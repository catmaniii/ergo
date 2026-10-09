// 净白格栅（39 号票，设计稿 docs/design/styles/b-*.dc.html）：Noto Sans SC、黑白细线、一抹信号橙只给"要你"的事、
// 无阴影、细线分隔、密度高。主按钮和你发的消息是墨色块（浅色下黑底白字，深色下反过来）。
// token 在这里；只靠 token 做不到的（聊天里个人助理的话不套气泡、看板是一行一行的列表……）在 style.css。
import type { VisualStyle } from "../tokens.ts";

export const grid: VisualStyle = {
  id: "grid",
  name: "净白格栅",
  blurb: "黑白细线、无阴影，只有要你处理的事是橙色",
  tokens: {
    // ---- 颜色（设计稿的 --bg、--alt、--border、--text、--muted、--accent、--ink） ----
    bg: ["#ffffff", "#0b0b0c"],
    surface: ["#ffffff", "#0b0b0c"],
    text: ["#111111", "#f2f2f2"],
    muted: ["#5f6368", "#a3a3a3"],
    border: ["#e4e4e4", "#2a2a2d"],
    // 墨色：主按钮、选中的东西
    primary: ["#111111", "#f2f2f2"],
    "primary-text": ["#ffffff", "#111111"],
    "primary-fill": "var(--primary)",
    "danger-fill": "var(--high-fg)",
    "user-bubble": ["#111111", "#f2f2f2"],
    "user-text": ["#ffffff", "#111111"],
    fill: ["#f5f5f5", "#19191b"],
    "on-color": ["#ffffff", "#111111"],
    "nav-on": "var(--text)",
    badge: "var(--you)",
    // 信号橙：只给"要你"的事（等你、问你、未读）
    you: ["#c2410c", "#ff8a4c"],
    "you-bg": ["#fff4ed", "#2a160c"],
    // 个人助理的名字标签（43 号票要求名字带底色；设计稿里名字只是一行灰字）：按黑白灰推成浅灰底墨字，不用信号橙
    "name-bg": ["#e8e8e8", "#2a2a2d"],
    "name-fg": "var(--text)",
    // 内容类型色：收敛成低饱和，时间线全局层的色块还分得开
    "c-user": ["#111111", "#f2f2f2"],
    "c-thinking": ["#7c6f9b", "#a99bcb"],
    "c-reply": ["#9aa0a6", "#6b7075"],
    "c-plan": ["#475569", "#94a3b8"],
    "c-tool": ["#3f7d5a", "#6fbf8f"],
    "c-context": ["#9d4e72", "#d58baf"],
    // 标注：数据灰底，操作（命中关注类别）只是细线框里的灰字
    "data-bg": ["#f5f5f5", "#19191b"],
    "data-fg": ["#374151", "#d1d5db"],
    "op-bg": ["#ffffff", "#0b0b0c"],
    "op-fg": ["#5f6368", "#a3a3a3"],
    "high-bg": ["#fef3f2", "#2a1211"],
    "high-fg": ["#b42318", "#ff7a6e"],
    // 结果色（全 App 固定的含义不变）：通过绿、拉回青、退回紫
    ok: ["#067647", "#4cc38a"],
    "pull-fg": ["#0e7490", "#5cc8db"],
    "reject-fg": ["#6d28d9", "#b79cff"],

    // ---- 字体：Noto Sans SC（二狗自己提供，没下好时先用系统字体） ----
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 圆角：几乎是直角 ----
    "radius-xs": "2px",
    "radius-s": "3px",
    "radius-m": "3px",
    "radius-l": "4px",
    "radius-xl": "4px",
    "radius-2xl": "4px",
    "radius-sheet": "6px",
    "radius-pill": "3px",

    // ---- 阴影：没有，浮起来的东西只描一圈细线 ----
    "shadow-menu": "0 0 0 1px var(--text)",
    "shadow-float": "0 0 0 1px var(--border)",
    "shadow-note": "0 0 0 1px var(--border)",

    // ---- 间距密度：页面留白宽一点，列表本身靠细线分隔、排得密 ----
    "space-page": "16px",
    "space-msg": "20px",
    "bar-h": "52px",

    // ---- 边框：卡片、底板都是细线框 ----
    "card-border": "1px solid var(--border)",
    "panel-border": "1px solid var(--border)",
  },
  fonts: [{ package: "@fontsource-variable/noto-sans-sc", css: "index.css" }],
};
