// 假的 Agent SDK（287 号票，只在测试里）：Claude Code 适配子进程的 query 换成它，不启动真的 claude、不花额度。
// - FakeClaudeQuery：实现适配子进程用到的那一点（流式输入、吐消息、interrupt、close）。测试扮演 claude：nextInput() 等适配子进程推来的
//   用户消息，emit() 按顺序吐 SDK 的消息，fail() 让迭代器 throw，end() 让它结束；options 是适配子进程交给 query 的选项。
// - createFakeClaudeSdk()：手动挡（契约测试一条一条地吐，插话、打断、压缩的时机都能卡住）；
// - scriptedClaudeSdk(script)：按 faux 剧本自动回（主切面和拉起真子进程的契约测试用，test/fixtures/fake-claude-child.ts）：
//   每条用户输入是一轮，剧本一步是一次模型调用——reply 吐逐字输出、几条 assistant（一块一条）、工具调用的假结果，最后一条 result；
//   echo_context 把适配子进程交给 query 的选项和这条输入回成一段 JSON（契约测试据此核对环境里没有 ANTHROPIC_API_KEY、系统提示怎么追加的）。
// - 消息的写法（sdk.*）照 @anthropic-ai/claude-agent-sdk 的 sdk.d.ts，只填适配子进程看的字段。
// - 288 号票：runTool() 扮演 claude 执行一次工具调用之前的权限流程——先叫适配子进程交来的 PreToolUse 钩子（全量闸口：拦下、改参数、
//   放行时要不要再问），钩子没给决定时按 Claude Code 自己的规则（permissionAsks 里的工具、AskUserQuestion、ExitPlanMode 要问人，别的规则里放行），
//   要问人的叫 canUseTool（没有就是 permissionPrompts: "none"，一律拒绝），执行完叫 PostToolUse 钩子收 additionalContext。
//   interrupt() 让钩子、canUseTool 拿到的中止信号触发（和真的一样：打断时还在等的判定、提问按中止收尾）。
//   按剧本自动回时每次工具调用都走它；Agent 工具的参数里写了 fake_subagent_calls（只在测试里）的，先扮演子代理把这几次调用做了
//   （带 parent_tool_use_id 的回复和结果，钩子输入带 agent_id）。
// - 291 号票：扮演 Claude Code 这一侧的 MCP 客户端——options.mcpServers 里 type: "sdk" 的进程内服务照 SDK 的写法接上（instance.connect(传输)），
//   initialize、tools/list（收到 notifications/tools/list_changed 下一次重列）、tools/call（_meta 带 claudecode/toolUseId）；剧本里调 mcp__<服务>__<工具>
//   的，过完权限流程就经它调（工具不在服务现在的清单里回出错）。setMcpServers 照 SDK 的规矩（同名已登记的保留原来的连接，新的接上，没列的断开）；
//   reloadPlugins 记次数、照插件目录列出 ergo:<目录名>。钩子：每个 query 的第一条输入先叫 SessionStart（startup / resume），每条输入叫 UserPromptSubmit，
//   收下的 additionalContext 按输入记着（contextFor）；echo_context 也回它、这一轮工具结果的 PostToolUse 交的话、插件目录里的 skill、MCP 服务和工具。
// - 293 号票：扮演 Claude Code 的会话记录（FakeClaudeStore）——每个会话一串主线条目（推来的用户消息、吐出的主线 assistant 和工具结果，uuid 照原样），
//   forkSession 复制成新会话（换新 uuid、不带撤销历史、截到给的那条为止），getSessionMessages 读主线；文件检查点：按剧本自动回时 Write、Edit 真的写盘，
//   每条输入（uuid）时第一次改的文件记下原来的内容，rewindFiles 把那条输入及之后改过的文件恢复回去（要开 enableFileCheckpointing）。给了文件的存进文件
//   （子进程重启后还在，主切面里测试也能读）。echo_context 另回这个会话的主线（history）。剧本认 branch_on_context：按这条输入（连同钩子交的话）选一步。
// - 309 号票：按剧本自动回时用户打的 /compact 扮演 Claude Code 的手动压缩（不取剧本）：先叫 PreCompact 钩子，再 compact_boundary、SessionStart（compact）、
//   本地输出、result；手动挡的 preCompactHooks() 叫 PreCompact。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HookEvent, HookInput, HookJSONOutput, McpServerConfig, Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeChainMessage, ClaudeRewindResult, ClaudeSessionOps } from "../../src/claude-code/child/navigation.ts";
import type { ClaudeQuery, ClaudeQueryFunction } from "../../src/claude-code/child/session.ts";
import type { FauxStep, FauxUsage } from "../../src/runtime/index.ts";

type Out = { message: SDKMessage } | { error: Error } | { end: true };

/**
 * 假 SDK 报的斜杠命令（289 号票）：system/init 的 slash_commands 也是这几个。
 * 310 号票加一个用户自己的命令（不在 Claude Code 内置命令的中文说明表里，说明要交给二狗的模型翻）
 */
