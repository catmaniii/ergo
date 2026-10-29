// 二狗 App 图标：从透明前景原图生成鸿蒙分层图标、安卓自适应图标和老式图标。
// 用法（在仓库根目录）：node frontend/icon/generate.mjs [预览输出目录]
// 读 frontend/icon/foreground-master.png，覆盖写鸿蒙和安卓的图标资源；给了预览目录就另出三张预览图。
// sharp 是根目录 node_modules 里已有的（间接依赖），没有单独登记。
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.dirname(here);
const src = path.join(here, "foreground-master.png");
const previewDir = process.argv[2];

// 背景：暖奶油色径向渐变，中间一点很淡的蓝紫光（接住前景光环的光晕）
const backgroundSvg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="cream" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#FFF9F0"/>
      <stop offset="60%" stop-color="#FDEFDC"/>
      <stop offset="100%" stop-color="#F9DFC2"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="38%">
      <stop offset="0%" stop-color="#B9A4FF" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#B9A4FF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="url(#cream)"/>
  <rect width="100" height="100" fill="url(#glow)"/>
</svg>`;

const background = (size) => sharp(Buffer.from(backgroundSvg(size))).resize(size, size).png().toBuffer();

// 前景原图里主体（含光晕）的外框
async function contentBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const box = await contentBox(src);
const cropped = await sharp(src).extract(box).png().toBuffer();

// 透明画布上居中放主体：主体的高占画布的 heightRatio（主体比宽高，按高定）
async function foreground(size, heightRatio) {
  const h = Math.round(size * heightRatio);
  const w = Math.round((box.width / box.height) * h);
  const subject = await sharp(cropped).resize(w, h, { kernel: "lanczos3" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: subject, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
    .png()
    .toBuffer();
}

// 前景叠在背景上，再按形状裁（square 不裁、rounded 圆角方形、circle 圆）
async function composite(size, heightRatio, shape) {
  let img = sharp(await background(size)).composite([{ input: await foreground(size, heightRatio) }]);
  if (shape === "square") return img.png().toBuffer();
  const r = shape === "circle" ? size / 2 : size * 0.22;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`);
  const flat = await img.png().toBuffer();
  return sharp(flat).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

const write = async (buf, file) => {
  mkdirSync(path.dirname(file), { recursive: true });
  await sharp(buf).png({ compressionLevel: 9 }).toFile(file);
  console.log(path.relative(frontend, file).replaceAll("\\", "/"));
};

// —— 鸿蒙：分层图标 1024×1024（AppScope 和 entry 各一份），启动页图标 288×288 ——
const H = path.join(frontend, "harmony");
for (const dir of ["AppScope/resources/base/media", "entry/src/main/resources/base/media"]) {
  await write(await foreground(1024, 0.74), path.join(H, dir, "foreground.png"));
  await write(await background(1024), path.join(H, dir, "background.png"));
}
await write(await composite(288, 0.78, "rounded"), path.join(H, "entry/src/main/resources/base/media/startIcon.png"));

// —— 安卓：自适应图标的两层（108dp）、老式方形和圆形图标（48dp）、应用商店 512 ——
const A = path.join(frontend, "android/app/src/main/res");
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, s] of Object.entries(densities)) {
  const layer = Math.round(108 * s);
  const legacy = Math.round(48 * s);
  await write(await foreground(layer, 0.62), path.join(A, `mipmap-${d}`, "ic_launcher_foreground.png"));
  await write(await background(layer), path.join(A, `mipmap-${d}`, "ic_launcher_background.png"));
  await write(await composite(legacy, 0.8, "rounded"), path.join(A, `mipmap-${d}`, "ic_launcher.png"));
  await write(await composite(legacy, 0.8, "circle"), path.join(A, `mipmap-${d}`, "ic_launcher_round.png"));
}
await write(await composite(512, 0.76, "square"), path.join(frontend, "android/ic_launcher-playstore.png"));

// —— 预览：鸿蒙圆角效果、安卓圆形遮罩效果 ——
if (previewDir) {
  mkdirSync(previewDir, { recursive: true });
  await write(await composite(1024, 0.74, "rounded"), path.join(previewDir, "preview-harmony-1024.png"));
  await write(await composite(432, 0.62, "circle"), path.join(previewDir, "preview-android-adaptive-circle.png"));
  await write(await composite(96, 0.8, "rounded"), path.join(previewDir, "preview-small-96.png"));
}
console.log("content box in source:", box);
