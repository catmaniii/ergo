// 复古杂志（51 号票，设计稿 docs/design/styles/j-*.dc.html）：粗宋大标题、粗细双线、编号分节、芥末黄高亮。
// 正文是 Noto Serif SC 宋体，按钮、导航、时间、说明小字这些是 Noto Sans SC 黑体（设计稿的 .sans / .lbl）；全部直角、不用阴影，
// 靠墨色的线分块：标题栏下面一道 3px 粗线，导航、卡片、看板分组的头上是"细线 + 粗线"的双线，输入栏、分隔是 1px 细线。
// 颜色取自设计稿样式里 .root（浅色）、.root.dark（深色）两套变量 --bg、--surface、--text、--muted、--accent、--accent-ink、
// --accent-text、--rule、--rule-on、--warm、--warn-ink、--code（renderVals() 只挑强调色：默认芥末黄 #D4A72C，深色下换成 #E2B33A）；
// 设计稿的线色 --rule 就是正文色，这里线（border）是 var(--text)。
// 对比度不够、或者设计稿没画到的几处按同一套推（标着"设计稿是""设计稿没有"）。
// token 在这里；只靠 token 做不到的（双线、粗宋标题、黑体的小字、芥末黄高亮、线条图标、看板分组编号……）在 style.css。
import type { VisualStyle } from "../tokens.ts";

