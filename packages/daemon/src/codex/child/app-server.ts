// 和 codex app-server 说话的那一层（stdio 上每行一个 JSON，JSON-RPC 的形状但没有 "jsonrpc" 字段；协议的权威来源是 0.166 生成的
// schema，test/fixtures/codex-app-server.schema.json）。适配子进程、一次性子进程都用它。这里只管收发和配对，不懂任何一个方法的意思。
// 拉起 app-server 的办法可注入（CodexServerSpawn）：真的是起用户本机的 codex，测试给假的（test/helpers/fake-codex-app-server.ts）。
// @i18n-ignore-file log：日志、编程错误
import { spawn } from "node:child_process";
import { encodeLine, readJsonLines } from "../../runtime/line-channel.ts";
import type { CodexEntry } from "../install.ts";

/** 一个跑着的 app-server：stdin / stdout 和它什么时候退出 */
export interface CodexServerProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  /** 退出时兑现（不拒绝）；起不来的 error 写原因 */
  exited: Promise<{ code: number | null; error?: string }>;
  kill(): void;
}

export interface CodexSpawnOptions {
  env: Record<string, string>;
  cwd: string;
  log(line: string): void;
}

/** 拉起 app-server：args 是 codex 后面的参数（app-server、-c ……） */
export type CodexServerSpawn = (args: readonly string[], options: CodexSpawnOptions) => CodexServerProcess;

/** 起用户本机的 codex */
export function spawnCodexServer(entry: CodexEntry): CodexServerSpawn {
  return (args, options) => {
    const child = spawn(entry.command, [...entry.args, ...args], { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      tail += chunk.toString("utf8");
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.log(`[codex] ${line}`);
    });
    // 起不来、写的时候它退了：都由 exited 报，这里不让流的出错变成没人接的异常
    child.stdin.on("error", () => {});
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      exited: new Promise((resolve) => {
        child.once("error", (err) => resolve({ code: null, error: err.message }));
        child.once("exit", (code) => resolve({ code }));
      }),
      kill: () => {
        child.kill();
      },
    };
  };
}

/** app-server 回的出错 */
export class CodexRpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** 客户端的名字：会话的 originator 记的就是它（列本机会话时认出二狗自己开的，不列） */
export const CODEX_CLIENT_NAME = "ergo_codex";

const CLOSE_WAIT_MS = 3_000;

interface RpcHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  /** app-server 发来的请求（审批、问用户……）：交回结果；抛错回 error */
  onRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** app-server 退出了（不是这边关的也算） */
  onExit(reason: string): void;
}

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class CodexRpc {
  private seq = 0;
  private readonly waits = new Map<string | number, { resolve(value: unknown): void; reject(err: Error): void }>();
  private ended = false;
  private readonly proc: CodexServerProcess;
  private readonly handlers: RpcHandlers;

  constructor(proc: CodexServerProcess, handlers: RpcHandlers) {
    this.proc = proc;
    this.handlers = handlers;
    readJsonLines<Message>(proc.stdout, (message) => this.onMessage(message), { onInvalid: () => {} });
    void proc.exited.then((exit) => this.onExited(exit));
  }

  get alive(): boolean {
    return !this.ended;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.ended) return Promise.reject(new CodexRpcError(`app-server 已经退出了，发不了 ${method}`));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waits.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.ended) this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** 握手（app-server 要求第一条就是它）；实验性的方法和字段（dynamicTools 不用；additionalContext、beforeTurnId 要）都要声明 experimentalApi */
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: CODEX_CLIENT_NAME, title: "ergo", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify("initialized");
  }

  /** 关掉：关 stdin 让它自己退（app-server 在 stdin 关了时退出），到点还在就杀 */
  async close(): Promise<void> {
    if (this.ended) return;
    try {
      this.proc.stdin.end();
    } catch {
      // 已经关了
    }
    const timer = setTimeout(() => this.proc.kill(), CLOSE_WAIT_MS);
    timer.unref();
    await this.proc.exited;
    clearTimeout(timer);
  }

  kill(): void {
    this.proc.kill();
  }

  private write(message: object): void {
    try {
      this.proc.stdin.write(encodeLine(message));
    } catch {
      // 退出了：exited 会报
    }
  }

  private onMessage(message: Message): void {
    if (message.method !== undefined) {
      if (message.id === undefined) return this.handlers.onNotification(message.method, message.params ?? {});
      const { id, method } = message;
      this.handlers.onRequest(method, message.params ?? {}).then(
        (result) => this.write({ id, result: result ?? {} }),
        (err: unknown) => this.write({ id, error: { code: err instanceof CodexRpcError && err.code !== undefined ? err.code : -32000, message: err instanceof Error ? err.message : String(err) } }),
      );
      return;
    }
    if (message.id === undefined) return;
    const wait = this.waits.get(message.id);
    if (!wait) return;
    this.waits.delete(message.id);
    if (message.error) wait.reject(new CodexRpcError(message.error.message ?? "app-server 回了出错", message.error.code));
    else wait.resolve(message.result);
  }

  private onExited(exit: { code: number | null; error?: string }): void {
    this.ended = true;
    const reason = exit.error ?? `退出码 ${exit.code ?? "?"}`;
    for (const wait of this.waits.values()) wait.reject(new CodexRpcError(`app-server 退出了（${reason}）`));
    this.waits.clear();
    this.handlers.onExit(reason);
  }
}
