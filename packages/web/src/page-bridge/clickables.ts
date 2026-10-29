// 页面桥里"看能点的东西、按编号点"（164 号票，用户 2026-10-19：秘书在"浏览"里点不了链接和按钮，希望像 CDP 那样自己点；
// 照 agent-browser 的 snapshot 给可交互元素编号 @e1、click @e1 按编号点的形状）。宿主经页面桥的 snapshot、click 调（带口令）。
// - 看（snapshot）：走一遍文档（连同网页自己开放的 shadow root；页面桥自己那一层是封闭的 shadow root，悬浮按钮、气泡、挑图片窗口
//   都在里面，不列），收链接、按钮、role 是按钮/链接/菜单项/标签页的、提交和按钮样子的 input、summary；不列看不见的（没有大小、
//   visibility 藏起来、offsetParent 是空的又不是 fixed/sticky）、禁用的、aria-hidden 和 inert 里的、pointer-events:none 的、密码框；
//   aria-disabled 的照列、标 disabled。超过上限时屏幕上看得见的、上半屏的先列（rules.ts 的 chooseClickables）；
// - 编号（e1、e2……）只记在这里的内存里（元素 → 编号、编号 → 元素和看的时候的文字），**不写进网页的 DOM**：网页自己的脚本能读能改
//   DOM 属性，恶意的网页可以把 data-ergo-ref 挪到别的元素上让秘书点错；同一页再看一次，同一个元素还是这个号，新出来的接着编；
//   换了网页（新的文档）页面桥重新装、从 e1 编起；
// - 点（click）：先核对还是看的时候那一页（地址去掉查询串）、编号认得、元素还在文档里、文字和看的时候一样、现在没禁用，不是就回原因
//   （"页面变了，请重新 snapshot"），决不点到别的元素上；再滚到屏幕中间，在元素正中依次派 pointerover、pointerenter、mouseover、
//   mouseenter、pointerdown、mousedown、pointerup、mouseup、click（真的点一下浏览器派的就是这一串，能触发悬停菜单和 React 的合成事件；
//   pointerdown 被网页拦下时照浏览器的规矩不派 mousedown、mouseup；mousedown 没被拦下时把焦点给它）。网页自己的脚本派的、
//   我们派的都不是 isTrusted，只认真事件的网站点不动（第二期电脑上的浏览器经 CDP 能派真事件）；
// - 开新窗口的在同一标签打开（内置浏览器只有一个标签）：链接、表单（连同 <base target>、formtarget）的 target 是 _blank 或起了名字的，
//   派事件前临时改成 _self、派完还原——网站自己的 onClick 照样先跑，拦下了就不跳；派事件的那一下里网页调 window.open 开新窗口的，
//   记下地址、回 null，派完了如果这一下没有别的跳转（不是链接、链接被拦下、链接只是 # 或 javascript:）就在这个标签里打开它。
// 用到的内置函数（派事件、量位置、滚动、算样式、查元素）在注入的那一刻记下来，网页的脚本之后改了也碍不着。
// 184 号票（用户 2026-10-20：希望在一页里能自动交图 → 自动填字 → 自动点按钮，不用每次都由人先点中框）：
// - 看的时候也列能填、能交、能选的框（和能点的同一套编号，一起排先后、一起算上限）：文本框（bridge.ts 认得能填的单行、多行、
//   可编辑区域，连 role=combobox 的输入框也算文本框）带现在的值的前 40 字；上传框（选文件的 input）带 accept、multiple，网站把它
//   藏起来（display:none、1 像素、透明）、画了自己的上传按钮的照样列、标 hidden——只能交、不能点；下拉框（select、别的 role=combobox）
//   带现在选的、前 20 个选项，只能看。密码、验证码、银行卡类的框（bridge.ts 的 isSensitive）、禁用的、只读的不列；
// - 按编号找框（field）：填字、交文件之前照点的核对——还是那一页、编号认得、元素还在文档里、种类没变（还是能填的文本框、能交的上传框），
//   回元素和框的种类，bridge.ts 再照原来的 fill、attachFiles 填、交（原因按二狗的网页交来的语言写：可能显示在挑图片窗口里）；
// - 框按编号点不了（回原因）：填字、交文件有自己的路，下拉框只能看。
import type { PageElement, PageField, PageFieldKind } from "@ergo/protocol";
import type { PageInfo } from "./protocol.ts";
import { chooseClickables, cleanElementText, clickRoleOf, type ElementRole, type FieldRole, isFieldRole, optionTexts, opensNewWindow, previewText } from "./rules.ts";
import type { BridgeTextKey } from "./texts.ts";

