// 假的 ffmpeg（230 号票：测试里代替本机的 ffmpeg，不解码、不真转码、不装依赖）。
// 用法：node fake-ffmpeg.mjs <记录文件> -hide_banner … -i 输入 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav 输出.wav
// 输入是测试造的假音频（helpers/audio.ts 的 fakeMp3，或者 makeWav 的真 WAV 头）：后面可以跟一行 "FAKE-FFMPEG <JSON>"：
//   seconds      转出来的 WAV 有多长（秒）；不给时按输入 WAV 的头算，输入不是 WAV 时 3 秒
//   sampleRate   转出来的采样率，默认 16000
//   channels     转出来的声道数，默认 1
//   fail         转码失败：stderr 写这个原因、退出码 1（模拟认不出的格式、坏文件）
//   asr          自动识别逐字稿时给假识别进程的指令（helpers/voice.ts 的 FakeAsr），原样写成输出后面的一行
//                "FAKE-ASR <JSON>"，假识别进程从它读出这次识别回什么
// 交回的是 16 kHz、单声道、16 位 PCM 的 WAV（不加 -ac/-ar 的格式见 sampleRate、channels）；每件事往记录文件追加一行 JSON：
// convert（时长、字节数）或 fail（原因）。
import fs from "node:fs";
import path from "node:path";

const maybeLog = process.argv[2];
const hasLog = maybeLog !== undefined && maybeLog !== "" && !maybeLog.startsWith("-");
const logFile = hasLog ? maybeLog : undefined;
const args = process.argv.slice(hasLog ? 3 : 2);
const inputAt = args.indexOf("-i");
const input = inputAt >= 0 ? args[inputAt + 1] : undefined;
const output = args[args.length - 1];

const record = (entry) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

/** 输入里的指令（"FAKE-FFMPEG <JSON>" 那一行） */
function directiveOf(bytes, marker) {
  const text = bytes.toString("latin1");
  const at = text.indexOf(`${marker} `);
  if (at < 0) return {};
  const line = text.slice(at + marker.length + 1).split("\n")[0];
  try {
    return JSON.parse(Buffer.from(line, "latin1").toString("utf8"));
  } catch {
    return {};
  }
}

/** 输入是 WAV 时按头量出的时长（秒）；不是时 undefined */
function wavSeconds(bytes) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let format;
  let dataLength;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) {
      format = { channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4), blockAlign: bytes.readUInt16LE(body + 12) };
    }
    if (id === "data") {
      dataLength = size === 0 || body + size > bytes.length ? bytes.length - body : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataLength === undefined || format.sampleRate < 1 || format.blockAlign < 1) return undefined;
  return dataLength / format.blockAlign / format.sampleRate;
}

/** 一段 16 位 PCM 的 WAV（正弦波，信噪比没有意义，只要头是对的） */
function makeWav(seconds, sampleRate, channels) {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const block = channels * 2;
  const data = Buffer.alloc(frames * block);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(value, i * block + c * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * block, 28);
  header.writeUInt16LE(block, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function done() {
  process.exit(0);
}

if (!input || !output) {
  process.stderr.write("fake-ffmpeg: 缺少 -i 输入或者输出文件\n");
  process.exit(2);
}
let bytes;
try {
  bytes = fs.readFileSync(input);
} catch (err) {
  process.stderr.write(`fake-ffmpeg: 读不到输入文件（${err.message}）\n`);
  process.exit(1);
}
const directive = directiveOf(bytes, "FAKE-FFMPEG");
if (directive.fail) {
  record({ event: "fail", reason: directive.fail });
  process.stderr.write(`${directive.fail}\n`);
  process.exit(1);
}
const seconds = typeof directive.seconds === "number" ? directive.seconds : wavSeconds(bytes);
if (seconds === undefined) {
  const reason = "Invalid data found when processing input";
  record({ event: "fail", reason });
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}
const sampleRate = typeof directive.sampleRate === "number" ? directive.sampleRate : 16000;
const channels = typeof directive.channels === "number" ? directive.channels : 1;
const wav = makeWav(seconds, sampleRate, channels);
// 自动识别逐字稿时把指令放进输出：假识别进程读它知道回什么（没有这一行就是空文字）
const asr = directive.asr === undefined ? undefined : Buffer.from(`\nFAKE-ASR ${JSON.stringify(directive.asr)}\n`, "utf8");
const out = asr === undefined ? wav : Buffer.concat([wav, asr]);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, out);
record({ event: "convert", seconds, bytes: out.length });
done();
