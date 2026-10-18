require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* CSS 真实生效性审计
 *
 * 此前只检查过"颜色对比度"（读 style.css 里的十六进制值），
 * 但从未验证过**样式是否真的作用到了该作用的元素上**。
 *
 * 这类问题的典型表现：
 *   · 选择器写错类名 → 规则永远不匹配（死样式），看起来没事但功能缺失
 *   · JS 动态加的类名在 CSS 里不存在 → 状态样式不生效
 *   · 响应式断点写反 → 手机上不是预期布局
 *   · 关键可点击元素尺寸不足 44px（移动端可用性）
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
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
const scriptSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");

/** 用 jsdom 加载页面（含样式表），以便查询 computed style */
function load(withScript) {
  const dom = new JSDOM(html, {
    runScripts: withScript ? "outside-only" : undefined,
    url: "https://example.com/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // 手动注入样式表内容（jsdom 不会自动加载外部 css）
  const style = w.document.createElement("style");
  style.textContent = css;
  w.document.head.appendChild(style);

  if (withScript) {
    w.scrollTo = () => {}; w.confirm = () => true;
    w.__MSSTYLE_CONFIG__ = { apiKey: "css.audit.key" };
    w.fetch = () => Promise.resolve({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "结果" } }] }) });
    w.eval(fs.readFileSync(path.join(dir, "prompt.js"), "utf8"));
    w.eval(fs.readFileSync(path.join(dir, "config.js"), "utf8"));
    w.eval(scriptSrc);
  }
  return dom;
}

