// 原型里的假附件（113 号票）：聊天里的附件卡片、报告页用。文本类的带内容（报告页照真接口的规矩回：能预览的给文字，超过 1 MB 的截断；
// 117 号票起 HTML、SVG 也带内容，报告页在沙箱框、<img> 里看），
// 别的只有名字、类型、大小。原型没有守护进程：下载给的是一段说明文字（data: 地址）。名字和内容都是明显虚构的。
import type { FilePartValue } from "../state/index.ts";

/** 一个假附件：part 上的样子，文本类的再带内容 */
export interface FakeMedia {
  readonly part: FilePartValue;
  readonly text?: string;
  /** 引用它的那条消息什么时候发的（报告页"……发出"那一行）；不写是 10 月 7 日 21:30 */
  readonly sentAt?: string;
}

const DAILY = `# 10 月 7 日日报

## 今天做了什么

- **记账本**：九月账单全部导入，三张卡的消费已经对上。
- **训练记录**：本周第三次训练，深蹲加到 60 kg。
- **十一月西安行程**：往返高铁订好了，住宿还在比价。

## 进度一览

| 事项 | 状态 | 完成度 | 下一步 | 谁在做 |
|---|---|---|---|---|
| 家庭账本 | 进行中 | 80% | 导入信用卡账单 | 记账本项目 |
| 车险比价 | 已暂停 | 40% | 等你说继续 | 任务 t-3 |
| 西安行程 | 规划中 | 30% | 挑两家酒店给你选 | 任务 t-5 |
| 保修单整理 | 待立项 | 0% | 确认立项书 | 二狗 |

## 参考链接

- 九月账单汇总：[账本页面](https://example.com/ledger/2026-09)
- 高铁订单：<https://example.com/orders/xian-1101>
- 训练计划：[五分化训练表](https://example.com/training)

![本周消费走势图](https://example.com/charts/week-41.png)

## 明天

1. 把信用卡账单导入记账本
2. 西安的酒店挑两家给你选
3. 车险比价等你说继续

> 这份日报每天晚上 21:30 自动整理，有要改的直接回我。
`;

const NOTES = `# 读书笔记：置身事内

## 第一章 地方政府的权力与事务

- 地方政府不只是"守夜人"，还直接参与经济发展。
- 事权划分的三个原则：**公共服务的规模经济**、**信息复杂性**、**激励相容**。

## 第二章 财税与政府行为

1. 分税制改革之后，中央财政占比上升，地方靠转移支付和土地财政补缺口。
2. 土地出让金是很多城市基础设施建设的主要资金来源。

> 读后感：理解了"招商引资"背后的逻辑，下次看城市新闻会更有感觉。
`;

/** 定时任务 t-brief 第 3 次运行交付的早报（115 号票：任务做完时运行时作为附件放进秘书会话） */
const BRIEF = `# 早报 · 10 月 7 日（周三）

## 科技新闻

1. **一款开源数据库发布 5.0**：查询提速约三成，内置向量检索。
2. **国产笔记本新品**：续航做到 20 小时，下周开售。
3. **浏览器默认开启新的隐私模式**：第三方 Cookie 默认拦截。

## 关注的开源项目

| 项目 | 新版本 | 要点 |
|---|---|---|
| Vite | 7.2.1 | 修了热更新的内存泄漏 |
| pnpm | 10.4 | 安装速度又快了一点 |
| Deno | 2.4 | 又补了几个 Node 兼容的模块 |

## 链接

- Vite 发布说明：[7.2.1](https://example.com/vite/7.2.1)
- 数据库 5.0 的更新日志：<https://example.com/db/5.0>

> 昨天（10 月 6 日）新闻源连不上，那份没出，补不回来了；今天恢复了。
`;

/** 全年账单流水：超过 1 MB（每天一节，一天八笔，按账户分了八份），报告页只显示开头一部分 */
function yearLedger(): string {
  const items = ["早餐", "午餐", "地铁", "超市", "咖啡", "水果", "晚餐", "停车"];
  const lines = ["# 2026 年账单流水", "", "按账户、按天列出每一笔，金额单位是元。"];
  for (const account of ["招行信用卡", "工行储蓄卡", "建行信用卡", "农行储蓄卡", "支付宝", "微信支付", "交通卡", "现金"]) {
    lines.push("", `## ${account}`);
    for (let day = 0; day < 365; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day));
      const label = `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`;
      lines.push("", `### ${label}`, "");
      for (let k = 0; k < 8; k++) lines.push(`- ${items[(day + k) % items.length]}：${(((day * 7 + k * 13) % 9000) / 100 + 3).toFixed(2)} 元（${account}，第 ${k + 1} 笔）`);
    }
  }
  return lines.join("\n");
}

/**
 * 117 号票：活动页的预览页（HTML，原来只能下载）：报名按钮点了改字（框里的脚本能跑）
 */