export const magazine: VisualStyle = {
  id: "magazine",
  name: "复古杂志",
  blurb: "粗宋大标题、粗细双线、编号分节，芥末黄高亮",
  tokens: {
    // ---- 颜色（设计稿的 --bg、--surface、--text、--muted、--code） ----
    bg: ["#f3efe4", "#161411"],
    surface: ["#fbf8f1", "#1f1c18"],
    // 标题栏落在页面底色上（设计稿的头没有自己的底色，只有下面一道粗线），手机地址栏跟着它
    "bar-bg": "var(--bg)",
    text: ["#171511", "#f1ece0"],
    muted: ["#5e584c", "#afa796"],
    // 线：设计稿所有的线（--rule）都是墨色，深色下是米白——就是正文色。
    // 经典里有几处拿 --border 当底色（次要按钮、件数小签、进度条的轨道……），style.css 里逐个换成纸色底或者线框
    border: "var(--text)",
    // 强调色（链接、选中的字、细条）：设计稿 a 的颜色、分组编号、"审批""提醒"这类种类字是 --accent-text（浅色深芥末、深色芥末黄）
    primary: ["#7a5f0e", "#e2b33a"],
    // 主按钮（发起任务、批准这一次）：设计稿是墨色实底、页面底色的字（--rule / --rule-on）
    "primary-fill": "var(--text)",
    "primary-text": "var(--bg)",
    // 危险按钮：设计稿的 --warm。浅色深红实底白字 6.54:1；深色亮珊瑚实底墨色字 8.01:1（设计稿的 --warn-ink 也是深色字）
    "danger-fill": ["#b3261e", "#ff8b7a"],
    // 你发的消息：设计稿你的语音是芥末黄实底、墨色字（--accent / --accent-ink），四周 1px 墨线（style.css）；浅色 8.13:1、深色 9.33:1
    "user-bubble": ["#d4a72c", "#e2b33a"],
    "user-text": "#171511",
    // 设计稿的 --code：代码、输入框、小签的纸色底
    fill: ["#ece6d6", "#26221c"],
    // 实色块上的字：浅色白字；深色下实色块都是亮色（珊瑚红、计划橙、通过绿），字用墨色（同设计稿的 --warn-ink、--accent-ink）
    "on-color": ["#ffffff", "#171511"],
    // 主导航里当前那一项：正文色（设计稿 .tab.on 是正文色、下面一道芥末黄短线）
    "nav-on": "var(--text)",
    // 未读、待办的角标：设计稿的 --warm
    badge: ["#b3261e", "#ff8b7a"],
    scrim: "rgba(23, 21, 17, 0.5)",
    // 内容类型色：你说的是芥末黄；计划是赭橙（和芥末黄分得开），想法灰紫、回复暖灰、工具墨绿、上下文豆沙（设计稿没有）。
    // 浅色压深到直接当字用（详情里"问你"、步骤的图标这类）在卡片、页面、纸色底上都 ≥ 4.5:1（最差 4.87）；
    // 缩小后要点层的色块、流程计划的步骤号上压着实色块上的字（on-color：浅色白字 6.07–7.34、深色墨色字 5.99–9.33）。
    // 同色淡底上的小签（tag-*、vv-unknown、rb-s-deferred……）的字换成混正文色的那一档，在 style.css
    "c-user": ["#76600f", "#e2b33a"],
    "c-thinking": ["#625694", "#a99bd6"],
    "c-reply": ["#686253", "#9b9384"],
    "c-plan": ["#86501a", "#d99a4e"],
    "c-tool": ["#3d6848", "#79ad84"],
    "c-context": ["#944a61", "#d08aa0"],
    // 标注：数据是墨蓝灰；操作（命中关注类别、计划外……）是赭石（审批卡上命中的关注类别按设计稿是中性的线框签，在 style.css 里单独改）
    "data-bg": ["#e3e7e6", "#262b2c"],
    "data-fg": ["#2f4a5e", "#a9bccd"],
    "op-bg": ["#f5e2d3", "#3b2a1e"],
    "op-fg": ["#8a3f12", "#eaa77c"],
    // 出错、拦下：设计稿的 --warm
    "high-bg": ["#f7e1dc", "#3d211d"],
    "high-fg": ["#b3261e", "#ff8b7a"],
    // 结果色（全 App 固定的含义不变）：通过绿、拉回青、退回紫。通过绿浅色压深到同色 20% 的淡底上（RuleBook 选中的修法这类小签）也有 4.60:1
    ok: ["#275e35", "#8cc79a"],
    "pull-fg": ["#1d6a72", "#7fc4cb"],
    "reject-fg": ["#6a4b95", "#bca6e3"],
    // 跟你有关的（等你、问你）：芥末黄。字是 --accent-text，底是淡芥末（设计稿"等你验收"这类是芥末黄实底的高亮，看板上在 style.css）
    you: ["#7a5f0e", "#e2b33a"],
    "you-bg": ["#f1e4bd", "#3a3019"],
    // 个人助理的名字标签（43 号票；设计稿的 .name：芥末黄底、墨色字、1px 墨线、粗宋）：浅色 8.13:1、深色 9.33:1；
    // 和页面底色、卡片底色的亮度差浅色 1.95 / 2.11、深色 9.40 / 8.68
    "name-bg": ["#d4a72c", "#e2b33a"],
    "name-fg": "#171511",
    // 缩小后条右上角关注小圆点的圈：卡片底色（经典是白）
    "zoom-dot-ring": "var(--surface)",

    // ---- 字体：正文、标题 Noto Serif SC 宋体（标题 900 的粗宋在 style.css）；数字和设计稿里黑体的小字用 Noto Sans SC ----
    "font-body": '"Noto Serif SC Variable", "Songti SC", "STSong", "SimSun", serif',
    "font-num": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号阶：页面标题 30（设计稿的 h1），别的和经典一样（正文 15 是设计稿根元素的字号；话、看板和待我处理的标题 16 写在 style.css） ----
    "fs-title": "30px",

    // ---- 圆角：全部直角 ----
    "radius-xs": "0px",
    "radius-s": "0px",
    "radius-m": "0px",
    "radius-l": "0px",
    "radius-xl": "0px",
    "radius-2xl": "0px",
    "radius-sheet": "0px",
    "radius-pill": "0px",

    // ---- 阴影：设计稿不用阴影；浮起来的东西（菜单、短提示、录音面板）往右下错开一块不模糊的淡影（它们自己有墨线框），
    //      录音时的提示条（色块、没有框）一圈墨线，窄屏滑入的详情页左边是一道线 ----
    "shadow-menu": "4px 4px 0 light-dark(rgba(23, 21, 17, 0.18), rgba(0, 0, 0, 0.5))",
    "shadow-float": "4px 4px 0 light-dark(rgba(23, 21, 17, 0.18), rgba(0, 0, 0, 0.5))",
    "shadow-note": "0 0 0 1px var(--border)",
    "shadow-slide": "-1px 0 0 var(--border)",
    // 宽屏阶段栏的 × 这类浮在栏边上的小圆钮（88 号票）：小一号的硬投影
    "shadow-btn": "2px 2px 0 light-dark(rgba(23, 21, 17, 0.18), rgba(0, 0, 0, 0.5))",

    // ---- 间距密度：页面左右 20、消息之间 18（设计稿），标题栏放得下 30 的粗宋标题和 44 高的按钮 ----
    "space-page": "20px",
    "space-msg": "18px",
    "bar-h": "68px",

    // ---- 边框：有框的卡片和底板都是 1px 墨线（卡片的 card-border 经典就是，没写）；看板、待我处理是一行一行的，只留每行下面那道线（style.css） ----
    "panel-border": "1px solid var(--border)",

    // ---- 语音气泡的播放条（照设计稿 j-chat：左右内边距 12，播放键 16（和经典一样，没写）、和波形隔 10，竖条 2（同经典）隔 3） ----
    "voice-pad": "12px",
    // 你的、个人助理的框都是四周 1px 的墨线（style.css），左右合起来 2
    "voice-line": "2px",
    "voice-gap": "10px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-serif-sc", css: "index.css" },
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
  ],
};
