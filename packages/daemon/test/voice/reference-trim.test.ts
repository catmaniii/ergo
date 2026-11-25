// 参考录音太长不再报错，自动截一段当参考（472）："参考录音如果太长，现在会报错，最长30秒，其实没必要。"
// - 截法（reference-trim.ts）：去掉开头的静音，从说话开始往后取，目标 15 秒，在 10–20 秒之间找一处停顿（静音 ≥ 0.3 秒）断开、
//   挑离 15 秒最近的；找不到停顿就在 15 秒处硬截；截出来的就是原来的采样；
// - 导入（reference-voices.ts）：只存截出来的那段，逐字稿识别的也是截出来的那段，voice.json 和交回的音色带上原来多长。
// 测试音频全是代码合成的（正弦波当"说话"，加一点白噪声当底噪，静音段只有底噪），转换器、识别进程都是进程内的假的：
// 不跑 ffmpeg、不连识别模型、只写临时目录。
import fs from "node:fs";
import path from "node:path";
import { REFERENCE_VOICE_MAX_MS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { AudioConverter } from "../../src/voice/audio-convert.ts";
import type { RecognizeRequest, RecognizeResult, Recognizer } from "../../src/voice/recognizer.ts";
import { trimReference } from "../../src/voice/reference-trim.ts";
import { openReferenceVoices } from "../../src/voice/reference-voices.ts";
import { readWav, type WavInfo } from "../../src/voice/wav.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const RATE = 16_000;

/** 一段录音由几块拼成：talk 是在说话（正弦波，响度按每秒 4 次起伏，像一个个字），quiet 是没说话（只有底噪） */
type Piece = ["talk" | "quiet", number];

/** 白噪声用的伪随机数（固定种子，每次合成的一样） */
function noise(seed = 7): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648 - 0.5;
  };
}

/**
 * 合成一段 16 kHz 单声道 PCM16 的 WAV。noiseDb 是底噪的响度（dBFS，不给就是数字静音），talkAmp 是说话的幅度。
 * 交回每一块从第几秒起（按采样数算的，和截出来的边界对得上）
 */
function speech(pieces: readonly Piece[], options: { noiseDb?: number; talkAmp?: number; clickAt?: number } = {}): { wav: Buffer; info: WavInfo; starts: number[] } {
  const amp = options.talkAmp ?? 0.3;
  // 均匀分布的噪声 RMS 是幅度的 1/√3
  const noiseAmp = options.noiseDb === undefined ? 0 : Math.sqrt(3) * 10 ** (options.noiseDb / 20) * 2;
  const rand = noise();
  const counts = pieces.map(([, seconds]) => Math.round(seconds * RATE));
  const total = counts.reduce((a, b) => a + b, 0);
  const data = Buffer.alloc(total * 2);
  const starts: number[] = [];
  let at = 0;
  for (const [i, [kind]] of pieces.entries()) {
    starts.push(at / RATE);
    for (let n = 0; n < counts[i]!; n++, at++) {
      const t = at / RATE;
      const talk = kind === "talk" ? amp * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 220 * t) : 0;
      const click = options.clickAt !== undefined && at >= options.clickAt * RATE && at < options.clickAt * RATE + 80 ? 0.8 : 0;
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((talk + click + noiseAmp * rand()) * 32767))), at * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  const wav = Buffer.concat([header, data]);
  return { wav, info: readWav(wav)!, starts };
}

/** 一段话：说 seconds 秒，每说 0.7 秒顿 0.15 秒（字和字之间的小停顿，不到 0.3 秒，不该在这儿断） */
function talking(seconds: number): Piece[] {
  const pieces: Piece[] = [];
  let left = Math.round(seconds * 100);
  while (left > 0) {
    const talk = Math.min(70, left);
    pieces.push(["talk", talk / 100]);
    left -= talk;
    if (left > 15) {
      pieces.push(["quiet", 0.15]);
      left -= 15;
    }
  }
  return pieces;
}

