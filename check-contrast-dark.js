/* 深色模式对比度实测：用 WCAG 公式验证所有深色模式组合
   （此前只测过浅色模式的 28 项 + 深色模式的少量抽查） */
const fs = require("fs");

function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* 从 style.css 的深色模式块提取变量（健壮版：变量定义在 :root 内，逐行解析） */
const css = fs.readFileSync("style.css", "utf8");
const dmStart = css.indexOf("prefers-color-scheme: dark");
const dmBody = css.slice(dmStart, dmStart + 2500);   // 深色块长度有限，取足够范围
const vars = {};
for (const m of dmBody.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  if (!(m[1] in vars)) vars[m[1]] = m[2];
}

console.log("=== 深色模式变量 ===");
for (const [k, v] of Object.entries(vars)) console.log(`  --${k}: ${v}`);

/* 测试组合：深色模式下每个语义色在每种背景上的表现 */
const bgs = { "面板": vars["panel"], "面板备选": vars["panel-alt"], "页面背景": vars["bg"] };
const PAIRS = [
  ["正文", vars["text"]],
  ["次级文字", vars["text-soft"]],
  ["弱化文字", vars["text-muted"]],
  ["占位符", vars["placeholder"]],
  ["成功", vars["success"]],
  ["危险", vars["danger"]],
  ["警告", vars["warn-text"]],
  ["强调橙", vars["accent"]],
];

console.log("\n=== 对比度矩阵（AA 正文 >= 4.5，大字 >= 3.0）===\n");
let fails = [];
console.log("前景色".padEnd(12) + Object.keys(bgs).map((k) => k.slice(0, 4)).map((s) => s.padEnd(8)).join(""));
console.log("-".repeat(44));

for (const [fgName, fg] of PAIRS) {
  const row = [fgName.padEnd(10)];
  for (const bgName of Object.keys(bgs)) {
    const bg = bgs[bgName];
    const r = ratio(fg, bg);
    const mark = r >= 4.5 ? "✓" : r >= 3 ? "△" : "✗";
    row.push(`${r.toFixed(2)}${mark}`.padEnd(8));
    if (r < 4.5) fails.push({ fgName, bgName, fg, bg, r });
  }
  console.log(row.join(""));
}

console.log("\n=== 不达标组合 ===");
if (fails.length === 0) {
  console.log("  ✅ 所有前景色在所有深色背景上均满足 AA 4.5:1");
} else {
  fails.forEach((f) =>
    console.log(`  ✗ ${f.fgName} on ${f.bgName}: ${f.fg} → ${f.r.toFixed(2)}:1（需 ≥ 4.5）`));
}

/* 补充：toast 深色下的反转（浅底深字） */
const toastFg = "#111111", toastBg = "rgba(240,240,240,.95)";
console.log("\n=== toast（浅底反转）===");
const tr = ratio(toastFg, "#f0f0f0");
console.log(`  深字浅底: ${tr.toFixed(2)}:1 ${tr >= 4.5 ? "✓" : "✗"}`);

process.exit(fails.length ? 1 : 0);
