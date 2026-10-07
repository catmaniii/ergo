import { defineConfig } from "vitest/config";

// Web 包的测试：目前是前端状态层的回放测试（纯函数，跑在 Node 里，不需要 DOM）。
// 页面本身不单设测试切面，靠用户评审（规格 Testing Decisions）。
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
  },
});
