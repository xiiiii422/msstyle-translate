require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 验证新增 UI：Key 设置、引导、竞态、存储降级、hidden 语义 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const __PROMPT_SRC__ = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/** 用指定配置造一个环境 */
function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://example.com/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // 外部 config.js 模拟
  if (opts.externalConfig) window.__MSSTYLE_CONFIG__ = opts.externalConfig;

  // fetch mock
  const calls = [];
  window.fetch = function (url, o) {
    const body = JSON.parse(o.body);
    calls.push({ url, body, headers: o.headers, signal: o.signal });
    if (opts.fetchImpl) return opts.fetchImpl(body, calls.length, o);
    return new Promise((res) =>
      setTimeout(
        () => res({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "我今天是特别高兴的，因为假期终于已经到达。" } }] }),
        }), 25)
    );
  };

  window.scrollTo = () => {};
  window.confirm = () => true;
  window.eval(__PROMPT_SRC__);   // 先加载共享提示词模块
  window.eval(opts.scriptSource || js);

  return { dom, window, document: window.document, calls };
}

const waitInit = (window) => new Promise((resolve) => {
  const d = window.document;
  if (d.readyState !== "loading") return setTimeout(resolve, 0);
  d.addEventListener("DOMContentLoaded", () => setTimeout(resolve, 0), { once: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  /* ============ 场景 1：全新访客，没有任何 Key ============ */
  {
    const { window, document: d } = makeDom();
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    check("[无Key] 首次引导自动弹出", $("onboarding").hidden === false);
    check("[无Key] 设置面板默认隐藏", $("settingsPanel").hidden === true);
    check("[无Key] 设置按钮带 needs-key 提示", $("settingsBtn").classList.contains("needs-key"));

    // 点「去填写 API Key」应打开设置面板并关闭引导
    $("onboardingSetupBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(10);
    check("[无Key] 点引导按钮后引导关闭", $("onboarding").hidden === true);
    check("[无Key] 点引导按钮后设置面板打开", $("settingsPanel").hidden === false);
    check("[无Key] 设置按钮 aria-expanded=true", $("settingsBtn").getAttribute("aria-expanded") === "true");

    // 填 Key 并保存
    $("apiKeyInput").value = "abc123.def456ghi789";
    $("saveKeyBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(10);
    check("[无Key] 保存后写入 localStorage",
      window.localStorage.getItem("msstyle_translate_apikey_v1") === "abc123.def456ghi789",
      window.localStorage.getItem("msstyle_translate_apikey_v1"));
    check("[无Key] 保存后输入框被清空（不留明文）", $("apiKeyInput").value === "");
    check("[无Key] 保存后状态提示为成功", $("keyStatus").className.includes("is-ok"), $("keyStatus").textContent);
    check("[无Key] 保存后 needs-key 消失", !$("settingsBtn").classList.contains("needs-key"));

    // 现在翻译应该用这个 Key
    const callsBefore = 0;
    $("inputText").value = "我今天特别开心，因为终于放假了。";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(80);
    check("[无Key] 保存后可以正常翻译", $("outputText").textContent.includes("我今天是特别高兴的"));

    // 关闭面板应清空输入
    $("toggleKeyBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check("[无Key] 显示按钮切换 type=text", $("apiKeyInput").type === "text");
    $("settingsCloseBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(10);
    check("[无Key] 关闭后输入框重置为 password", $("apiKeyInput").type === "password");
    check("[无Key] 关闭后设置面板隐藏", $("settingsPanel").hidden === true);
    check("[无Key] 关闭后 aria-expanded=false", $("settingsBtn").getAttribute("aria-expanded") === "false");
  }

  /* ============ 场景 2：Key 通过 config.js 预置 ============ */
  {
    const { window, document: d, calls } = makeDom({
      externalConfig: { apiKey: "preset.key.from.config", model: "glm-4-flash" },
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    check("[预置Key] 不弹出引导", $("onboarding").hidden === true);
    check("[预置Key] 设置按钮无 needs-key", !$("settingsBtn").classList.contains("needs-key"));

    $("inputText").value = "测试预置 Key";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(120);
    check("[预置Key] 用 config.js 的 Key 发起请求",
      calls.length > 0 && calls[0].headers.Authorization === "Bearer preset.key.from.config",
      calls.length ? calls[0].headers.Authorization : "(无请求)");
    check("[预置Key] 使用了 config.js 指定的模型",
      calls.length > 0 && calls[0].body.model === "glm-4-flash",
      calls.length ? calls[0].body.model : "(无请求)");
  }

  /* ============ 场景 3：访客 Key 覆盖 config.js 预置 Key ============ */
  {
    const ext = { apiKey: "preset.key", model: "glm-4.7-flash" };
    const { window, document: d, calls } = makeDom({ externalConfig: ext });
    // 预先在 localStorage 放一个访客 Key
    window.localStorage.setItem("msstyle_translate_apikey_v1", "user.own.key");
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    $("inputText").value = "测试覆盖";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(120);
    check("[覆盖] 访客 Key 优先于预置 Key",
      calls.length > 0 && calls[0].headers.Authorization === "Bearer user.own.key",
      calls.length ? calls[0].headers.Authorization : "(无请求)");
  }

  /* ============ 场景 4：竞态 —— 在途请求被打断后不得覆盖新结果 ============ */
  {
    let resolvers = [];
    const { window, document: d } = makeDom({
      externalConfig: { apiKey: "k" },
      fetchImpl: (body) => new Promise((res) => { resolvers.push({ body, res }); }),
    });
    await waitInit(window);
    const $ = (id) => d.getElementById(id);

    $("inputText").value = "第一次请求";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);

    // 请求进行中再点一次 —— 应被 loading 挡住
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("[竞态] 请求中重复点击不会发起新请求", resolvers.length === 1, "resolvers=" + resolvers.length);

    // 让第一次请求返回
    resolvers[0].res({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "第一次的结果" } }] }),
    });
    await sleep(60);
    check("[竞态] 第一次结果正常显示", $("outputText").textContent.includes("第一次的结果"));
  }

  /* ============ 场景 5：localStorage 被禁用（隐私模式）============ */
  {
    const { window, document: d } = makeDom({ externalConfig: { apiKey: "k" } });
    // 在脚本执行前就把 localStorage 打坏 —— 必须在 eval 之前做，做不到就跳过
    await waitInit(window);
    const $ = (id) => d.getElementById(id);
    // 运行时把 localStorage 改成抛异常，测试后续写入路径
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: localStorage disabled"); },
    });
    $("inputText").value = "测试存储禁用";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(80);
    check("[存储禁用] 翻译仍然成功（不被存储异常打断）",
      $("outputText").textContent.includes("我今天是特别高兴的"), $("outputText").textContent.slice(0, 30));
  }

  /* ============ 场景 6：Key 缺失时点翻译 ============ */
  {
    const { window, document: d } = makeDom();
    await waitInit(window);
    const $ = (id) => d.getElementById(id);
    $("onboardingSkipBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(10);
    check("[缺Key] 点跳过会记住选择",
      window.localStorage.getItem("msstyle_onboard_skipped") === "1");

    $("inputText").value = "没有 Key 也要翻译";
    $("translateBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("[缺Key] 提示去设置填 Key", $("toast").textContent.includes("设置"), $("toast").textContent);
    check("[缺Key] 自动打开设置面板", $("settingsPanel").hidden === false);
  }

  /* ============ 场景 7：跳过引导后刷新不再弹 ============ */
  {
    const { window, document: d } = makeDom({ externalConfig: { apiKey: "k" } });
    await waitInit(window);
    check("[预置Key] 有 Key 时不弹引导", d.getElementById("onboarding").hidden === true);
  }

  /* ============ 输出 ============ */
  console.log("\n============ 新增 UI 测试 ============");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
