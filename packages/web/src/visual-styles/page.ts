// 页面上和风格有关、样式表管不到的几样（39 号票）：手机浏览器地址栏的颜色（<meta name="theme-color">）、这套风格的字体样式表，
// 119 号票起还有这套风格可选的主色（根元素的 data-accent 挂哪个）。
// app/theme.ts 和 index.html 的内联脚本（构建时由 build/visual-styles-plugin.ts 把这张表填进去）用同一份。
import { effectiveTokens, resolveColor, type BaseVisualStyle, type VisualStyle } from "./tokens.ts";

export interface StylePageInfo {
  /** 地址栏的颜色：和标题栏的底色（--bar-bg，经典是 --surface）一样，浅色、深色各一个 */
  readonly bar: { readonly light: string; readonly dark: string };
  /** 这套风格的字体样式表（相对页面的地址）；没有自己的字体就不给 */
  readonly fonts?: string;
  /** 这套风格可选的主色 id（119 号票），第一个是默认的；不能换主色就不给 */
  readonly accents?: readonly string[];
}

/** 字体文件放在构建产物的哪个目录（守护进程按 /fonts/ 提供，见 docs/developer-guide.md 的"视觉风格"） */
export const FONTS_DIR = "fonts";

/** 一套风格的字体样式表：dist/fonts/<风格 id>.css，里面的 @font-face 按 unicode-range 切片，只下页面上用到的字 */
export function fontsHref(styleId: string): string {
  return `${FONTS_DIR}/${styleId}.css`;
}

/**
 * 设置里风格预览用的字体样式表：有自己字体的风格，只收覆盖预览场景里那几个字的 @font-face（preview.ts 的 PREVIEW_SCENE），
 * 全部风格合成一份。打开设置时挂上，只下这几个字所在的切片
 */
export const PREVIEW_FONTS_HREF = `${FONTS_DIR}/preview.css`;

/** 风格 id → 页面上要挂的东西 */
export function stylePageInfo(styles: readonly VisualStyle[], base: BaseVisualStyle): Record<string, StylePageInfo> {
  return Object.fromEntries(
    styles.map((style) => {
      const tokens = effectiveTokens(style, base);
      const bar = { light: resolveColor(tokens, "bar-bg", "light"), dark: resolveColor(tokens, "bar-bg", "dark") };
      const info: StylePageInfo = {
        bar,
        ...(style.fonts?.length ? { fonts: fontsHref(style.id) } : {}),
        ...(style.accents?.length ? { accents: style.accents.map((a) => a.id) } : {}),
      };
      return [style.id, info];
    }),
  );
}
