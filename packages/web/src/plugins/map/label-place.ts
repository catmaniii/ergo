// 把 label-layout.ts 排出来的位置用到地图上点旁边的字上（451 补，用户 2026-11-09：字不互相盖住，挤开了用一条线连到点上）。
// OpenStreetMap（osm-engine.ts）、地图页盖在高德谷歌上面的那一层（overlay.ts）、点开卡片时那张静态大图（static-overlay.tsx）三处共用：
// - 量：每个点（.map-mark，它的底边正中就是点）的大小、针（.map-pin）占的那一块、字（.map-mark-label）照旧的位置和宽高
//   （CSS 写的针的右边；挪字用 transform，不改 offsetLeft/Top）。量过的按字（没有字按针）的元素记着；字体、风格、深浅换了、
//   字框变了（ResizeObserver 报）再量。量不到的（display: none 的字）不排；
// - 只排看得见的：没藏着的点（离这一块 200 像素以外的点两种画法本来就藏着）；眼睛钮藏起二狗画的那一层时
//   （.map-canvas[data-marks="hidden"]）只排「当前位置」，开关一变就重排；
// - 字尽量不出这一块（clip：地图那块、静态图看得见的那一块），出了边看不见；
// - 每帧最多排一次：同一份（哪几个、彼此的相对位置、字框大小都没变，这一块的边挪了不到 BOUNDS_STEP——只是拖了一点）
//   直接用上一次的；变了而这一帧已经排过，留到下一帧；
// - 摆：字用 transform 从照旧的位置挪过去（回到照旧就清掉），挪开了的标 data-moved，在引线那一层（.map-leaders，压在点下面、
//   线和圈上面）画一条细线从字框边上连到点（针尖、圆点中心）。线的 data-kind 跟着点：眼睛钮藏起来时「当前位置」那条照旧。
import { type LabelBox, type LabelPlacement, layoutLabels, type PinBox, type Rect } from "./label-layout.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 拖的时候这一块的边（相对点）挪了这么多（像素）才重排：靠边的字该换边时换，不用每一帧都排 */
const BOUNDS_STEP = 16;

/** 先排谁（大的先）：停留、搜到的、查路线的那一头 > 地点 > 「当前位置」 > 照片的时间 */
const RANK: Readonly<Record<string, number>> = { stay: 4, search: 4, here: 4, place: 3, me: 2, photo: 1 };

/** 摆好的一个点 */
export interface PlacedMark {
  readonly id: string;
  /** 点的种类（MapMark.kind，没写是 place） */
  readonly kind: string;
  /** 点的元素：它的底边正中是点 */
  readonly el: HTMLElement;
  readonly pin: HTMLElement | undefined;
  readonly label: HTMLElement | undefined;
  /** 点在这一块里的位置（像素） */
  readonly x: number;
  readonly y: number;
}

export interface LabelPlacer {
  /** 点都摆好以后调（每次视野变了都调）：排字、画引线。clip 是看得见的那一块（同一套坐标），字尽量不出它 */
  update(marks: readonly PlacedMark[], clip?: Rect): void;
  destroy(): void;
}

