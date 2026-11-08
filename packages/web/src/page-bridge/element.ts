// 长按网页元素出二狗圆钮（长按网页元素或鼠标右键时，系统菜单照常弹、不阻止；多出一个二狗图标的按钮，按住说话或打字，
// 让二狗处理这个元素，做什么由用户说了算）在页面桥这一侧：认元素、摆圆钮、收手势、替宿主取元素的内容。样子和操作照现有悬浮按钮（点一下打字、按住说话、
// 回话进小气泡），画在同一个封闭的 shadow root 里。圆钮上没有操作菜单，这里也不管用户要做什么。试验结论这里用到的：
// - 只在捕获阶段听 contextmenu，绝不 preventDefault：手指长按和鼠标右键在安卓 WebView、鸿蒙 ArkWeb 上都来，target 对；图片、canvas、视频优先，
//   选区要和元素相交才算文字（鸿蒙长按 canvas 会把旁边的字选上）；
// - 系统选文字的浮动工具条是原生层，盖在网页上，摆在选区上方，所以文字的圆钮放选区下方（rules.ts 的 placeElementButton）；选区变了（拖手柄）重摆；
// - 圆钮同时听 pointer 和 touch：鸿蒙长按图片、链接后不到一秒就松手时，下一个 pointerdown 还落在原来的图上（touchstart 正常落在圆钮上），
//   这时靠 touch 接住；"点别处收起"按坐标判断，按在圆钮上不算点别处；
// - 留 ELEMENT_KEEP_MS 自己消失；点别处、滚动马上收。不做对抗：网页屏蔽了长按、遮罩盖着、跨站 iframe 里、封闭 shadow root 里认不出就不出。
// 取内容（宿主经 elementPrepare、elementChunk、elementRect 调）：blob:、data:、canvas 只有页面自己读得到，在这里读好分段交给宿主；
// 截图由 App 截，这里把元素滚到看得见、藏起页面桥自己这一层、报元素在视口里的位置。http 地址由 App 自己取（带登录状态和来源页）。
import type { PickedElement, PickedElementKind, PickedElementSource } from "@ergo/protocol";
import type { Bubble } from "./bubble.ts";
import type { PageBridgeEvent, PageBridgeMark, PageInfo } from "./protocol.ts";
import { BUTTON_SIZE, cleanElementLabel, ELEMENT_KEEP_MS, ELEMENT_URL_MAX, elementSourceOf, FIELD_VALUE_MAX, inVoiceCancelZone, placeElementButton, type Rect } from "./rules.ts";
import type { BridgeTextKey, BridgeTexts } from "./texts.ts";

/** 按多久算按住说话（和悬浮按钮一样） */
const LONG_PRESS_MS = 350;
/** 记着最近几个元素（秘书这一轮可能排在后面才来取） */
const PICKS_KEPT = 20;
/** 分段交给宿主时一段多少字节（base64 之后约 512 KB） */
const CHUNK_BYTES = 384 * 1024;
/** 点别处收起时，离圆钮多近算按在圆钮上（CSS 像素） */
const BUTTON_SLOP = 6;
/** 截图藏起页面桥这一层最多藏多久（毫秒）：宿主没来放回来（App 被切走了）时自己放回来 */
const SHOT_HIDE_MAX_MS = 3000;
/** touch 那条路的编号（pointerId 都是非负数） */
const VIA_TOUCH = -1;

const LABEL_KEYS: Readonly<Record<PickedElementKind, BridgeTextKey>> = {
  image: "bridge.talkTo.image",
  video: "bridge.talkTo.video",
  link: "bridge.talkTo.link",
  text: "bridge.talkTo.text",
};

export interface ElementButtonDeps {
  win: Window & typeof globalThis;
  doc: Document;
  /** 页面桥那一层的宿主元素（按在它上面的不算点网页） */
  hostEl: HTMLElement;
  button: HTMLElement;
  bubble: Bubble;
  texts: BridgeTexts;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  decode(base64: string): string;
  encode(binary: string): string;
  innerText?: (this: HTMLElement) => string;
  send(event: PageBridgeEvent): void;
  pageInfo(): PageInfo;
  visibleArea(): Rect;
  ensureHost(): void;
  startTracking(): void;
  /** 收起开着的、别人的气泡（用户转去指别的元素了） */
  closeBubble(): void;
  /** 圆钮出来了、收起了（右下角常驻的悬浮按钮让给它、再回来） */
  shownChanged?(): void;
}

