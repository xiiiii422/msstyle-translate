require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 实测：四档"翻译程度"是否真的产出可区分的结果？
 *
 * 此前所有风格测试只验证"没有文言文"，从未验证"档位之间有差异"。
 * 如果 1 档和 4 档输出差不多，那这个滑块就是装饰品 —— 用户会认为它没用。
 *
 * 方法：同一句话跑遍四档，用可量化的特征比较：
 *   · 与原文的相似度（越高说明改动越小 = 越自然）
 *   · 长度变化
 *   · 机器味特征词命中数
 *   · 语序异常指标（"是……的"、重复主语、多余"的"）
 */
const path = require("path");
const https = require("https");
const PROMPTS = require(path.join(__dirname, "prompt.js"));

const KEY = process.env.TEST_ZHIPU_KEY;
const MODEL = process.env.TEST_MODEL || "glm-4-flash-250414";
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

function call(model, text, mode, level) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(PROMPTS.buildRequestBody(model, text, mode, level));
    const req = https.request({
      host: "open.bigmodel.cn", path: "/api/paas/v4/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY,
        "Content-Length": Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try {
          const j = JSON.parse(d);
          resolve(PROMPTS.cleanResult(j.choices[0].message.content));
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

/* ---- 量化指标 ---- */

/** 字符级相似度（最长公共子序列 / 较长串长度），0~1 */
function similarity(a, b) {
  const A = a.replace(/\s/g, ""), B = b.replace(/\s/g, "");
  if (!A || !B) return 0;
  const m = A.length, n = B.length;
  // 滚动数组 LCS，避免大输入爆内存
  let prev = new Uint16Array(n + 1), cur = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[n] / Math.max(m, n);
}

/** 机器味特征：出现越多越"机翻" */
const MACHINE_MARKERS = [
  "是……的", "的。", "因为", "所以", "已经", "将会", "对于", "由于",
  "进行", "一个", "这是", "它是", "而且", "并且", "因此", "得到", "拥有",
];
function machineScore(t) {
  let n = 0;
  for (const m of MACHINE_MARKERS) if (t.includes(m)) n++;
  // 语序生硬特征
  if (/是[^，。]{1,12}的[，。]/.test(t)) n++;      // "是……的" 结构
  if (/^(我|你|他|她|它|我们|你们|他们)/.test(t) && /我们|他们/.test(t)) n++; // 代词重复
  const extraDe = (t.match(/的/g) || []).length;
  n += Math.max(0, extraDe - 2) * 0.5;            // 多余的"的"
  return n;
}

const CASES = [
  { text: "我今天特别开心，因为终于放假了。", mode: "zh" },
  { text: "I'm really happy because we finally have a holiday.", mode: "en" },
];

(async () => {
  console.log("模型: " + MODEL);
  console.log("目的：验证 4 个档位是否真的产出可区分的结果\n");

  const summary = [];

  for (const c of CASES) {
    console.log("=".repeat(66));
    console.log("原文: " + c.text);
    console.log("=".repeat(66));

    const rows = [];
    for (const level of [1, 2, 3, 4]) {
      let out;
      try { out = await call(MODEL, c.text, c.mode, level); }
      catch (e) { console.log(`  L${level}: 请求失败 ${e.message}`); continue; }

      const sim = similarity(c.text, out);
      const ms = machineScore(out);
      rows.push({ level, out, sim, ms, len: out.length });

      console.log(`  L${level} (${PROMPTS.LEVELS[level].name})`);
      console.log(`      ${out}`);
      console.log(`      与原文相似度=${(sim * 100).toFixed(1)}%  机器味=${ms.toFixed(1)}  长度=${out.length}`);
    }

    if (rows.length >= 2) {
      const sims = rows.map((r) => r.sim);
      const mss = rows.map((r) => r.ms);
      // 相似度应随档位升高而下降（越机器越不像原文）
      const simSpread = Math.max(...sims) - Math.min(...sims);
      const msSpread = Math.max(...mss) - Math.min(...mss);
      console.log(`\n  相似度区间跨度: ${(simSpread * 100).toFixed(1)} 个百分点`);
      console.log(`  机器味区间跨度: ${msSpread.toFixed(1)}`);

      summary.push({
        text: c.text.slice(0, 20),
        simSpread, msSpread,
        distinctOutputs: new Set(rows.map((r) => r.out)).size,
        levels: rows.length,
      });
    }
    console.log("");
  }

  console.log("=".repeat(66));
  console.log("=== 结论 ===");
  let problems = 0;
  for (const s of summary) {
    const distinctOk = s.distinctOutputs === s.levels;
    const spreadOk = s.simSpread > 0.05 || s.msSpread > 1.5;
    console.log(`  "${s.text}"`);
    console.log(`    四档输出互不相同: ${distinctOk ? "✓" : "✗ (" + s.distinctOutputs + "/" + s.levels + ")"}`);
    console.log(`    档位间有可测差异: ${spreadOk ? "✓" : "✗"}（相似度跨度 ${(s.simSpread*100).toFixed(1)}pp，机器味跨度 ${s.msSpread.toFixed(1)}）`);
    if (!distinctOk || !spreadOk) problems++;
  }
  console.log("");
  console.log(problems === 0
    ? "  ✅ 四档确实产出可区分的结果，滑块不是装饰品"
    : `  ⚠️  有 ${problems} 例档位区分度不足`);
  process.exit(0);
})();
