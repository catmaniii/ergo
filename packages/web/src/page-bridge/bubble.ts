// 悬浮按钮旁边的小气泡（146 号票，用户 2026-10-18：点一下就在按钮旁边打字，按住说话时按钮旁边有实时的波形，二狗的回话也在按钮
// 旁边的小气泡里）。画在页面桥那个封闭的 shadow root 里（和悬浮按钮一起，网站的 CSS、脚本都碰不到），只管画和收用户点了什么，
// 样子由宿主交来（PageBubbleView：二狗的网页 app/page-bubble.ts 照它的面板算好），点了什么交给 onAction。
// 149 号票起悬浮按钮背后就是秘书本人：气泡只放打字、说话、回话（"二狗在想……"、秘书正忙时"排在后面"）；秘书给的候选不在气泡里，
// 画在固定位置的挑图片窗口里（pick.ts）。
// 页面桥为了不等来回，有两样先自己画：点了按钮先出打字框（在点的那一下里聚焦，手机上输入法才弹得出来）、按够了先出在听；
// 宿主随后交来的一样就留着（打字框里打了一半的字不丢），不一样就照宿主的改。
// - 摆在哪（rules.ts）：每一帧照悬浮按钮、按钮挂着的框和看得见的部分（输入法弹起时只剩上面那一截）摆——在听的时候放在按钮上方
//   （placeListening，149 号票：手指按在按钮上，下方会被挡住；贴着顶时放在左右空间大的一侧），别的时候放在按钮背离框的那一边、
//   不盖住框（placeBubble，主会话 2026-10-18 定）；没有按钮（不知道是哪个框）放在下面居中；
// - 文字一律 textContent（模型回的话里有 HTML 也只是字）；
// - 气泡里的按键、输入、点按不往网页里冒泡（网站的快捷键、"点外面就关"的菜单不会被它触发；网页在捕获阶段还是能看到）。
// - 169 号票：页面桥自己的字（标题、×、发送、在听的提示、"让二狗选"……）按二狗的网页交来的语言（texts.ts），没交来是中文。
// - 181 号票：标题、"二狗在想……"、"让二狗选"里的名字是用户起的那个，画成名字标签（照二狗网页里的 .assistant-name：左右留一点、
//   圆角、底色、字色、不换行；颜色是二狗的网页照现在的风格交来的，没交来是经典的）；读屏说明只写名字本身。
import type { PageBubbleAction, PageBubbleView, PageNamedPart, PageNamedText } from "./protocol.ts";
import { BUBBLE_MAX_HEIGHT, bubbleWidth, placeBubble, placeListening, type Rect, recordedText, WAVE_BARS, waveBars } from "./rules.ts";
import { type BridgeTexts, NAME_TAG_CLASSIC, type NameTagColors, plainOf } from "./texts.ts";

/** 打字框最多长到几行（每行 20 像素，加上下内边距、边框） */
const INPUT_MAX_HEIGHT = 5 * 20 + 16;
/** 打的字最多多少 */
const TEXT_MAX = 2000;

const ICON_SEND =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
export const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * 名字标签的颜色交来了（181 号票）：另一段样式表（接在 BUBBLE_STYLE 后面，盖过经典的），跟着网页的深浅色挑一对；没交来是空的。
 * 颜色在 texts.ts 收的时候核对过是 #rrggbb
 */
export function nameTagStyle(colors: NameTagColors | undefined): string {
  if (!colors) return "";
  return `.name { background: ${colors.light.bg}; color: ${colors.light.fg}; }
@media (prefers-color-scheme: dark) {
  .name { background: ${colors.dark.bg}; color: ${colors.dark.fg}; }
}`;
}

