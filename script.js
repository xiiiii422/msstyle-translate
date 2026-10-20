/* ==========================================================================
 * 微软式翻译 · script.js
 *
 * 模块划分（从上到下）：
 *   1. CONFIG      —— 需要你修改的配置（API Key / 模型 / 接口地址）
 *   2. PROMPTS     —— 提示词管理（与 UI、网络请求完全解耦）
 *   3. API         —— 网络请求封装（只负责"把一段文字变成微软式中文"）
 *   4. STORAGE     —— localStorage 历史记录读写
 *   5. UI          —— DOM 操作、状态渲染、事件绑定
 *
 * 依赖：无。原生 JavaScript，可直接双击 index.html 运行。
 * ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
   * 1. CONFIG —— 配置区
   * ==================================================================== */

  /**
   * ★★★ 部署者可以在这里预置一个 API Key（可选）★★★
   *
   * 本站的正式部署方式不是这里 —— 而是 secret.js 里的**加密内置 Key**，
   * 访客打开页面就能直接用（见下面 VAULT 那一段）。
   *
   * 这个常量留成占位符，优先级如下（从高到低）：
   *   1. 访客自己填的 Key（存在他自己的浏览器里）
   *   2. config.js 里注入的 apiKey
   *   3. 本文件这里的 API_KEY（只建议本地调试时临时填）
   *   4. secret.js 里加密的内置 Key（线上真实使用的来源）
   *
   * 注意：任何写进前端的 Key 最终都能被打开网页的人拿到。
   *      正式商用要真正保密，只有后端代理一条路（见 proxy/ 目录）。
   */
  const API_KEY = "YOUR_API_KEY";

  const CONFIG = {
    // 智谱开放平台通用接口地址（OpenAI 兼容格式）
    API_URL: "https://open.bigmodel.cn/api/paas/v4/chat/completions",

    /* ------------------------------------------------------------------
     * 代理地址（商用部署用）
     *
     * 留空 "" → 纯静态直连模式（个人娱乐）。
     * 填地址  → 优先走代理，API Key 保存在服务端，前端完全接触不到。
     *
     * 部署方式是同源时，直接用 "/api" 即可（推荐，天然没有 CORS 问题）：
     *   同域反向代理：PROXY_URL: "/api"
     *   Cloudflare Worker 独立域名：PROXY_URL: "https://xxx.workers.dev"
     *
     * 见 proxy/ 目录下的现成实现。
     * ---------------------------------------------------------------- */
    PROXY_URL: "",

    // 代理请求超时（服务端要串行试多个模型，所以给得比单个模型宽）
    PROXY_TIMEOUT: 50000,

    // 使用的模型（首选）
    //
    // 为什么首选不是更新的 glm-4.7-flash：
    //   实测它高峰期极容易返回 429 / code 1305，而每次都要先等它失败
    //   （约 400ms）才降级到备用模型 —— 用户白等，还多一次往返。
    //   glm-4-flash-250414 响应约 500ms、几乎不失败，而且它的"机器味"
    //   在真实语料上最稳定。把这个位置让给最好用的那个，而不是最新的那个。
    MODEL: "glm-4-flash-250414",

    // 备用模型：首选模型返回"访问量过大/限流/超时/空内容"时按顺序降级。
    // 最后放 glm-4.7-flash：它更新，但更容易限流，适合当最后一张牌。
    // 如果不想要自动降级，把这里改成空数组 [] 即可。
    FALLBACK_MODELS: ["glm-4-flash", "glm-4.7-flash"],

    // 生成参数：机器翻译需要一点"意外感"，temperature 不宜过低
    TEMPERATURE: 1.0,
    TOP_P: 0.9,
    MAX_TOKENS: 2048,

    /* 分档温度 —— 真正的表在 prompt.js 里（唯一来源），这里只是转发。
     *
     * 为什么不在这里另抄一份：两份代理和所有联网测试都直接调用
     * prompt.js 的 buildRequestBody。表只放在前端的话，代理模式就会
     * 悄悄退回统一温度 —— 同一个输入，直连和走代理风格不一样，
     * 正是当初把提示词抽成 prompt.js 要消灭的那类漂移。
     *
     * ⚠️ 上限必须是 1.0：智谱接口对 temperature 的合法区间是 [0, 1]，
     *    写 1.1 会直接返回 400 / code 1210，而 400 不在重试白名单里，
     *    结果是那一档**每次**都翻译失败（实测踩过：四档里唯独 4 档全挂）。
     *    prompt.js 的 clampTemperature 还会再夹一次，配置写错也打不死某档。
     *
     * 后面的兜底值只在 prompt.js 缺失（部署不完整）时用到。 */
    LEVEL_TEMPERATURE:
      (typeof window !== "undefined" && window.MSSTYLE_PROMPT &&
        window.MSSTYLE_PROMPT.LEVEL_TEMPERATURE) ||
      { 1: 0.55, 2: 0.75, 3: 0.95, 4: 1.0 },

    // 关闭"思考模式"。
    //
    // 【实测踩坑】glm-4.7-flash 是一个思考模型：它会先生成一大段
    // reasoning_content（实测 800~1000+ tokens），然后才输出正文。
    // 如果 max_tokens 不够大，推理过程会把额度耗尽，于是接口返回
    // HTTP 200 但 content 是空字符串（finish_reason: "length"），
    // 用户就会看到"翻译失败"——非常难排查。
    //
    // 关掉思考后：响应从 ~9700ms 降到 ~470ms，输出也正常。
    // 对这个任务（风格改写）完全不需要推理，所以直接禁用。
    //
    // 如果换用不支持该参数的模型，服务端会忽略它，不影响兼容性。
    THINKING_DISABLED: true,

    // 单次请求超时时间（毫秒）
    TIMEOUT: 60000,

    // 一次翻译所有尝试加起来的总时间预算（毫秒）。
    // 这是**硬上限**：无论分给几个模型，用户等待都不会超过它。
    TOTAL_TIMEOUT: 25000,

    // 第一个模型拿总预算的多少比例（其余分给备用模型）。
    // 实测：备用模型主要处理"限流/过载"，上游会很快返回，
    // 不需要太多时间；而第一个模型要处理正常但较慢的请求。
    PRIMARY_BUDGET_RATIO: 0.6,

    // 单个模型的最小超时，避免备用模型分到太少时间而必然失败
    MIN_ATTEMPT_TIMEOUT: 5000,

    // 最大输入长度（与 HTML 的 maxlength 保持一致）
    MAX_INPUT: 2000,

    // localStorage 中保存的记录条数
    HISTORY_LIMIT: 10,
    HISTORY_KEY: "msstyle_translate_history_v1",
    LEVEL_KEY: "msstyle_translate_level_v1",
    // 访客自己填写的 API Key（只存在他自己的浏览器里）
    KEY_STORAGE: "msstyle_translate_apikey_v1",
    MODEL_STORAGE: "msstyle_translate_model_v1",
    /* 输入草稿。手机上打字很痛苦，刷新一下就全没了是最劝退的一种体验。
       只存最近 MAX_INPUT 个字符，所以这一项的大小天然有上限。 */
    DRAFT_KEY: "msstyle_translate_draft_v1",
  };

  /* ----------------------------------------------------------------------
   * 配置解析：把「外部 config.js」和「源码里的常量」合并进来。
   * 这样部署者不需要改这份文件就能覆盖默认值。
   * -------------------------------------------------------------------- */
  const EXTERNAL_CONFIG =
    (typeof window !== "undefined" && window.__MSSTYLE_CONFIG__) || {};

  if (EXTERNAL_CONFIG.apiUrl) CONFIG.API_URL = EXTERNAL_CONFIG.apiUrl;
  if (EXTERNAL_CONFIG.model) CONFIG.MODEL = EXTERNAL_CONFIG.model;
  if (Array.isArray(EXTERNAL_CONFIG.fallbackModels)) {
    CONFIG.FALLBACK_MODELS = EXTERNAL_CONFIG.fallbackModels;
  }
  // 代理地址（商用部署：Key 放服务端）
  if (typeof EXTERNAL_CONFIG.proxyUrl === "string") {
    CONFIG.PROXY_URL = EXTERNAL_CONFIG.proxyUrl.replace(/\/+$/, ""); // 去掉尾部斜杠
  }

  /* ----------------------------------------------------------------------
   * 安全存储：隐私模式 / 禁用 Cookie 时 localStorage 会直接抛异常，
   * 所有读写都必须包一层，否则整个页面会挂掉。
   * -------------------------------------------------------------------- */
  const safeStorage = {
    available: (function () {
      try {
        const k = "__msstyle_test__";
        window.localStorage.setItem(k, "1");
        window.localStorage.removeItem(k);
        return true;
      } catch (e) {
        return false;
      }
    })(),

    get(key) {
      if (!safeStorage.available) return null;
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },

    set(key, value) {
      if (!safeStorage.available) return false;
      try { window.localStorage.setItem(key, value); return true; } catch (e) {
        console.warn("[微软式翻译] 写入本地存储失败（可能是隐私模式或空间已满）：", e);
        return false;
      }
    },

    remove(key) {
      if (!safeStorage.available) return;
      try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  /* ----------------------------------------------------------------------
   * KeyStore：API Key 的唯一来源。
   *
   * 优先级（高 → 低）：
   *   1. 访客在「设置」里自己填的（存在他自己的 localStorage）
   *   2. 部署者写在 config.js 里的
   *   3. 部署者写在源码 API_KEY 常量里的
   *
   * 之所以把「访客自己填的」放最高，是为了让公共部署的访客可以覆盖
   * 部署者的测试 Key，而不是被迫共用。
   * -------------------------------------------------------------------- */
  /* ----------------------------------------------------------------------
   * 内置 Key（密文 + 运行时解密）
   *
   * 商用部署时访客不该看到"请自己填 API Key"这种开发者步骤，所以站点
   * 内置了一个 Key。它不以明文存在于任何文件里，而是 secret.js 里的
   * AES-256-GCM 密文，页面运行时用 WebCrypto 派生出密钥再解开。
   *
   * 三个必须知道的事实：
   *   1. 解密出来的明文只在内存里活一次，之后只留在闭包变量中，
   *      不写 localStorage、不挂 window、不进 DOM。
   *   2. 它不是真正的安全 —— 浏览器最终必须拿到明文才能调用接口，
   *      在 fetch 上打一个断点就能看到。它挡住的是随手扒源码、
   *      GitHub 密钥扫描、以及把页面复制到别的域名（那里解不开）。
   *   3. secret.js 不存在或环境不支持 WebCrypto 时，会安静降级成
   *      "需要访客自己填 Key"，页面其它功能不受影响。
   * -------------------------------------------------------------------- */
  const VAULT =
    (typeof window !== "undefined" && window.__MSSTYLE_VAULT__) || null;

  /** 解密后的明文 Key（只在内存中） */
  let embeddedKey = null;
  /** 解密中的 Promise，避免并发重复解密 */
  let vaultPromise = null;

  /** 当前环境是否可以尝试解密内置 Key（域名 + WebCrypto 都满足） */
  function isVaultUsable() {
    try {
      return !!(VAULT && typeof VAULT.canAttempt === "function" && VAULT.canAttempt());
    } catch (e) {
      return false;
    }
  }

  /** 解锁内置 Key；失败返回 null，绝不抛异常打断页面 */
  function unlockEmbeddedKey() {
    if (embeddedKey) return Promise.resolve(embeddedKey);
    if (!isVaultUsable()) return Promise.resolve(null);
    if (vaultPromise) return vaultPromise;

    vaultPromise = Promise.resolve()
      .then(function () { return VAULT.unlock(); })
      .then(function (k) {
        if (k) embeddedKey = String(k);
        return embeddedKey;
      })
      .catch(function (e) {
        console.warn("[微软式翻译] 内置 Key 解密失败，需要手动填写。", e);
        return null;
      });
    return vaultPromise;
  }

  const KeyStore = {
    /** 判断一个值是不是有效的 Key（不是空、不是占位符） */
    isValid(key) {
      return !!key &&
        typeof key === "string" &&
        key.trim() !== "" &&
        key !== "YOUR_API_KEY";
    },

    /** 访客自己保存的 Key */
    getUserKey() {
      const k = safeStorage.get(CONFIG.KEY_STORAGE);
      return KeyStore.isValid(k) ? k.trim() : null;
    },

    /** 解析出当前应该使用的 Key；没有则返回 null */
    resolve() {
      const user = KeyStore.getUserKey();
      if (user) return user;

      const external = EXTERNAL_CONFIG.apiKey;
      if (KeyStore.isValid(external)) return String(external).trim();

      if (KeyStore.isValid(API_KEY)) return String(API_KEY).trim();

      // 内置 Key：已经解密过就直接用
      if (embeddedKey) return embeddedKey;

      return null;
    },

    /**
     * 异步解析：如果唯一可用的来源是加密的内置 Key，
     * 会等解密完成再返回（首次约 20~80ms，之后命中缓存）。
     */
    async resolveAsync() {
      const sync = KeyStore.resolve();
      if (sync) return sync;
      return await unlockEmbeddedKey();
    },

    /** 保存访客填写的 Key */
    saveUserKey(key) {
      if (!KeyStore.isValid(key)) return false;
      return safeStorage.set(CONFIG.KEY_STORAGE, String(key).trim());
    },

    /** 清除访客填写的 Key（回到部署者默认值） */
    clearUserKey() {
      safeStorage.remove(CONFIG.KEY_STORAGE);
    },

    /** 当前用户选用的模型 */
    resolveModel() {
      const m = safeStorage.get(CONFIG.MODEL_STORAGE);
      return m && String(m).trim() ? String(m).trim() : CONFIG.MODEL;
    },

    saveModel(model) {
      if (!model) return;
      safeStorage.set(CONFIG.MODEL_STORAGE, String(model));
    },
  };

  /* ======================================================================
   * 2. PROMPTS —— 提示词
   *
   * 提示词本体在 prompt.js（唯一来源），前端与两份代理共用同一份，
   * 避免"改了前端忘了改代理"导致两种模式风格不一致。
   * 这里只是薄适配层，把 window.MSSTYLE_PROMPT 暴露成原来的函数名。
   * ==================================================================== */

  const PROMPTS = window.MSSTYLE_PROMPT;

  /**
   * prompt.js 是否加载成功。
   *
   * 这是一个**部署级**故障：缺少 prompt.js 时页面看起来正常，
   * 但点翻译会毫无反应 —— 部署者很难自己定位。
   * 所以除了 console 报错，还要在界面上明确说出来。
   */
  const PROMPTS_MISSING = !PROMPTS;

  if (PROMPTS_MISSING) {
    console.error(
      "[微软式翻译] prompt.js 没有加载成功。\n" +
      "请确认 index.html 里在 script.js 之前引入了 <script src=\"prompt.js\"></script>，\n" +
      "并且 prompt.js 确实已上传到站点根目录。"
    );
  }

  const SYSTEM_PROMPT = PROMPTS ? PROMPTS.SYSTEM_PROMPT : "";
  const LEVELS = PROMPTS ? PROMPTS.LEVELS : {};

  /** 构造用户消息（转发给共享模块） */
  function buildUserPrompt(text, mode, level) {
    return PROMPTS.buildUserPrompt(text, mode, level);
  }

  /** 在界面上提示"缺文件"——只有部署者会看到，普通访客见不到 */
  function showMissingPromptsNotice() {
    // 顶栏下面插一条醒目的横幅，比 toast 更持久，不会被忽略
    if (document.getElementById("promptsMissingNotice")) return;

    const box = document.createElement("div");
    box.id = "promptsMissingNotice";
    box.className = "notice";
    box.setAttribute("role", "alert");
    // 用 textContent 保证安全（消息里含尖括号）
    box.textContent =
      "部署不完整：缺少 prompt.js，翻译功能无法使用。" +
      "请确认该文件已上传到站点根目录，并在 index.html 中先于 script.js 引入。";
    box.style.margin = "16px auto";
    box.style.maxWidth = "1040px";

    const main = document.getElementById("main");
    if (main && main.parentNode) main.parentNode.insertBefore(box, main);
  }

  /* ======================================================================
   * 3. API —— 网络请求封装
   *
   * 支持两种模式，客户端会自动选择：
   *
   *   A. 代理模式（商用推荐）
   *      请求同源的 /api/translate，由服务端持有 API Key。
   *      Key 不出现在前端，访客不需要自己填，也能由服务端做限流与配额。
   *      见 proxy/ 目录（Cloudflare Worker 与 Node 两种实现）。
   *
   *   B. 直连模式（纯静态 / 个人娱乐）
   *      浏览器直接请求智谱接口，用访客自己填的 Key（或部署者预置的）。
   *
   * 探测顺序：CONFIG.PROXY_URL 有值 → 先试代理；代理不可用再回退直连。
   * 这样同一份前端代码既能部署成纯静态，也能部署成带后端的商用版本。
   * ==================================================================== */

  /** 记录代理是否被探测过，避免每次请求都浪费一次探测 */
  let proxyState = "unknown"; // unknown | available | unavailable

  /**
   * 探测代理是否可用（GET /api/health）。
   * 只在第一次翻译时探测一次，结果缓存。
   */
  async function probeProxy() {
    if (!CONFIG.PROXY_URL) return false;
    if (proxyState !== "unknown") return proxyState === "available";

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(CONFIG.PROXY_URL + "/health", {
        method: "GET",
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      clearTimeout(timer);
      proxyState = res.ok ? "available" : "unavailable";
      if (!res.ok) {
        console.warn("[微软式翻译] 代理健康检查返回 " + res.status + "，改用直连模式。");
      }
    } catch (e) {
      proxyState = "unavailable";
      console.warn("[微软式翻译] 代理不可用，改用直连模式：", e.message || e);
    }
    return proxyState === "available";
  }

  /**
   * 把文本转换成"微软式中文"。这是 UI 唯一需要调用的入口。
   *
   * @param {Object} opts
   * @param {string} opts.text
   * @param {string} opts.mode  'auto' | 'zh' | 'en'
   * @param {number} opts.level 1-4
   * @returns {Promise<string>} 翻译结果
   */
  async function requestTranslation({ text, mode, level }) {
    // ---- 优先走代理：Key 在服务端，前端不接触 ----
    if (await probeProxy()) {
      try {
        return await requestViaProxy({ text, mode, level });
      } catch (err) {
        // 代理明确报"配置错误/额度问题"时不再回退直连（回退也没用），直接抛
        if (err && err.noFallback) throw err;

        console.warn(
          "[微软式翻译] 代理请求失败（" + (err.status || err.code || "网络") +
          "），尝试回退到直连模式。",
          err
        );
        proxyState = "unavailable";
      }
    }

    // ---- 直连模式 ----
    // resolveAsync：如果唯一可用的来源是加密的内置 Key，
    // 这里会等它解密完成（首次约 20~80ms，之后直接命中缓存）。
    const apiKey = await KeyStore.resolveAsync();
    if (!apiKey) {
      const err = new Error("API Key 未配置");
      err.code = "NO_API_KEY";
      throw err;
    }

    // 依次尝试：当前选用的模型 + 备用模型（去重，避免重复请求同一个模型）
    const preferred = KeyStore.resolveModel();
    const models = [preferred].concat(CONFIG.FALLBACK_MODELS || [])
      .filter(function (m, i, arr) { return m && arr.indexOf(m) === i; });

    /* ------------------------------------------------------------------
     * 时间预算怎么分（实测调过，别随意改）
     *
     * 早期实现是"总预算 ÷ 模型数"平均分，结果是 3 个模型各 15 秒，
     * 上游全挂时用户要干等 45 秒 —— 手机用户早就关页面了。
     *
     * 但"平均分"其实是错的前提：备用模型主要是为了应对**限流/过载**，
     * 而这两种情况上游会**很快**返回（实测 429 大约 300ms）。
     * 真正慢的是"模型在正常处理但很慢"，那只有第一个模型会遇到。
     *
     * 所以改成：
     *   · 第一个模型拿大头（总预算 60%），让它有足够时间正常完成
     *   · 备用模型各分一点（足够覆盖 429/超时）
     *   · 再加一层"总墙钟上限"，无论分到多少都不会超过它
     * ------------------------------------------------------------------ */
    const deadline = Date.now() + CONFIG.TOTAL_TIMEOUT;
    const primaryBudget = Math.round(CONFIG.TOTAL_TIMEOUT * CONFIG.PRIMARY_BUDGET_RATIO);
    const restCount = Math.max(1, models.length - 1);
    const restBudget = Math.max(
      CONFIG.MIN_ATTEMPT_TIMEOUT,
      Math.floor((CONFIG.TOTAL_TIMEOUT - primaryBudget) / restCount)
    );

    let lastError = null;

    for (let i = 0; i < models.length; i++) {
      // 用户点了「取消」——立刻停止，不再尝试后续模型
      if (state.cancelled) {
        const err = new Error("用户取消了翻译");
        err.code = "USER_CANCELLED";
        err.userCancelled = true;
        throw err;
      }

      // 总墙钟上限：剩余时间不足就直接放弃，不再开新请求
      const remaining = deadline - Date.now();
      if (remaining <= CONFIG.MIN_ATTEMPT_TIMEOUT / 2) {
        const err = new Error("总时间预算已用完");
        err.code = "DEADLINE_EXCEEDED";
        err.isTimeout = true;
        err.allModelsBusy = true;
        lastError = lastError || err;
        break;
      }

      const budget = Math.min(
        i === 0 ? primaryBudget : restBudget,
        remaining
      );

      try {
        return await requestWithModel(models[i], { text, mode, level, apiKey }, budget);
      } catch (err) {
        lastError = err;

        // 只有在"模型过载 / 限流 / 超时 / 网络抖动"时才降级到下一个模型。
        // Key 错误、余额不足、参数错误等问题换模型也没用，直接抛出。
        const retriable = err && err.retriable === true;
        const hasNext = i < models.length - 1;

        if (retriable && hasNext) {
          console.warn(
            "[微软式翻译] 模型 " + models[i] + " 暂时不可用（" +
            (err.status || "网络") + "），自动切换到备用模型 " + models[i + 1]
          );
          continue;
        }

        // 不可重试，或已经没有备用模型了
        if (retriable && !hasNext) {
          err.allModelsBusy = true;
        }
        throw err;
      }
    }

    throw lastError || new Error("翻译失败");
  }

  /**
   * 经由服务端代理翻译。
   *
   * 模型降级、重试、Key 都在服务端处理，前端只发一次请求。
   * 服务端返回统一的 { ok, result } 或 { ok:false, code, message }。
   */
  async function requestViaProxy({ text, mode, level }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.PROXY_TIMEOUT);

    try {
      const response = await fetch(CONFIG.PROXY_URL + "/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, mode: mode, level: level }),
        signal: controller.signal,
      });

      let data = null;
      try { data = await response.json(); } catch (_) { /* 可能不是 JSON */ }

      if (!response.ok) {
        const err = new Error(
          "代理返回 HTTP " + response.status +
          (data && data.message ? "：" + data.message : "")
        );
        err.status = response.status;
        err.proxyCode = (data && data.code) || "";

        // 429：服务端限流 —— 换个模型也没用，但要告诉用户稍后再试
        if (response.status === 429) {
          err.retriable = false;
          err.allModelsBusy = true;
          err.noFallback = true;   // 直连也绕不过服务端限流
        }
        // 5xx：服务端故障 —— 可以回退直连
        else if (response.status >= 500) {
          err.retriable = true;
        }
        // 400/403：请求本身有问题，回退无意义
        else if (response.status === 400 || response.status === 403) {
          err.noFallback = true;
        }
        throw err;
      }

      if (!data || !data.ok || !data.result || !String(data.result).trim()) {
        const err = new Error("代理返回内容为空");
        err.code = "EMPTY_RESULT";
        err.retriable = true;
        throw err;
      }

      // 服务端已经清洗过，这里再兜一层（防止自建代理忘了）
      return cleanResult(String(data.result));
    } catch (err) {
      if (err && err.name === "AbortError") {
        const e = new Error("代理请求超时");
        e.isTimeout = true;
        e.retriable = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 组装一次对话补全的请求体。
   *
   * 单独抽出来是为了集中处理"思考模式"这个坑（见 CONFIG.THINKING_DISABLED）：
   * 部分模型（如 glm-4.7-flash）默认会先输出一大段推理内容，
   * 把 max_tokens 吃光后正文变成空字符串，接口却仍然返回 HTTP 200。
   */
  function buildRequestBody(model, { text, mode, level }) {
    // 温度取自 prompt.js 的分档表（唯一来源），并在那里已夹进 [0,1]。
    // 万一 prompt.js 缺失（部署不完整），退回本地兜底表再自己夹一次，
    // 保证不会因为"取不到共享值"而发出一个接口拒绝的温度把整档打死。
    const shared = PROMPTS && typeof PROMPTS.temperatureForLevel === "function"
      ? PROMPTS.temperatureForLevel(level)
      : Math.min(1, Math.max(0,
          typeof CONFIG.LEVEL_TEMPERATURE[level] === "number"
            ? CONFIG.LEVEL_TEMPERATURE[level]
            : CONFIG.TEMPERATURE));

    const body = {
      model: model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(text, mode, level) },
      ],
      // 档位越重，越需要一点"意外感"；档位越轻，越要克制
      temperature: shared,
      top_p: CONFIG.TOP_P,
      max_tokens: CONFIG.MAX_TOKENS,
      stream: false,
    };

    // 智谱的思考开关。不支持的模型会忽略这个字段。
    if (CONFIG.THINKING_DISABLED) {
      body.thinking = { type: "disabled" };
    }

    return body;
  }

  /**
   * 用指定模型发一次请求。
   * @returns {Promise<string>}
   */
  async function requestWithModel(model, { text, mode, level, apiKey }, timeoutMs) {
    // 超时控制：AbortController
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || CONFIG.TIMEOUT);

    // 让「取消」按钮也能中断这次请求：
    // 把当前的 controller 挂到 state 上，用户点取消时统一 abort。
    state.abortController = controller;

    try {
      const response = await fetch(CONFIG.API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify(buildRequestBody(model, { text, mode, level })),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 尽量读出服务端返回的错误信息，便于开发调试
        let detail = "";
        let code = "";
        try {
          const data = await response.json();
          code = (data && data.error && data.error.code) || "";
          detail = (data && data.error && data.error.message) || JSON.stringify(data);
        } catch (_) {
          try { detail = await response.text(); } catch (_) { /* ignore */ }
        }
        const err = new Error("HTTP " + response.status + " [" + code + "] " + detail);
        err.code = "HTTP_" + response.status;
        err.status = response.status;
        err.apiCode = code;

        // 429 = 限流 / 模型过载；1305 模型访问量过大，1302 账户速率限制
        err.retriable =
          response.status === 429 ||
          response.status === 500 ||
          response.status === 503 ||
          code === "1305" ||
          code === "1302";

        throw err;
      }

      const data = await response.json();
      const choice = data && data.choices && data.choices[0];
      const content = choice && choice.message && choice.message.content;
      const finish = choice && choice.finish_reason;
      const reasoning = choice && choice.message && choice.message.reasoning_content;

      if (!content || !String(content).trim()) {
        // 诊断：区分"模型只输出了思考内容就被截断"和"真的返回了空"。
        // 前者是 max_tokens 太小 / 思考模式没关掉导致的（见 CONFIG.THINKING_DISABLED）。
        const err = new Error(
          "接口返回内容为空" +
          "（finish_reason=" + finish +
          "，推理内容长度=" + (reasoning ? reasoning.length : 0) + "）"
        );
        err.code = "EMPTY_RESULT";
        err.finishReason = finish;
        err.hadReasoning = !!reasoning;
        // 空结果通常换个模型就能成功，因此允许降级重试
        err.retriable = true;
        throw err;
      }

      // 清洗后再判一次空：模型有时会返回一句纯引号/纯前缀，
      // 原文非空但清洗完什么都不剩，这种结果不能拿去展示。
      const cleaned = cleanResult(String(content));
      if (!cleaned) {
        const err = new Error("清洗后内容为空");
        err.code = "EMPTY_RESULT";
        err.retriable = true;
        throw err;
      }
      return cleaned;
    } catch (err) {
      // 超时（AbortError）与网络中断同样属于"可以换个模型再试"的情况：
      // 首选模型可能正好在那一刻不可用。
      if (err && err.name === "AbortError") {
        err.retriable = true;
        err.isTimeout = true;
      } else if (err && !err.status && !err.code &&
                 (err instanceof TypeError || err.name === "TypeError")) {
        err.retriable = true;
        err.isNetworkError = true;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 清理模型输出：去掉 Markdown 代码块、前缀、"翻译结果："等，
   * 并把偶发跑偏的文言词换回现代白话。
   *
   * 实现在 prompt.js，与两份代理共用同一套规则。
   */
  function cleanResult(raw) {
    return PROMPTS.cleanResult(raw);
  }

  /** 仅供测试与调试：暴露文言词清洗规则 */
  function deClassicalize(text) {
    return PROMPTS.deClassicalize(text);
  }

  /**
   * 把真实错误翻译成"用户友好"的提示。
   * 真实错误一律打到 console，方便开发者排查。
   */
  function friendlyError(err) {
    // 用户主动取消不是错误，不值得刷一条 error 日志
    if (err && err.userCancelled) {
      return "已经取消这次翻译。";
    }

    console.error("[微软式翻译] 真实错误：", err);

    if (err && err.code === "NO_API_KEY") {
      return "还没有配置 API Key。请点击右上角的「设置」，填入你自己的智谱 API Key。";
    }
    if (err && err.name === "AbortError") {
      return "翻译等待的时间实在是太长了，请稍后再试一次。";
    }

    // fetch 在"网络中断 / 跨域被拦 / 被广告拦截插件阻断"时会抛出 TypeError。
    // 这里不用 instanceof 判断：跨 iframe、跨 realm 或被打包工具处理后，
    // instanceof TypeError 可能失效，因此改为按结构特征识别。
    const isNetworkError =
      err &&
      !err.code &&           // 我们自己包装的错误都带 code，排除掉
      !err.status &&         // 有 status 说明是 HTTP 层错误，交给下面的分支
      (err instanceof TypeError || err.name === "TypeError");

    if (isNetworkError) {
      return "无法连接到翻译系统。请检查网络连接，或关闭可能拦截请求的浏览器插件。";
    }
    if (err && err.status === 401) {
      return "翻译系统的通行证没有被承认，请检查 API Key 是否正确。";
    }
    // 余额不足、无可用资源包（智谱 code 1113）
    if (err && (err.apiCode === "1113" || /余额|资源包/.test(err.message || ""))) {
      return "翻译系统的账户余额不足了，请为智谱账户充值后再试。";
    }
    /* 注意判断顺序：
     *   err.allModelsBusy 是"所有备用模型都试过了"的通用标记，
     *   HTTP 500 与 429 都可能带上它。如果把 allModelsBusy 放在前面，
     *   服务器 5xx 会被误报成"使用的人太多了"。
     *   所以必须先判具体状态码，再落到 allModelsBusy 兜底。 */
    if (err && err.status === 429) {
      return "翻译系统现在使用的人实在是太多了，请稍等一会儿再试。";
    }
    if (err && err.status >= 500) {
      return "翻译系统暂时出现了一点非常机器的问题，请稍后再试。";
    }
    // 兜底：没有具体状态码，但确实所有模型都失败了（多为网络/超时）
    if (err && err.allModelsBusy) {
      return "翻译系统现在使用的人实在是太多了，请稍等一会儿再试。";
    }
    return "翻译系统暂时出现了一点非常机器的问题，请稍后再试。";
  }

  /* ======================================================================
   * 4. STORAGE —— 历史记录（localStorage）
   * ==================================================================== */

  const History = {
    /** 读取全部记录 */
    load() {
      try {
        const raw = safeStorage.get(CONFIG.HISTORY_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (e) {
        console.warn("[微软式翻译] 读取历史记录失败（数据可能已损坏，将重置）：", e);
        safeStorage.remove(CONFIG.HISTORY_KEY);
        return [];
      }
    },

    /** 保存全部记录（最多 HISTORY_LIMIT 条） */
    save(list) {
      return safeStorage.set(
        CONFIG.HISTORY_KEY,
        JSON.stringify(list.slice(0, CONFIG.HISTORY_LIMIT))
      );
    },

    /** 新增一条记录，返回新的列表 */
    add(record) {
      const list = History.load();
      list.unshift(record);
      const trimmed = list.slice(0, CONFIG.HISTORY_LIMIT);
      History.save(trimmed);
      return trimmed;
    },

    /** 清空 */
    clear() {
      safeStorage.remove(CONFIG.HISTORY_KEY);
      return [];
    },
  };

  /* ======================================================================
   * 5. UI —— DOM 与交互
   * ==================================================================== */

  // ---- 元素引用 ----
  const el = {
    input: document.getElementById("inputText"),
    output: document.getElementById("outputText"),
    counter: document.getElementById("charCounter"),
    status: document.getElementById("statusText"),
    translateBtn: document.getElementById("translateBtn"),
    cancelBtn: document.getElementById("cancelBtn"),
    clearBtn: document.getElementById("clearBtn"),
    copyBtn: document.getElementById("copyBtn"),
    retryBtn: document.getElementById("retryBtn"),
    randomBtn: document.getElementById("randomBtn"),
    levelRange: document.getElementById("levelRange"),
    levelLabel: document.getElementById("levelLabel"),
    levelDesc: document.getElementById("levelDesc"),
    historyList: document.getElementById("historyList"),
    clearHistoryBtn: document.getElementById("clearHistoryBtn"),
    toast: document.getElementById("toast"),
    modeInputs: Array.prototype.slice.call(
      document.querySelectorAll('input[name="mode"]')
    ),

    // --- 动效挂钩（只用到一个类名开关，失败也不影响功能） ---
    header: document.querySelector(".site-header"),
    modeRow: document.querySelector(".mode-row"),
    translateCard: document.querySelector(".translate-card"),

    // --- 设置面板 ---
    settingsBtn: document.getElementById("settingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    settingsCloseBtn: document.getElementById("settingsCloseBtn"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    toggleKeyBtn: document.getElementById("toggleKeyBtn"),
    modelSelect: document.getElementById("modelSelect"),
    saveKeyBtn: document.getElementById("saveKeyBtn"),
    clearKeyBtn: document.getElementById("clearKeyBtn"),
    keyStatus: document.getElementById("keyStatus"),

    // --- 首次使用引导 ---
    onboarding: document.getElementById("onboarding"),
    onboardingSetupBtn: document.getElementById("onboardingSetupBtn"),
    onboardingSkipBtn: document.getElementById("onboardingSkipBtn"),
  };

  // ---- 运行状态 ----
  const state = {
    loading: false,       // 是否正在请求（用于防止重复点击）
    hasResult: false,     // 当前是否已有结果
    lastRequest: null,    // 上一次请求参数，用于"重新翻译"
    requestSeq: 0,        // 请求序号：用于丢弃过期响应（防止竞态）
    lastFocused: null,    // 打开设置面板前的焦点元素，关闭时归还
    cancelled: false,     // 用户是否点了「取消」
    abortController: null,// 当前在途请求的控制器，用于取消
  };

  // ---- 随机示例 ----
  const SAMPLES = [
    "我今天特别开心，因为终于放假了。",
    "我决定今天早点睡觉。",
    "这个计划听起来非常不错。",
    "妈妈让我先去把作业写完，然后才能玩游戏。",
    "天气预报说，明天可能会下雨。",
    "我已经很久没有吃过这么好吃的拉面了。",
    "I'm really happy because we finally have a holiday.",
    "Tomorrow I will definitely finish my homework.",
    "I have no idea what is happening.",
    "Please remember to bring your umbrella tomorrow morning.",
    "This is the best day of my entire life.",
    "My computer crashed again while I was saving the file.",
  ];

  // ---- 工具函数 ----

  /** 当前选中的模式 */
  function getMode() {
    const checked = el.modeInputs.find(function (i) { return i.checked; });
    return checked ? checked.value : "auto";
  }

  /** 模式的中文名（用于历史记录） */
  function modeLabel(mode) {
    return { auto: "自动识别", zh: "中文 → 微软式中文", en: "英文 → 微软式中文" }[mode] || "自动识别";
  }

  /* ----------------------------------------------------------------------
   * 动效工具
   *
   * 原则：动画只是锦上添花，任何一步失败都不能影响功能。
   * 所以每个函数都自己兜底，不假设元素一定存在。
   * -------------------------------------------------------------------- */

  /** 重新触发一次 CSS 动画（同一个类连续加两次不会重放，必须先摘掉） */
  function replayClass(node, cls, ms) {
    if (!node) return;
    node.classList.remove(cls);
    // 读一次布局，强制浏览器"忘掉"上一次的动画状态
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(function () { node.classList.remove(cls); }, ms);
  }

  /** 输入有误时抖一下输入框：比只弹一句 toast 更容易被注意到 */
  function shakeInput() {
    replayClass(el.input, "is-shake", 460);
  }

  /**
   * 首屏卡片错落入场。
   *
   * 这里**不监听 animationend 去摘 .reveal**：jsdom 里动画永远不触发，
   * 监听器会一直挂在 DOM 上（实测把"监听器有界"的计数从 56 顶到 64）。
   * 保留 .reveal 是安全的 —— 动画的终点就是 transform: none / opacity: 1，
   * 和没加这个类完全等价。唯一有风险的是 position: fixed 的移动端历史抽屉
   * （动画的 fill 会永久压住它的 translateX），所以它被显式排除在外。
   */
  function revealAll() {
    const nodes = Array.prototype.slice
      .call(document.querySelectorAll("main .card"))
      .filter(function (n) { return !n.classList.contains("history-card"); });

    nodes.push(document.querySelector(".site-footer .wrap"));

    nodes.forEach(function (node, i) {
      if (!node) return;
      node.style.setProperty("--i", String(i));
      node.classList.add("reveal");
    });
  }

  /** 顶栏滚动态：滚动后加一点投影，视觉上"浮起来" */
  function bindHeaderElevation() {
    if (!el.header) return;
    let ticking = false;

    function update() {
      ticking = false;
      const y = window.scrollY || window.pageYOffset || 0;
      el.header.classList.toggle("is-scrolled", y > 4);
    }

    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
      else update();
    }, { passive: true });

    update();
  }

  /** 分段控件的游标跟着选中项滑过去 */
  function syncModeThumb() {
    if (!el.modeRow) return;
    const idx = el.modeInputs.findIndex(function (i) { return i.checked; });
    el.modeRow.style.setProperty("--seg", String(idx < 0 ? 0 : idx));
  }

  /** 设置右上角状态文字 */
  function setStatus(text, kind) {
    el.status.textContent = text || "";
    el.status.className = "status" + (kind ? " is-" + kind : "");
  }

  let firstSuccessTimer = null;

  /** 轻提示 */
  let toastTimer = null;
  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.className = "toast is-show" + (isError ? " is-error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.className = "toast" + (isError ? " is-error" : "");
    }, isError ? 4200 : 1800);
  }

  /**
   * 带操作按钮的轻提示（如"已清空 → 撤销"）。
   *
   * 用独立的操作按钮而不是改写文本，保证：
   *   · 按钮可聚焦、可点击（默认 toast 是 pointer-events: none 的）
   *   · 不破坏 showToast 的纯文本语义
   */
  let toastActionTimer = null;
  function showToastWithAction(message, actionLabel, onAction) {
    clearTimeout(toastTimer);
    clearTimeout(toastActionTimer);

    el.toast.textContent = message;
    el.toast.className = "toast is-show toast-has-action";

    // 移除旧的按钮，重建（避免累积监听器）
    const old = el.toast.querySelector(".toast-action");
    if (old) old.remove();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", function () {
      el.toast.className = "toast";
      onAction();
    });
    el.toast.appendChild(btn);

    toastActionTimer = setTimeout(function () {
      el.toast.className = "toast";
      const b = el.toast.querySelector(".toast-action");
      if (b) b.remove();
    }, 6000);
  }

  /* ----------------------------------------------------------------------
   * 设置面板 + 首次使用引导
   *
   * 这是"商用可用"的关键：访客不需要改源码，直接在页面上填 Key 即可。
   * -------------------------------------------------------------------- */

  /** 设置面板是否展开 */
  let settingsOpen = false;

  /** 打开设置面板 */
  function openSettings() {
    if (settingsOpen) {
      if (el.apiKeyInput) el.apiKeyInput.focus();
      return;
    }
    settingsOpen = true;
    state.lastFocused = document.activeElement;

    el.settingsPanel.hidden = false;
    el.settingsBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";   // 面板展开时锁定背景滚动

    // 回填当前状态
    if (el.apiKeyInput) {
      el.apiKeyInput.value = KeyStore.getUserKey() || "";
    }
    if (el.modelSelect) {
      el.modelSelect.value = KeyStore.resolveModel();
      // 如果当前模型不在下拉里（例如 config.js 指定的），补一个选项
      if (!el.modelSelect.value) {
        const opt = document.createElement("option");
        opt.value = KeyStore.resolveModel();
        opt.textContent = KeyStore.resolveModel() + "（来自配置）";
        el.modelSelect.appendChild(opt);
        el.modelSelect.value = KeyStore.resolveModel();
      }
    }
    updateKeyStatus();

    // 焦点移入面板，方便键盘用户
    if (el.apiKeyInput) el.apiKeyInput.focus();
  }

  /** 关闭设置面板 */
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    el.settingsPanel.hidden = true;
    el.settingsBtn.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";   // 解除滚动锁定

    // 清空输入框里的 Key，避免明文残留在 DOM 里
    if (el.apiKeyInput) {
      el.apiKeyInput.value = "";
      el.apiKeyInput.type = "password";
      el.toggleKeyBtn.textContent = "显示";
      el.toggleKeyBtn.setAttribute("aria-pressed", "false");
    }

    // 焦点归还给触发元素
    const back = state.lastFocused && state.lastFocused.focus
      ? state.lastFocused
      : el.settingsBtn;
    if (back && back.focus) back.focus();
  }

  /** 刷新 Key 状态文案（用中性图标文字，不用任何符号/emoji） */
  function updateKeyStatus() {
    if (!el.keyStatus) return;

    const effective = KeyStore.resolve();
    const own = KeyStore.getUserKey();

    if (effective && own) {
      el.keyStatus.textContent = "正在使用你自己填写的 API Key。";
      el.keyStatus.className = "field-help is-ok";
    } else if (effective) {
      el.keyStatus.textContent = "正在使用本站预置的 API Key（你也可以填自己的来覆盖它）。";
      el.keyStatus.className = "field-help is-ok";
    } else if (isVaultUsable()) {
      el.keyStatus.textContent = "正在准备本站内置的翻译服务……";
      el.keyStatus.className = "field-help";
      unlockEmbeddedKey().then(function (k) {
        if (!el.keyStatus) return;
        if (k) {
          el.keyStatus.textContent =
            "本站已内置翻译服务，直接使用即可。填自己的 Key 可以覆盖它。";
          el.keyStatus.className = "field-help is-ok";
        } else {
          el.keyStatus.textContent =
            "内置翻译服务在当前环境不可用，请填写自己的 API Key。";
          el.keyStatus.className = "field-help is-warn";
        }
        updateKeyIndicator();
      });
    } else {
      el.keyStatus.textContent = "还没有可用的翻译服务，请填写 API Key 后使用。";
      el.keyStatus.className = "field-help is-warn";
    }

    if (!safeStorage.available) {
      el.keyStatus.textContent +=
        "（当前浏览器禁用了本地存储，设置无法保存，可能是隐私模式。）";
      el.keyStatus.className = "field-help is-warn";
    }
  }

  /**
   * 当前是否"可以直接翻译"。
   *
   * 代理模式下由服务端持有 Key，访客什么都不用填 —— 这时不该再弹引导、
   * 也不该在设置按钮上标红点，否则会误导用户以为还得自己配 Key。
   *
   * 注意：代理可用性是异步探测的，这里只做"乐观判断"：
   * 只要配置了 PROXY_URL 就先当作可用，真失败了再由错误处理兜底。
   */
  function isReadyToTranslate() {
    if (CONFIG.PROXY_URL) return true;   // 交给服务端，访客无需配置
    if (KeyStore.resolve()) return true;
    // 内置 Key 正在解密（或即将解密）：先当作可用，真失败时再兜底提示，
    // 否则首屏会先闪一下"请填写 Key"的引导，体验很差。
    return isVaultUsable();
  }

  /** 首次使用引导 */
  let onboardingShown = false;
  function maybeShowOnboarding() {
    // 已经有可用的 Key（或走代理），或者用户之前选择过"先随便看看"，就不再打扰
    if (isReadyToTranslate()) return;
    if (safeStorage.get("msstyle_onboard_skipped") === "1") return;
    if (onboardingShown) return;

    onboardingShown = true;
    el.onboarding.hidden = false;
    // 把焦点移入对话框
    if (el.onboardingSetupBtn) el.onboardingSetupBtn.focus();
  }

  function hideOnboarding() {
    el.onboarding.hidden = true;
    onboardingShown = false;
  }

  /** 历史记录：有记录时显示 FAB（移动端入口）+ 卡片内容，无记录时收起 */
  function updateHistoryCount() {
    const title = document.getElementById("historyTitle");
    const card = document.querySelector(".history-card");
    const fab = document.getElementById("historyFab");
    const n = History.load().length;

    if (title) title.textContent = n ? "历史记录（" + n + "）" : "历史记录";
    if (card) card.hidden = n === 0;
    if (fab) fab.hidden = n === 0;
  }

  /** 顶栏「设置」按钮上给出状态小圆点，让用户一眼看出能不能直接用 */
  function updateKeyIndicator() {
    if (!el.settingsBtn) return;

    // 代理模式：服务端已配好 Key，无需访客操心
    if (CONFIG.PROXY_URL) {
      el.settingsBtn.classList.remove("needs-key");
      el.settingsBtn.title = "设置（本站已配置好翻译服务，直接用即可）";
      return;
    }

    const ready = isReadyToTranslate();
    el.settingsBtn.classList.toggle("needs-key", !ready);
    el.settingsBtn.title = ready ? "设置" : "还没有可用的翻译服务，点击查看";
  }

  /** 更新字符计数（接近上限时渐进提醒：90% 变橙，100% 变红加粗） */
  function updateCounter() {
    const len = el.input.value.length;
    el.counter.textContent = len + " / " + CONFIG.MAX_INPUT;
    el.counter.classList.toggle("is-over", len >= CONFIG.MAX_INPUT);
    el.counter.classList.toggle("is-warn",
      len >= CONFIG.MAX_INPUT * 0.9 && len < CONFIG.MAX_INPUT);
  }

  /* ----------------------------------------------------------------------
   * 输入草稿
   *
   * 手机上打好一段话，误触刷新 / 切后台被系统回收，回来全没了 ——
   * 这是这类小工具最劝退的一种体验。所以把输入框内容存一份在本地。
   *
   * 三个刻意的取舍：
   *   · 防抖 400ms 再写：打字时每个键都同步写一次 localStorage 会掉帧。
   *     代价是"打完字 400ms 内就关掉标签页"会丢最后几个字 ——
   *     故意没加 pagehide 监听来补这个洞：监听器总数有预算上限
   *     （test-long-session 要求 < 60），历史条目已经吃掉一大半，
   *     为一个 400ms 的边角情况再加监听不划算。点翻译时会立即落盘。
   *   · 只存 MAX_INPUT 个字符：这一项的大小因此天然有上限。
   *   · 点「清空」时一起清掉：用户已经明确说"我不要了"，
   *     下次打开还看到旧文字会很诡异（手滑的情况有「撤销」兜底）。
   * -------------------------------------------------------------------- */
  let draftTimer = null;

  function saveDraftNow() {
    const v = el.input.value;
    if (!v) { safeStorage.remove(CONFIG.DRAFT_KEY); return; }
    safeStorage.set(CONFIG.DRAFT_KEY, v.slice(0, CONFIG.MAX_INPUT));
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      draftTimer = null;
      saveDraftNow();
    }, 400);
  }

  /**
   * 立刻落盘并取消挂起的防抖定时器。
   *
   * 用在"状态要变了"的节点上（提交翻译、页面要卸载）。
   * 除了保证内容不丢，也避免留一个没人管的定时器在后台跑 ——
   * test-long-session 会数"翻译结束后还没清理的定时器"，
   * 防抖定时器如果跨过一次完整请求周期留着，就会被算成泄漏。
   */
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    saveDraftNow();
  }

  /** 恢复上次没翻译完的输入；返回是否真的恢复了内容 */
  function restoreDraft() {
    const saved = safeStorage.get(CONFIG.DRAFT_KEY);
    if (!saved || !String(saved).trim()) return false;
    el.input.value = String(saved).slice(0, CONFIG.MAX_INPUT);
    updateCounter();
    return true;
  }

  /**
   * 手机上把结果滚进视野。
   *
   * 桌面端两栏并排，结果就在右手边，不需要滚；
   * 手机是上下堆叠，输入框一撑高，翻译完结果常常还在屏幕下面，
   * 用户会以为"没反应"。所以只在窄屏 + 结果确实看不见时才滚。
   */
  function revealResult() {
    try {
      if (window.innerWidth > 860) return;          // 桌面并排，不用滚
      if (!el.output || !el.output.getBoundingClientRect) return;
      const box = el.output.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      // 结果区大部分已在视野内就别动，避免打断正在看字的人
      const visible = Math.min(box.bottom, vh) - Math.max(box.top, 0);
      if (box.height <= 0 || visible > box.height * 0.6) return;
      window.scrollTo({ top: window.scrollY + box.top - 16, behavior: "smooth" });
    } catch (e) {
      /* 滚动纯属锦上添花，任何异常都不该影响翻译结果本身 */
    }
  }

  /**
   * 自适应输入框高度（随内容增长，但不撑爆页面）。
   *
   * 性能：autoGrow 内部是"写 height:auto → 读 scrollHeight → 写 height"，
   * 属于典型的强制同步重排（layout thrash）。如果每次按键都直接跑，
   * 在长文本下会明显卡顿。所以用 requestAnimationFrame 合并同一帧内的多次调用。
   */
  let growPending = false;
  function autoGrow() {
    if (growPending) return;
    growPending = true;

    const run = function () {
      growPending = false;
      el.input.style.height = "auto";
      const maxH = Math.round(window.innerHeight * 0.46);
      const next = Math.min(el.input.scrollHeight, maxH);
      el.input.style.height = Math.max(next, 148) + "px";
    };

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  /** 立即执行一次高度计算（不需要 rAF 的场景，如初始化） */
  function autoGrowNow() {
    el.input.style.height = "auto";
    const maxH = Math.round(window.innerHeight * 0.46);
    const next = Math.min(el.input.scrollHeight, maxH);
    el.input.style.height = Math.max(next, 148) + "px";
  }

  /** 渲染输出区 */
  /** 建议芯片（ChatGPT 风格）：空状态时给用户可一键试的例子 */
  const SUGGESTION_CHIPS = [
    "我今天特别开心，因为终于放假了。",
    "Sit back and relax.",
    "我决定今天早点睡觉。",
    "The meeting starts at 9 AM.",
  ];

  function renderOutput(text) {
    el.output.innerHTML = "";
    if (!text) {
      const p = document.createElement("p");
      p.className = "output-placeholder";
      p.textContent = "翻译结果将会出现在这里。试试：";
      el.output.appendChild(p);

      // 建议芯片
      const wrap = document.createElement("div");
      wrap.className = "chips";
      SUGGESTION_CHIPS.forEach(function (chip, i) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.style.setProperty("--i", String(i));
        b.textContent = chip;
        b.addEventListener("click", function () {
          el.input.value = chip;
          el.input.dispatchEvent(new Event("input", { bubbles: true }));
          doTranslate(false);
        });        wrap.appendChild(b);
      });
      el.output.appendChild(wrap);
      return;
    }
    const p = document.createElement("p");
    p.className = "output-text output-fade-in";
    p.textContent = text;         // 使用 textContent 而不是 innerHTML，避免 XSS
    el.output.appendChild(p);
  }

  /** 渲染加载状态 */
  function renderLoading() {
    el.output.innerHTML = "";
    const p = document.createElement("p");
    p.className = "output-placeholder";
    p.textContent = "正在进行非常认真的机器翻译……";
    el.output.appendChild(p);

    const bar = document.createElement("div");
    bar.className = "loading-bar";
    el.output.appendChild(bar);

    // 骨架：三行正在"成形"的文字，比一行提示更有进度感
    const sk = document.createElement("div");
    sk.className = "skeleton";
    for (let i = 0; i < 3; i++) sk.appendChild(document.createElement("span"));
    el.output.appendChild(sk);
  }

  /** 更新按钮禁用状态 */
  function syncButtons() {
    const busy = state.loading;
    el.translateBtn.disabled = busy;
    el.retryBtn.disabled = busy || !state.lastRequest;
    el.copyBtn.disabled = busy || !state.hasResult;

    // 主按钮：翻译中内嵌 spinner + 文案变化
    // （用 textContent + 独立 span，保持「不用 innerHTML 写外部内容」的安全模式）
    el.translateBtn.textContent = busy ? "正在翻译" : "开始翻译";
    el.translateBtn.classList.toggle("is-busy", busy);

    // 翻译中才显示「取消」——平时不占位置，避免干扰
    if (el.cancelBtn) el.cancelBtn.hidden = !busy;

    // 翻译中：中间的箭头开始呼吸，让等待有方向感
    if (el.translateCard) el.translateCard.classList.toggle("is-loading", busy);
  }

  /** 更新滑块文字 */
  let lastShownLevel = null;
  function syncLevel(level) {
    // LEVELS 来自 prompt.js。万一它没加载（部署不完整），
    // 这里不能直接读 info.name —— 那会抛异常并让整个 init() 中断，
    // 连"缺文件"的提示都来不及显示（实测踩过）。
    const info = LEVELS[level] || LEVELS[3];
    if (!info) return;

    const label = level + " · " + info.name;
    el.levelLabel.textContent = label;
    el.levelDesc.textContent = info.desc;

    // 无障碍：屏幕阅读器读的是 aria-valuetext，而不是可见文字。
    // 之前漏了这句，导致无论滑块在哪一档，读屏软件都念"3 · 重度微软式"。
    el.levelRange.setAttribute("aria-valuetext", label);

    // 档位真的变了才弹一下（首屏不弹，避免一进页面就在动）
    if (lastShownLevel !== null && lastShownLevel !== level) {
      replayClass(el.levelLabel, "is-pop", 400);
    }
    lastShownLevel = level;
  }

  // ---- 历史记录渲染 ----

  /**
   * 时间戳格式化。
   *
   * 说明：显示用的是浏览器本地时区（用户看了才顺眼），
   * 但页面里同时会输出一个机器可读的 ISO 时间戳（<time datetime>），
   * 这样屏幕阅读器和将来的导出/同步都有确定的基准。
   *
   * @param {number} ts epoch 毫秒
   * @returns {{label: string, iso: string}} label 给眼睛看，iso 给机器读
   */
  function formatTime(ts) {
    const d = new Date(ts);
    // 数据损坏时 ts 可能不是合法数字，兜底避免显示 NaN
    if (isNaN(d.getTime())) {
      return { label: "时间未知", iso: "" };
    }
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return {
      label:
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()),
      // toISOString 会转成 UTC，带上 Z 后缀，语义明确
      iso: d.toISOString(),
    };
  }

  function renderHistory(list) {
    el.historyList.innerHTML = "";

    if (!list.length) {
      const li = document.createElement("li");
      li.className = "history-empty";
      li.textContent = "还没有记录。你的前 10 次翻译将被保存在这台设备上。";
      el.historyList.appendChild(li);
      return;
    }

    list.forEach(function (record, index) {
      const li = document.createElement("li");
      li.className = "history-item";
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.title = "点击可重新查看这条记录";
      // 错落入场：最多 6 条参与，再多就一起出现，避免等太久
      li.style.setProperty("--i", String(Math.min(index, 6)));

      const meta = document.createElement("div");
      meta.className = "history-meta";

      const tag = document.createElement("span");
      tag.className = "history-tag";
      tag.textContent = modeLabel(record.mode);

      // 用 <time datetime="ISO"> 输出，既有给人看的时间，也有给机器读的标准时间
      const t = formatTime(record.time);
      const time = document.createElement("time");
      time.textContent = t.label;
      if (t.iso) time.setAttribute("datetime", t.iso);

      const lv = document.createElement("span");
      lv.textContent = "程度 " + (record.level || 3);

      meta.appendChild(tag);
      meta.appendChild(lv);
      meta.appendChild(time);

      const src = document.createElement("div");
      src.className = "history-src";
      src.textContent = record.source;

      const dst = document.createElement("div");
      dst.className = "history-dst";
      dst.textContent = record.result;

      // 单条复制按钮：不冒泡到整条回填
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "history-copy";
      copyBtn.setAttribute("aria-label", "复制这条翻译结果");
      copyBtn.title = "复制结果";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        copyText(record.result).then(function (ok) {
          if (!ok) return;
          copyBtn.textContent = "已复制";
          copyBtn.classList.add("is-done");
          copyBtn.disabled = true;
          setTimeout(function () {
            copyBtn.textContent = "复制";
            copyBtn.classList.remove("is-done");
            copyBtn.disabled = false;
          }, 1600);
        });
      });

      li.appendChild(meta);
      li.appendChild(copyBtn);
      li.appendChild(src);
      li.appendChild(dst);

      // 点击 / 回车 → 回填到界面
      function apply() {
        el.input.value = record.source;
        updateCounter();
        autoGrow();
        // 直接改 value 不会触发 input 事件，草稿要手动同步一次，
        // 否则刷新后回来的还是上一条草稿，而不是刚选中的这条。
        flushDraft();
        renderOutput(record.result);
        state.hasResult = true;
        state.lastRequest = {
          text: record.source,
          mode: record.mode,
          level: record.level || 3,
        };
        syncButtons();
        setStatus("已从历史记录中载入", "done");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }

      li.addEventListener("click", apply);
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          apply();
        }
      });

      el.historyList.appendChild(li);
    });
  }

  // ---- 核心流程：翻译 ----

  /**
   * 执行一次翻译。
   * @param {boolean} isRetry 是否为"重新翻译"（会重新调用 API）
   */
  async function doTranslate(isRetry) {
    // --- 部署不完整：直接说明原因，而不是静默无反应 ---
    if (PROMPTS_MISSING) {
      showToast("部署不完整：缺少 prompt.js，翻译功能无法使用。", true);
      showMissingPromptsNotice();
      return;
    }

    // --- 防重复点击 ---
    if (state.loading) {
      showToast("机器还在认真地翻译上一条，请稍等一下。", false);
      return;
    }

    const text = el.input.value.trim();
    if (!text) {
      showToast("请先输入一点内容，机器才有东西可以翻译。", true);
      shakeInput();
      el.input.focus();
      return;
    }
    if (text.length > CONFIG.MAX_INPUT) {
      showToast("输入太长了，请控制在 " + CONFIG.MAX_INPUT + " 个字符以内。", true);
      shakeInput();
      return;
    }

    // 没有可用的翻译通道：直接把用户引导到设置面板，而不是让他干瞪眼
    // （代理模式下服务端已配好 Key，isReadyToTranslate() 会返回 true，不会走到这里）
    if (!isReadyToTranslate()) {
      showToast("请先填写 API Key，点右上角「设置」即可。", true);
      openSettings();
      return;
    }

    const mode = getMode();
    const level = parseInt(el.levelRange.value, 10) || 3;

    // 提交即落盘，顺手取消挂起的防抖定时器（别让它跨过整个请求周期）
    flushDraft();

    // --- 进入加载状态 ---
    // requestSeq：每发起一次请求就自增。响应回来时如果序号已经变了，
    // 说明期间又发起了新请求，这条结果已经过期，直接丢弃，避免旧结果覆盖新结果。
    const seq = ++state.requestSeq;

    state.loading = true;
    state.hasResult = false;
    state.cancelled = false;      // 新一轮开始，清掉上次的取消标记
    state.abortController = null;
    state.lastRequest = { text: text, mode: mode, level: level };
    renderLoading();
    setStatus("正在进行非常认真的机器翻译……", "busy");
    syncButtons();

    // 请求较慢时给出渐进提示，避免用户以为页面卡死。
    // 6 秒后换成"仍在努力"，这样 19 秒的降级等待也不会让人困惑。
    const slowTimer = setTimeout(function () {
      if (state.loading && seq === state.requestSeq) {
        setStatus("这台机器有点慢，它仍然在努力……", "busy");
        const ph = el.output.querySelector(".output-placeholder");
        if (ph) ph.textContent = "这台机器有点慢，它仍然在努力地进行翻译……";
      }
    }, 6000);

    try {
      const result = await requestTranslation({ text: text, mode: mode, level: level });

      // 过期响应直接丢弃
      if (seq !== state.requestSeq) return;

      // --- 成功 ---
      renderOutput(result);
      state.hasResult = true;
      setStatus(isRetry ? "已经重新翻译完成" : "翻译完成", "done");

      // 完成态微反馈：输出区短暂绿色描边
      el.output.classList.add("is-success");
      setTimeout(function () {
        el.output.classList.remove("is-success");
      }, 1300);

      // 首次成功：轻量引导用户复制（Apple 风的"下一步"提示，只出现一次）
      if (!safeStorage.get("msstyle_first_success")) {
        safeStorage.set("msstyle_first_success", "1");
        firstSuccessTimer = setTimeout(function () {
          firstSuccessTimer = null;
          if (state.loading || !state.hasResult) return;
          showToast("提示：点「复制结果」可以把译文带走。", false);
        }, 600);
      }

      // 写入历史记录
      const list = History.add({
        source: text,
        result: result,
        time: Date.now(),
        mode: mode,
        level: level,
      });
      renderHistory(list);
      updateHistoryCount();

      // 手机上输入框会把结果顶到屏幕外，滚一下让用户立刻看到译文
      revealResult();
    } catch (err) {
      // 过期请求的失败同样丢弃，避免干扰新一轮请求
      if (seq !== state.requestSeq) return;

      // --- 用户主动取消：中性处理，不当作错误 ---
      if (err && err.userCancelled) {
        state.hasResult = false;
        renderOutput("");
        setStatus("已取消", "done");
        showToast("已经取消这次翻译。", false);
        return;
      }

      // --- 失败：给用户友好提示，真实错误留在 console ---
      const msg = friendlyError(err);
      state.hasResult = false;
      renderOutput("");
      setStatus("翻译没有成功", "error");
      showToast(msg, true);

      // Key 无效时顺手把设置面板打开，让用户能立刻改
      if (err && (err.status === 401 || err.code === "NO_API_KEY")) {
        openSettings();
      }
    } finally {
      clearTimeout(slowTimer);
      // 只有仍是最新一轮请求时才复位 loading，
      // 否则会把新一轮的加载状态误清掉。
      if (seq === state.requestSeq) {
        state.loading = false;
        syncButtons();
      }
    }
  }

  // ---- 复制 ----

  /**
   * 复制任意文本（核心实现，供主复制按钮与历史项复制共用）。
   * @returns {Promise<boolean>} 是否成功
   */
  async function copyText(text) {
    // 先尝试现代剪贴板 API；失败（微信内置浏览器、iframe、权限被拒等）
    // 再退回 execCommand 方案，两条路都失败才报失败。
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        console.warn("[微软式翻译] clipboard API 失败，改用 execCommand 兜底：", e);
      }
    }
    return legacyCopy(text);
  }

  async function copyResult() {
    const text = (el.output.querySelector(".output-text") || {}).textContent || "";
    if (!text) return;

    const copied = await copyText(text);

    if (copied) {
      showToast("已复制", false);
      // 复制按钮内联反馈：按钮自身短暂变成「已复制」
      const btn = el.copyBtn;
      const original = btn.textContent;
      btn.textContent = "已复制";
      btn.disabled = true;
      setTimeout(function () {
        btn.textContent = original;
        syncButtons();
      }, 1600);
    } else {
      // 不打印 error 级别，避免在正常降级路径上刷红
      console.warn("[微软式翻译] 两种复制方案都不可用，请用户手动选择文本。");
      showToast("复制没有成功，请长按结果手动选择文本。", true);
    }
  }

  /**
   * 传统复制方案：创建一个隐藏 textarea 并 execCommand("copy")。
   * 兼容 http 页面、微信内置浏览器与部分老设备。
   * @returns {boolean} 是否复制成功
   */
  function legacyCopy(text) {
    let ta = null;
    try {
      ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      // 放在视口内但不可见，iOS 上 position: fixed + 负偏移更稳
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.width = "1px";
      ta.style.height = "1px";
      ta.style.padding = "0";
      ta.style.border = "none";
      ta.style.outline = "none";
      ta.style.boxShadow = "none";
      ta.style.background = "transparent";
      ta.style.opacity = "0";
      document.body.appendChild(ta);

      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);

      const ok = document.execCommand("copy");
      return !!ok;
    } catch (e) {
      console.warn("[微软式翻译] execCommand 复制失败：", e);
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    // 开始翻译
    el.translateBtn.addEventListener("click", function () {
      doTranslate(false);
    });

    // 重新翻译
    el.retryBtn.addEventListener("click", function () {
      doTranslate(true);
    });

    // 取消正在进行的翻译
    if (el.cancelBtn) {
      el.cancelBtn.addEventListener("click", function () {
        if (!state.loading) return;

        state.cancelled = true;
        state.requestSeq++;              // 让在途响应失效（即使 abort 没生效）
        if (state.abortController) {
          try { state.abortController.abort(); } catch (e) { /* 忽略 */ }
        }

        state.loading = false;
        state.hasResult = false;
        renderOutput("");
        setStatus("已取消", "done");
        showToast("已经取消这次翻译。", false);
        syncButtons();
      });
    }

    // 复制结果
    el.copyBtn.addEventListener("click", copyResult);

    // 清空输入（带撤销：清空后 toast 里可一键恢复）
    el.clearBtn.addEventListener("click", function () {
      const prev = el.input.value;
      if (!prev) return;

      el.input.value = "";
      updateCounter();
      autoGrow();
      // 用户明确表达"不要了"，草稿也要一起清掉
      flushDraft();
      el.input.focus();

      // 撤销入口：复用 toast，点「撤销」恢复原内容
      showToastWithAction("已清空。", "撤销", function () {
        el.input.value = prev;
        updateCounter();
        autoGrow();
        flushDraft();
        el.input.focus();
      });
    });

    // 随机示例
    el.randomBtn.addEventListener("click", function () {
      const current = el.input.value.trim();
      let next = current;
      // 尽量避免连续两次抽到同一句
      for (let i = 0; i < 5 && next === current; i++) {
        next = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
      }
      el.input.value = next;
      updateCounter();
      autoGrow();
      flushDraft();
      el.input.focus();
    });

    // 输入框：计数 + 自适应高度 + 草稿
    el.input.addEventListener("input", function () {
      updateCounter();
      autoGrow();
      scheduleDraftSave();
    });

    // Ctrl / ⌘ + Enter 开始翻译
    el.input.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doTranslate(false);
      }
    });

    // 翻译程度滑块
    el.levelRange.addEventListener("input", function () {
      const level = parseInt(el.levelRange.value, 10) || 3;
      syncLevel(level);
      safeStorage.set(CONFIG.LEVEL_KEY, String(level));
    });

    // 语言模式：让分段控件的游标滑到选中项
    // （原生的 radio 已经负责选中语义，这里只补一个视觉位移）
    // 用事件委托而不是逐个绑定：radio 的 change 会冒泡，
    // 一个监听器顶三个，也少一份"监听器泄漏"的风险。
    if (el.modeRow) el.modeRow.addEventListener("change", syncModeThumb);

    // 清空历史
    el.clearHistoryBtn.addEventListener("click", function () {
      if (!History.load().length) {
        showToast("历史记录本来就是空的。", false);
        return;
      }
      if (window.confirm("确定要清空全部历史记录吗？")) {
        renderHistory(History.clear());
        updateHistoryCount();
        closeHistoryDrawer();
        showToast("历史记录已经清空。", false);
      }
    });

    // ---- 移动端历史抽屉 ----
    const fab = document.getElementById("historyFab");
    const closeBtn = document.getElementById("historyCloseBtn");

    /* 移动端历史抽屉：打开时锁定页面滚动（防止 iOS 橡皮筋穿帮） */
    function closeHistoryDrawer() {
      document.body.classList.remove("history-open");
      document.body.style.overflow = "";
      const bd = document.querySelector(".history-backdrop");
      if (bd) bd.hidden = true;
      if (fab) fab.setAttribute("aria-expanded", "false");
      if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
      drawerReturnFocus = null;
    }

    let drawerReturnFocus = null;
    function openHistoryDrawer() {
      drawerReturnFocus = document.activeElement;
      document.body.classList.add("history-open");
      document.body.style.overflow = "hidden";   // 锁定背景滚动
      const bd = document.querySelector(".history-backdrop");
      if (bd) bd.hidden = false;
      if (fab) fab.setAttribute("aria-expanded", "true");
      renderHistory(History.load());   // 打开时刷新列表
    }

    if (fab) {
      fab.addEventListener("click", openHistoryDrawer);
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", closeHistoryDrawer);
    }
    // 点遮罩关闭（遮罩是独立元素，因为 ::after 不接收事件）
    const backdrop = document.createElement("div");
    backdrop.className = "history-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", closeHistoryDrawer);
    document.body.appendChild(backdrop);

    document.body.addEventListener("click", function (e) {
      if (!document.body.classList.contains("history-open")) return;
      if (e.target === document.body) closeHistoryDrawer();
    });
    // Esc 关闭（历史抽屉），若抽屉未开则交给设置面板处理
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (document.body.classList.contains("history-open")) {
        closeHistoryDrawer();
      } else if (settingsOpen) {
        closeSettings();
      }
    });

    // ---- 设置面板 ----
    el.settingsBtn.addEventListener("click", function () {
      if (settingsOpen) closeSettings();
      else openSettings();
    });
    el.settingsCloseBtn.addEventListener("click", closeSettings);

    // 显示 / 隐藏 Key
    el.toggleKeyBtn.addEventListener("click", function () {
      const showing = el.apiKeyInput.type === "text";
      el.apiKeyInput.type = showing ? "password" : "text";
      el.toggleKeyBtn.textContent = showing ? "显示" : "隐藏";
      el.toggleKeyBtn.setAttribute("aria-pressed", showing ? "false" : "true");
    });

    // 保存设置
    el.saveKeyBtn.addEventListener("click", function () {
      const key = el.apiKeyInput.value.trim();

      if (key && !KeyStore.isValid(key)) {
        showToast("这个 API Key 看起来不太对，请检查一下。", true);
        return;
      }

      if (key) {
        if (!KeyStore.saveUserKey(key)) {
          showToast("保存失败：当前浏览器不允许本地存储（可能是隐私模式）。", true);
          return;
        }
      } else {
        KeyStore.clearUserKey();
      }

      if (el.modelSelect && el.modelSelect.value) {
        KeyStore.saveModel(el.modelSelect.value);
      }

      el.apiKeyInput.value = "";
      updateKeyStatus();
      updateKeyIndicator();
      hideOnboarding();
      showToast(key ? "设置已保存，可以开始翻译了。" : "已清除你填写的 Key。", false);
    });

    // 清除 Key
    el.clearKeyBtn.addEventListener("click", function () {
      KeyStore.clearUserKey();
      if (el.apiKeyInput) el.apiKeyInput.value = "";
      updateKeyStatus();
      updateKeyIndicator();
      showToast("已清除你自己填写的 Key。", false);
    });

    // 设置面板内按 Esc 关闭
    el.settingsPanel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSettings();
      }
    });

    // ---- 首次使用引导 ----
    el.onboardingSetupBtn.addEventListener("click", function () {
      hideOnboarding();
      openSettings();
    });
    el.onboardingSkipBtn.addEventListener("click", function () {
      // 记住"先随便看看"，不再反复弹
      safeStorage.set("msstyle_onboard_skipped", "1");
      hideOnboarding();
    });

    // 窗口尺寸变化时重新计算输入框高度（横竖屏切换）
    let resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(autoGrow, 150);
    });
  }

  // ---- 初始化 ----
  function init() {
    /* ------------------------------------------------------------------
     * 最先检查部署完整性。
     *
     * 缺少 prompt.js 时，LEVELS 是空对象，后面任何读 LEVELS 的代码
     * （如 syncLevel）都会抛异常并中断 init —— 连提示都显示不出来。
     * 所以这一检查必须放在**所有依赖 prompt.js 的逻辑之前**。
     * ------------------------------------------------------------------ */
    if (PROMPTS_MISSING) {
      showMissingPromptsNotice();
      // 仍然绑定事件：否则点按钮完全没反应，用户以为是页面卡死。
      // 绑定后点击会弹出"缺少 prompt.js"的提示，比静默好得多。
      bindEvents();
      console.error("[微软式翻译] 初始化中止：缺少 prompt.js。");
      return;
    }

    // 恢复上次选择的翻译程度（默认 3：重度微软式，偏向"微软"一侧）
    let level = 3;
    const saved = parseInt(safeStorage.get(CONFIG.LEVEL_KEY), 10);
    if (saved >= 1 && saved <= 4) level = saved;
    el.levelRange.value = String(level);
    syncLevel(level);

    // 先恢复草稿，再算高度与计数 —— 顺序反了会出现"输入框先矮后跳高"
    const hasDraft = restoreDraft();
    updateCounter();
    autoGrowNow();   // 初始化时需要立即定高，避免首屏跳动
    renderOutput("");
    renderHistory(History.load());
    updateHistoryCount();
    syncButtons();
    bindEvents();
    updateKeyIndicator();

    // 恢复了草稿就要说出来：凭空出现在输入框里的文字会让人困惑，
    // 甚至怀疑是不是自己刚才误操作留下的。
    if (hasDraft) {
      setStatus("已恢复上次未翻译的内容", "done");
    }

    // 动效：首屏错落入场 + 顶栏滚动态 + 分段游标归位。
    // 这三件事纯属视觉，任何一个失败都不该影响页面可用性。
    try {
      revealAll();
      bindHeaderElevation();
      syncModeThumb();
    } catch (e) {
      console.warn("[微软式翻译] 入场动效初始化失败（不影响使用）：", e);
    }

    // 内置 Key 提前解密：用户看页面 + 打字的这几秒足够完成，
    // 真正点翻译时就不用再等（否则首次点击会有几十毫秒的额外延迟）。
    if (isVaultUsable()) {
      unlockEmbeddedKey().then(function (k) {
        updateKeyIndicator();
        if (!k && !CONFIG.PROXY_URL && !KeyStore.getUserKey()) {
          // 解密失败要给出可操作的出路，否则用户点翻译只会看到报错
          showToast("本站内置的翻译服务暂时不可用，可以在「设置」里填写自己的 Key。", true);
        }
      });
    }

    // 没有可用的 Key 时，用页面内的引导代替 console 提示
    if (!isReadyToTranslate()) {
      maybeShowOnboarding();
      console.warn(
        "[微软式翻译] 还没有可用的 API Key，已经弹出引导。\n" +
        "访客可以在页面右上角「设置」里填写；部署者也可以预置（见 README）。"
      );
    }

    // 提前把提示文案里的模型名同步一次
    // （代理模式下由服务端决定模型，这里只影响设置面板的默认选项）
    if (el.modelSelect) el.modelSelect.value = KeyStore.resolveModel();

    // 代理模式：模型与 Key 都由服务端管，把设置面板里相关项隐藏，避免误导
    if (CONFIG.PROXY_URL) applyProxyModeUI();
  }

  /** 代理模式下调整设置面板，隐藏与访客无关的项 */
  function applyProxyModeUI() {
    if (el.apiKeyInput && el.apiKeyInput.closest(".field")) {
      el.apiKeyInput.closest(".field").hidden = true;
    }
    if (el.modelSelect && el.modelSelect.closest(".field")) {
      el.modelSelect.closest(".field").hidden = true;
    }
    if (el.saveKeyBtn) el.saveKeyBtn.hidden = true;
    if (el.clearKeyBtn) el.clearKeyBtn.hidden = true;

    if (el.keyStatus) {
      el.keyStatus.textContent = "本站已配置好翻译服务，直接使用即可，无需填写 API Key。";
      el.keyStatus.className = "field-help is-ok";
    }
  }

  // DOM 就绪后启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
