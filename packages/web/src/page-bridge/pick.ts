// 挑图片窗口（149 号票，用户 2026-10-18："挑图片的窗口不跟着悬浮按钮，固定弹在屏幕上让用户挑。二狗的聊天窗里也能看到、能挑"）：
// 秘书给候选（网页候选卡）时，这个框所在的网页上弹出的窗口。画在页面桥那个封闭的 shadow root 里（和悬浮按钮、气泡一起），
// 只管画和收用户点了什么，样子由宿主交来（PagePickView：二狗的网页 app/page-pick.ts 照候选卡算好），点了什么交给 onAction。
// - 摆在哪（rules.ts 的 placePickWindow）：只看看得见的部分——手机上贴着底、占满宽，宽屏底部居中、宽度有上限；不跟着悬浮按钮，
//   不随网页滚动（position: fixed，每一帧照看得见的部分对一次：输入法弹起时贴着它上面）；
// - 一排缩略图能左右滑：单张的框点一张选一张（单选），多张的框每张能勾能取消；下面"都不要""交 / 交 N 个"；右上角 × 收起
//   （会话里的候选卡照样能挑）；
// - 缩略图是二狗的网页凭取件码从守护进程取来的小图（base64），在这里解成位图画进 canvas——不用 <img src="data:…">，免得网站的 CSP
//   不许 data: 图片；没有缩略图（不是图片、做不出来）的画文件图标和名字；文字一律 textContent。
// - 169 号票：窗口自己的字（"都不要""交"、读屏的说明）按二狗的网页交来的语言（texts.ts），没交来是中文；标题、提示本来就由网页给。
// - 181 号票：标题里的名字（网页另给的 titleParts）画成名字标签，颜色和气泡里的一样（同一个 shadow root 里的样式表）；读屏说明是纯名字。
import { appendNamed, el, ICON_CLOSE, makeButton, namedTextOf, stopBubbling } from "./bubble.ts";
import type { PageBubbleFile, PagePickAction, PagePickPhase, PagePickView } from "./protocol.ts";
import { PICK_MAX_HEIGHT, placePickWindow, type Rect } from "./rules.ts";
import type { BridgeTexts } from "./texts.ts";

const ICON_DOC =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

/** 挑图片窗口的样式（接在气泡的样式后面，同一个 shadow root）：只用像素和写死的颜色 */
export const PICK_STYLE = `
.pick {
  position: fixed; left: 0; top: 0; box-sizing: border-box; display: none; flex-direction: column;
  max-height: ${PICK_MAX_HEIGHT}px; background: #fff; color: #1d2433; border-radius: 16px;
  box-shadow: 0 -6px 28px rgba(20, 30, 70, .22), 0 0 0 1px rgba(20, 30, 70, .08);
  font: 14px/1.45 system-ui, -apple-system, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: left; -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.pick.on { display: flex; }
.pick.placing { opacity: 0; }
.pick.docked { border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }
.pick * { box-sizing: border-box; }
.pick-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 6px 2px 16px; }
.pick-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.pick-strip {
  display: flex; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 8px 16px 6px;
  overscroll-behavior-x: contain; scrollbar-width: thin; -webkit-overflow-scrolling: touch;
}
.pick-tile {
  position: relative; flex: none; width: 92px; height: 92px; margin: 0; padding: 0; overflow: hidden; cursor: pointer;
  border: 2px solid transparent; border-radius: 12px; background: #eef1f7; color: #4a5266; font: inherit;
}
.pick-tile canvas { display: block; width: 100%; height: 100%; }
.pick-tile.checked { border-color: #3a5bd9; box-shadow: 0 0 0 2px rgba(58, 91, 217, .25); }
.pick-tile:disabled { opacity: .6; cursor: default; }
.pick-doc { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 100%; height: 100%; padding: 6px; }
.pick-name { display: block; max-width: 100%; font-size: 11px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-mark {
  position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; border-radius: 50%;
  background: rgba(255, 255, 255, .92); border: 1.5px solid #9aa3b5; color: #fff; font-size: 13px; line-height: 19px; text-align: center;
}
.pick-tile.checked .pick-mark { background: #3a5bd9; border-color: #3a5bd9; }
.pick-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 16px 14px; }
.pick-note { flex: 1 1 auto; min-width: 0; font-size: 12px; color: #6b7385; }
.pick-note.ok { color: #1f9d55; font-weight: 600; }
.pick-note.failed { color: #d63b3b; }
@media (prefers-color-scheme: dark) {
  .pick { background: #252a34; color: #e7eaf0; box-shadow: 0 -6px 28px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .08); }
  .pick-note { color: #a3abbd; }
  .pick-tile { background: #323846; color: #e7eaf0; }
}
`;

/** 页面桥在注入那一刻记下的内置函数（网页的脚本之后改了也碍不着） */
export interface PickTools {
  decode(base64: string): string;
  makeBitmap(blob: Blob): Promise<ImageBitmap>;
  BlobCtor: typeof Blob;
  /** 页面桥自己的字（169 号票） */
  texts: BridgeTexts;
}

