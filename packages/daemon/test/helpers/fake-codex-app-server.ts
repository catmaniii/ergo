// 假的 codex app-server（只在测试里）：不启动真的 codex、不联网、不花额度、不碰 ~/.codex。适配子进程是真的（child/），它经 CodexServerSpawn 拿到这里的流，
// 说的是和真的一样的 JSON-RPC：请求参数、回复、通知、发来的审批请求都按 0.166 生成的 schema 校验（helpers/codex-schema.ts），对不上的记进 violations。
// 照真的（0.166，临时 CODEX_HOME 下实测的）做的几样：
// - 钩子只认 -c 给的 hooks.PreToolUse，默认 untrusted 不跑，hooks.state 写对了 key 和 hash 才跑；--enable hooks 没开也不跑；真的拉起钩子命令（cmd /C ergo-guard-hook，env 里的 PATH），
//   stdin 喂 PreToolUse 的 JSON，读 stdout；钩子不给判定、跑失败时照真的放行（靠审批和事后核对兜着）；"allow" 不带 updatedInput、deny 不写原因当错；
// - MCP 中转真的拉起（-c mcp_servers.ergo.*），说 MCP：initialize、tools/list、tools/call；
// - 第一条用户消息之前 thread 不落盘：resume、fork、turns/list、read 都回 no rollout found；beforeTurnId、additionalContext 要 initialize 声明 experimentalApi；
// - 审批策略看 untrusted：命令、补丁走 item/*/requestApproval（放行才执行），审批在 item/started 之后；只读命令（approval: false）不问；
// - 联网搜索、看图这些 Codex 自己做的不过钩子，开始了才让人知道。
// 剧本：一轮一组步骤（FakeStep）；FauxStep 由 turnsOfFaux 换成它（主切面的负责人剧本）。线程存进 FakeCodexStore（给了文件就落盘，子进程重启后还在，测试也读它）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CodexServerProcess, CodexServerSpawn, CodexSpawnOptions } from "../../src/codex/child/app-server.ts";
import { relayNameOf } from "../../src/codex/child/host-tools.ts";
import type { FauxStep, FauxUsage } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { codexSchema } from "./codex-schema.ts";

/** 会话目录里假 Codex 的线程记录的文件名 */
export const FAKE_CODEX_STORE = "fake-codex-store.json";

type Json = Record<string, unknown>;

/** 一轮里的一步 */
export type FakeStep =
  /** 一次模型回复：思考、文字，带用量 */
  | { kind: "reply"; text?: string; thinking?: string; usage?: FauxUsage }
  /** 一条命令；hook: false 是钩子没拦到（没覆盖到）；approval: false 是 Codex 判成只读、不问；itemAfterDeny：钩子拦下后还报条目（declined）；id 不给自动起 */
  | { kind: "command"; command: string; id?: string; hook?: boolean; approval?: boolean; exitCode?: number; output?: string; itemAfterDeny?: boolean; network?: string }
  /** 一次补丁（apply_patch 的正文） */
  | { kind: "patch"; patch: string; id?: string; hook?: boolean; approval?: boolean }
  /** 按名字调一个工具（二狗的、用户的 MCP、bash……），调的时候看中转的清单决定怎么走 */
  | { kind: "tool"; name: string; args: Json; id?: string }
  /** 用户自己配的 MCP 工具；elicit：Codex 给它要审批（走 mcpServer/elicitation/request） */
  | { kind: "user_mcp"; server: string; tool: string; args: Json; id?: string; hook?: boolean; elicit?: boolean }
  /** Codex 在服务端做的联网搜索：不过钩子 */
  | { kind: "web_search"; query: string; id?: string; holdMs?: number }
  /** Codex 自己看图：不过钩子 */
  | { kind: "image_view"; path: string; id?: string }
  /** 派子代理：steps 在子线程上跑 */
  | { kind: "collab"; steps: FakeStep[]; prompt?: string; id?: string }
  /** Codex 要问用户 */
  | { kind: "ask"; question: string; options: string[]; id?: string }
  /** 要更多权限 */
  | { kind: "permissions"; id?: string }
  /** 往终端里送输入（要审批） */
  | { kind: "write_stdin"; id?: string; input: string }
  /** 自动压缩 */
  | { kind: "compaction" }
  /** 这一轮出错 */
  | { kind: "fail"; message: string; codexErrorInfo?: string }
  /** 等被打断或者插话 */
  | { kind: "hang" }
  /** 把这一轮看到的回成一段 JSON（FakeCodexEcho） */
  | { kind: "echo" };

/** echo 回的 */
export interface FakeCodexEcho {
  thread: string;
  cwd: string;
  model: string;
  input: string;
  additionalContext: string[];
  developerInstructions: string | null;
  sandbox: string | null;
  effort: string | null;
  mcpTools: string[];
  skillRoots: string[];
  env: Record<string, string | undefined>;
}

export interface FakeThread {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  originator: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  ephemeral: boolean;
  forkedFromId: string | null;
  materialized: boolean;
  branch?: string;
  /** 编的状态（默认 notLoaded） */
  status?: Json;
  developerInstructions: string | null;
  usage: { input: number; cached: number; output: number; total: number };
  turns: Array<{ id: string; status: string; items: Json[]; error?: Json | null }>;
}

