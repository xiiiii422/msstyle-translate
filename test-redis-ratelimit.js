require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 用假的 ioredis 验证 Redis 限流分支的**命令用法**是否正确。
   本机没有 Redis 服务器，所以这里不测真实网络，
   而是精确复刻 Redis 的 INCR / PEXPIRE / PTTL 语义，
   验证「固定窗口计数」的实现正确、且是多实例共享的。 */
const path = require("path");
const http = require("http");
const Module = require("module");

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

/* ---------- 假 Redis：实现 INCR / PEXPIRE / PTTL，带单线程原子性 ---------- */
const fakeDb = new Map();      // key -> { value, expireAt }
const commandLog = [];

class FakeRedis {
  constructor(url, opts) {
    this.url = url;
    this.handlers = {};
    // 立即"连接成功"
    setTimeout(() => this.emit("ready"), 0);
  }
  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
  emit(evt, arg) { (this.handlers[evt] || []).forEach((f) => f(arg)); }

  _get(k) {
    const e = fakeDb.get(k);
    if (!e) return null;
    if (e.expireAt && Date.now() > e.expireAt) { fakeDb.delete(k); return null; }
    return e;
  }

  async incr(key) {
    commandLog.push(["incr", key]);
    const e = this._get(key);
    if (!e) {
      fakeDb.set(key, { value: 1, expireAt: null });
      return 1;
    }
    e.value += 1;
    return e.value;
  }

  async pexpire(key, ms) {
    commandLog.push(["pexpire", key, ms]);
    const e = this._get(key);
    if (!e) return 0;
    e.expireAt = Date.now() + ms;
    return 1;
  }

  async pttl(key) {
    commandLog.push(["pttl", key]);
    const e = this._get(key);
    if (!e) return -2;
    if (!e.expireAt) return -1;
    return e.expireAt - Date.now();
  }

  async quit() { this.emit("end"); }
}

/* ---------- 把假 ioredis 注入 require 缓存 ---------- */
const fakeIoredisPath = path.join(__dirname, "_fake_ioredis.js");
require.cache[fakeIoredisPath] = {
  id: fakeIoredisPath, filename: fakeIoredisPath, loaded: true,
  exports: FakeRedis,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "ioredis") return fakeIoredisPath;
  return origResolve.call(this, request, ...rest);
};

/* ---------- 环境 ---------- */
process.env.ZHIPU_API_KEY = "redis.test.key";
process.env.ALLOWED_ORIGINS = "*";
process.env.LOG_LEVEL = "off";
process.env.RATE_LIMIT_STORE = "redis";
process.env.REDIS_URL = "redis://fake:6379";
process.env.RATE_LIMIT_MAX = "5";

global.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: "Redis 限流测试结果" } }] }),
});

const app = require(path.join(__dirname, "proxy", "node-server.js"));