/** 气泡的样式（接在悬浮按钮的样式后面，同一个 shadow root）：只用像素和写死的颜色，不用 rem、var()——网页的根字号、CSS 变量会透进来 */
export const BUBBLE_STYLE = `
.bubble {
  position: fixed; left: 0; top: 0; box-sizing: border-box; display: none; flex-direction: column;
  width: 300px; max-height: ${BUBBLE_MAX_HEIGHT}px;
  background: #fff; color: #1d2433; border-radius: 14px;
  box-shadow: 0 8px 28px rgba(20, 30, 70, .24), 0 0 0 1px rgba(20, 30, 70, .08);
  font: 14px/1.45 system-ui, -apple-system, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: left; -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.bubble.on { display: flex; }
.bubble.placing { opacity: 0; }
.bubble * { box-sizing: border-box; }
.tail { position: absolute; left: 0; width: 12px; height: 12px; margin-left: -6px; background: inherit; transform: rotate(45deg); }
.bubble.above .tail { bottom: -6px; box-shadow: 1px 1px 0 rgba(20, 30, 70, .08); }
.bubble.below .tail { top: -6px; box-shadow: -1px -1px 0 rgba(20, 30, 70, .08); }
.bubble.left .tail { left: auto; right: -6px; margin: -6px 0 0; box-shadow: 1px -1px 0 rgba(20, 30, 70, .08); }
.bubble.right .tail { left: -6px; margin: -6px 0 0; box-shadow: -1px 1px 0 rgba(20, 30, 70, .08); }
.bubble.free .tail { display: none; }
.head { position: relative; flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 4px 0 12px; min-height: 30px; }
.label { flex: 1; min-width: 0; font-size: 12px; color: #6b7385; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x { flex: none; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #6b7385; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.x:active { background: rgba(20, 30, 70, .08); }
.body { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 12px 4px; }
.body:empty { display: none; }
.foot { position: relative; flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 12px 10px; }
.foot:empty { display: none; }
.said { font-size: 12px; color: #6b7385; margin: 0 0 4px; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; }
.text { margin: 0; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; }
.text.failed { color: #d63b3b; }
.input-row { display: flex; align-items: flex-end; gap: 8px; width: 100%; }
textarea {
  flex: 1; min-width: 0; height: 36px; max-height: ${INPUT_MAX_HEIGHT}px; margin: 0; resize: none; overflow-y: auto;
  border: 1px solid #d5dae6; border-radius: 10px; padding: 7px 10px; outline: none;
  font: inherit; line-height: 20px; color: inherit; background: #f6f7fb; user-select: text; -webkit-user-select: text;
}
textarea:focus { border-color: #3a5bd9; background: #fff; }
textarea::placeholder { color: #9aa3b5; }
.send {
  flex: none; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: linear-gradient(145deg, #5b8cff, #3a5bd9); color: #fff; display: flex; align-items: center; justify-content: center;
}
.send:disabled { opacity: .4; cursor: default; }
.wave { display: flex; align-items: center; gap: 2px; height: 44px; }
.wave i { flex: 1; min-height: 3px; border-radius: 2px; background: #3a5bd9; opacity: .85; transition: height 80ms linear; }
.bubble.cancel .wave i { background: #e03131; }
.voice-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%; font-size: 12px; color: #6b7385; }
.time { font-variant-numeric: tabular-nums; font-size: 13px; color: #1d2433; }
.bubble.cancel .hint { color: #e03131; font-weight: 600; }
.thinking { display: flex; align-items: center; gap: 8px; margin: 0; color: #4a5266; }
.thinking::before {
  content: ""; flex: none; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(58, 91, 217, .25); border-top-color: #3a5bd9; animation: ergo-spin .8s linear infinite;
}
.btn { flex: none; margin: 0; border: 0; border-radius: 16px; padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer; background: #eef1f7; color: #1d2433; }
.btn.primary { background: #3a5bd9; color: #fff; }
.btn:disabled { opacity: .45; cursor: default; }
.name {
  padding: 0 3px; margin: 0 1px; border-radius: 4px; white-space: nowrap;
  background: ${NAME_TAG_CLASSIC.light.bg}; color: ${NAME_TAG_CLASSIC.light.fg};
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.btn.primary .name { box-shadow: 0 0 0 1px rgba(255, 255, 255, .85); }
@media (prefers-color-scheme: dark) {
  .bubble { background: #252a34; color: #e7eaf0; box-shadow: 0 8px 28px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .08); }
  .label, .said, .voice-row, .x { color: #a3abbd; }
  .time, .thinking { color: #e7eaf0; }
  textarea { background: #1c2028; border-color: #3a4152; }
  textarea:focus { background: #1c2028; border-color: #6d8dff; }
  .btn { background: #323846; color: #e7eaf0; }
  .btn.primary { background: #4a6bea; color: #fff; }
  .name { background: ${NAME_TAG_CLASSIC.dark.bg}; color: ${NAME_TAG_CLASSIC.dark.fg}; }
}
`;

