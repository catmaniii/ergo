// 地图上点旁边的字不互相盖住（451 补，用户 2026-11-09："如果文本正常显示会覆盖，那就互相挤开，然后用一条线连到那个标记的点上去"）。
// 纯函数，不碰 DOM，测试在 Node 里跑：输入每个点在哪（像素）、它的字框多大、照旧放在哪（针的右边），和地图上别的针（圆点）占的那一块；
// 输出每个字放在哪、要不要画引线。DOM 那一半（量字框、摆、画线）在 label-place.ts。
// 排法（贪心，重要的先排，同样重要的照给的先后）：
// 1. 照旧的位置（针的右边）；
// 2. 放不下先试针旁边几个近的：左边、右上、右下、左上、左下、正上、正下——还贴着针，不画引线；
// 3. 还不行往外挪：以点为圆心一圈一圈往外找（字框的中心落在圈上，一圈取若干个方向），挪开了的从字框边上画一条线连到点；
// 4. 硬规矩只有一条：字和字不相交（中间至少留 LABEL_GAP）。盖住针、出了边（给了 bounds 时）、引线穿过别的字、离点远都只算"代价"，
//    挑代价最小的；往外一圈一圈找到"再往外不可能更好"就停。够远的地方总是空的，所以总排得下（点太密时字离点远一些，也不叠在一起）。
// 上一次挪到外面的那一处（prefer）有一点优惠：拖、缩放时字不来回跳。点很多时用格子索引查"附近有谁"，几十个点一次排完是几毫秒的事。

/** 一块（像素）：左、上、右、下 */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 一个要排的字 */
export interface LabelBox {
  readonly id: string;
  /** 点（针尖、圆点的中心）在哪 */
  readonly x: number;
  readonly y: number;
  /** 字框的宽高 */
  readonly width: number;
  readonly height: number;
  /** 照旧的位置：字框左上角相对点的偏移（针的右边） */
  readonly dx: number;
  readonly dy: number;
  /** 这个点的针（圆点）占的那一块，相对点 */
  readonly pin: Rect;
  /** 先排谁：大的先排（一样大照给的先后） */
  readonly rank?: number;
}

/** 别的针（没有字的点也算）：字尽量不盖住它 */
export interface PinBox {
  readonly x: number;
  readonly y: number;
  /** 相对点 */
  readonly pin: Rect;
}

/** 一个字排在哪 */
export interface LabelPlacement {
  readonly id: string;
  /** 字框左上角相对点的偏移 */
  readonly dx: number;
  readonly dy: number;
  /** 挪开了（不在针旁边那几个位置）：要画引线 */
  readonly moved: boolean;
  /** 引线从哪起：字框边上对着点的那一点（相对点）；另一头就是点（0, 0）。没挪开的没有 */
  readonly leader?: { readonly x: number; readonly y: number };
}

export interface LabelLayoutOptions {
  /** 别的针（给的字自己的针会自动算进来） */
  readonly pins?: readonly PinBox[];
  /**
   * 字尽量放在这一块里面（出了边算代价：出了边看不见、静态图上会被裁掉）；不给就不管。
   * 点自己在这一块外面的不管（针都看不见，不把它的字拉进来）
   */
  readonly bounds?: Rect;
  /** 上一次各自放在哪（相对点的偏移）：照旧放得下时优先 */
  readonly prefer?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>;
}

/** 字和字之间至少留这么多（像素） */
export const LABEL_GAP = 2;
/** 引线短于这么多（像素）就不画：字还挨着点 */
export const LEADER_MIN = 6;

// 代价（越小越好）：近的几个位置按先后 0、0.5、1……；往外挪的从 FAR_BASE 起，引线每长一像素加 FAR_PER_PX。
// 盖住一枚针 PIN_COST·(0.3 + 0.7·盖住的比例)；出了边 EDGE_COST 起；引线穿过一个已经排好的字 CROSS_COST；上一次挪到外面的那一处减 STICKY
const NEAR_STEP = 0.5;
const FAR_BASE = 8;
const FAR_PER_PX = 0.2;
const PIN_COST = 70;
const EDGE_COST = 60;
const CROSS_COST = 6;
const STICKY = 3;
/** 往外找：第一圈的半径、一圈比一圈大多少、圈上两个方向隔多远（像素） */
const RING_START = 16;
const RING_STEP = 8;
const ARC_STEP = 10;
/**
 * 找到第一个"干净"的空位（不盖针、不出边）以后最多再往外找 FAR_EXTRA；只找到不干净的空位时最多再找 FAR_FALLBACK
 * （靠边、针很密时往远处找一个干净的）；再远也停（防坏输入）
 */
const FAR_EXTRA = 48;
const FAR_FALLBACK = 240;
const RING_MAX = 4000;
/** 格子索引一格多大（像素） */
const CELL = 64;

