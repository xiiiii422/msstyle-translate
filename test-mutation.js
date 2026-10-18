require("./check-integrity.js");   // 防止变异测试被中断后带伤运行
/* 变异测试：故意破坏产品代码，确认 test-pageload.js 真的能发现。
   一个从不失败的保护没有价值 —— 第 5 轮 Worker 的教训。

   实现说明：本环境禁止对子进程做管道捕获（execFileSync/spawnSync 的
   stdio:"pipe" 会 EPERM），因此这里不用子进程 —— 改为在**同一进程内**
   反复以不同文件内容运行测试逻辑。

   做法：把 test-pageload.js 改造成可复用函数不方便，于是这里直接
   require 它并观察它的退出码行不通（process.exit 会杀掉本进程）。
   折中方案：用 stdio:"inherit" 跑子进程，只判断退出码。
   inherit 是允许的，退出码可以从 spawn 的 'exit' 事件拿到。 */
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

/* ----------------------------------------------------------------------
 * 安全机制：绝不能把被破坏的代码留在仓库里
 *
 * 教训：早期版本的变异测试在被中断时（Ctrl+C / 超时 / 崩溃）
 *       会把改坏的文件留在磁盘上。实测发生过一次 ——
 *       `_headers` 的 X-Content-Type-Options 被删掉后没恢复，
 *       直到下一轮 check-csp.js 报警才发现。
 *
 * 三重保护：
 *   1. 把原文件备份到 .mutation-backup/ 目录（不依赖进程内存）
 *   2. 注册 exit / SIGINT / SIGTERM / uncaughtException 全部恢复
 *   3. 每次运行前先检查有没有上次残留的备份，有就自动还原
 * -------------------------------------------------------------------- */
const BACKUP_DIR = path.join(__dirname, ".mutation-backup");
const LOCK_FILE = path.join(__dirname, ".mutation-running");

/* 锁文件：告诉 check-integrity.js "我是正在运行的变异测试，
   备份目录里是我正常的工作状态，不要还原它们"。
   没有这个锁，守卫会在变异跑到一半时把文件还原回去，
   导致变异还没被测试看到就消失 → 全部误报"漏掉"（实测踩过）。 */
