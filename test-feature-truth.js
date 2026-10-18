require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 逐个质疑面向用户的功能：它们真的像 UI 宣称的那样工作吗？
 *
 * 背景：上一轮发现"翻译程度"滑块是坏的（拉到最高反而效果最弱），
 *       而 400+ 项断言全绿 —— 因为它们只测"没报错"，不测"有没有用"。
 *       这个套件用同样的问题去审其他功能：
 *         · 语言模式切换真的改变行为吗？
 *         · 随机示例真的会换句子吗？会不会抽到和当前一样的？
 *         · 历史记录点击后真的完整还原吗？
 *         · 复制真的复制了输出框里的内容吗？
 *         · 重新翻译真的重新请求了吗？
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

/** 记录每次发给模型的实际 prompt，用于验证"模式是否真的生效" */
async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const requests = [];
  let replyIndex = 0;
  const replies = opts.replies || [];

  w.fetch = function (url, o) {
    const body = o && o.body ? JSON.parse(o.body) : null;
    requests.push({ url: String(url), body, userPrompt: body && body.messages ? body.messages[1].content : "" });
    const r = replies[replyIndex] || { text: "默认回复 " + replyIndex };
    replyIndex++;
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: r.text } }] }),
    });
  };
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "feature.audit.key" };
  if (opts.clipboard) {
    Object.defineProperty(w.navigator, "clipboard", {
      value: { writeText: async (t) => { opts.clipboard.copied = t; } },
      configurable: true,
    });
    w.isSecureContext = true;
  }
  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    const d = w.document;
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });
  return { dom, window: w, document: w.document, requests };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translate(p, text) {
  const d = p.document;
  d.getElementById("inputText").value = text;
  d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
  d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  return d.getElementById("outputText").textContent;
}