/** 页面桥在注入那一刻记下的内置函数（网页的脚本之后改了也碍不着）；页面桥自己的字（169 号票） */
export interface BubbleTools {
  now(): number;
  texts: BridgeTexts;
}

export interface Bubble {
  readonly el: HTMLElement;
  /** 开着（画着 none 以外的样子） */
  readonly open: boolean;
  readonly view: PageBubbleView;
  /** 宿主交来的样子（一样的不重画） */
  show(view: PageBubbleView): void;
  /** 页面桥先自己画的：点了按钮先出打字框，在这一下里聚焦（输入法弹起）；按够了先出在听；松手后先出"在想"（label 是"对「标题」说"、"对二狗说"） */
  openInput(fieldId: string, label: PageNamedText): void;
  openListening(fieldId: string, label: PageNamedText): void;
  openBusy(fieldId: string): void;
  /** 按住说话的手指在不在"松开取消"里 */
  setCancelZone(on: boolean): void;
  /** 收起（页面桥自己收：点外面、框被滚出屏幕；宿主随后交来 none） */
  hide(): void;
  /** 二狗的网页交来了别的语言（169 号票）、别的名字（181 号票）：一直挂着的几处说明换过来，开着的照现在的样子重画 */
  relabel(): void;
  /** 每一帧摆位置、走秒：button 是悬浮按钮（undefined 是没有按钮），view 是看得见的部分，field 是按钮挂着的框（不许盖住它） */
  frame(button: Rect | undefined, view: Rect, field?: Rect): void;
}

const NONE: PageBubbleView = { kind: "none" };
const KINDS: readonly string[] = ["none", "chooser", "input", "listening", "busy", "reply"];

const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.slice(0, max) : "");
/** 认得的几段放进这个字段，认不得不放 */
const withParts = <K extends string>(key: K, value: unknown, max?: number): Partial<Record<K, PageNamedText>> => {
  const parts = namedTextOf(value, max);
  return parts ? ({ [key]: parts } as Record<K, PageNamedText>) : {};
};

/** 宿主交来的样子（JSON 解出来的）：认不得的当 undefined，字段按形状收拾（宿主是可信的，这里只防写错） */
export function bubbleViewOf(value: unknown): PageBubbleView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const kind = str(v.kind, 20);
  if (!KINDS.includes(kind)) return undefined;
  const fieldId = str(v.fieldId, 20);
  const said = str(v.said);
  const text = str(v.text);
  switch (kind) {
    case "chooser":
      return { kind, fieldId, text };
    case "input":
      return { kind, fieldId, label: str(v.label, 200), ...withParts("labelParts", v.labelParts, 200), placeholder: str(v.placeholder, 200) };
    case "listening":
      return { kind, fieldId, label: str(v.label, 200), ...withParts("labelParts", v.labelParts, 200), levels: Array.isArray(v.levels) ? v.levels.slice(-100).map((n) => (typeof n === "number" ? n : 0)) : [] };
    case "busy":
      // 宿主没给那一句时画"二狗在想……"（按页面桥现在的语言，见 render）；说到助理的那一句另给几段（181 号票）
      return { kind, fieldId, said, text, ...withParts("textParts", v.textParts) };
    case "reply":
      return { kind, fieldId, said, text, failed: v.failed === true, system: v.system === true, more: v.more === true };
    default:
      return NONE;
  }
}

/** 建一个元素，带上 class 和字（字用 textContent） */
export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 一句带名字的话画进 parent（181 号票）：字是字，名字是名字标签（span.name）；都用 textContent */
export function appendNamed(doc: Document, parent: HTMLElement, parts: PageNamedText): void {
  for (const part of parts) parent.append(typeof part === "string" ? doc.createTextNode(part) : el(doc, "span", "name", part.name));
}

