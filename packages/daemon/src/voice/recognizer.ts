// 语音识别进程（规格第 21、22 节，31 号票）：faster-whisper 跑在守护进程按需拉起的 Python 进程里（recognizer.py）。
// - 第一次要识别时才拉起，放进它自己的 Job 对象（KILL_ON_JOB_CLOSE、不允许脱离；守护进程怎么死它都跟着结束）。
//   不放进 agent 管家的 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，守护进程直接起的进程会被当成孤儿；
// - 环境照 agent 子进程的系统变量白名单（buildChildEnv：没有守护进程的密钥），另加固定的几项（不联网下载模型、输出 UTF-8）；
// - 两边走 stdin / stdout 的 JSON 行，形状照 08 号票算向量的工作线程：请求 { id, type, ... }，应答 { id, result } 或
//   { id, error, fatal? }（fatal：模型没加载起来，这个进程不能再用）。识别进程一次处理一条，按到达顺序；
// - 闲置超过配置的时间（默认 5 分钟）就让它退出，把模型占的显存还回去，下次要识别时再拉起；
// - 一次识别最多等多久按语音时长和设备算（recognizeTimeoutMs）：超时就结束这个进程，这条记成失败，后面的输入不再等它；
// - 起不来（Python 路径不对、没装 faster-whisper）、模型加载失败，交给它的请求以 RecognizerUnavailable 结束
//   （语音的识别状态记成失败，待我处理里放一条说明），守护进程照常运行。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { VOICE_MAX_MS } from "@ergou/protocol";
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
 * loadedDevice 是识别进程已经加载好模型的设备（上一次的结果里报的）；还没加载（刚拉起）时多留冷启动的时间，
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

/** 识别进程不可用：起不来、模型加载失败。这类问题重试也没用，要用户在本机修好（待我处理里说明） */
export class RecognizerUnavailable extends Error {
  override readonly name = "RecognizerUnavailable";
}

export interface Recognizer {
  /** 识别一段音频；audioMs 是它的时长（算超时用，不给按最长的 60 秒算） */
  transcribe(request: RecognizeRequest, audioMs?: number): Promise<RecognizeResult>;
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
  /** 闲置多久让识别进程退出（毫秒） */
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
  | ({ id: number; type: "transcribe" } & RecognizeRequest)
  | { type: "exit" };
type RecognizerResponseLine = { id: number; result: RecognizeResult } | { id: number; error: string; fatal?: boolean };

/** 退出要等多久：送了 exit 还不退就结束它 */
const EXIT_GRACE_MS = 5_000;
/** 日志里留识别进程 stderr 的最后多少字符（起不来时写进原因） */
const STDERR_TAIL = 2_000;

interface Pending {
  resolve(result: RecognizeResult): void;
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
  /** 模型加载在哪个设备上（有过一次结果才知道；之前是冷的） */
  device: string | undefined;
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

  /** 这个进程不能再用了：交给它的请求都以 err 结束，Job 关掉（里面的进程一起结束） */
  const retire = (running: Running, err: Error) => {
    running.retired = true;
    if (current === running) current = undefined;
    for (const p of running.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    running.pending.clear();
  };

  const kill = (running: Running) => {
    if (running.job) running.job.close();
    else running.child.kill();
  };

  /** 闲着就让它退出：先送 exit，过一会儿还在就结束它 */
  const retireIdle = (running: Running) => {
    if (running.pending.size > 0 || running.retired) return;
    options.log("语音识别进程闲置，让它退出、释放模型");
    retire(running, new Error("语音识别进程已闲置退出"));
    send(running, { type: "exit" });
    running.child.stdin.end();
    setTimeout(() => kill(running), EXIT_GRACE_MS).unref();
  };

  const armIdle = (running: Running) => {
    clearTimeout(idleTimer);
    if (running.pending.size > 0) return;
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

  const ensureProcess = (): Running => {
    if (current && !current.retired) return current;
    const [program, ...args] = options.command;
    if (!program) throw new RecognizerUnavailable("没有配置识别进程的程序");
    let job: JobObject | undefined;
    try {
      job = options.newJob?.();
    } catch (err) {
      throw new RecognizerUnavailable(`建不了 Job 对象：${messageOf(err)}`);
    }
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const exit = deferred();
    const running: Running = { child, job, pending: new Map(), stderr: "", retired: false, device: undefined, exited: exit.promise };
    current = running;
    alive.add(running);
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
      if (running.pending.size > 0) retire(running, unavailable(running, `识别进程退出了（退出码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）`));
      else retire(running, new Error("识别进程已退出"));
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
    // 放好 Job 之后才交给它设置：它读到之前什么都不做
    send(running, { type: "init", ...options.init });
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
      if (message.fatal) {
        const err = new RecognizerUnavailable(message.error);
        p.reject(err);
        // 模型没加载起来：这个进程作废，下次要识别时重新拉起、重新加载
        retire(running, err);
        kill(running);
        return;
      }
      p.reject(new Error(message.error));
    } else {
      running.device = message.result.device;
      p.resolve(message.result);
    }
    if (current === running) armIdle(running);
  };

  return {
    get running() {
      return current !== undefined && !current.retired;
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
        running.pending.set(id, { resolve, reject, timer });
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

/** 识别进程不可用时（比如配置里的 Python 路径还是占位符）：每次都以 RecognizerUnavailable 结束 */
export function unavailableRecognizer(reason: string): Recognizer {
  return {
    running: false,
    transcribe: () => Promise.reject(new RecognizerUnavailable(reason)),
    close: () => Promise.resolve(),
  };
}

/** 一个之后才兑现的 Promise */
function deferred(): { promise: Promise<void>; resolve(): void } {
  const out: { promise?: Promise<void>; resolve?: () => void } = {};
  out.promise = new Promise<void>((r) => {
    out.resolve = r;
  });
  return out as { promise: Promise<void>; resolve(): void };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
