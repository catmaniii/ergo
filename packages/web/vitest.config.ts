import { defineConfig } from "vitest/config";

// Web 包的测试：前端状态层的回放测试（纯函数，跑在 Node 里，不需要 DOM）、app/ 里浏览器那一半的模块（存储、页面换成假的），
// 以及构建产物检查（test/build.test.ts：照 vite.config.ts 构建一遍，不写盘）。
// 页面本身不单设测试切面，靠用户评审（规格 Testing Decisions）；只查"打开不崩"：构建产物在真 Chrome 里挨个切每一页
// （test/page-opens.test.ts，2026-10-18 用户要求改了代码起码打开网页看一下）。
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
    setupFiles: ["test/setup-locales.ts", "../../vitest.setup-no-network.mjs"],
    // 244 号票：转译缓存（page-opens 走集成车道，见 vitest.integration.config.ts）
    fsModuleCache: true,
  },
});
