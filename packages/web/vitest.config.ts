import { defineConfig } from "vitest/config";

// 空壳：02 号票复制 AgentSense 前端时按需改成 Vite 的配置
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
