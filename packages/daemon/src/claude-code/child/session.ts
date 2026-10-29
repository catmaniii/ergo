// Claude Code 适配子进程里的一个会话（287 号票，issue 24 方案 2.4）：一个 Agent SDK 的 query()（流式输入），宿主协议的命令翻成往里推的
// 用户消息和控制调用，SDK 的消息经 translator.ts 翻回宿主协议，这里管轮次、压缩、打断和会话记录。
//
// 对照（宿主协议 → SDK）：
// - start / ready：按装配参数选会话（records.ts：新开时自己定会话 id，SDK 的 sessionId；接着时 resume），拉起 query 就报 ready
//   （claude 起没起来、登没登录，第一轮才知道：出错时这一轮按出错收尾）；
// - user_input（含图片、跟在后面的上下文）：推一条用户消息（图片是 image 块）；斜杠命令原样交给 Claude Code（不加 client_composed）；
// - interject：推一条 priority: "next" 的用户消息——Claude Code 在手头的工具调用做完后并进同一轮；
// - abort：interrupt()；compact：推一条 "/compact"，等 compact_boundary 和这一轮的 result；
// - turn_end：result（每轮恰好一条）。插话来晚了没赶上这一轮的，Claude Code 会接着另起一轮（result 的 queued_turn_count 大于 0），
//   二狗这边并进同一轮、等后面那条 result 才算结束（中途注入的输入并进同一轮，调研 32 第 6.1 节）；收下了哪些插话按 result 的
//   user_message_uuids 认（每条用户消息带二狗定的 uuid）。
// 用 Claude Code 自己的配置（用户 2026-10-25 第 3 条）：settingSources 加载用户、项目、本地三层设置（CLAUDE.md、技能、MCP、钩子照常），
// 系统提示用 Claude Code 自己的（preset: claude_code），二狗的系统提示追加在末尾（append）；snapshot: false——不录下系统提示、每次请求现渲染，
// 恢复的会话里追加的这段当场生效（等同命令行的 --system-prompt-snapshot off，调研 35 第 7 步；代价是追加的内容变了那一次缓存不命中）。
// 交给 claude 的环境去掉 ANTHROPIC_API_KEY（env.ts）。守卫（288 号票，guard.ts）：装配打开了 forwardToolCalls（正式的会话都开）时交给 SDK
// 二狗的 PreToolUse 钩子（全量闸口：每次工具调用发 guard_request、等判定，子代理里的也过）和 canUseTool（Claude 自己要问的：AskUserQuestion、
// 退出计划模式变成二狗的提问卡，别的守卫放行过的直接放行）；没打开（只有测试里直接拉起的）照 287 号票用 permissionPrompts: "none"——
// Claude Code 自己的权限模式、规则、钩子照常判，要问人的一律拒绝。
// SDK 的坑（调研 32 第 6.1 节）：消费循环绝不在 result 处 break（break 会结束整个会话）；出错的 result 之后迭代器可能 throw，
// 循环 try/catch——query 结束了就记着，下一条输入按会话 id 恢复一个新的；不认得的消息一律不管。
// 不读 Claude Code 的会话记录（超大会话不整个读：这一张根本不读；290 号票接管时只读尾部）。
// 289 号票：维护者在 ⚙ 里给 Claude Code 选的模型、权限模式、思考档位（装配参数 runtimeOptions）翻成 query 的 model、permissionMode、effort
// （../settings.ts，没选的用 Claude Code 自己的设置）；query 起来后报一次 Claude Code 自己的模型列表和斜杠命令清单（runtime_catalog：
// supportedModels / supportedCommands），每轮开头的 system/init、中途的 commands_changed 再按它报命令；换运行时之前的 write_handoff：
// 推一条请 Claude 写交接摘要的消息，这一轮的回复不当成回复，最后的 result 文字就是摘要。
// 291 号票（二狗的工具和上下文交给 Claude Code）：
// - 二狗的工具（装配参数 contributions.tools）经进程内 MCP 服务交给 Claude（host-tools.ts，query 的 mcpServers），调用转成 host_tool_call；
// - 进上下文不显示的（上下文块、跟在输入后面的上下文、系统提示后缀和近期范围记录）经 UserPromptSubmit / SessionStart 钩子的 additionalContext
//   交给模型（context.ts）；跟在输入后面的上下文不再是用户消息里的一块文字；
// - 工具包里的 skill 拼成本地插件目录交给 query 的 plugins（../skill-plugin.ts，在装配参数 runtimeDir 里；二狗不写 ~/.claude、项目的 .claude/）；
// - 工具包当场换（宿主协议 toolkit）：MCP 服务的工具清单当场换（服务有增减时 setMcpServers），skill 有变重拼插件目录、叫 SDK 的
//   reloadPlugins 当场生效（报回刷新后的斜杠命令；重新加载不成的下一个 query 起来时照新目录加载），"工具包已变更"在下一次工具结果或下一条输入时
//   交给模型；回合不停下、不重新拉起；
// - 追加的系统提示后面补一句二狗的工具在这里叫什么（维护者的系统提示是按 pi 写的，287 号票留的④）。
// 293 号票（撤回和分支，navigation.ts）：query 一律开文件检查点（enableFileCheckpointing）；每条输入记下推进了哪个 Claude 会话、二狗给它定的
// uuid、那个会话里上一条（records.ts 的 lineage）；navigate_session 按 navigation.ts 分叉出新会话、按检查点恢复文件、切到废弃分支的会话，
// 换会话时关掉手头的 query（下一条输入按新的会话 id 起）；守护进程写好的分支摘要在新会话的下一条输入的 UserPromptSubmit 钩子交给模型。
// 309 号票（范围审视由二狗另起）：装配了范围审视的会话交给 SDK 一个 PreCompact 钩子，压缩之前报 compacting（手动 / 自动），守护进程按自己记下的
// 事件另起一次审视要压缩掉的那段；钩子不等它、不拦压缩。
// @i18n-ignore-file log：子进程的日志（守护进程记进日志）
import { randomUUID, type UUID } from "node:crypto";
import fs from "node:fs";
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput, McpServerConfig, Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type RuntimeQuestionReply, t } from "@ergo/protocol";
import {
  type AgentReport,
  type CompactedReport,
  errorReport,
  type HostCommand,
  type GuardVerdict,
  type HostToolResult,
  type HostToolSpec,
  type InputImage,
  type LoadedResources,
  type SessionAssembly,
  type SessionContextInfo,
  type SessionModel,
  type TurnOutcome,
} from "../../runtime/host-protocol.ts";
import { claudeQueryChoices } from "../settings.ts";
import { buildSkillPlugin, pluginSkillCommand } from "../skill-plugin.ts";
import { ClaudeContext } from "./context.ts";
import { claudeProcessEnv } from "./env.ts";
import { ClaudeGuard } from "./guard.ts";
import { ERGO_MCP_SERVER, HostToolBridge } from "./host-tools.ts";
import { type ClaudeLineage, type ClaudeRewindResult, type ClaudeSessionOps, emptyLineage, navigateClaude } from "./navigation.ts";
import { type OpenedRecord, openSessionRecord, writeRecord } from "./records.ts";
import { ClaudeTranslator, usageOf, usageReport } from "./translator.ts";

