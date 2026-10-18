require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 恶劣网络下的用户体验测试
 *
 * 此前所有测试都假设"网络正常"或"明确失败"。真实用户（尤其手机）会遇到：
 *   · 慢到几乎超时
 *   · 中途断网
 *   · 时断时续（先失败后成功）
 *   · 离线
 * 这里验证应用在这些情况下是否仍然"能用 + 说人话"。
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

/** 造一个页面，fetch 行为由 scenario 决定 */
async function openPage(scenario, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const calls = [];

  w.fetch = function (url, o) {
    calls.push({ url: String(url), t: Date.now() });
    return scenario(String(url), o, calls.length);
  };
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "net.test.key" };
  if (opts.localStorageBroken) {
    Object.defineProperty(w, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: disabled"); },
    });
  }

  w.eval(promptSrc);
  w.eval(configSrc);
  w.eval(scriptSrc);

  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });

  return { dom, window: w, document: w.document, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 触发一次翻译并等待结束（带超时保护） */
async function translate(p, text, maxWaitMs) {
  const d = p.document;
  d.getElementById("inputText").value = text;
  d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
  const t0 = Date.now();
  d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));

  let waited = 0;
  const cap = maxWaitMs || 20000;
  while (d.getElementById("translateBtn").disabled && waited < cap) {
    await sleep(50); waited += 50;
  }
  return {
    ms: Date.now() - t0,
    output: d.getElementById("outputText").querySelector(".output-text")
      ? d.getElementById("outputText").querySelector(".output-text").textContent : "",
    status: d.getElementById("statusText").textContent,
    toast: d.getElementById("toast").textContent,
    stillBusy: d.getElementById("translateBtn").disabled,
  };
}

