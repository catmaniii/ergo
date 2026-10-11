// 风格清单（39 号票）：设置 · 外观 · 风格里按这个顺序列出。加一套风格见 docs/dev.md 的"视觉风格"：
// 建 src/visual-styles/<id>/style.ts（token、名字、字体）和 style.css（限定在这套风格下的规则），然后在下面登记一行。
// 第一项必须是经典：别的风格没写的 token 都沿用它，记住的风格找不到时也按它。
import { classic } from "./classic/style.ts";
import { blueprint } from "./blueprint/style.ts";
import { candy } from "./candy/style.ts";
import { glass } from "./glass/style.ts";
import { grid } from "./grid/style.ts";
import { ink } from "./ink/style.ts";
import { night } from "./night/style.ts";
import { paper } from "./paper/style.ts";
import { sticker } from "./sticker/style.ts";
import type { BaseVisualStyle, VisualStyle } from "./tokens.ts";

export const BASE_STYLE: BaseVisualStyle = classic;

export const VISUAL_STYLES: readonly VisualStyle[] = [
  classic,
  paper,
  grid,
  night,
  candy,
  glass,
  blueprint,
  sticker,
  ink,
];

export * from "./page.ts";
export * from "./preview.ts";
export * from "./tokens.ts";
export * from "./voice.ts";