/** 适配子进程用到的 SDK 的那一点：query()（流式输入）交回的会话。真的 query 满足它，契约测试换成按剧本吐事件的假实现 */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Claude Code 现在能用的斜杠命令（289 号票：输入框的候选）；假 SDK 可以不给 */
  supportedCommands?(): Promise<ReadonlyArray<{ name: string; description: string; argumentHint?: string }>>;
  /** Claude Code 能选的模型（289 号票：⚙ 的模型列表）；假 SDK 可以不给 */
  supportedModels?(): Promise<ReadonlyArray<{ value: string; displayName: string }>>;
  /** 会话中途换动态的 MCP 服务（291 号票：工具包加减了 MCP，进程内服务有增减）；假 SDK 可以不给 */
  setMcpServers?(servers: Record<string, McpServerConfig>): Promise<unknown>;
  /** 从盘上重新加载插件（291 号票：工具包里的 skill 变了、插件目录重拼过），交回刷新后的斜杠命令；假 SDK 可以不给 */
  reloadPlugins?(): Promise<{ commands?: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> }>;
  /** 按文件检查点把 Write、Edit 改过的文件恢复到某条用户消息时（293 号票，要开 enableFileCheckpointing）；假 SDK 可以不给 */
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<ClaudeRewindResult>;
}

export type ClaudeQueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

export interface ClaudeSessionDeps {
  query: ClaudeQueryFunction;
  /** 适配子进程自己的环境（交给 claude 之前去掉 ANTHROPIC_API_KEY 等，env.ts） */
  env: Readonly<Record<string, string | undefined>>;
  /** 本机的 claude.exe（env.ts 的 findClaudeExecutable）；没有是用 SDK 自带的 */
  executable?: string;
  /** 撤回要用的 SDK 会话函数（293 号票：forkSession、getSessionMessages）；不给的撤回不了（回原因） */
  sessions?: ClaudeSessionOps;
  log: (line: string) => void;
  now?: () => Date;
}

/** 还不知道模型的上下文窗口时报的（第一轮之后按 result 的 modelUsage 记进会话记录） */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** 打断之后等这一轮的 result 最多多久，到点还没来就按被打断收尾 */
const ABORT_GRACE_MS = 15_000;
/** 子进程收尾时等打断多久 */
const DISPOSE_INTERRUPT_MS = 3_000;
/** Claude Code 说"没什么可压的" */
const NOTHING_TO_COMPACT = /not enough messages|nothing to compact/i;

type Phase =
  | { kind: "idle" }
  | {
      kind: "turn";
      inputId: string;
      /** 这一轮收进来的插话（输入 id、二狗给那条用户消息定的 uuid），按先后 */
      interjections: Array<{ inputId: string; uuid: string }>;
      /** Claude Code 说已经收进这一轮的用户消息的 uuid（result、assistant 上的 user_message_uuids） */
      consumed: Set<string>;
      aborting: boolean;
      abortTimer?: NodeJS.Timeout;
      /** 这一轮是用户自己打的 /compact（压缩失败时 compacted 的 reason 写 manual） */
      slashCompact: boolean;
    }
  | { kind: "compacting"; preTokens?: number; failure?: string; output: string[]; aborting: boolean; done: () => void }
  /** 换运行时之前写交接摘要（289 号票）：这一轮的回复不当成回复，result 的文字就是摘要 */
  | { kind: "handoff"; requestId: string; timer: NodeJS.Timeout; timeoutMs: number; timedOut: boolean; aborting: boolean; done: () => void };

/** 写交接摘要那一轮交给 Claude 的话：守护进程给的写法（prompts/handoff-summary.md 填好值）前面说清这是要干什么 */
function handoffPrompt(instructions: string): string {
  // @i18n-ignore-next model：交给 Claude 的话照旧中文
  return `这个对话要交给另一个 agent 接着做（换运行时）。请写一份交接摘要：只回摘要本身，不调用工具、不做别的事。\n\n${instructions}`;
}

