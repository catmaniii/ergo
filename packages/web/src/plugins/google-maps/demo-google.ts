// 假的谷歌（446；453 起装进隔离框里）：演示页和页面测试里不连真的谷歌，扮 Maps JavaScript API 用到的那几样——
// google.maps.importLibrary("maps") 交回一个只有 Map、OverlayView 的库（453 起底图之外什么都不用：足迹、点、线外层自己画；
// 458 起小桥用 OverlayView 放两个看不见的探针）。
// 自己画一张瓦片地图（Web 墨卡托，瓦片是外面给的编的占位图）：能拖、能滚轮缩放、能捏、松手有一点惯性、能双击放大、能跳；
// 左下角写"Google"当标志；动的时候叫 bounds_changed，停下来叫 idle（真的谷歌也是这样）。
// 458：照真的谷歌（普通的栅格地图，不带 Key 的真脚本量过）的样子动——
// - 双指捏合：画面整块拉伸、平移过去（瓦片和覆盖物那一层在同一块上，一起变换），getZoom/getCenter 不跟着变；
//   拉伸超过半级时换到下一级（getZoom 跳一级、画面按新的级别重画、拉伸跟着折回去）；松手后回弹到整数级再停下；
// - 拖一下松手（惯性）：getCenter 当场跳到滑完的地方，画面再慢慢滑过去；
// - 双击：getZoom 当场加一级，画面从原来的大小慢慢放大过去；
// 所以外层要是照 getZoom/getCenter 摆，这几样的过程中就漂（458 修好以前就是这样）；滚轮、外层发的跳转照旧直接改级别。
// 瓦片的 img 上写 data-tile="z/x/y"：页面测试照它算"底图此刻把哪个点画在哪"。
// installFakeGoogle 整个函数原样转成字符串交给隔离框（和 google-bridge.ts 的小桥一起跑），所以它**自成一体**：不引用这个文件以外的东西，
// 样式都写在元素上（框里没有页面的样式表）。只有 basemap.ts 里 import.meta.env.MODE === "demo" 的分支、测试引它（安装版的产物里没有）。
// 它收到的坐标是谷歌那一种的（大陆里 GCJ-02），原样当成画的位置（占位底图对不上任何真实的地方）。

/** 装假谷歌的选项：unreachable 扮"这台设备连不上谷歌"（过一会儿加载失败） */
export interface FakeGoogleOptions {
  readonly unreachable?: boolean;
}

/**
 * 在 win 上装一个假的 google.maps（importLibrary）。tile(style, z, x, y) 交回一张占位瓦片的地址（style 是 google 或 googleDark）
 */
