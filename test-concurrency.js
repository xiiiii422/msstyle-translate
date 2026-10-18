require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 并发 / 负载验证
   目的：代理在多个用户同时打的时候会不会算错、漏算、串数据。
   重点检查共享可变状态：限流桶、指标计数、模块级变量。 */
const path = require("path");
const http = require("http");

process.env.ZHIPU_API_KEY = "concurrency.test.key";
process.env.RATE_LIMIT_MAX = "100000";   // 先关掉限流，单独测并发正确性
process.env.ALLOWED_ORIGINS = "*";
process.env.LOG_LEVEL = "off";           // 静音，避免刷屏

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const app = require(path.join(__dirname, "proxy", "node-server.js"));

/** 上游 mock：可控延迟 + 可注入失败 + 回显输入，用来验证"没有串数据" */
let upstreamCalls = 0;
let delayMs = 0;
let failEvery = 0;      // 每 N 个请求失败一次（0 = 不失败）
let failAll = false;    // 让所有上游调用都失败（测"最终失败"路径）
let failByText = null;  // 按输入内容决定是否失败（并发下更可控）
global.fetch = async function (url, opts) {
  upstreamCalls++;
  const n = upstreamCalls;
  const body = JSON.parse(opts.body);
  const userText = body.messages[1].content.match(/>>>\n([\s\S]*?)\n<<</)[1];

  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

  const shouldFail = failAll ||
    (failEvery && n % failEvery === 0) ||
    (failByText && failByText(userText));

  if (shouldFail) {
    return { ok: false, status: 503, json: async () => ({ error: { code: "500", message: "boom" } }) };
  }
  // 回显输入，便于验证并发下响应没有串到别人身上
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "回显:" + userText } }] }),
  };
};

function post(port, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text });
    const r = http.request({
      host: "127.0.0.1", port, path: "/translate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", reject);
    r.write(data); r.end();
  });
}

