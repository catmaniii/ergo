// 语音回复的测试底座（32 号票）：假的语音合成服务（代替本机 LSM 托管的 audio.cpp，空闲端口，测试结束时关掉）、
// 生成 WAV、导入参考音色。测试一律不碰本机 8090 上的真服务、不占显卡。
// 38 号票起守护进程分段合成：一段一次请求，假服务按段（按请求）回；script 给接下来几次请求各自怎么回，
// hold 住的可以一次放行一个（releaseNext），看守护进程是不是合成好一段推一段。
// 45 号票起守护进程启动后（和导入参考音色后）会发一条预热的试合成：它单独记在 warmups、单独回（behaveWarmup），不影响别的。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentVoiceEventPayload, type AgentVoiceRecord, EVENT_TYPES, HTTP_PATHS, type ReferenceVoice, type ReferenceVoiceList, type VoiceModelsView } from "@ergo/protocol";
import { onTestFinished } from "vitest";
import { WARMUP_TEXT } from "../../src/voice/warmup.ts";
import type { TestFrontend } from "./frontend.ts";
import { requestJson } from "./http.ts";
import { waitUntil } from "./process.ts";

/** 测试守护进程默认的语音合成地址：本机 1 号端口上没有服务（连不上），免得哪个测试不小心打到真的 audio.cpp */
export const NO_SPEECH_SERVICE_URL = "http://127.0.0.1:1";

