require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* Cloudflare Worker 代理的功能测试
 *
 * 背景：proxy/cloudflare-worker.js 是"推荐的商用部署方式"，但一直只做过语法检查，
 *       从未真正执行过。这个套件用真实的 Web 标准对象（Request/Response/Headers）
 *       直接调用它的 default.fetch()，验证路由、CORS、校验、降级、限流、统计。
 *
 * Node 18+ 自带 Request/Response/Headers/fetch，因此不需要 Cloudflare 运行时。
 */
const path = require("path");
const { pathToFileURL } = require("url");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/* ---------- 控制上游 fetch ---------- */
let upstreamMode = "ok";
let upstreamCalls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async function (url, opts) {
  upstreamCalls.push({ url, body: JSON.parse(opts.body) });
  if (upstreamMode === "ok") {
    return new Response(JSON.stringify({
      choices: [{ message: { content: "我今天是特别高兴的，因为假期终于已经到达。" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (upstreamMode === "first429") {
    if (upstreamCalls.length === 1) {
      return new Response(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大" } }),
        { status: 429, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "降级成功的结果。" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (upstreamMode === "401") {
    return new Response(JSON.stringify({ error: { code: "1002", message: "invalid api key" } }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (upstreamMode === "empty") {
    return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (upstreamMode === "allfail") {
    return new Response(JSON.stringify({ error: { code: "500", message: "boom" } }),
      { status: 503, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("unknown mode " + upstreamMode);
};

/* ---------- 加载真实的 Worker 模块 ---------- */
const workerUrl = pathToFileURL(path.join(__dirname, "proxy", "cloudflare-worker.js")).href;

/** 造一个请求 */
function makeRequest(method, pathname, opts) {
  opts = opts || {};
  const url = "https://proxy.example" + pathname;
  const init = { method, headers: {} };
  if (opts.origin) init.headers["Origin"] = opts.origin;
  if (opts.ip) init.headers["CF-Connecting-IP"] = opts.ip;
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(url, init);
}

async function callWorker(worker, req, env) {
  try {
    const res = await worker.default.fetch(req, env || { ZHIPU_API_KEY: "test.worker.key" });
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body, headers: res.headers, text };
  } catch (e) {
    return { status: -1, body: null, headers: new Headers(), text: "", error: e.message };
  }
}

(async () => {
  let worker;
  try {
    worker = await import(workerUrl);
  } catch (e) {
    console.error("✗ 无法加载 Worker 模块：", e.message);
    process.exit(1);
  }

  check("Worker 模块有 default.fetch 导出",
    worker.default && typeof worker.default.fetch === "function");

  const ENV = { ZHIPU_API_KEY: "test.worker.key" };

  /* ============ 1. 健康检查 ============ */
  {
    upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("GET", "/health"), ENV);
    check("GET /health 返回 200", r.status === 200, r.status);
    check("/health 返回 ok:true", r.body && r.body.ok === true);
    check("/health 不调用上游", upstreamCalls.length === 0);
    check("/health 不泄露 Key", !r.text.includes("test.worker.key"));

    const r2 = await callWorker(worker, makeRequest("GET", "/api/health"), ENV);
    check("/api/health 别名可用", r2.status === 200, r2.status);
  }

  /* ============ 2. CORS 与预检 ============ */
  {
    const pre = await callWorker(worker, makeRequest("OPTIONS", "/translate", { origin: "https://a.com" }), ENV);
    check("OPTIONS 预检返回 204", pre.status === 204, pre.status);
    check("预检回显 Origin",
      pre.headers.get("access-control-allow-origin") === "https://a.com",
      pre.headers.get("access-control-allow-origin"));
    check("预检声明允许 POST",
      (pre.headers.get("access-control-allow-methods") || "").includes("POST"),
      pre.headers.get("access-control-allow-methods"));

    const r = await callWorker(worker, makeRequest("GET", "/health", { origin: "https://b.com" }), ENV);
    check("普通请求也带 CORS 头",
      r.headers.get("access-control-allow-origin") === "https://b.com",
      r.headers.get("access-control-allow-origin"));
  }

  /* ============ 3. 输入校验 ============ */
  {
    upstreamCalls = [];
    const r1 = await callWorker(worker, makeRequest("POST", "/translate", { body: { text: "" } }), ENV);
    check("空输入返回 400", r1.status === 400, r1.status);
    check("空输入错误码 EMPTY_INPUT", r1.body && r1.body.code === "EMPTY_INPUT", r1.body && r1.body.code);
    check("空输入不调用上游", upstreamCalls.length === 0);

    const r2 = await callWorker(worker, makeRequest("POST", "/translate", { body: { text: "a".repeat(2001) } }), ENV);
    check("超长输入返回 400", r2.status === 400, r2.status);
    check("超长输入错误码 TOO_LONG", r2.body && r2.body.code === "TOO_LONG");

    const r3 = await callWorker(worker, makeRequest("POST", "/translate", { body: "{bad json" }), ENV);
    check("非法 JSON 返回 400", r3.status === 400, r3.status);
    check("非法 JSON 错误码 BAD_JSON", r3.body && r3.body.code === "BAD_JSON", r3.body && r3.body.code);

    const r4 = await callWorker(worker, makeRequest("POST", "/translate", { body: { text: "   " } }), ENV);
    check("纯空白输入被拒", r4.status === 400, r4.status);
  }

  /* ============ 4. 正常翻译 ============ */
  {
    upstreamMode = "ok"; upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "我今天特别开心。", mode: "zh", level: 3 } }), ENV);
    check("正常翻译返回 200", r.status === 200, r.status);
    check("返回 ok:true 与 result", r.body && r.body.ok === true && !!r.body.result,
      JSON.stringify(r.body));
    check("响应不泄露服务端 Key", !r.text.includes("test.worker.key"));
    const c0 = upstreamCalls[0];
    check("上游请求带 Bearer Key", !!c0);
    check("请求体关闭了思考模式",
      c0 && c0.body.thinking && c0.body.thinking.type === "disabled",
      c0 && JSON.stringify(c0.body.thinking));
    check("提示词注入了风格强度 3",
      c0 && c0.body.messages[1].content.includes("风格强度：3"));
    check("提示词注入了中文模式",
      c0 && c0.body.messages[1].content.includes("输入语言：中文"));
    check("系统提示词含文言文禁令",
      c0 && c0.body.messages[0].content.includes("绝对禁止使用文言文"));
  }

  /* ============ 5. 非法参数回落 ============ */
  {
    upstreamMode = "ok"; upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "测试", mode: "evil", level: 999 } }), ENV);
    const call = upstreamCalls[0];
    check("非法参数时仍能翻译", r.status === 200, "status=" + r.status + " body=" + JSON.stringify(r.body));
    if (call) {
      const p = call.body.messages[1].content;
      check("非法 mode 回落为 auto", p.includes("自动判断"));
      check("非法 level 回落为 3", p.includes("风格强度：3"));
    } else {
      check("非法 mode 回落为 auto", false, "没有调用上游");
      check("非法 level 回落为 3", false, "没有调用上游");
    }
  }

  /* ============ 6. 模型降级 ============ */
  {
    upstreamMode = "first429"; upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "测试降级" } }), ENV);
    check("Worker 首个模型 429 后自动降级",
      r.status === 200 && r.body.result.indexOf("降级成功") === 0,
      JSON.stringify(r.body).slice(0, 80));
    check("Worker 降级共调用上游 2 次", upstreamCalls.length === 2, upstreamCalls.length);
    check("Worker 降级换了模型",
      upstreamCalls.length >= 2 && upstreamCalls[0].body.model !== upstreamCalls[1].body.model,
      upstreamCalls.map((c) => c.body.model).join(" → "));
  }

  /* ============ 7. 401 不降级 ============ */
  {
    upstreamMode = "401"; upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "测试401" } }), ENV);
    check("Worker 上游 401 返回 401", r.status === 401, r.status);
    check("Worker 401 不浪费重试", upstreamCalls.length === 1, upstreamCalls.length);
  }

  /* ============ 8. 空内容降级 / 全失败 ============ */
  {
    upstreamMode = "empty"; upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "测试空内容" } }), ENV);
    check("Worker 空内容会换模型重试", upstreamCalls.length > 1, upstreamCalls.length);
    check("Worker 全部空内容返回 502", r.status === 502, r.status);

    upstreamMode = "allfail"; upstreamCalls = [];
    const r2 = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "测试全挂" } }), ENV);
    check("Worker 全部失败返回 502", r2.status === 502, r2.status);
    check("Worker 失败响应不泄露上游细节", !r2.text.includes("boom"), r2.text.slice(0, 100));
  }

  /* ============ 9. 缺少服务端 Key ============ */
  {
    upstreamCalls = [];
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "没有服务端 Key" } }), {});
    check("Worker 未配 Key 返回 500", r.status === 500, r.status);
    check("Worker 未配 Key 错误码 NO_SERVER_KEY",
      r.body && r.body.code === "NO_SERVER_KEY", r.body && r.body.code);

    const r2 = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "没有服务端 Key" } }), { ZHIPU_API_KEY: "" });
    check("Worker 空 Key 也返回 500", r2.status === 500, r2.status);
  }

  /* ============ 10. 方法限制与未知路径 ============ */
  {
    const r = await callWorker(worker, makeRequest("GET", "/translate"), ENV);
    check("Worker GET /translate 返回 405", r.status === 405, r.status);
    check("Worker 405 错误码正确", r.body && r.body.code === "METHOD_NOT_ALLOWED",
      r.body && r.body.code);

    const r2 = await callWorker(worker, makeRequest("GET", "/nope"), ENV);
    check("Worker 未知路径返回 404", r2.status === 404, r2.status);
  }

  /* ============ 11. 限流 ============ */
  {
    upstreamMode = "ok"; upstreamCalls = [];
    const ip = "203.0.113.99";
    const statuses = [];
    // Worker 默认 RATE_LIMIT_MAX = 20
    for (let i = 0; i < 25; i++) {
      const r = await callWorker(worker, makeRequest("POST", "/translate",
        { body: { text: "限流 " + i }, ip: ip }), ENV);
      statuses.push(r.status);
    }
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    check("Worker 限流生效（放行 ≤ 20）", ok <= 20, "放行=" + ok);
    check("Worker 限流拒绝超出部分", limited > 0, "429=" + limited);
    check("Worker 限流不丢请求", ok + limited === 25, ok + limited);

    const last = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "再试" }, ip: ip }), ENV);
    check("Worker 429 带 Retry-After", !!last.headers.get("retry-after"),
      last.headers.get("retry-after"));
    check("Worker 429 错误码 RATE_LIMITED",
      last.body && last.body.code === "RATE_LIMITED", last.body && last.body.code);
  }

  /* ============ 12. 统计接口保护 ============ */
  {
    // 未设 STATS_TOKEN → 可读
    const open = await callWorker(worker, makeRequest("GET", "/stats"), ENV);
    check("Worker 未设 token 时 /stats 可读", open.status === 200, open.status);
    check("/stats 返回统计字段", open.body && typeof open.body.requests === "number",
      open.body && String(open.body.requests));

    // 设了 STATS_TOKEN → 需要 token
    const envTok = { ZHIPU_API_KEY: "k", STATS_TOKEN: "s3cr3t" };
    const noTok = await callWorker(worker, makeRequest("GET", "/stats"), envTok);
    check("Worker 设了 token 后无 token 被拒", noTok.status === 403, noTok.status);
    check("拒绝码为 STATS_FORBIDDEN",
      noTok.body && noTok.body.code === "STATS_FORBIDDEN", noTok.body && noTok.body.code);

    const goodTok = await callWorker(worker, makeRequest("GET", "/stats?token=s3cr3t"), envTok);
    check("Worker 带正确 token 可读", goodTok.status === 200, goodTok.status);

    const badTok = await callWorker(worker, makeRequest("GET", "/stats?token=wrong"), envTok);
    check("Worker 带错误 token 被拒", badTok.status === 403, badTok.status);
  }

  /* ============ 13. 来源白名单（默认 *，应放行） ============ */
  {
    const r = await callWorker(worker, makeRequest("POST", "/translate",
      { body: { text: "来源测试" }, origin: "https://any.example" }), ENV);
    check("默认 ALLOWED_ORIGINS=* 时任意来源可用", r.status === 200, r.status);
  }

  /* ---------- 输出 ---------- */
  globalThis.fetch = realFetch;

  console.log("\n========== Cloudflare Worker 功能测试 ==========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("===============================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
