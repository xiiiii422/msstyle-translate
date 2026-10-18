/* ==========================================================================
 * make-icons.js —— 由 icon.svg 生成各个尺寸的 PNG 图标
 *
 * 为什么需要 PNG：
 *   · iOS 的 apple-touch-icon 不支持 SVG，只放 SVG 的话
 *     "添加到主屏幕"会得到一个空白图标
 *   · PWA 安装要求 manifest 里至少有 192 与 512 的 PNG
 *
 * 用法：
 *   npm install @resvg/resvg-js --no-save
 *   node make-icons.js
 * ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");

let Resvg;
try {
  ({ Resvg } = require("@resvg/resvg-js"));
} catch (e) {
  console.error("缺少依赖 @resvg/resvg-js。请先运行：");
  console.error("  npm install @resvg/resvg-js --no-save");
  process.exit(1);
}

const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");

/* apple-touch-icon 要去掉自带的圆角。
   iOS 会自己给主屏图标套一个圆角遮罩 —— 我们再画一层圆角，
   就会出现"圆角里套圆角"的双层边框（很业余）。 */
const svgSquare = svg.replace('rx="120"', 'rx="0"');

const targets = [
  { file: "icon-180.png", size: 180, src: svgSquare },   // iOS 主屏图标（自己会加圆角）
  { file: "icon-192.png", size: 192, src: svg },          // PWA / Android
  { file: "icon-512.png", size: 512, src: svg },          // PWA 启动画面 / 商店
];

for (const t of targets) {
  const resvg = new Resvg(t.src, { fitTo: { mode: "width", value: t.size } });
  const png = resvg.render().asPng();
  const out = path.join(__dirname, t.file);
  fs.writeFileSync(out, png);
  console.log("✓ " + t.file + "  " + t.size + "×" + t.size + "  " + Math.round(png.length / 1024) + " KB");
}

console.log("\n生成完毕。记得在 index.html / manifest.webmanifest 里引用它们。");
