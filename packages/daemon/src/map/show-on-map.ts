// 秘书的"画在地图上"（show_on_map，431）：把一样东西画成聊天里的一张地图卡片（card.ts），用户点开进地图页看大的。一次画一样：
// - date：某一天的足迹（经 MAP_DAY 现算：去过哪、待了多久、照片在哪拍的）——卡上只存日期；工具结果里按先后列出待过的几处（名字、
//   几点到几点）和照片张数，让秘书先说结论（"去了 3 个地方：公司、西湖边、家"）。这一天什么都没有就不出卡，说最近有足迹的是哪天；
// - points：一组点（秘书自己给的坐标，WGS-84，每个点写个名字）；
// - route：一条路线（按先后的点连成线；起点、终点总标出来，途经的写了名字才标）；
// - lookup：查地点、算路线（432 高德、433 OpenStreetMap：map_search_places、map_route、map_geocode、map_reverse_geocode 的结果末尾
//   "编号 amap-r1""编号 osm-p1"）那一次查到的点和线——从地图插件的内存里按编号取（lookups，就是查的时候放进去的 service.lookups），
//   卡上只存编号、种类、哪家查的和标题（高德的协议不许存它的结果），
//   网页按编号现取来画；取不到（过期了、二狗重启过、编号不对）回错，让秘书再查一次。
// 461：用户开着地图页时，新出的卡直接画到他正看着的地图上（不用再点卡片），连着画的叠在一起；replace 填 true 的这张替掉地图上
// 二狗之前画的（用户说"换成……""只看……""别的不要了"）。卡上带着它（MapCardPayload.replace），地图页照它办。
// 只读：不改任何东西、不往外发（足迹只在二狗里算，lookup 取的是已经查到的）；每调一次多一张卡，所以不算幂等。
// 用户自己的坐标不写进工具结果（模型那边也是外面的服务）：只写名字和时间。
// @i18n-ignore-file model：工具的说明、参数说明和结果给秘书（模型）看；工具的名字走 t()
import { clockLabel, type MapCardMark, type MapCardPayload, MAP_CARD_LABEL_MAX, MAP_CARD_MARKS_MAX, MAP_CARD_ROUTE_POINTS_MAX, MAP_CARD_TITLE_MAX, type MapDayView, type MapDrawing, mapCardTitle, mapDateProblem, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";

/** 工具名 */
export const SHOW_ON_MAP_TOOL = "show_on_map";

/** 查地点、算路线（432、433）查到的能画的那几份：按编号取，过期、挤掉了、没有是 undefined（432 的 LookupResults 就是这个形状） */
export interface MapLookups {
  get(id: string): MapDrawing | undefined;
}

export interface ShowOnMapDeps {
  /** 某一天的足迹（MAP_DAY：经手机插件现算，不联网）；日期不对、手机插件没启用抛 RequestRejected */
  day(date: string): MapDayView;
  /** 查地点、算路线留在内存里的那几份（现取：地图插件的 service.lookups）；取不到是 undefined，当作没有那个编号 */
  lookups(): MapLookups | undefined;
  cards: Pick<CardService, "create">;
}

const Point = Type.Object(
  {
    lat: Type.Number({ minimum: -85, maximum: 85, description: "纬度（WGS-84，GPS 的坐标；查地点结果里给的就是）" }),
    lon: Type.Number({ minimum: -180, maximum: 180, description: "经度（WGS-84）" }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CARD_LABEL_MAX, description: "旁边写的名字（\"西湖\"\"起点\"）" })),
  },
  { additionalProperties: false },
);

const Params = Type.Object(
  {
    date: Type.Optional(Type.String({ description: "画某一天的足迹（去过哪、待了多久、照片在哪拍的）：YYYY-MM-DD，按用户消息前的时间标记算今天、昨天" })),
    points: Type.Optional(Type.Array(Point, { minItems: 1, maxItems: MAP_CARD_MARKS_MAX, description: "标一组点：每个点写上名字" })),
    route: Type.Optional(Type.Array(Point, { minItems: 2, maxItems: MAP_CARD_ROUTE_POINTS_MAX, description: "画一条路线：按先后的点连成线，起点、终点会标出来，途经要标的写 label" })),
    lookup: Type.Optional(
      Type.String({ minLength: 1, maxLength: 40, description: "画查地点、算路线的结果：那次工具结果末尾写的编号（比如 amap-r1）。查到的点和线由二狗取，你不用抄坐标" }),
    ),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CARD_TITLE_MAX, description: "卡片标题（\"今天去过的地方\"）；不写按内容起" })),
    replace: Type.Optional(
      Type.Boolean({
        description: "用户说\"换成……\"\"只看……\"\"别的不要了\"时填 true：地图上你之前画的清掉，只留这一次的。不填是叠加：加在之前画的上面（\"再把公司标上\"）",
      }),
    ),
  },
  { additionalProperties: false },
);

