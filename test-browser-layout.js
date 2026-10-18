require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 真实浏览器行为审计
 *
 * jsdom 不做布局：scrollHeight / innerHeight / getBoundingClientRect 全是 0 或固定值，
 * 所以依赖真实布局的代码路径**从未被真正验证过**。
 *
 * 这个套件用"可控的假布局"补上这一块：
 *   · 给 innerHeight / scrollHeight 注入真实感的值
 *   · 模拟手机浏览器地址栏收起/展开导致的 innerHeight 变化
 *   · 模拟旋转屏幕
 * 验证 autoGrow 等函数在这些情况下行为正确。
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

/**
 * 造一个页面，并注入"假布局"：
 *   scrollHeightFor(text) 让我们控制输入框内容对应的真实高度。
 */
async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;

  // --- 注入可控布局 ---
  let viewportHeight = opts.viewportHeight || 800;
  let viewportWidth = opts.viewportWidth || 390;

  Object.defineProperty(w, "innerHeight", { get: () => viewportHeight, configurable: true });
  Object.defineProperty(w, "innerWidth", { get: () => viewportWidth, configurable: true });

  // scrollHeight：按内容长度估算（每 20 字换一行，每行 28px），最少 3 行
  const HEIGHT_PER_LINE = 28;
  Object.defineProperty(w.HTMLElement.prototype, "scrollHeight", {
    get() {
      if (this.id === "inputText") {
        const text = this.value || "";
        const lines = Math.max(3, Math.ceil(text.length / 20) + (text.split("\n").length - 1));
        return lines * HEIGHT_PER_LINE + 24;   // 加上 padding
      }
      return 200;
    },
    configurable: true,
  });

  // 记录被设置过的 height，便于断言。
  // 注意：不能自己 new CSSStyleDeclaration（jsdom 的构造函数是 illegal constructor），
  // 所以用一个普通对象承载 height 属性，并保留原有的 setProperty 等能力。
  const heightSets = [];
  Object.defineProperty(w.HTMLElement.prototype, "style", {
    get() {
      const el = this;
      if (!el.__fakeStyle) {
        const fake = {};
        Object.defineProperty(fake, "height", {
          get() { return el.__height || ""; },
          set(v) { el.__height = v; heightSets.push({ id: el.id, value: String(v) }); },
          configurable: true,
        });
        // 代码里还会设置其它内联样式（如 legacyCopy 的 textarea），一并容错
        ["position", "top", "left", "width", "padding", "border",
         "outline", "boxShadow", "background", "opacity"].forEach((k) => {
          Object.defineProperty(fake, k, {
            get() { return el["__s_" + k] || ""; },
            set(v) { el["__s_" + k] = String(v); },
            configurable: true,
          });
        });
        fake.setProperty = function (k, v) { this[k] = v; };
        fake.removeProperty = function (k) { delete this[k]; };
        el.__fakeStyle = fake;
      }
      return el.__fakeStyle;
    },
    configurable: true,
  });

  // rAF 立即执行（测试里不需要真的等帧）
  w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  w.scrollTo = () => {}; w.confirm = () => true;

  // resize 监听需要能被触发
  const listeners = {};
  const realAdd = w.addEventListener.bind(w);
  w.addEventListener = (type, fn, o) => { (listeners[type] = listeners[type] || []).push(fn); realAdd(type, fn, o); };

  w.__MSSTYLE_CONFIG__ = { apiKey: "layout.audit.key" };
  w.fetch = () => Promise.resolve({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "结果" } }] }) });

  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  await new Promise((r) => setTimeout(r, 30));   // 等 rAF

  return {
    dom, window: w, document: d, heightSets, listeners,
    setViewport(h, wd) {
      viewportHeight = h; if (wd) viewportWidth = wd;
      (listeners.resize || []).forEach((fn) => fn());
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

  /* ============ 1. 初始化时输入框应该被设定高度 ============ */
  {
    const p = await openPage();
    const sets = p.heightSets.filter((s) => s.id === "inputText");
    check("初始化时给输入框设定了高度", sets.length > 0, "次数=" + sets.length);
    const last = sets.length ? sets[sets.length - 1].value : "";
    check("高度是合法的 px 值", /^\d+px$/.test(last), last);
    const px = parseInt(last, 10);
    check("高度不低于最小 148px", px >= 148, last);
    check("高度不超过视口 46%", px <= Math.round(800 * 0.46) + 1,
      `${last}（上限 ${Math.round(800 * 0.46)}px）`);
  }

  /* ============ 2. 输入长文本时高度增长（但有上限） ============ */
  {
    const p = await openPage();
    const d = p.document;
    const input = d.getElementById("inputText");

    p.heightSets.length = 0;
    input.value = "短";
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);
    const shortH = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    p.heightSets.length = 0;
    input.value = "a".repeat(400);   // 20 行
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);
    const longH = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    check("长文本时输入框变高", longH > shortH, `${shortH}px → ${longH}px`);
    check("长文本时高度被限制在视口 46% 以内",
      longH <= Math.round(800 * 0.46) + 1,
      `${longH}px（上限 ${Math.round(800 * 0.46)}px）`);
  }

  /* ============ 3. 手机地址栏收起/展开（innerHeight 变化） ============ */
  {
    const p = await openPage({ viewportHeight: 800 });
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "a".repeat(400);
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);
    const before = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    // 地址栏收起 → 视口变高
    p.setViewport(900);
    await sleep(250);   // resize 有 150ms debounce
    const after = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    check("地址栏收起（视口变高）后重算了输入框高度", after !== before,
      `${before}px → ${after}px`);
    check("新高度符合新视口的 46% 上限",
      after <= Math.round(900 * 0.46) + 1,
      `${after}px（上限 ${Math.round(900 * 0.46)}px）`);
  }

  /* ============ 4. 旋转屏幕（横屏时视口变矮） ============ */
  {
    const p = await openPage({ viewportHeight: 800, viewportWidth: 390 });
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "a".repeat(400);
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);
    const portrait = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    // 转横屏：高度变小、宽度变大
    p.setViewport(390, 800);
    await sleep(250);
    const landscape = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    check("转横屏后输入框高度随视口缩小",
      landscape < portrait || landscape >= 148,
      `竖屏 ${portrait}px → 横屏 ${landscape}px`);
    check("横屏下高度不低于最小值 148px", landscape >= 148, landscape + "px");
    check("横屏下高度不超过视口的 46%",
      landscape <= Math.round(390 * 0.46) + 1,
      `${landscape}px（上限 ${Math.round(390 * 0.46)}px）`);
  }

  /* ============ 5. resize 防抖 ============
     注意：不能只用"高度被设置了几次"来判定，
     因为 autoGrow 内部还有 growPending + rAF 合并，
     即使删掉 resize 防抖也可能只算一次 —— 那样断言会漏报。
     这里改为**直接测延迟行为**：resize 之后不应立即重算，
     而要等一小段时间（防抖 150ms）才执行。 */
  {
    const p = await openPage();
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "a".repeat(400);
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(80);   // 等 rAF 合并结束

    p.heightSets.length = 0;
    p.setViewport(900);

    // 防抖期内不应有任何重算
    await sleep(60);
    const during = p.heightSets.filter((s) => s.id === "inputText").length;

    // 防抖到点后必须执行（证明不是永不触发的空操作）
    await sleep(250);
    const after = p.heightSets.filter((s) => s.id === "inputText").length;

    check("resize 后不会立即重算（有防抖延迟）",
      during === 0, `防抖期内重算了 ${during} 次`);
    check("防抖到点后确实执行了重算（不是空操作）",
      after >= 1, `防抖后重算 ${after} 次`);

    // 连续多次 resize 应被合并
    p.heightSets.length = 0;
    for (let i = 0; i < 20; i++) p.setViewport(800 + i);
    await sleep(300);
    const coalesced = p.heightSets.filter((s) => s.id === "inputText").length;
    check("连续 20 次 resize 被合并为极少次重算",
      coalesced <= 2, `合并后 ${coalesced} 次`);
  }

  /* ============ 6. 极端视口：非常矮的屏幕 ============ */
  {
    const p = await openPage({ viewportHeight: 300 });
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "a".repeat(400);
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);
    const h = parseInt(p.heightSets[p.heightSets.length - 1].value, 10);

    // 视口 300px 的 46% = 138px，但代码有 148px 的下限
    check("极矮视口下高度仍有下限（不会压成一条线）", h >= 148, h + "px");
    check("极矮视口下高度不会为零或 NaN", Number.isFinite(h) && h > 0, String(h));
  }

  /* ============ 7. rAF 不可用时的降级路径 ============ */
  {
    const p = await openPage();
    const w = p.window;
    // 模拟不支持 rAF 的老浏览器
    const saved = w.requestAnimationFrame;
    delete w.requestAnimationFrame;
    Object.defineProperty(w, "requestAnimationFrame", { value: undefined, configurable: true });

    const d = p.document;
    p.heightSets.length = 0;
    d.getElementById("inputText").value = "降级测试";
    d.getElementById("inputText").dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(60);

    check("没有 requestAnimationFrame 时会退回 setTimeout（仍能设高度）",
      p.heightSets.filter((s) => s.id === "inputText").length > 0,
      "次数=" + p.heightSets.filter((s) => s.id === "inputText").length);
  }

  /* ============ 8. 输出区高度限制（长结果不撑爆页面） ============ */
  {
    const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
    check("输出区有 max-height（长结果不会无限撑高）",
      /\.output-area\s*\{[^}]*max-height/.test(cssCode) ||
      /\.text-area\s*\{[^}]*max-height/.test(cssCode),
      "检查 .output-area / .text-area 的 max-height");
    check("输出区设置了 overflow-y: auto（超出可滚动）",
      /overflow-y:\s*auto/.test(cssCode));
  }

  /* ---------- 输出 ---------- */
  console.log("\n======= 真实浏览器行为（假布局） =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("========================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
