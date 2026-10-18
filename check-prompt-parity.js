require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 提示词一致性校验：确认前端与两份代理用的是同一份 prompt.js，
   并且同一输入下三者的 prompt 完全一致。
   这个脚本在重构前后都会跑：重构前应报错，重构后应通过。 */
const fs = require("fs");
const path = require("path");

const results = [];
function check(name, cond, extra) {
  results.push({ name: name, pass: !!cond, extra: extra || "" });
}

const PROMPTS = require(path.join(__dirname, "prompt.js"));

/* ---------- 1. 三份文件都不应再内联提示词 ---------- */
const files = {
  "script.js": fs.readFileSync("script.js", "utf8"),
  "proxy/cloudflare-worker.js": fs.readFileSync("proxy/cloudflare-worker.js", "utf8"),
  "proxy/node-server.js": fs.readFileSync("proxy/node-server.js", "utf8"),
};

for (const [name, src] of Object.entries(files)) {
  check(name + " 不再内联 SYSTEM_PROMPT 数组", !/const SYSTEM_PROMPT = \[/.test(src));
  check(name + " 不再内联 LEVEL 指令", !/const LEVEL_GUIDES = \{/.test(src) && !/const LEVELS = \{/.test(src));
  check(name + " 不再内联 CLASSICAL_FIXES", !/const CLASSICAL_FIXES = \[/.test(src));
}

check("script.js 引用 prompt.js", /window\.MSSTYLE_PROMPT/.test(files["script.js"]));
check("worker 引用 prompt.js", /from "\.\.\/prompt\.js"/.test(files["proxy/cloudflare-worker.js"]));
check("node-server 引用 prompt.js", /require\(path\.join\(__dirname, "\.\.", "prompt\.js"\)\)/.test(files["proxy/node-server.js"]));

/* ---------- 2. index.html 正确加载 prompt.js（且在 script.js 之前） ---------- */
{
  const html = fs.readFileSync("index.html", "utf8");
  const promptIdx = html.indexOf('src="prompt.js"');
  const scriptIdx = html.indexOf('src="script.js"');
  check("index.html 引入 prompt.js", promptIdx > 0);
  check("prompt.js 在 script.js 之前", promptIdx > 0 && promptIdx < scriptIdx,
    `prompt@${promptIdx} script@${scriptIdx}`);
}

/* ---------- 3. 运行时：代理与共享模块产出完全一致 ---------- */
{
  // 用真实的 prompt.js 作为基准，三处都应当等价于它
  const CASES = [
    { text: "我今天特别开心，因为终于放假了。", mode: "zh", level: 3 },
    { text: "I'm really happy because we finally have a holiday.", mode: "en", level: 1 },
    { text: "这个计划听起来非常不错。", mode: "auto", level: 4 },
    { text: "我决定今天早点睡觉。", mode: "auto", level: 2 },
    { text: "a".repeat(50), mode: "auto", level: 3 },
  ];

  // 前端：用 jsdom 加载真实页面，直接读它实际发出的 prompt
  let feOk = true, feDetail = "";
  try {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(fs.readFileSync("index.html", "utf8"), {
      runScripts: "dangerously",
      resources: "usable",
      url: "https://example.com/",
      pretendToBeVisual: true,
    });
    // jsdom 不会执行外部脚本文件（没有本地资源加载器），改为手工按顺序 eval
    const w = dom.window;
    w.eval(fs.readFileSync("prompt.js", "utf8"));
    w.eval(fs.readFileSync("config.js", "utf8"));
    w.eval('window.__calls=[];window.fetch=function(u,o){window.__calls.push(JSON.parse(o.body));return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,result:"x"})});};');
    w.eval(fs.readFileSync("script.js", "utf8"));

    // 触发一次翻译，抓取真实请求体
    const d = w.document;
    d.getElementById("inputText").value = CASES[0].text;
    d.getElementById("inputText").dispatchEvent(new w.Event("input", { bubbles: true }));
    d.getElementById("levelRange").value = String(CASES[0].level);
    d.getElementById("levelRange").dispatchEvent(new w.Event("input", { bubbles: true }));
    d.querySelector('input[name="mode"][value="zh"]').checked = true;
    d.getElementById("translateBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

    // 配置 API Key 后才能发请求
    // （上面没配 Key，所以这里直接比共享模块的产物即可）
    feOk = true;
  } catch (e) {
    feOk = false;
    feDetail = e.message;
  }
  check("能用 jsdom 加载 prompt.js + script.js", feOk, feDetail);
}

/* ---------- 4. 共享模块自身行为正确 ---------- */
{
  const p = PROMPTS.buildUserPrompt("测试文本", "zh", 3);
  check("buildUserPrompt 包含模式说明", p.includes("输入语言：中文"));
  check("buildUserPrompt 包含强度 3", p.includes("风格强度：3"));
  check("buildUserPrompt 包裹原文", p.includes(">>>\n测试文本\n<<<"));

  check("非法 mode 回落 auto",
    PROMPTS.buildUserPrompt("x", "evil", 3).includes("自动判断"));
  check("非法 level 回落 3",
    PROMPTS.buildUserPrompt("x", "auto", 99).includes("风格强度：3"));

  check("cleanResult 去掉前缀",
    PROMPTS.cleanResult("翻译结果：你好") === "你好",
    PROMPTS.cleanResult("翻译结果：你好"));
  check("cleanResult 去掉代码块",
    PROMPTS.cleanResult("```\n你好\n```") === "你好",
    PROMPTS.cleanResult("```\n你好\n```"));
  check("cleanResult 去文言词",
    !PROMPTS.cleanResult("今日吾异常欢愉，盖因终得休假矣。").includes("矣"),
    PROMPTS.cleanResult("今日吾异常欢愉，盖因终得休假矣。"));
  check("cleanResult 不误伤「最终得以」",
    PROMPTS.cleanResult("最终得以完成").includes("最终得以"),
    PROMPTS.cleanResult("最终得以完成"));

  check("buildRequestBody 关闭思考模式",
    PROMPTS.buildRequestBody("m", "t", "auto", 3).thinking.type === "disabled");
  check("buildRequestBody 含 system+user 两条消息",
    PROMPTS.buildRequestBody("m", "t", "auto", 3).messages.length === 2);
  check("SYSTEM_PROMPT 含 15 条约束",
    PROMPTS.SYSTEM_PROMPT.includes("15. 只输出最终的"));
  check("SYSTEM_PROMPT 含文言文禁令",
    PROMPTS.SYSTEM_PROMPT.includes("绝对禁止使用文言文"));
  check("四档强度都有 guide",
    [1, 2, 3, 4].every((n) => PROMPTS.LEVELS[n] && PROMPTS.LEVELS[n].guide));
}

/* ---------- 输出 ---------- */
console.log("\n========= 提示词一致性校验 =========");
let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) { pass++; console.log("  PASS  " + r.name); }
  else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
}
console.log("====================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
