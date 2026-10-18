/**
 * 微软式翻译 · Node 代理服务
 *
 * 适合部署在自己的服务器 / 容器 / 阿里云函数计算上。
 * 与 Cloudflare Worker 版本功能一致，逻辑等价。
 *
 * ── 运行 ───────────────────────────────────────────────────
 *   npm install express
 *   ZHIPU_API_KEY=你的Key node proxy/node-server.js
 *
 * 默认监听 8787，然后把前端 config.js 指向它：
 *   window.__MSSTYLE_CONFIG__ = { proxyUrl: "http://localhost:8787" };
 *
 * 生产环境建议用反向代理把 /api 指到本服务，这样前端用同源 "/api" 即可，
 * 天然没有 CORS 问题（见 README 的 nginx 示例）。
 */

/* 依赖加载：给出可操作的错误，而不是裸的 MODULE_NOT_FOUND。
 *
 * 部署者最常见的失误就是直接 `node proxy/node-server.js` 而没先装依赖。
 * 裸报错「Cannot find module 'express'」不会告诉他该做什么 ——
 * 实测确认过这一点，所以这里包一层。
 */
let express;
try {
  express = require("express");
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND") {
    console.error(
      "\n[微软式翻译] 启动失败：缺少依赖 express。\n\n" +
      "请在项目根目录执行：\n" +
      "    npm install express\n\n" +
      "（如果需要分布式限流，再加上 ioredis：npm install express ioredis）\n" +
      "安装完成后重新运行本服务。\n"
    );
    process.exit(1);
  }
  throw e;
}
const path = require("path");
const app = express();

// ======================= 配置 =======================

const PORT = process.env.PORT || 8787;
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || "";

/** 允许的前端来源，逗号分隔；"*" 表示不限 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** 模型优先级 */
const MODELS = ["glm-4-flash-250414", "glm-4-flash", "glm-4.7-flash"];

const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MAX_INPUT = 2000;
const PER_MODEL_TIMEOUT = 20000;

/** 限流：每个 IP 每分钟允许的请求数 */
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "20", 10);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ======================= 提示词 =======================
// 复用 prompt.js（唯一来源），保证代理与前端直连模式产出的风格完全一致。
// 不要在这里重新定义提示词 —— 一旦分叉，两种部署模式会产出不同风格。

const PROMPTS = require(path.join(__dirname, "..", "prompt.js"));

const cleanResult = PROMPTS.cleanResult;

// ======================= 工具 =======================

/* ----------------------------------------------------------------------
 * 限流：可插拔存储
 *
 * 为什么要可插拔：
 *   内存计数只在"单进程"下准确。一旦水平扩容（多容器 / 多进程 / PM2 cluster），
 *   每个实例各算各的，实际放行量会变成 限额 × 实例数 —— 防护形同虚设。
 *
 * 两种后端：
 *   memory（默认）—— 零依赖，单实例部署够用
 *   redis         —— 多实例共享计数，生产环境推荐
 *
 * 配置：
 *   RATE_LIMIT_STORE=redis
 *   REDIS_URL=redis://127.0.0.1:6379
 *
 * 故障语义（重要，不要含糊）：
 *   Redis 不可用时默认 **放行**（fail-open），优先保证正常用户能用；
 *   安全要求高时设 RATE_LIMIT_FAIL_CLOSED=1 改为拒绝，
 *   宁可暂时不可用，也不让额度被刷。
 * -------------------------------------------------------------------- */

/** 内存后端 */
const memoryStore = {
  name: "memory",
  buckets: new Map(),
  distributed: false,

  async hit(key, windowMs, max) {
    const now = Date.now();
    const b = this.buckets.get(key);

    if (!b || now - b.start > windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      // 顺带清理过期条目，防止内存无限增长
      if (this.buckets.size > 10000) {
        for (const [k, v] of this.buckets) {
          if (now - v.start > windowMs) this.buckets.delete(k);
        }
      }
      return { ok: true, count: 1 };
    }

    b.count++;
    if (b.count > max) {
      return { ok: false, retryAfter: Math.ceil((b.start + windowMs - now) / 1000) };
    }
    return { ok: true, count: b.count };
  },
};

