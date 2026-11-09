// 静态预览图上自己画的点和线（453）：高德、谷歌只给一张光底图（守护进程只要中心、级别、尺寸、清晰度、深浅，点和线不交给它们），
// 回应头 X-Map-View 写着这张图看的是哪一片（MapPreviewView），这里照它在本机投影、把卡片要画的东西（card-scene.ts 的 scene）画在图上。
// - 投影（previewPoint）：Web 墨卡托、256 像素一张瓦片；那家是 gcj02 的（高德、谷歌）大陆里的点和图的中心都先转 GCJ-02 再投影
//   （和 446、451 的规矩一样），横着取离中心最近的那一份；
// - 图在盒子里是 object-fit: cover（铺满、居中、多的裁掉）：coverFit 算出图在盒子里的缩放和左上角，点照它摆，和图对得上；
// - 不盖地图公司的标志和版权：它们在图的最下面一条（左下标志、右下版权），这一层只画到那一条上面（LOGO_BAND），
//   东西落进去的被裁掉（守护进程看全时下面也留了这么多边，一般落不进去）；
// - 点带序号（numberedMarks）：主要的那一种按先后写 1、2、3……（足迹是停留、查到的是搜到的、别的是地点），没有上限；
//   "现在在哪"、照片、没去的常去地方只画点不写号；点旁边的字不写（名字写在卡片下面那一行），样子和地图页的点一样（map.css）。
// 整块不能点（卡片上那一层"看大地图"盖在上面）。
import { type CSSProperties, useEffect, useState } from "react";
import { type LatLon, type MapPreviewView, wgsToGcj } from "../../state/index.ts";
import type { MapMark, MapScene } from "./scene.ts";
import { metersPerPixel, screenPoint } from "./tiles.ts";

/** 图最下面留给地图公司标志和版权的那一条（逻辑像素）：这一层不画进去 */
export const LOGO_BAND = 24;

/** 一个点（WGS-84）落在图上哪个像素（图的逻辑像素，左上角是 0,0） */
export function previewPoint(p: LatLon, view: MapPreviewView): { x: number; y: number } {
  const conv = (q: LatLon) => (view.datum === "gcj02" ? wgsToGcj(q) : q);
  return screenPoint(conv(p), conv({ lat: view.lat, lon: view.lon }), view.zoom, view.width, view.height);
}

/** 图（宽高 w×h）照 object-fit: cover 放进盒子（宽高 W×H）：缩放、左上角在盒子里的位置 */
export function coverFit(box: { width: number; height: number }, view: Pick<MapPreviewView, "width" | "height">): { scale: number; left: number; top: number } {
  const scale = Math.max(box.width / view.width, box.height / view.height);
  return { scale, left: (box.width - view.width * scale) / 2, top: (box.height - view.height * scale) / 2 };
}

/**
 * 哪几个点写序号、写几：有停留就只给停留编号（足迹卡），不然有搜到的就只给搜到的（查到的），再不然给地点（点、路线）；
 * 按画的先后从 1 起，没有上限。"现在在哪"、照片不写
 */
export function numberedMarks(marks: readonly MapMark[]): Map<string, number> {
  const kinds = new Set(marks.map((m) => m.kind ?? "place"));
  const main = kinds.has("stay") ? "stay" : kinds.has("search") ? "search" : "place";
  const out = new Map<string, number>();
  for (const m of marks) if ((m.kind ?? "place") === main) out.set(m.id, out.size + 1);
  return out;
}

/** 图上那一层：盒子是装着图的那一块（量出来的宽高） */
export function StaticOverlay({ scene, view, box }: { scene: MapScene; view: MapPreviewView; box: { width: number; height: number } }) {
  if (box.width <= 0 || box.height <= 0) return null;
  const fit = coverFit(box, view);
  const width = view.width * fit.scale;
  const height = Math.max(0, (view.height - LOGO_BAND) * fit.scale);
  const at = (p: LatLon) => {
    const q = previewPoint(p, view);
    return { x: q.x * fit.scale, y: q.y * fit.scale };
  };
  const numbers = numberedMarks(scene.marks);
  const style: CSSProperties = { left: `${fit.left}px`, top: `${fit.top}px`, width: `${width}px`, height: `${height}px` };
  return (
    <div className="map-overlay map-static-overlay" style={style} aria-hidden="true" data-zoom={view.zoom}>
      <svg className="map-shapes" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {scene.circles.map((c) => {
          const p = at(c);
          return <circle key={c.id} className={c.kind ? `map-circle map-circle-${c.kind}` : "map-circle"} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={((c.radius / metersPerPixel(c.lat, view.zoom)) * fit.scale).toFixed(1)} data-id={c.id} />;
        })}
        {scene.lines
          .filter((l) => l.points.length >= 2)
          .map((l) => (
            <polyline
              key={l.id}
              className={`map-line${l.kind ? ` map-line-${l.kind}` : ""}`}
              points={l.points
                .map((pt) => {
                  const p = at(pt);
                  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
                })
                .join(" ")}
              data-id={l.id}
            />
          ))}
      </svg>
      <div className="map-marks">
        {scene.marks.map((m) => {
          const p = at(m);
          const n = numbers.get(m.id);
          return (
            <span key={m.id} className="map-mark" data-id={m.id} data-kind={m.kind ?? "place"} data-n={n} style={{ transform: `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)` }}>
              <span className="map-pin" />
              {n !== undefined && <span className="map-mark-num">{n}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 一张静态预览图加上面自己画的那一层（卡片、地图页的静态大图都用）：图铺满盒子（object-fit: cover），量盒子的大小（会变：转屏、拖窗口），
 * 那一层照着摆。view 没有（旧守护进程：图里自己带着点）就只放图
 */
export function StaticPreview({ url, view, scene, alt, imgClass }: { url: string; view: MapPreviewView | undefined; scene: MapScene | undefined; alt: string; imgClass?: string | undefined }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const take = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    take();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(take);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return (
    <div className="map-preview" ref={setEl} data-overlay={view !== undefined && scene !== undefined ? "" : undefined}>
      <img className={imgClass} src={url} alt={alt} />
      {view !== undefined && scene !== undefined && <StaticOverlay scene={scene} view={view} box={box} />}
    </div>
  );
}
