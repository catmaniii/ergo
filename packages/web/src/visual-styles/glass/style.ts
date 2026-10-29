// 玻璃光纹（46 号票，设计稿 docs/design/styles/e-*.dc.html）：磨砂玻璃面板浮在点阵底上、电光蓝微光，正文 Noto Sans SC，
// 时间、时长、计数这些数字用 Chakra Petch。按钮、你发的消息是电光蓝实色块；"要你"的事（等你验收、卡住、未读）是砖红（设计稿的 --warn）。
// token 在这里；只靠 token 做不到的（点阵底、磨砂玻璃、浮起的标题栏 / 导航 / 输入栏、带微光的选中条和进度条……）在 style.css。
//
// 颜色取设计稿 renderVals() 的浅色、深色两套（--bg、--surface、--border、--text、--muted、--accent、--accent-ink、--accent-soft、
// --warn、--warn-ink、--warn-soft、--code、--dot）。磨砂玻璃的半透明底（设计稿的 --surface，浅色白 74%、深色 72%）和点阵的点（--dot）
// 写在 style.css 里（--glass-bg、--glass-dot），只给标题栏、导航、输入栏用（用户 2026-10-11 定）；面板的亮边（--edge）是 card-border。
// 这里的 surface 是不透明的：玻璃叠在页面底色上的样子（浅色 #fbfbfd、深色 #14192d），卡片、气泡、看板卡、待办行这些浮在点阵上的面板，
// 和弹层、菜单、窄屏滑入的详情页这些盖在内容上的东西都用它。
//
// 对比度按"最坏的底色"算（文字对比度不能靠模糊撑）：直接压在页面上的字按点阵的点算（浅色下点比页面底深、深色下比页面底亮），
// 玻璃上的字按"玻璃叠在点上"算（不支持 backdrop-filter 时退回的半透明纯色正好压在一个点上）；小签、名字标签的淡底写成不透明的，
// 放在哪都一样。浅色下设计稿的几个字色压在点上不到 4.5:1，沿原来的色相压暗（下面标着"设计稿是"）；深色都够，照设计稿。
// 这些组合在 test/visual-styles/glass.test.ts 里查。
import { t } from "@ergo/protocol";
import type { VisualStyle } from "../tokens.ts";