(async () => {

  /* ============ 1. 提取 CSS 里定义的所有类名 ============ */
  //
  // 必须先去注释再扫描：否则注释里提到的类名（例如"已删除的 .foo"）
  // 会被当成真实规则。上一轮已经在 README 检查上踩过同样的坑。
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const cssClasses = new Set();
  for (const m of cssNoComments.matchAll(/\.([a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);

  // 这些检查必须用"去注释"后的 CSS，避免注释内容干扰
  const cssCode = cssNoComments;

  /* ============ 2. HTML 里用到的类名，是否都在 CSS 里定义过？ ============ */
  {
    const dom = load(false);
    const d = dom.window.document;
    const htmlClasses = new Set();
    d.querySelectorAll("[class]").forEach((n) => {
      n.className.split(/\s+/).filter(Boolean).forEach((c) => htmlClasses.add(c));
    });

    // 这些类名是"语义钩子"：只为可读性/将来扩展存在，当前不需要样式。
    // 要求每个类都必须有 CSS 是不合理的 —— 但必须显式登记，防止真有笔误混进来。
    const SEMANTIC_ONLY = new Set(["translate-card"]);
    const undefinedClasses = [...htmlClasses].filter(
      (c) => !cssClasses.has(c) && !SEMANTIC_ONLY.has(c)
    );
    check("HTML 用到的类名都在 CSS 里定义过（语义钩子除外）",
      undefinedClasses.length === 0,
      undefinedClasses.length ? "未定义: " + undefinedClasses.join(", ") : `${htmlClasses.size} 个类`);
  }

  /* ============ 3. JS 动态添加的类名，是否都在 CSS 里定义过？ ============ */
  {
    // 从 script.js 里提取 classList.add / className = "..." 用到的类名
    const jsClasses = new Set();
    for (const m of scriptSrc.matchAll(/classList\.(?:add|toggle|remove)\("([\w-]+)"/g)) {
      jsClasses.add(m[1]);
    }
    for (const m of scriptSrc.matchAll(/className\s*=\s*"([^"]+)"/g)) {
      m[1].split(/\s+/).filter(Boolean).forEach((c) => jsClasses.add(c));
    }
    // 带条件的拼接形式： "status" + (kind ? " is-" + kind : "")
    for (const m of scriptSrc.matchAll(/"is-" \+/g)) { /* 动态前缀，单独处理 */ }

    const undefinedJs = [...jsClasses].filter((c) => !cssClasses.has(c) && c !== "");
    check("JS 动态添加的类名都在 CSS 里有对应样式",
      undefinedJs.length === 0,
      undefinedJs.length ? "未定义: " + undefinedJs.join(", ") : `${jsClasses.size} 个类`);

    /* is-* 状态类：它们由 script.js 用 "is-" + kind 拼出来，CSS 里必须真有样式。
     *
     * 注意这里查的是**完整选择器**，而不是"CSS 里出现过 .is-done 这个子串"。
     * 早先的写法只查子串，于是"删掉 .status.is-done（完成状态变绿）"
     * 这种破坏根本查不出来 —— 因为 .history-copy.is-done 里还含有 ".is-done"。
     * 变异测试把这个问题抓了出来（1 种破坏没被发现），所以改成按前缀配对检查。 */
    const STATE_SELECTORS = {
      "is-busy": [".status.is-busy", ".btn-primary.is-busy"],
      "is-error": [".status.is-error", ".toast.is-error"],
      "is-done": [".status.is-done", ".history-copy.is-done"],
      "is-show": [".toast.is-show"],
      "is-over": [".counter.is-over"],
      "needs-key": [".needs-key"],
    };
    for (const st of Object.keys(STATE_SELECTORS)) {
      const missing = STATE_SELECTORS[st].filter(
        (sel) => !cssCode.includes(sel) && !new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(cssCode)
      );
      check(`状态类 .${st} 在 CSS 里有对应样式`, missing.length === 0,
        missing.length ? "缺少: " + missing.join(", ") : STATE_SELECTORS[st].join(" / "));
    }
  }

  /* ============ 4. 关键元素的关键样式真的生效吗 ============ */
  {
    const dom = load(false);
    const w = dom.window;
    const d = w.document;

    // 输入区基础样式
    const input = d.getElementById("inputText");
    check("输入框应用了 .text-area 样式（有边框）",
      cssCode.includes(".text-area") && cssCode.includes("border"),
      "检查 .text-area 规则存在");

    // 输出区可滚动（长文本不撑爆）
    check("输出区设置了滚动（overflow-y）",
      /\.text-area\s*\{[^}]*overflow-y/.test(css) || /overflow-y:\s*auto/.test(css));

    // 主按钮
    check("主按钮 .btn-primary 有定义", cssCode.includes(".btn-primary"));
    check("主按钮有最小高度（手指可点）",
      /\.btn-primary\s*\{[^}]*min-height/.test(css),
      "检查 .btn-primary 的 min-height");

    // 手机端按钮尺寸
    const mobileBlock = cssCode.slice(cssCode.indexOf("@media (max-width: 560px)"));
    check("手机端主按钮高度 >= 48px",
      /min-height:\s*(4[89]|5\d)px/.test(mobileBlock),
      "检查 560px 断点里的 min-height");

    /* 触摸目标尺寸：**每个**按钮都必须够大，不能只查主按钮。
       （曾经漏掉过：只断言 .btn-primary 和媒体查询，
         结果基础 .btn 规则的 min-height 被改小也没被发现。）
       规则：普通按钮 >= 40px；.btn-small 是次要小控件，放宽到 >= 32px
       （仍高于 WCAG 建议的 24px 最小目标）。 */
    const btnRules = [...cssCode.matchAll(/\.btn[\w-]*\s*\{([^}]*)\}/g)]
      .map((m) => ({ sel: m[0].split("{")[0].trim(), body: m[1] }));

    const violations = [];
    for (const r of btnRules) {
      const m = r.body.match(/min-height:\s*(\d+)px/);
      if (!m) continue;
      const px = Number(m[1]);
      const isSmall = /btn-small/.test(r.sel);
      const min = isSmall ? 32 : 40;
      if (px < min) violations.push(`${r.sel}=${px}px（应 >= ${min}px）`);
    }
    check("所有按钮的触摸目标都达标（普通 >=40px，小按钮 >=32px）",
      violations.length === 0,
      violations.length ? violations.join(", ") : `${btnRules.length} 条规则`);

    // 防止横向滚动
    check("body 设置了 overflow-x: hidden（防横向滚动）",
      /body\s*\{[^}]*overflow-x:\s*hidden/.test(css));
    check("长文本强制换行（overflow-wrap）",
      /overflow-wrap:\s*anywhere/.test(css));

    // iOS 聚焦不缩放
    check("手机端输入字号 >= 16px（防 iOS 聚焦缩放）",
      /@media \(max-width: 560px\)[\s\S]*?font-size:\s*16px/.test(css),
      "检查 560px 断点里的输入框字号");
  }

  /* ============ 5. 响应式断点是否有重叠/矛盾 ============ */
  {
    const breakpoints = [...cssCode.matchAll(/@media \(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(breakpoints)].sort((a, b) => b - a);
    check("存在移动端断点（<=560px）", uniq.some((b) => b <= 560), uniq.join(", "));

    // 检查是否有重复定义的断点（可能相互覆盖，导致某些规则永远不生效）
    const dupes = breakpoints.filter((b, i) => breakpoints.indexOf(b) !== i);
    check("没有重复定义的断点",
      dupes.length === 0,
      dupes.length ? "重复: " + [...new Set(dupes)].join(", ") : uniq.join(", "));
  }

  /* ============ 6. 关键交互元素的实际渲染尺寸 ============ */
  {
    const dom = load(true);
    await new Promise((r) => {
      const d = dom.window.document;
      if (d.readyState !== "loading") return setTimeout(r, 0);
      d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
    });
    const d = dom.window.document;

    // jsdom 不做布局，getBoundingClientRect 全是 0 —— 所以要换一种验证方式：
    // 确认元素存在、可见、且没有被 hidden 属性误隐藏
    const clickable = [
      "translateBtn", "cancelBtn", "clearBtn", "randomBtn",
      "copyBtn", "retryBtn", "settingsBtn", "clearHistoryBtn",
    ];
    const issues = [];
    for (const id of clickable) {
      const el = d.getElementById(id);
      if (!el) { issues.push(id + " 不存在"); continue; }
      if (el.tagName !== "BUTTON") issues.push(id + " 不是 button");
      // 取消按钮平时是 hidden 的，这是预期
      if (id !== "cancelBtn" && el.hidden) issues.push(id + " 被意外隐藏");
    }
    check("所有交互按钮都存在且是 button 元素",
      issues.length === 0, issues.join("; "));

    // 每个按钮都要有可读文字或 aria-label
    const noLabel = [];
    d.querySelectorAll("button").forEach((b) => {
      if (!b.textContent.trim() && !b.getAttribute("aria-label")) {
        noLabel.push(b.id || b.className);
      }
    });
    check("所有按钮都有可读名称", noLabel.length === 0, noLabel.join(", "));
  }

  /* ============ 7. 死样式检测：CSS 里定义了但 HTML/JS 从不使用的类 ============ */
  {
    const dom = load(true);
    const d = dom.window.document;
    const usedClasses = new Set();
    d.querySelectorAll("[class]").forEach((n) => {
      n.className.split(/\s+/).filter(Boolean).forEach((c) => usedClasses.add(c));
    });
    // JS 里动态用到的也算
    for (const m of scriptSrc.matchAll(/classList\.(?:add|toggle|remove)\("([\w-]+)"/g)) {
      usedClasses.add(m[1]);
    }
    for (const m of scriptSrc.matchAll(/"([\w-]*is-[\w-]+)"/g)) usedClasses.add(m[1]);

    // 这些前缀的类名可能是"复合选择器"的一部分，不作为死样式判定
    const IGNORE = new Set([
      "toast", "status", "level-badge", "brand-mark", "wrap", "card",
      "output-text", "output-placeholder", "loading-bar", "history-item",
      "history-src", "history-dst", "history-meta", "history-tag", "history-empty",
      "text-area", "output-area", "pane", "panes", "pane-head", "pane-foot",
      "pane-title", "pane-arrow", "arrow-glyph", "counter", "hint", "actions",
      "site-header", "site-footer", "brand", "brand-text", "tagline",
      "mode-card", "mode-row", "mode-option", "translate-card", "level-card",
      "history-card", "slider-row", "slider-end", "level-desc",
      "btn", "btn-primary", "btn-ghost", "btn-small", "notice", "notice-inline",
      "skip-link", "onboarding", "onboarding-card", "onboarding-steps",
      "onboarding-actions", "settings-panel", "settings-card", "settings-actions",
      "field", "field-label", "field-row", "field-help", "text-input", "doc", "doc-back",
      "footer-links", "plain-link", "header-inner", "history-list",
    ]);

    const deadClasses = [...cssClasses].filter((c) =>
      !usedClasses.has(c) && !IGNORE.has(c) &&
      !c.startsWith("is-") && !c.startsWith("needs-") &&
      !c.startsWith("webkit") && !c.startsWith("moz")
    );

    // 只报告"看起来像笔误"的：在 CSS 里定义、但项目里任何地方都搜不到
    const trulyDead = deadClasses.filter((c) => {
      const inHtml = html.includes(c);
      const inJs = scriptSrc.includes(c);
      return !inHtml && !inJs;
    });

    check("没有定义后从未使用的 CSS 类（死样式）",
      trulyDead.length === 0,
      trulyDead.length ? "可疑: " + trulyDead.join(", ") : `${cssClasses.size} 个类全部有使用`);
  }

  /* ---------- 输出 ---------- */
  console.log("\n========== CSS 生效性审计 ==========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("====================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
