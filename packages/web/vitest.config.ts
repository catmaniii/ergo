import { defineConfig } from "vitest/config";

// Web 包的测试：前端状态层的回放测试（纯函数，跑在 Node 里，不需要 DOM）、app/ 里浏览器那一半的模块（存储、页面换成假的），
// 以及构建产物检查（test/build.test.ts：照 vite.config.ts 构建一遍，不写盘）。
// 页面本身不单设测试切面，靠用户评审（规格 Testing Decisions）。
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
  },
});
