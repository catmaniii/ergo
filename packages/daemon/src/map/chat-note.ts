// 地图页的二狗（444）：地图页右边的聊天窗、右下角的二狗悬浮按钮里发的消息（MessageEnvelope.map）交给秘书时后面跟的那段——
// 用户是在地图页上说的、地图现在看的是哪里（中心、缩放、底图）、看的是哪一天的足迹（选中了哪一处）、哪张地图卡片，
// 这一轮怎么在地图上给他看（show_on_map）。地图插件经 agent 贡献的"输入附注"给（插件停用时没有这段）。
// 底图写的是地图服务插槽（445）里那一家的编号（地图页地图切换报上来的"真画着的那一家"）：这段写明
// "地图上用的是 X（编号 id）"，让秘书查地点、算路线时把工具的 map 参数写成它——查询跟着地图走（lookup-tools.ts 的 map），
// 查来的结果才画得到用户正看着的这张地图上。还没画上（loading）、不是编号的写法时不写 map，按自动挑。
// 名字由登记那一家的插件给（MapProvider.modelName，455：地图插件不认得任何一家）；没登记的照原样写编号。
// 451 起开着"足迹"时底图也是当前地图，编号就是画着的那一家；453 起足迹、点和线只在用户这台设备上画（不交给地图服务，
// 它们只知道地图看的是哪一片）：开着足迹时照实写一句，他问"地图公司看不看得到"时秘书答得对。
// 给模型看的话，照旧只用中文（多语言第 6 条）。
import { MAP_PROVIDER_ID, type MapMark } from "@ergo/protocol";
import { MAP_TOOL } from "./lookup-tools.ts";
import { SHOW_ON_MAP_TOOL } from "./show-on-map.ts";

/** 地图页还没画上底图时报的（不是哪一家的编号） */
const BASEMAP_LOADING = "loading";


/** 坐标写成几位小数（5 位约 1 米） */
const coord = (n: number) => n.toFixed(5);

// @i18n-ignore-start model：交给秘书的输入附注（给模型看）
/** 地图页上发的那条消息后面那段。nameOf：编号 → 给模型看的名字（登记了的那一家给的；不认得的交回 undefined，照原样写编号） */
export function mapChatNote(mark: MapMark, nameOf: (id: string) => string | undefined = () => undefined): string {
  const how = mark.via === "button" ? (mark.spoken ? "右下角的二狗悬浮按钮上按住说的（语音认出来的字）" : "右下角的二狗悬浮按钮上点它打的字") : "右边的二狗聊天窗里说的";
  const loading = mark.basemap === BASEMAP_LOADING;
  /** 是地图服务的编号（工具的 map 认的写法）才叫秘书照它查；别的写法（不认得的）只照原样写底图 */
  const id = !loading && MAP_PROVIDER_ID.test(mark.basemap) ? mark.basemap : undefined;
  // 451 起看足迹时底图也是当前地图：开不开足迹，编号都是画着的那一家（查询跟着它走）
  const basemap = loading ? "底图还没画上" : id ? `地图上用的是${nameOf(id) ?? id}（地图服务编号 ${id}）` : `底图是${mark.basemap}`;
  const view = `地图现在看的中心在纬度 ${coord(mark.lat)}、经度 ${coord(mark.lon)}（WGS-84），缩放 ${Math.round(mark.zoom * 10) / 10} 级（3 级看全国、11 级看一个城市、17 级看街道），${basemap}`;
  const looking = mark.card
    ? `看的是聊天里的一张地图卡片${mark.card.title ? `「${mark.card.title}」` : ""}（卡片 ${mark.card.id}）`
    : mark.footprints
      ? `"足迹"开着，看的是 ${mark.footprints.date} 那一天的足迹${mark.footprints.spot ? `，选中了「${mark.footprints.spot}」` : ""}（足迹只在他这台设备上画，不发给任何地图服务，它们只知道地图看的是哪一片）`
      : `"足迹"关着`;
  const lines = [
    `（这句是用户在二狗的地图页上，${how}：${view}；${looking}。`,
    `用户说"这里""这一片""附近"多半指地图现在看的这一带，不一定是他本人现在的位置（他的位置不在这段里）。`,
    ...(id === undefined
      ? []
      : [`查地点、地址、算路线（${MAP_TOOL.search}、${MAP_TOOL.geocode}、${MAP_TOOL.reverse}、${MAP_TOOL.route}）时把 map 写成"${id}"：查询跟着他地图上用的这一家走，查来的结果才画得到这张地图上。`]),
    `要在地图上给他看地点、路线、某一天的足迹，用 ${SHOW_ON_MAP_TOOL} 画成聊天里的地图卡片（他点开就在地图页上看）。`,
    ...(mark.via === "button" ? ["从悬浮按钮来的：用户在地图上按钮旁边的小气泡里看你的回话，回话要短，一两句话（30 字上下），不列清单。"] : []),
  ];
  return `${lines.join("\n")}）`;
}
// @i18n-ignore-end
