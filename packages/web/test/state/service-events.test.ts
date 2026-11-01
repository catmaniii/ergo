// 项目的服务报事件（357 号票）的状态层：项目页"运营方案"那一节，服务那一条列这个服务最近报的事件（名字写错的也在），等事件的那一条列它等的这个名字的；
// 发起任务对话框、简单提醒能选的来源里没有它，卡上的说法。
import { describe, expect, test } from "vitest";
import { describeEventTrigger, EVENT_SOURCES, PICKABLE_EVENT_SOURCES, type Project, type ProjectEventPayload, type ProjectOperationItem, projectOperationRows, type ProjectServiceView, replay } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

const serviceItem: ProjectOperationItem = {
  key: "watcher",
  name: "评论监控",
  means: "service",
  meansLabel: "项目自己的服务（登记到 LSM）",
  automatic: true,
  triggerText: "上线服务「评论监控」（端口 18700，开机自启）",
  approach: "plain",
  instructions: "盯评论",
  capabilities: {},
  service: { name: "watcher", app: "p-1-watcher", command: "node watcher.mjs", cwd: "D:/x", env: [], port: 18700, autostart: true, autoRestart: false },
};

const waiter = (key: string, name: string): ProjectOperationItem => ({
  key,
  name: `${name}时处理`,
  means: "event",
  meansLabel: "事件触发的任务",
  automatic: true,
  triggerText: `项目的服务报事件「${name}」`,
  event: { kind: "event", source: "service", events: ["reported"], filter: { name } },
  approach: "plain",
  instructions: "处理",
  capabilities: {},
  taskId: `t-${key}`,
});

const project: Project = {
  id: "p-1",
  name: "评论监控",
  goal: "盯评论",
  state: "in_use",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: T,
  updatedAt: T,
  operations: { revision: 1, confirmedAt: T, items: [serviceItem, waiter("alert", "评论异常"), waiter("quiet", "价格异常")] },
};

const view = (extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({ projectId: "p-1", key: "watcher", title: "评论监控", name: "watcher", app: "p-1-watcher", port: 18700, autostart: true, rollout: "live", status: "online", ...extra });

const stateWith = (services: ProjectServiceView[]) =>
  replay([frame("projects", 1, "project", { project, change: "in_use", from: "building", by: "user" } satisfies ProjectEventPayload), frame("projects", 2, "project_services", { services })]);

describe("项目页上最近收到的事件", () => {
  test("服务那一条列全部（名字写错、没叫醒的写明为什么）；等事件的那一条只列它等的名字；还没收到过的是空的", () => {
    const state = stateWith([
      view({
        recentEvents: [
          { name: "评论异常", at: "2026-10-08T10:00:00.000+08:00", outcome: "woke", runIds: ["j-1-r2"] },
          { name: "评论异长", at: "2026-10-08T09:50:00.000+08:00", outcome: "no_waiter" },
          { name: "评论异常", at: "2026-10-08T09:40:00.000+08:00", outcome: "rate_limited" },
          { name: "评论异常", at: "2026-10-08T09:30:00.000+08:00", outcome: "merged", runIds: ["j-1-r1"] },
        ],
      }),
    ]);
    const [service, alert, quiet] = projectOperationRows(state, state.projects["p-1"]!);
    expect(service!.events!.map((e) => [e.name, e.woke, e.text])).toEqual([
      ["评论异常", true, "叫醒了维护者"],
      ["评论异长", false, "没叫醒：运营方案里没有等它的"],
      ["评论异常", false, "没叫醒：报得太快，超了限速"],
      ["评论异常", true, "并进了排着的那次运行"],
    ]);
    expect(alert!.events!.map((e) => e.at)).toEqual(["2026-10-08T10:00:00.000+08:00", "2026-10-08T09:40:00.000+08:00", "2026-10-08T09:30:00.000+08:00"]);
    expect(quiet!.events).toEqual([]);
  });

  test("服务从没报过：服务那一条没有；定时的那些条不带这一栏", () => {
    const state = stateWith([view()]);
    const rows = projectOperationRows(state, state.projects["p-1"]!);
    expect(rows[0]!.events).toEqual([]);
    expect(rows[1]!.events).toEqual([]);
    const timed = replay([frame("projects", 1, "project", { project: { ...project, operations: { revision: 1, confirmedAt: T, items: [{ ...waiter("x", "y"), event: { kind: "event", source: "folder", events: ["added"], filter: { path: "D:/x" } } }] } }, change: "in_use", from: "building", by: "user" } satisfies ProjectEventPayload)]);
    expect(projectOperationRows(timed, timed.projects["p-1"]!)[0]!.events).toBeUndefined();
  });
});

describe("这种事件只能写在运营方案里", () => {
  test("登记表里有，能选的来源里没有；卡上的说法用户看得懂", () => {
    expect(EVENT_SOURCES.map((s) => s.id)).toContain("service");
    expect(PICKABLE_EVENT_SOURCES.map((s) => s.id)).toEqual(["ergo", "folder"]);
    expect(describeEventTrigger({ kind: "event", source: "service", events: ["reported"], filter: { name: "评论异常" } })).toBe("项目的服务报事件「评论异常」");
  });
});
