require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 对比度计算工具：WCAG 相对亮度 + 对比度比值 */
function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS = [
  // [前景, 背景, 说明, 是否大字号]
  ["#1f1f1f", "#f3f3f3", "正文 text on body bg", false],
  ["#1f1f1f", "#ffffff", "正文 text on 卡片", false],
  ["#5c5c5c", "#f3f3f3", "次级文字 text-soft on bg", false],
  ["#5c5c5c", "#ffffff", "次级文字 text-soft on 卡片", false],
  ["#6e6e6e", "#f3f3f3", "text-muted on body bg (.hint)", false],
  ["#6e6e6e", "#ffffff", "text-muted on 卡片 (.counter/.status)", false],
  ["#6e6e6e", "#fafafa", "text-muted on panel-alt (.history-meta)", false],
  ["#6e6e6e", "#ffffff", "placeholder（占位符）", false],
  ["#6e6e6e", "#fafafa", "output-placeholder", false],
  ["#0f6cbd", "#ffffff", "蓝色链接/主按钮文字", false],
  ["#ffffff", "#0f6cbd", "主按钮白字", false],
  ["#0b5394", "#e8f1fa", "选中模式文字 (blue-dark on blue-light)", false],
  ["#0f7b0f", "#ffffff", "状态成功绿 is-done", false],
  ["#b3261e", "#ffffff", "错误红 is-error", false],
  ["#6b5300", "#fff8e1", "notice 提示文字", false],
  ["#6e6e6e", "#ffffff", "footer 文字", false],
  ["#ffffff", "#2b2b2b", "toast 文字", false],
  ["#ececec", "#1b1b1b", "深色模式正文", false],
  ["#b8b8b8", "#1b1b1b", "深色模式 text-soft", false],
  ["#9a9a9a", "#1b1b1b", "深色模式 text-muted", false],
  ["#9a9a9a", "#2b2b2b", "深色模式 text-muted on panel-alt", false],
  ["#9a9a9a", "#242424", "深色模式 placeholder", false],
  ["#0f6cbd", "#f3f3f3", "蓝色文字 on body bg", false],
  ["#4ca0e0", "#1b1b1b", "深色模式强调蓝", false],

  // --- 审计发现 H1：深色模式下的状态色，原值几乎看不清 ---
  ["#b3261e", "#242424", "深色 错误红（修复前 2.37:1）", false],
  ["#ff99a4", "#242424", "深色 错误红（修复后）", false],
  ["#ff99a4", "#2b2b2b", "深色 错误红 on panel-alt", false],
  ["#0f7b0f", "#242424", "深色 成功绿（修复前 2.85:1）", false],
  ["#6ccb6c", "#242424", "深色 成功绿（修复后）", false],
  ["#6ccb6c", "#2b2b2b", "深色 成功绿 on panel-alt", false],
];

console.log("WCAG AA 正文要求 >= 4.5:1；大字号(>=18.66px粗体 或 >=24px)要求 >= 3:1");
console.log("=".repeat(78));
let fails = [];
const baseline = [];
for (const [fg, bg, label] of PAIRS) {
  const r = ratio(fg, bg);
  const passAA = r >= 4.5;
  const passLarge = r >= 3;
  const mark = passAA ? "AA ✓" : (passLarge ? "仅大字号 ✓" : "不合格 ✗");
  // "（修复前 X:1）" 这类样本是历史基线，只展示、不参与判定
  const isBaseline = /修复前/.test(label);
  if (isBaseline) { baseline.push({ label, r }); }
  else if (!passAA) { fails.push({ label, fg, bg, r }); }
  console.log(`${label.padEnd(42)} ${fg} on ${bg}  ${r.toFixed(2).padStart(6)}:1  ${mark}`);
}
console.log("=".repeat(78));
if (baseline.length) {
  console.log("历史基线（仅对照用，不代表当前配置）：");
  for (const b of baseline) console.log(`  ${b.label}  ${b.r.toFixed(2)}:1`);
  console.log("");
}
console.log(`当前配置不达 AA 的配色：${fails.length} 个`);
for (const f of fails) {
  console.log(`  - ${f.label}  ${f.r.toFixed(2)}:1`);
}
if (!fails.length) console.log("  ✓ 全部满足 WCAG AA");
console.log(`判定配色总数: ${PAIRS.length - baseline.length} / ${PAIRS.length - baseline.length}`);
process.exit(fails.length ? 1 : 0);
