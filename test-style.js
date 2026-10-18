require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 真实联网验证：输出是否稳定呈现"现代白话 + 机器味"，且不跑成文言文。
   提示词统一从 prompt.js 读取（唯一来源），保证测的就是线上实际用的那一份。 */
const path = require("path");
const https = require("https");
const { analyze } = require("./detect.js");
const PROMPTS = require(path.join(__dirname, "prompt.js"));

const KEY = process.env.TEST_ZHIPU_KEY;
const MODEL = process.env.TEST_MODEL || "glm-4.7-flash";
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

const SYSTEM_PROMPT = PROMPTS.SYSTEM_PROMPT;
const buildUserPrompt = PROMPTS.buildUserPrompt;

function post(text, mode, level) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(text, mode, level) },
      ],
      temperature: 1.0, top_p: 0.9, max_tokens: 1024, stream: false,
    });
    const req = https.request({
      host: "open.bigmodel.cn", path: "/api/paas/v4/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + KEY,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " " + d.slice(0, 200)));
        try { resolve(JSON.parse(d).choices[0].message.content.trim()); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

const CASES = [
  { text: "我今天特别开心，因为终于放假了。", mode: "zh", level: 3 },
  { text: "I'm really happy because we finally have a holiday.", mode: "en", level: 3 },
  { text: "This is the best day of my entire life.", mode: "auto", level: 3 },
  { text: "这个计划听起来非常不错。", mode: "auto", level: 1 },
  { text: "我决定今天早点睡觉。", mode: "auto", level: 4 },
  { text: "妈妈让我先去把作业写完，然后才能玩游戏。", mode: "auto", level: 2 },
  { text: "My computer crashed again while I was saving the file.", mode: "en", level: 3 },
  { text: "天气预报说，明天可能会下雨。", mode: "auto", level: 3 },
  { text: "I have no idea what is happening.", mode: "en", level: 2 },
  { text: "我已经很久没有吃过这么好吃的拉面了。", mode: "auto", level: 4 },
  { text: "Please remember to bring your umbrella tomorrow morning.", mode: "en", level: 1 },
  { text: "这家店的咖啡很好喝，但是有点贵。", mode: "auto", level: 3 },
];

(async () => {
  console.log("模型: " + MODEL + " | 用例: " + CASES.length + "\n");
  let clean = 0, classicalLeak = 0, formatBad = 0;

  for (const c of CASES) {
    try {
      const out = await post(c.text, c.mode, c.level);
      const a = analyze(out);
      const hasPrefix = /^(翻译结果|微软式中文|结果)\s*[:：]/.test(out);
      const hasMd = /```|\*\*|^#\s/m.test(out);
      const okFormat = !hasPrefix && !hasMd && /[\u4e00-\u9fa5]/.test(out);
      const okStyle = a.classical.length === 0;

      console.log(`[${c.mode}/L${c.level}] ${c.text}`);
      console.log(`  -> ${out.replace(/\n/g, " ")}`);
      console.log(`  格式:${okFormat ? "✓" : "✗"}  无文言:${okStyle ? "✓" : "✗ " + a.classical.join(" ")}  机器味词:${a.machine}`);
      console.log("");

      if (okFormat) clean++; else formatBad++;
      if (!okStyle) classicalLeak++;
    } catch (e) {
      console.log(`[${c.mode}/L${c.level}] ${c.text}\n  请求失败: ${e.message}\n`);
      formatBad++;
    }
  }
  console.log("================================");
  console.log(`格式合规: ${clean}/${CASES.length}   文言文泄漏: ${classicalLeak}   失败: ${formatBad}`);
})();
