// 地图页上二狗画的那一叠（461：二狗在地图上画的直接出现在地图上，不用再点卡片）。纯函数，不碰 DOM、不联网，测试在 Node 里跑；
// 地图页（MapPage.tsx）拿它记着画了哪几张、新到的怎么叠、标题栏写什么。
// - 只认地图页打开以后新出的：打开（连接补发推完）那一刻秘书会话收到的最后一个序号记成 since，之后的消息里引用的地图卡片
//   （card_ref，show_on_map 出的；不管在右边聊天窗、悬浮按钮、还是别的设备上说的）才自动画；打开前的旧卡不画。认过的记在 seen 里，不认第二次；
// - 叠：新的加在后面，不冲掉前面的；卡上写了 replace（秘书照"换成……""只看……"填的）的这张替掉之前画的。最多叠 DRAWN_MAX 张，多了挤掉最早的；
// - 足迹卡（某一天）：照现在"看那一天"的样子——清掉二狗画的点线，地图页换到那一天的足迹（MapPage 交给足迹那一套），
//   和点开足迹卡一样；同一批里它后面再画的点、路线照样叠上去（这时看的是二狗画的，"×"清掉回到那一天）；
// - 点开一张（地址里的 #/more/map/card/<编号>、"在地图上看"的 #/more/map/lookup/<编号>）：照旧只看它；之后新画的叠在它上面；
// - "×"：一次清掉，回到足迹（或者光地图）；
// - 视野（drawnFit）：新画了一张，挪到看全地图上二狗画的全部；全部看全要比只看最新那张缩小 DRAWN_FIT_ZOOM_GAP 级以上
//   （前面画的在杭州、新画的在新加坡这种；最新那张最多按街道那一级算），只看全最新那张。
// 画法和点开卡片完全一样（card-scene.ts 那一份）：哪儿都能画的合成一层；高德、谷歌查来的只能画在它自己的地图上——
// 叠着几张这种的，用最新那张的那一家（这一屏临时换它），别家查来的这时画不上（换回它那张、或者点开那张卡再看）。
import { CHANNELS, type LatLon, type MapCardPayload, type MapCardShow, type UiState } from "../../state/index.ts";
import { CARD_PREFIX, type MapCardData } from "./card-scene.ts";
import { EMPTY_SCENE, type MapScene, type MapView, viewToFit } from "./scene.ts";

/** 地图上一次最多叠几张（再多挤掉最早的） */
export const DRAWN_MAX = 20;

/** 看全叠着的全部要比只看最新那张缩小这么多级（或更多）时，只看全最新那张 */
export const DRAWN_FIT_ZOOM_GAP = 3;
/**
 * 比的时候最新那张最多按这一级算（viewToFit 只有一个点时看的级别，街道那么大）：最新那张的几个点挨得很近（看全它要放大到 17、18 级）时，
 * 不因为它放得太大就把旁边几公里的前一组甩出去
 */
export const DRAWN_FIT_REF_ZOOM = 15;

/** 查到的一处（447，不经卡片看的） */
export type LookupShow = Extract<MapCardShow, { kind: "lookup" }>;

/** 叠着的一张：聊天里的地图卡片（按编号，负载从手里的卡片状态现取），或者不经卡片看的查到的一处（地址里来的） */
export type DrawnItem = { readonly kind: "card"; readonly cardId: string } | { readonly kind: "lookup"; readonly show: LookupShow };

/** 一张的编号（同一张不画两遍、取的东西按它记） */
export const drawnKey = (item: DrawnItem): string => (item.kind === "card" ? `card:${item.cardId}` : `lookup:${item.show.lookup}`);

/** 地图页上二狗画的那一叠 */
export interface MapDrawn {
  /** 秘书会话里这个序号以后新出的地图卡片才自动画（地图页打开、补发推完那一刻收到的最后一个）；还没定是 undefined（一张都不认） */
  readonly since: number | undefined;
  /** 认过的卡（自动画过的、点开看过的）：不再认 */
  readonly seen: readonly string[];
  /** 地图上叠着的，先画的在前；空的是没画（看足迹、光地图） */
  readonly items: readonly DrawnItem[];
}

