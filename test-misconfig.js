/* 代理的"配置错误"场景审计
 *
 * 上一轮发现："文件不齐"是前端从未测过的角度。
 * 同样的角度放到代理上：我此前只测过"配置完全正确"的情况。
 *
 * 实现说明：本环境禁止对子进程做管道捕获（execFileSync/spawnSync 会 EPERM），
 * 因此不能靠"起子进程看输出"来测。改为在**同一进程内**用模块缓存重载 +
 * 捕获 console 输出 + try/catch 来模拟各种配置错误。
 */
require("./check-integrity.js");

const fs = require("fs");
const path = require("path");
const http = require("http");

const dir = __dirname;
const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}

const NODE_SERVER = path.join(dir, "proxy", "node-server.js");

/** 在受控环境下加载 node-server.js，捕获日志与异常 */
function loadServer(env, opts) {
  opts = opts || {};
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }

  const logs = [];
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.warn = (...a) => logs.push("WARN " + a.map(String).join(" "));
  console.error = (...a) => logs.push("ERR " + a.map(String).join(" "));

  const modPath = require.resolve(NODE_SERVER);
  delete require.cache[modPath];

  let mod = null, error = null;
  try {
    mod = require(modPath);
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realErr;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  return { mod, error, logs };
}

/** 起服务并打一个请求 */
function withServer(mod, fn) {
  return new Promise((resolve) => {
    const server = mod.listen(0, async () => {
      const port = server.address().port;
      try { await fn(port); } finally { server.close(); resolve(); }
    });
  });
}

