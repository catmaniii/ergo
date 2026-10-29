// 页面桥（134 号票第二部分）：注入到"浏览"里的网页的一小段脚本，和宿主无关（宿主怎么注入、怎么收发见 protocol.ts）。它做五件事：
// - 认框：文本框、多行文本、可编辑区域、选文件的框（含藏在网站自己画的"上传"按钮、拖放区后面的：label[for]、包着它的 label、
//   包着它的、里面没有别的要填的框的可点元素）。每个给一个编号（f1、f2……，同一个元素一直是同一个号），带上标签文字、placeholder、accept、能不能多选。
//   密码、银行卡、验证码类的框不列、不填、不出悬浮按钮（rules.ts）。交出去的只有这些，不交页面正文和框里已有的值；
// - 悬浮按钮：文本框获得焦点、上传处被点到时，在它旁边出一个二狗的小按钮（rules.ts 的 placeButton：右边放不下放下面、上面），
//   跟着框走（显示着的时候每一帧对一次位置：滚动、缩放、输入法弹出都跟得上），焦点离开就收起。按钮画在网页里的一个封闭的
//   shadow root 里（样式不受网站的 CSS 影响，网站的脚本也摸不到里面），被网站删了下次再挂上。
//   点一下报 open（按钮旁边的气泡里打字），长按报 voice（press 按下就备好录音器、按够 0.35 秒 start、松手 stop；
//   上滑 60 或划开 80 像素进"松开取消"，这时松手 cancel，挪回来又能发）。按下时 preventDefault：框不丢焦点、输入法不收；
//   只认真的用户操作（isTrusted），网页的脚本派的假事件不算；
// - 气泡（146 号票，bubble.ts）：打字、在听（实时波形、秒数）、二狗的回话、要交的文件和候选都画在按钮旁边的小气泡里，和按钮在同一个
//   封闭的 shadow root 里；样子由宿主交来（bubble 方法），用户在气泡上点了什么报 bubble。点了按钮先自己出打字框、在点的那一下里聚焦
//   （手机上输入法才弹得出来），按够了先自己出在听，不等宿主来回。气泡开着时按钮不收；点气泡外面的网页、框被用户滚出屏幕、
//   按钮挪到别的框上时收起（报 bubble close）。气泡放在按钮背离框的那一边、不盖住框（rules.ts 的 placeBubble）；输入法弹起挡住了框时
//   先把框滚回看得见的地方（框和气泡都要看得见），还是看不见就把气泡挪到看得见的地方；
// - 填字：照 React 这些框架也认的方式写值（用 HTMLInputElement / HTMLTextAreaElement 原型上的 value setter，绕开框架装在元素上的那层），
//   再派 input、change；可编辑区域用 execCommand("insertText")（编辑器认它的 beforeinput / input），不行再直接换文字；
// - 塞文件：宿主分段交来文件的字节，拼成 File、放进 DataTransfer，设进 input.files 再派 input、change；没有 input 的拖放区派
//   dragenter / dragover / drop。
// 149 号票（悬浮按钮背后就是秘书本人）：
// - 气泡只放打字、说话、回话；按住说话时气泡在按钮上方（bubble.ts、rules.ts 的 placeListening）；
// - 挑图片窗口（pick.ts）：秘书给的候选画在固定位置的窗口里，不跟着按钮、不随网页滚动，宿主经 pick 方法交来样子，点了什么报 pick；
//   开着时气泡不盖住它（气泡摆在窗口上面那一截里）；
// - 框里现在的内容（用户 2026-10-18："我在网页选中文本框的时候，二狗读不到文本框的内容"）：选中的框（报 selected、selected()）、
//   悬浮按钮所在的框（open、voice、气泡上的 send）带上框里那一刻的内容（PageField.value，最多 FIELD_VALUE_MAX 字）；框里的字变了
//   （用户打字、网页自己改）过一会儿再报一次 selected。密码类的框本来就不认，照旧不读；框的列表（fields()）照旧不带内容。
// 147 号票（浏览侧边栏）再加三样：
// - 选中的框：点进一个能填的框、点了上传处就选中它，焦点离开也不丢（用户转去侧边栏里打字时还记着），换了另一个框、框从页面上没了
//   （每秒看一眼）、宿主让取消才变，变了就报 selected；装上时报一次"没选中"（新的一页）。宿主调 selected() 现问；
// - 整页文字：text() 交看得见的正文文字（innerText，脚本、样式本来就不在里面；拿不到时自己走一遍 DOM、跳过脚本样式），
//   收拾空白、截到 PAGE_TEXT_MAX 字（rules.ts 的 tidyPageText）；
// - 秘书的填字、交文件照旧用 fill、attachFiles，宿主核对过是选中的框才调。
// 164 号票（用户 2026-10-19：秘书点不了链接和按钮）再加两样（clickables.ts）：snapshot 列能点的东西（编号只记在页面桥的内存里，
// 不写进网页的 DOM；页面桥自己这一层不列）、click 按编号点（先核对还是那一页、元素还在、文字没变）。点什么由秘书经守护进程定，
// 守护进程那边拦着支付、提交、删除这类字眼的（"这一步建议你自己点"）；页面桥自己不会主动点、不会提交表单。
// 184 号票（用户 2026-10-20：希望在一页里自动交图 → 自动填字 → 自动点按钮，不用每次都由人先点中框）：snapshot 也列文本框、上传框
// （藏起来的也列）、下拉框（只能看），和能点的同一套编号；refField 按编号找要填的文本框、要交的上传框（照点的核对：还是那一页、
// 编号认得、元素还在、种类没变），回框的说法（页面桥的框编号 f…），宿主再照原来的 fill、attachFiles 填、交。
// 用到的内置函数（JSON、原型上的 setter、DataTransfer、File、atob……）都在注入的那一刻记下来，网页的脚本之后再改它们也碍不着。
import type { PageField, PageFieldKind } from "@ergo/protocol";
import { BUBBLE_STYLE, bubbleViewOf, createBubble, nameTagStyle } from "./bubble.ts";
import { createClickables } from "./clickables.ts";
import { createPickWindow, PICK_STYLE, pickViewOf } from "./pick.ts";
import type { PageBridgeApi, PageBridgeEvent, PageBridgeMark, PageBubbleAction, PageBubbleView, PageInfo, PageNamedText, PagePickView } from "./protocol.ts";
import { BUBBLE_GAP, BUTTON_SIZE, cleanLabel, FIELD_VALUE_MAX, inVoiceCancelZone, isSensitiveField, placeButton, type Rect, TEXT_INPUT_TYPES, tidyPageText } from "./rules.ts";
import { bridgeTextsOf, createBridgeTexts } from "./texts.ts";

