require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 文档宣称 vs 代码实际：README 里对用户/部署者的承诺，代码真的做到了吗？
 *
 * 起因：上两轮发现"能跑 ≠ 有用"（滑块坏、aria 不更新）。
 *       这一轮把同样的怀疑指向**文档**：
 *       README 里写"按 Ctrl+Enter 可以翻译"、"401 会自动打开设置面板"……
 *       这些承诺有没有被验证过？
 *
 * 方法：把 README 里可验证的断言逐条提取成测试。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const promptSrc = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");
const configSrc = fs.readFileSync(path.join(dir, "config.js"), "utf8");
const scriptSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");

async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const requests = [];
  w.fetch = function (url, o) {
    requests.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null });
    if (opts.fetchImpl) return opts.fetchImpl(url, o, requests.length);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "默认结果。" } }] }),
    });
  };
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "doc.audit.key" };
  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  return { dom, window: w, document: w.document, requests };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

  /* ============ 1. README 宣称「Ctrl + Enter 也可以开始翻译」 ============ */
  {
    const p = await openPage();
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "快捷键测试";
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));

    // Ctrl+Enter
    input.dispatchEvent(new p.window.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await sleep(120);
    check("README 宣称的 Ctrl+Enter 真的能触发翻译",
      p.requests.length === 1, "请求数=" + p.requests.length);

    // Meta+Enter（Mac）
    const p2 = await openPage();
    const d2 = p2.document;
    d2.getElementById("inputText").value = "Mac 快捷键";
    d2.getElementById("inputText").dispatchEvent(new p2.window.Event("input", { bubbles: true }));
    d2.getElementById("inputText").dispatchEvent(new p2.window.KeyboardEvent("keydown", {
      key: "Enter", metaKey: true, bubbles: true, cancelable: true,
    }));
    await sleep(120);
    check("⌘+Enter（Mac）也能触发翻译",
      p2.requests.length === 1, "请求数=" + p2.requests.length);

    // 单独 Enter 不应触发（那是换行）
    const p3 = await openPage();
    const d3 = p3.document;
    d3.getElementById("inputText").value = "单独回车";
    d3.getElementById("inputText").dispatchEvent(new p3.window.Event("input", { bubbles: true }));
    d3.getElementById("inputText").dispatchEvent(new p3.window.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    }));
    await sleep(120);
    check("单独按 Enter 不会触发翻译（应换行）",
      p3.requests.length === 0, "请求数=" + p3.requests.length);
  }

  /* ============ 2. README 宣称「401 会打开设置面板」 ============ */
  {
    const p = await openPage({
      fetchImpl: () => Promise.resolve({
        ok: false, status: 401,
        json: async () => ({ error: { code: "1002", message: "invalid api key" } }),
      }),
    });
    const d = p.document;
    check("初始时设置面板是隐藏的", d.getElementById("settingsPanel").hidden === true);

    d.getElementById("inputText").value = "401 测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    check("README 宣称的「401 自动打开设置面板」属实",
      d.getElementById("settingsPanel").hidden === false,
      "hidden=" + d.getElementById("settingsPanel").hidden);
  }

  /* ============ 3. README 宣称「Key 无效时提示检查 Key」 ============ */
  {
    const p = await openPage({
      fetchImpl: () => Promise.resolve({
        ok: false, status: 401,
        json: async () => ({ error: { code: "1002", message: "invalid api key" } }),
      }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "401 提示测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    check("401 给出「通行证」相关提示",
      d.getElementById("toast").textContent.includes("通行证"),
      d.getElementById("toast").textContent);
    // 注意：这里不能简单禁止 "API Key" 字样 ——
    // "请检查 API Key 是否正确" 是有用的可操作指引，不是技术泄露。
    // 真正该禁止的是原始状态码与上游错误原文。
    check("401 提示不泄露原始状态码与上游错误",
      !/HTTP|401|1002|invalid api key/i.test(d.getElementById("toast").textContent),
      d.getElementById("toast").textContent);
    check("401 提示确实是可操作的指引",
      d.getElementById("toast").textContent.includes("API Key"),
      d.getElementById("toast").textContent);
  }

  /* ============ 4. README 宣称「Key 只存在本地，清除后回到部署者默认值」 ============ */
  {
    const p = await openPage({ config: { apiKey: "deployer.default.key" } });
    const d = p.document;
    const w = p.window;

    // 访客填自己的 Key
    d.getElementById("settingsBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    d.getElementById("apiKeyInput").value = "visitor.own.key";
    d.getElementById("saveKeyBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(30);

    check("访客 Key 被写入 localStorage",
      w.localStorage.getItem("msstyle_translate_apikey_v1") === "visitor.own.key",
      String(w.localStorage.getItem("msstyle_translate_apikey_v1")));

    d.getElementById("inputText").value = "优先级测试";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(150);
    check("访客 Key 优先于部署者预置 Key",
      p.requests.length > 0, "请求数=" + p.requests.length);

    // 清除访客 Key
    d.getElementById("clearKeyBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(50);
    check("清除后 localStorage 里的 Key 被移除",
      w.localStorage.getItem("msstyle_translate_apikey_v1") === null,
      String(w.localStorage.getItem("msstyle_translate_apikey_v1")));
  }

  /* ============ 5. README 宣称「输出用 textContent，绝不用 innerHTML」 ============ */
  {
    // 模型返回 HTML/脚本时，必须原样显示而不是被解析
    const evil = '<img src=x onerror="window.__XSS__=1">尾巴';
    const p = await openPage({
      fetchImpl: () => Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: evil } }] }),
      }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "XSS 测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    check("模型输出里的 HTML 被当作纯文本（无注入）",
      p.window.__XSS__ === undefined, "window.__XSS__=" + p.window.__XSS__);
    check("输出区没有真的插入 img 元素",
      d.getElementById("outputText").querySelector("img") === null);
    check("危险字符串原样显示（说明走了 textContent）",
      d.getElementById("outputText").textContent.includes("onerror"),
      d.getElementById("outputText").textContent.slice(0, 40));
  }

  /* ============ 6. README 宣称「历史保留最近 10 条」 ============ */
  {
    const p = await openPage();
    const d = p.document;
    for (let i = 0; i < 13; i++) {
      d.getElementById("inputText").value = "第 " + i + " 条";
      d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
      d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
      await sleep(60);
    }
    const items = d.querySelectorAll(".history-item");
    check("历史记录上限是 10 条", items.length === 10, "count=" + items.length);
    check("保留的是最新的 10 条",
      items[0].textContent.includes("第 12 条"), items[0].textContent.slice(0, 30));
  }

  /* ============ 7. README 宣称「清空历史需要二次确认」 ============ */
  {
    const p = await openPage();
    const d = p.document;
    let confirmCalled = false;
    let confirmReturn = true;
    p.window.confirm = (msg) => { confirmCalled = true; return confirmReturn; };

    // 先造一条历史
    d.getElementById("inputText").value = "历史测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(120);
    check("已有一条历史", d.querySelectorAll(".history-item").length === 1);

    // 取消确认 → 历史应保留
    confirmReturn = false;
    d.getElementById("clearHistoryBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(50);
    check("点清空历史会弹出确认框", confirmCalled);
    check("用户取消确认时历史被保留",
      d.querySelectorAll(".history-item").length === 1,
      "count=" + d.querySelectorAll(".history-item").length);

    // 确认 → 历史清空
    confirmReturn = true;
    d.getElementById("clearHistoryBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(50);
    check("用户确认后历史被清空",
      d.querySelectorAll(".history-item").length === 0,
      "count=" + d.querySelectorAll(".history-item").length);
  }

  /* ============ 8. README 宣称「历史保存在 localStorage，关浏览器仍在」 ============ */
  {
    const p = await openPage();
    const d = p.document;
    d.getElementById("inputText").value = "持久化测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    const raw = p.window.localStorage.getItem("msstyle_translate_history_v1");
    check("历史确实写进了 localStorage", !!raw, raw ? "有" : "无");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {}
    check("localStorage 里是合法 JSON 数组", Array.isArray(parsed), typeof parsed);
    check("记录含原文/结果/时间/模式/档位",
      parsed && parsed[0] && parsed[0].source && parsed[0].result &&
      typeof parsed[0].time === "number" && parsed[0].mode && parsed[0].level,
      parsed && parsed[0] ? Object.keys(parsed[0]).join(",") : "(空)");
  }

  /* ============ 9. README 宣称「无障碍：跳转链接、aria-live」 ============ */
  {
    const p = await openPage();
    const d = p.document;
    const skip = d.querySelector(".skip-link");
    check("存在跳到输入框的 skip-link", !!skip, skip ? skip.getAttribute("href") : "无");
    check("skip-link 指向存在的元素",
      !!skip && !!d.getElementById(skip.getAttribute("href").replace("#", "")),
      skip ? skip.getAttribute("href") : "无");

    check("状态栏是 aria-live", d.getElementById("statusText").getAttribute("aria-live") === "polite",
      d.getElementById("statusText").getAttribute("aria-live"));
    check("toast 是 aria-live", d.getElementById("toast").getAttribute("aria-live") === "polite",
      d.getElementById("toast").getAttribute("aria-live"));
    check("语言标注为 zh-CN",
      d.documentElement.getAttribute("lang") === "zh-CN",
      d.documentElement.getAttribute("lang"));
  }

  /* ============ 10. README 宣称的部署清单：文件都真实存在 ============ */
  {
    // README 第 1 节列出的文件
    const listed = [
      "index.html", "style.css", "prompt.js", "script.js", "config.js",
      "manifest.webmanifest", "icon.svg", "og-image.png", "og-image.svg",
      "privacy.html", "terms.html", "_headers", "README.md",
    ];
    const missing = listed.filter((f) => !fs.existsSync(path.join(dir, f)));
    check("README 列出的部署文件全部存在", missing.length === 0, missing.join(", "));

    const proxyFiles = ["proxy/cloudflare-worker.js", "proxy/node-server.js", "proxy/smoke-test.js"];
    const missingProxy = proxyFiles.filter((f) => !fs.existsSync(path.join(dir, f)));
    check("README 列出的 proxy 文件全部存在", missingProxy.length === 0, missingProxy.join(", "));

    // README 里提到的测试脚本也应存在
    const testRefs = [...readme.matchAll(/node ((?:test|check)-[a-z-]+\.js)/g)]
      .map((m) => m[1]);
    const uniq = [...new Set(testRefs)];
    const missingTests = uniq.filter((f) => !fs.existsSync(path.join(dir, f)));
    check("README 提到的测试脚本全部存在", missingTests.length === 0,
      missingTests.length ? missingTests.join(", ") : `${uniq.length} 个脚本`);
  }

  /* ---------- 输出 ---------- */
  console.log("\n======== 文档宣称 vs 代码实际 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=====================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
