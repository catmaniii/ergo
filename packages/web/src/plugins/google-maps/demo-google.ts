// 假的谷歌（446；453 起装进隔离框里）：演示页和页面测试里不连真的谷歌，扮 Maps JavaScript API 用到的那几样——
// google.maps.importLibrary("maps") 交回一个只有 Map 的库（453 起底图之外什么都不用：足迹、点、线外层自己画）。
// 自己画一张瓦片地图（Web 墨卡托，瓦片是外面给的编的占位图）：能拖、能滚轮缩放、能捏、松手有一点惯性、能跳；左下角写"Google"当标志；
// 动的时候叫 bounds_changed，停下来叫 idle（真的谷歌也是这样）。
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
  const TILE = 256;
  const MAX_LAT = 85.05112878;
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

  class FakeMap {
    private center: LatLng;
    private zoom: number;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private readonly listeners = new Map<string, Set<Listener>>();
    private readonly container: HTMLElement;
    private readonly tiles: HTMLElement;
    private settle: ReturnType<typeof setTimeout> | undefined;
    private readonly style: string;
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
      this.tiles = doc.createElement("div");
      Object.assign(this.tiles.style, { position: "absolute", inset: "0" });
      // 谷歌的标志（演示页是编的）
      const logo = doc.createElement("div");
      logo.textContent = "Google";
      Object.assign(logo.style, { position: "absolute", left: "8px", bottom: "6px", font: "700 14px Arial, sans-serif", color: this.style === "googleDark" ? "#e8eaed" : "#5f6368", pointerEvents: "none" });
      container.append(this.tiles, logo);
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
      this.center = { lat: center.lat, lng: center.lng };
      this.moved();
    }
    setZoom(zoom: number) {
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
      this.moved();
    }
    addListener(event: string, fn: Listener) {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(fn);
      this.listeners.set(event, set);
      return { remove: () => set.delete(fn) };
    }
    private emit(event: string) {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    private moved() {
      this.render();
      this.emit("bounds_changed");
      this.idleSoon();
    }
    /** 停下来了：叫 idle（真的谷歌拖完、缩放完也是这样） */
    private idleSoon() {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.emit("idle"), 80);
    }
    /** 拖（松手后一点惯性）、滚轮缩放、两指捏 */
    private gestures() {
      const el = this.container;
      const pointers = new Map<number, { x: number; y: number }>();
      let pinch: { dist: number; zoom: number } | undefined;
      let velocity = { x: 0, y: 0 };
      let glide = 0;
      const panBy = (dx: number, dy: number) => {
        const z = this.zoom;
        const c = world(this.center, z);
        this.center = unworld(c.x - dx, c.y - dy, z);
        this.moved();
      };
      el.addEventListener("pointerdown", (e) => {
        cancelAnimationFrame(glide);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        el.setPointerCapture?.(e.pointerId);
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: this.zoom };
        }
      });
      el.addEventListener("pointermove", (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinch && pinch.dist > 0) {
          const [a, b] = [...pointers.values()];
          this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, pinch.zoom + Math.log2(Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.dist)));
          this.moved();
          return;
        }
        velocity = { x: e.clientX - prev.x, y: e.clientY - prev.y };
        panBy(velocity.x, velocity.y);
      });
      const end = (e: PointerEvent) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size < 2) pinch = undefined;
        if (pointers.size > 0) return;
        // 松手：照最后一下的速度滑一会儿
        const step = () => {
          if (Math.abs(velocity.x) < 0.3 && Math.abs(velocity.y) < 0.3) return;
          velocity = { x: velocity.x * 0.9, y: velocity.y * 0.9 };
          panBy(velocity.x, velocity.y);
          glide = requestAnimationFrame(step);
        };
        glide = requestAnimationFrame(step);
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom - Math.max(-1, Math.min(1, e.deltaY / 300))));
          this.moved();
        },
        { passive: false },
      );
    }
    /** 画瓦片（级别带小数时取最近的整数级放大缩小着画） */
    private render() {
      const doc = this.container.ownerDocument;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
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
          const left = w / 2 + (tx * TILE - c.x) * k;
          const top = h / 2 + (ty * TILE - c.y) * k;
          Object.assign(img.style, { position: "absolute", left: "0", top: "0", width: `${TILE * k + 0.5}px`, height: `${TILE * k + 0.5}px`, maxWidth: "none", pointerEvents: "none", transform: `translate(${left}px, ${top}px)` });
          imgs.push(img);
        }
      }
      this.tiles.replaceChildren(...imgs);
    }
  }

  const lib = { Map: FakeMap };
  const maps = {
    importLibrary: (name: string) =>
      options.unreachable === true ? new Promise((_, reject) => setTimeout(() => reject(new Error("unreachable")), 600)) : name === "maps" ? Promise.resolve(lib) : Promise.reject(new Error(`no library ${name}`)),
  };
  (win as Window & { google?: { maps: typeof maps } }).google = { maps };
}
