// 软糖圆角（42 号票，设计稿 docs/design/styles/d-*.dc.html）：ZCOOL 快乐体标题（正文是 Noto Sans SC，不用它）、大圆角、
// 浮起的胶囊导航和输入栏、紫罗兰强调色，"要你"的事和未读是珊瑚红。卡片、气泡都是白色浮在淡紫底上，靠柔和的紫色投影分层，不描边。
// token 在这里；只靠 token 做不到的（胶囊导航、浮起的输入栏、按钮一律胶囊、看板和待办一行一张浮卡……）在 style.css。
// 颜色取设计稿 renderVals() 的浅色、深色两套（--bg、--surface、--border、--text、--muted、--accent、--accent-ink、
// --accent-soft、--warm、--warm-soft、--code）；对比度不够的几处沿原来的色相调深，下面标着"设计稿是"。
import type { VisualStyle } from "../tokens.ts";

export const candy: VisualStyle = {
  id: "candy",
  name: "软糖圆角",
  blurb: "大圆角、浮起的胶囊，紫罗兰配珊瑚红",
  tokens: {
    // ---- 颜色 ----
    bg: ["#f4f1fb", "#15112a"],
    surface: ["#ffffff", "#221c3f"],
    // 标题栏不是白条，直接落在淡紫底上（设计稿），手机浏览器地址栏的颜色跟着它
    "bar-bg": "var(--bg)",
    text: ["#241e3a", "#f1ecff"],
    muted: ["#6b6484", "#aea6cc"],
    border: ["#e6e1f3", "#352d5c"],
    // 紫罗兰：链接、选中、主按钮、你发的消息（深色下是浅紫，上面的字是深紫）
    primary: ["#5b3df5", "#a99bff"],
    "primary-text": ["#ffffff", "#1a1340"],
    "primary-fill": "var(--primary)",
    // 危险按钮：珊瑚红压暗一档，浅深一样（白字 5.71:1）
    "danger-fill": "#bd3421",
    "user-bubble": "var(--primary)",
    "user-text": "var(--primary-text)",
    // 输入框、代码块、小签的浅底（设计稿的 --code）
    fill: ["#f4f1fb", "#1b1636"],
    // 主导航里当前那一项：压在淡紫胶囊（--data-bg）上，用淡紫底配的深紫字（这一对在对比度测试里）
    "nav-on": "var(--data-fg)",
    // 未读：珊瑚红
    badge: "var(--you)",
    scrim: "rgba(21, 17, 42, 0.5)",
    // 内容类型色：你说的是紫罗兰；想法换成长春花蓝（经典的紫和你的紫撞了），别的沿用经典
    "c-user": ["#5b3df5", "#a99bff"],
    "c-thinking": ["#6f8ff0", "#8fa8ff"],
    "c-reply": ["#958fae", "#8a83a8"],
    // 淡紫底紫字（设计稿的 --accent-soft 配 --accent）：数据小签，也是这套风格所有淡紫底的地方（次要按钮、选中的导航、
    // "执行中"这类状态、按住说话……）——字一律用 data-fg，对比度测试查得到这一对（浅色 6.6:1、深色 7.6:1）
    "data-bg": ["#ece7ff", "#2e2659"],
    "data-fg": ["#4a2bd9", "#c3b8ff"],
    // 命中关注类别、紧急度"卡住任务"：琥珀色（设计稿里这类全是珊瑚红，和"有时限"的玫红、"要你"的珊瑚红分不开，拉开成琥珀）
    "op-bg": ["#fff1dc", "#3a2a12"],
    "op-fg": ["#9a5800", "#f5b45a"],
    // 出错、拦下、紧急度"有时限"：偏紫的玫红，和"要你"的珊瑚红、琥珀分得开
    "high-bg": ["#fde6ee", "#4a1a2c"],
    "high-fg": ["#b0185f", "#ff8cc0"],
    // 跟你有关的（等你、问你、要你批准）：珊瑚红。设计稿浅色是 #c93a26，压在淡珊瑚底上 4.3:1 → 调深到 4.82:1
    you: ["#bd3421", "#ff9a86"],
    "you-bg": ["#fde7e3", "#45231f"],
    // 个人助理的名字标签：淡紫底深紫字（设计稿的淡紫 #ece7ff 和页面底色分不出来，加深一档）
    "name-bg": ["#ddd5ff", "#3a3070"],
    "name-fg": ["#3f22c9", "#ddd6ff"],

    // ---- 字体：正文 Noto Sans SC，标题 ZCOOL 快乐体（都由二狗自己提供，没下好时先用系统字体） ----
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-title": '"ZCOOL KuaiLe", var(--font-body)',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号：标题大一点（快乐体只有一种字重，靠字号撑） ----
    "fs-title": "19px",

    // ---- 圆角：大圆角，气泡 22、卡片 20、底部弹层 28；气泡的小尖角 6 ----
    "radius-xs": "6px",
    "radius-s": "8px",
    "radius-m": "12px",
    "radius-l": "16px",
    "radius-xl": "20px",
    "radius-2xl": "22px",
    "radius-sheet": "28px",

    // ---- 阴影：柔和的紫色投影（深色下是黑的、重一点）。浅深几何一样只换颜色，写成一个值、颜色用 light-dark() ----
    "shadow-menu": "0 12px 32px light-dark(rgba(72, 48, 160, 0.2), rgba(0, 0, 0, 0.5))",
    "shadow-float": "0 8px 24px light-dark(rgba(72, 48, 160, 0.2), rgba(0, 0, 0, 0.45))",
    // 设计稿的 --shadow：卡片、气泡、浮起的导航和输入栏都用它（style.css）
    "shadow-note": "0 8px 24px light-dark(rgba(72, 48, 160, 0.12), rgba(0, 0, 0, 0.35))",
    "shadow-slide": "-8px 0 24px light-dark(rgba(72, 48, 160, 0.14), rgba(0, 0, 0, 0.35))",

    // ---- 间距：留白宽，消息之间 16 ----
    "space-page": "16px",
    "space-msg": "16px",
    "bar-h": "60px",

    // ---- 边框：卡片不描边，靠投影浮起来（style.css） ----
    "card-border": "none",

    // ---- 语音气泡的播放条（设计稿 d-chat）：播放键是 36 的圆、和波形隔 10，波形竖条 4 像素、隔 3；没有经典左边的竖线 ----
    // 内边距：设计稿播放键一侧 10、另一侧 14，这里两边一样取 12
    "voice-pad": "12px",
    "voice-line": "0px",
    "voice-key": "36px",
    "voice-gap": "10px",
    "voice-bar": "4px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    { package: "@fontsource/zcool-kuaile", css: "index.css" },
  ],
};