/** 算能点的：链接、按钮、role 是按钮/链接/菜单项/标签页的、提交和按钮样子的 input、summary（展开 details 的那一行） */
const SELECTOR = 'a[href], button, [role="button" i], [role="link" i], [role="menuitem" i], [role="tab" i], input[type="submit" i], input[type="button" i], summary';
/** 框的种类对应列出来的种类（184 号票） */
const fieldRoleOf = (kind: PageFieldKind): "textbox" | "upload" => (kind === "file" ? "upload" : "textbox");
/** 上传框没有标签时拿上传处上的字，最多多少（和框的标签一样） */
const AREA_TEXT_MAX = 80;
/** 算能填、能交、能选的（184 号票）：再按 FieldHooks 认种类 */
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable], [role="textbox" i], [role="combobox" i]';
/** 看一次最多列多少个（和协议的 PAGE_ELEMENTS_MAX、PAGE_ELEMENTS_DEFAULT 一样） */
const ELEMENTS_MAX = 100;
const ELEMENTS_DEFAULT = 40;
/** 链接地址最长交多少字（和协议的 PageElement.href 一样） */
const HREF_MAX = 2000;

/** 地址去掉 # 后面的 */
const strip = (href: string) => href.split("#")[0];

/** 点不成的原因（宿主原样转给守护进程） */
// @i18n-ignore-start model：点不成的原因进秘书的网页工具结果（给模型看，"请重新 snapshot"）
export const CLICK_MOVED = "换了网页，编号失效，请重新 snapshot";
export const CLICK_GONE = "页面变了（这个元素已经不在页面上），请重新 snapshot";
export const CLICK_CHANGED = "页面变了（这个元素上的字变了），请重新 snapshot";
export const CLICK_DISABLED = "这个元素现在是灰的（禁用了），点不了";
export const clickUnknown = (ref: string) => `这一页上没有 ${ref} 这个编号（编号只在看过的那一页有效），请重新 snapshot`;
/** 框按编号点不了（184 号票） */
export const clickField = (ref: string, role: FieldRole) =>
  role === "upload" ? `${ref} 是上传框，只能交文件，不能点` : role === "textbox" ? `${ref} 是文本框，不能点：填字按编号填` : `${ref} 是下拉框：下拉框现在只能看，选要用户自己点`;
// @i18n-ignore-end

export type SnapshotReply = { ok: true; page: PageInfo; elements: PageElement[]; total: number };
export type ClickReply = { ok: true; role: ElementRole; text: string; page: PageInfo } | { ok: false; reason: string };
/** 按编号找到的框（184 号票）：元素和框的种类（bridge.ts 照它填、交） */
export type FieldReply = { ok: true; el: Element; kind: PageFieldKind } | { ok: false; reason: string };

export interface Clickables {
  /** 列能点的（184 号票起连同能填、能交、能选的框；max 是字符串，宿主经 App 交来的；认不出按 40，夹在 1–100） */
  snapshot(max: string): SnapshotReply;
  /** 按编号点；url 是看的时候那一页的地址（去掉查询串） */
  click(ref: string, url: string): ClickReply;
  /** 按编号找要填的文本框、要交的上传框（184 号票）；url 同上 */
  field(ref: string, url: string, want: "textbox" | "upload"): FieldReply;
}

