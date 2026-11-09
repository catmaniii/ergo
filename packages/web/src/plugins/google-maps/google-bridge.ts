// 谷歌地图的"小桥"（453）：在隔离框里（public/map-frame.html，ADR-0059）跑的那一段——加载谷歌的 Maps JavaScript API、建一张只有底图的
// 谷歌地图，照外层说的挪视野、放大缩小、换深浅，把"此刻画着哪一片"每一帧报出去（拖、捏、滚轮、惯性、动画时；停下来就歇着），
// 停下来报一次 moveend。**足迹、点、线不进这里**：外层自己在框上面那一层画。
// googleBridge 整个函数原样转成字符串交给框（google-engine.ts：`(${googleBridge})(env, config)`），所以它必须**自成一体**：
// 不引用这个文件以外的任何东西（不 import、不用模块里的常量、不调 t()——给人看的字由外层在 config 里给好），类型只是注解。
// 同一段也能不进框、直接在页面里跑（google-engine.ts 的 isolated: false，万一隔离框在真机上跑不通时的退路）。
// 加载照谷歌官方的"动态库导入"加载法（developers.google.com/maps/documentation/javascript/load-maps-js-api 的 bootstrap loader，
// 参数一样）：<script src=".../maps/api/js?key=…&v=…&language=…&callback=google.maps.__ib__">，好了 importLibrary("maps")。
// 框里已经有 google.maps.importLibrary（演示页、测试先装好的假谷歌，demo-google.ts）就直接用它，不加载脚本。
// 谷歌说 Key 不对（gm_authFailure）、加载不上、等太久：报 failed（只报一次），外层退回下一家。
// 坐标：进出都是谷歌自己的坐标（大陆里 GCJ-02），外层转。
// 探针（458）：谷歌的普通（栅格）地图在双指捏合、松手后的回弹、惯性滑动、双击放大的动画里，画面是整块拉伸、平移过去的（CSS 变换），
// getZoom()/getCenter() 要么还是旧的、要么一下就跳到终点，停下来才和画面一致——照它报，外层那一层就一路漂、停下才对齐（458 量过：
// 捏合差到 80 像素，惯性 150）。谷歌变换画面时覆盖物那一层（OverlayView 的 overlayLayer）跟着一起变，所以在那一层放两个看不见的空 div，
// 钉在两个固定的经纬度上（停下来时这一屏中心左上、右下各四分之一处，跟着视野换；**和足迹、地点无关**——框里照旧拿不到二狗的数据），
// 每一帧读它们在屏幕上的位置：两点之间的距离给出画面此刻的级别（带小数），其中一点给出此刻的中心。报出去的 surface 就是"画面此刻
// 等于哪个中心、哪一级"，外层照它投影，和平时一样。探针还没放好（谷歌还没给投影）、量出来不对劲（两点方向和世界里的不一样：
// 跨了 180 度经线、到了两极）时照旧报 getCenter/getZoom。停下来报的 moveend 照旧用 getCenter/getZoom（那时两者一致）。

/** 框里的环境（map-frame.html 给的；不进框时 google-engine.ts 给的） */
export interface GoogleBridgeEnv {
  readonly win: Window & typeof globalThis;
  /** 地图放在这里面（铺满） */
  readonly container: HTMLElement;
  /** 报给外层 */
  post(msg: { readonly type: string; readonly [field: string]: unknown }): void;
  /** 外层来的指令 */
  listen(fn: (msg: { readonly type: string; readonly [field: string]: unknown }) => void): void;
}

/** 外层给的设置：Key、版本、语言、脚本地址、一开始看哪里（谷歌的坐标）、深浅、级别范围、等多久、两句给人看的话 */
export interface GoogleBridgeConfig {
  readonly key: string;
  readonly version: string;
  readonly language: string;
  readonly scriptUrl: string;
  readonly lat: number;
  readonly lng: number;
  readonly zoom: number;
  readonly dark: boolean;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly timeoutMs: number;
  /** 连不上谷歌（设备在中国大陆、断网）时报的那一句 */
  readonly unreachable: string;
  /** 谷歌说 Key 不对时报的那一句 */
  readonly authFailed: string;
}

