require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 最终完整性检查：所有被引用的本地资源是否真实存在（防 404） */
const fs = require("fs");
const path = require("path");

const htmlFiles = ["index.html", "privacy.html", "terms.html"];
const missing = [];
const checked = [];

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, "utf8");
  // 抓 href="..." 和 src="..."（排除外链、data:、锚点）
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    if (/^(https?:|data:|#|mailto:|\/\/)/.test(r)) continue;
    const target = r.split("?")[0].split("#")[0];
    if (!target) continue;
    checked.push({ from: f, ref: target });
    if (!fs.existsSync(target)) missing.push({ from: f, ref: target });
  }
}

console.log("=== 本地资源引用完整性 ===");
console.log(`共检查 ${checked.length} 条引用`);
const uniq = [...new Set(checked.map((c) => c.ref))];
for (const r of uniq) console.log(`  ${fs.existsSync(r) ? "✓" : "✗"} ${r}`);

// manifest 里的图标
const mf = JSON.parse(fs.readFileSync("manifest.webmanifest", "utf8"));
for (const icon of mf.icons || []) {
  if (!fs.existsSync(icon.src)) missing.push({ from: "manifest", ref: icon.src });
}

// _headers 里 CSP 放行的域名 vs 代码里的 API_URL
const script = fs.readFileSync("script.js", "utf8");
const apiUrl = script.match(/API_URL:\s*"([^"]+)"/)[1];
const headers = fs.readFileSync("_headers", "utf8");
// 只取真正生效的响应头行（以 Content-Security-Policy: 开头），
// 忽略上面 # 注释里出现的同名文字。
const cspLine = headers.split(/\r?\n/).find((l) => /^\s*Content-Security-Policy:/.test(l)) || "";
const cspConnect = (cspLine.match(/connect-src ([^;]+);?/) || [])[1] || "";
const apiHost = new URL(apiUrl).origin;

console.log("\n=== CSP 与 API 地址一致性（不一致会导致请求被浏览器拦掉）===");
console.log(`  API_URL  : ${apiUrl}`);
console.log(`  CSP 放行 : ${cspConnect.trim()}`);
const cspOk = cspConnect.includes(apiHost);
console.log(`  ${cspOk ? "✓ 直连模式可用：接口域名在 CSP 白名单内" : "✗ 不一致！直连请求会被拦"}`);

// 代理模式检查：同源代理靠 'self'；跨域代理必须显式加进 connect-src
// 代理模式检查：只看真正生效的配置行（CONFIG 里的 PROXY_URL: "..."），
// 不能匹配注释里的示例，否则会误报。
const proxyLine = script.split(/\r?\n/).find((l) => /^\s*PROXY_URL:/.test(l)) || "";
const proxyUrl = (proxyLine.match(/PROXY_URL:\s*"([^"]*)"/) || [])[1] || "";
console.log(`  代理配置 : ${proxyLine.trim() || "(未找到)"}`);
if (!proxyUrl) {
  console.log("  ✓ 代理模式：PROXY_URL 为空（纯静态直连模式）");
} else if (proxyUrl.startsWith("/")) {
  const selfOk = cspConnect.includes("'self'");
  console.log(`  ${selfOk ? "✓" : "✗"} 代理模式：PROXY_URL="${proxyUrl}" 是同源，依赖 'self' ${
    selfOk ? "（CSP 已包含）" : "（CSP 缺少 'self'！）"}`);
} else {
  const ph = proxyUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const proxyOk = cspConnect.includes(ph);
  console.log(`  ${proxyOk ? "✓" : "✗"} 代理模式：PROXY_URL 是跨域（${ph}）${
    proxyOk ? "，已在 connect-src 中" : "，但 connect-src 未放行！浏览器会拦截翻译请求"}`);
  if (!proxyOk) missing.push({ from: "CSP", ref: "connect-src 缺少 " + ph });
}

console.log("\n=== 结论 ===");
if (missing.length === 0) {
  console.log("  ✓ 所有本地资源都存在，无 404");
} else {
  console.log(`  ✗ 缺失 ${missing.length} 个资源：`);
  missing.forEach((m) => console.log(`     ${m.ref}  (被 ${m.from} 引用)`));
}
process.exit(missing.length ? 1 : 0);