export const FAKE_COMMANDS = [
  { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>" },
  { name: "context", description: "Visualize current context usage", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "" },
  { name: "deploy-notes", description: "Write release notes for the current branch", argumentHint: "[version]" },
];

/** 假 SDK 报的模型（289 号票） */
export const FAKE_MODELS = [
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet for everyday tasks" },
  { value: "opus", displayName: "Opus", description: "Opus for complex work" },
];

/** 一次工具调用过了权限流程之后：执行没有（执行的参数）、拦下的说明、钩子给的决定、PostToolUse 交的话 */
export interface FakeToolRun {
  allowed: boolean;
  /** 执行时用的参数（钩子、canUseTool 改过的） */
  input: Record<string, unknown>;
  /** 拦下时模型收到的说明 */
  denial?: string;
  /** PreToolUse 钩子给的决定（没给是 undefined） */
  decision?: string;
  /** 叫过 canUseTool */
  asked: boolean;
  /** PostToolUse 钩子交的 additionalContext */
  context?: string;
  /** 执行的结果（给了 execute 的：291 号票，进程内 MCP 服务的调用） */
  output?: unknown;
}

/** Claude Code 自己的权限要问人的工具（规则里没放行的）：AskUserQuestion、ExitPlanMode 总要问 */
const ALWAYS_ASK = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** JSON-RPC 的一条消息 */
interface Rpc {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** MCP 工具调用交回的（照 MCP 的 CallToolResult） */
export interface FakeMcpResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface FakeTransport {
  start(): Promise<void>;
  send(message: Rpc): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Rpc) => void;
  onclose?: () => void;
}

/** 扮演 SDK 接上一个进程内 MCP 服务（Query.connectSdkMcpServer）：传输两头都在这里 */
export class FakeMcpLink {
  readonly name: string;
  /** 服务发来 list_changed 的次数 */
  listChanged = 0;
  closed = false;
  private seq = 0;
  private readonly pending = new Map<string, (message: Rpc) => void>();
  private tools: Array<{ name: string; description?: string; inputSchema?: unknown }> | undefined;
  private readonly transport: FakeTransport;
  private readonly ready: Promise<void>;

  constructor(name: string, instance: { connect(transport: unknown): Promise<void> }) {
    this.name = name;
    const transport: FakeTransport = {
      start: () => Promise.resolve(),
      send: (message: Rpc) => {
        if (message.id !== undefined && message.method === undefined) {
          const resolve = this.pending.get(String(message.id));
          this.pending.delete(String(message.id));
          resolve?.(message);
        } else if (message.method === "notifications/tools/list_changed") {
          this.listChanged += 1;
          this.tools = undefined;
        }
        return Promise.resolve();
      },
      close: () => {
        this.closed = true;
        transport.onclose?.();
        return Promise.resolve();
      },
    };
    this.transport = transport;
    this.ready = instance.connect(transport).then(async () => {
      await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
      transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
    });
  }

  /** 服务现在的工具（list_changed 之后重列） */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.ready;
    if (!this.tools) this.tools = ((await this.request("tools/list")).result as { tools: Array<{ name: string }> }).tools;
    return this.tools;
  }

  /** 调一次工具（toolUseId 放进 _meta；requestId 给了用它，测试取消时用） */
  async callTool(tool: string, args: Record<string, unknown>, toolUseId?: string, requestId?: string): Promise<FakeMcpResult> {
    await this.ready;
    const reply = await this.request("tools/call", { name: tool, arguments: args, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}) }, requestId);
    return reply.result as FakeMcpResult;
  }

  /** 取消一次在做的调用（Claude Code 打断时发的 notifications/cancelled） */
  cancel(requestId: string): void {
    this.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
  }

  close(): void {
    void this.transport.close();
  }

  private request(method: string, params?: Record<string, unknown>, requestId?: string): Promise<Rpc> {
    const id = requestId ?? `${this.name}-${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.transport.onmessage?.({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }
}

/** 假 SDK 的会话记录在会话目录里的文件名（293 号票：fixtures/fake-claude-child.ts 存在这里，主切面里测试读它） */
export const FAKE_CLAUDE_STORE = "fake-claude-store.json";

/** 假 SDK 记的一个会话：主线条目、文件检查点（每条输入时第一次改的文件原来的内容，null 是原来没有） */
interface FakeSessionData {
  entries: ClaudeChainMessage[];
  backups: Array<{ at: string; file: string; before: string | null }>;
}

/** 假 SDK 的会话记录（293 号票，见文件开头）：file 给了就存进去（每次改都写） */
export class FakeClaudeStore {
  private sessions: Record<string, FakeSessionData> = {};
  /** 分叉过的（测试核对）：从哪个会话、截到哪条、分出的新会话 */
  forks: Array<{ from: string; upTo: string; to: string }> = [];
  /** 恢复过的（测试核对）：哪个会话、恢复到哪条输入时、恢复了哪些文件 */
  rewinds: Array<{ session: string; uuid: string; files: string[] }> = [];
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: Record<string, FakeSessionData>; forks: FakeClaudeStore["forks"]; rewinds: FakeClaudeStore["rewinds"] };
      this.sessions = saved.sessions;
      this.forks = saved.forks;
      this.rewinds = saved.rewinds;
    }
  }

  /** 读存好的记录（主切面里测试从守护进程的数据目录读） */
  static load(file: string): FakeClaudeStore {
    return new FakeClaudeStore(file);
  }

  private session(id: string): FakeSessionData {
    return (this.sessions[id] ??= { entries: [], backups: [] });
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ sessions: this.sessions, forks: this.forks, rewinds: this.rewinds }));
  }

  /** 会话里记一条主线条目 */
  append(session: string, entry: ClaudeChainMessage): void {
    this.session(session).entries.push(entry);
    this.save();
  }

  /** 有没有这个会话 */
  has(session: string): boolean {
    return this.sessions[session] !== undefined;
  }

  /** 会话的主线（SDK 的 getSessionMessages） */
  messages(session: string): ClaudeChainMessage[] {
    return (this.sessions[session]?.entries ?? []).map((e) => ({ ...e }));
  }

  /** 复制成新会话（SDK 的 forkSession）：换新 uuid、不带撤销历史，截到 upTo（含）为止 */
  fork(session: string, upTo: string): string {
    const source = this.sessions[session];
    if (!source) throw new Error(`Session ${session} not found`);
    const at = source.entries.findIndex((e) => e.uuid === upTo);
    if (at < 0) throw new Error(`Message ${upTo} not found in session ${session}`);
    const to = randomUUID();
    this.sessions[to] = { entries: source.entries.slice(0, at + 1).map((e) => ({ ...e, uuid: randomUUID() })), backups: [] };
    this.forks.push({ from: session, upTo, to });
    this.save();
    return to;
  }

  /** 第 turn 条输入（uuid）时要改 file：这条输入里第一次改它就记下原来的内容，然后写盘（content 是 null 就删掉） */
  writeFile(session: string, turn: string, file: string, content: string | null): void {
    const data = this.session(session);
    if (!data.backups.some((b) => b.at === turn && b.file === file)) data.backups.push({ at: turn, file, before: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null });
    if (content === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    this.save();
  }

  /** 按检查点恢复（Query.rewindFiles）：uuid 那条输入及之后改过的文件恢复到那条输入之前 */
  rewind(session: string, uuid: string): ClaudeRewindResult {
    const data = this.sessions[session];
    const order = data?.entries.map((e) => e.uuid) ?? [];
    const at = order.indexOf(uuid);
    if (!data || at < 0) return { canRewind: false, error: `No file checkpoint for message ${uuid}` };
    const later = data.backups.filter((b) => order.indexOf(b.at) >= at);
    const files: string[] = [];
    for (const backup of later) {
      if (files.includes(backup.file)) continue;
      files.push(backup.file);
      if (backup.before === null) fs.rmSync(backup.file, { force: true });
      else fs.writeFileSync(backup.file, backup.before);
    }
    data.backups = data.backups.filter((b) => !later.includes(b));
    this.rewinds.push({ session, uuid, files });
    this.save();
    return { canRewind: true, filesChanged: files };
  }

  /** 交给适配子进程的会话函数（navigation.ts 的 ClaudeSessionOps） */
  ops(): ClaudeSessionOps {
    return {
      fork: (session, upTo) => Promise.resolve(this.fork(session, upTo)),
      messages: (session) => Promise.resolve(this.messages(session)),
    };
  }
}

/** 主线条目给人看的一行（echo_context 的 history） */
function chainLine(entry: ClaudeChainMessage): string {
  const content = (entry.message as { content?: unknown }).content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  const text = blocks
    .map((b) => (b.type === "text" ? String(b.text) : b.type === "tool_use" ? `<tool_use ${String(b.name)}>` : b.type === "tool_result" ? "<tool_result>" : b.type === "thinking" ? "<thinking>" : `<${String(b.type)}>`))
    .join(" ");
  return `${entry.type}: ${text}`;
}

export class FakeClaudeQuery implements ClaudeQuery {
  readonly options: Options;
  /** 适配子进程推来的用户消息，按先后 */
  readonly inputs: SDKUserMessage[] = [];
  interrupts = 0;
  closed = false;
  /** 收到一条用户消息时（scripted 用） */
  onInput: ((message: SDKUserMessage) => void) | undefined;
  /** interrupt() 时（测试扮演 claude：吐打断后的 result） */
  onInterrupt: (() => void) | undefined;
  /** 288 号票：Claude Code 自己的规则里没放行、要问人的工具（钩子没给决定时到 canUseTool） */
  readonly permissionAsks = new Set<string>();
  /** 291 号票：接上的进程内 MCP 服务（服务名 → 连接）；setMcpServers 换 */
  readonly mcp = new Map<string, FakeMcpLink>();
  /** 291 号票：setMcpServers 每次给的服务名 */
  readonly setMcpServersCalls: string[][] = [];
  /** 291 号票：reloadPlugins 叫过几次 */
  reloads = 0;
  /** 291 号票：每条输入（uuid）收到的钩子 additionalContext（SessionStart 的在前） */
  private readonly contexts = new Map<string, string>();
  /** 291 号票：这一轮工具结果的 PostToolUse 交的话（scripted 每轮清空） */
  toolContexts: string[] = [];
  private sessionStarted = false;
  private readonly out: Out[] = [];
  private outWaiter: (() => void) | undefined;
  private inputCursor = 0;
  private inputWaiters: Array<() => void> = [];
  /** 钩子、canUseTool 拿到的中止信号：interrupt() 触发，之后换一个新的 */
  private aborter = new AbortController();
  /** 293 号票：会话记录（主线、检查点） */
  readonly store: FakeClaudeStore;
  /** 293 号票：这一轮的输入（uuid）：这一轮里改的文件记在它名下 */
  turnUuid: string | undefined;

  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, store: FakeClaudeStore = new FakeClaudeStore()) {
    this.options = params.options;
    this.store = store;
    for (const [name, config] of Object.entries(params.options.mcpServers ?? {})) this.connectMcp(name, config);
    void (async () => {
      for await (const message of params.prompt) {
        // 293 号票：推来的用户消息进这个会话的主线（uuid 照原样）
        if (message.uuid) store.append(this.sessionId, { uuid: message.uuid, type: "user", message: message.message });
        this.inputs.push(message);
        for (const wake of this.inputWaiters.splice(0)) wake();
        this.onInput?.(message);
      }
    })();
  }

  /** 吐消息（按顺序）；主线的 assistant、工具结果记进会话记录（293 号票） */
  emit(...messages: SDKMessage[]): void {
    for (const message of messages) {
      const { type, uuid, parent_tool_use_id: parent } = message as { type?: string; uuid?: string; parent_tool_use_id?: string | null };
      if ((type === "assistant" || type === "user") && uuid && !parent) this.store.append(this.sessionId, { uuid, type, message: (message as { message: unknown }).message });
      this.push({ message });
    }
  }

  /** 按检查点恢复文件（293 号票）：要开 enableFileCheckpointing */
  rewindFiles(userMessageId: string): Promise<ClaudeRewindResult> {
    if (!this.options.enableFileCheckpointing) return Promise.resolve({ canRewind: false, error: "File checkpointing is not enabled" });
    return Promise.resolve(this.store.rewind(this.sessionId, userMessageId));
  }

  /** 这个会话的主线，一条一行（echo_context 的 history） */
  history(): string[] {
    return this.store.messages(this.sessionId).map(chainLine);
  }

  /** 迭代器 throw（claude 出错退出） */
  fail(error: Error): void {
    this.push({ error });
  }

  /** 迭代器结束（claude 退出） */
  end(): void {
    this.push({ end: true });
  }

  /** 等下一条（从上次取到的往后）用户消息 */
  async nextInput(timeoutMs = 10_000): Promise<SDKUserMessage> {
    const deadline = Date.now() + timeoutMs;
    while (this.inputCursor >= this.inputs.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等适配子进程推用户消息超时（已收到 ${this.inputs.length} 条）`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.inputWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.inputs[this.inputCursor++]!;
  }

  interrupt(): Promise<undefined> {
    this.interrupts += 1;
    this.aborter.abort();
    this.aborter = new AbortController();
    this.onInterrupt?.();
    return Promise.resolve(undefined);
  }

  /** Claude Code 能用的斜杠命令（289 号票：输入框的候选） */
  supportedCommands(): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    // 291 号票：插件里的 skill 也报（ergo:<目录名>）
    return Promise.resolve([...FAKE_COMMANDS.map((c) => ({ ...c })), ...this.pluginSkills().map((name) => ({ name: `ergo:${name}`, description: `（插件里的 ${name}）`, argumentHint: "" }))]);
  }

  /** 会话中途换动态的 MCP 服务（291 号票）：照 SDK 的规矩——同名已登记的保留原来的连接，新的接上，没列的断开 */
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }> {
    this.setMcpServersCalls.push(Object.keys(servers));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [name, link] of this.mcp) {
      if (name in servers) continue;
      link.close();
      this.mcp.delete(name);
      removed.push(name);
    }
    for (const [name, config] of Object.entries(servers)) {
      if (this.mcp.has(name)) continue;
      if (this.connectMcp(name, config)) added.push(name);
    }
    return Promise.resolve({ added, removed, errors: {} });
  }

  /** 从盘上重新加载插件（291 号票）：记次数，照插件目录列出 ergo:<目录名>（加上 Claude Code 自己的命令） */
  reloadPlugins(): Promise<{ commands: Array<{ name: string; description: string; argumentHint: string }> }> {
    this.reloads += 1;
    return Promise.resolve({
      commands: [...FAKE_COMMANDS.map((c) => ({ ...c })), ...this.pluginSkills().map((name) => ({ name: `ergo:${name}`, description: `（插件里的 ${name}）`, argumentHint: "" }))],
    });
  }

  /** 交给 query 的本地插件目录里有哪些 skill（目录名） */
  pluginSkills(): string[] {
    return (this.options.plugins ?? []).flatMap((plugin) => {
      const dir = path.join(plugin.path, "skills");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md"))) : [];
    });
  }

  /** 进程内 MCP 服务（没接上的是 undefined） */
  mcpLink(server: string): FakeMcpLink | undefined {
    return this.mcp.get(server);
  }

  /**
   * 扮演 Claude Code 处理一条输入之前叫钩子（291 号票）：这个 query 的第一条先叫 SessionStart（接着的会话是 resume，新开的是 startup），
   * 再叫 UserPromptSubmit；交回收下的 additionalContext（几段空一行），也按这条输入的 uuid 记着
   */
  async promptHooks(input: SDKUserMessage): Promise<string> {
    const parts: string[] = [];
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      parts.push(...(await this.runHooks("SessionStart", { source: this.options.resume ? "resume" : "startup" })));
    }
    parts.push(...(await this.runHooks("UserPromptSubmit", { prompt: inputText(input), source: "sdk" })));
    const context = parts.join("\n\n");
    if (input.uuid) this.contexts.set(input.uuid, context);
    return context;
  }

  /** 压缩之后（291 号票）：叫 SessionStart（source 是 compact），交回 additionalContext */
  async compactedHooks(): Promise<string> {
    return (await this.runHooks("SessionStart", { source: "compact" })).join("\n\n");
  }

  /** 压缩之前（309 号票）：叫 PreCompact（手动的 /compact 是 manual，自动的是 auto；手动的带上 /compact 后面的指令） */
  async preCompactHooks(trigger: "manual" | "auto", customInstructions: string | null = null): Promise<void> {
    await this.runHooks("PreCompact", { trigger, custom_instructions: customInstructions });
  }

  /** 这条输入（uuid）收到的钩子 additionalContext */
  contextFor(uuid: string | undefined): string | undefined {
    return uuid === undefined ? undefined : this.contexts.get(uuid);
  }

  /** 叫某种钩子（不带 matcher 的都叫），交回各自的 additionalContext */
  async runHooks(event: HookEvent, fields: Record<string, unknown>): Promise<string[]> {
    const out: string[] = [];
    for (const matcher of this.options.hooks?.[event] ?? []) {
      for (const hook of matcher.hooks) {
        const output = await hook({ session_id: this.sessionId, transcript_path: "", cwd: this.options.cwd ?? "", hook_event_name: event, ...fields } as HookInput, undefined, {
          signal: this.aborter.signal,
        });
        const context = (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
        if (context) out.push(context);
      }
    }
    return out;
  }

  private connectMcp(name: string, config: McpServerConfig): boolean {
    if (config.type !== "sdk" || !("instance" in config)) return false;
    this.mcp.set(name, new FakeMcpLink(name, config.instance as unknown as { connect(transport: unknown): Promise<void> }));
    return true;
  }

  /** Claude Code 能选的模型（289 号票：⚙ 的模型列表） */
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return Promise.resolve(FAKE_MODELS.map((m) => ({ ...m })));
  }

  /**
   * 扮演 claude 执行一次工具调用之前的权限流程（288 号票，见文件开头）：PreToolUse 钩子 → 要问人的到 canUseTool → （调用方执行）→ PostToolUse 钩子。
   * agentId：子代理里的调用（钩子输入、canUseTool 带上）
   */
  async runTool(toolUseId: string, toolName: string, input: Record<string, unknown>, opts: { agentId?: string; execute?: (input: Record<string, unknown>) => Promise<unknown> } = {}): Promise<FakeToolRun> {
    const signal = this.aborter.signal;
    const base = { session_id: this.sessionId, transcript_path: "", cwd: this.options.cwd ?? "", ...(opts.agentId ? { agent_id: opts.agentId, agent_type: "general-purpose" } : {}) };
    let current = input;
    let decision: string | undefined;
    let reason: string | undefined;
    for (const matcher of this.options.hooks?.PreToolUse ?? []) {
      if (matcher.matcher && !new RegExp(matcher.matcher).test(toolName)) continue;
      for (const hook of matcher.hooks) {
        const output = await hook({ ...base, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: current, tool_use_id: toolUseId } as HookInput, toolUseId, { signal });
        const specific = preToolUseOutput(output);
        if (specific?.updatedInput) current = specific.updatedInput;
        if (specific?.permissionDecision) {
          decision = specific.permissionDecision;
          reason = specific.permissionDecisionReason;
        }
      }
    }
    if (decision === "deny") return { allowed: false, input: current, denial: reason ?? "denied by hook", decision, asked: false };
    let asked = false;
    if (decision === "ask" || (decision === undefined && (ALWAYS_ASK.has(toolName) || this.permissionAsks.has(toolName)))) {
      const canUseTool = this.options.canUseTool;
      if (!canUseTool || this.options.permissionPrompts === "none") return { allowed: false, input: current, denial: "This session has no approval surface", ...(decision ? { decision } : {}), asked };
      asked = true;
      const result: PermissionResult | null = await canUseTool(toolName, current, { signal, toolUseID: toolUseId, requestId: `req-${toolUseId}`, ...(opts.agentId ? { agentID: opts.agentId } : {}) });
      if (!result || result.behavior === "deny") return { allowed: false, input: current, denial: result?.message ?? "denied", ...(decision ? { decision } : {}), asked };
      if (result.updatedInput) current = result.updatedInput;
    }
    // 执行（291 号票：进程内 MCP 服务的调用）在 PostToolUse 之前，和真的一样
    const executed = opts.execute ? await opts.execute(current) : undefined;
    const contexts: string[] = [];
    for (const matcher of this.options.hooks?.PostToolUse ?? []) {
      if (matcher.matcher && !new RegExp(matcher.matcher).test(toolName)) continue;
      for (const hook of matcher.hooks) {
        const output = await hook({ ...base, hook_event_name: "PostToolUse", tool_name: toolName, tool_input: current, tool_response: {}, tool_use_id: toolUseId } as HookInput, toolUseId, { signal });
        const context = (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
        if (context) contexts.push(context);
      }
    }
    return { allowed: true, input: current, ...(decision ? { decision } : {}), asked, ...(contexts.length > 0 ? { context: contexts.join("\n") } : {}), ...(executed === undefined ? {} : { output: executed }) };
  }

  close(): void {
    this.closed = true;
    this.push({ end: true });
  }

  /** 这条会话的 id：恢复的是 resume，新开的是 sessionId */
  get sessionId(): string {
    return this.options.resume ?? this.options.sessionId ?? "fake-session";
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        for (;;) {
          const item = this.out.shift();
          if (item) {
            if ("message" in item) return { value: item.message, done: false };
            if ("error" in item) throw item.error;
            this.out.unshift(item);
            return { value: undefined, done: true };
          }
          await new Promise<void>((resolve) => {
            this.outWaiter = resolve;
          });
        }
      },
    };
  }

  private push(item: Out): void {
    this.out.push(item);
    const wake = this.outWaiter;
    this.outWaiter = undefined;
    wake?.();
  }
}

