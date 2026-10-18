/* ==========================================================================
 * make-secret.js —— 生成 secret.js（内置 Key 的密文容器）
 *
 * 用法（Key 与口令都从环境变量读，不进版本库、不落盘）：
 *
 *   $env:ZHIPU_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"
 *   node make-secret.js > secret.js
 *
 * 或者同时指定一个固定口令（不指定则每次随机生成）：
 *
 *   $env:ZHIPU_KEY="..."
 *   $env:VAULT_PASS="your-passphrase"
 *   node make-secret.js > secret.js
 *
 * 它做的事：
 *   1. 用 PBKDF2-HMAC-SHA256（150000 轮）+ 随机盐，从口令派生 AES-256 密钥
 *   2. 用 AES-256-GCM 加密真实 Key，得到密文 + 认证标签 + 随机 IV
 *   3. 把「密文 / IV / 盐 / 口令」全部按字节打散、做偏移与异或，
 *      再和诱饵数字混在同一个数组里，输出成纯数字的 secret.js
 *
 * 生成结果里**没有明文 Key**，也没有明文口令。
 * 想换 Key：重跑一次，覆盖 secret.js 即可。
 *
 * ⚠️ 安全边界（请务必理解）：
 *    纯前端不存在真正的密钥保护 —— 浏览器最终必须还原出明文才能调用接口，
 *    所以任何混淆都挡不住专门逆向的人（在 fetch 上打断点就能拿到）。
 *    这一层能挡住的是：随手查看源代码、GitHub 密钥扫描、复制页面到别的域名。
 *    要真正安全只有一条路：把 Key 放到服务端代理（见 proxy/ 目录）。
 * ========================================================================== */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEY = process.env.ZHIPU_KEY;
if (!KEY) {
  console.error("缺少环境变量 ZHIPU_KEY。示例：$env:ZHIPU_KEY=\"xxxx.yyyy\"");
  process.exit(1);
}
if (!/^[0-9a-f]{16,64}\.[A-Za-z0-9]{8,64}$/.test(KEY.trim())) {
  console.error("ZHIPU_KEY 格式看起来不像智谱的 Key（应为 id.secret 两段）。已中止。");
  process.exit(1);
}

const PASS =
  process.env.VAULT_PASS ||
  Array.from({ length: 44 }, () =>
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(
      crypto.randomBytes(1)[0] % 62
    )
  ).join("");

const PBKDF2_ITER = 150000;

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const aesKey = crypto.pbkdf2Sync(Buffer.from(PASS, "utf8"), salt, PBKDF2_ITER, 32, "sha256");

const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
const ct = Buffer.concat([cipher.update(Buffer.from(KEY.trim(), "utf8")), cipher.final()]);
const tag = cipher.getAuthTag(); // 16 字节认证标签，篡改密文会导致解密失败

/* --------------------------------------------------------------------------
 * 打散：把每个字节变成 (b XOR mask) + 偏移，再把所有片段交错塞进一个数组。
 * 交错的好处：密文不是连续的一段，肉眼扫过去看不出边界。
 * ------------------------------------------------------------------------ */
const MASK = Array.from(crypto.randomBytes(24));
const OFF = Array.from(crypto.randomBytes(24));

function pack(buf, saltIndex) {
  return Array.from(buf).map((b, i) => {
    const j = (i + saltIndex) % MASK.length;
    return ((b ^ MASK[j]) + OFF[j]) & 0xff;
  });
}

const chunks = {
  ct: pack(ct, 0),
  tag: pack(tag, 7),
  iv: pack(iv, 13),
  salt: pack(salt, 19),
  pass: pack(Buffer.from(PASS, "utf8"), 3),
};

// 交错合并：按轮次从每个片段里各取一个字节，前面插诱饵数字
const lengths = {};
let total = 0;
for (const k of Object.keys(chunks)) {
  lengths[k] = chunks[k].length;
  total += chunks[k].length;
}
const DECK = 37; // 诱饵数量
const flat = [];
const cursors = {};
for (const k of Object.keys(chunks)) cursors[k] = 0;
const order = Object.keys(chunks);
let guard = 0;
while (flat.length < DECK + total && guard++ < 100000) {
  if (flat.length < DECK) {
    flat.push(crypto.randomBytes(1)[0]);
    continue;
  }
  for (const k of order) {
    if (cursors[k] < lengths[k]) {
      flat.push(chunks[k][cursors[k]++]);
    }
  }
}

/* 片段在 flat 里的位置说明：因为诱饵固定在最前，之后按 order 轮流取字节，
   解包时用同样的规则即可还原。这里把「每片的长度」也一起写出去。 */
const layout = {
  deck: DECK,
  order: order,
  lengths: lengths,
};

const num = (arr) => "[" + arr.join(",") + "]";

