// 运营方案的差异（130 号票）：按 key 认同一条；只比维护者写的部分；照旧却没跑着的重新开起来；只改了时间表、手段能就地改的标 inPlace。
// 内核的运营手段：定时的只在两边都是重复的时间表、别的都没变时就地改；要用户手动的（公网入口）必须写清手动步骤、不能写流程；
// 项目自己的服务（133 号票）组合根另给（project-services/），排在事件触发的后面。
import type { OperationItem } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { builtinOperationMeans, OperationMeansRegistry } from "../../src/operations/index.ts";
import { type ActiveOperation, diffIsEmpty, diffOperations, writtenForm } from "../../src/operations/diff.ts";

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
  capabilities: {},
  ...extra,
});
const active = (i: OperationItem, taskId?: string): ActiveOperation => ({ item: i, taskId });

describe("diffOperations", () => {
  const deps = { alive: (a: ActiveOperation) => a.taskId !== undefined, inPlace: () => true };

  it("加上、去掉、改了、照旧、重新开起来各归各的", () => {
    const now = [active(item("a"), "t-1"), active(item("b"), "t-2"), active(item("c")), active(item("d"), "t-4")];
    const next = [item("a"), item("b", { schedule: { kind: "daily", time: "07:00" }, triggerText: "每天 07:00" }), item("c"), item("e")];
    const diff = diffOperations(now, next, deps);
    expect(diff.kept.map((k) => k.after.key)).toEqual(["a"]);
    expect(diff.changed.map((c) => [c.after.key, c.inPlace])).toEqual([["b", true]]);
    // c 没有内部任务（上次没生效）：照旧却没跑着，重新开起来
    expect(diff.restored.map((r) => r.after.key)).toEqual(["c"]);
    expect(diff.added.map((i) => i.key)).toEqual(["e"]);
    expect(diff.removed.map((r) => r.item.key)).toEqual(["d"]);
    expect(diffIsEmpty(diff)).toBe(false);
  });

  it("运行时补上的说法不算改动；能力的写法（没写和写 false、skill 的先后）不算改动", () => {
    const before = item("a", { capabilities: { skills: ["b", "a"] } });
    const after = item("a", { meansLabel: "别的说法", triggerText: "别的说法", capabilities: { skills: ["a", "b"], network: false } });
    expect(writtenForm(before)).toBe(writtenForm(after));
    expect(diffIsEmpty(diffOperations([active(before, "t-1")], [after], deps))).toBe(true);
  });

  it("服务的定义改了算改动（133 号票）", () => {
    const service = { name: "web", app: "p-1-web", command: "node a.mjs", cwd: "D:/work/p-1", env: [], port: 8899, autostart: true, autoRestart: false };
    const before = item("w", { means: "service", service });
    expect(writtenForm(before)).not.toBe(writtenForm(item("w", { means: "service", service: { ...service, port: 8900 } })));
    expect(writtenForm(before)).not.toBe(writtenForm(item("w", { means: "service", service: { ...service, autoRestart: true } })));
    expect(writtenForm(before)).toBe(writtenForm(item("w", { means: "service", service: { ...service } })));
  });

  it("没跑着的改了：不就地改（撤了重建）", () => {
    const diff = diffOperations([active(item("a"))], [item("a", { instructions: "换个做法" })], deps);
    expect(diff.changed.map((c) => c.inPlace)).toEqual([false]);
  });
});

describe("内核的运营手段", () => {
  const registry = new OperationMeansRegistry();
  const updates: string[] = [];
  const builtin = builtinOperationMeans({
    tasks: { buildInternal: () => ({}) as never, buildAuthorizedWorkflow: () => ({}) as never },
    scheduledJobs: () => ({ cancelTaskEvents: () => [], rescheduleTaskEvents: (taskId) => (updates.push(taskId), []) }),
  });
  for (const m of [...builtin.triggered, ...builtin.manual]) registry.register(m);
  const ctx = { project: {} as never, now: "2026-10-08T07:30:00.000+08:00", checkEventTrigger: () => [], names: {} };

  it("登记的先后分两段（运营层的服务由组装函数在两段之间装运营层时自己登记，280 号票；整张表的先后见 test/projects/system.test.ts）、重名报错", () => {
    expect(builtin.triggered.map((m) => m.id)).toEqual(["schedule", "event"]);
    expect(builtin.manual.map((m) => m.id)).toEqual(["public_entry"]);
    expect(registry.list().map((m) => m.id)).toEqual(["schedule", "event", "public_entry"]);
    expect(() => registry.register(registry.get("schedule")!)).toThrow(/已经登记过了/);
  });

  it("定时的：要写时间表、不能同时写事件、一次性的要在将来；只改了重复的时间表才就地改", () => {
    const schedule = registry.get("schedule")!;
    expect(schedule.check({ key: "a", name: "a", means: "schedule", instructions: "x", capabilities: {} }, ctx)).toHaveLength(1);
    expect(schedule.check({ key: "a", name: "a", means: "schedule", schedule: { kind: "once", at: "2026-10-01T08:00:00.000+08:00" }, instructions: "x", capabilities: {} }, ctx)).toHaveLength(1);
    expect(schedule.describe({ key: "a", name: "a", means: "schedule", schedule: { kind: "weekly", time: "18:00", weekdays: [0] }, instructions: "x", capabilities: {} }, ctx)).toBe("每周日 18:00");
    const before = item("a");
    expect(schedule.update!(before, item("a", { schedule: { kind: "daily", time: "07:00" } }), { taskId: "t-1" }, { key: "k" })).toEqual([]);
    expect(updates).toEqual(["t-1"]);
    expect(schedule.update!(before, item("a", { schedule: { kind: "daily", time: "07:00" }, instructions: "换个做法" }), { taskId: "t-1" }, { key: "k" })).toBeUndefined();
    expect(schedule.update!(before, item("a", { schedule: { kind: "once", at: "2026-10-09T08:00:00.000+08:00" } }), { taskId: "t-1" }, { key: "k" })).toBeUndefined();
  });

  it("要用户手动的（公网入口）：不自动生效，要写清手动步骤，不能写流程", () => {
    const entry = registry.get("public_entry")!;
    expect(entry.automatic).toBe(false);
    expect(entry.apply).toBeUndefined();
    expect(entry.check({ key: "s", name: "s", means: "public_entry", instructions: "x", capabilities: {} }, ctx)).toHaveLength(1);
    expect(entry.check({ key: "s", name: "s", means: "public_entry", instructions: "x", manual: "在 nginx 里加一条", approach: "workflow", capabilities: {} }, ctx)).toHaveLength(1);
    expect(entry.check({ key: "s", name: "s", means: "public_entry", instructions: "x", manual: "在 nginx 里加一条", capabilities: {} }, ctx)).toEqual([]);
  });
});
