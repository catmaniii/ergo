// 原型的地图（429）：演示页不连守护进程、不连高德和 OpenStreetMap，地图页用编的东西——
// - 当作填好了高德的 Key（DEMO_AMAP_KEY，假的）：国内那一处用"高德"（演示页里的高德是假的，plugins/map/demo-amap.ts 拿占位底图画）；
// - 两个地点：国内一处（杭州西湖）、新加坡一处（滨海湾），点了跳过去，底图跟着换；
// - 占位底图（demoTileUrl）：编的街区格子，不是真的地图；两种底图颜色不同，一眼分得出是哪一种。
// - 聊天里地图卡片的那条路线（431，demoMapDrawing）：OpenStreetMap 查的、从公司到西湖边，编的。
// 只在演示页里用（地图页 import.meta.env.MODE === "demo" 的分支、FakeDaemonHttp）。英文在 en/fake-map.ts。
import type { MapDrawing } from "../state/index.ts";
import { fakeText } from "./fake-content.ts";

/** 演示页里"填好了"的高德 Key（假的，安装版的产物里不该有它：DEMO_SENTINELS） */
export const DEMO_AMAP_KEY = "demo-amap-key-not-real";

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

/** 两种占位底图的颜色：底、街道、公园、水 */
const PALETTE = {
  osm: { ground: "#f2efe9", street: "#ffffff", edge: "#d9d2c5", park: "#cfe8c4", water: "#aad3df" },
  amap: { ground: "#eef1f6", street: "#ffffff", edge: "#d4dae6", park: "#d3ecd0", water: "#9ec7f0" },
} as const;

/** 一个整数的哈希（编街道、公园用：同一个位置每次一样） */
function hash(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * 一张占位瓦片（SVG 的 data: 地址）：每张分成 4×4 格，格子随机是街区、公园或水；街道按全局的行列号定，横竖连得上。
 * 是编的，不对应任何真实的地方
 */
export function demoTileUrl(style: "osm" | "amap", z: number, x: number, y: number): string {
  const c = PALETTE[style];
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
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" fill="${c.ground}"/>${cells.join("")}` +
    `<g stroke="${c.edge}" fill="none">${edges.join("")}</g><g stroke="${c.street}" fill="none">${roads.join("")}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 聊天里的地图卡片（431）：演示的那条路线（OpenStreetMap 查的，编的）从公司到西湖边，开车、步行各一条；坐标和 fake-footprints.ts 的公司、西湖边一样 */
const DEMO_DRAWINGS: Readonly<Record<string, MapDrawing>> = {
  "osm-r1": {
    id: "osm-r1",
    kind: "route",
    source: "osm",
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

/** 查地点、算路线查到的那一份（FakeDaemonHttp.mapDrawing）：演示的只有 osm-r1，别的当作过期了 */
export function demoMapDrawing(lookup: string): Promise<MapDrawing> {
  const drawing = DEMO_DRAWINGS[lookup];
  return drawing ? Promise.resolve(drawing) : Promise.reject(new Error("这次查到的地点和路线已经过期了（只在这台电脑上留一会儿、不存）：再问一次就有"));
}