/** 假 Codex 的存档：线程，真的"执行"了的调用，协议对不上的 */
export class FakeCodexStore {
  threads: Record<string, FakeThread> = {};
  executed: Array<{ tool: string; input: unknown }> = [];
  violations: string[] = [];
  seq = 0;
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file && fs.existsSync(file)) Object.assign(this, JSON.parse(fs.readFileSync(file, "utf8")) as object);
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ threads: this.threads, executed: this.executed, violations: this.violations, seq: this.seq }));
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** 编一个本机已有的会话（接管用） */
  addThread(partial: Partial<FakeThread> & { id: string; cwd: string }): FakeThread {
    const thread: FakeThread = {
      name: null,
      preview: "",
      originator: "codex_cli_rs",
      model: "gpt-fake",
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      ephemeral: false,
      forkedFromId: null,
      materialized: true,
      developerInstructions: null,
      usage: { input: 0, cached: 0, output: 0, total: 0 },
      turns: [],
      ...partial,
    };
    this.threads[thread.id] = thread;
    this.save();
    return thread;
  }
}

export interface FakeCodexOptions {
  store?: FakeCodexStore;
  /** 剧本：一轮一组步骤；用完了回"（剧本用完了）" */
  turns?: FakeStep[][];
  /** 登录：chatgpt、apiKey，null 是没登录 */
  account?: "chatgpt" | "apiKey" | null;
  /** 用户在 config.toml 写的 developer_instructions */
  userInstructions?: string;
  /** hooks/list 不报钩子（hooks 特性被关了） */
  hooksOff?: boolean;
  /** 钩子永远不算信任 */
  neverTrust?: boolean;
  /** 不认得的 thread 当成本机已有的（主切面：接管列表是编的） */
  lenientThreads?: boolean;
  /** 上下文窗口 */
  contextWindow?: number;
  /** 默认模型 */
  model?: string;
  /** 写交接摘要的那一轮怎么回（默认回一段摘要） */
  ephemeralSteps?: FakeStep[];
}

const DEFAULT_MODEL = "gpt-fake";

/** 把 -c 的值读出来（key=值） */
function configOf(args: readonly string[]): Map<string, string> {
  const config = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const entry = args[i + 1] ?? "";
    const at = entry.indexOf("=");
    config.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return config;
}

function patchChanges(patch: string): Json[] {
  const changes: Json[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(line);
    if (!match) continue;
    const kind = match[1] === "Add File" ? { type: "add" } : match[1] === "Delete File" ? { type: "delete" } : { type: "update", move_path: null };
    changes.push({ path: match[2]!.trim(), kind, diff: "" });
  }
  return changes;
}

/** 假 Codex：一个 FakeCodexServer 可以被拉起好几次（spawn），线程和剧本接着 */
export class FakeCodexServer {
  readonly store: FakeCodexStore;
  /** 收到的每个请求 */
  readonly calls: Array<{ method: string; params: Json }> = [];
  /** 拉起过几次、用的参数和环境 */
  readonly spawns: Array<{ args: readonly string[]; env: Record<string, string>; cwd: string }> = [];
  /** 钩子拉起的结果 */
  readonly hookRuns: Array<{ toolName: string; id: string; output: unknown }> = [];
  /** 模型看到的工具结果（工具 id → 文字） */
  readonly toolResults = new Map<string, string>();
  account: "chatgpt" | "apiKey" | null;
  connections: FakeConnection[] = [];
  private next = 0;
  readonly options: FakeCodexOptions;

  constructor(options: FakeCodexOptions = {}) {
    this.options = options;
    this.store = options.store ?? new FakeCodexStore();
    this.account = options.account === undefined ? "chatgpt" : options.account;
  }

  get violations(): string[] {
    return this.store.violations;
  }

  get executed(): Array<{ tool: string; input: unknown }> {
    return this.store.executed;
  }

  callsOf(method: string): Json[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  /** 现在连着的那一个 */
  get connection(): FakeConnection {
    const last = this.connections.at(-1);
    if (!last) throw new Error("还没拉起假 app-server");
    return last;
  }

  /** 下一轮的剧本 */
  nextTurn(): FakeStep[] {
    const turns = this.options.turns ?? [];
    return turns[this.next++] ?? [{ kind: "reply", text: "（假 Codex 的剧本用完了）" }];
  }

  spawn: CodexServerSpawn = (args, options) => {
    this.spawns.push({ args: [...args], env: options.env, cwd: options.cwd });
    const connection = new FakeConnection(this, args, options);
    this.connections.push(connection);
    return connection.process;
  };

  violation(line: string): void {
    this.store.violations.push(line);
    this.store.save();
    process.stderr.write(`假 Codex 发现协议对不上：${line}\n`);
  }
}

interface ActiveTurn {
  thread: FakeThread;
  id: string;
  items: Json[];
  interrupted: boolean;
  wake: Array<() => void>;
  additionalContext: string[];
  input: string;
  effort: string | null;
}

class RpcFailure extends Error {
  readonly code: number;
  constructor(message: string, code = -32600) {
    super(message);
    this.code = code;
  }
}

/** 一次拉起 */
export class FakeConnection {
  readonly process: CodexServerProcess;
  readonly config: Map<string, string>;
  /** 这次拉起的环境 */
  readonly env: Record<string, string>;
  readonly loaded = new Set<string>();
  readonly skillRoots: string[] = [];
  relayTools: string[] = [];
  active: ActiveTurn | undefined;

  private readonly server: FakeCodexServer;
  private readonly args: readonly string[];
  private readonly cwd: string;
  private readonly stdin = new PassThrough();
  private readonly stdout = new PassThrough();
  private resolveExit!: (exit: { code: number | null; error?: string }) => void;
  private ended = false;
  private experimental = false;
  private seq = 0;
  private readonly waits = new Map<number, { method: string; resolve(value: unknown): void; reject(err: Error): void }>();
  private relay: FakeRelay | undefined;
  private sandbox: string | null = null;

