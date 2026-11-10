// 二狗在地图上画的直接出现在地图上（461，plugins/map/drawn.ts）在 Node 里能测的那一半：回放秘书会话频道、卡片频道上的事件
// （手写的，照守护进程 show_on_map 出卡的形状：卡片频道一张 map 卡、会话里一条 agent 消息引用它）——
// - 只认地图页打开（补发推完）以后新出的：打开前的旧卡不画；since 还没定一张都不认；卡片状态还没到手的先不认，到了再认；不是地图卡片的不认；
// - 叠加：新的加在后面；replace 的替掉之前画的；足迹卡清掉二狗画的、交出要看的那一天（同一批后面的照样叠）；最多叠 DRAWN_MAX 张；
// - 认过的不认第二次；点开一张只看它（之后新画的叠在它上面）；"×"一次清掉；
// - 画成地图上的东西：只有一张时编号照旧，几张时每张前面加序号；高德、谷歌查来的用最新那张的那一家，别家查来的这一屏画不上（数出来）；
//   还在取、取不到的不画；
// - 视野（drawnFit）：看全叠着的全部；全部看全要比只看最新那张缩小 DRAWN_FIT_ZOOM_GAP 级以上（杭州和新加坡）时只看全最新那张。
import { describe, expect, test } from "vitest";
import { type MapCardData, shownContent } from "../../src/plugins/map/card-scene.ts";
import { arrivedMapCards, clearDrawn, DRAWN_FIT_REF_ZOOM, DRAWN_FIT_ZOOM_GAP, DRAWN_MAX, type DrawnItem, drawnFit, drawnKey, drawnLayers, drawnSince, type MapDrawn, NO_DRAWN, openDrawn, takeArrived } from "../../src/plugins/map/drawn.ts";
import { viewToFit } from "../../src/plugins/map/scene.ts";
import { type EventFrame, type MapCardPayload, replay, type UiInput } from "../../src/state/index.ts";
import { card, frame, textMessage } from "../state/events.ts";

const S = "secretary";
const points = (title: string, n = 2, extra: Partial<MapCardPayload> = {}): MapCardPayload => ({
  title,
  show: { kind: "points", marks: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, lat: 30.25 + i * 0.01, lon: 120.14 + i * 0.01, label: `${title}${i + 1}` })) },
  ...extra,
});
/** show_on_map 出的一张：卡片频道上的卡、会话里引用它的那条 agent 消息 */
const drawnCard = (seq: number, id: string, payload: MapCardPayload): EventFrame[] => [
  frame("cards", seq, "card", { card: card(id, 1, { type: "map", status: "handled", payload }) }),
  frame(S, seq, "message", { message: { id: `m-${id}`, conversation: S, speaker: "agent", time: "2026-11-10T10:00:00+08:00", parts: [{ type: "card_ref", cardId: id }] } }),
];
const say = (seq: number, id: string, text: string) => frame(S, seq, "message", { message: textMessage(id, "user", text) });

/** 一路回放、一路照地图页那样认新到的：交回每一步之后的那一叠和要看的那一天 */
function walk(steps: readonly (readonly (EventFrame | UiInput)[])[], start: MapDrawn = NO_DRAWN): { drawn: MapDrawn; days: string[] } {
  let drawn = start;
  const days: string[] = [];
  const events: (EventFrame | UiInput)[] = [];
  for (const step of steps) {
    events.push(...step);
    const ui = replay(events);
    if (drawn.since === undefined) {
      drawn = drawnSince(drawn, ui.cursors[S] ?? 0);
      continue;
    }
    const next = takeArrived(drawn, arrivedMapCards(ui, drawn));
    drawn = next.drawn;
    if (next.day !== undefined) days.push(next.day);
  }
  return { drawn, days };
}

const ids = (drawn: MapDrawn) => drawn.items.map(drawnKey);