/** 推进 query 的用户消息队列（流式输入）：close 之后迭代结束，claude 的输入关掉 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class ClaudeSessionRunner {
  private readonly translator: ClaudeTranslator;
  /** 守卫（288 号票）：装配打开了 forwardToolCalls 才有 */
  private readonly guard: ClaudeGuard | undefined;
  /** 二狗的工具（291 号票）：进程内 MCP 服务 */
  private readonly tools: HostToolBridge;
  /** 进上下文不显示的内容（291 号票）：钩子的 additionalContext */
  private readonly context: ClaudeContext;
  /** 工具包里的 skill 的目录（291 号票：拼本地插件用；宿主协议 toolkit 整份换） */
  private skillPaths: readonly string[];
  /** 拼好的本地插件根目录（没有运行时目录、拼不成是 undefined） */
  private pluginRoot: string | undefined;
  private readonly opened: OpenedRecord;
  private query: ClaudeQuery | undefined;
  private input: InputQueue | undefined;
  private phase: Phase = { kind: "idle" };
  private idleWaiters: Array<() => void> = [];
  private disposing = false;
  private turnSeq = 0;
  private compactionSeq = 0;
  /** Claude Code 报过的斜杠命令的说明（system/init 只给名字：按名字补上 supportedCommands 给过的说明） */
  private readonly commandInfo = new Map<string, { description: string; argumentHint?: string }>();
  /** 这个 query 里主线上最近的一条（assistant、工具结果、二狗推的用户消息）的 uuid（293 号票：交下一条输入时记成它的"上一条"） */
  private lastChainUuid: string | undefined;

  private readonly assembly: SessionAssembly;
  private readonly emit: (report: AgentReport) => void;
  private readonly deps: ClaudeSessionDeps;

  private constructor(assembly: SessionAssembly, emit: (report: AgentReport) => void, deps: ClaudeSessionDeps) {
    this.assembly = assembly;
    this.emit = emit;
    this.deps = deps;
    this.translator = new ClaudeTranslator(emit);
    this.tools = new HostToolBridge({
      emit,
      interjected: () => this.interjectedSoFar(),
      resolveId: (claudeName) => this.translator.openCallId(claudeName),
      log: deps.log,
    });
    this.tools.setTools(assembly.contributions.tools);
    this.context = new ClaudeContext(assembly.contributions, assembly.scopeReview?.recentRecords, deps.log);
    this.skillPaths = assembly.skillPaths;
    if (assembly.forwardToolCalls) {
      const guard = new ClaudeGuard({
        emit,
        ensureStarted: (id, name, args) => this.translator.ensureStarted(id, name, args),
        ownTool: (claudeName) => this.ownTool(claudeName),
        log: deps.log,
      });
      this.translator.takePrefix = (id) => guard.takePrefix(id);
      this.guard = guard;
    }
    this.opened = openSessionRecord(assembly, deps.now);
  }

  /** 选好会话、拉起 query（之后报 ready） */
  static open(assembly: SessionAssembly, emit: (report: AgentReport) => void, deps: ClaudeSessionDeps): ClaudeSessionRunner {
    const runner = new ClaudeSessionRunner(assembly, emit, deps);
    const { record, name, existing } = runner.opened;
    deps.log(
      `Claude Code 会话 ${name}：${record.started ? `恢复 ${record.claudeSessionId}` : `新开 ${record.claudeSessionId}`}${existing ? "（接着已有的）" : ""}，` +
        `claude ${deps.executable ?? "用 SDK 自带的"}`,
    );
    // 先起好（claude 冷启动要几秒）；起不来的等第一条输入时再试，那一轮按出错收尾
    runner.tryEnsureQuery();
    return runner;
  }

  get sessionId(): string {
    return this.opened.record.claudeSessionId;
  }

  get session(): string {
    return this.opened.name;
  }

  get sessionFile(): string {
    return this.opened.file;
  }

  /** Claude Code 自己装配资源（CLAUDE.md、技能、MCP……），这里不知道，都报空的 */
  get loaded(): LoadedResources {
    return { tools: [], skills: [], contextFiles: [], extensions: [], credentialProviders: [] };
  }

  /** 模型用 Claude Code 自己的设置（这一张不传 model，289 号票接 ⚙）；跑过一轮之后会话记录里记着 system/init 报的 */
  get model(): SessionModel {
    return { provider: "claude-code", modelId: this.opened.record.model ?? "default", thinkingLevel: this.assembly.model.thinkingLevel, pinned: this.opened.existing };
  }

  get contextInfo(): SessionContextInfo {
    return { window: this.opened.record.contextWindow ?? DEFAULT_CONTEXT_WINDOW, reserveTokens: 0, keepRecentTokens: 0 };
  }

  prompt(inputId: string, text: string, images: InputImage[], context?: string): void {
    if (this.phase.kind !== "idle") {
      this.emit(errorReport("busy", "上一轮还没结束", false, inputId));
      return;
    }
    const input = this.tryEnsureQuery();
    if (!input.ok) {
      // query 都起不来（SDK 当场报错）：这一轮按出错收尾，不让守护进程干等
      this.emit({ type: "turn_end", outcome: "error", errorMessage: input.error });
      return;
    }
    const uuid = randomUUID();
    this.phase = { kind: "turn", inputId, interjections: [], consumed: new Set([uuid]), aborting: false, slashCompact: /^\/compact\b/.test(text.trim()) };
    this.turnSeq += 1;
    this.translator.beginTurn();
    // 293 号票：记下这条输入推进了哪个会话（撤回到它之前要），撤回后还没交给模型的分支摘要跟着它交
    const note = this.noteInput(inputId, uuid, true);
    // 跟在这条输入后面的上下文、上下文块经它的 UserPromptSubmit 钩子交给模型（291 号票），不放进用户消息
    this.context.beginPrompt(note === undefined ? context : context ? `${note}\n\n${context}` : note);
    this.lastChainUuid = uuid;
    input.queue.push(userMessage(uuid, text, images));
  }

  interject(inputId: string, text: string, images: InputImage[]): void {
    const phase = this.phase;
    if (phase.kind !== "turn" || phase.aborting || !this.input) {
      this.emit(errorReport("bad_command", "没有进行中的回合，插话没收下", false, inputId));
      return;
    }
    const uuid = randomUUID();
    phase.interjections.push({ inputId, uuid });
    // 293 号票：插话也记下（撤回到它之前时按主线找它的上一条）
    this.noteInput(inputId, uuid, false);
    this.input.push(userMessage(uuid, text, images, "next"));
  }

  /**
   * 在 Claude 的会话之间挪（293 号票，宿主协议 navigate_session，navigation.ts）：手头有一轮先打断、等它收尾（守护进程已经停稳，这里再看一眼），
   * 结果以 session_navigated 报回。做完才处理排在后面的命令
   */
  async navigate(command: Extract<HostCommand, { type: "navigate_session" }>): Promise<void> {
    if (this.phase.kind !== "idle") {
      await this.abort();
      await this.whenIdle();
    }
    const report = await navigateClaude(
      {
        current: () => this.opened.record.claudeSessionId,
        lineage: this.lineage(),
        ops: this.deps.sessions,
        rewindIn: (session, uuid) => this.rewindIn(session, uuid),
        switchTo: (session, started) => this.switchTo(session, started),
        log: this.deps.log,
      },
      command,
    );
    this.saveRecord();
    this.emit(report);
  }

  /** 会话记录里的 lineage（没有就建一份空的） */
  private lineage(): ClaudeLineage {
    return (this.opened.record.lineage ??= emptyLineage());
  }

  /**
   * 记下一条交给 Claude 的输入（293 号票）：推进了哪个会话、二狗定的 uuid；轮次开头的（prompt）另记那个会话里的上一条（这个 query 里见过的）、
   * 是不是这个会话的第一条输入，取走这个会话还没交给模型的分支摘要（交回它）
   */
  private noteInput(inputId: string, uuid: string, prompt: boolean): string | undefined {
    const lineage = this.lineage();
    const session = this.opened.record.claudeSessionId;
    const anchor = prompt ? this.lastChainUuid : undefined;
    lineage.inputs[inputId] = { session, uuid, ...(anchor === undefined ? {} : { anchor }) };
    const own = (lineage.sessions[session] ??= {});
    if (prompt) own.first ??= uuid;
    const note = prompt ? lineage.notes[session] : undefined;
    if (note !== undefined) delete lineage.notes[session];
    this.saveRecord();
    return note;
  }

  /** 把 session 的文件按检查点恢复到 uuid 那条用户消息时（293 号票）：现在的会话用活着的 query（没有就起），别的会话临时起一个 query 只做这一件 */
  private async rewindIn(session: string, uuid: string): Promise<ClaudeRewindResult> {
    if (session === this.opened.record.claudeSessionId) {
      const started = this.tryEnsureQuery();
      if (!started.ok) throw new Error(started.error);
      if (!this.query?.rewindFiles) throw new Error(t("claudeCode.navigate.noRewind"));
      return await this.query.rewindFiles(uuid);
    }
    const input = new InputQueue();
    const query = this.deps.query({
      prompt: input,
      options: {
        cwd: this.claudeCwd(),
        env: claudeProcessEnv(this.deps.env),
        ...(this.deps.executable ? { pathToClaudeCodeExecutable: this.deps.executable } : {}),
        // 只恢复文件：不加载用户、项目的设置（钩子、CLAUDE.md 都不要），不推任何输入
        settingSources: [],
        enableFileCheckpointing: true,
        permissionPrompts: "none",
        resume: session,
        stderr: (data) => {
          const line = data.trimEnd();
          if (line) this.deps.log(`[claude 恢复文件] ${line}`);
        },
      },
    });
    // 消息照收（不收的话 SDK 那边可能堵着），不处理
    void (async () => {
      try {
        for await (const message of query) void message;
      } catch {
        // 收尾时 throw 的不管
      }
    })();
    try {
      if (!query.rewindFiles) throw new Error(t("claudeCode.navigate.noRewind"));
      return await query.rewindFiles(uuid);
    } finally {
      input.close();
      try {
        query.close();
      } catch (err) {
        this.deps.log(`关掉恢复文件的 query 出错：${describe(err)}`);
      }
    }
  }

  /** 换成接着另一个 Claude 会话（293 号票：撤回分叉出的、切过去的）：关掉手头的 query（下一条输入按新的会话 id 起），记进会话记录 */
  private switchTo(session: string, started: boolean): void {
    const query = this.query;
    this.query = undefined;
    this.input?.close();
    this.input = undefined;
    this.tools.abortAll();
    try {
      query?.close();
    } catch (err) {
      this.deps.log(`关掉 query 出错：${describe(err)}`);
    }
    this.lastChainUuid = undefined;
    this.opened.record.claudeSessionId = session;
    this.opened.record.started = started;
    this.saveRecord();
  }

  async abort(): Promise<void> {
    const phase = this.phase;
    // 写交接摘要那一轮守护进程不打断（到点由 writeHandoff 自己打断）
    if (phase.kind === "idle" || phase.kind === "handoff" || phase.aborting) return;
    phase.aborting = true;
    if (phase.kind === "turn") {
      phase.abortTimer = setTimeout(() => {
        if (this.phase === phase) {
          this.deps.log(`打断之后 ${ABORT_GRACE_MS / 1000} 秒还没等到这一轮的 result，按被打断收尾`);
          this.finishTurn("aborted");
        }
      }, ABORT_GRACE_MS);
      phase.abortTimer.unref();
    }
    try {
      await this.query?.interrupt();
    } catch (err) {
      this.deps.log(`打断出错：${describe(err)}`);
    }
  }

  /** 手动压缩（宿主协议 compact）：手头有一轮就先打断、等它收尾，再推 "/compact"；压完（或没压成）报 compacted 才 resolve */
  async compact(): Promise<void> {
    if (this.phase.kind === "turn") {
      await this.abort();
      await this.whenIdle();
    }
    if (this.phase.kind !== "idle") return;
    const input = this.tryEnsureQuery();
    if (!input.ok) {
      this.emit({ type: "compacted", reason: "manual", outcome: "failed", error: input.error });
      return;
    }
    await new Promise<void>((resolve) => {
      this.phase = { kind: "compacting", output: [], aborting: false, done: resolve };
      this.translator.discard();
      this.translator.suppress = true;
      // 压缩指令（钩子订阅 compaction_instructions，291 号票）：写在 /compact 后面
      const instructions = this.context.compactionInstructions();
      input.queue.push(userMessage(randomUUID(), instructions ? `/compact ${instructions}` : "/compact", []));
    });
  }

  /**
   * 换运行时之前写交接摘要（289 号票，宿主协议 write_handoff）：推一条请 Claude 照写法写摘要的用户消息，这一轮的回复不当成回复
   * （不报 message_final），result 的文字就是摘要；到点没写完打断、按没写成报。结果以 handoff_written 报回，写完才兑现
   */
  async writeHandoff(requestId: string, instructions: string, timeoutMs: number): Promise<void> {
    if (this.phase.kind !== "idle") {
      this.emit({ type: "handoff_written", requestId, error: "上一轮还没结束" });
      return;
    }
    const input = this.tryEnsureQuery();
    if (!input.ok) {
      this.emit({ type: "handoff_written", requestId, error: input.error });
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.phase.kind !== "handoff" || this.phase.requestId !== requestId) return;
        this.phase.timedOut = true;
        this.phase.aborting = true;
        this.query?.interrupt().catch((err: unknown) => this.deps.log(`打断写交接摘要出错：${describe(err)}`));
      }, timeoutMs);
      timer.unref();
      this.phase = { kind: "handoff", requestId, timer, timeoutMs, timedOut: false, aborting: false, done: resolve };
      this.turnSeq += 1;
      this.translator.beginTurn();
      this.translator.discard();
      this.translator.suppress = true;
      input.queue.push(userMessage(randomUUID(), handoffPrompt(instructions), []));
    });
  }

  /** 守护进程执行完二狗的工具了（宿主协议 host_tool_result，291 号票）；没有在等的是 false（被取消的照样收下、扔掉） */
  replyHostTool(requestId: string, result: HostToolResult): boolean {
    return this.tools.reply(requestId, result);
  }

  /** 换掉通用贡献清单里一项的文字（宿主协议 contribution，291 号票）：下一次注入就是新的 */
  updateContribution(id: string, text: string): void {
    this.context.update(id, text);
  }

  /** 换成最新的近期范围记录（宿主协议 scope_context，291 号票）：当成"一直在"的那段，变了下一次注入 */
  setScopeContext(recentRecords: string | undefined): void {
    this.context.setRecentRecords(recentRecords);
  }

  /**
   * 工具包当场换（宿主协议 toolkit，291 号票）：MCP 服务的工具清单当场换（服务有增减、query 活着时 setMcpServers）；skill 变了重拼插件目录，
   * query 活着时叫 reloadPlugins 当场生效（报回刷新后的斜杠命令）；notice 在下一次工具结果或下一条输入时交给模型。做完才处理排在后面的命令
   */
  async changeToolkit(tools: readonly HostToolSpec[], skillPaths: readonly string[], notice: string | undefined): Promise<void> {
    if (notice) this.context.note(notice);
    const reshaped = this.tools.setTools(tools);
    const query = this.query;
    if (reshaped && query?.setMcpServers) {
      try {
        const result = await query.setMcpServers(this.tools.mcpServers());
        this.deps.log(`工具包变了，MCP 服务换过了：${JSON.stringify(result)}`);
      } catch (err) {
        this.deps.log(`工具包变了，换 MCP 服务没成（下一个 query 起来时照新的）：${describe(err)}`);
      }
    }
    this.skillPaths = [...skillPaths];
    if (!this.assembly.runtimeDir) return;
    const changed = this.buildPlugin();
    if (!changed || !query || query !== this.query) return;
    if (!query.reloadPlugins) {
      this.deps.log("工具包里的 skill 变了：这个 SDK 不能当场重新加载插件，下一个 query 起来时生效");
      return;
    }
    try {
      const reloaded = await query.reloadPlugins();
      this.deps.log(`工具包里的 skill 变了，插件重新加载了：${(reloaded.commands ?? []).filter((c) => c.name.startsWith(pluginSkillCommand(""))).map((c) => c.name).join("、") || "（没有 skill）"}`);
      if (reloaded.commands && query === this.query) {
        for (const c of reloaded.commands) this.commandInfo.set(c.name, { description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
        this.reportCommands(reloaded.commands.map((c) => c.name));
      }
    } catch (err) {
      this.deps.log(`工具包里的 skill 变了，重新加载插件没成（下一个 query 起来时生效）：${describe(err)}`);
    }
  }

  /** 守护进程的判定到了（宿主协议 guard_reply）；没有在等的是 false */
  replyGuard(requestId: string, verdict: GuardVerdict): boolean {
    return this.guard?.replyGuard(requestId, verdict) ?? false;
  }

  /** 提问卡上的回答到了（宿主协议 ask_user_reply）；没有在等的是 false */
  replyAsk(requestId: string, reply: RuntimeQuestionReply): boolean {
    return this.guard?.replyAsk(requestId, reply) ?? false;
  }

  /** 子进程收尾：手头有一轮先打断（等一会儿），再关掉 claude 的输入、结束 query */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const query = this.query;
    if (query && this.phase.kind !== "idle") {
      await Promise.race([query.interrupt().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, DISPOSE_INTERRUPT_MS).unref())]);
    }
    this.input?.close();
    try {
      query?.close();
    } catch (err) {
      this.deps.log(`关掉 query 出错：${describe(err)}`);
    }
    this.query = undefined;
    this.tools.abortAll();
  }

  /** 有活着的 query 就用它，没有（第一次、上一个结束了）就按会话记录起一个新的；SDK 当场报错的交回原因 */
  private tryEnsureQuery(): { ok: true; queue: InputQueue } | { ok: false; error: string } {
    try {
      if (!this.query || !this.input) this.startQuery();
      return { ok: true, queue: this.input! };
    } catch (err) {
      this.query = undefined;
      this.input = undefined;
      this.deps.log(`起 Claude Code 的 query 出错：${describe(err)}`);
      return { ok: false, error: describe(err) };
    }
  }

  /**
   * 交给 Claude Code 的工作目录。312 号票：Claude Code 按工作目录的写法找它的会话记录（~/.claude/projects/<工作目录编码>/），数据目录从
   * ~/.ergou 改名成 ~/.ergo 之后，早先在数据目录里开的会话记在旧写法下——接着这种会话（记录里 started）、记录里开始时的工作目录和这次的
   * 写法不同却是同一个目录（旧路径是指到新目录的目录联接）时，照记录里的写法，才找得到。别的照这次的
   */
  private claudeCwd(): string {
    const { record } = this.opened;
    const now = this.assembly.cwd;
    if (!record.started || record.cwd === now) return now;
    return sameDirectory(record.cwd, now) ? record.cwd : now;
  }

  private startQuery(): void {
    const input = new InputQueue();
    const { record } = this.opened;
    const append = withToolNote(this.assembly.systemPrompt?.trim());
    // 291 号票：工具包里的 skill 拼成本地插件（有运行时目录才拼）；"一直在"的那段在这个 query 里重新注入一次
    if (this.assembly.runtimeDir) this.buildPlugin();
    this.context.queryStarted();
    this.lastChainUuid = undefined;
    const options: Options = {
      cwd: this.claudeCwd(),
      // 维护者在 ⚙ 里选的模型、思考档位、权限模式（289 号票）；没选的用 Claude Code 自己的设置
      ...claudeQueryChoices(this.assembly.runtimeOptions),
      env: claudeProcessEnv(this.deps.env),
      ...(this.deps.executable ? { pathToClaudeCodeExecutable: this.deps.executable } : {}),
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", snapshot: false, ...(append ? { append } : {}) },
      includePartialMessages: true,
      // 撤回时把 Write、Edit 改过的文件恢复到撤回点（293 号票，Query.rewindFiles）：一律开文件检查点
      enableFileCheckpointing: true,
      // 守卫（288 号票）：PreToolUse 钩子做全量闸口，canUseTool 接 Claude 自己要问的；没接守卫的（测试）要问人的一律拒绝。
      // 291 号票：上下文经 UserPromptSubmit / SessionStart 钩子注入，PostToolUse 交守卫要加的话和二狗要告诉模型的话
      hooks: this.sdkHooks(),
      ...(this.guard ? { canUseTool: this.guard.canUseTool } : { permissionPrompts: "none" as const }),
      // 二狗的工具（291 号票）：进程内 MCP 服务（二狗自己的 ergo，工具包里的 MCP 各一个）
      mcpServers: this.tools.mcpServers(),
      // 工具包里的 skill（291 号票）：二狗拼的本地插件；插件里没有 MCP（二狗的工具已经在上面），不让它去找
      ...(this.pluginRoot ? { plugins: [{ type: "local" as const, path: this.pluginRoot, skipMcpDiscovery: true }] } : {}),
      ...(record.started ? { resume: record.claudeSessionId } : { sessionId: record.claudeSessionId }),
      stderr: (data) => {
        const line = data.trimEnd();
        if (line) this.deps.log(`[claude] ${line}`);
      },
    };
    const query = this.deps.query({ prompt: input, options });
    this.query = query;
    this.input = input;
    void this.consume(query);
    void this.reportCatalog(query);
  }

  /**
   * 交给 SDK 的钩子（291 号票）：守卫的 PreToolUse，上下文的 UserPromptSubmit、SessionStart，合在一起的 PostToolUse、PostToolUseFailure；
   * 309 号票起装配了范围审视的还有 PreCompact
   */
  private sdkHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const post = (input: HookInput): Promise<HookJSONOutput> => {
      const context = [this.guard?.postToolContext(input), this.context.postToolContext(input)].filter((s): s is string => Boolean(s)).join("\n\n");
      if (!context) return Promise.resolve({});
      return Promise.resolve(
        input.hook_event_name === "PostToolUseFailure"
          ? { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: context } }
          : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } },
      );
    };
    // 309 号票：压缩之前报一条，范围审视由守护进程按自己记下的事件另起（Claude 子进程里调不了二狗的审视模型）；不拦压缩
    const preCompact = (input: HookInput): Promise<HookJSONOutput> => {
      if (input.hook_event_name === "PreCompact") this.emit({ type: "compacting", reason: input.trigger === "manual" ? "manual" : "threshold" });
      return Promise.resolve({});
    };
    return {
      ...this.guard?.hooks(),
      ...this.context.sdkHooks(),
      PostToolUse: [{ hooks: [post] }],
      PostToolUseFailure: [{ hooks: [post] }],
      ...(this.assembly.scopeReview ? { PreCompact: [{ hooks: [preCompact] }] } : {}),
    };
  }

  /** 拼（或更新）工具包 skill 的本地插件目录；拼不成只记日志（这一回不带插件）。返回 skill 有没有变 */
  private buildPlugin(): boolean {
    const runtimeDir = this.assembly.runtimeDir;
    if (!runtimeDir) return false;
    try {
      const built = buildSkillPlugin(runtimeDir, this.skillPaths, this.deps.log);
      if (built.changed) this.deps.log(`工具包里的 skill 拼成了本地插件 ${built.root}：${built.names.map(pluginSkillCommand).join("、") || "（没有 skill）"}`);
      this.pluginRoot = built.root;
      return built.changed;
    } catch (err) {
      this.deps.log(`拼工具包 skill 的本地插件没成：${describe(err)}`);
      return false;
    }
  }

  /** 这是二狗交给 Claude 的工具（Claude 的工具名）：ergo 服务里的，或工具包里 MCP 的那几个 */
  private ownTool(claudeName: string): boolean {
    if (claudeName.startsWith(`mcp__${ERGO_MCP_SERVER}__`)) return true;
    return claudeName.startsWith("mcp__") && this.tools.toolNames.includes(claudeName);
  }

  /** 这一轮已经进了上下文的插话（输入 id，按先后）：随 host_tool_call 报（86 号票） */
  private interjectedSoFar(): string[] {
    const phase = this.phase;
    return phase.kind === "turn" ? phase.interjections.filter((i) => phase.consumed.has(i.uuid)).map((i) => i.inputId) : [];
  }

  /**
   * Claude Code 自己的模型列表和斜杠命令清单报给守护进程（289 号票，runtime_catalog）：query 起来后问一次（只握手，不调用模型、不花额度）；
   * 问不到（老版本、出错）只记日志，命令等每轮开头的 system/init 再报
   */
  private async reportCatalog(query: ClaudeQuery): Promise<void> {
    try {
      const [commands, models] = await Promise.all([query.supportedCommands?.(), query.supportedModels?.()]);
      if (query !== this.query) return;
      for (const c of commands ?? []) this.commandInfo.set(c.name, { description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
      if (!commands && !models) return;
      this.emit({
        type: "runtime_catalog",
        ...(commands ? { commands: commands.map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })) } : {}),
        ...(models ? { models: models.map((m) => ({ id: m.value, title: m.displayName || m.value })) } : {}),
      });
    } catch (err) {
      this.deps.log(`问 Claude Code 的模型和命令清单出错：${describe(err)}`);
    }
  }

  /** 按名字报斜杠命令（system/init 只给名字、去掉只在终端里能用的；说明按 supportedCommands、commands_changed 给过的补） */
  private reportCommands(names: readonly string[], terminalOnly: readonly string[] = []): void {
    const hidden = new Set(terminalOnly);
    const commands = names
      .filter((name) => !hidden.has(name))
      .map((name) => {
        const info = this.commandInfo.get(name);
        return { name, description: info?.description ?? "", ...(info?.argumentHint ? { argumentHint: info.argumentHint } : {}) };
      });
    this.emit({ type: "runtime_catalog", commands });
  }

  /** 消费 SDK 的消息：绝不 break（会结束整个会话）；结束或 throw 了交给 ended */
  private async consume(query: ClaudeQuery): Promise<void> {
    try {
      for await (const message of query) {
        if (query !== this.query) continue;
        try {
          this.onMessage(message);
        } catch (err) {
          this.deps.log(`处理 Claude Code 的消息出错（${(message as { type?: string }).type}）：${describe(err)}`);
        }
      }
      this.ended(query, undefined);
    } catch (err) {
      this.ended(query, err);
    }
  }

  /** query 结束了（claude 退出、出错）：手头的一轮按出错收尾，下一条输入按会话 id 恢复一个新的 */
  private ended(query: ClaudeQuery, err: unknown): void {
    if (query !== this.query) return;
    this.query = undefined;
    this.input?.close();
    this.input = undefined;
    // 还在等结果的二狗工具调用没人要了（下一个 query 是新的连接）
    this.tools.abortAll();
    if (this.disposing) return;
    const reason = err === undefined ? t("claudeCode.child.ended") : describe(err);
    this.deps.log(`Claude Code 的 query 结束了：${reason}`);
    const phase = this.phase;
    if (phase.kind === "turn") {
      this.translator.flushAll();
      this.finishTurn(phase.aborting ? "aborted" : "error", phase.aborting ? undefined : reason);
    } else if (phase.kind === "compacting") {
      this.finishCompaction({ type: "compacted", reason: "manual", outcome: phase.aborting ? "aborted" : "failed", ...(phase.aborting ? {} : { error: reason }) });
    } else if (phase.kind === "handoff") {
      this.finishHandoff({ error: reason });
    } else {
      this.emit(errorReport("internal", `Claude Code 的 query 结束了：${reason}`));
    }
  }

  private onMessage(message: SDKMessage): void {
    const type = (message as { type?: string }).type;
    switch (type) {
      case "assistant":
        this.markStarted();
        this.noteConsumed(message);
        this.noteChain(message);
        this.translator.assistant(message as Extract<SDKMessage, { type: "assistant" }>);
        return;
      case "stream_event":
        this.noteConsumed(message);
        this.translator.stream(message as Extract<SDKMessage, { type: "stream_event" }>);
        return;
      case "user":
        this.noteChain(message);
        this.translator.user(message as SDKUserMessage);
        return;
      case "result":
        this.markStarted();
        this.onResult(message as SDKResultMessage);
        return;
      case "system":
        this.onSystem(message as Extract<SDKMessage, { type: "system" }>);
        return;
      case "rate_limit_event": {
        const info = (message as { rate_limit_info?: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number } }).rate_limit_info;
        // 订阅额度（调研 31：不算钱）：宿主协议里还没有它的位置，先记进日志
        if (info) this.deps.log(`订阅额度：${info.rateLimitType ?? "?"} ${info.status ?? "?"}${info.utilization === undefined ? "" : ` ${Math.round(info.utilization * 100)}%`}${info.resetsAt ? `，${new Date(info.resetsAt * 1000).toISOString()} 重置` : ""}`);
        return;
      }
      default:
        // 不认得的消息一律不管（SDK 的消息种类还在加）
        return;
    }
  }

  private onSystem(message: Extract<SDKMessage, { type: "system" }>): void {
    const subtype = (message as { subtype?: string }).subtype;
    switch (subtype) {
      case "init": {
        const init = message as { session_id?: string; model?: string; slash_commands?: string[]; terminal_slash_commands?: string[] };
        // 这一轮能用的斜杠命令（289 号票：输入框的候选），只在终端里能用的不报
        if (Array.isArray(init.slash_commands)) this.reportCommands(init.slash_commands, init.terminal_slash_commands);
        const { record } = this.opened;
        let changed = false;
        if (init.session_id && init.session_id !== record.claudeSessionId) {
          // /clear 之类让 Claude Code 换了会话：以后接着新的
          this.deps.log(`Claude Code 换了会话：${record.claudeSessionId} → ${init.session_id}`);
          record.claudeSessionId = init.session_id;
          changed = true;
        }
        if (init.model && init.model !== record.model) {
          record.model = init.model;
          changed = true;
        }
        if (changed) this.saveRecord();
        return;
      }
      case "compact_boundary": {
        this.translator.flushAll();
        // "一直在"的那段（系统提示后缀、近期范围记录）压缩之后再注入一次（291 号票）
        this.context.compacted();
        const meta = (message as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
        const phase = this.phase;
        if (phase.kind === "compacting") phase.preTokens = meta?.pre_tokens ?? 0;
        else this.emit({ type: "compacted", reason: meta?.trigger === "manual" ? "manual" : "threshold", outcome: "done", ...(meta?.pre_tokens === undefined ? {} : { tokensBefore: meta.pre_tokens }) });
        return;
      }
      case "status": {
        const status = message as { compact_result?: string; compact_error?: string };
        if (status.compact_result !== "failed") return;
        const phase = this.phase;
        if (phase.kind === "compacting") phase.failure = status.compact_error ?? "";
        else {
          const error = status.compact_error ?? t("claudeCode.child.compactFailed");
          const reason = phase.kind === "turn" && phase.slashCompact ? "manual" : "threshold";
          this.emit(NOTHING_TO_COMPACT.test(error) ? { type: "compacted", reason, outcome: "nothing" } : { type: "compacted", reason, outcome: "failed", error });
        }
        return;
      }
      case "local_command_output": {
        const content = (message as { content?: string }).content ?? "";
        if (this.phase.kind === "compacting") this.phase.output.push(content);
        else this.translator.localOutput(content);
        return;
      }
      case "api_retry": {
        const retry = message as { attempt?: number; retry_delay_ms?: number; error?: unknown };
        this.deps.log(`Claude Code 在重试请求：第 ${retry.attempt ?? "?"} 次，${retry.retry_delay_ms ?? "?"} 毫秒后`);
        return;
      }
      case "conversation_reset":
        this.deps.log("Claude Code 清空了对话（新的会话 id 在下一轮的 system/init 里）");
        return;
      case "commands_changed": {
        // 中途命令变了（289 号票：比如在子目录里发现了技能）：整份换掉
        const commands = (message as { commands?: Array<{ name: string; description: string; argumentHint?: string }> }).commands ?? [];
        for (const c of commands) this.commandInfo.set(c.name, { description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
        this.reportCommands(commands.map((c) => c.name));
        return;
      }
      default:
        return;
    }
  }

  private onResult(result: SDKResultMessage): void {
    const phase = this.phase;
    this.noteContextWindow(result);
    if (phase.kind === "handoff") {
      // 写交接摘要那一轮（289 号票）：回复不当成回复，result 的文字就是摘要；那次调用的用量记成 handoff
      this.translator.discard();
      const usage = result.usage ? usageOf(result.usage) : undefined;
      if (usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
        this.emit(usageReport(`handoff-${this.opened.name}`, this.translator.lastModel ?? this.opened.record.model ?? "", usage, "handoff"));
      }
      const text = resultText(result).trim();
      if (phase.timedOut) return this.finishHandoff({ error: `写交接摘要超过 ${Math.round(phase.timeoutMs / 1000)} 秒没有结束` });
      if (result.subtype !== "success" || result.is_error || !text) return this.finishHandoff({ error: text || result.subtype || "Claude 回的交接摘要是空的" });
      return this.finishHandoff({ text });
    }
    if (phase.kind === "compacting") {
      this.translator.discard();
      const text = [phase.failure, ...phase.output, resultText(result)].filter((s): s is string => Boolean(s)).join("\n");
      const usage = result.usage ? usageOf(result.usage) : undefined;
      if (usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
        this.emit(usageReport(`compaction-${++this.compactionSeq}`, this.translator.lastModel ?? this.opened.record.model ?? "", usage, "compaction"));
      }
      if (phase.preTokens !== undefined) return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "done", tokensBefore: phase.preTokens });
      if (phase.aborting) return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "aborted" });
      if (NOTHING_TO_COMPACT.test(text)) return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "nothing" });
      return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "failed", error: text || t("claudeCode.child.compactFailed") });
    }
    this.translator.flushAll();
    if (phase.kind !== "turn") {
      // Claude Code 自己起的一轮（后台任务的通知、打断后还排着的插话……）：回复照转，没有二狗这边的输入要收尾
      this.deps.log("没有进行中的一轮时来了一条 result（Claude Code 自己起的一轮），不报轮次结束");
      return;
    }
    for (const uuid of result.user_message_uuids ?? []) phase.consumed.add(uuid);
    const pending = phase.interjections.filter((i) => !phase.consumed.has(i.uuid));
    // 插话来晚了：Claude Code 接着另起一轮，二狗这边并进同一轮（有 queued_turn_count 的按它，老版本按插话收没收进来）
    const more = result.queued_turn_count !== undefined ? result.queued_turn_count > 0 : result.user_message_uuids !== undefined && pending.length > 0;
    if (!phase.aborting && more) {
      this.deps.log(`这一轮的 result 来了，还有 ${pending.length} 条插话排着：接着同一轮`);
      return;
    }
    if (!this.translator.usageReported && result.usage) {
      // 流里没有逐次调用的用量（按说不会）：按这一轮的 usage 报一条
      const usage = usageOf(result.usage);
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
        this.emit(usageReport(this.translator.lastMessageId ?? `turn-${this.turnSeq}`, this.translator.lastModel ?? this.opened.record.model ?? "", usage));
      }
    }
    const interjected =
      result.user_message_uuids === undefined && !phase.aborting ? phase.interjections.map((i) => i.inputId) : phase.interjections.filter((i) => phase.consumed.has(i.uuid)).map((i) => i.inputId);
    if (phase.aborting) return this.finishTurn("aborted", undefined, interjected);
    const ok = result.subtype === "success" && !result.is_error;
    this.finishTurn(ok ? "completed" : "error", ok ? undefined : resultText(result) || result.subtype, interjected);
  }

  private finishTurn(outcome: TurnOutcome, errorMessage?: string, interjected: string[] = []): void {
    const phase = this.phase;
    if (phase.kind === "turn" && phase.abortTimer) clearTimeout(phase.abortTimer);
    this.phase = { kind: "idle" };
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }), ...(interjected.length > 0 ? { interjected } : {}) });
    this.saveRecord();
    this.wakeIdle();
  }

  private finishCompaction(report: CompactedReport): void {
    const phase = this.phase;
    this.translator.discard();
    this.translator.suppress = false;
    this.phase = { kind: "idle" };
    this.emit(report);
    this.saveRecord();
    if (phase.kind === "compacting") phase.done();
    this.wakeIdle();
  }

  private finishHandoff(outcome: { text: string } | { error: string }): void {
    const phase = this.phase;
    if (phase.kind !== "handoff") return;
    clearTimeout(phase.timer);
    this.translator.discard();
    this.translator.suppress = false;
    this.phase = { kind: "idle" };
    this.emit({ type: "handoff_written", requestId: phase.requestId, ...outcome });
    this.saveRecord();
    phase.done();
    this.wakeIdle();
  }

  private whenIdle(): Promise<void> {
    if (this.phase.kind === "idle") return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private wakeIdle(): void {
    for (const wake of this.idleWaiters.splice(0)) wake();
  }

  /** 主线上的一条（不是子代理里的）：记下它的 uuid（293 号票：交下一条输入时记成"上一条"） */
  private noteChain(message: SDKMessage): void {
    const { uuid, parent_tool_use_id: parent } = message as { uuid?: string; parent_tool_use_id?: string | null };
    if (uuid && !parent) this.lastChainUuid = uuid;
  }

  /** assistant、stream_event 上的 user_message_uuids：这些用户消息已经收进这一轮了 */
  private noteConsumed(message: SDKMessage): void {
    const phase = this.phase;
    const uuids = (message as { user_message_uuids?: string[] }).user_message_uuids;
    if (phase.kind === "turn" && uuids) for (const uuid of uuids) phase.consumed.add(uuid);
  }

  private noteContextWindow(result: SDKResultMessage): void {
    const model = this.translator.lastModel ?? this.opened.record.model;
    const window = model === undefined ? undefined : result.modelUsage?.[model]?.contextWindow;
    if (typeof window === "number" && window > 0) this.opened.record.contextWindow = window;
  }

  /** 有过回复了：claude 写过记录，之后按 id 恢复 */
  private markStarted(): void {
    if (this.opened.record.started) return;
    this.opened.record.started = true;
    this.saveRecord();
  }

  private saveRecord(): void {
    try {
      writeRecord(this.opened.file, this.opened.record);
    } catch (err) {
      this.deps.log(`写会话记录出错：${describe(err)}`);
    }
  }
}