  constructor(server: FakeCodexServer, args: readonly string[], options: CodexSpawnOptions) {
    this.server = server;
    this.args = args;
    this.env = options.env;
    this.cwd = options.cwd;
    this.config = configOf(args);
    const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
      this.resolveExit = resolve;
    });
    this.process = { stdin: this.stdin, stdout: this.stdout, exited, kill: () => this.end(1) };
    readJsonLines<Json & { id?: number; method?: string; params?: Json; result?: unknown; error?: { message?: string } }>(this.stdin, (message) => this.onMessage(message), {
      onInvalid: (line) => server.violation(`看不懂的一行：${line}`),
      onEnd: () => this.end(0),
    });
  }

  /** 假装 app-server 自己死了 */
  crash(): void {
    this.end(1);
  }

  /** 钩子配了、开了、信任了才跑 */
  get hook(): { command: string; key: string; hash: string; trusted: boolean; timeoutSec: number } | undefined {
    const raw = this.config.get("hooks.PreToolUse");
    if (raw === undefined || !this.args.includes("--enable") || this.server.options.hooksOff) return undefined;
    const command = /command="([^"]+)"/.exec(raw)?.[1];
    if (!command) return undefined;
    const key = "C:\\<session-flags>\\config.toml:pre_tool_use:0:0";
    const hash = `sha256:${createHash("sha256").update(command).digest("hex")}`;
    const state = this.config.get("hooks.state") ?? "";
    const trusted = !this.server.options.neverTrust && state.includes(`trusted_hash="${hash}"`) && state.includes(JSON.stringify(key));
    return { command, key, hash, trusted, timeoutSec: Number(/timeout=(\d+)/.exec(raw)?.[1] ?? 600) };
  }

  private end(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.relay?.close();
    for (const wait of this.waits.values()) wait.reject(new Error("app-server 退出了"));
    this.waits.clear();
    if (this.active) {
      this.active.interrupted = true;
      for (const wake of this.active.wake.splice(0)) wake();
    }
    this.server.store.save();
    this.stdout.end();
    this.resolveExit({ code });
  }

  private write(message: object): void {
    if (!this.ended) this.stdout.write(encodeLine(message));
  }

  notify(method: string, params: Json): void {
    for (const line of codexSchema.notification(method, params)) this.server.violation(line);
    this.write({ method, params });
  }

  /** 发一个请求给适配子进程 */
  ask(method: string, params: Json): Promise<unknown> {
    for (const line of codexSchema.serverRequestParams(method, params)) this.server.violation(line);
    const id = 1000 + ++this.seq;
    return new Promise((resolve, reject) => {
      this.waits.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  private onMessage(message: { id?: number; method?: string; params?: Json; result?: unknown; error?: { message?: string } }): void {
    if (message.method === undefined) {
      if (message.id === undefined) return;
      const wait = this.waits.get(message.id);
      if (!wait) return;
      this.waits.delete(message.id);
      if (message.error) wait.reject(new Error(message.error.message ?? "出错"));
      else {
        for (const line of codexSchema.serverRequestResult(wait.method, message.result)) this.server.violation(line);
        wait.resolve(message.result);
      }
      return;
    }
    if (message.id === undefined) return;
    const { id, method } = message;
    const params = message.params ?? {};
    this.server.calls.push({ method, params });
    for (const line of codexSchema.requestParams(method, params)) this.server.violation(line);
    void this.handle(method, params).then(
      (result) => {
        for (const line of codexSchema.requestResult(method, result)) this.server.violation(line);
        this.write({ id, result });
      },
      (err: unknown) => this.write({ id, error: { code: err instanceof RpcFailure ? err.code : -32000, message: err instanceof Error ? err.message : String(err) } }),
    );
  }

  private threadOf(id: unknown): FakeThread {
    const store = this.server.store;
    const known = store.threads[String(id)];
    if (known) return known;
    if (this.server.options.lenientThreads) return store.addThread({ id: String(id), cwd: this.cwd });
    throw new RpcFailure(`no rollout found for thread id ${String(id)}`);
  }

  private materialized(id: unknown): FakeThread {
    const thread = this.threadOf(id);
    if (!thread.materialized) throw new RpcFailure(`no rollout found for thread id ${thread.id}`);
    return thread;
  }

  private view(thread: FakeThread, withTurns = false): Json {
    return {
      id: thread.id,
      sessionId: thread.id,
      cliVersion: "0.166.0",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      cwd: thread.cwd,
      ephemeral: thread.ephemeral,
      forkedFromId: thread.forkedFromId,
      gitInfo: thread.branch ? { branch: thread.branch } : null,
      historyMode: "paginated",
      model: thread.model,
      modelProvider: "openai",
      name: thread.name,
      originator: thread.originator,
      preview: thread.preview,
      projectId: null,
      source: "vscode",
      status: thread.status ?? (this.loaded.has(thread.id) ? { type: "idle" } : { type: "notLoaded" }),
      turns: withTurns ? thread.turns : [],
    };
  }

  private threadResponse(thread: FakeThread, params: Json): Json {
    return {
      approvalPolicy: (params.approvalPolicy as string | undefined) ?? "on-request",
      approvalsReviewer: (params.approvalsReviewer as string | undefined) ?? "user",
      cwd: thread.cwd,
      model: thread.model,
      modelProvider: "openai",
      sandbox: { type: "readOnly" },
      thread: this.view(thread),
    };
  }

  private async attach(thread: FakeThread, params: Json): Promise<void> {
    this.loaded.add(thread.id);
    thread.developerInstructions = (params.developerInstructions as string | null | undefined) ?? thread.developerInstructions;
    this.sandbox = (params.sandbox as string | null | undefined) ?? this.sandbox;
    await this.ensureRelay();
    this.notify("thread/started", { thread: this.view(thread) });
  }

  private async ensureRelay(): Promise<FakeRelay | undefined> {
    if (this.relay) return this.relay;
    const command = this.config.get("mcp_servers.ergo.command");
    const args = this.config.get("mcp_servers.ergo.args");
    if (!command || !args) return undefined;
    this.relay = new FakeRelay(JSON.parse(command) as string, JSON.parse(args) as string[], this.env, this.cwd);
    await this.relay.initialize();
    this.relayTools = await this.relay.listTools();
    return this.relay;
  }

  private async handle(method: string, params: Json): Promise<unknown> {
    const { store, options } = this.server;
    switch (method) {
      case "initialize":
        this.experimental = (params.capabilities as { experimentalApi?: boolean } | undefined)?.experimentalApi === true;
        return { codexHome: "C:\\fake-codex-home", platformFamily: "windows", platformOs: "windows", userAgent: `${String((params.clientInfo as { name?: string }).name)}/0.166.0` };
      case "hooks/list": {
        const hook = this.hook;
        return {
          data: [
            {
              cwd: String((params.cwds as string[] | undefined)?.[0] ?? this.cwd),
              errors: [],
              warnings: [],
              hooks: hook
                ? [
                    {
                      key: hook.key,
                      eventName: "preToolUse",
                      handlerType: "command",
                      command: hook.command,
                      matcher: ".*",
                      source: "sessionFlags",
                      sourcePath: "C:\\<session-flags>\\config.toml",
                      displayOrder: 0,
                      enabled: true,
                      isManaged: false,
                      timeoutSec: hook.timeoutSec,
                      currentHash: hook.hash,
                      trustStatus: hook.trusted ? "trusted" : "untrusted",
                    },
                  ]
                : [],
            },
          ],
        };
      }
      case "skills/extraRoots/set":
        this.skillRoots.splice(0, this.skillRoots.length, ...((params.extraRoots as string[]) ?? []));
        return {};
      case "config/read":
        return { config: { developer_instructions: options.userInstructions ?? null }, origins: {} };
      case "account/read": {
        const account = this.server.account;
        return { account: account === null ? null : account === "apiKey" ? { type: "apiKey" } : { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true };
      }
      case "model/list":
        return {
          data: [
            { id: "gpt-fake", model: "gpt-fake", displayName: "GPT Fake", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }] },
            { id: "gpt-other", model: "gpt-other", displayName: "GPT Other", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
            { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", description: "", hidden: true, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
          ],
        };
      case "thread/start": {
        const clientName = "ergo_codex";
        const thread = store.addThread({
          id: store.nextId("th"),
          cwd: String(params.cwd ?? this.cwd),
          originator: clientName,
          model: (params.model as string | undefined) ?? options.model ?? DEFAULT_MODEL,
          materialized: false,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        });
        await this.attach(thread, params);
        return this.threadResponse(thread, params);
      }
      case "thread/resume": {
        const thread = this.materialized(params.threadId);
        if (params.model) thread.model = params.model as string;
        await this.attach(thread, params);
        return this.threadResponse(thread, params);
      }
      case "thread/fork": {
        const source = this.materialized(params.threadId);
        let turns = source.turns;
        if (params.beforeTurnId !== undefined) {
          if (!this.experimental) throw new RpcFailure("thread/fork.beforeTurnId requires experimentalApi capability");
          const at = source.turns.findIndex((turn) => turn.id === params.beforeTurnId);
          if (at < 0) throw new RpcFailure(`turn ${String(params.beforeTurnId)} not found`);
          turns = source.turns.slice(0, at);
        }
        const thread = store.addThread({
          ...source,
          id: store.nextId("th"),
          cwd: String(params.cwd ?? source.cwd),
          forkedFromId: source.id,
          ephemeral: params.ephemeral === true,
          status: undefined as unknown as Json,
          turns: structuredClone(turns),
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
          originator: "ergo_codex",
        } as FakeThread);
        delete thread.status;
        await this.attach(thread, params);
        return this.threadResponse(thread, params);
      }
      case "thread/list": {
        const limit = Number(params.limit ?? 50);
        const start = params.cursor === undefined ? 0 : Number(params.cursor);
        const all = Object.values(store.threads)
          .filter((t) => t.materialized && !t.ephemeral)
          .toSorted((a, b) => b.updatedAt - a.updatedAt);
        const page = all.slice(start, start + limit);
        return { data: page.map((t) => this.view(t)), nextCursor: start + limit < all.length ? String(start + limit) : null };
      }
      case "thread/read":
        return { thread: this.view(this.materialized(params.threadId), params.includeTurns === true) };
      case "thread/turns/list": {
        const thread = this.materialized(params.threadId);
        const limit = Number(params.limit ?? 25);
        const newestFirst = thread.turns.toReversed();
        return { data: newestFirst.slice(0, limit), nextCursor: newestFirst.length > limit ? "more" : null };
      }
      case "thread/unsubscribe":
        this.loaded.delete(String(params.threadId));
        return { status: "unsubscribed" };
      case "thread/compact/start":
        void this.playCompact(this.materialized(params.threadId));
        return {};
      case "turn/start":
        return this.startTurn(params);
      case "turn/steer": {
        const active = this.active;
        if (!active || active.id !== params.expectedTurnId) throw new RpcFailure("expected turn is not active");
        const text = textOfInput(params.input);
        const item = { type: "userMessage", id: store.nextId("item"), content: params.input, clientId: params.clientUserMessageId ?? null };
        active.items.push(item);
        active.input += `\n${text}`;
        this.itemStarted(active, item);
        this.itemCompleted(active, item);
        for (const wake of active.wake.splice(0)) wake();
        return { turnId: active.id };
      }
      case "turn/interrupt": {
        const active = this.active;
        if (active && active.id === params.turnId) {
          active.interrupted = true;
          for (const wake of active.wake.splice(0)) wake();
        }
        return {};
      }
      default:
        throw new RpcFailure(`假 app-server 没做 ${method}`, -32601);
    }
  }

  private startTurn(params: Json): Json {
    const { store } = this.server;
    const thread = store.threads[String(params.threadId)];
    if (!thread || !this.loaded.has(thread.id)) throw new RpcFailure(`thread ${String(params.threadId)} is not loaded`);
    if (this.active) throw new RpcFailure("a turn is already running");
    if (params.additionalContext !== undefined && !this.experimental) throw new RpcFailure("turn/start.additionalContext requires experimentalApi capability");
    const context = Object.values((params.additionalContext as Record<string, { value: string; kind: string }> | undefined) ?? {});
    for (const entry of context) if (entry.kind !== "application") this.server.violation(`additionalContext 的 kind 是 ${entry.kind}`);
    const turn: ActiveTurn = {
      thread,
      id: store.nextId("turn"),
      items: [],
      interrupted: false,
      wake: [],
      additionalContext: context.map((entry) => entry.value),
      input: textOfInput(params.input),
      effort: (params.effort as string | undefined) ?? null,
    };
    if (params.approvalPolicy !== "untrusted" || params.approvalsReviewer !== "user") this.server.violation(`turn/start 的审批策略不是最严的：${String(params.approvalPolicy)}、${String(params.approvalsReviewer)}`);
    this.active = turn;
    thread.materialized = true;
    thread.preview ||= turn.input.slice(0, 40);
    thread.updatedAt = Math.floor(Date.now() / 1000);
    const steps = thread.ephemeral ? (this.server.options.ephemeralSteps ?? [{ kind: "reply" as const, text: "（假 Codex 写的交接摘要）", usage: { cacheHit: 0, cacheMiss: 50, output: 10 } }]) : this.server.nextTurn();
    setImmediate(() => void this.playTurn(turn, params, steps));
    return { turn: { id: turn.id, items: [], status: "inProgress" } };
  }

  private itemStarted(turn: Pick<ActiveTurn, "id" | "thread">, item: Json): void {
    this.notify("item/started", { threadId: turn.thread.id, turnId: turn.id, item, startedAtMs: Date.now() });
  }

  private itemCompleted(turn: Pick<ActiveTurn, "id" | "thread">, item: Json): void {
    this.notify("item/completed", { threadId: turn.thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
  }

  private async playTurn(turn: ActiveTurn, params: Json, steps: readonly FakeStep[]): Promise<void> {
    const { store } = this.server;
    const threadId = turn.thread.id;
    this.notify("turn/started", { threadId, turn: { id: turn.id, items: [], status: "inProgress" } });
    const user = { type: "userMessage", id: store.nextId("item"), content: params.input, clientId: params.clientUserMessageId ?? null };
    turn.items.push(user);
    this.itemStarted(turn, user);
    this.itemCompleted(turn, user);
    let error: Json | undefined;
    try {
      error = await this.playSteps(turn, steps);
    } catch (err) {
      if (!this.ended) error = { message: err instanceof Error ? err.message : String(err) };
    }
    const status = turn.interrupted ? "interrupted" : error ? "failed" : "completed";
    turn.thread.turns.push({ id: turn.id, status, items: turn.items, ...(error ? { error } : {}) });
    this.active = undefined;
    store.save();
    this.notify("turn/completed", { threadId, turn: { id: turn.id, items: [], status, ...(error ? { error } : {}) } });
  }

  /** 跑一串步骤；出错的回那个 error */
  private async playSteps(turn: ActiveTurn, steps: readonly FakeStep[], parent?: { id: string; thread: FakeThread }): Promise<Json | undefined> {
    const scope = parent ? { id: turn.id, thread: parent.thread } : turn;
    for (const step of steps) {
      if (turn.interrupted) return undefined;
      switch (step.kind) {
        case "reply":
          this.playReply(turn, scope, step);
          break;
        case "echo":
          this.playReply(turn, scope, { kind: "reply", text: JSON.stringify(this.echoOf(turn)) });
          break;
        case "command":
          await this.playCommand(turn, scope, step);
          break;
        case "patch":
          await this.playPatch(turn, scope, step);
          break;
        case "tool":
          await this.playNamed(turn, scope, step);
          break;
        case "user_mcp":
          await this.playUserMcp(turn, scope, step);
          break;
        case "web_search": {
          const id = step.id ?? this.server.store.nextId("ws");
          this.itemStarted(scope, { type: "webSearch", id, query: "", action: null });
          if (step.holdMs) await new Promise((resolve) => setTimeout(resolve, step.holdMs));
          this.itemCompleted(scope, { type: "webSearch", id, query: step.query, action: { type: "search", query: step.query, queries: null } });
          break;
        }
        case "image_view": {
          const id = step.id ?? this.server.store.nextId("img");
          const item = { type: "imageView", id, path: step.path };
          this.itemStarted(scope, item);
          this.itemCompleted(scope, item);
          break;
        }
        case "collab": {
          const id = step.id ?? this.server.store.nextId("collab");
          const sub = this.server.store.addThread({ id: this.server.store.nextId("sub"), cwd: turn.thread.cwd, originator: "ergo_codex", ephemeral: true, materialized: true });
          const base = { type: "collabAgentToolCall", id, tool: "spawnAgent", senderThreadId: turn.thread.id, receiverThreadIds: [sub.id], prompt: step.prompt ?? "看看", model: null, reasoningEffort: null, agentsStates: {} };
          this.itemStarted(scope, { ...base, status: "inProgress" });
          await this.playSteps(turn, step.steps, { id, thread: sub });
          this.itemCompleted(scope, { ...base, status: "completed" });
          break;
        }
        case "ask":
          await this.playAsk(turn, scope, step);
          break;
        case "permissions":
          await this.playPermissions(turn, scope, step);
          break;
        case "write_stdin":
          await this.playWriteStdin(turn, scope, step);
          break;
        case "compaction": {
          const item = { type: "contextCompaction", id: this.server.store.nextId("compact") };
          this.itemStarted(scope, item);
          this.itemCompleted(scope, item);
          break;
        }
        case "fail": {
          const error = { message: step.message, codexErrorInfo: step.codexErrorInfo ?? null, additionalDetails: null };
          this.notify("error", { threadId: turn.thread.id, turnId: turn.id, error, willRetry: false });
          return error;
        }
        case "hang":
          await new Promise<void>((resolve) => turn.wake.push(resolve));
          break;
      }
    }
    return undefined;
  }

  private echoOf(turn: ActiveTurn): FakeCodexEcho {
    return {
      thread: turn.thread.id,
      cwd: turn.thread.cwd,
      model: turn.thread.model,
      input: turn.input,
      additionalContext: turn.additionalContext,
      developerInstructions: turn.thread.developerInstructions,
      sandbox: this.sandbox,
      effort: turn.effort,
      mcpTools: this.relayTools.map((name) => `mcp__ergo__${name}`),
      skillRoots: [...this.skillRoots],
      env: Object.fromEntries(["OPENAI_API_KEY", "CODEX_API_KEY", "ERGO_CODEX_PIPE"].map((name) => [name, this.env[name]])),
    };
  }

  private playReply(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "reply" }>): void {
    const { store } = this.server;
    const threadId = scope.thread.id;
    if (step.thinking) {
      const id = store.nextId("think");
      this.itemStarted(scope, { type: "reasoning", id, summary: [], content: [] });
      this.notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: id, delta: step.thinking, summaryIndex: 0 });
      const item = { type: "reasoning", id, summary: [step.thinking], content: [] };
      turn.items.push(item);
      this.itemCompleted(scope, item);
    }
    if (step.text) {
      const id = store.nextId("msg");
      this.itemStarted(scope, { type: "agentMessage", id, text: "" });
      const middle = Math.ceil(step.text.length / 2);
      for (const delta of [step.text.slice(0, middle), step.text.slice(middle)]) if (delta) this.notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: id, delta });
      const item = { type: "agentMessage", id, text: step.text };
      turn.items.push(item);
      this.itemCompleted(scope, item);
    }
    const usage = step.usage ?? { cacheHit: 0, cacheMiss: 100, output: 20 };
    const input = usage.cacheHit + usage.cacheMiss;
    const totals = scope.thread.usage;
    totals.input += input;
    totals.cached += usage.cacheHit;
    totals.output += usage.output;
    totals.total += input + usage.output;
    this.notify("thread/tokenUsage/updated", {
      threadId,
      turnId: turn.id,
      tokenUsage: {
        total: { inputTokens: totals.input, cachedInputTokens: totals.cached, outputTokens: totals.output, reasoningOutputTokens: 0, totalTokens: totals.total },
        last: { inputTokens: input, cachedInputTokens: usage.cacheHit, outputTokens: usage.output, reasoningOutputTokens: 0, totalTokens: input + usage.output },
        modelContextWindow: this.server.options.contextWindow ?? 272_000,
      },
    });
  }

  /** 真的拉起钩子命令：交回它的判定；没配、没信任的不跑（照真的放行） */
  private async runHook(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, toolName: string, toolInput: unknown, id: string): Promise<{ deny?: string; updatedInput?: unknown; context?: string }> {
    const hook = this.hook;
    if (!hook?.trusted) return {};
    const payload = {
      cwd: scope.thread.cwd,
      hook_event_name: "PreToolUse",
      model: scope.thread.model,
      permission_mode: "default",
      session_id: scope.thread.id,
      tool_input: toolInput,
      tool_name: toolName,
      tool_use_id: id,
      transcript_path: null,
      turn_id: turn.id,
    };
    const stdout = await new Promise<string>((resolve) => {
      const child =
        process.platform === "win32"
          ? spawn(this.env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", hook.command], { env: this.env, cwd: this.cwd, windowsHide: true })
          : spawn("sh", ["-c", hook.command], { env: this.env, cwd: this.cwd });
      let out = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (chunk.trim()) process.stderr.write(`[假 Codex 的钩子] ${chunk}`);
      });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    });
    let output: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown; additionalContext?: string } } = {};
    try {
      output = JSON.parse(stdout) as typeof output;
    } catch {
      // 钩子没给判定：照真的接着往下走
    }
    this.server.hookRuns.push({ toolName, id, output });
    const specific = output.hookSpecificOutput;
    if (specific?.permissionDecision === "deny") {
      if (!specific.permissionDecisionReason) this.server.violation(`deny 没写原因：${toolName}`);
      return { deny: specific.permissionDecisionReason ?? "denied" };
    }
    if (specific?.permissionDecision === "allow" && specific.updatedInput === undefined) this.server.violation(`allow 不带 updatedInput：${toolName}（真的 Codex 不认）`);
    if (specific?.permissionDecision === "ask") this.server.violation(`permissionDecision: ask（真的 Codex 不认）：${toolName}`);
    return { ...(specific?.updatedInput === undefined ? {} : { updatedInput: specific.updatedInput }), ...(specific?.additionalContext ? { context: specific.additionalContext } : {}) };
  }

  private async playCommand(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "command" }>): Promise<void> {
    const { store } = this.server;
    const id = step.id ?? store.nextId("call");
    let command = step.command;
    if (step.hook !== false) {
      const verdict = await this.runHook(turn, scope, "Bash", { command }, id);
      if (verdict.deny !== undefined) {
        this.server.toolResults.set(id, verdict.deny);
        if (step.itemAfterDeny) {
          const item = { type: "commandExecution", id, command, commandActions: [], cwd: scope.thread.cwd, status: "declined", source: "agent", exitCode: null, aggregatedOutput: null };
          this.itemStarted(scope, { ...item, status: "inProgress" });
          this.itemCompleted(scope, item);
        }
        return;
      }
      if (verdict.updatedInput !== undefined) command = (verdict.updatedInput as { command: string }).command;
    }
    const base = { type: "commandExecution", id, command, commandActions: [], cwd: scope.thread.cwd, source: "agent", processId: null };
    this.itemStarted(scope, { ...base, status: "inProgress", exitCode: null, aggregatedOutput: null });
    if (step.approval !== false) {
      const reply = (await this.ask("item/commandExecution/requestApproval", {
        threadId: scope.thread.id,
        turnId: turn.id,
        itemId: id,
        startedAtMs: Date.now(),
        command,
        cwd: scope.thread.cwd,
        ...(step.network ? { networkApprovalContext: { host: step.network, protocol: "https" } } : {}),
      })) as { decision?: unknown };
      if (reply.decision !== "accept") {
        this.server.toolResults.set(id, "declined");
        this.itemCompleted(scope, { ...base, status: "declined", exitCode: null, aggregatedOutput: null });
        return;
      }
    }
    store.executed.push({ tool: "Bash", input: { command } });
    store.save();
    const output = step.output ?? `（假 Codex 执行了 ${command}）`;
    this.server.toolResults.set(id, output);
    const exitCode = step.exitCode ?? 0;
    this.itemCompleted(scope, { ...base, status: exitCode === 0 ? "completed" : "failed", exitCode, aggregatedOutput: output });
  }

  private async playPatch(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "patch" }>): Promise<void> {
    const { store } = this.server;
    const id = step.id ?? store.nextId("call");
    let patch = step.patch;
    if (step.hook !== false) {
      const verdict = await this.runHook(turn, scope, "apply_patch", { command: patch }, id);
      if (verdict.deny !== undefined) {
        this.server.toolResults.set(id, verdict.deny);
        return;
      }
      if (verdict.updatedInput !== undefined) patch = (verdict.updatedInput as { command: string }).command;
    }
    const base = { type: "fileChange", id, changes: patchChanges(patch) };
    this.itemStarted(scope, { ...base, status: "inProgress" });
    if (step.approval !== false) {
      const reply = (await this.ask("item/fileChange/requestApproval", { threadId: scope.thread.id, turnId: turn.id, itemId: id, startedAtMs: Date.now(), reason: null, grantRoot: null })) as { decision?: unknown };
      if (reply.decision !== "accept") {
        this.server.toolResults.set(id, "declined");
        this.itemCompleted(scope, { ...base, status: "declined" });
        return;
      }
    }
    store.executed.push({ tool: "apply_patch", input: { command: patch } });
    store.save();
    this.itemCompleted(scope, { ...base, status: "completed" });
  }

  /** 按名字调：bash → 命令；中转清单里有的 → 经中转；mcp__x__y → 用户的 MCP；别的当成用户 MCP 服务 unknown 上的 */
  private async playNamed(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "tool" }>): Promise<void> {
    const { name, args } = step;
    if (name === "bash") return this.playCommand(turn, scope, { kind: "command", command: String(args.command), ...(step.id ? { id: step.id } : {}) });
    if (name === "write" || name === "edit") {
      const verb = name === "write" ? "Add File" : "Update File";
      return this.playPatch(turn, scope, { kind: "patch", patch: `*** Begin Patch\n*** ${verb}: ${String(args.path)}\n+${String(args.content ?? args.new_string ?? "")}\n*** End Patch`, ...(step.id ? { id: step.id } : {}) });
    }
    if (name === "read") return this.playCommand(turn, scope, { kind: "command", command: `type ${String(args.path)}`, approval: false, ...(step.id ? { id: step.id } : {}) });
    const relayName = relayNameOf(name);
    if (this.relayTools.includes(relayName)) return this.playRelay(turn, scope, relayName, args, step.id);
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    return this.playUserMcp(turn, scope, { kind: "user_mcp", server: match?.[1] ?? "unknown", tool: match?.[2] ?? name, args, ...(step.id ? { id: step.id } : {}) });
  }

  /** 二狗的工具：照真的先过钩子（适配子进程放行），报开始，再经中转调 */
  private async playRelay(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, relayName: string, args: Json, givenId?: string): Promise<void> {
    const id = givenId ?? this.server.store.nextId("call");
    const verdict = await this.runHook(turn, scope, `mcp__ergo__${relayName}`, args, id);
    if (verdict.deny !== undefined) {
      this.server.toolResults.set(id, verdict.deny);
      return;
    }
    const base = { type: "mcpToolCall", id, server: "ergo", tool: relayName, arguments: args };
    this.itemStarted(scope, { ...base, status: "inProgress", result: null, error: null });
    const result = (await this.relay!.callTool(relayName, args)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    this.server.toolResults.set(id, result.content.map((c) => c.text ?? "").join("\n"));
    this.itemCompleted(scope, { ...base, status: result.isError ? "failed" : "completed", result: { content: result.content }, error: null });
  }

  private async playUserMcp(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "user_mcp" }>): Promise<void> {
    const { store } = this.server;
    const id = step.id ?? store.nextId("call");
    const nativeName = `mcp__${step.server}__${step.tool}`;
    if (step.hook !== false) {
      const verdict = await this.runHook(turn, scope, nativeName, step.args, id);
      if (verdict.deny !== undefined) {
        this.server.toolResults.set(id, verdict.deny);
        return;
      }
    }
    const base = { type: "mcpToolCall", id, server: step.server, tool: step.tool, arguments: step.args };
    this.itemStarted(scope, { ...base, status: "inProgress", result: null, error: null });
    if (step.elicit) {
      const reply = (await this.ask("mcpServer/elicitation/request", {
        threadId: scope.thread.id,
        turnId: turn.id,
        serverName: step.server,
        mode: "form",
        message: "Allow this tool?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
      })) as { action?: string };
      if (reply.action !== "accept") {
        this.itemCompleted(scope, { ...base, status: "failed", result: null, error: { message: "declined" } });
        return;
      }
    }
    store.executed.push({ tool: nativeName, input: step.args });
    store.save();
    this.itemCompleted(scope, { ...base, status: "completed", result: { content: [{ type: "text", text: `（假 MCP 执行了 ${nativeName}）` }] }, error: null });
  }

  private async playAsk(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "ask" }>): Promise<void> {
    const id = step.id ?? this.server.store.nextId("ask");
    const reply = (await this.ask("item/tool/requestUserInput", {
      threadId: scope.thread.id,
      turnId: turn.id,
      itemId: id,
      isBlocking: true,
      questions: [{ id: "q1", header: "选一个", question: step.question, isOther: false, isSecret: false, options: step.options.map((label) => ({ label, description: "" })) }],
    })) as { answers: Record<string, { answers: string[] }> };
    this.server.toolResults.set(id, JSON.stringify(reply.answers));
  }

  private async playPermissions(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "permissions" }>): Promise<void> {
    const id = step.id ?? this.server.store.nextId("perm");
    const reply = await this.ask("item/permissions/requestApproval", {
      threadId: scope.thread.id,
      turnId: turn.id,
      itemId: id,
      startedAtMs: Date.now(),
      cwd: scope.thread.cwd,
      reason: "要联网",
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    this.server.toolResults.set(id, JSON.stringify(reply));
  }

  private async playWriteStdin(turn: ActiveTurn, scope: Pick<ActiveTurn, "id" | "thread">, step: Extract<FakeStep, { kind: "write_stdin" }>): Promise<void> {
    const id = step.id ?? this.server.store.nextId("stdin");
    const reply = (await this.ask("item/commandExecution/requestApproval", { threadId: scope.thread.id, turnId: turn.id, itemId: id, startedAtMs: Date.now(), kind: "writeStdin", command: step.input, approvalId: "a1" })) as { decision?: unknown };
    this.server.toolResults.set(id, String(reply.decision));
    if (reply.decision === "accept") {
      this.server.store.executed.push({ tool: "write_stdin", input: step.input });
      this.server.store.save();
    }
  }

  private async playCompact(thread: FakeThread): Promise<void> {
    const { store } = this.server;
    await new Promise((resolve) => setImmediate(resolve));
    const turn = { id: store.nextId("turn"), thread };
    this.notify("turn/started", { threadId: thread.id, turn: { id: turn.id, items: [], status: "inProgress" } });
    const item = { type: "contextCompaction", id: store.nextId("compact") };
    this.itemStarted(turn, item);
    this.itemCompleted(turn, item);
    thread.turns.push({ id: turn.id, status: "completed", items: [item] });
    store.save();
    this.notify("turn/completed", { threadId: thread.id, turn: { id: turn.id, items: [], status: "completed" } });
  }
}

function textOfInput(input: unknown): string {
  return (Array.isArray(input) ? (input as Array<{ type?: string; text?: string }>) : [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : "[图片]"))
    .join("\n");
}

/** 真的拉起 MCP 中转，说 MCP（Codex 那一侧） */
class FakeRelay {
  private seq = 0;
  private readonly waits = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  private readonly child;

  constructor(command: string, args: readonly string[], env: Record<string, string>, cwd: string) {
    this.child = spawn(command, [...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (chunk.trim()) process.stderr.write(`[假 Codex 拉起的中转] ${chunk}`);
    });
    this.child.stdin.on("error", () => {});
    readJsonLines<{ id?: number; result?: unknown; error?: { message?: string } }>(
      this.child.stdout,
      (message) => {
        if (message.id === undefined) return;
        const wait = this.waits.get(message.id);
        if (!wait) return;
        this.waits.delete(message.id);
        if (message.error) wait.reject(new Error(message.error.message ?? "出错"));
        else wait.resolve(message.result);
      },
      { onInvalid: () => {} },
    );
    this.child.on("exit", () => {
      for (const wait of this.waits.values()) wait.reject(new Error("中转退出了"));
      this.waits.clear();
    });
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waits.set(id, { resolve, reject });
      this.child.stdin.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } });
    this.child.stdin.write(encodeLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
  }

  async listTools(): Promise<string[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: Array<{ name: string }> };
    return (result.tools ?? []).map((tool) => tool.name);
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args, _meta: { threadId: "fake" } });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** faux 剧本 → 一轮一组步骤（和 scriptedClaudeSdk 一样：回复不带工具调用的那一步是这一轮的最后一步） */
export function turnsOfFaux(script: readonly FauxStep[]): FakeStep[][] {
  const turns: FakeStep[][] = [];
  let turn: FakeStep[] = [];
  const close = () => {
    turns.push(turn);
    turn = [];
  };
  for (const step of script) {
    if (step.kind === "echo_context") {
      turn.push({ kind: "echo" });
      close();
    } else if (step.kind === "reply") {
      turn.push({ kind: "reply", ...(step.text ? { text: step.text } : {}), ...(step.thinking ? { thinking: step.thinking } : {}), ...(step.usage ? { usage: step.usage } : {}) });
      const calls = step.toolCalls ?? [];
      for (const call of calls) turn.push({ kind: "tool", name: call.name, args: call.arguments as Json });
      if (calls.length === 0) close();
    } else if (step.kind === "context_overflow") {
      // 这里没有上下文溢出（Codex 自己压缩），借这一步演额度用完
      turn.push({ kind: "fail", message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" });
      close();
    } else {
      turn.push({ kind: "reply", text: `（假 Codex 不认得这一步：${step.kind}）` });
      close();
    }
  }
  if (turn.length > 0) close();
  return turns;
}
