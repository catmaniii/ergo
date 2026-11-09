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
  type Listener = { remove(): void };
  type GMap = {
    getCenter(): LatLngFn | undefined;
    getZoom(): number | undefined;
    setCenter(c: { lat: number; lng: number }): void;
    setZoom(z: number): void;
    addListener(event: string, fn: () => void): Listener;
  };
  type GLib = { Map: new (el: HTMLElement, options: Record<string, unknown>) => GMap };
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

  // ---- 此刻画着哪一片：动着的时候每一帧报，停下来二十帧没变就歇着 ----
  let last = "";
  let frame = 0;
  let still = 0;
  const read = () => {
    if (!map) return undefined;
    const c = map.getCenter();
    const z = map.getZoom();
    if (!c || z === undefined) return undefined;
    return { lat: c.lat(), lng: c.lng(), zoom: z, width: env.container.clientWidth, height: env.container.clientHeight };
  };
  const check = () => {
    const v = read();
    if (!v || v.width <= 0 || v.height <= 0) return;
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
  const inputs = ["pointerdown", "pointermove", "wheel", "touchstart", "touchmove"];
  for (const e of inputs) env.container.addEventListener(e, poke, { capture: true, passive: true });
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(poke) : undefined;
  resize?.observe(env.container);

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
    listeners.push(
      m.addListener("idle", () => {
        const v = read();
        if (v) env.post({ type: "moveend", lat: v.lat, lng: v.lng, zoom: v.zoom });
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
      const size = 256 * 2 ** v.zoom;
      const lat = Math.max(-85.05112878, Math.min(85.05112878, v.lat));
      const s = Math.sin((lat * Math.PI) / 180);
      const x = ((v.lng + 180) / 360) * size - num(msg.dx, 0);
      const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size - num(msg.dy, 0);
      const n = Math.PI - (2 * Math.PI * y) / size;
      map.setCenter({ lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / size) * 360 - 180 });
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
    for (const l of listeners) l.remove();
    listeners = [];
    env.container.replaceChildren();
  };
}
