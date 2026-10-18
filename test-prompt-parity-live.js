require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 真实验证：修复提示词分叉后，代理模式与直连模式在**同一输入**下的
   输出质量是否一致（尤其是"不再跑成文言文"）。
   这是最初发现 bug 的地方，必须用真实 API 复核。 */
const path = require("path");
const fs = require("fs");
const https = require("https");
const { JSDOM } = require("jsdom");
const { analyze } = require("./detect.js");

const KEY = process.env.TEST_ZHIPU_KEY;
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

process.env.ZHIPU_API_KEY = KEY;
process.env.RATE_LIMIT_MAX = "10000";
process.env.LOG_LEVEL = "off";

const dir = __dirname;
const PROMPTS = require(path.join(dir, "prompt.js"));
const app = require(path.join(dir, "proxy", "node-server.js"));

/* 直连：直接调用上游（复刻前端行为） */
function directCall(model, text, mode, level) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(PROMPTS.buildRequestBody(model, text, mode, level));
    const req = https.request({
      host: "open.bigmodel.cn", path: "/api/paas/v4/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY,
        "Content-Length": Buffer.byteLength(body) },
      timeout: 40000,
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try {
          const j = JSON.parse(d);
          const c = j.choices[0].message.content;
          resolve(PROMPTS.cleanResult(c));
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function post(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const http = require("http");
    const r = http.request({
      host: "127.0.0.1", port, path: "/translate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); r.write(data); r.end();
  });
}

const CASES = [
  { text: "我今天特别开心，因为终于放假了。", mode: "zh", level: 3 },
  { text: "I'm really happy because we finally have a holiday.", mode: "en", level: 1 },
  { text: "这个计划听起来非常不错。", mode: "auto", level: 4 },
  { text: "我决定今天早点睡觉。", mode: "auto", level: 2 },
];

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const MODEL = "glm-4-flash-250414";   // 用最稳的模型，避免 429 干扰对比

  console.log("模型: " + MODEL + "  用例: " + CASES.length);
  console.log("对比：直连模式 vs 代理模式（提示词应完全等价）\n");

  let directClassical = 0, proxyClassical = 0, bothOk = 0;

  for (const c of CASES) {
    process.stdout.write(`[${c.mode}/L${c.level}] ${c.text.slice(0, 24)}... `);
    let dOut = "", pOut = "";
    try { dOut = await directCall(MODEL, c.text, c.mode, c.level); } catch (e) { dOut = "(失败:" + e.message + ")"; }
    try {
      const r = await post(port, { text: c.text, mode: c.mode, level: c.level });
      pOut = r.body && r.body.result ? r.body.result : "(失败:" + r.status + ")";
    } catch (e) { pOut = "(异常:" + e.message + ")"; }

    const da = analyze(dOut), pa = analyze(pOut);
    const dHas = da.classical.length > 0, pHas = pa.classical.length > 0;
    if (dHas) directClassical++;
    if (pHas) proxyClassical++;
    if (!dHas && !pHas && dOut && pOut) bothOk++;

    console.log(dHas || pHas ? "⚠" : "✓");
    console.log("      直连: " + dOut + (dHas ? "   ← 文言词:" + da.classical.join(" ") : ""));
    console.log("      代理: " + pOut + (pHas ? "   ← 文言词:" + pa.classical.join(" ") : ""));
  }

  console.log("\n================================");
  console.log(`两边都无文言文: ${bothOk} / ${CASES.length}`);
  console.log(`直连文言文泄漏: ${directClassical}`);
  console.log(`代理文言文泄漏: ${proxyClassical}`);
  console.log(
    (directClassical === 0 && proxyClassical === 0)
      ? "✅ 代理模式与直连模式的风格质量已一致，且都未跑成文言文"
      : "❌ 仍有文言文泄漏"
  );

  server.close();
  process.exit(directClassical === 0 && proxyClassical === 0 ? 0 : 1);
})();
