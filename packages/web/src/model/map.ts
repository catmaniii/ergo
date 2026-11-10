// 地图上画什么、看哪里，和"画地图的那一层"的外形（429 起在地图插件里，445 挪到核心：地图服务插槽 mapBasemaps 的条目要用它，
// 别的插件登记一种底图时照它写引擎，插件之间不互相 import）。只有类型，不碰 DOM 以外的东西。
// - 坐标一律 WGS-84（二狗里存的、手机交来的就是它），要转的底图（高德、谷歌在大陆是 GCJ-02）由它自己的引擎转；
// - 地图插件里 plugins/map/scene.ts、engine.ts 原样转出这些类型，插件里别的文件照旧从那两处 import。
import type { LatLon, MapDatum } from "../state/index.ts";

/** 看的是哪里：中心（WGS-84）和级别（Web 墨卡托的级别，可以带小数） */
export interface MapView {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
}

/** 地图上的一个点 */
export interface MapMark {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** 旁边写的字（地名、"14:20 · 停留 2 小时"） */
  readonly label?: string;
  /**
   * 种类：样式按它分（地点、停留、照片、搜到的、现在在哪）。me 是地图页"回到我现在的位置"（442）定到的那一点：蓝点，不是定位针
   * （here 是查路线时"从当前位置"那一头，照旧是针）
   */
  readonly kind?: "place" | "stay" | "photo" | "search" | "here" | "me";
}

/** 一条线：轨迹、路线 */
export interface MapLine {
  readonly id: string;
  readonly points: readonly LatLon[];
  readonly kind?: "track" | "route";
}

/** 一个圈：常去的地方的范围；定位的精度圈（442） */
export interface MapCircle {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** 半径（米） */
  readonly radius: number;
  /** 种类：不写是范围（强调色）；accuracy 是"回到我现在的位置"的精度圈（和蓝点同色） */
  readonly kind?: "accuracy";
}

/** 地图上画的全部东西 */
export interface MapScene {
  readonly marks: readonly MapMark[];
  readonly lines: readonly MapLine[];
  readonly circles: readonly MapCircle[];
}

/**
 * 只出底图的引擎（453：高德、谷歌）此刻画着哪一片：每动一下（拖、捏、滚轮、惯性、跳过去）都报，地图页在底图上面盖着自己的一层，
 * 照它投影、画足迹和点线（这些不交给地图公司的接口）。中心是这家地图自己的坐标（datum 是 gcj02 时大陆里是 GCJ-02），
 * 级别可以带小数，宽高是底图那一块的 CSS 像素
 */
export interface MapSurfaceView {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  readonly datum: MapDatum;
}

export interface MapEngineEvents {
  /** 拖完、缩放完（停下来）：现在看的是哪里 */
  onMoveEnd(view: MapView): void;
  /** 只出底图的引擎：此刻画着哪一片（每动一下都报，453）；自己画点线的引擎（OpenStreetMap）不报 */
  onSurface?(view: MapSurfaceView): void;
  /** 建好时还在加载的引擎（loading 为真：隔离框里的谷歌）加载好了 */
  onReady?(): void;
  /** 点了地图上的一个点 */
  onMarkClick?(id: string): void;
  /**
   * 建好以后这一家又不能用了（446：谷歌加载上以后才说浏览器用的 Key 不对，gm_authFailure）：reason 给人看。
   * 地图页把这一家记成"这一页加载失败"（退回 OpenStreetMap、地图切换里标"连不上"、手动选的退回"自动"），和准备时抛错一样
   */
  onFailed?(reason: string): void;
}

/** 画地图的那一层：地图页只经这个接口用它，换底图时整个换掉 */
export interface MapEngine {
  /** 哪一家的底图（地图服务的编号：amap、osm……） */
  readonly kind: string;
  /**
   * 建好时还在加载（453：谷歌在隔离框里加载）：加载好了报 onReady，加载不了报 onFailed；地图页在那之前照"想用的那一家还在加载"
   * 显示（写"正在加载…"、不先画别家）。准备时就加载好了的不写
   */
  readonly loading?: boolean;
  /** 现在看的是哪里 */
  view(): MapView;
  /** 跳到哪里（不带动画）；跳完和拖完一样报 onMoveEnd */
  setView(view: MapView): void;
  /** 放大缩小几级（正的放大） */
  zoomBy(delta: number): void;
  /**
   * 地图上画什么（整份换掉）：自己画点线的引擎（OpenStreetMap）有；只出底图的引擎（453：高德、谷歌——足迹、点线不交给它们的接口）
   * 不写，由地图页照 onSurface 报的视野在上面那一层画
   */
  setScene?(scene: MapScene): void;
  /** 平移多少像素（地图页那一层上按住一个点拖的时候转给底图；正的往右、往下拖）；只出底图的引擎有 */
  panBy?(dx: number, dy: number): void;
  /** 深色：OSM 的瓦片加滤镜，高德换深色样式 */
  setDark(dark: boolean): void;
  /** 停用：拆掉自己加的元素和监听 */
  destroy(): void;
}

/** 自己画点线的引擎（OpenStreetMap、聊天卡片的缩略图）：一定有 setScene */
export type SceneEngine = MapEngine & { setScene(scene: MapScene): void };

/** 建一个引擎时给的：一开始看哪里、深不深，和两个事件 */
export interface MapEngineOptions extends MapEngineEvents {
  readonly view: MapView;
  readonly dark: boolean;
}

/** 建引擎的函数（地图服务插槽的条目准备好以后交回的）：在 host 里画 */
export type MapEngineFactory = (host: HTMLElement, options: MapEngineOptions) => MapEngine;

/**
 * 自己画的瓦片地图（地图插件的瓦片引擎，455：OpenStreetMap 那种"页面自己画"的底图；演示页的假高德也借它扮）的选项：
 * 一开始看哪里、一张瓦片的地址、瓦片最大到第几级（再放大就把这一级的放大着画）
 */
export interface TileEngineOptions extends MapEngineEvents {
  readonly view: MapView;
  tileUrl(z: number, x: number, y: number): string;
  readonly maxTileZoom: number;
  /** 根元素上的 data-engine（地图页写那一家的编号；演示页的假高德写 amap-demo；卡片的缩略图写 thumb） */
  readonly engineName?: string;
  /** 点旁边的字互相让开（451 补）；聊天卡片的缩略图不写字，给 false 省掉 */
  readonly labelLayout?: boolean;
}
