// 真机核对的装配（只在 ERGO_TEST_REAL_CODEX=1 时用，test/codex/real-codex.test.ts）：真的 codex 程序 + 真的适配子进程 + 本机假模型（fake-responses-model.ts）。
// 绝不连 OpenAI、绝不花钱，都写死在这里，不靠手动：
// - CODEX_HOME 是新建的临时目录（不碰 ~/.codex）；环境去掉 OPENAI_API_KEY、CODEX_API_KEY；代理全指到不通的本机地址，NO_PROXY 只放本机——假模型连得上，外网全不通；
// - 模型服务只有一个 provider，指到假模型；模型目录的元数据用 codex 内置的（工具清单和真账号一样），不问服务端；统计、更新检查、联网全关；
// - 模型让跑的命令只在 lab.work 这个临时目录里动文件。
// 一次性子进程（sessions-main.ts）读不到 -c，所以同一份配置也写进临时 CODEX_HOME 的 config.toml。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { CodexRpc, type CodexServerSpawn, spawnCodexServer } from "../../src/codex/child/app-server.ts";
import { runCodexChild } from "../../src/codex/child/child.ts";
import { findCodexEntry } from "../../src/codex/install.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type GuardVerdict, type HostCommand, type HostToolResult, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { codexAssembly } from "./codex-child.ts";
import { FakeResponsesModel } from "./fake-responses-model.ts";
import { ReportLog, type ReportOf } from "./report-log.ts";
import { removeDir } from "./temp-dir.ts";

/** 不通的本机地址：外网全走它，全连不上 */
const DEAD_PROXY = "http://127.0.0.1:9";
const UNSAFE_ENV = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN"]);

/** 拉起 codex 用的环境：见文件开头 */
export function realCodexEnv(home: string, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !UNSAFE_ENV.has(name.toUpperCase())) env[name] = value;
  return { ...env, CODEX_HOME: home, HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, ALL_PROXY: DEAD_PROXY, NO_PROXY: "127.0.0.1,localhost" };
}

/** app-server 线路上的一条消息 */
export interface WireMessage {
  dir: "in" | "out";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  at: number;
}

/** 一次核对用的一整套：临时 CODEX_HOME、工作目录、假模型 */
export class RealCodexLab {
  readonly root: string;
  readonly home: string;
  /** 模型让跑的命令只动这里 */
  readonly work: string;
  readonly model: FakeResponsesModel;
  /** 所有 app-server 的线路消息（按到达先后，换进程也接着） */
  readonly wire: WireMessage[] = [];
  /** codex 的 stderr */
  readonly logs: string[] = [];
  readonly modelName: string;
  /** 模型服务要 OpenAI 登录（测没登录） */
  providerAuth = false;
  /** 把适配子进程给的 --disable unified_exec_tty 去掉（证明为什么要关） */
  allowTty = false;
  /** 拉起 codex 时盖过去的环境（测钩子跑失败） */
  envOverride: Record<string, string> = {};

  private constructor(root: string, model: FakeResponsesModel, modelName: string) {
    this.root = root;
    this.home = path.join(root, "codex-home");
    this.work = path.join(root, "work");
    this.model = model;
    this.modelName = modelName;
    fs.mkdirSync(this.home, { recursive: true });
    fs.mkdirSync(this.work, { recursive: true });
    fs.writeFileSync(path.join(this.home, "config.toml"), this.configToml());
  }

  /** 建一套；测试结束收掉 */
  static async open(modelName: string): Promise<RealCodexLab> {
    // 用真实路径（短文件名的路径 codex 报回来不一样）
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-real-codex-")));
    const model = await new FakeResponsesModel().start();
    const lab = new RealCodexLab(root, model, modelName);
    onTestFinished(async () => {
      await model.close();
      removeDir(root);
    });
    return lab;
  }

