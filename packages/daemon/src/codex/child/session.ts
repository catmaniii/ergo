// Codex 适配子进程里的一个会话：一个 codex app-server（stdio 上的 JSON-RPC），宿主协议的命令翻成它的调用，它的通知经 translator.ts 翻回宿主协议，这里管轮次、压缩、打断和会话记录。
//
// 对照（宿主协议 → app-server，协议以 0.166 生成的 schema 为准，test/fixtures/codex-app-server.schema.json）：
// - start / ready：起 app-server（-c 配好守卫钩子和 MCP 中转）→ initialize → thread/start 或 thread/resume；
// - user_input：turn/start（文字、data URL 的图片；进上下文不显示的放 additionalContext，context.ts）；interject：turn/steer；abort：turn/interrupt；
// - compact：thread/compact/start；turn_end：turn/completed（completed / interrupted / failed）；
// - navigate_session：thread/fork（navigation.ts）；write_handoff：thread/fork 一个 ephemeral 的临时分叉，在它上面跑一轮写摘要（不进原来的会话）；
// - 审批策略固定 untrusted、approvalsReviewer 固定 user（守卫要收到审批请求），每个 thread/start、thread/resume、thread/fork、turn/start 都带。
// 用 Codex 自己的配置（config.toml、AGENTS.md、它自己的 MCP 和 skill 照常）：二狗的系统提示追加进 developerInstructions（用户在 config.toml 写的 developer_instructions 排在前面），
// 别的都走 -c 启动参数，不写 ~/.codex 和项目目录。交给 codex 的环境去掉改计费的变量（install.ts）。不读 auth.json：登录的是谁、订阅还是 API key 问 account/read。
// 守卫钩子（ADR-0046）：
// - Windows 上钩子命令要交给 cmd /C，路径里有空格时 Codex 转义的引号 cmd 认不了，所以 hook 的命令固定写 ergo-guard-hook，PATH 前面加 <runtimeDir>/bin，里面的包装脚本只认环境变量；
// - -c 给的钩子默认 untrusted、不会跑：起来后问 hooks/list，没信任就把它报的 key 和 hash 写进 -c hooks.state 重起一次（记在 runtimeDir，下次不用重起）；还不行就不起（绝不在没有守卫时跑）。
// 没登录：account/read 看得出来，这一轮按出错收尾，写清怎么登录；关掉 app-server，下一条输入重新起（登录是另一个进程做的，缓存着的还是旧的）。额度用完（usageLimitExceeded……）同样按出错收尾，写明。
// app-server 自己退出了：手头这一轮按出错收尾，下一条输入重新起、按 thread id 恢复。
// @i18n-ignore-file log：子进程的日志（守护进程记进日志）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type RuntimeQuestionReply, t } from "@ergo/protocol";
import { syncSkillDirs } from "../../runtime/skill-dirs.ts";
import {
  type AgentReport,
  type CompactedReport,
  errorReport,
  type GuardVerdict,
  type HandoffReport,
  type HostCommand,
  type HostToolResult,
  type InputImage,
  type LoadedResources,
  type ModelRef,
  type SessionAssembly,
  type SessionContextInfo,
  type SessionModel,
  type TurnOutcome,
} from "../../runtime/host-protocol.ts";
import { codexProcessEnv } from "../install.ts";
import { codexChoices } from "../settings.ts";
import { CodexRpc, CodexRpcError, type CodexServerSpawn } from "./app-server.ts";
import { type Bridge, openBridge } from "./bridge.ts";
import { CODEX_TOOL_NOTE, CodexContext } from "./context.ts";
import { CodexGuard } from "./guard.ts";
import { ERGO_MCP_SERVER, HostToolBridge } from "./host-tools.ts";
import { type CodexLineage, emptyLineage, navigateCodex } from "./navigation.ts";
import { type OpenedRecord, openSessionRecord, writeRecord } from "./records.ts";
import { type CodexItem, type CodexToolCall, CodexTranslator, toolOfItem, type TokenUsageNotice } from "./translator.ts";

export interface CodexSessionDeps {
  spawn: CodexServerSpawn;
  /** 适配子进程自己的环境 */
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  now?: () => Date;
}

/** 钩子的命令（见文件开头）：hash 也跟着它不变 */
export const GUARD_HOOK_COMMAND = "ergo-guard-hook";
/** 钩子最多等多久（秒）：钩子超时 Codex 当它出错、接着往下走，等于没过守卫；守护进程这边等审批有自己的时限，总会回判定 */
export const GUARD_HOOK_TIMEOUT_S = 24 * 60 * 60;
/** 中转上的工具单次最多等多久（秒）：Codex 默认一分钟，二狗的工具可能等审批 */
const RELAY_TOOL_TIMEOUT_S = 24 * 60 * 60;

/** 还不知道模型的上下文窗口时报的 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** 打断之后等这一轮的 turn/completed 最多多久 */
const ABORT_GRACE_MS = 15_000;
/** 子进程收尾时等打断多久 */
const DISPOSE_INTERRUPT_MS = 3_000;

const ownExt = path.extname(fileURLToPath(import.meta.url));
const scriptPath = (name: string) => fileURLToPath(new URL(`./${name}${ownExt}`, import.meta.url));

/** 用量记在哪种计费下（消耗页按它写明，协议包 runtimeBillingOf） */
const PROVIDER = { subscription: "codex-subscription", metered: "codex-api-key", unknown: "codex" } as const;

interface TurnPhase {
  kind: "turn";
  inputId: string;
  turnId: string | undefined;
  /** 这一轮收下的插话（输入 id） */
  interjections: string[];
  /** 还没回话的 turn/steer：turn/completed 先到时等它们，收没收下才说得准 */
  steering: Set<Promise<void>>;
  aborting: boolean;
  abortTimer?: NodeJS.Timeout;
  /** error 通知里说的（willRetry 是 false 的）：turn/completed 没写原因时用 */
  failure?: string;
}

interface CompactPhase {
  kind: "compacting";
  turnId: string | undefined;
  /** 真的压了（contextCompaction 条目结束了） */
  compacted: boolean;
  done: () => void;
}

interface HandoffPhase {
  kind: "handoff";
  thread: string;
  turnId: string | undefined;
  text: string;
  timedOut: boolean;
  done: (outcome: { text: string } | { error: string }) => void;
}

