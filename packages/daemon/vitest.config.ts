import { defineConfig } from "vitest/config";

// 守护进程的单元与集成测试。pi 契约测试另有一个 project，见 vitest.contract.config.ts。
export default defineConfig({
  test: {
    name: "daemon",
    include: ["test/**/*.test.ts"],
    // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
    setupFiles: ["test/setup-locales.ts", "../../vitest.setup-no-network.mjs"],
    exclude: ["test/contract/**", "**/node_modules/**"],
    // 集成测试会真的拉起 agent 子进程（每个约 1 秒冷启动）
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 244 号票：转译缓存（快车道上多数 project 的超时收紧到 15 秒，daemon 保持 30 秒，见 vitest.fast.config.ts）
    fsModuleCache: true,
  },
});