describe("只认地图页打开以后新出的地图卡片", () => {
  test("打开前的旧卡不画；打开以后的画上去；同一张不认第二次", () => {
    const before = [say(1, "u-1", "画一下西湖"), ...drawnCard(2, "c-old", points("旧的"))];
    const { drawn } = walk([before, [say(3, "u-2", "把咖啡馆标出来"), ...drawnCard(4, "c-new", points("咖啡馆"))], [say(5, "u-3", "谢谢")]]);
    expect(drawn.since).toBe(2);
    expect(ids(drawn)).toEqual(["card:c-new"]);
    expect(drawn.seen).toEqual(["c-new"]);
  });

  test("since 还没定时一张都不认；卡片状态还没到手的先不认，到了再认；不是地图卡片的不认", () => {
    const ui = replay([...drawnCard(1, "c-1", points("一"))]);
    expect(arrivedMapCards(ui, NO_DRAWN)).toEqual([]);
    const since: MapDrawn = { ...NO_DRAWN, since: 0 };
    // 会话里的引用先到、卡片还没到
    const refOnly = replay([frame(S, 1, "message", { message: { id: "m-1", conversation: S, speaker: "agent", time: "2026-11-10T10:00:00+08:00", parts: [{ type: "card_ref", cardId: "c-1" }] } })]);
    expect(arrivedMapCards(refOnly, since)).toEqual([]);
    expect(arrivedMapCards(replay([...drawnCard(1, "c-1", points("一"))]), since).map((a) => a.cardId)).toEqual(["c-1"]);
    // 别的卡（提醒、快速动作）不认
    const other = replay([frame("cards", 1, "card", { card: card("c-q", 1) }), frame(S, 1, "message", { message: { id: "m-q", conversation: S, speaker: "agent", time: "2026-11-10T10:00:00+08:00", parts: [{ type: "card_ref", cardId: "c-q" }] } })]);
    expect(arrivedMapCards(other, since)).toEqual([]);
  });
});

describe("连着画几次：叠在一起", () => {
  test("新的加在后面不冲掉前面的；replace 的替掉之前画的；同一批里也按先后", () => {
    const { drawn } = walk([
      [say(1, "u-0", "你好")],
      [...drawnCard(2, "c-1", points("咖啡馆"))],
      [...drawnCard(3, "c-2", points("地铁站"))],
      [...drawnCard(4, "c-3", points("公司"))],
    ]);
    expect(ids(drawn)).toEqual(["card:c-1", "card:c-2", "card:c-3"]);
    const replaced = takeArrived(drawn, [{ cardId: "c-4", seq: 5, payload: points("只看公园", 1, { replace: true }) }, { cardId: "c-5", seq: 6, payload: points("再加一个") }]);
    expect(ids(replaced.drawn)).toEqual(["card:c-4", "card:c-5"]);
    expect(replaced.last?.cardId).toBe("c-5");
  });

  test("足迹卡：清掉二狗画的、交出要看的那一天；同一批里它后面的点照样叠上去", () => {
    const start: MapDrawn = { since: 0, seen: ["c-1"], items: [{ kind: "card", cardId: "c-1" }] };
    const day = takeArrived(start, [{ cardId: "c-d", seq: 3, payload: { show: { kind: "day", date: "2026-11-09" } } }]);
    expect(day.day).toBe("2026-11-09");
    expect(day.drawn.items).toEqual([]);
    expect(day.drawn.seen).toEqual(["c-1", "c-d"]);
    const then = takeArrived(start, [
      { cardId: "c-d", seq: 3, payload: { show: { kind: "day", date: "2026-11-09" } } },
      { cardId: "c-2", seq: 4, payload: points("公司", 1) },
    ]);
    expect(then.day).toBe("2026-11-09");
    expect(ids(then.drawn)).toEqual(["card:c-2"]);
  });

  test(`最多叠 ${DRAWN_MAX} 张，多了挤掉最早的；没有新的原样交回`, () => {
    let drawn: MapDrawn = { ...NO_DRAWN, since: 0 };
    for (let i = 1; i <= DRAWN_MAX + 2; i++) drawn = takeArrived(drawn, [{ cardId: `c-${i}`, seq: i, payload: points(`第${i}`) }]).drawn;
    expect(drawn.items).toHaveLength(DRAWN_MAX);
    expect(drawnKey(drawn.items[0]!)).toBe("card:c-3");
    const same = takeArrived(drawn, []);
    expect(same.drawn).toBe(drawn);
    expect(same.last).toBeUndefined();
  });

  test("点开一张只看它（记成认过的），之后新画的叠在它上面；\"×\"一次清掉", () => {
    const opened = openDrawn({ since: 4, seen: ["c-1"], items: [{ kind: "card", cardId: "c-1" }, { kind: "card", cardId: "c-2" }] }, { kind: "card", cardId: "c-old" });
    expect(ids(opened)).toEqual(["card:c-old"]);
    expect(opened.seen).toEqual(["c-1", "c-old"]);
    const more = takeArrived(opened, [{ cardId: "c-3", seq: 5, payload: points("公司", 1) }]).drawn;
    expect(ids(more)).toEqual(["card:c-old", "card:c-3"]);
    const cleared = clearDrawn(more);
    expect(cleared.items).toEqual([]);
    expect(cleared.seen).toEqual(["c-1", "c-old", "c-3"]);
    expect(cleared.since).toBe(4);
    // 查到的一处（447）也能点开，编号按查到的编号
    const lookup: DrawnItem = { kind: "lookup", show: { kind: "lookup", lookup: "amap-p1", what: "places", source: "amap" } };
    expect(drawnKey(lookup)).toBe("lookup:amap-p1");
    expect(openDrawn(NO_DRAWN, lookup).seen).toEqual([]);
  });
});

