// 视觉风格（39 号票）的构建插件：把风格清单（src/visual-styles/）变成页面要的三样东西。
// 1. 样式：main.tsx 里 import "virtual:visual-styles"，它先引入生成的 token 样式表（经典挂在 :root，每套风格写全挂在
//    [data-style="<id>"]），再按清单顺序引入各套风格的 <id>/style.css；和别的样式一样经 Lightning CSS 降级
//    （light-dark() 变成开关变量）、内联进单文件的 index.html；
// 2. index.html 内联脚本里的风格表（地址栏颜色、字体样式表的地址）：把 /*VISUAL_STYLES*/ {} 换成清单生成的那张，
//    打开页面时不用等页面脚本就能挂好风格；
// 3. 字体：有自己字体的风格，按 fontsource 包里切好片的 @font-face 生成 dist/fonts/<风格 id>.css，把用到的 woff2
//    和许可证拷进 dist/fonts/<包>@<版本>/。字体文件不内联进页面，由守护进程的网关按 /fonts/ 提供（外网端口要设备凭证）。
//    woff2 所在的目录带着包的版本，同一个地址的内容不会变，网关可以让浏览器长期缓存；<风格 id>.css 每次都要问一下有没有变。
//    另有一份 fonts/preview.css 给设置里的风格预览：只收管着预览场景里那几个字的 @font-face（src/visual-styles/preview.ts）。
//    开发服务器（vite dev）同样按 /fonts/ 提供。
// 运行时不请求任何外部地址：字体全由二狗自己提供。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  BASE_STYLE,
  FONTS_DIR,
  type FontSource,
  fontsHref,
  PREVIEW_FONTS_HREF,
  previewChars,
  type StylePageInfo,
  stylePageInfo,
  VISUAL_STYLES,
  type VisualStyle,
  visualStylesCss,
} from "../src/visual-styles/index.ts";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 页面（main.tsx）import 这个：依次引入 token 样式表、清单里每套风格自己的 style.css */
const VIRTUAL = "virtual:visual-styles";
const RESOLVED = "\0virtual:visual-styles";
/** token 样式表：带 .css 结尾，Vite 才按样式处理（压缩、降级、内联） */
const RESOLVED_CSS = "\0virtual:visual-styles-tokens.css";

/** 一套风格自己的规则：src/visual-styles/<id>/style.css（可以没有） */
function rulesFile(styleId: string): string | undefined {
  const file = path.join(WEB_ROOT, "src", "visual-styles", styleId, "style.css");
  return fs.existsSync(file) ? file : undefined;
}

/** 虚拟模块的代码：先 token，再按清单的顺序引入各套风格的规则 */
function entryModule(styles: readonly VisualStyle[]): string {
  const rules = styles.flatMap((s) => rulesFile(s.id) ?? []).map((file) => `import ${JSON.stringify(file.replaceAll("\\", "/"))};`);
  return [`import ${JSON.stringify(RESOLVED_CSS)};`, ...rules].join("\n");
}

/** index.html 内联脚本里等着填风格表的地方 */
const TABLE_MARKER = "/*VISUAL_STYLES*/ {}";

/** 把风格表填进 index.html 的内联脚本（测试也用它，跑出来的就是构建产物里那段） */
export function injectStyleTable(html: string, table: Readonly<Record<string, StylePageInfo>>): string {
  if (!html.includes(TABLE_MARKER)) throw new Error(`index.html 的内联脚本里找不到 ${TABLE_MARKER}`);
  // 放进 <script> 里：< 写成 <，值里怎么写都不会提前结束脚本
  return html.replace(TABLE_MARKER, () => JSON.stringify(table).replaceAll("<", "\\u003c"));
}

/** 要放进 dist/fonts/ 的东西：相对 fonts/ 的路径 → 内容（生成的样式表）或源文件（woff2、许可证） */
export interface FontPlan {
  readonly stylesheets: ReadonlyMap<string, string>;
  readonly files: ReadonlyMap<string, string>;
}

/** 一个字体包：装在哪、版本、拷进 dist/fonts/ 时的目录名 */
function fontPackage(name: string): { dir: string; version: string; outDir: string } {
  const pkgJson = createRequire(path.join(WEB_ROOT, "package.json")).resolve(`${name}/package.json`);
  const version = (JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { version: string }).version;
  return { dir: path.dirname(pkgJson), version, outDir: `${name.replace(/^@/, "").replace("/", "-")}@${version}` };
}

/** 一个字体包里 @font-face 声明的字族名（去掉引号；字体测试拿它和风格的字体 token 对） */
export function fontFamiliesOf(font: FontSource): string[] {
  const css = fs.readFileSync(path.join(fontPackage(font.package).dir, font.css), "utf8");
  return [...new Set([...css.matchAll(/font-family:\s*['"]?([^'";]+?)['"]?\s*;/g)].map((m) => m[1]!))];
}

/** 包里的许可证文件 */
function licenseFile(dir: string): string {
  const name = ["LICENSE", "LICENSE.txt", "OFL.txt", "LICENSE.md"].find((n) => fs.existsSync(path.join(dir, n)));
  if (!name) throw new Error(`字体包 ${dir} 里没有许可证文件：不能分发`);
  return path.join(dir, name);
}

