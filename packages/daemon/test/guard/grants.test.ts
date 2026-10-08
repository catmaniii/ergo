// 守卫切面：授权项（次数、阶段、有效期、对象范围）只对"计划里列了才做"那一档起作用；授权项的修改只能收窄。
import { describe, expect, it } from "vitest";
import { GRANT_OTHER_STAGE, judgementExecutes, judgeToolCall, validateGrantChange, type EffectRecord, type Grant } from "../../src/guard/index.ts";
import { bash, call, DAY, dispositionFinding, inChat, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";
import { categoryTool, TEST_TOOLS } from "./helpers/test-tools.ts";

const pushOrigin: Grant = { grantId: "push-origin", tool: "git_push", scope: { remote: "origin" }, stageId: "s1", grantedAt: NOW - DAY };
const push = (remote = "origin") => call("git_push", { remote, branch: "main" });
// 这里看的是授权项：v1 模板的前提（工作目录和项目外那个仓库里都跑过测试、都已提交）先满足
const ready = v1Satisfied(P.workDir, P.outside);
const withGrants = (...grants: Grant[]) => ({ task: task({ plan: { grants } }), ...ready });
const writeGrant = (scope: Grant["scope"]): Grant => ({ grantId: "w", tool: "write", scope, stageId: "s1", grantedAt: NOW - DAY });

/** 效果日志里的一次推送（这里看的是授权项计次） */
function pushEffect(seq: number, overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    seq,
    taskId: "task-1",
    stageId: "s1",
    agentId: "maintainer-notes",
    tool: "git_push",
    args: { remote: "origin", branch: "main" },
    summary: "推送了 main",
    at: NOW - 60_000,
    ...overrides,
  };
}

