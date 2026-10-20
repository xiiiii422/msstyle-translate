require("./check-integrity.js");
/* 档位阶梯的结构校验（离线，不联网）
 *
 * 为什么需要这个文件：
 *   四档的区分度只能靠联网实测发现（test-level-differentiation.js）。
 *   但实测过才发现一个很难看的事实 —— 早期四档的差别是**程度副词**
 *   （"开始使用" → "密集使用" → "用到极致"），模型根本无法执行，
 *   同一句英文的 L2/L3/L4 输出**逐字相同**，滑块等于装饰品。
 *
 *   副词写错在文本上完全看不出来，联网测试又慢、要 Key、还会被限流。
 *   所以这里把"阶梯必须是可数的"这条规则固化成离线断言：
 *   改提示词时如果不小心把某一档的标志特征删掉/写重，本地立刻报错。
 *
 * 现在四档的定义（每档只新增一个"任何句子都能做出来"的标记）：
 *   L1 = 只换词，禁止 是……的 / 括号 / 被
 *   L2 = + 「是……的」框谓语
 *   L3 = + 恰好 1 处括号补充强调
 *   L4 = + 恰好 1 处「被」字硬译被动句
 */
const path = require("path");
const P = require(path.join(__dirname, "prompt.js"));

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const G = (n) => (P.LEVELS[n] && P.LEVELS[n].guide) || "";

/* ---------- 1. 每档都必须自报强度，且与档位号一致 ---------- */
for (const n of [1, 2, 3, 4]) {
  check(`L${n} 的 guide 非空`, G(n).length > 60, G(n).length + " 字符");
  check(`L${n} 开头声明了本次强度`, G(n).includes("本次风格强度：" + n + "（"));
}

/* ---------- 2. 三个"可数标记"必须各自只出现在该出现的档位 ---------- */

/* 每个标记：在哪些档位是"必须做"，在哪些档位是"禁止做"。
   用"必须/禁止"两类关键词分别匹配，避免把禁令当成要求。 */
const MARKERS = [
  {
    key: "是……的框架",
    mustHave: /「是……的」|是……的/,
    banPattern: /不要用“是……的”|不要用「是……的」/,
    requiredIn: [2, 3, 4],
    bannedIn: [1],
  },
  {
    key: "括号补充强调",
    mustHave: /括号/,
    banPattern: /不要加括号|不要括号|禁止：不要加括号/,
    requiredIn: [3, 4],
    bannedIn: [1, 2],
  },
  {
    key: "被字硬译被动句",
    mustHave: /被」|「被|被\s*字/,
    banPattern: /不要用“被”|不要.*被字被动/,
    requiredIn: [4],
    bannedIn: [1, 2, 3],
  },
];

for (const m of MARKERS) {
  for (const n of m.requiredIn) {
    check(`L${n} 要求「${m.key}」`, m.mustHave.test(G(n)), m.mustHave.source);
  }
  for (const n of m.bannedIn) {
    // 该档要么显式禁止，要么根本没提到 —— 但绝不能"要求"它
    const requires = m.mustHave.test(G(n)) && !m.banPattern.test(G(n));
    check(`L${n} 不要求「${m.key}」`, !requires, requires ? "低档位出现了高档特征" : "");
  }
}

/* ---------- 3. 阶梯必须严格递增：每档的特征集合是上一档的超集 ---------- */
function markerSet(n) {
  const s = new Set();
  for (const m of MARKERS) {
    if (m.mustHave.test(G(n)) && !m.banPattern.test(G(n))) s.add(m.key);
  }
  return s;
}
for (let n = 1; n <= 3; n++) {
  const a = markerSet(n), b = markerSet(n + 1);
  const superset = [...a].every((k) => b.has(k));
  const grows = b.size > a.size;
  check(`L${n}→L${n + 1} 特征集合只增不减`, superset, [...a].join(",") + " ⊆ " + [...b].join(","));
  check(`L${n}→L${n + 1} 至少新增一个可数特征`, grows, `L${n}=${a.size} L${n + 1}=${b.size}`);
}
check("L4 的特征比 L1 多至少 3 个", markerSet(4).size - markerSet(1).size >= 3,
  `L1=${markerSet(1).size} L4=${markerSet(4).size}`);