export function installFakeGoogle(win: Window & typeof globalThis, tile: (style: string, z: number, x: number, y: number) => string, options: FakeGoogleOptions = {}): void {
  type Listener = () => void;
  type LatLng = { lat: number; lng: number };
  type Point = { x: number; y: number };
  /** 画面在模型（getCenter/getZoom 那一份）之上的变换：屏幕 = s · 模型像素 + t */
  type Stretch = { s: number; tx: number; ty: number };
  const TILE = 256;
  const MAX_LAT = 85.05112878;
  /** 回弹、惯性、双击放大的动画多长（毫秒） */
  const ANIMATE_MS = 260;
  const world = (p: LatLng, z: number) => {
    const scale = TILE * 2 ** z;
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
    const s = Math.sin((lat * Math.PI) / 180);
    return { x: ((p.lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
  };
  const unworld = (x: number, y: number, z: number): LatLng => {
    const scale = TILE * 2 ** z;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / scale) * 360 - 180 };
  };
  // 整段要转成字符串交给框：帮手函数只能写在里面
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const ease = (k: number) => 1 - (1 - k) ** 3;

  /** 覆盖物（小桥放探针用）：setMap 后下一轮叫 onAdd、draw；地图换了视野叫 draw；拿掉叫 onRemove */
  class FakeOverlayView {
    onAdd?: () => void;
    draw?: () => void;
    onRemove?: () => void;
    private map: FakeMap | undefined;
    setMap(m: FakeMap | null) {
      if (this.map) {
        this.map.overlays.delete(this);
        this.onRemove?.();
      }
      this.map = m ?? undefined;
      if (!m) return;
      m.overlays.add(this);
      setTimeout(() => {
        if (this.map !== m) return;
        this.onAdd?.();
        this.draw?.();
      }, 0);
    }
    getPanes() {
      return this.map ? { overlayLayer: this.map.overlayLayer } : null;
    }
    getProjection() {
      const m = this.map;
      return m ? { fromLatLngToDivPixel: (p: LatLng) => m.divPixel(p) } : null;
    }
  }

  class FakeMap {
    readonly overlays = new Set<FakeOverlayView>();
    readonly overlayLayer: HTMLElement;
    private center: LatLng;
    private zoom: number;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private readonly listeners = new Map<string, Set<Listener>>();
    private readonly container: HTMLElement;
    /** 瓦片和覆盖物那一层在同一块上：捏合、动画时整块变换（像真的谷歌） */
    private readonly pane: HTMLElement;
    private readonly tiles: HTMLElement;
    private settle: ReturnType<typeof setTimeout> | undefined;
    private readonly style: string;
    private stretch: Stretch = { s: 1, tx: 0, ty: 0 };
    private anim = 0;
    constructor(container: HTMLElement, opts: Record<string, unknown>) {
      this.container = container;
      this.center = opts.center as LatLng;
      this.minZoom = typeof opts.minZoom === "number" ? opts.minZoom : 3;
      this.maxZoom = typeof opts.maxZoom === "number" ? opts.maxZoom : 20;
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, opts.zoom as number));
      this.style = opts.colorScheme === "DARK" ? "googleDark" : "google";
      const doc = container.ownerDocument;
      container.dataset.fakeGoogle = this.style;
      Object.assign(container.style, { overflow: "hidden", touchAction: "none", userSelect: "none", cursor: "grab", background: this.style === "googleDark" ? "#242f3e" : "#f5f5f5" });
      this.pane = doc.createElement("div");
      Object.assign(this.pane.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", transformOrigin: "0 0" });
      this.tiles = doc.createElement("div");
      Object.assign(this.tiles.style, { position: "absolute", inset: "0" });
      this.overlayLayer = doc.createElement("div");
      Object.assign(this.overlayLayer.style, { position: "absolute", left: "0", top: "0", width: "100%" });
      this.pane.append(this.tiles, this.overlayLayer);
      // 谷歌的标志（演示页是编的）
      const logo = doc.createElement("div");
      logo.textContent = "Google";
      Object.assign(logo.style, { position: "absolute", left: "8px", bottom: "6px", font: "700 14px Arial, sans-serif", color: this.style === "googleDark" ? "#e8eaed" : "#5f6368", pointerEvents: "none" });
      container.append(this.pane, logo);
      this.gestures();
      this.render();
      this.idleSoon();
    }
    getCenter() {
      const c = this.center;
      return { lat: () => c.lat, lng: () => c.lng };
    }
    getZoom() {
      return this.zoom;
    }
    setCenter(center: LatLng) {
      this.halt();
      this.center = { lat: center.lat, lng: center.lng };
      this.moved();
    }
    setZoom(zoom: number) {
      this.halt();
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
      this.moved();
    }
    addListener(event: string, fn: Listener) {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(fn);
      this.listeners.set(event, set);
      return { remove: () => set.delete(fn) };
    }
    /** 一个点在覆盖物那一层里的位置（模型的像素：这一份中心、级别下，相对左上角） */
    divPixel(p: LatLng): Point {
      const w = this.size();
      const a = world(p, this.zoom);
      const c = world(this.center, this.zoom);
      return { x: w.w / 2 + a.x - c.x, y: w.h / 2 + a.y - c.y };
    }
    private size() {
      return { w: this.container.clientWidth, h: this.container.clientHeight };
    }
    private emit(event: string) {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    /** 模型变了：重画瓦片、覆盖物重摆，叫 bounds_changed，过一会儿 idle */
    private moved() {
      this.render();
      for (const o of this.overlays) o.draw?.();
      this.emit("bounds_changed");
      this.idleSoon();
    }
    /** 停下来了：叫 idle（真的谷歌拖完、缩放完也是这样）；还在拉伸、动画时不叫 */
    private idleSoon() {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        if (this.anim === 0 && this.stretch.s === 1 && this.stretch.tx === 0 && this.stretch.ty === 0) this.emit("idle");
      }, 80);
    }
    /** 画面的变换（只改样式，不改模型：getCenter/getZoom 不变） */
    private applyStretch(next: Stretch) {
      this.stretch = next;
      this.pane.style.transform = next.s === 1 && next.tx === 0 && next.ty === 0 ? "" : `translate(${next.tx}px, ${next.ty}px) scale(${next.s})`;
    }
    /** 屏幕上一点此刻对应的经纬度（算上拉伸） */
    private latLngAt(q: Point): LatLng {
      const w = this.size();
      const st = this.stretch;
      const mx = (q.x - st.tx) / st.s;
      const my = (q.y - st.ty) / st.s;
      const c = world(this.center, this.zoom);
      return unworld(c.x + mx - w.w / 2, c.y + my - w.h / 2, this.zoom);
    }
    /** 把模型换成"画面此刻的样子"再加 dz 级（拉伸跟着折回去，画面不动） */
    private commit(dz: number) {
      const w = this.size();
      const mid = { x: w.w / 2, y: w.h / 2 };
      this.center = this.latLngAt(mid);
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + dz));
      const s = this.stretch.s / 2 ** dz;
      this.applyStretch({ s, tx: mid.x * (1 - s), ty: mid.y * (1 - s) });
      this.moved();
    }
    /** 停掉动画、把拉伸原样并进模型（级别可能带小数；外层发了跳转、又按下手指、滚轮时），画面不动 */
    private halt() {
      if (this.anim !== 0) cancelAnimationFrame(this.anim);
      this.anim = 0;
      const st = this.stretch;
      if (st.s === 1 && st.tx === 0 && st.ty === 0) return;
      const w = this.size();
      this.center = this.latLngAt({ x: w.w / 2, y: w.h / 2 });
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + Math.log2(st.s)));
      this.applyStretch({ s: 1, tx: 0, ty: 0 });
      this.moved();
    }
    /** 画面从此刻的变换慢慢变到 to，到了以后把它并进模型（to 是 s=1 时模型的中心挪 t） */
    private animateTo(to: Stretch, done?: () => void) {
      if (this.anim !== 0) cancelAnimationFrame(this.anim);
      const from = this.stretch;
      const start = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / ANIMATE_MS);
        const e = ease(k);
        this.applyStretch({ s: from.s + (to.s - from.s) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e });
        if (k < 1) {
          this.anim = requestAnimationFrame(step);
          return;
        }
        this.anim = 0;
        done?.();
        this.idleSoon();
      };
      this.anim = requestAnimationFrame(step);
    }
    /** 拖（松手后惯性）、滚轮缩放、两指捏（整块拉伸）、双击放大 */
    private gestures() {
      const el = this.container;
      const pointers = new Map<number, Point>();
      /** 捏着：开始（或上一次换级）时两指的距离、两指中间那一点（模型的像素）、那时的拉伸；last 是此刻两指中间 */
      let pinch: { dist: number; anchor: Point; s: number; last: Point } | undefined;
      /** 合法的换级：出了最小最大级别就不换 */
      const step = (dz: number) => (dz !== 0 && this.zoom + dz >= this.minZoom && this.zoom + dz <= this.maxZoom ? dz : 0);
      let velocity = { x: 0, y: 0 };
      let lastMove = 0;
      const local = (e: { clientX: number; clientY: number }) => {
        const r = el.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      const panBy = (dx: number, dy: number) => {
        const z = this.zoom;
        const c = world(this.center, z);
        this.center = unworld(c.x - dx, c.y - dy, z);
        this.moved();
      };
      const two = () => {
        const [a, b] = [...pointers.values()];
        return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
      };
      el.addEventListener("pointerdown", (e) => {
        this.halt();
        pointers.set(e.pointerId, local(e));
        el.setPointerCapture?.(e.pointerId);
        velocity = { x: 0, y: 0 };
        if (pointers.size === 2) {
          const g = two();
          const st = this.stretch;
          // 两指中间那一点（模型的像素）：捏的时候它一直在两指中间
          pinch = { dist: g.dist, anchor: { x: (g.mid.x - st.tx) / st.s, y: (g.mid.y - st.ty) / st.s }, s: st.s, last: g.mid };
        }
      });
      el.addEventListener("pointermove", (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const now = local(e);
        pointers.set(e.pointerId, now);
        if (pointers.size === 2 && pinch && pinch.dist > 0) {
          const g = two();
          const s = pinch.s * (g.dist / pinch.dist);
          this.applyStretch({ s, tx: g.mid.x - s * pinch.anchor.x, ty: g.mid.y - s * pinch.anchor.y });
          pinch.last = g.mid;
          // 拉伸超过半级：换到下一级（像真的谷歌：getZoom 在捏的途中跳一级），拉伸折回去、画面不动
          const dz = step(Math.round(Math.log2(s)));
          if (dz !== 0) {
            this.commit(dz);
            const st = this.stretch;
            pinch = { dist: g.dist, anchor: { x: (g.mid.x - st.tx) / st.s, y: (g.mid.y - st.ty) / st.s }, s: st.s, last: g.mid };
          }
          return;
        }
        if (pointers.size !== 1) return;
        velocity = { x: now.x - prev.x, y: now.y - prev.y };
        lastMove = performance.now();
        panBy(velocity.x, velocity.y);
      });
      const end = (e: PointerEvent) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pinch && pointers.size < 2) {
          // 松开一指：回弹到整数级（围着两指中间那一点），到了再并进模型
          const g = pinch.last;
          pinch = undefined;
          const st = this.stretch;
          const q = { x: (g.x - st.tx) / st.s, y: (g.y - st.ty) / st.s };
          const dz = step(Math.round(Math.log2(st.s)));
          const target = 2 ** dz;
          this.animateTo({ s: target, tx: g.x - target * q.x, ty: g.y - target * q.y }, () => this.commit(dz));
          velocity = { x: 0, y: 0 };
          return;
        }
        if (pointers.size > 0) return;
        // 松手：照最后一下的速度滑一会儿。像真的谷歌：getCenter 当场跳到滑完的地方，画面再慢慢滑过去
        if (performance.now() - lastMove > 100 || (Math.abs(velocity.x) < 2 && Math.abs(velocity.y) < 2)) return;
        const travel = { x: velocity.x * 8, y: velocity.y * 8 };
        panBy(travel.x, travel.y);
        this.applyStretch({ s: 1, tx: -travel.x, ty: -travel.y });
        this.animateTo({ s: 1, tx: 0, ty: 0 });
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("dblclick", (e) => {
        // 双击：getZoom 当场加一级（点的那一处不动），画面从原来的大小慢慢放大过去
        this.halt();
        if (this.zoom + 1 > this.maxZoom) return;
        const q = local(e);
        const at = this.latLngAt(q);
        this.zoom += 1;
        const w = this.size();
        const a = world(at, this.zoom);
        this.center = unworld(a.x - (q.x - w.w / 2), a.y - (q.y - w.h / 2), this.zoom);
        this.moved();
        this.applyStretch({ s: 0.5, tx: q.x / 2, ty: q.y / 2 });
        this.animateTo({ s: 1, tx: 0, ty: 0 });
      });
      el.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.halt();
          this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom - Math.max(-1, Math.min(1, e.deltaY / 300))));
          this.moved();
        },
        { passive: false },
      );
    }
    /** 画瓦片（按模型；级别带小数时取最近的整数级放大缩小着画） */
    private render() {
      const doc = this.container.ownerDocument;
      const { w, h } = this.size();
      const z = Math.max(0, Math.round(this.zoom));
      const k = 2 ** (this.zoom - z);
      const c = world(this.center, z);
      const span = 2 ** z;
      const half = { w: w / 2 / k, h: h / 2 / k };
      const imgs: HTMLImageElement[] = [];
      for (let tx = Math.floor((c.x - half.w) / TILE); tx <= Math.floor((c.x + half.w) / TILE); tx++) {
        for (let ty = Math.max(0, Math.floor((c.y - half.h) / TILE)); ty <= Math.min(span - 1, Math.floor((c.y + half.h) / TILE)); ty++) {
          const img = doc.createElement("img");
          img.alt = "";
          img.draggable = false;
          img.src = tile(this.style, z, ((tx % span) + span) % span, ty);
          img.dataset.tile = `${z}/${tx}/${ty}`;
          const left = w / 2 + (tx * TILE - c.x) * k;
          const top = h / 2 + (ty * TILE - c.y) * k;
          Object.assign(img.style, { position: "absolute", left: "0", top: "0", width: `${TILE * k + 0.5}px`, height: `${TILE * k + 0.5}px`, maxWidth: "none", pointerEvents: "none", transform: `translate(${left}px, ${top}px)` });
          imgs.push(img);
        }
      }
      this.tiles.replaceChildren(...imgs);
    }
  }

  const lib = { Map: FakeMap, OverlayView: FakeOverlayView };
  const maps = {
    importLibrary: (name: string) =>
      options.unreachable === true ? new Promise((_, reject) => setTimeout(() => reject(new Error("unreachable")), 600)) : name === "maps" ? Promise.resolve(lib) : Promise.reject(new Error(`no library ${name}`)),
  };
  (win as Window & { google?: { maps: typeof maps } }).google = { maps };
}
