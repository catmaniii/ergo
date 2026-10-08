// 项目状态机（15 号票）："哪个状态能做哪个动作"只有一份（PROJECT_ACTION_RULES），守护进程据此校验，Web 据此给出入口。
import { describe, expect, test } from "vitest";
import {
  ARCHIVING_ACTIONS,
  archiveBlockedText,
  canResetMaintainer,
  emptyToolkit,
  hasOwnMaintainer,
  inboxItemProjectId,
  PROJECT_ACTIONS,
  PROJECT_STATES,
  projectActionRefusal,
  projectActions,
  projectActionTarget,
  type ProjectState,
  projectToolkit,
} from "../src/index.ts";

const project = (state: ProjectState, charterConfirmed = false) => ({ state, charterConfirmed });

describe("项目页上能做的动作", () => {
  test.each<[ProjectState, boolean, string[]]>([
    // 筹备中：放弃；立项书确认之后（稍后开工）还能开工
    ["preparing", false, ["abandon"]],
    ["preparing", true, ["start_build", "abandon"]],
    // 建设中：放弃（首个建设任务没失败、没取消时不能再开工）
    ["building", true, ["abandon"]],
    // 使用中 ⇄ 已停用，只能用户手动归档（不能"放弃"）
    ["in_use", true, ["retire", "archive"]],
    ["retired", true, ["reactivate", "archive"]],
    // 已归档：取消归档、删除（删除要二次确认）
    ["archived", true, ["unarchive", "delete"]],
  ])("%s（立项书已确认：%s）→ %j", (state, confirmed, actions) => {
    expect(projectActions(project(state, confirmed))).toEqual(actions);
  });

  test("建设中、首个建设任务失败或取消了：可以再开工一次；还在跑、做完了的不行", () => {
    expect(projectActions(project("building", true), "failed")).toEqual(["start_build", "abandon"]);
    expect(projectActions(project("building", true), "cancelled")).toEqual(["start_build", "abandon"]);
    expect(projectActions(project("building", true), "running")).toEqual(["abandon"]);
    expect(projectActions(project("building", true), "done")).toEqual(["abandon"]);
  });

  test("删除只能从已归档发起", () => {
    for (const state of PROJECT_STATES) expect(projectActions(project(state, true)).includes("delete")).toBe(state === "archived");
  });

  test("不能做时说明原因", () => {
    expect(projectActionRefusal(project("in_use", true), "abandon")).toBe("使用中的项目不能放弃（归档）（只有筹备中、建设中的能）");
    expect(projectActionRefusal(project("preparing"), "delete")).toBe("筹备中的项目不能删除（只有已归档的能）");
    expect(projectActionRefusal(project("preparing"), "start_build")).toBe("立项书还没确认，不能开工：先在立项书卡上确认");
    expect(projectActionRefusal(project("building", true), "start_build")).toBe("首个建设任务还没结束（只有它失败或取消了，才能再发起一个建设任务）");
  });
});

describe("做了动作之后", () => {
  test.each<[ProjectState, string, object | undefined]>([
    ["preparing", "start_build", { state: "building", change: "building_started" }],
    ["building", "abandon", { state: "archived", change: "abandoned", archivedFrom: "building" }],
    ["in_use", "retire", { state: "retired", change: "retired" }],
    ["retired", "reactivate", { state: "in_use", change: "reactivated" }],
    ["retired", "archive", { state: "archived", change: "archived", archivedFrom: "retired" }],
    ["archived", "delete", undefined],
  ])("%s 上 %s → %j", (state, action, target) => {
    expect(projectActionTarget({ state }, action as (typeof PROJECT_ACTIONS)[number])).toEqual(target);
  });

  test("取消归档回到归档前的状态；没记下的回到筹备中", () => {
    expect(projectActionTarget({ state: "archived", archivedFrom: "retired" }, "unarchive")).toEqual({ state: "retired", change: "unarchived" });
    expect(projectActionTarget({ state: "archived" }, "unarchive")).toEqual({ state: "preparing", change: "unarchived" });
  });

  test("除了删除，每个动作都在项目列表频道上记一种变化（重置维护者不改项目状态，不在项目动作里，16 号票）", () => {
    for (const action of PROJECT_ACTIONS) expect(projectActionTarget({ state: "archived", archivedFrom: "in_use" }, action) === undefined).toBe(action === "delete");
    expect(PROJECT_ACTIONS).not.toContain("reset_maintainer");
  });
});

describe("重置维护者和归档（16 号票）", () => {
  test("重置维护者是项目页上单独的入口（不改项目状态，不在项目动作里）：没归档的都能重置，已归档的维护者会话只读、不能", () => {
    for (const state of PROJECT_STATES) expect(canResetMaintainer({ state })).toBe(state !== "archived");
  });

  test("还有正在做或排队的工单时不能归档：放弃、归档都算归档，说法写明先完成或取消哪几个任务（同一个任务的几张工单只列一次）", () => {
    expect(ARCHIVING_ACTIONS).toEqual(["abandon", "archive"]);
    expect(
      archiveBlockedText([
        { taskId: "t-3", taskTitle: "加周报" },
        { taskId: "t-3", taskTitle: "加周报" },
        { taskId: "t-5", taskTitle: "导出账单" },
      ]),
    ).toBe("项目还有正在做或排队的工单：先完成或取消任务 t-3「加周报」、t-5「导出账单」，再归档");
    // 定时作业的一次运行（19 号票）不属于任务：写明等它做完
    expect(archiveBlockedText([{ taskId: "t-3", taskTitle: "加周报" }, { title: "定时作业：每天早上出简报" }])).toBe(
      "项目还有正在做或排队的工单：先完成或取消任务 t-3「加周报」，等定时作业的运行「定时作业：每天早上出简报」做完，再归档",
    );
  });

  test("项目的工具包：立项书确认之后才有，之前什么都不带", () => {
    const toolkit = { skills: ["pdf"], mcp: [], bash: true, network: false };
    expect(projectToolkit({ charterConfirmed: true, toolkit })).toEqual(toolkit);
    expect(projectToolkit({ charterConfirmed: false, toolkit })).toEqual(emptyToolkit());
    expect(projectToolkit({ charterConfirmed: true })).toEqual({ skills: [], mcp: [], bash: false, network: false });
  });
});

describe("别处共用的小函数", () => {
  test("待我处理事项里的项目编号", () => {
    expect(inboxItemProjectId({ data: { projectId: "p-1" } })).toBe("p-1");
    expect(inboxItemProjectId({ data: { projectId: 1 } })).toBeUndefined();
    expect(inboxItemProjectId({})).toBeUndefined();
  });

  test("任务由自己的维护者执行（能转为项目），项目的任务不是", () => {
    expect(hasOwnMaintainer({ id: "t-12", maintainerId: "tm-12" })).toBe(true);
    expect(hasOwnMaintainer({ id: "t-12", maintainerId: "pm-1" })).toBe(false);
  });
});
