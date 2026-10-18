/* 把 og-image.svg 渲染成 1200x630 PNG（社交媒体不认 SVG） */
const fs = require("fs");
const { Resvg } = require("@resvg/resvg-js");

const svg = fs.readFileSync("og-image.svg", "utf8");

// 中文必须显式指定字体，否则会渲染成方块/空白
const fontCandidates = [
  "C:\\Windows\\Fonts\\msyh.ttc",   // 微软雅黑
  "C:\\Windows\\Fonts\\msyhbd.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
];
const fontFiles = fontCandidates.filter((f) => fs.existsSync(f));
const fontDirs = ["C:\\Windows\\Fonts"];
console.log("可用字体文件:", fontFiles.length ? fontFiles.join(", ") : "(无，将用字体目录)");

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: {
    fontFiles: fontFiles,
    loadSystemFonts: true,
    fontDirs: fontDirs,
    defaultFontFamily: "Microsoft YaHei",
  },
  background: "#f3f3f3",
});

const png = resvg.render().asPng();
fs.writeFileSync("og-image.png", png);

const st = fs.statSync("og-image.png");
console.log(`✓ 已生成 og-image.png  ${(st.size / 1024).toFixed(1)} KB`);

// 读回 PNG 头，确认真实尺寸
const buf = fs.readFileSync("og-image.png");
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
console.log(`  尺寸: ${w} x ${h}  ${w === 1200 && h === 630 ? "✓ 符合 OG 规范" : "✗ 尺寸不对"}`);
