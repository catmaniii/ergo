// 原型里的假附件：聊天里的附件卡片、报告页用。文本类的带内容（报告页照真接口的规矩回：能预览的给文字，超过 1 MB 的截断；
// Markdown、CSV 表格、JSON、代码，还有一份当作 Excel 导出、GBK 编码的流水；HTML、SVG 也带内容，报告页在沙箱框、<img> 里看），
// 录音带一段现场合成的提示音（报告页的播放器真能放、能拖），PDF 现场生成（fake-pdf.ts：三页的纪要能看能选字，
// 还有一份加了密码的、一份坏的），周会录像没有内容（报告页说"原型里没有这个文件的内容"，聊天里照旧是卡片），
// 另有两段带内容的小视频：一段浏览器能放的 H.264（聊天里显示第一帧、大播放器真能放），一段浏览器解不了的（聊天里退回卡片、提示下载），
// 别的只有名字、类型、大小。原型没有守护进程：下载给的是一段说明文字（data: 地址）。名字和内容都是明显虚构的。
import type { FilePartValue } from "../state/index.ts";
import { fakeFormat, fakeMoney, fakeText } from "./fake-content.ts";
import { brokenPdf, fakePdf, type FakePdfLine } from "./fake-pdf.ts";

/** 一个假附件：part 上的样子，文本类的再带内容 */
export interface FakeMedia {
  readonly part: FilePartValue;
  readonly text?: string;
  /** PDF：内容现场生成（按界面语言写字；fake-pdf.ts），报告页交给 pdf.js 画 */
  readonly pdf?: () => Uint8Array<ArrayBuffer>;
  /** 当作 GBK（GB18030）编码存的（报告页那一行写明编码）；内容照样是这里的字 */
  readonly encoding?: "gb18030";
  /** 录音：内容是现场合成的一段提示音（fakeSoundUrl） */
  readonly sound?: boolean;
  /** 引用它的那条消息什么时候发的（报告页"……发出"那一行）；不写是 10 月 7 日 21:30 */
  readonly sentAt?: string;
  /** 带真内容的视频：文件的字节（base64），聊天里、报告页的播放器放它（fakeVideoUrl） */
  readonly video?: string;
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

/** 定时任务 t-brief 第 3 次运行交付的早报（任务做完时运行时作为附件放进秘书会话） */
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
  const items = ["早餐", "午餐", "地铁", "超市", "咖啡", "水果", "晚餐", "停车"].map(fakeText);
  const lines = [fakeText("# 2026 年账单流水"), "", fakeText("按账户、按天列出每一笔，金额单位是元。")];
  for (const account of ["招行信用卡", "工行储蓄卡", "建行信用卡", "农行储蓄卡", "支付宝", "微信支付", "交通卡", "现金"].map(fakeText)) {
    lines.push("", `## ${account}`);
    for (let day = 0; day < 365; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day));
      const label = fakeFormat("{} 月 {} 日", date.getUTCMonth() + 1, date.getUTCDate());
      lines.push("", `### ${label}`, "");
      for (let k = 0; k < 8; k++) lines.push(fakeFormat("- {}：{} 元（{}，第 {} 笔）", items[(day + k) % items.length]!, fakeMoney(((day * 7 + k * 13) % 9000) / 100 + 3).toFixed(2), account, k + 1));
    }
  }
  return lines.join("\n");
}

/**
 * 活动页的预览页（HTML，原来只能下载）：报名按钮点了改字（框里的脚本能跑）
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
 * 定时任务"每天早上出早报"的负责人发的网页版早报（HTML）：目录跳到各节（页内锚点）、内嵌的柱状图、
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

/** 本周三个项目新增 star 的走势（SVG，报告页用 <img> 显示） */
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

/** 发票报销明细（CSV，报告页画成表格）：和会话里算出来的合计、可报金额对得上 */
const EXPENSES_CSV = `日期,类别,明细,金额,按 85% 可报
09-21,交通,高铁 G87 北京南—上海虹桥,¥553.00,¥470.05
09-21,住宿,酒店两晚,¥416.00,¥353.60
09-22,餐饮,工作午餐,¥86.00,¥73.10
09-23,交通,出租车,¥48.00,¥40.80
09-23,餐饮,客户咖啡,¥32.00,¥27.20
09-24,办公,打印装订,¥145.00,¥123.25
合计,,,¥1280.00,¥1088.00
`;

/** 银行导出的九月流水（当作 Excel 存的 GBK 编码，报告页那一行写明编码） */
const STATEMENT_CSV = `交易日期,摘要,收入,支出,余额
2026-09-01,工资,¥8500.00,,¥12850.30
2026-09-03,超市,,¥286.40,¥12563.90
2026-09-10,房租,,¥3200.00,¥9363.90
2026-09-15,水电燃气,,¥215.60,¥9148.30
2026-09-21,高铁票,,¥553.00,¥8595.30
2026-09-28,理财赎回,¥2000.00,,¥10595.30
`;

