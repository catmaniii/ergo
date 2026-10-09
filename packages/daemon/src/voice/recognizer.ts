// 语音识别进程（规格第 21、22 节，31 号票）：faster-whisper 跑在守护进程拉起的 Python 进程里（recognizer.py）。
// - 要用时才拉起（45 号票起守护进程一启动就由预热拉起，见 warmup.ts），放进它自己的 Job 对象（KILL_ON_JOB_CLOSE、不允许脱离；
//   守护进程怎么死它都跟着结束）。不放进 agent 管家的 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，守护进程直接起的进程会被当成孤儿；
// - 环境照 agent 子进程的系统变量白名单（buildChildEnv：没有守护进程的密钥），另加固定的几项（不联网下载模型、输出 UTF-8）；
// - 两边走 stdin / stdout 的 JSON 行，形状照 08 号票算向量的工作线程：请求 { id, type, ... }，应答 { id, result } 或
//   { id, error, fatal? }（fatal：模型没加载起来，这个进程不能再用）。识别进程一次处理一条，按到达顺序；
// - 45 号票：拉起后先交给它设置，紧接着让它加载模型（"加载"消息，回报用的模型、设备、计算精度、加载耗时、退回的原因）。
//   真的识别排在加载后面（同一个进程按到达顺序处理），所以预热时来的识别请求等加载好就识别，不另起进程；
// - 闲置多久退出可配（idleMs）：0 是常驻（45 号票起的默认），不因闲置退出；正数的闲置这么久就让它退出、把模型占的显存还回去，
//   下次要识别时再拉起；
// - 一次识别最多等多久按语音时长和设备算（recognizeTimeoutMs）：超时就结束这个进程，这条记成失败，后面的输入不再等它；
//   加载最多等余量加冷启动的时间；
// - 起不来（Python 路径不对、没装 faster-whisper）、模型加载失败，交给它的请求以 RecognizerUnavailable 结束
//   （语音的识别状态记成失败，待我处理里放一条说明），守护进程照常运行；
// - 识别模型的状态（VoiceModelState：等待加载、加载中、已就绪、出错、已卸载）经 state / onState 给出（设置 · 语音里显示）。
//   进程的一生（加载好了、没了和为什么：没加载起来、加载好之后意外没了、闲置退出）经 onLifecycle 明确报出，
//   要不要重新拉起由预热（warmup.ts）据此定。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { nowIso, VOICE_MAX_MS, type VoiceModelState } from "@ergou/protocol";
import type { RecognizeTimeoutConfig, VoiceModelConfig } from "../config/config.ts";
import type { JobObject } from "../process/job-object.ts";

/** 拉起后第一行交给识别进程的设置：先用 primary，显卡不可用或显存不够时退回 fallback */
export interface RecognizerInit {
  primary: VoiceModelConfig;
  fallback: VoiceModelConfig | null;
}

/** 这个设备算不算 CPU（别的都按显卡算：cuda、auto……） */
const isCpu = (device: string) => device.toLowerCase() === "cpu";

/**
 * 一次识别最多等多久（毫秒）：余量 + 语音时长 × 每秒语音最多等几秒（显卡上、CPU 上各一个）。
 * loadedDevice 是识别进程已经加载好模型的设备（加载的回报、上一次的结果里报的）；还没加载好（刚拉起）时多留冷启动的时间，
 * 而且不知道会落在哪个设备上（显卡不行会退回），按 primary 和 fallback 里宽的算
 */
export function recognizeTimeoutMs(timeout: RecognizeTimeoutConfig, init: RecognizerInit, audioMs: number, loadedDevice: string | undefined): number {
  const factor = (device: string) => (isCpu(device) ? timeout.cpuPerAudioSecond : timeout.gpuPerAudioSecond);
  const perAudioSecond =
    loadedDevice === undefined ? Math.max(factor(init.primary.device), init.fallback ? factor(init.fallback.device) : 0) : factor(loadedDevice);
  return Math.round(timeout.baseMs + (loadedDevice === undefined ? timeout.coldStartMs : 0) + (audioMs / 1000) * perAudioSecond * 1000);
}

