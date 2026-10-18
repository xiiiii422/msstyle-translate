require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 用真实加载 + CSP 校验，检查 _headers 里的策略是否会拦掉页面自身需要的东西。
   CSP 写错的后果是"部署后白屏"或"翻译请求被静默拦截"，而且很难排查。
   这里做两件事：
     1. 把 CSP 解析成指令表，逐项检查页面实际用到的资源类型是否被允许
     2. 检查 index.html 里有没有内联脚本/样式（会被 script-src 'self' 拦掉） */
const fs = require("fs");
const path = require("path");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/* ---------- 解析 _headers ---------- */
const headersSrc = fs.readFileSync("_headers", "utf8");
const cspLine = headersSrc.split(/\r?\n/).find((l) => /^\s*Content-Security-Policy:/.test(l)) || "";
const csp = cspLine.replace(/^\s*Content-Security-Policy:\s*/, "").trim();

const directives = {};
csp.split(";").forEach((part) => {
  const t = part.trim();
  if (!t) return;
  const [k, ...vals] = t.split(/\s+/);
  directives[k] = vals;
});

const html = fs.readFileSync("index.html", "utf8");

/* ---------- 1. 页面用到的资源类型是否被放行 ---------- */

// script-src：本地脚本
check("CSP 有 default-src", !!directives["default-src"], csp);
check("script-src 放行 'self'",
  (directives["script-src"] || []).includes("'self'"),
  (directives["script-src"] || []).join(" "));

// style-src：外部样式表 + 代码里的内联 style 赋值
check("style-src 放行 'self'（style.css）",
  (directives["style-src"] || []).includes("'self'"),
  (directives["style-src"] || []).join(" "));

// 代码里是否真的有内联 style 赋值（需要 'unsafe-inline'）
const scriptSrc = fs.readFileSync("script.js", "utf8");
const usesInlineStyle = /\.style\.[a-zA-Z]+\s*=/.test(scriptSrc);
check("检测到代码使用内联 style 赋值", usesInlineStyle);
check("style-src 含 'unsafe-inline'（否则内联 style 会被拦）",
  !usesInlineStyle || (directives["style-src"] || []).includes("'unsafe-inline'"),
  usesInlineStyle ? (directives["style-src"] || []).join(" ") : "（代码未用内联 style）");

// img-src：data: 图标
check("img-src 放行 data:（内联图标）",
  (directives["img-src"] || []).includes("data:"),
  (directives["img-src"] || []).join(" "));

// connect-src：翻译接口
const apiUrl = scriptSrc.match(/API_URL:\s*"([^"]+)"/)[1];
const apiOrigin = new URL(apiUrl).origin;
check("connect-src 放行 API 域名 " + apiOrigin,
  (directives["connect-src"] || []).includes(apiOrigin),
  (directives["connect-src"] || []).join(" "));
check("connect-src 放行 'self'（同源代理 /api 需要）",
  (directives["connect-src"] || []).includes("'self'"),
  (directives["connect-src"] || []).join(" "));

/* ---------- 2. index.html 里有没有会被脚本策略拦掉的东西 ---------- */
{
  // 内联 <script>（无 src）会被 script-src 'self' 拦掉
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[1].trim().length > 0);
  check("没有会被 CSP 拦掉的内联 <script>", inlineScripts.length === 0,
    inlineScripts.map((m) => m[1].trim().slice(0, 50)).join(" | "));

  // 内联事件处理器（onclick="..."）同样被 script-src 拦
  const inlineHandlers = [...html.matchAll(/\son(click|load|error|change|input)\s*=\s*"/gi)];
  // onerror 在 <script> 上是允许的（不是内联脚本，是脚本元素属性）
  const scriptTagHandlers = [...html.matchAll(/<script[^>]*\son(error)\s*=\s*"/gi)];
  const realHandlers = inlineHandlers.length - scriptTagHandlers.length;
  check("没有会被 CSP 拦掉的内联事件处理器", realHandlers <= 0,
    realHandlers > 0 ? `${realHandlers} 处` : "");

  // data: URI 的 favicon 是否被 img-src 覆盖
  const hasDataIcon = /<link[^>]+rel="(icon|apple-touch-icon)"[^>]+href="data:/i.test(html);
  check("图标使用 data: URI 时 img-src 已放行", !hasDataIcon || (directives["img-src"] || []).includes("data:"));

  // 外链的**子资源**（脚本/样式/图片/字体）会被 CSP 拦；
  // canonical / og:url 这类 <link rel="canonical"> 与 <meta> 不是子资源，不受 CSP 约束。
  const subresourceRefs = [
    ...html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/gi),
    ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https?:\/\/[^"]+)"/gi),
    ...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]+href="(https?:\/\/[^"]+)"/gi),
    ...html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/gi),
  ].map((m) => m[1]);
  check("没有引用会被 CSP 拦掉的第三方子资源（脚本/样式/图标/图片）",
    subresourceRefs.length === 0, subresourceRefs.join(", "));
}

/* ---------- 3. _headers 其他安全头 ---------- */
{
  const get = (name) => {
    const l = headersSrc.split(/\r?\n/).find((x) => new RegExp("^\\s*" + name + ":", "i").test(x));
    return l ? l.split(":").slice(1).join(":").trim() : "";
  };
  check("有 X-Content-Type-Options: nosniff",
    /nosniff/i.test(get("X-Content-Type-Options")), get("X-Content-Type-Options"));
  check("有 Referrer-Policy", !!get("Referrer-Policy"), get("Referrer-Policy"));
  check("有 X-Frame-Options", !!get("X-Frame-Options"), get("X-Frame-Options"));
  check("有 Permissions-Policy", !!get("Permissions-Policy"), get("Permissions-Policy"));
  check("frame-ancestors 设为 none",
    (directives["frame-ancestors"] || []).includes("'none'"),
    (directives["frame-ancestors"] || []).join(" "));
  check("object-src 设为 none",
    (directives["object-src"] || []).includes("'none'"),
    (directives["object-src"] || []).join(" "));
}

/* ---------- 4. manifest 的图标真实存在 ---------- */
{
  const mf = JSON.parse(fs.readFileSync("manifest.webmanifest", "utf8"));
  const missing = (mf.icons || []).filter((i) => !fs.existsSync(i.src));
  check("manifest 里的图标都存在", missing.length === 0,
    missing.map((i) => i.src).join(", "));
  check("manifest 有 start_url", !!mf.start_url, mf.start_url);
  check("manifest 有 theme_color", !!mf.theme_color, mf.theme_color);
  check("manifest 的 start_url 指向存在的文件",
    !mf.start_url || fs.existsSync(mf.start_url.replace(/^\.\//, "")),
    mf.start_url);
}

/* ---------- 5. README 里关于 CSP 的描述是否与实际一致 ---------- */
{
  const readme = fs.readFileSync("README.md", "utf8");
  const claimsOnlyBigmodel =
    /connect-src`?\s*只放行了\s*`?https:\/\/open\.bigmodel\.cn/.test(readme) ||
    /只放行了\s*`?https:\/\/open\.bigmodel\.cn/.test(readme);
  check("README 没有把 connect-src 描述成「只放行 bigmodel.cn」（漏掉 'self' 会误导）",
    !claimsOnlyBigmodel,
    claimsOnlyBigmodel ? "README 的说法与实际策略不符" : "");
}

/* ---------- 输出 ---------- */
console.log("\n======== CSP / 元数据一致性检查 ========");
let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) { pass++; console.log("  PASS  " + r.name); }
  else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
}
console.log("========================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
