// 消耗页和任务详情的用量（24 号票）：范围的快捷选项、范围里的每一天、agent 的叫法；消耗页单价那块（94 号票：自带价格表分时段）。录下的真实事件流回放在 recorded.test.ts 的 token-ledger。
import { describe, expect, test } from "vitest";
import {
  agentLabel,
  ASSISTANT_NAME_MARK,
  rangeDays,
  replay,
  taskUsage,
  usageAgentName,
  usagePriceRows,
  usagePricingNotes,
  type UsagePricing,
  usageRange,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

describe("消耗页的范围", () => {
  const now = new Date(2026, 9, 8, 15, 30);
  test.each([
    ["today", { from: "2026-10-08", to: "2026-10-08" }],
    ["7d", { from: "2026-10-02", to: "2026-10-08" }],
    ["30d", { from: "2026-09-09", to: "2026-10-08" }],
    ["month", { from: "2026-10-01", to: "2026-10-08" }],
  ] as const)("%s", (preset, expected) => {
    expect(usageRange(preset, now)).toEqual(expected);
  });

  test("范围里的每一天：含两头，跨月", () => {
    expect(rangeDays("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(rangeDays("2026-10-08", "2026-10-08")).toEqual(["2026-10-08"]);
  });
});

describe("agent 的叫法", () => {
  test("秘书写名字占位（界面按用户起的名字显示，43 号票），别的是角色加 id；消耗页上维护者写编号加它所在的项目或任务（159 号票）", () => {
    expect(agentLabel("secretary", "secretary")).toBe(ASSISTANT_NAME_MARK);
    expect(agentLabel("review-t-1-s2-1", "reviewer")).toBe("评审子 agent review-t-1-s2-1");
    const state = replay([
      frame("board", 1, "task", { task: { id: "t-1", title: "X 的调研", maintainerId: "tm-1" }, change: "created", from: null, by: "user" }),
      frame("projects", 1, "project", { project: { id: "p-1", name: "记账本", maintainerId: "pm-1" }, change: "created", from: null, by: "user" }),
      { kind: "synced" },
    ]);
    expect(usageAgentName(state, "tm-1", "maintainer")).toBe("tm-1「X 的调研的任务维护者」");
    expect(usageAgentName(state, "pm-1", "maintainer")).toBe("pm-1「记账本的项目维护者」");
    expect(usageAgentName(state, "tm-9", "maintainer")).toBe("tm-9（已删除）");
    expect(usageAgentName(state, "sa-1", "sub_agent")).toBe("子 agent sa-1");
  });

  test("未归属的 agent 在消耗页上就写 id", () => {
    expect(usageAgentName(replay([]), "stray-1", "unattributed")).toBe("stray-1");
  });

  test("任务详情里范围审视、压缩各单独一行，标出来", () => {
    const tokens = { cacheHit: 10, cacheMiss: 5, output: 1 };
    const state = replay([
      frame("board", 1, "task", { task: { id: "t-1", title: "X 的调研", maintainerId: "tm-1" }, change: "created", from: null, by: "user" }),
      frame("board", 2, "token_totals", {
        owner: { kind: "task", id: "t-1" },
        tokens: { cacheHit: 30, cacheMiss: 15, output: 3 },
        calls: 3,
        byAgent: [
          { agentId: "tm-1", role: "maintainer", purpose: "work", tokens, calls: 1 },
          { agentId: "tm-1", role: "maintainer", purpose: "scope_review", tokens, calls: 1 },
          { agentId: "tm-1", role: "maintainer", purpose: "compaction", tokens, calls: 1 },
        ],
        byStage: [],
        time: "2026-10-08T10:00:00.000+08:00",
      }),
    ]);
    expect(taskUsage(state, "t-1")).toEqual({
      rows: [
        expect.objectContaining({ label: "tm-1「X 的调研的任务维护者」", total: 16, purpose: "work" }),
        expect.objectContaining({ label: "tm-1「X 的调研的任务维护者」 · 范围审视", total: 16, purpose: "scope_review" }),
        expect.objectContaining({ label: "tm-1「X 的调研的任务维护者」 · 压缩", total: 16, purpose: "compaction" }),
      ],
      total: 48,
      // 311 号票：合计里缓存命中的（详情顶上写"（其中缓存命中 …）"）
      cacheHit: 30,
      calls: 3,
    });
  });
});

describe("消耗页的单价（94 号票）", () => {
  const flash = { cacheHit: 0.02, cacheMiss: 1, output: 4 };
  const flashPeak = { cacheHit: 0.04, cacheMiss: 2, output: 8 };
  const pricing: UsagePricing = {
    estimate: true,
    currency: "CNY",
    prices: [
      { model: "deepseek/deepseek-flash", source: "builtin", pricedAs: "deepseek/deepseek-flash", offPeak: flash, peak: flashPeak },
      { model: "deepseek/deepseek-v4-flash", source: "builtin", pricedAs: "deepseek/deepseek-flash", offPeak: flash, peak: flashPeak },
      { model: "faux", source: "config", cacheHit: 0.5, cacheMiss: 2, output: 8 },
    ],
    unpriced: ["other/m"],
    builtin: {
      source: { title: "DeepSeek 官网的价格页", url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", readOn: "2026-10-12" },
      peakHours: "北京时间周一至周五 9:00–12:00、14:00–18:00 是高峰时段",
      missingHolidayYears: [2027],
    },
  };

  test("自带价格表的模型列高峰、空闲两行，旧名字写明按谁计价；配置里的一行，不分时段", () => {
    expect(usagePriceRows(pricing)).toEqual([
      { key: "deepseek/deepseek-flash:peak", model: "deepseek/deepseek-flash", period: "高峰", price: flashPeak },
      { key: "deepseek/deepseek-flash:off_peak", model: "deepseek/deepseek-flash", period: "空闲", price: flash },
      { key: "deepseek/deepseek-v4-flash:peak", model: "deepseek/deepseek-v4-flash", note: "按 deepseek/deepseek-flash 计价", period: "高峰", price: flashPeak },
      { key: "deepseek/deepseek-v4-flash:off_peak", model: "deepseek/deepseek-v4-flash", note: "按 deepseek/deepseek-flash 计价", period: "空闲", price: flash },
      { key: "faux:config", model: "faux", period: "配置里的，不分时段", price: { cacheHit: 0.5, cacheMiss: 2, output: 8 } },
    ]);
  });

  test("说明：高峰时段怎么算、价格取自官网哪天、缺节假日数据的年份、没配单价的、配置读不出来的", () => {
    expect(usagePricingNotes(pricing)).toEqual([
      "北京时间周一至周五 9:00–12:00、14:00–18:00 是高峰时段",
      "自带价格表取自 DeepSeek 官网的价格页（2026-10-12），官网改价后以官网为准；配置里写了单价的模型以配置为准，不分时段。",
      "缺 2027 年国内节假日数据：那一年只按周一至周五算高峰时段。",
      "没有单价、没算进成本的模型：other/m。",
    ]);
    expect(usagePricingNotes({ ...pricing, builtin: undefined, unpriced: [], problem: "坏了" })).toEqual(["配置里的单价读不出来，没用它：坏了"]);
    expect(usagePricingNotes({ estimate: true, currency: "CNY", prices: [], unpriced: [] })).toEqual([]);
  });
});
