// 假的语音识别服务（250 号票）：代替 LSM 托管的 recognizer.py --serve（fixtures/fake-asr-service.mjs）。
// 用的是真进程、真 HTTP，端口由系统挑（记录文件里那行 start 写着），所以两种用法都合适：
// - 单元测试（test/voice/recognizer-client.test.ts）：只看 HTTP 客户端的行为，杀掉它就是"服务没了"；
// - 主切面（test/main/voice-services.test.ts）：真守护进程按配置连上它，识别出的文字进语音、进素材。
// 测试一律不碰本机真的 8091、不加载真模型。
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { killIfRunning, waitUntil } from "./process.ts";
import { makeTempDir } from "./temp-dir.ts";

/** 假的语音识别服务 */
export const FAKE_ASR_SERVICE = fileURLToPath(new URL("../fixtures/fake-asr-service.mjs", import.meta.url));

/** 假服务这次怎么回（见 fake-asr-service.mjs 开头） */
export interface FakeAsrDirective {
  /** 识别出的文字（按句末标点切成分段） */
  text?: string;
  language?: string;
  /** 音频多少秒 */
  seconds?: number;
  model?: string;
  device?: string;
  computeType?: string;
  /** 当作退回了 CPU：这是原因 */
  fallbackReason?: string;
  /** 预热之后过多少毫秒才算加载好（默认 0） */
  loadMs?: number;
  /** 预热失败：状态里带 error，识别回 503 + fatal */
  loadFail?: string;
  /** 预热也不加载好 */
  notLoaded?: boolean;
  /** /health 不回 */
  hangHealth?: boolean;
  /** 识别回 500（不致命） */
  transcribeError?: string;
  /** 识别回 503 + fatal */
  transcribeFatal?: string;
  /** 识别回这个状态码 */
  transcribeStatus?: number;
  /** 识别不回 */
  hangTranscribe?: boolean;
  /** 从这一刻起什么请求都不回 */
  wedged?: boolean;
}

/** 让假服务之后的请求这样回（undefined：照常回）；logFile 是它的记录文件 */
export function setFakeAsr(logFile: string, directive: FakeAsrDirective | undefined): void {
  const file = `${logFile}.asr.json`;
  if (directive === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(directive));
}

/** 假服务的记录 */
export interface FakeAsrEntry {
  event: "start" | "health" | "models" | "warmup" | "transcribe";
  pid?: number;
  port?: number;
  /** 识别请求里的录音解出来多少字节 */
  bytes?: number;
  language?: string;
  initialPrompt?: string;
  /** 预热收到的设置（和 stdio 那行 init 一样） */
  init?: unknown;
}

export function asrLog(logFile: string): FakeAsrEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FakeAsrEntry);
}

export interface FakeAsrService {
  /** 记录文件（asrLog 读它） */
  log: string;
  /** 服务的地址，比如 http://127.0.0.1:51234 */
  url: string;
  port: number;
  /** 杀掉（模拟服务没了）；已经杀了就什么也不做 */
  down(): Promise<void>;
  /** 进程还活着吗 */
  alive(): boolean;
}

/** 起一个假的语音识别服务（用完自动收掉）：端口由系统挑，等它报出端口再返回 */
export async function startFakeAsrService(options: { directive?: FakeAsrDirective } = {}): Promise<FakeAsrService> {
  const dir = makeTempDir("ergo-asr-service-");
  const log = path.join(dir, "asr.jsonl");
  if (options.directive) setFakeAsr(log, options.directive);
  const child: ChildProcess = spawn(process.execPath, [FAKE_ASR_SERVICE, log], { stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(async () => {
    killIfRunning(child);
    await exited;
  });
  const alive = () => child.exitCode === null && child.signalCode === null;
  await waitUntil(() => asrLog(log).some((e) => e.event === "start") || !alive(), { timeoutMs: 10_000, describe: () => "假识别服务起来并报出端口" });
  const started = asrLog(log).find((e) => e.event === "start");
  if (!started?.port) throw new Error("假识别服务没报出端口（进程没起来？）");
  return {
    log,
    url: `http://127.0.0.1:${started.port}`,
    port: started.port,
    alive,
    async down() {
      killIfRunning(child);
      await exited;
    },
  };
}
