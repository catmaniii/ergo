// 守卫切面：任务里偏离计划的分级（规格第 8 节"偏离的逐级升级"，14 号票）。
// 授权内的放行（只在时间线记一笔）；"计划里列了才做"而没被授权项覆盖的分两档——计划对这个类别有授权项、只是这次超出了
// 对象范围、次数或有效期的是"超出授权"（先问用户）；计划里完全没有这个类别的授权项的是"没预料到的类别"（先问用户并暂停这一支）。
// "先问我"类别、"交给我做""永不"、对话里、被拉回的都不在这个分级里。
import { describe, expect, it } from "vitest";
import { type EffectRecord, GRANT_OTHER_STAGE, type Grant, type GuardInput, judgeToolCall, type ToolCall } from "../../src/guard/index.ts";
import { bash, call, DAY, inChat, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";
import { categoryTool, TEST_TOOLS } from "./helpers/test-tools.ts";

const pushOrigin: Grant = { grantId: "push-origin", tool: "git_push", scope: { remote: "origin" }, stageId: "s1", grantedAt: NOW - DAY };
const writeNotes: Grant = { grantId: "notes", tool: "write", scope: { path: P.workDir }, stageId: "s1", grantedAt: NOW - DAY };
const createRepo: Grant = { grantId: "repo", tool: "create_remote_repo", scope: {}, stageId: "s1", grantedAt: NOW - DAY };
/** 在项目外建一个目录：按路径落在"越出项目目录"里 */
const outsideDir: Grant = { grantId: "outside-dir", tool: "make_dir", scope: { path: `${P.outside}\\out` }, stageId: "s1", grantedAt: NOW - DAY };
const readOutside = call("read", { path: `${P.outside}\\notes.txt` });
const push = (remote = "origin") => call("git_push", { remote, branch: "main" });
// v1 模板的前提先满足（工作目录里跑过测试、都已提交），这里看的是授权项
const ready = v1Satisfied(P.workDir);
const withGrants = (...grants: Grant[]): Partial<GuardInput> => ({ task: task({ plan: { grants } }), ...ready });

/** 效果日志里一次已经生效的推送（授权项计次） */
const pushed = (seq: number): EffectRecord => ({ seq, taskId: "task-1", stageId: "s1", agentId: "maintainer-notes", tool: "git_push", args: { remote: "origin", branch: "main" }, summary: "推送了 main", at: NOW - 60_000 });

type Expect = { disposition: "log_only" | "ask_first"; deviation: "exceeds_grant" | "unanticipated" | null };
const CASES: [string, Grant[], ToolCall, Partial<GuardInput>, Expect][] = [
  ["授权内：放行，不算偏离（只在时间线记一笔）", [pushOrigin], push(), {}, { disposition: "log_only", deviation: null }],
  ["超出对象范围（计划对同一种操作有授权项）：超出授权", [pushOrigin], push("upstream"), {}, { disposition: "ask_first", deviation: "exceeds_grant" }],
  ["次数用完：超出授权", [{ ...pushOrigin, maxUses: 1 }], push(), { effectLog: [...ready.effectLog, pushed(10)] }, { disposition: "ask_first", deviation: "exceeds_grant" }],
  ["授权项过期没续：超出授权（执行到这一步再问用户）", [{ ...pushOrigin, expiresAt: NOW - 1 }], push(), {}, { disposition: "ask_first", deviation: "exceeds_grant" }],
  ["计划对这个类别有授权项（别的工具，登记在同一个类别里）：超出授权", [createRepo], push(), {}, { disposition: "ask_first", deviation: "exceeds_grant" }],
  ["计划里完全没有这个类别的授权项：没预料到的类别", [writeNotes], push(), {}, { disposition: "ask_first", deviation: "unanticipated" }],
  ["按路径判的类别：计划里有一条授权项本身落在越出项目目录（在项目外建目录），读项目外的别的文件是超出授权", [outsideDir], readOutside, {}, { disposition: "ask_first", deviation: "exceeds_grant" }],
  ["按路径判的类别：计划里的授权项都在项目里，读项目外的文件是没预料到的类别", [writeNotes], readOutside, {}, { disposition: "ask_first", deviation: "unanticipated" }],
  ["计划里一条授权项都没有：没预料到的类别", [], push(), {}, { disposition: "ask_first", deviation: "unanticipated" }],
];

describe("偏离的分级", () => {
  it.each(CASES)("%s", (_name, grants, toolCall, extra, want) => {
    const j = judgeToolCall(inTask(maintainer(), toolCall, { ...withGrants(...grants), ...extra }));
    expect({ disposition: j.disposition, deviation: j.deviation }).toEqual(want);
    expect(j.withinGrant).toBe(want.disposition === "log_only");
  });

  it("给模型的说明写明是超出授权还是没预料到的类别", () => {
    expect(judgeToolCall(inTask(maintainer(), push("upstream"), withGrants(pushOrigin))).explanation).toContain("超出授权");
    const unanticipated = judgeToolCall(inTask(maintainer(), push(), withGrants(writeNotes))).explanation;
    expect(unanticipated).toContain("计划没预料到这类操作");
    expect(unanticipated).toContain("这一支停下等用户");
  });

  it("bash 里的同一操作结论一样", () => {
    expect(judgeToolCall(inTask(maintainer(), bash("git push upstream main"), withGrants(pushOrigin))).deviation).toBe("exceeds_grant");
    expect(judgeToolCall(inTask(maintainer(), bash("git push origin main"), withGrants(writeNotes))).deviation).toBe("unanticipated");
  });
});

describe("不在偏离分级里的", () => {
  it('"先问我"类别的操作即使计划里列了授权项也当场问，不算偏离', () => {
    const install = judgeToolCall(inTask(maintainer(), bash("npm install -g left-pad"), withGrants({ grantId: "g", tool: "install_global", scope: {}, stageId: "s1", grantedAt: NOW - DAY })));
    expect(install.disposition).toBe("ask_first");
    expect(install.deviation).toBeNull();
  });

  it('"交给我做"照旧', () => {
    const pay = judgeToolCall(inTask(maintainer(), call(categoryTool("spend_money"), {}), { ...withGrants(), tools: TEST_TOOLS }));
    expect(pay.disposition).toBe("hand_over");
    expect(pay.deviation).toBeNull();
  });

  it("对话里没有计划：按先问我，不算偏离", () => {
    expect(judgeToolCall(inChat(maintainer(), push(), ready)).deviation).toBeNull();
  });

  it("用到别的阶段的授权项被拉回当前阶段：不算偏离（计入拉回次数）", () => {
    const pulled = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, stageId: "s2" })));
    expect(pulled.pullBack).toEqual([GRANT_OTHER_STAGE]);
    expect(pulled.deviation).toBeNull();
  });
});

describe("按工具名匹配的自定义类别", () => {
  const settings: GuardInput["settings"] = {
    custom: [{ id: "c-1", title: "动 docs", match: { tools: ["write"], paths: ["E:\\work\\notes\\docs"] }, chat: "ask_first", task: "plan_listed" }],
  };
  const docs = call("write", { path: "E:\\work\\notes\\docs\\a.md", content: "x" });

  it("计划里有这个工具的授权项（对象不对）：超出授权", () => {
    const j = judgeToolCall(inTask(maintainer(), docs, { ...withGrants({ ...writeNotes, scope: { path: "E:\\work\\notes\\src" } }), settings }));
    expect(j.disposition).toBe("ask_first");
    expect(j.deviation).toBe("exceeds_grant");
  });

  it("计划里没有：没预料到的类别", () => {
    expect(judgeToolCall(inTask(maintainer(), docs, { ...withGrants(), settings })).deviation).toBe("unanticipated");
  });
});
