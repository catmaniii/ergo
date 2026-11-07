import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { buildInfoPlugin } from "./build/build-info-plugin.ts";
import { pdfjsPlugin } from "./build/pdfjs-plugin.ts";
import { visualStylesPlugin } from "./build/visual-styles-plugin.ts";
import { webVersionPlugin } from "./build/web-version-plugin.ts";

/** 只属于原型的假连接、假数据（src/prototype/） */
const PROTOTYPE_DIR = /[\\/]src[\\/]prototype[\\/]/;

// 打成单个 index.html（JS、CSS 全内联，用 vite-plugin-singlefile）。同一套配置构建两份（src/app/prototype-mode.ts）：
// - 安装版：`npm run build:web`，产物 dist/，由守护进程提供。一条假数据都不带：页面里用到原型的地方都写成
//   `import.meta.env.MODE === "demo"` 的分支，构建时这个分支直接摇掉，下面再声明 src/prototype/ 没有副作用，引了没用就整个不进产物；
//   test/build.test.ts 和 npm run release（packages/daemon/build/demo-sentinels.ts）都查产物。
// - 演示页：`npm run build:demo` = `vite build --mode demo --outDir dist-demo`，全是原型的假数据，不连守护进程，
//   整个 dist-demo/ 放 GitHub Pages；改界面时也用 file:// 打开它看效果，不起开发服务器。
export default defineConfig(({ mode }) => ({
  base: "./",
  // 视觉风格：风格清单生成的 token 样式表、内联脚本里的风格表、拷字体（build/visual-styles-plugin.ts）
  // 页面是哪一版：产物内容的哈希写进 index.html 的 <meta name="ergo-web-version">（build/web-version-plugin.ts）
  // 关于页：二狗的版本、更新日志（仓库根目录的 package.json、CHANGELOG.md）写进页面（build/build-info-plugin.ts）
  // 报告页预览 PDF 用的 pdf.js：拷进产物的 pdfjs/<版本>/，不打进 index.html，打开 PDF 时才加载（build/pdfjs-plugin.ts）
  plugins: [react(), buildInfoPlugin(), visualStylesPlugin(), pdfjsPlugin(), viteSingleFile(), webVersionPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // CSS 用 Lightning CSS 压缩，并按 cssTarget 降级：颜色 token 写成 light-dark(浅色, 深色)，
    // 目标浏览器比 light-dark() 要求的（Chrome/Edge 123、Firefox 120、Safari 17.5）老，构建时就把它换成
    // 跟着 color-scheme 切的两个开关变量，老一点的 WebView、ArkWeb 照样能切深浅色。
    // 目标和 JS 的 es2022 同一档（Vite 对 es2022 的换算）。开发服务器不压缩、不降级，用新浏览器看。
    // test/build.test.ts 构建一遍，查产物里没有 light-dark( 留下。
    cssMinify: "lightningcss",
    cssTarget: ["chrome94", "edge94", "firefox93", "safari16.4", "ios16.4"],
    ...(mode === "demo" ? {} : { rolldownOptions: { treeshake: { moduleSideEffects: (id: string) => (PROTOTYPE_DIR.test(id) ? false : undefined) } } }),
  },
}));
