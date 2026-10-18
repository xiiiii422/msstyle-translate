require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 按"浏览器真实加载方式"测试整个站点
 *
 * 此前所有前端测试都是手工 eval 脚本，这掩盖了一类问题：
 *   · <script src> 顺序/路径错误
 *   · prompt.js 未加载导致 script.js 静默降级
 *   · 页面自身的 meta / 结构化元素与脚本不一致
 *   · 隐私页 / 条款页的引用错误
 *
 * 这个套件用 jsdom 的 resources:"usable" + runScripts:"dangerously"，
 * 让 jsdom 像浏览器一样**自己**去加载 <script src>，并且捕获所有
 * console 错误与未处理异常 —— 任何一条都算失败。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole, requestInterceptor } = require("jsdom");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/* jsdom 30 用 requestInterceptor 拦截资源请求；默认只走 http，
   这里把站点根路径映射到项目目录，脚本才能像浏览器一样被真正加载。
   注意：回调必须返回 Response。 */
const SITE_ORIGIN = "http://localhost/";

const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const localResources = {
  interceptors: [
    requestInterceptor((request) => {
      const url = request.url;

      // 非本站请求（外部 API 等）返回空响应，避免测试联网
      if (!url.startsWith(SITE_ORIGIN)) {
        return new Response("", { status: 200 });
      }

      const rel = decodeURIComponent(url.slice(SITE_ORIGIN.length).split("?")[0].split("#")[0]);
      const filePath = path.join(__dirname, rel || "index.html");

      // 防止路径穿越
      if (!filePath.startsWith(__dirname)) {
        return new Response("forbidden", { status: 403 });
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return new Response(fs.readFileSync(filePath), {
          status: 200,
          headers: { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" },
        });
      }

      // config.js 可能不存在，返回 404 让页面的 onerror 走降级
      return new Response("not found", { status: 404 });
    }),
  ],
};

/** 用真实加载方式打开一个页面 */
async function openPage(file, opts) {
  opts = opts || {};
  const errors = [];
  const warnings = [];
  const logs = [];

  const vc = new VirtualConsole();
  vc.on("error", (...a) => errors.push(a.map(String).join(" ")));
  vc.on("warn", (...a) => warnings.push(a.map(String).join(" ")));
  vc.on("log", (...a) => logs.push(a.map(String).join(" ")));
  vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
  const dom = new JSDOM(fs.readFileSync(file, "utf8"), {
    runScripts: "dangerously",
    resources: localResources,
    // 用 http:// 而不是 file://：file:// 属于 opaque origin，
    // jsdom 会禁用 localStorage，测试里预置数据会抛 SecurityError。
    // 真实部署也是 https，所以这里更贴近线上。
    url: "http://localhost/" + file,
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // 页面会调用这些浏览器 API，jsdom 里补上
      window.scrollTo = () => {};
      window.confirm = () => true;
      // 用受控的假 fetch 顶掉真实网络
      window.fetch = async (url, o) => {
        const u = String(url);
        if (u.endsWith("/health")) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (u.includes("bigmodel.cn")) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: "我今天是特别高兴的，因为假期已经到达。" } }] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: "代理结果：我今天是特别高兴的。" }) };
      };
      if (opts.beforeParse) opts.beforeParse(window);
    },
  });

  await new Promise((r) => {
    if (dom.window.document.readyState === "complete") return setTimeout(r, 0);
    dom.window.addEventListener("load", () => setTimeout(r, 0));
  });
  // 给 defer 脚本一点时间
  await new Promise((r) => setTimeout(r, 150));

  return { dom, window: dom.window, document: dom.window.document, errors, warnings, logs };
}

