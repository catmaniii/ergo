// 假的语音识别服务（250 号票）：测试里代替 LSM 托管的 recognizer.py --serve（不加载模型、不占显卡）。
// node fake-asr-service.mjs <记录文件>
// 接口和 recognizer.py 的 --serve 一样，只听 127.0.0.1，端口由系统挑：挑到的那一个写进记录文件的一行
// {"event":"start","port":N,"pid":…}，测试（helpers/asr.ts 的 startFakeAsrService）读它连上来。
//   GET  /health        → 模型状态
//   GET  /v1/models     → 同一份
//   POST /v1/warmup     → 开始加载（按指令等一会儿才好），马上回状态
//   POST /v1/transcribe → 回固定的识别结果
// 怎么回由记录文件旁边的 <记录文件>.asr.json 定（每次请求现读，没有就是照常；helpers/asr.ts 的 setFakeAsr 写它）：
//   text        识别出的文字（默认"（假的识别结果）"），按句末标点切成分段
//   language    识别出的语言，默认 zh；seconds 音频时长（秒），默认 3
//   model / device / computeType  报的模型，默认按 warmup 给的设置（没给就是 large-v3 / cuda / int8_float16）
//   fallbackReason  给了就记成退回了 CPU，这是原因
//   loadMs      预热之后过这么多毫秒才算加载好（默认 0：马上好）
//   loadFail    预热失败：状态里带 error，识别回 503 + fatal（撤掉这条指令以后重新预热还能好）
//   notLoaded   预热也不加载好（状态一直 loaded: false，没有 error）
//   hangHealth  /health 不回（服务还活着、卡住了）
//   transcribeError   识别回 500 + {"error":"识别出错：…"}（不是致命的）
//   transcribeFatal   识别回 503 + {"error":"模型加载失败：…","fatal":true}
//   transcribeStatus  识别回这个状态码（正文 {"error":"服务出错"}）
//   hangTranscribe    识别不回
//   wedged      从这一刻起什么请求都不回（进程还活着、卡死了）
// 每次请求往记录文件追加一行：health、models、warmup（带设置）、transcribe（带语言、提示、音频多少字节）。
import fs from "node:fs";
import http from "node:http";

const logFile = process.argv[2];
if (!logFile) {
  process.stderr.write("用法：node fake-asr-service.mjs <记录文件>\n");
  process.exit(2);
}
const directiveFile = `${logFile}.asr.json`;
const record = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const directive = () => {
  try {
    return fs.existsSync(directiveFile) ? JSON.parse(fs.readFileSync(directiveFile, "utf8")) : {};
  } catch {
    return {};
  }
};

/** 预热时收到的设置（和 stdio 那行 init 一样） */
let init;
/** 到这一刻算加载好（没预热过是 undefined） */
let loadedAt;
let loading = false;
/** 加载失败的原因（撤掉 loadFail 指令以后重新预热会清掉） */
let error;
let loadMs = 0;

const nowLoaded = () => loadedAt !== undefined && Date.now() >= loadedAt;

function statusOf(d) {
  const loaded = nowLoaded();
  const primary = init?.primary ?? {};
  const status = {
    ok: loaded && error === undefined,
    loaded,
    model: d.model ?? primary.model ?? "large-v3",
    device: d.device ?? primary.device ?? "cuda",
    computeType: d.computeType ?? primary.computeType ?? "int8_float16",
  };
  if (loaded) status.loadMs = loadMs;
  if (loaded && d.fallbackReason) status.fallbackReason = d.fallbackReason;
  if (error !== undefined) status.error = error;
  return status;
}

function warmup(d) {
  record({ event: "warmup", init });
  if (nowLoaded()) return;
  if (d.loadFail) {
    error = `模型加载失败：${d.loadFail}`;
    return;
  }
  // 指令撤掉了：上一次的失败不算了，重新加载
  error = undefined;
  if (d.notLoaded) return;
  if (loading) return;
  loading = true;
  loadMs = d.loadMs ?? 0;
  loadedAt = Date.now() + loadMs;
}

function reply(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) });
  res.end(body);
}

function resultOf(d) {
  const primary = init?.primary ?? {};
  const text = d.text ?? "（假的识别结果）";
  const seconds = d.seconds ?? 3;
  const pieces = text.split(/(?<=[，。？！,.?!])/).filter((p) => p.trim());
  const step = pieces.length > 0 ? seconds / pieces.length : 0;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    text,
    language: d.language ?? "zh",
    segments: pieces.map((p, i) => ({ start: round(i * step), end: round((i + 1) * step), text: p })),
    duration: seconds,
    model: d.model ?? primary.model ?? "large-v3",
    device: d.device ?? primary.device ?? "cuda",
    computeType: d.computeType ?? primary.computeType ?? "int8_float16",
    ...(d.fallbackReason ? { fallbackReason: d.fallbackReason } : {}),
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const d = directive();
    // 卡死了：什么都不回（连接还开着，对面只能等超时）
    if (d.wedged) return;
    const path = req.url;
    const raw = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    let body;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        reply(res, 400, { error: "正文不是 JSON" });
        return;
      }
    }
    if (req.method === "GET" && path === "/health") {
      record({ event: "health" });
      if (d.hangHealth) return;
      reply(res, 200, statusOf(d));
      return;
    }
    if (req.method === "GET" && path === "/v1/models") {
      record({ event: "models" });
      reply(res, 200, statusOf(d));
      return;
    }
    if (req.method === "POST" && path === "/v1/warmup") {
      if (body && typeof body === "object") init = body;
      warmup(d);
      reply(res, 200, statusOf(d));
      return;
    }
    if (req.method === "POST" && path === "/v1/transcribe") {
      const request = body ?? {};
      record({
        event: "transcribe",
        language: request.language,
        initialPrompt: request.initialPrompt,
        bytes: typeof request.audio === "string" ? Buffer.from(request.audio, "base64").length : 0,
      });
      if (d.hangTranscribe) return;
      if (d.transcribeStatus) {
        reply(res, d.transcribeStatus, { error: "服务出错" });
        return;
      }
      if (d.transcribeError) {
        reply(res, 500, { error: `识别出错：${d.transcribeError}` });
        return;
      }
      if (d.transcribeFatal) {
        reply(res, 503, { error: `模型加载失败：${d.transcribeFatal}`, fatal: true });
        return;
      }
      if (error !== undefined) {
        reply(res, 503, { error, fatal: true });
        return;
      }
      reply(res, 200, resultOf(d));
      return;
    }
    reply(res, 404, { error: `不认得这个地址：${path}` });
  });
});

server.listen(0, "127.0.0.1", () => {
  record({ event: "start", pid: process.pid, port: server.address().port });
});
