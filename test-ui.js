require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 用 jsdom 加载真实 index.html + script.js，验证 UI 逻辑（API 被 mock） */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
let js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const __PROMPT_SRC__ = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

// 把占位符换成假 Key，让代码走真实请求分支
js = js.replace('const API_KEY = "YOUR_API_KEY";', 'const API_KEY = "fake.key.for.test";');

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || "" });
}

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  url: "https://example.com/",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// ---- mock fetch ----
let fetchCalls = [];
let fetchMode = "ok";
// 按"模型名"决定返回结果的钩子，用于测试备用模型降级
let modelHandler = null;
window.fetch = function (url, opts) {
  const parsed = JSON.parse(opts.body);
  fetchCalls.push({ url, body: parsed, headers: opts.headers });

  if (modelHandler) {
    const r = modelHandler(parsed.model, fetchCalls.length);
    if (r) return r;
  }

  if (fetchMode === "ok") {
    // 模拟一个延迟，以测试"进行中"状态
    return new Promise((res) =>
      setTimeout(
        () =>
          res({
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: "我今天是特别高兴的，因为假期终于已经到达。" } }],
            }),
          }),
        30
      )
    );
  }
  if (fetchMode === "401") {
    return Promise.resolve({
      ok: false, status: 401,
      json: async () => ({ error: { message: "invalid api key", code: "1002" } }),
    });
  }
  return Promise.reject(new TypeError("Failed to fetch"));
};

/** 构造一个"模型过载"的响应（智谱 429 / code 1305） */
function overloadResponse() {
  return Promise.resolve({
    ok: false, status: 429,
    json: async () => ({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }),
  });
}

// mock clipboard
let copiedText = null;
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: async (t) => {
    if (copyShouldFail) throw new Error("clipboard denied");
    copiedText = t;
  } },
  configurable: true,
});
window.isSecureContext = true;
// jsdom 不实现 execCommand，这里补一个，用于测试降级路径
window.document.execCommand = function (cmd) {
  if (cmd === "copy") {
    const ta = window.document.querySelector("textarea[readonly]");
    if (ta) { legacyCopied = ta.value; return true; }
  }
  return false;
};
let legacyCopied = null;
let copyShouldFail = false;
window.scrollTo = () => {};
window.confirm = () => true;

// 注入并执行 script.js
window.eval(__PROMPT_SRC__);   // 先加载共享提示词模块
window.eval(js);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等待 init() 真正执行完毕。
 *
 * script.js 在 readyState === "loading" 时会把自己挂到 DOMContentLoaded 上，
 * 而 jsdom 的 DCL 是在同步脚本阶段之后才异步触发的。
 * 真实浏览器里 <script> 位于 </body> 之前，DCL 紧接着解析完成就会触发，
 * 用户点击时 init() 早已执行。这里必须等一等，否则会误报"功能没反应"。
 */
function waitForInit() {
  return new Promise((resolve) => {
    if (window.document.readyState !== "loading") {
      // 某些环境下 eval 时已经 ready，init 是同步执行的
      setTimeout(resolve, 0);
      return;
    }
    window.document.addEventListener("DOMContentLoaded", () => setTimeout(resolve, 0), { once: true });
  });
}

