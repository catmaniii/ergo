// 悬浮按钮旁边的小气泡（146 号票，用户 2026-10-18：点一下就在按钮旁边打字，按住说话时按钮旁边有实时的波形，二狗的回话也在按钮
// 旁边的小气泡里，不再从"浏览"页最下面出来）在二狗网页这一侧：
// - bubbleView：网页上下指令的面板（page-commands.ts 的 PagePanel）换成气泡的样子（page-bridge/protocol.ts 的 PageBubbleView，纯函数）；
// - PageBubbleSync：面板变了就把气泡的样子经 App 交给页面桥画（NativePageControl.bubble，一样的不重复交）；页面桥点了、长按了、
//   气泡上点了什么之后再交一遍现在的样子（页面桥为了不等来回，先自己画了打字框、在听，面板没接的话照面板的改回来）；
//   拦下的选文件对话框画不出来（页面桥不在）时交给系统的选择器，免得网页那边干等。
// 149 号票起气泡只放打字、说话、回话（"二狗在想……"，秘书正忙时"排在后面"）；候选画在挑图片窗口里（page-pick.ts）。
// 169 号票：气泡上的字按当前语言；页面桥自己的那几句（悬浮按钮的说明、按钮上的字、在听的提示）它没有词典，按钮出来、选中的框变了时
// 把当前语言的这几句交给它（bridgeTexts；旧版 App 不认就算了，页面桥照旧中文）。
// 181 号票：说到助理的那几句（"二狗在想……"、页面桥自己的标题、"让二狗选"……）用用户起的名字：纯文字换好名字（旧版页面桥照样显示），
// 另给按名字切开的几段（页面桥画成名字标签）；名字标签的颜色照现在的视觉风格算好（nameTagColors，浅色深色两对）随那几句交过去；
// 名字、语言、风格变了（lookChanged，页面上的 page-browse.ts 告诉这里）重交，开着的气泡跟着变。
// 不碰 DOM 和浏览器的全局变量，测试在 Node 里跑。
import { PAGE_BUBBLE_NONE, type PageBubbleView, type PageNamedPart, type PageNamedText } from "../../page-bridge/protocol.ts";
import { BRIDGE_ASSISTANT_KEYS, BRIDGE_TEXT_KEYS, type NameTagColors, type PageBridgeTexts } from "../../page-bridge/texts.ts";
import { DEFAULT_ASSISTANT_NAME, t, tParts } from "../../state/index.ts";
import { BASE_STYLE, effectiveTokens, resolveColor, type Theme, VISUAL_STYLES } from "../../visual-styles/index.ts";
import type { NativeBrowserEvent, NativePageControl } from "../../app/native-browser.ts";
import type { BusyNote, CommandTarget, PageCommands, PagePanel } from "./page-commands.ts";
import { targetName, wantsFiles } from "./page-commands.ts";

/** 气泡跟着哪个框：悬浮按钮所在的框、拦下的对话框认出来的框；都没有是空串（气泡放在屏幕下面） */
function fieldIdOf(target: CommandTarget): string {
  return target.field?.id ?? target.chooser?.fieldId ?? "";
}

/** 网页要选文件时气泡上的那句话 */
function chooserText(accept: readonly string[], multiple: boolean): string {
  const images = accept.length > 0 && accept.every((a) => a.startsWith("image/") || /^\.(jpe?g|png|gif|webp|heic)$/i.test(a));
  if (images) return t(multiple ? "app.pageBubble.chooser.images" : "app.pageBubble.chooser.image");
  return t(multiple ? "app.pageBubble.chooser.files" : "app.pageBubble.chooser.file");
}

/** 在办的那一句气泡里怎么写（149 号票：秘书正忙时说明排在后面，不让用户以为没反应；181 号票起说到助理的写 {name}） */
export const BUSY_KEY: Readonly<Record<BusyNote, string>> = {
  hearing: "app.pageBubble.busy.hearing",
  thinking: "app.pageBubble.busy.thinking",
  queued: "app.pageBubble.busy.queued",
};

/** 一句可能说到助理的话（181 号票）：纯文字（名字换好）；说到了的另给按名字切开的几段（页面桥画成名字标签） */
export interface NamedText {
  text: string;
  parts?: PageNamedText;
}

/** 名字在 tParts 里的记号 */
const NAME_MARK = Symbol("name");

