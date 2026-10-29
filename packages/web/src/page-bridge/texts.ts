// 页面桥自己的字（169 号票）：悬浮按钮的说明、气泡和挑图片窗口上的按钮、在听时的提示、页面桥先自己画的打字框的称呼。
// 页面桥是注入到网页里的独立脚本，没有二狗的词典：
// - 默认用打包进去的中文（共享协议包 locales/zh-CN/bridge.json）——旧版 App 不认 texts、二狗的网页没交来时就是它；
// - 二狗的网页经宿主交来当前语言的这几句（texts 方法，PageBridgeTexts：bridge.* 的 key → 句子；网页那边按当前语言 t() 取好，
//   见 app/page-bubble.ts 的 bridgeTexts），交来了就用交来的，没交的那几句照旧中文。
// 气泡、挑图片窗口上别的字（"对「标题」说"、回话、"给「上传头像」挑一张"……）本来就由二狗的网页给。
// 181 号票：说到助理的那几句（BRIDGE_ASSISTANT_KEYS，名字处写 {name}）用用户起的名字，名字画成名字标签（bubble.ts 的 appendNamed）：
// - 二狗的网页交来的顶层那几句名字已经换好（不认 assistant 的旧页面桥照样显示起的名字，只是没有底色），原样（带 {name}）、名字、
//   名字标签浅色深色两对颜色放在 assistant 里；
// - 没交来（旧版网页）用默认的名字"二狗"、经典风格的颜色（bubble.ts 的样式表里写着）。
import ZH from "../../../protocol/locales/zh-CN/bridge.json" with { type: "json" };
import type { PageNamedPart, PageNamedText } from "./protocol.ts";

/** 页面桥自己的几句的 key（bridge.*） */
export type BridgeTextKey = keyof typeof ZH;

/** 说到助理的那几句（181 号票）：句子里名字处写 {name} */
export const BRIDGE_ASSISTANT_KEYS = ["bridge.fab.label", "bridge.talkTo.ergo", "bridge.bubble.title", "bridge.bubble.thinking", "bridge.bubble.letErgoPick", "bridge.pick.title"] as const satisfies readonly BridgeTextKey[];
export type BridgeAssistantKey = (typeof BRIDGE_ASSISTANT_KEYS)[number];

/** 名字标签的一对颜色（#rrggbb）：底色、字色 */
export interface NameTagPair {
  bg: string;
  fg: string;
}

/** 名字标签的颜色（181 号票）：二狗的网页照现在的视觉风格算好，浅色、深色各一对（页面桥跟着网页的深浅色挑） */
export interface NameTagColors {
  light: NameTagPair;
  dark: NameTagPair;
}

/** 名字标签经典风格的颜色（181 号票：二狗的网页没交来颜色时用，写在 bubble.ts 的样式表里；和风格清单里经典的 name-bg / name-fg 一样，测试核对） */
export const NAME_TAG_CLASSIC: NameTagColors = { light: { bg: "#fbe3a1", fg: "#5c3d00" }, dark: { bg: "#4a3c14", fg: "#f7d57e" } };

/** 二狗的网页交来的助理（181 号票）：名字、名字标签的颜色（没有是经典的）、说到助理的那几句的原样（带 {name}） */
export interface BridgeAssistant {
  name: string;
  tag?: NameTagColors;
  templates: Partial<Record<BridgeAssistantKey, string>>;
}

/** 二狗的网页交来的：key → 当前语言的句子（说到助理的那几句名字已经换好）；181 号票起还有 assistant */
export type PageBridgeTexts = Partial<Record<BridgeTextKey, string>> & { assistant?: BridgeAssistant };

/** 页面桥自己的全部 key（二狗的网页按它取好交过来） */
export const BRIDGE_TEXT_KEYS = Object.keys(ZH) as BridgeTextKey[];

/** 没交来名字时的名字（同协议包的 DEFAULT_ASSISTANT_NAME；页面桥不引协议包的运行时，测试核对两边一样） */
export const BRIDGE_DEFAULT_NAME = "二狗"; // @i18n-ignore fixed：用户起的名字不翻

/** 一句最多多长（宿主是可信的，这里只防写错） */
const TEXT_MAX = 200;
/** 名字最多多长（起名的规则是 8 个字，这里只防写错） */
const NAME_MAX = 40;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 一对颜色：都是 #rrggbb 才认（拼进页面桥自己的样式表，见 bubble.ts 的 nameTagStyle） */
function pairOf(value: unknown): NameTagPair | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { bg, fg } = value as Record<string, unknown>;
  return typeof bg === "string" && typeof fg === "string" && HEX_COLOR.test(bg) && HEX_COLOR.test(fg) ? { bg, fg } : undefined;
}

