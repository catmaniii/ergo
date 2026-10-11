// 像素小屋（49 号票，设计稿 docs/design/styles/h-*.dc.html）：卡片、气泡、按钮、标题栏、输入栏、导航都是"像素框"——四周 3px 的
// 墨色线、四个角各缺一格（设计稿的 .px：上下左右四道不模糊的投影，角上空着，就是像素画里的阶梯边）；页面是草地绿底加 16px 的格子，
// 强调色是草地绿（主按钮、选中的导航和分段、进度格），你发的消息是粉色，"要你"的事也是粉色（设计稿"等你验收"的签），
// 出错和未读是暖红。数字（时间、时长、件数、token、进度）用 Press Start 2P（font-num），它没有中文字形，中文照常落到正文的 Noto Sans SC。
// 颜色取设计稿样式里 .root（浅色）、.root.dark（深色）两套变量（--bg、--surface、--ink、--text、--muted、--accent、--accent-ink、
// --accent-soft、--pink、--pink-ink、--warm、--warn-ink、--code）；标着"设计稿是"的几处为了对比度调过（字压在格子线上按格子线算）。
// token 在这里；只靠 token 做不到的（像素框、格子底、HP 格进度、像素图标、看板卡的排法……）在 style.css。
// 像素框的墨色（设计稿的 --ink）和像素框本身只写在 style.css 一处（--pixel-ink、--pixel-edge），下面的阴影 token 引用它们
// （页面上 token 和它们都挂在根元素上，引用得到）。设置里的预览例外：预览的 token 挂在宿主上，style.css 根元素上的东西换到了
// 场景最外层，宿主上算不出这四个阴影，预览里它们是空的——预览场景里没有菜单、提示条、滑入的详情页，用不到。
// 别的 token 不要这样引用 style.css 里的自定义属性。
import type { VisualStyle } from "../tokens.ts";