export const NO_DRAWN: MapDrawn = { since: undefined, seen: [], items: [] };

/** 定下从哪以后算新的（cursor：这时秘书会话收到的最后一个序号）；定过了不再改（断线重连补发来的、打开以后出的照样算新的） */
export function drawnSince(drawn: MapDrawn, cursor: number): MapDrawn {
  return drawn.since === undefined ? { ...drawn, since: cursor } : drawn;
}

/** 秘书会话里新出的一张地图卡片：编号、那条消息的序号、负载 */
export interface ArrivedCard {
  readonly cardId: string;
  readonly seq: number;
  readonly payload: MapCardPayload;
}

/**
 * 秘书会话里 since 以后新出的、没认过的地图卡片，按先后。卡片状态还没到手的先不算（到了再认）；
 * since 还没定时一张都不认
 */
export function arrivedMapCards(ui: Pick<UiState, "conversations" | "cards">, drawn: MapDrawn): ArrivedCard[] {
  const since = drawn.since;
  const conv = ui.conversations[CHANNELS.secretary];
  if (since === undefined || !conv) return [];
  const seen = new Set(drawn.seen);
  const found: ArrivedCard[] = [];
  // 消息按序号从早到晚：从最后往前找到 since 为止
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const entry = conv.messages[i]!;
    if (entry.seq <= since) break;
    if (!("message" in entry)) continue;
    const ids = entry.message.parts.flatMap((p) => (p.type === "card_ref" ? [p.cardId] : []));
    for (const id of ids.toReversed()) {
      const card = ui.cards[id]?.card;
      if (seen.has(id) || card?.type !== "map") continue;
      found.push({ cardId: id, seq: entry.seq, payload: card.payload as MapCardPayload });
    }
  }
  return found.toReversed();
}

/** 画上去以后：新的那一叠；要换到哪一天的足迹（足迹卡）；这一批最后一张（窄屏收起聊天窗、气泡里接着显示这一轮用）；没有新的都不写 */
export interface DrawnStep {
  readonly drawn: MapDrawn;
  readonly day?: string;
  readonly last?: ArrivedCard;
}

/** 新到的几张画上去：叠在后面；replace 的替掉之前画的；足迹卡清掉二狗画的、换到那一天 */
export function takeArrived(drawn: MapDrawn, arrived: readonly ArrivedCard[]): DrawnStep {
  const last = arrived.at(-1);
  if (last === undefined) return { drawn };
  let items = drawn.items;
  let day: string | undefined;
  for (const a of arrived) {
    const show = a.payload.show;
    if (show.kind === "day") {
      items = [];
      day = show.date;
      continue;
    }
    const item: DrawnItem = { kind: "card", cardId: a.cardId };
    items = a.payload.replace === true ? [item] : [...items, item].slice(-DRAWN_MAX);
  }
  const seen = [...drawn.seen, ...arrived.map((a) => a.cardId)];
  return { drawn: { ...drawn, seen, items }, ...(day === undefined ? {} : { day }), last };
}

/** 点开一张（地址里的卡片、查到的一处）：只看它，和以前一样 */
export function openDrawn(drawn: MapDrawn, item: DrawnItem): MapDrawn {
  return { ...drawn, items: [item], seen: item.kind === "card" && !drawn.seen.includes(item.cardId) ? [...drawn.seen, item.cardId] : drawn.seen };
}

/** "×"：一次清掉 */
export function clearDrawn(drawn: MapDrawn): MapDrawn {
  return drawn.items.length === 0 ? drawn : { ...drawn, items: [] };
}

/** 叠着的一张和取到的（还在取、取不到的也在） */
export interface DrawnEntry {
  readonly item: DrawnItem;
  readonly data: MapCardData | undefined;
}