function get(port, ppath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: ppath, method: "GET" }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  /* ============ 1. 50 个并发请求，每个带唯一标记 ============ */
  {
    app.__resetMetrics();
    upstreamCalls = 0; delayMs = 0; failEvery = 0;

    const N = 50;
    const texts = [];
    for (let i = 0; i < N; i++) texts.push("并发标记-" + i);

    const t0 = Date.now();
    const responses = await Promise.all(texts.map((t) => post(port, t)));
    const ms = Date.now() - t0;

    const allOk = responses.every((r) => r.status === 200);
    check("50 个并发请求全部成功", allOk,
      "失败数=" + responses.filter((r) => r.status !== 200).length);

    // 关键：每个响应必须对应自己的输入，不能串
    let mismatched = 0;
    responses.forEach((r, i) => {
      const expect = "回显:并发标记-" + i;
      if (!r.body || r.body.result !== expect) mismatched++;
    });
    check("并发下响应没有串数据（一一对应）", mismatched === 0, "错配数=" + mismatched);

    check("上游调用次数等于请求数", upstreamCalls === N, "upstreamCalls=" + upstreamCalls);

    const st = await get(port, "/stats");
    check("指标计数在并发下准确", st.body.requests === N && st.body.succeeded === N,
      "requests=" + st.body.requests + " succeeded=" + st.body.succeeded);
    check("并发成功率达到 1", st.body.successRate === 1, String(st.body.successRate));

    console.log(`  （50 并发耗时 ${ms}ms）`);
  }

  /* ============ 2. 慢上游 + 高并发（请求会重叠在途） ============ */
  {
    app.__resetMetrics();
    upstreamCalls = 0; delayMs = 30; failEvery = 0;

    const N = 30;
    const texts = [];
    for (let i = 0; i < N; i++) texts.push("慢请求-" + i);

    const t0 = Date.now();
    const responses = await Promise.all(texts.map((t) => post(port, t)));
    const elapsed = Date.now() - t0;

    check("慢上游下 30 并发全部成功",
      responses.every((r) => r.status === 200),
      "失败=" + responses.filter((r) => r.status !== 200).length);

    let mismatched = 0;
    responses.forEach((r, i) => {
      if (!r.body || r.body.result !== "回显:慢请求-" + i) mismatched++;
    });
    check("慢上游下依然没有串数据", mismatched === 0, "错配=" + mismatched);

    // 30 个请求 × 30ms 串行要 900ms；并发应该在 200ms 内完成
    check("请求确实并行执行（未被串行化）", elapsed < 500, elapsed + "ms");
    console.log(`  （30 并发 × 30ms 延迟，实际耗时 ${elapsed}ms —— 串行需 900ms）`);

    const st = await get(port, "/stats");
    check("慢请求场景指标准确", st.body.succeeded === N, "succeeded=" + st.body.succeeded);
  }

  /* ============ 3. 部分失败：混合成功与失败 ============ */
  {
    app.__resetMetrics();
    upstreamCalls = 0; delayMs = 0; failEvery = 0;
    // 按内容决定成败：偶数编号的输入必定失败，奇数必定成功。
    // （用 failEvery 计数不行：代理会对同一个请求重试 3 个模型，
    //   计数会被重试打乱，导致"看起来没有失败"。）
    failByText = (t) => {
      const m = t.match(/混合-(\d+)/);
      return m ? Number(m[1]) % 2 === 0 : false;
    };

    const N = 40;
    const texts = [];
    for (let i = 0; i < N; i++) texts.push("混合-" + i);

    const responses = await Promise.all(texts.map((t) => post(port, t)));
    const ok = responses.filter((r) => r.status === 200).length;
    const bad = responses.filter((r) => r.status !== 200).length;

    check("部分失败：确实是混合结果（有成功也有失败）", ok > 0 && bad > 0,
      `ok=${ok} bad=${bad}`);
    check("部分失败：成功的都是 200", ok === 20, "ok=" + ok);
    check("部分失败：失败的返回 5xx",
      responses.filter((r) => r.status !== 200).every((r) => r.status >= 500),
      "状态集合=" + [...new Set(responses.map((r) => r.status))].join(","));

    // 成功的那一半必须内容正确（没有因为失败请求而串数据）
    let successMismatch = 0;
    responses.forEach((r, i) => {
      if (r.status === 200 && (!r.body || r.body.result !== "回显:混合-" + i)) successMismatch++;
    });
    check("部分失败：成功的响应内容依然一一对应", successMismatch === 0,
      "错配=" + successMismatch);

    const st = await get(port, "/stats");
    check("指标：成功数 + 失败数 = 总请求数",
      st.body.succeeded + st.body.failed === N,
      st.body.succeeded + " + " + st.body.failed + " != " + N);
    check("指标：成功数正确", st.body.succeeded === 20, "succeeded=" + st.body.succeeded);
    check("指标记录了上游错误", st.body.upstreamErrors > 0, "upstreamErrors=" + st.body.upstreamErrors);
    console.log(`  （混合负载：成功 ${ok}，失败 ${bad}）`);
    failByText = null;
  }

  /* ============ 4. 并发 + 限流：不能超发 ============ */
  {
    // 换一个低限额实例
    const savedLimit = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = "10";
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appRl = require(modPath);
    appRl.__resetMetrics();

    const s2 = await new Promise((resolve) => {
      const s = appRl.listen(0, () => resolve(s));
    });
    const p2 = s2.address().port;

    upstreamCalls = 0; delayMs = 0; failEvery = 0;

    // 同时打 30 个，限额 10
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(p2, "限流并发-" + i))
    );
    const ok = responses.filter((r) => r.status === 200).length;
    const limited = responses.filter((r) => r.status === 429).length;

    check("并发限流：放行数不超过限额", ok <= 10, "放行=" + ok);
    check("并发限流：超出的都被拒", limited === 30 - ok, `429=${limited} ok=${ok}`);
    check("并发限流：没有请求被漏掉", ok + limited === 30, ok + limited);

    const st = await get(p2, "/stats");
    check("并发限流指标一致", st.body.rateLimited === limited,
      `stats=${st.body.rateLimited} 实际=${limited}`);
    console.log(`  （30 并发 / 限额 10 → 放行 ${ok}，拒绝 ${limited}）`);

    s2.close();
    process.env.RATE_LIMIT_MAX = savedLimit;
    delete require.cache[modPath];
    require(modPath);
  }

  /* ============ 5. 限流桶不会无限增长（内存泄漏） ============ */
  {
    const savedLimit = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = "100000";
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appMem = require(modPath);
    const s3 = await new Promise((resolve) => {
      const s = appMem.listen(0, () => resolve(s));
    });
    const p3 = s3.address().port;

    // 用 600 个不同 IP 各打一次，触发清理阈值逻辑
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => {
        const data = JSON.stringify({ text: "ip-" + i });
        const r = http.request({
          host: "127.0.0.1", port: p3, path: "/translate", method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            "X-Forwarded-For": "10.0." + Math.floor(i / 255) + "." + (i % 255),
          },
        }, (res) => { res.resume(); res.on("end", resolve); });
        r.on("error", resolve);
        r.write(data); r.end();
      });
    }

    const st = await get(p3, "/stats");
    check("大量不同 IP 后服务仍存活", st.status === 200, st.status);
    check("大量不同 IP 的请求都被记账", st.body.requests === 600, "requests=" + st.body.requests);

    s3.close();
    process.env.RATE_LIMIT_MAX = savedLimit;
    delete require.cache[modPath];
    require(modPath);
  }

  server.close();

  /* ============ 输出 ============ */
  console.log("\n========== 并发 / 负载验证 ==========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=====================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