const EVENT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>秋季读书会 · 报名</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; color: #24292f; background: #fffaf2; }
  header { padding: 36px 24px 28px; background: linear-gradient(135deg, #f4a261, #e76f51); color: #fff; }
  header h1 { margin: 0 0 6px; font-size: 26px; }
  main { padding: 20px 24px 40px; max-width: 640px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .tag { padding: 4px 10px; border-radius: 999px; background: #fde2c8; font-size: 13px; }
  button { padding: 10px 20px; border: 0; border-radius: 8px; background: #e76f51; color: #fff; font-size: 15px; cursor: pointer; }
  button.done { background: #2a9d8f; }
</style>
</head>
<body>
<header><h1>秋季读书会</h1><div>10 月 19 日（周日）14:00 · 社区图书馆二楼</div></header>
<main>
  <p>这一期读《置身事内》，每人带一个想讨论的问题。现场有茶水，名额 20 人。</p>
  <div class="row"><span class="tag">经济</span><span class="tag">非虚构</span><span class="tag">两小时</span></div>
  <button id="join" onclick="this.textContent='已报名，到时见';this.className='done'">我要报名</button>
</main>
</body>
</html>
`;

/**
 * 117 号票：定时任务"每天早上出早报"的维护者发的网页版早报（HTML）：目录跳到各节（页内锚点）、内嵌的柱状图、
 * "标成已读"按钮（框里的脚本能跑：点了改字、数一下读了几条）。只用内联的样式和图，不从外面拉东西
 */
const BRIEF_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>10 月 7 日早报</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; color: #1f2328; background: #f6f8fa; line-height: 1.6; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 18px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #57606a; font-size: 13px; margin-bottom: 14px; }
  nav a { margin-right: 12px; color: #0969da; text-decoration: none; font-size: 14px; }
  section { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 12px 16px; margin: 14px 0; }
  h2 { font-size: 17px; margin: 4px 0 8px; }
  li { margin: 4px 0; }
  .bar { fill: #54aeff; } .bar.hot { fill: #fb8f44; }
  .lbl { font-size: 11px; fill: #57606a; }
  button { margin-top: 6px; padding: 7px 14px; border: 1px solid #1f883d; border-radius: 6px; background: #1f883d; color: #fff; cursor: pointer; }
  button.read { background: #fff; color: #1f883d; }
</style>
</head>
<body>
<div class="wrap">
  <h1>10 月 7 日早报</h1>
  <div class="sub">9 条科技新闻 · 3 个关注的开源项目发了新版本 · 08:06 生成</div>
  <nav><a href="#news">科技新闻</a><a href="#releases">新版本</a><a href="#stars">本周 star</a></nav>
  <section id="news">
    <h2>科技新闻</h2>
    <ol>
      <li>两家浏览器厂商宣布明年默认开启分区存储，第三方 cookie 进一步收紧。</li>
      <li>一款开源的本地语音识别模型发布 2.0，中文识别错字率下降约三成。</li>
      <li>某云厂商推出按秒计费的 GPU 实例，最短租用一分钟。</li>
      <li>新的长上下文评测基准公开，十个主流模型的成绩参差不齐。</li>
    </ol>
  </section>
  <section id="releases">
    <h2>关注的项目发了新版本</h2>
    <ul>
      <li><b>Vite 7.2</b>：构建缓存提速，开发服务器冷启动更快。</li>
      <li><b>Bun 1.3</b>：内置的测试运行器支持快照。</li>
      <li><b>Deno 2.5</b>：npm 包的兼容性又补了一批。</li>
    </ul>
  </section>
  <section id="stars">
    <h2>本周新增 star</h2>
    <svg viewBox="0 0 320 130" width="100%" role="img" aria-label="本周新增 star 柱状图">
      <rect class="bar" x="20" y="40" width="60" height="70"/><text class="lbl" x="50" y="124" text-anchor="middle">Vite</text><text class="lbl" x="50" y="34" text-anchor="middle">1,240</text>
      <rect class="bar hot" x="130" y="16" width="60" height="94"/><text class="lbl" x="160" y="124" text-anchor="middle">Bun</text><text class="lbl" x="160" y="10" text-anchor="middle">1,680</text>
      <rect class="bar" x="240" y="62" width="60" height="48"/><text class="lbl" x="270" y="124" text-anchor="middle">Deno</text><text class="lbl" x="270" y="56" text-anchor="middle">860</text>
    </svg>
  </section>
  <button id="mark">标成已读</button> <span id="count" class="sub"></span>
</div>
<script>
  var read = 0;
  document.getElementById("mark").addEventListener("click", function () {
    read += 1;
    this.textContent = "已读";
    this.className = "read";
    document.getElementById("count").textContent = "这周读了 " + read + " 份早报";
  });
</script>
</body>
</html>
`;

/** 117 号票：本周三个项目新增 star 的走势（SVG，报告页用 <img> 显示） */
const TREND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200" width="360" height="200">
<style>
  .axis { stroke: #8c959f; stroke-width: 1; }
  .grid { stroke: #d0d7de; stroke-width: 1; stroke-dasharray: 3 3; }
  .t { font: 11px system-ui, sans-serif; fill: #57606a; }
  .v { fill: none; stroke: #0969da; stroke-width: 2.5; }
  .b { fill: none; stroke: #fb8f44; stroke-width: 2.5; }
  .d { fill: none; stroke: #1f883d; stroke-width: 2.5; }
</style>
<text class="t" x="40" y="18">本周新增 star（每天）</text>
<line class="grid" x1="40" y1="60" x2="340" y2="60"/><line class="grid" x1="40" y1="110" x2="340" y2="110"/>
<line class="axis" x1="40" y1="160" x2="340" y2="160"/><line class="axis" x1="40" y1="30" x2="40" y2="160"/>
<text class="t" x="10" y="64">300</text><text class="t" x="10" y="114">150</text><text class="t" x="24" y="164">0</text>
<polyline class="v" points="40,120 90,112 140,104 190,96 240,100 290,88 340,80"/>
<polyline class="b" points="40,110 90,96 140,84 190,70 240,62 290,50 340,44"/>
<polyline class="d" points="40,134 90,130 140,126 190,128 240,118 290,116 340,110"/>
<text class="t" x="40" y="180">周一</text><text class="t" x="180" y="180">周四</text><text class="t" x="316" y="180">周日</text>
<text class="t" x="300" y="76" fill="#0969da">Vite</text><text class="t" x="300" y="40" fill="#fb8f44">Bun</text><text class="t" x="300" y="130" fill="#1f883d">Deno</text>
</svg>
`;

const file = (mediaId: string, name: string, mime: string, size: number): FilePartValue => ({ type: "file", mediaId, name, mime, size });
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const textFile = (mediaId: string, name: string, mime: string, text: string): FakeMedia => ({ part: file(mediaId, name, mime, utf8Bytes(text)), text });

/** 全年账单流水用到时才生成（一兆多的字） */
let ledger: FakeMedia | undefined;
const LEDGER_ID = "sha256:fake-ledger-2026";
const LEDGER_SIZE = 1_240_921;

export const FAKE_DAILY = textFile("sha256:fake-daily-1007", "10 月 7 日日报.md", "text/markdown", DAILY);
export const FAKE_BRIEF: FakeMedia = { ...textFile("sha256:fake-brief-1007", "brief.md", "text/markdown", BRIEF), sentAt: "2026-10-07T08:06:00.000+08:00" };
export const FAKE_VIDEOS = [1, 2, 3].map((n) => ({ part: file(`sha256:fake-video-${n}`, `周会录像-第${n}段.mp4`, "video/mp4", 180_000_000 + n * 3_100_000) }));
export const FAKE_ZIP: FakeMedia = { part: file("sha256:fake-zip", "活动页源码.zip", "application/zip", 2_516_582) };
export const FAKE_HTML: FakeMedia = textFile("sha256:fake-html", "活动页预览.html", "text/html", EVENT_PAGE);
/** 117 号票：维护者发的网页版早报、走势图（在沙箱里预览） */
export const FAKE_BRIEF_HTML = textFile("sha256:fake-brief-html-1007", "10 月 7 日早报.html", "text/html", BRIEF_PAGE);
export const FAKE_TREND_SVG = textFile("sha256:fake-trend-41", "本周 star 走势.svg", "image/svg+xml", TREND_SVG);
/** 消息里的全年账单流水（大小就是生成出来的字节数，不在打开页面时就生成一遍） */
export const FAKE_LEDGER_PART = file(LEDGER_ID, "2026 年账单流水.md", "text/markdown", LEDGER_SIZE);

const FAKE_MEDIA: Readonly<Record<string, FakeMedia>> = Object.fromEntries(
  [
    FAKE_DAILY,
    FAKE_BRIEF,
    textFile("sha256:fake-notes", "读书笔记-置身事内.md", "text/markdown", NOTES),
    { part: file("sha256:fake-csv", "报销明细-0927.csv", "text/csv", 1_284) },
    ...FAKE_VIDEOS,
    FAKE_ZIP,
    FAKE_HTML,
    FAKE_BRIEF_HTML,
    FAKE_TREND_SVG,
  ].map((m) => [m.part.mediaId, m]),
);

/** 原型里的一个假附件；没有是 undefined */
export function fakeMedia(mediaId: string): FakeMedia | undefined {
  if (mediaId === LEDGER_ID) return (ledger ??= { part: FAKE_LEDGER_PART, text: yearLedger() });
  return FAKE_MEDIA[mediaId];
}
