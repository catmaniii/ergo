// 原型的地图（429）：演示页不连守护进程、不连高德和 OpenStreetMap，地图页用编的东西——
// - 当作填好了高德的 Key（DEMO_AMAP_KEY，假的）：国内那一处用"高德"（演示页里的高德是假的，高德地图插件的 plugins/amap/demo-amap.ts 拿占位底图画）；
// - 当作填好了谷歌地图的 Key（446，DEMO_GOOGLE_KEY，假的）：新加坡那一处"自动"用"谷歌"（演示页里的谷歌是假的，
//   plugins/google-maps/demo-google.ts 拿占位底图画）；谷歌地图插件停用了（?demo-plugins-off=google-maps）就没有这一家；
// - 两个地点：国内一处（杭州西湖）、新加坡一处（滨海湾），点了跳过去，底图跟着换；
// - 占位底图（demoTileUrl）：编的街区格子，不是真的地图；两种底图颜色不同，一眼分得出是哪一种。
// - 聊天里地图卡片的那条路线（431，demoMapDrawing）：高德查的、从公司到西湖边，编的。
// - "在地图上看"（447，demoMapFind）：网页上选中的一段字，带汉字的当国内地址、"高德"查到西湖边，不带的当国外查到滨海湾（谷歌地图插件
//   开着时"谷歌"查的，停用了 OpenStreetMap 查的）；写着"找不到"、nowhere 的回没找到。
// - 聊天卡片的预览图（451，demoStaticMap）：真的是守护进程拿 Key 去取那家的静态地图；演示页拿同一套占位瓦片在页面里拼一张 SVG，
//   左下角写那家的名字（看得出是哪家）；453 起只有光底图，点和线页面自己画（和真的一样）；谷歌深色换深色的占位颜色
//   （高德的静态图没有深色，页面加滤镜）。
// - 国外"自动"：谷歌（填了）→ 高德 → OpenStreetMap（451）；停用谷歌地图插件（?demo-plugins-off=google-maps）时国外"自动"是高德。
// - 地图页上说"把……标出来"（461，demoMapDraw）：原型回一张标了几个点的地图卡片（附近的咖啡馆、地铁站、公司轮着来，点照说话时
//   地图看的中心编），说了"只看""换成"的写 replace；地图页开着就直接画上去。
// - 455 起三家各是一个插件：?demo-plugins-off=amap 停用高德（国内"自动"是 OpenStreetMap），openstreetmap 停用 OpenStreetMap，
//   三个都停了地图页说"没有能用的地图"。
// 只在演示页里用（地图页 import.meta.env.MODE === "demo" 的分支、FakeDaemonHttp）。英文在 en/fake-map.ts。
import type { MapCardPayload, MapDrawing, MapFindResult, MapPreviewView, MapProviderView } from "../state/index.ts";
import { fakeFormat, fakeText } from "./fake-content.ts";

/** 演示页里"填好了"的高德 Key（假的，安装版的产物里不该有它：DEMO_SENTINELS） */
export const DEMO_AMAP_KEY = "demo-amap-key-not-real";
/** 演示页里"填好了"的谷歌浏览器用的 Key（446，假的，安装版的产物里不该有它：DEMO_SENTINELS） */
export const DEMO_GOOGLE_KEY = "demo-google-key-not-real";

/**
 * 登记了的几家地图服务（445 的插槽，GET /api/map/config 的 providers）：455 起三家各是一个插件，开着的才登记，先后照插件装的先后——
 * OpenStreetMap（哪儿都管、0）、高德（底图国内国外都管，451：国内优先级 100、国外 30；"填好了"假的 Key）、谷歌（446，大陆外 50，
 * "填好了"假的 Key）。高德、谷歌能出预览图（preview），谷歌的预览图有深色的（previewDark）
 */
export function demoMapProviders(on: { readonly osm?: boolean; readonly amap?: boolean; readonly google?: boolean } = { osm: true, amap: true, google: true }): MapProviderView[] {
  const osm: MapProviderView = { id: "osm", title: "OpenStreetMap", regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 0, ownBasemapOnly: false, basemap: true, ready: true, lookup: true, preview: false };
  const amap: MapProviderView = {
    id: "amap",
    title: fakeText("高德地图"),
    regions: ["mainland", "abroad"],
    manualRegions: ["mainland", "abroad"],
    priority: 100,
    regionPriority: { abroad: 30 },
    ownBasemapOnly: true,
    basemap: true,
    ready: true,
    key: DEMO_AMAP_KEY,
    lookup: true,
    preview: true,
  };
  // 谷歌地图插件（446）登记的：大陆外、优先级 50，手动时大陆也能用
  const google: MapProviderView = { id: "google", title: fakeText("谷歌地图"), regions: ["abroad"], manualRegions: ["abroad", "mainland"], priority: 50, ownBasemapOnly: true, basemap: true, ready: true, key: DEMO_GOOGLE_KEY, lookup: true, preview: true, previewDark: true };
  return [...(on.osm === true ? [osm] : []), ...(on.amap === true ? [amap] : []), ...(on.google === true ? [google] : [])];
}

