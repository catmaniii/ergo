import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 打成单个 dist/index.html（JS、CSS 全内联，和 AgentSense 一样用 vite-plugin-singlefile）：
// 02 号票的原型还没有守护进程，评审时直接在浏览器里打开这个文件，不起开发服务器。
// 04 号票起由守护进程提供这份静态文件。
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // CSS 用 Lightning CSS 压缩，并按 cssTarget 降级（34 号票）：颜色 token 写成 light-dark(浅色, 深色)，
    // 目标浏览器比 light-dark() 要求的（Chrome/Edge 123、Firefox 120、Safari 17.5）老，构建时就把它换成
    // 跟着 color-scheme 切的两个开关变量，老一点的 WebView、ArkWeb 照样能切深浅色。
    // 目标和 JS 的 es2022 同一档（Vite 对 es2022 的换算）。开发服务器不压缩、不降级，用新浏览器看。
    // test/build.test.ts 构建一遍，查产物里没有 light-dark( 留下。
    cssMinify: "lightningcss",
    cssTarget: ["chrome94", "edge94", "firefox93", "safari16.4", "ios16.4"],
  },
});