/** 量出来的：针占的那一块、字照旧的位置和宽高（都相对点） */
interface Measure {
  readonly pin: Rect;
  readonly label: { readonly dx: number; readonly dy: number; readonly width: number; readonly height: number } | undefined;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 量一个点（量不到——藏着、还没进页面——给 undefined） */
function measureMark(m: PlacedMark): Measure | undefined {
  const bw = num(m.el.offsetWidth);
  const bh = num(m.el.offsetHeight);
  if (bw <= 0 || bh <= 0) return undefined;
  const ax = bw / 2;
  const ay = bh;
  const p = m.pin;
  const box = p && num(p.offsetWidth) > 0 ? { left: p.offsetLeft - ax, top: p.offsetTop - ay, right: p.offsetLeft + p.offsetWidth - ax, bottom: p.offsetTop + p.offsetHeight - ay } : { left: -ax, top: -ay, right: ax, bottom: 0 };
  // 针尖（点本身）也算进针占的那一块
  const pin: Rect = { left: Math.min(box.left, -2), top: Math.min(box.top, -2), right: Math.max(box.right, 2), bottom: Math.max(box.bottom, 2) };
  const l = m.label;
  const label = l && num(l.offsetWidth) > 0 && num(l.offsetHeight) > 0 ? { dx: l.offsetLeft - ax, dy: l.offsetTop - ay, width: l.offsetWidth, height: l.offsetHeight } : undefined;
  return { pin, label };
}

/** 在 host 里建引线那一层（host 和点那一层一样大、坐标一样） */
export function createLabelPlacer(host: HTMLElement): LabelPlacer {
  const doc = host.ownerDocument;
  const win: (Window & typeof globalThis) | undefined = doc.defaultView ?? (typeof window === "undefined" ? undefined : window);
  const raf = win && typeof win.requestAnimationFrame === "function" ? (fn: () => void) => win.requestAnimationFrame(fn) : undefined;
  const leaders = doc.createElementNS(SVG_NS, "svg");
  leaders.setAttribute("class", "map-leaders");
  leaders.setAttribute("aria-hidden", "true");
  host.append(leaders);
  const lines = new Map<string, SVGLineElement>();

  /** 量过的（按字、没有字按针的元素） */
  const measured = new WeakMap<Element, Measure>();
  /** 这一次排了的字（下一次没排到的放回照旧的位置） */
  const shifted = new Map<string, HTMLElement>();
  /** 上一次各自排在哪 */
  let placements = new Map<string, LabelPlacement>();
  let lastKey = "";
  let latest: { marks: readonly PlacedMark[]; clip: Rect | undefined } = { marks: [], clip: undefined };
  let frame = 0;
  /** 这一帧已经排过一次了 */
  let busy = false;
  /** 有变化留到下一帧排 */
  let dirty = false;
  let destroyed = false;

  // 字框变了（字体加载完、换了风格、深浅）：重量、重排
  const sizes =
    win && typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver((entries) => {
          let changed = false;
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const was = measured.get(el)?.label;
            if (was && (Math.round(was.width) !== el.offsetWidth || Math.round(was.height) !== el.offsetHeight)) {
              measured.delete(el);
              changed = true;
            }
          }
          if (changed) later();
        })
      : undefined;
  /** 正看着大小的字（换了一份点、字没了就不看了） */
  const observed = new Set<HTMLElement>();
  const keyOf = (m: PlacedMark) => m.label ?? m.pin ?? m.el;
  const measure = (m: PlacedMark): Measure | undefined => {
    const k = keyOf(m);
    const hit = measured.get(k);
    if (hit) return hit;
    const got = measureMark(m);
    // 字还量不到（display: none）的不记：露出来以后再量
    if (got && (m.label === undefined || got.label !== undefined)) {
      measured.set(k, got);
      if (m.label && sizes && !observed.has(m.label)) {
        sizes.observe(m.label);
        observed.add(m.label);
      }
    }
    return got;
  };

  // 眼睛钮：藏起来时只排「当前位置」
  const canvas = typeof host.closest === "function" ? host.closest<HTMLElement>(".map-canvas") : null;
  const toggles =
    canvas && win && typeof win.MutationObserver === "function"
      ? new win.MutationObserver(() => {
          lastKey = "";
          later();
        })
      : undefined;
  if (canvas) toggles?.observe(canvas, { attributes: true, attributeFilter: ["data-marks"] });

  /** 下一帧再排一次 */
  function later() {
    dirty = true;
    lastKey = "";
    if (raf) tick();
    else run();
  }
  /** 这一帧排过了：到下一帧解开，有留下的就排 */
  function tick() {
    if (!raf || frame !== 0 || destroyed) return;
    frame = raf(() => {
      frame = 0;
      busy = false;
      if (dirty) {
        dirty = false;
        run();
      }
    });
  }

