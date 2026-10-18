require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 部署产物冒烟：确认每一个"可部署入口"都能真正跑起来，
   而不只是语法正确。

   起因：proxy/cloudflare-worker.js 曾被 `node --check` 判为通过，
        但整个 POST 分支引用了未定义的 metrics，线上每次翻译都会 500。
         语法检查抓不到这种问题，只有真正执行一条请求才会暴露。

   这个脚本对每个入口发一条真实（或 mock 上游的）请求：
     · proxy/node-server.js      — 真起服务，打 /health 与 /translate
     · proxy/cloudflare-worker.js — 真调 default.fetch()
     · prompt.js                 — 真跑一遍构建与清洗
     · script.js                 — 用 jsdom 加载并触发一次翻译
   任何一条路径抛异常即失败。 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { pathToFileURL } = require("url");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const realFetch = globalThis.fetch;

/** 统一的假上游响应 */
function fakeUpstream() {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "我今天是特别高兴的，因为假期终于已经到达。" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function httpReq(port, method, p, body) {
  return new Promise((resolve) => {
    const d = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: d ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } : {},
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, text: b }));
    });
    req.on("error", (e) => resolve({ status: -1, text: e.message }));
    if (d) req.write(d);
    req.end();
  });
}

(async () => {
  /* ============ 1. Node 代理：真起服务，打真实请求 ============ */
  {
    process.env.ZHIPU_API_KEY = "smoke.key";
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.LOG_LEVEL = "off";
    fakeUpstream();

    const app = require(path.join(__dirname, "proxy", "node-server.js"));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = server.address().port;

    const cases = [
      ["GET", "/health", null, 200],
      ["GET", "/stats", null, 200],
      ["POST", "/translate", { text: "冒烟测试" }, 200],
      ["POST", "/translate", { text: "" }, 400],
      ["POST", "/translate", { text: "a".repeat(2001) }, 400],
      ["GET", "/nope", null, 404],
    ];
    for (const [m, p, b, expect] of cases) {
      const r = await httpReq(port, m, p, b);
      check(`node-server ${m} ${p} → ${expect}`, r.status === expect,
        `实际 ${r.status} ${r.text.slice(0, 80)}`);
    }
    server.close();
  }

  /* ============ 2. Cloudflare Worker：真调 fetch() ============ */
  {
    fakeUpstream();
    const mod = await import(pathToFileURL(path.join(__dirname, "proxy", "cloudflare-worker.js")).href);
    const env = { ZHIPU_API_KEY: "smoke.key" };

    async function call(method, p, body) {
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      try {
        const res = await mod.default.fetch(new Request("https://p.example" + p, init), env);
        return { status: res.status, text: await res.text(), threw: false };
      } catch (e) {
        return { status: -1, text: e.message, threw: true };
      }
    }

    const cases = [
      ["GET", "/health", undefined, 200],
      ["GET", "/stats", undefined, 200],
      ["POST", "/translate", { text: "冒烟测试" }, 200],
      ["POST", "/translate", { text: "" }, 400],
      ["POST", "/translate", { text: "a".repeat(2001) }, 400],
      ["GET", "/nope", undefined, 404],
    ];
    for (const [m, p, b, expect] of cases) {
      const r = await call(m, p, b);
      check(`worker ${m} ${p} → ${expect}`, !r.threw && r.status === expect,
        r.threw ? `抛异常: ${r.text}` : `实际 ${r.status}`);
    }

    // 关键：确认翻译路径真的返回了内容，而不是"没抛错但空"
    const t = await call("POST", "/translate", { text: "内容检查" });
    let parsed = null;
    try { parsed = JSON.parse(t.text); } catch (_) {}
    check("worker 翻译返回了非空 result",
      parsed && parsed.ok === true && !!parsed.result,
      t.text.slice(0, 120));
  }

  /* ============ 3. prompt.js：共享模块可独立工作 ============ */
  {
    const P = require(path.join(__dirname, "prompt.js"));
    check("prompt.js 导出 buildRequestBody",
      typeof P.buildRequestBody === "function");
    const body = P.buildRequestBody("m", "文本", "auto", 3);
    check("prompt.js 构建的请求体含 thinking 关闭",
      body.thinking && body.thinking.type === "disabled",
      JSON.stringify(body.thinking));
    check("prompt.js 构建的请求体含 2 条消息", body.messages.length === 2);
    check("prompt.js 清洗可正常工作",
      P.cleanResult("翻译结果：你好") === "你好",
      P.cleanResult("翻译结果：你好"));
  }

  /* ============ 4. script.js：jsdom 加载并触发一次翻译 ============ */
  {
    try {
      const { JSDOM } = require("jsdom");
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const dom = new JSDOM(html, {
        runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
      });
      const w = dom.window;
      fakeUpstream();
      w.fetch = globalThis.fetch;
      w.scrollTo = () => {};
      w.confirm = () => true;
      w.__MSSTYLE_CONFIG__ = { apiKey: "smoke.key" };
      w.eval(fs.readFileSync(path.join(__dirname, "prompt.js"), "utf8"));
      w.eval(fs.readFileSync(path.join(__dirname, "config.js"), "utf8"));
      w.eval(fs.readFileSync(path.join(__dirname, "script.js"), "utf8"));

      await new Promise((r) => {
        const d = w.document;
        if (d.readyState !== "loading") return setTimeout(r, 0);
        d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
      });

      const d = w.document;
      d.getElementById("inputText").value = "前端冒烟";
      d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));

      const out = d.getElementById("outputText").textContent;
      check("script.js 能完成一次翻译", out.includes("我今天是特别高兴的"),
        out.slice(0, 60));
      check("script.js 状态显示完成",
        d.getElementById("statusText").textContent.includes("翻译完成"),
        d.getElementById("statusText").textContent);
    } catch (e) {
      check("script.js 能完成一次翻译", false, e.message);
      check("script.js 状态显示完成", false, e.message);
    }
  }

  globalThis.fetch = realFetch;

  /* ---------- 输出 ---------- */
  console.log("\n========= 部署入口冒烟（真执行）=========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=========================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
