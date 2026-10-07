// 守卫切面的测试底座：拼一份判定输入。
// 判定函数是纯函数、不碰文件系统，所以这里的路径都是虚构的固定路径，不需要真的存在。
import {
  BUILTIN_TOOL_REGISTRY,
  type DispositionFinding,
  type EffectRecord,
  type GuardAgent,
  type GuardJudgement,
  type GuardInput,
  type GuardTask,
  type SecretaryAgent,
  type ExecutingAgent,
  type ToolCall,
} from "../../../src/guard/index.ts";

/** 虚构的目录布局（Windows 路径；Git Bash 写法见 `bashPath`） */
export const P = {
  dataDir: "D:\\ergou-data",
  config: "D:\\ergou-data\\config",
  secrets: "D:\\ergou-data\\secrets",
  db: "D:\\ergou-data\\db",
  projects: "D:\\ergou-data\\projects",
  tmp: "D:\\ergou-data\\tmp",
  programDir: "D:\\ergou-app",
  home: "C:\\Users\\tester",
  /** 维护者 notes 的项目档案 */
  records: "D:\\ergou-data\\projects\\notes",
  /** 维护者 notes 的工作目录（绑定的外部路径） */
  workDir: "E:\\work\\notes",
  /** 秘书的草稿区 */
  scratch: "D:\\ergou-data\\tmp\\scratch",
  /** 项目外的某个目录 */
  outside: "E:\\elsewhere",
} as const;

/** 时间基准：2026-10-07 12:00（UTC），各测试的"现在" */
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

/** notes 项目里干活的 agent：工作目录 E:\work\notes，开着 bash 和联网 */
export function executingAgent(kind: ExecutingAgent["kind"], overrides: Partial<ExecutingAgent> = {}): GuardAgent {
  return {
    kind,
    agentId: kind === "maintainer" ? "maintainer-notes" : "sub-notes-1",
    cwd: P.workDir,
    toolkit: { bash: true, network: true },
    projectRecords: [P.records],
    workingDirs: [P.workDir],
    ...overrides,
  };
}

export const maintainer = (overrides: Partial<ExecutingAgent> = {}) => executingAgent("maintainer", overrides);
export const subAgent = (overrides: Partial<ExecutingAgent> = {}) => executingAgent("sub_agent", overrides);

export function secretary(overrides: Partial<SecretaryAgent> = {}): GuardAgent {
  return {
    kind: "secretary",
    agentId: "secretary",
    cwd: P.scratch,
    toolkit: { bash: true, network: false },
    scratchDir: P.scratch,
    ...overrides,
  };
}

/** 一个进行中的任务：当前在 s1 阶段，没有授权项 */
export function task(overrides: Partial<GuardTask> = {}): GuardTask {
  return {
    taskId: "task-1",
    currentStageId: "s1",
    plan: { grants: [] },
    ...overrides,
  };
}

export function call(toolName: string, args: Record<string, unknown> = {}): ToolCall {
  return { toolName, args };
}

export function bash(command: string): ToolCall {
  return call("bash", { command });
}

/**
 * 效果日志的一条（执行成功的调用）：默认属于 task-1 的 s1 阶段、维护者 notes 做的，时间按 seq 先后排在 NOW 之前。
 * args 要写规范化之后的形式（路径是绝对路径）。
 */
export function effect(seq: number, tool: string, args: Record<string, unknown>, overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    seq,
    taskId: "task-1",
    stageId: "s1",
    agentId: "maintainer-notes",
    tool,
    args,
    summary: tool,
    at: NOW - (100 - seq) * 60_000,
    ...overrides,
  };
}

/**
 * v1 规则模板的前提都满足：这几个仓库里都跑过测试，它们都是没有未提交改动的 git 仓库（不给时是工作目录），
 * HEAD 是之前没推送过的新提交。看关注类别、授权项这些别的东西的表格测试用它，免得被"push 之前必须跑过测试"
 * "删除或覆盖之前必须已提交"退回，或者被"不重复发"判断不了。
 */
export function v1Satisfied(...repos: string[]): Pick<GuardInput, "effectLog" | "facts"> {
  const dirs = repos.length > 0 ? repos : [P.workDir];
  return {
    effectLog: dirs.map((repoPath, i) => effect(i + 1, "run_tests", { repoPath })),
    facts: { git: Object.fromEntries(dirs.map((dir) => [dir, { uncommittedPaths: [], head: "new-commit" }])) },
  };
}

/** 对话里的一次判定输入 */
export function inChat(agent: GuardAgent, toolCall: ToolCall, extra: Partial<GuardInput> = {}): GuardInput {
  return {
    call: toolCall,
    agent,
    places: {
      dataDir: { root: P.dataDir, config: P.config, secrets: P.secrets, db: P.db, projects: P.projects },
      programDir: P.programDir,
      homeDir: P.home,
    },
    task: null,
    effectLog: [],
    settings: {},
    facts: {},
    tools: BUILTIN_TOOL_REGISTRY,
    now: NOW,
    ...extra,
  };
}

/** 任务里的一次判定输入 */
export function inTask(agent: GuardAgent, toolCall: ToolCall, extra: Partial<GuardInput> = {}): GuardInput {
  return inChat(agent, toolCall, { task: task(), ...extra });
}

/** 判定里某个类别（或底线、受保护区域……）的那条处置依据 */
export function dispositionFinding(j: GuardJudgement, id: string): DispositionFinding | undefined {
  return j.findings.find((f): f is DispositionFinding => f.kind !== "hard_refusal" && f.id === id);
}
