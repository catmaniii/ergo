// 选中的地址用地图（447）：网页上选中的字像地址、地名时（rules.ts 的 guessAddress，拿不准也给），长按 / 选中出来的二狗圆钮旁边
// 多一行两个小按钮——"在地图上看"（二狗的网页直接查这一处、打开地图页定位，不经对话）、"怎么去"（交给二狗算路线、出路线卡）。
// 画在页面桥同一个封闭的 shadow root 里（样式走构造的样式表，网站的 CSP 管不着），摆在圆钮旁边（rules.ts 的 placeMapChips）；
// 只认真的用户操作，按下时不让网页收到（选区不丢）。鸿蒙长按后很快松手时 pointer 可能还落在原来的元素上，所以和圆钮一样
// pointer、touch 两条路都听，同一下只算一次。点了什么交给 element.ts（报 element-map）。
// 二狗的网页能接这两个动作（地图插件开着、网页够新）才给：随页面桥自己的那几句交来（texts 的 map，见 texts.ts），没交来不给。
import type { BridgeTexts } from "./texts.ts";

/** 两个动作：在地图上看、怎么去 */
export type MapChipAction = "show" | "route";

/** 地图上的定位针、两点间的路线（SVG，跟着字的颜色） */
const ICON_PIN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>';
const ICON_ROUTE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/></svg>';

export const MAP_CHIPS_STYLE = `
.map-chips { position: fixed; left: 0; top: 0; display: none; gap: 6px; z-index: 1; }
.map-chips.on { display: flex; }
.map-chip {
  display: flex; align-items: center; gap: 4px; height: 32px; margin: 0; padding: 0 12px; box-sizing: border-box; border: 0; border-radius: 16px;
  background: #fff; color: #1d2433; white-space: nowrap; cursor: pointer;
  box-shadow: 0 4px 14px rgba(20, 30, 70, .22), 0 0 0 1px rgba(20, 30, 70, .1);
  font: 600 13px/1 system-ui, -apple-system, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
}
.map-chip svg { flex: none; color: #3a5bd9; }
.map-chip:active { transform: scale(.96); }
@media (prefers-color-scheme: dark) {
  .map-chip { background: #252a34; color: #e7eaf0; box-shadow: 0 4px 14px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .1); }
  .map-chip svg { color: #8aa4ff; }
}`;

export interface MapChips {
  readonly el: HTMLElement;
  /** 显示着 */
  shown(): boolean;
  /** 摆到这里显示（左上角，视口坐标） */
  showAt(x: number, y: number): void;
  hide(): void;
  /** 显示时的大小（摆之前先显示出来量） */
  size(): { width: number; height: number };
  /** 换了语言：重写两个按钮上的字 */
  relabel(): void;
}

const stop = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

/** 建那一行（先藏着）；点了哪个交给 onAction */
export function createMapChips(doc: Document, texts: BridgeTexts, onAction: (action: MapChipAction) => void): MapChips {
  const root = doc.createElement("div");
  root.className = "map-chips";
  root.setAttribute("role", "toolbar");
  const chips: { action: MapChipAction; el: HTMLElement; label: HTMLElement }[] = [];
  /** 按下的那一个（pointer、touch 两条路共用：同一下只算一次） */
  let pressed: MapChipAction | undefined;
  for (const [action, icon] of [
    ["show", ICON_PIN],
    ["route", ICON_ROUTE],
  ] as const) {
    const el = doc.createElement("div");
    el.className = "map-chip";
    el.dataset.act = action;
    el.setAttribute("role", "button");
    el.innerHTML = icon;
    const label = doc.createElement("span");
    el.append(label);
    const press = (e: Event) => {
      stop(e);
      if (e.isTrusted) pressed = action;
    };
    const release = (e: Event) => {
      stop(e);
      if (!e.isTrusted || pressed !== action) return;
      pressed = undefined;
      onAction(action);
    };
    el.addEventListener("mousedown", stop);
    el.addEventListener("contextmenu", stop);
    el.addEventListener("click", stop);
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", () => (pressed = undefined));
    el.addEventListener("touchstart", press, { passive: false });
    el.addEventListener("touchend", release);
    el.addEventListener("touchcancel", () => (pressed = undefined));
    root.append(el);
    chips.push({ action, el, label });
  }
  const relabel = () => {
    for (const c of chips) {
      const text = texts.get(c.action === "show" ? "bridge.map.show" : "bridge.map.route");
      c.label.textContent = text;
      c.el.setAttribute("aria-label", text);
    }
  };
  relabel();
  return {
    el: root,
    shown: () => root.classList.contains("on"),
    showAt(x, y) {
      root.style.left = `${Math.round(x)}px`;
      root.style.top = `${Math.round(y)}px`;
      root.classList.add("on");
    },
    hide() {
      pressed = undefined;
      root.classList.remove("on");
    },
    size() {
      const r = root.getBoundingClientRect();
      return { width: r.width, height: r.height };
    },
    relabel,
  };
}