/** Redis 后端（惰性加载 ioredis，没装也不影响其他功能） */
function createRedisStore() {
  let client = null;
  let ready = false;

  try {
    // 用 require 而非 import，保证"没装 redis 也能启动"
    const Redis = require("ioredis");
    client = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    client.on("ready", () => { ready = true; console.log("[proxy] Redis 已连接，限流为分布式模式"); });
    client.on("error", (e) => {
      if (ready) console.warn("[proxy] Redis 连接异常：", e.message);
      ready = false;
    });
  } catch (e) {
    console.warn(
      "[proxy] 配置了 RATE_LIMIT_STORE=redis 但没能加载 ioredis：" + e.message + "\n" +
      "        请先 `npm install ioredis`，否则会退回内存限流（多实例下不准确）。"
    );
    return null;
  }

  return {
    name: "redis",
    distributed: true,
    get ready() { return ready; },

    async hit(key, windowMs, max) {
      if (!ready) throw new Error("redis-not-ready");
      const k = "msstyle:rl:" + key;
      // INCR + 首次设置过期，是标准的固定窗口计数
      const count = await client.incr(k);
      if (count === 1) {
        await client.pexpire(k, windowMs);
      }
      if (count > max) {
        const ttl = await client.pttl(k);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)) };
      }
      return { ok: true, count: count };
    },

    async close() {
      if (client) { try { await client.quit(); } catch (_) { /* ignore */ } }
    },
  };
}

const RATE_LIMIT_STORE = (process.env.RATE_LIMIT_STORE || "memory").toLowerCase();
const RATE_LIMIT_FAIL_CLOSED = process.env.RATE_LIMIT_FAIL_CLOSED === "1";
const redisStore = RATE_LIMIT_STORE === "redis" ? createRedisStore() : null;
const rateStore = redisStore || memoryStore;

/**
 * 检查限流。
 * @returns {Promise<{ok:boolean, retryAfter?:number}>}
 */
async function checkRateLimit(ip) {
  try {
    return await rateStore.hit(ip, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);
  } catch (e) {
    // 存储故障：按配置决定放行还是拒绝
    metrics.rateLimitErrors = (metrics.rateLimitErrors || 0) + 1;
    recordEvent("rate_limit_store_error", { store: rateStore.name });
    if (RATE_LIMIT_FAIL_CLOSED) {
      console.warn("[proxy] 限流存储不可用，按 fail-closed 策略拒绝请求：", e.message);
      return { ok: false, retryAfter: 30, degraded: true };
    }
    console.warn("[proxy] 限流存储不可用，按 fail-open 策略放行：", e.message);
    return { ok: true, degraded: true };
  }
}

/** 调用一次上游模型 */
async function callModel(model, text, mode, level) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + ZHIPU_API_KEY,
      },
      body: JSON.stringify(PROMPTS.buildRequestBody(model, text, mode, level)),
      signal: controller.signal,
    });

    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }

    if (!res.ok) {
      const code = (data && data.error && data.error.code) || "";
      const msg = (data && data.error && data.error.message) || "";
      const err = new Error("HTTP " + res.status + " [" + code + "] " + msg);
      err.status = res.status;
      err.apiCode = code;
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
  } finally {
    clearTimeout(timer);
  }
}

// ======================= 可观测性 =======================
//
// 商用服务和"能跑起来"的区别之一，就是出故障时运维能不能看到信号。
// 这里记录：请求量、成功率、错误分类、模型降级次数、各模型耗时。
//
// 设计取舍：
//   · 只保留聚合计数 + 最近 N 条事件，不落盘 —— 避免引入数据库，
//     也避免把用户输入写进日志（隐私）。
//   · 日志里绝不记录原文与 API Key。
//   · 生产环境建议再接一个真正的日志/监控系统（见 README）。

/** 结构化计数 */
const metrics = {
  startedAt: Date.now(),
  requests: 0,          // 收到的翻译请求总数
  succeeded: 0,         // 成功返回
  failed: 0,            // 最终失败
  rateLimited: 0,       // 被限流拒绝
  rejected: 0,          // 参数校验失败
  upstreamErrors: 0,    // 上游报错次数
  fallbacks: 0,         // 模型降级次数
  emptyResults: 0,      // 上游返回空内容次数
  rateLimitErrors: 0,   // 限流存储不可用次数（>0 说明限流可能不准）
  totalUpstreamMs: 0,   // 上游累计耗时
  modelErrors: {},      // 各模型失败次数
  statusCounts: {},     // HTTP 状态码分布
};

/** 最近事件（环形缓冲，最多 RING_SIZE 条） */
const RING_SIZE = 50;
const recentEvents = [];

