// 守卫切面：带类型的特殊 bash 工具的判定（28 号票）。八个工具的登记见 registries.test.ts；这里是对话和任务里的处置、
// 授权项按对象范围放行、仓库路径过围栏和受保护区域、工具包的 bash 和联网开关。用真实 git 仓库跑的序列在主切面
// （test/main/typed-shell.test.ts），守卫自己的序列在场景文件 scenarios/typed-shell-tools.guard.json。
import { describe, expect, it } from "vitest";
import { type Grant, judgeToolCall } from "../../src/guard/index.ts";
import { call, DAY, inChat, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";

const ready = v1Satisfied(P.workDir, `${P.workDir}\\wt-1`);
const grant = (grantId: string, tool: string, scope: Grant["scope"]): Grant => ({ grantId, tool, scope, stageId: "s1", grantedAt: NOW - DAY });
const withGrants = (...grants: Grant[]) => ({ ...ready, task: task({ plan: { grants } }) });

const TYPED: [string, Record<string, unknown>][] = [
  ["git_status_diff", {}],
  ["git_commit", { message: "wip" }],
  ["git_merge", { branch: "sub-1" }],
  ["git_push", { remote: "origin", branch: "main" }],
  ["create_remote_repo", { name: "notes", visibility: "private" }],
  ["run_tests", { args: ["--grep", "x"] }],
  ["install_deps", { packages: ["left-pad"] }],
  ["start_build", {}],
];

describe("处置：不用拆命令就知道落在哪些类别里", () => {
  it("[工具, 对话里, 任务里（没有授权项）]：状态和差异、跑测试、构建直接做；提交、合并、装依赖做完告诉我；推送、建远端仓库先问；都不带通用 bash 标记", () => {
    const TABLE: Record<string, [string, string]> = {
      git_status_diff: ["log_only", "log_only"],
      git_commit: ["notify_after", "notify_after"],
      git_merge: ["notify_after", "notify_after"],
      git_push: ["ask_first", "ask_first"],
      create_remote_repo: ["ask_first", "ask_first"],
      run_tests: ["log_only", "log_only"],
      install_deps: ["notify_after", "notify_after"],
      start_build: ["log_only", "log_only"],
    };
    for (const [tool, args] of TYPED) {
      const chat = judgeToolCall(inChat(maintainer(), call(tool, args), ready));
      const inTaskJ = judgeToolCall(inTask(maintainer(), call(tool, args), ready));
      expect({ tool, chat: chat.disposition, task: inTaskJ.disposition, generic: [chat.genericShell, inTaskJ.genericShell] }).toEqual({
        tool,
        chat: TABLE[tool]![0],
        task: TABLE[tool]![1],
        generic: [false, false],
      });
      const external = tool === "git_push" || tool === "create_remote_repo";
      // 任务里"以我的名义对外发送或发布"是"计划里列了才做"：没有授权项时先问
      const category = inTaskJ.findings.find((f) => f.kind === "category");
      expect({ tool, categories: inTaskJ.categories, categoryDisposition: category && "categoryDisposition" in category ? category.categoryDisposition : undefined }).toEqual({
        tool,
        categories: external ? ["external_send"] : [],
        categoryDisposition: external ? "plan_listed" : undefined,
      });
    }
  });

  it("任务里推送、建远端仓库：有覆盖它的授权项（对象范围含这个远端、这个仓库名）就放行并标授权内；范围不含或没有授权项就先问；对话里没有计划，先问", () => {
    const pushOrigin = grant("push-origin", "git_push", { remote: "origin" });
    const repoNotes = grant("repo-notes", "create_remote_repo", { name: ["notes", "notes-site"] });
    const CASES: [string, ReturnType<typeof call>, Grant[], string, boolean][] = [
      ["推送到授权的远端", call("git_push", { remote: "origin", branch: "main" }), [pushOrigin], "log_only", true],
      ["推送到别的远端", call("git_push", { remote: "backup", branch: "main" }), [pushOrigin], "ask_first", false],
      ["推送没有授权项", call("git_push", { remote: "origin", branch: "main" }), [], "ask_first", false],
      ["建授权里列了名字的仓库", call("create_remote_repo", { name: "notes-site", visibility: "public" }), [repoNotes], "log_only", true],
      ["建别的名字的仓库", call("create_remote_repo", { name: "secret-stuff" }), [repoNotes], "ask_first", false],
      ["推送的授权项不覆盖建仓库", call("create_remote_repo", { name: "notes" }), [pushOrigin], "ask_first", false],
    ];
    for (const [name, c, grants, disposition, withinGrant] of CASES) {
      const j = judgeToolCall(inTask(maintainer(), c, withGrants(...grants)));
      expect({ name, disposition: j.disposition, withinGrant: j.withinGrant, genericShell: j.genericShell }).toEqual({ name, disposition, withinGrant, genericShell: false });
    }
    const chat = judgeToolCall(inChat(maintainer(), call("git_push", { remote: "origin", branch: "main" }), ready));
    expect(chat.disposition).toBe("ask_first");
  });
});

describe("仓库路径过路径围栏", () => {
  it("工作目录（含建在里面的 worktree，相对路径相对工作目录）之内照常判定；工作目录之外落入'越出项目目录'", () => {
    for (const [tool, args] of TYPED) {
      const inside = judgeToolCall(inTask(maintainer(), call(tool, { ...args, repoPath: "wt-1" }), ready));
      expect({ tool, categories: inside.categories.filter((c) => c === "outside_project") }).toEqual({ tool, categories: [] });
      const outside = judgeToolCall(inTask(maintainer(), call(tool, { ...args, repoPath: P.outside }), v1Satisfied(P.outside)));
      expect({ tool, categories: outside.categories.includes("outside_project") }).toEqual({ tool, categories: true });
    }
  });

  it("仓库路径落在受保护区域（配置区、密钥区、数据库区、二狗程序目录）：会往仓库里写的（推送更新远端跟踪分支、建远端仓库加远端）一律永不", () => {
    for (const tool of ["git_commit", "git_merge", "git_push", "create_remote_repo", "run_tests", "install_deps", "start_build"]) {
      const args = TYPED.find(([t]) => t === tool)![1];
      for (const area of [P.config, P.secrets, P.db, P.programDir]) {
        const j = judgeToolCall(inTask(maintainer(), call(tool, { ...args, repoPath: area }), v1Satisfied(area)));
        expect({ tool, area, disposition: j.disposition }).toEqual({ tool, area, disposition: "never" });
      }
    }
  });

  it("只读的状态和差异：受保护区域按 03 号票的规则——密钥区连读都硬拒绝，别处是'越出项目目录'", () => {
    const secrets = judgeToolCall(inTask(maintainer(), call("git_status_diff", { repoPath: P.secrets }), v1Satisfied(P.secrets)));
    expect(secrets.hardRefusal).toEqual(["secrets_area"]);
    for (const area of [P.config, P.db, P.programDir]) {
      const j = judgeToolCall(inTask(maintainer(), call("git_status_diff", { repoPath: area }), v1Satisfied(area)));
      expect({ area, categories: j.categories, hardRefusal: j.hardRefusal }).toEqual({ area, categories: ["outside_project"], hardRefusal: null });
    }
  });
});

describe("工具包", () => {
  it("bash 关着：八个工具一个都用不了（硬拒绝，不看工具白名单）", () => {
    for (const [tool, args] of TYPED) {
      const j = judgeToolCall(inTask(maintainer({ toolkit: { bash: false, network: true, tools: ["read", tool] } }), call(tool, args), ready));
      expect({ tool, hardRefusal: j.hardRefusal }).toEqual({ tool, hardRefusal: ["no_bash"] });
    }
  });

  it("bash 开着时不看工具白名单（白名单里没列也能用）", () => {
    const j = judgeToolCall(inTask(maintainer({ toolkit: { bash: true, network: true, tools: ["read"] } }), call("git_commit", { message: "x" }), ready));
    expect(j.hardRefusal).toBeNull();
  });

  it("联网关着：推送、建远端仓库、装依赖硬拒绝，说明写明要开联网；别的照常", () => {
    const offline = maintainer({ toolkit: { bash: true, network: false } });
    for (const [tool, args] of TYPED) {
      const j = judgeToolCall(inTask(offline, call(tool, args), ready));
      const needsNetwork = ["git_push", "create_remote_repo", "install_deps"].includes(tool);
      expect({ tool, hardRefusal: j.hardRefusal, explained: /要联网，但工具包的联网开关关着.*开联网/.test(j.explanation) }).toEqual({
        tool,
        hardRefusal: needsNetwork ? ["network_off"] : null,
        explained: needsNetwork,
      });
    }
  });
});
