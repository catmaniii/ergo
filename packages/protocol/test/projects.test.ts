// 项目状态机（15 号票）："哪个状态能做哪个动作"只有一份（PROJECT_ACTION_RULES），守护进程据此校验，Web 据此给出入口。
import { describe, expect, test } from "vitest";
import {
  hasOwnMaintainer,
  inboxItemProjectId,
  PROJECT_ACTIONS,
  PROJECT_STATES,
  projectActionRefusal,
  projectActions,
  projectActionTarget,
  type ProjectState,
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

  test("除了删除，每个动作都在项目列表频道上记一种变化", () => {
    for (const action of PROJECT_ACTIONS) expect(projectActionTarget({ state: "archived", archivedFrom: "in_use" }, action) === undefined).toBe(action === "delete");
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