/** 截出来的 WAV 的采样和原录音里那一段逐字节一样 */
function sameSamples(trimmed: Buffer, source: { wav: Buffer; info: WavInfo }, startMs: number, durationMs: number): boolean {
  const info = readWav(trimmed)!;
  const from = source.info.dataOffset + Math.round((startMs / 1000) * RATE) * 2;
  return info.dataLength === Math.round((durationMs / 1000) * RATE) * 2 && trimmed.subarray(info.dataOffset).equals(source.wav.subarray(from, from + info.dataLength));
}

describe("长录音截一段当参考", () => {
  it("两分钟的录音：去掉开头 1.2 秒的静音（留 0.1 秒），在 10–20 秒之间挑离 15 秒最近的停顿，断在停顿开头往后 0.2 秒", () => {
    // 说话从 1.2 秒开始；停顿（0.5 秒以上）放在说话开始后约 6.3、12.2、16.6、19.9 秒，还有一处 0.25 秒的（不到 0.3 秒，不算停顿）正好在 15 秒上下
    const pieces: Piece[] = [
      ["quiet", 1.2],
      ...talking(6.3),
      ["quiet", 0.6], // 停顿 A：说话开始后 6.3 秒，不在 10–20 秒里
      ...talking(5.3),
      ["quiet", 0.5], // 停顿 B：约 12.2 秒
      ...talking(2.6),
      ["quiet", 0.25], // 不到 0.3 秒：约 15.3 秒，离 15 秒最近也不算
      ...talking(1.1),
      ["quiet", 0.8], // 停顿 C：约 16.65 秒，挑它
      ...talking(2.5),
      ["quiet", 0.6], // 停顿 D：约 19.95 秒
      ...talking(120 - 1.2 - 6.3 - 0.6 - 5.3 - 0.5 - 2.6 - 0.25 - 1.1 - 0.8 - 2.5 - 0.6),
    ];
    const source = speech(pieces, { noiseDb: -55 });
    expect(source.info.durationMs).toBe(120_000);
    const pauseC = source.starts[pieces.findIndex((p, i) => i > 0 && p[0] === "quiet" && p[1] === 0.8)]!;

    const trim = trimReference(source.wav, source.info);
    expect(trim.cut).toBe("pause");
    expect(trim.startMs).toBe(1100);
    expect(trim.durationMs).toBe(Math.round((pauseC + 0.2) * 1000) - 1100);
    expect(trim.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(trim.durationMs).toBeLessThanOrEqual(20_000);
    // 截出来的就是原来的那一段采样，16 kHz 单声道 PCM16
    expect(readWav(trim.wav)).toMatchObject({ sampleRate: RATE, channels: 1, bitsPerSample: 16, encoding: "pcm", durationMs: trim.durationMs });
    expect(sameSamples(trim.wav, source, trim.startMs, trim.durationMs)).toBe(true);
  });

  it("五分钟的录音，10–20 秒之间没有停顿（只有字和字之间的小停顿）：在说话开始后 15 秒处硬截；10 秒前、20 秒后的停顿不用", () => {
    const pieces: Piece[] = [["quiet", 0.5], ...talking(6), ["quiet", 1], ...talking(16), ["quiet", 1], ...talking(300 - 0.5 - 6 - 1 - 16 - 1)];
    const source = speech(pieces, { noiseDb: -50 });
    const trim = trimReference(source.wav, source.info);
    expect(trim).toMatchObject({ cut: "hard", startMs: 400, durationMs: 15_000 });
    expect(sameSamples(trim.wav, source, 400, 15_000)).toBe(true);
  });

  it("没有底噪的干净录音（静音是数字零）也认得出开头的静音和停顿", () => {
    const pieces: Piece[] = [["quiet", 2], ...talking(13.5), ["quiet", 0.4], ...talking(40)];
    const source = speech(pieces);
    const pause = source.starts[pieces.findIndex((p) => p[0] === "quiet" && p[1] === 0.4)]!;
    const trim = trimReference(source.wav, source.info);
    // 0.4 秒的停顿：断在中间（停顿开头往后 0.2 秒）
    expect(trim).toMatchObject({ cut: "pause", startMs: 1900, durationMs: Math.round((pause + 0.2) * 1000) - 1900 });
  });

  it("开头静音里的一下咔哒（10 毫秒以内）不算开始说话", () => {
    const pieces: Piece[] = [["quiet", 3], ...talking(50)];
    const source = speech(pieces, { noiseDb: -55, clickAt: 1 });
    expect(trimReference(source.wav, source.info)).toMatchObject({ startMs: 2900, cut: "hard", durationMs: 15_000 });
  });

  it("开头的静音很长、说话开始以后剩下的不到 20 秒：整段留到结尾，不硬截", () => {
    const pieces: Piece[] = [["quiet", 14], ...talking(18)];
    const source = speech(pieces, { noiseDb: -50 });
    expect(source.info.durationMs).toBeGreaterThan(REFERENCE_VOICE_MAX_MS);
    const trim = trimReference(source.wav, source.info);
    expect(trim).toMatchObject({ cut: "end", startMs: 13_900, durationMs: 18_100 });
    expect(sameSamples(trim.wav, source, 13_900, 18_100)).toBe(true);
  });

  it("底噪大到和说话分不开：认不出停顿，也认不出开头的静音，从头硬截 15 秒", () => {
    const pieces: Piece[] = [["quiet", 1], ...talking(5), ["quiet", 1], ...talking(40)];
    const source = speech(pieces, { noiseDb: -20, talkAmp: 0.3 });
    expect(trimReference(source.wav, source.info)).toMatchObject({ cut: "hard", startMs: 0, durationMs: 15_000 });
  });
});

/** 进程内的假转换器：交回事先合成好的那段 WAV（写进临时目录，cleanup 删掉），记下转了几次、临时目录在哪 */
function fakeConverter(output: Buffer) {
  const dirs: string[] = [];
  const converter: AudioConverter = {
    convert: () => {
      const dir = makeTempDir("ergo-trim-convert-");
      dirs.push(dir);
      const file = path.join(dir, "output.wav");
      fs.writeFileSync(file, output);
      return Promise.resolve({ wav: output, path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
    },
  };
  return { converter, dirs };
}

/** 进程内的假识别：识别时把拿到的文件读下来（之后临时文件就删了），回一句编好的逐字稿 */
function fakeRecognizer(text: string) {
  const calls: Array<{ bytes: Buffer; audioMs: number | undefined }> = [];
  const recognizer = {
    transcribe: (request: RecognizeRequest, audioMs?: number): Promise<RecognizeResult> => {
      calls.push({ bytes: fs.readFileSync(request.path), audioMs });
      return Promise.resolve({ text, language: "zh", segments: [], model: "fake", device: "cpu", computeType: "int8" });
    },
  } as unknown as Recognizer;
  return { recognizer, calls };
}

describe("导入长录音", () => {
  it("2 分 10 秒的录音导入成功：只存截出来的那段，逐字稿识别的是这一段，voice.json 和交回的音色记下原来多长", async () => {
    const pieces: Piece[] = [["quiet", 0.8], ...talking(14.3), ["quiet", 0.6], ...talking(130 - 0.8 - 14.3 - 0.6)];
    const source = speech(pieces, { noiseDb: -55 });
    const { converter, dirs } = fakeConverter(source.wav);
    const { recognizer, calls } = fakeRecognizer("这是截出来那一段的逐字稿。");
    const dir = path.join(makeTempDir("ergo-trim-voices-"), "voices");
    const log: string[] = [];
    const voices = openReferenceVoices({ dir, log: (line) => log.push(line), converter, recognizer });

    const { voice, created } = await voices.import({ name: "示例音色", audio: Buffer.from("一段编的长录音") });
    expect(created).toBe(true);
    // 说话从 0.8 秒开始（从 0.7 秒起截，留 0.1 秒），停顿在说话开始后 14.3 秒，断在往后 0.2 秒：截了 14.6 秒（下面"从 2 分 10 秒的录音里截了开头 14.6 秒"）
    expect(voice).toMatchObject({ name: "示例音色", referenceText: "这是截出来那一段的逐字稿。", durationMs: 14_600, trimmedFromMs: 130_000 });

    // 识别进程拿到的就是截出来的这段（时长也按这段算超时）
    expect(calls).toHaveLength(1);
    expect(readWav(calls[0]!.bytes)!.durationMs).toBe(14_600);
    expect(calls[0]!.audioMs).toBe(14_600);
    // 存下的就是这一段，原来的长录音没留下：音色目录里只有这三个文件，转换用的临时目录也删了
    const stored = fs.readFileSync(path.join(dir, voice.id, "reference.wav"));
    expect(stored).toEqual(calls[0]!.bytes);
    expect(sameSamples(stored, source, 700, 14_600)).toBe(true);
    expect(fs.readdirSync(path.join(dir, voice.id)).toSorted()).toEqual(["reference.txt", "reference.wav", "voice.json"]);
    expect(dirs.every((d) => !fs.existsSync(d))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, voice.id, "voice.json"), "utf8"))).toMatchObject({ durationMs: 14_600, trimmedFromMs: 130_000 });
    expect(fs.readFileSync(path.join(dir, voice.id, "reference.txt"), "utf8")).toBe("这是截出来那一段的逐字稿。");
    // 列出来也带着
    expect(voices.list().voices).toEqual([voice]);
    // 日志写怎么截的，不写逐字稿
    expect(log.join("\n")).toContain("断在停顿处");
    expect(log.join("\n")).not.toContain("这是截出来那一段的逐字稿");

    // 同样的录音和名字再导一次：拿到同一个，不再转码、不再识别
    expect(await voices.import({ name: "示例音色", audio: Buffer.from("一段编的长录音") })).toEqual({ voice, created: false });
    expect(dirs).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("截过的录音给了逐字稿也重新识别截出来的那段（给的对的是整段）；30 秒以内的照旧整段存、给的逐字稿照用，不带 trimmedFromMs", async () => {
    const long = speech([["quiet", 0.3], ...talking(60)], { noiseDb: -50 });
    const dir = path.join(makeTempDir("ergo-trim-voices-"), "voices");
    const longConverter = fakeConverter(long.wav);
    const { recognizer, calls } = fakeRecognizer("截出来那段识别出的。");
    const voices = openReferenceVoices({ dir, log: () => {}, converter: longConverter.converter, recognizer });
    const trimmed = await voices.import({ name: "长的", referenceText: "这是整段一分钟录音的逐字稿。", audio: Buffer.from("长") });
    expect(trimmed.voice).toMatchObject({ referenceText: "截出来那段识别出的。", durationMs: 15_000, trimmedFromMs: 60_300 });
    expect(calls).toHaveLength(1);

    const short = speech([["quiet", 0.3], ...talking(29)], { noiseDb: -50 });
    const shortVoices = openReferenceVoices({ dir, log: () => {}, converter: fakeConverter(short.wav).converter, recognizer });
    const whole = await shortVoices.import({ name: "短的", referenceText: "自己写的逐字稿。", audio: Buffer.from("短") });
    expect(whole.voice).toMatchObject({ referenceText: "自己写的逐字稿。", durationMs: short.info.durationMs });
    expect(whole.voice.trimmedFromMs).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, whole.voice.id, "reference.wav"))).toEqual(short.wav);
    expect(JSON.parse(fs.readFileSync(path.join(dir, whole.voice.id, "voice.json"), "utf8"))).not.toHaveProperty("trimmedFromMs");
    expect(calls).toHaveLength(1);
  });

  it("截出来不到 1 秒（长录音里几乎全是静音）：照「太短」拒，什么都不留", async () => {
    const source = speech([["quiet", 30.5], ["talk", 0.5]], { noiseDb: -55 });
    const dir = path.join(makeTempDir("ergo-trim-voices-"), "voices");
    const { converter, dirs } = fakeConverter(source.wav);
    const { recognizer, calls } = fakeRecognizer("不该识别。");
    const voices = openReferenceVoices({ dir, log: () => {}, converter, recognizer });
    await expect(voices.import({ name: "太短", audio: Buffer.from("静音") })).rejects.toThrow(/1 秒/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(dirs.every((d) => !fs.existsSync(d))).toBe(true);
  });
});
