/* 验证：缺少 prompt.js 时，页面是否给出**可见**提示（而不是静默无反应） */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole, requestInterceptor } = require("jsdom");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const MIME = { ".js": "application/javascript", ".css": "text/css" };

function load(missing) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.message));

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/index.html",
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: {
      interceptors: [requestInterceptor((req) => {
        const rel = decodeURIComponent(req.url.replace("http://localhost/", "").split("?")[0]);
        if (missing.includes(rel)) return new Response("nf", { status: 404 });
        const full = path.join(dir, rel);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return new Response(fs.readFileSync(full), { status: 200,
            headers: { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" } });
        }
        return new Response("nf", { status: 404 });
      })],
    },
    beforeParse(w) {
      w.scrollTo = () => {}; w.confirm = () => true;
      // 预置 Key：排除"没配 Key"这条更早的分支，专门测缺文件
      try { w.localStorage.setItem("msstyle_translate_apikey_v1", "k"); } catch (e) {}
      w.fetch = () => Promise.resolve({ ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "结果" } }] }) });
    },
  });
  return { dom, errors };
}

(async () => {
  const results = [];
  const check = (n, c, e) => results.push({ n, c: !!c, e: e || "" });

  /* ---------- 场景 A：缺少 prompt.js ---------- */
  {
    const { dom, errors } = load(["prompt.js"]);
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;

    const banner = d.getElementById("promptsMissingNotice");
    check("缺 prompt.js 时显示持久横幅提示", !!banner,
      banner ? "" : "没有任何横幅");
    check("横幅文案说明了缺什么", banner && banner.textContent.includes("prompt.js"),
      banner ? banner.textContent.slice(0, 50) : "");
    check("横幅文案说明了怎么办",
      banner && /上传|引入|index\.html/.test(banner.textContent),
      banner ? banner.textContent.slice(0, 80) : "");
    check("横幅使用 role=alert（屏幕阅读器会播报）",
      banner && banner.getAttribute("role") === "alert");
    check("控制台有明确错误", errors.some((e) => e.includes("prompt.js")),
      errors.join(" | ").slice(0, 80));

    // 点翻译必须给出提示，不能静默
    d.getElementById("inputText").value = "测试";
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    const toast = d.getElementById("toast").textContent;
    check("点翻译会提示缺文件（不再静默无反应）",
      toast.includes("prompt.js") || toast.includes("部署不完整"), toast);
    check("缺文件时不会误弹「填 Key」引导",
      d.getElementById("onboarding").hidden === true,
      "onboarding hidden=" + d.getElementById("onboarding").hidden);
  }

  /* ---------- 场景 B：文件齐全（不应误报） ---------- */
  {
    const { dom } = load([]);
    await new Promise((r) => setTimeout(r, 600));
    const d = dom.window.document;

    check("文件齐全时**不**显示缺文件横幅",
      d.getElementById("promptsMissingNotice") === null,
      "出现了误报横幅");
    check("文件齐全时正常初始化",
      d.getElementById("levelLabel").textContent.includes("·"),
      d.getElementById("levelLabel").textContent);
  }

  /* ---------- 输出 ---------- */
  console.log("\n======= prompt.js 缺失时的降级行为 =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.c) { pass++; console.log("  PASS  " + r.n); }
    else { fail++; console.log("  FAIL  " + r.n + (r.e ? "  <- " + r.e : "")); }
  }
  console.log("==========================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
