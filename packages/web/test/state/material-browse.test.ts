// 167 号票：记忆 · 素材按时间范围浏览、按日期分组、按关键词搜（标出命中的字）、按种类和会话筛。这些推导是纯函数，在状态层：
// 范围（今天、近 7 天、近 30 天、自定义、全部时间）怎么落成本地日期、往前往后翻一段、写成什么字、交给守护进程的起止时间；
// 列表按日期分组（今天、昨天、10 月 17 日 周六……）；命中的字怎么切出来；筛选怎么拼成接口的 filter；会话下拉框列哪些。
// 时间都按本地时间造（new Date(年, 月, 日, …)），换了时区跑也一样。
import { describe, expect, test } from "vitest";
import {
  CHANNELS,
  customMaterialRange,
  highlightParts,
  type MaterialRange,
  materialClock,
  materialConversationChoices,
  materialDayGroups,
  materialDayLabel,
  materialListFilter,
  materialRangeBounds,
  materialRangeLabel,
  materialRangePreset,
  nowIso,
  presetMaterialRange,
  shiftMaterialRange,
  canShiftMaterialRangeLater,
} from "../../src/state/index.ts";

/** 2026-10-19（周一）上午十点 */
const NOW = new Date(2026, 9, 19, 10, 0);
const iso = (month: number, day: number, h = 12, m = 0) => nowIso(new Date(2026, month - 1, day, h, m));

describe("时间范围", () => {
  test("快捷选项：今天、近 7 天（含今天）、近 30 天，落成本地日期", () => {
    expect(presetMaterialRange("today", NOW)).toEqual({ kind: "today", from: "2026-10-19", to: "2026-10-19" });
    expect(presetMaterialRange("7d", NOW)).toEqual({ kind: "7d", from: "2026-10-13", to: "2026-10-19" });
    expect(presetMaterialRange("30d", NOW)).toEqual({ kind: "30d", from: "2026-09-20", to: "2026-10-19" });
  });

  test("自定义：起止日期两头都算；起点晚于终点、写法不对的不算", () => {
    expect(customMaterialRange("2026-10-01", "2026-10-05")).toEqual({ kind: "custom", from: "2026-10-01", to: "2026-10-05" });
    expect(customMaterialRange("2026-10-05", "2026-10-05")).toEqual({ kind: "custom", from: "2026-10-05", to: "2026-10-05" });
    expect(customMaterialRange("2026-10-06", "2026-10-05")).toBeUndefined();
    expect(customMaterialRange("", "2026-10-05")).toBeUndefined();
    expect(customMaterialRange("2026-02-30", "2026-03-01")).toBeUndefined();
  });

  test("往前一段、往后一段：按这一段的天数翻（跨月也对），种类不变；最晚翻到今天", () => {
    const week = presetMaterialRange("7d", NOW);
    expect(shiftMaterialRange(week, -1)).toEqual({ kind: "7d", from: "2026-10-06", to: "2026-10-12" });
    expect(shiftMaterialRange(shiftMaterialRange(week, -1), 1)).toEqual(week);
    expect(shiftMaterialRange(presetMaterialRange("today", NOW), -1)).toEqual({ kind: "today", from: "2026-10-18", to: "2026-10-18" });
    expect(shiftMaterialRange(presetMaterialRange("30d", NOW), -1)).toEqual({ kind: "30d", from: "2026-08-21", to: "2026-09-19" });
    expect(shiftMaterialRange(customMaterialRange("2026-10-01", "2026-10-03")!, -1)).toEqual({ kind: "custom", from: "2026-09-28", to: "2026-09-30" });
    expect(shiftMaterialRange({ kind: "all" }, -1)).toEqual({ kind: "all" });
    // 往后：到今天为止
    expect(canShiftMaterialRangeLater(week, NOW)).toBe(false);
    expect(canShiftMaterialRangeLater(shiftMaterialRange(week, -1), NOW)).toBe(true);
    expect(canShiftMaterialRangeLater({ kind: "all" }, NOW)).toBe(false);
  });

  test("哪个快捷选项亮着：是今天的那一段才亮；翻过的不亮；自定义一直亮", () => {
    expect(materialRangePreset(presetMaterialRange("7d", NOW), NOW)).toBe("7d");
    expect(materialRangePreset(shiftMaterialRange(presetMaterialRange("7d", NOW), -1), NOW)).toBeUndefined();
    expect(materialRangePreset(customMaterialRange("2026-10-01", "2026-10-03")!, NOW)).toBe("custom");
    expect(materialRangePreset({ kind: "all" }, NOW)).toBeUndefined();
  });

  test("写成什么字：今天、昨天；一段写起止日期（同一个月后一头只写日，不是今年的带年份，跨年两头都带）；全部时间", () => {
    expect(materialRangeLabel(presetMaterialRange("today", NOW), NOW)).toBe("今天");
    expect(materialRangeLabel(shiftMaterialRange(presetMaterialRange("today", NOW), -1), NOW)).toBe("昨天");
    expect(materialRangeLabel(shiftMaterialRange(shiftMaterialRange(presetMaterialRange("today", NOW), -1), -1), NOW)).toBe("10 月 17 日 周六");
    expect(materialRangeLabel(presetMaterialRange("7d", NOW), NOW)).toBe("10 月 13 日 – 19 日");
    expect(materialRangeLabel(shiftMaterialRange(presetMaterialRange("7d", NOW), -1), NOW)).toBe("10 月 6 日 – 12 日");
    expect(materialRangeLabel(presetMaterialRange("30d", NOW), NOW)).toBe("9 月 20 日 – 10 月 19 日");
    expect(materialRangeLabel(customMaterialRange("2025-03-01", "2025-03-07")!, NOW)).toBe("2025 年 3 月 1 日 – 7 日");
    expect(materialRangeLabel(customMaterialRange("2025-12-28", "2026-01-03")!, NOW)).toBe("2025 年 12 月 28 日 – 2026 年 1 月 3 日");
    expect(materialRangeLabel({ kind: "all" }, NOW)).toBe("全部时间");
  });

  test("交给守护进程的起止时间：从头一天的零点到最后一天的最后一刻（本地时间，带时区）；全部时间不给", () => {
    const bounds = materialRangeBounds(presetMaterialRange("7d", NOW));
    expect(bounds).toEqual({ from: nowIso(new Date(2026, 9, 13, 0, 0, 0, 0)), to: nowIso(new Date(2026, 9, 19, 23, 59, 59, 999)) });
    expect(materialRangeBounds({ kind: "all" })).toEqual({});
  });
});

