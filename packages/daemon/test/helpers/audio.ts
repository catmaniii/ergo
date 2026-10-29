// 参考音色导入（230 号票）的测试底座：假的 ffmpeg（fixtures/fake-ffmpeg.mjs，不解码、不真转码、不跑本机的 ffmpeg）、
// 造一段假的 mp3（"多格式"用例的内容，假 ffmpeg 只看后面那行指令）、读假 ffmpeg 的记录。
// 交回的 WAV 是 16 kHz、单声道、16 位 PCM；时长按指令（不给按输入 WAV 的头算，mp3 这类默认 3 秒）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FakeAsr } from "./voice.ts";

/** 假的 ffmpeg */
export const FAKE_FFMPEG = fileURLToPath(new URL("../fixtures/fake-ffmpeg.mjs", import.meta.url));

/** 拉起假 ffmpeg 的命令（每转一次往 logFile 追加一行 JSON） */
export function fakeFfmpegCommand(logFile: string): string[] {
  return [process.execPath, FAKE_FFMPEG, logFile];
}

/** 假 ffmpeg 这次怎么转（见 fake-ffmpeg.mjs 开头） */
export interface FakeAudio {
  /** 转出来多长（秒）；不给按输入 WAV 的头算，不是 WAV 时 3 秒 */
  seconds?: number;
  /** 给了就转码失败，stderr 写这句（模拟认不出的格式、坏文件） */
  fail?: string;
  /** 自动识别逐字稿时给假识别进程的指令（text、error……见 FakeAsr） */
  asr?: FakeAsr;
}

/** 一段假的 mp3：ID3v2 头加指令行，不是真能解码的音频；salt 让两段的内容（sha256）不同 */
export function fakeMp3(audio: FakeAudio = {}, salt = Math.random().toString(36).slice(2)): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, Buffer.from(`\nFAKE-FFMPEG ${JSON.stringify(audio)}\nFAKE-SALT ${salt}\n`, "utf8")]);
}

/** 假 ffmpeg 的一次记录 */
export interface FfmpegLogEntry {
  event: "convert" | "fail";
  /** 转出来的时长（秒） */
  seconds?: number;
  /** 交回的 WAV 有多少字节 */
  bytes?: number;
  /** 转码失败的原因 */
  reason?: string;
}

/** 假 ffmpeg 的记录（按先后） */
export function ffmpegLog(logFile: string): FfmpegLogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FfmpegLogEntry);
}
