import { defineConfig } from "vitest/config";
import { oldNameOf } from "./packages/protocol/src/old-names.ts";

// `npm run test:integration` 用的配置：主切面（244 号票）。
// 这里只有最慢的两类：daemon/test/main（真的拉起守护进程和 agent 子进程，占了全量 86% 的时间）和网页的
// page-opens（照 vite.config.ts 构建一遍，再用真 Chrome 打开每一页）。全量 `npm test` 仍走根 `vitest.config.ts`。
//
// 各 project 的 include 在这里重写了一遍（理由见 vitest.fast.config.ts 的文件头）。
export default defineConfig({
  test: {
    // 312 号票：兼容期旧的变量名（ERGOU_TEST_WORKERS）也认
    maxWorkers: Number(process.env.ERGO_TEST_WORKERS || process.env[oldNameOf("ERGO_TEST_WORKERS")]) || "50%",
    // 244 号票：转译缓存，和快车道共用 node_modules/.vitest-cache。
    fsModuleCache: true,
    projects: [
      {
        root: "packages/daemon",
        test: {
          name: "daemon",
          include: ["test/main/**/*.test.ts"],
          // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
          setupFiles: ["test/setup-locales.ts"],
          // 集成车道保持 30 秒：每条用例拉起子进程、等回合结束，收紧到 15 秒会让本来正常的用例偶发超时。
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        root: "packages/web",
        test: {
          name: "web",
          include: ["test/page-opens.test.ts"],
          setupFiles: ["test/setup-locales.ts"],
          // 和全量里一样用默认超时（用例自己按需写更长的），这里不额外放宽。
        },
      },
    ],
  },
});
