require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 客户端代理模式测试：验证前端在配置 proxyUrl 后的行为
   —— 探测、走代理、失败回退直连、UI 适配、限流提示 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const __PROMPT_SRC__ = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const { window } = dom;
  if (opts.externalConfig) window.__MSSTYLE_CONFIG__ = opts.externalConfig;

  const calls = [];
  window.fetch = function (url, o) {
    const rec = { url, method: (o && o.method) || "GET", body: o && o.body ? JSON.parse(o.body) : null };
    calls.push(rec);
    if (opts.fetchImpl) return opts.fetchImpl(rec, calls.length, o);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: "默认结果" }) });
  };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.eval(__PROMPT_SRC__);   // 先加载共享提示词模块
  window.eval(js);
  return { dom, window, document: window.document, calls };
}

const waitInit = (window) => new Promise((resolve) => {
  const d = window.document;
  if (d.readyState !== "loading") return setTimeout(resolve, 0);
  d.addEventListener("DOMContentLoaded", () => setTimeout(resolve, 0), { once: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 常见的代理响应 */
const proxyOk = (text) => ({
  ok: true, status: 200, json: async () => ({ ok: true, result: text || "我是真正地高兴的，因为假期已经到达。" }),
});

(async () => {

  /* ============ 1. 代理模式：探测 + 走代理 ============ */
  {
    const { window, document: d, calls } = makeDom({
      externalConfig: { proxyUrl: "https://proxy.example" },
      fetchImpl: (rec) => {
        if (rec.url.endsWith("/health")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        return Promise.resolve(proxyOk());
      },
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    check("[代理] 不弹首次引导", $("onboarding").hidden === true);
    check("[代理] 设置按钮无 needs-key 红点", !$("settingsBtn").classList.contains("needs-key"));
    check("[代理] 隐藏 API Key 输入项",
      $("apiKeyInput").closest(".field").hidden === true);
    check("[代理] 隐藏模型选择项",
      $("modelSelect").closest(".field").hidden === true);
    check("[代理] 隐藏保存/清除按钮",
      $("saveKeyBtn").hidden === true && $("clearKeyBtn").hidden === true);
    check("[代理] 状态文案说明无需填 Key",
      $("keyStatus").textContent.includes("无需填写"), $("keyStatus").textContent);

    $("inputText").value = "我今天特别开心。";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(120);

    const health = calls.find((c) => c.url.endsWith("/health"));
    const translate = calls.find((c) => c.url.endsWith("/translate"));
    check("[代理] 先探测 /health", !!health, calls.map((c) => c.url).join(", "));
    check("[代理] 再调用 /translate", !!translate, calls.map((c) => c.url).join(", "));
    check("[代理] 翻译请求体含 text/mode/level",
      translate && translate.body && translate.body.text === "我今天特别开心。" &&
      translate.body.mode === "auto" && translate.body.level === 3,
      translate && JSON.stringify(translate.body));
    check("[代理] 前端未接触任何 Key（无 Authorization 头）",
      !calls.some((c) => c.body && c.body.apiKey));
    check("[代理] 结果正常渲染",
      $("outputText").textContent.includes("我是真正地高兴的"), $("outputText").textContent.slice(0, 40));
    check("[代理] 状态为完成", $("statusText").textContent.includes("翻译完成"));
  }

  /* ============ 2. 代理不可用 → 回退直连 ============ */
  {
    const { window, document: d, calls } = makeDom({
      externalConfig: { proxyUrl: "https://proxy.example", apiKey: "direct.fallback.key" },
      fetchImpl: (rec) => {
        if (rec.url.endsWith("/health")) return Promise.reject(new TypeError("Failed to fetch"));
        // 直连走的是智谱
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "直连得到的结果。" } }] }),
        });
      },
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    $("inputText").value = "测试回退";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("[回退] 探测失败后仍能翻译成功",
      $("outputText").textContent.includes("直连得到的结果"), $("outputText").textContent.slice(0, 40));
    const direct = calls.find((c) => c.url.includes("bigmodel.cn"));
    check("[回退] 确实回退到了直连智谱接口", !!direct, calls.map((c) => c.url).join(", "));
  }

  /* ============ 3. 代理 500 → 回退直连 ============ */
  {
    const { window, document: d, calls } = makeDom({
      externalConfig: { proxyUrl: "https://proxy.example", apiKey: "k2" },
      fetchImpl: (rec) => {
        if (rec.url.endsWith("/health")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        if (rec.url.endsWith("/translate")) {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, code: "NO_SERVER_KEY", message: "no key" }) });
        }
        return Promise.resolve({ ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "回退结果。" } }] }) });
      },
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);
    $("inputText").value = "代理500";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(150);
    check("[代理500] 回退直连成功",
      $("outputText").textContent.includes("回退结果"), $("outputText").textContent.slice(0, 40));
  }

  /* ============ 4. 代理 429（限流）→ 不回退，给友好提示 ============ */
  {
    const { window, document: d, calls } = makeDom({
      externalConfig: { proxyUrl: "https://proxy.example", apiKey: "k3" },
      fetchImpl: (rec) => {
        if (rec.url.endsWith("/health")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        return Promise.resolve({
          ok: false, status: 429,
          json: async () => ({ ok: false, code: "RATE_LIMITED", message: "请求太频繁了，请 60 秒后再试。" }),
        });
      },
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);
    $("inputText").value = "代理限流";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("[代理429] 给出友好提示（不泄露技术细节）",
      $("toast").textContent.includes("人实在是太多") || $("toast").textContent.includes("稍等"),
      $("toast").textContent);
    const direct = calls.find((c) => c.url.includes("bigmodel.cn"));
    check("[代理429] 不会回退直连（限流绕不过去）", !direct, calls.map((c) => c.url).join(", "));
  }

  /* ============ 5. 未配置 proxyUrl → 行为与之前一致（回归） ============ */
  {
    const { window, document: d, calls } = makeDom({
      fetchImpl: () => Promise.resolve(proxyOk("不该走代理")),
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);
    check("[无代理] 未配 Key 时弹出引导", $("onboarding").hidden === false);
    check("[无代理] 不发 /health 探测",
      !calls.some((c) => c.url.endsWith("/health")), calls.map((c) => c.url).join(", "));
    check("[无代理] 设置面板 Key 输入项可见",
      $("apiKeyInput").closest(".field").hidden === false);
  }

  /* ============ 6. 代理地址尾部斜杠处理 ============ */
  {
    const { window, calls } = makeDom({
      externalConfig: { proxyUrl: "https://proxy.example/" },
      fetchImpl: (rec) => {
        if (rec.url.endsWith("/health")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        return Promise.resolve(proxyOk());
      },
    });
    await waitInit(window);
    window.document.getElementById("inputText").value = "斜杠测试";
    window.document.getElementById("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(120);
    check("[斜杠] 尾部斜杠被规范化（不产生 //health）",
      !calls.some((c) => c.url.includes("//health")), calls.map((c) => c.url).join(", "));
  }

  /* ============ 输出 ============ */
  console.log("\n========== 客户端代理模式测试 ==========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("========================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
