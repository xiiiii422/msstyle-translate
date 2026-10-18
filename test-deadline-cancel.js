require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 最坏等待时间 + 取消功能测试
 *
 * 背景：实测发现上游完全无响应时，用户要等 45 秒（3 个模型 × 15 秒）才看到失败。
 *       改成"首选模型拿大头 + 总墙钟硬上限"之后应降到 25 秒以内，
 *       并且翻译过程中要能点「取消」。
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

/** 从源码读出配置，避免在测试里写死数字 */
function readConfig() {
  const g = (re) => Number(scriptSrc.match(re)[1]);
  return {
    TOTAL: g(/TOTAL_TIMEOUT:\s*(\d+)/),
    RATIO: g(/PRIMARY_BUDGET_RATIO:\s*([\d.]+)/),
    MIN: g(/MIN_ATTEMPT_TIMEOUT:\s*(\d+)/),
  };
}
const CFG = readConfig();

async function openPage(fetchImpl, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const calls = [];
  w.fetch = function (url, o) {
    calls.push({ url: String(url), hasSignal: !!(o && o.signal) });
    return fetchImpl(String(url), o, calls.length);
  };
  w.scrollTo = () => {}; w.confirm = () => true;
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "deadline.test.key" };
  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  return { dom, window: w, document: w.document, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 永不返回，只响应 abort */
function hangUntilAbort(url, o) {
  return new Promise((resolve, reject) => {
    if (o && o.signal) {
      o.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    }
  });
}

(async () => {

  /* ============ 1. 配置合理性 ============ */
  {
    check("TOTAL_TIMEOUT 不超过 30 秒（手机端可接受上限）",
      CFG.TOTAL <= 30000, CFG.TOTAL + "ms");
    check("PRIMARY_BUDGET_RATIO 在 0.4~0.8 之间",
      CFG.RATIO >= 0.4 && CFG.RATIO <= 0.8, String(CFG.RATIO));
    check("首选模型预算 >= 8 秒（够正常请求用）",
      Math.round(CFG.TOTAL * CFG.RATIO) >= 8000,
      Math.round(CFG.TOTAL * CFG.RATIO) + "ms");
    check("备用模型预算 >= MIN_ATTEMPT_TIMEOUT",
      Math.max(CFG.MIN, Math.floor((CFG.TOTAL - CFG.TOTAL * CFG.RATIO) / 2)) >= CFG.MIN,
      String(CFG.MIN));
  }

  /* ============ 2. 上游完全挂死：实测总等待 ============ */
  {
    const p = await openPage(hangUntilAbort);
    const d = p.document;
    const T0 = Date.now();
    d.getElementById("inputText").value = "最坏等待";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));

    let waited = 0;
    while (d.getElementById("translateBtn").disabled && waited < CFG.TOTAL + 15000) {
      await sleep(100); waited += 100;
    }
    const total = Date.now() - T0;

    check("上游全挂时总等待不超过 TOTAL_TIMEOUT + 容差",
      total <= CFG.TOTAL + 3000, total + "ms（上限 " + CFG.TOTAL + "ms）");
    check("上游全挂时确实试了备用模型", p.calls.length >= 2, "calls=" + p.calls.length);
    check("每个请求都带了 abort signal",
      p.calls.every((c) => c.hasSignal), JSON.stringify(p.calls));
    check("失败后按钮恢复可用", !d.getElementById("translateBtn").disabled);
    check("失败后有友好提示", d.getElementById("toast").textContent.length > 0,
      d.getElementById("toast").textContent);
    console.log(`      （上游全挂：调用 ${p.calls.length} 次，总等待 ${total}ms，上限 ${CFG.TOTAL}ms）`);
  }

  /* ============ 3. 首个模型慢但最终成功：不应被过早掐断 ============ */
  {
    const slowButOk = () => new Promise((resolve) => setTimeout(() => resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "慢但成功了。" } }] }),
    }), 10000));

    const p = await openPage(slowButOk);
    const d = p.document;
    const T0 = Date.now();
    d.getElementById("inputText").value = "慢但成功";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));

    let waited = 0;
    while (d.getElementById("translateBtn").disabled && waited < 30000) {
      await sleep(100); waited += 100;
    }
    const total = Date.now() - T0;

    check("10 秒的慢请求能成功（首选预算够）",
      d.getElementById("outputText").textContent.includes("慢但成功了"),
      d.getElementById("outputText").textContent.slice(0, 40));
    check("慢请求只调用了一次上游（没被误判超时）", p.calls.length === 1, "calls=" + p.calls.length);
    console.log(`      （10 秒慢请求：调用 ${p.calls.length} 次，耗时 ${total}ms）`);
  }

  /* ============ 4. 429 快速失败：应迅速切备用模型 ============ */
  {
    let call = 0;
    const p = await openPage(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({ ok: false, status: 429,
          json: async () => ({ error: { code: "1305", message: "访问量过大" } }) });
      }
      return Promise.resolve({ ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "备用模型结果。" } }] }) });
    });

    const d = p.document;
    const T0 = Date.now();
    d.getElementById("inputText").value = "429快速降级";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    let waited = 0;
    while (d.getElementById("translateBtn").disabled && waited < 15000) {
      await sleep(50); waited += 50;
    }
    const total = Date.now() - T0;

    check("429 后快速切备用模型并成功",
      d.getElementById("outputText").textContent.includes("备用模型结果"),
      d.getElementById("outputText").textContent.slice(0, 30));
    check("429 降级耗时应很短（<3 秒）", total < 3000, total + "ms");
  }

  /* ============ 5. 取消功能 ============ */
  {
    const p = await openPage(hangUntilAbort);
    const d = p.document;

    check("未翻译时「取消」按钮是隐藏的",
      d.getElementById("cancelBtn").hidden === true);

    d.getElementById("inputText").value = "取消测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    check("翻译中「取消」按钮出现",
      d.getElementById("cancelBtn").hidden === false);

    const T0 = Date.now();
    d.getElementById("cancelBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(300);
    const elapsed = Date.now() - T0;

    check("点取消后立刻停止（<1 秒，不用等超时）", elapsed < 1000, elapsed + "ms");
    check("取消后按钮恢复可用", !d.getElementById("translateBtn").disabled);
    check("取消后「取消」按钮重新隐藏",
      d.getElementById("cancelBtn").hidden === true);
    check("取消后状态显示已取消",
      d.getElementById("statusText").textContent.includes("取消"),
      d.getElementById("statusText").textContent);
    check("取消后提示措辞中性（不当作错误）",
      d.getElementById("toast").textContent.includes("取消") &&
      !d.getElementById("toast").textContent.includes("失败"),
      d.getElementById("toast").textContent);
    check("取消后不会留下半截结果",
      !d.getElementById("outputText").querySelector(".output-text"),
      d.getElementById("outputText").textContent.slice(0, 30));
    console.log(`      （点取消后 ${elapsed}ms 内停止）`);
  }

  /* ============ 6. 取消后可以重新翻译 ============ */
  {
    let call = 0;
    const p = await openPage(() => {
      call++;
      if (call === 1) return hangUntilAbort();
      return Promise.resolve({ ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "取消后重新翻译成功。" } }] }) });
    });
    const d = p.document;

    d.getElementById("inputText").value = "先取消再翻译";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);
    d.getElementById("cancelBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    check("取消后输入内容还在（没被清空）",
      d.getElementById("inputText").value === "先取消再翻译",
      d.getElementById("inputText").value);

    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(300);
    check("取消后能重新发起翻译并成功",
      d.getElementById("outputText").textContent.includes("取消后重新翻译成功"),
      d.getElementById("outputText").textContent.slice(0, 30));
  }

  /* ---------- 输出 ---------- */
  console.log("\n======= 最坏等待 / 取消功能测试 =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
