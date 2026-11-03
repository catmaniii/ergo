// 界面字号（纯函数）：设置 · 外观与风格 · 显示里调，按设备、按屏幕形态各记一份——窄屏（手机）、中屏（折叠屏展开）、
// 宽屏（平板、电脑）；折叠屏折起、展开时各用各的，没调过的是 1（就是现在的样子）。不是个人数据，也不经协议。
// 页面上怎么跟着走：根元素上写 --fs-k（这里的比例），风格的字号 token 乘它，间距只跟一部分，标题栏这类容器封顶
// （visual-styles/tokens.ts 的 scaledTokenValue、styles/base.css 开头）。读写浏览器存储、给页面写变量、跟着窗口宽度换形态
// 在 app/font-scale.ts；index.html 的内联脚本打开页面时先写一遍，和这里同一套算法（test/app/font-scale.test.ts 比对）。

/** 没调过的比例：风格本来的样子 */
export const FONT_SCALE_DEFAULT = 1;
/** 细调滑杆的范围和步长 */
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

/** 四个预设：小、标准、大、特大 */
export type FontScalePreset = "small" | "standard" | "large" | "xlarge";

export const FONT_SCALE_PRESETS: readonly { readonly id: FontScalePreset; readonly scale: number }[] = [
  { id: "small", scale: 0.9 },
  { id: "standard", scale: 1 },
  { id: "large", scale: 1.15 },
  { id: "xlarge", scale: 1.3 },
];

/** 屏幕形态：窄屏（手机）、中屏（折叠屏展开）、宽屏（平板、电脑） */
export type ScreenForm = "narrow" | "medium" | "wide";

export const SCREEN_FORMS: readonly ScreenForm[] = ["narrow", "medium", "wide"];

/**
 * 按窗口宽度（CSS 像素）分形态，用鸿蒙"一多"的断点：< 600 是手机（和导航换到左边一栏的分界一样），
 * 600–840 是折叠屏展开（中屏），≥ 840 是平板、电脑
 */
export const MEDIUM_FORM_MIN = 600;
export const WIDE_FORM_MIN = 840;

export function screenFormOf(width: number): ScreenForm {
  if (width >= WIDE_FORM_MIN) return "wide";
  if (width >= MEDIUM_FORM_MIN) return "medium";
  return "narrow";
}

/** 记在 localStorage 里的键：每种形态一个（index.html 的内联脚本也用它） */
export function fontScaleKey(form: ScreenForm): string {
  return `ergo-font-scale-${form}`;
}

/** 比例落到范围里、按步长取整（0.05 一格，写出来没有 1.1500000000000001 这种尾巴） */
export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return FONT_SCALE_DEFAULT;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
  return Math.round(clamped / FONT_SCALE_STEP) / Math.round(1 / FONT_SCALE_STEP);
}

/** 记住的值：认得出的数就落到范围里取整；没记过、写坏了的按 1 */
export function fontScaleOf(raw: string | null): number {
  if (raw === null || raw.trim() === "") return FONT_SCALE_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampFontScale(n) : FONT_SCALE_DEFAULT;
}

/** 这个比例正好是哪个预设（滑杆调到别处就不是哪个） */
export function fontScalePresetOf(scale: number): FontScalePreset | undefined {
  return FONT_SCALE_PRESETS.find((p) => p.scale === scale)?.id;
}

/** 根元素上写的 --fs-k；是 1 时不写（样式里 :root 的 --fs-k: 1，和没有这个功能时一样） */
export function fontScaleCss(scale: number): string | undefined {
  return scale === FONT_SCALE_DEFAULT ? undefined : String(scale);
}

/**
 * 根元素上的 data-font-scale：调大了是 up、调小了是 down，1 时不挂。只在调过时才要的排版（窄屏上次要信息收成一行、
 * 标题单行省略，styles/font-scale.css）、调小时能点的东西不缩（visual-styles/tokens.ts 的 CONTROLS）挂在它下面，
 * 1 时这些规则一条都不生效
 */
export function fontScaleMark(scale: number): "up" | "down" | undefined {
  if (scale > FONT_SCALE_DEFAULT) return "up";
  if (scale < FONT_SCALE_DEFAULT) return "down";
  return undefined;
}
