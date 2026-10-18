/* 验证 check-claim-counts.js 真的能发现"README 数字过期" */
const fs = require("fs");
const { spawnSync } = require("child_process");

const README = "README.md";
const original = fs.readFileSync(README, "utf8");

function runChecker() {
  const outFile = ".claim-verify.log";
  const fd = fs.openSync(outFile, "w");
  const r = spawnSync(process.execPath, ["check-claim-counts.js"], {
    cwd: __dirname, stdio: ["ignore", fd, fd], timeout: 900000,
  });
  fs.closeSync(fd);
  const out = fs.readFileSync(outFile, "utf8");
  fs.unlinkSync(outFile);
  return { code: r.status, out };
}

console.log("=== 1. 基线（未破坏）===");
const base = runChecker();
const baseOk = base.out.includes("✅");
console.log("  exit =", base.code, baseOk ? "✓ 通过" : "✗ 未通过");
if (!baseOk) {
  console.log(base.out.split("\n").slice(-8).join("\n"));
  process.exit(1);
}

console.log("\n=== 2. 注入过期数字（把某个套件的声明条数改小 7）===");
/* 不要写死具体数字：README 里的条数会随测试增加而变化，
   写死的话每加一条测试，这个"验证器是否有效"的测试自己就先失效了。 */
const target = original.match(/\| `(test-[a-z-]+\.js)` \| \*\*(\d+) \/ \2 通过\*\* \|/);
if (!target) {
  console.log("  ✗ README 里找不到可注入的「N / N 通过」行");
  process.exit(1);
}
const oldRow = target[0];
const declared = Number(target[2]);
const newRow = oldRow.replace(
  `**${declared} / ${declared} 通过**`,
  `**${declared - 7} / ${declared - 7} 通过**`
);
const mutated = original.replace(oldRow, newRow);
console.log("  目标：" + target[1] + "  " + declared + " → " + (declared - 7));
if (mutated === original) {
  console.log("  ✗ 注入失败（替换没有生效）");
  process.exit(1);
}
fs.writeFileSync(README, mutated, "utf8");
const bad = runChecker();
fs.writeFileSync(README, original, "utf8");

const detected = bad.code !== 0 && /不一致|过期/.test(bad.out);
console.log("  exit =", bad.code, detected ? "✓ 检测到" : "✗ 未检测到");
if (!detected) console.log(bad.out.split("\n").slice(-8).join("\n"));

console.log("\n=== 3. 还原后复检 ===");
const again = runChecker();
console.log("  exit =", again.code, again.out.includes("✅") ? "✓ 恢复通过" : "✗ 仍失败");

const finalOk = baseOk && detected && again.out.includes("✅");
console.log("\n" + (finalOk
  ? "✅ check-claim-counts.js 有效：能发现 README 里过期的数字"
  : "❌ 校验器无效"));

// 统一成 "通过 N / N" 格式，方便 check-claim-counts 与其它套件共用解析逻辑
const passN = [baseOk, detected, again.out.includes("✅")].filter(Boolean).length;
console.log(`通过 ${passN} / 3` + (finalOk ? "  ✅ 全部通过" : "  ❌ 有失败"));
process.exit(finalOk ? 0 : 1);
