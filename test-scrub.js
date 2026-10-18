require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 单元测试 deClassicalize
   提示词与清洗规则已统一到 prompt.js（唯一来源），所以这里直接从它取函数，
   不再从 script.js 里正则抽取 —— 那样一重构就会失效。 */
const path = require("path");
const PROMPTS = require(path.join(__dirname, "prompt.js"));

const CLASSICAL_FIXES = PROMPTS.CLASSICAL_FIXES;
const deClassicalize = PROMPTS.deClassicalize;

const cases = [
  // [输入, 期望不含, 说明]
  ["今日吾异常欢愉，盖因终得休假矣。", ["吾", "矣"], "典型文言"],
  ["我今天异常愉悦，鉴于最终得以享有休假之荣幸。", ["矣"], "半文半白"],
  ["今日我倍感高兴，乃是因着假期终至。", ["乃是", "终至", "倍感"], "实测泄漏1"],
  ["我已经很久未曾品尝过如此美味之拉面矣。", ["矣"], "实测泄漏2"],
  ["此方案听来颇为不俗。", ["颇为"], "实测泄漏3（属文言，应当被改写）"],
  // 关键回归：'最终得以' 不能被 '终得' 规则误伤
  ["我今天异常愉悦，鉴于最终得以享有休假之荣幸。", ["矣"], "回归-最终得以"],
  ["他最终得到了他想要的结果。", [], "回归-最终得到"],
  ["我终于得到了这个机会。", [], "回归-终于得到"],
  // 正常文本必须完全不变
  ["我今天是特别的开心，因为我们终于已经得到了假期。", [], "正常机器味"],
  ["我决定今天早点睡觉。", [], "正常"],
  ["我的电脑又在我保存文件的时候崩溃了。", [], "正常"],
  ["这是可以说的，因为我也是这样认为的。", [], "正常"],
  ["我也是一个普通人。", [], "正常含'也'"],
  ["他说的比较有道理。", [], "正常含'比较'"],
];

let pass = 0, fail = 0;
console.log("=== deClassicalize 单元测试 ===\n");
for (const [input, forbidden, note] of cases) {
  const out = deClassicalize(input);
  const leaked = forbidden.filter((w) => out.includes(w));
  const untouched = forbidden.length === 0 && out === input;
  const ok = leaked.length === 0 && (forbidden.length > 0 || untouched);

  if (ok) { pass++; console.log(`  PASS  [${note}]`); }
  else { fail++; console.log(`  FAIL  [${note}]`); }

  console.log(`        输入: ${input}`);
  console.log(`        输出: ${out}`);
  if (leaked.length) console.log(`        !! 仍残留: ${leaked.join(" ")}`);
  if (forbidden.length === 0 && out !== input) console.log(`        !! 正常文本被改动了`);
  console.log("");
}

// 幂等性：跑两次结果应一致
const idem = deClassicalize(deClassicalize("今日吾异常欢愉，盖因终得休假矣。"));
const once = deClassicalize("今日吾异常欢愉，盖因终得休假矣。");
console.log("幂等性检查:", idem === once ? "PASS" : "FAIL");
if (idem === once) pass++; else fail++;

// 空输入与边界
console.log("空字符串:", JSON.stringify(deClassicalize("")) === '""' ? "PASS" : "FAIL");
console.log("\n================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
