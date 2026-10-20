/* 线上验证：确认部署产物带上了新的档位阶梯与草稿逻辑，
   并用真实接口跑一遍四档，看标记是否逐档出现。 */
const vm = require("vm");
const BASE = "https://xiiiii422.github.io/msstyle-translate/";

const out = [];
function ok(name, cond, extra) {
  out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  <- " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const promptSrc = await (await fetch(BASE + "prompt.js?v=2")).text();
  const scriptSrc = await (await fetch(BASE + "script.js?v=2")).text();
  const secretSrc = await (await fetch(BASE + "secret.js?v=2")).text();

  /* 1. 线上 prompt.js 带上了新阶梯 */
  ok("线上 prompt.js 有「被」字档位标记", promptSrc.includes("恰好 1 处「被」字硬译被动句"));
  ok("线上 prompt.js 有括号档位标记", promptSrc.includes("恰好 1 处「括号补充强调」"));
  ok("线上 prompt.js 温度表上限是 1.0", promptSrc.includes("4: 1.0 }"));
  ok("线上 prompt.js 有通用硬约束段", promptSrc.includes("所有档位通用的硬约束"));
  ok("线上 prompt.js 有叠字清洗", promptSrc.includes("是是"));

  /* 2. 线上 script.js 带上了草稿 */
  ok("线上 script.js 有草稿键", scriptSrc.includes("msstyle_translate_draft_v1"));
  ok("线上 script.js 有结果揭示", scriptSrc.includes("function revealResult"));

  /* 3. 内置 Key 仍可解密 */
  const sb = {
    crypto: globalThis.crypto, TextDecoder, TextEncoder, Uint8Array,
    Promise, Object, console, location: { hostname: "xiiiii422.github.io" },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(secretSrc, sb);
  const key = await sb.__MSSTYLE_VAULT__.unlock();
  ok("线上 secret.js 能解出 Key", typeof key === "string" && key.length > 10);
  ok("secret.js 无明文 Key", !/[0-9a-f]{32}\.[A-Za-z0-9]{8,}/.test(secretSrc));

  /* 4. 真跑四档，检查标记逐档出现 */
  const P = require("D:\\微软式翻译\\prompt.js");
  const SRC = "我今天特别开心，因为终于放假了。";
  const got = {};
  for (const lv of [1, 2, 3, 4]) {
    const body = P.buildRequestBody("glm-4-flash-250414", SRC, "auto", lv);
    const t0 = Date.now();
    const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
    });
    if (!res.ok) { ok(`L${lv} 请求成功`, false, "HTTP " + res.status + " " + (await res.text()).slice(0, 90)); continue; }
    const j = await res.json();
    got[lv] = P.cleanResult(j.choices[0].message.content);
    console.log(`  L${lv} (${Date.now() - t0}ms): ${got[lv]}`);
  }

  ok("四档输出互不相同", new Set(Object.values(got)).size === Object.keys(got).length,
    Object.keys(got).length + " 档");
  ok("L1 不含「是……的」框架", !/是有|是终于|是高/.test(got[1] || ""), got[1]);
  ok("L2 出现「是……的」", /是[^，。]{1,12}的/.test(got[2] || ""), got[2]);
  ok("L3 出现括号强调", /（.+）/.test(got[3] || ""), got[3]);
  ok("L4 出现「被」字被动句", /被/.test(got[4] || ""), got[4]);
  for (const lv of [1, 2, 3, 4]) {
    const len = (got[lv] || "").length;
    const max = P.maxLengthFor(lv, SRC.length);
    ok(`L${lv} 长度未超本档上限（${len} ≤ ${max}）`, len <= max);
    ok(`L${lv} 无文言文`, !/[吾亦矣焉哉汝]/.test(got[lv] || ""));
  }

  console.log("\n" + out.join("\n"));
  const pass = out.filter((l) => l.startsWith("PASS")).length;
  console.log("\n线上验证 通过 " + pass + " / " + out.length
    + (pass === out.length ? "  ✅" : "  ❌"));
})();
