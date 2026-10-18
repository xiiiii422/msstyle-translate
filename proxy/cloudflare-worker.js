/**
 * 微软式翻译 · Cloudflare Worker 代理
 *
 * 作用：把 API Key 留在服务端，前端完全不接触。这是"商用部署"的推荐方式。
 *
 * ── 部署步骤 ───────────────────────────────────────────────
 *   1. 安装 wrangler：npm i -g wrangler
 *   2. 设置密钥（不要写进代码！）：
 *        wrangler secret put ZHIPU_API_KEY
 *   3. （可选）限制允许的来源，改下面的 ALLOWED_ORIGINS
 *   4. 部署：wrangler deploy
 *   5. 把部署出来的地址填到前端 config.js：
 *        window.__MSSTYLE_CONFIG__ = { proxyUrl: "https://xxx.workers.dev" };
 *
 * ── 它做了什么 ─────────────────────────────────────────────
 *   GET  /health    → 健康检查，前端用它判断要不要走代理
 *   POST /translate → 翻译，body: { text, mode, level }
 *   · 校验输入长度与类型
 *   · 模型降级（与前端直连模式同一套策略）
 *   · 关闭思考模式（否则 glm-4.7-flash 会返回空内容，见 README）
 *   · 按 IP 限流，防止被人刷爆额度
 *   · CORS 白名单
 */

// ======================= 配置 =======================

/** 允许的前端来源。部署后请改成你自己的域名，或留 ["*"] 但务必配合限流 */
const ALLOWED_ORIGINS = ["*"];

/** 模型优先级：从前到后依次尝试 */
const MODELS = ["glm-4-flash-250414", "glm-4-flash", "glm-4.7-flash"];

/** 上游接口 */
const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** 单次请求的最大输入长度 */
const MAX_INPUT = 2000;

/** 单个模型的超时（毫秒） */
const PER_MODEL_TIMEOUT = 20000;

/** 限流：每个 IP 在窗口内允许的请求数 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ======================= 提示词 =======================
// 复用 prompt.js（唯一来源），保证代理与前端直连模式产出的风格完全一致。
// Worker 打包时会把 prompt.js 一起打进去（它是无依赖的 UMD 模块）。

import PROMPTS from "../prompt.js";

const cleanResult = PROMPTS.cleanResult;

/* ----------------------------------------------------------------------
 * 可观测性
 *
 * Worker 没有常驻进程，module 级变量只在该实例存活期间保留计数，
 * 实例回收后归零 —— 所以这是"趋势参考"，不是精确统计。
 * 需要精确统计请接 Cloudflare Analytics Engine 或外部日志服务。
 *
 * 日志一律走 console.log(JSON)，Cloudflare 后台可直接按字段检索。
 * 绝不记录用户原文与 API Key。
 * -------------------------------------------------------------------- */
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  succeeded: 0,
  failed: 0,
  rateLimited: 0,
  rejected: 0,
  upstreamErrors: 0,
  fallbacks: 0,
  emptyResults: 0,
  rateLimitErrors: 0,
  totalUpstreamMs: 0,
  modelErrors: {},
  statusCounts: {},
};

function bumpStatus(status) {
  const k = String(status);
  metrics.statusCounts[k] = (metrics.statusCounts[k] || 0) + 1;
}

function logEvent(fields) {
  try { console.log(JSON.stringify(fields)); } catch (_) { /* ignore */ }
}

function metricsSnapshot() {
  const uptimeSec = Math.round((Date.now() - metrics.startedAt) / 1000);
  const finished = metrics.succeeded + metrics.failed;
  return {
    uptimeSec: uptimeSec,
    note: "Worker 实例回收后计数会归零，仅作趋势参考",
    requests: metrics.requests,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    successRate: finished ? Number((metrics.succeeded / finished).toFixed(4)) : null,
    rateLimited: metrics.rateLimited,
    rejected: metrics.rejected,
    upstreamErrors: metrics.upstreamErrors,
    fallbacks: metrics.fallbacks,
    emptyResults: metrics.emptyResults,
    avgUpstreamMs: metrics.requests
      ? Math.round(metrics.totalUpstreamMs / metrics.requests)
      : 0,
    modelErrors: metrics.modelErrors,
    statusCounts: metrics.statusCounts,
  };
}

// ======================= 工具 =======================

/** CORS 头 */
function corsHeaders(origin) {
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed = allowAll ? (origin || "*") : (ALLOWED_ORIGINS.includes(origin) ? origin : "");
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (allowed) h["Access-Control-Allow-Origin"] = allowed;
  return h;
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      extraHeaders || {}
    ),
  });
}

/* ----------------------------------------------------------------------
 * 限流：内存计数。
 *
 * ⚠️ 注意这是"尽力而为"的防护：
 *    Cloudflare Worker 的实例会被回收与多开，计数不跨实例共享，
 *    因此它只能挡住单实例上的突发滥用，挡不住有组织的分布式刷量。
 *    正式商用请改用 Durable Objects / KV / 或平台自带的 Rate Limiting 规则。
 * -------------------------------------------------------------------- */
