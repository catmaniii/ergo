// 266 号票：记忆简报的用量单独一项。记忆简报不调模型，它的开销是秘书这一轮多读的那些输入 token——已经算在秘书的用量里了，
// 用量页另列"记忆简报"一项：带了几次、估的 token、粗估的钱（按带进去那一次没命中缓存、秘书最近一次干活用的模型的单价算）。
// 账本频道上的 context_usage 事件，派生视图 context_usage_ledger（能从事件日志重建），不进 token 的合计、不叫 onRecorded。
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { openEventStore } from "../src/events/event-store.ts";
import { contextUsageView, createTokenLedger, ledgerView, webCallsView } from "../src/ledger/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

function setup() {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-context-usage-"), "ergo.db"), views: [ledgerView, webCallsView, contextUsageView] });
  onTestFinished(() => store.close());
  let time = "2026-10-25T10:00:00.000+08:00";
  const recorded: unknown[] = [];
  const ledger = createTokenLedger({ store, now: () => time, currentStage: () => undefined, prices: () => ({ currency: "CNY", models: { "deepseek/deepseek-flash": { cacheHit: 0.2, cacheMiss: 2, output: 8 } } }), holidays: () => [], log: () => undefined });
  ledger.onRecorded((e) => recorded.push(e));
  return {
    store,
    ledger,
    recorded,
    at: (t: string) => {
      time = t;
    },
  };
}

const SECRETARY = { owner: null, role: "secretary" as const };

describe("记忆简报的用量", () => {
  test("带了几次、估的 token、粗估的钱（按秘书最近一次干活用的模型、没命中缓存的单价）；不进 token 的合计、不叫 onRecorded", () => {
    const { ledger, recorded, at } = setup();
    ledger.record({ agentId: "secretary", sessionId: "s-1", model: "deepseek/deepseek-flash", attribution: SECRETARY, report: { type: "usage", messageId: "a-1", provider: "deepseek", modelId: "deepseek-flash", input: 1000, cacheRead: 9000, cacheWrite: 0, output: 300, totalTokens: 10300 } });
    expect(recorded).toHaveLength(1);
    ledger.recordContextUsage({ agentId: "secretary", role: "secretary", kind: "memory_brief", tokens: 700, chars: 1500 });
    at("2026-10-25T11:00:00.000+08:00");
    ledger.recordContextUsage({ agentId: "secretary", role: "secretary", kind: "memory_brief", tokens: 300, chars: 650 });
    // 别的日子的不算
    at("2026-10-27T11:00:00.000+08:00");
    ledger.recordContextUsage({ agentId: "secretary", role: "secretary", kind: "memory_brief", tokens: 999, chars: 2000 });
    const summary = ledger.summary({ from: "2026-10-25", to: "2026-10-25" });
    expect(summary.memoryBrief).toEqual({ count: 2, tokens: 1000, cost: expect.closeTo(0.002, 10) });
    // token 的合计只有模型调用那一笔
    expect(summary.total.calls).toBe(1);
    expect(summary.total.tokens).toEqual({ cacheHit: 9000, cacheMiss: 1000, output: 300 });
    expect(recorded).toHaveLength(1);
  });

  test("秘书还没调过模型（不知道用哪个模型）：照样记次数和 token，钱算 0；没有记忆简报时是 0", () => {
    const { ledger, store } = setup();
    expect(ledger.summary({ from: "2026-10-25", to: "2026-10-25" }).memoryBrief).toEqual({ count: 0, tokens: 0, cost: 0 });
    ledger.recordContextUsage({ agentId: "secretary", role: "secretary", kind: "memory_brief", tokens: 500, chars: 1000 });
    const summary = ledger.summary({ from: "2026-10-25", to: "2026-10-25" });
    expect(summary.memoryBrief).toEqual({ count: 1, tokens: 500, cost: 0 });
    expect(summary.pricing.unpriced).toEqual([]);
    // 派生视图能从事件日志重建
    store.rebuildViews();
    expect(ledger.summary({ from: "2026-10-25", to: "2026-10-25" }).memoryBrief).toEqual({ count: 1, tokens: 500, cost: 0 });
  });
});