/** 取到了的一张（own：只能画在哪家地图上） */
const ready = (payload: MapCardPayload, own?: string): MapCardData => {
  const content = shownContent(payload.show as Extract<MapCardPayload["show"], { kind: "points" }>);
  return { state: "ready", content: own === undefined ? content : { ...content, ownBasemap: own } };
};
const item = (id: string): DrawnItem => ({ kind: "card", cardId: id });

describe("叠着的几张画成地图上的东西", () => {

  test("只有一张：编号照旧（和点开卡片一样）；几张：每张前面加序号，不撞", () => {
    const one = drawnLayers([{ item: item("c-1"), data: ready(points("咖啡馆")) }]);
    expect(one.scene.marks.map((m) => m.id)).toEqual(["card-p1", "card-p2"]);
    expect(one.own).toBeUndefined();
    const two = drawnLayers([
      { item: item("c-1"), data: ready(points("咖啡馆")) },
      { item: item("c-2"), data: ready(points("地铁站", 1)) },
    ]);
    expect(two.scene.marks.map((m) => [m.id, m.label])).toEqual([
      ["card-1-p1", "咖啡馆1"],
      ["card-1-p2", "咖啡馆2"],
      ["card-2-p1", "地铁站1"],
    ]);
  });

  test("高德、谷歌查来的：用最新那张的那一家（同一家的几张都画），别家查来的这一屏画不上；还在取、取不到的不画", () => {
    const layers = drawnLayers([
      { item: item("c-a1"), data: ready(points("高德一", 1), "amap") },
      { item: item("c-p"), data: ready(points("点", 1)) },
      { item: item("c-g"), data: ready(points("谷歌", 1), "google") },
      { item: item("c-a2"), data: ready(points("高德二", 1), "amap") },
      { item: item("c-wait"), data: { state: "loading" } },
      { item: item("c-gone"), data: { state: "failed", text: "过期了" } },
      { item: item("c-none"), data: undefined },
    ]);
    expect(layers.scene.marks.map((m) => m.label)).toEqual(["点1"]);
    expect(layers.own?.source).toBe("amap");
    expect(layers.own?.scene.marks.map((m) => m.label)).toEqual(["高德一1", "高德二1"]);
    expect(layers.ownItem).toEqual(item("c-a2"));
    expect(layers.hidden).toBe(1);
    // 挪视野看全的：画得上的那几张（谷歌那张画不上、还在取的不算）
    expect(layers.bounds).toHaveLength(3);
  });
});

