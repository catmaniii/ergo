import { defineConfig } from "vitest/config";

// 守护进程的单元与集成测试。pi 契约测试另有一个 project，见 vitest.contract.config.ts。
export default defineConfig({
  test: {
    name: "daemon",
    include: ["test/**/*.test.ts"],
    exclude: ["test/contract/**", "**/node_modules/**"],
    // 集成测试会真的拉起 agent 子进程（每个约 1 秒冷启动）
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
