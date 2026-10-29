// 运营方案（130 号票）的视图：项目页"运营方案"一节每一条的状态（在跑、暂停及原因、没生效及原因、要你手动、已结束），
// "运营方案变更"卡的分组和改了哪几处，项目的变更卡。
import { describe, expect, test } from "vitest";
import {
  type OperationItem,
  type OperationsChangeCardPayload,
  operationChangedFields,
  operationsChangeGroups,
  type Project,
  type ProjectEventPayload,
  projectOperationRows,
  projectOperationsChangeCards,
  replay,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Task,
  type TaskEventPayload,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

const item = (key: string, extra: Partial<OperationItem> = {}): OperationItem => ({
  key,
  name: key,
  means: "schedule",
  meansLabel: "定时触发的任务",
  automatic: true,
  triggerText: "每天 08:00",
  schedule: { kind: "daily", time: "08:00" },
  approach: "plain",
  instructions: `做 ${key}`,
  capabilities: { network: true },
  ...extra,
});

const project: Project = {
  id: "p-1",
  name: "AI 简报站",
  goal: "每天出 AI 日报",
  state: "in_use",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: T,
  updatedAt: T,
  operations: {
    revision: 2,
    confirmedAt: T,
    items: [
      { ...item("daily"), taskId: "t-2" },
      { ...item("weekly", { triggerText: "每周日 18:00" }), taskId: "t-3" },
      { ...item("folder", { means: "event", meansLabel: "事件触发的任务", capabilities: { bash: true } }), failed: "要的能力超出了项目现在的工具包（bash）" },
      { ...item("site", { means: "service", meansLabel: "项目自己的服务（登记到 LSM）", automatic: false, manual: "在 LSM 里登记一个静态网页服务", capabilities: {} }) },
      { ...item("old"), taskId: "t-4" },
    ],
  },
};

const job = (id: string, ownerTaskId: string, extra: Partial<ScheduledJob>): ScheduledJob => ({
  id,
  title: id,
  schedule: { kind: "daily", time: "08:00" },
  each: id,
  projectId: "p-1",
  projectName: "AI 简报站",
  maintainerId: "pm-1",
  taskId: ownerTaskId,
  ownerTaskId,
  taskTitle: id,
  state: "active",
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: 0,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  createdAt: T,
  updatedAt: T,
  ...extra,
});

const task = (id: string, state: Task["state"]): Task => ({ id, title: id, summary: id, state, origin: "operations", maintainerId: "pm-1", projects: ["AI 简报站"], projectIds: ["p-1"], createdAt: T, updatedAt: T });

/** 只看项目的"运营方案变更"卡负载 */
const payload = (projectId: string) => ({ projectId }) as unknown as OperationsChangeCardPayload;

describe("项目页的运营方案", () => {
  test("每一条的状态照它的内部任务和触发登记现算：在跑（下次）、暂停（及原因）、没生效（及原因）、要你手动（写明步骤）、已结束", () => {
    const state = replay([
      frame("projects", 1, "project", { project, change: "in_use", from: "building", by: "user" } satisfies ProjectEventPayload),
      frame("board", 1, "scheduled_job", { job: job("j-2", "t-2", { nextAt: "2026-10-09T08:00:00.000+08:00" }), change: "registered", by: "system" } satisfies ScheduledJobEventPayload),
      frame("board", 2, "scheduled_job", { job: job("j-3", "t-3", { state: "paused", pausedBy: "project_retired" }), change: "paused", by: "system" } satisfies ScheduledJobEventPayload),
      frame("board", 3, "task", { task: task("t-4", "cancelled"), change: "cancelled", from: "operating", by: "user" } satisfies TaskEventPayload),
    ]);
    const rows = projectOperationRows(state, state.projects["p-1"]!);
    expect(rows.map((r) => [r.item.key, r.status, r.statusText, r.detail])).toEqual([
      ["daily", "running", "在跑", undefined],
      ["weekly", "paused", "已暂停（项目已停用）", undefined],
      ["folder", "failed", "没生效", "要的能力超出了项目现在的工具包（bash）"],
      ["site", "manual", "要你手动", "这一项二狗现在还做不了，需要你手动：在 LSM 里登记一个静态网页服务"],
      ["old", "ended", "已结束（已取消）", undefined],
    ]);
    expect(rows[0]!.nextAt).toBe("2026-10-09T08:00:00.000+08:00");
    expect(rows[0]!.howText).toBe("普通任务 · 联网");
    expect(rows[3]!.howText).toBe("不用额外的能力");
    // 没有运营方案的项目：没有这一节的行
    expect(projectOperationRows(state, { id: "p-1", operations: undefined })).toEqual([]);
  });

  test("这个项目的“运营方案变更”卡，先提的在前", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c-2", 1, { type: "operations_change", payload: payload("p-1"), createdAt: "2026-10-08T10:00:00+08:00" }) }),
      frame("cards", 2, "card", { card: card("c-1", 1, { type: "operations_change", payload: payload("p-1"), createdAt: "2026-10-08T09:00:00+08:00" }) }),
      frame("cards", 3, "card", { card: card("c-3", 1, { type: "operations_change", payload: payload("p-2") }) }),
    ]);
    expect(projectOperationsChangeCards(state, "p-1")).toEqual(["c-1", "c-2"]);
  });
});

describe("“运营方案变更”卡", () => {
  const p: OperationsChangeCardPayload = {
    projectId: "p-1",
    projectName: "AI 简报站",
    revision: 3,
    baseRevision: 2,
    why: "日报改到 7 点，周报不要了",
    added: [item("run-failed")],
    changed: [{ before: item("daily"), after: item("daily", { schedule: { kind: "daily", time: "07:00" }, triggerText: "每天 07:00" }), inPlace: true }],
    removed: [item("weekly")],
    restored: [],
    kept: [],
  };

  test("按加上、改了、去掉、重新开起来分组，空的组不列", () => {
    expect(operationsChangeGroups(p).map((g) => [g.kind, g.items.map((i) => i.key)])).toEqual([
      ["added", ["run-failed"]],
      ["changed", ["daily"]],
      ["removed", ["weekly"]],
    ]);
  });

  test("改了的写明改了哪几处", () => {
    const [changed] = p.changed;
    expect(operationChangedFields(changed!.before, changed!.after)).toEqual(["触发：每天 08:00 → 每天 07:00"]);
    expect(operationChangedFields(item("a"), item("a", { instructions: "换个做法", capabilities: { network: true, bash: true } }))).toEqual(["每次做什么改了", "能力：联网 → bash、联网"]);
  });
});