type Phase = { kind: "idle" } | TurnPhase | CompactPhase | HandoffPhase;

interface StartedThread {
  thread: { id: string };
  model: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handoffPrompt(instructions: string): string {
  // @i18n-ignore-next model：交给 Codex 的话照旧中文
  return `这个对话要交给另一个 agent 接着做。请写一份交接摘要：只回摘要本身，不调用工具、不做别的事。\n\n${instructions}`;
}

/** 一条用户输入：文字、图片（data URL，协议的 image） */
function userInput(text: string, images: readonly InputImage[]): unknown[] {
  return [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((image) => ({ type: "image", url: `data:${image.mime};base64,${image.data}` }))];
}

/** turn 的 error → 给人看的一句 */
function turnError(error: unknown, fallback: string | undefined): string {
  const e = (typeof error === "object" && error !== null ? error : {}) as { message?: unknown; codexErrorInfo?: unknown };
  const message = typeof e.message === "string" && e.message !== "" ? e.message : fallback;
  switch (e.codexErrorInfo) {
    case "usageLimitExceeded":
    case "rateLimitExceeded":
    case "sessionBudgetExceeded":
      return t("codex.child.usageLimit", { detail: message ?? "" });
    case "unauthorized":
      return t("codex.child.notLoggedIn");
    default:
      return message ?? t("codex.child.turnFailed");
  }
}

export class CodexSessionRunner {
  private readonly translator: CodexTranslator;
  private readonly guard: CodexGuard;
  private readonly tools: HostToolBridge;
  private readonly context: CodexContext;
  private readonly opened: OpenedRecord;
  private readonly runtimeDir: string;
  private rpc: CodexRpc | undefined;
  private bridge: Bridge | undefined;
  private phase: Phase = { kind: "idle" };
  private idleWaiters: Array<() => void> = [];
  private disposing = false;
  /** 这个 app-server 里已经加载、订阅着的 thread */
  private readonly loaded = new Set<string>();
  /** 子代理的 thread → 派它的那次调用 */
  private readonly subAgents = new Map<string, string>();
  /** fileChange 条目（审批请求不带改了哪些文件，开始时记下） */
  private readonly fileCalls = new Map<string, CodexToolCall>();
  /** 没登录：这一轮按出错收尾，下一条输入重新起 */
  private loggedIn = true;
  private userInstructions: string | undefined;
  private compactionSeq = 0;
  /** 接着的会话的模型和负责人选的不一样（没带 handoff：任务执行中途不换） */
  private differs = false;
  /** 这次起来时换了模型的结果（ready 里报回） */
  private handoffResult: HandoffReport | undefined;
  /** ready 之后才报的（写交接摘要那次的用量；模型列表） */
  private afterReadyReports: AgentReport[] = [];
  private holdReports = false;

  private readonly assembly: SessionAssembly;
  private readonly emit: (report: AgentReport) => void;
  private readonly deps: CodexSessionDeps;

  private constructor(assembly: SessionAssembly, emit: (report: AgentReport) => void, deps: CodexSessionDeps) {
    this.assembly = assembly;
    this.deps = deps;
    this.emit = (report) => {
      if (this.holdReports && report.type === "usage") this.afterReadyReports.push(report);
      else emit(report);
    };
    this.runtimeDir = assembly.runtimeDir ?? path.join(assembly.sessionDir, "codex-runtime");
    this.opened = openSessionRecord(assembly, deps.now);
    this.translator = new CodexTranslator(this.emit);
    this.translator.model = this.opened.record.model ?? "";
    this.context = new CodexContext(assembly.contributions, assembly.scopeReview?.recentRecords);
    this.guard = new CodexGuard({
      emit: this.emit,
      ensureStarted: (call, parent) => this.translator.ensureStarted(call, parent),
      end: (id, isError, text, parent) => this.translator.end(id, isError, text, parent),
      parentOf: (threadId) => (threadId === undefined ? undefined : this.subAgents.get(threadId)),
      addPrefix: (id, prefix) => this.translator.addPrefix(id, prefix),
      settled: (id) => this.translator.release(id),
      interrupt: () => void this.interruptNow(),
      ownTool: (toolName) => toolName.startsWith(`mcp__${ERGO_MCP_SERVER}__`),
      sealed: () => this.phase.kind === "handoff",
      enabled: assembly.forwardToolCalls,
      log: deps.log,
    });
    this.tools = new HostToolBridge(assembly.contributions.tools, {
      emit: this.emit,
      interjected: () => (this.phase.kind === "turn" ? this.phase.interjections : []),
      claim: (relayName) => this.translator.claim(relayName),
      decide: ({ id, hostName, relayName, args }) => {
        const call: CodexToolCall = { id, toolName: hostName, args: args as Record<string, unknown>, native: { toolName: `mcp__${ERGO_MCP_SERVER}__${relayName}`, args } };
        if (this.phase.kind === "handoff") return Promise.resolve({ allow: false, reason: "这一轮只写交接摘要，不调用工具。" });
        if (!assembly.forwardToolCalls) {
          this.translator.ensureStarted(call);
          return Promise.resolve({ allow: true });
        }
        return this.guard.decide(call, true);
      },
    });
  }

  /** 起 app-server、开或接 thread（之后报 ready）；起不来抛错 */
  static async open(assembly: SessionAssembly, emit: (report: AgentReport) => void, deps: CodexSessionDeps): Promise<CodexSessionRunner> {
    const runner = new CodexSessionRunner(assembly, emit, deps);
    runner.holdReports = true;
    try {
      await runner.connect();
      await runner.openThread();
      await runner.handoffIfDue();
    } catch (err) {
      await runner.dispose();
      throw err;
    }
    runner.saveRecord();
    return runner;
  }

  /** ready 报过了：起来时攒着的用量、模型列表现在报 */
  afterReady(): void {
    this.holdReports = false;
    for (const report of this.afterReadyReports.splice(0)) this.emit(report);
    void this.reportCatalog();
  }

  get sessionId(): string {
    return this.opened.record.threadId;
  }

  get session(): string {
    return this.opened.name;
  }

  get sessionFile(): string {
    return this.opened.file;
  }

  /** Codex 自己装配资源（AGENTS.md、skill、MCP……），这里不知道，都报空的 */
  get loadedResources(): LoadedResources {
    return { tools: [], skills: [], contextFiles: [], extensions: [], credentialProviders: [] };
  }