describe("按日期分组", () => {
  test("新的在前，同一天的一组；今天、昨天，别的写几月几日和周几，不是今年的带年份", () => {
    const items = [
      { id: "a", time: iso(10, 19, 9, 30) },
      { id: "b", time: iso(10, 19, 0, 5) },
      { id: "c", time: iso(10, 18, 23, 59) },
      { id: "d", time: iso(10, 17, 8) },
      { id: "e", time: nowIso(new Date(2025, 11, 31, 20)) },
    ];
    expect(materialDayGroups(items, NOW).map((g) => [g.date, g.label, g.items.map((i) => i.id)])).toEqual([
      ["2026-10-19", "今天", ["a", "b"]],
      ["2026-10-18", "昨天", ["c"]],
      ["2026-10-17", "10 月 17 日 周六", ["d"]],
      ["2025-12-31", "2025 年 12 月 31 日 周三", ["e"]],
    ]);
    expect(materialDayGroups([], NOW)).toEqual([]);
  });

  test("组里一行只写几点几分（本地时间）", () => {
    expect(materialClock(iso(10, 19, 9, 5))).toBe("09:05");
    expect(materialClock("不是时间")).toBe("不是时间");
  });

  test("一天的说法", () => {
    expect(materialDayLabel("2026-10-19", NOW)).toBe("今天");
    expect(materialDayLabel("2026-10-18", NOW)).toBe("昨天");
    expect(materialDayLabel("2026-10-01", NOW)).toBe("10 月 1 日 周四");
  });
});

describe("标出命中的字", () => {
  test("几个词都标出来，不分大小写，挨着的、叠着的合成一段；没有关键词时整段不标", () => {
    expect(highlightParts("周末想去杭州爬山", "杭州")).toEqual([
      { text: "周末想去", hit: false },
      { text: "杭州", hit: true },
      { text: "爬山", hit: false },
    ]);
    expect(highlightParts("Open AI 和 openai", "openai")).toEqual([
      { text: "Open AI 和 ", hit: false },
      { text: "openai", hit: true },
    ]);
    expect(highlightParts("杭州西湖杭州", "杭州 西湖")).toEqual([{ text: "杭州西湖杭州", hit: true }]);
    expect(highlightParts("abcabc", "bca ab")).toEqual([
      { text: "abcab", hit: true },
      { text: "c", hit: false },
    ]);
    expect(highlightParts("没有命中", "杭州")).toEqual([{ text: "没有命中", hit: false }]);
    expect(highlightParts("整段", "  ")).toEqual([{ text: "整段", hit: false }]);
    expect(highlightParts("", "杭州")).toEqual([]);
  });
});

describe("拼成接口的筛选", () => {
  const week: MaterialRange = presetMaterialRange("7d", NOW);
  test("范围、关键词、种类、会话都可以不给；关键词去掉两头的空白", () => {
    expect(materialListFilter({ range: week, query: "", facets: [] })).toEqual(materialRangeBounds(week));
    expect(materialListFilter({ range: { kind: "all" }, query: "  杭州 爬山 ", facets: ["said", "voice"], conversation: CHANNELS.secretary })).toEqual({
      query: "杭州 爬山",
      facets: ["said", "voice"],
      conversation: CHANNELS.secretary,
    });
    expect(materialListFilter({ range: week, query: "杭州", facets: ["web_page"] })).toEqual({ ...materialRangeBounds(week), query: "杭州", facets: ["web_page"] });
  });
});

describe("会话下拉框", () => {
  test("秘书主线排第一（没有素材也列，写 0 条），别的按条数多的在前", () => {
    expect(
      materialConversationChoices([
        { conversation: "maintainer:tm-1", count: 3 },
        { conversation: CHANNELS.secretary, count: 40 },
        { conversation: "maintainer:pm-1", count: 9 },
      ]),
    ).toEqual([
      { conversation: CHANNELS.secretary, count: 40 },
      { conversation: "maintainer:pm-1", count: 9 },
      { conversation: "maintainer:tm-1", count: 3 },
    ]);
    expect(materialConversationChoices([{ conversation: "maintainer:tm-1", count: 1 }])).toEqual([
      { conversation: CHANNELS.secretary, count: 0 },
      { conversation: "maintainer:tm-1", count: 1 },
    ]);
  });
});
