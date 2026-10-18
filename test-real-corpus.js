/* 用网上找到的**真实微软式翻译**案例，检验新提示词能不能复现那种味道。
   这些是真实语料（品玩整理的 Windows 10 翻译），不是编的。 */
const path = require("path");
const https = require("https");
const PROMPTS = require(path.join(__dirname, "prompt.js"));

const KEY = process.env.TEST_ZHIPU_KEY;
const MODEL = process.env.TEST_MODEL || "glm-4-flash-250414";
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

function call(text, level) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(PROMPTS.buildRequestBody(MODEL, text, "auto", level || 3));
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

/* 真实语料：[原文, 微软真实翻译] */
const CORPUS = [
  ["Sit back and relax.", "请坐和放宽。"],
  ["Windows 10 Business Experience", "窗 10 商业经验"],
  ["Please save your work before logging off.", "请在登出之前保存您的作业。"],
  ["Windows 10 is available for your phone (yes, your phone).", "Windows 10 可用于你的手机（是的，你的手机）"],
  ["Please enter your password.", "请键入您的密码。"],
  ["We all have our ups and downs.", "我们都有不顺利的时候。"],
  ["Something happened.", "Something happened"],
  ["This is really awkward.", "这真是让人尴尬。"],
];

/** 招牌特征检测 */
const SIGNATURES = {
  "逐词硬拆": (t) => /坐和放宽|窗\s*10|硬拆/.test(t),
  "括号强调": (t) => /（[^）]{1,20}）|\([^)]{1,20}\)/.test(t),
  "句首加请": (t) => /^请/.test(t) || /。请/.test(t),
  "生硬对应": (t) => /键入|登出|到达|拥有|得到|进行/.test(t),
  "是…的": (t) => /是[^，。]{1,14}的/.test(t),
  "选错义项": (t) => /作业|书籍|记号/.test(t),
};

(async () => {
  console.log("模型:", MODEL);
  console.log("对照真实微软翻译语料，检验复现效果\n");
  console.log("=".repeat(70));

  let hitCount = 0;
  const detail = [];

  for (const [src, realOut] of CORPUS) {
    process.stdout.write(`原文: ${src}\n`);
    process.stdout.write(`  真实微软翻译: ${realOut}\n`);
    let out = "";
    try { out = await call(src, 3); } catch (e) { out = "(失败: " + e.message + ")"; }
    process.stdout.write(`  本次生成: ${out}\n`);

    // 统计命中了哪些招牌特征
    const hits = Object.entries(SIGNATURES)
      .filter(([name, fn]) => fn(out))
      .map(([name]) => name);
    process.stdout.write(`  命中特征: ${hits.length ? hits.join("、") : "（无）"}\n`);
    if (hits.length) hitCount++;
    detail.push({ src, hits: hits.length });
    console.log("");
  }

  console.log("=".repeat(70));
  console.log(`\n命中至少一个招牌特征: ${hitCount} / ${CORPUS.length}`);
  const avg = detail.reduce((a, b) => a + b.hits, 0) / detail.length;
  console.log(`平均命中特征数: ${avg.toFixed(1)}`);
  console.log("");
  console.log(hitCount >= CORPUS.length * 0.75
    ? "✅ 复现效果良好：大多数输出都带有微软式招牌特征"
    : "⚠️  复现不足：很多输出没有体现出招牌特征，需要继续调提示词");
})();
