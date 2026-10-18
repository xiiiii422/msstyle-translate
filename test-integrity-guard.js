/* 严格验证完整性守卫：注入损坏 → 守卫应还原 → 内容必须与原始一致 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = __dirname;
const target = "script.js";
const original = fs.readFileSync(path.join(dir, target), "utf8");

// 1) 造一个"被强杀"的现场：备份 + 损坏的源文件
fs.mkdirSync(path.join(dir, ".mutation-backup"), { recursive: true });
fs.writeFileSync(path.join(dir, ".mutation-backup", target), original, "utf8");

const marker = 'showToast("请先输入一点内容，机器才有东西可以翻译。", true);';
if (!original.includes(marker)) {
  console.error("✗ 找不到用于破坏的目标字符串");
  process.exit(2);
}
const corrupted = original.replace(
  marker,
  "/* 静默返回 —— 模拟变异测试留下的损坏 */"
);
fs.writeFileSync(path.join(dir, target), corrupted, "utf8");
console.log("1) 已注入损坏，长度", corrupted.length, "（原始", original.length, "）");

// 2) 跑一个带守卫的套件（用 stdio ignore，只看结果文件）
try {
  execFileSync(process.execPath, ["test-manual-checklist.js"], {
    cwd: dir, stdio: "ignore", timeout: 300000,
  });
} catch (e) { /* 可能返回非 0 */ }

// 3) 校验：是否被还原
const after = fs.readFileSync(path.join(dir, target), "utf8");
const restored = after === original;
const backupGone = !fs.existsSync(path.join(dir, ".mutation-backup"));

console.log("2) 跑完套件后：");
console.log("   内容与原始完全一致:", restored ? "✓" : "✗");
console.log("   备份目录已清理    :", backupGone ? "✓" : "✗");

// 4) 清理（若还原失败，手动恢复，避免留下烂摊子）
if (!restored) {
  fs.writeFileSync(path.join(dir, target), original, "utf8");
  console.log("   （已手动恢复）");
}
if (fs.existsSync(path.join(dir, ".mutation-backup"))) {
  fs.rmSync(path.join(dir, ".mutation-backup"), { recursive: true, force: true });
}

console.log("\n" + (restored && backupGone
  ? "✅ 完整性守卫有效：被强杀后留下的损坏会被下一个套件自动修复"
  : "❌ 守卫无效"));
process.exit(restored && backupGone ? 0 : 1);
