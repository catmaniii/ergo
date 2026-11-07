// 秘书的"画在地图上"（show_on_map，431）和地图卡片这种卡（card.ts）、按编号取查到的那一份（drawing.ts）：工具本身，依赖都是假的
// （某一天的足迹是编的、卡片只记下建了什么、查地点和路线留下的那几份是手写的），不起守护进程、不联网：
// - date：建一张只存日期的卡，结果里按先后列出待过的几处和照片张数、叫秘书先说结论，不给坐标；这一天什么都没有不出卡、说最近有足迹的一天；
//   日期写法不对、手机插件没启用回错；
// - points / route：点和路线存在卡上，路线的起点终点标出来；
// - lookup：卡上只存编号、种类、哪家查的和标题（不存点和线）；取不到回错、不出卡；
// - 四样里给了不止一样、参数不对：回错、不出卡；守卫登记：只看、不落任何关注类别；
// - 卡片：负载合 schema、纯文本降级、彻底删除时标题和点旁边的字换成删除标记；GET /api/map/drawing 的那一份过期了回 404。
import { type Card, type MapCardPayload, MapCardPayload as MapCardSchema, type MapDayView, type MapDrawing, PURGED_TEXT, schemaChecker } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { NewCard } from "../../src/cards/cards.ts";
import { mapCardText, mapCardType, purgedMapCard } from "../../src/map/card.ts";
import { createMapDrawings } from "../../src/map/drawing.ts";
import { type MapLookups, SHOW_ON_MAP_TOOL, showOnMapTool } from "../../src/map/show-on-map.ts";
import { RequestRejected } from "../../src/errors.ts";

const payloadOk = schemaChecker(MapCardSchema);

/** 编的一天（本地时间写的协议时间）：家两段、公司一段（只有系统地名）、路上的点、两张照片（一张没有地点） */
function day(date = "2026-11-06"): MapDayView {
  const t = (hm: string) => `${date}T${hm}:00.000+08:00`;
  const stay = (id: string, spot: string, from: string, to: string, extra: Partial<MapDayView["stays"][number]>) => ({ id, spot, from: t(from), to: t(to), minutes: 60, lat: 30.28, lon: 120.1, points: 6, ...extra });
  return {
    date,
    points: [
      { at: t("08:00"), lat: 30.28, lon: 120.1 },
      { at: t("09:30"), lat: 30.27, lon: 120.15 },
    ],
    stays: [
      stay("s1", "place-home", "07:00", "08:15", { placeId: "place-home", name: "家" }),
      stay("s2", "spot-1", "08:50", "17:30", { address: "杭州市西湖区天目山路" }),
      stay("s3", "place-home", "19:00", "22:00", { placeId: "place-home", name: "家" }),
    ],
    photos: [{ id: "p1", at: t("12:10"), lat: 30.27, lon: 120.15 }],
    unlocatedPhotos: 1,
    places: [{ id: "place-home", name: "家", lat: 30.28, lon: 120.1, radius: 200 }],
    days: [date, "2026-11-01"],
    linked: { location: true, photos: true },
  };
}

const EMPTY: MapDayView = { date: "2026-11-05", points: [], stays: [], photos: [], unlocatedPhotos: 0, places: [], days: ["2026-11-06", "2026-11-01"], linked: { location: true, photos: true } };

const ROUTE: MapDrawing = {
  id: "amap-r1",
  kind: "route",
  source: "amap",
  title: "从家到公司",
  at: "2026-11-07T08:52:00.000+08:00",
  marks: [
    { id: "from", lat: 30.2775, lon: 120.1255, label: "家", kind: "place" },
    { id: "to", lat: 30.2525, lon: 120.2055, label: "公司", kind: "place" },
  ],
  lines: [{ id: "driving", kind: "route", mode: "driving", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.26, lon: 120.17 }, { lat: 30.2525, lon: 120.2055 }] }],
};

function setup(options: { day?: (date: string) => MapDayView; lookups?: MapLookups } = {}) {
  const made: NewCard[] = [];
  let n = 0;
  const tool = showOnMapTool({
    day: options.day ?? (() => day()),
    lookups: () => options.lookups,
    cards: {
      create: (input) => {
        made.push(input);
        n += 1;
        return { id: `c-${n}`, type: input.type, typeVersion: 1, version: 1, status: input.status ?? "pending", payload: input.payload, text: "", createdAt: "2026-11-07T09:00:00.000+08:00" } as Card;
      },
    },
  });
  const run = async (args: Record<string, unknown>) => await tool.run(args as never, { toolCallId: "call-1" });
  return { tool, made, run };
}

