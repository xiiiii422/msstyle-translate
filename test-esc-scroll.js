/* 验证：ESC 全局关闭设置面板、面板与抽屉的滚动锁定 */
require("./check-integrity.js");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const results = [];
const check = (n, c, e) => results.push({ n, c: !!c, e: e || "" });

(async () => {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  w.scrollTo = () => {}; w.confirm = () => true;
  w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  w.__MSSTYLE_CONFIG__ = { apiKey: "k" };
  w.fetch = () => Promise.resolve({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "x" } }] }) });
  w.eval(fs.readFileSync(path.join(dir, "prompt.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(dir, "config.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(dir, "script.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 60));

  const $ = (id) => d.getElementById(id);

  /* ===== 1. 设置面板：打开时锁滚动，关闭时解锁 ===== */
  $("settingsBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("设置面板打开时 body.overflow=hidden",
    d.body.style.overflow === "hidden", d.body.style.overflow);

  $("settingsCloseBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("设置面板关闭后 body.overflow 恢复",
    d.body.style.overflow === "", JSON.stringify(d.body.style.overflow));

  /* ===== 2. 设置面板：焦点不在面板内时按 ESC 也能关闭 ===== */
  $("settingsBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  // 焦点移到 body（模拟用户点了别处再按 Esc）
  $("settingsBtn").focus();
  d.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("焦点在面板外时 ESC 仍关闭设置面板",
    d.getElementById("settingsPanel").hidden === true);

  /* ===== 3. 历史抽屉：打开时锁滚动，关闭时解锁 ===== */
  $("inputText").value = "滚动锁定测试";
  $("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  $("historyFab").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("历史抽屉打开时 body.overflow=hidden",
    d.body.style.overflow === "hidden", d.body.style.overflow);
  check("FAB aria-expanded=true",
    $("historyFab").getAttribute("aria-expanded") === "true");

  d.querySelector(".history-close").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("历史抽屉关闭后 body.overflow 恢复",
    d.body.style.overflow === "", d.body.style.overflow);

  /* ===== 4. ESC 优先级：抽屉开着时按 ESC 只关抽屉 ===== */
  $("inputText").value = "优先级测试";
  $("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  $("historyFab").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("抽屉开着时 ESC 只关抽屉（不影响设置面板状态）",
    !d.body.classList.contains("history-open"),
    "history-open 仍存在");

  console.log("\n===== ESC 全局 / 滚动锁定 =====");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.c) { pass++; console.log("  PASS  " + r.n); }
    else { fail++; console.log("  FAIL  " + r.n + (r.e ? "  <- " + r.e : "")); }
  }
  console.log("================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
