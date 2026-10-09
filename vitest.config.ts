import { defineConfig } from "vitest/config";

// 根目录 `npm test` 跑全部测试；每个包、以及 pi 契约测试各是一个 vitest project。
// 只跑某一个：`npx vitest run --project daemon`（项目名见各包的 vitest 配置）。
export default defineConfig({
  test: {
    // 主切面用例会真的拉起守护进程和 agent 子进程。默认按核数开满 worker，几套测试同时跑（比如几张票并行开发）时
    // 机器会被挤满、等待类用例超时。默认只用一半的核，`ERGOU_TEST_WORKERS` 可以改成具体个数。
    maxWorkers: Number(process.env.ERGOU_TEST_WORKERS) || "50%",
    projects: [
      "packages/protocol/vitest.config.ts",
      "packages/web/vitest.config.ts",
      "packages/daemon/vitest.config.ts",
      "packages/daemon/vitest.contract.config.ts",
      // 62 号票：frontend/ 的构建脚本和"签名材料不进仓库"的检查（鸿蒙工程本身不归 vitest 管）
      "frontend/vitest.config.ts",
    ],
  },
});