(async () => {

  /* ============ 1. 慢网络：3 秒后才返回 ============ */
  {
    const p = await openPage((url) => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "慢网络下返回的结果。" } }] }),
      }), 3000);
    }));

    const r = await translate(p, "慢网络测试");
    check("慢网络（3s）最终能出结果", r.output.includes("慢网络下返回的结果"), r.output.slice(0, 40));
    check("慢网络下状态显示完成", r.status.includes("翻译完成"), r.status);
    check("慢网络不会卡在加载态", !r.stillBusy);
  }

  /* ============ 2. 极慢网络：22 秒（超过单模型超时，但有备用模型） ============ */
  {
    let call = 0;
    const p = await openPage(() => {
      call++;
      // 第一次（首选模型）极慢，第二次（备用模型）正常
      if (call === 1) {
        return new Promise((resolve) => setTimeout(() => resolve({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "第一个模型很慢。" } }] }),
        }), 22000));
      }
      return new Promise((resolve) => setTimeout(() => resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "备用模型救场了。" } }] }),
      }), 200));
    });

    const r = await translate(p, "超时降级测试", 40000);
    check("首选模型超时后会切备用模型",
      r.output.includes("备用模型救场了"),
      `输出=${JSON.stringify(r.output.slice(0, 30))} 状态=${r.status}`);
    check("降级后状态显示完成", r.status.includes("翻译完成"), r.status);
    check("总耗时在合理范围（不应等到 22 秒）", r.ms < 25000, r.ms + "ms");
    console.log(`      （首选超时 → 备用成功，总耗时 ${r.ms}ms）`);
  }

  /* ============ 3. 断网（fetch reject） ============ */
  {
    const p = await openPage(() => Promise.reject(new TypeError("Failed to fetch")));
    const r = await translate(p, "断网测试");
    check("断网给出友好提示（不暴露技术细节）",
      r.toast.includes("无法连接到翻译系统") || r.toast.includes("网络"),
      r.toast);
    check("断网提示里没有英文技术词", !/TypeError|fetch|undefined/i.test(r.toast), r.toast);
    check("断网后按钮恢复可用", !r.stillBusy);
    check("断网后不会留下半截结果",
      !r.output || r.output.includes("将会出现在这里"), r.output.slice(0, 40));
  }

  /* ============ 4. 离线（navigator.onLine = false） ============ */
  {
    const p = await openPage(() => Promise.reject(new TypeError("Failed to fetch")));
    Object.defineProperty(p.window.navigator, "onLine", { value: false, configurable: true });
    const r = await translate(p, "离线测试");
    check("离线时也给友好提示", r.toast.length > 0, r.toast);
    check("离线时按钮恢复可用", !r.stillBusy);
  }

  /* ============ 5. 时断时续：先失败后成功（重试） ============ */
  {
    let call = 0;
    const p = await openPage(() => {
      call++;
      if (call === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "重试后成功了。" } }] }),
      });
    });

    const r1 = await translate(p, "第一次失败");
    check("第一次失败有提示", r1.toast.length > 0, r1.toast);

    // 用户再点一次
    const r2 = await translate(p, "第二次成功");
    check("用户可以重试并成功", r2.output.includes("重试后成功了"), r2.output.slice(0, 30));
    check("重试后状态正常", r2.status.includes("翻译完成"), r2.status);
  }

  /* ============ 6. 上游返回 500 ============ */
  {
    const p = await openPage(() => Promise.resolve({
      ok: false, status: 500,
      json: async () => ({ error: { code: "500", message: "internal error" } }),
    }));
    const r = await translate(p, "上游500");
    check("上游 500 给出友好提示",
      r.toast.includes("机器的问题") || r.toast.includes("稍后"),
      r.toast);
    check("上游 500 不泄露内部错误信息",
      !/internal error|500/.test(r.toast), r.toast);
  }

  /* ============ 7. 上游返回畸形 JSON ============ */
  {
    const p = await openPage(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    }));
    const r = await translate(p, "畸形JSON");
    check("上游返回畸形 JSON 时不崩溃", !r.stillBusy);
    check("畸形 JSON 有友好提示", r.toast.length > 0, r.toast);
  }

  /* ============ 8. 返回结构缺字段 ============ */
  {
    const p = await openPage(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [] }),   // 没有 message
    }));
    const r = await translate(p, "缺字段");
    check("上游返回结构异常时不崩溃", !r.stillBusy);
    check("结构异常有友好提示", r.toast.length > 0, r.toast);
  }

  /* ============ 9. 请求中途被 abort（模拟用户关页面/切后台） ============ */
  {
    const p = await openPage((url, o) => new Promise((resolve, reject) => {
      // 永不 resolve；等 abort 信号
      if (o && o.signal) {
        o.signal.addEventListener("abort", () => {
          const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        });
      }
    }));
    const r = await translate(p, "abort测试", 60000);
    check("请求被 abort 后能结束（不会永久卡住）", !r.stillBusy, "stillBusy=" + r.stillBusy);
    check("abort 后给出提示", r.toast.length > 0, r.toast);
    console.log(`      （abort 路径耗时 ${r.ms}ms）`);
  }

  /* ============ 10. 存储不可用（隐私模式）下仍能翻译 ============ */
  {
    const p = await openPage(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "隐私模式下也能用。" } }] }),
    }), { localStorageBroken: true });

    const r = await translate(p, "隐私模式");
    check("localStorage 不可用时仍能翻译",
      r.output.includes("隐私模式下也能用"), r.output.slice(0, 30));
    check("localStorage 不可用时不崩溃", !r.stillBusy);
  }

  /* ============ 11. 连续快速点击（真实用户手抖） ============ */
  {
    let call = 0;
    const p = await openPage(() => {
      call++;
      return new Promise((resolve) => setTimeout(() => resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "第 " + call + " 次结果。" } }] }),
      }), 400));
    });

    const d = p.document;
    d.getElementById("inputText").value = "狂点测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    const btn = d.getElementById("translateBtn");
    for (let i = 0; i < 10; i++) {
      btn.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    }
    await sleep(1200);
    check("狂点 10 次只发出 1 个请求", call === 1, "call=" + call);
    check("狂点后结果正常", d.getElementById("outputText").textContent.includes("第 1 次结果"),
      d.getElementById("outputText").textContent.slice(0, 30));
  }

  /* ============ 12. 输入超长（粘贴 5000 字） ============ */
  {
    const p = await openPage(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "不该被调用。" } }] }),
    }));
    const d = p.document;
    // 模拟粘贴超长文本（maxlength 在程序化赋值时不拦截）
    d.getElementById("inputText").value = "a".repeat(5000);
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));

    const r = await translate(p, "a".repeat(5000), 5000);
    check("超长输入被拦截并提示", r.toast.includes("太长") || r.toast.includes("2000"), r.toast);
    check("超长输入不会真的发请求", p.calls.length === 0, "calls=" + p.calls.length);
  }

  /* ---------- 输出 ---------- */
  console.log("\n========= 恶劣网络 / 异常场景 =========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
