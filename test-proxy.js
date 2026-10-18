require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 代理服务测试：直接跑 Node 版代理，把上游 fetch 换成 mock。
   重点验证：输入校验、限流、CORS、模型降级、错误映射、Key 不外泄。 */
const path = require("path");
const http = require("http");

process.env.ZHIPU_API_KEY = "test.server.key.12345";
// 限流测试单独用一个高限额实例；主实例放开限额，避免测试之间互相干扰
// （否则前面的用例会把 IP 配额耗光，后面的用例全部收到 429）
process.env.RATE_LIMIT_MAX = "10000";
process.env.ALLOWED_ORIGINS = "*";

const app = require("./proxy/node-server.js");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/** 启动服务器并返回 port */
function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

/** 发一个请求 */
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        data ? { "Content-Length": Buffer.byteLength(data) } : {},
        headers || {}
      ),
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: d, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---- 替换全局 fetch，模拟上游智谱接口 ----
let upstreamMode = "ok";
let upstreamCalls = [];
const realFetch = global.fetch;
global.fetch = async function (url, opts) {
  const body = JSON.parse(opts.body);
  upstreamCalls.push({ model: body.model, thinking: body.thinking, messages: body.messages, auth: opts.headers.Authorization });

  if (upstreamMode === "ok") {
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "我今天是特别高兴的，因为假期终于已经到达。" } }] }),
    };
  }
  if (upstreamMode === "first429") {
    // 第一个模型 429，第二个成功
    if (upstreamCalls.length === 1) {
      return { ok: false, status: 429,
        json: async () => ({ error: { code: "1305", message: "该模型当前访问量过大" } }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "降级之后的结果。" } }] }),
    };
  }
  if (upstreamMode === "401") {
    return { ok: false, status: 401,
      json: async () => ({ error: { code: "1002", message: "invalid api key" } }) };
  }
  if (upstreamMode === "empty") {
    return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
  }
  if (upstreamMode === "allfail") {
    return { ok: false, status: 503,
      json: async () => ({ error: { code: "500", message: "server error" } }) };
  }
  throw new Error("unknown mode");
};