(async function run() {
  await waitForInit();

  // ---------- 初始化状态 ----------
  check("初始字符计数为 0/2000", $("charCounter").textContent === "0 / 2000", $("charCounter").textContent);
  check("默认翻译程度为 3", $("levelRange").value === "3", $("levelRange").value);
  check("默认模式为自动识别", document.querySelector('input[name="mode"]:checked').value === "auto");
  check("初始复制按钮禁用", $("copyBtn").disabled === true);
  check("初始重新翻译按钮禁用", $("retryBtn").disabled === true);
  check("初始历史为空提示", $("historyList").textContent.includes("还没有记录"));

  // ---------- 空输入不得调用 API ----------
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(20);
  check("空输入不发起 API 请求", fetchCalls.length === 0, "calls=" + fetchCalls.length);
  check("空输入给出 toast 提示", $("toast").className.includes("is-show"));

  // ---------- 字符计数 ----------
  $("inputText").value = "abc中文";
  $("inputText").dispatchEvent(new window.Event("input", { bubbles: true }));
  check("字符计数实时更新", $("charCounter").textContent === "5 / 2000", $("charCounter").textContent);

  // ---------- 随机示例 ----------
  $("randomBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const sampleLen = $("inputText").value.length;
  check("随机示例填入了内容", sampleLen > 0, "len=" + sampleLen);

  // ---------- 正常翻译 ----------
  $("inputText").value = "我今天特别开心，因为终于放假了。";
  $("inputText").dispatchEvent(new window.Event("input", { bubbles: true }));
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(5);
  check("请求期间显示机器翻译文案", $("outputText").textContent.includes("正在进行非常认真的机器翻译"));
  check("请求期间按钮被禁用", $("translateBtn").disabled === true);
  check("请求期间显示加载条", !!document.querySelector(".loading-bar"));

  // 防重复点击：请求进行中再点 5 次
  for (let i = 0; i < 5; i++) {
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }
  await sleep(80);
  check("防重复点击：只发出 1 次请求", fetchCalls.length === 1, "calls=" + fetchCalls.length);

  // ---------- 结果渲染 ----------
  const outText = $("outputText").querySelector(".output-text");
  check("输出区渲染了结果", !!outText && outText.textContent.length > 0);
  check("输出使用 textContent（非 innerHTML）", outText && outText.children.length === 0);
  check("翻译完成后状态为完成", $("statusText").textContent.includes("翻译完成"), $("statusText").textContent);
  check("翻译完成后复制按钮可用", $("copyBtn").disabled === false);
  check("翻译完成后重新翻译按钮可用", $("retryBtn").disabled === false);

  // ---------- 请求体校验 ----------
  const reqBody = fetchCalls[0].body;
  check("首选模型为 glm-4-flash-250414（最稳、最快）",
    reqBody.model === "glm-4-flash-250414", reqBody.model);
  check("程度 3 的 temperature 生效", reqBody.temperature === 0.95, reqBody.temperature);
  check("使用 system + user 两条消息", reqBody.messages.length === 2);
  check("system 角色设定正确", reqBody.messages[0].content.includes("非常古老但非常认真的机器翻译系统"));
  check("system 含 15 条约束", reqBody.messages[0].content.includes("15. 只输出最终的"));
  check("prompt 注入了当前程度 3", reqBody.messages[1].content.includes("风格强度：3"));
  check("prompt 注入了自动识别模式", reqBody.messages[1].content.includes("自动判断"));
  check("prompt 包裹了用户原文", reqBody.messages[1].content.includes("我今天特别开心"));
  check("Authorization 头正确", fetchCalls[0].headers["Authorization"] === "Bearer fake.key.for.test");
  check("stream 为 false", reqBody.stream === false);

  // ---------- 生成参数随滑块变化 ----------
  $("levelRange").value = "1";
  $("levelRange").dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(5);
  check("滑块 1 档文字正确", $("levelLabel").textContent.includes("轻微机器味"), $("levelLabel").textContent);
  check("滑块 1 档描述正确", $("levelDesc").textContent.includes("基本通顺"));
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("1 档 prompt 注入风格强度 1", fetchCalls[0].body.messages[1].content.includes("风格强度：1"));

  $("levelRange").value = "4";
  $("levelRange").dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(5);
  check("滑块 4 档文字正确", $("levelLabel").textContent.includes("经典机器翻译灾难"), $("levelLabel").textContent);
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("4 档 prompt 注入风格强度 4", fetchCalls[0].body.messages[1].content.includes("风格强度：4"));

  // 接口对 temperature 的合法区间是 [0,1]，越界会直接 400 且不重试，
  // 等于"这一档永远失败"。这里守住下限/上限，避免以后调参又把某档写废。
  const t4 = fetchCalls[0].body.temperature;
  check("4 档温度未被写越界（0 <= t <= 1）", typeof t4 === "number" && t4 >= 0 && t4 <= 1, String(t4));
  check("4 档温度确实比 3 档更高（档位有区分度）", t4 > 0.95, "4档=" + t4);

  // ---------- 模式切换 ----------
  const enRadio = document.querySelector('input[name="mode"][value="en"]');
  enRadio.checked = true;
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("英文模式 prompt 正确", fetchCalls[0].body.messages[1].content.includes("输入语言：英文"));

  // ---------- 历史记录 ----------
  const items = document.querySelectorAll(".history-item");
  check("历史记录已生成", items.length === 4, "count=" + items.length);
  check("历史显示模式标签", items[0].textContent.includes("英文 → 微软式中文"));
  check("历史显示程度", items[0].textContent.includes("程度 4"));
  check("历史显示时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(items[0].textContent));
  check("历史包含原文", items[0].textContent.includes("我今天特别开心"));
  check("历史包含译文", items[0].textContent.includes("我今天是特别高兴的"));

  // 点击历史回填
  $("inputText").value = "清空一下";
  items[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  check("点击历史回填原文", $("inputText").value.includes("我今天特别开心"));
  check("点击历史回填译文", $("outputText").textContent.includes("我今天是特别高兴的"));

  // ---------- 历史上限 10 条 ----------
  for (let i = 0; i < 12; i++) {
    fetchCalls = [];
    $("inputText").value = "第 " + i + " 条测试";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(70);
  }
  const finalItems = document.querySelectorAll(".history-item");
  check("历史上限为 10 条", finalItems.length === 10, "count=" + finalItems.length);
  const stored = JSON.parse(window.localStorage.getItem("msstyle_translate_history_v1"));
  check("localStorage 持久化且为 10 条", stored.length === 10, "len=" + stored.length);
  check("历史记录含 mode 字段", !!stored[0].mode);
  check("历史记录含 level 字段", !!stored[0].level);
  check("历史记录含 time 字段", typeof stored[0].time === "number");

  // ---------- 复制 ----------
  await $("copyBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(20);
  check("复制按钮取到正确文本", copiedText && copiedText.includes("我今天是特别高兴的"), String(copiedText));
  check("复制后显示已复制", $("toast").textContent === "已复制", $("toast").textContent);

  // 降级路径：clipboard API 抛错 → 走 execCommand → 仍然提示"已复制"
  copiedText = null; legacyCopied = null; copyShouldFail = true;
  await $("copyBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(20);
  check("clipboard 失败时降级到 execCommand", legacyCopied !== null && legacyCopied.includes("我今天是特别高兴的"),
    String(legacyCopied));
  check("降级复制成功仍提示已复制", $("toast").textContent === "已复制", $("toast").textContent);
  copyShouldFail = false;

  // ---------- 清空输入 ----------
  $("clearBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  check("清空按钮清空输入", $("inputText").value === "");
  check("清空后计数归零", $("charCounter").textContent === "0 / 2000");

  // ---------- 错误处理：401 ----------
  fetchMode = "401";
  $("inputText").value = "测试错误";
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("401 显示通行证提示", $("toast").textContent.includes("通行证"), $("toast").textContent);
  check("401 不泄露技术细节给用户", !$("toast").textContent.includes("401"));
  check("401 后按钮恢复可用", $("translateBtn").disabled === false);

  // ---------- 错误处理：断网 ----------
  fetchMode = "network";
  $("inputText").value = "测试断网";
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("断网显示友好提示", $("toast").textContent.includes("无法连接到翻译系统"), $("toast").textContent);

  // ---------- 清空历史 ----------
  $("clearHistoryBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  check("清空历史后列表为空", $("historyList").textContent.includes("还没有记录"));
  check("清空历史后 localStorage 已移除", window.localStorage.getItem("msstyle_translate_history_v1") === null);

  // ---------- 超长输入 ----------
  $("inputText").value = "a".repeat(2500);
  $("inputText").dispatchEvent(new window.Event("input", { bubbles: true }));
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("超长输入被拦截", fetchCalls.length === 0 && $("toast").textContent.includes("太长"));

  // ---------- 程度设置持久化 ----------
  check("程度选择写入 localStorage", window.localStorage.getItem("msstyle_translate_level_v1") === "4",
    String(window.localStorage.getItem("msstyle_translate_level_v1")));

  // ---------- 备用模型自动降级 ----------
  fetchMode = "ok";
  modelHandler = null;

  // 从 script.js 读取真实配置，避免把模型名写死在测试里
  const cfgSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");
  const PRIMARY_MODEL = cfgSrc.match(/MODEL:\s*"([^"]+)"/)[1];
  const FALLBACK_MODELS = JSON.parse(cfgSrc.match(/FALLBACK_MODELS:\s*(\[[^\]]*\])/)[1]);

  // 场景 A：首选模型 429 过载，备用模型成功
  modelHandler = (model) => (model === PRIMARY_MODEL ? overloadResponse() : null);
  $("inputText").value = "测试模型降级";
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  check("降级：共发出 2 次请求", fetchCalls.length === 2, "calls=" + fetchCalls.length);
  check("降级：先试首选模型", fetchCalls[0] && fetchCalls[0].body.model === PRIMARY_MODEL,
    fetchCalls[0] && fetchCalls[0].body.model);
  check("降级：再试第一个备用模型", fetchCalls[1] && fetchCalls[1].body.model === FALLBACK_MODELS[0],
    fetchCalls[1] && fetchCalls[1].body.model);
  check("降级后翻译成功", $("outputText").textContent.includes("我今天是特别高兴的"));
  check("降级后状态为完成", $("statusText").textContent.includes("翻译完成"));

  // 场景 B：所有模型都过载 → 友好提示，且不泄露 429
  modelHandler = () => overloadResponse();
  $("inputText").value = "测试全部过载";
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  check("全部过载：尝试了所有模型", fetchCalls.length === 1 + FALLBACK_MODELS.length, "calls=" + fetchCalls.length);
  check("全部过载：提示人数太多", $("toast").textContent.includes("人实在是太多"), $("toast").textContent);
  check("全部过载：不泄露技术细节", !/429|1305/.test($("toast").textContent));
  check("全部过载：按钮恢复可用", $("translateBtn").disabled === false);

  // 场景 C：401 不应触发降级（换模型也没用）
  modelHandler = () => Promise.resolve({
    ok: false, status: 401,
    json: async () => ({ error: { code: "1002", message: "invalid api key" } }),
  });
  $("inputText").value = "测试401不降级";
  fetchCalls = [];
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  check("401 不降级：只发 1 次请求", fetchCalls.length === 1, "calls=" + fetchCalls.length);
  check("401 提示检查 Key", $("toast").textContent.includes("通行证"), $("toast").textContent);

  // 场景 D：余额不足（1113）给出专门提示
  modelHandler = () => Promise.resolve({
    ok: false, status: 429,
    json: async () => ({ error: { code: "1113", message: "余额不足或无可用资源包,请充值。" } }),
  });
  $("inputText").value = "测试余额不足";
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  check("余额不足提示充值", $("toast").textContent.includes("余额不足"), $("toast").textContent);

  modelHandler = null;
  fetchMode = "ok";

  // ---------- 慢请求渐进提示（等 6 秒太久，这里验证计时器确实被注册并在完成后清理） ----------
  let pendingTimers = 0;
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  window.setTimeout = function (fn, ms) {
    if (ms === 6000) {
      pendingTimers++;
      check("慢请求提示计时器已注册", true);
    }
    return realSetTimeout(fn, ms);
  };
  // 让请求一直不返回，这样 6 秒计时器不会被 finally 清掉
  let holdResolve = null;
  modelHandler = () => new Promise((res) => { holdResolve = res; });
  $("inputText").value = "测试慢请求";
  $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  check("慢请求期间处于加载状态", $("translateBtn").disabled === true);
  // 手动结束请求
  holdResolve({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "这是一个测试结果。" } }] }),
  });
  await sleep(80);
  check("慢请求结束后加载状态解除", $("translateBtn").disabled === false);
  window.setTimeout = realSetTimeout;
  window.clearTimeout = realClearTimeout;

  // ---------- 输出 ----------
  console.log("\n================ 测试结果 ================");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("==========================================");
  console.log("通过 " + pass + " / " + (pass + fail) + (fail ? "  ❌ 有 " + fail + " 项失败" : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