/** 交来的助理：要有名字；颜色不对的不认（用经典的），原样只收说到助理的那几句 */
function assistantOf(value: unknown): BridgeAssistant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || v.name === "") return undefined;
  const tag = typeof v.tag === "object" && v.tag !== null ? v.tag : {};
  const light = pairOf((tag as Record<string, unknown>).light);
  const dark = pairOf((tag as Record<string, unknown>).dark);
  const templates: Partial<Record<BridgeAssistantKey, string>> = {};
  const given = typeof v.templates === "object" && v.templates !== null ? (v.templates as Record<string, unknown>) : {};
  for (const key of BRIDGE_ASSISTANT_KEYS) {
    const text = given[key];
    if (typeof text === "string" && text !== "") templates[key] = text.slice(0, TEXT_MAX);
  }
  return { name: v.name.slice(0, NAME_MAX), ...(light && dark ? { tag: { light, dark } } : {}), templates };
}

/** 交来的（JSON 解出来的）：只收认得的 key、是字符串的句子，和助理（181 号票）；什么都没有是 undefined */
export function bridgeTextsOf(value: unknown): PageBridgeTexts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: PageBridgeTexts = {};
  let any = false;
  for (const key of BRIDGE_TEXT_KEYS) {
    const text = (value as Record<string, unknown>)[key];
    if (typeof text === "string" && text !== "") {
      out[key] = text.slice(0, TEXT_MAX);
      any = true;
    }
  }
  const assistant = assistantOf((value as Record<string, unknown>).assistant);
  if (assistant) {
    out.assistant = assistant;
    any = true;
  }
  return any ? out : undefined;
}

type Params = Readonly<Record<string, string | number>>;

const PARAM = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 一句话拼好、按名字切开：给了的参数换上；没给 name 的 {name} 是助理的名字（{ name } 一段）；别的没给的原样 */
function fill(template: string, name: string, params: Params = {}): PageNamedText {
  const out: PageNamedPart[] = [];
  let text = "";
  let last = 0;
  for (const m of template.matchAll(PARAM)) {
    text += template.slice(last, m.index);
    last = m.index + m[0].length;
    const param = m[1]!;
    if (Object.hasOwn(params, param)) text += String(params[param]);
    else if (param === "name") {
      if (text) out.push(text);
      text = "";
      out.push({ name });
    } else text += m[0];
  }
  text += template.slice(last);
  if (text) out.push(text);
  return out;
}

/** 几段连成纯文字（名字就是名字本身：读屏说明、旧的写法） */
export function plainOf(parts: PageNamedText): string {
  return parts.map((p) => (typeof p === "string" ? p : p.name)).join("");
}

/** 页面桥现在用的几句：没交来的用中文 */
export interface BridgeTexts {
  /** 取一句，{参数} 换成参数；没给 name 时 {name} 是助理的名字（纯文字：读屏说明、标题这类） */
  get(key: BridgeTextKey, params?: Params): string;
  /** 同 get，按助理的名字切开（181 号票：名字画成名字标签） */
  parts(key: BridgeTextKey, params?: Params): PageNamedText;
  /** 名字标签的颜色（181 号票；没交来是 undefined，用样式表里经典的） */
  tag(): NameTagColors | undefined;
  /** 换上交来的（整份换掉：没交的那几句回到中文，没交名字回到"二狗"） */
  set(texts: PageBridgeTexts): void;
}

export function createBridgeTexts(): BridgeTexts {
  let current: PageBridgeTexts = {};
  /** 说到助理的那几句先用交来的原样（带 {name}），再用顶层的（旧版网页交来的、名字写死了），都没有用中文 */
  const template = (key: BridgeTextKey): string => current.assistant?.templates[key as BridgeAssistantKey] ?? current[key] ?? ZH[key];
  const parts = (key: BridgeTextKey, params?: Params) => fill(template(key), current.assistant?.name ?? BRIDGE_DEFAULT_NAME, params);
  return {
    get: (key, params) => plainOf(parts(key, params)),
    parts,
    tag: () => current.assistant?.tag,
    set(texts) {
      current = texts;
    },
  };
}
