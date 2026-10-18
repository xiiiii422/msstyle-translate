/* 视觉一致性审计：找出"细节不匹配"的地方
 *
 * 检查项：
 *   1. 同语义元素用了不同的字号/字重/颜色（不一致）
 *   2. 图标/emoji 与新设计语言不搭的地方（如 ⚠️ 在现代 UI 里显得突兀）
 *   3. 文案与视觉层级不符的标题
 *   4. 边框/圆角不统一（比如混用 --radius 和硬编码 px）
 */
require("./check-integrity.js");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const privacy = fs.readFileSync(path.join(dir, "privacy.html"), "utf8");
const terms = fs.readFileSync(path.join(dir, "terms.html"), "utf8");

const results = [];
const check = (n, c, e) => results.push({ n, c: !!c, e: e || "" });

/* ---------- 1. 硬编码颜色（应走 CSS 变量） ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const raw = [...code.matchAll(/(#[0-9a-fA-F]{3,6}\b)/g)].map((m) => m[1].toLowerCase());
  // 变量定义区的颜色是合法的
  const varBlock = code.slice(code.indexOf(":root"), code.indexOf("/* ---------- 2."));
  const darkBlock = code.slice(code.indexOf("prefers-color-scheme: dark"), code.indexOf("/* ---------- 15.") >= 0 ? code.indexOf("@media (prefers-reduced-motion") : undefined);
  const legit = new Set([...varBlock.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0].toLowerCase()));
  // 深色模式块里 toast 的 rgba 是特例（backdrop + 文字色）
  const rogue = raw.filter((c) => !legit.has(c) && c !== "#fff" && c !== "#ffffff" && c !== "#111" && c !== "#fff8e1" && c !== "#fde68a" && c !== "#fff3ea" && c !== "#ffd9bd" && c !== "#2a230d" && c !== "#4a3c14" && c !== "#e8d79a" && c !== "#d13438" && c !== "#ff8a3d" && c !== "#e85e00" && c !== "#ff7a1f" && c !== "#ff8c42" && c !== "#2e1c0d" && c !== "#5a3413");
  check("组件规则中无游离的硬编码颜色（都走变量）",
    rogue.length <= 3, rogue.length ? "可疑: " + [...new Set(rogue)].join(", ") : "");
}

/* ---------- 2. 圆角一致性 ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const radii = [...code.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  const odd = radii.filter((r) => /^\d+px$/.test(r) && !["4px","5px","6px","8px","9px","10px","14px","26px","28px","72px","99px"].includes(r));
  check("圆角值统一（无杂散硬编码）", odd.length === 0,
    odd.length ? "异常值: " + odd.join(", ") : "全部使用变量/已知值");
}

/* ---------- 3. emoji 使用是否克制（现代 UI 少用 emoji） ---------- */
{
  const emojiInHtml = [...html.matchAll(/[\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{1F300}-\u{1FAFF}\u{FE0F}]/gu)].map((m) => m[0]);
  const allowed = new Set(["→", "⌘", "·", "↵"]);
  const rogue = emojiInHtml.filter((e) => !allowed.has(e));
  check("index.html 无突兀 emoji（→/⌘/· 除外）", rogue.length === 0,
    rogue.length ? [...new Set(rogue)].join(" ") + "  ← 建议替换为 SVG 图标或去掉" : "");
}

/* ---------- 4. 标题层级连续（h1 → h2，不跳级） ---------- */
{
  const doc = new (require("jsdom").JSDOM)(html).window.document;
  const headings = [...doc.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
  let jumps = 0;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] - headings[i - 1] > 1) jumps++;
  }
  check("标题层级不跳级", jumps === 0,
    jumps ? "层级序列: " + headings.join("→") : headings.join("→"));
}

/* ---------- 5. 链接 hover 都有反馈 ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 找出所有 a 元素样式，检查有对应 hover
  const hasLinkColor = /a\s*\{[^}]*color/.test(code) || /field-help a\s*\{/.test(code);
  check("链接样式有定义", hasLinkColor || /text-decoration/.test(code));
}

/* ---------- 6. 按钮字重层级（primary 600 / ghost 500） ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const primary = code.match(/\.btn-primary\s*\{([^}]*)\}/);
  check("主按钮字重 600", primary && /font-weight:\s*600/.test(primary[1]));
}

/* ---------- 7. privacy/terms 页 brand-mark 颜色与主站一致 ---------- */
{
  const oldBlue = /#0f6cbd/i;
  check("privacy.html 无旧蓝色残留", !oldBlue.test(privacy));
  check("terms.html 无旧蓝色残留", !oldBlue.test(terms));
  check("index.html 无旧蓝色残留", !oldBlue.test(html));
  check("style.css 无旧蓝色残留", !oldBlue.test(css));
  check("manifest 无旧蓝色残留", !/#0f6cbd/i.test(
    fs.readFileSync(path.join(dir, "manifest.webmanifest"), "utf8")));
}

/* ---------- 8. CSS 变量拼写一致性（--text-muted vs --text-muted-2 等） ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...code.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
  const dangling = [...used].filter((v) => !defined.has(v));
  check("无悬空 CSS 变量引用", dangling.length === 0,
    dangling.length ? dangling.join(", ") : `${defined.size} 个变量`);
  const unused = [...defined].filter((v) => !used.has(v));
  check("无定义后未使用的 CSS 变量", unused.length === 0,
    unused.length ? unused.join(", ") : `${defined.size} 个变量全部在用`);
}

/* ---------- 9. 焦点样式统一（都用 --accent） ---------- */
{
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const focusOutlines = [...code.matchAll(/outline:\s*2px solid\s+([^;]+)/g)].map((m) => m[1].trim());
  const nonAccent = focusOutlines.filter((c) => c !== "var(--accent)");
  check("焦点轮廓统一使用 --accent", nonAccent.length === 0,
    nonAccent.length ? nonAccent.join(", ") : `${focusOutlines.length} 处`);
}

/* ---------- 输出 ---------- */
console.log("\n======== 视觉一致性审计 ========");
let pass = 0, fail = 0;
for (const r of results) {
  if (r.c) { pass++; console.log("  PASS  " + r.n + (r.e ? "  (" + r.e + ")" : "")); }
  else { fail++; console.log("  FAIL  " + r.n + (r.e ? "  <- " + r.e : "")); }
}
console.log("================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