const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    // 顺手清理过期条目，避免内存无限增长
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (now - v.start > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return {
      ok: false,
      retryAfter: Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000),
    };
  }
  return { ok: true, remaining: RATE_LIMIT_MAX - bucket.count };
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** 调用一次上游模型 */
async function callModel(model, apiKey, text, mode, level) {
  const res = await fetchWithTimeout(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify(PROMPTS.buildRequestBody(model, text, mode, level)),
  }, PER_MODEL_TIMEOUT);

  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }

  if (!res.ok) {
    const code = (data && data.error && data.error.code) || "";
    const msg = (data && data.error && data.error.message) || "";
    const err = new Error("HTTP " + res.status + " [" + code + "] " + msg);
    err.status = res.status;
    err.apiCode = code;
    // 429/5xx 或智谱的过载码 → 可以换模型重试
    err.retriable = res.status === 429 || res.status >= 500 ||
      code === "1305" || code === "1302";
    throw err;
  }

  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;

  if (!content || !String(content).trim()) {
    const err = new Error("上游返回内容为空");
    err.code = "EMPTY_RESULT";
    err.retriable = true;
    throw err;
  }
  return cleanResult(content);
}

// ======================= 路由处理 =======================

async function handleTranslate(request, env, origin) {
  const t0 = Date.now();
  metrics.requests++;

  /** 统一的失败出口 */
  function fail(status, code, message) {
    metrics.failed++;
    if (status === 400) metrics.rejected++;
    bumpStatus(status);
    logEvent({ evt: "fail", code: code, status: status, ms: Date.now() - t0 });
    return json({ ok: false, code: code, message: message }, status, corsHeaders(origin));
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail(400, "BAD_JSON", "请求体不是合法 JSON");
  }

  const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
  const mode = ["auto", "zh", "en"].includes(payload && payload.mode) ? payload.mode : "auto";
  let level = parseInt(payload && payload.level, 10);
  if (!(level >= 1 && level <= 4)) level = 3;

  if (!text) {
    return fail(400, "EMPTY_INPUT", "输入不能为空");
  }
  if (text.length > MAX_INPUT) {
    return fail(400, "TOO_LONG", "输入太长了，请控制在 " + MAX_INPUT + " 个字符以内。");
  }

  const apiKey = env && env.ZHIPU_API_KEY;
  if (!apiKey) {
    // 这是部署者的问题，不是访客的问题 —— 返回 500 让前端可以回退直连
    return fail(500, "NO_SERVER_KEY",
      "服务端没有配置 ZHIPU_API_KEY（请用 wrangler secret put 设置）");
  }

  let lastErr = null;
  let attempt = 0;

  for (const model of MODELS) {
    attempt++;
    try {
      const result = await callModel(model, apiKey, text, mode, level);

      metrics.succeeded++;
      metrics.totalUpstreamMs += Date.now() - t0;
      if (attempt > 1) metrics.fallbacks++;
      bumpStatus(200);
      logEvent({
        evt: "ok", model: model, attempts: attempt,
        len: text.length, level: level, ms: Date.now() - t0,
      });

      return json({ ok: true, result: result, model: model }, 200, corsHeaders(origin));
    } catch (err) {
      lastErr = err;
      metrics.upstreamErrors++;
      metrics.modelErrors[model] = (metrics.modelErrors[model] || 0) + 1;
      if (err.code === "EMPTY_RESULT") metrics.emptyResults++;
      // 不可重试的错误（如 401 Key 无效）直接返回，换模型没意义
      if (!err.retriable) break;

    }
  }

  const status = lastErr && lastErr.status === 401 ? 401
    : (lastErr && lastErr.status === 429 ? 429 : 502);

  metrics.failed++;
  bumpStatus(status);
  logEvent({
    evt: "upstream_failed", status: status, attempts: attempt,
    ms: Date.now() - t0,
    detail: lastErr && lastErr.message ? String(lastErr.message).slice(0, 120) : "",
  });

  return json({
    ok: false,
    code: (lastErr && (lastErr.apiCode || lastErr.code)) || "UPSTREAM_ERROR",
    message: "所有模型都暂时不可用",
  }, status, corsHeaders(origin));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // 来源白名单校验（非浏览器请求没有 Origin，放行）
    if (!ALLOWED_ORIGINS.includes("*") && origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ ok: false, code: "FORBIDDEN_ORIGIN", message: "来源不被允许" },
        403, cors);
    }

    // 健康检查：前端用它决定走代理还是直连
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ ok: true, service: "msstyle-translate-proxy", models: MODELS },
        200, cors);
    }

    if (url.pathname === "/translate" || url.pathname === "/api/translate") {
      if (request.method !== "POST") {
        return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "请用 POST" },
          405, cors);
      }

      const ip = request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") || "unknown";
      const rate = checkRateLimit(ip);
      if (!rate.ok) {
        metrics.rateLimited++;
        console.log(JSON.stringify({
          evt: "rate_limited", ip: ip, retryAfter: rate.retryAfter, ts: Date.now(),
        }));
        return json({
          ok: false, code: "RATE_LIMITED",
          message: "请求太频繁了，请 " + rate.retryAfter + " 秒后再试。",
        }, 429, Object.assign({ "Retry-After": String(rate.retryAfter) }, cors));
      }

      return handleTranslate(request, env, origin);
    }

    // 统计：默认需要管理令牌，避免把运行数据暴露到公网。
    // 设置环境变量 STATS_TOKEN 后，用 ?token=xxx 访问。
    if (url.pathname === "/stats" || url.pathname === "/api/stats") {
      const expected = env && env.STATS_TOKEN;
      if (expected) {
        const got = url.searchParams.get("token") || "";
        if (got !== expected) {
          return json({ ok: false, code: "STATS_FORBIDDEN", message: "需要正确的 token" },
            403, cors);
        }
      }
      return json(Object.assign(
        { ok: true, service: "msstyle-translate-proxy", models: MODELS },
        metricsSnapshot()
      ), 200, cors);
    }

    return json({ ok: false, code: "NOT_FOUND", message: "未知路径" }, 404, cors);
  },
};