  get model(): SessionModel {
    return { provider: "codex", modelId: this.opened.record.model ?? "default", thinkingLevel: this.assembly.model.thinkingLevel, pinned: this.opened.existing, ...(this.differs ? { differs: true as const } : {}) };
  }

  get contextInfo(): SessionContextInfo {
    return { window: this.opened.record.contextWindow ?? DEFAULT_CONTEXT_WINDOW, reserveTokens: 0, keepRecentTokens: 0 };
  }

  get handoff(): HandoffReport | undefined {
    return this.handoffResult;
  }

  // ───────────────────────── 起 app-server ─────────────────────────

  /** 给 app-server 的环境：去掉改计费的变量，PATH 前面加钩子的包装脚本，钩子、中转要的放环境变量里（包装脚本只有 ASCII，路径里有中文也不怕 cmd 的编码） */
  private serverEnv(bridge: Bridge): Record<string, string> {
    const env = codexProcessEnv(this.deps.env);
    const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = [path.join(this.runtimeDir, "bin"), env[pathKey]].filter(Boolean).join(path.delimiter);
    env.ERGO_CODEX_NODE = process.execPath;
    env.ERGO_CODEX_HOOK = scriptPath("guard-hook");
    env.ERGO_CODEX_PIPE = bridge.pipe;
    env.ERGO_CODEX_TOKEN = bridge.token;
    return env;
  }

  /** 钩子的包装脚本（内容固定，见 serverEnv） */
  private writeHookScript(): void {
    const dir = path.join(this.runtimeDir, "bin");
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") fs.writeFileSync(path.join(dir, `${GUARD_HOOK_COMMAND}.cmd`), '@"%ERGO_CODEX_NODE%" "%ERGO_CODEX_HOOK%"\r\n');
    else fs.writeFileSync(path.join(dir, GUARD_HOOK_COMMAND), '#!/bin/sh\nexec "$ERGO_CODEX_NODE" "$ERGO_CODEX_HOOK"\n', { mode: 0o755 });
  }

  /**
   * app-server 的启动参数：-c 配好钩子、中转；Codex 自己的联网搜索一律关掉——它在模型服务那边做，钩子拦不到，只能事后知道；
   * 要联网的负责人工具包里有二狗的 web_search（经中转，调用之前过守卫），联网开关关着的本来就不该搜（ADR-0046）
   */
  private serverArgs(bridge: Bridge, trust: { key: string; hash: string } | undefined): string[] {
    const relay = `mcp_servers.${ERGO_MCP_SERVER}`;
    const toml = (value: unknown) => JSON.stringify(value);
    return [
      "app-server",
      ...(this.assembly.forwardToolCalls
        ? [
            "--enable",
            "hooks",
            "-c",
            `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${toml(GUARD_HOOK_COMMAND)},timeout=${GUARD_HOOK_TIMEOUT_S}}]}]`,
            ...(trust ? ["-c", `hooks.state={${toml(trust.key)}={trusted_hash=${toml(trust.hash)}}}`] : []),
          ]
        : []),
      "-c",
      `${relay}.command=${toml(process.execPath)}`,
      "-c",
      `${relay}.args=${toml([scriptPath("mcp-relay"), bridge.pipe, bridge.token])}`,
      "-c",
      // 二狗的工具过二狗的守卫，Codex 不再为它们要审批
      `${relay}.default_tools_approval_mode="approve"`,
      "-c",
      `${relay}.tool_timeout_sec=${RELAY_TOOL_TIMEOUT_S}`,
      "-c",
      `${relay}.startup_timeout_sec=30`,
      "-c",
      'web_search="disabled"',
    ];
  }

  private async launch(bridge: Bridge, trust: { key: string; hash: string } | undefined): Promise<CodexRpc> {
    const proc = this.deps.spawn(this.serverArgs(bridge, trust), { env: this.serverEnv(bridge), cwd: this.assembly.cwd, log: this.deps.log });
    const rpc: CodexRpc = new CodexRpc(proc, {
      onNotification: (method, params) => {
        if (rpc === this.rpc) this.onNotification(method, params);
      },
      onRequest: (method, params) => this.onServerRequest(method, params),
      onExit: (reason) => {
        if (rpc === this.rpc) this.ended(reason);
      },
    });
    this.rpc = rpc;
    await rpc.initialize();
    return rpc;
  }

  /** 起好一个能用的 app-server：开通道、钩子信任好、skill 目录交过去、问登录和用户的 developer_instructions */
  private async connect(): Promise<void> {
    this.loaded.clear();
    this.bridge ??= await openBridge({
      hook: (payload) => this.guard.hook(payload),
      list: () => this.tools.list(),
      call: (name, args, signal) => this.tools.call(name, args, signal),
      log: this.deps.log,
    });
    this.writeHookScript();
    const trustFile = path.join(this.runtimeDir, "hook-trust.json");
    let trust = readTrust(trustFile);
    let rpc = await this.launch(this.bridge, trust);
    if (this.assembly.forwardToolCalls) {
      let state = await this.hookState(rpc);
      if (!state.active) {
        // 第一次（或 Codex 换了算 hash 的办法）：按它报的 key、hash 信任，重起
        trust = { key: state.key, hash: state.hash };
        fs.mkdirSync(this.runtimeDir, { recursive: true });
        fs.writeFileSync(trustFile, `${JSON.stringify(trust)}\n`);
        this.rpc = undefined;
        await rpc.close();
        rpc = await this.launch(this.bridge, trust);
        state = await this.hookState(rpc);
        if (!state.active) throw new Error(t("codex.child.hookNotActive", { status: state.status }));
      }
    }
    await this.prepare(rpc);
  }

  /** 二狗的钩子现在生效没有（hooks/list）；一条都没报的当没生效 */
  private async hookState(rpc: CodexRpc): Promise<{ active: boolean; key: string; hash: string; status: string }> {
    const listed = await rpc.request<{ data?: Array<{ hooks?: Array<{ key?: string; command?: string; eventName?: string; currentHash?: string; trustStatus?: string; enabled?: boolean }> }> }>("hooks/list", { cwds: [this.assembly.cwd] });
    const hook = (listed.data ?? []).flatMap((entry) => entry.hooks ?? []).find((h) => h.command === GUARD_HOOK_COMMAND && h.eventName === "preToolUse");
    if (!hook?.key || !hook.currentHash) throw new Error(t("codex.child.hookNotActive", { status: "missing" }));
    const status = hook.trustStatus ?? "unknown";
    return { active: hook.enabled !== false && (status === "trusted" || status === "managed"), key: hook.key, hash: hook.currentHash, status };
  }