function acquireLock() {
  try { fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8"); } catch (e) { /* ignore */ }
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/** 备份文件路径（把斜杠替换掉，避免嵌套目录） */
function backupPath(file) {
  return path.join(BACKUP_DIR, file.replace(/[\\/]/g, "__"));
}

/** 恢复上次运行可能残留的文件 */
function recoverLeftovers() {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const files = fs.readdirSync(BACKUP_DIR);
  let n = 0;
  for (const b of files) {
    const original = b.replace(/__/g, path.sep);
    const content = fs.readFileSync(path.join(BACKUP_DIR, b), "utf8");
    fs.writeFileSync(original, content, "utf8");
    fs.unlinkSync(path.join(BACKUP_DIR, b));
    n++;
    console.log(`  ⟲ 已还原上次残留的破坏：${original}`);
  }
  return n;
}

function backup(file) {
  ensureBackupDir();
  const bp = backupPath(file);
  if (!fs.existsSync(bp)) {
    fs.writeFileSync(bp, fs.readFileSync(file, "utf8"), "utf8");
  }
}

function restore(file) {
  const bp = backupPath(file);
  if (fs.existsSync(bp)) {
    fs.writeFileSync(file, fs.readFileSync(bp, "utf8"), "utf8");
    fs.unlinkSync(bp);
  }
}

function restoreAllBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  for (const b of fs.readdirSync(BACKUP_DIR)) {
    const original = b.replace(/__/g, path.sep);
    try {
      fs.writeFileSync(original, fs.readFileSync(path.join(BACKUP_DIR, b), "utf8"), "utf8");
      fs.unlinkSync(path.join(BACKUP_DIR, b));
      console.log(`  ⟲ 已还原：${original}`);
    } catch (e) { /* ignore */ }
  }
  // 顺手把空目录也删掉：留着会让人以为"上次运行没还原干净"
  try {
    if (fs.readdirSync(BACKUP_DIR).length === 0) fs.rmdirSync(BACKUP_DIR);
  } catch (e) { /* ignore */ }
}

// 任何退出路径都要还原，并且释放锁
function cleanup() {
  restoreAllBackups();
  releaseLock();
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
process.on("uncaughtException", (e) => {
  console.error("未捕获异常：", e.message);
  cleanup();
  process.exit(1);
});

// 上锁：告诉 check-integrity.js 不要动我的备份
acquireLock();

const MUTATIONS = [
  {
    name: "移除 prompt.js 的 <script> 引用",
    file: "index.html",
    apply: (s) => s.replace(/<script src="prompt\.js"[^>]*><\/script>\n/, ""),
  },
  {
    name: "把 prompt.js 挪到 script.js 之后（顺序错误）",
    file: "index.html",
    apply: (s) => {
      const m = s.match(/<script src="prompt\.js"[^>]*><\/script>\n/);
      if (!m) return s;
      return s.replace(m[0], "")
        .replace('<script src="script.js" defer></script>',
          '<script src="script.js" defer></script>\n' + m[0]);
    },
  },
  {
    name: "给主按钮改错 id",
    file: "index.html",
    apply: (s) => s.replace('id="translateBtn"', 'id="translateBtn_TYPO"'),
  },
  {
    name: "删除 label 的 for 目标",
    file: "index.html",
    apply: (s) => s.replace('for="inputText"', 'for="inputText_MISSING"'),
  },
  {
    name: "制造重复 id",
    file: "index.html",
    apply: (s) => s.replace('id="toast"', 'id="inputText"'),
  },
  {
    name: "删除 aria-labelledby 的目标元素",
    file: "index.html",
    apply: (s) => s.replace('id="outputTitle"', 'id="outputTitle_X"'),
  },
  {
    name: "破坏 script.js 的初始化（注释掉 syncLevel）",
    file: "script.js",
    apply: (s) => s.replace("    syncLevel(level);", "    /* syncLevel(level); */"),
  },
  {
    name: "破坏 script.js 的翻译处理（让 doTranslate 提前返回）",
    file: "script.js",
    apply: (s) => s.replace("  async function doTranslate(isRetry) {",
      "  async function doTranslate(isRetry) {\n    if (true) return;"),
  },
  {
    name: "让引导永远不弹出",
    file: "script.js",
    apply: (s) => s.replace("  function maybeShowOnboarding() {",
      "  function maybeShowOnboarding() {\n    return;"),
  },
  // --- 针对 test-deploy-http.js / check-csp.js 的破坏 ---
  {
    name: "CSP 丢掉 script-src 的 'self'（部署后白屏）",
    file: "_headers",
    apply: (s) => s.replace("script-src 'self';", "script-src 'none';"),
    suite: "test-deploy-http.js",
  },
  {
    name: "CSP 丢掉 style-src 的 'unsafe-inline'（内联 style 被拦）",
    file: "_headers",
    apply: (s) => s.replace("style-src 'self' 'unsafe-inline';", "style-src 'self';"),
    suite: "check-csp.js",
  },
  {
    name: "CSP 丢掉 connect-src 的 'self'（同源代理失效）",
    file: "_headers",
    apply: (s) => s.replace("connect-src 'self' https://open.bigmodel.cn;",
      "connect-src https://open.bigmodel.cn;"),
    suite: "check-csp.js",
  },
  {
    name: "去掉 X-Content-Type-Options（安全头缺失）",
    file: "_headers",
    apply: (s) => s.replace(/^\s*X-Content-Type-Options:.*\r?\n/m, ""),
    suite: "check-csp.js",
  },
  {
    name: "manifest 指向不存在的图标",
    file: "manifest.webmanifest",
    apply: (s) => s.replace('"src": "icon.svg"', '"src": "icon-MISSING.svg"'),
    suite: "check-csp.js",
  },
  // --- 针对 test-feature-truth.js 的破坏（功能性退化） ---
  {
    name: "滑块不再更新 aria-valuetext（读屏软件念错档位）",
    file: "script.js",
    apply: (s) => s.replace(
      '    el.levelRange.setAttribute("aria-valuetext", label);',
      '    /* el.levelRange.setAttribute("aria-valuetext", label); */'),
    suite: "test-feature-truth.js",
  },
  {
    name: "复制按钮复制错误的内容（复制原文而非结果）",
    file: "script.js",
    apply: (s) => s.replace(
      'const text = (el.output.querySelector(".output-text") || {}).textContent || "";',
      'const text = el.input.value;'),
    suite: "test-feature-truth.js",
  },
  {
    name: "历史记录点击后不还原原文",
    file: "script.js",
    apply: (s) => s.replace("        el.input.value = record.source;",
      "        /* el.input.value = record.source; */"),
    suite: "test-feature-truth.js",
  },
  {
    name: "重新翻译按钮不再重新请求（只显示旧结果）",
    file: "script.js",
    apply: (s) => s.replace('      doTranslate(true);', '      /* doTranslate(true); */'),
    suite: "test-feature-truth.js",
  },
  {
    name: "语言模式切换不影响 prompt（zh 与 auto 变得相同）",
    file: "prompt.js",
    apply: (s) => s.replace(
      'zh: "输入语言：中文。请先理解这句话的意思，再用具有机器翻译感的中文重新组织一遍。不要只是原样复述输入。",',
      'zh: "输入语言：自动判断。请先自行判断输入是中文还是英文，再按照对应方式处理。",'),
    suite: "test-feature-truth.js",
  },
  {
    name: "英文模式与中文模式混同",
    file: "prompt.js",
    apply: (s) => s.replace(
      'en: "输入语言：英文。请先理解英文含义，再转换成具有机器翻译感的中文。",',
      'en: "输入语言：中文。请先理解这句话的意思，再用具有机器翻译感的中文重新组织一遍。不要只是原样复述输入。",'),
    suite: "test-feature-truth.js",
  },
  // --- 针对 test-doc-claims.js 的破坏（README 承诺的功能退化） ---
  {
    name: "Ctrl+Enter 快捷键失效（README 明确承诺过）",
    file: "script.js",
    apply: (s) => s.replace(
      "      if ((e.ctrlKey || e.metaKey) && e.key === \"Enter\") {",
      "      if (false) {"),
    suite: "test-doc-claims.js",
  },
  {
    name: "401 不再自动打开设置面板",
    file: "script.js",
    apply: (s) => s.replace(
      "      if (err && (err.status === 401 || err.code === \"NO_API_KEY\")) {\n        openSettings();\n      }",
      "      /* 设置面板不再自动打开 */"),
    suite: "test-doc-claims.js",
  },
  {
    name: "历史记录上限改成 3 条（README 说 10 条）",
    file: "script.js",
    apply: (s) => s.replace("HISTORY_LIMIT: 10,", "HISTORY_LIMIT: 3,"),
    suite: "test-doc-claims.js",
  },
  {
    name: "清空历史不再二次确认（直接删）",
    file: "script.js",
    apply: (s) => s.replace('if (window.confirm("确定要清空全部历史记录吗？")) {', "if (true) {"),
    suite: "test-doc-claims.js",
  },
  {
    name: "输出改用 innerHTML（XSS 风险）",
    file: "script.js",
    apply: (s) => s.replace("    p.textContent = text;         // 使用 textContent 而不是 innerHTML，避免 XSS",
      "    p.innerHTML = text;"),
    suite: "test-doc-claims.js",
  },
  {
    name: "skip-link 指向不存在的锚点",
    file: "index.html",
    apply: (s) => s.replace('<a class="skip-link" href="#inputText">', '<a class="skip-link" href="#nope">'),
    suite: "test-doc-claims.js",
  },
  // --- 针对 test-manual-checklist.js 的破坏（错误文案映射） ---
  {
    name: "500 被误报成「人太多」（判断顺序回退）",
    file: "script.js",
    apply: (s) => s.replace(
      '    if (err && err.status === 429) {\n      return "翻译系统现在使用的人实在是太多了，请稍等一会儿再试。";\n    }',
      '    if (err && (err.allModelsBusy || err.status === 429)) {\n      return "翻译系统现在使用的人实在是太多了，请稍等一会儿再试。";\n    }'),
    suite: "test-manual-checklist.js",
  },
  {
    name: "断网提示改成技术性文案",
    file: "script.js",
    apply: (s) => s.replace(
      'return "无法连接到翻译系统。请检查网络连接，或关闭可能拦截请求的浏览器插件。";',
      'return "TypeError: Failed to fetch";'),
    suite: "test-manual-checklist.js",
  },
  {
    name: "空输入不再提示（直接静默返回）",
    file: "script.js",
    apply: (s) => s.replace('showToast("请先输入一点内容，机器才有东西可以翻译。", true);',
      "/* 静默返回 */"),
    suite: "test-manual-checklist.js",
  },
  {
    name: "README 错误文案表回退到旧文案（文档与代码脱节）",
    file: "README.md",
    apply: (s) => s.replace(
      "| Key 未配置 | 不填 Key（保持 `YOUR_API_KEY`） | 提示「请先填写 API Key，点右上角「设置」即可。」，**并自动打开设置面板**；不发起请求 |",
      "| Key 未配置 | 不填 Key | 提示「还没有配置 API Key……」 |"),
    suite: "test-manual-checklist.js",
  },
  // --- 针对 test-css-audit.js 的破坏 ---
  {
    name: "按钮尺寸改小到手指点不到（移动端可用性）",
    file: "style.css",
    // 旧目标串含已删除的内联注释，CSS 重写后不再匹配 → 变异变成 no-op
    // 新目标：.btn 规则里的裸 min-height（注释已在新版 style.css 中移除）
    apply: (s) => s.replace(
      /(\.btn\s*\{[^}]*min-height:\s*)40px/,
      "$112px"),
    suite: "test-css-audit.js",
  },
  {
    name: "去掉 overflow-x: hidden（会出现横向滚动条）",
    file: "style.css",
    apply: (s) => s.replace("  overflow-x: hidden;\n  -webkit-font-smoothing", "  -webkit-font-smoothing"),
    suite: "test-css-audit.js",
  },
  {
    name: "新增一个没人用的死样式类",
    file: "style.css",
    apply: (s) => s + "\n.dead-style-never-used { color: red; }\n",
    suite: "test-css-audit.js",
  },
  {
    name: "JS 用到的状态类在 CSS 里被删掉（is-done 无样式）",
    file: "style.css",
    apply: (s) => s.replace(".status.is-done { color: var(--success); }", ""),
    suite: "test-css-audit.js",
  },
  // --- 针对 test-browser-layout.js 的破坏 ---
  {
    name: "autoGrow 不再限制最大高度（长文本撑爆页面）",
    file: "script.js",
    apply: (s) => s.replace(
      "      const next = Math.min(el.input.scrollHeight, maxH);\n      el.input.style.height = Math.max(next, 148) + \"px\";",
      "      el.input.style.height = el.input.scrollHeight + \"px\";"),
    suite: "test-browser-layout.js",
  },
  {
    name: "autoGrow 去掉最小高度下限（短文本压成一条线）",
    file: "script.js",
    apply: (s) => s.replace(
      "    el.input.style.height = Math.max(next, 148) + \"px\";\n  }\n\n  /** 渲染输出区 */",
      "    el.input.style.height = next + \"px\";\n  }\n\n  /** 渲染输出区 */"),
    suite: "test-browser-layout.js",
  },
  {
    name: "resize 去掉防抖（高频重排）",
    file: "script.js",
    apply: (s) => s.replace(
      "      clearTimeout(resizeTimer);\n      resizeTimer = setTimeout(autoGrow, 150);",
      "      autoGrow();"),
    suite: "test-browser-layout.js",
  },
  // --- 针对 test-mobile-scenarios.js 的破坏 ---
  {
    name: "viewport 禁用用户缩放（无障碍倒退）",
    file: "index.html",
    apply: (s) => s.replace(
      'content="width=device-width, initial-scale=1.0, viewport-fit=cover"',
      'content="width=device-width, initial-scale=1.0, user-scalable=no"'),
    suite: "test-mobile-scenarios.js",
  },
  {
    name: "去掉刘海屏安全区域适配",
    file: "style.css",
    apply: (s) => s.replace(/env\(safe-area-inset-bottom, 0px\)/g, "0px"),
    suite: "test-mobile-scenarios.js",
  },
  {
    name: "设置面板输入框字号改小（iOS 会聚焦缩放）",
    file: "style.css",
    apply: (s) => s.replace(
      "  /* 16px 可以避免 iOS 聚焦时自动放大页面 */\n  font-size: 16px;\n  line-height: 1.4;",
      "  font-size: 13px;\n  line-height: 1.4;"),
    suite: "test-mobile-scenarios.js",
  },
  // --- 针对 test-long-session.js 的破坏（长会话 / 内存） ---
  {
    name: "历史列表不再清理旧节点（真内存泄漏）",
    file: "script.js",
    apply: (s) => s.replace(
      'function renderHistory(list) {\n    el.historyList.innerHTML = "";',
      "function renderHistory(list) {\n    /* 不清空 —— 模拟泄漏 */"),
    suite: "test-long-session.js",
  },
  {
    name: "API Key 输入框类型改成 text（明文显示）",
    file: "index.html",
    apply: (s) => s.replace('type="password" id="apiKeyInput"', 'type="text" id="apiKeyInput"'),
    suite: "test-long-session.js",
  },
  // --- 针对 test-incomplete-deploy.js 的破坏（部署完整性） ---
  {
    name: "index.html 不再引入 prompt.js（部署后翻译不可用）",
    file: "index.html",
    apply: (s) => s.replace(/<script src="prompt\.js"[^>]*><\/script>\n/, ""),
    suite: "test-incomplete-deploy.js",
  },
  {
    name: "prompt.js 被挪到 script.js 之后（加载顺序错误）",
    file: "index.html",
    apply: (s) => {
      const m = s.match(/<script src="prompt\.js"[^>]*><\/script>\n/);
      if (!m) return s;
      return s.replace(m[0], "").replace('<script src="script.js" defer></script>',
        '<script src="script.js" defer></script>\n' + m[0]);
    },
    suite: "test-incomplete-deploy.js",
  },
  {
    name: "PROMPTS_MISSING 检查被移到 syncLevel 之后（崩溃前来不及提示）",
    file: "script.js",
    apply: (s) => s.replace(
      "    if (PROMPTS_MISSING) {\n      showMissingPromptsNotice();",
      "    if (false) {\n      showMissingPromptsNotice();"),
    suite: "test-incomplete-deploy.js",
  },
  // --- 针对 test-misconfig.js 的破坏（代理配置错误处理） ---
  {
    name: "缺 express 时不再给出安装指引（裸报错）",
    file: "proxy/node-server.js",
    apply: (s) => s.replace(/let express;\ntry \{[\s\S]*?\n\}\n/, 'const express = require("express");\n'),
    suite: "test-misconfig.js",
  },
  {
    name: "Redis 不可用时谎报为分布式（运维会被误导）",
    file: "proxy/node-server.js",
    apply: (s) => s.replace("name: \"memory\",\n  buckets: new Map(),\n  distributed: false,",
      "name: \"redis\",\n  buckets: new Map(),\n  distributed: true,"),
    suite: "test-misconfig.js",
  },
  // --- 针对注释声称核对（check-comment-claims / test-comment-behavior） ---
  {
    name: "删掉模型去重（注释声称有去重）",
    file: "script.js",
    apply: (s) => s.replace(
      /\n\s*\.filter\(function \(m, i, arr\) \{ return m && arr\.indexOf\(m\) === i; \}\)/,
      ""),
    suite: "check-comment-claims.js",
  },
  {
    name: "绕过 safeStorage 直接读写 localStorage（注释声称都包了一层）",
    file: "script.js",
    apply: (s) => s.replace("const raw = safeStorage.get(CONFIG.HISTORY_KEY);",
      "const raw = localStorage.getItem(CONFIG.HISTORY_KEY);"),
    suite: "check-comment-claims.js",
  },
  {
    name: "去掉 script 的 defer（注释声称都带 defer）",
    file: "index.html",
    apply: (s) => s.replace('<script src="script.js" defer></script>',
      '<script src="script.js"></script>'),
    suite: "check-comment-claims.js",
  },
  {
    name: "破坏过期响应守卫（旧结果会覆盖新结果）",
    file: "script.js",
    apply: (s) => s.replace(/if \(seq !== state\.requestSeq\) return;/g, "if (false) return;"),
    suite: "test-comment-behavior.js",
  },
  {
    name: "输出改用 innerHTML（XSS 防护失效）",
    file: "script.js",
    apply: (s) => s.replace("    p.textContent = text;         // 使用 textContent 而不是 innerHTML，避免 XSS",
      "    p.innerHTML = text;"),
    suite: "test-comment-behavior.js",
  },
  // --- 针对视觉一致性（test-visual-audit.js） ---
  {
    name: "privacy.html 主题色回退旧蓝",
    file: "privacy.html",
    apply: (s) => s.replaceAll("#ff6900", "#0f6cbd"),
    suite: "test-visual-audit.js",
  },
  {
    name: "重新引入 ⚠️ emoji 装饰",
    file: "index.html",
    apply: (s) => s.replace("安全说明：本站的翻译服务由页面内置的加密 Key 提供。",
      "⚠️ 安全说明：本站的翻译服务由页面内置的加密 Key 提供。"),
    suite: "test-visual-audit.js",
  },
  {
    name: "主按钮字重降为 400",
    file: "style.css",
    apply: (s) => s.replace(
      "  color: #fff;\n  font-weight: 600;\n  padding: 10px 28px;",
      "  color: #fff;\n  font-weight: 400;\n  padding: 10px 28px;"),
    suite: "test-visual-audit.js",
  },
];

function runTestOnce(suite) {
  return new Promise((resolve) => {
    // stdio 用默认（inherit）：本环境允许，pipe 会 EPERM
    const child = spawn(process.execPath, [suite || "test-pageload.js"], { stdio: "inherit" });

    // 必须自带超时：否则某个套件卡住会把整个变异测试挂死，
    // 而外部强杀（SIGKILL）不会触发任何还原钩子 —— 实测因此留下过损坏的源文件。
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
      resolve(1);   // 当作"测试失败"，绝不能让 runner 无限等待
    }, 240000);

    child.on("exit", (code) => { clearTimeout(timer); resolve(code === null ? 1 : code); });
    child.on("error", () => { clearTimeout(timer); resolve(1); });
  });
}

