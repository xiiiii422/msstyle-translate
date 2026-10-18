require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 真实验证：Cloudflare Worker 代理能否用真 Key 完成一次真实翻译。
   这是修复 "metrics is not defined" 之后必须做的联网复核 ——
   之前它每次 POST 都会 500，从没成功过一次。 */
const path = require("path");
const { pathToFileURL } = require("url");

const KEY = process.env.TEST_ZHIPU_KEY;
if (!KEY) { console.error("缺少 TEST_ZHIPU_KEY"); process.exit(2); }

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "proxy", "cloudflare-worker.js")).href);
  const env = { ZHIPU_API_KEY: KEY };

  console.log("=== Worker 真实联网翻译 ===\n");
  const cases = [
    { text: "我今天特别开心，因为终于放假了。", mode: "zh", level: 3 },
    { text: "I'm really happy because we finally have a holiday.", mode: "en", level: 3 },
    { text: "这个计划听起来非常不错。", mode: "auto", level: 4 },
  ];

  let ok = 0;
  for (const c of cases) {
    const req = new Request("https://proxy.example/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://site.example" },
      body: JSON.stringify(c),
    });
    let res, body;
    try {
      res = await mod.default.fetch(req, env);
      body = await res.json();
    } catch (e) {
      console.log(`[${c.mode}/L${c.level}] ✗ 抛异常: ${e.message}\n`);
      continue;
    }

    if (res.status === 200 && body.ok) {
      const classical = /[矣焉哉兮]|乃是|终至|吾|汝/.test(body.result);
      console.log(`[${c.mode}/L${c.level}] ${c.text}`);
      console.log(`  -> ${body.result}`);
      console.log(`  模型: ${body.model} | 文言文: ${classical ? "✗ 有" : "✓ 无"}\n`);
      if (!classical) ok++;
    } else {
      console.log(`[${c.mode}/L${c.level}] ✗ HTTP ${res.status} ${JSON.stringify(body)}\n`);
    }
  }

  // 统计接口应可用
  const statsRes = await mod.default.fetch(new Request("https://proxy.example/stats"), env);
  const stats = await statsRes.json();
  console.log("=== /stats ===");
  console.log(`  请求数: ${stats.requests}  成功: ${stats.succeeded}  失败: ${stats.failed}`);
  console.log(`  成功率: ${stats.successRate}  平均耗时: ${stats.avgUpstreamMs}ms`);
  console.log(`  状态码分布: ${JSON.stringify(stats.statusCounts)}`);

  console.log("\n================================");
  console.log(
    ok === cases.length
      ? `✅ Worker 代理 ${ok}/${cases.length} 真实翻译成功，无文言文泄漏`
      : `❌ 仅 ${ok}/${cases.length} 成功`
  );
  process.exit(ok === cases.length ? 0 : 1);
})();