function recordEvent(type, detail) {
  recentEvents.push(Object.assign({ t: Date.now(), type: type }, detail || {}));
  if (recentEvents.length > RING_SIZE) recentEvents.shift();
}

function bumpStatus(status) {
  const k = String(status);
  metrics.statusCounts[k] = (metrics.statusCounts[k] || 0) + 1;
}

/**
 * 请求日志。默认开启；设 LOG_LEVEL=off 可关闭。
 * 绝不记录用户原文，只记录长度与耗时，避免隐私问题。
 */
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function logRequest(fields) {
  if (LOG_LEVEL === "off" || LOG_LEVEL === "silent") return;
  const parts = Object.keys(fields).map(function (k) {
    return k + "=" + fields[k];
  });
  console.log("[proxy] " + parts.join(" "));
}

/** 供 /stats 输出的快照（不含任何敏感信息） */
function metricsSnapshot() {
  const uptimeSec = Math.round((Date.now() - metrics.startedAt) / 1000);
  const finished = metrics.succeeded + metrics.failed;
  return {
    uptimeSec: uptimeSec,
    requests: metrics.requests,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    successRate: finished ? Number((metrics.succeeded / finished).toFixed(4)) : null,
    rateLimited: metrics.rateLimited,
    rejected: metrics.rejected,
    upstreamErrors: metrics.upstreamErrors,
    fallbacks: metrics.fallbacks,
    emptyResults: metrics.emptyResults,
    rateLimitErrors: metrics.rateLimitErrors,
    // 让运维一眼看出限流是否真的生效（内存版在多实例下不算数）
    rateLimitStore: rateStore.name,
    rateLimitDistributed: !!rateStore.distributed,
    rateLimitDegraded: metrics.rateLimitErrors > 0,
    avgUpstreamMs: metrics.requests
      ? Math.round(metrics.totalUpstreamMs / metrics.requests)
      : 0,
    modelErrors: metrics.modelErrors,
    statusCounts: metrics.statusCounts,
    recentEvents: recentEvents.slice(-20),
  };
}

// ======================= 中间件 =======================

app.use(express.json({ limit: "64kb" }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed = allowAll ? (origin || "*") : (ALLOWED_ORIGINS.includes(origin) ? origin : "");

  if (allowed) res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.sendStatus(204);

  if (!allowAll && origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ ok: false, code: "FORBIDDEN_ORIGIN", message: "来源不被允许" });
  }
  next();
});

// ======================= 路由 =======================

app.get(["/health", "/api/health"], (req, res) => {
  res.json({ ok: true, service: "msstyle-translate-proxy", models: MODELS });
});

app.post(["/translate", "/api/translate"], async (req, res) => {
  const t0 = Date.now();
  metrics.requests++;

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress || "unknown";

  const rate = await checkRateLimit(ip);
  if (!rate.ok) {
    metrics.rateLimited++;
    bumpStatus(429);
    recordEvent("rate_limited", { ip: ip, retryAfter: rate.retryAfter });
    logRequest({ evt: "rate_limited", ip: ip, ms: Date.now() - t0 });
    res.setHeader("Retry-After", String(rate.retryAfter));
    return res.status(429).json({
      ok: false, code: "RATE_LIMITED",
      message: "请求太频繁了，请 " + rate.retryAfter + " 秒后再试。",
    });
  }

  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const mode = ["auto", "zh", "en"].includes(body.mode) ? body.mode : "auto";
  let level = parseInt(body.level, 10);
  if (!(level >= 1 && level <= 4)) level = 3;

  /** 统一的失败出口：记指标 + 打日志 + 返回 */
  function fail(status, code, message) {
    metrics.failed++;
    metrics.rejected += status === 400 ? 1 : 0;
    bumpStatus(status);
    recordEvent("failed", { code: code, status: status, ms: Date.now() - t0 });
    logRequest({
      evt: "fail", code: code, status: status,
      len: text.length, ms: Date.now() - t0,
    });
    return res.status(status).json({ ok: false, code: code, message: message });
  }

  if (!text) {
    return fail(400, "EMPTY_INPUT", "输入不能为空");
  }
  if (text.length > MAX_INPUT) {
    return fail(400, "TOO_LONG", "输入太长了，请控制在 " + MAX_INPUT + " 个字符以内。");
  }
  if (!ZHIPU_API_KEY) {
    return fail(500, "NO_SERVER_KEY", "服务端没有配置 ZHIPU_API_KEY");
  }

  let lastErr = null;
  let attempt = 0;

  for (const model of MODELS) {
    attempt++;
    try {
      const result = await callModel(model, text, mode, level);

      metrics.succeeded++;
      metrics.totalUpstreamMs += Date.now() - t0;
      if (attempt > 1) {
        // 发生了降级：这是"上游不太健康"的早期信号，值得记录
        metrics.fallbacks++;
        recordEvent("fallback_ok", { finalModel: model, attempts: attempt });
      }
      bumpStatus(200);
      logRequest({
        evt: "ok", model: model, attempts: attempt,
        len: text.length, level: level, ms: Date.now() - t0,
      });

      return res.json({ ok: true, result: result, model: model });
    } catch (err) {
      lastErr = err;
      metrics.upstreamErrors++;
      metrics.modelErrors[model] = (metrics.modelErrors[model] || 0) + 1;
      if (err.code === "EMPTY_RESULT") metrics.emptyResults++;

      if (!err.retriable) break;   // 换模型也没用，直接结束
    }
  }

  const status = lastErr && lastErr.status === 401 ? 401
    : (lastErr && lastErr.status === 429 ? 429 : 502);

  metrics.failed++;
  bumpStatus(status);
  recordEvent("upstream_failed", {
    status: status,
    code: (lastErr && (lastErr.apiCode || lastErr.code)) || "UPSTREAM_ERROR",
    attempts: attempt,
  });
  logRequest({
    evt: "upstream_failed", status: status, attempts: attempt,
    ms: Date.now() - t0,
    detail: lastErr && lastErr.message ? String(lastErr.message).slice(0, 120) : "",
  });

  res.status(status).json({
    ok: false,
    code: (lastErr && (lastErr.apiCode || lastErr.code)) || "UPSTREAM_ERROR",
    message: "所有模型都暂时不可用",
  });
});