export interface ElementButton {
  /** 这个编号是不是现在圆钮上的元素 */
  owns(id: string): boolean;
  /** 圆钮在哪（显示着才有） */
  rect(): Rect | undefined;
  /** 圆钮显示着 */
  shown(): boolean;
  /** 现在的元素（选中的文字是这一刻的） */
  fresh(): PickedElement | undefined;
  mark(next: PageBridgeMark): void;
  /** 气泡收起了（点外面、回话看完）：圆钮也收 */
  bubbleClosed(): void;
  /** 用户滚页面了 */
  scrolled(): void;
  /** 用户去用文本框了 */
  fieldFocused(): void;
  info(id: string, url: string): unknown;
  prepare(id: string, url: string): unknown;
  chunk(id: string, offset: number): unknown;
  shotRect(id: string, url: string): unknown;
  shotDone(): unknown;
}

interface Kept {
  pick: PickedElement;
  el: WeakRef<Element>;
}

/** 页面里读好的内容：读完是字节和类型，读不到是原因 */
type Prepared = { state: "reading" } | { state: "failed"; reason: string } | { state: "ready"; bytes: Uint8Array; mime: string };

const isHttpOnly = (url: string) => /^https?:\/\//i.test(url);

/** 元素自己直接带着字（按在空白的大盒子上不算文字） */
const hasOwnText = (el: Element): boolean => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.nodeValue ?? "").trim() !== "");

/** 地址交不交：太长不交（只说有） */
const addressOf = (url: string): { src?: string } => (url.length <= ELEMENT_URL_MAX ? { src: url } : {});

const stop = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

const textValue = (raw: string) => {
  const text = raw.trim();
  return { text: text.slice(0, FIELD_VALUE_MAX), total: text.length };
};

const mediaPick = (kind: PickedElementKind, source: PickedElementSource | undefined, url: string, el: Element): Omit<PickedElement, "id"> => {
  const label = cleanElementLabel(el.getAttribute("alt") ?? el.getAttribute("title") ?? el.getAttribute("aria-label"));
  return { kind, ...(source ? { source } : {}), ...(source === "http" ? addressOf(url) : {}), ...(label ? { label } : {}) };
};

