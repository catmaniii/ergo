import { defineConfig } from "vitest/config";

// pi 契约测试（规格 Testing Decisions 切面 3）：升级 pi 前先跑 `npm run test:contract`。
// 每条用例单独拉起一个 agent 子进程、接 faux provider，只验二狗依赖的 pi 行为。
export default defineConfig({
  test: {
    name: "pi-contract",
    include: ["test/contract/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
