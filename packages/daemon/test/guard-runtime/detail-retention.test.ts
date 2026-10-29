// 哪些调用还被用着（65 号票）：待办里还在（没删、没归档）的事项按登记表（CALL_REFERENCES）引用到的调用、还没决定的审批。
// 主切面覆盖了快速动作卡和没结束的任务；这里按协议的事件直接构造另外几种：审批卡、"交给我做"、"中断不确定"。
import path from "node:path";
import { CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import { expect, test } from "vitest";
import { approvalsView } from "../../src/approvals/views.ts";
import { cardsView } from "../../src/cards/views.ts";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { CALL_REFERENCES, callsInUse } from "../../src/guard-runtime/detail-retention.ts";
import { type ApprovalRecord, GUARD_CHANNEL, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { tasksView } from "../../src/tasks/views.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const T = "2026-10-09T10:00:00.000+08:00";
const base = (id: string, flags: { archived?: boolean; deleted?: boolean } = {}) => ({
  id,
  version: 1,
  title: id,
  source: "系统",
  urgency: "non_blocking",
  pinned: false,
  createdAt: T,
  read: false,
  archived: flags.archived ?? false,
  deleted: flags.deleted ?? false,
});
const notice = (store: EventStore, id: string, kind: string, data: unknown, flags?: { archived?: boolean; deleted?: boolean }) =>
  store.append({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...base(id, flags), kind: "notice", notice: kind, actions: ["知道了"], data } } });
const cardItem = (store: EventStore, id: string, cardId: string, flags?: { archived?: boolean }) =>
  store.append({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...base(id, flags), kind: "card", cardId } } });
const card = (store: EventStore, id: string, type: string, payload: unknown) =>
  store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card: { id, type, version: 1, status: "pending", payload, text: id, createdAt: T, updatedAt: T } } });
const approval = (store: EventStore, approvalId: string, cardId: string, toolCallId: string) => {
  const record: ApprovalRecord = {
    approvalId,
    cardId,
    origin: { agentId: "secretary", conversation: "secretary", taskId: null, stageId: null, source: "对话" },
    toolCallId,
    tool: "bash",
    args: {},
    toolTitle: "通用 bash",
    argsSummary: "rm x",
    fingerprint: `fp-${approvalId}`,
    categories: [],
    reason: "要问你",
    requestedAt: T,
  };
  store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalRequested, payload: { approval: record } });
  card(store, cardId, "approval", { approvalId });
};

test("登记表里有四种：审批卡、快速动作卡、\"交给我做\"、\"中断不确定\"", () => {
  expect(CALL_REFERENCES.map((r) => (r.kind === "card" ? `卡片 ${r.cardType}` : `通知 ${r.notice}`))).toEqual(["卡片 approval", "卡片 quick_action", "通知 hand_over", "通知 interrupted"]);
});

test("待办里还在的事项引用到的调用、还没决定的审批算还被用着；归档了、删了的事项，别的通知里碰巧带着调用 id 的不算", () => {
  const store = openEventStore({ file: path.join(makeTempDir(), "ergo.db"), views: [inboxView, cardsView, approvalsView, tasksView] });
  try {
    notice(store, "i-hand", "hand_over", { toolCallId: "c-hand", origin: {}, tool: "pay", toolTitle: "付款", argsSummary: "", calls: [] });
    notice(store, "i-int", "interrupted", { toolCallId: "c-int", agentId: "tm-1", taskId: null });
    notice(store, "i-hand-archived", "hand_over", { toolCallId: "c-hand-archived" }, { archived: true });
    notice(store, "i-int-deleted", "interrupted", { toolCallId: "c-int-deleted", agentId: "tm-1", taskId: null }, { deleted: true });
    notice(store, "i-other", "reminder_due", { toolCallId: "c-other" });
    card(store, "card-qa", "quick_action", { toolCallId: "c-qa" });
    cardItem(store, "i-qa", "card-qa");
    // 还没决定的审批：卡被归档了也算
    approval(store, "a-pending", "card-a1", "c-approval-pending");
    cardItem(store, "i-a1", "card-a1", { archived: true });
    // 决定过的审批：卡还在待办里就算，归档了就不算
    approval(store, "a-decided", "card-a2", "c-approval-decided");
    cardItem(store, "i-a2", "card-a2");
    approval(store, "a-done", "card-a3", "c-approval-done");
    cardItem(store, "i-a3", "card-a3", { archived: true });
    for (const id of ["a-decided", "a-done"]) store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalDecided, payload: { approvalId: id, decision: "approved", resumed: true, by: "user", time: T } });

    expect([...callsInUse(store.reader).calls].toSorted()).toEqual(["c-approval-decided", "c-approval-pending", "c-hand", "c-int", "c-qa"]);
  } finally {
    store.close();
  }
});