/** 钩子交回的 PreToolUse 决定（不是 PreToolUse 的、没给的是 undefined） */
function preToolUseOutput(output: HookJSONOutput): { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } | undefined {
  const specific = (output as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput;
  return specific?.hookEventName === "PreToolUse" ? specific : undefined;
}

/** 手动挡的假 SDK：每次 query() 建一个 FakeClaudeQuery，测试按先后取 */
export interface FakeClaudeSdk {
  query: ClaudeQueryFunction;
  readonly queries: FakeClaudeQuery[];
  /** 293 号票：会话记录（在内存里），和交给适配子进程的会话函数 */
  readonly store: FakeClaudeStore;
  readonly sessions: ClaudeSessionOps;
  /** 等第 n 个（从 1 数）query 建出来 */
  nth(n: number, timeoutMs?: number): Promise<FakeClaudeQuery>;
}

export function createFakeClaudeSdk(): FakeClaudeSdk {
  const queries: FakeClaudeQuery[] = [];
  const store = new FakeClaudeStore();
  return {
    query: (params) => {
      const query = new FakeClaudeQuery(params, store);
      queries.push(query);
      return query;
    },
    queries,
    store,
    sessions: store.ops(),
    async nth(n, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (queries.length < n) {
        if (Date.now() > deadline) throw new Error(`等第 ${n} 个 query 超时（现在 ${queries.length} 个）`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return queries[n - 1]!;
    },
  };
}

// ───────────────────────── SDK 的消息（只填适配子进程看的字段） ─────────────────────────

const as = (value: unknown) => value as SDKMessage;
const uuid = () => randomUUID();

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const sdk = {
  /** extraCommands：另外报的斜杠命令（291 号票：插件里的 skill，ergo:<目录名>） */
  init: (sessionId: string, model = "claude-test-model", extraCommands: readonly string[] = []) =>
    as({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model,
      cwd: "",
      tools: [],
      mcp_servers: [],
      permissionMode: "default",
      slash_commands: [...FAKE_COMMANDS.map((c) => c.name), ...extraCommands],
      output_style: "default",
      skills: [],
      plugins: [],
      apiKeySource: "none",
      claude_code_version: "2.1.296",
      uuid: uuid(),
    }),
  messageStart: (id: string, usage: ApiUsage = {}, model = "claude-test-model") =>
    as({ type: "stream_event", event: { type: "message_start", message: { id, model, usage } }, parent_tool_use_id: null, uuid: uuid(), session_id: "" }),
  textDelta: (text: string) => as({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, uuid: uuid(), session_id: "" }),
  thinkingDelta: (thinking: string) =>
    as({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }, parent_tool_use_id: null, uuid: uuid(), session_id: "" }),
  messageDelta: (stopReason: string, usage: ApiUsage = {}) =>
    as({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason }, usage }, parent_tool_use_id: null, uuid: uuid(), session_id: "" }),
  messageStop: () => as({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, uuid: uuid(), session_id: "" }),
  text: (text: string) => ({ type: "text", text }),
  thinking: (thinking: string) => ({ type: "thinking", thinking, signature: "sig" }),
  toolUse: (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }),
  /** 一条 assistant：一个内容块（SDK 每完成一块发一条，同一次模型调用的 id 相同） */
  assistant: (id: string, block: unknown, opts: { parent?: string; model?: string; aborted?: boolean; error?: string; usage?: ApiUsage; userMessageUuids?: string[] } = {}) =>
    as({
      type: "assistant",
      message: { id, model: opts.model ?? "claude-test-model", role: "assistant", content: [block], stop_reason: null, ...(opts.usage ? { usage: opts.usage } : {}) },
      parent_tool_use_id: opts.parent ?? null,
      uuid: uuid(),
      session_id: "",
      ...(opts.aborted ? { aborted: true } : {}),
      ...(opts.error ? { error: opts.error } : {}),
      ...(opts.userMessageUuids ? { user_message_uuids: opts.userMessageUuids } : {}),
    }),
  toolResult: (toolUseId: string, content: unknown, opts: { isError?: boolean; parent?: string } = {}) =>
    as({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(opts.isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: opts.parent ?? null,
      uuid: uuid(),
      session_id: "",
    }),
  result: (
    opts: { subtype?: string; isError?: boolean; result?: string; errors?: string[]; usage?: ApiUsage; userMessageUuids?: string[]; queuedTurnCount?: number; modelUsage?: Record<string, unknown> } = {},
  ) =>
    as({
      type: "result",
      subtype: opts.subtype ?? "success",
      is_error: opts.isError ?? false,
      duration_ms: 10,
      duration_api_ms: 5,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...opts.usage },
      modelUsage: opts.modelUsage ?? {},
      permission_denials: [],
      ...(opts.subtype && opts.subtype !== "success" ? { errors: opts.errors ?? [] } : { result: opts.result ?? "" }),
      ...(opts.userMessageUuids ? { user_message_uuids: opts.userMessageUuids } : {}),
      ...(opts.queuedTurnCount === undefined ? {} : { queued_turn_count: opts.queuedTurnCount }),
      uuid: uuid(),
      session_id: "",
    }),
  compactBoundary: (trigger: "manual" | "auto", preTokens: number) =>
    as({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: preTokens }, uuid: uuid(), session_id: "" }),
  compactFailed: (error: string) => as({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: error, uuid: uuid(), session_id: "" }),
  localOutput: (content: string) => as({ type: "system", subtype: "local_command_output", content, uuid: uuid(), session_id: "" }),
  sessionState: (state: "idle" | "running" | "requires_action") => as({ type: "system", subtype: "session_state_changed", state, uuid: uuid(), session_id: "" }),
  rateLimit: (status: string, utilization: number) =>
    as({ type: "rate_limit_event", rate_limit_info: { status, rateLimitType: "five_hour", utilization, resetsAt: 1_800_000_000 }, uuid: uuid(), session_id: "" }),
  /** 不认得的消息（SDK 以后加的种类） */
  unknown: (type: string, subtype?: string) => as({ type, ...(subtype ? { subtype } : {}), uuid: uuid(), session_id: "", payload: { anything: true } }),
};

