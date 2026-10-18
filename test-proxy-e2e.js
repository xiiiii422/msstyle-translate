require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 真实端到端：启动真实 Node 代理（真 Key）→ 用真实页面走代理翻译
   证明"商用模式"链路完整可用，且前端确实拿不到 Key。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const KEY = process.env.TEST_ZHIPU_KEY;
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

process.env.ZHIPU_API_KEY = KEY;
process.env.RATE_LIMIT_MAX = "10000";
process.env.ALLOWED_ORIGINS = "*";

const dir = __dirname;
const app = require(path.join(dir, "proxy", "node-server.js"));
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const __PROMPT_SRC__ = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

(async () => {
  // 1. 启动真实代理
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const proxyUrl = "http://127.0.0.1:" + port;
  console.log("真实代理已启动:", proxyUrl, "\n");

  // 2. 用真实页面 + 真实 fetch（Node 18+ 全局 fetch）
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__MSSTYLE_CONFIG__ = { proxyUrl: proxyUrl };

  const seen = [];
  window.fetch = function (url, opts) {
    seen.push({ url, hasAuth: !!(opts && opts.headers && opts.headers.Authorization) });
    return global.fetch(url, opts);
  };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.eval(__PROMPT_SRC__);   // 先加载共享提示词模块
  window.eval(js);

  const d = window.document;
  const $ = (id) => d.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await new Promise((r) => {
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });

  console.log("=== 走真实代理的完整翻译 ===\n");
  const INPUTS = [
    { text: "我今天特别开心，因为终于放假了。", level: 3 },
    { text: "I'm really happy because we finally have a holiday.", level: 3 },
    { text: "这个计划听起来非常不错。", level: 1 },
  ];

  let ok = 0;
  for (const item of INPUTS) {
    $("levelRange").value = String(item.level);
    $("levelRange").dispatchEvent(new window.Event("input", { bubbles: true }));
    $("inputText").value = item.text;
    $("inputText").dispatchEvent(new window.Event("input", { bubbles: true }));
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    let waited = 0;
    while ($("translateBtn").disabled && waited < 60000) { await sleep(200); waited += 200; }

    const out = ($("outputText").querySelector(".output-text") || {}).textContent || "";
    console.log("原文(L" + item.level + "): " + item.text);
    console.log("结果: " + (out || "(空)"));
    console.log("状态: " + $("statusText").textContent + "  (" + waited + "ms)\n");
    if (out && $("statusText").textContent.includes("翻译完成")) ok++;
  }

  // 3. 关键安全断言：前端从未拿到 Key
  const anyAuth = seen.some((s) => s.hasAuth);
  const anyKeyInUrl = seen.some((s) => s.url.includes("bigmodel.cn"));
  console.log("=== 安全断言 ===");
  console.log("前端发出的请求:", seen.map((s) => s.url.replace(proxyUrl, "")).join(", "));
  console.log("前端是否携带 Authorization 头:", anyAuth ? "✗ 是（不该）" : "✓ 否");
  console.log("前端是否直连智谱:", anyKeyInUrl ? "✗ 是（不该）" : "✓ 否，全部经代理");

  console.log("\n=== 历史记录 ===");
  console.log("条数:", d.querySelectorAll(".history-item").length);

  console.log("\n================================");
  console.log("翻译成功 " + ok + "/" + INPUTS.length +
    (ok === INPUTS.length && !anyAuth && !anyKeyInUrl ? "  ✅ 商用代理模式链路完整" : "  ❌ 有问题"));

  server.close();
  process.exit(ok === INPUTS.length && !anyAuth && !anyKeyInUrl ? 0 : 1);
})();