(async () => {

  /* ============ 1. 语言模式：切换真的改变发给模型的内容吗？ ============ */
  {
    const p = await openPage();
    const d = p.document;

    for (const mode of ["auto", "zh", "en"]) {
      const radio = d.querySelector('input[name="mode"][value="' + mode + '"]');
      radio.checked = true;
      radio.dispatchEvent(new p.window.Event("change", { bubbles: true }));
      await translate(p, "模式测试文本");
    }

    check("三种模式各发出了一次请求", p.requests.length === 3, "requests=" + p.requests.length);

    const [auto, zh, en] = p.requests.map((r) => r.userPrompt);
    check("自动识别模式注入「自动判断」", auto && auto.includes("自动判断"),
      auto ? auto.slice(0, 40) : "(无)");
    check("中文模式注入「输入语言：中文」", zh && zh.includes("输入语言：中文"),
      zh ? zh.slice(0, 40) : "(无)");
    check("英文模式注入「输入语言：英文」", en && en.includes("输入语言：英文"),
      en ? en.slice(0, 40) : "(无)");

    // 三种模式的 prompt 必须互不相同，否则切换模式没有意义
    const distinct = new Set([auto, zh, en]).size;
    check("三种模式发出的 prompt 互不相同", distinct === 3, "不同数=" + distinct);
  }

  /* ============ 2. 随机示例：真的会换句子吗？ ============ */
  {
    const p = await openPage();
    const d = p.document;
    const input = d.getElementById("inputText");

    // 连点 20 次，看抽到多少种不同的句子
    const seen = [];
    for (let i = 0; i < 20; i++) {
      d.getElementById("randomBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
      seen.push(input.value);
    }

    check("随机示例每次都会填入内容", seen.every((s) => s.length > 0),
      seen.filter((s) => !s).length + " 次为空");
    check("随机示例能抽到多种句子", new Set(seen).size >= 4,
      "不同句子数=" + new Set(seen).size);

    // 关键：不应连续抽到同一句（代码注释声称"尽量避免"）
    let consecutive = 0;
    for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) consecutive++;
    check("不会连续两次抽到同一句", consecutive === 0, "连续重复 " + consecutive + " 次");

    // 抽到的句子应当在代码里定义过（不能是乱码）
    const samples = scriptSrc.match(/const SAMPLES = \[([\s\S]*?)\];/);
    const sampleList = samples ? samples[1].match(/"((?:[^"\\]|\\.)*)"/g).map((s) => JSON.parse(s)) : [];
    check("抽到的句子都来自内置示例库", seen.every((s) => sampleList.indexOf(s) >= 0),
      "库里有 " + sampleList.length + " 条");
    check("内置示例库至少 8 条", sampleList.length >= 8, sampleList.length + " 条");
    check("示例库同时包含中英文",
      sampleList.some((s) => /[\u4e00-\u9fa5]/.test(s)) && sampleList.some((s) => /^[A-Za-z]/.test(s)),
      sampleList.length + " 条");
  }

  /* ============ 3. 历史记录：点击后真的完整还原吗？ ============ */
  {
    const p = await openPage({
      replies: [
        { text: "第一条结果。" },
        { text: "第二条结果。" },
      ],
    });
    const d = p.document;

    // 翻译两次（用不同模式与档位，验证还原是否包含这些）
    d.querySelector('input[name="mode"][value="zh"]').checked = true;
    d.getElementById("levelRange").value = "2";
    d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await translate(p, "第一次原文");

    d.querySelector('input[name="mode"][value="en"]').checked = true;
    d.getElementById("levelRange").value = "4";
    d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await translate(p, "第二次原文");

    const items = d.querySelectorAll(".history-item");
    check("两次翻译产生两条历史", items.length === 2, "count=" + items.length);

    // 最新的在最前面
    check("最新的历史排在最前", items[0].textContent.includes("第二次原文"),
      items[0].textContent.slice(0, 40));

    // 清空界面，再点历史还原
    d.getElementById("clearBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    check("清空后输入框为空", d.getElementById("inputText").value === "");

    const beforeCalls = p.requests.length;
    items[1].dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(60);

    check("点击历史还原了原文", d.getElementById("inputText").value === "第一次原文",
      d.getElementById("inputText").value);
    check("点击历史还原了结果", d.getElementById("outputText").textContent.includes("第一条结果"),
      d.getElementById("outputText").textContent.slice(0, 30));
    check("点击历史不会重新请求 API（只是回看）",
      p.requests.length === beforeCalls, "多发了 " + (p.requests.length - beforeCalls) + " 次");
    check("点击历史后复制按钮可用（结果确实可用）",
      d.getElementById("copyBtn").disabled === false);
  }

  /* ============ 4. 复制：复制的是输出内容吗？ ============ */
  {
    const clip = { copied: null };
    const p = await openPage({
      replies: [{ text: "这是要被复制的结果。" }],
      clipboard: clip,
    });
    const d = p.document;

    await translate(p, "复制测试原文");
    check("复制前按钮禁用状态正确",
      d.getElementById("copyBtn").disabled === false,
      "disabled=" + d.getElementById("copyBtn").disabled);

    d.getElementById("copyBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(80);

    check("复制到剪贴板的内容就是输出结果",
      clip.copied === "这是要被复制的结果。", JSON.stringify(clip.copied));
    check("复制后提示「已复制」",
      d.getElementById("toast").textContent === "已复制", d.getElementById("toast").textContent);
  }

  /* ============ 5. 重新翻译：真的重新请求吗？结果会更新吗？ ============ */
  {
    const p = await openPage({
      replies: [
        { text: "第一次生成的结果。" },
        { text: "重新翻译后的新结果。" },
      ],
    });
    const d = p.document;

    await translate(p, "重新翻译测试");
    check("首次翻译结果正确",
      d.getElementById("outputText").textContent.includes("第一次生成的结果"),
      d.getElementById("outputText").textContent.slice(0, 30));

    const before = p.requests.length;
    d.getElementById("retryBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(150);

    check("重新翻译确实又发了一次请求",
      p.requests.length === before + 1, "增加了 " + (p.requests.length - before) + " 次");
    check("重新翻译后结果被更新",
      d.getElementById("outputText").textContent.includes("重新翻译后的新结果"),
      d.getElementById("outputText").textContent.slice(0, 30));
    check("两次请求的 prompt 相同（同样的原文与设置）",
      p.requests[before].userPrompt === p.requests[before - 1].userPrompt);
  }

  /* ============ 6. 字符计数：准确吗？会标红吗？ ============ */
  {
    const p = await openPage();
    const d = p.document;
    const input = d.getElementById("inputText");

    input.value = "一二三四五";
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    check("字符计数准确（5 个字）",
      d.getElementById("charCounter").textContent === "5 / 2000",
      d.getElementById("charCounter").textContent);

    input.value = "a".repeat(2000);
    input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    check("达到上限时计数显示 2000 / 2000",
      d.getElementById("charCounter").textContent === "2000 / 2000",
      d.getElementById("charCounter").textContent);
    check("达到上限时高亮提示",
      d.getElementById("charCounter").classList.contains("is-over"),
      d.getElementById("charCounter").className);

    // maxlength 属性是否真的设了（防止用户粘贴超长）
    check("textarea 设置了 maxlength=2000",
      input.getAttribute("maxlength") === "2000", input.getAttribute("maxlength"));
  }

  /* ============ 7. 清空按钮：只清输入，不动结果？ ============ */
  {
    const p = await openPage({ replies: [{ text: "清空测试结果。" }] });
    const d = p.document;
    await translate(p, "要被清空的原文");

    d.getElementById("clearBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await sleep(30);

    check("清空后输入框为空", d.getElementById("inputText").value === "");
    check("清空后计数归零",
      d.getElementById("charCounter").textContent === "0 / 2000",
      d.getElementById("charCounter").textContent);
    check("清空后结果仍在（不会误删输出）",
      d.getElementById("outputText").textContent.includes("清空测试结果"),
      d.getElementById("outputText").textContent.slice(0, 20));
  }

  /* ============ 8. 翻译程度滑块：UI 文案是否与实际档位一致 ============ */
  {
    const p = await openPage();
    const d = p.document;

    const names = [];
    for (const lv of [1, 2, 3, 4]) {
      d.getElementById("levelRange").value = String(lv);
      d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
      names.push({
        lv,
        label: d.getElementById("levelLabel").textContent,
        desc: d.getElementById("levelDesc").textContent,
        aria: d.getElementById("levelRange").getAttribute("aria-valuetext"),
      });
    }

    check("四档文案互不相同", new Set(names.map((n) => n.label)).size === 4,
      names.map((n) => n.label).join(" | "));
    check("每档都有描述文字", names.every((n) => n.desc && n.desc.length > 5),
      names.map((n) => n.desc.length).join(","));
    check("aria-valuetext 与显示一致",
      names.every((n) => n.aria && n.label.indexOf(n.aria.split(" · ")[0]) === 0),
      names.map((n) => n.aria).join(" | "));

    // 档位文案应来自 prompt.js（单一来源），而不是写死在 HTML 里
    const PROMPTS = require(path.join(dir, "prompt.js"));
    check("档位名称与 prompt.js 一致",
      names.every((n) => n.label.includes(PROMPTS.LEVELS[n.lv].name)),
      names.map((n) => n.lv + ":" + n.label).join(" | "));
  }

  /* ---------- 输出 ---------- */
  console.log("\n======= 功能宣称 vs 实际行为审计 =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