(async () => {

  /* ============ 1. index.html 以真实方式加载 ============ */
  {
    const p = await openPage("index.html");
    const w = p.window, d = p.document;

    check("index.html 加载无 JS 错误", p.errors.length === 0,
      p.errors.slice(0, 3).join(" | "));

    // 三个脚本都应被 jsdom 真正加载执行
    check("prompt.js 已加载（window.MSSTYLE_PROMPT 存在）",
      !!(w.MSSTYLE_PROMPT && w.MSSTYLE_PROMPT.buildUserPrompt));

    // 前端初始化成功的标志：script.js 必须真的调用了 syncLevel。
    // 注意：不能只断言"文案里有 ·" —— index.html 里本来就写着
    // "3 · 重度微软式"，那样即使 syncLevel 没跑也会通过（断言太弱）。
    // 这里改为：改掉滑块值 → 触发 input → 看文案是否跟着变，
    // 只有真正执行的代码才能做到这一点。
    const label0 = d.getElementById("levelLabel").textContent;
    d.getElementById("levelRange").value = "1";
    d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    const label1 = d.getElementById("levelLabel").textContent;
    check("script.js 已初始化（改滑块会更新档位文案）",
      label1 !== label0 && label1.includes("轻微机器味"),
      `${JSON.stringify(label0)} → ${JSON.stringify(label1)}`);
    check("档位描述也同步更新",
      d.getElementById("levelDesc").textContent.includes("轻微机器味"),
      d.getElementById("levelDesc").textContent.slice(0, 30));
    // 复位，避免影响后续断言
    d.getElementById("levelRange").value = "3";
    d.getElementById("levelRange").dispatchEvent(new p.window.Event("input", { bubbles: true }));

    // 未配 Key → 应弹出引导
    check("未配 Key 时弹出首次引导",
      d.getElementById("onboarding").hidden === false);

    // 设置按钮应有 needs-key 红点
    check("设置按钮显示 needs-key 提示",
      d.getElementById("settingsBtn").classList.contains("needs-key"));

    // 不应出现"prompt.js 没有加载成功"的错误
    const promptErr = p.errors.concat(p.warnings).some((e) => e.includes("prompt.js 没有加载成功"));
    check("没有 prompt.js 加载失败告警", !promptErr,
      p.errors.concat(p.warnings).filter((e) => e.includes("prompt.js")).join(" | "));
  }

  /* ============ 2. 页面自检：ID 唯一性与引用完整性 ============ */
  {
    const p = await openPage("index.html");
    const d = p.document;

    // 重复 ID 会导致 getElementById 拿到错误的元素
    const ids = [...d.querySelectorAll("[id]")].map((n) => n.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    check("页面没有重复 ID", dupes.length === 0, [...new Set(dupes)].join(", "));

    // aria-labelledby / aria-describedby 指向的元素必须存在
    const ariaRefs = [];
    d.querySelectorAll("[aria-labelledby]").forEach((n) =>
      n.getAttribute("aria-labelledby").split(/\s+/).forEach((r) => ariaRefs.push(r)));
    d.querySelectorAll("[aria-describedby]").forEach((n) =>
      n.getAttribute("aria-describedby").split(/\s+/).forEach((r) => ariaRefs.push(r)));
    const danglingAria = [...new Set(ariaRefs)].filter((r) => !d.getElementById(r));
    check("aria-labelledby/describedby 无悬空引用", danglingAria.length === 0,
      danglingAria.join(", "));

    // label 的 for 必须指向存在的控件
    const labels = [...d.querySelectorAll("label[for]")];
    const danglingLabels = labels.filter((l) => !d.getElementById(l.getAttribute("for")));
    check("label[for] 无悬空引用", danglingLabels.length === 0,
      danglingLabels.map((l) => l.getAttribute("for")).join(", "));

    // 按钮都应有可读文本
    const emptyBtns = [...d.querySelectorAll("button")].filter(
      (b) => !b.textContent.trim() && !b.getAttribute("aria-label"));
    check("所有 button 都有文本或 aria-label", emptyBtns.length === 0,
      emptyBtns.map((b) => b.id || b.className).join(", "));
  }

  /* ============ 3. 前端完整翻译流程（真实脚本加载） ============ */
  {
    const p = await openPage("index.html", {
      beforeParse(window) {
        // 预置一个 Key，跳过引导
        window.localStorage.setItem("msstyle_translate_apikey_v1", "page.test.key");
      },
    });
    const d = p.document;

    check("配好 Key 后不弹引导", d.getElementById("onboarding").hidden === true);
    check("配好 Key 后无 needs-key 红点",
      !d.getElementById("settingsBtn").classList.contains("needs-key"));

    d.getElementById("inputText").value = "我今天特别开心，因为终于放假了。";
    d.getElementById("inputText").dispatchEvent(new p.window.Event("input", { bubbles: true }));
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    check("真实页面能完成翻译",
      d.getElementById("outputText").textContent.includes("我今天是特别高兴的"),
      d.getElementById("outputText").textContent.slice(0, 60));
    check("翻译后状态显示完成",
      d.getElementById("statusText").textContent.includes("翻译完成"),
      d.getElementById("statusText").textContent);
    check("翻译后写入历史记录",
      d.querySelectorAll(".history-item").length === 1,
      d.querySelectorAll(".history-item").length);
    check("历史计数已更新",
      d.getElementById("historyTitle").textContent.includes("1"),
      d.getElementById("historyTitle").textContent);
    check("翻译流程无 JS 错误", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  }

  /* ============ 4. 复制按钮（真实脚本） ============ */
  {
    const p = await openPage("index.html", {
      beforeParse(window) {
        window.localStorage.setItem("msstyle_translate_apikey_v1", "k");
        // jsdom 不实现 execCommand，补一个以便走降级路径
        window.document.execCommand = () => true;
      },
    });
    const d = p.document;
    d.getElementById("inputText").value = "测试复制";
    d.getElementById("translateBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    d.getElementById("copyBtn").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    check("复制按钮可用并给出反馈",
      ["已复制", "复制没有成功"].some((t) => d.getElementById("toast").textContent.includes(t)),
      d.getElementById("toast").textContent);
  }

  /* ============ 5. config.js 覆盖路径 ============ */
  {
    const p = await openPage("index.html", {
      beforeParse(window) {
        // config.js 是真实加载的（内容留空），这里模拟部署者填了值
        window.__MSSTYLE_CONFIG__ = { proxyUrl: "/api" };
      },
    });
    const d = p.document;
    await new Promise((r) => setTimeout(r, 100));

    check("代理模式下不弹引导", d.getElementById("onboarding").hidden === true);
    check("代理模式下隐藏 Key 输入项",
      d.getElementById("apiKeyInput").closest(".field").hidden === true,
      "hidden=" + d.getElementById("apiKeyInput").closest(".field").hidden);
    check("代理模式下状态文案说明无需填 Key",
      d.getElementById("keyStatus").textContent.includes("无需填写"),
      d.getElementById("keyStatus").textContent);
  }

  /* ============ 6. privacy.html / terms.html ============ */
  for (const page of ["privacy.html", "terms.html"]) {
    const p = await openPage(page);
    const d = p.document;
    check(page + " 加载无 JS 错误", p.errors.length === 0, p.errors.slice(0, 2).join(" | "));
    check(page + " 有标题", d.title.includes("微软式翻译"), d.title);
    check(page + " 有正文内容", d.querySelector(".doc") &&
      d.querySelector(".doc").textContent.length > 200,
      d.querySelector(".doc") ? d.querySelector(".doc").textContent.length : "无 .doc");
    check(page + " 返回首页链接可用",
      !!d.querySelector('a[href="index.html"]'));
    check(page + " 引用了样式表",
      !!d.querySelector('link[href="style.css"]'));
  }

  /* ============ 7. 无 JS 时的降级（渐进增强） ============ */
  {
    const dom = new JSDOM(fs.readFileSync("index.html", "utf8"), { runScripts: "outside-only" });
    const d = dom.window.document;
    check("禁用 JS 时核心文案仍可见",
      d.body.textContent.includes("微软式翻译") &&
      d.body.textContent.includes("把正常的话"));
    check("禁用 JS 时输入框仍可用", !!d.getElementById("inputText"));
    check("禁用 JS 时引导层是隐藏的（不遮挡内容）",
      d.getElementById("onboarding").hidden === true);
  }

  /* ---------- 输出 ---------- */
  console.log("\n======== 真实页面加载测试 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
