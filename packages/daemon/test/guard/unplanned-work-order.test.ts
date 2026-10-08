// 守卫切面：计划外工单（规格第 9 节的表、第 12 节，17 号票）。涉及多个项目的任务的维护者执行中派出计划外的工单时，
// 这次派单作为一个伪工具调用交给守卫的判定函数（和快速动作同一种做法）：命中"计划外工单"类别，任务里默认先问我；
// 用户只能往严里调（全局设置、本任务的计划里）；计划里的授权项放不开它（先问我的类别执行时一定当场问）；用户的自定义类别也管它。
import { describe, expect, it } from "vitest";
import type { WatchCategorySettings } from "../../src/guard/index.ts";
import { judgeUnplannedWorkOrder, UNPLANNED_WORK_ORDER_TOOL } from "../../src/work-orders/unplanned.ts";
import { maintainer, NOW, P, task } from "./helpers/guard-input.ts";

const places = {
  dataDir: { root: P.dataDir, config: P.config, secrets: P.secrets, db: P.db, projects: P.projects },
  programDir: P.programDir,
  homeDir: P.home,
};

/** 任务维护者（固定工具包：不写文件、不跑 bash、不联网）在 s2 阶段派一张计划外的工单给"家电档案" */
function judge(extra: { settings?: WatchCategorySettings; plan?: Parameters<typeof task>[0] } = {}) {
  return judgeUnplannedWorkOrder({
    agent: maintainer({ agentId: "tm-1", toolkit: { bash: false, network: false }, projectRecords: [], workingDirs: [P.workDir] }),
    places,
    task: task({ currentStageId: "s2", ...extra.plan }),
    settings: extra.settings ?? {},
    project: "家电档案",
    now: NOW,
  });
}

describe("计划外工单", () => {
  it("任务里默认先问我：命中“计划外工单”类别", () => {
    expect(judge()).toEqual({ disposition: "ask_first", categories: ["计划外工单"] });
  });

  it("用户只能往严里调：全局调成永不就不派（给出原因），本任务的计划里调成交给我做也照样要确认", () => {
    const never = judge({ settings: { builtin: { unplanned_work_order: { task: "never" } } } });
    expect(never).toMatchObject({ refused: expect.stringContaining("计划外工单") });
    expect(judge({ plan: { plan: { grants: [], watchCategories: { builtin: { unplanned_work_order: "hand_over" } } } } })).toEqual({ disposition: "hand_over", categories: ["计划外工单"] });
  });

  it("计划里的授权项放不开它：先问我的类别列进授权项，执行时也照样问", () => {
    const grant = { grantId: "g1", tool: UNPLANNED_WORK_ORDER_TOOL.name, scope: {}, stageId: "s2", grantedAt: NOW - 1000 };
    expect(judge({ plan: { plan: { grants: [grant] } } })).toEqual({ disposition: "ask_first", categories: ["计划外工单"] });
  });

  it("用户的自定义类别按工具名也能匹配它，一同命中时取最严", () => {
    const settings: WatchCategorySettings = { custom: [{ id: "c-1", title: "别乱派活", match: { tools: [UNPLANNED_WORK_ORDER_TOOL.name] }, chat: "ask_first", task: "never" }] };
    expect(judge({ settings })).toMatchObject({ refused: expect.stringContaining("别乱派活") });
  });
});