/** 一页最多列多少个框（和协议的 PAGE_FIELDS_MAX 一样；这里不引用协议包的值，页面桥的脚本里只有类型） */
const FIELDS_MAX = 60;
/** 按多久算长按（毫秒） */
const LONG_PRESS_MS = 350;
/** 焦点离开框之后多久收起按钮（毫秒）：焦点在框之间换来换去时不闪 */
const HIDE_DELAY_MS = 150;
/** 点气泡外面的网页：按下到抬起挪了多少以内算点（多了是在滚页面，不收） */
const TAP_SLOP = 10;
/** 用户滚过页面之后多久以内框出了屏幕算"滚出去了"（气泡收起）；输入法弹起挡住框不算（没有滚动） */
const SCROLL_CLOSE_MS = 500;
/** 看得见的部分比气泡开着时最高的时候矮了这么多，算输入法弹起来了（这时挡住了框就把框滚回来） */
const KEYBOARD_MIN = 100;
/** 手指划、滚轮之后多久以内的滚动算用户滚的（手指离开后页面还会惯性滚一阵）；输入法弹起时浏览器自己滚的不算 */
const GESTURE_SCROLL_MS = 1500;
/** 选中的框多久看一眼还在不在页面上、里面的字变没变（毫秒） */
const SELECTION_CHECK_MS = 1000;
/** 选中的框里打了字之后多久再报一次（毫秒）：连着打字时不每个字都报 */
const VALUE_REPORT_MS = 300;
/** 自己走 DOM 取文字时跳过的元素 */
const NO_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "HEAD"]);

/** 二狗的小按钮上画的：一个对话气泡里一颗星（白色），在听时是话筒 */
const ICON_IDLE =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8 8 0 0 1-8 8H8l-4 3v-5.2A8 8 0 0 1 11.5 4h1a8 8 0 0 1 8 8z"/><path d="M12 8.2l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" fill="currentColor" stroke-width="1.2"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

const STYLE = `
:host { all: initial; }
.fab {
  position: fixed; left: 0; top: 0; width: ${BUTTON_SIZE}px; height: ${BUTTON_SIZE}px; box-sizing: border-box;
  display: none; align-items: center; justify-content: center;
  border-radius: 50%; background: linear-gradient(145deg, #5b8cff, #3a5bd9); color: #fff;
  box-shadow: 0 2px 8px rgba(30, 50, 120, .35), 0 0 0 2px rgba(255, 255, 255, .9);
  cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  transition: transform .12s ease;
}
.fab.on { display: flex; }
.fab:active { transform: scale(.92); }
.fab.listening { background: linear-gradient(145deg, #ff6b6b, #e03131); animation: ergo-pulse 1s ease-out infinite; }
.fab.busy::after {
  content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid transparent; border-top-color: #3a5bd9; animation: ergo-spin .8s linear infinite;
}
@keyframes ergo-pulse { 0% { box-shadow: 0 0 0 0 rgba(224, 49, 49, .55), 0 0 0 2px #fff; } 100% { box-shadow: 0 0 0 14px rgba(224, 49, 49, 0), 0 0 0 2px #fff; } }
@keyframes ergo-spin { to { transform: rotate(360deg); } }
${BUBBLE_STYLE}
${PICK_STYLE}`;

/** 看得见（有大小） */
function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** 悬浮按钮摆在哪（视口坐标）：照看得见的部分（area）摆，框不在看得见的部分里是 undefined */
function buttonAt(anchor: Element, area: Rect): { x: number; y: number } | undefined {
  const r = anchor.getBoundingClientRect();
  if (!anchor.isConnected || r.width + r.height <= 0) return undefined;
  const rect: Rect = { left: r.left - area.left, top: r.top - area.top, right: r.right - area.left, bottom: r.bottom - area.top };
  const at = placeButton(rect, { width: area.right - area.left, height: area.bottom - area.top });
  return at ? { x: at.x + area.left, y: at.y + area.top } : undefined;
}

/** 按钮上的按下、抬起：不让网页收到、不让框丢焦点 */
function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

/** 网页的 window 里用到的那一点（就是 window；写成参数，测试在真浏览器里装多次） */
export type BridgeWindow = Window & typeof globalThis;

/**
 * 装上页面桥：nonce 是宿主给的口令，post 把一条话（JSON）交给宿主。返回给宿主调的入口（宿主再把它挂到 window.__ergoPage 上）
 */