  /** 钉死在假模型上的那几条设置（toml 的 key=值） */
  private settings(): Array<[string, string]> {
    const origin = this.model.baseUrl.replace(/\/v1$/, "");
    return [
      ["model_providers.fake", `{name="fake",base_url="${this.model.baseUrl}",wire_api="responses",requires_openai_auth=${String(this.providerAuth)},stream_max_retries=0,request_max_retries=0}`],
      ["model_provider", '"fake"'],
      ["model", JSON.stringify(this.modelName)],
      // 别的出口也钉在本机（就算代理不生效也到不了外面）
      ["chatgpt_base_url", JSON.stringify(`${origin}/`)],
      ["analytics.enabled", "false"],
      ["otel.exporter", '"none"'],
      ["otel.trace_exporter", '"none"'],
      ["otel.metrics_exporter", '"none"'],
      ["check_for_update_on_startup", "false"],
    ];
  }

  private configToml(): string {
    return `${this.settings()
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n")}\n`;
  }

  /** 拉起 codex 用的环境 */
  get env(): Record<string, string> {
    return realCodexEnv(this.home);
  }

  /** 真的 codex：环境再按上面的钉一遍（适配子进程给什么都盖过去），线路抄一份 */
  get spawn(): CodexServerSpawn {
    const entry = findCodexEntry(process.env);
    if (!entry) throw new Error("PATH 上找不到 codex：真机核对要本机装了 codex");
    const real = spawnCodexServer(entry);
    return (args, options) => {
      const settings = this.settings().flatMap(([key, value]) => ["-c", `${key}=${value}`]);
      const given = this.allowTty ? args.filter((arg, at) => !(arg === "--disable" && args[at + 1] === "unified_exec_tty") && !(arg === "unified_exec_tty" && args[at - 1] === "--disable")) : args;
      const proc = real([...given, ...settings], { ...options, env: { ...options.env, ...realCodexEnv(this.home, options.env), ...this.envOverride }, log: (line) => this.logs.push(line) });
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      let buffered = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
          this.note("in", buffered.slice(0, at));
          buffered = buffered.slice(at + 1);
        }
        stdout.write(chunk);
      });
      proc.stdout.on("end", () => stdout.end());
      let sent = "";
      stdin.on("data", (chunk: Buffer) => {
        sent += chunk.toString("utf8");
        for (let at = sent.indexOf("\n"); at >= 0; at = sent.indexOf("\n")) {
          this.note("out", sent.slice(0, at));
          sent = sent.slice(at + 1);
        }
      });
      stdin.pipe(proc.stdin);
      return { stdin, stdout, exited: proc.exited, kill: () => proc.kill() };
    };
  }

  private note(dir: "in" | "out", line: string): void {
    if (!line.trim()) return;
    try {
      this.wire.push({ dir, at: Date.now(), ...(JSON.parse(line) as Omit<WireMessage, "dir" | "at">) });
    } catch {
      this.logs.push(`看不懂的一行（${dir}）：${line}`);
    }
  }

  /** 线路上某个方法的消息 */
  methods(name: string): WireMessage[] {
    return this.wire.filter((m) => m.method === name);
  }

  /** 这里面的工作文件 */
  file(name: string): string {
    return path.join(this.work, name);
  }

  /** 直接开一个 app-server、握手（造测试会话、读状态用；不配守卫）；测试结束关掉 */
  async rpc(onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = () => Promise.reject(new Error("不接"))): Promise<{ rpc: CodexRpc; close(): Promise<void>; notes: Array<{ method: string; params: Record<string, unknown> }> }> {
    const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
    const proc = this.spawn(["app-server"], { env: this.env, cwd: this.work, log: () => {} });
    const rpc = new CodexRpc(proc, { onNotification: (method, params) => notes.push({ method, params }), onRequest, onExit: () => {} });
    await rpc.initialize();
    onTestFinished(() => rpc.close());
    return { rpc, close: () => rpc.close(), notes };
  }

  /** 模拟终端里开着的 Codex 会话：一个独立的 app-server，client 名字不是二狗（真的终端界面这里驱动不了） */
  async terminal(): Promise<{ rpc: CodexRpc; start(): Promise<string>; say(threadId: string, text: string): Promise<string>; close(): Promise<void> }> {
    const proc = this.spawn(["app-server"], { env: this.env, cwd: this.work, log: () => {} });
    const completed: string[] = [];
    const rpc = new CodexRpc(proc, {
      onNotification: (method, params) => {
        if (method === "turn/completed") completed.push(String((params.turn as { id?: string }).id));
      },
      onRequest: () => Promise.resolve({ decision: "accept" }),
      onExit: () => {},
    });
    await rpc.request("initialize", { clientInfo: { name: "codex_cli_rs", title: "terminal", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    rpc.notify("initialized");
    onTestFinished(() => rpc.close());
    return {
      rpc,
      close: () => rpc.close(),
      start: async () => (await rpc.request<{ thread: { id: string } }>("thread/start", { cwd: this.work })).thread.id,
      say: async (threadId, text) => {
        const before = completed.length;
        const started = await rpc.request<{ turn: { id: string } }>("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
        for (let i = 0; i < 600 && completed.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
        if (completed.length === before) throw new Error(`终端这一轮 60 秒没结束：${text}`);
        return started.turn.id;
      },
    };
  }

  /** 真的一次性子进程（sessions-main.ts）：一行请求、一行结果，和守护进程拉起它一样 */
  oneShot<T>(request: object): Promise<T> {
    const entry = fileURLToPath(new URL("../../src/codex/child/sessions-main.ts", import.meta.url));
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(process.execPath, [entry], { env: this.env, cwd: this.work, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          const reply = JSON.parse(out.trim().split("\n").at(-1) ?? "") as { ok: boolean; result?: T; error?: string };
          if (reply.ok) resolve(reply.result as T);
          else reject(new Error(reply.error ?? `一次性子进程退出码 ${String(code)}：${err}`));
        } catch {
          reject(new Error(`一次性子进程没回结果（退出码 ${String(code)}）：${out} ${err}`));
        }
      });
      child.stdin!.end(encodeLine(request));
    });
  }
}

export interface RealChildOptions {
  session?: Partial<SessionAssembly>;
}

const allowAll = (): GuardVerdict => ({ allow: true });

/** 在本进程里跑真的适配子进程（宿主协议的流在内存里），它拉起真的 codex，钩子、MCP 中转都是真的进程 */
export function startRealChild(lab: RealCodexLab, options: RealChildOptions = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Set<(report: AgentReport) => void>();
  readJsonLines<AgentReport>(stdout, (report) => listeners.forEach((l) => l(report)), { onInvalid: () => {} });
  const log = new ReportLog({
    onReport: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const logs: string[] = [];
  const child = runCodexChild({ stdin, stdout, env: lab.env, log: (line) => logs.push(line), exit: () => {} }, { spawnFor: () => lab.spawn });
  const assembly = codexAssembly({ cwd: lab.work, sessionDir: path.join(lab.root, "sessions"), runtimeDir: path.join(lab.root, "runtime"), ...options.session });
  fs.mkdirSync(assembly.sessionDir, { recursive: true });
  fs.mkdirSync(assembly.runtimeDir!, { recursive: true });
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(() => child.shutdown(0));

  /** 守卫按这个函数判（默认全放行）；后设的盖掉先设的 */
  let decide: (request: ReportOf<"guard_request">) => GuardVerdict = allowAll;
  listeners.add((report) => {
    if (report.type === "guard_request") send({ type: "guard_reply", requestId: report.requestId, verdict: decide(report) });
  });
  const answerGuard = (next: (request: ReportOf<"guard_request">) => GuardVerdict) => {
    decide = next;
  };
  /** 二狗工具的结果按这个函数回 */
  const answerHostTool = (run: (call: ReportOf<"host_tool_call">) => HostToolResult) => {
    listeners.add((report) => {
      if (report.type === "host_tool_call") send({ type: "host_tool_result", requestId: report.requestId, result: run(report) });
    });
  };
  /** 送一条输入，等这一轮结束 */
  const turn = async (inputId: string, text: string, timeoutMs = 120_000) => {
    send({ type: "user_input", inputId, text });
    return log.next("turn_end", timeoutMs);
  };
  return { send, log, logs, assembly, answerGuard, answerHostTool, turn, shutdown: child.shutdown };
}

export type RealChild = ReturnType<typeof startRealChild>;
