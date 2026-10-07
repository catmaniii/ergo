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
  },
});
