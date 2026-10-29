// Claude Code 运行时（287 号票，issue 24 方案 2.1、2.4）：维护者用本机的 Claude Code 跑会话。插件在数据契约里把它登记进运行时的
// 登记表（runtime/runtimes.ts 的 AgentRuntime，286 号票的"运行时"贡献点）。
// - 子进程入口 child/main.ts：守护进程用 process.execPath 拉起，每个会话一个；里面用 Agent SDK 的 query()（流式输入）驱动 claude，
//   把宿主协议翻成 SDK 调用、把 SDK 事件翻回宿主协议（child/session.ts、child/translator.ts）。守护进程里别的代码不 import 子进程的模块，
//   SDK 只在子进程里用（ADR-0001 的封装边界照旧）。
// - 能力清单照实写：这一张做了插话、压缩、思考档位（SDK 有 effort，289 号票接 ⚙）、斜杠命令转交（输入原样交给 Claude Code，
//   不加 client_composed）、接管已有会话（290 号票）、交给官方 App 再收回来（292 号票，remote-control.ts）；换模型写交接摘要留给后面的票；
// - 293 号票：撤回（对话按 SDK 的 forkSession 从撤回点之前分叉出新的 Claude 会话接着用，记下撤回前的会话 id）、切到废弃分支（接着那条分支的
//   会话 id）能做；撤回时把 Claude 自己的 Write、Edit 改过的文件按文件检查点恢复到撤回点（rewind_files，Bash 改的追不到）；分支摘要它自己不写
//   （branch_summary 是 false：Claude 子进程里没有 pi 的生成函数），由二狗按自己记下的事件、用维护者的二狗模型写好交给子进程（child/navigation.ts）；
//   彻底删除改写会话不做（Claude 的会话文件是内部格式，用户定"现阶段不管"）；做完这一步停下不需要：工具包变了当场换（291 号票，live_toolkit：
//   宿主协议 toolkit，进程内 MCP 服务的工具清单当场换、skill 重拼插件目录再叫 SDK 重新加载）；范围审视不在 Claude 的会话里做。
// - 309 号票：范围审视做得成（scope_review 是 true）——由二狗按自己记下的事件另起一次（recordedScopeReview）：压缩之前子进程的 PreCompact 钩子报
//   compacting，守护进程审视要压缩掉的那段；工单结束时守护进程自己审视，不给子进程送 scope_review。审视用二狗的审视模型、pi 的同一套提示和结果格式。
// - 291 号票：工具包里的 skill 在 Claude Code 里的斜杠命令（toolkitSkillCommands：/ergo:<目录名>，和子进程拼插件目录同一套名字，skill-plugin.ts），
//   输入框的 / 补全按它列。
// - 310 号票：内置命令的说明表（commandText）：语言文件 claudeCode.json 的 claudeCode.commands.<命令名>、claudeCode.commandHints.<命令名>，
//   只查现在这种语言自己的（不退到中文），输入框的 / 补全用它换掉 Claude Code 报的英文；表里没有的由二狗的模型翻。
// - 可选的模型、设置项（权限模式、思考档位）在 settings.ts（289 号票）：⚙ 里按它们列，选的值经装配参数 runtimeOptions 交给子进程；
//   模型列表以子进程报回的 Claude Code 自己的为准（宿主协议 runtime_catalog，登记表记着），还没报过时先列三个别名；
//   列能接管的会话 290 号票加：sessions.ts（列本机会话、正被占着的写明、核对、分叉、前情，来源可注入）。
// - 守卫（288 号票）：Claude Code 自带、二狗没装配的工具（TodoWrite、Agent、Skill、AskUserQuestion……）登记进守卫的登记表（guard-tools.ts），
//   能对上二狗工具的由子进程映射（child/guard.ts）；单次调用的超时：子代理（Agent，以前叫 Task）不按单次超时算（一次可能跑十几分钟，它里面的
//   每次调用照常各自计时，卡住的调用照样按超时中止这一轮）；问你、等你批准计划（AskUserQuestion、ExitPlanMode）也不算（等用户回答不是卡住，
//   这一轮停在"等你"，你可以点停止）；Bash、PowerShell 给 11 分钟（Claude 自己前台命令最多 10 分钟，它先到点、交回超时的结果，不至于和守护进程
//   同时到点把整轮中止）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeLocale, t } from "@ergo/protocol";
import type { RuntimeCapabilities } from "@ergo/protocol";
import type { AgentRuntime } from "../runtime/index.ts";
import { CLAUDE_CODE_RUNTIME_ID } from "./api.ts";
import { CLAUDE_FALLBACK_MODELS, claudeCodeSettings } from "./settings.ts";
import { CLAUDE_GUARD_TOOLS } from "./guard-tools.ts";
import type { ClaudeCli } from "./cli.ts";
import { claudeRemoteControl, type RemoteTiming } from "./remote-control.ts";
import { currentClaudeSession } from "./session-records.ts";
import { type ClaudeSessionSource, listResumable, sessionBusy } from "./sessions.ts";
import { pluginSkillCommand, pluginSkillNames } from "./skill-plugin.ts";