  private async prepare(rpc: CodexRpc): Promise<void> {
    const skillsDir = path.join(this.runtimeDir, "skills");
    try {
      syncSkillDirs(skillsDir, this.assembly.skillPaths, this.deps.log);
      await rpc.request("skills/extraRoots/set", { extraRoots: [skillsDir] });
    } catch (err) {
      this.deps.log(`把工具包里的 skill 交给 Codex 没成：${describe(err)}`);
    }
    const config = await rpc.request<{ config?: { developer_instructions?: string | null } }>("config/read", { cwd: this.assembly.cwd }).catch((err: unknown) => {
      this.deps.log(`读 Codex 的配置出错：${describe(err)}`);
      return undefined;
    });
    this.userInstructions = config?.config?.developer_instructions ?? undefined;
    await this.readAccount(rpc);
  }

  /** 登录的是谁：定用量记在哪种计费下，没登录的记着（下一条输入按出错收尾） */
  private async readAccount(rpc: CodexRpc): Promise<void> {
    const account = await rpc.request<{ account?: { type?: string } | null; requiresOpenaiAuth?: boolean }>("account/read", {}).catch((err: unknown) => {
      this.deps.log(`问 Codex 的登录出错：${describe(err)}`);
      return undefined;
    });
    if (!account) return;
    this.loggedIn = account.account != null || account.requiresOpenaiAuth !== true;
    const type = account.account?.type;
    this.translator.provider = type === "chatgpt" ? PROVIDER.subscription : type === undefined ? PROVIDER.unknown : PROVIDER.metered;
  }

  private async reportCatalog(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    try {
      const listed = await rpc.request<{ data?: Array<{ model?: string; displayName?: string; hidden?: boolean }> }>("model/list", { limit: 100 });
      const models = (listed.data ?? []).filter((m) => m.hidden !== true && m.model).map((m) => ({ id: m.model!, title: m.displayName || m.model! }));
      if (models.length > 0) this.emit({ type: "runtime_catalog", models });
    } catch (err) {
      this.deps.log(`问 Codex 的模型列表出错：${describe(err)}`);
    }
  }

  // ───────────────────────── thread ─────────────────────────

  private get lineage(): CodexLineage {
    return (this.opened.record.lineage ??= emptyLineage());
  }

  /** developerInstructions：用户配置里的在前，二狗的系统提示和工具说明追加在后 */
  private instructions(): string | undefined {
    const own = this.assembly.systemPrompt?.trim();
    const text = [this.userInstructions?.trim(), own, own ? CODEX_TOOL_NOTE : undefined].filter(Boolean).join("\n\n");
    return text || undefined;
  }

  /** thread/start、thread/resume、thread/fork 都带的 */
  private threadParams(): Record<string, unknown> {
    const { sandbox } = codexChoices(this.assembly.runtimeOptions);
    const instructions = this.instructions();
    return { cwd: this.assembly.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", ...(sandbox ? { sandbox } : {}), ...(instructions ? { developerInstructions: instructions } : {}) };
  }

  /** 开或接现在的 thread（这个 app-server 里还没加载的话） */
  private async openThread(): Promise<void> {
    const rpc = this.rpc!;
    const { record } = this.opened;
    if (record.threadId && this.loaded.has(record.threadId)) return;
    if (record.started && record.threadId) {
      const resumed = await rpc.request<StartedThread>("thread/resume", { threadId: record.threadId, ...this.threadParams(), excludeTurns: true });
      this.noteThread(resumed);
      return;
    }
    const before = record.threadId;
    const { model } = codexChoices(this.assembly.runtimeOptions);
    const started = await rpc.request<StartedThread>("thread/start", { ...this.threadParams(), serviceName: "ergo", ...(model ? { model } : {}) });
    record.threadId = started.thread.id;
    const lineage = this.lineage;
    // 还没落盘的空 thread 重起之后 id 变了：记着的跟过去
    const own = before ? lineage.threads[before] : undefined;
    const note = before ? lineage.notes[before] : undefined;
    if (before && before !== record.threadId) {
      delete lineage.threads[before];
      delete lineage.notes[before];
    }
    lineage.threads[record.threadId] = own ?? { fresh: true };
    if (note !== undefined) lineage.notes[record.threadId] = note;
    this.noteThread(started);
  }

  private noteThread(thread: StartedThread): void {
    this.loaded.add(thread.thread.id);
    if (thread.model) {
      this.opened.record.model = thread.model;
      this.translator.model = thread.model;
    }
    const { model } = codexChoices(this.assembly.runtimeOptions);
    this.differs = model !== undefined && this.opened.record.started && thread.model !== model;
  }

  /** 接着的会话的模型和选的不一样、这次又带着 handoff：旧模型写交接摘要，新模型新开 thread（写不成照旧接着，下一条能换的输入再试） */
  private async handoffIfDue(): Promise<void> {
    const setup = this.assembly.handoff;
    if (!setup || !this.differs) return;
    const { record } = this.opened;
    const ref = (modelId: string): ModelRef => ({ provider: "codex", modelId, name: modelId, thinkingLevel: this.assembly.model.thinkingLevel });
    const from = record.model ?? "";
    const to = codexChoices(this.assembly.runtimeOptions).model ?? from;
    const written = await this.summarize(setup.instructions, setup.timeoutMs, `handoff-${this.opened.name}`);
    if ("error" in written) {
      this.handoffResult = { from: { session: this.opened.name, model: ref(from) }, to: ref(to), error: written.error };
      return;
    }
    record.started = false;
    record.threadId = "";
    this.differs = false;
    await this.openThread();
    this.context.note(written.text);
    this.handoffResult = { from: { session: this.opened.name, model: ref(from) }, to: ref(to) };
  }

  // ───────────────────────── 轮次 ─────────────────────────

  /** 有能用的 app-server、thread 接好了；不行抛错 */
  private async ready(): Promise<CodexRpc> {
    if (!this.rpc?.alive) await this.connect();
    await this.openThread();
    return this.rpc!;
  }

  async prompt(inputId: string, text: string, images: InputImage[], inputContext?: string): Promise<void> {
    if (this.phase.kind !== "idle") {
      this.emit(errorReport("busy", "上一轮还没结束", false, inputId));
      return;
    }
    const phase: TurnPhase = { kind: "turn", inputId, turnId: undefined, interjections: [], steering: new Set(), aborting: false };
    this.phase = phase;
    this.translator.beginTurn();
    let rpc: CodexRpc;
    try {
      rpc = await this.ready();
      if (!this.loggedIn) await this.readAccount(rpc);
      if (!this.loggedIn) {
        // 登录是另一个进程（codex login）做的：关掉这个 app-server，下一条输入重新起才看得到新的登录
        this.closeServer();
        return this.finishTurn("error", t("codex.child.notLoggedIn"));
      }
    } catch (err) {
      this.deps.log(`起 Codex 出错：${describe(err)}`);
      return this.finishTurn("error", describe(err));
    }
    const { record } = this.opened;
    const threadId = record.threadId;
    const note = this.lineage.notes[threadId];
    if (note !== undefined) {
      delete this.lineage.notes[threadId];
      this.context.note(note);
    }
    const context = this.context.forPrompt(inputContext);
    const { effort } = codexChoices(this.assembly.runtimeOptions);
    try {
      const started = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: userInput(text, images),
        clientUserMessageId: inputId,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        ...(effort ? { effort } : {}),
        ...(context ? { additionalContext: { ergo: { value: context, kind: "application" } } } : {}),
      });
      this.turnStarted(phase, started.turn.id);
    } catch (err) {
      // 这一轮可能已经结束了（报错的通知先到）
      if (this.phase === phase) this.finishTurn("error", describe(err));
    }
  }

