import { defineConfig } from "vitest/config";

// 根目录 `npm test` 跑全部测试；每个包、以及 pi 契约测试各是一个 vitest project。
// 只跑某一个：`npx vitest run --project daemon`（项目名见各包的 vitest 配置）。
export default defineConfig({
  test: {
    projects: [
      "packages/protocol/vitest.config.ts",
      "packages/web/vitest.config.ts",
      "packages/daemon/vitest.config.ts",
      "packages/daemon/vitest.contract.config.ts",
    ],
  },
});
