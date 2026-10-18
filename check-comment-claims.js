/* 核对代码注释里的「技术声称」
 *
 * 上一轮核对了 README 里的数字声明，找出 3 处过期。
 * 同样的思路：**代码注释里的技术断言，同样没人验证过。**
 *
 * 例如 script.js 里写着：
 *   "依次尝试：当前选用的模型 + 备用模型（去重，避免重复请求同一个模型）"
 * 如果去重逻辑被改坏了，注释不会报错 —— 但行为已经和声称不符。
 *
 * 这个脚本把可机械验证的注释声称逐条变成断言。
 */
require("./check-integrity.js");

const fs = require("fs");
const path = require("path");

const dir = __dirname;
const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const script = fs.readFileSync(path.join(dir, "script.js"), "utf8");
const promptSrc = fs.readFileSync(path.join(dir, "prompt.js"), "utf8");

/* ============ 1. "去重，避免重复请求同一个模型" ============ */
{
  const claims = /备用模型（去重，避免重复请求同一个模型）/.test(script);
  const dedupLogic = /\.filter\(function \(m, i, arr\) \{ return m && arr\.indexOf\(m\) === i; \}\)/.test(script);
  check("注释声称「去重避免重复请求同一模型」", claims,
    claims ? "" : "找不到这句注释");
  check("去重逻辑确实存在（与注释一致）", dedupLogic,
    dedupLogic ? "" : "注释说有去重，代码里找不到");
}

/* ============ 2. "使用 textContent 而不是 innerHTML，避免 XSS" ============ */
{
  const usesTextContent = /p\.textContent = text;/.test(script);
  // 找所有把"外部内容"写进 DOM 的地方
  const innerHtmlWithVar = [...script.matchAll(/(\w+)\.innerHTML\s*=\s*([^;]+);/g)]
    .filter((m) => !/^\s*""\s*$/.test(m[2]));
  check("注释声称「用 textContent 避免 XSS」", /使用 textContent 而不是 innerHTML/.test(script));
  check("输出结果确实走 textContent", usesTextContent);
  check("没有用 innerHTML 写入非空内容",
    innerHtmlWithVar.length === 0,
    innerHtmlWithVar.map((m) => m[0].slice(0, 60)).join(" | "));
}

/* ============ 3. "所有读写都必须包一层，否则整个页面会挂掉" ============ */
{
  // 声称：localStorage 的读写全部经过 safeStorage
  const directLocalStorage = [...script.matchAll(/(?<!safeStorage\.)(?<!\.)\blocalStorage\.(get|set|remove)Item/g)];
  check("注释声称「localStorage 读写都包了一层」", /所有读写都必须包一层/.test(script));
  check("确实没有绕过 safeStorage 直接读写 localStorage",
    directLocalStorage.length === 0,
    directLocalStorage.map((m) => m[0]).join(", "));
}

/* ============ 4. "过期请求的失败同样丢弃" ============ */
{
  const hasSeqGuard = /if \(seq !== state\.requestSeq\) return;/.test(script);
  const count = (script.match(/if \(seq !== state\.requestSeq\) return;/g) || []).length;
  check("注释声称「过期响应/失败都丢弃」", /过期响应|过期请求/.test(script));
  check("请求序号守卫至少出现在成功与失败两条路径",
    count >= 2, `出现 ${count} 次（期望 >= 2）`);
}

/* ============ 5. "先判具体状态码，再落到 allModelsBusy 兜底" ============ */
{
  const idx429 = script.indexOf('if (err && err.status === 429)');
  const idx5xx = script.indexOf('if (err && err.status >= 500)');
  const idxBusy = script.indexOf('if (err && err.allModelsBusy)');
  check("注释声称「具体状态码先于 allModelsBusy 兜底」",
    /先判具体状态码，再落到 allModelsBusy 兜底/.test(script));
  check("429 判断确实在 allModelsBusy 之前",
    idx429 > 0 && idxBusy > 0 && idx429 < idxBusy,
    `429@${idx429} busy@${idxBusy}`);
  check("5xx 判断确实在 allModelsBusy 之前",
    idx5xx > 0 && idxBusy > 0 && idx5xx < idxBusy,
    `5xx@${idx5xx} busy@${idxBusy}`);
}

