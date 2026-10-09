// 视觉风格（39 号票）的 token：名字、写法，以及从风格清单生成样式表、算出某个 token 实际的颜色。
//
// 一套风格 = 一组 token + 限定在这套风格下的规则（<风格 id>/style.css）。token 写在每套风格自己的 style.ts 里，
// 构建时由 build/visual-styles-plugin.ts 生成一份样式表（visualStylesCss）：经典挂在 :root 上，别的风格挂在
// [data-style="<id>"] 上（根元素的 data-style 由 index.html 的内联脚本和 app/theme.ts 挂）。页面样式只用 var(--名字)。
// 这个文件是纯数据和纯函数：Vite 的配置（Node 里）和页面都引用它，测试（对比度）也直接用它。

/** 浅色、深色各一个值；只写一个字符串就是浅深一样（可以是 var(--别的 token)） */
export type TokenValue = string | readonly [light: string, dark: string];

/**
 * 全部 token 的名字，就是样式里的 --名字。按类分：
 * - 颜色：底色、文字、线、强调色、结果色……（浅深两个值）。primary 是强调色（链接、选中的字、细条），
 *   primary-fill 是主按钮这类实色块的底（上面是 primary-text 的字）；danger-fill 是危险按钮的底（上面是 on-color 的字）——
 *   分开是因为深色下当字用的颜色要亮、当底用的要暗，一个值两头顾不上；name-bg / name-fg 是个人助理名字的小标签（43 号票）；
 * - 字体：正文 font-body、标题 font-title（页面标题、分组标题、卡片的类型标签……）、数字 font-num（时间、时长、计数、
 *   统计数字、日历上的日子）、等宽 font-mono。经典的标题、数字就是正文字体；
 * - 字号阶：2xs 10、xs 11、s 12、m 13、l 14、正文 15、标题 17（经典的取值）；
 * - 圆角：xs 4、s 6、m 8、l 10、xl 12、2xl 14、底部弹层 18、胶囊 999；
 * - 阴影：菜单、浮起的提示、录音时的提示条；
 * - 间距密度：页面左右留白和块间距、聊天里消息之间的距离、标题栏高度；
 * - 边框：card-border 是有框的卡片（聊天里的卡片、看板上的卡片，经典是 1px 细线），panel-border 是底板
 *   （.card：设置项、项目页的头部这类，经典靠底色区分，没有边框）。
 * 加 token：在这里加名字，在 classic/style.ts 给经典的值（别的风格不写就沿用经典的），样式里用 var(--名字)。
 */
export const TOKEN_NAMES = [
  // 颜色
  "bg",
  "surface",
  "text",
  "muted",
  "border",
  "primary",
  "primary-text",
  "primary-fill",
  "danger-fill",
  "user-bubble",
  "user-text",
  "fill",
  "on-color",
  "nav-on",
  "badge",
  "scrim",
  "c-user",
  "c-thinking",
  "c-reply",
  "c-plan",
  "c-tool",
  "c-context",
  "data-bg",
  "data-fg",
  "op-bg",
  "op-fg",
  "high-bg",
  "high-fg",
  "ok",
  "pull-fg",
  "reject-fg",
  "you",
  "you-bg",
  "name-bg",
  "name-fg",
  // 字体
  "font-body",
  "font-title",
  "font-num",
  "font-mono",
  // 字号阶
  "fs-2xs",
  "fs-xs",
  "fs-s",
  "fs-m",
  "fs-l",
  "fs-body",
  "fs-title",
  // 圆角
  "radius-xs",
  "radius-s",
  "radius-m",
  "radius-l",
  "radius-xl",
  "radius-2xl",
  "radius-sheet",
  "radius-pill",
  // 阴影
  "shadow-menu",
  "shadow-float",
  "shadow-note",
  // 间距密度
  "space-page",
  "space-msg",
  "bar-h",
  // 边框
  "card-border",
  "panel-border",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

export type Tokens = Readonly<Record<TokenName, TokenValue>>;

/** 风格要用的字体：npm 上 fontsource 的包（按 unicode-range 切好片的 woff2，OFL 等许可），构建时拷进 dist/fonts/ */
export interface FontSource {
  /** 包名，比如 @fontsource-variable/noto-sans-sc（要写进 packages/web 的 devDependencies） */
  readonly package: string;
  /** 包里的哪份 CSS：可变字体一般是 index.css，固定字重的是 400.css、700.css 这样 */
  readonly css: string;
}

/** 一套风格 */
export interface VisualStyle {
  /** 内部 id，用英文：根元素的 data-style、记在这台设备上的值、风格目录的名字 */
  readonly id: string;
  /** 界面上显示的名字 */
  readonly name: string;
  /** 设置里名字下面的一句话 */
  readonly blurb: string;
  /** 这套风格的 token；没写的沿用经典的 */
  readonly tokens: Partial<Tokens>;
  /** 这套风格用到的字体，只在选了这套风格时加载（经典用系统字体，没有） */
  readonly fonts?: readonly FontSource[];
}

/** 经典要把全部 token 写全：别的风格没写的都沿用它 */
export interface BaseVisualStyle extends VisualStyle {
  readonly tokens: Tokens;
}

/** 一套风格实际用的全部 token：自己写了的，加上沿用经典的 */
export function effectiveTokens(style: VisualStyle, base: BaseVisualStyle): Tokens {
  return { ...base.tokens, ...style.tokens };
}

export type Theme = "light" | "dark";

/** token 在浅色或深色下的值（原样，可能是 var(--别的)） */
export function tokenValue(value: TokenValue, theme: Theme): string {
  return typeof value === "string" ? value : value[theme === "light" ? 0 : 1];
}

/** 颜色写法：#rgb、#rrggbb、#rrggbbaa、rgb()/rgba()（逗号或空格分隔）→ [r, g, b, 透明度]；别的写法给 undefined */
function parseColor(value: string): [number, number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b, a = 255] = (full.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));
    return [r!, g!, b!, a / 255];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (!fn) return undefined;
  const alpha = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
}

