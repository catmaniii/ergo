// 工程蓝图（47 号票，设计稿 docs/design/styles/f-*.dc.html）：直角、1.5px 线框带角标、网格底、钴蓝；深色就是真正的蓝图纸
// （深蓝底、浅蓝线）。密度比别的风格低：标题栏 60、消息之间 16、卡片内边距大。
// 颜色取自设计稿样式里 .root（浅色）、.root.dark（深色）两套变量 --bg、--surface、--line、--text、--muted、--accent、
// --accent-ink、--accent-soft、--warn、--warn-ink、--code（renderVals() 只挑强调色：默认钴蓝，深色下换成 #9DB4FF）；
// 设计稿的线色 --line 和强调色 --accent 是同一个钴蓝，这里线（border）、强调（primary）都是它。
// 对比度不够、或者设计稿没画到的几处按同一套推（标着"设计稿是""设计稿没有"）。
// token 在这里；只靠 token 做不到的（网格底、角标、线框按钮、实色状态签、线条图标……）在 style.css。
import type { VisualStyle } from "../tokens.ts";

export const blueprint: VisualStyle = {
  id: "blueprint",
  name: "工程蓝图",
  blurb: "直角线框带角标、网格底、钴蓝，深色就是蓝图纸",
  tokens: {
    // ---- 颜色（设计稿的 --bg、--surface、--text、--muted） ----
    bg: ["#f7f9fc", "#0d1b3e"],
    surface: ["#ffffff", "#112353"],
    text: ["#0f1e45", "#e6ecff"],
    muted: ["#4b5a80", "#a4b2d9"],
    // 线：设计稿所有的框、分隔线、虚线都是钴蓝（--line），深色下是浅蓝线——蓝图纸。
    // 经典里有几处拿 --border 当底色（次要按钮、件数小签、进度条的轨道……），style.css 里逐个换成淡蓝底或者线框
    border: ["#1e3a8a", "#9db4ff"],
    // 钴蓝（--accent）：链接、选中、主按钮实色块（上面的字是 --accent-ink）
    primary: ["#1e3a8a", "#9db4ff"],
    "primary-text": ["#ffffff", "#0d1b3e"],
    "primary-fill": "var(--primary)",
    // 你发的消息：设计稿你的语音是线色实底、页面底色的字（深色下浅蓝底深蓝字），文字消息照它
    "user-bubble": "var(--primary)",
    "user-text": "var(--bg)",
    // 设计稿的 --code：输入框、代码、小签的浅底（聊天的输入框按设计稿用页面底色，在 style.css）
    fill: ["#eef2fa", "#0b173a"],
    // 实色块上的字：浅色白字；深色下实色块都是亮色（出错粉红、计划琥珀、通过绿），字用深蓝墨（同设计稿的 --accent-ink）
    "on-color": ["#ffffff", "#0d1b3e"],
    // 危险按钮：浅色深红实底白字 6.57:1；深色亮粉红实底深蓝字 7.81:1（设计稿没有）
    "danger-fill": ["#b42318", "#ff8fa3"],
    // 弹层下面压暗的那一层：深蓝
    scrim: "rgba(13, 27, 62, 0.5)",
    // 未读、要你的事：橙色（--warn）
    badge: "var(--you)",
    // 跟你有关的（等你、审批、卡住任务、未读）：设计稿的 --warn。浅色设计稿是 #c2410c，设计稿的网格线（#dce4f2）上 4.05:1（字压在网格线上要按
    // 最坏的底算），沿色相加深到 #b23a0a：网格线（#dde2ee，见 style.css）上 4.62:1、页面底色上 5.68:1、白底上 6.0:1；深色 #ffb070 原样
    you: ["#b23a0a", "#ffb070"],
    "you-bg": ["#fdf0e8", "#3a3245"],
    // 个人助理的名字标签（43 号票；设计稿的 .name：淡蓝底 --accent-soft、钴蓝字、钴蓝细框，前后一对 [ ]）。
    // 设计稿的淡蓝 #e3eaf8 和浅色页面底色亮度差 1.14、深色 #1c2d5c 和卡片底色 1.14，名字标签测试要 1.15，各加深 / 提亮一档
    "name-bg": ["#dbe4f6", "#22366b"],
    "name-fg": "var(--primary)",
    // 内容类型色：你说的是钴蓝；计划换成琥珀（橙色留给"要你"的事，钴蓝已经是强调色），回复是蓝灰
    "c-user": "var(--primary)",
    "c-thinking": ["#5b4bb7", "#b3a6ff"],
    "c-reply": ["#62719a", "#8d9cc6"],
    "c-plan": ["#a16207", "#f2c14e"],
    "c-tool": ["#2f7d4f", "#6fcf97"],
    "c-context": ["#a3346f", "#f08bbf"],
    // 标注：数据是设计稿的淡蓝（--accent-soft）钴蓝字；操作（命中关注类别、计划外……）是土黄，和"要你"的橙分开
    // （审批卡上命中的关注类别按设计稿是中性的线框签，那一处在 style.css 里单独改）
    "data-bg": ["#e3eaf8", "#1c2d5c"],
    "data-fg": "var(--primary)",
    "op-bg": ["#fbf1e1", "#352f2c"],
    "op-fg": ["#7a4b00", "#f2c46b"],
    "high-bg": ["#fdecee", "#3d2346"],
    "high-fg": ["#b42318", "#ff8fa3"],
    // 结果色（全 App 固定的含义不变）：通过绿、拉回青、退回紫。工具调用那一行的"通过""拉回"这些字直接压在网格底上，
    // 浅色按网格线的颜色（#dde2ee）算要 4.5:1：绿 #05703f 4.77:1（白底 6.2:1）、青 #0b6a84 4.75:1（经典 #0f8a9d 白底上只有 4.08:1）、
    // 紫 #7a40c8 4.77:1（经典 #8a4fd6 网格线上 3.88:1）；深色拉回、退回沿用经典
    ok: ["#05703f", "#5fd39a"],
    "pull-fg": ["#0b6a84", "#4fc6d6"],
    "reject-fg": ["#7a40c8", "#b691ff"],

    // ---- 字体：正文 Noto Sans SC（设计稿就是它，净白格栅已经带着这个包）；时间、时长、计数、代码用 IBM Plex Mono ----
    // 数字字体后面接正文字体：混在数字里的汉字（"万""阶段"）落到 Noto Sans SC
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-num": '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, var(--font-body)',
    "font-mono": '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',

    // ---- 字号阶：标题 18（设计稿的 h1），其余和经典一样 ----
    "fs-title": "18px",

    // ---- 圆角：全部直角 ----
    "radius-xs": "0px",
    "radius-s": "0px",
    "radius-m": "0px",
    "radius-l": "0px",
    "radius-xl": "0px",
    "radius-2xl": "0px",
    "radius-sheet": "0px",
    "radius-pill": "0px",

    // ---- 阴影：不用模糊，浮起来的东西往右下错开一块硬边的淡蓝（设计稿主按钮的 3px 3px 0 --accent-soft） ----
    "shadow-menu": "4px 4px 0 var(--data-bg)",
    "shadow-float": "4px 4px 0 var(--data-bg)",
    "shadow-note": "3px 3px 0 var(--data-bg)",
    // 窄屏整页滑入的详情页左边缘：一道线，不是阴影
    "shadow-slide": "-1.5px 0 0 var(--border)",
    // 宽屏阶段栏的 × 这类浮在栏边上的小圆钮（88 号票）：小一号的硬投影
    "shadow-btn": "2px 2px 0 var(--data-bg)",

    // ---- 间距密度：页面左右 16、消息之间 16、标题栏 60（设计稿） ----
    "space-page": "16px",
    "space-msg": "16px",
    "bar-h": "60px",

    // ---- 边框：卡片、底板都是 1.5px 的线框（设计稿的 .box） ----
    "card-border": "1.5px solid var(--border)",
    "panel-border": "1.5px solid var(--border)",

    // ---- 语音气泡的播放条（照设计稿 f-chat：播放键 28 的方块、和波形隔 10，波形竖条 3、隔 3，左右内边距 12） ----
    // 你的、个人助理的框都是四周 1.5px 的线框，左右合起来 3——和经典 voice-line 的 3 一样，不写；标题栏底色就是卡片色，不写 bar-bg
    "voice-pad": "12px",
    "voice-key": "28px",
    "voice-gap": "10px",
    "voice-bar": "3px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    // 设计稿用了 500（.mono）、600（导航上的数字）两个字重；只写 400 的地方落到 500
    { package: "@fontsource/ibm-plex-mono", css: "500.css" },
    { package: "@fontsource/ibm-plex-mono", css: "600.css" },
  ],
};