const DESCRIPTION =
  "把一样东西画成聊天里的一张地图卡片（缩略地图，用户点开进地图页看大的）。一次画一样，四选一：" +
  "date（某一天的足迹：用户说\"把我今天去过的地方画在地图上\"\"昨天去了哪\"）；" +
  "lookup（查地点、算路线之后，把那次的结果画出来：用编号，不用抄坐标）；" +
  "points（一组你确定坐标的点）；route（一条你给出的路线）。" +
  "卡片会直接出现在聊天里：回复时先用一句话说结论（去了几个地方、是哪几处；路线多久），不要描述地图、不念坐标。" +
  "用户不在地图页上说的（消息后面没带地图上看的是哪里）：画完说一句标好了、点卡片能在大地图上看，不会自己跳过去。" +
  "用户在地图页上说的（消息后面带着他地图上看的是哪里）：画出来会直接出现在他正看着的地图上，不用叫他去点卡片；" +
  "连着画的几次叠在一起，用户要换掉之前画的时填 replace。";

/** 一处叫什么：起的名字 > 系统地名 > 几点到的 */
const spotName = (stay: MapDayView["stays"][number]) => stay.name ?? stay.address ?? `没起名的一处（${clockLabel(stay.from)} 到）`;

/** 足迹的工具结果：按先后的几处（名字、几点到几点）、照片张数、怎么回复 */
function dayText(date: string, view: MapDayView): string {
  const order: string[] = [];
  const bySpot = new Map<string, MapDayView["stays"]>();
  for (const stay of view.stays.toSorted((a, b) => a.from.localeCompare(b.from))) {
    if (!bySpot.has(stay.spot)) {
      bySpot.set(stay.spot, []);
      order.push(stay.spot);
    }
    bySpot.get(stay.spot)!.push(stay);
  }
  const spots = order.map((key) => {
    const stays = bySpot.get(key)!;
    const name = stays.map((s) => s.name ?? s.address).find((n) => n !== undefined) ?? spotName(stays[0]!);
    return `${name}（${stays.map((s) => `${clockLabel(s.from)}–${clockLabel(s.to)}`).join("，")}）`;
  });
  const lines = [`已在聊天里放了一张地图卡片：${date} 的足迹（用户点开能看大地图，轨迹、停留、照片地点都在上面）。`];
  if (spots.length > 0) lines.push(`这一天待过 ${spots.length} 个地方（按先到的先后）：${spots.join("、")}。`);
  else lines.push("这一天没有待够 15 分钟的地方，只有路上的点。");
  const photos = view.photos.length + view.unlocatedPhotos;
  if (photos > 0) lines.push(`拍了 ${photos} 张照片${view.unlocatedPhotos > 0 ? `（${view.unlocatedPhotos} 张没有地点）` : ""}。`);
  lines.push("回复时先用一句话说结论（比如\"去了 3 个地方：公司、西湖边、家\"），卡片已经在聊天里了：不用描述地图、不念坐标，用户问了再说几点到几点。");
  return lines.join("\n");
}

/** 一组点、一条路线上标的点：编号按先后，名字截到上限 */
const marksOf = (points: readonly { lat: number; lon: number; label?: string | undefined }[], prefix: string): MapCardMark[] =>
  points.map((p, i) => ({ id: `${prefix}${i + 1}`, lat: p.lat, lon: p.lon, ...(p.label === undefined ? {} : { label: p.label.slice(0, MAP_CARD_LABEL_MAX) }) }));

/** 标题：给了才写 */
const titled = (title: string | undefined) => (title === undefined ? {} : { title });