/* ============ 6. "确保总等待不超过 TOTAL_TIMEOUT" ============ */
{
  const hasDeadline = /const deadline = Date\.now\(\) \+ CONFIG\.TOTAL_TIMEOUT/.test(script);
  const checksRemaining = /const remaining = deadline - Date\.now\(\)/.test(script);
  check("注释声称「硬上限，用户等待不会超过 TOTAL_TIMEOUT」",
    /这是\*\*硬上限\*\*|硬上限/.test(script));
  check("deadline 机制确实存在", hasDeadline && checksRemaining,
    `deadline=${hasDeadline} remaining=${checksRemaining}`);
}

/* ============ 7. "关闭思考模式" ============ */
{
  const hasThinking = /thinking = \{ type: "disabled" \}/.test(promptSrc) ||
                      /thinking: \{ type: "disabled" \}/.test(promptSrc);
  check("注释声称「关闭思考模式」", /关闭"思考模式"|关闭思考模式|THINKING_DISABLED/.test(promptSrc));
  check("请求体里确实带了 thinking: disabled", hasThinking);
}

/* ============ 8. "三个脚本都用 defer，保持执行顺序" ============ */
{
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"([^>]*)>/g)];
  const allDefer = scripts.every((m) => /defer/.test(m[2]));
  const order = scripts.map((m) => m[1]);
  const promptIdx = order.indexOf("prompt.js");
  const scriptIdx = order.indexOf("script.js");

  check("注释声称「三个脚本都用 defer，保持执行顺序」",
    /都用 defer，保持执行顺序/.test(html));
  check("所有外部脚本确实都带 defer", allDefer,
    scripts.map((m) => m[1] + (/defer/.test(m[2]) ? "(defer)" : "(无)")).join(", "));
  check("prompt.js 确实排在 script.js 之前",
    promptIdx >= 0 && scriptIdx >= 0 && promptIdx < scriptIdx,
    `prompt@${promptIdx} script@${scriptIdx}`);
}

/* ============ 9. "去不掉最后一个斜杠" 之类的 URL 处理 ============ */
{
  check("注释声称会去掉 PROXY_URL 尾部斜杠",
    /去掉尾部斜杠/.test(script));
  // 注意：这里匹配的是源码文本里的正则字面量 /\/+$/，
  // 在 JS 字符串里写正则时要多一层转义，容易被自己写错（本次第一版就写错了）。
  const slashRe = script.indexOf("replace(/\\/+$/, \"\")") >= 0;
  check("确实有去掉尾部斜杠的处理", slashRe,
    slashRe ? "" : "找不到 replace(/\\/+$/, \"\")");
}

/* ============ 10. 注释里提到的函数/常量是否都还存在 ============ */
{
  // 抽取注释里用反引号或直接提到的函数名
  const mentioned = new Set();
  for (const m of script.matchAll(/`([a-zA-Z_$][\w$]*)\s*\(\)`/g)) mentioned.add(m[1]);
  const missing = [...mentioned].filter((fn) => {
    // 该函数名是否在代码里被定义
    const re = new RegExp("(function\\s+" + fn + "\\b|\\b" + fn + "\\s*[:=]\\s*function|\\b" + fn + "\\s*\\()");
    return !re.test(script);
  });
  check("注释里提到的函数都真实存在",
    missing.length === 0,
    missing.length ? "注释提到但代码里没有: " + missing.join(", ") : `${mentioned.size} 个函数`);
}

/* ---------- 输出 ---------- */
console.log("\n======== 代码注释里的技术声称核对 ========");
let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) { pass++; console.log("  PASS  " + r.name); }
  else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
}
console.log("=========================================");
console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
process.exit(fail ? 1 : 0);