function get(port, p) {
  return new Promise((res) => {
    http.get({ host: "127.0.0.1", port, path: p }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", () => res({ status: -1, body: "" }));
  });
}

(async () => {

  /* ============ 0. 缺少 express 时给出可操作的提示 ============ */
  {
    const Module = require("module");
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req === "express") {
        const e = new Error("Cannot find module 'express'");
        e.code = "MODULE_NOT_FOUND";
        throw e;
      }
      return orig.call(this, req, ...rest);
    };

    const captured = [];
    const realErr = console.error;
    const realExit = process.exit;
    let exitCode = null;
    console.error = (...a) => captured.push(a.map(String).join(" "));
    // 拦住 process.exit，否则会杀掉测试进程
    process.exit = (code) => { exitCode = code; throw new Error("__EXIT__"); };

    let thrown = null;
    try {
      delete require.cache[require.resolve(NODE_SERVER)];
      require(NODE_SERVER);
    } catch (e) {
      thrown = e;
    } finally {
      console.error = realErr;
      process.exit = realExit;
      Module._resolveFilename = orig;
      delete require.cache[require.resolve(NODE_SERVER)];
    }

    const msg = captured.join("\n");
    check("缺少 express 时给出可操作提示（而非裸 MODULE_NOT_FOUND）",
      /npm install express/.test(msg), msg.replace(/\n/g, " ").slice(0, 140));
    check("缺少 express 时以非零码退出（不会假装启动成功）",
      exitCode === 1 || (thrown && thrown.message === "__EXIT__"),
      "exitCode=" + exitCode);
  }

  /* ============ 1. Redis 地址写错 ============ */
  {
    const r = loadServer({
      ZHIPU_API_KEY: "k", RATE_LIMIT_STORE: "redis",
      REDIS_URL: "redis://this-host-does-not-exist.invalid:6379",
      LOG_LEVEL: "off", RATE_LIMIT_MAX: "1000",
    });

    check("Redis 地址写错时服务仍能启动（不崩溃）",
      r.mod && !r.error, r.error ? r.error.message : "");

    if (r.mod && r.mod.__rateStoreInfo) {
      const info = r.mod.__rateStoreInfo();
      check("不会谎报限流为分布式（必须如实报告退化后的类型）",
        info.distributed === false, JSON.stringify(info));
      check("如实报告仍在使用 memory 存储",
        info.name === "memory", info.name);
    } else {
      check("不会谎报限流为分布式（必须如实报告退化后的类型）", false, "模块未加载");
      check("如实报告仍在使用 memory 存储", false, "");
    }

    // 服务仍应可用
    if (r.mod) {
      await withServer(r.mod, async (port) => {
        const h = await get(port, "/health");
        check("Redis 配错时 /health 仍可用（服务没瘫）",
          h.status === 200, "status=" + h.status);
      });
    }
  }

  /* ============ 2. 完全没配 Redis，但指定了 redis 模式 ============ */
  {
    const r = loadServer({
      ZHIPU_API_KEY: "k", RATE_LIMIT_STORE: "redis", REDIS_URL: undefined,
      LOG_LEVEL: "off", RATE_LIMIT_MAX: "1000",
    });

    check("REDIS_URL 缺失时不会崩溃", r.mod && !r.error, r.error ? r.error.message : "");
    if (r.mod && r.mod.__rateStoreInfo) {
      const info = r.mod.__rateStoreInfo();
      check("REDIS_URL 缺失时如实报告为 memory",
        info.name === "memory" && info.distributed === false, JSON.stringify(info));
    } else {
      check("REDIS_URL 缺失时如实报告为 memory", false, "");
    }
  }

  /* ============ 3. 缺少服务端 Key ============ */
  {
    const r = loadServer({
      ZHIPU_API_KEY: undefined, RATE_LIMIT_STORE: "memory",
      LOG_LEVEL: "off", RATE_LIMIT_MAX: "1000",
    });

    check("没配 ZHIPU_API_KEY 时服务仍能启动", r.mod && !r.error,
      r.error ? r.error.message : "");

    if (r.mod) {
      await withServer(r.mod, async (port) => {
        const h = await get(port, "/health");
        check("缺 Key 时 /health 仍返回 200（前端据此判断代理可用）",
          h.status === 200, "status=" + h.status);
      });
    }
  }

  /* ============ 4. 端口占用 ============ */
  {
    const r = loadServer({
      ZHIPU_API_KEY: "k", RATE_LIMIT_STORE: "memory",
      LOG_LEVEL: "off", RATE_LIMIT_MAX: "1000",
    });

    if (r.mod) {
      // 占住一个端口，再让代理去监听同一个端口
      const blocker = http.createServer(() => {});
      await new Promise((res) => blocker.listen(0, res));
      const busyPort = blocker.address().port;

      let listenError = null;
      const s = r.mod.listen(busyPort);
      await new Promise((res) => {
        s.on("error", (e) => { listenError = e; res(); });
        s.on("listening", () => { s.close(); res(); });
        setTimeout(res, 500);
      });
      blocker.close();

      check("端口被占用时抛出可识别的错误（EADDRINUSE）",
        listenError && (listenError.code === "EADDRINUSE" || /EADDRINUSE/.test(listenError.message)),
        listenError ? (listenError.code || listenError.message) : "没有报错（不该）");
    } else {
      check("端口被占用时抛出可识别的错误（EADDRINUSE）", false, "模块未加载");
    }
  }

  /* ============ 5. 非法配置值应被容错 ============ */
  {
    const r = loadServer({
      ZHIPU_API_KEY: "k", RATE_LIMIT_MAX: "not-a-number",
      RATE_LIMIT_STORE: "unknown-store", LOG_LEVEL: "off",
    });

    check("RATE_LIMIT_MAX 非数字时不崩溃", r.mod && !r.error,
      r.error ? r.error.message : "");

    if (r.mod) {
      await withServer(r.mod, async (port) => {
        const h = await get(port, "/health");
        check("非法 RATE_LIMIT_MAX 下服务仍可用", h.status === 200, "status=" + h.status);
      });
    }
  }

  /* ---------- 输出 ---------- */
  console.log("\n======== 代理配置错误审计 ========");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log("  PASS  " + r.name + (r.extra ? "  (" + r.extra + ")" : "")); }
    else { fail++; console.log("  FAIL  " + r.name + (r.extra ? "  <- " + r.extra : "")); }
  }
  console.log("==================================");
  console.log(`通过 ${pass} / ${pass + fail}` + (fail ? `  ❌ ${fail} 项失败` : "  ✅ 全部通过"));
  process.exit(fail ? 1 : 0);
})();
