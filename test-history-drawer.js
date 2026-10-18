/* 移动端历史抽屉：打开/关闭/Esc/遮罩/FAB 渐进显示 */
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
    json: async () => ({ choices: [{ message: { content: "结果 " + Math.random() } }] }) });
  d.execCommand = () => true;
  w.eval(fs.readFileSync(path.join(dir, "prompt.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(dir, "config.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(dir, "script.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 60));

  const $ = (id) => d.getElementById(id);
  const bodyHas = (cls) => d.body.classList.contains(cls);

  /* ===== 1. 无记录：FAB 隐藏 ===== */
  check("无记录时 FAB 隐藏", $("historyFab").hidden === true);

  /* ===== 2. 翻译后 FAB 出现 ===== */
  $("inputText").value = "抽屉测试";
  $("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  check("翻译后 FAB 出现", $("historyFab").hidden === false);

  /* ===== 3. 点 FAB 打开抽屉 ===== */
  $("historyFab").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check("点 FAB 后 body 加 history-open", bodyHas("history-open"));
  check("遮罩显示", $("historyCard") && !d.querySelector(".history-backdrop").hidden);
  check("FAB aria-expanded=true", $("historyFab").getAttribute("aria-expanded") === "true");

  /* ===== 4. 抽屉里点历史条目 → 回填并关闭抽屉？ ===== */
  // （当前实现：回填但抽屉保持打开——验证现状，回填后用户自己关）
  const item = d.querySelector(".history-item");
  check("抽屉里有历史条目", !!item);
  item.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check("抽屉内点条目会回填原文", $("inputText").value.includes("抽屉测试"));

  /* ===== 5. 点关闭按钮 ===== */
  $("historyCloseBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check("点关闭后 body 移除 history-open", !bodyHas("history-open"));
  check("遮罩隐藏", d.querySelector(".history-backdrop").hidden === true);

  /* ===== 6. 再打开 → Esc 关闭 ===== */
  $("historyFab").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  check("Esc 关闭抽屉", !bodyHas("history-open"));

  /* ===== 7. 再打开 → 点遮罩关闭 ===== */
  $("historyFab").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  d.querySelector(".history-backdrop").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  check("点遮罩关闭抽屉", !bodyHas("history-open"));

  /* ===== 8. 无锁崩溃恢复守卫未误触发 ===== */
  check("守卫未误触发（.history-backdrop 仍存在）", !!d.querySelector(".history-backdrop"));

  console.log("\n===== 移动端历史抽屉 =====");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.c) { pass++; console.log("  PASS  " + r.n); }
    else { fail++; console.log("  FAIL  " + r.n + (r.e ? "  <- " + r.e : "")); }
  }
  console.log("================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
