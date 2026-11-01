// 假的 audio.cpp 语音识别：代替真的 audiocpp_server，真 HTTP、端口由系统挑，不碰 8090、不加载真模型。
// 接口和错误照 2026-10-31 拿真服务（dist/cuda，8 月版）试出来的写：
// - GET /health 回 {"status":"ok","backend":…,"models":N}；GET /v1/models 回配置里的 id 和 family，加没加载都一样；
// - POST /v1/audio/transcriptions（multipart）：文件名不是 .wav 回 400，内容不是 WAV 回 500（invalid WAV RIFF header），
//   语言不是 auto、zh、en、ja 回 500，模型 id 不对回 500（unknown model id）；
// - 成了回 {"text":…,"timing":{"wall_ms","audio_duration_ms","rtf"}}，没有分段。静音（没带指令的）识别出"我"，和真的一样会幻听。
// 回什么看录音里的 FAKE-ASR 指令（helpers/voice.ts 的 fakeWavRecording）或者 behave。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 收到的一次识别 */
export interface FakeAsrRequest {
  fields: Record<string, string>;
  filename: string;
  file: Buffer;
  /** 是预热发的静音（没带指令，全是零） */
  silence: boolean;
}

/** 接下来的识别怎么回：照常、挂着不回、回这个错误 */
export type FakeAsrBehavior = "ok" | "hang" | { status: number; message: string; type?: string } | { text: unknown };

export interface FakeAudioCppAsr {
  url: string;
  port: number;
  /** 收到的识别（预热的静音也在里面） */
  readonly requests: FakeAsrRequest[];
  /** 问过几次模型列表 */
  readonly modelQueries: number;
  /** 不是预热的那些 */
  recognitions(): FakeAsrRequest[];
  behave(behavior: FakeAsrBehavior): void;
  /** 接下来几次依次这样回（用完了照 behave 定的回） */
  script(...behaviors: FakeAsrBehavior[]): void;
  /** 模型列表里有哪些；默认 [{ id: "asr", family: "fun_asr_nano" }] */
  models(list: { id: string; family?: string }[]): void;
  /** 关掉（连不上） */
  down(): Promise<void>;
  /** 在原来的端口上重新开起来（模拟被服务管家重新拉起） */
  up(): Promise<void>;
}

/** multipart 拆开：字段和文件 */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; filename: string; file: Buffer } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const mark = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ""}`);
  const fields: Record<string, string> = {};
  let filename = "";
  let file: Buffer = Buffer.alloc(0);
  let at = body.indexOf(mark);
  while (at >= 0) {
    const start = at + mark.length + 2;
    const next = body.indexOf(mark, start);
    if (next < 0) break;
    const part = body.subarray(start, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1] ?? "";
    const fileName = /filename="([^"]*)"/.exec(headers)?.[1];
    if (fileName !== undefined) {
      filename = fileName;
      file = content;
    } else fields[name] = content.toString("utf8");
    at = next;
  }
  return { fields, filename, file };
}

const LANGUAGES = new Set(["auto", "zh", "en", "ja"]);

/** 起一个假服务，测试结束时关掉 */
export async function startFakeAudioCppAsr(options: { backend?: string; down?: boolean } = {}): Promise<FakeAudioCppAsr> {
  const requests: FakeAsrRequest[] = [];
  let behavior: FakeAsrBehavior = "ok";
  const upcoming: FakeAsrBehavior[] = [];
  let models: { id: string; family?: string }[] = [{ id: "asr", family: "fun_asr_nano" }];
  let modelQueries = 0;
  const hanging = new Set<http.ServerResponse>();
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const failed = (res: http.ServerResponse, status: number, message: string, type = "server_error") => json(res, status, { error: { message, type } });
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok", backend: options.backend ?? "cuda", models: models.length });
    if (req.method === "GET" && req.url === "/v1/models") {
      modelQueries += 1;
      return json(res, 200, { object: "list", data: models.map((m) => ({ object: "model", owned_by: "engine", task: "asr", mode: "offline", ...m })) });
    }
    if (req.method !== "POST" || req.url !== "/v1/audio/transcriptions") {
      res.writeHead(404);
      res.end();
      return undefined;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { fields, filename, file } = parseMultipart(Buffer.concat(chunks), String(req.headers["content-type"] ?? ""));
      const text = file.toString("latin1");
      const directive = /FAKE-ASR ([^\n]*)/.exec(text)?.[1];
      requests.push({ fields, filename, file, silence: directive === undefined && file.subarray(44).every((b) => b === 0) });
      if (!filename.toLowerCase().endsWith(".wav")) return failed(res, 400, "only WAV audio uploads are currently supported for transcription; MP3 support is planned", "invalid_request_error");
      const how = upcoming.shift() ?? behavior;
      if (how === "hang") {
        hanging.add(res);
        return undefined;
      }
      if (how !== "ok" && "status" in how) return failed(res, how.status, how.message, how.type);
      if (fields.model !== "asr") return failed(res, 500, `unknown model id: ${fields.model ?? ""}`);
      if (file.toString("latin1", 0, 4) !== "RIFF" || file.toString("latin1", 8, 12) !== "WAVE") return failed(res, 500, "invalid WAV RIFF header");
      if (fields.language !== undefined && !LANGUAGES.has(fields.language)) return failed(res, 500, `unsupported Fun-ASR-Nano prompt language: ${fields.language}`);
      const said = how !== "ok" ? how.text : directive === undefined ? "我" : (JSON.parse(Buffer.from(directive, "latin1").toString("utf8")) as { text?: string }).text;
      const durationMs = Math.round(((file.length - 44) / 32_000) * 1000);
      return json(res, 200, { text: said, timing: { wall_ms: 12.5, audio_duration_ms: durationMs, rtf: 0.04 } });
    });
    return undefined;
  });
  let port = 0;
  let listening = false;
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        port = (server.address() as AddressInfo).port;
        listening = true;
        resolve();
      });
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (!listening) return resolve();
      listening = false;
      for (const res of hanging) res.destroy();
      hanging.clear();
      server.close(() => resolve());
      server.closeAllConnections();
      return undefined;
    });
  await listen();
  const url = `http://127.0.0.1:${port}`;
  if (options.down) await stop();
  onTestFinished(stop);
  return {
    url,
    port,
    requests,
    get modelQueries() {
      return modelQueries;
    },
    recognitions: () => requests.filter((r) => !r.silence),
    behave(next) {
      behavior = next;
    },
    script(...next) {
      upcoming.push(...next);
    },
    models(list) {
      models = list;
    },
    down: stop,
    up: listen,
  };
}