  const drawLeaders = (marks: readonly PlacedMark[]) => {
    const keep = new Set<string>();
    for (const m of marks) {
      const p = placements.get(m.id);
      if (!p?.moved || !p.leader || m.el.hidden) continue;
      keep.add(m.id);
      let line = lines.get(m.id);
      if (!line) {
        line = doc.createElementNS(SVG_NS, "line");
        line.setAttribute("class", "map-leader");
        line.setAttribute("data-id", m.id);
        lines.set(m.id, line);
        leaders.append(line);
      }
      line.setAttribute("data-kind", m.kind);
      line.setAttribute("x1", (m.x + p.leader.x).toFixed(1));
      line.setAttribute("y1", (m.y + p.leader.y).toFixed(1));
      line.setAttribute("x2", m.x.toFixed(1));
      line.setAttribute("y2", m.y.toFixed(1));
    }
    for (const [id, line] of lines) {
      if (keep.has(id)) continue;
      line.remove();
      lines.delete(id);
    }
  };

  function run() {
    if (destroyed) return;
    const { marks, clip } = latest;
    const hiddenMode = canvas?.getAttribute("data-marks") === "hidden";
    const shown: Array<{ m: PlacedMark; size: Measure }> = [];
    for (const m of marks) {
      if (m.el.hidden || (hiddenMode && m.kind !== "me")) continue;
      const size = measure(m);
      if (size) shown.push({ m, size });
    }
    const x0 = shown[0]?.m.x ?? 0;
    const y0 = shown[0]?.m.y ?? 0;
    // 这一份长什么样：只是拖（相对位置没变）就和上一次一样
    const key = [
      hiddenMode ? "h" : "s",
      clip ? [clip.left - x0, clip.top - y0, clip.right - x0, clip.bottom - y0].map((n) => Math.round(n / BOUNDS_STEP)).join(",") : "",
      ...shown.map(({ m, size }) => `${m.id}:${(m.x - x0).toFixed(1)},${(m.y - y0).toFixed(1)}:${size.label ? `${size.label.width}x${size.label.height}` : "-"}`),
    ].join("|");
    if (key !== lastKey) {
      if (busy && raf) {
        // 这一帧排过了：留到下一帧
        dirty = true;
        tick();
      } else {
        lastKey = key;
        busy = raf !== undefined;
        tick();
        const labels: LabelBox[] = [];
        const pins: PinBox[] = [];
        const els = new Map<string, { label: HTMLElement; size: NonNullable<Measure["label"]> }>();
        for (const { m, size } of shown) {
          if (size.label && m.label) {
            labels.push({ id: m.id, x: m.x, y: m.y, ...size.label, pin: size.pin, rank: RANK[m.kind] ?? 3 });
            els.set(m.id, { label: m.label, size: size.label });
          } else pins.push({ x: m.x, y: m.y, pin: size.pin });
        }
        const prefer = new Map([...placements.values()].map((p) => [p.id, { dx: p.dx, dy: p.dy }]));
        const next = new Map<string, LabelPlacement>();
        for (const p of layoutLabels(labels, { pins, prefer, ...(clip ? { bounds: clip } : {}) })) next.set(p.id, p);
        // 摆：照旧位置的清掉 transform；这一次没排到的（藏起来了、出了这一块）放回照旧的位置
        for (const [id, label] of shifted) {
          if (next.has(id) && els.get(id)?.label === label) continue;
          label.style.transform = "";
          delete label.dataset.moved;
          shifted.delete(id);
        }
        for (const [id, p] of next) {
          const { label, size } = els.get(id)!;
          const tx = p.dx - size.dx;
          const ty = p.dy - size.dy;
          const at = Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5;
          label.style.transform = at ? "" : `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
          if (p.moved) label.dataset.moved = "";
          else delete label.dataset.moved;
          if (at && !p.moved) shifted.delete(id);
          else shifted.set(id, label);
        }
        placements = next;
        // 不在这一份里的字不再看它的大小（点换了一份，旧的字已经拿掉了）
        if (observed.size > 0) {
          const present = new Set(marks.flatMap((m) => (m.label ? [m.label] : [])));
          for (const el of observed) {
            if (present.has(el)) continue;
            sizes?.unobserve(el);
            observed.delete(el);
          }
        }
      }
    }
    drawLeaders(marks);
  }

  return {
    update(marks, clip) {
      latest = { marks, clip };
      run();
    },
    destroy() {
      destroyed = true;
      if (frame !== 0) win?.cancelAnimationFrame(frame);
      sizes?.disconnect();
      observed.clear();
      toggles?.disconnect();
      leaders.remove();
      lines.clear();
      shifted.clear();
    },
  };
}