/** 把一些框按格子放好，查"和这一块挨着的有谁"（每个只给一次） */
class Grid {
  private readonly cells = new Map<number, number[]>();
  private readonly rects: Rect[] = [];
  private readonly stamps: number[] = [];
  private query = 0;
  private static key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }
  add(r: Rect): void {
    const i = this.rects.length;
    this.rects.push(r);
    this.stamps.push(0);
    for (let cx = Math.floor(r.left / CELL); cx <= Math.floor(r.right / CELL); cx++) {
      for (let cy = Math.floor(r.top / CELL); cy <= Math.floor(r.bottom / CELL); cy++) {
        const k = Grid.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }
  /** 和 r（四周再放宽 pad）挨着的每一个交给 fn；fn 交回 true 就不往下看了（这时交回 true） */
  some(r: Rect, pad: number, fn: (o: Rect) => boolean): boolean {
    this.query += 1;
    for (let cx = Math.floor((r.left - pad) / CELL); cx <= Math.floor((r.right + pad) / CELL); cx++) {
      for (let cy = Math.floor((r.top - pad) / CELL); cy <= Math.floor((r.bottom + pad) / CELL); cy++) {
        const list = this.cells.get(Grid.key(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (this.stamps[i] === this.query) continue;
          this.stamps[i] = this.query;
          if (fn(this.rects[i]!)) return true;
        }
      }
    }
    return false;
  }
}

/** 两块相交（中间不到 gap 也算） */
export function rectsHit(a: Rect, b: Rect, gap = 0): boolean {
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const shift = (r: Rect, x: number, y: number): Rect => ({ left: r.left + x, top: r.top + y, right: r.right + x, bottom: r.bottom + y });

/** 线段 (x1,y1)-(x2,y2) 穿不穿过框 r（Liang–Barsky） */
function segmentHits(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x1 - r.left) && clip(dx, r.right - x1) && clip(-dy, y1 - r.top) && clip(dy, r.bottom - y1) && t0 < t1;
}

/**
 * 引线的起点：从字框中心朝点走、出字框的那一点（相对点）；点在字框里面（或贴着）给 undefined。
 * 引线就是这一点到点（0, 0）那一段，长度 = 这一点离点多远
 */
export function leaderStart(dx: number, dy: number, width: number, height: number): { x: number; y: number } | undefined {
  const cx = dx + width / 2;
  const cy = dy + height / 2;
  const tx = cx === 0 ? Infinity : width / 2 / Math.abs(cx);
  const ty = cy === 0 ? Infinity : height / 2 / Math.abs(cy);
  const t = Math.min(tx, ty);
  if (t >= 1) return undefined;
  return { x: cx * (1 - t), y: cy * (1 - t) };
}

/** 针旁边那几个近的位置（字框左上角相对点）：照旧（右边）、左边、右上、右下、左上、左下、正上、正下 */
function nearOffsets(l: LabelBox): Array<readonly [number, number]> {
  const { dx, dy, width: w, height: h, pin } = l;
  const left = -dx - w;
  const up = dy - h - LABEL_GAP;
  const down = dy + h + LABEL_GAP;
  return [
    [dx, dy],
    [left, dy],
    [dx, up],
    [dx, down],
    [left, up],
    [left, down],
    [-w / 2, pin.top - h - LABEL_GAP],
    [-w / 2, pin.bottom + LABEL_GAP],
  ];
}

const valid = (l: LabelBox) => [l.x, l.y, l.width, l.height, l.dx, l.dy].every(Number.isFinite) && l.width > 0 && l.height > 0;

/** 排一组字：每个字一份结果，和给的先后一样 */
export function layoutLabels(labels: readonly LabelBox[], options: LabelLayoutOptions = {}): LabelPlacement[] {
  const pins = new Grid();
  for (const p of [...labels.filter(valid), ...(options.pins ?? [])]) {
    const r = shift(p.pin, p.x, p.y);
    if ([r.left, r.top, r.right, r.bottom].every(Number.isFinite)) pins.add(r);
  }
  const placed = new Grid();
  const out: LabelPlacement[] = labels.map((l) => ({ id: l.id, dx: l.dx, dy: l.dy, moved: false }));
  const order = labels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => valid(l))
    .toSorted((a, b) => (b.l.rank ?? 0) - (a.l.rank ?? 0) || a.i - b.i);
  for (const { l, i } of order) {
    const spot = placeOne(l, placed, pins, options);
    placed.add(shift({ left: spot.dx, top: spot.dy, right: spot.dx + l.width, bottom: spot.dy + l.height }, l.x, l.y));
    out[i] = spot;
  }
  return out;
}

/** 一个候选：位置、代价、是不是往外挪的 */
interface Candidate {
  readonly dx: number;
  readonly dy: number;
  readonly cost: number;
  readonly far: boolean;
}

function placeOne(l: LabelBox, placed: Grid, pins: Grid, options: LabelLayoutOptions): LabelPlacement {
  const { x, y, width: w, height: h } = l;
  const prev = options.prefer?.get(l.id);
  const b = options.bounds && x >= options.bounds.left && x <= options.bounds.right && y >= options.bounds.top && y <= options.bounds.bottom ? options.bounds : undefined;
  /** 手里最好的；看到过干净的（不盖针、不出边）空位没有 */
  const found: { best: Candidate | undefined; clean: boolean } = { best: undefined, clean: false };
  /** 看一处：和已经排好的字相交就不要；base 是位置本身的代价 */
  const consider = (dx: number, dy: number, base: number, far: boolean) => {
    const box: Rect = { left: x + dx, top: y + dy, right: x + dx + w, bottom: y + dy + h };
    if (placed.some(box, LABEL_GAP, (r) => rectsHit(box, r, LABEL_GAP))) return;
    let penalty = 0;
    pins.some(box, 0, (p) => {
      const area = overlapArea(box, p);
      if (area > 0) penalty += PIN_COST * (0.3 + (0.7 * area) / Math.max(1, (p.right - p.left) * (p.bottom - p.top)));
      return false;
    });
    if (b && (box.left < b.left || box.top < b.top || box.right > b.right || box.bottom > b.bottom)) penalty += EDGE_COST * (2 - overlapArea(box, b) / (w * h));
    if (penalty === 0) found.clean = true;
    let cost = base + penalty;
    if (far) {
      // 引线穿过已经排好的字：难看，加一点
      const cx = x + dx + w / 2;
      const cy = y + dy + h / 2;
      const span: Rect = { left: Math.min(x, cx), top: Math.min(y, cy), right: Math.max(x, cx), bottom: Math.max(y, cy) };
      placed.some(span, 0, (r) => {
        if (segmentHits(x, y, cx, cy, r)) cost += CROSS_COST;
        return false;
      });
    }
    // 上一次挪到外面的那一处有优惠（一圈一圈找的位置每一帧都差一点，不给优惠会来回跳）；针旁边那几处不给：空出来了就回到照旧的位置
    if (far && prev && Math.abs(prev.dx - dx) < 0.5 && Math.abs(prev.dy - dy) < 0.5) cost -= STICKY;
    if (found.best === undefined || cost < found.best.cost) found.best = { dx, dy, cost, far };
  };
  /** 往外挪到 (dx, dy) 的位置代价：引线越长越贵 */
  const farBase = (dx: number, dy: number) => {
    const s = leaderStart(dx, dy, w, h);
    return FAR_BASE + (s ? Math.hypot(s.x, s.y) : 0) * FAR_PER_PX;
  };

  const near = nearOffsets(l);
  near.forEach(([dx, dy], k) => consider(dx, dy, k * NEAR_STEP, false));
  // 上一次挪到外面的那一处：也算一个候选（有优惠）
  if (prev && !near.some(([dx, dy]) => Math.abs(prev.dx - dx) < 0.5 && Math.abs(prev.dy - dy) < 0.5)) consider(prev.dx, prev.dy, farBase(prev.dx, prev.dy), true);

  // 往外一圈一圈找：这一圈上最好也不会低于 lower，比手里的还差就停；有了干净的空位以后最多再找 FAR_EXTRA，
  // 只有不干净的空位时最多再找 FAR_FALLBACK
  const half = Math.hypot(w, h) / 2;
  let freeAt = found.best === undefined ? undefined : 0;
  let cleanAt = found.clean ? 0 : undefined;
  for (let r = RING_START; r <= RING_MAX; r += RING_STEP) {
    const best = found.best;
    if (best !== undefined && FAR_BASE + Math.max(0, r - half) * FAR_PER_PX >= best.cost) break;
    if (cleanAt !== undefined && r > cleanAt + FAR_EXTRA) break;
    if (freeAt !== undefined && r > freeAt + FAR_FALLBACK) break;
    const n = Math.max(12, Math.ceil((2 * Math.PI * r) / ARC_STEP));
    for (let k = 0; k < n; k++) {
      // 从右边起，上下交替往左转：一样好的时候右边的先
      const step = Math.ceil(k / 2) * (k % 2 === 1 ? -1 : 1);
      const angle = (step * 2 * Math.PI) / n;
      const dx = Math.cos(angle) * r - w / 2;
      const dy = Math.sin(angle) * r - h / 2;
      consider(dx, dy, farBase(dx, dy) + (1 - Math.cos(angle)) * 0.25, true);
    }
    if (freeAt === undefined && found.best !== undefined) freeAt = r;
    if (cleanAt === undefined && found.clean) cleanAt = r;
  }
  const chosen = found.best;
  // RING_MAX 都找不到（只有坏输入会这样）：照旧放
  if (chosen === undefined) return { id: l.id, dx: l.dx, dy: l.dy, moved: false };
  const start = chosen.far ? leaderStart(chosen.dx, chosen.dy, w, h) : undefined;
  if (start === undefined || Math.hypot(start.x, start.y) < LEADER_MIN) return { id: l.id, dx: chosen.dx, dy: chosen.dy, moved: false };
  return { id: l.id, dx: chosen.dx, dy: chosen.dy, moved: true, leader: start };
}