describe("授权项放行'计划里列了才做'", () => {
  it("有一条属于当前阶段、没过期、次数没用完、对象范围覆盖它的授权项：放行，标'属于授权内'", () => {
    const j = judgeToolCall(inTask(maintainer(), push(), withGrants(pushOrigin)));
    expect(j.disposition).toBe("log_only");
    expect(j.withinGrant).toBe(true);
    expect(j.categories).toEqual(["external_send"]);
    const finding = dispositionFinding(j, "external_send")!;
    expect(finding.categoryDisposition).toBe("plan_listed");
    expect(finding.grantId).toBe("push-origin");
    expect(j.explanation).toMatch(/push-origin/);
  });

  it("bash 里的 git push 和带类型的 git_push 同名同参数，同一条授权项放行", () => {
    const j = judgeToolCall(inTask(maintainer(), bash("git push origin main"), withGrants(pushOrigin)));
    expect(j.disposition).toBe("log_only");
    expect(j.withinGrant).toBe(true);
    expect(j.genericShell).toBe(true);
  });

  it("用到不属于当前阶段的授权项（13 号票控制器的硬检查）：不按授权放行，也不问用户，拉回当前阶段", () => {
    const j = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, stageId: "s2" })));
    expect(j.withinGrant).toBe(false);
    expect(judgementExecutes(j)).toBe(false);
    expect(j.pullBack).toEqual([GRANT_OTHER_STAGE]);
    expect(j.explanation).toContain("授权项 push-origin 属于阶段 s2，当前是阶段 s1");
    expect(j.explanation).toMatch(/^退回：/);
    // 处置本身还是"先问"：拉回之后不问用户
    expect(j.disposition).toBe("ask_first");
  });

  it("别的阶段的授权项换到它自己的阶段也覆盖不了（对象范围不对）：不拉回，照常先问", () => {
    const j = judgeToolCall(inTask(maintainer(), push("upstream"), withGrants({ ...pushOrigin, stageId: "s2" })));
    expect(j.pullBack).toBeNull();
    expect(j.disposition).toBe("ask_first");
  });

  it("当前阶段有覆盖它的授权项时，别的阶段也有一条不影响放行", () => {
    const j = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, grantId: "later", stageId: "s2" }, pushOrigin)));
    expect(j.pullBack).toBeNull();
    expect(j.disposition).toBe("log_only");
  });

  it("已过期（默认有效期 7 天）：改为先问用户", () => {
    const old = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, grantedAt: NOW - 7 * DAY - 1 })));
    expect(old.disposition).toBe("ask_first");
    expect(old.explanation).toMatch(/已过期/);
    const fresh = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, grantedAt: NOW - 7 * DAY + 60_000 })));
    expect(fresh.disposition).toBe("log_only");
    const explicit = judgeToolCall(inTask(maintainer(), push(), withGrants({ ...pushOrigin, expiresAt: NOW - 1 })));
    expect(explicit.disposition).toBe("ask_first");
  });

  it("次数用完（按效果日志里实际生效的效果计数）：改为先问用户", () => {
    const grant = { ...pushOrigin, maxUses: 2 };
    const one = judgeToolCall(inTask(maintainer(), push(), { ...withGrants(grant), effectLog: [...ready.effectLog, pushEffect(1)] }));
    expect(one.disposition).toBe("log_only");
    const two = judgeToolCall(inTask(maintainer(), push(), { ...withGrants(grant), effectLog: [...ready.effectLog, pushEffect(1), pushEffect(2)] }));
    expect(two.disposition).toBe("ask_first");
    expect(two.explanation).toMatch(/次数已用完/);
  });

  it("不算次数的效果：别的任务、别的阶段、授予之前、别的工具、范围外的对象", () => {
    const grant = { ...pushOrigin, maxUses: 1 };
    const unrelated = [
      pushEffect(1, { taskId: "task-2" }),
      pushEffect(2, { stageId: "s0" }),
      pushEffect(3, { at: NOW - 2 * DAY }),
      pushEffect(4, { tool: "git_commit" }),
      pushEffect(5, { args: { remote: "upstream", branch: "main" } }),
    ];
    expect(judgeToolCall(inTask(maintainer(), push(), { ...withGrants(grant), effectLog: [...ready.effectLog, ...unrelated] })).disposition).toBe("log_only");
  });

  it("超出对象范围：改为先问用户", () => {
    const j = judgeToolCall(inTask(maintainer(), push("upstream"), withGrants(pushOrigin)));
    expect(j.disposition).toBe("ask_first");
    expect(j.explanation).toMatch(/超出对象范围/);
  });

  it("路径类的对象范围按目录匹配：越出项目目录读某个目录", () => {
    const docs: Grant = { grantId: "read-docs", tool: "read", scope: { path: "E:\\docs" }, stageId: "s1", grantedAt: NOW - DAY };
    const inside = judgeToolCall(inTask(maintainer(), call("read", { path: "E:/docs/spec/a.md" }), withGrants(docs)));
    expect(inside.disposition).toBe("log_only");
    expect(inside.withinGrant).toBe(true);
    const outside = judgeToolCall(inTask(maintainer(), call("read", { path: "E:\\docs-old\\a.md" }), withGrants(docs)));
    expect(outside.disposition).toBe("ask_first");
  });

  it("没有这项操作的授权项：先问，说明里写明计划里没有", () => {
    const j = judgeToolCall(inTask(maintainer(), push(), withGrants()));
    expect(j.disposition).toBe("ask_first");
    expect(j.explanation).toMatch(/计划里没有覆盖它的授权项/);
  });

  it("对话里没有计划，授权项不起作用", () => {
    expect(judgeToolCall(inChat(maintainer(), push(), ready)).disposition).toBe("ask_first");
  });
});

