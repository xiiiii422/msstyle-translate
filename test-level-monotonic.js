require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 档位区分度回归测试（联网）
 *
 * 背景：实测发现"翻译程度"滑块曾经是坏的 ——
 *   L1=1.00  L2=1.53  L3=0.30  L4=0.40
 * 拉到最右边反而"不那么微软"，滑块等于装饰品。
 * 原因是 L3/L4 的提示词只强调"语序倒装"，没强调机器味标志结构，
 * 模型于是把句子改短、打乱词序，而不是产出机器翻译腔。
 *
 * 这个测试守住"机器味必须随档位单调递增"，防止以后改提示词时退化。
 *
 * 用法：TEST_ZHIPU_KEY=xxx node test-level-monotonic.js
 *       （需要联网；默认不跑在离线套件里）
 */
const path = require("path");
const https = require("https");
const PROMPTS = require(path.join(__dirname, "prompt.js"));

const KEY = process.env.TEST_ZHIPU_KEY;
const MODEL = process.env.TEST_MODEL || "glm-4-flash-250414";
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

const ROUNDS = parseInt(process.env.LEVEL_ROUNDS || "2", 10);

function call(text, mode, level) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(PROMPTS.buildRequestBody(MODEL, text, mode, level));
    const req = https.request({
      host: "open.bigmodel.cn", path: "/api/paas/v4/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY,
        "Content-Length": Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(PROMPTS.cleanResult(JSON.parse(d).choices[0].message.content)); }
        catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

/** 机器味打分：只看"像不像机翻"，不看语序是否混乱 */
function machineScore(orig, out) {
  let n = 0;
  if (/是[^，。]{1,14}的/.test(out)) n += 2;                  // 是……的
  const de = (out.match(/的/g) || []).length;
  if (de > 2) n += 1;                                        // 多余的"的"
  if (/进行|得到|拥有|已经|将会/.test(out)) n += 1;           // 机械动词
  const conn = (out.match(/而且|并且|因此|所以|然而|但是|因为|由于/g) || []).length;
  if (conn >= 2) n += 1;                                     // 连接词堆叠
  if (/(我|你|他|她|它|我们|他们)(?=[^，。]{0,10}\1)/.test(out)) n += 0.5; // 主语重复
  if (out.length < orig.length * 0.9) n -= 1;                // 压缩了 = 跑偏
  return n;
}

const TEXTS = [
  { text: "我今天特别开心，因为终于放假了。", mode: "zh" },
  { text: "这个计划听起来非常不错。", mode: "zh" },
  { text: "I'm really happy because we finally have a holiday.", mode: "en" },
];

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

(async () => {
  console.log("模型: " + MODEL + "  每个输入每档 " + ROUNDS + " 次\n");

  const scores = { 1: [], 2: [], 3: [], 4: [] };
  for (const t of TEXTS) {
    process.stdout.write("  " + t.text.slice(0, 28) + "... ");
    for (const level of [1, 2, 3, 4]) {
      for (let r = 0; r < ROUNDS; r++) {
        try { scores[level].push(machineScore(t.text, await call(t.text, t.mode, level))); }
        catch (e) { /* 单次失败忽略 */ }
      }
    }
    console.log("完成");
  }

  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const means = [1, 2, 3, 4].map((l) => avg(scores[l]));

  console.log("\n档位   机器味均值   样本");
  console.log("-".repeat(34));
  for (const l of [1, 2, 3, 4]) {
    console.log(`L${l}     ${means[l - 1].toFixed(2).padStart(8)}   ${String(scores[l].length).padStart(4)}`);
  }

  /* ---------- 断言 ---------- */
  check("每个档位都拿到了样本",
    [1, 2, 3, 4].every((l) => scores[l].length > 0),
    [1, 2, 3, 4].map((l) => "L" + l + "=" + scores[l].length).join(" "));

  // 核心：单调递增（容忍小幅波动）
  for (let i = 1; i < 4; i++) {
    check(`L${i} → L${i + 1} 机器味不下降`,
      means[i] >= means[i - 1] - 0.3,
      `${means[i - 1].toFixed(2)} → ${means[i].toFixed(2)}`);
  }

  // 两端必须有明显差距，否则滑块没意义
  check("L4 与 L1 差距明显（>= 2.0）",
    means[3] - means[0] >= 2.0,
    `${means[0].toFixed(2)} → ${means[3].toFixed(2)}（差 ${(means[3] - means[0]).toFixed(2)}）`);

  // L4 不应比 L2 还低（这是曾经的真实 bug）
  check("L4 明显高于 L2（高档位确实更重）",
    means[3] > means[1],
    `L2=${means[1].toFixed(2)} L4=${means[3].toFixed(2)}`);

  console.log("\n======== 档位区分度测试 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
