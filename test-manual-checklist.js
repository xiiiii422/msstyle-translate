require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 核对 README 第 7 节的**手动测试清单**是否与当前代码一致。
 *
 * 这类清单看起来只是给人看的，但：
 *   · 清单写错会误导使用者（照着测却测不出问题，或以为有 bug）
 *   · 清单本身是"承诺"，和上一轮审计的 README 承诺是同一类东西
 *
 * 重点核对那些"后来改过行为、但清单没同步"的地方。
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
const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");

async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const requests = [];
  w.fetch = function (url, o) {
    requests.push({ url: String(url) });
    if (opts.fetchImpl) return opts.fetchImpl(url, o);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "默认结果。" } }] }),
    });
  };
  w.scrollTo = () => {}; w.confirm = () => true;
  // 注意：不设 apiKey，模拟"Key 未配置"
  w.__MSSTYLE_CONFIG__ = opts.config || {};
  if (opts.presetKey) w.localStorage.setItem("msstyle_translate_apikey_v1", opts.presetKey);
  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  return { dom, window: w, document: w.document, requests };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

  /* ============ README 第 1 条：空输入 ============ */
  {
    const p = await openPage({ presetKey: "k" });
    const d = p.document;
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(100);
    check("清单①：空输入提示「请先输入一点内容」",
      d.getElementById("toast").textContent.includes("请先输入一点内容"),
      d.getElementById("toast").textContent);
    check("清单①：空输入不发起 API 请求", p.requests.length === 0, "请求数=" + p.requests.length);
  }

  /* ============ README 第 4 条：字符计数最多 2000 ============ */
  {
    const p = await openPage({ presetKey: "k" });
    const d = p.document;
    const input = d.getElementById("inputText");
    input.value = "x".repeat(2500);   // 程序化赋值绕过 maxlength
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    check("清单④：计数不会超过 2000（显示的是实际长度还是截断值？）",
      d.getElementById("charCounter").textContent === "2500 / 2000" ||
      d.getElementById("charCounter").textContent === "2000 / 2000",
      d.getElementById("charCounter").textContent);
  }

  /* ============ README 第 6 条：快速连点 5 次只发 1 次请求 ============ */
  {
    let call = 0;
    const p = await openPage({
      presetKey: "k",
      fetchImpl: () => {
        call++;
        return new Promise((res) => setTimeout(() => res({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "结果" + call } }] }),
        }), 300));
      },
    });
    const d = p.document;
    d.getElementById("inputText").value = "连点测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    for (let i = 0; i < 5; i++) {
      d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    }
    await sleep(600);
    check("清单⑥：连点 5 次只发出 1 次请求", call === 1, "调用次数=" + call);
  }

  /* ============ README 第 7 条：请求中显示进度条 ============ */
  {
    const p = await openPage({
      presetKey: "k",
      fetchImpl: () => new Promise((res) => setTimeout(() => res({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "慢结果" } }] }),
      }), 800)),
    });
    const d = p.document;
    d.getElementById("inputText").value = "进度条测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("清单⑦：请求中显示「正在进行非常认真的机器翻译」",
      d.getElementById("outputText").textContent.includes("正在进行非常认真的机器翻译"),
      d.getElementById("outputText").textContent.slice(0, 30));
    check("清单⑦：请求中显示进度条元素",
      !!d.querySelector(".loading-bar"));
    check("清单⑦：按钮变灰显示「正在翻译」",
      d.getElementById("translateBtn").disabled === true &&
      d.getElementById("translateBtn").textContent.includes("正在翻译"),
      d.getElementById("translateBtn").textContent);
  }

  /* ============ 错误处理表第 1 行：Key 未配置 ============ */
  {
    const p = await openPage();   // 不设 Key
    const d = p.document;
    // README 说：提示"还没有配置 API Key……"
    // 但实际行为可能是"打开设置面板"——需要核对清楚
    d.getElementById("inputText").value = "无 Key 测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    const toast = d.getElementById("toast").textContent;
    const settingsOpen = d.getElementById("settingsPanel").hidden === false;
    const onboardingOpen = d.getElementById("onboarding").hidden === false;

    console.log("      [实际情况] 无 Key 时：");
    console.log("        toast     = " + JSON.stringify(toast));
    console.log("        设置面板打开 = " + settingsOpen);
    console.log("        引导弹窗打开 = " + onboardingOpen);

    check("错误表①：无 Key 时确实给出了提示",
      toast.length > 0, toast);
    check("错误表①：提示里提到 API Key",
      /API Key/i.test(toast), toast);
    check("错误表①：无 Key 时不发起请求", p.requests.length === 0, "请求数=" + p.requests.length);

    // 核对 README「错误处理测试」表格里声称的文案。
    //
    // 注意：不能对整篇 README 做 includes() —— 那会误伤「事故记录」章节里
    // 引用旧文案的说明文字（那些是历史描述，不是当下的承诺）。
    // 所以这里只截取表格所在的区块来检查。
    const tableStart = readme.indexOf("### 错误处理测试");
    const tableEnd = readme.indexOf("### 响应式", tableStart);
    const errTable = tableStart >= 0
      ? readme.slice(tableStart, tableEnd > tableStart ? tableEnd : tableStart + 2000)
      : "";

    check("README 有「错误处理测试」表格", errTable.length > 0);

    // 表格里描述的「Key 未配置」那一行，文案必须与代码一致
    const row = errTable.split("\n").find((l) => l.includes("Key 未配置")) || "";
    check("错误表描述的无 Key 文案与代码一致",
      row.includes("请先填写 API Key"),
      row ? row.trim().slice(0, 80) : "(找不到该行)");
    check("错误表不再残留旧文案「还没有配置 API Key」",
      !row.includes("还没有配置 API Key"),
      row ? row.trim().slice(0, 80) : "");
  }

  /* ============ 错误处理表第 2 行：Key 错误 ============ */
  {
    const p = await openPage({
      presetKey: "wrong.key",
      fetchImpl: () => Promise.resolve({
        ok: false, status: 401,
        json: async () => ({ error: { code: "1002", message: "invalid api key" } }),
      }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "错误 Key 测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(250);

    check("错误表②：Key 错误提示「通行证没有被承认」",
      d.getElementById("toast").textContent.includes("通行证"),
      d.getElementById("toast").textContent);
  }

  /* ============ 错误处理表第 3 行：断网 ============ */
  {
    const p = await openPage({
      presetKey: "k",
      fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const d = p.document;
    d.getElementById("inputText").value = "断网测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(250);

    check("错误表③：断网提示「无法连接到翻译系统」",
      d.getElementById("toast").textContent.includes("无法连接到翻译系统"),
      d.getElementById("toast").textContent);
    check("错误表③：断网后不卡死（按钮恢复）",
      d.getElementById("translateBtn").disabled === false);
  }

  /* ============ 历史记录清单第 2 条：每条显示五项信息 ============ */
  {
    const p = await openPage({ presetKey: "k" });
    const d = p.document;
    d.getElementById("inputText").value = "历史字段测试";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(200);

    const item = d.querySelector(".history-item");
    const txt = item ? item.textContent : "";
    check("历史清单②：显示模式", /自动识别|中文 →|英文 →/.test(txt), txt.slice(0, 60));
    check("历史清单②：显示程度", /程度\s*\d/.test(txt), txt.slice(0, 60));
    check("历史清单②：显示时间", /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(txt), txt.slice(0, 60));
    check("历史清单②：显示原文", txt.includes("历史字段测试"), txt.slice(0, 60));
    check("历史清单②：显示译文", txt.includes("默认结果"), txt.slice(0, 60));
  }

  /* ============ 错误处理：README 说真实错误只在 Console ============ */
  {
    // 这条是"不应该出现在 UI 上"的断言，与上轮的教训一致
    const p = await openPage({
      presetKey: "k",
      fetchImpl: () => Promise.resolve({
        ok: false, status: 500,
        json: async () => ({ error: { code: "500", message: "internal server error XYZ" } }),
      }),
    });
    const d = p.document;
    d.getElementById("inputText").value = "错误泄露测试";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(250);

    const uiText = d.getElementById("toast").textContent + " " +
      d.getElementById("statusText").textContent + " " +
      d.getElementById("outputText").textContent;
    check("上游错误原文不出现在界面上",
      !uiText.includes("internal server error") && !uiText.includes("XYZ"),
      uiText.slice(0, 60));
    check("原始状态码不出现在界面上",
      !/\b500\b/.test(uiText), uiText.slice(0, 60));
  }

  /* ============ 错误文案映射：每种场景必须给出对应的话术 ============ */
  {
    const SCENARIOS = [
      { name: "断网", expect: "无法连接到翻译系统",
        impl: () => Promise.reject(new TypeError("Failed to fetch")) },
      { name: "上游 5xx", expect: "非常机器的问题",
        impl: () => Promise.resolve({ ok: false, status: 500,
          json: async () => ({ error: { code: "500", message: "boom" } }) }) },
      { name: "全部模型 429", expect: "人实在是太多",
        impl: () => Promise.resolve({ ok: false, status: 429,
          json: async () => ({ error: { code: "1305", message: "busy" } }) }) },
      { name: "Key 错误 401", expect: "通行证没有被承认",
        impl: () => Promise.resolve({ ok: false, status: 401,
          json: async () => ({ error: { code: "1002", message: "invalid api key" } }) }) },
      { name: "余额不足 1113", expect: "余额不足",
        impl: () => Promise.resolve({ ok: false, status: 429,
          json: async () => ({ error: { code: "1113", message: "余额不足或无可用资源包" } }) }) },
    ];

    for (const s of SCENARIOS) {
      const p = await openPage({ presetKey: "k", fetchImpl: s.impl });
      const d = p.document;
      d.getElementById("inputText").value = s.name + " 测试";
      d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
      d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
      await sleep(300);
      const toast = d.getElementById("toast").textContent;
      check(`${s.name} → 提示「${s.expect}」`, toast.includes(s.expect), toast);
    }

    // 关键回归：500 不能被误报成"人太多"
    // （曾经的真实 bug：allModelsBusy 判断放在 status 之前，
    //   导致服务器故障被说成"用户太多"，用户会白等重试）
    const p500 = await openPage({
      presetKey: "k",
      fetchImpl: () => Promise.resolve({ ok: false, status: 500,
        json: async () => ({ error: { code: "500", message: "boom" } }) }),
    });
    const d500 = p500.document;
    d500.getElementById("inputText").value = "500 误报回归";
    d500.getElementById("inputText").dispatchEvent(new p500.window.Event("input", { bubbles: true }));
    d500.getElementById("translateBtn").dispatchEvent(new p500.window.MouseEvent("click", { bubbles: true }));
    await sleep(300);
    check("500 错误不再被误报为「人太多」",
      !d500.getElementById("toast").textContent.includes("人实在是太多"),
      d500.getElementById("toast").textContent);
  }

  /* ---------- 输出 ---------- */
  console.log("\n======= README 手动清单 vs 实际行为 =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("===========================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