/** 一段 WAV：单声道 16 位 PCM，正弦波，响度随时间起伏（波形摘要看得出高低） */
export function makeWav(seconds: number, options: { sampleRate?: number; channels?: number; float?: boolean } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 8000;
  const channels = options.channels ?? 1;
  const float = options.float ?? false;
  const bytesPerSample = float ? 4 : 2;
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * channels * bytesPerSample);
  for (let i = 0; i < frames; i++) {
    const envelope = 0.2 + 0.7 * Math.abs(Math.sin((Math.PI * i) / sampleRate));
    const value = envelope * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    for (let c = 0; c < channels; c++) {
      const offset = (i * channels + c) * bytesPerSample;
      if (float) data.writeFloatLE(value, offset);
      else data.writeInt16LE(Math.round(value * 32767), offset);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 假服务合成的语音有多长：每 5 个字 1 秒，至少 1 秒（时长只用来核对守护进程按 WAV 头量出的时长） */
export function fakeSpeechSeconds(input: string): number {
  return Math.max(1, Math.round((input.length / 5) * 10) / 10);
}

/** 假服务收到的一次合成请求 */
export interface FakeSpeechRequest {
  body: Record<string, unknown>;
  model: unknown;
  input: string;
  voiceRef: string;
  referenceText: unknown;
  /** 收到请求时 voice_ref 指的文件在不在、内容是什么 */
  voiceRefBytes: Buffer | undefined;
}

/** 假服务怎么回：ok 回一段 WAV；status 回一个错误状态码；hang 一直不回（测超时）；hold 先不回，release() 之后照 ok 回 */
export type FakeSpeechBehavior = "ok" | "hang" | "hold" | { status: number; body?: string } | { wav: Buffer };

/** 假服务的模型列表（GET /v1/models，照 audio.cpp 的样子）：常见的配置里 TTS 模型 id 是 tts，家族是 fish_audio */
export const FAKE_SPEECH_MODELS = { object: "list", data: [{ id: "tts", object: "model", owned_by: "engine", family: "fish_audio", task: "tts", mode: "offline" }] };

/** audio.cpp 说忙的样子（显卡在给别的任务用）：HTTP 503，error.type 是 server_busy */
export const FAKE_SPEECH_BUSY = { status: 503, body: '{"error":{"message":"model is busy","type":"server_busy"}}' } as const;

export interface FakeSpeechService {
  url: string;
  /** 收到的合成请求（不含预热的试合成） */
  readonly requests: FakeSpeechRequest[];
  /**
   * 收到的预热的试合成（45 号票：稿子是 WARMUP_TEXT 的请求）。它们单独记、单独回（behaveWarmup），不占 script、behave 定的回法，
   * 别的测试不用管守护进程什么时候预热
   */
  readonly warmups: FakeSpeechRequest[];
  /** 之后的试合成怎么回（默认 ok） */
  behaveWarmup(behavior: FakeSpeechBehavior): void;
  /** hold 住了几个试合成还没回 */
  readonly heldWarmups: number;
  /** 放行 hold 住的试合成（之后的照 ok 回） */
  releaseWarmups(): void;
  /** 关掉（端口留着，连不上）：模拟 audio.cpp 没开 */
  down(): Promise<void>;
  /** 在原来的端口上重新开起来：模拟 audio.cpp 被 LSM 重新拉起 */
  up(): Promise<void>;
  /** 问过几次模型列表 */
  readonly modelQueries: number;
  /** 之后的请求怎么回 */
  behave(behavior: FakeSpeechBehavior): void;
  /** 接下来的几次请求依次这样回（用完了照 behave 定的回）：分段合成时让第几段出错 */
  script(...behaviors: FakeSpeechBehavior[]): void;
  /** hold 住了几个请求还没回 */
  readonly held: number;
  /** 放行最早 hold 住的一个（照 ok 回），之后的照旧 */
  releaseNext(): void;
  /** 模型列表怎么回：默认 FAKE_SPEECH_MODELS；给状态码时回那个错误（测问不到实际模型时记配置里的） */
  models(answer: typeof FAKE_SPEECH_MODELS | { status: number }): void;
  /** 放行 hold 住的请求（之后的照 ok 回） */
  release(): void;
  close(): Promise<void>;
}

/** 起一个假的语音合成服务（POST /v1/audio/speech、GET /v1/models、GET /health），测试结束时关掉；可以关了再开（down、up） */
export async function startFakeSpeechService(): Promise<FakeSpeechService> {
  const requests: FakeSpeechRequest[] = [];
  const warmups: FakeSpeechRequest[] = [];
  let behavior: FakeSpeechBehavior = "ok";
  let warmupBehavior: FakeSpeechBehavior = "ok";
  const heldWarmups: Array<() => void> = [];
  const upcoming: FakeSpeechBehavior[] = [];
  let models: typeof FAKE_SPEECH_MODELS | { status: number } = FAKE_SPEECH_MODELS;
  let modelQueries = 0;
  const held: Array<() => void> = [];
  const hanging = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      modelQueries += 1;
      res.writeHead("status" in models ? models.status : 200, { "content-type": "application/json" });
      res.end("status" in models ? '{"error":{"message":"fake failure"}}' : JSON.stringify(models));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/audio/speech") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const voiceRef = String(body.voice_ref ?? "");
      // 预热的试合成单独记、单独回
      const warmup = body.input === WARMUP_TEXT;
      (warmup ? warmups : requests).push({
        body,
        model: body.model,
        input: String(body.input ?? ""),
        voiceRef,
        referenceText: body.reference_text,
        voiceRefBytes: voiceRef && fs.existsSync(voiceRef) ? fs.readFileSync(voiceRef) : undefined,
      });
      const answer = (how: FakeSpeechBehavior) => {
        if (how === "hang") {
          hanging.add(res);
          return;
        }
        if (how === "hold") {
          (warmup ? heldWarmups : held).push(() => answer("ok"));
          return;
        }
        if (how === "ok" || "wav" in how) {
          const wav = how === "ok" ? makeWav(fakeSpeechSeconds(String(body.input ?? ""))) : how.wav;
          res.writeHead(200, { "content-type": "audio/wav", "content-length": String(wav.length) });
          res.end(wav);
          return;
        }
        res.writeHead(how.status, { "content-type": "application/json" });
        res.end(how.body ?? '{"error":{"message":"fake failure"}}');
      };
      answer(warmup ? warmupBehavior : (upcoming.shift() ?? behavior));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    for (const res of hanging) res.destroy();
    hanging.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const up = () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  onTestFinished(close);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    warmups,
    behaveWarmup(next) {
      warmupBehavior = next;
    },
    get heldWarmups() {
      return heldWarmups.length;
    },
    releaseWarmups() {
      warmupBehavior = "ok";
      for (const go of heldWarmups.splice(0)) go();
    },
    down: close,
    up,
    get modelQueries() {
      return modelQueries;
    },
    behave(next) {
      behavior = next;
    },
    script(...behaviors) {
      upcoming.push(...behaviors);
    },
    get held() {
      return held.length;
    },
    releaseNext() {
      held.shift()?.();
    },
    models(answer) {
      models = answer;
    },
    release() {
      behavior = "ok";
      for (const go of held.splice(0)) go();
    },
    close,
  };
}

/** 设置里的语音页：两个语音模型的状态（45 号票） */
export const voiceModelsApi = {
  get: (url: string) => requestJson<VoiceModelsView>(url, HTTP_PATHS.voiceModels),
};

/** 设置里的语音页：参考音色的 HTTP 接口 */
export const referenceVoicesApi = {
  list: (url: string) => requestJson<ReferenceVoiceList>(url, HTTP_PATHS.referenceVoices),
  /** 导入一个：名字和音频；referenceText 不给由守护进程自动识别（230 号票），给了照用 */
  import: (url: string, voice: { name: string; referenceText?: string; audio: Buffer }) =>
    requestJson<ReferenceVoice & { message?: string }>(url, HTTP_PATHS.referenceVoices, {
      method: "POST",
      body: { name: voice.name, ...(voice.referenceText === undefined ? {} : { referenceText: voice.referenceText }), audioBase64: voice.audio.toString("base64") },
    }),
  select: (url: string, voiceId: string) => requestJson<ReferenceVoiceList & { message?: string }>(url, HTTP_PATHS.referenceVoiceSelect(voiceId), { method: "POST" }),
  remove: (url: string, voiceId: string) => requestJson<ReferenceVoiceList & { message?: string }>(url, HTTP_PATHS.referenceVoice(voiceId), { method: "DELETE" }),
};

/** 示例参考音色的名字和逐字稿（测试里的都是编的，不是谁的真声音） */
export const SAMPLE_VOICE = { name: "示例音色", referenceText: "大家好，这是一段示例参考录音，今天天气真不错。" } as const;

/** 导入一个参考音色（3 秒的 WAV），返回它；不给逐字稿就由守护进程自动识别（假的识别进程回空文字，所以默认给） */
export async function importReferenceVoice(url: string, name: string = SAMPLE_VOICE.name, referenceText: string | undefined = SAMPLE_VOICE.referenceText): Promise<ReferenceVoice> {
  const res = await referenceVoicesApi.import(url, { name, ...(referenceText === undefined ? {} : { referenceText }), audio: makeWav(3) });
  if (res.status !== 201) throw new Error(`导入参考音色失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 前端收到的 agent 语音的各个版本（按到达顺序） */
export function agentVoiceVersions(frontend: TestFrontend, voiceId?: string): AgentVoiceRecord[] {
  return frontend
    .events({ type: EVENT_TYPES.agentVoice })
    .map((f) => (f.payload as AgentVoiceEventPayload).voice)
    .filter((v) => voiceId === undefined || v.id === voiceId);
}

/** 等前端收到第 nth 条（1 起）有了这个状态的 agent 语音 */
export async function agentVoiceSettled(frontend: TestFrontend, status: AgentVoiceRecord["status"], nth = 1, timeoutMs = 20_000): Promise<AgentVoiceRecord> {
  const matches = () => agentVoiceVersions(frontend).filter((v) => v.status === status);
  await waitUntil(() => matches().length >= nth, { timeoutMs, describe: () => `agent 语音：${JSON.stringify(agentVoiceVersions(frontend).map((v) => [v.status, v.error]))}` });
  return matches()[nth - 1]!;
}
