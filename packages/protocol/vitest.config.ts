import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "protocol",
    include: ["test/**/*.test.ts"],
    // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
    setupFiles: ["test/setup-locales.ts", "../../vitest.setup-no-network.mjs"],
    passWithNoTests: true,
    // 244 号票：转译缓存
    fsModuleCache: true,
  },
});