/** 本周训练记录（JSON，挤在一行：报告页格式化成缩进两格，"看原文"看回一行） */
const WORKOUT_JSON = `{"week":"2026-W41","sessions":[{"date":"2026-10-05","focus":"腿","exercises":[{"name":"深蹲","sets":5,"reps":5,"kg":60},{"name":"硬拉","sets":3,"reps":5,"kg":80}]},{"date":"2026-10-07","focus":"胸背","exercises":[{"name":"卧推","sets":5,"reps":5,"kg":45},{"name":"引体向上","sets":4,"reps":8,"kg":0}]}],"note":"深蹲加到 60 kg，下周试 62.5"}
`;

/** 算报销的脚本（代码，报告页等宽显示） */
const REIMBURSE_PY = `"""按比例算能报销多少：读发票识别出来的 JSON，打印合计和可报金额。"""
import json
import sys


def reimbursable(items, rate):
    """合计和按比例能报的金额（保留两位小数）"""
    total = sum(item["amount"] for item in items)
    return total, round(total * rate, 2)


if __name__ == "__main__":
    # 用法：python calc_reimburse.py 发票.json --rate 0.85
    path, rate = sys.argv[1], float(sys.argv[3])
    with open(path, encoding="utf-8") as f:
        items = json.load(f)["items"]
    total, ok = reimbursable(items, rate)
    print(f"合计 ¥{total:,.2f} × {rate:.0%} = ¥{ok:,.2f}")
`;

/** 合成的提示音：8000 Hz、8 位、单声道，4 秒，三个音一个接一个（报告页的播放器能放、能拖进度） */
const SOUND_RATE = 8000;
const SOUND_SECONDS = 4;
const SOUND_BYTES = 44 + SOUND_RATE * SOUND_SECONDS;

/** 现场合成一段 WAV（只在报告页、下载要用时合成一次） */
function chimeWav(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(SOUND_BYTES);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, SOUND_BYTES - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SOUND_RATE, true);
  view.setUint32(28, SOUND_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, SOUND_RATE * SOUND_SECONDS, true);
  const notes = [523.25, 659.25, 783.99];
  for (let i = 0; i < SOUND_RATE * SOUND_SECONDS; i++) {
    const t = i / SOUND_RATE;
    const k = Math.min(notes.length - 1, Math.floor(t / (SOUND_SECONDS / notes.length)));
    const since = t - k * (SOUND_SECONDS / notes.length);
    const sample = Math.sin(2 * Math.PI * notes[k]! * since) * Math.exp(-3 * since) * 0.6;
    bytes[44 + i] = Math.round(128 + sample * 127);
  }
  return bytes;
}

let soundUrl: string | undefined;

/** 合成的提示音的地址（blob:，合成一次反复用）：报告页的播放器、下载都给它 */
export function fakeSoundUrl(): string {
  return (soundUrl ??= URL.createObjectURL(new Blob([chimeWav()], { type: "audio/wav" })));
}

/**
 * 投影仪测试画面：3 秒、256×144，H.264（baseline）画面加 AAC 的提示音，mp4。用 ffmpeg 合成的（SMPTE 彩条上一个从左往右走的白块，
 * 声音是 660 Hz 的正弦波），不是拍的：
 * ffmpeg -f lavfi -i "smptehdbars=size=256x144:rate=12:duration=3,drawbox=x='mod(t*80,256)':y=60:w=24:h=24:color=white:t=fill"
 *   -f lavfi -i "sine=frequency=660:duration=3:sample_rate=22050" -filter:a volume=0.3 -c:v libx264 -profile:v baseline -level 3.0
 *   -pix_fmt yuv420p -crf 36 -preset veryslow -g 36 -c:a aac -b:a 16k -ac 1 -movflags +faststart -shortest
 */
const PROJECTOR_MP4 =
  "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";

/**
 * 老摄像机录的：1 秒、96×72，MPEG-4 Part 2（老摄像机、老手机常见）画面装在 mov 里，没有声音。浏览器都解不了这种画面
 * （Chrome 报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS），聊天里退回卡片、提示下载：
 * ffmpeg -f lavfi -i "testsrc2=size=96x72:rate=8:duration=1" -c:v mpeg4 -vtag mp4v -q:v 25 -an
 */
const OLD_CAMERA_MOV =
  "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";

const videoUrls = new Map<string, string>();