(async () => {
  const { server, port } = await listen();

  /* ---------- 健康检查 ---------- */
  {
    const r = await req(port, "GET", "/health");
    check("GET /health 返回 200", r.status === 200, r.status);
    check("健康检查返回 ok:true", r.body && r.body.ok === true);
    check("健康检查不泄露 Key", !r.raw.includes("test.server.key"));
    const r2 = await req(port, "GET", "/api/health");
    check("支持 /api/health 别名", r2.status === 200);
  }

  /* ---------- CORS ---------- */
  {
    const r = await req(port, "GET", "/health", undefined, { Origin: "https://mysite.com" });
    check("CORS 回显 Origin", r.headers["access-control-allow-origin"] === "https://mysite.com",
      r.headers["access-control-allow-origin"]);
    const pre = await req(port, "OPTIONS", "/translate");
    check("OPTIONS 预检返回 204", pre.status === 204, pre.status);
  }

  /* ---------- 输入校验 ---------- */
  {
    upstreamCalls = [];
    const r1 = await req(port, "POST", "/translate", { text: "" });
    check("空输入返回 400", r1.status === 400, r1.status);
    check("空输入不调用上游", upstreamCalls.length === 0);

    const r2 = await req(port, "POST", "/translate", { text: "a".repeat(2001) });
    check("超长输入返回 400", r2.status === 400, r2.status);
    check("超长输入错误码为 TOO_LONG", r2.body && r2.body.code === "TOO_LONG");

    const r3 = await req(port, "POST", "/translate", { text: "   " });
    check("纯空白输入被拒绝", r3.status === 400, r3.status);
  }

  /* ---------- 正常翻译 ---------- */
  {
    upstreamMode = "ok"; upstreamCalls = [];
    const r = await req(port, "POST", "/translate", { text: "我今天特别开心。", mode: "zh", level: 3 });
    check("正常翻译返回 200", r.status === 200, r.status);
    check("返回 ok:true 与 result", r.body && r.body.ok === true && !!r.body.result, JSON.stringify(r.body));
    check("结果已清洗（无前缀）", r.body.result.indexOf("翻译结果") === -1);
    check("调用上游时带了 Bearer Key",
      upstreamCalls[0] && upstreamCalls[0].auth === "Bearer test.server.key.12345",
      upstreamCalls[0] && upstreamCalls[0].auth);
    check("请求体关闭了思考模式",
      upstreamCalls[0] && upstreamCalls[0].thinking && upstreamCalls[0].thinking.type === "disabled",
      JSON.stringify(upstreamCalls[0] && upstreamCalls[0].thinking));
    check("提示词注入了程度 3",
      upstreamCalls[0] && upstreamCalls[0].messages[1].content.includes("风格强度：3"));
    check("响应体不含服务端 Key", !r.raw.includes("test.server.key"));
  }

  /* ---------- 非法参数回落 ---------- */
  {
    upstreamMode = "ok"; upstreamCalls = [];
    await req(port, "POST", "/translate", { text: "测试", mode: "evil", level: 999 });
    const prompt = upstreamCalls[0].messages[1].content;
    check("非法 mode 回落为 auto", prompt.includes("自动判断"));
    check("非法 level 回落为 3", prompt.includes("风格强度：3"));
  }

  /* ---------- 模型降级 ---------- */
  {
    upstreamMode = "first429"; upstreamCalls = [];
    const r = await req(port, "POST", "/translate", { text: "测试降级" });
    check("首个模型 429 后自动降级", r.status === 200 && r.body.result.indexOf("降级之后") === 0,
      JSON.stringify(r.body).slice(0, 80));
    check("降级共调用上游 2 次", upstreamCalls.length === 2, upstreamCalls.length);
    check("降级换了模型",
      upstreamCalls.length >= 2 && upstreamCalls[0].model !== upstreamCalls[1].model,
      upstreamCalls.map((c) => c.model).join(" → ") || "(无调用)");
  }

  /* ---------- 401 不降级 ---------- */
  {
    upstreamMode = "401"; upstreamCalls = [];
    const r = await req(port, "POST", "/translate", { text: "测试401" });
    check("上游 401 返回 401", r.status === 401, r.status);
    check("401 不浪费时间重试其他模型", upstreamCalls.length === 1, upstreamCalls.length);
  }

  /* ---------- 空内容降级 ---------- */
  {
    upstreamMode = "empty"; upstreamCalls = [];
    const r = await req(port, "POST", "/translate", { text: "测试空内容" });
    check("上游返回空内容时会换模型", upstreamCalls.length > 1, upstreamCalls.length);
    check("全部空内容时返回 502", r.status === 502, r.status);
  }

  /* ---------- 全部失败 ---------- */
  {
    upstreamMode = "allfail"; upstreamCalls = [];
    const r = await req(port, "POST", "/translate", { text: "测试全挂" });
    check("全部模型失败返回 502", r.status === 502, r.status);
    check("失败响应不泄露上游细节给用户", !r.raw.includes("server error"), r.raw.slice(0, 100));
  }

  /* ---------- 限流（真实触发） ----------
     用独立实例 + 低限额，通过模块缓存重载实现进程内隔离
     （沙箱禁止 spawnSync 捕获输出，所以不能用子进程）。 */
  {
    upstreamMode = "ok"; upstreamCalls = [];   // 重要：前面的用例把它设成了 allfail
    const savedKey = process.env.ZHIPU_API_KEY;
    const savedLimit = process.env.RATE_LIMIT_MAX;
    process.env.ZHIPU_API_KEY = "k";
    process.env.RATE_LIMIT_MAX = "5";

    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appRl = require(modPath);
    const s3 = await new Promise((resolve) => {
      const srv = appRl.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });

    const statuses = [];
    let last429 = null;
    for (let i = 0; i < 8; i++) {
      const r = await req(s3.port, "POST", "/translate", { text: "限流测试 " + i });
      statuses.push(r.status);
      if (r.status === 429 && !last429) last429 = r;
    }

    const okCount = statuses.filter((s) => s === 200).length;
    const limitedCount = statuses.filter((s) => s === 429).length;

    check("限流：限额内 5 次成功", okCount === 5, "ok=" + okCount + " statuses=" + statuses.join(","));
    check("限流：超出的 3 次被拒", limitedCount === 3, "429数=" + limitedCount + " statuses=" + statuses.join(","));
    check("限流：429 带 Retry-After 头", !!last429 && !!last429.headers["retry-after"],
      last429 && last429.headers["retry-after"]);
    check("限流：错误码为 RATE_LIMITED",
      !!last429 && last429.body && last429.body.code === "RATE_LIMITED",
      last429 && last429.body && last429.body.code);

    s3.server.close();
    process.env.ZHIPU_API_KEY = savedKey;
    process.env.RATE_LIMIT_MAX = savedLimit;
    delete require.cache[modPath];
    require(modPath);
  }

  /* ---------- CORS 白名单（独立实例，验证非白名单来源被拒） ---------- */
  {
    const savedOrigins = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://good.example";
    process.env.RATE_LIMIT_MAX = "10000";

    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appCors = require(modPath);
    const s4 = await new Promise((resolve) => {
      const srv = appCors.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });

    const good = await req(s4.port, "POST", "/translate", { text: "白名单内" },
      { Origin: "https://good.example" });
    const bad = await req(s4.port, "POST", "/translate", { text: "白名单外" },
      { Origin: "https://evil.example" });

    check("CORS 白名单内的来源可用", good.status === 200, good.status);
    check("CORS 白名单外的来源被拒", bad.status === 403, bad.status);
    check("被拒时错误码为 FORBIDDEN_ORIGIN",
      bad.body && bad.body.code === "FORBIDDEN_ORIGIN", bad.body && bad.body.code);

    s4.server.close();
    process.env.ALLOWED_ORIGINS = savedOrigins;
    delete require.cache[modPath];
    require(modPath);
  }

  /* ---------- 可观测性：/stats 与指标 ---------- */
  {
    upstreamMode = "ok";
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appObs = require(modPath);
    appObs.__resetMetrics();

    const s5 = await new Promise((resolve) => {
      const srv = appObs.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });
    const p = s5.port;

    // 2 次成功 + 1 次参数错误
    await req(p, "POST", "/translate", { text: "观测测试一" });
    await req(p, "POST", "/translate", { text: "观测测试二" });
    await req(p, "POST", "/translate", { text: "" });

    const st = await req(p, "GET", "/stats");
    check("/stats 返回 200", st.status === 200, st.status);

    const m = st.body || {};
    check("统计记录了 3 次请求", m.requests === 3, "requests=" + m.requests);
    check("统计记录了 2 次成功", m.succeeded === 2, "succeeded=" + m.succeeded);
    check("统计记录了 1 次失败", m.failed === 1, "failed=" + m.failed);
    check("统计记录了 1 次参数拒绝", m.rejected === 1, "rejected=" + m.rejected);
    check("统计有成功率字段", m.successRate !== null && m.successRate !== undefined,
      String(m.successRate));
    check("统计有平均耗时字段", typeof m.avgUpstreamMs === "number", String(m.avgUpstreamMs));
    check("统计有状态码分布", m.statusCounts && m.statusCounts["200"] === 2,
      JSON.stringify(m.statusCounts));
    check("统计不含任何 Key 内容", !JSON.stringify(m).includes("test.server.key"));
    check("统计不含用户原文", !JSON.stringify(m).includes("观测测试"));

    // 降级次数应被记录
    // 注意：fetch mock 用 upstreamCalls.length === 1 判定"第一次调用失败"，
    // 所以这里必须先把计数器清零，否则永远不会触发 429 分支。
    appObs.__resetMetrics();
    upstreamCalls = [];
    upstreamMode = "first429";
    await req(p, "POST", "/translate", { text: "触发降级" });
    const st2 = await req(p, "GET", "/stats");
    check("降级次数被记录", st2.body.fallbacks === 1, "fallbacks=" + st2.body.fallbacks);
    check("上游错误次数被记录", st2.body.upstreamErrors >= 1,
      "upstreamErrors=" + st2.body.upstreamErrors);
    upstreamMode = "ok";

    s5.server.close();
    delete require.cache[modPath];
    require(modPath);
  }

  /* ---------- /stats 默认不对公网开放 ---------- */
  {
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    const realFetch = global.fetch;
    delete require.cache[modPath];
    const appS = require(modPath);
    const s6 = await new Promise((resolve) => {
      const srv = appS.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });

    // 伪造一个公网来源 IP
    const r = await req(s6.port, "GET", "/stats", undefined,
      { "X-Forwarded-For": "203.0.113.9" });
    check("公网访问 /stats 被拒绝", r.status === 403, r.status);
    check("拒绝码为 STATS_FORBIDDEN",
      r.body && r.body.code === "STATS_FORBIDDEN", r.body && r.body.code);

    // 本机访问仍然允许
    const r2 = await req(s6.port, "GET", "/stats");
    check("本机访问 /stats 允许", r2.status === 200, r2.status);

    s6.server.close();
    delete require.cache[modPath];
    require(modPath);
    global.fetch = realFetch;
  }

  /* ---------- 限流存储：可插拔与故障语义 ---------- */
  {
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    const savedStore = process.env.RATE_LIMIT_STORE;
    const savedFailMode = process.env.RATE_LIMIT_FAIL_CLOSED;

    // 1) 默认是内存存储
    delete process.env.RATE_LIMIT_STORE;
    delete require.cache[modPath];
    const appMem = require(modPath);
    const info = appMem.__rateStoreInfo();
    check("默认限流存储为 memory", info.name === "memory", info.name);
    check("内存存储标记为非分布式", info.distributed === false, String(info.distributed));

    const s7 = await new Promise((resolve) => {
      const srv = appMem.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });
    const st = await req(s7.port, "GET", "/stats");
    check("/stats 暴露当前限流存储类型", st.body.rateLimitStore === "memory",
      st.body.rateLimitStore);
    check("/stats 暴露限流是否为分布式", st.body.rateLimitDistributed === false,
      String(st.body.rateLimitDistributed));
    check("/stats 暴露限流是否降级", st.body.rateLimitDegraded === false,
      String(st.body.rateLimitDegraded));
    s7.server.close();

    // 2) 配置 redis 但没装 ioredis → 应优雅退化为内存，且不崩
    process.env.RATE_LIMIT_STORE = "redis";
    delete require.cache[modPath];
    let appRedis = null;
    let threw = false;
    try { appRedis = require(modPath); } catch (e) { threw = true; }
    check("未安装 ioredis 时不崩溃", !threw);
    if (appRedis) {
      const info2 = appRedis.__rateStoreInfo();
      check("缺少 ioredis 时退回内存存储", info2.name === "memory", info2.name);
      // 仍应能正常服务
      const s8 = await new Promise((resolve) => {
        const srv = appRedis.listen(0, () => resolve({ server: srv, port: srv.address().port }));
      });
      const r = await req(s8.port, "POST", "/translate", { text: "退化后仍可用" });
      check("限流退化后翻译仍正常", r.status === 200, r.status);
      s8.server.close();
    }

    process.env.RATE_LIMIT_STORE = savedStore;
    if (savedFailMode === undefined) delete process.env.RATE_LIMIT_FAIL_CLOSED;
    else process.env.RATE_LIMIT_FAIL_CLOSED = savedFailMode;
    delete require.cache[modPath];
    require(modPath);
  }

  /* ---------- 方法限制与未知路径 ---------- */
  {
    const r = await req(port, "GET", "/translate");
    // Express 的 app.get 未注册该路径 → 落到 404 兜底；关键是"不被当成翻译处理"
    check("GET /translate 不被当作翻译处理", r.status === 404 || r.status === 405, r.status);
    const r2 = await req(port, "GET", "/nope");
    check("未知路径返回 404", r2.status === 404, r2.status);
  }

  /* ---------- 缺少服务端 Key ----------
     沙箱禁止 spawnSync 捕获输出，因此改为：
     在同一个进程里清空模块缓存后重新 require 一个"没有 Key"的实例。 */
  {
    const savedKey = process.env.ZHIPU_API_KEY;
    const savedLimit = process.env.RATE_LIMIT_MAX;
    delete process.env.ZHIPU_API_KEY;
    process.env.RATE_LIMIT_MAX = "10000";

    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appNoKey = require(modPath);
    const s2 = await new Promise((resolve) => {
      const srv = appNoKey.listen(0, () => resolve({ server: srv, port: srv.address().port }));
    });

    const r = await req(s2.port, "POST", "/translate", { text: "没有服务端 Key" });
    check("服务端未配置 Key 时返回 500", r.status === 500, r.status);
    check("缺少 Key 时错误码为 NO_SERVER_KEY",
      r.body && r.body.code === "NO_SERVER_KEY", r.body && r.body.code);
    s2.server.close();

    // 恢复环境与模块缓存，避免影响后续
    process.env.ZHIPU_API_KEY = savedKey;
    process.env.RATE_LIMIT_MAX = savedLimit;
    delete require.cache[modPath];
    require(modPath);
  }

  server.close();

  /* ---------- 输出 ---------- */
  console.log("\n============ 代理服务测试 ============");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