export const glass: VisualStyle = {
  id: "glass",
  // 名字和一句话按当前语言（169 号票，取的时候现查）
  get name() {
    return t("styles.glass.name");
  },
  get blurb() {
    return t("styles.glass.blurb");
  },
  tokens: {
    // ---- 颜色 ----
    bg: ["#eef1f8", "#0b0e1a"],
    // 不透明的玻璃色（设计稿的 --surface 叠在 --bg 上）：卡片、气泡这些面板的底；半透明的磨砂玻璃见 style.css 的 --glass-bg。
    // 标题栏底色 bar-bg 沿用经典的 var(--surface)：标题栏是浮起的磨砂玻璃，看上去就是这个颜色，手机浏览器地址栏跟着它
    surface: ["#fbfbfd", "#14192d"],
    text: ["#121a33", "#e8ecff"],
    // 设计稿是 #566078：压在点上 3.96:1 → 4.61:1
    muted: ["#4d566c", "#9aa3c7"],
    // 细线、次要按钮的边：半透明，叠在玻璃上、页面上都合适（设计稿的 --border）
    border: ["rgba(30, 41, 82, 0.12)", "rgba(255, 255, 255, 0.1)"],
    // 电光蓝当字用（链接、选中的字、导航当前那一项）：设计稿是 #2457f5，压在点上 3.52:1 → 4.56:1；深色照设计稿 #7c9cff
    primary: ["#1e49ce", "#7c9cff"],
    // 电光蓝实色块（主按钮、你发的消息、分段选中的那一段）：设计稿的 --accent 原样，上面是 --accent-ink 的字（浅色 5.59:1、深色 7.38:1）
    "primary-fill": ["#2457f5", "#7c9cff"],
    "primary-text": ["#ffffff", "#0b0e1a"],
    "user-bubble": "var(--primary-fill)",
    "user-text": "var(--primary-text)",
    // 危险按钮：深玫红，浅深一样（白字 7.28:1）
    "danger-fill": "#a8154f",
    // 输入框、代码、小签的浅底（设计稿的 --code）：半透明，叠在玻璃上
    fill: ["rgba(18, 26, 51, 0.06)", "rgba(255, 255, 255, 0.07)"],
    // 未读的小点：砖红（设计稿导航上的未读）
    badge: "var(--you)",
    scrim: "rgba(11, 14, 26, 0.5)",
    // 淡蓝底蓝字（设计稿的 --accent-soft 配 --accent）：数据小签、卡片的类型标签、"执行中"、选中的竖栏、按住说话……
    // 淡底写成不透明的（--accent-soft 叠在玻璃上），字用 primary（浅色 5.81:1、深色 5.09:1）
    "data-bg": ["#dfe6fb", "#252e4f"],
    "data-fg": "var(--primary)",
    // 跟你有关的（等你验收、中断、超预算、上次失败、未读）：设计稿的 --warn。浅色设计稿是 #b8321a，压在点上 3.76:1 → 4.57:1；
    // 淡底是 --warn-soft 叠在玻璃上（不透明），浅色 6.0:1、深色 5.98:1
    you: ["#a12c17", "#ff8a6a"],
    "you-bg": ["#f5e6e4", "#352936"],
    // 设计稿没有的按同一套推：出错、拦下用深玫红（和"要你"的砖红分得开），命中关注类别（计划外、待处理……）用琥珀，通过绿；
    // 浅色都压暗到压在点上也有 4.5:1
    "high-bg": ["#f7e3ea", "#3a2340"],
    "high-fg": ["#a8154f", "#ff7aa8"],
    "op-bg": ["#f8eddb", "#2f2a22"],
    "op-fg": ["#7d4b00", "#f3c06a"],
    ok: ["#0f6431", "#5fd38d"],
    // 个人助理的名字标签（43 号票；设计稿的 .name：淡蓝底、蓝字、一圈蓝线，线在 style.css）。底色比数据小签深一档，
    // 和页面底色、玻璃分得出来（浅色 1.20 / 1.31 倍，深色 1.63 / 1.48 倍）；字和底浅色 5.36:1、深色 5.84:1
    "name-bg": ["#d5ddf9", "#2b365b"],
    "name-fg": ["#1e49ce", "#9db4ff"],

    // ---- 字体：正文 Noto Sans SC（净白格栅已经带着这个包）；数字 Chakra Petch 600（设计稿的 .num），后面接正文字体，混在数字里的汉字落到 Noto Sans SC ----
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-num": '"Chakra Petch", var(--font-body)',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号：页面标题 18（设计稿的 h1） ----
    "fs-title": "18px",

    // ---- 圆角：分段、代码块 10，按钮、输入栏里的按钮 12，看板卡、待办行 14，卡片、气泡、标题栏 16，弹层 20；小签、角标、药丸都是 6 的小圆角（不是胶囊） ----
    // （xs 4、s 6 和经典一样，沿用）
    "radius-m": "10px",
    "radius-l": "12px",
    "radius-xl": "14px",
    "radius-2xl": "16px",
    "radius-sheet": "20px",
    "radius-pill": "6px",

    // ---- 阴影：设计稿的 --glow（顶上一道内亮线，下面一圈淡淡的蓝光；深色下是黑的、重一点）。浅深几何一样，颜色用 light-dark() ----
    "shadow-menu": "inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.08)), 0 14px 36px light-dark(rgba(30, 41, 82, 0.18), rgba(0, 0, 0, 0.55))",
    "shadow-float": "0 10px 30px light-dark(rgba(36, 87, 245, 0.16), rgba(0, 0, 0, 0.5))",
    // 浮在点阵上的面板（标题栏、导航、输入栏这几块磨砂玻璃，卡片、气泡这些不透明的）都用它（style.css）
    "shadow-note": "inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.08)), 0 10px 30px light-dark(rgba(36, 87, 245, 0.1), rgba(0, 0, 0, 0.45))",
    "shadow-slide": "-8px 0 24px light-dark(rgba(30, 41, 82, 0.12), rgba(0, 0, 0, 0.4))",

    // ---- 间距：页面左右 16、消息之间 16；标题栏 68（浮起的玻璃，放得下 44 高的按钮，上下各留 11） ----
    "space-page": "16px",
    "space-msg": "16px",
    "bar-h": "68px",

    // ---- 边框：玻璃面板四周一道亮边（设计稿的 --edge），卡片、底板都是 ----
    "card-border": "1px solid light-dark(rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.12))",
    "panel-border": "var(--card-border)",

    // ---- 语音气泡的播放条（照设计稿 e-chat：播放键 30 的圆角方块、和波形隔 10，波形竖条 2 像素、隔 3，左右内边距 12） ----
    // 竖条宽 2 和经典一样，沿用；个人助理的框四周 1px 亮边（style.css），左右合起来 2
    "voice-pad": "12px",
    "voice-line": "2px",
    "voice-key": "30px",
    "voice-gap": "10px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    // 设计稿只用 600 一种字重（.num）
    { package: "@fontsource/chakra-petch", css: "600.css" },
  ],
};
