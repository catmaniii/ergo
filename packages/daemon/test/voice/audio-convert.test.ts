// 参考音色导入的转码（230 号票）：真的去拉假 ffmpeg（fixtures/fake-ffmpeg.mjs，不解码、不装依赖），验命令行参数、
// 交回的 WAV、临时目录清掉，和本机没有 ffmpeg / 转码失败时怎么分。真的 ffmpeg 一次都不跑。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AudioConvertError, createFfmpegConverter, ffmpegArgs } from "../../src/voice/audio-convert.ts";
import { readWav } from "../../src/voice/wav.ts";
import { fakeFfmpegCommand, fakeMp3 } from "../helpers/audio.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const quiet = () => {};

describe("把常见音频转成 16 kHz 单声道 PCM16 的 WAV（230 号票）", () => {
  it("ffmpeg 的参数：16 kHz、单声道、PCM16、WAV，输入和输出是给的那两个文件", () => {
    expect(ffmpegArgs("input.bin", "output.wav")).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      "input.bin",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "output.wav",
    ]);
  });

  it("转出来的 WAV 和文件都在临时目录里；用完 cleanup 把临时目录整个删掉", async () => {
    const tmpDir = makeTempDir("ergo-convert-");
    const logFile = path.join(makeTempDir("ergo-ffmpeg-"), "ffmpeg.jsonl");
    const converter = createFfmpegConverter({ tmpDir, command: fakeFfmpegCommand(logFile), log: quiet });
    const converted = await converter.convert(fakeMp3({ seconds: 2.5 }));
    expect(readWav(converted.wav)).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, encoding: "pcm", durationMs: 2500 });
    expect(fs.readFileSync(converted.path)).toEqual(converted.wav);
    expect(path.dirname(converted.path).startsWith(tmpDir)).toBe(true);
    converted.cleanup();
    expect(fs.existsSync(path.dirname(converted.path))).toBe(false);
  });

  it("本机没有 ffmpeg、转码失败：AudioConvertError 说明是哪一种，临时目录也清掉", async () => {
    const tmpDir = makeTempDir("ergo-convert-");
    const logFile = path.join(makeTempDir("ergo-ffmpeg-"), "ffmpeg.jsonl");
    const missing = createFfmpegConverter({ tmpDir, command: ["ergo-no-such-ffmpeg-230"], log: quiet });
    const missingError = await missing.convert(fakeMp3()).catch((err: unknown) => err);
    expect(missingError).toBeInstanceOf(AudioConvertError);
    expect((missingError as AudioConvertError).kind).toBe("missing");
    expect(fs.readdirSync(tmpDir)).toEqual([]);

    const failed = createFfmpegConverter({ tmpDir, command: fakeFfmpegCommand(logFile), log: quiet });
    const failedError = await failed.convert(fakeMp3({ fail: "Invalid data found when processing input" })).catch((err: unknown) => err);
    expect(failedError).toBeInstanceOf(AudioConvertError);
    expect((failedError as AudioConvertError).kind).toBe("failed");
    expect((failedError as Error).message).toContain("Invalid data found");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
