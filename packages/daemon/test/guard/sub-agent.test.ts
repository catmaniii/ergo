// 守卫切面：为并行派出的子 agent（20 号票）。子 agent 的装配从它的维护者收窄（sub-agents/assembly.ts），
// 判定照常走守卫的纯函数：
// - 工具包是维护者工具包的子集：维护者没有的工具（bash 关着时的 bash 和带类型的 bash 工具、MCP），子 agent 也没有；
//   维护者推进任务的工具（宣布阶段完成、提议并行……）子 agent 不给；
// - 写项目档案一律拒绝（不问），写工作目录（含自己的 worktree）照常判定，写受保护区域一律永不，读密钥区照常拒绝；
// - 按维护者所属任务的计划、子 agent 所在的阶段和授权项判定：别的阶段的授权项用不到（拉回）。
import { describe, expect, it } from "vitest";
import { GRANT_OTHER_STAGE, type Grant, type GuardAgent, judgementExecutes, judgeToolCall, type ToolCall } from "../../src/guard/index.ts";
import type { MaintainerAssembly } from "../../src/maintainers/assembly.ts";
import { MAINTAINER_ONLY_TOOLS, subAgentAssembly, subAgentGuardTask } from "../../src/sub-agents/assembly.ts";
import { bash, call, DAY, inTask, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";

/** 子 agent 的 worktree：维护者建在工作目录里 */
const WORKTREE = `${P.workDir}\\.worktrees\\a`;

/** 带类型的 bash 工具（维护者开了 bash 时有） */
const TYPED = ["git_status_diff", "git_commit", "git_merge", "git_push", "create_remote_repo", "run_tests", "install_deps", "start_build"];
/** 维护者推进任务、提议并行的工具 */
const DRIVING = ["start_stage", "complete_stage", "report_progress", "wait_for_user", "fail_task", "propose_parallel"];

/** notes 项目的维护者在执行任务：开着 bash 和联网 */
const maintainer = (overrides: Partial<MaintainerAssembly> = {}): MaintainerAssembly => ({
  cwd: P.workDir,
  toolkit: { bash: true, network: true },
  skillPaths: [],
  piTools: ["read", "write", "edit", "ls", "grep", "find", "bash"],
  hostTools: [...DRIVING, ...TYPED],
  projectRecords: [P.records],
  workingDirs: [P.workDir],
  development: true,
  ...overrides,
});

/** 子 agent 在自己的 worktree 里；代为执行的工具只有带类型的 bash 工具（维护者开了 bash 时） */
const subAgentOf = (m: MaintainerAssembly, hostTools: readonly string[] = m.toolkit.bash ? ["git_status_diff", "git_commit"] : []): GuardAgent =>
  subAgentAssembly(m, { agentId: "sa-1", cwd: WORKTREE, hostTools }).guardAgent;

const write = (path: string) => call("write", { path, content: "x" });
const read = (path: string) => call("read", { path });
const newFile = (path: string) => ({ facts: { files: { [path]: { exists: false } } } });

describe("子 agent 的工具包是维护者的子集", () => {
  it("pi 工具、bash 和联网开关照维护者的；工作目录换成子 agent 自己的，围栏还是维护者的", () => {
    const m = maintainer();
    const sub = subAgentAssembly(m, { agentId: "sa-1", cwd: WORKTREE, hostTools: ["git_commit"] });
    expect(sub.piTools).toEqual(m.piTools);
    expect(sub.toolkit).toEqual({ bash: true, network: true });
    expect(sub.guardAgent).toEqual({
      kind: "sub_agent",
      agentId: "sa-1",
      cwd: WORKTREE,
      toolkit: { bash: true, network: true, tools: [...m.piTools, "git_commit"] },
      projectRecords: [P.records],
      workingDirs: [P.workDir],
    });
  });

  // 表格：不管调用方给了什么候选，子 agent 的工具一定是维护者的子集，维护者推进任务的工具一个都没有
  const noBash = maintainer({ toolkit: { bash: false, network: true }, piTools: ["read", "write", "edit", "ls"], hostTools: DRIVING });
  const readOnly = maintainer({ toolkit: { bash: false, network: false }, piTools: ["read", "ls"], hostTools: ["submit_plan"] });
  const CASES: Array<[string, MaintainerAssembly, string[], string[]]> = [
    ["开了 bash：候选的带类型工具都给", maintainer(), TYPED, TYPED],
    ["候选里混进推进任务的工具：去掉", maintainer(), [...TYPED, ...DRIVING, "submit_plan"], TYPED],
    ["候选里有维护者没有的工具（MCP）：去掉", maintainer(), ["git_commit", "mcp_mail_send"], ["git_commit"]],
    ["维护者没开 bash：候选的带类型工具都不给", noBash, TYPED, []],
    ["只读的维护者：什么都不给", readOnly, [...TYPED, "submit_plan"], []],
  ];
  for (const [name, m, candidates, expected] of CASES) {
    it(`收窄：${name}`, () => {
      const sub = subAgentAssembly(m, { agentId: "sa-1", cwd: WORKTREE, hostTools: candidates });
      expect(sub.hostTools).toEqual(expected);
      const owned = new Set([...m.piTools, ...m.hostTools]);
      const tools = sub.guardAgent.toolkit.tools ?? [];
      expect(tools.filter((t) => !owned.has(t))).toEqual([]);
      expect(tools.filter((t) => MAINTAINER_ONLY_TOOLS.includes(t))).toEqual([]);
      expect(sub.piTools.filter((t) => !m.piTools.includes(t))).toEqual([]);
      expect(sub.toolkit).toEqual({ bash: m.toolkit.bash, network: m.toolkit.network });
    });
  }

  it("维护者推进任务、起草计划的工具和 MCP 工具，子 agent 的工具包里没有：一律拒绝，不问", () => {
    const agent = subAgentOf(maintainer());
    for (const c of [call("complete_stage", { stageId: "s1", summary: "x" }), call("propose_parallel", {}), call("submit_plan", {}), call("start_stage", { stageId: "s2" })]) {
      const j = judgeToolCall(inTask(agent, c));
      expect({ tool: c.toolName, hardRefusal: j.hardRefusal }).toEqual({ tool: c.toolName, hardRefusal: ["not_in_toolkit"] });
      expect(judgementExecutes(j)).toBe(false);
    }
  });

  it("维护者没开 bash：子 agent 也没有 bash 和带类型的 bash 工具", () => {
    const m = maintainer({ toolkit: { bash: false, network: true }, piTools: ["read", "write", "edit", "ls", "grep", "find"], hostTools: DRIVING });
    const sub = subAgentAssembly(m, { agentId: "sa-1", cwd: WORKTREE, hostTools: TYPED });
    expect(sub.piTools).not.toContain("bash");
    expect(sub.toolkit.bash).toBe(false);
    for (const c of [bash("echo hi"), call("git_commit", { message: "x" })]) {
      expect(judgeToolCall(inTask(sub.guardAgent, c)).hardRefusal).toEqual(["no_bash"]);
    }
  });

  it("维护者没开联网：子 agent 联网也被拒绝", () => {
    const agent = subAgentOf(maintainer({ toolkit: { bash: true, network: false } }));
    expect(judgeToolCall(inTask(agent, bash("curl https://example.com/a"))).hardRefusal).toEqual(["network_off"]);
  });
});

describe("子 agent 的围栏", () => {
  const agent = subAgentOf(maintainer());

  it("写自己的 worktree（相对路径落在 worktree 里）和维护者工作目录里别处：照常判定", () => {
    for (const [c, file] of [
      [write("a.txt"), `${WORKTREE}\\a.txt`],
      [write(`${WORKTREE}\\src\\b.ts`), `${WORKTREE}\\src\\b.ts`],
      [write(`${P.workDir}\\notes.md`), `${P.workDir}\\notes.md`],
    ] as Array<[ToolCall, string]>) {
      const j = judgeToolCall(inTask(agent, c, newFile(file)));
      expect({ call: c, hardRefusal: j.hardRefusal, disposition: j.disposition }).toEqual({ call: c, hardRefusal: null, disposition: "log_only" });
    }
    // bash 里在 worktree 下写文件同样照常
    expect(judgeToolCall(inTask(agent, bash("echo A > a.txt"))).hardRefusal).toBeNull();
  });

  it("写项目档案：一律拒绝（文件工具和 bash 都一样），不问用户；读项目档案照常", () => {
    for (const c of [write(`${P.records}\\spec.md`), bash(`echo x >> '${P.records}\\progress.md'`)]) {
      const j = judgeToolCall(inTask(agent, c));
      // 硬拒绝优先于一切处置：运行时直接拒绝，不出审批卡
      expect(j.hardRefusal).toEqual(["sub_agent_records"]);
      expect(judgementExecutes(j)).toBe(false);
    }
    expect(judgeToolCall(inTask(agent, read(`${P.records}\\spec.md`))).hardRefusal).toBeNull();
  });

  it("写受保护区域（配置区、密钥区、数据库区、二狗程序目录）一律永不；读密钥区照常拒绝", () => {
    for (const target of [`${P.config}\\watch-categories.json`, `${P.db}\\ergou.db`, `${P.programDir}\\package.json`]) {
      const j = judgeToolCall(inTask(agent, bash(`echo x > '${target}'`)));
      expect({ target, disposition: j.disposition }).toEqual({ target, disposition: "never" });
      expect(judgementExecutes(j)).toBe(false);
    }
    const secretsWrite = judgeToolCall(inTask(agent, bash(`echo x > '${P.secrets}\\k.txt'`)));
    expect(judgementExecutes(secretsWrite)).toBe(false);
    expect(judgeToolCall(inTask(agent, read(`${P.secrets}\\deepseek-api-key.txt`))).hardRefusal).toEqual(["secrets_area"]);
  });

  it("写维护者工作目录以外：一律拒绝", () => {
    expect(judgeToolCall(inTask(agent, write(`${P.outside}\\x.txt`))).hardRefusal).toEqual(["fence"]);
  });
});

describe("按维护者所属任务的计划、子 agent 所在的阶段和授权项判定", () => {
  const pushOrigin: Grant = { grantId: "push-origin", tool: "git_push", scope: { remote: "origin" }, stageId: "s1", grantedAt: NOW - DAY };
  const push = call("git_push", { remote: "origin", branch: "main" });
  const ready = v1Satisfied(WORKTREE);
  const agent = subAgentOf(maintainer());
  /** 维护者此刻在做 s1；子 agent 被派去做 s2 或 s1 */
  const maintainerTask = task({ currentStageId: "s1", plan: { grants: [pushOrigin] } });

  it("子 agent 的当前阶段是它被派去做的阶段（维护者在做别的阶段也一样），计划和授权项是任务的", () => {
    expect(subAgentGuardTask(maintainerTask, "s2")).toEqual({ ...maintainerTask, currentStageId: "s2" });
    expect(subAgentGuardTask(null, "s2")).toBeNull();
  });

  it("用到自己阶段的授权项：放行，标授权内", () => {
    const j = judgeToolCall(inTask(agent, push, { ...ready, task: subAgentGuardTask(maintainerTask, "s1") }));
    expect(j.withinGrant).toBe(true);
    expect(judgementExecutes(j)).toBe(true);
  });

  it("别的阶段的授权项用不到：拉回，不问用户（维护者此刻在那个阶段也一样）", () => {
    const j = judgeToolCall(inTask(agent, push, { ...ready, task: subAgentGuardTask(maintainerTask, "s2") }));
    expect(j.withinGrant).toBe(false);
    expect(j.pullBack).toEqual([GRANT_OTHER_STAGE]);
    expect(judgementExecutes(j)).toBe(false);
  });

  it("任务计划里没有的授权，子 agent 也没有：照处置先问", () => {
    const j = judgeToolCall(inTask(agent, push, { ...ready, task: subAgentGuardTask(task({ plan: { grants: [] } }), "s1") }));
    expect(j.withinGrant).toBe(false);
    expect(j.disposition).toBe("ask_first");
  });
});
