// 按次计费的联网调用记账（154 号票）：DeepSeek 的联网搜索、读网页每次成功的调用记一条（账本频道上的 web_call，派生视图 web_call_ledger），
// 记在发起调用的 agent 名下（和 token 用量同一套归属：秘书的是系统开销，没给归属的是未归属，任务名下的记上阶段）；
// 消耗页的 web 一节按种类、按 agent 给次数和粗估成本（每次 0.005 元，框架自带的单价；配置里的货币不是人民币时不算钱）。
// 不进 token 的合计、不叫 onRecorded（预算阈值只看 token）；派生视图能从事件日志重建。
import path from "node:path";
import { BUILTIN_WEB_CALL_PRICE_SOURCE } from "@ergo/protocol";
import { describe, expect, onTestFinished, test } from "vitest";
import type { TokenPriceTable } from "../src/config/config.ts";
import { openEventStore } from "../src/events/event-store.ts";
import { contextUsageView, createTokenLedger, ledgerView, webCallsView } from "../src/ledger/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

function setup(prices: () => TokenPriceTable = () => ({ currency: "CNY", models: {} })) {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-web-calls-"), "ergo.db"), views: [ledgerView, webCallsView, contextUsageView] });
  onTestFinished(() => store.close());
  let time = "2026-10-18T10:00:00.000+08:00";
  const recorded: unknown[] = [];
  const ledger = createTokenLedger({ store, now: () => time, currentStage: () => "s-2", prices, holidays: () => [], log: () => undefined });
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
const TASK_MAINTAINER = { owner: { kind: "task" as const, id: "t-1" }, role: "maintainer" as const };

describe("联网调用记账", () => {
  test("按种类、按 agent 记次数和粗估成本（每次 0.005 元）；秘书的是系统开销，没给归属的是未归属；不进 token 的合计、不叫 onRecorded", () => {
    const { ledger, recorded, store } = setup();
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "search" });
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "search" });
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "fetch" });
    ledger.recordWebCall({ agentId: "tm-1", attribution: TASK_MAINTAINER, service: "deepseek", kind: "search" });
    ledger.recordWebCall({ agentId: "x-9", attribution: undefined, service: "deepseek", kind: "fetch" });
    const summary = ledger.summary({ from: "2026-10-18", to: "2026-10-18" });
    expect(summary.web.search.calls).toBe(3);
    expect(summary.web.search.cost).toBeCloseTo(0.015, 10);
    expect(summary.web.fetch.calls).toBe(2);
    expect(summary.web.fetch.cost).toBeCloseTo(0.01, 10);
    expect(summary.web.unpriced).toBe(false);
    expect(summary.web.price).toEqual({ service: "deepseek", search: 0.005, fetch: 0.005, currency: "CNY", source: { ...BUILTIN_WEB_CALL_PRICE_SOURCE } });
    const rows = summary.web.agents.map((a) => ({ agentId: a.agentId, role: a.role, category: a.category, search: a.search.calls, fetch: a.fetch.calls }));
    expect(rows).toEqual([
      { agentId: "secretary", role: "secretary", category: "system", search: 2, fetch: 1 },
      { agentId: "tm-1", role: "maintainer", category: "owned", search: 1, fetch: 0 },
      { agentId: "x-9", role: "unattributed", category: "unattributed", search: 0, fetch: 1 },
    ]);
    expect(summary.web.agents[0]!.search.cost).toBeCloseTo(0.01, 10);
    // token 那边不受影响
    expect(summary.total).toEqual({ tokens: { cacheHit: 0, cacheMiss: 0, output: 0 }, calls: 0, cost: 0 });
    expect(summary.days).toEqual([]);
    expect(ledger.entries()).toEqual([]);
    expect(recorded).toEqual([]);
    // 任务名下的记上当前阶段（和 token 用量一样）
    const row = store.reader.get<{ stage_id: string | null; owner_id: string | null }>("SELECT stage_id, owner_id FROM web_call_ledger WHERE agent_id = 'tm-1'");
    expect(row).toEqual({ stage_id: "s-2", owner_id: "t-1" });
  });

  test("只算范围里的日子；没有调用时没有单价", () => {
    const { ledger, at } = setup();
    at("2026-10-16T23:59:00.000+08:00");
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "search" });
    at("2026-10-17T09:00:00.000+08:00");
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "fetch" });
    const one = ledger.summary({ from: "2026-10-17", to: "2026-10-18" }).web;
    expect([one.search.calls, one.fetch.calls]).toEqual([0, 1]);
    const none = ledger.summary({ from: "2026-10-18", to: "2026-10-18" }).web;
    expect(none).toEqual({ search: { calls: 0, cost: 0 }, fetch: { calls: 0, cost: 0 }, agents: [], unpriced: false });
  });

  test("配置里的货币不是人民币：自带的单价用不了，不算钱、标出来", () => {
    const { ledger } = setup(() => ({ currency: "USD", models: {} }));
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "search" });
    const web = ledger.summary({ from: "2026-10-18", to: "2026-10-18" }).web;
    expect(web.search).toEqual({ calls: 1, cost: 0 });
    expect(web.unpriced).toBe(true);
    expect(web.price).toBeUndefined();
  });

  test("派生视图能从事件日志重建", () => {
    const { ledger, store } = setup();
    ledger.recordWebCall({ agentId: "secretary", attribution: SECRETARY, service: "deepseek", kind: "search" });
    ledger.recordWebCall({ agentId: "tm-1", attribution: TASK_MAINTAINER, service: "deepseek", kind: "fetch" });
    const before = ledger.summary({ from: "2026-10-18", to: "2026-10-18" });
    store.rebuildViews();
    expect(ledger.summary({ from: "2026-10-18", to: "2026-10-18" })).toEqual(before);
  });
});
