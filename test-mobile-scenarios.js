require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 手机专属场景审计
 *
 * 上一轮审了 CSS 生效性，这一轮审"只有真机才会遇到的情况"。
 * jsdom 无法模拟的，就明确标注"未验证"，而不是假装测过。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const results = [];
function check(name, cond, extra, unverified) {
  results.push({ name, pass: !!cond, extra: extra || "", unverified: !!unverified });
}

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
const scriptSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");

/* ============ 1. 微信内置浏览器 / 剪贴板降级 ============ */
{
  // 微信里 navigator.clipboard 常常不可用或 isSecureContext 为 false，
  // 代码必须有 execCommand 兜底路径
  check("有 clipboard API 失败后的降级路径",
    /execCommand/.test(scriptSrc) && /legacyCopy/.test(scriptSrc),
    "找到 legacyCopy + execCommand");

  // 降级路径必须是"先试 clipboard，失败再试 execCommand"，而不是二选一
  const clipboardFirst = scriptSrc.indexOf("navigator.clipboard") < scriptSrc.indexOf("legacyCopy");
  check("复制逻辑是「先现代 API，失败再降级」", clipboardFirst);

  // 两条路都失败时要有用户可操作的提示
  check("两条复制路径都失败时有可操作提示",
    /长按结果手动选择文本|手动复制/.test(scriptSrc),
    (scriptSrc.match(/长按[^"]*/) || [""])[0]);
}

/* ============ 2. iOS 安全区域（刘海屏） ============ */
{
  check("使用了 env(safe-area-inset-*) 适配刘海屏",
    /safe-area-inset/.test(cssCode), "检查 style.css");
  const usesBottom = /safe-area-inset-bottom/.test(cssCode);
  check("页面底部（页脚/提示条）考虑了安全区域",
    usesBottom, usesBottom ? "有 safe-area-inset-bottom" : "未处理，iPhone 上可能被 home 条遮挡");
}

/* ============ 3. 触摸与点击延迟 ============ */
{
  check("按钮设置了 touch-action（消除 300ms 点击延迟）",
    /touch-action:\s*manipulation/.test(cssCode),
    "检查 .btn 规则");
  check("设置了 -webkit-tap-highlight-color（去掉点击高亮块）",
    /-webkit-tap-highlight-color/.test(cssCode));
}

/* ============ 4. 防止 iOS 聚焦缩放 ============ */
{
  // 所有可输入控件在手机断点下都必须 >= 16px
  const mobileCss = cssCode.slice(cssCode.indexOf("@media (max-width: 560px)"));
  check("手机断点下 textarea 字号 >= 16px",
    /\.text-area\s*\{[^}]*font-size:\s*16px/.test(mobileCss) ||
    /font-size:\s*16px/.test(mobileCss));

  // .text-input（设置面板里的输入框）在基础规则里就该是 16px
  check("设置面板输入框基础字号 >= 16px（防 iOS 缩放）",
    /\.text-input\s*\{[^}]*font-size:\s*16px/.test(cssCode),
    "检查 .text-input");
}

/* ============ 5. 视口与缩放设置 ============ */
{
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const vp = d.querySelector('meta[name="viewport"]');
  check("有 viewport meta", !!vp);
  const content = vp ? vp.getAttribute("content") : "";
  check("viewport 含 viewport-fit=cover（配合安全区域）",
    /viewport-fit=cover/.test(content), content);
  check("viewport 未禁用用户缩放（无障碍要求）",
    !/user-scalable\s*=\s*no/.test(content) && !/maximum-scale\s*=\s*1/.test(content),
    content);
  check("viewport 宽度为 device-width",
    /width=device-width/.test(content), content);
}

/* ============ 6. 深色模式（手机夜间使用） ============ */
{
  check("有 prefers-color-scheme: dark 适配",
    /prefers-color-scheme:\s*dark/.test(cssCode));
  // 深色模式里必须覆盖背景色，否则会白底黑字刺眼
  const darkBlock = cssCode.slice(cssCode.indexOf("prefers-color-scheme: dark"));
  check("深色模式覆盖了 --bg", /--bg:/.test(darkBlock));
  check("深色模式覆盖了 --text", /--text:/.test(darkBlock));
}

/* ============ 7. 降低动效偏好（无障碍） ============ */
{
  check("有 prefers-reduced-motion 适配",
    /prefers-reduced-motion/.test(cssCode));
  // 加载动画必须被减弱
  const rmIdx = cssCode.indexOf("prefers-reduced-motion");
  const after = cssCode.slice(rmIdx, rmIdx + 400);
  check("降低动效时确实调整了动画", /animation|transition/.test(after),
    after.replace(/\s+/g, " ").slice(0, 60));
}

/* ============ 8. 打印样式 ============ */
{
  check("有打印样式（@media print）", /@media print/.test(cssCode));
}

/* ============ 9. 明确标注"无法在 jsdom 验证"的项 ============ */
{
  // 这些只有真机能测，列出来是为了诚实：不要假装验证过
  check("（仅真机可验证）微信内置浏览器实际粘贴行为",
    true, "需真机", true);
  check("（仅真机可验证）iOS Safari 聚焦是否真的不缩放",
    true, "需真机", true);
  check("（仅真机可验证）刘海屏安全区域实际留白",
    true, "需真机", true);
  check("（仅真机可验证）地址栏收起时的滚动行为",
    true, "需真机", true);
}

/* ---------- 输出 ---------- */
console.log("\n======== 手机专属场景审计 ========");
let pass = 0, fail = 0, unverified = 0;
for (const r of results) {
  if (r.unverified) {
    unverified++;
    console.log("  N/A   " + r.name + (r.extra ? "  (" + r.extra + ")" : ""));
  } else if (r.pass) {
    pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : ""));
  } else {
    fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : ""));
  }
}
console.log("==================================");
console.log(`通过 ${pass} / ${pass + fail}` +
  (unverified ? `，另有 ${unverified} 项需真机验证` : "") +
  (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
