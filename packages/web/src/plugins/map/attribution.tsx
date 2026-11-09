// 瓦片底图的署名（455）：右下角照登记那一家的写（OpenStreetMap："© OpenStreetMap 贡献者"，链到它的版权页）；演示页再写一句底图是编的。
// 地图页（MapView.tsx）、聊天卡片的缩略图（MapThumb.tsx）共用。高德、谷歌的底图自己画标志和版权，地图插件不另写。
import type { MapTileSource } from "../api.ts";
import { demoBasemapNoteText } from "./demo-note.ts";

/** 瓦片底图的署名（地图页、缩略图共用）：链到那一家的版权页，后面跟一句；演示页再写一句底图是编的 */
export function TileAttribution({ tiles }: { tiles: MapTileSource }) {
  const { label, href, after } = tiles.attribution;
  return (
    <div className="map-attribution">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
      {after === undefined ? null : ` ${after}`}
      {demoBasemapNoteText && <span className="map-demo-note"> · {demoBasemapNoteText()}</span>}
    </div>
  );
}