/** @font-face 的 unicode-range 管的码位段（U+4E00-4E10、U+20、U+4??）；没写的是全部 */
export function unicodeRanges(face: string): [number, number][] {
  const value = /unicode-range:\s*([^;}]+)/i.exec(face)?.[1];
  if (value === undefined) return [[0, 0x10ffff]];
  return value.split(",").map((part) => {
    const m = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
    if (!m) throw new Error(`看不懂的 unicode-range：${part}`);
    const from = m[1]!;
    return [Number.parseInt(from.replaceAll("?", "0"), 16), Number.parseInt(m[2] ?? from.replaceAll("?", "f"), 16)];
  });
}

/** 这段 @font-face 管不管这些字里的某一个 */
function coversAny(face: string, chars: readonly string[]): boolean {
  const ranges = unicodeRanges(face);
  return chars.some((ch) => ranges.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b));
}

/**
 * 有自己字体的风格各一份样式表：照抄包里的 @font-face（字族名、字重、unicode-range、font-display: swap 都不动），
 * 只留 woff2 一种格式、地址改到 dist/fonts/<包>@<版本>/ 下。
 * 再合一份 preview.css 给设置里的风格预览：每套风格的 @font-face 里，只收管着预览场景里某个字的那几段
 */
export function planFonts(styles: readonly VisualStyle[]): FontPlan {
  const stylesheets = new Map<string, string>();
  const files = new Map<string, string>();
  const chars = previewChars();
  const preview = ["/* 设置里风格预览用的字体：只收管着预览场景（src/visual-styles/preview.ts）里那几个字的 @font-face。由风格清单生成，不要手改 */"];
  for (const style of styles) {
    if (!style.fonts?.length) continue;
    if (fontsHref(style.id) === PREVIEW_FONTS_HREF) throw new Error(`风格 id 不能叫 ${style.id}：和预览的字体样式表重名`);
    const parts = [`/* ${style.name}（${style.id}）的字体：由风格清单生成（build/visual-styles-plugin.ts），不要手改 */`];
    for (const font of style.fonts) {
      const pkg = fontPackage(font.package);
      files.set(`${pkg.outDir}/LICENSE.txt`, licenseFile(pkg.dir));
      parts.push(`/* ${font.package} ${pkg.version} 的 ${font.css}；许可证见 ${pkg.outDir}/LICENSE.txt */`);
      preview.push(`/* ${style.name}（${style.id}）：${font.package} ${pkg.version} 的 ${font.css}；许可证见 ${pkg.outDir}/LICENSE.txt */`);
      const css = fs.readFileSync(path.join(pkg.dir, font.css), "utf8");
      const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
      if (faces.length === 0) throw new Error(`${font.package}/${font.css} 里没有 @font-face`);
      for (const face of faces) {
        const woff2 = /url\((['"]?)\.\/files\/([^'")]+\.woff2)\1\)/.exec(face)?.[2];
        if (!woff2) throw new Error(`${font.package}/${font.css} 里有一段 @font-face 没有 woff2：${face.slice(0, 120)}…`);
        files.set(`${pkg.outDir}/${woff2}`, path.join(pkg.dir, "files", woff2));
        const rewritten = face.replace(/src:[^;]*;/, `src: url("${pkg.outDir}/${woff2}") format("woff2");`);
        parts.push(rewritten);
        // 两套风格用同一个字体时只收一次
        if (coversAny(face, chars) && !preview.includes(rewritten)) preview.push(rewritten);
      }
    }
    stylesheets.set(path.posix.relative(FONTS_DIR, fontsHref(style.id)), `${parts.join("\n")}\n`);
  }
  if (stylesheets.size > 0) stylesheets.set(path.posix.relative(FONTS_DIR, PREVIEW_FONTS_HREF), `${preview.join("\n")}\n`);
  return { stylesheets, files };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function visualStylesPlugin(): Plugin {
  let plan: FontPlan | undefined;
  const fonts = () => (plan ??= planFonts(VISUAL_STYLES));
  return {
    name: "ergou:visual-styles",
    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED;
      if (id === RESOLVED_CSS) return RESOLVED_CSS;
      return undefined;
    },
    load(id) {
      if (id === RESOLVED) return entryModule(VISUAL_STYLES);
      if (id === RESOLVED_CSS) return visualStylesCss(VISUAL_STYLES, BASE_STYLE);
      return undefined;
    },
    transformIndexHtml(html) {
      return injectStyleTable(html, stylePageInfo(VISUAL_STYLES, BASE_STYLE));
    },
    // 只在真的写盘时拷字体（test/build.test.ts 不写盘，就不碰这些文件）
    writeBundle(options) {
      const outDir = path.join(options.dir ?? path.join(WEB_ROOT, "dist"), FONTS_DIR);
      const { stylesheets, files } = fonts();
      for (const [rel, content] of stylesheets) {
        fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(outDir, rel), content);
      }
      for (const [rel, source] of files) {
        fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
        fs.copyFileSync(source, path.join(outDir, rel));
      }
    },
    // 开发服务器：/fonts/ 直接从 node_modules 里的字体包取
    configureServer(server) {
      server.middlewares.use(`/${FONTS_DIR}/`, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
        const { stylesheets, files } = fonts();
        const type = CONTENT_TYPES[path.extname(rel)];
        const css = stylesheets.get(rel);
        const file = files.get(rel);
        if (!type || (css === undefined && file === undefined)) return next();
        res.setHeader("Content-Type", type);
        res.end(css ?? fs.readFileSync(file!));
      });
    },
  };
}