export function createElementButton(deps: ElementButtonDeps): ElementButton {
  const { win, doc, hostEl, button, bubble, texts } = deps;
  const keptPicks = new Map<string, Kept>();
  const prepared = new Map<string, Prepared>();
  let nextId = 1;
  /** 现在圆钮上的元素 */
  let current: { pick: PickedElement; el: Element; point: { x: number; y: number } } | undefined;
  let mark: PageBridgeMark = "idle";
  let hideTimer: number | undefined;
  let press: { x: number; y: number; id: number; timer: number | undefined; listening: boolean; cancel: boolean } | undefined;
  let hiddenForShot = false;
  // 记在注入的那一刻：网页的脚本之后改了也碍不着
  const fetchFn = win.fetch?.bind(win);
  const getSelection = win.getSelection.bind(win);

  const setMark = (next: PageBridgeMark) => {
    mark = next;
    button.classList.toggle("listening", next === "listening");
    button.classList.toggle("busy", next === "busy");
  };

  /** 选中的字（和这个元素相交才算）；没有是空串 */
  const selectedTextOn = (el: Element): string => {
    try {
      const selection = getSelection();
      if (!selection || selection.rangeCount === 0) return "";
      const text = String(selection).trim();
      if (!text) return "";
      return selection.getRangeAt(0).intersectsNode(el) ? text : "";
    } catch {
      return "";
    }
  };

  const selectionRect = (): Rect | undefined => {
    try {
      const selection = getSelection();
      if (!selection || selection.rangeCount === 0 || String(selection).trim() === "") return undefined;
      const r = selection.getRangeAt(0).getBoundingClientRect();
      return r.width + r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : undefined;
    } catch {
      return undefined;
    }
  };

  const visibleText = (el: Element): string => {
    try {
      const text = deps.innerText?.call(el as HTMLElement);
      if (typeof text === "string") return text;
    } catch {
      // 拿不到：用 textContent
    }
    return el.textContent ?? "";
  };

  /** 选中的字所在的那段（比选中的字长才带）：手指长按时系统只选中一个词 */
  const aroundOf = (el: Element, selected: string): { around?: { text: string; total: number } } => {
    const whole = visibleText(el).trim();
    return whole.length > selected.length ? { around: textValue(whole) } : {};
  };

  /** CSS 背景图的地址（这个元素自己的；渐变这些不算） */
  const backgroundOf = (el: Element): string | undefined => {
    try {
      const m = /url\((["']?)(.+?)\1\)/.exec(win.getComputedStyle(el).backgroundImage);
      return m ? new URL(m[2]!, doc.baseURI).href : undefined;
    } catch {
      return undefined;
    }
  };

  /** 事件落在哪个元素上，认成图片、视频、链接、文字；都不是（空白、文本框、密码框这些）是 undefined */
  const recognize = (first: Element, path: readonly EventTarget[]): Omit<PickedElement, "id"> | undefined => {
    const tag = first.tagName.toUpperCase();
    if (tag === "BODY" || tag === "HTML") return undefined;
    // 文本框有自己的悬浮按钮（这里连内容都不看，密码框也在其中）
    if (first.closest("input, textarea, select, [contenteditable]")) return undefined;
    const linkEl = path.find((t): t is HTMLAnchorElement => t instanceof win.HTMLAnchorElement && isHttpOnly(t.href));
    const href = linkEl && linkEl.href.length <= ELEMENT_URL_MAX ? { href: linkEl.href } : {};
    // 图、canvas、视频优先：鸿蒙长按它们时可能把旁边的字选上（选区不相交的不算）
    if (first instanceof win.HTMLImageElement) {
      const url = first.currentSrc || first.src;
      return { ...mediaPick("image", elementSourceOf(url), url, first), ...href };
    }
    if (first instanceof win.HTMLVideoElement) {
      const url = first.currentSrc || first.src || first.querySelector("source")?.src || "";
      return { ...mediaPick("video", elementSourceOf(url), url, first), ...href };
    }
    if (first instanceof win.HTMLCanvasElement) return { ...mediaPick("image", "canvas", "", first), ...href };
    const svg = first.closest("svg");
    if (svg) return { ...mediaPick("image", "svg", "", svg), ...href };
    const selected = selectedTextOn(first);
    if (selected) return { kind: "text", text: textValue(selected), selected: true, ...aroundOf(first, selected), ...href };
    if (linkEl) {
      const text = visibleText(linkEl);
      return { kind: "link", ...(text.trim() ? { text: textValue(text) } : {}), ...href };
    }
    if (hasOwnText(first)) return { kind: "text", text: textValue(visibleText(first)) };
    const background = backgroundOf(first);
    if (background) return { ...mediaPick("image", elementSourceOf(background), background, first), ...href };
    return undefined;
  };

  const place = () => {
    if (!current) return;
    const size = BUTTON_SIZE;
    const at = placeElementButton(current.point, current.pick.selected ? selectionRect() : undefined, deps.visibleArea(), size);
    button.style.left = `${Math.round(at.x)}px`;
    button.style.top = `${Math.round(at.y)}px`;
  };

  const inUse = () => press !== undefined || mark !== "idle" || (bubble.open && current !== undefined && bubble.view.kind !== "none" && bubble.view.fieldId === current.pick.id);

  const stopTimer = () => {
    if (hideTimer !== undefined) deps.clearTimer(hideTimer);
    hideTimer = undefined;
  };

  /** 过一会儿自己消失（正在用的不收：气泡收起、松手时再算） */
  const arm = () => {
    stopTimer();
    hideTimer = deps.setTimer(() => {
      hideTimer = undefined;
      if (!inUse()) hide();
    }, ELEMENT_KEEP_MS);
  };

  const hide = () => {
    stopTimer();
    if (!current) return;
    current = undefined;
    setMark("idle");
    button.classList.remove("on");
    deps.send({ type: "element", element: null });
    deps.shownChanged?.();
  };

  const show = (found: Omit<PickedElement, "id">, el: Element, x: number, y: number) => {
    // 用户转去指别的元素了：开着的气泡是上一个的
    if (bubble.open && bubble.view.kind !== "listening") deps.closeBubble();
    const id = `x${nextId++}`;
    const pick: PickedElement = { id, ...found };
    keptPicks.set(id, { pick, el: new WeakRef(el) });
    while (keptPicks.size > PICKS_KEPT) keptPicks.delete(keptPicks.keys().next().value!);
    current = { pick, el, point: { x, y } };
    setMark("idle");
    deps.ensureHost();
    place();
    button.classList.add("on");
    deps.send({ type: "element", element: pick });
    deps.shownChanged?.();
    arm();
  };

  /** 现在的元素：选中的文字以这一刻为准（用户可能拖过手柄） */
  const fresh = (): PickedElement | undefined => {
    if (!current) return undefined;
    if (!current.pick.selected) return current.pick;
    const selection = getSelection();
    const text = selection ? String(selection).trim() : "";
    if (!text) return current.pick;
    current.pick = { ...current.pick, text: textValue(text) };
    const kept = keptPicks.get(current.pick.id);
    if (kept) kept.pick = current.pick;
    return current.pick;
  };

  const labelOfCurrent = () => texts.parts(current ? LABEL_KEYS[current.pick.kind] : "bridge.talkTo.ergo");

  const begin = (x: number, y: number, id: number) => {
    const pick = fresh();
    if (!pick || mark === "busy") return;
    stopTimer();
    deps.send({ type: "element-voice", phase: "press", element: pick, page: deps.pageInfo() });
    press = {
      x,
      y,
      id,
      listening: false,
      cancel: false,
      timer: deps.setTimer(() => {
        if (!press) return;
        press.timer = undefined;
        press.listening = true;
        setMark("listening");
        // 先自己出在听（波形、秒数），宿主随后交来音量
        const held = fresh();
        bubble.openListening(held?.id ?? "", labelOfCurrent());
        deps.ensureHost();
        deps.startTracking();
        if (held) deps.send({ type: "element-voice", phase: "start", element: held, page: deps.pageInfo() });
      }, LONG_PRESS_MS),
    };
  };

  const moved = (x: number, y: number) => {
    if (!press?.listening) return;
    press.cancel = inVoiceCancelZone(press, { x, y });
    bubble.setCancelZone(press.cancel);
  };

  const finish = (how: "release" | "cancel") => {
    if (!press) return;
    const { timer, listening } = press;
    const cancel = how === "cancel" || press.cancel;
    press = undefined;
    if (timer !== undefined) deps.clearTimer(timer);
    const pick = fresh();
    if (!pick) return;
    if (listening) {
      setMark(cancel ? "idle" : "busy");
      if (cancel) {
        if (bubble.view.kind === "listening") bubble.hide();
        arm();
      } else {
        bubble.openBusy(pick.id);
      }
      deps.send({ type: "element-voice", phase: cancel ? "cancel" : "stop", element: pick, page: deps.pageInfo() });
    } else if (how === "release") {
      // 先自己出打字框、在这一下里聚焦（手机上要在用户点的这一下里聚焦，输入法才弹得出来）
      deps.ensureHost();
      bubble.openInput(pick.id, labelOfCurrent());
      deps.startTracking();
      deps.send({ type: "element-open", element: pick, page: deps.pageInfo() });
      // 打字框开着不算到期（到期时看 inUse）；宿主没接（还在办上一句）的，到时候照常收
      arm();
    } else {
      arm();
    }
  };

  button.addEventListener("mousedown", stop);
  button.addEventListener("contextmenu", stop);
  button.addEventListener("pointerdown", (e) => {
    stop(e);
    if (!e.isTrusted || press) return;
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      // 拿不到就算了
    }
    begin(e.clientX, e.clientY, e.pointerId);
  });
  button.addEventListener("pointermove", (e) => {
    if (press && e.pointerId === press.id) moved(e.clientX, e.clientY);
  });
  button.addEventListener("pointerup", (e) => {
    stop(e);
    if (e.isTrusted && press && e.pointerId === press.id) finish("release");
  });
  button.addEventListener("pointercancel", (e) => {
    if (press && e.pointerId === press.id) finish("cancel");
  });
  // pointer 没来的时候（鸿蒙长按后很快松手，下一个 pointerdown 还落在原来的元素上）：touch 接住
  button.addEventListener(
    "touchstart",
    (e) => {
      stop(e);
      const t = e.changedTouches[0];
      if (!e.isTrusted || press || !t) return;
      begin(t.clientX, t.clientY, VIA_TOUCH);
    },
    { passive: false },
  );
  button.addEventListener(
    "touchmove",
    (e) => {
      const t = e.changedTouches[0];
      if (press && t) moved(t.clientX, t.clientY);
    },
    { passive: true },
  );
  // pointer 那条路开的按下，pointerup 也可能被原来的元素收走：touch 这边结束时还按着就算结束（正常时 pointerup 先到，这里没事做）
  button.addEventListener("touchend", (e) => {
    if (e.isTrusted && press) finish("release");
  });
  button.addEventListener("touchcancel", () => {
    if (press) finish("cancel");
  });

  // 只听，不 preventDefault：系统菜单照常（网页自己屏蔽的，网页的监听在后面，这里也不去改）
  doc.addEventListener(
    "contextmenu",
    (e) => {
      if (!e.isTrusted || press) return;
      const path = e.composedPath();
      const first = path[0];
      if (!(first instanceof win.Element) || first === hostEl) return;
      const found = recognize(first, path);
      if (found) show(found, first, e.clientX, e.clientY);
      else if (!inUse()) hide();
    },
    true,
  );
  // 点别处收起（按在圆钮上的不算，见文件头：pointer 可能落在原来的元素上）
  doc.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || !current || inUse()) return;
      if (e.composedPath()[0] === hostEl) return;
      const r = button.getBoundingClientRect();
      const on = e.clientX >= r.left - BUTTON_SLOP && e.clientX <= r.right + BUTTON_SLOP && e.clientY >= r.top - BUTTON_SLOP && e.clientY <= r.bottom + BUTTON_SLOP;
      if (!on) hide();
    },
    true,
  );
  // 选区变了（拖手柄、全选）：重摆、重新计时；选区没了（文字的圆钮）收起
  doc.addEventListener("selectionchange", () => {
    if (!current || inUse() || current.pick.kind !== "text") return;
    if (!current.pick.selected) {
      // 选区比 contextmenu 晚到：认成选中的字
      const selected = selectedTextOn(current.el);
      if (!selected) return;
      current.pick = { ...current.pick, text: textValue(selected), selected: true, ...aroundOf(current.el, selected) };
      const kept = keptPicks.get(current.pick.id);
      if (kept) kept.pick = current.pick;
    }
    if (!selectionRect()) {
      hide();
      return;
    }
    fresh();
    place();
    arm();
  });

  const refuse = (key: BridgeTextKey) => ({ ok: false as const, reason: texts.get(key) });

  const showAfterShot = () => {
    if (hiddenForShot) hostEl.style.setProperty("visibility", "visible", "important");
    hiddenForShot = false;
  };

  /** 这个编号的元素：换了网页、不认得、不在页面上了回原因 */
  const lookup = (id: string, url: string): { kept: Kept; el: Element } | { ok: false; reason: string } => {
    if (url && deps.pageInfo().url !== url) return refuse("bridge.reason.refMoved");
    const kept = keptPicks.get(id);
    if (!kept) return refuse("bridge.reason.elementUnknown");
    const el = kept.el.deref();
    if (!el || !el.isConnected) return refuse("bridge.reason.elementGone");
    return { kept, el };
  };

  const bytesOfBase64 = (base64: string): Uint8Array => {
    const binary = deps.decode(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const bytesOfDataUrl = (url: string): { bytes: Uint8Array; mime: string } => {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("data");
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    const mime = meta.split(";")[0] || "application/octet-stream";
    if (/;base64$/i.test(meta)) return { bytes: bytesOfBase64(body), mime };
    return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
  };

  return {
    owns: (id) => current?.pick.id === id,
    shown: () => current !== undefined,
    rect() {
      if (!current) return undefined;
      const r = button.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    },
    fresh,
    mark(next) {
      setMark(next);
      if (next === "idle" && !inUse() && current) arm();
    },
    bubbleClosed() {
      if (!press) hide();
    },
    scrolled() {
      if (current && !inUse()) hide();
    },
    fieldFocused() {
      if (current && !inUse()) hide();
    },
    info(id, url) {
      const found = lookup(id, url);
      if ("ok" in found) return found;
      return { ok: true, page: deps.pageInfo(), element: found.kept.pick };
    },
    prepare(id, url) {
      const found = lookup(id, url);
      if ("ok" in found) return found;
      const { pick } = found.kept;
      try {
        if (found.el instanceof win.HTMLCanvasElement) {
          prepared.set(id, { state: "ready", ...bytesOfDataUrl(found.el.toDataURL("image/png")) });
          return { ok: true };
        }
        const src = found.el instanceof win.HTMLImageElement ? found.el.currentSrc || found.el.src : found.el instanceof win.HTMLVideoElement ? found.el.currentSrc || found.el.src : "";
        if (pick.source === "data") {
          prepared.set(id, { state: "ready", ...bytesOfDataUrl(src) });
          return { ok: true };
        }
        if (pick.source === "blob" && fetchFn) {
          prepared.set(id, { state: "reading" });
          void fetchFn(src)
            .then(async (res) => {
              const blob = await res.blob();
              prepared.set(id, { state: "ready", bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "application/octet-stream" });
            })
            .catch(() => prepared.set(id, { state: "failed", reason: texts.get("bridge.reason.elementUnreadable") }));
          return { ok: true };
        }
      } catch {
        // 跨站的图画过的 canvas（SecurityError）、写坏的 data 地址：读不了
      }
      return refuse("bridge.reason.elementUnreadable");
    },
    chunk(id, offset) {
      const data = prepared.get(id);
      if (!data) return refuse("bridge.reason.elementUnreadable");
      if (data.state === "reading") return { ok: true, ready: false };
      if (data.state === "failed") return { ok: false, reason: data.reason };
      const end = Math.min(data.bytes.length, offset + CHUNK_BYTES);
      let binary = "";
      for (let i = offset; i < end; i += 0x8000) binary += String.fromCharCode(...data.bytes.subarray(i, Math.min(end, i + 0x8000)));
      const done = end >= data.bytes.length;
      if (done) prepared.delete(id);
      return { ok: true, ready: true, base64: deps.encode(binary), mime: data.mime, total: data.bytes.length, done };
    },
    shotRect(id, url) {
      const found = lookup(id, url);
      if ("ok" in found) return found;
      // SVG 按在里面的图形上时截整张
      const el = found.el.closest("svg") ?? found.el;
      const area = deps.visibleArea();
      const first = el.getBoundingClientRect();
      if (first.top < area.top || first.bottom > area.bottom || first.left < area.left || first.right > area.right) el.scrollIntoView({ block: "center", inline: "center" });
      hostEl.style.setProperty("visibility", "hidden", "important");
      hiddenForShot = true;
      deps.setTimer(showAfterShot, SHOT_HIDE_MAX_MS);
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, area.left);
      const top = Math.max(r.top, area.top);
      const right = Math.min(r.right, area.right);
      const bottom = Math.min(r.bottom, area.bottom);
      if (right <= left || bottom <= top) {
        hostEl.style.setProperty("visibility", "visible", "important");
        hiddenForShot = false;
        return refuse("bridge.reason.elementHidden");
      }
      const scale = win.visualViewport?.scale ?? 1;
      const ratio = win.devicePixelRatio || 1;
      return {
        ok: true,
        x: (left - area.left) * scale * ratio,
        y: (top - area.top) * scale * ratio,
        width: (right - left) * scale * ratio,
        height: (bottom - top) * scale * ratio,
        dpr: ratio,
        partial: left > r.left || top > r.top || right < r.right || bottom < r.bottom,
      };
    },
    shotDone() {
      showAfterShot();
      return { ok: true };
    },
  };
}