/** 宿主交来的几段（JSON 解出来的）：字和 { name }，别的不认；一段都没有是 undefined */
export function namedTextOf(value: unknown, max = 4000): PageNamedText | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PageNamedPart[] = [];
  for (const part of value.slice(0, 20)) {
    if (typeof part === "string") out.push(part.slice(0, max));
    else if (typeof part === "object" && part !== null && typeof (part as { name?: unknown }).name === "string") out.push({ name: (part as { name: string }).name.slice(0, 40) });
  }
  return out.length > 0 ? out : undefined;
}

/** 一个按钮：按下不抢焦点（打字框里的输入法不收），点了才算（只认真的用户操作） */
export function makeButton(doc: Document, className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el(doc, "button", className, text);
  b.type = "button";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    if (e.isTrusted && !b.disabled) onClick();
  });
  return b;
}

/** 气泡、挑图片窗口里的按键、输入、点按不往网页里冒泡（网站的快捷键、点外面就关的菜单） */
export function stopBubbling(root: HTMLElement): void {
  for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "copy", "cut", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "focusin", "focusout", "wheel", "contextmenu"]) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
}

export function createBubble(doc: Document, tools: BubbleTools, onAction: (action: PageBubbleAction) => void): Bubble {
  const tx = tools.texts;
  const root = el(doc, "div", "bubble");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", tx.get("bridge.bubble.title"));
  const tail = el(doc, "i", "tail");
  const head = el(doc, "div", "head");
  const label = el(doc, "span", "label");
  const close = el(doc, "button", "x");
  close.type = "button";
  close.setAttribute("aria-label", tx.get("bridge.bubble.close"));
  close.innerHTML = ICON_CLOSE;
  head.append(label, close);
  const body = el(doc, "div", "body");
  const foot = el(doc, "div", "foot");
  root.append(tail, head, body, foot);

  let view: PageBubbleView = NONE;
  /** 打字框（打字的样子时有） */
  let textarea: HTMLTextAreaElement | undefined;
  let sendButton: HTMLButtonElement | undefined;
  /** 在听：开始的时刻、波形的竖条、秒数 */
  let listenStart = 0;
  let bars: HTMLElement[] = [];
  let timeText: HTMLElement | undefined;
  let hintText: HTMLElement | undefined;
  let cancelZone = false;
  let lastPlace = "";
  let lastTime = "";

  stopBubbling(root);
  // 按 Esc 收起
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.isTrusted && view.kind !== "listening") {
      e.preventDefault();
      act({ action: "close" });
    }
  });

  const act = (action: PageBubbleAction) => {
    if (action.action === "close" || action.action === "sidebar") hide();
    onAction(action);
  };

  const button = (className: string, text: string, onClick: () => void) => makeButton(doc, className, text, onClick);
  /** 字里有名字的按钮（181 号票："让二狗选"） */
  const namedButton = (className: string, parts: PageNamedText, onClick: () => void) => {
    const b = makeButton(doc, className, "", onClick);
    appendNamed(doc, b, parts);
    return b;
  };
  /** 顶上那一行：名字画成名字标签 */
  const setLabel = (parts: PageNamedText) => {
    label.replaceChildren();
    appendNamed(doc, label, parts);
  };
  close.addEventListener("mousedown", (e) => e.preventDefault());
  close.addEventListener("click", (e) => {
    if (e.isTrusted) act({ action: "close" });
  });

  const saidAndText = (said: string, text: string, failed = false) => {
    if (said) body.append(el(doc, "p", "said", said));
    if (text) body.append(el(doc, "p", `text${failed ? " failed" : ""}`, text));
  };

  const resetParts = () => {
    textarea = undefined;
    sendButton = undefined;
    bars = [];
    timeText = undefined;
    hintText = undefined;
  };

  const fitInput = () => {
    if (!textarea) return;
    textarea.style.height = "auto";
    const border = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${Math.min(INPUT_MAX_HEIGHT, textarea.scrollHeight + border)}px`;
    if (sendButton) sendButton.disabled = textarea.value.trim() === "";
  };

  const sendText = () => {
    const text = textarea?.value.trim() ?? "";
    if (!text) return;
    act({ action: "send", text: text.slice(0, TEXT_MAX) });
  };

  const buildInput = (v: Extract<PageBubbleView, { kind: "input" }>) => {
    const row = el(doc, "div", "input-row");
    const t = el(doc, "textarea");
    t.rows = 1;
    t.maxLength = TEXT_MAX;
    t.placeholder = v.placeholder;
    t.setAttribute("aria-label", v.label || tx.get("bridge.talkTo.ergo"));
    t.setAttribute("enterkeyhint", "enter");
    t.autocomplete = "off";
    t.addEventListener("input", fitInput);
    // 回车换行（和二狗的输入框一样），Ctrl / ⌘ + 回车发出去
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.isTrusted) {
        e.preventDefault();
        sendText();
      }
    });
    const send = button("send", "", sendText);
    send.innerHTML = ICON_SEND;
    send.setAttribute("aria-label", tx.get("bridge.bubble.send"));
    send.disabled = true;
    row.append(t, send);
    foot.append(row);
    textarea = t;
    sendButton = send;
  };

  const buildListening = () => {
    const wave = el(doc, "div", "wave");
    wave.setAttribute("aria-hidden", "true");
    bars = Array.from({ length: WAVE_BARS }, () => el(doc, "i"));
    wave.append(...bars);
    body.append(wave);
    const row = el(doc, "div", "voice-row");
    timeText = el(doc, "span", "time", recordedText(0));
    hintText = el(doc, "span", "hint");
    row.append(timeText, hintText);
    foot.append(row);
    lastTime = "";
  };

  const updateListening = (levels: readonly number[]) => {
    const heights = waveBars(levels, bars.length);
    bars.forEach((b, i) => {
      b.style.height = `${heights[i]}%`;
    });
    if (hintText) hintText.textContent = tx.get(cancelZone ? "bridge.bubble.releaseToCancel" : "bridge.bubble.releaseToSend");
    root.classList.toggle("cancel", cancelZone);
  };

  const render = (next: PageBubbleView) => {
    const prev = view;
    view = next;
    if (next.kind === "none") {
      root.classList.remove("on", "cancel");
      resetParts();
      body.replaceChildren();
      foot.replaceChildren();
      lastPlace = "";
      return;
    }
    if (!root.classList.contains("on")) {
      root.classList.add("on", "placing");
      lastPlace = "";
    }
    // 同一种里会变的：打字框留着（打了一半的字不丢）、在听只改竖条
    if (next.kind === "input" && prev.kind === "input" && textarea) {
      setLabel(next.labelParts ?? [next.label]);
      textarea.placeholder = next.placeholder;
      return;
    }
    if (next.kind === "listening" && prev.kind === "listening" && bars.length > 0) {
      setLabel(next.labelParts ?? [next.label]);
      updateListening(next.levels);
      return;
    }
    const scrollTop = prev.kind === next.kind ? body.scrollTop : 0;
    resetParts();
    body.replaceChildren();
    foot.replaceChildren();
    root.classList.remove("cancel");
    close.style.display = next.kind === "listening" ? "none" : "";
    setLabel(next.kind === "input" || next.kind === "listening" ? (next.labelParts ?? [next.label]) : tx.parts("bridge.bubble.title"));
    switch (next.kind) {
      case "chooser":
        saidAndText("", next.text);
        foot.append(namedButton("btn primary", tx.parts("bridge.bubble.letErgoPick"), () => act({ action: "ergo" })), button("btn", tx.get("bridge.bubble.pickMyself"), () => act({ action: "system" })));
        break;
      case "input":
        buildInput(next);
        break;
      case "listening":
        if (prev.kind !== "listening") listenStart = tools.now();
        cancelZone = prev.kind === "listening" ? cancelZone : false;
        buildListening();
        updateListening(next.levels);
        break;
      case "busy": {
        saidAndText(next.said, "");
        // 字放进一个 span：.thinking 是 flex（前面转圈），名字标签和字要排在同一段里
        const line = el(doc, "span");
        appendNamed(doc, line, next.textParts ?? (next.text ? [next.text] : tx.parts("bridge.bubble.thinking")));
        const p = el(doc, "p", "thinking");
        p.append(line);
        body.append(p);
        break;
      }
      case "reply":
        saidAndText(next.said, next.text, next.failed);
        if (next.system) foot.append(button("btn", tx.get("bridge.bubble.pickMyself"), () => act({ action: "system" })));
        // 回话太长（147 号票）：去浏览侧边栏看全文（回话也记在秘书的会话里）
        if (next.more) foot.append(button("btn", tx.get("bridge.bubble.seeInSidebar"), () => act({ action: "sidebar" })));
        break;
    }
    body.scrollTop = scrollTop;
  };

  let lastJson = "";
  const show = (next: PageBubbleView) => {
    const json = JSON.stringify(next);
    if (json === lastJson && next.kind === view.kind) return;
    lastJson = json;
    render(next);
  };

  const hide = () => {
    lastJson = "";
    render(NONE);
  };

  return {
    el: root,
    get open() {
      return view.kind !== "none";
    },
    get view() {
      return view;
    },
    show,
    openInput(fieldId, parts) {
      if (view.kind !== "input") {
        lastJson = "";
        render({ kind: "input", fieldId, label: plainOf(parts), labelParts: parts, placeholder: "" });
      }
      textarea?.focus({ preventScroll: true });
    },
    openListening(fieldId, parts) {
      lastJson = "";
      render({ kind: "listening", fieldId, label: plainOf(parts), labelParts: parts, levels: [] });
    },
    openBusy(fieldId) {
      lastJson = "";
      render({ kind: "busy", fieldId, said: "", text: "" });
    },
    setCancelZone(on) {
      if (cancelZone === on) return;
      cancelZone = on;
      if (view.kind === "listening") updateListening(view.levels);
    },
    hide,
    relabel() {
      root.setAttribute("aria-label", tx.get("bridge.bubble.title"));
      close.setAttribute("aria-label", tx.get("bridge.bubble.close"));
      if (sendButton) sendButton.setAttribute("aria-label", tx.get("bridge.bubble.send"));
      if (view.kind === "listening") updateListening(view.levels);
      // 不是打字（打了一半的字不能丢）、在听（上面刚换过）的，照现在的样子重画一遍：标题、按钮上的字跟着换
      else if (view.kind !== "none" && view.kind !== "input") {
        lastJson = "";
        const current = view;
        view = NONE;
        render(current);
      }
    },
    frame(buttonRect, area, field) {
      if (view.kind === "none") return;
      if (view.kind === "listening" && timeText) {
        const t = recordedText(tools.now() - listenStart);
        if (t !== lastTime) {
          lastTime = t;
          timeText.textContent = t;
        }
      }
      const full = bubbleWidth(area.right - area.left);
      // 按内容要多高：气泡现在的高度，加上身子里滚不下的那一截
      const natural = root.offsetHeight - body.clientHeight + body.scrollHeight;
      // 在听：放在按钮上方（149 号票，手指在按钮上）；别的时候放在背离框的那一边
      const at = view.kind === "listening" && buttonRect ? placeListening(buttonRect, { width: full, height: natural }, area) : placeBubble(buttonRect, { width: full, height: natural }, area, field);
      const width = Math.round(at.width ?? full);
      const tailAt = at.side === "left" || at.side === "right" ? `${Math.round(at.tailY ?? 0)}` : `${Math.round(at.tailX)}`;
      const key = `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.maxHeight)},${at.side},${tailAt},${width}`;
      if (key === lastPlace) return;
      lastPlace = key;
      root.style.width = `${width}px`;
      root.style.left = `${Math.round(at.x)}px`;
      root.style.top = `${Math.round(at.y)}px`;
      root.style.maxHeight = `${Math.round(at.maxHeight)}px`;
      root.classList.remove("above", "below", "left", "right", "free", "placing");
      root.classList.add(at.side);
      if (at.side === "left" || at.side === "right") {
        tail.style.left = "";
        tail.style.top = `${Math.round(at.tailY ?? 0)}px`;
      } else {
        tail.style.top = "";
        tail.style.left = `${Math.round(at.tailX)}px`;
      }
    },
  };
}
