// 守卫切面的测试底座：拼一份判定输入。
// 判定函数是纯函数、不碰文件系统，所以这里的路径都是虚构的固定路径，不需要真的存在。
import {
  BUILTIN_TOOL_REGISTRY,
  type GuardAgent,
  type GuardInput,
  type GuardTask,
  type SecretaryAgent,
  type ToolCall,
  type WorkerAgent,
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

export function maintainer(overrides: Partial<WorkerAgent> = {}): GuardAgent {
  return {
    kind: "maintainer",
    agentId: "maintainer-notes",
    cwd: P.workDir,
    toolkit: { bash: true, network: true },
    projectRecords: [P.records],
    workingDirs: [P.workDir],
    ...overrides,
  };
}

export function subAgent(overrides: Partial<WorkerAgent> = {}): GuardAgent {
  return {
    kind: "sub_agent",
    agentId: "sub-notes-1",
    cwd: P.workDir,
    toolkit: { bash: true, network: true },
    projectRecords: [P.records],
    workingDirs: [P.workDir],
    ...overrides,
  };
}

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