/** 地图页上的一个地点：点了跳过去 */
export interface DemoMapPlace {
  readonly id: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
}

const PLACES: readonly DemoMapPlace[] = [
  { id: "demo-west-lake", label: "杭州 · 西湖", lat: 30.2465, lon: 120.144, zoom: 14 },
  { id: "demo-marina-bay", label: "新加坡 · 滨海湾", lat: 1.2834, lon: 103.8607, zoom: 14 },
];

/** 两个地点（字按界面语言） */
export function demoMapPlaces(): DemoMapPlace[] {
  return PLACES.map((p) => ({ ...p, label: fakeText(p.label) }));
}

/** 署名角标后面跟的一句：演示页的底图是编的 */
export function demoBasemapNote(): string {
  return fakeText("演示底图：编的街区，不是真的地图");
}

/** 占位底图的几种颜色（osm、amap、google、googleDark：谷歌深色，451 预览图的 colorscheme=dark） */
type TileStyle = "osm" | "amap" | "google" | "googleDark";

/**
 * 一张占位瓦片（SVG 的 data: 地址）：每张分成 4×4 格，格子随机是街区、公园或水；街道按全局的行列号定，横竖连得上。
 * 是编的，不对应任何真实的地方
 */
export function demoTileUrl(style: TileStyle, z: number, x: number, y: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${demoTileBody(style, z, x, y)}</svg>`)}`;
}

/**
 * 隔离框里（453：假谷歌在框里跑）用的同一种瓦片：一段能原样交给框的函数源码 (style, z, x, y) => 地址。
 * demoTileBody 自成一体（颜色表、哈希都在里面），所以能整段转成字符串
 */
export function demoTileSource(): string {
  return `(style, z, x, y) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' + (${demoTileBody.toString()})(style, z, x, y) + "</svg>")`;
}

/**
 * 一张占位瓦片里面画的东西（SVG 片段，256×256）：拼预览图时直接嵌进去，不经 data: 地址。
 * 自成一体（不引用外面的东西）：隔离框里的假谷歌要整段拿去用（demoTileSource）
 */
function demoTileBody(style: string, z: number, x: number, y: number): string {
  // 底、街道、公园、水
  const palette: Record<string, { ground: string; street: string; edge: string; park: string; water: string }> = {
    osm: { ground: "#f2efe9", street: "#ffffff", edge: "#d9d2c5", park: "#cfe8c4", water: "#aad3df" },
    amap: { ground: "#eef1f6", street: "#ffffff", edge: "#d4dae6", park: "#d3ecd0", water: "#9ec7f0" },
    google: { ground: "#f5f5f5", street: "#ffffff", edge: "#dadce0", park: "#c8e6c9", water: "#a4cdf5" },
    googleDark: { ground: "#242f3e", street: "#38414e", edge: "#212a37", park: "#263c3f", water: "#17263c" },
  };
  // 一个整数的哈希（编街道、公园用：同一个位置每次一样）；要整段转成字符串，只能写在里面
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const hash = (a: number, b: number, h0: number): number => {
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(h0, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
  };
  const c = palette[style] ?? palette.osm!;
  const cells: string[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const r = hash(x * 4 + i, y * 4 + j, z) % 23;
      const fill = r === 0 ? c.water : r < 3 ? c.park : undefined;
      if (fill) cells.push(`<rect x="${i * 64}" y="${j * 64}" width="64" height="64" fill="${fill}"/>`);
    }
  }
  // 街道：先画一道深一点的边，再画白的路面
  const edges: string[] = [];
  const roads: string[] = [];
  const street = (d: string, wide: boolean) => {
    edges.push(`<path d="${d}" stroke-width="${wide ? 10 : 5}"/>`);
    roads.push(`<path d="${d}" stroke-width="${wide ? 7 : 3}"/>`);
  };
  for (let i = 0; i <= 4; i++) {
    const vx = hash(x * 4 + i, 7, z) % 3;
    const hy = hash(11, y * 4 + i, z) % 3;
    if (vx !== 0) street(`M${i * 64} 0V256`, vx === 2);
    if (hy !== 0) street(`M0 ${i * 64}H256`, hy === 2);
  }
  return `<rect width="256" height="256" fill="${c.ground}"/>${cells.join("")}<g stroke="${c.edge}" fill="none">${edges.join("")}</g><g stroke="${c.street}" fill="none">${roads.join("")}</g>`;
}

