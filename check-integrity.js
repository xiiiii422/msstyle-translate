/* 仓库完整性守卫
 *
 * 背景：test-mutation.js 会临时改坏源文件，靠 exit/SIGINT 钩子还原。
 *       但进程被强杀（SIGKILL / 超时）时**任何钩子都没机会执行** ——
 *       实测就发生过：script.js 被留在"空输入不提示"的变异状态，
 *       导致 test-ui 与 test-manual-checklist 莫名失败。
 *
 * 钩子靠不住，所以守卫必须在**读取侧**：任何测试开始前先检查
 * 有没有残留的变异备份，有就报警并自动还原。
 *
 * 用法（在每个套件顶部）：
 *   require("./check-integrity.js");
 */
const fs = require("fs");
const path = require("path");

const BACKUP_DIR = path.join(__dirname, ".mutation-backup");
const LOCK_FILE = path.join(__dirname, ".mutation-running");

function hasLeftover() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  try { return fs.readdirSync(BACKUP_DIR); } catch (e) { return []; }
}

/* ----------------------------------------------------------------------
 * 重要：变异测试运行期间，备份目录是**正常存在**的，不是残留。
 *
 * 早期版本没区分这两种情况，导致守卫在变异测试跑到一半时
 * 把刚改坏的文件还原回去 —— 变异还没被测试看到就消失了，
 * 于是所有用例都误报"漏掉"（实测踩过：18/19 全红）。
 *
 * 用 .mutation-running 锁文件区分：
 *   存在锁 = 变异测试正在跑 → 不要动它的备份
 *   没有锁 = 上次被强杀留下的残留 → 自动还原
 * -------------------------------------------------------------------- */
if (fs.existsSync(LOCK_FILE)) {
  // 变异测试正在进行，安静地跳过
  module.exports = { hadLeftover: false, skipped: true };
  return;
}

const leftovers = hasLeftover();

if (leftovers.length > 0) {
  // 有残留 = 上次变异测试没跑完，源文件可能仍是被改坏的版本
  const restored = [];
  for (const b of leftovers) {
    const original = b.replace(/__/g, path.sep);
    const bakPath = path.join(BACKUP_DIR, b);
    try {
      const backupContent = fs.readFileSync(bakPath, "utf8");
      const current = fs.existsSync(path.join(__dirname, original))
        ? fs.readFileSync(path.join(__dirname, original), "utf8")
        : null;

      if (current !== backupContent) {
        fs.writeFileSync(path.join(__dirname, original), backupContent, "utf8");
        restored.push(original + "（内容曾被改动，已还原）");
      } else {
        restored.push(original + "（内容一致，仅清理备份）");
      }
      fs.unlinkSync(bakPath);
    } catch (e) {
      restored.push(original + "（还原失败：" + e.message + "）");
    }
  }
  try {
    if (fs.readdirSync(BACKUP_DIR).length === 0) fs.rmdirSync(BACKUP_DIR);
  } catch (e) { /* ignore */ }

  console.error("\n⚠️  检测到上次变异测试留下的备份（说明它被强制中断了）：");
  restored.forEach((r) => console.error("     · " + r));
  console.error("   已自动处理。为避免误判，建议重跑一次测试。\n");
}

module.exports = { hadLeftover: leftovers.length > 0 };
