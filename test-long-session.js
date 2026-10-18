/* 长会话 / 内存审计
 *
 * 前面几轮都在测"单次操作正确吗"，从没测过"连续用半小时会怎样"。
 * 网页挂着不动、反复翻译几百次，是真实用户会做的事。
 *
 * 重点查：
 *   · 事件监听器是否随操作次数增长（泄漏）
 *   · 历史记录列表是否会无限增长（DOM 节点）
 *   · 定时器是否被正确清理
 *   · 状态对象是否累积
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

/** 造页面，并统计"被创建的监听器数量" */
async function openPage(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;

  // 统计 addEventListener 调用（含元素与 window）
  const listenerStats = { added: 0, removed: 0, liveByTarget: new WeakMap() };
  const realAdd = w.EventTarget.prototype.addEventListener;
  const realRemove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, o) {
    listenerStats.added++;
    let n = listenerStats.liveByTarget.get(this) || 0;
    listenerStats.liveByTarget.set(this, n + 1);
    return realAdd.call(this, type, fn, o);
  };
  w.EventTarget.prototype.removeEventListener = function (type, fn, o) {
    listenerStats.removed++;
    let n = listenerStats.liveByTarget.get(this) || 0;
    listenerStats.liveByTarget.set(this, Math.max(0, n - 1));
    return realRemove.call(this, type, fn, o);
  };

  // 统计活跃定时器
  const timers = { pending: new Set(), created: 0, cleared: 0 };
  const realSetTimeout = w.setTimeout;
  const realClearTimeout = w.clearTimeout;
  w.setTimeout = function (fn, ms) {
    timers.created++;
    const id = realSetTimeout.call(w, function () { timers.pending.delete(id); fn.apply(this, arguments); }, ms);
    timers.pending.add(id);
    return id;
  };
  w.clearTimeout = function (id) {
    if (timers.pending.has(id)) { timers.pending.delete(id); timers.cleared++; }
    return realClearTimeout.call(w, id);
  };

  w.scrollTo = () => {}; w.confirm = () => true;
  w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  w.__MSSTYLE_CONFIG__ = opts.config || { apiKey: "mem.audit.key" };
  let replyIdx = 0;
  w.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "结果 " + (++replyIdx) } }] }),
  });

  w.eval(promptSrc); w.eval(configSrc); w.eval(scriptSrc);

  await new Promise((r) => {
    if (d.readyState !== "loading") return setTimeout(r, 0);
    d.addEventListener("DOMContentLoaded", () => setTimeout(r, 0), { once: true });
  });

  return { dom, window: w, document: d, listenerStats, timers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translate(p, text) {
  const d = p.document;
  d.getElementById("inputText").value = text;
  d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
  d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
}

(async () => {

  /* ============ 1. 反复翻译 60 次：DOM 与监听器应有界 ============
     注意：不能简单断言"监听器总数不增长"。
     renderHistory 每次都重建历史列表（先 innerHTML = ""），
     于是每轮都会创建新节点和新监听器，旧节点脱离 DOM 后被 GC 回收。
     这是**可回收的 churn**，不是泄漏。
     真正该断言的是：
       (a) 当前 DOM 里的监听器总数有界
       (b) 旧节点确实脱离了 DOM（可被回收）
       (c) 没有被移除却仍被引用的节点 */
  {
    const p = await openPage();
    await sleep(30);

    // 记录第一次渲染出的历史节点
    await translate(p, "第一次");
    const firstItem = p.document.querySelector(".history-item");

    for (let i = 0; i < 60; i++) {
      await translate(p, "第 " + i + " 条测试文本");
    }

    // (a) 当前 DOM 中的节点数量有界
    const items = p.document.querySelectorAll(".history-item").length;
    check("反复翻译 60 次后历史 DOM 稳定在 10 条", items === 10, "count=" + items);

    // (b) 旧节点已脱离 DOM（可被 GC 回收，不是泄漏）
    check("被替换掉的历史节点已脱离 DOM（可回收，非泄漏）",
      firstItem && firstItem.isConnected === false,
      firstItem ? "isConnected=" + firstItem.isConnected : "找不到首个节点");

    // (c) 当前每个节点的监听器数量固定（没有重复挂载）
    let maxPerItem = 0;
    for (const item of p.document.querySelectorAll(".history-item")) {
      const n = p.listenerStats.liveByTarget.get(item) || 0;
      if (n > maxPerItem) maxPerItem = n;
    }
    check("当前每个历史项只挂 2 个监听器（无重复挂载）",
      maxPerItem <= 2, "最多 " + maxPerItem);

    // (d) 真正该看的指标：**仍挂在 DOM 上的节点**所持有的监听器数量。
    //     不能统计 added - removed —— 被替换掉的节点不会有人显式调用
    //     removeEventListener（GC 会连同节点回收），那样算出来的是
    //     可回收的 churn，不是存活监听器。
    let liveOnDom = 0;
    const walk = (node) => {
      if (node.nodeType === 1) {
        liveOnDom += p.listenerStats.liveByTarget.get(node) || 0;
        for (const child of node.children) walk(child);
      }
    };
    walk(p.document.documentElement);
    // window / document 上的监听器
    liveOnDom += p.listenerStats.liveByTarget.get(p.window) || 0;
    liveOnDom += p.listenerStats.liveByTarget.get(p.document) || 0;

    check("仍挂在 DOM 上的监听器总数有界（< 60）",
      liveOnDom < 60, "liveOnDom=" + liveOnDom);
  }

  /* ============ 2. 反复渲染历史不会累积节点 ============ */
  {
    const p = await openPage();
    await sleep(30);

    // 翻 30 次，每次都会 renderHistory
    for (let i = 0; i < 30; i++) {
      await translate(p, "渲染压力 " + i);
    }

    const list = p.document.getElementById("historyList");
    const children = list.children.length;
    check("历史列表子节点数不超过 10（渲染会清理旧的）",
      children <= 10, "子节点=" + children);

    // 每个历史项应恰好挂 2 个监听器（click + keydown）
    // 如果重复 renderHistory 而不清理，旧节点会被丢弃（GC 回收），
    // 真正的风险是"往同一个节点重复挂监听器"
    let maxPerItem = 0;
    for (const item of list.children) {
      const n = p.listenerStats.liveByTarget.get(item) || 0;
      if (n > maxPerItem) maxPerItem = n;
    }
    check("每个历史项只挂 2 个监听器（click + keydown）",
      maxPerItem <= 2, "最多 " + maxPerItem + " 个");
  }

  /* ============ 3. 定时器是否被清理（toast 计时器） ============ */
  {
    const p = await openPage();
    await sleep(30);

    // 触发多次 toast（清空、随机示例等都会触发）
    for (let i = 0; i < 20; i++) {
      p.document.getElementById("clearBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    }
    // toast 有 1.8 秒的自动隐藏定时器；这里不该堆积
    const pending = p.timers.pending.size;
    check("多次操作后未清理的定时器数量可控",
      pending <= 3, "pending=" + pending);
  }

  /* ============ 4. 慢请求的渐进提示定时器必须被清理 ============ */
  {
    const p = await openPage();
    await sleep(30);

    const before = p.timers.pending.size;
    await translate(p, "触发慢提示定时器");
    await sleep(60);
    const after = p.timers.pending.size;

    // 注意：600ms 的首次成功提示等 UI 定时器可能在此刻仍未到期，
    // 少量 pending 属正常瞬态，不算泄漏；泄漏的定义是「持续增长」。
    check("翻译结束后未清理的定时器为瞬态（<= 2 个）",
      after <= 2, `${before} → ${after}`);
  }

  /* ============ 5. 反复开关设置面板不出错 ============ */
  {
    const p = await openPage();
    await sleep(30);
    const d = p.document;
    let errors = 0;

    for (let i = 0; i < 30; i++) {
      try {
        d.getElementById("settingsBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
        await sleep(2);
        d.getElementById("settingsCloseBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
        await sleep(2);
      } catch (e) { errors++; }
    }

    check("反复开关设置面板 30 次不报错", errors === 0, "错误 " + errors + " 次");
    check("开关 30 次后面板处于关闭状态",
      d.getElementById("settingsPanel").hidden === true,
      "hidden=" + d.getElementById("settingsPanel").hidden);
  }

  /* ============ 6. localStorage 不会无限增长 ============ */
  {
    const p = await openPage();
    await sleep(30);

    for (let i = 0; i < 50; i++) {
      await translate(p, "存储压力测试文本 " + i);
    }

    const raw = p.window.localStorage.getItem("msstyle_translate_history_v1");
    const parsed = JSON.parse(raw);
    check("localStorage 历史仍为 10 条", parsed.length === 10, "len=" + parsed.length);

    const sizeKB = Buffer.byteLength(raw, "utf8") / 1024;
    check("localStorage 占用在合理范围（< 20KB）",
      sizeKB < 20, sizeKB.toFixed(1) + " KB");
  }

  /* ============ 7. 反复切换档位/模式不累积状态 ============ */
  {
    const p = await openPage();
    await sleep(30);
    const d = p.document;

    const modes = ["auto", "zh", "en"];
    for (let i = 0; i < 50; i++) {
      d.getElementById("levelRange").value = String((i % 4) + 1);
      d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
      d.querySelector('input[name="mode"][value="' + modes[i % 3] + '"]').checked = true;
    }

    // 显式设定最终值，避免依赖循环奇偶（上一版断言就是因为算错 (49%4)+1 而误报）
    const FINAL = 4;
    d.getElementById("levelRange").value = String(FINAL);
    d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    await sleep(30);

    check("反复切换后档位状态正确",
      d.getElementById("levelRange").value === String(FINAL),
      d.getElementById("levelRange").value);
    check("反复切换后档位文案与值一致",
      d.getElementById("levelLabel").textContent.startsWith(String(FINAL)),
      d.getElementById("levelLabel").textContent);
    check("反复切换后档位描述已同步更新",
      d.getElementById("levelDesc").textContent.length > 5,
      d.getElementById("levelDesc").textContent.slice(0, 20));
  }

  /* ============ 8. 输入内容不会残留在 DOM 属性里 ============ */
  {
    const p = await openPage();
    await sleep(30);
    await translate(p, "敏感内容不该留在属性里");

    const d = p.document;
    // Key 输入框的值必须是空的（之前处理过：关闭面板时清空）
    check("API Key 输入框不保留上次输入",
      d.getElementById("apiKeyInput").value === "",
      JSON.stringify(d.getElementById("apiKeyInput").value));
    check("API Key 输入框类型是 password（不明文显示）",
      d.getElementById("apiKeyInput").type === "password",
      d.getElementById("apiKeyInput").type);
  }

  /* ---------- 输出 ---------- */
  console.log("\n======== 长会话 / 内存审计 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("===================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