export interface PickWindow {
  readonly el: HTMLElement;
  readonly open: boolean;
  readonly view: PagePickView;
  /** 宿主交来的样子（一样的不重画） */
  show(view: PagePickView): void;
  /** 收起（返回手势、页面桥自己收）；宿主随后交来 none */
  hide(): void;
  /** 二狗的网页交来了别的语言（169 号票）、别的名字（181 号票）：说明、按钮上的字换过来（勾着的、横排滚到哪不动） */
  relabel(): void;
  /** 每一帧摆位置：view 是看得见的部分；回窗口现在占的那一块（没开着是 undefined，气泡据此不盖住它） */
  frame(view: Rect): Rect | undefined;
}

const NONE: PagePickView = { kind: "none" };
const PHASES: readonly string[] = ["choosing", "sending", "done", "failed"];
const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.slice(0, max) : "");

function fileOf(v: unknown): PageBubbleFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const f = v as Record<string, unknown>;
  const token = str(f.token, 64);
  if (!token) return undefined;
  return { token, name: str(f.name, 300), image: f.image === true, thumb: str(f.thumb, 2_000_000), checked: f.checked === true };
}

/** 宿主交来的样子（JSON 解出来的）：认不得的当 undefined */
export function pickViewOf(value: unknown): PagePickView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "none") return NONE;
  if (v.kind !== "pick") return undefined;
  const id = str(v.id, 100);
  if (!id) return undefined;
  const phase = str(v.phase, 20);
  const titleParts = namedTextOf(v.titleParts, 200);
  return {
    kind: "pick",
    id,
    title: str(v.title, 200),
    ...(titleParts ? { titleParts } : {}),
    note: str(v.note, 600),
    files: Array.isArray(v.files) ? v.files.slice(0, 40).flatMap((f) => fileOf(f) ?? []) : [],
    multiple: v.multiple === true,
    phase: PHASES.includes(phase) ? (phase as PagePickPhase) : "choosing",
  };
}