describe("画在地图上（show_on_map）", () => {
  it("某一天的足迹：卡上只存日期、出来就是已处理；结果按先后列出待过的几处（同一处合在一起）和照片张数，叫秘书先说结论，不给坐标", async () => {
    const { made, run } = setup();
    const out = await run({ date: "2026-11-06" });
    expect(out.isError).toBeUndefined();
    expect(out.cardIds).toEqual(["c-1"]);
    expect(made).toEqual([{ type: "map", status: "handled", payload: { show: { kind: "day", date: "2026-11-06" } } }]);
    expect(payloadOk.check(made[0]!.payload)).toBe(true);
    expect(out.text).toContain("这一天待过 2 个地方（按先到的先后）：家（07:00–08:15，19:00–22:00）、杭州市西湖区天目山路（08:50–17:30）。");
    expect(out.text).toContain("拍了 2 张照片（1 张没有地点）。");
    expect(out.text).toContain("回复时先用一句话说结论");
    // 用户自己的坐标不进给模型的结果
    expect(out.text).not.toMatch(/30\.2|120\.1/);
  });

  it("秘书写了标题就用它", async () => {
    const { made, run } = setup();
    await run({ date: "2026-11-06", title: "昨天去过的地方" });
    expect(made[0]!.payload).toEqual({ title: "昨天去过的地方", show: { kind: "day", date: "2026-11-06" } });
  });

  it("这一天什么都没有：不出卡，说最近有足迹的是哪天；日期写法不对、手机插件没启用回错", async () => {
    const empty = setup({ day: () => EMPTY });
    const none = await empty.run({ date: "2026-11-05" });
    expect(none.cardIds).toBeUndefined();
    expect(empty.made).toEqual([]);
    expect(none.text).toContain("2026-11-05 没有足迹");
    expect(none.text).toContain("最近有足迹的是 2026-11-01");

    const bad = await setup().run({ date: "2026-13-01" });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/^日期要写成 YYYY-MM-DD/);

    const off = setup({
      day: () => {
        throw new RequestRejected("not_allowed", "数据源-手机插件没启用");
      },
    });
    const phoneOff = await off.run({ date: "2026-11-06" });
    expect(phoneOff).toMatchObject({ isError: true, text: "取不到 2026-11-06 的足迹：数据源-手机插件没启用" });
    expect(off.made).toEqual([]);
  });

  it("一组点、一条路线：存在卡上；路线的起点终点总标出来，途经的写了名字才标", async () => {
    const { made, run } = setup();
    const points = await run({ points: [{ lat: 30.25, lon: 120.14, label: "西湖" }, { lat: 30.24, lon: 120.1 }] });
    expect(points.text).toContain("标了 2 个点");
    expect(made[0]!.payload).toEqual({ show: { kind: "points", marks: [{ id: "p1", lat: 30.25, lon: 120.14, label: "西湖" }, { id: "p2", lat: 30.24, lon: 120.1 }] } });

    await run({ route: [{ lat: 30.27, lon: 120.15 }, { lat: 30.265, lon: 120.15 }, { lat: 30.262, lon: 120.148, label: "断桥" }, { lat: 30.26, lon: 120.145 }], title: "下班走过去" });
    expect(made[1]!.payload).toEqual({
      title: "下班走过去",
      show: {
        kind: "route",
        points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.265, lon: 120.15 }, { lat: 30.262, lon: 120.148 }, { lat: 30.26, lon: 120.145 }],
        marks: [
          { id: "r1", lat: 30.27, lon: 120.15, label: "起点" },
          { id: "r2", lat: 30.262, lon: 120.148, label: "断桥" },
          { id: "r3", lat: 30.26, lon: 120.145, label: "终点" },
        ],
      },
    });
    for (const m of made) expect(payloadOk.check(m.payload)).toBe(true);
  });

  it("查地点、算路线的结果：卡上只存编号、种类、哪家查的和标题，点和线不存；取不到回错、不出卡", async () => {
    const lookups: MapLookups = { get: (id) => (id === "amap-r1" ? ROUTE : undefined) };
    const { made, run } = setup({ lookups });
    const out = await run({ lookup: "amap-r1" });
    expect(out.cardIds).toEqual(["c-1"]);
    expect(made[0]).toEqual({ type: "map", status: "handled", payload: { title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } } });
    expect(JSON.stringify(made[0])).not.toMatch(/30\.2|120\.1|120\.2/);
    expect(out.text).toContain("「从家到公司」（2 个点、1 条路线");

    const gone = await run({ lookup: "amap-r9" });
    expect(gone).toMatchObject({ isError: true });
    expect(gone.text).toContain("没有编号是 amap-r9 的查询结果");
    expect(made).toHaveLength(1);
    // 取不到查地点、算路线的那几份（插件停着）：一样回错
    expect(await setup().run({ lookup: "amap-r1" })).toMatchObject({ isError: true });
  });

  it("四样里给了不止一样或一样都没给、参数不对：回错、不出卡", async () => {
    const { made, run } = setup();
    expect(await run({ date: "2026-11-06", points: [{ lat: 1, lon: 1 }] })).toMatchObject({ isError: true });
    expect(await run({ title: "什么都没画" })).toMatchObject({ isError: true });
    // 参数不合 schema（纬度超出范围）
    expect(await run({ points: [{ lat: 95, lon: 1 }] })).toMatchObject({ isError: true });
    expect(made).toEqual([]);
  });

  it("守卫登记：只看、不落任何关注类别；每调一次多一张卡，不算幂等", () => {
    const { tool } = setup();
    expect(tool.spec.name).toBe(SHOW_ON_MAP_TOOL);
    expect(tool.descriptor).toMatchObject({ title: "画在地图上", source: "host", categories: [], nature: "look", readOnlyOrIdempotent: false });
    expect(tool.spec.description).toContain("lookup");
  });
});