(async () => {
  console.log("=== 变异测试：确认测试能抓到真实破坏 ===\n");

  // 先清理上次可能残留的破坏（本工具早期版本会留下烂摊子）
  const recovered = recoverLeftovers();
  if (recovered) console.log("");

  // 基线：只跑默认套件
  const baseline = await runTestOnce("test-pageload.js");
  console.log(`\n基线（test-pageload.js 未破坏）: exit=${baseline} ${baseline === 0 ? "✓ 通过" : "✗ 本该通过"}\n`);
  if (baseline !== 0) {
    console.log("基线就不通过，变异测试无意义。");
    process.exit(1);
  }
  // 另外几个被破坏目标也要先确认基线正常
  for (const s of ["check-csp.js", "test-deploy-http.js", "test-feature-truth.js",
                   "test-doc-claims.js", "test-manual-checklist.js", "test-css-audit.js",
                   "test-browser-layout.js", "test-mobile-scenarios.js", "test-long-session.js",
                   "test-incomplete-deploy.js", "test-misconfig.js",
                   "test-visual-audit.js",
                   "check-comment-claims.js", "test-comment-behavior.js"]) {
    const c = await runTestOnce(s);
    if (c !== 0) {
      console.log(`基线 ${s} 不通过，先修好再说。`);
      process.exit(1);
    }
  }
  console.log("基线 check-csp / test-deploy-http / test-feature-truth / test-doc-claims / test-manual-checklist 均通过 ✓\n");

  let caught = 0, missed = 0;

  for (const m of MUTATIONS) {
    backup(m.file);
    const before = fs.readFileSync(m.file, "utf8");
    const after = m.apply(before);
    const suite = m.suite || "test-pageload.js";

    if (after === before) {
      console.log(`  ?  ${m.name} —— 变异未生效，跳过`);
      restore(m.file);
      continue;
    }

    process.stdout.write(`  ... ${m.name}  [${m.file}]\n`);
    fs.writeFileSync(m.file, after, "utf8");
    const code = await runTestOnce(suite);
    restore(m.file);   // 从磁盘备份还原，不依赖内存

    if (code !== 0) {
      caught++;
      console.log(`      ✓ 捕获（${suite} exit=${code}）`);
    } else {
      missed++;
      console.log(`      ✗ 漏掉 —— ${suite} 在破坏后仍然通过！`);
    }
  }

  // 收尾：确保没有任何残留
  restoreAllBackups();

  console.log("\n=== 结论 ===");
  console.log(`  捕获 ${caught} / ${caught + missed}`);
  console.log(missed === 0
    ? "  ✅ 测试对真实破坏敏感"
    : `  ❌ 有 ${missed} 种破坏没被发现`);
  process.exit(missed ? 1 : 0);
})();
