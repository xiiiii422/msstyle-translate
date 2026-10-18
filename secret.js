/* ==========================================================================
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

  var ITER = 150000;
  var MASK = [52,205,103,103,36,8,28,9,48,105,222,96,146,60,192,133,42,45,244,138,200,183,182,199];
  var OFF = [208,228,128,145,250,246,118,50,71,202,178,12,47,173,83,118,51,235,122,31,121,36,213,250];
  var BLOCK = [208,113,51,84,66,51,81,211,196,115,170,3,81,188,176,184,42,139,106,225,225,62,189,107,105,248,50,109,66,52,188,239,244,51,237,149,212,16,151,142,231,179,143,209,179,156,68,161,8,5,115,56,9,153,247,66,220,106,236,221,154,110,181,226,60,179,166,15,28,103,221,218,110,95,10,12,154,166,82,58,225,16,253,149,8,242,217,128,133,227,91,181,198,70,110,211,72,17,253,126,108,242,68,238,79,48,226,214,3,81,41,25,26,166,14,167,28,18,11,23,172,92,138,179,47,163,139,249,149,154,179,18,107,60,102,69,244,93,147,130,169,111,229,56,111,214,61,13,9,128,37,24,75,126,54,123,76,15,90,7,10,176,217,187,37,193,28,76,180,2,119,249,175,198];
  var DECK = 37;
  var ORDER = [0,1,2,3,4];
  var LEN = [49,16,12,16,44];

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