export function installPageBridge(win: BridgeWindow, nonce: string, post: (json: string) => void): PageBridgeApi {
  const doc = win.document;
  // 注入的那一刻记下内置函数：网页的脚本之后改了也碍不着
  const stringify = win.JSON.stringify.bind(win.JSON);
  const parse = win.JSON.parse.bind(win.JSON);
  const inputValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  const textareaValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
  const inputFiles = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "files")?.set;
  const DataTransferCtor = win.DataTransfer;
  const FileCtor = win.File;
  const EventCtor = win.Event;
  const InputEventCtor = win.InputEvent;
  const DragEventCtor = win.DragEvent;
  const decode = win.atob.bind(win);
  const execCommand = doc.execCommand.bind(doc);
  const raf = win.requestAnimationFrame.bind(win);
  const setTimer = win.setTimeout.bind(win);
  const clearTimer = win.clearTimeout.bind(win);
  const makeBitmap = win.createImageBitmap.bind(win);
  const BlobCtor = win.Blob;
  const perf = win.performance;
  const now = () => perf.now();
  const setRepeat = win.setInterval.bind(win);
  const clearRepeat = win.clearInterval.bind(win);
  const innerText = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "innerText")?.get;
  const inputValueGet = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.get;
  const textareaValueGet = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.get;
  // 页面桥自己的字（169 号票）：二狗的网页经宿主交来当前语言的（texts 方法），没交来是中文
  const texts = createBridgeTexts();
  /** 上次交来的几句（JSON） */
  let textsJson = "";

  const send = (event: PageBridgeEvent) => {
    try {
      post(stringify({ nonce, ...event }));
    } catch {
      // 宿主不在了：不报
    }
  };

  // ---------- 认框 ----------
  const ids = new WeakMap<Element, string>();
  const byId = new Map<string, WeakRef<Element>>();
  let nextId = 1;
  const idOf = (el: Element): string => {
    let id = ids.get(el);
    if (!id) {
      id = `f${nextId++}`;
      ids.set(el, id);
      byId.set(id, new WeakRef(el));
    }
    return id;
  };
  const elementOf = (id: string): Element | undefined => {
    const el = byId.get(id)?.deref();
    return el && el.isConnected ? el : undefined;
  };

  /** 可编辑区域往上找到它的编辑宿主（contenteditable 的那一层） */
  const editingHost = (el: Element): HTMLElement | undefined => {
    if (!(el instanceof win.HTMLElement) || !el.isContentEditable) return undefined;
    let host: HTMLElement = el;
    while (host.parentElement instanceof win.HTMLElement && host.parentElement.isContentEditable) host = host.parentElement;
    return host;
  };

  const kindOf = (el: Element): PageFieldKind | undefined => {
    if (el instanceof win.HTMLTextAreaElement) return "textarea";
    if (el instanceof win.HTMLInputElement) {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (type === "file") return "file";
      return TEXT_INPUT_TYPES.includes(type) ? "text" : undefined;
    }
    if (el instanceof win.HTMLElement && el.isContentEditable && editingHost(el) === el) return "editable";
    return undefined;
  };

  const textOfIds = (list: string | null): string => (list ?? "").split(/\s+/).map((id) => (id ? doc.getElementById(id)?.textContent ?? "" : "")).join(" ");

  /** 标签文字：label[for]、包着它的 label、aria-labelledby、aria-label、title */
  const labelOf = (el: Element): string => {
    const id = el.getAttribute("id");
    const forLabel = id ? Array.from(doc.querySelectorAll("label")).find((l) => l.htmlFor === id) : undefined;
    const candidates = [
      forLabel?.textContent,
      el.closest("label")?.textContent,
      textOfIds(el.getAttribute("aria-labelledby")),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
    ];
    for (const c of candidates) {
      const text = cleanLabel(c);
      if (text) return text;
    }
    return "";
  };

  const isSensitive = (el: Element): boolean =>
    isSensitiveField({
      type: el.getAttribute("type") ?? "",
      autocomplete: el.getAttribute("autocomplete") ?? "",
      hints: [el.getAttribute("name") ?? "", el.getAttribute("id") ?? "", el.getAttribute("placeholder") ?? "", el.getAttribute("aria-label") ?? "", labelOf(el)],
    });

  /** 能填：认得的框、不是密码类、没禁用、不是只读（选文件的框不看只读） */
  const fillable = (el: Element): PageFieldKind | undefined => {
    const kind = kindOf(el);
    if (!kind || isSensitive(el)) return undefined;
    if ((el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) && (el.disabled || (kind !== "file" && el.readOnly))) return undefined;
    return kind;
  };

  /** 选文件的框露在外面的那个东西：它自己看得见就是它，不然 label[for]、包着它的 label、往上几层里第一个看得见的上传处（网站画的上传按钮、拖放区，见 uploadArea） */
  /**
   * 一个元素算不算这个选文件的框的"上传处"（网站画的上传按钮、拖放区）：里面只有这一个选文件的框，也没有别的要填的框
   * （文本框、下拉、可编辑区域）——不然点到整张表单的空白处也当成点了上传
   */
  const uploadArea = (area: Element, input: HTMLInputElement): boolean => {
    if (area === doc.body || area === doc.documentElement) return false;
    const files = area.querySelectorAll('input[type="file" i]');
    if (files.length !== 1 || files[0] !== input) return false;
    return area.querySelector('textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="file" i]):not([type="hidden" i]):not([type="button" i]):not([type="submit" i]):not([type="reset" i]):not([type="image" i])') === null;
  };

  /** 往上几层里第一个看得见的上传处（网站画的上传按钮、拖放区） */
  const areaOf = (input: HTMLInputElement): Element | undefined => {
    let up = input.parentElement;
    for (let i = 0; up && i < 4 && uploadArea(up, input); i++, up = up.parentElement) {
      if (visible(up)) return up;
    }
    return undefined;
  };

  const triggerOf = (input: HTMLInputElement): Element | undefined => {
    if (visible(input)) return input;
    const id = input.getAttribute("id");
    const forLabel = id ? Array.from(doc.querySelectorAll("label")).find((l) => l.htmlFor === id && visible(l)) : undefined;
    if (forLabel) return forLabel;
    const wrap = input.closest("label");
    if (wrap && visible(wrap)) return wrap;
    return areaOf(input);
  };

  const describe = (el: Element, kind: PageFieldKind): PageField => {
    const field: PageField = { id: idOf(el), kind, label: labelOf(el) };
    const placeholder = cleanLabel(el.getAttribute("placeholder"));
    if (placeholder) field.placeholder = placeholder;
    if (el instanceof win.HTMLInputElement) {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (kind === "text" && type !== "text") field.inputType = type;
      if (kind === "file") {
        if (el.accept) field.accept = el.accept.slice(0, 200);
        if (el.multiple) field.multiple = true;
        // 选文件的框多半没有标签：拿网站画的上传按钮上的字
        if (!field.label) {
          const trigger = triggerOf(el);
          if (trigger && trigger !== el) field.label = cleanLabel(trigger.textContent);
        }
      }
    }
    return field;
  };

  /** 框里现在的字（149 号票）：文本框取 value（照原型上的 getter，React 受控的框也是现在显示的字），可编辑区域取看得见的文字 */
  const valueOf = (el: Element, kind: PageFieldKind): string | undefined => {
    if (kind === "file") return undefined;
    try {
      if (el instanceof win.HTMLInputElement) return String(inputValueGet ? inputValueGet.call(el) : el.value);
      if (el instanceof win.HTMLTextAreaElement) return String(textareaValueGet ? textareaValueGet.call(el) : el.value);
      const text = innerText?.call(el as HTMLElement);
      return typeof text === "string" ? text.replace(/\n$/, "") : (el.textContent ?? "");
    } catch {
      return undefined;
    }
  };

  /** 框的说法连同框里这一刻的内容（选中的框、悬浮按钮所在的框；截到 FIELD_VALUE_MAX 字，total 写一共多少字） */
  const describeNow = (el: Element, kind: PageFieldKind): PageField => {
    const field = describe(el, kind);
    const value = valueOf(el, kind);
    if (value !== undefined) field.value = { text: value.slice(0, FIELD_VALUE_MAX), total: value.length };
    return field;
  };

  const pageInfo = (): PageInfo => ({ title: (doc.title || "").slice(0, 300), url: `${win.location.origin}${win.location.pathname}` });

  /** 页面上能填的框（按出现的先后）：看得见的文本类框，和有露在外面的东西的选文件的框 */
  const listFields = (): PageField[] => {
    const out: PageField[] = [];
    for (const el of Array.from(doc.querySelectorAll("input, textarea, [contenteditable]"))) {
      if (out.length >= FIELDS_MAX) break;
      const kind = fillable(el);
      if (!kind) continue;
      if (kind === "file" ? !triggerOf(el as HTMLInputElement) : !visible(el)) continue;
      out.push(describe(el, kind));
    }
    return out;
  };

  // ---------- 选中的框、整页文字（147 号票，浏览侧边栏） ----------
  let chosen: { el: Element; kind: PageFieldKind } | undefined;
  let chosenWatch: number | undefined;
  /** 上次报的选中的框里的字（变了再报，149 号票）；打字之后等一会儿再报的计时 */
  let reportedValue: string | undefined;
  let valueTimer: number | undefined;
  const reportSelected = () => {
    if (valueTimer !== undefined) clearTimer(valueTimer);
    valueTimer = undefined;
    const field = chosen ? describeNow(chosen.el, chosen.kind) : null;
    reportedValue = chosen ? valueOf(chosen.el, chosen.kind) : undefined;
    send({ type: "selected", field, page: pageInfo() });
  };
  /** 选中的框里的字可能变了：变了就过一会儿再报（连着打字时不每个字都报） */
  const valueMaybeChanged = () => {
    if (!chosen || valueTimer !== undefined || valueOf(chosen.el, chosen.kind) === reportedValue) return;
    valueTimer = setTimer(() => {
      valueTimer = undefined;
      if (chosen && valueOf(chosen.el, chosen.kind) !== reportedValue) reportSelected();
    }, VALUE_REPORT_MS);
  };
  const unselect = () => {
    if (!chosen) return;
    chosen = undefined;
    if (chosenWatch !== undefined) clearRepeat(chosenWatch);
    chosenWatch = undefined;
    reportSelected();
  };
  const select = (el: Element, kind: PageFieldKind) => {
    if (chosen?.el === el) return;
    chosen = { el, kind };
    reportSelected();
    chosenWatch ??= setRepeat(() => {
      if (chosen && !chosen.el.isConnected) unselect();
      // 网页自己改了框里的字（没有 input 事件）：一秒内也报上去
      else valueMaybeChanged();
    }, SELECTION_CHECK_MS);
  };

  /** 自己走一遍 DOM 取文字（innerText 拿不到时）：跳过脚本、样式这些，块和换行处断行 */
  const walkText = (node: Node, out: string[]) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (!(node instanceof win.Element) || NO_TEXT_TAGS.has(node.tagName.toUpperCase())) return;
    if (node.tagName === "BR") out.push("\n");
    for (const child of Array.from(node.childNodes)) walkText(child, out);
    if (/^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|PRE|TABLE|UL|OL|DL|DT|DD)$/.test(node.tagName)) out.push("\n");
  };
  const pageText = (): string => {
    const body = doc.body;
    if (!body) return "";
    try {
      const text = innerText?.call(body);
      if (typeof text === "string") return text;
    } catch {
      // 拿不到：自己走
    }
    const out: string[] = [];
    walkText(body, out);
    return out.join("");
  };

  // ---------- 悬浮按钮 ----------
  const hostEl = doc.createElement("div");
  hostEl.setAttribute("style", "all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;");
  const shadow = hostEl.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = STYLE;
  // 名字标签的颜色（181 号票）：二狗的网页交来的，盖过样式表里经典的；没交来是空的
  const tagStyle = doc.createElement("style");
  const fab = doc.createElement("div");
  fab.className = "fab";
  fab.setAttribute("role", "button");
  fab.setAttribute("aria-label", texts.get("bridge.fab.label"));
  fab.innerHTML = ICON_IDLE;
  const bubble = createBubble(doc, { now, texts }, (action) => bubbleAction(action));
  // 挑图片窗口（149 号票）：排在最上面
  const pickWindow = createPickWindow(doc, { decode, makeBitmap, BlobCtor, texts }, (action) => send({ type: "pick", ...action }));
  shadow.append(style, tagStyle, bubble.el, fab, pickWindow.el);
  // 能点的东西（164 号票）：页面桥自己这一层（hostEl）不列；184 号票起连同能填、能交、能选的框（认框用上面这一套）
  const clickables = createClickables({
    win,
    own: hostEl,
    pageInfo,
    ...(innerText ? { innerText } : {}),
    fields: { kindOf: fillable, describe, valueOf, anchorOf: triggerOf, areaOf, labelOf, sensitive: isSensitive, reason: (key, ref) => texts.get(key, { ref }) },
  });

  /** 按钮挂在哪个框上（填字的框本身，或选文件的框）、贴着哪个元素摆 */
  let current: { el: Element; anchor: Element; kind: PageFieldKind } | undefined;
  let mark: PageBridgeMark = "idle";
  let hideTimer: number | undefined;
  let tracking = false;
  let lastPos = "";
  /** 用户最近一次滚页面（或网页里某一块）的时刻；最近一次手指划、滚轮的时刻 */
  let lastScroll = -Infinity;
  let lastGesture = -Infinity;
  /** 气泡开着时在气泡外面按下的那一下（抬起时挪得不多就是点了外面） */
  let outside: { x: number; y: number; id: number } | undefined;
  /** 气泡开着以来看得见的部分最高多高；输入法弹起挡住了框时把框滚回来过的那次（看得见的部分多高）：同一次只滚一回 */
  let tallestArea = 0;
  let revealedFor = "";

  const ensureHost = () => {
    if (!hostEl.isConnected) (doc.documentElement ?? doc.body)?.appendChild(hostEl);
  };

  /** 看得见的部分（视口坐标）：输入法弹起、双指放大时比视口小（visualViewport），没有它就是整个视口 */
  const visibleArea = (): Rect => {
    const vv = win.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) return { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
    return { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  };

  const place = () => {
    if (!bubble.open) {
      tallestArea = 0;
      revealedFor = "";
    }
    if (!current && !bubble.open && !pickWindow.open) {
      tracking = false;
      return;
    }
    const area = visibleArea();
    // 挑图片窗口固定在看得见的部分的底部（不跟着按钮、不随网页滚动）；开着时气泡摆在它上面那一截里，不盖住它
    const pickRect = pickWindow.frame(area);
    const bubbleArea = pickRect ? { ...area, bottom: Math.max(area.top, Math.min(area.bottom, pickRect.top - BUBBLE_GAP)) } : area;
    const at = current ? buttonAt(current.anchor, area) : undefined;
    const pos = at ? `${Math.round(at.x)},${Math.round(at.y)}` : "";
    if (pos !== lastPos) {
      lastPos = pos;
      if (at) {
        fab.style.transform = "";
        fab.style.left = `${Math.round(at.x)}px`;
        fab.style.top = `${Math.round(at.y)}px`;
      }
      fab.classList.toggle("on", at !== undefined);
    }
    if (bubble.open) placeBubble(bubbleArea, at);
    raf(place);
  };

  /**
   * 气泡跟着按钮摆：气泡跟的是现在挂按钮的框时贴着按钮、不盖住框，框被用户滚出屏幕、被网页删了就收起；输入法弹起挡住了框（没有用户滚动）
   * 不收：先把框滚回看得见的地方（scrollIntoView，同一次输入法弹起只滚一回），还是看不见就把气泡放在看得见的部分下面。
   * 不知道跟哪个框的放在下面居中。在听的时候手指还按着按钮，不收
   */
  const placeBubble = (area: Rect, at: { x: number; y: number } | undefined) => {
    const view = bubble.view;
    const fieldId = view.kind === "none" ? "" : view.fieldId;
    const anchored = fieldId !== "" && current !== undefined && idOf(current.el) === fieldId;
    let field: Rect | undefined;
    if (anchored && current) {
      if (view.kind !== "listening" && (!current.anchor.isConnected || (!at && now() - lastScroll < SCROLL_CLOSE_MS))) {
        closeBubble();
        return;
      }
      const height = Math.round(area.bottom - area.top);
      tallestArea = Math.max(tallestArea, height);
      if (!at && height < tallestArea - KEYBOARD_MIN && revealedFor !== `${height}`) {
        revealedFor = `${height}`;
        current.anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const r = current.anchor.getBoundingClientRect();
      field = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    bubble.frame(anchored && at ? { left: at.x, top: at.y, right: at.x + BUTTON_SIZE, bottom: at.y + BUTTON_SIZE } : undefined, area, at ? field : undefined);
  };

  const startTracking = () => {
    if (!tracking) {
      tracking = true;
      raf(place);
    }
  };

  const setMark = (next: PageBridgeMark) => {
    mark = next;
    fab.classList.toggle("listening", next === "listening");
    fab.classList.toggle("busy", next === "busy");
    fab.innerHTML = next === "listening" ? ICON_MIC : ICON_IDLE;
  };

  /** 按钮挂到这个框上；forBubble：是宿主交来的气泡要跟着这个框（不是用户换了框，开着的气泡不收） */
  const show = (el: Element, kind: PageFieldKind, anchor: Element, forBubble = false) => {
    if (hideTimer !== undefined) clearTimer(hideTimer);
    hideTimer = undefined;
    const changed = current?.el !== el;
    // 用户换到别的框上了：开着的气泡是上一个框的，收起
    if (changed && !forBubble && bubble.open && bubble.view.kind !== "listening") closeBubble(false);
    current = { el, anchor, kind };
    ensureHost();
    if (changed) {
      if (mark !== "busy") setMark("idle");
      lastPos = "";
      send({ type: "field", field: describe(el, kind) });
    }
    startTracking();
  };

  const hide = () => {
    if (!current || press || bubble.open) return;
    current = undefined;
    lastPos = "";
    fab.classList.remove("on");
    if (mark !== "busy") setMark("idle");
    send({ type: "field", field: null });
  };

  const hideSoon = () => {
    if (hideTimer !== undefined) clearTimer(hideTimer);
    hideTimer = setTimer(() => {
      hideTimer = undefined;
      // 焦点还在一个能填的框里（比如换到了同一个编辑器里的另一处）、在气泡里打字（焦点在页面桥自己的 shadow root 里）不收
      if (bubble.open || focusStays()) return;
      hide();
    }, HIDE_DELAY_MS);
  };

  /** 焦点还在按钮挂着的框里 */
  const focusStays = (): boolean => {
    const active = deepActive();
    return active !== null && current !== undefined && (active === current.el || current.el.contains(active));
  };

  /** 收起气泡、报给宿主；reevaluate：焦点已经不在框里的话按钮也跟着收（上传处的按钮照旧等点到别处才收） */
  const closeBubble = (reevaluate = true) => {
    if (!bubble.open) return;
    bubble.hide();
    send({ type: "bubble", action: "close" });
    if (reevaluate) afterBubbleClosed();
  };

  const afterBubbleClosed = () => {
    if (current && current.kind !== "file" && !press && !focusStays()) hide();
  };

  /** 按钮挂着的框在气泡上怎么称呼："对「标题」说"；没有框是"对二狗说"（名字画成名字标签，181 号票） */
  const labelOfCurrent = (): PageNamedText => {
    if (!current) return texts.parts("bridge.talkTo.ergo");
    const field = describe(current.el, current.kind);
    const name = field.label || field.placeholder || "";
    if (name) return texts.parts("bridge.talkTo.named", { name });
    return texts.parts(current.kind === "file" ? "bridge.talkTo.upload" : "bridge.talkTo.field");
  };

  /** 气泡上点的：报给宿主；"让二狗选"先自己出打字框（在点的那一下里聚焦，输入法弹得出来）；发送带上按钮所在的框和框里这一刻的内容 */
  const bubbleAction = (action: PageBubbleAction) => {
    const view = bubble.view;
    if (action.action === "ergo" && view.kind === "chooser") bubble.openInput(view.fieldId, texts.parts("bridge.talkTo.ergo"));
    if (action.action === "send" && current && view.kind !== "none" && view.fieldId === idOf(current.el)) action = { ...action, field: describeNow(current.el, current.kind) };
    send({ type: "bubble", ...action });
    if (action.action === "close" || action.action === "sidebar") afterBubbleClosed();
  };

  /** 宿主交来气泡的样子：要跟着的框按钮没挂在上面（拦下的对话框认出来的框）就挪过去；收起时焦点不在框里的按钮也收 */
  const applyBubble = (view: PageBubbleView) => {
    if (view.kind === "none") {
      const was = bubble.open;
      bubble.show(view);
      if (was) afterBubbleClosed();
      return;
    }
    if (view.fieldId && (!current || idOf(current.el) !== view.fieldId)) {
      const el = elementOf(view.fieldId);
      const kind = el ? fillable(el) : undefined;
      const anchor = el && kind ? (kind === "file" ? triggerOf(el as HTMLInputElement) : el) : undefined;
      if (el && kind && anchor) show(el, kind, anchor, true);
    }
    ensureHost();
    bubble.show(view);
    startTracking();
  };

  /** 现在有焦点的元素（进到网页自己的 shadow root 里找） */
  const deepActive = (): Element | null => {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  /** 事件真正落在的元素（网页自己的 shadow root 里的也找得到） */
  const targetOf = (e: Event): Element | undefined => {
    const first = e.composedPath()[0];
    return first instanceof win.Element ? first : undefined;
  };

  const isFile = (x: Element | null | undefined): x is HTMLInputElement => x instanceof win.HTMLInputElement && (x.getAttribute("type") ?? "").toLowerCase() === "file";

  /** 点到的元素有没有关联一个选文件的框：它自己、label[for] / 包着的 label 的控件、往上几层里面包着的 input[type=file] */
  const fileInputNear = (el: Element): HTMLInputElement | undefined => {
    if (isFile(el)) return el;
    const label = el.closest("label");
    if (label && isFile(label.control)) return label.control;
    // 点在要填的框上的不算
    if (el.closest("input, textarea, select, [contenteditable]")) return undefined;
    let up: Element | null = el;
    for (let i = 0; up && i < 4; i++, up = up.parentElement) {
      if (up === doc.body || up === doc.documentElement) break;
      const inputs = up.querySelectorAll('input[type="file" i]');
      if (inputs.length > 1) break;
      if (inputs.length === 1 && isFile(inputs[0])) return uploadArea(up, inputs[0]) ? inputs[0] : undefined;
    }
    return undefined;
  };

  doc.addEventListener(
    "focusin",
    (e) => {
      if (!e.isTrusted) return;
      const t = targetOf(e);
      if (!t || t === hostEl) return;
      const el = t instanceof win.HTMLElement && t.isContentEditable ? editingHost(t) : t;
      const kind = el ? fillable(el) : undefined;
      if (el && kind && kind !== "file") {
        show(el, kind, el);
        select(el, kind);
      }
    },
    true,
  );
  doc.addEventListener(
    "focusout",
    (e) => {
      if (!e.isTrusted || !current || current.kind === "file") return;
      hideSoon();
    },
    true,
  );
  doc.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted) return;
      const t = targetOf(e);
      outside = bubble.open && t !== hostEl ? { x: e.clientX, y: e.clientY, id: e.pointerId } : undefined;
      if (!t || t === hostEl) return;
      const input = fileInputNear(t);
      if (input && fillable(input) === "file") {
        const anchor = triggerOf(input);
        if (anchor) show(input, "file", anchor);
        select(input, "file");
        return;
      }
      // 点到别处：挂在上传处的按钮收起（文本框的按钮跟着焦点走）
      if (current?.kind === "file") hide();
    },
    true,
  );
  // 点了气泡外面的网页（按下、抬起没怎么挪；滚页面不算）：收起气泡
  doc.addEventListener(
    "pointerup",
    (e) => {
      const o = outside;
      outside = undefined;
      if (!e.isTrusted || !o || e.pointerId !== o.id || targetOf(e) === hostEl) return;
      if (Math.hypot(e.clientX - o.x, e.clientY - o.y) < TAP_SLOP && bubble.view.kind !== "listening") closeBubble();
    },
    true,
  );
  doc.addEventListener("pointercancel", () => void (outside = undefined), true);
  // 用户滚页面（或网页里某一块）：框滚出屏幕时据此收起气泡。只算手指划、滚轮带起来的滚动——输入法弹起时浏览器自己滚的不算
  const gesture = (e: Event) => {
    if (e.isTrusted) lastGesture = now();
  };
  doc.addEventListener("touchmove", gesture, { capture: true, passive: true });
  doc.addEventListener("wheel", gesture, { capture: true, passive: true });
  doc.addEventListener(
    "scroll",
    () => {
      if (now() - lastGesture < GESTURE_SCROLL_MS) lastScroll = now();
    },
    { capture: true, passive: true },
  );

  // 选中的框里打了字、粘贴了（149 号票）：过一会儿把框里的字再报一次
  doc.addEventListener(
    "input",
    (e) => {
      const t = targetOf(e);
      if (chosen && t && (t === chosen.el || chosen.el.contains(t))) valueMaybeChanged();
    },
    true,
  );

  // 网页要弹选文件对话框了（网站的脚本调 input.click()，这个点击不是用户的，但对话框会弹）：告诉宿主是哪个框
  doc.addEventListener(
    "click",
    (e) => {
      const t = targetOf(e);
      if (t instanceof win.HTMLInputElement && fillable(t) === "file") send({ type: "chooser-field", field: describe(t, "file") });
    },
    true,
  );

  // 按钮：按下不让框丢焦点；短按在气泡里打字，长按说话
  let press: { x: number; y: number; timer: number | undefined; listening: boolean; cancel: boolean; id: number } | undefined;
  const fieldIdOfCurrent = () => (current ? idOf(current.el) : "");
  const commandOf = () => {
    if (!current) return undefined;
    return { field: describeNow(current.el, current.kind), page: pageInfo(), fields: listFields() };
  };
  fab.addEventListener("mousedown", stop);
  fab.addEventListener("touchstart", stop, { passive: false });
  fab.addEventListener("pointerdown", (e) => {
    stop(e);
    if (!e.isTrusted || !current || mark === "busy") return;
    try {
      fab.setPointerCapture(e.pointerId);
    } catch {
      // 拿不到就算了
    }
    const command = commandOf();
    if (!command) return;
    send({ type: "voice", phase: "press", ...command });
    press = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      listening: false,
      cancel: false,
      timer: setTimer(() => {
        if (!press) return;
        press.timer = undefined;
        press.listening = true;
        setMark("listening");
        // 先自己出在听（波形、秒数），宿主随后交来音量
        bubble.openListening(fieldIdOfCurrent(), labelOfCurrent());
        ensureHost();
        startTracking();
        const started = commandOf();
        if (started) send({ type: "voice", phase: "start", ...started });
      }, LONG_PRESS_MS),
    };
  });
  // 按着说话时手指挪动：上滑、划开进"松开取消"（气泡变红），挪回来又能发
  fab.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id || !press.listening) return;
    press.cancel = inVoiceCancelZone(press, { x: e.clientX, y: e.clientY });
    bubble.setCancelZone(press.cancel);
  });
  const finish = (e: PointerEvent, how: "release" | "cancel") => {
    if (!press || e.pointerId !== press.id) return;
    const { timer, listening } = press;
    const cancel = how === "cancel" || press.cancel;
    press = undefined;
    if (timer !== undefined) clearTimer(timer);
    const command = commandOf();
    if (!command) return;
    if (listening) {
      setMark(cancel ? "idle" : "busy");
      if (cancel) {
        if (bubble.view.kind === "listening") bubble.hide();
      } else {
        bubble.openBusy(command.field.id);
      }
      send({ type: "voice", phase: cancel ? "cancel" : "stop", ...command });
      if (cancel) afterBubbleClosed();
    } else if (how === "release") {
      // 先自己出打字框、在这一下里聚焦（手机上要在用户点的这一下里聚焦，输入法才弹得出来）
      ensureHost();
      bubble.openInput(command.field.id, labelOfCurrent());
      startTracking();
      send({ type: "open", ...command });
    }
  };
  fab.addEventListener("pointerup", (e) => {
    stop(e);
    if (e.isTrusted) finish(e, "release");
  });
  fab.addEventListener("pointercancel", (e) => finish(e, "cancel"));

  // 新的一页：没有选中的框（宿主据此把上一页选中的那个清掉）
  send({ type: "selected", field: null, page: pageInfo() });

  // ---------- 宿主调的 ----------
  const reply = (value: unknown) => stringify(value);
  const files = new Map<string, { name: string; mime: string; parts: Uint8Array[] }>();

  const fireInput = (el: Element, text: string) => {
    try {
      el.dispatchEvent(new InputEventCtor("input", { bubbles: true, cancelable: false, inputType: "insertReplacementText", data: text }));
    } catch {
      el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }
  };

  return {
    fields(key) {
      if (key !== nonce) return "";
      return reply({ page: pageInfo(), fields: listFields() });
    },
    fill(key, fieldId, text) {
      if (key !== nonce) return "";
      const el = elementOf(fieldId);
      const kind = el ? fillable(el) : undefined;
      if (!el || !kind) return reply({ ok: false, reason: "页面上没有这个框了，或者它不能填" }); // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
      if (kind === "file") return reply({ ok: false, reason: "这是选文件的框，不能填字" }); // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
      const value = String(text);
      // 聚焦、滚到看得见（用户看着它被填上）
      (el as HTMLElement).focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
        const setter = el instanceof win.HTMLInputElement ? inputValue : textareaValue;
        if (setter) setter.call(el, value);
        else el.value = value;
        fireInput(el, value);
        el.dispatchEvent(new EventCtor("change", { bubbles: true }));
      } else {
        const range = doc.createRange();
        range.selectNodeContents(el);
        const selection = win.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        let done = false;
        try {
          done = execCommand("insertText", false, value);
        } catch {
          done = false;
        }
        if (!done) {
          el.textContent = value;
          fireInput(el, value);
        }
      }
      return reply({ ok: true });
    },
    fileBegin(key, id, name, mime) {
      if (key !== nonce) return "";
      files.set(String(id), { name: String(name), mime: String(mime), parts: [] });
      return reply({ ok: true });
    },
    fileChunk(key, id, base64) {
      if (key !== nonce) return "";
      const file = files.get(String(id));
      // 175 号票：交文件没成的原因挑图片窗口里也显示（"没交进去：<原因>"），按二狗网页交来的语言写；秘书的网页工具结果里也是这句
      if (!file) return reply({ ok: false, reason: texts.get("bridge.reason.noFile") });
      const binary = decode(String(base64));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      file.parts.push(bytes);
      return reply({ ok: true });
    },
    attachFiles(key, fieldId, idsJson) {
      if (key !== nonce) return "";
      const el = elementOf(fieldId);
      let wanted: unknown;
      try {
        wanted = parse(String(idsJson));
      } catch {
        wanted = undefined;
      }
      const list = Array.isArray(wanted) ? wanted.map(String) : [];
      const picked = list.map((id) => files.get(id)).filter((f): f is { name: string; mime: string; parts: Uint8Array[] } => f !== undefined);
      for (const id of list) files.delete(id);
      if (!el || picked.length === 0) return reply({ ok: false, reason: texts.get(el ? "bridge.reason.nothingToUpload" : "bridge.reason.fieldGone") });
      const input = el instanceof win.HTMLInputElement && (el.getAttribute("type") ?? "").toLowerCase() === "file" ? el : undefined;
      if (input && (!fillable(input) || input.disabled)) return reply({ ok: false, reason: texts.get("bridge.reason.cantUpload") });
      const dt = new DataTransferCtor();
      const take = input && !input.multiple ? picked.slice(0, 1) : picked;
      for (const f of take) dt.items.add(new FileCtor(f.parts as BlobPart[], f.name, { type: f.mime, lastModified: Date.now() }));
      if (input) {
        if (inputFiles) inputFiles.call(input, dt.files);
        else input.files = dt.files;
        input.dispatchEvent(new EventCtor("input", { bubbles: true }));
        input.dispatchEvent(new EventCtor("change", { bubbles: true }));
        return reply({ ok: true, count: input.files?.length ?? 0 });
      }
      // 没有 input 的拖放区：照用户拖进来那样派事件
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEventCtor(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return reply({ ok: true, count: take.length });
    },
    selected(key) {
      if (key !== nonce) return "";
      if (chosen && !chosen.el.isConnected) unselect();
      return reply({ page: pageInfo(), field: chosen ? describeNow(chosen.el, chosen.kind) : null });
    },
    text(key) {
      if (key !== nonce) return "";
      return reply({ ok: true, page: pageInfo(), ...tidyPageText(pageText()) });
    },
    clearSelection(key) {
      if (key !== nonce) return "";
      unselect();
      return reply({ ok: true });
    },
    snapshot(key, max) {
      if (key !== nonce) return "";
      return reply(clickables.snapshot(String(max)));
    },
    click(key, ref, url) {
      if (key !== nonce) return "";
      return reply(clickables.click(String(ref), String(url)));
    },
    refField(key, ref, url, want) {
      if (key !== nonce) return "";
      if (want !== "textbox" && want !== "upload") return reply({ ok: false, reason: "want" });
      const found = clickables.field(String(ref), String(url), want);
      if (!found.ok) return reply(found);
      return reply({ ok: true, page: pageInfo(), field: describe(found.el, found.kind) });
    },
    mark(key, fieldId, next) {
      if (key !== nonce) return "";
      if (next === "idle" || next === "listening" || next === "busy") {
        if (!current || idOf(current.el) === fieldId || next === "idle") setMark(next);
      }
      return reply({ ok: true });
    },
    bubble(key, viewJson) {
      if (key !== nonce) return "";
      let value: unknown;
      try {
        value = parse(String(viewJson));
      } catch {
        value = undefined;
      }
      const view = bubbleViewOf(value);
      if (!view) return reply({ ok: false, reason: "气泡的样子不对" }); // @i18n-ignore log：宿主交错了才有，只回给宿主
      applyBubble(view);
      return reply({ ok: true });
    },
    texts(key, json) {
      if (key !== nonce) return "";
      let value: unknown;
      try {
        value = parse(String(json));
      } catch {
        value = undefined;
      }
      const next = bridgeTextsOf(value);
      if (!next) return reply({ ok: false, reason: "texts" });
      // 一样的不重画（二狗的网页每次按钮出来、选中的框变了都交一遍）
      const normalized = stringify(next);
      if (normalized !== textsJson) {
        textsJson = normalized;
        texts.set(next);
        tagStyle.textContent = nameTagStyle(texts.tag());
        fab.setAttribute("aria-label", texts.get("bridge.fab.label"));
        bubble.relabel();
        pickWindow.relabel();
      }
      return reply({ ok: true });
    },
    pick(key, viewJson) {
      if (key !== nonce) return "";
      let value: unknown;
      try {
        value = parse(String(viewJson));
      } catch {
        value = undefined;
      }
      const view: PagePickView | undefined = pickViewOf(value);
      if (!view) return reply({ ok: false, reason: "挑图片窗口的样子不对" }); // @i18n-ignore log：宿主交错了才有，只回给宿主
      if (view.kind !== "none") ensureHost();
      pickWindow.show(view);
      startTracking();
      return reply({ ok: true });
    },
  };
}