export function showOnMapTool(deps: ShowOnMapDeps): HostTool {
  return defineHostTool({
    name: SHOW_ON_MAP_TOOL,
    title: t("map.tool.show"),
    description: DESCRIPTION,
    parameters: Params,
    // 每调一次多一张卡（重做会多一张）
    readOnlyOrIdempotent: false,
    // 只看：不改任何东西、不往外送
    nature: "look",
    run(args) {
      // 替掉地图上二狗之前画的（461）：填了 true 才写进卡片，不填是叠加
      const give = (payload: MapCardPayload, text: string): HostToolOutput => {
        const card = deps.cards.create({ type: "map", status: "handled", payload: args.replace === true ? { ...payload, replace: true } : payload });
        return { text, cardIds: [card.id] };
      };
      const given = [args.date, args.points, args.route, args.lookup].filter((x) => x !== undefined).length;
      if (given !== 1) return { text: "date、points、route、lookup 四样里给一样（一次画一样；要画几样就调几次）。", isError: true };

      if (args.date !== undefined) {
        const problem = mapDateProblem(args.date);
        if (problem !== undefined) return { text: problem, isError: true };
        let view: MapDayView;
        try {
          view = deps.day(args.date);
        } catch (err) {
          if (err instanceof RequestRejected) return { text: `取不到 ${args.date} 的足迹：${err.message}`, isError: true };
          throw err;
        }
        if (view.points.length === 0 && view.stays.length === 0 && view.photos.length === 0) {
          const latest = view.days.find((d) => d < args.date!);
          const why = view.linked.location ? "手机没交来这一天的位置" : "手机上的二狗 App 没开「记位置」";
          return { text: `${args.date} 没有足迹（${why}），没出卡片。${latest ? `最近有足迹的是 ${latest}，可以问用户要不要看那天。` : "以前也没有记下的足迹。"}` };
        }
        return give({ ...titled(args.title), show: { kind: "day", date: args.date } }, dayText(args.date, view));
      }

      if (args.points !== undefined) {
        const payload: MapCardPayload = { ...titled(args.title), show: { kind: "points", marks: marksOf(args.points, "p") } };
        return give(payload, `已在聊天里放了一张地图卡片「${mapCardTitle(payload)}」，标了 ${args.points.length} 个点。卡片已经在聊天里了：回复不用再念坐标。`);
      }

      if (args.route !== undefined) {
        const route = args.route;
        const last = route.length - 1;
        // 起点、终点总标出来（没写名字的写"起点""终点"），途经的写了名字才标
        const marked = route.flatMap((p, i) => (i === 0 || i === last ? [{ ...p, label: p.label ?? (i === 0 ? t("map.card.start") : t("map.card.end")) }] : p.label === undefined ? [] : [p]));
        const payload: MapCardPayload = { ...titled(args.title), show: { kind: "route", points: route.map((p) => ({ lat: p.lat, lon: p.lon })), marks: marksOf(marked, "r").slice(0, MAP_CARD_MARKS_MAX) } };
        return give(payload, `已在聊天里放了一张地图卡片「${mapCardTitle(payload)}」：一条 ${route.length} 个点的路线。卡片已经在聊天里了：回复不用再念坐标。`);
      }

      const id = args.lookup!.trim();
      const drawing = deps.lookups()?.get(id);
      if (!drawing) return { text: `没有编号是 ${id} 的查询结果：查地点、算路线的结果只在这台电脑上留一会儿（不存，二狗重启过也没了），编号要照抄那次工具结果末尾写的。再查一次，用新的编号画。`, isError: true };
      // 卡上只存编号、种类、哪家查的和标题（查的时候起的"从家到公司"）：点和线不存
      const title = (args.title ?? drawing.title).slice(0, MAP_CARD_TITLE_MAX);
      const payload: MapCardPayload = { ...titled(title || undefined), show: { kind: "lookup", lookup: drawing.id, what: drawing.kind, source: drawing.source } };
      const what = [drawing.marks.length > 0 ? `${drawing.marks.length} 个点` : "", drawing.lines.length > 0 ? `${drawing.lines.length} 条路线` : ""].filter(Boolean).join("、");
      return give(payload, `已在聊天里放了一张地图卡片「${mapCardTitle(payload)}」（${what || "没有能画的点"}；卡上写着数据来自哪家）。卡片已经在聊天里了：回复先说结论（多久、哪几家），不用描述地图、不念坐标。`);
    },
  });
}