/** 叠着的几张画成地图上的东西 */
export interface DrawnLayers {
  /** 哪家地图上都能画的（足迹卡、二狗给的点和路线、OpenStreetMap 查来的） */
  readonly scene: MapScene;
  /** 只能画在某一家地图上的（高德、谷歌查来的）：最新那张的那一家，和同一家查来的另几张 */
  readonly own?: { readonly source: string; readonly scene: MapScene };
  /** own 里最新的那张（那家在这台设备上加载不了时放它的静态大图） */
  readonly ownItem?: DrawnItem;
  /** 只能画在别家地图上、这一屏画不上的几张（own 用了另一家） */
  readonly hidden: number;
  /** 这一屏画得上的那几张要看全的点（挪视野用；画不上的、还在取的不算） */
  readonly bounds: readonly LatLon[];
}

/** 一张的东西换个编号（叠着几张时每张前面加序号，免得两张都有 card-p1） */
function renamed(scene: MapScene, n: number): MapScene {
  const id = (raw: string) => (raw.startsWith(CARD_PREFIX) ? `${CARD_PREFIX}${n}-${raw.slice(CARD_PREFIX.length)}` : raw);
  return { marks: scene.marks.map((m) => ({ ...m, id: id(m.id) })), lines: scene.lines.map((l) => ({ ...l, id: id(l.id) })), circles: scene.circles.map((c) => ({ ...c, id: id(c.id) })) };
}

function merged(scenes: readonly MapScene[]): MapScene {
  if (scenes.length === 0) return EMPTY_SCENE;
  if (scenes.length === 1) return scenes[0]!;
  return { marks: scenes.flatMap((s) => s.marks), lines: scenes.flatMap((s) => s.lines), circles: scenes.flatMap((s) => s.circles) };
}

/** 几张要看全的点合在一起 */
const boundsOf = (rs: readonly { readonly content: { readonly bounds: readonly LatLon[] } }[]): LatLon[] => rs.flatMap((r) => r.content.bounds);

/** 叠着的几张（先画的在前）画成地图上的东西：只有一张时编号照旧（和点开卡片一样） */
export function drawnLayers(entries: readonly DrawnEntry[]): DrawnLayers {
  const ready = entries.flatMap((e, i) => (e.data?.state === "ready" ? [{ item: e.item, content: e.data.content, scene: entries.length > 1 ? renamed(e.data.content.scene, i + 1) : e.data.content.scene }] : []));
  const anywhere = ready.filter((r) => r.content.ownBasemap === undefined);
  const ownAll = ready.filter((r) => r.content.ownBasemap !== undefined);
  const latestOwn = ownAll.at(-1);
  if (latestOwn === undefined) return { scene: merged(anywhere.map((r) => r.scene)), hidden: 0, bounds: boundsOf(anywhere) };
  const source = latestOwn.content.ownBasemap!;
  const own = ownAll.filter((r) => r.content.ownBasemap === source);
  return {
    scene: merged(anywhere.map((r) => r.scene)),
    own: { source, scene: merged(own.map((r) => r.scene)) },
    ownItem: latestOwn.item,
    hidden: ownAll.length - own.length,
    bounds: boundsOf(ready.filter((r) => r.content.ownBasemap === undefined || r.content.ownBasemap === source)),
  };
}

/**
 * 新画了一张以后看哪里（宽高是地图那一块能放点的像素）：看全地图上二狗画的全部（all）；全部看全要比只看全最新那张（latest）
 * 缩小 DRAWN_FIT_ZOOM_GAP 级以上（最新那张最多按 DRAWN_FIT_REF_ZOOM 级算）时只看全最新那张。都没有点给 undefined
 */
export function drawnFit(all: readonly LatLon[], latest: readonly LatLon[], width: number, height: number): MapView | undefined {
  const one = viewToFit(latest, width, height);
  const every = viewToFit(all.length > 0 ? all : latest, width, height);
  if (one === undefined) return every;
  if (every === undefined) return one;
  return Math.min(one.zoom, DRAWN_FIT_REF_ZOOM) - every.zoom >= DRAWN_FIT_ZOOM_GAP ? one : every;
}