const out = `/* ==========================================================================
 * secret.js —— 内置 Key 的密文容器（由 make-secret.js 生成，请勿手改）
 *
 * 这里没有任何明文 Key。真实 Key 是 AES-256-GCM 密文，
 * 密钥由页面在运行时用 PBKDF2 从口令派生，口令本身也被打散成数字。
 *
 * 想换 Key：重跑 make-secret.js 覆盖本文件。
 * 想了解安全边界：见 README「内置 Key 的安全边界」。
 * ========================================================================== */
(function (root) {
  "use strict";

  /* 允许解密的站点。复制本页面到其他域名时，Key 在这里就解不开。 */
  var ALLOW_HOSTS = ["localhost", "127.0.0.1", "[::1]", ""];
  var ALLOW_SUFFIX = [".github.io", ".pages.dev", ".vercel.app", ".netlify.app"];

  var ITER = ${PBKDF2_ITER};
  var MASK = ${num(MASK)};
  var OFF = ${num(OFF)};
  var BLOCK = ${num(flat)};
  var DECK = ${layout.deck};
  var ORDER = ${num(order.map((o) => ["ct", "tag", "iv", "salt", "pass"].indexOf(o)))};
  var LEN = ${num(order.map((o) => lengths[o]))};

  function hostAllowed(host) {
    host = String(host || "").toLowerCase();
    for (var i = 0; i < ALLOW_HOSTS.length; i++) {
      if (host === ALLOW_HOSTS[i]) return true;
    }
    for (var j = 0; j < ALLOW_SUFFIX.length; j++) {
      if (host.length > ALLOW_SUFFIX[j].length &&
          host.slice(-ALLOW_SUFFIX[j].length) === ALLOW_SUFFIX[j]) {
        return true;
      }
    }
    return false;
  }

  /* 还原交错数组：按 ORDER 轮流取字节，每片的长度在 LEN 里 */
  function unpack() {
    var out = [[], [], [], [], []];
    var cursor = [0, 0, 0, 0, 0];
    var pos = DECK;
    var remaining = 0;
    for (var i = 0; i < LEN.length; i++) remaining += LEN[i];
    var guard = 0;
    while (remaining > 0 && guard++ < 200000) {
      for (var o = 0; o < ORDER.length; o++) {
        var slot = ORDER[o];
        if (cursor[slot] < LEN[o]) {
          out[slot].push(BLOCK[pos++]);
          cursor[slot]++;
          remaining--;
        }
      }
    }
    return out;
  }

  function decode(nums, saltIndex) {
    var bytes = new Uint8Array(nums.length);
    for (var i = 0; i < nums.length; i++) {
      var j = (i + saltIndex) % MASK.length;
      bytes[i] = (((nums[i] - OFF[j]) & 0xff) ^ MASK[j]) & 0xff;
    }
    return bytes;
  }

  var cached = null;
  var pending = null;

  function canAttempt() {
    if (typeof root.crypto === "undefined" || !root.crypto.subtle) return false;
    var host = "";
    try { host = root.location && root.location.hostname; } catch (e) { host = ""; }
    return hostAllowed(host);
  }

  function unlock() {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;
    if (!canAttempt()) return Promise.resolve(null);

    pending = (function () {
      var C = root.crypto;
      var parts = unpack();
      var iv = decode(parts[2], 13);
      var salt = decode(parts[3], 19);
      var tag = decode(parts[1], 7);
      var ct = decode(parts[0], 0);
      var pass = new root.TextDecoder().decode(decode(parts[4], 3));

      return C.subtle
        .importKey("raw", new root.TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"])
        .then(function (base) {
          return C.subtle.deriveBits(
            { name: "PBKDF2", salt: salt, iterations: ITER, hash: "SHA-256" },
            base, 256
          );
        })
        .then(function (bits) {
          return C.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
        })
        .then(function (key) {
          var joined = new Uint8Array(ct.length + tag.length);
          joined.set(ct, 0);
          joined.set(tag, ct.length);
          return C.subtle.decrypt({ name: "AES-GCM", iv: iv, tagLength: 128 }, key, joined);
        })
        .then(function (plain) {
          cached = new root.TextDecoder().decode(plain);
          return cached;
        })
        .catch(function () {
          pending = null;
          return null;
        });
    })();

    return pending;
  }

  var api = { version: 1, canAttempt: canAttempt, unlock: unlock };
  try { Object.freeze(api); } catch (e) { /* 老浏览器忽略 */ }
  root.__MSSTYLE_VAULT__ = api;
})(typeof window !== "undefined" ? window : globalThis);
`;

// 传了第二个参数就直接写文件（避免 PowerShell 重定向带来的 BOM / 编码问题）
const outPath = process.argv[2];
if (outPath) {
  fs.writeFileSync(path.resolve(process.cwd(), outPath), out, "utf8");
  console.error("已写入 " + outPath + "（" + out.length + " 字符，无明文 Key）");
} else {
  process.stdout.write(out);
}
