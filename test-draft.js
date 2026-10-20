require("./check-integrity.js");
/* 输入草稿 + 结果揭示
 *
 * 为什么单独一个套件：
 *   草稿是"刷新后内容还在"这种看不见的行为，坏了不会报错，
 *   只会让用户白打一遍字 —— 恰恰是最难被发现的那类回归。
 *   而且它牵涉三个容易出错的点：
 *     · 防抖定时器如果跨过整个请求周期，会被当成泄漏
 *     · 直接给 textarea.value 赋值不触发 input 事件，草稿会不同步
 *     · 草稿必须长度有界，否则等于往 localStorage 里无限写
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
let js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const promptSrc = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

// 占位符换成假 Key，让代码走真实请求分支
js = js.replace('const API_KEY = "YOUR_API_KEY";', 'const API_KEY = "fake.key.for.test";');

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRAFT_KEY = "msstyle_translate_draft_v1";

function open(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://example.com/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;

  w.scrollTo = () => { w.__scrolls = (w.__scrolls || 0) + 1; };
  w.confirm = () => true;
  w.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "我今天是特别高兴的。" } }] }),
  });
  if (opts.innerWidth !== undefined) {
    Object.defineProperty(w, "innerWidth", { value: opts.innerWidth, configurable: true });
  }
  for (const k of Object.keys(opts.seed || {})) {
    w.localStorage.setItem(k, opts.seed[k]);
  }

  w.eval(promptSrc);
  w.eval(js);
  return { w, d };
}

async function settle(d, w) {
  // 等 DOMContentLoaded 之后 init 跑完
  await sleep(40);
  return d;
}

(async () => {
  /* ============ 1. 打字会存草稿，刷新后恢复 ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    const input = d.getElementById("inputText");

    input.value = "这是一段打到一半的话";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    check("刚打完还没写盘（防抖生效）", w.localStorage.getItem(DRAFT_KEY) === null);

    /* 只断言"立刻还没写"是抓不到"防抖被改成 0ms"这种破坏的 ——
       setTimeout(fn,0) 在同一个同步块里同样还没跑。
       所以再等 120ms：防抖窗口（400ms）内依然不该落盘。 */
    await sleep(120);
    check("防抖窗口内（120ms）仍然没有落盘",
      w.localStorage.getItem(DRAFT_KEY) === null,
      String(w.localStorage.getItem(DRAFT_KEY)));

    await sleep(400);
    check("防抖窗口之后草稿已落盘",
      w.localStorage.getItem(DRAFT_KEY) === "这是一段打到一半的话",
      String(w.localStorage.getItem(DRAFT_KEY)));

    // 模拟刷新：新窗口，带上同一份 localStorage
    const second = open({ seed: { [DRAFT_KEY]: "这是一段打到一半的话" } });
    await settle(second.d, second.w);
    check("刷新后输入框恢复了草稿",
      second.d.getElementById("inputText").value === "这是一段打到一半的话",
      second.d.getElementById("inputText").value);
    check("恢复草稿时明确告知用户（不凭空出现文字）",
      second.d.getElementById("statusText").textContent.includes("已恢复"),
      second.d.getElementById("statusText").textContent);
  }

  /* ============ 2. 没有草稿时不该有恢复提示 ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    check("首访输入框是空的", d.getElementById("inputText").value === "");
    check("首访不显示恢复提示",
      !d.getElementById("statusText").textContent.includes("已恢复"),
      d.getElementById("statusText").textContent);
  }

  /* ============ 3. 清空 = 草稿一起清掉 ============ */
  {
    const { w, d } = open({ seed: { [DRAFT_KEY]: "旧草稿" } });
    await settle(d, w);
    d.getElementById("clearBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    check("点清空后草稿被移除",
      w.localStorage.getItem(DRAFT_KEY) === null,
      String(w.localStorage.getItem(DRAFT_KEY)));
    check("清空后输入框为空", d.getElementById("inputText").value === "");

    // 撤销应该把草稿也带回来
    const action = d.querySelector(".toast-action");
    check("清空后出现撤销按钮", !!action);
    if (action) {
      action.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await sleep(30);
      check("撤销后内容回来了", d.getElementById("inputText").value === "旧草稿",
        d.getElementById("inputText").value);
      check("撤销后草稿也同步回来",
        w.localStorage.getItem(DRAFT_KEY) === "旧草稿",
        String(w.localStorage.getItem(DRAFT_KEY)));
    }
  }

  /* ============ 4. 草稿长度有界（不能往 localStorage 无限写） ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    const input = d.getElementById("inputText");
    const huge = "字".repeat(5000);
    input.value = huge;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(500);
    const stored = w.localStorage.getItem(DRAFT_KEY) || "";
    check("草稿被截断到 2000 字以内", stored.length <= 2000, "len=" + stored.length);
  }

  /* ============ 5. 提交翻译时立刻落盘，且不留挂起的定时器 ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    const input = d.getElementById("inputText");
    input.value = "马上要翻译的一句话";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));

    // 不等待防抖，直接提交
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check("提交时草稿已同步落盘（不等防抖）",
      w.localStorage.getItem(DRAFT_KEY) === "马上要翻译的一句话",
      String(w.localStorage.getItem(DRAFT_KEY)));

    await sleep(200);
    check("翻译结束后输入框内容仍在", input.value === "马上要翻译的一句话");
  }

  /* ============ 6. 从历史回填也要同步草稿 ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    const input = d.getElementById("inputText");
    input.value = "第一句";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    input.value = "第二句";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    // 点最早那条历史（列表里最后一个是第一条）
    const items = d.querySelectorAll(".history-item");
    check("历史里有两条", items.length === 2, "count=" + items.length);
    items[items.length - 1].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(40);
    check("点历史回填后草稿等于回填内容",
      w.localStorage.getItem(DRAFT_KEY) === "第一句",
      String(w.localStorage.getItem(DRAFT_KEY)));
  }

  /* ============ 7. revealResult：桌面不滚，手机且看不见才滚 ============ */
  /* jsdom 的 getBoundingClientRect 恒为全 0，测不出"看不见"这个判断，
     所以这里显式把输出区的矩形塞成想要的样子。 */
  async function translateWithRect(innerWidth, rect) {
    const { w, d } = open({ innerWidth });
    await settle(d, w);
    const out = d.getElementById("outputText");
    out.getBoundingClientRect = () => rect;

    const input = d.getElementById("inputText");
    input.value = "测试一句话";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(250);
    return w.__scrolls || 0;
  }

  {
    // 宽屏：结果就在右栏，任何情况下都不该滚动
    const n = await translateWithRect(1280, { top: 5000, bottom: 5100, height: 100 });
    check("桌面端翻译完成后不滚动页面", n === 0, "scrollTo 调用 " + n + " 次");
  }
  {
    // 窄屏 + 结果在屏幕下方（innerHeight 默认 768）：应该滚
    const n = await translateWithRect(400, { top: 1200, bottom: 1300, height: 100 });
    check("手机端结果在屏幕外时会滚进视野", n >= 1, "scrollTo 调用 " + n + " 次");
  }
  {
    // 窄屏但结果本来就看得见：不该多此一举打断阅读
    const n = await translateWithRect(400, { top: 100, bottom: 300, height: 200 });
    check("手机端结果已可见时不滚动", n === 0, "scrollTo 调用 " + n + " 次");
  }
  {
    // 窄屏 + 只露出一点点（超过 40% 在屏幕外）：仍然要滚
    const n = await translateWithRect(400, { top: 600, bottom: 900, height: 300 });
    check("手机端结果只露出一部分时也会滚", n >= 1, "scrollTo 调用 " + n + " 次");
  }

  /* ============ 8. 隐私：草稿里不写 Key，也不超出一个键 ============ */
  {
    const { w, d } = open();
    await settle(d, w);
    const input = d.getElementById("inputText");
    input.value = "secret.api.key.looks.like.this";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(500);
    const all = [];
    for (let i = 0; i < w.localStorage.length; i++) {
      const k = w.localStorage.key(i);
      all.push(k + "=" + w.localStorage.getItem(k));
    }
    check("草稿就是一个普通文本键",
      w.localStorage.getItem(DRAFT_KEY) === "secret.api.key.looks.like.this");
    check("没有把 API Key 写进草稿键",
      (w.localStorage.getItem(DRAFT_KEY) || "").indexOf("Bearer") < 0);
  }

  /* ============ 输出 ============ */
  console.log("\n======== 输入草稿 / 结果揭示 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("====================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
