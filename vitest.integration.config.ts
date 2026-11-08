import { defineConfig } from "vitest/config";

// `npm run test:integration` 用的配置：主切面。
// 这里只有最慢的两类：daemon/test/main（真的拉起守护进程和 agent 子进程，占了全量 86% 的时间）和网页的
// page-opens、open-snapshot-page、font-scale-page、image-viewer-page、chat-video-page（照 vite.config.ts 构建一遍，再用真 Chrome 打开）。全量 `npm test` 仍走根 `vitest.config.ts`。
//
// 各 project 的 include 在这里重写了一遍（理由见 vitest.fast.config.ts 的文件头）。
export default defineConfig({
  test: {
    maxWorkers: Number(process.env.ERGO_TEST_WORKERS) || "50%",
    // 转译缓存，和快车道共用 node_modules/.vitest-cache。
    fsModuleCache: true,
    projects: [
      {
        root: "packages/daemon",
        test: {
          name: "daemon",
          include: ["test/main/**/*.test.ts"],
          // 每个测试文件开始前装上自带的中文（t() 查得到句子）
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
          // 打开页面量补发（388）、图片查看器的捏合和拖动、聊天里的视频和大播放器：同样要构建一遍、真 Chrome
          include: ["test/page-opens.test.ts", "test/open-snapshot-page.test.ts", "test/font-scale-page.test.ts", "test/image-viewer-page.test.ts", "test/chat-video-page.test.ts"],
          setupFiles: ["test/setup-locales.ts"],
          // 和全量里一样用默认超时（用例自己按需写更长的），这里不额外放宽。
        },
      },
    ],
  },
});
