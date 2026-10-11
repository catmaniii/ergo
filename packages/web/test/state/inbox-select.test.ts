// 90 号票：待办多选。守护进程的 inbox_action 是全部生效或全部不生效，所以先剔掉做不了的（卡着任务、还没处理的不能归档或删除；
// 卡片不能一起处理），交上去的只有会变的那几条，跳过的写明几条、为什么；"一起处理"只给所选通知都有的"知道了"，要做决定的一条条来。
import { describe, expect, test } from "vitest";
import { allSelected, inboxBatchCounts, inboxBatchHandle, inboxBatchTargets, type InboxEntry, type InboxItem } from "../../src/state/index.ts";
import { cardInboxItem, inboxItem } from "./events.ts";

const entry = (item: InboxItem, processed = false): InboxEntry => ({ item, processed });

const entries: InboxEntry[] = [
  entry(inboxItem("i-ack", { actions: ["知道了"] })),
  entry(inboxItem("i-ack-read", { actions: ["知道了", "重试"], read: true })),
  entry(inboxItem("i-stuck", { notice: "stuck_help", urgency: "blocking", actions: ["继续执行"] })),
  entry(cardInboxItem("i-approval", "c-1", { urgency: "blocking_deadline" })),
  entry(cardInboxItem("i-plan-done", "c-2", { urgency: "blocking", read: true }), true),
];

describe("待办多选的操作栏", () => {
  test("每个按钮能对几条做：已读的不再标已读；卡着任务、还没处理的不能归档或删除", () => {
    expect(inboxBatchCounts(entries)).toEqual({ read: 3, unread: 2, archive: 3, unarchive: 0, delete: 3 });
  });

  test("归档、删除：跳过卡着任务、还没处理的，写明几条、为什么", () => {
    expect(inboxBatchTargets(entries, "archive")).toEqual({ ids: ["i-ack", "i-ack-read", "i-plan-done"], skipped: 2, why: "2 条卡着任务、还没处理，不能归档：先处理它" });
    expect(inboxBatchTargets(entries, "delete")).toMatchObject({ skipped: 2, why: "2 条卡着任务、还没处理，不能删除：先处理它" });
    expect(inboxBatchTargets(entries.slice(0, 2), "archive")).toEqual({ ids: ["i-ack", "i-ack-read"], skipped: 0 });
  });

  test("标已读、标未读：只交会变的，不算跳过", () => {
    expect(inboxBatchTargets(entries, "read")).toEqual({ ids: ["i-ack", "i-stuck", "i-approval"], skipped: 0 });
    expect(inboxBatchTargets(entries, "unread")).toEqual({ ids: ["i-ack-read", "i-plan-done"], skipped: 0 });
  });

  test("一起处理：所选的还没处理的通知都有的\"知道了\"；卡片、处理过的跳过并写明", () => {
    // "重试"是做决定的，不能一起选：只有"知道了"
    expect(inboxBatchHandle(entries.slice(0, 2))).toEqual({ choices: ["知道了"] });
    // 卡着任务的"卡住求助"只有"继续执行"：要做决定，一条条处理
    expect(inboxBatchHandle(entries)).toEqual({ choices: [], why: "1 条要做决定，要一条条处理" });
    expect(inboxBatchTargets([...entries.slice(0, 2), entries[3]!, entries[4]!], "handle", "知道了")).toEqual({
      ids: ["i-ack", "i-ack-read"],
      skipped: 2,
      why: "2 条是卡片，要一张张处理",
    });
    expect(inboxBatchTargets([entry(inboxItem("i-x", { actions: ["知道了"], handled: "知道了" }), true), entries[0]!], "handle", "知道了")).toEqual({
      ids: ["i-ack"],
      skipped: 1,
      why: "1 条已经处理过或没有这个选项",
    });
  });

  test("要做决定的通知都有同一个选项也不能一起选：中断不确定、验收、超预算、失败后的抉择……灰掉并写明", () => {
    const interrupted = (id: string) => entry(inboxItem(id, { notice: "interrupted", urgency: "blocking", actions: ["已经执行了，继续", "没执行，重做这一步"] }));
    const acceptance = (id: string) => entry(inboxItem(id, { notice: "stage_acceptance", urgency: "blocking", actions: ["验收通过", "退回"] }));
    const overBudget = (id: string) => entry(inboxItem(id, { notice: "over_budget", urgency: "blocking", actions: ["追加预算继续"] }));
    const failed = (id: string) => entry(inboxItem(id, { notice: "failure_choice", urgency: "blocking", actions: ["重试", "取消任务"] }));
    expect(inboxBatchHandle([interrupted("i-1"), interrupted("i-2")])).toEqual({ choices: [], why: "2 条要做决定，要一条条处理" });
    expect(inboxBatchHandle([acceptance("i-1"), acceptance("i-2")]).choices).toEqual([]);
    expect(inboxBatchHandle([overBudget("i-1"), overBudget("i-2")]).choices).toEqual([]);
    expect(inboxBatchHandle([failed("i-1"), failed("i-2"), entries[0]!])).toEqual({ choices: [], why: "2 条要做决定，要一条条处理" });
    // 就算硬交上去，做决定的选项也一条都不交
    expect(inboxBatchTargets([interrupted("i-1"), interrupted("i-2")], "handle", "已经执行了，继续").ids).toEqual([]);
    expect(inboxBatchTargets([failed("i-1")], "handle", "重试").ids).toEqual([]);
  });

  test("去设置页修的选项（点了是去设置页）不算能一起处理的；只有卡片、处理过的时没有，也不写为什么", () => {
    const broken = entry(inboxItem("i-broken", { notice: "watch_categories_broken", actions: ["去设置页修复"] }));
    expect(inboxBatchHandle([broken, broken]).choices).toEqual([]);
    expect(inboxBatchHandle([entries[3]!])).toEqual({ choices: [] });
    expect(inboxBatchHandle([entries[4]!])).toEqual({ choices: [] });
  });

  test("全选（当前页签）：都勾上了才算", () => {
    const items = entries.map((e) => e.item);
    expect(allSelected(new Set(items.map((i) => i.id)), items)).toBe(true);
    expect(allSelected(new Set(["i-ack"]), items)).toBe(false);
    expect(allSelected(new Set(), [])).toBe(false);
  });
});