/** 一组点（纬度、经度） */
const at = (...ps: [number, number][]) => ps.map(([lat, lon]) => ({ lat, lon }));

describe("新画了一张以后看哪里", () => {
  const W = 360;
  const H = 600;
  const inside = (v: { lat: number; lon: number; zoom: number }, p: { lat: number; lon: number }) => {
    // 墨卡托下 p 离中心多少像素，要在地图那一块里
    const scale = 256 * 2 ** v.zoom;
    const x = ((p.lon - v.lon) / 360) * scale;
    const y = (Math.log(Math.tan(Math.PI / 4 + (v.lat * Math.PI) / 360)) - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360))) * (scale / (2 * Math.PI));
    return Math.abs(x) <= W / 2 && Math.abs(y) <= H / 2;
  };

  test("离得不远：看全叠着的全部（前面画的也在屏幕里）", () => {
    const coffee = at([30.256, 120.14], [30.252, 120.148], [30.249, 120.152]);
    const metro = at([30.262, 120.155], [30.26, 120.158]);
    const v = drawnFit([...coffee, ...metro], metro, W, H)!;
    expect(v).toEqual(viewToFit([...coffee, ...metro], W, H));
    for (const p of [...coffee, ...metro]) expect(inside(v, p)).toBe(true);
    // 只看全最新那张会把咖啡馆挤出去（所以要看全全部）；最新那两个点挨得近，看全它要放到 17 级，比的时候按 15 级算
    const only = viewToFit(metro, W, H)!;
    expect(coffee.some((p) => !inside(only, p))).toBe(true);
    expect(only.zoom).toBeGreaterThan(DRAWN_FIT_REF_ZOOM);
    expect(DRAWN_FIT_REF_ZOOM - v.zoom).toBeLessThan(DRAWN_FIT_ZOOM_GAP);
  });

  test(`杭州和新加坡：全部看全要缩小 ${DRAWN_FIT_ZOOM_GAP} 级以上，只看全最新那张`, () => {
    const hangzhou = at([30.256, 120.14], [30.252, 120.148]);
    const singapore = at([1.2834, 103.8607], [1.2805, 103.845]);
    const v = drawnFit([...hangzhou, ...singapore], singapore, W, H)!;
    expect(v).toEqual(viewToFit(singapore, W, H));
    for (const p of singapore) expect(inside(v, p)).toBe(true);
    expect(v.zoom - viewToFit([...hangzhou, ...singapore], W, H)!.zoom).toBeGreaterThanOrEqual(DRAWN_FIT_ZOOM_GAP);
  });

  test("差正好 3 级算太多；差不到 3 级照看全部；只有一张、全部是空的、都没有点", () => {
    const latest = at([30.25, 120.14], [30.26, 120.15]);
    const one = viewToFit(latest, W, H)!;
    expect(one.zoom).toBeLessThanOrEqual(DRAWN_FIT_REF_ZOOM);
    // 找一个前面画的点：全部看全比只看最新那张小正好 3 级、小 2.5 级
    const farAt = (gap: number) => {
      for (let d = 0.001; d < 5; d += 0.001) {
        const all = viewToFit([...latest, { lat: 30.25, lon: 120.14 + d }], W, H)!;
        if (one.zoom - all.zoom >= gap) return { lat: 30.25, lon: 120.14 + d };
      }
      throw new Error("找不到");
    };
    expect(drawnFit([...latest, farAt(3)], latest, W, H)).toEqual(one);
    const near = farAt(2.5);
    expect(drawnFit([...latest, near], latest, W, H)).toEqual(viewToFit([...latest, near], W, H));
    expect(drawnFit(latest, latest, W, H)).toEqual(one);
    expect(drawnFit([], latest, W, H)).toEqual(one);
    expect(drawnFit(at([30.25, 120.14]), [], W, H)).toEqual(viewToFit(at([30.25, 120.14]), W, H));
    expect(drawnFit([], [], W, H)).toBeUndefined();
  });
});
