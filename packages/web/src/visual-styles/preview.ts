// 设置 · 外观 · 风格里每套风格的浅色、深色两张预览（39 号票）：用这套风格自己的 token 和规则现场画一小段固定的场景
// （自己发的一条、个人助理回的一条、一张带按钮的小卡片、一排导航图标），不是手画的示意图，风格改了预览跟着变。
// 加风格的票不用为预览做任何事：风格清单里有，设置里就有它的两张预览。
//
// 怎么画（pages/more/StylePreview.tsx）：每张预览是一个挂着 data-style、data-theme 的容器，场景放在它的 shadow root 里。
// - token：风格清单生成的样式表把每套风格的 token 也挂在 [data-style="<id>"] 上，容器上的 color-scheme 按 data-theme
//   定（pages.css 的 .style-preview），里面的 var(--...) 就是这套风格这种深浅的值；
// - 规则：页面的样式表（经典的样式加上每套风格的 style.css）原样复制一份给 shadow root 用，只把每套风格规则开头的
//   :root[data-style="<id>"] 换成 :host([data-style="<id>"])（previewCss）——于是这套风格的规则在它的预览里生效；
//   页面现在那套风格的规则（:root[...] 开头）进不了 shadow root，漏不到别的风格的预览里；
// - 继承：场景最外层 .preview-page 先 all: initial，页面（和它现在那套风格）挂在根元素、body 上的可继承属性
//   不会经宿主继承进预览；token 是自定义属性，不受 all 影响，照样从宿主继承；
// - 浏览器那一半（挂 shadow root、复制样式表、不让 Tab 到预览里、挂预览的字体）在 app/style-preview.ts、app/theme.ts；
// - 字体：场景里的字都挑在常用字那一片里，构建时只把覆盖这些字的 @font-face 收进 fonts/preview.css（见
//   build/visual-styles-plugin.ts 的 planFonts）。打开设置时挂上它，浏览器按 unicode-range 只下这几个字所在的切片。
// 这个文件是纯数据和纯函数：页面、构建插件、测试都引用它。
import type { Theme, VisualStyle } from "./tokens.ts";

/**
 * 预览场景里的全部文字。字都在 Noto Sans SC 最常用的那一片（fontsource 切片 118，45 KB）里：有自己中文字体的风格，
 * 打开设置只为预览多下一片。改这里的字要留意：每多一片就多下几十 KB（test/visual-styles/fonts.test.ts 查片数）。
 * 不放数字、标点、空格：它们在另一片（拉丁字母那片，75 KB）
 */
export const PREVIEW_SCENE = {
  /** 自己发的一条 */
  ask: "明天要开会",
  /** 个人助理回的一条 */
  reply: "到时我会提前说",
  /** 卡片：类型标签、标题、两个按钮 */
  cardTag: "要你定",
  cardTitle: "发报告",
  decline: "不用",
  confirm: "同意",
} as const;

/** 预览场景里出现的每一个字（构建时按它挑字体切片） */
export function previewChars(): string[] {
  return [...new Set(Object.values(PREVIEW_SCENE).join(""))];
}

/** 每套风格的两张预览：浅色、深色 */
export const PREVIEW_THEMES: readonly Theme[] = ["light", "dark"];

/** 设置里要画的预览：风格清单里的每一套，各浅色、深色一张（顺序和清单一样） */
export function stylePreviews(styles: readonly VisualStyle[]): { style: VisualStyle; themes: readonly Theme[] }[] {
  return styles.map((style) => ({ style, themes: PREVIEW_THEMES }));
}

/** 预览容器（shadow root 的宿主）的类名，场景最外层的类名（相当于页面的 body） */
export const PREVIEW_HOST_CLASS = "style-preview";
export const PREVIEW_PAGE_CLASS = "preview-page";

/**
 * 一套风格规则开头的 :root[data-style=...]，后面可以再跟几个属性（比如 [data-theme="dark"]）；
 * 再往后紧跟着的 body（" body"或者" > body"，"这套风格下的整页"）一起认出来
 */
const ROOT_SCOPE = /:root(\[data-style(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\](?:\[[^\]]*\])*)(\s*>\s*body(?![\w-])|\s+body(?![\w-]))?/g;
/** 选择器到这里就完了（后面是下一个选择器或者声明块）：规则挂在根元素本身上 */
const SELECTOR_END = /\s*[,{]/y;

/**
 * 页面的样式表 → 预览的 shadow root 里用的样式表：每套风格规则开头的 :root[data-style="<id>"] 换成
 * :host([data-style="<id>"])（特异度一样）。挂在根元素本身、body 上的（整页的字距、字体特性、行高……）换到场景最外层
 * .preview-page 上——它先 all: initial 把从宿主继承来的都复位（pages.css）：页面现在那套风格挂在根元素、body 上的
 * 可继承属性进不了别的风格的预览，这套风格自己的照样用在自己的预览里。别的原样：经典的样式本来就不挑风格，
 * :root、html、body 开头的在 shadow root 里什么也选不中。
 * 风格规则的写法（test/visual-styles/scope.test.ts 查）：每个选择器以 :root[data-style="<id>"] 开头，根元素上只能再加属性，
 * 往下接的只能是空格（后代）或者 "> body"
 */
export function previewCss(css: string): string {
  return css.replace(ROOT_SCOPE, (match: string, attrs: string, body: string | undefined, offset: number, whole: string) => {
    SELECTOR_END.lastIndex = offset + match.length;
    const page = body !== undefined || SELECTOR_END.test(whole);
    return `:host(${attrs})${page ? ` .${PREVIEW_PAGE_CLASS}` : ""}`;
  });
}