/** 按当前语言取一句，{name} 是助理的名字（181 号票）：别的参数照常换上，名字那一段单独切出来 */
export function namedText(key: string, name: string, params: Readonly<Record<string, string | number>> = {}): NamedText {
  const text = t(key, { ...params, name });
  const parts: PageNamedPart[] = [];
  let plain = "";
  let named = false;
  for (const part of tParts(key, { ...params, name: NAME_MARK })) {
    if (part !== NAME_MARK) {
      plain += String(part);
      continue;
    }
    if (plain) parts.push(plain);
    plain = "";
    parts.push({ name });
    named = true;
  }
  if (plain) parts.push(plain);
  return named ? { text, parts } : { text };
}

/** 助理现在的名字、名字标签的颜色（181 号票；没给颜色页面桥用经典的） */
export interface BridgeLook {
  name: string;
  tag?: NameTagColors;
  /** 只能打字（212、214 号票：语音插件没启用）：悬浮按钮的说明不说"按住说话" */
  typeOnly?: boolean;
}

/**
 * 页面桥自己的那几句，按当前语言（169 号票）。181 号票：说到助理的那几句名字换好（不认 assistant 的旧版页面桥照样显示起的名字），
 * 原样（带 {name}）、名字、名字标签的颜色放在 assistant 里
 */
export function bridgeTexts(look: BridgeLook = { name: DEFAULT_ASSISTANT_NAME }): PageBridgeTexts {
  const own = new Set<string>(BRIDGE_ASSISTANT_KEYS);
  const texts: PageBridgeTexts = Object.fromEntries(BRIDGE_TEXT_KEYS.map((key) => [key, own.has(key) ? t(key, { name: look.name }) : t(key)]));
  const templates: Record<string, string> = Object.fromEntries(BRIDGE_ASSISTANT_KEYS.map((key) => [key, t(key)]));
  if (look.typeOnly) {
    texts["bridge.fab.label"] = t("app.pageCommands.fabTypeOnly", { name: look.name });
    templates["bridge.fab.label"] = t("app.pageCommands.fabTypeOnly");
  }
  texts.assistant = { name: look.name, ...(look.tag ? { tag: look.tag } : {}), templates };
  return texts;
}

/**
 * 名字标签的颜色（181 号票）：照风格清单算出这套风格（连同选的主色）的 --name-bg / --name-fg 实际的颜色，浅色、深色各一对——
 * 和二狗网页里 .assistant-name 用的一样。页面桥跟着网页的深浅色挑一对（App 里外部网页的深浅色跟着二狗的外观）。
 * 不认识的风格按经典，不认识的主色按这套风格默认的
 */
export function nameTagColors(styleId: string, accentId?: string): NameTagColors {
  const style = VISUAL_STYLES.find((s) => s.id === styleId) ?? VISUAL_STYLES[0]!;
  const accent = style.accents?.some((a) => a.id === accentId) ? accentId : undefined;
  const tokens = effectiveTokens(style, BASE_STYLE, accent);
  const pair = (theme: Theme) => ({ bg: resolveColor(tokens, "name-bg", theme), fg: resolveColor(tokens, "name-fg", theme) });
  return { light: pair("light"), dark: pair("dark") };
}

/** 回话多长算"太长"（147 号票）：超过这么多字，或者超过这么多行（气泡 300 来宽，一行二十来个字），回话下面给"去侧边栏看" */
export const REPLY_LONG_CHARS = 120;
export const REPLY_LONG_LINES = 6;

/** 回话太长了没有 */
export function replyTooLong(text: string): boolean {
  return text.length > REPLY_LONG_CHARS || text.split("\n").length > REPLY_LONG_LINES;
}

/**
 * 网页上下指令的面板 → 气泡的样子；sidebar 是有没有浏览侧边栏（147 号票：有的话太长的回话下面给"去侧边栏看"）；
 * name 是助理现在的名字（181 号票）
 */
