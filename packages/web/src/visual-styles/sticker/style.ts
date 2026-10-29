// 贴纸便当（48 号票，设计稿 docs/design/styles/g-*.dc.html）：卡片、气泡、按钮都是"贴纸"——2px 墨色描边加不模糊的硬投影；
// 柠檬黄（主按钮、你发的消息、选中的东西、名字标签）、薄荷（个人助理的语音、在做的事、按住说话）、蜜桃（附件钮、命中关注类别的小签）；
// "要你"的事和未读是暖红。站酷庆科黄油体只用在标题上（font-title），正文是 Noto Sans SC。
// 墨色就是正文色（设计稿的 --ink 和 --text 浅深都一样）：描边、硬投影都用 var(--text)，深色下是浅色的线和投影。
// 颜色取设计稿 renderVals() 的浅色、深色两套（--bg、--surface、--ink、--muted、--accent、--accent-ink、--mint、--peach、--warm、
// --warm-ink、--code）；强调色（链接、可以点的小字）照设计稿就是墨色加下划线，选中的东西靠柠檬黄的底；标着"设计稿是"的几处为了对比度调过。
// token 在这里；只靠 token 做不到的（贴纸描边和硬投影、选中的导航是黄色贴纸、状态是带描边的药丸、名字标签歪着贴……）在 style.css。
import { t } from "@ergo/protocol";
import type { VisualStyle } from "../tokens.ts";