export interface RecognizeRequest {
  /** 音频文件（媒体库里的录音） */
  path: string;
  /** 语言（比如 zh）；不给由模型自己判断 */
  language?: string;
  /** 给模型的提示（比如"以下是普通话的句子。"：中文出简体、带标点） */
  initialPrompt?: string;
}

export interface RecognizeResult {
  text: string;
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
  /** 音频时长（秒） */
  duration?: number;
  model: string;
  device: string;
  computeType: string;
  /** 退回 CPU 的原因（没退回没有） */
  fallbackReason?: string;
}

/** 识别进程加载好模型的回报（45 号票） */
export interface RecognizerLoaded {
  model: string;
  device: string;
  computeType: string;
  /** 加载模型用了多久（毫秒；显卡上加载不了、退回 CPU 的，连试显卡的时间一起算） */
  loadMs: number;
  /** 退回 CPU 的原因（没退回没有） */
  fallbackReason?: string;
}

/**
 * 识别进程的一生里，预热（warmup.ts）据此决定要不要重拉的两件事（45 号票）：
 * - loaded：模型加载好了；
 * - ended：这个进程没了，cause 说为什么——load_failed（没加载起来：起不来、放不进 Job、加载失败、加载超时、加载完之前就退出了）、
 *   exited（加载好之后意外没了：崩溃、被杀、识别时报致命错误、识别超时被结束）、idle（闲置退出）。
 *   守护进程自己停（close）的不报
 */
export type RecognizerLifecycleEvent =
  | { type: "loaded"; info: RecognizerLoaded }
  | { type: "ended"; cause: "load_failed" | "exited" | "idle"; reason: string };

/** 识别进程不可用：起不来、模型加载失败。这类问题重试也没用，要用户在本机修好（待我处理里说明） */
export class RecognizerUnavailable extends Error {
  override readonly name = "RecognizerUnavailable";
}

export interface Recognizer {
  /** 识别一段音频；audioMs 是它的时长（算超时用，不给按最长的 60 秒算） */
  transcribe(request: RecognizeRequest, audioMs?: number): Promise<RecognizeResult>;
  /** 拉起识别进程、加载好模型（预热，45 号票）；已经加载好了直接回报。起不来、加载失败以 RecognizerUnavailable 结束 */
  load(): Promise<RecognizerLoaded>;
  /** 识别模型现在的状态 */
  readonly state: VoiceModelState;
  /** 状态变了就告诉 listener；返回取消的函数 */
  onState(listener: (state: VoiceModelState) => void): () => void;
  /** 模型加载好了、识别进程没了（为什么）就告诉 listener；返回取消的函数 */
  onLifecycle(listener: (event: RecognizerLifecycleEvent) => void): () => void;
  /** 识别进程现在在不在 */
  readonly running: boolean;
  /** 结束识别进程，等着的请求以出错结束 */
  close(): Promise<void>;
}

export interface ProcessRecognizerOptions {
  /** 拉起识别进程的程序和参数（正式的是 Python 加 recognizer.py；测试换成假的） */
  command: readonly string[];
  /** 完整的环境（显式给出，不继承守护进程的环境） */
  env: Record<string, string>;
  /** 工作目录 */
  cwd: string;
  init: RecognizerInit;
  /** 闲置多久让识别进程退出（毫秒）；0 是常驻，不因闲置退出 */
  idleMs: number;
  /** 一次识别最多等多久（按时长和设备算，见 recognizeTimeoutMs）：超时就结束这个进程（它可能卡住了），这次以出错结束 */
  timeout: RecognizeTimeoutConfig;
  /** 给识别进程建一个 Job 对象；返回 undefined（不是 Windows）时不放 */
  newJob?: () => JobObject | undefined;
  log: (line: string) => void;
}

