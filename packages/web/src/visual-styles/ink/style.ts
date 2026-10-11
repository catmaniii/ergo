// 水墨国风（50 号票，设计稿 docs/design/styles/i-*.dc.html）：宣纸底、墨色字，朱砂是唯一的颜色——主按钮、"要你"的事、未读、
// 个人助理名字的印章；马善政书法只用在标题上（font-title），正文是 Noto Serif SC 宋体；线是淡墨的细线，列表一行一行之间是虚线，
// 直角（2px）、无阴影。你发的消息是墨色块，个人助理的话是淡灰的"洗"（设计稿的 --wash）。
// 颜色取设计稿样式里 .root（浅色）、.root.dark（深色）两套变量（--bg、--surface、--text、--muted、--accent、--accent-ink、
// --accent-soft、--rule、--wash、--ink、--ink-on）；标着"设计稿是"的几处为了对比度调过，设计稿没画到的（出错、数据、操作类小签……）
// 按同一套色调补。token 在这里；只靠 token 做不到的（印章、书法标题不加粗、虚线细格、方形的点、线条图标……）在 style.css。
import type { VisualStyle } from "../tokens.ts";

export const ink: VisualStyle = {
  id: "ink",
  name: "水墨国风",
  blurb: "宣纸底、书法标题、朱砂印章，虚线细格",
  tokens: {
    // ---- 颜色 ----
    bg: ["#fbfaf7", "#141413"],
    surface: ["#ffffff", "#1e1e1c"],
    // 标题栏不是一条白板，直接落在宣纸底上（设计稿），手机浏览器地址栏跟着它
    "bar-bg": "var(--bg)",
    text: ["#222222", "#ece8df"],
    muted: ["#6a6a66", "#a39e93"],
    // 线：设计稿的 --rule，淡墨（黑 / 白 20%），落在宣纸底、卡片、淡灰的洗上都是同一种淡
    border: ["rgba(0, 0, 0, 0.2)", "rgba(255, 255, 255, 0.2)"],
    // 朱砂：链接、选中的字、"要你"的事。深色下设计稿是 #E0574B，压在卡片底上只有 4.48:1、淡朱底上 3.91:1，当字用的提亮到 #e8695d
    // （卡片底 5.26:1、淡朱底 4.59:1）；当底用的（主按钮、印章、未读的点）照设计稿（primary-fill）
    primary: ["#b3261e", "#e8695d"],
    "primary-fill": ["#b3261e", "#e0574b"],
    // 朱砂块上的字（设计稿的 --accent-ink）：浅色白字 6.54:1，深色深墨 5.12:1
    "primary-text": ["#ffffff", "#1a0c0a"],
    // 危险按钮：比朱砂深一档的赭红（设计稿 a:hover 的 #8E1D17），和朱砂的主按钮分得开，白字 8.98:1
    "danger-fill": "#8e1d17",
    // 你发的消息：墨色块（设计稿的 --ink / --ink-on，你的语音就是它）。浅色 16.67:1、深色 15.08:1
    "user-bubble": ["#1a1a1a", "#ece8df"],
    "user-text": ["#fbfaf7", "#141413"],
    // 淡灰的"洗"（设计稿的 --wash）：个人助理的话的底（style.css）、代码块、输入框、小签的底
    fill: ["#efede6", "#26262a"],
    // 未读：朱砂的小方块
    badge: "var(--primary-fill)",
    scrim: "rgba(20, 20, 19, 0.45)",
    // 跟你有关的（等你、问你、要你批准）：朱砂（设计稿看板上"等你验收"、审批卡的"先问我"）；淡朱底是设计稿的 --accent-soft
    you: "var(--primary)",
    "you-bg": ["#f6e7e4", "#3a2320"],
    // 个人助理的名字：朱砂印章（设计稿的 .seal：朱砂底、白字，里面一圈白线、书法字在 style.css）
    "name-bg": "var(--primary-fill)",
    "name-fg": "var(--primary-text)",
    // 内容类型色：收成墨色里的几种淡彩（藤紫、赭黄、松绿、胭脂），缩小后的色块、图例里还分得开。你说的是墨色
    // （深色下墨色是浅色，压不住白字，换成石墨灰）
    "c-user": ["#2b2b2b", "#77736b"],
    "c-thinking": ["#8b78b0", "#a898cc"],
    "c-reply": ["#a39e93", "#6a6a66"],
    "c-plan": ["#b9853a", "#d2a35a"],
    "c-tool": ["#5e8c6c", "#7fb08e"],
    "c-context": ["#b0607e", "#cf89a3"],
    // 标注（设计稿没画）：数据是黛蓝，命中关注类别的是赭石，出错、拦下是胭脂红（偏紫，和朱砂的"要你"分得开）
    "data-bg": ["#e8ecef", "#232a31"],
    "data-fg": ["#34506b", "#a9bdd1"],
    "op-bg": ["#f3eadb", "#33291c"],
    "op-fg": ["#7d4e12", "#e0b878"],
    "high-bg": ["#f7e4ea", "#3b1e28"],
    "high-fg": ["#9c1f4c", "#f08fae"],
    // 结果色（全 App 固定的含义不变）：通过是松绿；拉回青、退回紫沿用经典
    ok: ["#2d6a46", "#8cc8a0"],
    // 缩小后条右上角关注小圆点的圈：卡片底色（经典是白）
    "zoom-dot-ring": "var(--surface)",

    // ---- 字体：正文 Noto Serif SC 宋体，标题马善政书法（都由二狗自己提供，没下好时先用系统的宋体） ----
    "font-body": '"Noto Serif SC Variable", "Songti SC", "STSong", "SimSun", serif',
    "font-title": '"Ma Shan Zheng", var(--font-body)',

    // ---- 字号：页面标题 30（设计稿的 h1；马善政只有一种字重，靠字号撑） ----
    "fs-title": "30px",

    // ---- 圆角：一律 2px 的直角（设计稿的按钮、卡片、小签、代码块、导航上的角标都是 2）；胶囊也收成直角 ----
    "radius-xs": "2px",
    "radius-s": "2px",
    "radius-m": "2px",
    "radius-l": "2px",
    "radius-xl": "2px",
    "radius-2xl": "2px",
    "radius-sheet": "2px",
    "radius-pill": "2px",

    // ---- 阴影：没有（设计稿"无阴影"）；浮起来的菜单、提示、弹层靠一圈细线和底色分开（style.css） ----
    "shadow-menu": "none",
    "shadow-float": "none",
    "shadow-note": "none",
    "shadow-slide": "none",

    // ---- 间距：页面左右 22、消息之间 20（设计稿），标题栏放得下 30 的书法标题和 44 高的按钮 ----
    "space-page": "22px",
    "space-msg": "20px",
    "bar-h": "64px",

    // ---- 边框：底板（设置项、项目页头部……）也是一圈淡墨细线（卡片的 card-border 经典就是，没写） ----
    "panel-border": "1px solid var(--border)",

    // ---- 语音气泡的播放条（设计稿 i-chat：播放三角 16（和经典一样，没写）、和波形隔 10，波形竖条 2（同经典）隔 3，左右内边距 12） ----
    "voice-pad": "12px",
    // 个人助理的框是淡灰的洗，没有边线
    "voice-line": "0px",
    "voice-gap": "10px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-serif-sc", css: "index.css" },
    { package: "@fontsource/ma-shan-zheng", css: "index.css" },
  ],
};