/**
 * 一条用户消息：文字、图片（image 块）；只有文字时 content 是字符串（斜杠命令照常展开）。跟在后面的上下文不在这里（291 号票起经
 * UserPromptSubmit 钩子交，context.ts）
 */
function userMessage(uuid: UUID, text: string, images: InputImage[], priority?: "next"): SDKUserMessage {
  const blocks: Array<Record<string, unknown>> = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) blocks.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
  const content = images.length === 0 ? text : blocks;
  return {
    type: "user",
    message: { role: "user", content: content as SDKUserMessage["message"]["content"] },
    parent_tool_use_id: null,
    uuid,
    ...(priority ? { priority } : {}),
  };
}

/**
 * 追加的系统提示后面补的一句（291 号票）：维护者的系统提示是按 pi 写的（287 号票留的④），这里说清二狗的工具在 Claude Code 里叫什么、
 * 提示里说的 pi 的工具对应它自带的哪个。没有系统提示时不补
 */
function withToolNote(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return systemPrompt;
  return `${systemPrompt}\n\n${CLAUDE_TOOL_NOTE}`;
}

// @i18n-ignore-start model：追加在系统提示后面给 Claude 看的
const CLAUDE_TOOL_NOTE = [
  `（二狗补充：你现在跑在 Claude Code 里。上面说的二狗的工具在这里名字前面带 mcp__${ERGO_MCP_SERVER}__，比如 submit_plan 就是 mcp__${ERGO_MCP_SERVER}__submit_plan；`,
  "工具包里的 MCP 工具（mcp__<服务>__<工具>）名字不变；上面说的 read、write、edit、bash、grep、find、ls 是你自带的 Read、Write、Edit、Bash、Grep、Glob、LS。",
  `工具包里的 skill 在插件 ergo 里（斜杠命令 /ergo:<名字>），用你的 Skill 工具调用。）`,
].join("");
// @i18n-ignore-end

/** result 里给人看的那句：成功的是最后的回复（出错时是出错的说明），出错的 subtype 是 errors */
function resultText(result: SDKResultMessage): string {
  if (result.subtype === "success") return result.result ?? "";
  return (result.errors ?? []).map((e) => e.trim()).filter(Boolean).join("; ");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 两个写法是不是同一个目录（展开目录联接、8.3 短名之后比；取不到的不算） */
function sameDirectory(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
}