const MAX_LAT = 85.05112878;
/** 经纬度 → 第 z 级的世界像素（Web 墨卡托，256 一张瓦片） */
function worldPx(p: { lat: number; lon: number }, z: number): { x: number; y: number } {
  const scale = 256 * 2 ** z;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}
/** 第 z 级的世界像素 → 经纬度 */
function unworldPx(x: number, y: number, z: number): { lat: number; lon: number } {
  const scale = 256 * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon: (x / scale) * 360 - 180 };
}

/** 两家静态地图的上限（和守护进程 amap-static.ts、google-maps/static-map.ts 的一样） */
const DEMO_STATIC_LIMITS = { amap: { maxSide: 1024, minZoom: 1, maxZoom: 17, maxZoomHiDpi: 16 }, google: { maxSide: 640, minZoom: 1, maxZoom: 19, maxZoomHiDpi: 19 } } as const;
/** 看全时留的边（和守护进程 static-map.ts 的 MAP_STATIC_PAD 一样：下面留出标志那一条） */
const DEMO_STATIC_PAD = { x: 24, top: 40, bottom: 28 };

/**
 * 演示页的"静态地图"（451；453 起只有光底图）：照守护进程的样子（static-map.ts 的 planStatic）看全这些点——四周留边、级别取整数、
 * 宽高按那家的上限缩——用占位瓦片拼一张 SVG（data: 地址），左下角写那家的名字（扮它的标志），右下角写"演示图"；
 * **不画点和线**（真的也不画：页面按交回的视野自己画）。交回图和视野（回应头 X-Map-View 的那一份）。只在演示页用（FakeDaemonHttp.mapPreview）
 */
