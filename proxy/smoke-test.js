#!/usr/bin/env node
/**
 * 部署后冒烟自检 —— 运维在部署完成后跑一次，确认线上真的能用。
 *
 * 用法：
 *   node proxy/smoke-test.js https://your-site.com
 *   node proxy/smoke-test.js https://your-site.com --proxy https://xxx.workers.dev
 *   node proxy/smoke-test.js https://your-site.com --skip-translate   # 不消耗额度
 *
 * 检查项：
 *   1. 静态资源可访问（index.html / style.css / script.js / 图标 / 合规页）
 *   2. 首页关键元数据齐全（title / description / og:image / lang）
 *   3. 安全响应头是否下发（CSP / X-Content-Type-Options / Referrer-Policy 等）
 *   4. 代理健康检查 /health
 *   5. 真实翻译一次（验证 Key 配好、模型可用）—— 可用 --skip-translate 跳过
 *   6. 输入校验是否生效（超长输入应被拒）
 *   7. /stats 是否被正确保护
 *
 * 退出码：0 = 全部通过，1 = 有失败项
 */

const target = process.argv[2];
if (!target || !/^https?:\/\//.test(target)) {
  console.error("用法: node proxy/smoke-test.js <站点地址> [--proxy <代理地址>] [--skip-translate]");
  process.exit(2);
}

const args = process.argv.slice(3);
const proxyArgIdx = args.indexOf("--proxy");
const PROXY_URL = proxyArgIdx >= 0 ? args[proxyArgIdx + 1] : null;
const SKIP_TRANSLATE = args.includes("--skip-translate");

const base = target.replace(/\/+$/, "");
const proxyBase = (PROXY_URL || base).replace(/\/+$/, "");
// 同源代理时前端用的是 /api 前缀
const proxyPaths = PROXY_URL ? ["", "/api"] : ["/api", ""];

const results = [];
function record(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || "" });
  const mark = pass ? "  ✓" : "  ✗";
  console.log(mark + " " + name + (detail && !pass ? "  <- " + detail : ""));
}

