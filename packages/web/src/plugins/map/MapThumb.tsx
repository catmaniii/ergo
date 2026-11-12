// 聊天里地图卡片的缩略图（431）：一块不能拖的小地图，看全卡上画的东西。
// - 自己画：瓦片底图（455 起谁家的瓦片由登记它的插件给：OpenStreetMap 插件的瓦片经这台电脑转发），和地图页同一套瓦片引擎
//   （tile-engine.ts），点和线自己画；聊天页**不加载高德、谷歌的脚本**；
// - 451 起卡片按"当前地图"挑（MapCard.tsx、providers.ts 的 cardBasemap）：挑出来是能出静态图的那家（高德、谷歌）时放守护进程取来的
//   静态预览图，是瓦片底图（或者别家的图取不到、退回来）时才用这里自己画；
// - 不能拖、不能缩放、点不了上面的点（整块 inert）：聊天里滚动不被它吃掉；点卡片上的"看大地图"进地图页；
// - 署名：照那一家登记的写在右下角（OpenStreetMap："© OpenStreetMap 贡献者"；演示页再写一句底图是编的）。
import { useEffect, useRef } from "react";
import type { MapTileSource } from "../api.ts";
import type { MapCardContent } from "./card-scene.ts";
import { TileAttribution } from "./attribution.tsx";
import type { MapEngine } from "./engine.ts";
import { useDark } from "./MapView.tsx";
import { DEFAULT_VIEW, type MapView, viewToFit } from "./scene.ts";
import { createTileEngine } from "./tile-engine.ts";
import { pointAt, worldPoint } from "./tiles.ts";

/** 看全时四周留的边（像素）：定位针往上伸 30 像素，上面多留一些；右上角是"看大地图"、下面是署名 */
const PAD = { x: 24, top: 40, bottom: 28 };

/** 看全这些点的视野：四周留出边，针尖朝下的定位针整枚都在框里 */
export function thumbView(bounds: MapCardContent["bounds"], width: number, height: number): MapView {
  const v = viewToFit(bounds, width - 2 * PAD.x, height - PAD.top - PAD.bottom);
  if (!v) return DEFAULT_VIEW;
  // 中心往上挪半个"上下边的差"：东西落在留了边以后剩下那一块的正中
  const c = worldPoint(v, v.zoom);
  const at = pointAt(c.x, c.y - (PAD.top - PAD.bottom) / 2, v.zoom);
  return { lat: at.lat, lon: at.lon, zoom: v.zoom };
}

export function MapThumb({ content, provider, tiles }: { content: MapCardContent; provider: string; tiles: MapTileSource }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | undefined>(undefined);
  const dark = useDark();
  const darkRef = useRef(dark);
  useEffect(() => {
    darkRef.current = dark;
    engineRef.current?.setDark(dark);
  }, [dark]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = thumbView(content.bounds, host.clientWidth || 320, host.clientHeight || 168);
    // 这里只画瓦片底图（聊天页不加载高德、谷歌的脚本；它们的卡片用静态预览图）
    host.dataset.basemap = provider;
    // 缩略图上不写点旁边的字（map-card.css），不用排字
    const engine = createTileEngine(host, { view, tileUrl: (z, x, y) => tiles.tileUrl(z, x, y), maxTileZoom: tiles.maxZoom, engineName: "thumb", labelLayout: false, onMoveEnd: () => {} });
    engine.setScene(content.scene);
    engine.setDark(darkRef.current);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = undefined;
    };
  }, [content, provider, tiles]);

  return (
    <>
      {/* inert：不能拖、不能点上面的点、不进 Tab 顺序（React 19 认这个属性） */}
      <div className="map-host" ref={hostRef} inert />
      <TileAttribution tiles={tiles} />
    </>
  );
}
