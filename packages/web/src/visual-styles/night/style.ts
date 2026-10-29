// 夜航仪表（41 号票，设计稿 docs/design/styles/c-*.dc.html）：深色为主、青绿指示色、JetBrains Mono 等宽数字、带点的状态药丸。
// 风格和明暗正交：设计稿以深色为主，renderVals() 里也有一套浅色取值（青绿换成深一档的 #0F766E），浅色照它做；
// 用户选"跟随系统"时照常跟系统。颜色取自设计稿的 --bg、--surface、--raised、--border、--text、--muted、--accent、
// --accent-ink、--accent-dim、--warn、--warn-dim；对比度不够的几处沿原来的色相调了（标着"设计稿是"）。
// token 在这里；只靠 token 做不到的（个人助理的话不套气泡、状态写成带点的药丸、线条图标……）在 style.css。
import { t } from "@ergo/protocol";
import type { VisualStyle } from "../tokens.ts";

export const night: VisualStyle = {
  id: "night",
  // 名字和一句话按当前语言（169 号票，取的时候现查）
  get name() {
    return t("styles.night.name");
  },
  get blurb() {
    return t("styles.night.blurb");
  },
  tokens: {
    // ---- 颜色（设计稿的 --bg、--surface、--text、--muted、--border） ----
    bg: ["#eef2f6", "#0c1017"],
    surface: ["#ffffff", "#141a23"],
    text: ["#0f172a", "#e3e9f2"],
    muted: ["#5b6778", "#93a1b3"],
    border: ["#d5dce5", "#263040"],
    // 设计稿的 --raised：输入框、代码、小签、分段切换的底
    fill: ["#f6f8fa", "#1b2330"],
    // 青绿指示色（--accent）：链接、选中、进度条；主按钮是青绿实色块，上面的字是 --accent-ink
    primary: ["#0f766e", "#4fd1c5"],
    "primary-text": ["#ffffff", "#06211e"],
    "primary-fill": "var(--primary)",
    // 你发的消息：青绿的淡底（--accent-dim）加一圈青绿细线（线在 style.css），字是正文色
    "user-bubble": ["rgba(15, 118, 110, 0.12)", "rgba(79, 209, 197, 0.14)"],
    "user-text": "var(--text)",
    // 实色块上的字：浅色白字；深色下实色块都是亮色（青绿、亮红、亮绿），字用深色墨（同设计稿的 --accent-ink）
    "on-color": ["#ffffff", "#0c1017"],
    "danger-fill": ["#c53030", "#fc8181"],
    // 未读、要你的事：琥珀色（--warn）
    badge: "var(--you)",
    // 跟你有关的：设计稿里"等你验收""审批 · 先问我""卡住任务"都是琥珀色（--warn、--warn-dim）。
    // 浅色设计稿是 #b45309：压在淡琥珀底上 3.82:1，沿色相加深到 #a14806（4.63:1）
    you: ["#a14806", "#f6ad55"],
    "you-bg": ["rgba(180, 83, 9, 0.12)", "rgba(246, 173, 85, 0.16)"],
    // 个人助理的名字标签（43 号票要求名字带底色；设计稿里名字只是一行灰字）：按青绿推成淡青绿底、深青绿字
    "name-bg": ["#c2e3df", "#19403d"],
    "name-fg": ["#0b4f49", "#8fe3db"],
    // 内容类型色：计划换成蓝（琥珀色只留给"要你"的事，免得"这是计划"和"等你"撞色；蓝是设计稿给的强调色备选之一 #7AA2F7）
    "c-user": "var(--primary)",
    "c-thinking": ["#6d5bd0", "#a99bf5"],
    "c-reply": ["#64748b", "#94a3b8"],
    "c-plan": ["#3b6fd4", "#7aa2f7"],
    "c-tool": ["#2f855a", "#68d391"],
    "c-context": ["#b83280", "#f687b3"],
    // 标注：数据青绿淡底；操作（命中关注类别、计划外、待处理……）偏黄的琥珀，和"要你"的橙琥珀分开
    // （审批卡上命中的关注类别按设计稿是中性的细线签，那一处在 style.css 里单独改，别处都用这一对）
    "data-bg": ["#e1f0ee", "#15302f"],
    "data-fg": ["#0b5f58", "#7fdcd2"],
    "op-bg": ["#faf1dc", "#2c2616"],
    "op-fg": ["#8a5a00", "#f2c46b"],
    "high-bg": ["#fdecec", "#3a1d22"],
    "high-fg": ["#c42b2b", "#fc8f8f"],
    // 结果色（全 App 固定的含义不变）：通过绿；拉回青、退回紫沿用经典
    ok: ["#12773a", "#68d391"],

    // ---- 字体：正文 Noto Sans SC（设计稿就是它，净白格栅已经带着这个包）；时间、时长、计数、token 这些数字用 JetBrains Mono ----
    // 数字字体后面接正文字体：混在数字里的汉字（"万""阶段"）落到 Noto Sans SC，不落到系统随便挑的字体上
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-num": '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Consolas, var(--font-body)',
    "font-mono": '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Consolas, monospace',

    // ---- 圆角：卡片、气泡、输入框 12，按钮 10，代码块、小按钮 8，小签是胶囊，气泡的尖角 3 ----
    // （m 8、l 10、xl 12、胶囊 999 和经典一样，沿用；只写不一样的）
    "radius-xs": "3px",
    "radius-s": "4px",
    "radius-2xl": "12px",
    "radius-sheet": "16px",

    // ---- 阴影：深色底上阴影看不出来，浮起来的东西先描一圈线 ----
    "shadow-menu": "0 0 0 1px var(--border), 0 10px 28px rgba(2, 6, 12, 0.28)",
    "shadow-float": "0 0 0 1px var(--border), 0 8px 24px rgba(2, 6, 12, 0.26)",
    "shadow-note": "0 0 0 1px var(--border), 0 4px 14px rgba(2, 6, 12, 0.18)",
    "shadow-slide": "-8px 0 24px rgba(2, 6, 12, 0.22)",

    // ---- 间距密度：页面左右 16，消息之间 18，标题栏 56（标题下面可以带一行小字） ----
    "space-page": "16px",
    "space-msg": "18px",
    "bar-h": "56px",

    // ---- 边框：卡片、底板都是 1px 细线框（卡片的 card-border 经典就是这样，沿用；底板经典没有边框，这里加上） ----
    "panel-border": "1px solid var(--border)",

    // ---- 语音气泡的播放条（照设计稿 c-chat：播放键 28 的圆角方块、和波形隔 10，波形竖条 3 像素、隔 3，左右内边距 12） ----
    // 标题栏的底色（bar-bg）和卡片一样是 surface，经典就是，没写
    "voice-pad": "12px",
    // 你的、个人助理的框都是四周 1px 细线（style.css），左右合起来 2
    "voice-line": "2px",
    "voice-key": "28px",
    "voice-gap": "10px",
    "voice-bar": "3px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    { package: "@fontsource-variable/jetbrains-mono", css: "index.css" },
  ],
};