/* ---------- 4. 四档 guide 两两不同，且不能只是改了几个字 ---------- */
{
  const guides = [1, 2, 3, 4].map(G);
  check("四档 guide 互不相同", new Set(guides).size === 4);
  let tooClose = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      // 长度几乎一样、且共享 90% 以上内容的，说明差异只是措辞
      const ratio = Math.min(guides[i].length, guides[j].length) /
                    Math.max(guides[i].length, guides[j].length);
      if (ratio > 0.98 && guides[i] !== guides[j]) tooClose++;
    }
  }
  check("没有两档只是'程度副词'不同（长度近乎相等且内容雷同）", tooClose === 0, tooClose + " 对");
}

/* ---------- 5. 通用硬约束放在系统提示里，不在四档里各抄一遍 ---------- */
{
  const sys = P.SYSTEM_PROMPT;
  check("系统提示含长度上限", /1~1\.5 倍/.test(sys));
  check("系统提示含'只输出一句话'", /只输出一句话/.test(sys));
  check("系统提示含「请」只用于命令句", /「请」只能出现在命令句/.test(sys));
  // 四档里再重复同一条规则，会互相稀释注意力（实测高档位反而丢特征）
  const dupLenCap = [1, 2, 3, 4].filter((n) => /1~1\.5 倍/.test(G(n))).length;
  check("长度上限不在各档重复声明（避免互相稀释）", dupLenCap === 0, dupLenCap + " 档重复");
}

/* ---------- 6. 分档温度：严格递增且落在接口允许的 [0,1] ---------- */
{
  const T = P.LEVEL_TEMPERATURE;
  check("四档温度都存在", [1, 2, 3, 4].every((n) => typeof T[n] === "number"),
        JSON.stringify(T));
  check("温度随档位严格递增", T[1] < T[2] && T[2] < T[3] && T[3] < T[4],
        [1, 2, 3, 4].map((n) => T[n]).join(" < "));
  // 智谱接口对 temperature 的合法区间是 [0,1]，越界会直接 400 且不重试
  check("所有温度都在接口允许的 [0,1] 内",
        [1, 2, 3, 4].every((n) => T[n] >= 0 && T[n] <= 1),
        "最大值 " + Math.max(...[1, 2, 3, 4].map((n) => T[n])));
  check("clampTemperature 把 1.1 夹回 1", P.clampTemperature(1.1) === 1);
  check("clampTemperature 把 -3 夹回 0", P.clampTemperature(-3) === 0);
  check("clampTemperature 对非数字回落到默认值",
        P.clampTemperature("x") === P.DEFAULT_TEMPERATURE);
  check("buildRequestBody 按档位取温度",
        [1, 2, 3, 4].every((n) => P.buildRequestBody("m", "t", "auto", n).temperature === T[n]));
  check("非法档位也拿得到合法温度",
        P.buildRequestBody("m", "t", "auto", 99).temperature >= 0);
}

/* ---------- 7. 确定性清洗：叠字病句必须被修掉，正常句子不许误伤 ---------- */
{
  const fixes = {
    "我们都是是有我们的上和下的。": "我们都是有我们的上和下的。",
    "我的电脑是是又崩溃了的。": "我的电脑是又崩溃了的。",
    "他是在是在等你的。": "他是在等你的。",
    "这个文件是被是被保存了的。": "这个文件是被保存了的。",
  };
  for (const [bad, good] of Object.entries(fixes)) {
    check("叠字病句被修正：" + bad.slice(0, 10) + "…",
          P.deClassicalize(bad) === good, P.deClassicalize(bad));
  }

  const keep = [
    "你是不是我见过最好的。",
    "我现在在等你。",
    "好的，是的，我们的假期。",
    "你有没有时间？",
    "我们都是有梦想的。",
  ];
  for (const s of keep) {
    check("正常句子不被误伤：" + s.slice(0, 10) + "…", P.deClassicalize(s) === s, P.deClassicalize(s));
  }
}

/* ---------- 输出 ---------- */
console.log("\n======== 档位阶梯结构校验 ========");
let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
  else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
}
console.log("==================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
