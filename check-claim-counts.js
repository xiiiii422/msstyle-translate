/* 核对 README 里每一处「N 项」的声明与实际测试数量是否一致。
   文档里的数字最容易过期 —— 加了几条测试但忘了改 README。 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const dir = __dirname;
const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");

/* 1. 从 README 的"测试方法"清单里抽出 file → 声明条数 */
const declared = new Map();
for (const m of readme.matchAll(/^.*?(test-[a-z-]+\.js|check-[a-z-]+\.js).*?（(\d+)\s*项.*?）/gm)) {
  declared.set(m[1], Number(m[2]));
}

/* 2. 同一条目在结构表里也可能出现 */
for (const m of readme.matchAll(/\|\s*`(test-[a-z-]+\.js|check-[a-z-]+\.js)`\s*\|\s*\*\*(\d+)\s*\/\s*(\d+)/g)) {
  declared.set(m[1], Number(m[2]));
}

console.log("README 里声明了条数的测试：", declared.size, "个\n");

/* 3. 实际运行，读出真实条数
 *
 * 注意：本环境禁止对子进程做管道捕获（spawnSync/execFileSync 返回 EPERM），
 * 所以不能靠 spawn 读输出 —— 但我们需要**退出码**。
 * 折中：用 spawnSync 的 stdio:"ignore"（允许），同时把子进程输出重定向到临时文件。
 */
function actualCount(file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;

  // test-mutation.js 会**运行其它套件**并打印它们的"通过 N / N"，
  // 直接取最后一个匹配会拿到被破坏套件的数字（实测踩过：把 47/47 读成 15/19）。
  // 所以这些"会嵌套运行其它测试"的文件跳过计数核对，另行人工确认。
  const NESTED = [
    "test-mutation.js",
    "check-coverage.js",
    "check-claim-counts.js",
    // test-claim-counts.js 会跑三次 check-claim-counts.js 来验证"能发现过期数字"，
    // 它自己也是嵌套运行 —— 不排除的话会递归到超时，然后被记成"读不到"。
    "test-claim-counts.js",
  ];
  if (NESTED.includes(file)) return { nested: true };

  const outFile = path.join(dir, ".claim-count-" + file + ".log");
  const fs2 = require("fs");
  let fd = null;
  try {
    fd = fs2.openSync(outFile, "w");
    spawnSync(process.execPath, [file], {
      cwd: dir, stdio: ["ignore", fd, fd], timeout: 300000,
    });
    fs2.closeSync(fd);
    fd = null;
    const out = fs2.readFileSync(outFile, "utf8");

    // 标准格式：通过 N / N
    const m = out.match(/通过\s+(\d+)\s*\/\s*(\d+)/g);
    if (m && m.length) {
      const last = m[m.length - 1].match(/通过\s+(\d+)\s*\/\s*(\d+)/);
      return { pass: Number(last[1]), total: Number(last[2]) };
    }

    // check-contrast.js 的特殊格式：每行带 "AA ✓ / 仅大字号 / 不合格" 判定标记
    // 注意要排除"修复前"的历史基线行（它们不参与判定）
    const judged = out.split("\n").filter((l) => /AA ✓|仅大字号|不合格/.test(l) && !/修复前/.test(l));
    if (judged.length) return { pass: judged.length, total: judged.length };

    // test-integrity-guard.js 的格式：用 ✓/✗ 标记自己的断言
    const ticked = out.split("\n").filter((l) => /^\s*[✓✗]\s|:\s*[✓✗]/.test(l));
    if (ticked.length) return { pass: ticked.length, total: ticked.length };

    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs2.closeSync(fd); } catch (e) {} }
    try { fs2.unlinkSync(outFile); } catch (e) {}
  }
}

let mismatches = 0, checked = 0, unknown = 0, nested = 0;
const rows = [];
for (const [file, declaredN] of [...declared].sort()) {
  const act = actualCount(file);
  if (act && act.nested) { nested++; rows.push({ file, declaredN, act: null, nested: true }); continue; }
  if (!act) { unknown++; rows.push({ file, declaredN, act: null }); continue; }
  checked++;
  const ok = act.total === declaredN;
  if (!ok) mismatches++;
  rows.push({ file, declaredN, act, ok });
}

console.log("文件".padEnd(30) + "README声明".padEnd(12) + "实际".padEnd(12) + "结果");
console.log("-".repeat(66));
for (const r of rows) {
  const actStr = r.act ? `${r.act.pass}/${r.act.total}` : (r.nested ? "(嵌套运行)" : "(未取到)");
  const mark = r.nested ? "－ 跳过" : (r.act ? (r.ok ? "✓" : "✗ 不一致") : "?");
  console.log(r.file.padEnd(30) + String(r.declaredN).padEnd(12) + actStr.padEnd(12) + mark);
}

console.log("\n=== 结论 ===");
console.log(`  核对 ${checked} 个，不一致 ${mismatches} 个，未能读取 ${unknown} 个，跳过 ${nested} 个（嵌套运行）`);

/* 重要：如果一条都没读到，说明是**测量失败**，绝不能报"通过"。
   （第一版就踩了这个坑：26 个全部读不到，却打印了 ✅ 全部一致。） */
if (checked === 0) {
  console.log("  ❌ 无法读取任何测试结果 —— 这是测量失败，不是通过");
  process.exit(2);
}
if (mismatches === 0 && unknown === 0) {
  console.log("  ✅ README 里声明的条数与实际全部一致");
} else if (mismatches === 0) {
  console.log(`  ⚠️  已核对的都一致，但有 ${unknown} 个读不到（需人工确认）`);
  process.exit(1);
} else {
  console.log(`  ❌ 有 ${mismatches} 处 README 数字过期，需要更新`);
}
process.exit(mismatches ? 1 : 0);