/** 带内容的假视频的地址（blob:，做一次反复用）：聊天里取第一帧、大播放器、报告页、下载都给它；没有内容的是 undefined */
export function fakeVideoUrl(mediaId: string): string | undefined {
  const media = FAKE_MEDIA[mediaId];
  if (!media?.video) return undefined;
  let url = videoUrls.get(mediaId);
  if (!url) {
    url = URL.createObjectURL(new Blob([Uint8Array.from(atob(media.video), (c) => c.charCodeAt(0))], { type: media.part.mime }));
    videoUrls.set(mediaId, url);
  }
  return url;
}

/**
 * 周会纪要（PDF，三页）：标题、打勾的几条、编号的几条、每页底下的页码。tr 把每句换成当前语言（量大小时原样用中文）
 */
function meetingPages(tr: (text: string) => string): FakePdfLine[][] {
  const line = (style: FakePdfLine["style"], text: string): FakePdfLine => ({ style, text: tr(text) });
  return [
    [
      line("title", "周会纪要（第 41 周）"),
      line("note", "10 月 7 日 10:00 到 11:00，家里三个人"),
      line("heading", "一、上周的事"),
      line("check", "九月账单全部导入记账本，三张卡都对上了"),
      line("check", "车险比价拿到两家报价，等你说继续"),
      line("check", "训练计划改成每周三次，深蹲加到 60 kg"),
      line("heading", "二、录音里说到的三件事"),
      line("body", "1. 十一月去西安的高铁票订好了，酒店还在比价。"),
      line("body", "2. 冰箱保修卡下个月到期，到期前一个月提醒。"),
      line("body", "3. 周末整理一次家里的票据，扫描后存进记账本。"),
    ],
    [
      line("heading", "三、这周要做"),
      line("body", "1. 把信用卡账单导入记账本，周三前做完。"),
      line("body", "2. 西安的酒店挑两家，周五一起定。"),
      line("body", "3. 车险等两家报价都到了再比，不急。"),
      line("heading", "四、下次周会"),
      line("body", "10 月 14 日 10:00，还是在家里开。"),
      line("note", "这份纪要是演示用的，人和事都是编的。"),
    ],
    [
      line("heading", "附：怎么看这份 PDF"),
      line("body", "双指捏合放大缩小，电脑上按住 Ctrl 滚滚轮。"),
      line("body", "双击放大，再双击还原；放大后停一下，字会重新画清楚。"),
      line("body", "按住文字能选中、复制，和网页上的字一样。"),
    ],
  ];
}

/** 每页底下的页码 */
const PAGE_FOOTER = "第 {} 页，共 {} 页";
const BROKEN_NOTE = "这份扫描件只传了一半";

/** 周会纪要的 PDF：localize 时按界面语言写字（报告页现取），不然是中文原样（量附件大小） */
function meetingPdf(localize: boolean, encrypted = false): Uint8Array<ArrayBuffer> {
  const footer = (page: number, total: number) => (localize ? fakeFormat(PAGE_FOOTER, page, total) : PAGE_FOOTER.replace("{}", String(page)).replace("{}", String(total)));
  return fakePdf(meetingPages(localize ? fakeText : (text) => text), footer, { encrypted });
}
const brokenScan = (localize: boolean) => brokenPdf(localize ? fakeText(BROKEN_NOTE) : BROKEN_NOTE);

const file = (mediaId: string, name: string, mime: string, size: number): FilePartValue => ({ type: "file", mediaId, name, mime, size });
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const textFile = (mediaId: string, name: string, mime: string, text: string): FakeMedia => ({ part: file(mediaId, name, mime, utf8Bytes(text)), text });

/** 全年账单流水用到时才生成（一兆多的字） */
let ledger: FakeMedia | undefined;
const LEDGER_ID = "sha256:fake-ledger-2026";
const LEDGER_SIZE = 1_240_921;