function post(port, text, ip) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
    if (ip) headers["X-Forwarded-For"] = ip;
    const r = http.request({ host: "127.0.0.1", port, path: "/translate", method: "POST", headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    r.on("error", reject); r.write(data); r.end();
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(30);   // 等 fake ready 事件

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  /* ---------- 1. 存储类型正确上报 ---------- */
  {
    const info = app.__rateStoreInfo();
    check("配置 redis 后使用 redis 存储", info.name === "redis", info.name);
    check("redis 存储标记为分布式", info.distributed === true, String(info.distributed));

    const st = await get(port, "/stats");
    check("/stats 显示限流为分布式", st.body.rateLimitDistributed === true,
      String(st.body.rateLimitDistributed));
    check("/stats 显示存储名为 redis", st.body.rateLimitStore === "redis", st.body.rateLimitStore);
  }

  /* ---------- 2. 限流真的生效（走 Redis 计数） ---------- */
  {
    app.__resetMetrics();
    const ip = "198.51.100.1";
    let ok = 0, limited = 0, last429 = null;

    for (let i = 0; i < 8; i++) {
      const r = await post(port, "redis 限流 " + i, ip);
      if (r.status === 200) ok++;
      else if (r.status === 429) { limited++; if (!last429) last429 = r; }
    }

    check("Redis 限流：限额内 5 次放行", ok === 5, "ok=" + ok);
    check("Redis 限流：超出的 3 次被拒", limited === 3, "429=" + limited);
    check("Redis 限流：429 带 Retry-After", !!last429 && !!last429.headers["retry-after"],
      last429 && last429.headers["retry-after"]);
    check("Redis 限流：使用 INCR 计数", commandLog.some((c) => c[0] === "incr"));
    check("Redis 限流：首次计数设置了过期", commandLog.some((c) => c[0] === "pexpire"));
    check("Redis 限流：被拒时查询了剩余 TTL", commandLog.some((c) => c[0] === "pttl"));
  }

  /* ---------- 3. 不同 IP 互不影响 ---------- */
  {
    app.__resetMetrics();
    const a = await post(port, "ipA", "203.0.113.10");
    const b = await post(port, "ipB", "203.0.113.11");
    check("不同 IP 各自计数，互不影响", a.status === 200 && b.status === 200,
      `a=${a.status} b=${b.status}`);
  }

  /* ---------- 4. 多实例共享同一个 Redis（这是分布式限流的关键） ---------- */
  {
    // 用同一份 fakeDb 再起一个"实例"，模拟水平扩容
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const app2 = require(modPath);   // 同一个 fakeDb，但独立的进程内状态

    const s2 = await new Promise((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    const port2 = s2.address().port;

    app.__resetMetrics();
    app2.__resetMetrics();

    const ip = "198.51.100.200";   // 全新的 IP，配额是满的
    let ok1 = 0, ok2 = 0;
    // 交替打两个"实例"
    for (let i = 0; i < 10; i++) {
      const target = i % 2 === 0 ? port : port2;
      const r = await post(target, "跨实例 " + i, ip);
      if (r.status === 200) { if (target === port) ok1++; else ok2++; }
    }

    check("跨实例共享配额：总数不超过限额 5", ok1 + ok2 <= 5, `总放行=${ok1 + ok2}`);
    check("跨实例共享配额：确实被切分了（不是各 5 次）",
      ok1 + ok2 === 5, `实例1=${ok1} 实例2=${ok2}`);
    console.log(`  （两个实例交替请求，限额 5 → 共放行 ${ok1 + ok2} 次，实例1=${ok1} 实例2=${ok2}）`);

    s2.close();
  }

  /* ---------- 5. Redis 掉线时的故障语义 ---------- */
  {
    // 让 fake Redis 的 incr 开始抛错
    const origIncr = FakeRedis.prototype.incr;
    FakeRedis.prototype.incr = async () => { throw new Error("connection lost"); };

    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const app3 = require(modPath);
    const s3 = await new Promise((resolve) => {
      const s = app3.listen(0, () => resolve(s));
    });
    const port3 = s3.address().port;

    // 默认 fail-open：Redis 挂了也要让用户能用
    const r = await post(port3, "redis 掉线", "198.51.100.250");
    check("Redis 掉线 + fail-open：请求仍被放行", r.status === 200, r.status);

    const st = await get(port3, "/stats");
    check("Redis 掉线会记录 rateLimitErrors", st.body.rateLimitErrors >= 1,
      "rateLimitErrors=" + st.body.rateLimitErrors);
    check("Redis 掉线会在 /stats 标记降级", st.body.rateLimitDegraded === true,
      String(st.body.rateLimitDegraded));

    s3.close();
    FakeRedis.prototype.incr = origIncr;
  }

  /* ---------- 6. fail-closed 模式 ---------- */
  {
    const origIncr = FakeRedis.prototype.incr;
    FakeRedis.prototype.incr = async () => { throw new Error("connection lost"); };
    process.env.RATE_LIMIT_FAIL_CLOSED = "1";

    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const app4 = require(modPath);
    const s4 = await new Promise((resolve) => {
      const s = app4.listen(0, () => resolve(s));
    });
    const r = await post(s4.address().port, "fail closed", "198.51.100.251");
    check("fail-closed 模式下 Redis 掉线时拒绝请求", r.status === 429, r.status);
    check("fail-closed 仍返回友好错误码",
      r.body && r.body.code === "RATE_LIMITED", r.body && r.body.code);

    s4.close();
    FakeRedis.prototype.incr = origIncr;
    delete process.env.RATE_LIMIT_FAIL_CLOSED;
  }

  /* ---------- 7. Redis 连接能优雅关闭（避免重启时连接泄漏） ----------
     覆盖率分析发现 __closeRateStore / redisStore.close / get ready
     这几个函数从未被执行过 —— 它们都是关闭路径。
     生产环境重启服务时如果不断开连接，Redis 侧会累积僵尸连接。 */
  {
    const modPath = require.resolve(path.join(__dirname, "proxy", "node-server.js"));
    delete require.cache[modPath];
    const appClose = require(modPath);

    // get ready()：应返回布尔值
    const info = appClose.__rateStoreInfo();
    check("__rateStoreInfo 在 redis 模式下报告为分布式",
      info.distributed === true, JSON.stringify(info));

    // 关闭应该成功且不抛异常
    let closeErr = null;
    try {
      await appClose.__closeRateStore();
    } catch (e) { closeErr = e; }
    check("Redis 连接能被优雅关闭（不抛异常）",
      closeErr === null, closeErr ? closeErr.message : "");

    // 重复关闭也不应报错（幂等）
    let closeErr2 = null;
    try { await appClose.__closeRateStore(); } catch (e) { closeErr2 = e; }
    check("重复关闭是幂等的（不抛异常）",
      closeErr2 === null, closeErr2 ? closeErr2.message : "");
  }

  server.close();
  Module._resolveFilename = origResolve;
  delete require.cache[fakeIoredisPath];

  console.log("\n========= Redis 限流分支测试 =========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("======================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