/** 按编号找框没找到的原因（184 号票，按二狗的网页交来的语言写） */
export type RefReasonKey = Extract<BridgeTextKey, `bridge.reason.ref${string}` | "bridge.reason.notTextbox" | "bridge.reason.notUpload">;

/** 认框的那一套（bridge.ts 给，184 号票）：认框、说法、框里的字、上传处、标签、密码类 */
export interface FieldHooks {
  /** 能填、能交的框是什么种类（密码类、禁用、只读的是 undefined） */
  kindOf(el: Element): PageFieldKind | undefined;
  /** 框的说法（带页面桥的框编号 f…） */
  describe(el: Element, kind: PageFieldKind): PageField;
  /** 框里现在的字（文本框） */
  valueOf(el: Element, kind: PageFieldKind): string | undefined;
  /** 选文件的框露在外面的那个东西（它自己、label、网站画的上传处）；没有是 undefined */
  anchorOf(input: HTMLInputElement): Element | undefined;
  /** 包着选文件的框的上传处（往上几层里第一个看得见的，里面只有这一个要填的框；没有是 undefined）：框没有标签时拿它上面的字 */
  areaOf(input: HTMLInputElement): Element | undefined;
  /** 标签文字（label、aria-labelledby、aria-label、title） */
  labelOf(el: Element): string;
  /** 密码、验证码、银行卡类 */
  sensitive(el: Element): boolean;
  /** 按编号找框没找到的原因 */
  reason(key: RefReasonKey, ref: string): string;
}

export interface ClickablesDeps {
  /** 网页的 window */
  win: Window & typeof globalThis;
  /** 页面桥自己那一层（封闭的 shadow root 的宿主）：不列 */
  own: Element;
  /** 这一页的标题、地址（去掉查询串） */
  pageInfo(): PageInfo;
  /** 注入时记下的 innerText 的 getter（看得见的文字） */
  innerText?: (this: HTMLElement) => string;
  /** 认框的那一套（184 号票）；不给只列能点的 */
  fields?: FieldHooks;
}

