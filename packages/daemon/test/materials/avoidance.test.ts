// 回避信号（规格第 13、15 节，模块层，时钟可注入）：卡片被用户关掉，或者建议卡、提问卡 7 天（默认，可配置）没处理。
// 7 天没处理由调度器的内部作业在卡片频道追加 card_stale 事件，素材从事件日志采；7 天内处理了的不产生。
import { type Card, type CardEventPayload, type CardStaleEventPayload, CHANNELS, EVENT_TYPES, nowIso } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../src/materials/segments.ts";
import { materialsSetup, START } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

function suggestCard(t: ReturnType<typeof materialsSetup>) {
  return t.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "你提过三次重复照片太多" } });
}

const staleEvents = (t: ReturnType<typeof materialsSetup>) => t.store.read(CHANNELS.cards).filter((e) => e.type === EVENT_TYPES.cardStale);

describe("卡片被关闭", () => {
  test("用户关掉一张建议卡：一条回避信号素材（做、本人）；卡片只留引用，类型和标题作说明；关掉时写的说明是本人的话、存进原文副本", () => {
    const t = materialsSetup();
    const card = suggestCard(t);
    t.cards.act({ cardId: card.id, action: "dismiss", expectedVersion: 1, note: "照片的事以后再说", idempotencyKey: "k-1" });

    expect(t.materials.list()).toMatchObject([
      {
        kind: "avoidance_signal",
        mode: "do",
        source: "self",
        conversation: null,
        context: ["dismissed", "card:suggest_task", "action:dismiss"],
        ref: { cardId: card.id, event: { channel: CHANNELS.cards, type: EVENT_TYPES.cardDismissed } },
        segments: [
          { form: "agent_output", source: "agent", cardId: card.id, label: "建议发起任务：整理家庭照片（你提过三次重复照片太多）" },
          { form: "typed", source: "self", locator: { field: "note" }, text: "照片的事以后再说", sha256: sha256Hex("照片的事以后再说") },
        ],
        original: { path: expect.any(String) },
      },
    ]);
    // 关掉的卡不会再算"长期没处理"
    t.clock.advance(8 * DAY);
    expect(staleEvents(t)).toEqual([]);
  });

  test("关掉配对请求卡不算素材（批准配对不算素材）", () => {
    const t = materialsSetup();
    t.store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.cardDismissed, payload: { cardId: "c-pair", cardType: "pairing", action: "deny", time: "2026-10-08T09:00:00.000+08:00" } });
    expect(t.materials.list()).toEqual([]);
  });
});

describe("长期没处理", () => {
  test("建议卡 7 天没处理：追加 card_stale 事件，产生一条回避信号素材（做、系统）；差一分钟时还没有", () => {
    const t = materialsSetup();
    const card = suggestCard(t);

    t.clock.advanceTo(START.getTime() + 7 * DAY - 60_000);
    expect(staleEvents(t)).toEqual([]);
    expect(t.materials.list()).toEqual([]);

    t.clock.advanceTo(START.getTime() + 7 * DAY);
    expect(staleEvents(t).map((e) => e.payload)).toEqual([{ cardId: card.id, cardType: "suggest_task", pendingSince: card.createdAt, time: nowIso(new Date(START.getTime() + 7 * DAY)), cardText: "建议发起任务：整理家庭照片（你提过三次重复照片太多）" }]);
    expect(t.materials.list()).toMatchObject([
      {
        kind: "avoidance_signal",
        mode: "do",
        source: "system",
        time: nowIso(new Date(START.getTime() + 7 * DAY)),
        context: ["stale", "card:suggest_task"],
        segments: [{ form: "agent_output", cardId: card.id, label: "建议发起任务：整理家庭照片（你提过三次重复照片太多）" }],
        original: null,
        ref: { cardId: card.id },
      },
    ]);
  });

  test("7 天内处理了的不产生", () => {
    const t = materialsSetup();
    const card = suggestCard(t);
    t.clock.advance(3 * DAY);
    t.cards.act({ cardId: card.id, action: "start_task", expectedVersion: 1, idempotencyKey: "k-start" });
    t.clock.advance(10 * DAY);
    expect(staleEvents(t)).toEqual([]);
    expect(t.materials.list()).toEqual([]);
  });

  test("只有建议卡和提问卡计时：别的卡放多久都不算回避", () => {
    const t = materialsSetup();
    const card: Card = { id: "c-progress", type: "progress", typeVersion: 1, version: 1, status: "pending", payload: {}, text: "进度", createdAt: "2026-10-08T09:00:00.000+08:00" };
    t.store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card } satisfies CardEventPayload });
    t.clock.advance(30 * DAY);
    expect(staleEvents(t)).toEqual([]);
  });

  test("守护进程重启后照常计时；停着的时候过了点的，启动时补上、时间记到期的时刻，只补一条", async () => {
    const t = materialsSetup();
    const kept = suggestCard(t);
    await t.reopen();
    t.clock.advance(7 * DAY);
    expect(staleEvents(t).map((e) => (e.payload as { cardId: string }).cardId)).toEqual([kept.id]);

    const late = suggestCard(t);
    await t.materials.stop();
    t.clock.jumpTo(t.clock.now() + 9 * DAY);
    await t.reopen();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.reopen();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(staleEvents(t).map((e) => (e.payload as { cardId: string }).cardId)).toEqual([kept.id, late.id]);
    // 到期的时刻是建卡后 7 天，不是两天后醒来补发的时刻
    const due = nowIso(new Date(Date.parse(late.createdAt) + 7 * DAY));
    expect((staleEvents(t)[1]!.payload as CardStaleEventPayload).time).toBe(due);
    expect(t.materials.list({ kind: "avoidance_signal" }).map((m) => m.time)).toEqual([nowIso(new Date(Date.parse(kept.createdAt) + 7 * DAY)), due]);
  });

  test("天数可配置", () => {
    const t = materialsSetup({ staleCardDays: 2 });
    suggestCard(t);
    t.clock.advance(2 * DAY);
    expect(staleEvents(t)).toHaveLength(1);
  });
});
