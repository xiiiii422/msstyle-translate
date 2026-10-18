// 验证 secret.js：无明文 Key、无乱码、能被 WebCrypto 正确解出
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const dir = "D:\\微软式翻译";
const src = fs.readFileSync(path.join(dir, "secret.js"), "utf8");

const out = [];
function ok(name, cond, extra) {
  out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  <- " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

ok("secret.js 不是空的", src.length > 500, src.length + " 字符");
ok("secret.js 没有 U+FFFD 乱码", !src.includes("\uFFFD"));
ok("secret.js 里没有明文 Key", !/[0-9a-f]{32}\.[A-Za-z0-9]{8,}/.test(src));
ok("secret.js 里没有 YOUR_API_KEY 占位符", !src.includes("YOUR_API_KEY"));
ok("secret.js 没有 ESM import（浏览器直接可跑）", !/^\s*import\s/m.test(src));
ok("secret.js 不含 require(", !/\brequire\s*\(/.test(src));

// 用一个假 window 执行，注入 Node 的 WebCrypto
const sandbox = {
  crypto: globalThis.crypto,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  Promise,
  Object,
  console,
};
sandbox.window = sandbox;
sandbox.location = { hostname: "xiiiii422.github.io" };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const vault = sandbox.__MSSTYLE_VAULT__;
ok("暴露了 __MSSTYLE_VAULT__", !!vault);
ok("canAttempt() 在允许的域名下为 true", vault.canAttempt() === true);

(async () => {
  const t0 = Date.now();
  const key = await vault.unlock();
  const ms = Date.now() - t0;
  ok("解锁成功返回了字符串", typeof key === "string" && key.length > 10, String(key && key.length) + " 字符 / " + ms + "ms");
  ok("解出的 Key 符合智谱格式", /^[0-9a-f]{32}\.[A-Za-z0-9]{8,}$/.test(key || ""), (key || "").length + " 字符");
  ok("解密耗时在可接受范围（<1500ms）", ms < 1500, ms + "ms");

  // 再次解锁应命中缓存
  const again = await vault.unlock();
  ok("第二次解锁命中缓存（同一个值）", again === key);

  function runWith(source, host) {
    const sb = { crypto: globalThis.crypto, TextDecoder, TextEncoder, Uint8Array, Promise, Object, console };
    sb.window = sb;
    sb.location = { hostname: host };
    vm.createContext(sb);
    vm.runInContext(source, sb);
    return sb.__MSSTYLE_VAULT__;
  }

  // 篡改掩码 → 解出的字节全乱 → GCM 认证失败
  const tampered = src.replace(/var MASK = \[(\d+),/, (m, n) => "var MASK = [" + ((Number(n) + 1) % 256) + ",");
  ok("篡改脚本确实生效（源码变了）", tampered !== src);
  const bad = await runWith(tampered, "xiiiii422.github.io").unlock();
  ok("密文/掩码被篡改后解不出 Key（认证失败）", bad === null, String(bad));

  // 只改诱饵数字 → 不影响解密（说明诱饵真的被忽略，不是摆设）
  const decoy = src.replace(/var BLOCK = \[(\d+),/, (m, n) => "var BLOCK = [" + ((Number(n) + 7) % 256) + ",");
  const stillOk = await runWith(decoy, "xiiiii422.github.io").unlock();
  ok("改掉诱饵数字不影响解密", stillOk === key);

  // 域名锁
  const deniedVault = runWith(src, "evil.example.com");
  ok("其他域名下 canAttempt() 为 false", deniedVault.canAttempt() === false);
  const denied = await deniedVault.unlock();
  ok("其他域名下解不出 Key", denied === null, String(denied));

  // 没有 WebCrypto（jsdom 等）时安静降级
  const sb4 = { TextDecoder, TextEncoder, Uint8Array, Promise, Object, console };
  sb4.window = sb4;
  sb4.location = { hostname: "localhost" };
  vm.createContext(sb4);
  vm.runInContext(src, sb4);
  ok("没有 crypto.subtle 时 canAttempt() 为 false（安静降级）",
    sb4.__MSSTYLE_VAULT__.canAttempt() === false);

  console.log(out.join("\n"));
  const pass = out.filter((l) => l.startsWith("PASS")).length;
  console.log("\n通过 " + pass + " / " + out.length + (pass === out.length ? "  ✅ 全部通过" : "  ❌ 有失败"));
})();