export function createClickables(deps: ClickablesDeps): Clickables {
  const { win, own, pageInfo, innerText, fields } = deps;
  const doc = win.document;
  // 注入的那一刻记下内置函数
  const ElementProto = win.Element.prototype;
  const matches = ElementProto.matches;
  const closest = ElementProto.closest;
  const getAttribute = ElementProto.getAttribute;
  const rectOf = ElementProto.getBoundingClientRect;
  const scrollIntoView = ElementProto.scrollIntoView;
  const dispatch = win.EventTarget.prototype.dispatchEvent;
  const styleOf = win.getComputedStyle.bind(win);
  const PointerEventCtor = win.PointerEvent;
  const MouseEventCtor = win.MouseEvent;
  const URLCtor = win.URL;
  const assign = win.location.assign.bind(win.location);
  const WeakRefCtor = win.WeakRef;

  const attr = (el: Element, name: string): string | null => getAttribute.call(el, name);
  const is = (el: Element, selector: string): boolean => matches.call(el, selector);
  const up = (el: Element, selector: string): Element | null => closest.call(el, selector);

  // ---------- 编号：只在这里的内存里 ----------
  const refs = new WeakMap<Element, string>();
  const byRef = new Map<string, { el: WeakRef<Element>; text: string; role: ElementRole }>();
  let next = 1;

  /** 文档里（连同网页自己开放的 shadow root 里）的能点的（184 号票起连同能填、能交、能选的），照页面上的先后；页面桥自己那一层不进去 */
  const collect = (root: Document | ShadowRoot, out: Element[]) => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el === own) continue;
      if (is(el, SELECTOR) || (fields && is(el, FIELD_SELECTOR))) out.push(el);
      const inner = el.shadowRoot;
      if (inner) collect(inner, out);
    }
  };

  const textOfIds = (el: Element): string => {
    const ids = (attr(el, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const root = el.getRootNode() as Document | ShadowRoot;
    return ids.map((id) => (typeof root.getElementById === "function" ? root.getElementById(id)?.textContent : doc.getElementById(id)?.textContent) ?? "").join(" ");
  };

  /** 看得见的文字（按钮样子的 input 是它的 value）；没有时用 aria-label、aria-labelledby、title、里面图片的 alt */
  const textOf = (el: Element): string => {
    let seen = "";
    try {
      if (el instanceof win.HTMLInputElement) seen = el.value;
      else if (el instanceof win.HTMLElement) seen = innerText ? innerText.call(el) : (el.textContent ?? "");
      else seen = el.textContent ?? "";
    } catch {
      seen = el.textContent ?? "";
    }
    const text = cleanElementText(seen);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    for (const c of [attr(el, "aria-label"), textOfIds(el), attr(el, "title"), img ? attr(img, "alt") : null, attr(el, "alt")]) {
      const t = cleanElementText(c);
      if (t) return t;
    }
    return "";
  };

  const isPassword = (el: Element) => el instanceof win.HTMLInputElement && (attr(el, "type") ?? "").toLowerCase() === "password";
  const greyed = (el: Element) => up(el, '[aria-disabled="true"]') !== null;
  const disabledNow = (el: Element) => is(el, ":disabled") || greyed(el);

  /** 看得见、点得到：有大小、没藏起来（visibility、display 的祖先）、不在 aria-hidden / inert 里、不是 pointer-events:none、没禁用 */
  const eligible = (el: Element, rect: DOMRect): boolean => {
    if (isPassword(el) || is(el, ":disabled")) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (up(el, '[aria-hidden="true"], [inert]')) return false;
    const style = styleOf(el);
    if (style.visibility === "hidden" || style.visibility === "collapse" || style.pointerEvents === "none") return false;
    if (el instanceof win.HTMLElement && el.offsetParent === null && style.position !== "fixed" && style.position !== "sticky") return false;
    return true;
  };

  const clickRole = (el: Element) => {
    const form = el instanceof win.HTMLButtonElement || el instanceof win.HTMLInputElement ? el.form : null;
    return clickRoleOf({ tag: el.tagName, type: attr(el, "type") ?? "", role: attr(el, "role") ?? "", hasForm: form !== null });
  };

  // ---------- 能填、能交、能选的框（184 号票） ----------

  /** 下拉框：select，或者别的 role=combobox（能填的输入框算文本框，在前面已经认了）；密码类的不算 */
  const isSelect = (el: Element, hooks: FieldHooks) =>
    (el instanceof win.HTMLSelectElement || (attr(el, "role") ?? "").trim().toLowerCase() === "combobox") && !hooks.sensitive(el);

  /** 列出来是什么种类：能填、能交的框先认（文本框、上传框），再是下拉框，再是能点的；都不是是 undefined */
  const kindAt = (el: Element): { role: ElementRole; kind?: PageFieldKind } | undefined => {
    if (fields && is(el, FIELD_SELECTOR)) {
      const kind = fields.kindOf(el);
      if (kind) return { role: fieldRoleOf(kind), kind };
      if (isSelect(el, fields)) return { role: "select" };
    }
    return is(el, SELECTOR) ? { role: clickRole(el) } : undefined;
  };

  /** 藏起来的上传框（网站画了自己的上传按钮，把 input 藏在后面）：看不见、1 像素以下、透明的 */
  const tucked = (el: Element, rect: DOMRect): boolean => !eligible(el, rect) || rect.width <= 1 || rect.height <= 1 || styleOf(el).opacity === "0";

  /** 排先后用的位置：藏起来的上传框用它露在外面的那个东西，没有用往上第一个有大小的 */
  const placeOf = (el: Element, rect: DOMRect): DOMRect => {
    if (rect.width > 0 && rect.height > 0) return rect;
    const anchor = fields && el instanceof win.HTMLInputElement ? fields.anchorOf(el) : undefined;
    if (anchor && anchor !== el) return rectOf.call(anchor);
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const r = rectOf.call(parent);
      if (r.width > 0 && r.height > 0) return r;
    }
    return rect;
  };

  /** 下拉框现在选的、前 20 个选项（select 的 option；别的看 aria-controls / aria-owns 指的列表、自己里面的 role=option） */
  const selectState = (el: Element): Pick<PageElement, "valuePreview" | "options"> => {
    let value: string | undefined;
    let options: string[];
    if (el instanceof win.HTMLSelectElement) {
      value = previewText(Array.from(el.selectedOptions, (o) => o.label || o.text).join(", "));
      options = optionTexts(Array.from(el.options, (o) => o.label || o.text));
    } else {
      // 现在选的：输入框是它的值，别的是它上面看得见的字（不拿 aria-label 凑：那是标签）
      let shown = "";
      try {
        shown = el instanceof win.HTMLInputElement ? el.value : el instanceof win.HTMLElement && innerText ? innerText.call(el) : (el.textContent ?? "");
      } catch {
        shown = el.textContent ?? "";
      }
      value = previewText(shown);
      const root = el.getRootNode() as Document | ShadowRoot;
      const lists = `${attr(el, "aria-controls") ?? ""} ${attr(el, "aria-owns") ?? ""}`
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => (typeof root.getElementById === "function" ? root.getElementById(id) : doc.getElementById(id)));
      const found: string[] = [];
      for (const list of [...lists, el]) {
        if (!list) continue;
        for (const o of Array.from(list.querySelectorAll('[role="option" i]'))) found.push(o.textContent ?? "");
      }
      options = optionTexts(found);
    }
    return { ...(value ? { valuePreview: value } : {}), ...(options.length > 0 ? { options } : {}) };
  };

  /** 框列出来的样子（文字是标签，没有用 placeholder；上传框没有时用包着它的上传处上的字） */
  const fieldElement = (el: Element, at: { role: ElementRole; kind?: PageFieldKind }, hidden: boolean, hooks: FieldHooks): Omit<PageElement, "ref"> => {
    if (at.role === "select" || !at.kind) {
      const label = cleanElementText(hooks.labelOf(el)) || cleanElementText(attr(el, "placeholder"));
      return { role: "select", text: label, ...selectState(el) };
    }
    const kind = at.kind;
    const field = hooks.describe(el, kind);
    let text = cleanElementText(field.label || field.placeholder || "");
    if (kind === "file") {
      if (!text && el instanceof win.HTMLInputElement) {
        const area = hooks.areaOf(el);
        text = area ? cleanElementText(area.textContent).slice(0, AREA_TEXT_MAX) : "";
      }
      return { role: "upload", text, ...(field.accept ? { accept: field.accept } : {}), ...(field.multiple ? { multiple: true } : {}), ...(hidden ? { hidden: true } : {}) };
    }
    const value = previewText(hooks.valueOf(el, kind));
    return { role: "textbox", text, ...(kind !== "text" ? { multiline: true } : {}), ...(value ? { valuePreview: value } : {}) };
  };

  const hrefOf = (el: Element, role: ElementRole): string | undefined => {
    if (role !== "link" || !(el instanceof win.HTMLAnchorElement)) return undefined;
    const href = el.href;
    return /^https?:\/\//i.test(href) ? href.slice(0, HREF_MAX) : undefined;
  };

  const snapshot = (maxText: string): SnapshotReply => {
    const asked = Math.floor(Number(maxText));
    const max = Number.isFinite(asked) && asked >= 1 ? Math.min(ELEMENTS_MAX, asked) : ELEMENTS_DEFAULT;
    const found: Element[] = [];
    collect(doc, found);
    type Item = { el: Element; at: { role: ElementRole; kind?: PageFieldKind }; hidden: boolean };
    const candidates: Array<{ item: Item; rect: { left: number; top: number; right: number; bottom: number } }> = [];
    for (const el of found) {
      const at = kindAt(el);
      if (!at) continue;
      const r = rectOf.call(el);
      // 上传框藏起来了也列（只能交、不能点）：禁用的、inert 里的不列
      const upload = at.role === "upload";
      if (upload ? is(el, ":disabled") || up(el, "[inert]") !== null : !eligible(el, r)) continue;
      const p = upload ? placeOf(el, r) : r;
      candidates.push({ item: { el, at, hidden: upload && tucked(el, r) }, rect: { left: p.left, top: p.top, right: p.right, bottom: p.bottom } });
    }
    const chosen = chooseClickables(candidates, { width: win.innerWidth, height: win.innerHeight }, max);
    const elements = chosen.map(({ el, at, hidden }): PageElement => {
      let ref = refs.get(el);
      if (!ref) {
        ref = `e${next++}`;
        refs.set(el, ref);
      }
      if (fields && isFieldRole(at.role)) {
        const shown = fieldElement(el, at, hidden, fields);
        byRef.set(ref, { el: new WeakRefCtor(el), text: shown.text, role: at.role });
        return { ref, ...shown };
      }
      const role = at.role;
      const text = textOf(el);
      byRef.set(ref, { el: new WeakRefCtor(el), text, role });
      const href = hrefOf(el, role);
      return { ref, role, text, ...(href ? { href } : {}), ...(greyed(el) ? { disabled: true } : {}) };
    });
    return { ok: true, page: pageInfo(), elements, total: candidates.length };
  };

  // ---------- 点 ----------

  /** 开新窗口的链接、表单临时改成在这个标签打开；回还原的函数 */
  const sameTab = (el: Element): (() => void) => {
    const undo: Array<() => void> = [];
    const force = (node: Element, name: string) => {
      const had = attr(node, name);
      node.setAttribute(name, "_self");
      undo.push(() => (had === null ? node.removeAttribute(name) : node.setAttribute(name, had)));
    };
    const base = doc.querySelector("base[target]");
    const baseTarget = base ? (attr(base, "target") ?? "") : "";
    const anchor = up(el, "a[href], area[href]");
    if (anchor && opensNewWindow(attr(anchor, "target") ?? baseTarget)) force(anchor, "target");
    const submitter =
      (el instanceof win.HTMLButtonElement && el.type === "submit") || (el instanceof win.HTMLInputElement && (el.type === "submit" || el.type === "image")) ? el : undefined;
    const form = submitter?.form;
    if (submitter && form) {
      const ownTarget = attr(submitter, "formtarget");
      if (ownTarget !== null) {
        if (opensNewWindow(ownTarget)) force(submitter, "formtarget");
      } else if (opensNewWindow(attr(form, "target") ?? baseTarget)) force(form, "target");
    }
    // 倒着还原（不用 toReversed：页面桥要在 Chrome 100 起的 ArkWeb 上跑）
    return () => {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
    };
  };

  /** 派事件的那一下里网页调 window.open 开新窗口：记下第一个地址、回 null（_self 这类照原样）；回还原的函数 */
  const catchOpen = (onOpen: (url: string) => void): (() => void) => {
    let had: PropertyDescriptor | undefined;
    try {
      had = Object.getOwnPropertyDescriptor(win, "open");
      const original = typeof had?.value === "function" ? (had.value as Window["open"]) : undefined;
      const shim = (url?: string | URL, target?: string, features?: string): Window | null => {
        if (!opensNewWindow(target ?? "_blank")) return original ? original.call(win, url, target, features) : null;
        if (url !== undefined && String(url) !== "") onOpen(String(url));
        return null;
      };
      Object.defineProperty(win, "open", { value: shim, writable: true, configurable: true, enumerable: true });
    } catch {
      return () => {};
    }
    return () => {
      try {
        if (had) Object.defineProperty(win, "open", had);
      } catch {
        // 还原不了就算了
      }
    };
  };

  /** 在 (x, y) 派一串真点一下时的事件；回 click 有没有被网页拦下（拦下了是 false） */
  const fire = (el: Element, x: number, y: number): boolean => {
    const base = { clientX: x, clientY: y, screenX: x, screenY: y, view: win, composed: true, button: 0 };
    const pointer = (type: string, buttons: number, bubbles = true) =>
      dispatch.call(el, new PointerEventCtor(type, { ...base, bubbles, cancelable: bubbles, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 }));
    const mouse = (type: string, buttons: number, bubbles = true, detail = 0) => dispatch.call(el, new MouseEventCtor(type, { ...base, bubbles, cancelable: bubbles, buttons, detail }));
    pointer("pointerover", 0);
    pointer("pointerenter", 0, false);
    mouse("mouseover", 0);
    mouse("mouseenter", 0, false);
    // pointerdown 被拦下时浏览器不再派 mousedown、mouseup（click 照派）
    const compat = pointer("pointerdown", 1);
    if (compat && mouse("mousedown", 1, true, 1) && el instanceof win.HTMLElement) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // 给不了焦点就算了
      }
    }
    pointer("pointerup", 0);
    if (compat) mouse("mouseup", 0, true, 1);
    return mouse("click", 0, true, 1);
  };

  /** 这个链接点了会离开这一页（http(s)、不是这一页上的 #） */
  const leaves = (anchor: Element | null): boolean => {
    if (!(anchor instanceof win.HTMLAnchorElement) || !/^https?:\/\//i.test(anchor.href)) return false;
    return !(anchor.href.includes("#") && strip(anchor.href) === strip(win.location.href));
  };

  const click = (refText: string, url: string): ClickReply => {
    const ref = String(refText);
    if (pageInfo().url !== String(url)) return { ok: false, reason: CLICK_MOVED };
    const entry = byRef.get(ref);
    if (!entry) return { ok: false, reason: clickUnknown(ref) };
    // 框不点（184 号票）：填字、交文件按编号来，下拉框只能看
    if (isFieldRole(entry.role)) return { ok: false, reason: clickField(ref, entry.role) };
    const el = entry.el.deref();
    if (!el || !el.isConnected) return { ok: false, reason: CLICK_GONE };
    if (textOf(el) !== entry.text) return { ok: false, reason: CLICK_CHANGED };
    if (disabledNow(el)) return { ok: false, reason: CLICK_DISABLED };
    try {
      scrollIntoView.call(el, { block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    } catch {
      // 滚不了照样点
    }
    // 元素正中（取整：浏览器派的鼠标事件坐标是整数）
    const r = rectOf.call(el);
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    let opened: string | undefined;
    const restoreTargets = sameTab(el);
    const restoreOpen = catchOpen((u) => void (opened ??= u));
    let proceeded = true;
    try {
      proceeded = fire(el, x, y);
    } finally {
      restoreOpen();
      restoreTargets();
    }
    if (opened !== undefined && !(proceeded && leaves(up(el, "a[href]")))) {
      try {
        const target = new URLCtor(opened, doc.baseURI);
        if (target.protocol === "http:" || target.protocol === "https:") assign(target.href);
      } catch {
        // 地址不对：不跳
      }
    }
    return { ok: true, role: entry.role, text: entry.text, page: pageInfo() };
  };

  // ---------- 按编号找框（184 号票） ----------

  const field = (refText: string, url: string, want: "textbox" | "upload"): FieldReply => {
    const ref = String(refText);
    const no = (key: RefReasonKey): FieldReply => ({ ok: false, reason: fields ? fields.reason(key, ref) : key });
    if (!fields) return no("bridge.reason.refUnknown");
    if (pageInfo().url !== String(url)) return no("bridge.reason.refMoved");
    const entry = byRef.get(ref);
    if (!entry) return no("bridge.reason.refUnknown");
    if (entry.role !== want) return no(want === "textbox" ? "bridge.reason.notTextbox" : "bridge.reason.notUpload");
    const el = entry.el.deref();
    if (!el || !el.isConnected) return no("bridge.reason.refGone");
    // 种类变了（成了密码框、禁用了、只读了、换了类型）：不填、不交
    const kind = fields.kindOf(el);
    if (!kind || fieldRoleOf(kind) !== want) return no("bridge.reason.refChanged");
    return { ok: true, el, kind };
  };

  return { snapshot, click, field };
}