/** 跑起来；交回拆掉的函数（不进框时用；框里拆框就行） */
export function googleBridge(env: GoogleBridgeEnv, config: GoogleBridgeConfig): () => void {
  type LatLngFn = { lat(): number; lng(): number };
  type LatLng = { lat: number; lng: number };
  type Listener = { remove(): void };
  type GMap = {
    getCenter(): LatLngFn | undefined;
    getZoom(): number | undefined;
    setCenter(c: { lat: number; lng: number }): void;
    setZoom(z: number): void;
    addListener(event: string, fn: () => void): Listener;
  };
  /** 谷歌的覆盖物（只用来放探针）：谷歌在 setMap 后叫 onAdd、每次投影变了叫 draw，拿掉时叫 onRemove */
  type GOverlay = {
    setMap(m: GMap | null): void;
    getPanes(): { overlayLayer?: HTMLElement } | null | undefined;
    getProjection(): { fromLatLngToDivPixel(p: LatLng): { x: number; y: number } | null } | null | undefined;
    onAdd?: () => void;
    draw?: () => void;
    onRemove?: () => void;
  };
  type GLib = { Map: new (el: HTMLElement, options: Record<string, unknown>) => GMap; OverlayView?: new () => GOverlay };
  type GMaps = { importLibrary?: (name: string) => Promise<unknown>; [k: string]: unknown };
  const win = env.win as Window & typeof globalThis & { google?: { maps?: GMaps }; gm_authFailure?: () => void };
  const doc = win.document;
  const STILL_FRAMES = 20;
  let failed = false;
  let stopped = false;
  let lib: GLib | undefined;
  let map: GMap | undefined;
  let listeners: Listener[] = [];
  let center = { lat: config.lat, lng: config.lng };
  let zoom = config.zoom;
  let dark = config.dark;
  const clamp = (z: number) => Math.min(config.maxZoom, Math.max(config.minZoom, z));

  const fail = (reason: string, auth: boolean) => {
    if (failed || stopped) return;
    failed = true;
    env.post({ type: "failed", reason, auth });
  };
  // 谷歌说 Key 不对时叫的全局函数（谷歌文档写的办法）
  win.gm_authFailure = () => fail(config.authFailed, true);

  // ---- Web 墨卡托：第 0 级的世界像素（256 一张瓦片）；整段要转成字符串交给框，只能写在里面 ----
  const MAX_LAT = 85.05112878;
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const toWorld = (p: LatLng) => {
    const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat)) * Math.PI) / 180);
    return { x: ((p.lng + 180) / 360) * 256, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 };
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const fromWorld = (x: number, y: number): LatLng => {
    const n = Math.PI - (2 * Math.PI * y) / 256;
    return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / 256) * 360 - 180 };
  };

  // ---- 谷歌说的视野（getCenter/getZoom）：停着的时候就是画面；动画、捏合的途中不是 ----
  const read = () => {
    if (!map) return undefined;
    const c = map.getCenter();
    const z = map.getZoom();
    if (!c || z === undefined) return undefined;
    return { lat: c.lat(), lng: c.lng(), zoom: z, width: env.container.clientWidth, height: env.container.clientHeight };
  };

  // ---- 探针（458）：覆盖物那一层里两个看不见的空 div，钉在两个固定的经纬度上，跟着画面一起变换 ----
  const probes: [HTMLElement, HTMLElement] = [doc.createElement("div"), doc.createElement("div")];
  for (const p of probes) {
    p.style.position = "absolute";
    p.style.width = "0";
    p.style.height = "0";
    p.style.pointerEvents = "none";
  }
  let probe: GOverlay | undefined;
  let anchors: LatLng[] | undefined;
  /** 照谷歌此刻的投影把探针摆到钉着的经纬度上（谷歌在投影变了时叫 draw） */
  const placeProbes = () => {
    const projection = probe?.getProjection();
    if (!projection || !anchors) return;
    anchors.forEach((a, i) => {
      const px = projection.fromLatLngToDivPixel(a);
      if (!px) return;
      probes[i]!.style.left = `${px.x}px`;
      probes[i]!.style.top = `${px.y}px`;
    });
  };
  /** 重新钉（停下来时）：这一屏中心往左上、右下各四分之一屏处；出了世界的范围（跨 180 度经线、两极）就不钉，照旧报谷歌说的 */
  const anchor = () => {
    const v = read();
    if (!v || v.width <= 0 || v.height <= 0) return;
    const scale = 2 ** v.zoom;
    const c = toWorld(v);
    const dx = v.width / 4 / scale;
    const dy = v.height / 4 / scale;
    const corners = [
      [c.x - dx, c.y - dy],
      [c.x + dx, c.y + dy],
    ] as const;
    anchors = corners.every(([x, y]) => x > 0 && x < 256 && y > 0 && y < 256) ? corners.map(([x, y]) => fromWorld(x, y)) : undefined;
    placeProbes();
  };
  /** 给这张地图放探针（谷歌的库里有 OverlayView 时；测试的假库没有就不放） */
  const addProbe = (m: GMap) => {
    probe?.setMap(null);
    probe = undefined;
    anchors = undefined;
    const Overlay = lib?.OverlayView;
    if (typeof Overlay !== "function") return;
    const o = new Overlay();
    o.onAdd = () => {
      o.getPanes()?.overlayLayer?.append(...probes);
      anchor();
    };
    o.draw = placeProbes;
    o.onRemove = () => {
      for (const p of probes) p.remove();
    };
    o.setMap(m);
    probe = o;
  };
  /** 画面此刻等于哪个中心、哪一级：读两个探针在屏幕上的位置换算；量不了、不对劲时 undefined */
  const live = (width: number, height: number) => {
    const [a, b] = probes;
    if (!anchors || !a.isConnected || !b.isConnected || typeof a.getBoundingClientRect !== "function") return undefined;
    const box = env.container.getBoundingClientRect();
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const s0 = { x: ra.left - box.left, y: ra.top - box.top };
    const s1 = { x: rb.left - box.left, y: rb.top - box.top };
    const w0 = toWorld(anchors[0]!);
    const w1 = toWorld(anchors[1]!);
    const dw = Math.hypot(w1.x - w0.x, w1.y - w0.y);
    const ds = Math.hypot(s1.x - s0.x, s1.y - s0.y);
    if (!(dw > 0) || !(ds > 4) || !Number.isFinite(ds)) return undefined;
    // 画面不转不斜：屏幕上两点的方向要和世界里的一样，不一样就是量歪了
    const cos = ((w1.x - w0.x) * (s1.x - s0.x) + (w1.y - w0.y) * (s1.y - s0.y)) / (dw * ds);
    if (!(cos > 0.999)) return undefined;
    const scale = ds / dw;
    const c = fromWorld(w0.x + (width / 2 - s0.x) / scale, w0.y + (height / 2 - s0.y) / scale);
    return { lat: c.lat, lng: c.lng, zoom: Math.log2(scale), width, height };
  };

  // ---- 此刻画着哪一片：动着的时候每一帧报，停下来二十帧没变就歇着 ----
  let last = "";
  let frame = 0;
  let still = 0;
  const check = () => {
    const said = read();
    if (!said || said.width <= 0 || said.height <= 0) return;
    const v = live(said.width, said.height) ?? said;
    const key = `${v.lat}|${v.lng}|${v.zoom}|${v.width}|${v.height}`;
    if (key === last) {
      still += 1;
      return;
    }
    last = key;
    still = 0;
    // at：框里读到这一刻的时间（绝对毫秒）——量外层那一层跟手慢几帧用
    const at = typeof performance === "object" ? performance.timeOrigin + performance.now() : Date.now();
    env.post({ type: "surface", lat: v.lat, lng: v.lng, zoom: v.zoom, width: v.width, height: v.height, at });
  };
  const tick = () => {
    frame = 0;
    if (stopped) return;
    check();
    if (still < STILL_FRAMES) frame = win.requestAnimationFrame(tick);
  };
  const poke = () => {
    if (stopped) return;
    still = 0;
    check();
    if (frame === 0) frame = win.requestAnimationFrame(tick);
  };
  // 手指、鼠标一动就叫醒；松手也叫（458：松手后谷歌还要回弹、惯性滑、双击放大，那一段画面还在动）
  const inputs = ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "touchstart", "touchmove", "touchend", "touchcancel", "dblclick"];
  for (const e of inputs) env.container.addEventListener(e, poke, { capture: true, passive: true });
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(poke) : undefined;
  resize?.observe(env.container);
  // 谷歌每改一次画面的变换（它自己的动画帧里改 style）就当场再读一次（458）：只靠我们自己的动画帧，读的时候谷歌这一帧可能还没挪，
  // 报出去的就慢一帧（回弹、惯性、双击的动画里差 4～17 像素，量过）。停着的时候谷歌不改样式，这里也不动
  const moves = typeof win.MutationObserver === "function" ? new win.MutationObserver(poke) : undefined;
  moves?.observe(env.container, { attributes: true, attributeFilter: ["style"], subtree: true });

  // ---- 建一张谷歌地图（第一次、换深浅色时：colorScheme 只能建的时候定） ----
  const build = () => {
    if (!lib || stopped) return;
    for (const l of listeners) l.remove();
    listeners = [];
    env.container.replaceChildren();
    const el = doc.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    env.container.append(el);
    map = new lib.Map(el, {
      center,
      zoom: clamp(zoom),
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      colorScheme: dark ? "DARK" : "LIGHT",
      // 只要地图本身：不要谷歌自带的按钮、不让点谷歌的兴趣点；谷歌的标志和版权行谷歌自己画、不遮
      disableDefaultUI: true,
      gestureHandling: "greedy",
      clickableIcons: false,
      keyboardShortcuts: false,
    });
    env.post({ type: "loaded" });
    const m = map;
    addProbe(m);
    listeners.push(
      m.addListener("idle", () => {
        const v = read();
        if (v) env.post({ type: "moveend", lat: v.lat, lng: v.lng, zoom: v.zoom });
        // 停下来了：探针重新钉在这一屏上（下一次捏合、滑动从这里量起）
        anchor();
        poke();
      }),
    );
    for (const e of ["bounds_changed", "center_changed", "zoom_changed"]) listeners.push(m.addListener(e, poke));
    poke();
  };

  // ---- 加载谷歌（框里已经有的直接用） ----
  const load = (): Promise<unknown> => {
    const existing = win.google?.maps;
    if (existing && typeof existing.importLibrary === "function") return existing.importLibrary("maps");
    return new Promise((resolve, reject) => {
      const timer = win.setTimeout(() => reject(new Error("timeout")), config.timeoutMs);
      const g = (win.google ??= {});
      const maps = (g.maps ??= {});
      maps["__ib__"] = () => {
        win.clearTimeout(timer);
        const importLibrary = maps.importLibrary;
        if (typeof importLibrary !== "function") return reject(new Error("importLibrary missing"));
        importLibrary.call(maps, "maps").then(resolve, reject);
      };
      const params = new URLSearchParams({ key: config.key, v: config.version, language: config.language, callback: "google.maps.__ib__" });
      const script = doc.createElement("script");
      script.async = true;
      script.src = `${config.scriptUrl}?${params}`;
      script.addEventListener("error", () => {
        win.clearTimeout(timer);
        reject(new Error("script failed"));
      });
      doc.head.append(script);
    });
  };
  const timeout = win.setTimeout(() => fail(config.unreachable, false), config.timeoutMs + 1000);
  load().then(
    (got) => {
      win.clearTimeout(timeout);
      const l = got as Partial<GLib> | undefined;
      if (stopped || failed) return;
      if (!l || typeof l.Map !== "function") return fail(config.unreachable, false);
      lib = l as GLib;
      build();
      env.post({ type: "ready" });
    },
    () => {
      win.clearTimeout(timeout);
      fail(config.unreachable, false);
    },
  );

  // ---- 外层的指令（坐标都是谷歌的） ----
  // 整段要转成字符串交给框：帮手函数只能写在里面
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  env.listen((msg) => {
    if (stopped) return;
    if (msg.type === "setView") {
      center = { lat: num(msg.lat, center.lat), lng: num(msg.lng, center.lng) };
      zoom = clamp(num(msg.zoom, zoom));
      map?.setZoom(zoom);
      map?.setCenter(center);
      poke();
    } else if (msg.type === "zoomBy" && map) {
      map.setZoom(clamp(Math.round(map.getZoom() ?? zoom) + num(msg.delta, 0)));
      poke();
    } else if (msg.type === "panBy" && map) {
      // 平移多少像素：在这一级的世界像素里挪中心（Web 墨卡托，256 一张瓦片）
      const v = read();
      if (!v) return;
      const scale = 2 ** v.zoom;
      const w = toWorld(v);
      map.setCenter(fromWorld(w.x - num(msg.dx, 0) / scale, w.y - num(msg.dy, 0) / scale));
      poke();
    } else if (msg.type === "setDark" && typeof msg.dark === "boolean" && msg.dark !== dark) {
      dark = msg.dark;
      const v = read();
      if (v) {
        center = { lat: v.lat, lng: v.lng };
        zoom = v.zoom;
      }
      build();
    }
  });

  return () => {
    stopped = true;
    win.clearTimeout(timeout);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    for (const e of inputs) env.container.removeEventListener(e, poke, { capture: true });
    resize?.disconnect();
    moves?.disconnect();
    for (const l of listeners) l.remove();
    listeners = [];
    probe?.setMap(null);
    probe = undefined;
    env.container.replaceChildren();
  };
}