export function bubbleView(panel: PagePanel, sidebar = false, name = DEFAULT_ASSISTANT_NAME): PageBubbleView {
  switch (panel.kind) {
    case "idle":
      return PAGE_BUBBLE_NONE;
    case "chooser":
      return { kind: "chooser", fieldId: panel.chooser.fieldId, text: chooserText(panel.chooser.accept, panel.chooser.multiple) };
    case "bar":
      return {
        kind: "input",
        fieldId: fieldIdOf(panel.target),
        label: t("app.pageBubble.talkTo", { target: targetName(panel.target) }),
        placeholder: t(wantsFiles(panel.target) ? "app.pageBubble.placeholder.files" : "app.pageBubble.placeholder.text"),
      };
    case "listening":
      return { kind: "listening", fieldId: fieldIdOf(panel.target), label: t("app.pageBubble.talkTo", { target: targetName(panel.target) }), levels: [...panel.levels] };
    case "busy": {
      const busy = namedText(BUSY_KEY[panel.note], name);
      return { kind: "busy", fieldId: fieldIdOf(panel.target), said: panel.said ?? "", text: busy.text, ...(busy.parts ? { textParts: busy.parts } : {}) };
    }
    case "reply":
      return {
        kind: "reply",
        fieldId: fieldIdOf(panel.target),
        said: panel.said ?? "",
        text: panel.text,
        failed: panel.failed,
        system: panel.target.chooser !== undefined,
        more: sidebar && replyTooLong(panel.text),
      };
  }
}

export interface PageBubbleDeps {
  commands: Pick<PageCommands, "snapshot" | "subscribe" | "chooseBySystem">;
  page: Pick<NativePageControl, "bubble" | "texts">;
  /** 有没有浏览侧边栏（147 号票；没给当没有） */
  sidebar?: () => boolean;
  /** 助理现在的名字、名字标签的颜色（181 号票；没给是默认的名字、经典的颜色） */
  look?: () => BridgeLook;
}

export class PageBubbleSync {
  private readonly deps: PageBubbleDeps;
  /** 上次交给页面桥的样子（JSON） */
  private last = "";
  /** 上次交给页面桥的它自己的那几句（JSON；空串是还没交过：页面桥还没报过什么） */
  private lastTexts = "";

  constructor(deps: PageBubbleDeps) {
    this.deps = deps;
    deps.commands.subscribe(() => this.push(false));
    // 二狗的网页刚打开（App 里重新加载过）：浏览器里的网页上可能还留着上次的气泡，先收起
    this.push(true);
  }

  /** App 推过来的、面板已经办过的：页面桥点了、长按了、气泡上点了什么、返回手势之后再交一遍（页面桥先自己画了的照面板改回来） */
  after(event: NativeBrowserEvent): void {
    if (event.type === "bubble-close") return this.push(true);
    if (event.type !== "page") return;
    const e = event.event;
    // 悬浮按钮出来了、选中的框变了（页面桥一装上就报一次"没选中"）：把页面桥自己的那几句按当前语言交过去（169 号票）——
    // 每次都交（可能是新的一页上新装的页面桥）
    if ((e.type === "field" && e.field) || e.type === "selected") this.sendTexts(true);
    // "让二狗选"要先问页面桥要框的列表（等一下才变成打字），页面桥先画的打字框留着，等面板变了再交
    if (e.type === "open" || e.type === "voice" || (e.type === "bubble" && e.action !== "ergo")) this.push(true);
  }

  /**
   * 助理的名字、语言、视觉风格变了（181 号票；页面上的 page-browse.ts 在状态变了、风格变了时调）：页面桥装上过就把它自己的那几句
   * 重交（一样的不交），开着的气泡照新的名字、语言再交（一样的不交）
   */
  lookChanged(): void {
    if (this.lastTexts) this.sendTexts(false);
    this.push(false);
  }

  private look(): BridgeLook {
    return this.deps.look?.() ?? { name: DEFAULT_ASSISTANT_NAME };
  }

  private sendTexts(force: boolean): void {
    const texts = bridgeTexts(this.look());
    const json = JSON.stringify(texts);
    if (!force && json === this.lastTexts) return;
    this.lastTexts = json;
    this.deps.page.texts?.(texts);
  }

  private push(force: boolean): void {
    const panel = this.deps.commands.snapshot();
    const view = bubbleView(panel, this.deps.sidebar?.() ?? false, this.look().name);
    const json = JSON.stringify(view);
    if (!force && json === this.last) return;
    this.last = json;
    void this.deps.page.bubble(view).then((ok) => {
      // 拦下的选文件对话框画不出来（页面桥不在）：交给系统的选择器，网页那边别干等
      if (!ok && view.kind === "chooser" && this.deps.commands.snapshot() === panel) this.deps.commands.chooseBySystem();
    });
  }
}
