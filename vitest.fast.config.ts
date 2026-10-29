import fs from "node:fs";
import { defineConfig } from "vitest/config";
import { oldNameOf } from "./packages/protocol/src/old-names.ts";

// `npm run test:fast` 用的配置：做票时跑的那条车道（244 号票）。
// 只有纯单测、协议包、网页状态层和构建检查，目标是三分钟内跑完；主切面（daemon/test/main，占了全量 86% 的时间）
// 和真浏览器打开页面的检查在 `vitest.integration.config.ts` 那条车道。全量 `npm test` 仍走根 `vitest.config.ts`。
//
// 这里把各 project 的 include/exclude 重写了一遍，不直接引用各包的 vitest.config.ts（那边是给全量用的：
// 用 `extends` 继承时 include 是拼接的，没法从这里把 test/main 去掉）。改了某个包的 setupFiles、include 时两边一起改。
export default defineConfig({
  test: {
    // 和根配置一样：默认只开一半的核，几套测试同时跑时不把机器挤满。
    // 312 号票：兼容期旧的变量名（ERGOU_TEST_WORKERS）也认
    maxWorkers: Number(process.env.ERGO_TEST_WORKERS || process.env[oldNameOf("ERGO_TEST_WORKERS")]) || "50%",
    // 244 号票：把转译结果落到 node_modules/.vitest-cache，同一文件没改就跳过转译（第一次跑会慢一点）。
    // 缓存按文件内容算，改了文件自然失效；`npx vitest run --clearCache` 可以整个清掉。
    fsModuleCache: true,
    projects: [
      {
        root: "packages/protocol",
        test: {
          name: "protocol",
          include: ["test/**/*.test.ts"],
          // 168 号票：每个测试文件开始前装上自带的中文（t() 查得到句子）
          setupFiles: ["test/setup-locales.ts"],
          // 纯单测：超时从 30 秒降到 15 秒，挂住时更快看到（断言强度不变）。
          testTimeout: 15_000,
          hookTimeout: 15_000,
          passWithNoTests: true,
        },
      },
      {
        root: "packages/web",
        test: {
          name: "web",
          include: ["test/**/*.test.ts"],
          // page-opens 要真 Chrome 打开构建产物，放集成车道；build.test.ts 只构建、不写盘，留在快车道。
          exclude: ["test/page-opens.test.ts"],
          setupFiles: ["test/setup-locales.ts"],
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
      {
        root: "packages/daemon",
        test: {
          name: "daemon",
          include: ["test/**/*.test.ts"],
          // 主切面（真守护进程 + agent 子进程）在集成车道；契约测试本来就是单独一条。
          exclude: ["test/main/**", "test/contract/**"],
          setupFiles: ["test/setup-locales.ts"],
          // daemon 这个 project 不收紧：typed-shell 那批用例真的跑 git（合并、推送），一条"合并、推送的分支名"
          // 要挨个起 Git Bash，机器上有别的槽在跑测试时实测 15 秒、20 秒都会卡在超时上（全量里 30 秒刚好过）。
          // 其余 project 的 15 秒见上。
          testTimeout: 30_000,
          hookTimeout: 15_000,
        },
      },
      {
        root: "packages/memory",
        test: {
          name: "memory",
          include: ["test/**/*.test.ts"],
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
      // 公开仓库里没有 packages/memory-eval（记忆评测和评测数据只留私有仓库，326 号票），
      // 目录不在就不挂这个 project——否则公开版跑测试会死在 "root path does not exist"。
      ...(fs.existsSync(new URL("packages/memory-eval", import.meta.url))
        ? [
            {
              root: "packages/memory-eval",
              test: {
                name: "memory-eval",
                include: ["test/**/*.test.ts"],
                testTimeout: 15_000,
                hookTimeout: 15_000,
              },
            },
          ]
        : []),
      {
        root: "frontend",
        test: {
          name: "frontend",
          include: ["test/**/*.test.ts"],
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
    ],
  },
});
