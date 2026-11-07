// 聊天里地图卡片的缩略图（431）：一块不能拖的小地图，看全卡上画的东西。
// - 自己画：瓦片经这台电脑转发（/tiles/osm，和地图页同一套 osm-engine.ts），点和线自己画；聊天页**不加载高德的脚本**；
// - 底图和地图页同一处挑（scene.ts 的 chooseBasemap）：聊天页上高德不能用（amapUsable 传 false），所以挑出来是 OpenStreetMap；
//   画的是足迹时按 footprints 走（用户定"看足迹时改不改用 OpenStreetMap"以后只改 chooseBasemap 那一处）；
// - 不能拖、不能缩放、点不了上面的点（整块 inert）：聊天里滚动不被它吃掉；点卡片上的"看大地图"进地图页；
// - 署名：OpenStreetMap 的瓦片右下角照样写"© OpenStreetMap 贡献者"（演示页再写一句底图是编的）。
import { useEffect, useRef } from "react";
import { t } from "../../state/index.ts";
import type { MapCardContent } from "./card-scene.ts";
import type { MapEngine } from "./engine.ts";
import { demoBasemapNoteText, osmTileUrl, useDark } from "./MapView.tsx";
import { createOsmEngine } from "./osm-engine.ts";
import { chooseBasemap, DEFAULT_VIEW, viewToFit } from "./scene.ts";

/** OpenStreetMap 的版权页（署名角标链过去） */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
/** 一张透明的空瓦片（挑出来不是 OpenStreetMap 时不画底图，只画点和线） */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function MapThumb({ content }: { content: MapCardContent }) {
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
    const view = viewToFit(content.bounds, host.clientWidth || 320, host.clientHeight || 160) ?? DEFAULT_VIEW;
    // 聊天页不加载高德的脚本：高德在这里不能用（挑出来是 OpenStreetMap）
    const basemap = chooseBasemap(view, false, content.footprints);
    host.dataset.basemap = basemap;
    const engine = createOsmEngine(host, { view, tileUrl: basemap === "osm" ? osmTileUrl : () => BLANK_TILE, maxTileZoom: 19, engineName: "thumb", onMoveEnd: () => {} });
    engine.setScene(content.scene);
    engine.setDark(darkRef.current);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = undefined;
    };
  }, [content]);

  return (
    <>
      {/* inert：不能拖、不能点上面的点、不进 Tab 顺序（React 19 认这个属性） */}
      <div className="map-host" ref={hostRef} inert />
      <div className="map-attribution">
        <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">
          © OpenStreetMap
        </a>{" "}
        {t("ui.plugins.map.osmContributors")}
        {demoBasemapNoteText && <span className="map-demo-note"> · {demoBasemapNoteText()}</span>}
      </div>
    </>
  );
}