/** 请求和应答的形状（和 recognizer.py 一致） */
type RecognizerRequestLine =
  | ({ type: "init" } & RecognizerInit)
  | { id: number; type: "load" }
  | ({ id: number; type: "transcribe" } & RecognizeRequest)
  | { type: "exit" };
type RecognizerResponseLine = { id: number; result: RecognizeResult | RecognizerLoaded } | { id: number; error: string; fatal?: boolean };

/** 退出要等多久：送了 exit 还不退就结束它 */
const EXIT_GRACE_MS = 5_000;
/** 日志里留识别进程 stderr 的最后多少字符（起不来时写进原因） */
const STDERR_TAIL = 2_000;

interface Pending {
  /** 加载还是识别 */
  kind: "load" | "transcribe";
  resolve(result: RecognizeResult | RecognizerLoaded): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** 一个识别进程和交给它、还没回来的请求 */
interface Running {
  child: ChildProcessWithoutNullStreams;
  job: JobObject | undefined;
  pending: Map<number, Pending>;
  /** stderr 的结尾（起不来时写进原因） */
  stderr: string;
  /** 已经作废（出错、退出、闲置退出）：不再交请求给它 */
  retired: boolean;
  /** 模型加载在哪个设备上（加载好、有过一次结果才知道；之前是冷的） */
  device: string | undefined;
  /** 拉起时就让它加载模型：加载的结局 */
  loaded: Promise<RecognizerLoaded>;
  /** 加载好的模型（识别时显卡出错退回了 CPU 的，记退回后的） */
  info: RecognizerLoaded | undefined;
  /** 进程结束了（或者根本没起来） */
  exited: Promise<void>;
}

export function createProcessRecognizer(options: ProcessRecognizerOptions): Recognizer {
  let current: Running | undefined;
  /** 还没结束的识别进程（作废了、正在退出的也算）：close() 等它们都结束 */
  const alive = new Set<Running>();
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let state: VoiceModelState = { status: "waiting", since: nowIso() };
  const listeners = new Set<(state: VoiceModelState) => void>();
  const lifecycle = new Set<(event: RecognizerLifecycleEvent) => void>();

  const setState = (next: Omit<VoiceModelState, "since">) => {
    if (closed) return;
    state = { ...next, since: nowIso() };
    for (const listener of listeners) listener(state);
  };
  const report = (event: RecognizerLifecycleEvent) => {
    if (closed) return;
    for (const listener of lifecycle) listener(event);
  };
  const setReady = (info: RecognizerLoaded) =>
    setState({
      status: "ready",
      model: info.model,
      device: info.device,
      computeType: info.computeType,
      loadMs: Math.max(0, Math.round(info.loadMs)),
      ...(info.fallbackReason ? { fallbackReason: info.fallbackReason } : {}),
    });

  /**
   * 这个进程不能再用了：交给它的请求都以 err 结束，Job 关掉（里面的进程一起结束）。
   * 它是现在用的那个时，模型的状态跟着变（闲置退出的是已卸载，别的是出错），并报一次它没了：
   * 闲置退出的是 idle，加载好过的是 exited（意外没了），没加载好过的是 load_failed
   */
  const retire = (running: Running, err: Error, why: "idle" | "error" = "error") => {
    const wasCurrent = current === running && !running.retired;
    running.retired = true;
    if (current === running) current = undefined;
    for (const p of running.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    running.pending.clear();
    if (!wasCurrent) return;
    setState(why === "idle" ? { status: "unloaded" } : { status: "error", reason: err.message });
    report({ type: "ended", cause: why === "idle" ? "idle" : running.info ? "exited" : "load_failed", reason: err.message });
  };

  const kill = (running: Running) => {
    if (running.job) running.job.close();
    else running.child.kill();
  };

  /** 闲着就让它退出：先送 exit，过一会儿还在就结束它 */
  const retireIdle = (running: Running) => {
    if (running.pending.size > 0 || running.retired) return;
    options.log("语音识别进程闲置，让它退出、释放模型");
    retire(running, new Error("语音识别进程已闲置退出"), "idle");
    send(running, { type: "exit" });
    running.child.stdin.end();
    setTimeout(() => kill(running), EXIT_GRACE_MS).unref();
  };

  const armIdle = (running: Running) => {
    clearTimeout(idleTimer);
    // 0 是常驻：不因闲置退出
    if (running.pending.size > 0 || options.idleMs <= 0) return;
    idleTimer = setTimeout(() => retireIdle(running), options.idleMs);
    idleTimer.unref();
  };

  const send = (running: Running, line: RecognizerRequestLine) => {
    try {
      running.child.stdin.write(`${JSON.stringify(line)}\n`);
    } catch {
      // 进程刚好退出了：exit 事件会处理
    }
  };

  const unavailable = (running: Running, what: string) =>
    new RecognizerUnavailable(`${what}${running.stderr.trim() ? `：${running.stderr.trim().split(/\r?\n/).slice(-3).join(" / ")}` : ""}`);

  /** 拉起前就失败了（没配程序、建不了 Job）：状态记成出错 */
  const cannotStart = (reason: string): never => {
    setState({ status: "error", reason });
    report({ type: "ended", cause: "load_failed", reason });
    throw new RecognizerUnavailable(reason);
  };

  const ensureProcess = (): Running => {
    if (current && !current.retired) return current;
    const [program, ...args] = options.command;
    if (!program) return cannotStart("没有配置识别进程的程序");
    let job: JobObject | undefined;
    try {
      job = options.newJob?.();
    } catch (err) {
      return cannotStart(`建不了 Job 对象：${messageOf(err)}`);
    }
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const exit = deferred<void>();
    const loaded = deferred<RecognizerLoaded>();
    // 没人等（真的识别先到、预热还没来问）时加载失败不算没处理的 rejection
    loaded.promise.catch(() => {});
    const running: Running = { child, job, pending: new Map(), stderr: "", retired: false, device: undefined, loaded: loaded.promise, info: undefined, exited: exit.promise };
    current = running;
    alive.add(running);
    setState({ status: "loading" });
    // 加载先登记上：起不来、加载前就退出时，它和别的请求一起以出错结束
    const loadId = nextId++;
    const loadTimeoutMs = options.timeout.baseMs + options.timeout.coldStartMs;
    const loadTimer = setTimeout(() => {
      const seconds = Math.max(1, Math.round(loadTimeoutMs / 1000));
      options.log(`语音识别进程加载模型超过 ${seconds} 秒没有结果，结束它`);
      retire(running, new RecognizerUnavailable(`加载模型超过 ${seconds} 秒没有结果`));
      kill(running);
    }, loadTimeoutMs);
    loadTimer.unref();
    running.pending.set(loadId, {
      kind: "load",
      resolve: (result) => loaded.resolve(result as RecognizerLoaded),
      reject: loaded.reject,
      timer: loadTimer,
    });
    const gone = () => {
      alive.delete(running);
      exit.resolve();
    };
    child.on("error", (err) => {
      job?.close();
      retire(running, new RecognizerUnavailable(`识别进程起不来（${program}）：${err.message}`));
      // 没起来就不会有 exit
      if (child.pid === undefined) gone();
    });
    child.on("exit", (code, signal) => {
      job?.close();
      // 还在用着它（不是闲置退出、不是因为出错被结束）却退出了：意外退出
      retire(running, unavailable(running, `识别进程退出了（退出码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）`));
      gone();
    });
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      running.stderr = (running.stderr + chunk).slice(-STDERR_TAIL);
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => onLine(running, line));
    if (child.pid === undefined) return running;
    try {
      job?.assign(child.pid);
    } catch (err) {
      kill(running);
      retire(running, new RecognizerUnavailable(`识别进程放不进 Job 对象：${messageOf(err)}`));
      return running;
    }
    // 放好 Job 之后才交给它设置：它读到之前什么都不做；紧接着让它加载模型
    send(running, { type: "init", ...options.init });
    send(running, { id: loadId, type: "load" });
    return running;
  };

  const onLine = (running: Running, line: string) => {
    let message: RecognizerResponseLine;
    try {
      message = JSON.parse(line) as RecognizerResponseLine;
    } catch {
      // 不是协议的行（库打到 stdout 上的东西）：记日志、不理
      options.log(`语音识别进程输出了一行看不懂的：${line.slice(0, 200)}`);
      return;
    }
    const p = running.pending.get(message.id);
    if (!p) return;
    running.pending.delete(message.id);
    clearTimeout(p.timer);
    if ("error" in message) {
      // 加载出错都按致命的算：没有模型，这个进程不能用
      if (message.fatal || p.kind === "load") {
        const err = new RecognizerUnavailable(message.error);
        p.reject(err);
        // 模型没加载起来：这个进程作废，下次要用时重新拉起、重新加载
        retire(running, err);
        kill(running);
        return;
      }
      p.reject(new Error(message.error));
    } else if (p.kind === "load") {
      const info = message.result as RecognizerLoaded;
      running.info = info;
      running.device = info.device;
      if (current === running) {
        setReady(info);
        report({ type: "loaded", info });
      }
      p.resolve(info);
    } else {
      const result = message.result as RecognizeResult;
      running.device = result.device;
      // 识别时显卡出错、退回了 CPU：模型的状态跟着变
      const info = running.info;
      if (info && (info.model !== result.model || info.device !== result.device)) {
        running.info = { ...info, model: result.model, device: result.device, computeType: result.computeType, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) };
        if (current === running) setReady(running.info);
      }
      p.resolve(result);
    }
    if (current === running) armIdle(running);
  };

