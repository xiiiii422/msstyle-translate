/* 覆盖率测量（可信版）
 *
 * 教训：前端代码通过 window.eval 执行，在 V8 覆盖率里记为
 *       `evalmachine.<anonymous>`，无法按文件名归因 ——
 *       所以**不能用 NODE_V8_COVERAGE 测前端代码的覆盖率**。
 *
 * 能可靠测量的是 Node 侧：
 *   · proxy/node-server.js（真 require）
 *   · prompt.js            （真 require）
 *   · proxy/cloudflare-worker.js（真 import）
 *
 * 这个脚本只报告这些文件，并明确说明前端为何不在统计内 ——
 * 而不是给出一个会误导人的低覆盖率数字。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = __dirname;
const covDir = path.join(dir, ".cov-node");
if (fs.existsSync(covDir)) fs.rmSync(covDir, { recursive: true, force: true });
fs.mkdirSync(covDir, { recursive: true });

/* 这些套件会真正 require/import Node 侧代码 */
const NODE_SUITES = [
  "test-proxy.js",
  "test-concurrency.js",
  "test-redis-ratelimit.js",
  "test-worker.js",
  "test-entrypoints.js",
  "check-prompt-parity.js",
];

console.log("运行 Node 侧套件收集覆盖率...\n");
for (const s of NODE_SUITES) {
  if (!fs.existsSync(path.join(dir, s))) continue;
  try {
    execFileSync(process.execPath, [s], {
      cwd: dir,
      env: Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir }),
      stdio: "ignore",
      timeout: 300000,
    });
  } catch (e) { /* 有些套件返回非 0 */ }
}

/* ---------- 按真实文件路径归因 ---------- */
const TARGETS = ["prompt.js", "proxy\\node-server.js", "proxy\\cloudflare-worker.js"];
const stats = new Map();

for (const f of fs.readdirSync(covDir).filter((x) => x.endsWith(".json"))) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(covDir, f), "utf8")); }
  catch (e) { continue; }

  for (const script of data.result || []) {
    if (!script.url || !script.url.startsWith("file:")) continue;
    const p = decodeURIComponent(new URL(script.url).pathname.replace(/^\//, ""));
    const rel = path.relative(dir, p);

    let matched = null;
    for (const t of TARGETS) {
      if (rel === t || rel === t.replace(/\\/g, "/")) { matched = t; break; }
    }
    if (!matched) continue;

    if (!stats.has(matched)) stats.set(matched, { covered: new Set(), all: new Set() });
    const rec = stats.get(matched);

    for (const fn of script.functions || []) {
      const name = fn.functionName;
      if (!name) continue;
      rec.all.add(name);
      const top = fn.ranges && fn.ranges[0];
      if (top && top.count > 0) rec.covered.add(name);
    }
  }
}

console.log("=== Node 侧函数覆盖率 ===\n");
let totalAll = 0, totalCov = 0;
for (const t of TARGETS) {
  const rec = stats.get(t);
  const label = path.basename(t);
  if (!rec) { console.log(`  ${label.padEnd(22)} (未收集到)`); continue; }
  const pct = rec.all.size ? rec.covered.size / rec.all.size * 100 : 0;
  totalAll += rec.all.size;
  totalCov += rec.covered.size;
  console.log(`  ${pct >= 90 ? "✓" : pct >= 70 ? "~" : "✗"} ${label.padEnd(22)} ${rec.covered.size} / ${rec.all.size}  ${pct.toFixed(0)}%`);
  const unc = [...rec.all].filter((n) => !rec.covered.has(n));
  if (unc.length) console.log(`      未覆盖: ${unc.join(", ")}`);
}

console.log("\n" + "=".repeat(60));
console.log(`Node 侧合计: ${totalCov} / ${totalAll} (${(totalCov / totalAll * 100).toFixed(0)}%)`);

console.log("\n=== 前端（script.js）为何不在统计内 ===");
console.log("  前端代码由 jsdom 通过 window.eval 执行，V8 覆盖率把它记为");
console.log("  `evalmachine.<anonymous>`，无法按文件名归因。");
console.log("  强行统计会给出误导性的低数字 —— 所以这里不报。");
console.log("  前端的行为覆盖由 test-ui / test-feature-truth / test-doc-claims");
console.log("  等套件用**断言**保证，而不是靠行覆盖率。");

fs.rmSync(covDir, { recursive: true, force: true });
process.exit(0);
