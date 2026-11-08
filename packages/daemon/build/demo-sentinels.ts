// 安装版的网页（packages/web/dist）里不该有的字：演示页假数据里特有的编号、任务名、原话（中英都有）。
// 摆版本目录时查一遍（stage.ts，npm run release、ergo:install 都走它），查到就报错退出；
// packages/web/test/build.test.ts 构建两份比对：安装版一个都没有，演示页每个都有（免得哪个字从假数据里改没了，这里还在假装查着）。
export const DEMO_SENTINELS: readonly string[] = [
  // 编号、名字（假 skill、假 MCP，假项目、假任务、假卡片、假素材、假档案、假负责人，假的外网地址）
  "demo-pdf-reader",
  "demo-exif-reader",
  "p-ledger",
  "t-photos",
  "c-plan-bills",
  "mat-fake-",
  "p-fake-mom",
  "project-ledger",
  "ergo.tail.example.com",
  // 地图页演示用的假高德 Key
  "demo-amap-key-not-real",
  // 地图页演示用的假谷歌 Key（446）
  "demo-google-key-not-real",
  // 地图页演示用的假足迹（编号前缀）
  "demo-fp-",
  // 中文：记忆管理员的假访谈（0.4.1 的真页面里显示过这些）、看板和项目上的假名字
  "示例实验小学",
  "我是个什么样的人",
  "家庭照片整理与去重",
  "每周汇总银行账单",
  "博客迁移到 Astro",
  "记账本",
  // 英文
  "Sort and dedupe family photos",
  "Weekly bank statement summary",
  "Move the blog to Astro",
];

/** 这份页面里查到的假数据（空的是干净的） */
export function demoDataIn(html: string): string[] {
  return DEMO_SENTINELS.filter((word) => html.includes(word));
}