async function tryFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal }, opts || {}));
    return res;
  } catch (e) {
    return { ok: false, status: 0, _error: e.message, headers: new Map(),
             text: async () => "", json: async () => null };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log("冒烟自检目标: " + base + (PROXY_URL ? "  代理: " + proxyBase : ""));
  console.log("=".repeat(64));

  /* ---------- 1. 静态资源 ---------- */
  console.log("\n[1] 静态资源");
  const assets = [
    ["首页", "/index.html"],
    ["样式", "/style.css"],
    ["脚本", "/script.js"],
    ["提示词模块", "/prompt.js"],
    ["图标", "/icon.svg"],
    ["隐私说明", "/privacy.html"],
    ["使用条款", "/terms.html"],
    ["分享图", "/og-image.png"],
    ["PWA 清单", "/manifest.webmanifest"],
  ];
  for (const [label, p] of assets) {
    const r = await tryFetch(base + p);
    record(label + " " + p, r.ok, "HTTP " + r.status + (r._error ? " " + r._error : ""));
  }

  /* ---------- 2. 首页元数据 ---------- */
  console.log("\n[2] 首页 SEO / 分享元数据");
  const home = await tryFetch(base + "/");
  const html = home.ok || home.status === 200 ? await home.text() : "";
  if (!html) {
    record("首页可读取", false, "HTTP " + home.status);
  } else {
    record("首页可读取", true);
    record("有 <title>", /<title>[^<]+<\/title>/.test(html));
    record("有 meta description", /name="description"\s+content="[^"]+"/.test(html));
    record("有 lang 属性", /<html[^>]+lang=/.test(html));
    record("有 og:image", /property="og:image"/.test(html));
    record("有 viewport", /name="viewport"/.test(html));

    // 占位域名检查（上线前必须替换）
    const hasPlaceholder = html.includes("your-domain.example");
    record("域名占位符已替换", !hasPlaceholder,
      hasPlaceholder ? "index.html 里仍是 your-domain.example，分享图会裂、SEO 会归零" : "");

    // 旧的 example.com 检查
    const hasExample = /og:(url|image)"\s+content="https:\/\/example\.com/.test(html);
    record("未残留 example.com 占位符", !hasExample);
  }

  /* ---------- 3. 安全响应头 ---------- */
  console.log("\n[3] 安全响应头");
  const h = home.headers || new Map();
  const getH = (k) => (h.get ? h.get(k) : null);
  record("X-Content-Type-Options", getH("x-content-type-options") === "nosniff",
    String(getH("x-content-type-options")));
  record("Referrer-Policy", !!getH("referrer-policy"), String(getH("referrer-policy")));
  record("Content-Security-Policy", !!getH("content-security-policy"),
    "未下发 CSP（静态托管需配置 _headers 或 CDN 响应头）");
  record("X-Frame-Options", !!getH("x-frame-options"), "未下发，存在点击劫持风险");

  /* ---------- 4. 代理健康检查 ---------- */
  console.log("\n[4] 翻译服务");
  let healthOk = false;
  for (const prefix of proxyPaths) {
    const r = await tryFetch(proxyBase + prefix + "/health");
    if (r.ok) {
      let body = null;
      try { body = await r.json(); } catch (_) {}
      healthOk = !!(body && body.ok);
      record("代理健康检查 " + prefix + "/health", healthOk,
        healthOk ? "" : "返回体异常: " + JSON.stringify(body));
      if (healthOk) break;
    }
  }
  if (!healthOk) {
    console.log("      （没有可用代理 → 说明是纯静态直连模式，访客需自己填 Key）");
  }

  /* ---------- 5. 真实翻译 ---------- */
  console.log("\n[5] 端到端翻译");
  if (SKIP_TRANSLATE) {
    console.log("  - 已按 --skip-translate 跳过（不消耗 API 额度）");
  } else if (!healthOk) {
    console.log("  - 无代理，跳过（直连模式需要浏览器端 Key，无法在命令行验证）");
  } else {
    let translateOk = false;
    for (const prefix of proxyPaths) {
      const r = await tryFetch(proxyBase + prefix + "/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "我今天特别开心，因为终于放假了。", mode: "zh", level: 3 }),
      });
      if (r.status === 0) continue;
      let body = null;
      try { body = await r.json(); } catch (_) {}

      if (r.ok && body && body.ok && body.result) {
        const hasCJK = /[\u4e00-\u9fa5]/.test(body.result);
        const classical = /[矣焉哉兮]|乃是|终至|吾|汝/.test(body.result);
        record("真实翻译成功", hasCJK, "结果: " + body.result);
        record("输出是现代白话（无文言文）", !classical,
          classical ? "出现文言词: " + body.result : "");
        translateOk = true;
        break;
      } else if (r.status === 401) {
        record("真实翻译成功", false, "401：服务端 API Key 无效");
        break;
      } else if (r.status === 429) {
        record("真实翻译成功", false, "429：被限流（可能是刚才自检触发的，稍后重试）");
        break;
      } else if (r.status === 500) {
        record("真实翻译成功", false,
          "500：" + ((body && body.message) || "服务端未配置 API Key"));
        break;
      }
    }
    if (!translateOk) record("真实翻译成功", false, "没有可用的翻译端点");
  }

  /* ---------- 6. 输入校验 ---------- */
  console.log("\n[6] 输入校验");
  if (healthOk) {
    let checked = false;
    for (const prefix of proxyPaths) {
      const r = await tryFetch(proxyBase + prefix + "/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(5000) }),
      });
      if (r.status === 0) continue;
      record("超长输入被拒绝", r.status === 400, "HTTP " + r.status);
      checked = true;
      break;
    }
    if (!checked) record("超长输入被拒绝", false, "无法连接");
  } else {
    console.log("  - 无代理，跳过");
  }

  /* ---------- 7. 统计接口保护 ---------- */
  console.log("\n[7] 运维接口");
  if (healthOk) {
    let probed = false;
    for (const prefix of proxyPaths) {
      const r = await tryFetch(proxyBase + prefix + "/stats");
      if (r.status === 0) continue;
      // 403 = 已保护；200 = 公开可读（需要部署者确认是否有意为之）
      record("/stats 已保护或可读", r.status === 403 || r.status === 200, "HTTP " + r.status);
      if (r.status === 200) {
        console.log("      ⚠️  /stats 可被公网读取，确认这是有意的（Worker 可设 STATS_TOKEN）");
      }
      probed = true;
      break;
    }
    if (!probed) record("/stats 可访问性", false, "无法连接");
  } else {
    console.log("  - 无代理，跳过");
  }

  /* ---------- 汇总 ---------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log("\n" + "=".repeat(64));
  console.log("冒烟自检结果: " + pass + " / " + results.length +
    (fail ? "    ❌ " + fail + " 项失败" : "    ✅ 全部通过"));

  if (fail) {
    console.log("\n失败项：");
    results.filter((r) => !r.pass).forEach((r) => {
      console.log("  · " + r.name + (r.detail ? "  — " + r.detail : ""));
    });
  }
  process.exit(fail ? 1 : 0);
})();
