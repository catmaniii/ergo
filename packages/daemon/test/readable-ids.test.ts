// 159 号票：守护进程拼给用户看的句子（时间线记录、会话里的说明、越界通知、卡片的处理结果）里，工单、任务、维护者
// 带上名字；163 号票统一写成仓库里原来的"编号「简短描述」"（"wo-3「加一个导出说明」"、"t-5「建设「记账本」首版」"、
// "pm-1「记账本的项目维护者」"），句式回到加名字之前的样子；给 agent 看的照旧只写编号。
import type { MaintainerSegment, Project, ScopeRecord, Task, TaskMaintainerWorkOrder, WorkOrder } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { buildTaskNote, charterBuildText, kickoffNote, nextBuildNote, nextBuildText } from "../src/projects/texts.ts";
import { outOfScopeNotice, recentRecordsText } from "../src/scope-review/texts.ts";
import { forwardDismissedRecord, forwardDismissedText, timelineText } from "../src/work-orders/multi-project-texts.ts";
import { escalatedNote, ownJudgementRecord, unreviewedRecord, unwrittenRecord } from "../src/work-orders/texts.ts";

const wo = { id: "wo-3", title: "加一个导出说明", taskId: "t-2", taskTitle: "记账本和家电档案打通", stageId: "s1", reason: undefined, outcome: "done" } as unknown as TaskMaintainerWorkOrder;
const r = { wo, projectName: "记账本" };

describe("多项目任务时间线上的工单记录写编号加标题", () => {
  test.each([
    ["created", "建出工单 wo-3「加一个导出说明」 → 项目「记账本」（阶段 s1，阶段开始时派出）"],
    ["dispatched", "派出工单 wo-3「加一个导出说明」 → 项目「记账本」"],
    ["awaiting", "计划外工单 wo-3「加一个导出说明」 → 项目「记账本」待你确认"],
    ["unplannedDirect", "计划外工单 wo-3「加一个导出说明」 → 项目「记账本」：超出授权先不管，直接派出"],
    ["confirmed", "你确认派出计划外工单 wo-3「加一个导出说明」 → 项目「记账本」"],
    ["declined", "你拒绝了计划外工单 wo-3「加一个导出说明」 → 项目「记账本」，没有派出"],
    ["undispatched", "工单 wo-3「加一个导出说明」 → 项目「记账本」没有派出就结束了"],
    ["receipt", "工单 wo-3「加一个导出说明」回执：项目「记账本」完成"],
    ["lineDropped", "工单 wo-3「加一个导出说明」 → 项目「记账本」那一行从计划里去掉了，不再挡阶段 s1"],
  ] as const)("%s", (kind, expected) => {
    expect(timelineText[kind](r)).toBe(expected);
  });

  test("关掉转问的提问卡：记录写编号加标题；交给任务维护者的通知照旧只写编号", () => {
    expect(forwardDismissedRecord(wo).summary).toBe("关掉了为工单 wo-3「加一个导出说明」转问的提问卡：任务维护者按自己的理解回答");
    expect(forwardDismissedText(wo)).toContain("为工单 wo-3 转问");
  });
});

describe("项目维护者会话分段的记录和说明写工单的编号加标题", () => {
  const segment = { segmentId: "pm-1-s3", maintainerId: "pm-1", projectId: "p-1", workOrderId: "wo-3" } as MaintainerSegment;
  const order = { id: "wo-3", title: "加一个导出说明" } as WorkOrder;
  test("没写回、没做范围审视就结束的记录；催写回到了次数的说明", () => {
    expect(unwrittenRecord(segment, "nudged", order).detail).toBe("会话分段 pm-1-s3（工单 wo-3「加一个导出说明」）结束时没写回项目档案：催写回到了次数，转给用户拍板");
    expect(unreviewedRecord(segment, order).detail).toMatch(/^会话分段 pm-1-s3（工单 wo-3「加一个导出说明」）没做范围审视就结束了/);
    expect(escalatedNote(segment, 2, order)).toBe("维护者催了 2 次还没写回项目档案：这一段（pm-1-s3）没写回就结束了，工单 wo-3「加一个导出说明」照常结束，转给你拍板（待办里的\"卡住求助\"）。");
    // 对话段没有工单
    const chat = { ...segment, workOrderId: undefined } as MaintainerSegment;
    expect(unwrittenRecord(chat, "reset", undefined).detail).toBe("会话分段 pm-1-s3（对话段）结束时没写回项目档案：写回中途重置了维护者，工单照常算完成");
    // 工单取不到了（删掉了）
    expect(unwrittenRecord(segment, "nudged", undefined).detail).toContain("（工单 wo-3（已删除））");
  });

  test("关掉工单的提问卡", () => {
    expect(ownJudgementRecord({ ...order, taskId: "t-2", taskTitle: "加周报" } as WorkOrder).summary).toBe("关掉了工单 wo-3「加一个导出说明」的提问卡：维护者按自己的理解接着做");
  });
});

describe("越界通知里的归属写编号加名字；维护者系统提示里的近期范围记录照旧只写编号", () => {
  const record = { id: "sr-1", kind: "out_of_scope", summary: "顺手改了 README", trigger: "work_order_end", projectId: "p-1", maintainerId: "pm-1", workOrderId: "wo-2", taskId: "t-1", time: "2026-10-18T10:00:00.000+08:00" } as ScopeRecord;
  test("正文", () => {
    const notice = outOfScopeNotice(record, "项目「记账本」", { workOrder: "执行：给记账本加周报", task: "给记账本加周报" });
    expect(notice.body).toContain("（工单 wo-2「执行：给记账本加周报」，任务 t-1「给记账本加周报」）");
    // 取不到名字的写（已删除）
    expect(outOfScopeNotice(record, "项目「记账本」", {}).body).toContain("（工单 wo-2（已删除），任务 t-1（已删除））");
    expect(recentRecordsText([record])).toContain("（工单 wo-2（任务 t-1））");
  });
});

describe("项目的说明和卡片处理结果写任务、维护者的编号加名字", () => {
  const project = { id: "p-1", name: "记账本", goal: "把每月的账记清楚", maintainerId: "pm-1" } as Project;
  const task = { id: "t-5", title: "建设「记账本」首版" } as Task;
  test("立项后维护者会话里的说明", () => {
    expect(kickoffNote(project)).toBe(
      "项目「记账本」立项了（筹备中）：把每月的账记清楚\npm-1「记账本的项目维护者」会和你做立项问答：把规格、术语表、决策记录写进项目档案，最后交出立项书。在这里说话就能叫醒它。",
    );
  });

  test("首个建设任务、下一轮建设任务", () => {
    expect(buildTaskNote(task)).toBe("首个建设任务 t-5「建设「记账本」首版」");
    expect(charterBuildText(task)).toBe("首个建设任务 t-5「建设「记账本」首版」已建出（规划中）。");
    expect(nextBuildNote(task)).toBe("下一轮建设任务 t-5「建设「记账本」首版」");
    expect(nextBuildText(task)).toBe("下一轮建设任务 t-5「建设「记账本」首版」已建出（规划中），照这句话起草它的计划。");
  });
});