describe("'先问我'一律当场问，授权项替它放行不了", () => {
  it("任务里有一条覆盖它的授权项的'账户与安全'调用，仍判先问我", () => {
    const grant: Grant = { grantId: "g", tool: "install_global", scope: {}, stageId: "s1", grantedAt: NOW - DAY };
    const j = judgeToolCall(inTask(maintainer(), bash("npm install -g typescript"), withGrants(grant)));
    expect(j.disposition).toBe("ask_first");
    expect(j.withinGrant).toBe(false);
  });

  it("用户把'对外发送'在任务里调到'先问我'后，同样的调用即使有授权项也判先问我", () => {
    const settings = { builtin: { external_send: { task: "ask_first" as const } } };
    const j = judgeToolCall(inTask(maintainer(), push(), { ...withGrants(pushOrigin), settings }));
    expect(j.disposition).toBe("ask_first");
    expect(j.withinGrant).toBe(false);
  });

  it("一条调用里授权项放行的部分和别的类别取最严", () => {
    const testTools = { tools: TEST_TOOLS };
    const all: Grant = { grantId: "all", tool: "git_push", scope: {}, stageId: "s1", grantedAt: NOW - DAY };
    // 推送放行 + 删除（做完告诉我）→ 做完告诉我，仍属于授权内
    const notify = judgeToolCall(inTask(maintainer(), bash("rm -rf build && git push"), { ...withGrants(all), ...testTools }));
    expect(notify.disposition).toBe("notify_after");
    expect(notify.withinGrant).toBe(true);
    // 推送放行 + 全局装软件（先问我）→ 先问我，不算授权内
    const ask = judgeToolCall(inTask(maintainer(), bash("git push && npm i -g x"), withGrants(all)));
    expect(ask.disposition).toBe("ask_first");
    expect(ask.withinGrant).toBe(false);
    // 没有类别的工具：授权项无关
    expect(judgeToolCall(inTask(maintainer(), call(categoryTool("unknown_write"), { target: "x" }), { ...withGrants(all), ...testTools })).withinGrant).toBe(false);
  });

  it("项目外的读写一并授权：越出项目目录的 bash 命令", () => {
    const grant: Grant = { grantId: "copy-out", tool: "copy", scope: { to: `${P.outside}` }, stageId: "s1", grantedAt: NOW - DAY };
    const j = judgeToolCall(inTask(maintainer(), bash("cp report.md /e/elsewhere/report.md"), withGrants(grant)));
    expect(j.disposition).toBe("log_only");
    expect(j.withinGrant).toBe(true);
  });
});

describe("授权项不跨类别放行：命中的每个类别都要各自被覆盖", () => {
  const migrations = {
    custom: [{ id: "migrations", title: "动迁移目录", match: { paths: [`${P.workDir}\\db`] }, chat: "ask_first" as const, task: "plan_listed" as const }],
  };
  const newFile = { files: { [`${P.workDir}\\db\\001.sql`]: { exists: false } } };

  // [说明, 调用, 授权项, 额外输入, 处置, 被授权项放行的类别, 没被覆盖的类别]
  const TABLE: [string, ReturnType<typeof call>, Grant[], object, string, string[], string[]][] = [
    ["只管远端的推送授权项：放不了仓库路径在项目外的推送", call("git_push", { remote: "origin", repoPath: P.outside }), [pushOrigin], {}, "ask_first", ["external_send"], ["outside_project"]],
    ["同上，bash 里 cd 到项目外再推送", bash("cd /e/elsewhere && git push origin main"), [pushOrigin], {}, "ask_first", ["external_send"], ["outside_project"]],
    [
      "对象范围也管到仓库路径：两类都放行",
      call("git_push", { remote: "origin", repoPath: P.outside }),
      [{ ...pushOrigin, scope: { remote: "origin", repoPath: P.outside } }],
      {},
      "log_only",
      ["external_send", "outside_project"],
      [],
    ],
    [
      "不限对象的推送授权项：管不到项目外的仓库路径",
      call("git_push", { remote: "origin", repoPath: P.outside }),
      [{ ...pushOrigin, scope: {} }],
      {},
      "ask_first",
      ["external_send"],
      ["outside_project"],
    ],
    ["不限对象的读授权项：管不到项目外的路径", call("read", { path: `${P.outside}\\a.txt` }), [writeGrant({}), { ...writeGrant({}), grantId: "r", tool: "read" }], {}, "ask_first", [], ["outside_project"]],
    ["自定义类别按路径命中：授权项不管路径就放不了", call("write", { path: "db/001.sql", content: "x" }), [writeGrant({})], { settings: migrations, facts: newFile }, "ask_first", [], ["migrations"]],
    ["自定义类别按路径命中：授权项管到这个目录就放行", call("write", { path: "db/001.sql", content: "x" }), [writeGrant({ path: `${P.workDir}\\db` })], { settings: migrations, facts: newFile }, "log_only", ["migrations"], []],
  ];

  for (const [name, c, grants, extra, disposition, covered, uncovered] of TABLE) {
    it(`${name}`, () => {
      const j = judgeToolCall(inTask(maintainer(), c, { ...withGrants(...grants), ...extra }));
      expect(j.disposition).toBe(disposition);
      expect(j.withinGrant).toBe(disposition === "log_only");
      for (const id of covered) expect({ id, grantId: dispositionFinding(j, id)?.grantId }).toEqual({ id, grantId: expect.any(String) });
      for (const id of uncovered) {
        const f = dispositionFinding(j, id);
        expect({ id, disposition: f?.disposition, grantId: f?.grantId }).toEqual({ id, disposition: "ask_first", grantId: undefined });
      }
    });
  }

  it("说明里写明没覆盖的是哪一类、为什么", () => {
    const j = judgeToolCall(inTask(maintainer(), call("git_push", { remote: "origin", repoPath: P.outside }), withGrants(pushOrigin)));
    expect(j.explanation).toMatch(/越出项目目录.*对象范围没管到 repoPath/);
  });
});

