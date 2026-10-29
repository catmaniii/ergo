// 参考音色导入的多格式转码（230 号票）：用户定"导入音频要支持更多类型：wav、mp3、m4a、opus 等等，大不了用本地 ffmpeg 转"。
// - 用本机的 ffmpeg 把任意常见的音频（wav、mp3、m4a、aac、opus、ogg、flac、webm……）统一转成 16 kHz、单声道、PCM16 的 WAV
//   （Fish 克隆只收 WAV）；1–30 秒的限制由调用方按转换后的真实时长判（时长只有转出来才准）；
// - ffmpeg 的命令可注入（测试换成假的，不真跑 ffmpeg、不装依赖；正式运行就是 PATH 上的 ffmpeg）；程序本身不能替换、不下载；
// - 输入写在数据目录临时区里的一个唯一目录里，输出也在那儿；转换成功时把交回的对象连同临时目录的位置一起给出（自动识别逐字稿要
//   把转出来的文件交给识别进程），调用方用 conversion.cleanup() 删掉。失败、超时、ffmpeg 不在时这里已经删干净了；
// - 两种失败分开：本机没有 ffmpeg（missing：用户要装上，HTTP 回 503），这段音频转不了（failed：认不出的格式 / 坏文件，回 400）；
// - 日志只写"转码失败"和 ffmpeg 的一小段 stderr（文件名、报错），不写音频内容。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";

/** 转好的一段音频：16 kHz、单声道、PCM16 的 WAV */
export interface ConvertedAudio {
  /** 转出来的 WAV 的内容（存成 reference.wav 的就是它） */
  wav: Buffer;
  /** 转出来的文件在磁盘上的位置（自动识别逐字稿时交给识别进程）；用完调 cleanup 删掉 */
  path: string;
  /** 删掉转换用的临时目录 */
  cleanup(): void;
}

/** 转码失败的两类：本机没有 ffmpeg（缺环境），还是这段音频转不了（文件不对） */
export type AudioConvertFailure = "missing" | "failed";

/** 转不了的一段音频；kind 说该回 503（missing）还是 400（failed），message 是给人看的原因 */
export class AudioConvertError extends Error {
  readonly kind: AudioConvertFailure;

  constructor(kind: AudioConvertFailure, message: string) {
    super(message);
    this.name = "AudioConvertError";
    this.kind = kind;
  }
}

/** 把一段常见音频转成 16 kHz、单声道、PCM16 的 WAV；测试换成假的（不真跑 ffmpeg） */
export interface AudioConverter {
  convert(audio: Buffer): Promise<ConvertedAudio>;
}

/** 一次转换最多等多久（毫秒）：导入的是 30 秒以内的录音，转码本身很快，这么久还不出来就是卡住了 */
export const AUDIO_CONVERT_TIMEOUT_MS = 60_000;
/** 日志和原因里留 ffmpeg stderr 的最后多少字符 */
const STDERR_TAIL = 500;

/** ffmpeg 的参数：不读标准输入、安静输出、覆盖已有的输出；音频转成 16 kHz 单声道 PCM16 的 WAV（没有视频） */
export function ffmpegArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", output];
}

/** 用 ffmpeg 转码；command 是程序和它前面的固定参数（默认 ["ffmpeg"]，测试换成假的） */
export function createFfmpegConverter(options: { tmpDir: string; command?: readonly string[]; log: (line: string) => void; timeoutMs?: number }): AudioConverter {
  const { tmpDir, log } = options;
  const command = options.command !== undefined && options.command.length > 0 ? [...options.command] : ["ffmpeg"];
  const [program, ...prefix] = command as [string, ...string[]];
  const timeoutMs = options.timeoutMs ?? AUDIO_CONVERT_TIMEOUT_MS;

  /** 拉起 ffmpeg 转一次：退出码 0 才算转好；起不来是 missing，非 0 和超时是 failed */
  const run = (args: readonly string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(program, [...prefix, ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        finish(new AudioConvertError("failed", t("voice.reference.convertTimeout", { seconds })));
      }, timeoutMs);
      timer.unref();
      function finish(err?: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      child.on("error", (err) => {
        log(`参考音色：ffmpeg 跑不起来（${err.message}）`);
        finish(new AudioConvertError("missing", t("voice.reference.noFfmpeg")));
      });
      child.on("close", (code) => {
        if (code === 0) return finish();
        const detail = stderr
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "")
          .slice(-2)
          .join(" / ");
        log(`参考音色：ffmpeg 转码失败（退出码 ${code ?? "?"}${detail === "" ? "" : `：${detail}`}）`);
        finish(new AudioConvertError("failed", t("voice.reference.convertFailed", { reason: detail === "" ? String(code) : detail })));
      });
    });

  return {
    async convert(audio) {
      const dir = path.join(tmpDir, `ref-voice-${randomUUID()}`);
      const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const input = path.join(dir, "input.bin");
        const output = path.join(dir, "output.wav");
        fs.writeFileSync(input, audio);
        await run(ffmpegArgs(input, output));
        return { wav: fs.readFileSync(output), path: output, cleanup };
      } catch (err) {
        cleanup();
        throw err instanceof AudioConvertError ? err : new AudioConvertError("failed", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