describe("地图卡片", () => {
  const route: MapCardPayload = { title: "下班走过去", show: { kind: "route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.145 }], marks: [{ id: "r1", lat: 30.27, lon: 120.15, label: "公司" }] } };

  it("没有动作；纯文本降级写标题（没写的按画的是什么起）", () => {
    const type = mapCardType();
    expect(type).toMatchObject({ type: "map", version: 1, actions: {} });
    expect(mapCardText(route)).toBe("地图卡片：下班走过去（点开看地图）");
    expect(mapCardText({ show: { kind: "day", date: "2026-11-06" } })).toBe("地图卡片：11 月 6 日去过的地方（点开看地图）");
    expect(mapCardText({ show: { kind: "lookup", lookup: "amap-p2", what: "places", source: "amap" } })).toBe("地图卡片：查到的地点（点开看地图）");
  });

  it("彻底删除：标题、点旁边的字换成删除标记，坐标、日期、编号照旧", () => {
    expect(purgedMapCard(route)).toEqual({ title: PURGED_TEXT, show: { ...route.show, marks: [{ id: "r1", lat: 30.27, lon: 120.15, label: PURGED_TEXT }] } });
    const lookup: MapCardPayload = { show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } };
    expect(purgedMapCard(lookup)).toEqual(lookup);
    expect(payloadOk.check(purgedMapCard(route))).toBe(true);
  });
});

describe("按编号取查到的那一份（GET /api/map/drawing）", () => {
  it("在内存里就交回；过期了、没有、没有查地点和路线时 404 说再问一次；没写编号 400", () => {
    const drawings = createMapDrawings(() => ({ get: (id) => (id === "amap-r1" ? ROUTE : undefined) }));
    expect(drawings.drawing(" amap-r1 ")).toBe(ROUTE);
    const gone = (() => {
      try {
        drawings.drawing("amap-r2");
      } catch (err) {
        return err;
      }
    })() as RequestRejected;
    expect(gone).toBeInstanceOf(RequestRejected);
    expect(gone.code).toBe("not_found");
    expect(gone.message).toContain("已经过期了");
    expect(() => createMapDrawings(() => undefined).drawing("amap-r1")).toThrow("已经过期了");
    expect(() => drawings.drawing("")).toThrow(RequestRejected);
  });
});
