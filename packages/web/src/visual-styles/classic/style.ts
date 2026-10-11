// 经典（39 号票）：39 号票之前的样子原样 token 化，浅色、深色都和原来一样——除了 7 处对比度不够的颜色，沿原来的色相
// 稍微加深到 4.5:1（用户 2026-10-09 定；下面标着"原来是"的那几个）。别的风格没写的 token 都沿用这里的。
// 颜色原来写在 styles/base.css 和 look.css 开头（34 号票起是 light-dark(浅色, 深色)），别的取值原来散在各份样式里。
import { DEFAULT_VISUAL_STYLE } from "../../state/visual-style.ts";
import type { BaseVisualStyle } from "../tokens.ts";

export const classic: BaseVisualStyle = {
  // "classic"：默认的风格只在状态层写一次（index.html 内联脚本里退回的那个，test/app/theme.test.ts 和它比对）
  id: DEFAULT_VISUAL_STYLE,
  name: "经典",
  blurb: "蓝色强调、圆角卡片，二狗一直以来的样子",
  tokens: {
    // ---- 颜色 ----
    bg: ["#f5f6f8", "#121316"],
    // 卡片的底色；经典的标题栏也是它（见 bar-bg）
    surface: ["#ffffff", "#1d1f24"],
    // 标题栏（.topbar、详情页的 .detail-bar）的底色，也是手机浏览器地址栏的颜色（42 号票加；app/theme.ts、index.html 的内联脚本
    // 都按它取，visual-styles/page.ts 的 stylePageInfo）。经典就是卡片的底色，和加这个 token 之前一样
    "bar-bg": "var(--surface)",
    text: ["#1d2129", "#e8eaed"],
    // 说明文字（look.css 原来把它从 #86909c 加深到 #6b7380；浅色原来是 #6b7380，页面底色上 4.42:1 → 4.55:1）
    muted: ["#69717e", "#9aa1ab"],
    border: ["#e5e6eb", "#2c2f36"],
    primary: ["#3b6cf6", "#5b86ff"],
    "primary-text": "#ffffff",
    // 主按钮这类实色块的底：浅色就是 primary；深色原来也是 primary #5b86ff，白字 3.33:1 → 压暗到 4.56:1
    // （primary 本身在深色下还要当链接色压在深色底上，得亮，所以分成两个）
    "primary-fill": ["#3b6cf6", "#3369ff"],
    // 危险按钮的底：原来是 high-fg（深色下 #ff7b76，白字 2.52:1）；现在浅深都用浅色那个红 #d0312d（白字 5.05:1）
    "danger-fill": "#d0312d",
    "user-bubble": ["#3b6cf6", "#3a5bd0"],
    "user-text": "#ffffff",
    // 卡片、标题栏上的浅底：输入框、代码片段、小签、引用条（经典里就是页面底色）
    fill: "var(--bg)",
    // 压在实色块上的字（危险按钮、✓、计划的标签）
    "on-color": "#ffffff",
    // 主导航里当前那一项
    "nav-on": "var(--primary)",
    // 未读的小红点
    badge: "var(--high-fg)",
    // 弹层下面压暗的那一层
    scrim: "rgba(0, 0, 0, 0.45)",
    // 内容类型色
    "c-user": ["#3b6cf6", "#6d92ff"],
    "c-thinking": "#a07cf2",
    "c-reply": ["#8b93a3", "#9aa3b2"],
    "c-plan": "#f0a93b",
    "c-tool": "#4cb782",
    "c-context": "#e46aa6",
    // 标注
    "data-bg": ["#eef3ff", "#1c2744"],
    "data-fg": ["#3056c7", "#8fb0ff"],
    "op-bg": ["#fff4e5", "#3a2a12"],
    // 浅色原来是 #b86200：浅橙底上 4.04:1 → 4.57:1
    "op-fg": ["#ab5b00", "#f5b45a"],
    "high-bg": ["#ffeceb", "#401d1d"],
    // 浅色原来是 #d0312d：浅红底上 4.44:1 → 4.58:1
    "high-fg": ["#cc302c", "#ff7b76"],
    // 结果色：通过绿、拉回青、退回紫（拦下用 high-fg）
    // 浅色原来是 #1f9d55：白底上 3.49:1 → 4.56:1
    ok: ["#1b8749", "#4cc27f"],
    "pull-fg": ["#0f8a9d", "#4fc6d6"],
    "reject-fg": ["#8a4fd6", "#b691ff"],
    // 跟你有关的：和你自己的消息同一个蓝（look.css 的规矩 1）
    // 浅色原来是 #3b6cf6（和你的消息同一个蓝）：浅蓝底上 3.98:1 → 4.58:1，稍深一点
    you: ["#2a5ff5", "#6d92ff"],
    "you-bg": ["#ebf1ff", "#1c2744"],
    // 个人助理的名字（43 号票）：名字随便起，容易和普通文字混在一起，显示成带底色的小标签。字和底浅色 7.8:1、深色 7.6:1
    "name-bg": ["#fbe3a1", "#4a3c14"],
    "name-fg": ["#5c3d00", "#f7d57e"],

    // ---- 字体（系统字体，不下载） ----
    "font-body": '"HarmonyOS Sans SC", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    // 标题（页面标题、分组标题、卡片的类型标签……）、数字（时间、时长、计数、统计数字、日历上的日子）：经典都是正文字体
    "font-title": "var(--font-body)",
    "font-num": "var(--font-body)",
    "font-mono": 'ui-monospace, "Cascadia Mono", Consolas, monospace',

    // ---- 字号阶 ----
    "fs-3xs": "8px",
    "fs-2xs": "10px",
    "fs-xs": "11px",
    "fs-s": "12px",
    "fs-m": "13px",
    "fs-l": "14px",
    "fs-body": "15px",
    "fs-title": "17px",

    // ---- 圆角 ----
    "radius-xs": "4px",
    "radius-s": "6px",
    "radius-m": "8px",
    "radius-l": "10px",
    "radius-xl": "12px",
    "radius-2xl": "14px",
    "radius-sheet": "18px",
    "radius-pill": "999px",

    // ---- 阴影 ----
    // 弹出的菜单、录音面板
    "shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.16)",
    // 浮在页面上的提示：底部的短提示、到点的提醒
    "shadow-float": "0 6px 20px rgba(0, 0, 0, 0.2)",
    // 录音时输入框上方的提示条
    "shadow-note": "0 4px 14px rgba(0, 0, 0, 0.12)",
    // 窄屏整页滑入的详情页左边缘（56 号票，AgentSense 的 .sp-detail）
    "shadow-slide": "-8px 0 24px rgba(0, 0, 0, 0.12)",
    // 浮在栏边上的小圆钮：宽屏阶段栏的收起按钮（88 号票，AgentSense 的 .md-side-close）
    "shadow-btn": "0 1px 4px rgba(0, 0, 0, 0.12)",

    // ---- 间距密度 ----
    "space-page": "12px",
    "space-msg": "10px",
    "bar-h": "42px",

    // ---- 边框 ----
    // 有框的卡片：聊天里的卡片（.xcard）、看板上的卡片（.bcard）
    "card-border": "1px solid var(--border)",
    // 底板（.card：设置项、项目页的头部这类）：经典靠底色和页面区分，没有边框
    "panel-border": "none",

    // ---- 会话缩放（54 号票，照 AgentSense 的取值） ----
    // 要点层色块上的字
    "zoom-key-fg": "var(--on-color)",
    // 只看的工具：工具色调浅（动手是工具色本身，删改再加一圈 zoom-modify-ring）
    "zoom-tool-look": "color-mix(in srgb, var(--c-tool) 38%, var(--surface))",
    "zoom-modify-ring": "var(--high-fg)",
    "zoom-error-ring": "var(--high-fg)",
    // 点缩小的条放大回去、在对话中定位时闪的那一下
    "zoom-flash": "color-mix(in srgb, var(--c-plan) 25%, transparent)",
    // 内容多的条在要点层上那张小标题卡的阴影色（几何按缩放比例算，写在 zoom.css）
    "zoom-cap-shadow": "rgba(0, 0, 0, 0.18)",
    // 条右上角关注小圆点的白圈（AgentSense 写死的 #fff）
    "zoom-dot-ring": "#fff",
    // 缩小后的底色带（55 号票）：和计划色块同一个黄，调得很浅；相邻的另一块深一档（AgentSense layout.css 的 .zh-band）
    "zoom-band": "color-mix(in srgb, var(--c-plan) 7%, transparent)",
    "zoom-band-alt": "color-mix(in srgb, var(--c-plan) 21%, transparent)",
    // 底色带左缘竖排的"任务 N · 是什么事"
    "zoom-band-label": "color-mix(in srgb, var(--c-plan) 55%, var(--text))",

    // ---- 语音气泡的播放条（42 号票从 styles/voice.css、state/voice.ts 里写死的数挪过来，取值不变；只能写像素） ----
    // 框的左右内边距（各一份）
    "voice-pad": "13px",
    // agent 一侧框左边的竖线（回复色）
    "voice-line": "3px",
    // 播放键（▶ / ❚❚）的宽
    "voice-key": "16px",
    // 播放键和波形、波形和时长之间的间隔
    "voice-gap": "8px",
    // 波形一格竖条的宽、竖条之间的间隔
    "voice-bar": "2px",
    "voice-bar-gap": "2px",
  },
};
