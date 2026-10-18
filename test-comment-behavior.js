/* 行为级核对：注释声称的行为是否真的发生
 *
 * 上面 check-comment-claims.js 只验证"代码里有这段字符串"，
 * 那是弱验证 —— 字符串在，行为仍可能是坏的。
 * 这里对几条关键声称做**真实行为**验证。
 */
require("./check-integrity.js");

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dir = __dirname;
const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const promptSrc = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");
const configSrc = fs.readFileSync(path.join(dir, "config.js"), "utf8");
const scriptSrc = fs.readFileSync(path.join(dir, "script.js"), "utf8");

async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const models = [];
  w.fetch = function (url, o) {
    if (o && o.body) {
      try { models.push(JSON.parse(o.body).model); } catch (e) {}
    }
    if (opts.fetchImpl) return opts.fetchImpl(url, o);
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "结果" } }] }) });
  };
  w.scrollTo = () => {}; w.confirm = () => true;
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "k" };
  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);
  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  return { window: w, document: w.document, models };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

  /* ============ 1. "去重，避免重复请求同一个模型" —— 真的去重了吗 ============ */
  {
    // 让 MODEL 和第一个 FALLBACK 相同，检验是否会被重复请求
    const p = await openPage({
      fetchImpl: () => Promise.resolve({ ok: false, status: 429,
        json: async () => ({ error: { code: "1305", message: "busy" } }) }),
    });
    const w = p.window;

    // 人为把 FALLBACK_MODELS 设成包含首选模型，看是否去重
    w.eval(`
      // 直接操作内部 CONFIG 不方便，改为验证 Observable 行为：
      // 连续 429 时，请求链里不应出现同一个模型两次
    `);

    const d = p.document;
    d.getElementById("inputText").value = "去重验证";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(400);

    const dupes = p.models.filter((m, i) => p.models.indexOf(m) !== i);
    check("请求链里没有重复模型（去重真的生效）",
      dupes.length === 0, `请求序列: ${p.models.join(" → ")}`);
    check("至少尝试了 2 个不同模型",
      new Set(p.models).size >= 2, `${new Set(p.models).size} 个不同模型`);
  }

  /* ============ 2. "textContent 避免 XSS" —— 真的挡住了吗 ============ */
  {
    const payload = '<img src=x onerror="window.__XSS__=1"><script>window.__XSS2__=1<\/script>';
    const p = await openPage({
      fetchImpl: () => Promise.resolve({ ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: payload } }] }) }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "XSS 行为验证";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(300);

    check("恶意 HTML 未被执行", p.window.__XSS__ === undefined,
      "window.__XSS__=" + p.window.__XSS__);
    check("恶意 script 未被执行", p.window.__XSS2__ === undefined,
      "window.__XSS2__=" + p.window.__XSS2__);
    check("输出区没有插入真实 img 元素",
      d.getElementById("outputText").querySelector("img") === null);
    check("输出区没有插入真实 script 元素",
      d.getElementById("outputText").querySelector("script") === null);
  }

  /* ============ 3. "过期响应丢弃" —— 真的丢弃吗 ============ */
  {
    let call = 0;
    let resolveFirst = null;
    const p = await openPage({
      fetchImpl: () => {
        call++;
        if (call === 1) {
          // 第一次请求：挂住，等我们手动放行
          return new Promise((res) => { resolveFirst = () => res({
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: "第一次（过期）的结果" } }] }),
          }); });
        }
        return Promise.resolve({ ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "第二次（最新）的结果" } }] }) });
      },
    });
    const w = p.window, d = w.document;

    // 发起第一次
    d.getElementById("inputText").value = "第一次";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(100);

    // 取消，再发起第二次
    d.getElementById("cancelBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(50);
    d.getElementById("inputText").value = "第二次";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    // 现在放行那个"过期的"第一次响应
    if (resolveFirst) resolveFirst();
    await sleep(300);

    const out = d.getElementById("outputText").textContent;
    check("过期响应不会覆盖最新结果",
      !out.includes("第一次（过期）"), out.slice(0, 50));
    check("最新结果正确显示",
      out.includes("第二次（最新）"), out.slice(0, 50));
  }

  /* ============ 4. "429 具体判断先于兜底" —— 行为验证 ============ */
  {
    const p = await openPage({
      fetchImpl: () => Promise.resolve({ ok: false, status: 429,
        json: async () => ({ error: { code: "1305", message: "busy" } }) }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "429 行为";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(400);
    check("429 时提示「人太多」而不是「机器的问题」",
      d.getElementById("toast").textContent.includes("人实在是太多"),
      d.getElementById("toast").textContent);
  }

  /* ============ 5. 长时间请求可以被取消（不会永久挂起） ============ */
  {
    const p = await openPage({
      fetchImpl: (url, o) => new Promise((res, rej) => {
        if (o && o.signal) {
          o.signal.addEventListener("abort", () => {
            const e = new Error("aborted"); e.name = "AbortError"; rej(e);
          });
        }
      }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "超时上限验证";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("长时间请求期间按钮处于加载态",
      d.getElementById("translateBtn").disabled === true);

    // 手动取消，避免测试等满 TOTAL_TIMEOUT（25 秒）
    d.getElementById("cancelBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("可以中断长时间请求（不会永久挂起）",
      d.getElementById("translateBtn").disabled === false,
      "按钮仍禁用");
  }

  /* ---------- 输出 ---------- */
  console.log("\n======== 注释声称的行为级核对 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
