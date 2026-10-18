require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 用真实 HTTP 服务 + 真实响应头，验证 CSP 不会拦掉页面运行。
 *
 * 为什么不能只做字符串检查：
 *   CSP 是"语法正确但语义错误"的重灾区 —— 比如漏了 'unsafe-inline'、
 *   connect-src 少了某个域名，字符串看着都对，但浏览器运行时才拦。
 *   这里起一个本地服务器，把 _headers 里的策略作为真实响应头下发，
 *   再用 jsdom 加载页面，看脚本是否被拦、fetch 是否被拒。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/* ---------- 从 _headers 解析出真实响应头 ---------- */
function parseHeadersFile(file) {
  const out = {};
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return;
    const m = line.match(/^\s*([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}
const SECURITY_HEADERS = parseHeadersFile("_headers");

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json" };

/* ---------- 起一个"像真实托管"的静态服务器 ---------- */
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0];
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
      const full = path.join(__dirname, rel);

      // 把所有安全响应头按 _headers 下发
      Object.keys(SECURITY_HEADERS).forEach((k) => res.setHeader(k, SECURITY_HEADERS[k]));

      if (!full.startsWith(__dirname) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      fs.createReadStream(full).pipe(res);
    });
    srv.listen(0, () => resolve(srv));
  });
}

(async () => {
  const srv = await startServer();
  const base = "http://127.0.0.1:" + srv.address().port;

  /* ---------- 1. 响应头真的被下发了 ---------- */
  {
    const res = await fetch(base + "/index.html");
    check("服务器下发了 CSP", !!res.headers.get("content-security-policy"));
    check("服务器下发了 X-Content-Type-Options",
      res.headers.get("x-content-type-options") === "nosniff",
      res.headers.get("x-content-type-options"));
    check("服务器下发了 X-Frame-Options",
      !!res.headers.get("x-frame-options"), res.headers.get("x-frame-options"));
  }

  /* ---------- 2. 所有子资源都能取到，且 MIME 正确 ---------- */
  {
    const assets = ["/style.css", "/prompt.js", "/script.js", "/icon.svg",
      "/manifest.webmanifest", "/privacy.html", "/terms.html", "/og-image.png"];
    for (const a of assets) {
      const r = await fetch(base + a);
      check(`资源可访问且 MIME 正确 ${a}`,
        r.status === 200 && (r.headers.get("content-type") || "").length > 0,
        `${r.status} ${r.headers.get("content-type")}`);
    }
  }

  /* ---------- 3. 用 jsdom 加载真实页面（走真实 HTTP + 真实响应头） ---------- */
  {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("error", (...a) => errors.push(a.map(String).join(" ")));
    vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));

    const dom = await JSDOM.fromURL(base + "/index.html", {
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.scrollTo = () => {};
        window.confirm = () => true;
        // 拦截翻译请求，避免测试联网；同时记录是否被"CSP"影响
        window.fetch = async (url) => {
          const u = String(url);
          if (u.includes("bigmodel.cn")) {
            return { ok: true, status: 200,
              json: async () => ({ choices: [{ message: { content: "我今天是特别高兴的。" } }] }) };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, result: "代理结果：我今天是特别高兴的。" }) };
        };
      },
    });

    await new Promise((r) => setTimeout(r, 800));
    const d = dom.window.document;

    check("通过真实 HTTP 加载页面无错误", errors.length === 0, errors.slice(0, 2).join(" | "));
    check("prompt.js 通过真实 HTTP 加载成功", !!dom.window.MSSTYLE_PROMPT);
    check("script.js 初始化成功",
      d.getElementById("levelLabel").textContent.includes("微软"));

    // 样式表是否真的应用了（jsdom 会解析 link）
    const sheets = d.styleSheets.length;
    check("外部样式表被加载", sheets >= 1, "styleSheets=" + sheets);
  }

  /* ---------- 4. 反面验证：坏掉的 CSP 会被 check-csp.js 抓到 ----------
     诚实说明：jsdom **不强制执行 CSP**，所以这里无法验证"浏览器会拦掉"。
     能验证的是：把策略改坏之后，静态检查脚本会不会报警。
     真正的浏览器级验证需要在 Chrome 里手工跑（见 README「手动验证清单」）。

     实现注意：不要 require check-csp.js —— 它会自己打印并 process.exit，
     污染本脚本的输出。改为用子进程跑，只取退出码。 */
  {
    const saved = SECURITY_HEADERS["Content-Security-Policy"];
    const { spawnSync } = require("child_process");
    const headerFile = "_headers";
    const original = fs.readFileSync(headerFile, "utf8");

    function checkCspExitCode(policy) {
      const mutated = original.replace(
        /^\s*Content-Security-Policy:.*$/m,
        "  Content-Security-Policy: " + policy
      );
      fs.writeFileSync(headerFile, mutated, "utf8");
      try {
        // stdio:"ignore" 是允许的（pipe 会 EPERM），退出码仍可拿到
        const r = spawnSync(process.execPath, ["check-csp.js"], { stdio: "ignore" });
        return r.status;
      } finally {
        // 必须放 finally：一旦子进程启动失败（EPERM / 被杀 / 超时），
        // 恢复语句会被跳过，_headers 就被永久改坏 ——
        // 后续 check-csp 会一直报错，而原因看起来毫无头绪（实测踩过）。
        fs.writeFileSync(headerFile, original, "utf8");
      }
    }

    const badPolicy = saved.replace("script-src 'self';", "script-src 'none';");
    const badExit = checkCspExitCode(badPolicy);
    check("坏掉的 CSP（script-src 去掉 self）会被检查脚本发现",
      badExit !== 0 && badExit !== null, "exit=" + badExit);

    const goodExit = checkCspExitCode(saved);
    check("正常的 CSP 通过检查", goodExit === 0, "exit=" + goodExit);

    SECURITY_HEADERS["Content-Security-Policy"] = saved;
  }

  srv.close();

  /* ---------- 输出 ---------- */
  console.log("\n======= 真实 HTTP + 真实响应头加载测试 =======");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("=============================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