describe("校验授权项的修改：收窄通过，放宽被拒", () => {
  const base: Grant = {
    grantId: "g1",
    tool: "git_push",
    scope: { remote: ["origin", "backup"], repoPath: "E:\\work\\notes" },
    maxUses: 3,
    stageId: "s1",
    grantedAt: NOW,
    expiresAt: NOW + 5 * DAY,
  };

  const NARROWER: [string, Grant[]][] = [
    ["原样不变", [base]],
    ["次数变少", [{ ...base, maxUses: 1 }]],
    ["提前到期", [{ ...base, expiresAt: NOW + DAY }]],
    ["对象少一个", [{ ...base, scope: { ...base.scope, remote: "origin" } }]],
    ["路径收进子目录", [{ ...base, scope: { ...base.scope, repoPath: "E:\\work\\notes\\sub" } }]],
    ["多加一个限制条件", [{ ...base, scope: { ...base.scope, branch: "main" } }]],
    ["删掉这条授权项", []],
  ];
  for (const [name, after] of NARROWER) {
    it(`收窄：${name}`, () => {
      expect(validateGrantChange([base], after)).toEqual({ ok: true, problems: [] });
    });
  }

  const WIDER: [string, Grant[]][] = [
    ["次数变多", [{ ...base, maxUses: 4 }]],
    ["去掉次数上限", [{ ...base, maxUses: undefined }]],
    ["延后到期", [{ ...base, expiresAt: NOW + 6 * DAY }]],
    ["去掉到期时间（默认 7 天比原来晚）", [{ ...base, expiresAt: undefined }]],
    ["多一个对象", [{ ...base, scope: { ...base.scope, remote: ["origin", "backup", "upstream"] } }]],
    ["路径放大到上级目录", [{ ...base, scope: { ...base.scope, repoPath: "E:\\work" } }]],
    ["去掉一个限制条件", [{ ...base, scope: { remote: base.scope.remote! } }]],
    ["换了工具", [{ ...base, tool: "create_remote_repo" }]],
    ["换了阶段", [{ ...base, stageId: "s2" }]],
    ["新加一条授权项", [base, { ...base, grantId: "g2" }]],
  ];
  for (const [name, after] of WIDER) {
    it(`放宽：${name}`, () => {
      const result = validateGrantChange([base], after);
      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/g[12]/);
    });
  }
});