/** 一次模型调用的回复：逐字输出、每块一条 assistant、message_delta（stop_reason、输出用量）、message_stop */
export function sdkReply(id: string, opts: { thinking?: string; text?: string; toolCalls?: Array<{ id: string; name: string; input: unknown }>; usage?: { input: number; cacheRead?: number; output: number }; model?: string }): SDKMessage[] {
  const usage = opts.usage ?? { input: 100, output: 20 };
  const out: SDKMessage[] = [sdk.messageStart(id, { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: 0, output_tokens: 1 }, opts.model)];
  if (opts.thinking) out.push(sdk.thinkingDelta(opts.thinking), sdk.assistant(id, sdk.thinking(opts.thinking), opts.model ? { model: opts.model } : {}));
  if (opts.text) out.push(sdk.textDelta(opts.text), sdk.assistant(id, sdk.text(opts.text), opts.model ? { model: opts.model } : {}));
  for (const call of opts.toolCalls ?? []) out.push(sdk.assistant(id, sdk.toolUse(call.id, call.name, call.input), opts.model ? { model: opts.model } : {}));
  out.push(sdk.messageDelta((opts.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn", { output_tokens: usage.output }), sdk.messageStop());
  return out;
}

/** 用户消息里的文字（content 是字符串或块） */
export function inputText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

/** 用户消息里的图片块 */
export function inputImages(message: SDKUserMessage): Array<{ media_type: string; data: string }> {
  const content = message.message.content;
  if (typeof content === "string") return [];
  return (content as Array<{ type: string; source?: { media_type: string; data: string } }>).flatMap((b) => (b.type === "image" && b.source ? [b.source] : []));
}

// ───────────────────────── 按 faux 剧本自动回 ─────────────────────────

/** echo_context 回的那段 JSON：适配子进程交给 query 的选项（环境只列名字）和这条输入 */
export interface FakeClaudeEcho {
  input: string;
  images: number;
  priority?: string;
  options: {
    cwd?: string;
    settingSources?: string[];
    systemPrompt?: unknown;
    includePartialMessages?: boolean;
    permissionPrompts?: string;
    resume?: string;
    sessionId?: string;
    envKeys: string[];
    clientApp?: string;
    hasExecutable: boolean;
    /** 289 号票：维护者在 ⚙ 里选的值翻成的选项 */
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** 291 号票：交给 query 的本地插件目录、交给它的钩子种类、进程内 MCP 服务 */
    plugins: string[];
    hooks: string[];
    mcpServers: string[];
  };
  /** 291 号票：这条输入收到的钩子 additionalContext（SessionStart、UserPromptSubmit），模型看得到、界面不显示 */
  hookContext: string;
  /** 291 号票：这一轮工具结果的 PostToolUse 交的话 */
  toolContexts: string[];
  /** 291 号票：插件目录里的 skill（目录名） */
  pluginSkills: string[];
  /** 291 号票：各进程内 MCP 服务现在的工具（Claude 看到的名字） */
  mcpTools: string[];
  /** 293 号票：这个会话的主线（模型看到的对话），一条一行 */
  history: string[];
}

/**
 * 按 faux 剧本自动回的假 SDK（剧本在同一个子进程里的几个 query 之间接着往下走）：每条用户输入是一轮，开头一条 system/init，
 * 剧本一步一次模型调用，工具调用回一条假的结果接着下一步，最后一条 result（user_message_uuids 是这条输入的）
 */
export function scriptedClaudeSdk(script: readonly FauxStep[], store: FakeClaudeStore = new FakeClaudeStore()): ClaudeQueryFunction {
  let next = 0;
  let calls = 0;
  return (params) => {
    const query = new FakeClaudeQuery(params, store);
    let turns: Promise<void> = Promise.resolve();
    query.onInput = (input) => {
      turns = turns.then(() => playTurn(query, input));
    };
    return query;
  };

  async function playTurn(query: FakeClaudeQuery, input: SDKUserMessage): Promise<void> {
    // 309 号票：/compact 扮演 Claude Code 的手动压缩，不取剧本
    if (/^\/compact\b/.test(inputText(input).trim())) return playCompact(query, input);
    // 291 号票：处理这条输入之前叫钩子（SessionStart、UserPromptSubmit），这一轮工具结果的 PostToolUse 交的话从头记
    const hookContext = await query.promptHooks(input);
    query.toolContexts = [];
    query.turnUuid = input.uuid;
    query.emit(sdk.init(query.sessionId, undefined, query.pluginSkills().map((name) => `ergo:${name}`)));
    for (;;) {
      let step = script[next++];
      // 293 号票：按这条输入（连同钩子交的话）选一步
      while (step?.kind === "branch_on_context") {
        const seen = `${inputText(input)}\n${hookContext}`;
        step = step.contains.every((s) => seen.includes(s)) ? step.matched : step.otherwise;
      }
      const id = `msg_fake_${++calls}`;
      if (!step) {
        query.emit(...sdkReply(id, { text: "（假 SDK 的剧本用完了）" }));
        break;
      }
      if (step.kind === "echo_context") {
        query.emit(...sdkReply(id, { text: JSON.stringify(await echoOf(query, input)) }));
        break;
      }
      if (step.kind !== "reply") {
        query.emit(...sdkReply(id, { text: `（假 SDK 不认得这一步：${step.kind}）` }));
        break;
      }
      const toolCalls = (step.toolCalls ?? []).map((call, i) => ({ id: `toolu_fake_${calls}_${i}`, name: call.name, input: call.arguments as Record<string, unknown> }));
      query.emit(...sdkReply(id, { ...(step.thinking ? { thinking: step.thinking } : {}), ...(step.text ? { text: step.text } : {}), toolCalls, usage: usageOf(step.usage) }));
      if (toolCalls.length === 0) break;
      for (const call of toolCalls) {
        // 291 号票：进程内 MCP 服务的工具（mcp__<服务>__<工具>）过完权限流程就经服务调
        const mcp = mcpTarget(query, call.name);
        const run = await query.runTool(call.id, call.name, call.input, mcp ? { execute: (args) => callMcp(mcp.link, mcp.tool, args, call.id) } : {});
        if (run.context) query.toolContexts.push(run.context);
        // 293 号票：Write、Edit 真的写盘，记进文件检查点
        if (run.allowed) applyFileTool(query, call.name, run.input);
        if (run.allowed && call.name === "Agent") await playSubagent(query, call.id, run.input);
        query.emit(toolResultOf(call.id, call.name, run));
      }
    }
    query.emit(sdk.result({ ...(input.uuid ? { userMessageUuids: [input.uuid] } : {}), queuedTurnCount: 0 }));
  }
}

/**
 * 扮演 Claude Code 的手动压缩（309 号票，用户打的 /compact 原样转交过来的）：先叫 PreCompact 钩子（manual，带上 /compact 后面的指令），
 * 再吐 compact_boundary、叫压缩之后的 SessionStart（compact）、本地输出和这一轮的 result
 */
async function playCompact(query: FakeClaudeQuery, input: SDKUserMessage): Promise<void> {
  const instructions = inputText(input).trim().slice("/compact".length).trim();
  query.emit(sdk.init(query.sessionId, undefined, query.pluginSkills().map((name) => `ergo:${name}`)));
  await query.preCompactHooks("manual", instructions || null);
  query.emit(sdk.compactBoundary("manual", 12_345));
  await query.compactedHooks();
  query.emit(sdk.localOutput("Compacted. ctrl+o to see full summary"), sdk.result({ ...(input.uuid ? { userMessageUuids: [input.uuid] } : {}), queuedTurnCount: 0 }));
}

/**
 * 扮演子代理（只在测试里）：Agent 工具的参数里 fake_subagent_calls 列出的调用，一次一条回复（带 parent_tool_use_id），钩子输入带 agent_id，
 * 结果也带 parent_tool_use_id
 */
async function playSubagent(query: FakeClaudeQuery, agentCallId: string, input: Record<string, unknown>): Promise<void> {
  const subCalls = Array.isArray(input.fake_subagent_calls) ? (input.fake_subagent_calls as Array<{ name: string; arguments: Record<string, unknown> }>) : [];
  const agentId = `agent-${agentCallId}`;
  for (const [i, call] of subCalls.entries()) {
    const id = `${agentCallId}_sub_${i}`;
    query.emit(sdk.assistant(`msg_${id}`, sdk.toolUse(id, call.name, call.arguments), { parent: agentCallId }));
    const run = await query.runTool(id, call.name, call.arguments, { agentId });
    query.emit(toolResultOf(id, call.name, run, agentCallId));
  }
}

/** 扮演 Claude Code 的 Write、Edit（293 号票）：写盘，这一轮第一次改的文件记下原来的内容（文件检查点） */
function applyFileTool(query: FakeClaudeQuery, toolName: string, input: Record<string, unknown>): void {
  const file = typeof input.file_path === "string" ? input.file_path : undefined;
  if (!file || !query.turnUuid) return;
  if (toolName === "Write" && typeof input.content === "string") query.store.writeFile(query.sessionId, query.turnUuid, file, input.content);
  if (toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    query.store.writeFile(query.sessionId, query.turnUuid, file, before.replace(input.old_string, input.new_string));
  }
}

/** 一次工具调用的假结果：拦下的是说明（出错）；AskUserQuestion 照 Claude Code 的写法列出回答；别的写明执行时用的参数 */
/** 剧本里这个工具是不是接上的进程内 MCP 服务的（mcp__<服务>__<工具>，291 号票）：是的话交回连接和工具名 */
function mcpTarget(query: FakeClaudeQuery, toolName: string): { link: FakeMcpLink; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const link = match ? query.mcpLink(match[1]!) : undefined;
  return link && match ? { link, tool: match[2]! } : undefined;
}

/** 经进程内 MCP 服务调一次（291 号票）：工具不在服务现在的清单里（工具包里没有、刚去掉的）照 Claude Code 回出错，不调 */
async function callMcp(link: FakeMcpLink, tool: string, args: Record<string, unknown>, toolUseId: string): Promise<FakeMcpResult> {
  const tools = await link.listTools();
  if (!tools.some((t) => t.name === tool)) return { content: [{ type: "text", text: `No such tool available: mcp__${link.name}__${tool}` }], isError: true };
  return link.callTool(tool, args, toolUseId);
}

function toolResultOf(toolUseId: string, toolName: string, run: FakeToolRun, parent?: string): SDKMessage {
  const opts = parent ? { parent } : {};
  if (!run.allowed) return sdk.toolResult(toolUseId, run.denial ?? "denied", { ...opts, isError: true });
  if (run.output !== undefined) {
    // 进程内 MCP 服务交回的（291 号票）：MCP 的内容块照样放进工具结果
    const mcp = run.output as FakeMcpResult;
    return sdk.toolResult(
      toolUseId,
      mcp.content.map((c) => (c.type === "image" ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } } : { type: "text", text: c.text ?? "" })),
      { ...opts, ...(mcp.isError ? { isError: true } : {}) },
    );
  }
  if (toolName === "AskUserQuestion") {
    const answers = (run.input.answers ?? {}) as Record<string, string>;
    return sdk.toolResult(toolUseId, `User has answered your questions: ${Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(", ")}`, opts);
  }
  return sdk.toolResult(toolUseId, `（假 SDK 执行了 ${toolName}：${JSON.stringify(run.input)}）`, opts);
}

function usageOf(usage: FauxUsage | undefined): { input: number; cacheRead: number; output: number } {
  return usage ? { input: usage.cacheMiss, cacheRead: usage.cacheHit, output: usage.output } : { input: 100, cacheRead: 0, output: 20 };
}

async function echoOf(query: FakeClaudeQuery, input: SDKUserMessage): Promise<FakeClaudeEcho> {
  const { options } = query;
  const mcpTools = (await Promise.all([...query.mcp.values()].map(async (link) => (await link.listTools()).map((t) => `mcp__${link.name}__${t.name}`)))).flat();
  return {
    input: inputText(input),
    images: inputImages(input).length,
    ...(input.priority ? { priority: input.priority } : {}),
    options: {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.settingSources ? { settingSources: [...options.settingSources] } : {}),
      systemPrompt: options.systemPrompt,
      ...(options.includePartialMessages === undefined ? {} : { includePartialMessages: options.includePartialMessages }),
      ...(options.permissionPrompts ? { permissionPrompts: options.permissionPrompts } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      envKeys: Object.keys(options.env ?? {}).toSorted(),
      ...(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP ? { clientApp: options.env.CLAUDE_AGENT_SDK_CLIENT_APP } : {}),
      hasExecutable: options.pathToClaudeCodeExecutable !== undefined,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: String(options.effort) }),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      plugins: (options.plugins ?? []).map((plugin) => plugin.path),
      hooks: Object.keys(options.hooks ?? {}).toSorted(),
      mcpServers: Object.keys(options.mcpServers ?? {}),
    },
    hookContext: query.contextFor(input.uuid) ?? "",
    toolContexts: [...query.toolContexts],
    pluginSkills: query.pluginSkills(),
    mcpTools,
    history: query.history(),
  };
}