export function demoStaticMap(provider: "amap" | "google", bounds: readonly { lat: number; lon: number }[], q: { width: number; height: number; scale: 1 | 2; dark: boolean }): { url: string; view: MapPreviewView } {
  const limits = DEMO_STATIC_LIMITS[provider];
  const ratio = Math.min(1, limits.maxSide / Math.max(q.width, q.height));
  const width = Math.max(1, Math.floor(q.width * ratio));
  const height = Math.max(1, Math.floor(q.height * ratio));
  const dark = q.dark && provider === "google";
  const at0 = bounds.map((p) => worldPx(p, 0));
  const xs = at0.map((p) => p.x);
  const ys = at0.map((p) => p.y);
  const pad = DEMO_STATIC_PAD;
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const room = { w: Math.max(16, width - 2 * pad.x), h: Math.max(16, height - pad.top - pad.bottom) };
  const fit = spanX < 1e-9 && spanY < 1e-9 ? 15 : Math.floor(Math.min(Math.log2(room.w / Math.max(spanX, 1e-9)), Math.log2(room.h / Math.max(spanY, 1e-9))));
  const maxZoom = q.scale === 2 ? limits.maxZoomHiDpi : limits.maxZoom;
  const zoom = Math.min(maxZoom, Math.max(limits.minZoom, Math.min(fit, 15)));
  const scale = 2 ** zoom;
  const cx = ((Math.max(...xs) + Math.min(...xs)) / 2) * scale;
  const cy = ((Math.max(...ys) + Math.min(...ys)) / 2) * scale - (pad.top - pad.bottom) / 2;
  const center = unworldPx(cx, cy, zoom);
  const left = cx - width / 2;
  const top = cy - height / 2;
  const style: TileStyle = provider === "google" ? (dark ? "googleDark" : "google") : "amap";
  const tiles: string[] = [];
  const span = 2 ** zoom;
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + width) / 256); tx++) {
    for (let ty = Math.max(0, Math.floor(top / 256)); ty <= Math.min(span - 1, Math.floor((top + height) / 256)); ty++) {
      const wrapped = ((tx % span) + span) % span;
      tiles.push(`<svg x="${(tx * 256 - left).toFixed(1)}" y="${(ty * 256 - top).toFixed(1)}" width="256" height="256" viewBox="0 0 256 256">${demoTileBody(style, zoom, wrapped, ty)}</svg>`);
    }
  }
  const ink = provider === "google" && dark ? "#e8eaed" : "#3c4043";
  const logo = `<text x="8" y="${height - 8}" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="${ink}" fill-opacity="0.85">${provider === "google" ? "Google" : fakeText("高德地图")}</text>`;
  const note = `<text x="${width - 8}" y="${height - 8}" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="${ink}" fill-opacity="0.7">${fakeText("演示图")}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${tiles.join("")}${logo}${note}</svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, view: { lat: center.lat, lon: center.lon, zoom, width, height, scale: q.scale, datum: "gcj02" } };
}

/**
 * 聊天里的地图卡片（431）：演示的那条路线（"高德"查的，编的）从公司到西湖边，步行、开车各一条；坐标和 fake-footprints.ts 的公司、西湖边一样。
 * 高德查来的只能画在高德的地图上：卡片上不画缩略图，点开的地图页用（演示页里假的）高德底图画
 */
const DEMO_DRAWINGS: Readonly<Record<string, MapDrawing>> = {
  // 新加坡牛车水一带的 hawker centre（446：谷歌地图查的，只能画在谷歌的地图上；地名是公开的地点，坐标是大概的）
  "google-p1": {
    id: "google-p1",
    kind: "places",
    source: "google",
    title: "附近的 hawker centre",
    at: "2026-10-07T12:06:00.000+08:00",
    marks: [
      { id: "here", lat: 1.2805, lon: 103.845, label: "当前位置", kind: "here" },
      { id: "p1", lat: 1.28036, lon: 103.84476, label: "Maxwell Food Centre", kind: "search" },
      { id: "p2", lat: 1.2794, lon: 103.8465, label: "Amoy Street Food Centre", kind: "search" },
      { id: "p3", lat: 1.2826, lon: 103.8429, label: "Chinatown Complex Food Centre", kind: "search" },
      { id: "p4", lat: 1.28069, lon: 103.85036, label: "Lau Pa Sat", kind: "search" },
    ],
    lines: [],
  },
  "amap-r2": {
    id: "amap-r2",
    kind: "route",
    source: "amap",
    title: "从公司到西湖边",
    at: "2026-10-07T09:10:00.000+08:00",
    marks: [
      { id: "from", lat: 30.2738, lon: 120.1495, label: "公司", kind: "place" },
      { id: "to", lat: 30.2598, lon: 120.1452, label: "西湖边", kind: "place" },
    ],
    lines: [
      {
        id: "walking",
        kind: "route",
        mode: "walking",
        points: [
          { lat: 30.2738, lon: 120.1495 },
          { lat: 30.2721, lon: 120.1481 },
          { lat: 30.2689, lon: 120.1478 },
          { lat: 30.2652, lon: 120.1469 },
          { lat: 30.2621, lon: 120.1458 },
          { lat: 30.2598, lon: 120.1452 },
        ],
      },
      {
        id: "driving",
        kind: "route",
        mode: "driving",
        points: [
          { lat: 30.2738, lon: 120.1495 },
          { lat: 30.2731, lon: 120.1532 },
          { lat: 30.2684, lon: 120.1541 },
          { lat: 30.2636, lon: 120.1525 },
          { lat: 30.2608, lon: 120.1489 },
          { lat: 30.2598, lon: 120.1452 },
        ],
      },
    ],
  },
};

/** "在地图上看"查到的（demoMapFind 放进来的，编号 amap-p… / google-p… / osm-p…） */
const FOUND: Map<string, MapDrawing> = new Map();
let foundSeq = 0;

/**
 * "在地图上看"（447，FakeDaemonHttp.mapFind）：带汉字的当国内地址（"高德"查到西湖边），不带的当国外查到滨海湾——google（谷歌地图插件开着）
 * 时"谷歌"查的（446：守护进程"自动"时大陆外先问谷歌），不然 OpenStreetMap；写着"找不到"、nowhere 的回没找到
 */
export function demoMapFind(text: string, google = false): MapFindResult {
  const said = text.replace(/\s+/g, " ").trim();
  if (/找不到|nowhere/i.test(said)) return { ok: false, reason: fakeFormat("地图上没找到「{}」：选得具体些（带上城市、区）再试", said.slice(0, 40)) };
  const mainland = /\p{Script=Han}/u.test(said);
  const source = mainland ? "amap" : google ? "google" : "osm";
  foundSeq += 1;
  const lookup = `${source}-p${foundSeq}`;
  const at = mainland ? { lat: 30.2598, lon: 120.1452 } : { lat: 1.2834, lon: 103.8607 };
  FOUND.set(lookup, { id: lookup, kind: "places", source, title: said, at: new Date().toISOString(), marks: [{ id: "hit-1", ...at, label: said, kind: "search" }], lines: [] });
  return { ok: true, lookup, source, kind: "places", title: said };
}

/** 查地点、算路线查到的那一份（FakeDaemonHttp.mapDrawing）：演示的只有 amap-r2 和"在地图上看"查到的，别的当作过期了 */
export function demoMapDrawing(lookup: string): Promise<MapDrawing> {
  const drawing = DEMO_DRAWINGS[lookup] ?? FOUND.get(lookup);
  return drawing ? Promise.resolve(drawing) : Promise.reject(new Error("这次查到的地点和路线已经过期了（只在这台电脑上留一会儿、不存）：再问一次就有"));
}

/** 地图页上说的哪句话原型回一张地图卡片（461）：带"标"字的（"把附近的咖啡馆标出来""再把公司标上"），英文带 mark 的 */
export const DEMO_MAP_ASK = /标|\bmark/i;

/** 原型轮着画的几组（照说话时地图看的中心往旁边挪：纬度、经度各挪几格，一格随级别缩放） */
const DEMO_DRAWS: readonly { readonly title: string; readonly reply: string; readonly marks: readonly { readonly label: string; readonly dlat: number; readonly dlon: number }[] }[] = [
  {
    title: "附近的咖啡馆",
    reply: "（原型）标好了：附近 3 家咖啡馆，都在地图上了。",
    marks: [
      { label: "湖边咖啡", dlat: 0.6, dlon: -0.8 },
      { label: "转角咖啡", dlat: -0.5, dlon: 0.9 },
      { label: "书店咖啡", dlat: 0.9, dlon: 0.6 },
    ],
  },
  {
    title: "附近的地铁站",
    reply: "（原型）两个地铁站也标上了，和刚才的叠在一起。",
    marks: [
      { label: "地铁站 · 东口", dlat: -1.3, dlon: -1.4 },
      { label: "地铁站 · 西口", dlat: 1.3, dlon: 1.5 },
    ],
  },
  { title: "公司", reply: "（原型）公司标上了。", marks: [{ label: "公司", dlat: -0.3, dlon: -1.3 }] },
];

/** 编的点别出了能画的范围 */
const clampLat = (v: number) => Math.min(84, Math.max(-84, v));
const clampLon = (v: number) => Math.min(179.9, Math.max(-179.9, v));

/** 说了"只看……""换成……""别的不要了"：替掉地图上之前画的（秘书照这个填 replace） */
const DEMO_REPLACE = /只看|换成|别的不要|\bonly\b|instead/i;

/**
 * 地图页上说"把……标出来"（461）时原型回的那张卡：第 n 次画第 n 组（轮着来），点照说话时地图看的中心编（一格约 450 米 × 2^(14-级别)，14 级以上按 14 级），
 * 说了"只看""换成"的写 replace；reply 是二狗这一轮说的那句（短，悬浮按钮的气泡里显示）。名字、标题按界面语言
 */
export function demoMapDraw(n: number, at: { readonly lat: number; readonly lon: number; readonly zoom: number }, said: string): { payload: MapCardPayload; reply: string } {
  const draw = DEMO_DRAWS[n % DEMO_DRAWS.length]!;
  // 放大过 14 级的按 14 级算（接着画的一组和前一组差不多大，不会越画越小）
  const step = 0.004 * 2 ** (14 - Math.min(14, Math.max(8, at.zoom)));
  const lonStep = step / Math.max(0.2, Math.cos((at.lat * Math.PI) / 180));
  const marks = draw.marks.map((m, i) => ({ id: `p${i + 1}`, lat: clampLat(at.lat + m.dlat * step), lon: clampLon(at.lon + m.dlon * lonStep), label: fakeText(m.label) }));
  const replace = DEMO_REPLACE.test(said);
  return {
    payload: { title: fakeText(draw.title), show: { kind: "points", marks }, ...(replace ? { replace: true as const } : {}) },
    reply: replace ? fakeText("（原型）换好了：地图上只留这一次标的。") : fakeText(draw.reply),
  };
}

/** 原型这次打开以后画的地图卡片（预览图按卡片编号取：FakeDaemonHttp.mapPreview） */
const DRAWN_CARDS: Map<string, MapCardPayload> = new Map();

export function rememberDemoMapCard(id: string, payload: MapCardPayload): void {
  DRAWN_CARDS.set(id, payload);
}

export function demoDrawnMapCard(id: string): MapCardPayload | undefined {
  return DRAWN_CARDS.get(id);
}
