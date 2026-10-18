/* 检测输出是否跑偏成文言文 / 是否失去了机器味 */

// 强文言信号：出现即基本可判定为文言文（这些词在现代白话中几乎不会出现）
const STRONG_CLASSICAL = [
  "吾", "尔", "汝", "矣", "焉", "哉", "兮", "盖因", "皆", "乃", "何等",
  "决意", "就寝", "欢愉", "佳日", "云尔", "耶", "欤", "岂", "莫大",
  "甚是", "颇为", "为何物", "之至", "斯", "夫复",
  // 以下是实测中真实出现过的跑偏词
  "乃是", "终至", "倍感", "堪称", "犹如", "颇为不俗", "理应", "亦",
  "乃是因着", "因着", "终得", "异常欢愉", "不俗",
];

// 弱信号：单独出现是正常现代汉语，只有成串出现才说明跑偏
// 例如"之后""之前""之一"里的"之"完全正常，"颇"在现代书面语中也常见
const WEAK_CLASSICAL = ["之", "其", "亦", "颇", "甚", "此", "乃", "于"];

// 现代白话中这些词里含有弱信号字，需要先剔除再判断
const MODERN_WHITELIST = [
  "之后", "之前", "之一", "之间", "之类", "之外", "之中", "之下", "之上", "反之",
  "其他", "其中", "尤其", "与其", "其实", "极其", "及其",
  "颇为", "颇为不满",       // "颇为"在现代书面语中可接受
  "亦", "甚至", "甚好", "此致", "此后", "此外", "此时", "此事", "此次", "此项目",
  "由于", "对于", "关于", "至于", "终于", "等于", "属于", "位于", "便于",
];

// 机器味的正向特征（出现越多越像机器翻译）
const MACHINE = ["的。", "因为", "所以", "已经", "将会", "对于", "由于", "进行",
  "一个", "这是", "它是", "被", "而且", "并且", "因此", "获得", "得到", "拥有", "是……的"];

function analyze(text) {
  // 先挖掉现代词汇，避免其中的字被误判
  let stripped = text;
  for (const w of MODERN_WHITELIST) {
    stripped = stripped.split(w).join("　");
  }

  const strong = STRONG_CLASSICAL.filter((w) => stripped.includes(w));
  const weak = WEAK_CLASSICAL.filter((w) => stripped.includes(w));

  // 弱信号达到 2 个以上才算跑偏（单个弱信号在正常中文里很常见）
  const classical = weak.length >= 2 ? [...strong, ...weak] : strong;

  const machine = MACHINE.filter((w) => text.includes(w)).length;

  return {
    classical: [...new Set(classical)],
    weakOnly: [...new Set(weak)],
    machine,
    idioms: (text.match(/[\u4e00-\u9fa5]{4}(?=[，。！？]|$)/g) || []).length,
  };
}

module.exports = { analyze };

if (require.main === module) {
  const tests = [
    "今日吾异常欢愉，盖因终得休假矣。",
    "我今天是特别的开心，因为我们终于已经得到了假期。",
    "我确实感到非常愉快，因为我们终于迎来了假日。",
    "这系我一生之中最为美好的日子。",
  ];
  for (const t of tests) {
    const a = analyze(t);
    console.log(t);
    console.log("  文言词:", a.classical.length ? a.classical.join(" ") : "无", "| 机器味词数:", a.machine, "| 四字结构:", a.idioms);
    console.log("");
  }
}
