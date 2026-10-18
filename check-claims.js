/* 找出项目里"声称但未经验证"的东西
 *
 * 回顾本项目 19 轮的缺陷来源，全部集中在"某处声称了 X，但没人验证过 X"：
 *   · README 说最小部署集是 3 个文件      → 其实需要 4 个
 *   · README 说 401 提示"还没有配置 API Key" → 文案早已改过
 *   · CSS 里定义了 .settings-btn-wrap       → 没有任何元素用它
 *   · 代码注释说"用 rAF 合并避免重排"        → 没验证过是否真的生效
 *
 * 所以这轮换个做法：**机械地列出所有"声称"，逐一核对是否有人验证过。**
 */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
const files = {
  "script.js": fs.readFileSync(path.join(dir, "script.js"), "utf8"),
  "prompt.js": fs.readFileSync(path.join(dir, "prompt.js"), "utf8"),
  "style.css": fs.readFileSync(path.join(dir, "style.css"), "utf8"),
  "index.html": fs.readFileSync(path.join(dir, "index.html"), "utf8"),
};

console.log("=== 1. README 里所有「数字声明」===\n");

// 提取 README 里形如 "N 项" / "N / N" / "N 条" / "N 个文件" 的声明
const numericClaims = [];
for (const m of readme.matchAll(/(\d+)\s*(项|条|个|档|处)/g)) {
  const line = readme.slice(0, m.index).split("\n").pop();
  if (/测试|断言|破坏|配色|文件|档位|检查/.test(line)) {
    numericClaims.push({ n: m[1], unit: m[2], line: line.trim().slice(0, 90) });
  }
}
const seen = new Set();
for (const c of numericClaims) {
  const key = c.n + c.unit + c.line.slice(0, 40);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${c.n}${c.unit}  ← ${c.line}`);
}

console.log("\n=== 2. 代码注释里所有「这样做是为了…」的声称 ===\n");
// 这类注释最容易过期：写了理由，但后来行为变了，注释没改
const commentClaims = [];
for (const [name, src] of Object.entries(files)) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 匹配"避免了/确保/防止/因为/之所以/注意："这类解释性注释
    if (/\/\/|\/\*|\*/.test(l) && /(避免|确保|防止|之所以|因为|注意：|必须|应该会|会合并|无泄漏)/.test(l)) {
      commentClaims.push({ file: name, line: i + 1, text: l.trim().replace(/^[/*\s]+/, "").slice(0, 90) });
    }
  }
}
for (const c of commentClaims) {
  console.log(`  ${c.file}:${c.line}`);
  console.log(`     ${c.text}`);
}

console.log("\n=== 3. 这些声称中，哪些有对应测试？ ===\n");
const testFiles = fs.readdirSync(dir).filter((f) => f.startsWith("test-") || f.startsWith("check-"));
const allTests = testFiles.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");

// 关键词 → 是否有测试提到
const KEYWORDS = [
  ["避免重复请求", /防重复|loading.*锁|连点/],
  ["rAF 合并重排", /rAF|requestAnimationFrame|重排|合并/],
  ["防抖 resize", /防抖|debounce|resizeTimer/],
  ["XSS 防护", /XSS|innerHTML|注入/],
  ["历史 10 条上限", /10 条|HISTORY_LIMIT|上限/],
  ["深色模式", /深色|dark/],
  ["触摸目标 44px", /44px|触摸目标|min-height/],
  ["安全区域", /safe-area|刘海/],
  ["剪贴板降级", /execCommand|降级|clipboard/],
  ["存储容错", /隐私模式|localStorage.*不可用|safeStorage/],
  ["竞态防护", /竞态|requestSeq|过期/],
  ["超时降级", /超时|deadline|TOTAL_TIMEOUT/],
  ["文言文兜底", /文言|deClassicalize|classical/],
];

let verified = 0, unverified = 0;
for (const [name, re] of KEYWORDS) {
  const inTests = re.test(allTests);
  if (inTests) { verified++; console.log(`  ✓ ${name}`); }
  else { unverified++; console.log(`  ✗ ${name}  —— 没有找到对应测试`); }
}

console.log(`\n  有测试覆盖: ${verified} / ${verified + unverified}`);

console.log("\n=== 4. README 表格行统计 ===\n");
// README 里有很多表格，逐行看哪些是"可验证的断言"但没在测试里出现
const tableRows = readme.split("\n").filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l));
console.log(`  README 共有 ${tableRows.length} 行表格内容`);