const toHex = (channels: readonly number[]) => `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** 顺着 var(--别的 token) 找到的那个值 */
function finalValue(tokens: Tokens, name: TokenName, theme: Theme): string {
  const seen: string[] = [];
  let current: string = name;
  for (;;) {
    if (seen.includes(current)) throw new Error(`token 互相引用成了环：${[...seen, current].join(" → ")}`);
    seen.push(current);
    const value = tokenValue(tokens[current as TokenName], theme).trim();
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (!ref) return value;
    if (!(TOKEN_NAMES as readonly string[]).includes(ref[1]!)) throw new Error(`--${current} 引用了不认识的 token --${ref[1]}`);
    current = ref[1]!;
  }
}

/**
 * token 实际的颜色（#rrggbb）：顺着 var(--别的 token) 找下去。给对比度测试、地址栏颜色用。
 * 半透明的（#rrggbbaa、rgba()）按叠在页面底色（--bg，它自己得不透明）上算：毛玻璃这类效果在不支持的浏览器上退回的就是这样，
 * 字的对比度不能靠模糊撑。算不出来的写法（color-mix、渐变……）报错——要参与这些计算的 token 得写成上面几种
 */
export function resolveColor(tokens: Tokens, name: TokenName, theme: Theme): string {
  const value = finalValue(tokens, name, theme);
  const color = parseColor(value);
  const where = `--${name} 在${theme === "light" ? "浅色" : "深色"}下是 ${value}`;
  if (!color) throw new Error(`${where}，不是能算出来的颜色（写成 #rrggbb、#rrggbbaa 或 rgba()）`);
  const [r, g, b, a] = color;
  if (a >= 1) return toHex([r, g, b]);
  if (name === "bg") throw new Error(`${where}：页面底色要不透明，半透明的颜色都按叠在它上面算`);
  const under = parseColor(resolveColor(tokens, "bg", theme))!;
  return toHex([r, g, b].map((c, i) => c * a + under[i]! * (1 - a)));
}

/** 一个 token 写成样式：浅深不一样的用 light-dark()，跟着根元素的 color-scheme 取值（见 styles/base.css 开头） */
function declaration(name: TokenName, value: TokenValue): string {
  const css = typeof value === "string" || value[0] === value[1] ? tokenValue(value, "light") : `light-dark(${value[0]}, ${value[1]})`;
  return `  --${name}: ${css};`;
}

/**
 * 风格清单生成的样式表：经典挂在 :root（没挂 data-style、或挂的风格不认识时就是经典）；每套风格（包括经典）
 * 另挂在 [data-style="<id>"] 上，写全全部 token（没写的沿用经典的）——设置里的预览用 data-style 套一套风格的颜色，
 * 套在别的风格里面时也不会混进外面那套的值。同样的特异度，后写的压过先写的：经典在前。
 */
export function visualStylesCss(styles: readonly VisualStyle[], base: BaseVisualStyle): string {
  const blocks = [`:root {\n${TOKEN_NAMES.map((n) => declaration(n, base.tokens[n])).join("\n")}\n}`];
  for (const style of styles) {
    const tokens = effectiveTokens(style, base);
    blocks.push(`[data-style="${style.id}"] {\n${TOKEN_NAMES.map((n) => declaration(n, tokens[n])).join("\n")}\n}`);
  }
  return `/* 由风格清单生成（src/visual-styles/），不要手改 */\n${blocks.join("\n")}\n`;
}

/** 字体 token 实际的字体栈（顺着里面的 var(--别的 token) 展开），字族名去掉引号：给字体测试查"这套风格提供的字体有人用" */
export function fontStack(tokens: Tokens, name: TokenName): string[] {
  const expand = (value: string, depth: number): string[] =>
    value.split(",").flatMap((part) => {
      const item = part.trim();
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(item);
      if (!ref) return [item.replace(/^["']|["']$/g, "")];
      if (depth > 8 || !(TOKEN_NAMES as readonly string[]).includes(ref[1]!)) throw new Error(`--${name} 的字体栈里引用了 ${item}`);
      return expand(tokenValue(tokens[ref[1] as TokenName], "light"), depth + 1);
    });
  return expand(tokenValue(tokens[name], "light"), 0);
}