  /** 这一轮的 id 知道了：记下这条输入是哪一轮（撤回要），要打断的现在打断 */
  private turnStarted(phase: TurnPhase, turnId: string): void {
    if (phase.turnId !== undefined) return;
    phase.turnId = turnId;
    const { record } = this.opened;
    record.started = true;
    const lineage = this.lineage;
    lineage.inputs[phase.inputId] = { thread: record.threadId, turn: turnId };
    (lineage.threads[record.threadId] ??= {}).first ??= turnId;
    this.saveRecord();
    if (phase.aborting) void this.interruptNow();
  }

  async interject(inputId: string, text: string, images: InputImage[]): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== "turn" || phase.aborting || phase.turnId === undefined || !this.rpc) {
      this.emit(errorReport("bad_command", "没有进行中的回合，插话没收下", false, inputId));
      return;
    }
    const steer = this.rpc.request("turn/steer", { threadId: this.opened.record.threadId, expectedTurnId: phase.turnId, input: userInput(text, images), clientUserMessageId: inputId }).then(
      () => {
        phase.interjections.push(inputId);
      },
      (err: unknown) => {
        // 这一轮已经做完、不能插话：留在队里，回合结束后照常作为一条输入送
        this.emit(errorReport("bad_command", `插话没收下：${describe(err)}`, false, inputId));
      },
    );
    phase.steering.add(steer);
    await steer;
    phase.steering.delete(steer);
  }

  async abort(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== "turn") return;
    if (phase.aborting) return;
    phase.aborting = true;
    // 在等判定的、等工具结果的都不等了
    this.guard.abortAll("回合已中止");
    this.tools.abortAll();
    phase.abortTimer = setTimeout(() => {
      if (this.phase === phase) {
        this.deps.log(`打断之后 ${ABORT_GRACE_MS / 1000} 秒还没等到 turn/completed，按被打断收尾`);
        this.finishTurn("aborted");
      }
    }, ABORT_GRACE_MS);
    phase.abortTimer.unref();
    await this.interruptNow();
  }

  /** 现在这一轮（知道 id 的话）turn/interrupt */
  private async interruptNow(): Promise<void> {
    const phase = this.phase;
    if (phase.kind === "idle" || phase.turnId === undefined) return;
    const threadId = phase.kind === "handoff" ? phase.thread : this.opened.record.threadId;
    try {
      await this.rpc?.request("turn/interrupt", { threadId, turnId: phase.turnId });
    } catch (err) {
      this.deps.log(`打断出错：${describe(err)}`);
    }
  }

  /** 手动压缩（宿主协议 compact）：手头有一轮先打断、等它收尾；压完（或没压成）报 compacted 才兑现 */
  async compact(): Promise<void> {
    if (this.phase.kind === "turn") {
      await this.abort();
      await this.whenIdle();
    }
    if (this.phase.kind !== "idle") return;
    const fail = (error: string) => this.emit({ type: "compacted", reason: "manual", outcome: "failed", error });
    if (!this.opened.record.started) {
      this.emit({ type: "compacted", reason: "manual", outcome: "nothing" });
      return;
    }
    let rpc: CodexRpc;
    try {
      rpc = await this.ready();
    } catch (err) {
      return fail(describe(err));
    }
    await new Promise<void>((resolve) => {
      this.phase = { kind: "compacting", turnId: undefined, compacted: false, done: resolve };
      this.translator.beginTurn();
      this.translator.suppress = true;
      rpc.request("thread/compact/start", { threadId: this.opened.record.threadId }).catch((err: unknown) => {
        this.finishCompaction({ type: "compacted", reason: "manual", outcome: "failed", error: describe(err) });
      });
    });
  }

  /** 换运行时之前写交接摘要（宿主协议 write_handoff）：结果以 handoff_written 报回，写完才兑现 */
  async writeHandoff(requestId: string, instructions: string, timeoutMs: number): Promise<void> {
    if (this.phase.kind !== "idle") {
      this.emit({ type: "handoff_written", requestId, error: "上一轮还没结束" });
      return;
    }
    this.emit({ type: "handoff_written", requestId, ...(await this.summarize(instructions, timeoutMs, `handoff-${this.opened.name}`)) });
  }

  /** 在临时分叉（ephemeral，不进原来的会话）上跑一轮写摘要；什么工具都不让用（guard 的 sealed） */
  private async summarize(instructions: string, timeoutMs: number, usageId: string): Promise<{ text: string } | { error: string }> {
    if (!this.opened.record.started) return { error: t("codex.child.noSession") };
    try {
      const rpc = await this.ready();
      const forked = await rpc.request<StartedThread>("thread/fork", { threadId: this.opened.record.threadId, ...this.threadParams(), ephemeral: true, excludeTurns: true });
      const thread = forked.thread.id;
      const outcome = await new Promise<{ text: string } | { error: string }>((resolve) => {
        const timer = setTimeout(() => {
          const phase = this.phase;
          if (phase.kind !== "handoff" || phase.thread !== thread) return;
          phase.timedOut = true;
          void this.interruptNow();
          // 打断也回不来的不再等
          setTimeout(() => finish({ error: t("codex.child.handoffTimeout", { seconds: Math.round(timeoutMs / 1000) }) }), ABORT_GRACE_MS).unref();
        }, timeoutMs);
        timer.unref();
        const finish = (result: { text: string } | { error: string }) => {
          clearTimeout(timer);
          if (this.phase.kind === "handoff" && this.phase.thread === thread) this.phase = { kind: "idle" };
          this.translator.suppress = false;
          this.translator.active = false;
          this.guard.abortAll("回合已结束");
          this.guard.endTurn();
          this.handoffUsageId = undefined;
          resolve(result);
          this.wakeIdle();
        };
        this.handoffUsageId = usageId;
        this.translator.beginTurn();
        this.translator.suppress = true;
        this.phase = { kind: "handoff", thread, turnId: undefined, text: "", timedOut: false, done: finish };
        rpc.request<{ turn: { id: string } }>("turn/start", { threadId: thread, input: userInput(handoffPrompt(instructions), []), approvalPolicy: "untrusted", approvalsReviewer: "user" }).then(
          (started) => {
            const phase = this.phase;
            if (phase.kind === "handoff" && phase.thread === thread) phase.turnId ??= started.turn.id;
          },
          (err: unknown) => finish({ error: describe(err) }),
        );
      });
      void rpc.request("thread/unsubscribe", { threadId: thread }).catch(() => undefined);
      return outcome;
    } catch (err) {
      return { error: describe(err) };
    }
  }

  private handoffUsageId: string | undefined;

  // ───────────────────────── 撤回 ─────────────────────────

  async navigate(command: Extract<HostCommand, { type: "navigate_session" }>): Promise<void> {
    if (this.phase.kind !== "idle") {
      await this.abort();
      await this.whenIdle();
    }
    const report = await navigateCodex(
      {
        current: () => this.opened.record.threadId,
        lineage: this.lineage,
        fork: async (thread, beforeTurn) => {
          const rpc = this.rpc?.alive ? this.rpc : (await this.connect(), this.rpc!);
          const forked = await rpc.request<StartedThread>("thread/fork", { threadId: thread, beforeTurnId: beforeTurn, ...this.threadParams(), excludeTurns: true });
          this.loaded.add(forked.thread.id);
          return forked.thread.id;
        },
        startFresh: async () => {
          const rpc = this.rpc?.alive ? this.rpc : (await this.connect(), this.rpc!);
          const started = await rpc.request<StartedThread>("thread/start", { ...this.threadParams(), serviceName: "ergo" });
          this.loaded.add(started.thread.id);
          return started.thread.id;
        },
        switchTo: (thread, started) => this.switchTo(thread, started),
        log: this.deps.log,
      },
      command,
    );
    this.saveRecord();
    this.emit(report);
  }

  /** 换成接着另一个 thread：旧的退订（不再收它的通知） */
  private async switchTo(thread: string, started: boolean): Promise<void> {
    const { record } = this.opened;
    if (record.threadId && this.rpc?.alive) {
      const old = record.threadId;
      this.loaded.delete(old);
      await this.rpc.request("thread/unsubscribe", { threadId: old }).catch((err: unknown) => this.deps.log(`退订 thread ${old} 出错：${describe(err)}`));
    }
    record.threadId = thread;
    record.started = started;
    this.saveRecord();
  }

  // ───────────────────────── 来自守护进程的小命令 ─────────────────────────

  replyHostTool(requestId: string, result: HostToolResult): boolean {
    return this.tools.reply(requestId, result);
  }

  updateContribution(id: string, text: string): void {
    this.context.update(id, text);
  }

  setScopeContext(recentRecords: string | undefined): void {
    this.context.setRecentRecords(recentRecords);
  }

  replyGuard(requestId: string, verdict: GuardVerdict): boolean {
    return this.guard.replyGuard(requestId, verdict);
  }

  replyAsk(requestId: string, reply: RuntimeQuestionReply): boolean {
    return this.guard.replyAsk(requestId, reply);
  }

  /** 子进程收尾：手头有一轮先打断（等一会儿），再关掉 app-server 和本机通道 */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.guard.abortAll("回合已中止");
    this.tools.abortAll();
    if (this.phase.kind !== "idle") await Promise.race([this.interruptNow(), new Promise((resolve) => setTimeout(resolve, DISPOSE_INTERRUPT_MS).unref())]);
    const rpc = this.rpc;
    this.rpc = undefined;
    await rpc?.close().catch(() => undefined);
    await this.bridge?.close().catch(() => undefined);
    this.bridge = undefined;
  }

  private closeServer(): void {
    const rpc = this.rpc;
    this.rpc = undefined;
    void rpc?.close();
  }

  // ───────────────────────── 通知 ─────────────────────────

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const phase = this.phase;
    if (phase.kind === "handoff" && threadId === phase.thread) return this.onHandoffNotification(phase, method, params);
    const current = this.opened.record.threadId;
    const parent = threadId === undefined ? undefined : this.subAgents.get(threadId);
    switch (method) {
      case "turn/started": {
        const turnId = (params.turn as { id?: string } | undefined)?.id;
        if (threadId !== current || !turnId) return;
        if (phase.kind === "turn") this.turnStarted(phase, turnId);
        else if (phase.kind === "compacting") phase.turnId = turnId;
        return;
      }
      case "turn/completed":
        if (threadId === current) this.onTurnCompleted(params.turn as { id?: string; status?: string; error?: unknown });
        return;
      case "item/started":
        if (threadId === current || parent !== undefined) this.onItemStarted(params.item as CodexItem, parent);
        return;
      case "item/completed":
        if (threadId === current || parent !== undefined) this.onItemCompleted(params.item as CodexItem, parent);
        return;
      case "item/agentMessage/delta":
        if (threadId === current) this.translator.delta(String(params.itemId), "text", String(params.delta ?? ""));
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (threadId === current) this.translator.delta(String(params.itemId), "thinking", String(params.delta ?? ""));
        return;
      case "thread/tokenUsage/updated":
        if (threadId === current) this.onTokenUsage(params.tokenUsage as TokenUsageNotice | undefined);
        return;
      case "error":
        if (threadId === current && params.willRetry !== true && phase.kind === "turn") phase.failure = turnError(params.error, undefined);
        else this.deps.log(`Codex 报错（${params.willRetry === true ? "它会重试" : "不重试"}）：${JSON.stringify(params.error)}`);
        return;
      case "model/rerouted":
        if (threadId === current && typeof params.toModel === "string") {
          this.deps.log(`Codex 把模型从 ${String(params.fromModel)} 换成了 ${params.toModel}（${String(params.reason)}）`);
          this.translator.model = params.toModel;
        }
        return;
      case "account/rateLimits/updated": {
        const limits = params.rateLimits as { rateLimitReachedType?: string | null; primary?: { usedPercent?: number } | null } | undefined;
        this.deps.log(`Codex 额度：用了 ${limits?.primary?.usedPercent ?? "?"}%${limits?.rateLimitReachedType ? `，到限了（${limits.rateLimitReachedType}）` : ""}`);
        return;
      }
      case "hook/completed": {
        const run = params.run as { status?: string; eventName?: string; statusMessage?: string | null } | undefined;
        // 钩子自己出错 Codex 会接着往下走：记进日志，靠审批和事后核对兜着
        if (run?.eventName === "preToolUse" && run.status === "failed") this.deps.log(`守卫钩子跑失败了：${run.statusMessage ?? ""}`);
        return;
      }
      case "configWarning":
        this.deps.log(`Codex 的配置有警告：${String(params.summary)}`);
        return;
      default:
        return;
    }
  }

  private onItemStarted(item: CodexItem, parent: string | undefined): void {
    if (item.type === "contextCompaction") {
      // 压缩就要开始：装配了范围审视的，守护进程据此按自己记下的事件另起审视（宿主协议 compacting）
      if (this.assembly.scopeReview) this.emit({ type: "compacting", reason: this.phase.kind === "compacting" ? "manual" : "threshold" });
      return;
    }
    if (item.type === "collabAgentToolCall") this.noteSubAgents(item);
    const call = toolOfItem(item, (relayName) => this.tools.hostNameOf(relayName));
    if (!call) return;
    if (item.type === "fileChange") this.fileCalls.set(call.id, call);
    this.translator.ensureStarted(call, parent);
    // 二狗的工具在中转那边过守卫；联网搜索开始时还不知道搜什么（Codex 在服务端做，反正拦不住），结束时再核对
    if (call.native.toolName.startsWith(`mcp__${ERGO_MCP_SERVER}__`) || item.type === "webSearch") return;
    this.guard.audit(call);
  }

  private onItemCompleted(item: CodexItem, parent: string | undefined): void {
    switch (item.type) {
      case "agentMessage":
      case "reasoning":
        if (parent === undefined) this.translator.messageDone(item);
        return;
      case "contextCompaction":
        this.onCompactionDone();
        return;
      default:
        break;
    }
    if (item.type === "collabAgentToolCall") this.noteSubAgents(item);
    const call = toolOfItem(item, (relayName) => this.tools.hostNameOf(relayName));
    if (!call) return;
    this.fileCalls.delete(call.id);
    this.translator.ensureStarted(call, parent);
    if (!call.native.toolName.startsWith(`mcp__${ERGO_MCP_SERVER}__`)) this.guard.audit(call);
    this.translator.itemDone(item, parent, this.assembly.forwardToolCalls && this.guard.pending(call.id));
  }

  private noteSubAgents(item: CodexItem): void {
    const ids = item.receiverThreadIds;
    if (!Array.isArray(ids) || typeof item.id !== "string") return;
    for (const id of ids) if (typeof id === "string") this.subAgents.set(id, item.id);
  }

  private onCompactionDone(): void {
    this.context.refreshStanding();
    const phase = this.phase;
    if (phase.kind === "compacting") phase.compacted = true;
    else this.emit({ type: "compacted", reason: "threshold", outcome: "done" });
  }

  private onTokenUsage(notice: TokenUsageNotice | undefined): void {
    if (!notice) return;
    if (typeof notice.modelContextWindow === "number" && notice.modelContextWindow > 0) this.opened.record.contextWindow = notice.modelContextWindow;
    if (this.phase.kind === "compacting") this.translator.usage(notice, "compaction", `compaction-${++this.compactionSeq}`);
    else this.translator.usage(notice);
  }

  private onTurnCompleted(turn: { id?: string; status?: string; error?: unknown }): void {
    const phase = this.phase;
    if (phase.kind === "compacting") {
      if (phase.compacted) return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "done" });
      if (turn.status === "completed") return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "nothing" });
      if (turn.status === "interrupted") return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "aborted" });
      return this.finishCompaction({ type: "compacted", reason: "manual", outcome: "failed", error: turnError(turn.error, t("codex.child.compactFailed")) });
    }
    if (phase.kind !== "turn") {
      this.deps.log(`没有进行中的一轮时来了 turn/completed（${String(turn.id)}），不报轮次结束`);
      return;
    }
    if (phase.turnId !== undefined && turn.id !== undefined && turn.id !== phase.turnId) return;
    if (phase.steering.size > 0) {
      void Promise.allSettled(phase.steering).then(() => {
        phase.steering.clear();
        if (this.phase === phase) this.onTurnCompleted(turn);
      });
      return;
    }
    if (turn.status === "interrupted" || phase.aborting) return this.finishTurn("aborted");
    if (turn.status === "failed") return this.finishTurn("error", turnError(turn.error, phase.failure));
    this.finishTurn("completed");
  }

  private onHandoffNotification(phase: HandoffPhase, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started":
        phase.turnId ??= (params.turn as { id?: string } | undefined)?.id;
        return;
      case "item/completed": {
        const item = params.item as CodexItem;
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) phase.text = item.text;
        return;
      }
      case "thread/tokenUsage/updated":
        this.translator.usage(params.tokenUsage as TokenUsageNotice, "handoff", this.handoffUsageId);
        return;
      case "turn/completed": {
        const turn = params.turn as { status?: string; error?: unknown };
        if (phase.timedOut) return phase.done({ error: t("codex.child.handoffInterrupted") });
        if (turn.status !== "completed") return phase.done({ error: turnError(turn.error, t("codex.child.handoffFailed")) });
        return phase.done(phase.text.trim() ? { text: phase.text.trim() } : { error: t("codex.child.handoffEmpty") });
      }
      default:
        return;
    }
  }

  /** app-server 退出了：手头的按出错收尾，下一条输入重新起 */
  private ended(reason: string): void {
    this.rpc = undefined;
    this.loaded.clear();
    this.guard.abortAll(t("codex.child.ended"));
    this.tools.abortAll();
    if (this.disposing) return;
    this.deps.log(`app-server 结束了：${reason}`);
    const phase = this.phase;
    const text = t("codex.child.ended");
    if (phase.kind === "turn") this.finishTurn(phase.aborting ? "aborted" : "error", phase.aborting ? undefined : text);
    else if (phase.kind === "compacting") this.finishCompaction({ type: "compacted", reason: "manual", outcome: "failed", error: text });
    else if (phase.kind === "handoff") phase.done({ error: text });
  }

  // ───────────────────────── 服务端发来的请求（审批、问用户） ─────────────────────────

  private async onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { decision: (await this.approveCommand(params)) ? "accept" : "decline" };
      case "item/fileChange/requestApproval":
        return { decision: (await this.approveFile(params)) ? "accept" : "decline" };
      case "item/permissions/requestApproval":
        return this.approvePermissions(params);
      case "item/tool/requestUserInput":
        return this.guard.askUser(params);
      case "mcpServer/elicitation/request":
        return this.onElicitation(params);
      case "item/tool/call":
        // 没登记动态工具：不该来
        return { contentItems: [{ type: "inputText", text: "没有这个工具" }], success: false };
      case "applyPatchApproval":
      case "execCommandApproval":
        // 旧接口：只有 v1 的会话才发，二狗不用
        return { decision: "denied" };
      default:
        throw new CodexRpcError(`Method not found: ${method}`, -32601);
    }
  }

  private async approveCommand(params: Record<string, unknown>): Promise<boolean> {
    const id = String(params.itemId ?? "");
    if (params.kind === "writeStdin") {
      const key = `${id}:stdin:${String(params.approvalId ?? "")}`;
      const call: CodexToolCall = { id: key, toolName: "write_stdin", args: { input: params.command ?? null }, native: { toolName: "write_stdin", args: params } };
      return this.approveOnce(call);
    }
    const network = params.networkApprovalContext as { host?: string; protocol?: string } | null | undefined;
    if (network?.host) {
      const key = `${id}:net:${network.host}`;
      const url = `${network.protocol ?? "https"}://${network.host}`;
      return this.approveOnce({ id: key, toolName: "web_fetch", args: { url }, native: { toolName: "network_access", args: params } });
    }
    const command = typeof params.command === "string" ? params.command : "";
    return this.guard.approve({ id, toolName: "bash", args: { command }, native: { toolName: "Bash", args: { command, cwd: params.cwd ?? null } } });
  }

  /** 不对应一个条目的审批（往终端送输入、要联网）：单独记一次调用，判完就结束 */
  private async approveOnce(call: CodexToolCall): Promise<boolean> {
    const allowed = await this.guard.approve(call);
    this.translator.end(call.id, !allowed, allowed ? "" : t("codex.child.approvalDeclined"));
    return allowed;
  }

  private approveFile(params: Record<string, unknown>): Promise<boolean> {
    const id = String(params.itemId ?? "");
    const call: CodexToolCall = this.fileCalls.get(id) ?? { id, toolName: "apply_patch_unparsed", args: { reason: params.reason ?? null }, native: { toolName: "apply_patch", args: params } };
    return this.guard.approve(call);
  }

  private async approvePermissions(params: Record<string, unknown>): Promise<unknown> {
    const id = `${String(params.itemId ?? "")}:permissions`;
    const permissions = (params.permissions ?? {}) as { network?: unknown; fileSystem?: unknown };
    const allowed = await this.approveOnce({ id, toolName: "request_permissions", args: { reason: params.reason ?? null, permissions }, native: { toolName: "request_permissions", args: params } });
    const granted = allowed ? { ...(permissions.network ? { network: permissions.network } : {}), ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}) } : {};
    return { permissions: granted, scope: "turn" };
  }

  /** MCP 服务要问用户：Codex 给 MCP 工具调用要审批也走这里（调用本身已经过了守卫），放行；服务自己要填的表单界面接不了，拒掉 */
  private onElicitation(params: Record<string, unknown>): unknown {
    const meta = params._meta as { codex_approval_kind?: unknown } | null | undefined;
    if (meta?.codex_approval_kind === "mcp_tool_call" && this.assembly.forwardToolCalls && this.phase.kind === "turn") return { action: "accept", content: {}, _meta: null };
    this.deps.log(`MCP 服务 ${String(params.serverName)} 要用户填东西（${String(params.mode)}），界面接不了，拒掉`);
    return { action: "decline", content: null, _meta: null };
  }

  // ───────────────────────── 收尾 ─────────────────────────

  private finishTurn(outcome: TurnOutcome, errorMessage?: string): void {
    const phase = this.phase;
    if (phase.kind === "turn" && phase.abortTimer) clearTimeout(phase.abortTimer);
    this.guard.abortAll("回合已结束");
    this.guard.endTurn();
    this.tools.abortAll();
    this.translator.finishTurn(outcome === "aborted" ? "aborted" : outcome === "error" ? "error" : "done", errorMessage, t("codex.child.noResult"));
    this.phase = { kind: "idle" };
    const interjected = phase.kind === "turn" ? phase.interjections : [];
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }), ...(interjected.length > 0 ? { interjected } : {}) });
    this.saveRecord();
    this.wakeIdle();
  }

  private finishCompaction(report: CompactedReport): void {
    const phase = this.phase;
    if (phase.kind !== "compacting") return;
    this.translator.suppress = false;
    this.translator.active = false;
    this.phase = { kind: "idle" };
    this.emit(report);
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

  private saveRecord(): void {
    try {
      writeRecord(this.opened.file, this.opened.record);
    } catch (err) {
      this.deps.log(`写会话记录出错：${describe(err)}`);
    }
  }
}

function readTrust(file: string): { key: string; hash: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { key?: unknown; hash?: unknown };
    return typeof parsed.key === "string" && typeof parsed.hash === "string" ? { key: parsed.key, hash: parsed.hash } : undefined;
  } catch {
    return undefined;
  }
}

