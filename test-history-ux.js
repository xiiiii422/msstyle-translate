/* 验证历史记录三项新体验：渐进显示、单条复制、无记录时收起 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

(async () => {
  const results = [];
  const check = (n, c, e) => results.push({ n, c: !!c, e: e || "" });

  async function open(withKey) {
    const dom = new JSDOM(html, {
      runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
    });
    const w = dom.window, d = w.document;
    // 注入 CSS
    const style = d.createElement("style");
    style.textContent = css;
    d.head.appendChild(style);

    w.scrollTo = () => {}; w.confirm = () => true;
    w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    w.__MSSTYLE_CONFIG__ = withKey ? { apiKey: "k" } : {};
    d.execCommand = () => true;   // 历史复制走 legacyCopy
    let n = 0;
    w.fetch = () => Promise.resolve({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "结果 " + (++n) } }] }) });
    w.eval(fs.readFileSync(path.join(dir, "prompt.js"), "utf8"));
    w.eval(fs.readFileSync(path.join(dir, "config.js"), "utf8"));
    w.eval(fs.readFileSync(path.join(dir, "script.js"), "utf8"));
    await new Promise((r) => setTimeout(r, 60));
    return { w, d };
  }

  /* ===== A. 无记录：整个历史卡片收起 ===== */
  {
    const { d } = await open(true);
    const card = d.querySelector(".history-card");
    check("无记录时历史卡片整体隐藏", card.hidden === true, "hidden=" + card.hidden);
    check("CSS 有 .history-card[hidden] 收起规则", /\.history-card\[hidden\]/.test(css));
  }

  /* ===== B. 有记录：卡片出现 + 单条复制 ===== */
  {
    const { w, d } = await open(true);
    for (let i = 0; i < 2; i++) {
      d.getElementById("inputText").value = "历史复制 " + i;
      d.getElementById("inputText").dispatchEvent(new w.Event("input", { bubbles: true }));
      d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }

    const card = d.querySelector(".history-card");
    check("有记录后历史卡片显示", card.hidden === false);

    const first = d.querySelector(".history-item");
    const copyBtn = first.querySelector(".history-copy");
    check("每条历史有复制按钮", !!copyBtn);
    check("按钮 aria-label 正确", copyBtn.getAttribute("aria-label") === "复制这条翻译结果");

    // hover 才显示（桌面）：CSS 里 opacity 0 → hover 1
    check("CSS: 复制按钮默认透明", /\.history-copy\s*\{[^}]*opacity:\s*0/.test(css));
    check("CSS: hover 时出现", /\.history-item:hover \.history-copy/.test(css));
    check("CSS: 触屏设备常驻", /@media \(hover: none\)/.test(css));

    // 点击复制（stopPropagation 不应触发回填）
    const before = d.getElementById("inputText").value;
    copyBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    check("复制后文案变「已复制」", copyBtn.textContent === "已复制", copyBtn.textContent);
    check("复制按钮点击不触发整条回填",
      d.getElementById("inputText").value === before,
      d.getElementById("inputText").value);
    check("复制按钮带 is-done 成功态", copyBtn.classList.contains("is-done"));

    await new Promise((r) => setTimeout(r, 1700));
    check("1.6s 后恢复「复制」", copyBtn.textContent === "复制", copyBtn.textContent);
  }

  /* ===== C. 清空历史后卡片再次收起 ===== */
  {
    const { w, d } = await open(true);
    d.getElementById("inputText").value = "一条";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    w.confirm = () => true;
    d.getElementById("clearHistoryBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check("清空历史后卡片收起", d.querySelector(".history-card").hidden === true);
  }

  /* ===== D. 首次访客（无 Key 无记录）：引导弹出，历史隐藏 ===== */
  {
    const { d } = await open(false);
    check("首访：引导弹出", d.getElementById("onboarding").hidden === false);
    check("首访：历史卡片隐藏（不干扰引导）",
      d.querySelector(".history-card").hidden === true);
  }

  console.log("\n===== 历史记录体验验证 =====");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.c) { pass++; console.log("  PASS  " + r.n); }
    else { fail++; console.log("  FAIL  " + r.n + (r.e ? "  <- " + r.e : "")); }
  }
  console.log("================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
