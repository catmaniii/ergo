// 地图页的页面 id（地址 #/more/map、导航那一项的 data-nav）：插件定义和聊天里的地图卡片（点开去地图页）都用。
// 定义在协议包（MAP_PAGE_ID）："浏览"里网页上的地址点"在地图上看"（447）也要跳到这一页，浏览插件不 import 地图插件
import { MAP_PAGE_ID } from "../../state/index.ts";

export const MAP_PAGE = MAP_PAGE_ID;
