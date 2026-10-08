// 语音消息的测试底座（31 号票）：假的识别进程（fixtures/fake-recognizer.mjs）、"录音"文件、上传后发一条语音消息、读识别进程的记录。
// 测试一律用假的识别进程，不加载真模型、不联网、不占显卡。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type ConversationId, EVENT_TYPES, type VoiceEventPayload, type VoiceRecord } from "@ergou/protocol";
import type { TestFrontend } from "./frontend.ts";
import { media } from "./http.ts";
import { waitUntil } from "./process.ts";

/** 假的识别进程 */
export const FAKE_RECOGNIZER = fileURLToPath(new URL("../fixtures/fake-recognizer.mjs", import.meta.url));

/** 拉起假的识别进程的命令（记录写进 logFile） */
export function fakeRecognizerCommand(logFile: string): string[] {
  return [process.execPath, FAKE_RECOGNIZER, logFile];
}

/** 假的识别进程这次怎么回（见 fake-recognizer.mjs 开头） */
export interface FakeAsr {
  text?: string;
  language?: string;
  seconds?: number;
  fallback?: string;
  error?: string;
  errorUnless?: string;
  fatal?: string;
  crash?: string;
  holdFile?: string;
  noise?: string;
}

/** WebM 的 EBML 头：服务端按它认出是音频 */
const WEBM_HEADER = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);

/** 一段"录音"：WebM 头加上给假识别进程的指令（每段内容不同，媒体 id 也就不同） */
export function fakeRecording(asr: FakeAsr, salt = Math.random().toString(36).slice(2)): Uint8Array {
  return Buffer.concat([WEBM_HEADER, Buffer.from(`\nFAKE-ASR ${JSON.stringify(asr)}\n${salt}\n`, "utf8")]);
}

/** 把一段录音传上去，再发一条带语音 part 的消息（像 Web 那样：抬手后整段上传，传完再发） */
export async function sendVoice(
  frontend: TestFrontend,
  url: string,
  asr: FakeAsr,
  options: { conversation?: ConversationId; durationMs?: number; waveform?: number[]; idempotencyKey?: string; mime?: string } = {},
): Promise<{ messageId: string; seq: number; mediaId: string; idempotencyKey: string }> {
  const uploaded = await media.upload(url, fakeRecording(asr), { name: "语音.webm", mime: options.mime ?? "audio/webm;codecs=opus" });
  const sent = await frontend.sendParts(
    [{ type: "voice", mediaId: uploaded.mediaId, mime: options.mime ?? "audio/webm;codecs=opus", durationMs: options.durationMs ?? 3200, waveform: options.waveform ?? [8, 40, 72, 55, 20] }],
    { ...(options.conversation ? { conversation: options.conversation } : {}), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) },
  );
  return { ...sent, mediaId: uploaded.mediaId };
}

/** 前端收到的某条语音的各个版本（按到达顺序） */
export function voiceVersions(frontend: TestFrontend, voiceId?: string): VoiceRecord[] {
  return frontend
    .events({ type: EVENT_TYPES.voice })
    .map((f) => (f.payload as VoiceEventPayload).voice)
    .filter((v) => voiceId === undefined || v.id === voiceId);
}

/** 等前端收到这条语音的某个状态（识别有了结局：done / failed） */
export async function voiceSettled(frontend: TestFrontend, status: VoiceRecord["status"] | ((v: VoiceRecord) => boolean), timeoutMs = 10_000): Promise<VoiceRecord> {
  const match = typeof status === "function" ? status : (v: VoiceRecord) => v.status === status;
  await waitUntil(() => voiceVersions(frontend).some(match), { timeoutMs, describe: () => `语音状态：${JSON.stringify(voiceVersions(frontend).map((v) => [v.status, v.attempt]))}` });
  return voiceVersions(frontend).findLast(match)!;
}

/** 假识别进程的记录 */
export interface RecognizerLogEntry {
  event: "start" | "init" | "transcribe" | "exit";
  pid?: number;
  env?: string[];
  cwd?: string;
  path?: string;
  language?: string;
  initialPrompt?: string;
  primary?: { device: string; model: string; computeType: string };
  fallback?: { device: string; model: string; computeType: string } | null;
}

export function recognizerLog(logFile: string): RecognizerLogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecognizerLogEntry);
}
