require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 端到端：用 jsdom 加载真实页面 + 真实 script.js + 真实网络请求（只把 API_KEY 注入），
   完整走一遍"用户输入 → 点击翻译 → 看到结果"的流程。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { analyze } = require("./detect.js");

const KEY = process.env.TEST_ZHIPU_KEY;
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
let js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const __PROMPT_SRC__ = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");
js = js.replace('const API_KEY = "YOUR_API_KEY";', 'const API_KEY = ' + JSON.stringify(KEY) + ';');

const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
const { window } = dom;

// 用 Node 的真实 https 实现 fetch（jsdom 不带 fetch）
const https = require("https");
window.fetch = function (url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body;

    // 真实浏览器 fetch 必须响应 AbortSignal，否则 script.js 的超时降级逻辑测不出来
    if (opts.signal && opts.signal.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; return reject(e);
    }

    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: opts.method || "GET",
      headers: Object.assign({}, opts.headers, { "Content-Length": Buffer.byteLength(body || "") }),
      timeout: 60000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(d),
          text: async () => d,
        });
      });
    });

    let onAbort = null;
    if (opts.signal) {
      onAbort = () => {
        req.destroy();
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("timeout", () => { req.destroy(); const e = new Error("timeout"); e.name = "AbortError"; reject(e); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};
window.scrollTo = () => {};
window.confirm = () => true;
window.isSecureContext = false;

const logs = [];
const origWarn = window.console.warn, origErr = window.console.error;
window.console.warn = (...a) => { logs.push("WARN " + a.join(" ")); origWarn.apply(window.console, a); };
window.console.error = (...a) => { logs.push("ERR " + a.join(" ")); };

window.eval(__PROMPT_SRC__);   // 先加载共享提示词模块

window.eval(js);
const d = window.document;
const $ = (id) => d.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => {
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });

  console.log("=== 端到端真实翻译（走完整 UI 流程）===\n");
  const INPUTS = [
    "我今天特别开心，因为终于放假了。",
    "I'm really happy because we finally have a holiday.",
    "这个计划听起来非常不错。",
  ];

  let ok = 0, classical = 0;
  for (const text of INPUTS) {
    $("inputText").value = text;
    $("inputText").dispatchEvent(new window.Event("input", { bubbles: true }));
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // 等待真实网络返回
    let waited = 0;
    while ($("translateBtn").disabled && waited < 60000) { await sleep(200); waited += 200; }

    const out = ($("outputText").querySelector(".output-text") || {}).textContent || "";
    const a = analyze(out);
    const status = $("statusText").textContent;
    console.log("原文: " + text);
    console.log("结果: " + out);
    console.log("状态: " + status + "  (" + waited + "ms)");
    console.log("文言词: " + (a.classical.length ? "✗ " + a.classical.join(" ") : "无 ✓"));
    console.log("");

    if (out && status.includes("翻译完成")) ok++;
    if (a.classical.length) classical++;
  }

  console.log("=== 历史记录 ===");
  console.log("条数: " + d.querySelectorAll(".history-item").length + " (应为 3)");
  const stored = JSON.parse(window.localStorage.getItem("msstyle_translate_history_v1") || "[]");
  console.log("localStorage 条数: " + stored.length);
  if (stored[0]) console.log("首条字段: " + Object.keys(stored[0]).join(", "));

  console.log("\n=== 复制结果 ===");
  $("copyBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  console.log("toast: " + JSON.stringify($("toast").textContent));

  console.log("\n=== 控制台日志（观察是否发生了模型降级）===");
  const fallbackLogs = logs.filter((l) => l.includes("备用模型"));
  console.log(fallbackLogs.length ? fallbackLogs.join("\n") : "(未发生降级，首选模型可用)");

  console.log("\n================================");
  console.log(`成功翻译 ${ok}/${INPUTS.length}   文言文泄漏 ${classical}`);
})();