/**
 * 统计接口。默认只在本地/内网开放，避免把运行数据暴露给公网。
 * 需要公网可读时设 STATS_PUBLIC=1（不建议）。
 */
app.get(["/stats", "/api/stats"], (req, res) => {
  if (process.env.STATS_PUBLIC !== "1") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket.remoteAddress || "";
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "";
    if (!isLocal) {
      return res.status(403).json({
        ok: false, code: "STATS_FORBIDDEN",
        message: "统计接口默认只允许本机访问（如需公开请设 STATS_PUBLIC=1）",
      });
    }
  }
  res.json(Object.assign(
    { ok: true, service: "msstyle-translate-proxy", models: MODELS },
    metricsSnapshot()
  ));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, code: "NOT_FOUND", message: "未知路径" });
});

// 仅在直接运行时监听（便于被 require 进测试）
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("微软式翻译代理已启动: http://localhost:" + PORT);
    console.log("  ZHIPU_API_KEY: " + (ZHIPU_API_KEY ? "已配置 ✓" : "未配置 ✗（翻译会返回 500）"));
    console.log("  模型优先级: " + MODELS.join(" → "));
    console.log("  限流: " + RATE_LIMIT_MAX + " 次 / 分钟 / IP（存储：" + rateStore.name + "）");
    if (!rateStore.distributed) {
      console.log("        ⚠️  内存限流只在单进程下准确；多实例部署请设 RATE_LIMIT_STORE=redis");
    }
    if (metrics.rateLimitErrors) {
      console.log("        ⚠️  限流存储曾不可用 " + metrics.rateLimitErrors + " 次");
    }
    console.log("  统计: http://localhost:" + PORT + "/stats （默认仅本机可访问）");
  });
}

// 导出 app 供测试；同时导出度量工具，便于单测直接读取
module.exports = app;
module.exports.__metrics = metrics;
module.exports.__metricsSnapshot = metricsSnapshot;
module.exports.__resetMetrics = function () {
  metrics.requests = 0; metrics.succeeded = 0; metrics.failed = 0;
  metrics.rateLimited = 0; metrics.rejected = 0; metrics.upstreamErrors = 0;
  metrics.fallbacks = 0; metrics.emptyResults = 0; metrics.totalUpstreamMs = 0;
  metrics.rateLimitErrors = 0;
  metrics.modelErrors = {}; metrics.statusCounts = {};
  recentEvents.length = 0;
};
module.exports.__rateStoreInfo = function () {
  return { name: rateStore.name, distributed: !!rateStore.distributed };
};
module.exports.__closeRateStore = async function () {
  if (redisStore && redisStore.close) await redisStore.close();
};