export function createPickWindow(doc: Document, tools: PickTools, onAction: (action: PagePickAction) => void): PickWindow {
  const tx = tools.texts;
  const root = el(doc, "div", "pick");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", tx.get("bridge.pick.title"));
  const head = el(doc, "div", "pick-head");
  const title = el(doc, "span", "pick-title");
  const close = el(doc, "button", "x");
  close.type = "button";
  close.setAttribute("aria-label", tx.get("bridge.pick.close"));
  close.innerHTML = ICON_CLOSE;
  head.append(title, close);
  const body = el(doc, "div", "pick-body");
  const strip = el(doc, "div", "pick-strip");
  body.append(strip);
  const foot = el(doc, "div", "pick-foot");
  const note = el(doc, "span", "pick-note");
  root.append(head, body, foot);
  stopBubbling(root);

  let view: PagePickView = NONE;
  /** 同一张卡、同一批候选：只改勾没勾、缩略图、按钮（横排不跳回开头） */
  let shape = "";
  let tiles = new Map<string, HTMLButtonElement>();
  let dismiss: HTMLButtonElement | undefined;
  let deliver: HTMLButtonElement | undefined;
  let lastJson = "";
  let lastPlace = "";
  const bitmaps = new Map<string, Promise<ImageBitmap | undefined>>();

  const act = (action: PagePickAction) => {
    if (action.action === "hide") hide();
    onAction(action);
  };
  close.addEventListener("mousedown", (e) => e.preventDefault());
  close.addEventListener("click", (e) => {
    if (e.isTrusted && view.kind === "pick") act({ id: view.id, action: "hide" });
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.isTrusted && view.kind === "pick") {
      e.preventDefault();
      act({ id: view.id, action: "hide" });
    }
  });

  /** 解出一张缩略图（同一个取件码只解一次） */
  const bitmapOf = (token: string, base64: string): Promise<ImageBitmap | undefined> => {
    let p = bitmaps.get(token);
    if (!p) {
      p = (async () => {
        try {
          const binary = tools.decode(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return await tools.makeBitmap(new tools.BlobCtor([bytes]));
        } catch {
          return undefined;
        }
      })();
      bitmaps.set(token, p);
      if (bitmaps.size > 60) bitmaps.delete(bitmaps.keys().next().value!);
    }
    return p;
  };

  /** 格子里画缩略图（没有缩略图、不是图片的画文件图标和名字） */
  const fillTile = (tile: HTMLElement, file: PageBubbleFile) => {
    if (tile.dataset.thumb === "1") return;
    if (file.image && file.thumb) {
      tile.dataset.thumb = "1";
      const canvas = el(doc, "canvas");
      canvas.width = 192;
      canvas.height = 192;
      tile.querySelector(".pick-doc")?.remove();
      tile.prepend(canvas);
      void bitmapOf(file.token, file.thumb).then((bitmap) => {
        if (!bitmap) {
          // 解不开：换回名字
          canvas.remove();
          delete tile.dataset.thumb;
          fillTile(tile, { ...file, thumb: "" });
          return;
        }
        const ctx = canvas.getContext("2d");
        const side = Math.min(bitmap.width, bitmap.height);
        ctx?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      });
    } else if (!tile.querySelector(".pick-doc")) {
      const docBox = el(doc, "span", "pick-doc");
      docBox.innerHTML = ICON_DOC;
      docBox.append(el(doc, "span", "pick-name", file.name));
      tile.prepend(docBox);
    }
  };

  const update = (v: Extract<PagePickView, { kind: "pick" }>) => {
    // 标题：网页给了几段（181 号票）名字画成名字标签，没给（旧版网页）是纯文字
    title.replaceChildren();
    appendNamed(doc, title, v.titleParts ?? [v.title]);
    const busy = v.phase === "sending" || v.phase === "done";
    for (const file of v.files) {
      const tile = tiles.get(file.token);
      if (!tile) continue;
      fillTile(tile, file);
      tile.classList.toggle("checked", file.checked);
      tile.setAttribute("aria-checked", String(file.checked));
      tile.disabled = busy;
      const mark = tile.querySelector(".pick-mark");
      if (mark) mark.textContent = file.checked ? "✓" : "";
    }
    const count = v.files.filter((f) => f.checked).length;
    note.textContent = v.note;
    note.className = `pick-note${v.phase === "done" ? " ok" : v.phase === "failed" ? " failed" : ""}`;
    if (deliver) {
      deliver.textContent = v.phase === "sending" ? tx.get("bridge.pick.sending") : v.multiple ? tx.get("bridge.pick.deliverCount", { count }) : tx.get("bridge.pick.deliver");
      deliver.disabled = busy || count === 0;
      deliver.style.display = v.phase === "done" ? "none" : "";
    }
    if (dismiss) {
      dismiss.disabled = busy;
      dismiss.style.display = v.phase === "done" ? "none" : "";
    }
    close.style.display = v.phase === "sending" ? "none" : "";
  };

  const render = (next: PagePickView) => {
    view = next;
    if (next.kind === "none") {
      root.classList.remove("on");
      strip.replaceChildren();
      foot.replaceChildren();
      tiles = new Map();
      shape = "";
      lastPlace = "";
      return;
    }
    if (!root.classList.contains("on")) {
      root.classList.add("on", "placing");
      lastPlace = "";
    }
    const nextShape = JSON.stringify([next.id, next.multiple, next.files.map((f) => f.token)]);
    if (nextShape !== shape) {
      shape = nextShape;
      strip.replaceChildren();
      strip.scrollLeft = 0;
      tiles = new Map();
      strip.setAttribute("role", next.multiple ? "group" : "radiogroup");
      strip.setAttribute("aria-label", tx.get(next.multiple ? "bridge.pick.stripMultiple" : "bridge.pick.stripSingle"));
      for (const file of next.files) {
        const id = next.id;
        const tile = makeButton(doc, "pick-tile", "", () => act({ id, action: "choose", token: file.token }));
        tile.setAttribute("role", next.multiple ? "checkbox" : "radio");
        tile.title = file.name;
        tile.dataset.token = file.token;
        tile.append(el(doc, "span", "pick-mark"));
        strip.append(tile);
        tiles.set(file.token, tile);
      }
      const id = next.id;
      dismiss = makeButton(doc, "btn", tx.get("bridge.pick.dismiss"), () => act({ id, action: "dismiss" }));
      deliver = makeButton(doc, "btn primary", tx.get("bridge.pick.deliver"), () => act({ id, action: "deliver" }));
      foot.replaceChildren(note, dismiss, deliver);
    }
    update(next);
  };

  const show = (next: PagePickView) => {
    const json = JSON.stringify(next);
    if (json === lastJson) return;
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
    hide,
    relabel() {
      root.setAttribute("aria-label", tx.get("bridge.pick.title"));
      close.setAttribute("aria-label", tx.get("bridge.pick.close"));
      if (view.kind !== "pick") return;
      strip.setAttribute("aria-label", tx.get(view.multiple ? "bridge.pick.stripMultiple" : "bridge.pick.stripSingle"));
      if (dismiss) dismiss.textContent = tx.get("bridge.pick.dismiss");
      update(view);
    },
    frame(area) {
      if (view.kind === "none") return undefined;
      const natural = root.offsetHeight - body.clientHeight + body.scrollHeight;
      const at = placePickWindow(area, natural);
      const key = `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.width)},${Math.round(at.maxHeight)},${at.docked}`;
      if (key !== lastPlace) {
        lastPlace = key;
        root.style.left = `${Math.round(at.x)}px`;
        root.style.top = `${Math.round(at.y)}px`;
        root.style.width = `${Math.round(at.width)}px`;
        root.style.maxHeight = `${Math.round(at.maxHeight)}px`;
        root.classList.toggle("docked", at.docked);
        root.classList.remove("placing");
      }
      return { left: at.x, top: at.y, right: at.x + at.width, bottom: at.y + Math.min(natural, at.maxHeight) };
    },
  };
}