  return {
    get running() {
      return current !== undefined && !current.retired;
    },
    get state() {
      return state;
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycle.add(listener);
      return () => lifecycle.delete(listener);
    },
    load() {
      if (closed) return Promise.reject(new Error("语音识别已停止"));
      let running: Running;
      try {
        running = ensureProcess();
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return running.info ? Promise.resolve(running.info) : running.loaded;
    },
    transcribe(request, audioMs = VOICE_MAX_MS) {
      if (closed) return Promise.reject(new Error("语音识别已停止"));
      clearTimeout(idleTimer);
      let running: Running;
      try {
        running = ensureProcess();
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      if (running.retired) return Promise.reject(unavailable(running, "识别进程起不来"));
      const id = nextId++;
      const timeoutMs = recognizeTimeoutMs(options.timeout, options.init, audioMs, running.device);
      return new Promise<RecognizeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          // 可能卡住了：结束这个进程，这次以出错结束（下次重新拉起）
          const seconds = Math.max(1, Math.round(timeoutMs / 1000));
          options.log(`语音识别超过 ${seconds} 秒没有结果，结束识别进程`);
          retire(running, new Error(`识别超过 ${seconds} 秒没有结果`));
          kill(running);
        }, timeoutMs);
        timer.unref();
        running.pending.set(id, { kind: "transcribe", resolve: (result) => resolve(result as RecognizeResult), reject, timer });
        send(running, { id, type: "transcribe", ...request });
      });
    },
    async close() {
      closed = true;
      clearTimeout(idleTimer);
      // 正在用的、作废了还没退完的，一起结束，等它们都退出
      const all = [...alive];
      for (const running of all) {
        retire(running, new Error("语音识别已停止"));
        kill(running);
      }
      await Promise.all(all.map((r) => r.exited));
    },
  };
}

/** 识别进程不可用时（比如配置里的 Python 路径还是占位符）：每次都以 RecognizerUnavailable 结束，状态一直是出错 */
export function unavailableRecognizer(reason: string): Recognizer {
  const state: VoiceModelState = { status: "error", reason, since: nowIso() };
  return {
    running: false,
    state,
    onState: () => () => {},
    onLifecycle: () => () => {},
    load: () => Promise.reject(new RecognizerUnavailable(reason)),
    transcribe: () => Promise.reject(new RecognizerUnavailable(reason)),
    close: () => Promise.resolve(),
  };
}

/** 一个之后才兑现的 Promise */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
