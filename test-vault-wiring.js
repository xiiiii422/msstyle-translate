require("./check-integrity.js");
/* 内置 Key 的"接线"测试
 *
 * 前面的 test-secret.js 只验证了 secret.js 自己能解密；
 * 这个套件验证**整条链路真的接上了**：
 *
 *   index.html 引入 secret.js → script.js 认出 vault → KeyStore 取到 Key
 *   → 请求头里带上 Authorization → 页面里不出现明文 Key
 *
 * 为什么不用"真实浏览器"测：jsdom 没有 crypto.subtle（真实环境下它会
 * 安静降级成"需要访客自己填 Key"），所以这里手动把 Node 的 WebCrypto
 * 注入进去，模拟一个支持 WebCrypto 的浏览器。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const secretSrc = fs.readFileSync(path.join(dir, "secret.js"), "utf8");
const promptSrc = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");
const scriptSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个"支持 WebCrypto"的窗口 */
async function makeWindow(withVault) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://xiiiii422.github.io/msstyle-translate/",
    pretendToBeVisual: true,
  });
  const w = dom.window;

  // jsdom 的 crypto 只有 getRandomValues，没有 subtle；补上 Node 的实现。
  // 注意：jsdom 把 crypto 定义成原型上的 getter，直接赋值会被静默忽略，
  // 必须用 defineProperty 在实例上盖一层。
  const nodeCrypto = require("crypto").webcrypto;
  try {
    Object.defineProperty(w, "crypto", { value: nodeCrypto, configurable: true });
  } catch (e) {
    try { w.crypto = nodeCrypto; } catch (e2) { /* 下面会断言失败并说明原因 */ }
  }
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;

  w.scrollTo = () => {};
  w.confirm = () => true;

  // 记录请求
  w.__calls = [];
  w.fetch = function (url, opts) {
    w.__calls.push({ url: String(url), headers: (opts && opts.headers) || {}, body: opts && opts.body });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "我今天是有高兴的。" }, finish_reason: "stop" }] }),
    });
  };

  if (withVault) w.eval(secretSrc);
  w.eval(promptSrc);
  w.eval(scriptSrc);

  // script.js 在 readyState === "loading" 时等 DOMContentLoaded 才 init。
  // 让 jsdom 自己把那件事发完（不要手动 dispatch，否则 init 会跑两次）。
  await sleep(40);
  return w;
}

(async () => {
  /* ============ 1. 页面确实引入了 secret.js，且顺序在 script.js 之前 ============ */
  {
    const iSecret = html.indexOf('src="secret.js"');
    const iScript = html.indexOf('src="script.js"');
    check("index.html 引入了 secret.js", iSecret > 0);
    check("secret.js 在 script.js 之前加载", iSecret > 0 && iSecret < iScript,
      "secret@" + iSecret + " script@" + iScript);
    check("secret.js 用 defer（不阻塞渲染）", /<script src="secret\.js" defer/.test(html));
  }

  /* ============ 2. 有 vault 时：页面直接可用，不弹引导 ============ */
  const w = await makeWindow(true);
  const d = w.document;

  check("vault 暴露在 window 上", !!w.__MSSTYLE_VAULT__);
  check("vault 在当前域名下可解密", w.__MSSTYLE_VAULT__.canAttempt() === true);

  // 解密是异步的，等它完成（PBKDF2 15 万轮，实测 20~80ms）
  const revealed = await w.__MSSTYLE_VAULT__.unlock();
  check("能解出内置 Key", typeof revealed === "string" && revealed.length > 10);
  check("解出的 Key 符合智谱格式", /^[0-9a-f]{32}\.[A-Za-z0-9]{8,}$/.test(revealed || ""));

  check("有内置 Key 时不弹首次引导", d.getElementById("onboarding").hidden === true);
  check("有内置 Key 时设置按钮不打红点",
    !d.getElementById("settingsBtn").classList.contains("needs-key"));
  check("有内置 Key 时可以直接翻译（输入框可用）",
    d.getElementById("inputText").disabled === false);

  /* ============ 3. 点一次翻译：请求头带上解出来的 Key ============ */
  d.getElementById("inputText").value = "我今天特别开心。";
  d.getElementById("inputText").dispatchEvent(new w.Event("input", { bubbles: true }));
  d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

  // 等解密 + 请求 + 渲染
  for (let i = 0; i < 60 && !w.__calls.length; i++) await sleep(50);
  check("翻译确实发出了请求", w.__calls.length >= 1, w.__calls.length + " 次");

  const call = w.__calls[0] || { headers: {}, body: "" };
  const auth = call.headers["Authorization"] || "";
  check("请求头带 Authorization: Bearer", /^Bearer \S+$/.test(auth));
  check("请求头里的 Key 就是解密出来的那个", auth === "Bearer " + revealed);
  check("请求发往智谱官方接口", /open\.bigmodel\.cn\/api\/paas\/v4\/chat\/completions$/.test(call.url), call.url);

  /* ============ 4. 明文 Key 不出现在页面 / 存储里 ============ */
  check("页面 DOM 里没有明文 Key", !d.body.innerHTML.includes(revealed));
  check("页面 HTML 里没有明文 Key", !html.includes(revealed));
  check("localStorage 里没有写入明文 Key", !JSON.stringify(Object.entries({ ...w.localStorage })).includes(revealed));

  await sleep(60);
  check("翻译结果已渲染", d.getElementById("outputText").textContent.includes("高兴"));
  check("翻译完成后没有报错提示",
    !d.getElementById("toast").classList.contains("is-error"),
    d.getElementById("toast").textContent);

  /* ============ 5. 没有 secret.js 时（降级）仍然要求访客自己填 ============ */
  const w2 = await makeWindow(false);
  const d2 = w2.document;
  check("没有 secret.js 时不暴露 vault", !w2.__MSSTYLE_VAULT__);
  d2.getElementById("inputText").value = "测试";
  d2.getElementById("translateBtn").dispatchEvent(new w2.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  check("降级时给出「请先填写 API Key」提示",
    /API Key/.test(d2.getElementById("toast").textContent),
    d2.getElementById("toast").textContent);
  check("降级时自动打开设置面板", d2.getElementById("settingsPanel").hidden === false);

  /* ============ 输出 ============ */
  console.log("\n======== 内置 Key 接线测试 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