export const pixel: VisualStyle = {
  id: "pixel",
  name: "像素小屋",
  blurb: "像素阶梯边框、草地绿、HP 格进度和 8-bit 数字",
  tokens: {
    // ---- 颜色 ----
    bg: ["#e9f5e1", "#1b2430"],
    surface: ["#ffffff", "#273242"],
    // 标题栏是浮在格子底上的一个像素框（style.css 里铺卡片色），框外面、手机浏览器地址栏下面露出来的是页面底色，地址栏跟着它
    "bar-bg": "var(--bg)",
    text: ["#22302a", "#e6eef5"],
    muted: ["#53665a", "#a7b5c4"],
    // 细分隔线（表格、分栏线这类）：像素框本身是墨色（style.css），这里只是淡的绿灰线
    border: ["#c5d6bd", "#3d4b5e"],
    // 强调色（链接、选中的字、细条）：设计稿的 --accent。浅色的 #2f7a4f 压在格子线（#deead6）上只有 4.19:1，加深到 #2a6f47（4.86:1）
    primary: ["#2a6f47", "#7dd3a0"],
    // 主按钮、选中的导航和分段这类实色块：设计稿的 --accent 和 --accent-ink（白字 5.23:1；深色是浅绿底、深色字 9.52:1）
    "primary-fill": ["#2f7a4f", "#7dd3a0"],
    "primary-text": ["#ffffff", "#0f1f17"],
    // 危险按钮：设计稿的暖红 --warm，字是 on-color（浅色白字 5.16:1；深色是设计稿的 --warn-ink 深字，7.69:1）
    "danger-fill": ["#c9372c", "#ff8a7a"],
    // 你发的消息：设计稿你的语音是粉色、深莓色字（--pink、--pink-ink，浅深一样，8.15:1）
    "user-bubble": "#f2a7c1",
    "user-text": "#3a1a28",
    // 输入框、代码块、小签的浅底（设计稿的 --code；深色就是页面底色）
    fill: ["#eef6ea", "#1b2430"],
    // 压在实色块上的字：深色下的实色块（暖红、通过绿、计划橙……）都是亮的，压深色字（设计稿的 --warn-ink）
    "on-color": ["#ffffff", "#2a1210"],
    // 未读的小点、待办的提示：设计稿的暖红 --warm（只当底色用，不当字）
    badge: ["#c9372c", "#ff8a7a"],
    scrim: "rgba(27, 36, 48, 0.5)",
    // 你说的（缩小后要点层的色块、详情里"你"的小标）：和"跟你有关的"同一个莓红（浅色白字 6.39:1）；深色是设计稿的粉，压深色字
    "c-user": ["#a8325f", "#f2a7c1"],
    // 数据小签（工具名、在做的事这类）：设计稿的 --accent-soft 浅绿底，字是深一档的绿（设计稿 a:hover 的 #1f5a38，6.41:1；深色 7.32:1）
    "data-bg": ["#cfebd8", "#2f4a3d"],
    "data-fg": ["#1f5a38", "#bfeacd"],
    // 出错、拦下：暖红。设计稿浅色 #c9372c 压在格子线上只有 4.14:1、淡红底上 4.27:1，压暗到 #b8302a（4.82 / 4.97:1）；深色是设计稿的 #ff8a7a
    "high-bg": ["#fde4e1", "#4a2424"],
    "high-fg": ["#b8302a", "#ff8a7a"],
    // 命中关注类别、排队这类"操作"的字：经典的橙棕 #ab5b00 压在格子线上只有 3.98:1，浅色压深到 #9a5200（格子线上 4.70、淡橙底上 5.40:1）
    "op-fg": ["#9a5200", "#f5b45a"],
    // 通过绿：和强调色分开一点、偏黄一点；浅色压在格子线上 4.85:1
    ok: ["#1a713d", "#86d993"],
    // 拉回青、退回紫：详情栏落在格子底上，经典的浅色值压在格子线上不够，压深（格子线上 4.94 / 4.96:1）
    "pull-fg": ["#0b6a84", "#4fc6d6"],
    "reject-fg": ["#7a40c8", "#b691ff"],
    // 跟你有关的（等你、问你、要你批准）：粉色一族（设计稿"等你验收""中断"的签是粉底，你发的消息也是粉）。粉色当不了字（白底 1.9:1），
    // 字用深一档的莓红（白底 6.39、淡粉底 5.26、格子线上 5.13:1）；深色就是设计稿的粉（卡片底上 6.83:1）
    you: ["#a8325f", "#f2a7c1"],
    "you-bg": ["#fbe3ec", "#4a2c3c"],
    // 个人助理的名字标签：设计稿的 .name 是浅绿底、正文色字（--accent-soft）。浅色的 #cfebd8 和页面底只差 1.13 倍（名字标签要 1.15），
    // 压深一点到 #c7e7d1（1.18 倍，字 10.3:1）；深色是设计稿的 #2f4a3d（字 8.26:1）。像素框在 style.css
    "name-bg": ["#c7e7d1", "#2f4a3d"],
    "name-fg": ["#22302a", "#e6eef5"],
    // 缩小后条右上角关注小圆点的圈：卡片底色（经典是白）
    "zoom-dot-ring": "var(--surface)",

    // ---- 字体：正文 Noto Sans SC，数字 Press Start 2P（都由二狗自己提供，没下好时先用系统字体）；标题照经典跟正文（设计稿的标题是粗体正文字） ----
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-num": '"Press Start 2P", var(--font-body)',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号：页面标题 18（设计稿的 h1） ----
    "fs-title": "18px",

    // ---- 圆角：一律直角（像素框的角是阶梯，不是圆角） ----
    "radius-xs": "0px",
    "radius-s": "0px",
    "radius-m": "0px",
    "radius-l": "0px",
    "radius-xl": "0px",
    "radius-2xl": "0px",
    "radius-sheet": "0px",
    "radius-pill": "0px",

    // ---- 阴影：菜单、浮起的提示、录音时的提示条都是 3px 的像素框（style.css 的 --pixel-edge）；窄屏滑入的详情页左边一道 3px 的墨线 ----
    "shadow-menu": "var(--pixel-edge)",
    "shadow-float": "var(--pixel-edge)",
    "shadow-note": "var(--pixel-edge)",
    "shadow-slide": "-3px 0 0 0 var(--pixel-ink)",

    // ---- 间距：页面左右 18、消息之间 20（设计稿的 main），标题栏是 64 高的框（放得下 40 高的按钮和它的像素框） ----
    "space-page": "18px",
    "space-msg": "20px",
    "bar-h": "64px",

    // ---- 边框：有框的卡片不用边框，像素框是 style.css 里的投影（不占地方） ----
    "card-border": "none",

    // ---- 语音气泡的播放条（设计稿 h-chat：播放键是 28 的方块加 2px 的像素框共 32、和波形隔 10，波形竖条 4 宽，左右内边距 12；
    // 框的像素线是投影、不占地方，没有竖线；竖条之间隔 2 和经典一样，没写） ----
    "voice-pad": "12px",
    "voice-line": "0px",
    "voice-key": "32px",
    "voice-gap": "10px",
    "voice-bar": "4px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    { package: "@fontsource/press-start-2p", css: "index.css" },
  ],
};