export const FAKE_DAILY = textFile("sha256:fake-daily-1007", "10 月 7 日日报.md", "text/markdown", DAILY);
export const FAKE_BRIEF: FakeMedia = { ...textFile("sha256:fake-brief-1007", "brief.md", "text/markdown", BRIEF), sentAt: "2026-10-07T08:06:00.000+08:00" };
export const FAKE_VIDEOS = [1, 2, 3].map((n) => ({ part: file(`sha256:fake-video-${n}`, `周会录像-第${n}段.mp4`, "video/mp4", 180_000_000 + n * 3_100_000), sentAt: "2026-10-07T11:02:00.000+08:00" }));
export const FAKE_ZIP: FakeMedia = { part: file("sha256:fake-zip", "活动页源码.zip", "application/zip", 2_516_582) };
export const FAKE_HTML: FakeMedia = textFile("sha256:fake-html", "活动页预览.html", "text/html", EVENT_PAGE);
/** 负责人发的网页版早报、走势图（在沙箱里预览） */
export const FAKE_BRIEF_HTML = textFile("sha256:fake-brief-html-1007", "10 月 7 日早报.html", "text/html", BRIEF_PAGE);
export const FAKE_TREND_SVG = textFile("sha256:fake-trend-41", "本周 star 走势.svg", "image/svg+xml", TREND_SVG);
/** 消息里的全年账单流水（大小就是生成出来的字节数，不在打开页面时就生成一遍） */
export const FAKE_LEDGER_PART = file(LEDGER_ID, "2026 年账单流水.md", "text/markdown", LEDGER_SIZE);
/** 报销明细（CSV 表格） */
export const FAKE_EXPENSES_CSV: FakeMedia = { ...textFile("sha256:fake-csv", "报销明细-0927.csv", "text/csv", EXPENSES_CSV), sentAt: "2026-10-06T22:41:00.000+08:00" };
/** 银行导出的流水：当作 GBK 编码存的（大小按 GB18030 算：ASCII 一个字节，¥ 四个，汉字两个） */
export const FAKE_STATEMENT_CSV: FakeMedia = {
  part: file("sha256:fake-statement-gbk", "招行流水-9月.csv", "text/csv", [...STATEMENT_CSV].reduce((n, c) => n + (c.charCodeAt(0) < 0x80 ? 1 : c === "¥" ? 4 : 2), 0)),
  text: STATEMENT_CSV,
  encoding: "gb18030",
  sentAt: "2026-10-07T16:05:00.000+08:00",
};
/** 训练记录（JSON）、算报销的脚本（代码） */
export const FAKE_WORKOUT_JSON: FakeMedia = { ...textFile("sha256:fake-workout-json", "本周训练记录.json", "application/json", WORKOUT_JSON), sentAt: "2026-10-07T16:07:00.000+08:00" };
export const FAKE_REIMBURSE_PY: FakeMedia = { ...textFile("sha256:fake-reimburse-py", "calc_reimburse.py", "text/x-python", REIMBURSE_PY), sentAt: "2026-10-07T16:07:00.000+08:00" };
/** 带内容的两段视频：投影仪的测试画面（能放）、老摄像机录的（浏览器解不了）；大小是真的字节数 */
const videoFile = (mediaId: string, name: string, mime: string, base64: string): FakeMedia => ({
  part: file(mediaId, name, mime, atob(base64).length),
  video: base64,
  sentAt: "2026-10-07T11:40:00.000+08:00",
});
export const FAKE_PROJECTOR_VIDEO = videoFile("sha256:fake-projector-video", "投影仪测试画面.mp4", "video/mp4", PROJECTOR_MP4);
export const FAKE_OLD_CAMERA_VIDEO = videoFile("sha256:fake-old-camera-video", "老摄像机-生日会.mov", "video/quicktime", OLD_CAMERA_MOV);
/** 周会的录音（报告页里放合成的提示音） */
export const FAKE_MEETING_AUDIO: FakeMedia = { part: file("sha256:fake-meeting-audio", "周会要点录音.wav", "audio/wav", SOUND_BYTES), sound: true, sentAt: "2026-10-07T16:05:00.000+08:00" };
/** PDF：周会纪要（三页，能看能选字）、加了密码的合同（报告页说要密码）、只传了一半的扫描件（报告页说坏了）；大小按中文那一份量 */
const pdfMedia = (mediaId: string, name: string, make: (localize: boolean) => Uint8Array<ArrayBuffer>): FakeMedia => ({
  part: file(mediaId, name, "application/pdf", make(false).length),
  pdf: () => make(true),
  sentAt: "2026-10-07T16:20:00.000+08:00",
});
export const FAKE_MEETING_PDF = pdfMedia("sha256:fake-meeting-pdf", "周会纪要-第41周.pdf", (localize) => meetingPdf(localize));
export const FAKE_LOCKED_PDF = pdfMedia("sha256:fake-locked-pdf", "租房合同-加了密码.pdf", (localize) => meetingPdf(localize, true));
export const FAKE_BROKEN_PDF = pdfMedia("sha256:fake-broken-pdf", "扫描件-传了一半.pdf", brokenScan);

const FAKE_MEDIA: Readonly<Record<string, FakeMedia>> = Object.fromEntries(
  [
    FAKE_DAILY,
    FAKE_BRIEF,
    textFile("sha256:fake-notes", "读书笔记-置身事内.md", "text/markdown", NOTES),
    FAKE_EXPENSES_CSV,
    FAKE_STATEMENT_CSV,
    FAKE_WORKOUT_JSON,
    FAKE_REIMBURSE_PY,
    FAKE_MEETING_AUDIO,
    FAKE_MEETING_PDF,
    FAKE_LOCKED_PDF,
    FAKE_BROKEN_PDF,
    ...FAKE_VIDEOS,
    FAKE_PROJECTOR_VIDEO,
    FAKE_OLD_CAMERA_VIDEO,
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
