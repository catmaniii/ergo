// 原型里的假附件（113 号票）：聊天里的附件卡片、报告页用。文本类的带内容（报告页照真接口的规矩回：能预览的给文字，超过 1 MB 的截断），
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
export const FAKE_HTML: FakeMedia = { part: file("sha256:fake-html", "活动页预览.html", "text/html", 18_432) };
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
  ].map((m) => [m.part.mediaId, m]),
);

/** 原型里的一个假附件；没有是 undefined */
export function fakeMedia(mediaId: string): FakeMedia | undefined {
  if (mediaId === LEDGER_ID) return (ledger ??= { part: FAKE_LEDGER_PART, text: yearLedger() });
  return FAKE_MEDIA[mediaId];
}