export const sticker: VisualStyle = {
  id: "sticker",
  // 名字和一句话按当前语言（169 号票，取的时候现查）
  get name() {
    return t("styles.sticker.name");
  },
  get blurb() {
    return t("styles.sticker.blurb");
  },
  tokens: {
    // ---- 颜色 ----
    bg: ["#fff7e8", "#1f1a2e"],
    surface: ["#ffffff", "#2b2540"],
    // 标题栏不是一条白板，直接落在奶油色的底上（设计稿），手机浏览器地址栏跟着它
    "bar-bg": "var(--bg)",
    // 正文色，也是贴纸的描边和硬投影的颜色（设计稿的 --ink）
    text: ["#2a2238", "#f5eeff"],
    muted: ["#6e6478", "#b9b0cc"],
    // 细分隔线（表格、分栏线这类）：贴纸本身的描边是墨色（card-border / panel-border、style.css），这里只是淡的暖色线
    border: ["#e7dac2", "#4a4163"],
    // 强调色（链接、可以点的小字、细条）：照设计稿（a { color: 墨色 }、"全部标已读"）就是墨色，下划线在 style.css（用户定）；
    // 选中的东西不靠它，靠柠檬黄的底（primary-fill）。设计稿的柠檬黄压在白底上只有 1.7:1，当不了字
    primary: "var(--text)",
    // 主按钮、你发的消息、选中的导航这类实色块：柠檬黄，上面是墨色字（设计稿的 --accent、--accent-ink，浅色 8.89:1、深色 9.65:1）
    "primary-fill": ["#ffb950", "#ffc46b"],
    "primary-text": "#2a2238",
    // 危险按钮：设计稿的暖红压暗一点（白字 5.62:1）
    "danger-fill": "#bf3427",
    "user-bubble": "var(--primary-fill)",
    "user-text": "var(--primary-text)",
    // 输入框、代码块、小签的浅底（设计稿的 --code）
    fill: ["#fff1d6", "#1f1a2e"],
    // 未读：暖红
    badge: "var(--you)",
    scrim: "rgba(31, 26, 46, 0.5)",
    // 跟你有关的（等你、问你、要你批准）：暖红。设计稿浅色是 #d13b2b，压在淡红底上只有 3.9:1，压暗到 #bf3427（4.62:1）；
    // 深色是设计稿的 #ff8c7a。看板上"等你"是暖红实心药丸（style.css，字是卡片底色：浅色 5.62:1、深色 6.44:1）
    you: ["#bf3427", "#ff8c7a"],
    "you-bg": ["#ffe3da", "#4d2a2a"],
    // 个人助理的名字标签：柠檬黄贴纸、墨色字（设计稿的 .name；描边、硬投影、歪着贴在 style.css）。浅色 8.89:1、深色 9.65:1
    "name-bg": ["#ffb950", "#ffc46b"],
    "name-fg": "#2a2238",
    // 内容类型色：你说的另配，别的沿用经典。
    // 你说的：缩小后要点层的色块（上面是白字）和详情里"你"的小标都用它。浅色是墨色（白字 15:1）；深色的墨色是浅色，压不住白字，
    // 换成柠檬黄压暗的琥珀 #b87a14（白字 3.6:1、详情小标 3.3:1；经典深色的 #6d92ff 白字也只有 2.9:1，这两处不在对比度表里）
    "c-user": ["#2a2238", "#b87a14"],
    // 薄荷（设计稿的 --mint）：数据小签，也是这套风格所有薄荷底的地方（在做的状态、个人助理的语音、按住说话、工具名小签）；
    // 小签上的字是深绿（6.12:1 / 7.34:1，对比度测试查这一对），语音、按住说话照设计稿是墨色字（浅色 12.24:1、深色 8.64:1）
    "data-bg": ["#cdefd9", "#2b4a3c"],
    "data-fg": ["#17603a", "#b4ecc8"],
    // 蜜桃（设计稿的 --peach）：命中关注类别的小签（设计稿审批卡上"删除或覆盖"），字是深一档的棕（5.80:1 / 7.64:1）；附件钮也是蜜桃底
    "op-bg": ["#ffd9c7", "#4a2f2a"],
    "op-fg": ["#8a3d12", "#ffbfa3"],
    // 出错、拦下、紧急度"有时限"：偏紫的覆盆子红，和"要你"的暖红、"卡住任务"的棕分得开（设计稿没画出错）
    "high-bg": ["#fde2ea", "#4a1d2e"],
    "high-fg": ["#b0174f", "#ff8fb5"],
    // 结果色（全 App 固定的含义不变）：通过绿；拉回青、退回紫沿用经典
    ok: ["#1b7a43", "#7fd9a0"],
    // 缩小后条右上角关注小圆点的圈：卡片底色（经典是白）
    "zoom-dot-ring": "var(--surface)",

    // ---- 字体：正文 Noto Sans SC，标题站酷庆科黄油体（都由二狗自己提供，没下好时先用系统字体） ----
    "font-body": '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
    "font-title": '"ZCOOL QingKe HuangYou", var(--font-body)',
    "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',

    // ---- 字号：页面标题 28（设计稿的 h1；黄油体只有一种字重，靠字号撑） ----
    "fs-title": "28px",

    // ---- 圆角：按钮、导航项 12，输入框和代码块 10，卡片 14（radius-2xl 和经典一样，没写），底部弹层 20 ----
    "radius-m": "10px",
    "radius-l": "12px",
    "radius-xl": "14px",
    "radius-sheet": "20px",

    // ---- 阴影：不模糊的墨色硬投影（设计稿的 .stk 是 3px 3px 0 var(--ink)），浅深一样的写法，墨色跟着正文色变 ----
    "shadow-menu": "4px 4px 0 var(--text)",
    "shadow-float": "3px 3px 0 var(--text)",
    // 贴纸的投影：卡片、气泡、看板卡、按钮……都用它（style.css）
    "shadow-note": "3px 3px 0 var(--text)",
    "shadow-slide": "-2px 0 0 var(--text)",
    // 宽屏阶段栏的 × 这类浮在栏边上的小圆钮（88 号票）：小一号的硬投影
    "shadow-btn": "2px 2px 0 var(--text)",

    // ---- 间距：页面左右 16，消息之间 18（设计稿），标题栏放得下 28 的标题和 44 高的按钮 ----
    "space-page": "16px",
    "space-msg": "18px",
    "bar-h": "64px",

    // ---- 边框：有框的卡片、底板都是 2px 墨色描边（贴纸） ----
    "card-border": "2px solid var(--text)",
    "panel-border": "2px solid var(--text)",

    // ---- 语音气泡的播放条（设计稿 g-chat：播放键是 32 的圆、和波形隔 10，波形竖条 4 像素、隔 3，左右内边距 12） ----
    "voice-pad": "12px",
    // 你的、个人助理的框都是四周 2px 墨色描边（style.css），左右合起来 4
    "voice-line": "4px",
    "voice-key": "32px",
    "voice-gap": "10px",
    "voice-bar": "4px",
    "voice-bar-gap": "3px",
  },
  fonts: [
    { package: "@fontsource-variable/noto-sans-sc", css: "index.css" },
    { package: "@fontsource/zcool-qingke-huangyou", css: "index.css" },
  ],
};
