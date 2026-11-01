import { defineConfig } from "vitest/config";

// 记忆系统的测试：全部用临时目录里的 SQLite 和假向量，
// 不加载真模型、不碰 ~/.ergo。
export default defineConfig({
  test: {
    name: "memory",
    include: ["test/**/*.test.ts"],
    // 测试里不许连外部网络（只许本机假服务）
    fsModuleCache: true,
  },
});