// 子进程入口和本文件同扩展名（开发时直接跑 .ts，将来构建成 .js 也对得上），同 runtime/agent-process.ts 的 PI_CHILD_ENTRY
const ownExt = path.extname(fileURLToPath(import.meta.url));
/** Claude Code 运行时的子进程入口（child/main） */
export const CLAUDE_CODE_CHILD_ENTRY = fileURLToPath(new URL(`./child/main${ownExt}`, import.meta.url));

/** 能力清单（共享协议包 RUNTIME_OPERATIONS 逐项） */
export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  interject: true,
  compact: true,
  rollback: true,
  branch_switch: true,
  branch_summary: false,
  rewind_files: true,
  model_handoff: false,
  thinking_levels: true,
  slash_passthrough: true,
  take_over: true,
  purge_rewrite: false,
  yield: false,
  live_toolkit: true,
  scope_review: true,
  remote_control: true,
};

/** Claude 的命令行工具（Bash、PowerShell）的单次超时：比 Claude 自己前台命令的上限（10 分钟）多一分钟 */
const SHELL_TOOL_TIMEOUT_MS = 11 * 60_000;

/** 运行时自带的工具单次调用的超时（null 是不按单次超时算；没写的照守护进程的默认），见文件开头 */
export const CLAUDE_CODE_TOOL_TIMEOUTS: Readonly<Record<string, number | null>> = {
  Agent: null,
  Task: null,
  AskUserQuestion: null,
  ExitPlanMode: null,
  Bash: SHELL_TOOL_TIMEOUT_MS,
  PowerShell: SHELL_TOOL_TIMEOUT_MS,
};

/** 接管已有会话用的（290 号票）：会话来源（插件在运行时才有，现取）、日志；292 号票加了跑命令行的（交给官方 App、收回）和测试调短的等待 */
export interface ClaudeTakeOverDeps {
  source(): ClaudeSessionSource;
  cli?(): ClaudeCli;
  log(line: string): void;
  remoteTiming?: Partial<RemoteTiming>;
}

/** Claude Code 运行时；entry 不给是 child/main（测试换成接假 SDK 的子进程入口）；takeOver 不给的不能真的列会话（只给边界测试用） */
export function claudeCodeRuntime(entry: string = CLAUDE_CODE_CHILD_ENTRY, takeOver?: ClaudeTakeOverDeps): AgentRuntime {
  const source = () => {
    // @i18n-ignore-next log：编程错误
    if (!takeOver) throw new Error("这个 Claude Code 运行时没接会话来源");
    return takeOver.source();
  };
  const cli = () => {
    // @i18n-ignore-next log：编程错误
    if (!takeOver?.cli) throw new Error("这个 Claude Code 运行时没接命令行");
    return takeOver.cli();
  };
  return {
    id: CLAUDE_CODE_RUNTIME_ID,
    get title() {
      return t("claudeCode.runtime.title");
    },
    entry,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    models: () => CLAUDE_FALLBACK_MODELS,
    settings: claudeCodeSettings,
    guardTools: CLAUDE_GUARD_TOOLS,
    toolTimeouts: CLAUDE_CODE_TOOL_TIMEOUTS,
    // 305 号票：新建时选工作文件夹（设置 · Claude Code 里定默认文件夹）
    workFolder: true,
    // 309 号票：范围审视由二狗按自己记下的事件另起一次（子进程里调不了二狗的审视模型）
    recordedScopeReview: true,
    // 291 号票：工具包里的 skill 拼成本地插件 ergo，斜杠命令是 /ergo:<目录名>
    toolkitSkillCommands: (skillDirs) => pluginSkillNames(skillDirs).map(pluginSkillCommand),
    // 310 号票：内置命令按用户语言的说明、参数提示
    commandText: claudeCommandText,
    // 接管已有会话（290 号票，sessions.ts）
    sessions: () => listResumable(source(), (line) => takeOver?.log(line)),
    sessionBusy: (sessionId) => sessionBusy(source(), sessionId),
    forkSession: (sessionId, cwd) => source().fork(sessionId, cwd),
    sessionHistory: (sessionId, cwd) => source().history(sessionId, cwd),
    // 交给官方 App、再收回来（292 号票，remote-control.ts）；维护者现在接着的会话看会话目录里子进程记的（session-records.ts）
    remoteControl: claudeRemoteControl({ cli, source, log: (line) => takeOver?.log(line), ...(takeOver?.remoteTiming ? { timing: takeOver.remoteTiming } : {}) }),
    currentSession: currentClaudeSession,
  };
}

/**
 * Claude Code 内置命令按现在的语言的说明、参数提示（310 号票）：查语言文件里 claudeCode.commands.<命令名>、claudeCode.commandHints.<命令名>，
 * 只认现在这种语言自己有的（不退到中文：用户加的语言没翻这几句时照 Claude Code 报的原文，再交给模型翻）；都没有是 undefined
 */
export function claudeCommandText(name: string): { description?: string; argumentHint?: string } | undefined {
  const own = activeLocale().messages;
  const description = own[`claudeCode.commands.${name}`];
  const argumentHint = own[`claudeCode.commandHints.${name}`];
  if (description === undefined && argumentHint === undefined) return undefined;
  return { ...(description === undefined ? {} : { description }), ...(argumentHint === undefined ? {} : { argumentHint }) };
}
