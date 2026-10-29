import { defineConfig } from "vitest/config";
import { oldNameOf } from "./packages/protocol/src/old-names.ts";

// 根目录 `npm test` 跑全部测试；每个包、以及 pi 契约测试各是一个 vitest project。
// 只跑某一个：`npx vitest run --project daemon`（项目名见各包的 vitest 配置）。
export default defineConfig({
  test: {
    // 主切面用例会真的拉起守护进程和 agent 子进程。默认按核数开满 worker，几套测试同时跑（比如几张票并行开发）时
    // 机器会被挤满、等待类用例超时。默认只用一半的核，`ERGO_TEST_WORKERS` 可以改成具体个数。
    // 312 号票：兼容期旧的变量名（ERGOU_TEST_WORKERS）也认
    maxWorkers: Number(process.env.ERGO_TEST_WORKERS || process.env[oldNameOf("ERGO_TEST_WORKERS")]) || "50%",
    // 244 号票：转译结果落到 node_modules/.vitest-cache，同一文件没改就跳过转译。缓存按内容算，改了文件自然失效；
    // 要整个清掉：`npx vitest run --clearCache`。要关掉就把这一行去掉（各 project 继承根配置的这个开关）。
    fsModuleCache: true,
    projects: [
      "packages/protocol/vitest.config.ts",
      "packages/web/vitest.config.ts",
      "packages/daemon/vitest.config.ts",
      "packages/daemon/vitest.contract.config.ts",
      // 188 号票：记忆系统（326 号票起分成运行时 packages/memory 和只留私有仓库的评测 packages/memory-eval）
      "packages/memory/vitest.config.ts",
      "packages/memory-eval/vitest.config.ts",
      // 62 号票：frontend/ 的构建脚本和"签名材料不进仓库"的检查（鸿蒙工程本身不归 vitest 管）
      "frontend/vitest.config.ts",
    ],
  },
});
