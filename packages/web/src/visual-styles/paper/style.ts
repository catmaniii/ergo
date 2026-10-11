// 暖纸手帐（40 号票，设计稿 docs/design/styles/a-*.dc.html）：Noto Serif SC 宋体、米纸底、墨绿印章色、1px 细边卡片、
// 小圆角、个人助理的话前面一个圆形字头像（名字的第一个字）。主按钮、你发的消息、选中的东西是墨绿；"要你"的事也用墨绿，
// 出错、命中关注类别的小签、未读是赭石色（设计稿的 --warn）。
// token 在这里；只靠 token 做不到的（个人助理的话不套气泡、圆形字头像、线条图标、下划线页签……）在 style.css。
import type { VisualStyle } from "../tokens.ts";

export const paper: VisualStyle = {
  id: "paper",
  name: "暖纸手帐",
  blurb: "宋体、米纸底、墨绿印章色，细边卡片像手帐",
  tokens: {
    // ---- 颜色（设计稿的 --bg、--surface、--border、--text、--muted、--accent、--user、--warn……，浅深两套） ----
    bg: ["#f5f0e6", "#1c1916"],
    surface: ["#fffcf7", "#27231f"],
    text: ["#2a2522", "#ede6da"],
    muted: ["#6b625a", "#a89f93"],
    border: ["#e2d9c8", "#3b352e"],
    // 墨绿：链接、选中的字、主按钮（深色下是浅绿，上面压深绿字：设计稿的 --accent-ink）
    primary: ["#3f6b52", "#9cc9aa"],
    "primary-text": ["#ffffff", "#14241a"],
    "primary-fill": "var(--primary)",
    // 危险按钮：比赭石红一点的砖红，白字
    "danger-fill": "#a3342b",
    // 你发的消息：墨绿块（上面的白字 user-text 和经典一样，没写）
    "user-bubble": ["#3f6b52", "#2f5540"],
    // 卡片上的浅底（代码片段、小签、引用条、表单输入框）：设计稿的 --code；聊天输入框按设计稿用页面底色（style.css）
    fill: ["#efe9dc", "#1f1c18"],
    // 未读的小点：赭石（设计稿导航上的未读、待我处理的未读点）
    badge: ["#9e4523", "#e3a383"],
    scrim: "rgba(28, 22, 16, 0.45)",
    // 跟你有关的（等我、问你）：墨绿字、浅绿底（设计稿 .you、.kind 和头像的 --accent-soft）
    you: ["#3f6b52", "#9cc9aa"],
    "you-bg": ["#e6ece4", "#2a3a30"],
    // 个人助理的名字标签：墨绿的"印章"。浅色比头像的浅绿再深一档，和米纸底、卡片底分得出来（6.4:1，深色 6.5:1）
    "name-bg": ["#d6e3d7", "#2a3a30"],
    "name-fg": ["#2f5540", "#9cc9aa"],
    // 内容类型色：收成纸上的颜色（墨绿、赭黄、灰紫、豆沙），缩小后的色块、图例里还分得开
    "c-user": ["#3f6b52", "#9cc9aa"],
    "c-thinking": ["#8b78b0", "#a898cc"],
    "c-reply": ["#a89f93", "#6b625a"],
    "c-plan": ["#b9853a", "#d2a35a"],
    "c-tool": ["#5e8c6c", "#7fb08e"],
    "c-context": ["#b0607e", "#cf89a3"],
    // 标注：数据是靛蓝灰，命中关注类别的是设计稿审批卡上的赭石小签（--warn-soft 底、--warn 字）
    "data-bg": ["#e7ebee", "#232a30"],
    "data-fg": ["#3b5068", "#a9bcd0"],
    "op-bg": ["#f7e6dc", "#3b2a22"],
    "op-fg": ["#9e4523", "#e3a383"],
    "high-bg": ["#f8e3e0", "#3e2321"],
    "high-fg": ["#a3342b", "#f0a096"],
    // 结果色（全 App 固定的含义不变）：通过绿、拉回青、退回紫
    ok: ["#2e6b45", "#8fcb9f"],
    "pull-fg": ["#1d6a72", "#7fc4cb"],
    "reject-fg": ["#6a4b95", "#bca6e3"],
    // 缩小后条右上角关注小圆点的圈：卡片底色（经典是白）
    "zoom-dot-ring": "var(--surface)",

    // ---- 字体：Noto Serif SC 宋体（二狗自己提供，没下好时先用系统的宋体） ----
    "font-body": '"Noto Serif SC Variable", "Songti SC", "STSong", "SimSun", serif',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号阶：页面标题 22（设计稿的 h1），别的和经典一样 ----
    "fs-title": "22px",

    // ---- 圆角：小圆角。卡片 8、按钮 6、小签 4（radius-xs 和经典一样是 4，没写）；气泡（16，带一个 4 的角）和输入框（胶囊）写在 style.css ----
    "radius-s": "4px",
    "radius-m": "6px",
    "radius-l": "6px",
    "radius-xl": "8px",
    "radius-2xl": "8px",
    "radius-sheet": "12px",

    // ---- 阴影：纸面上几乎不用，浮起来的只压一层淡的暖灰 ----
    "shadow-menu": "0 6px 18px rgba(60, 42, 24, 0.14)",
    "shadow-float": "0 4px 16px rgba(60, 42, 24, 0.16)",
    "shadow-note": "0 2px 10px rgba(60, 42, 24, 0.1)",
    "shadow-slide": "-6px 0 18px rgba(60, 42, 24, 0.1)",

    // ---- 间距密度：页面留白 16、消息之间 18（设计稿），标题栏放得下 22 的标题和 44 高的按钮 ----
    "space-page": "16px",
    "space-msg": "18px",
    "bar-h": "64px",

    // ---- 边框：卡片、底板都是 1px 细边（卡片的 card-border 经典就是，没写） ----
    "panel-border": "1px solid var(--border)",

    // ---- 语音气泡的播放条（42 号票照设计稿 a-chat：播放键 28 的圆、和波形隔 10，波形竖条 3 像素、隔 3，左右内边距 12） ----
    "voice-pad": "12px",
    // 个人助理的框四周 1px 细边（style.css），左右合起来 2
    "voice-line": "2px",
    "voice-key": "28px",
    "voice-gap": "10px",
    "voice-bar": "3px",
    "voice-bar-gap": "3px",
  },
  fonts: [{ package: "@fontsource-variable/noto-serif-sc", css: "index.css" }],
};
