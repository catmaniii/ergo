// 参考录音太长时自动截一段当参考（472）："参考录音如果太长，现在会报错，最长 30 秒，其实没必要。"
// 导入的录音转成 16 kHz 单声道 PCM16 的 WAV 以后，长于 REFERENCE_VOICE_MAX_MS（克隆模型收的上限）的不拒，按电平截一段：
// - 按 10 毫秒一帧算响度（RMS，dBFS）。静音的门槛按这段录音自己定（silenceThresholdDb）：底噪往上 10 dB，
//   但至少比人声低 20 dB；几乎没有底噪的干净录音取人声往下 40 dB。底噪大到和人声分不开的找不到停顿，就硬截；
// - 去掉开头的静音：连着 30 毫秒有声音才算开始说话（一下咔哒不算），往前留 100 毫秒，不把第一个字的起音切掉；
// - 从说话开始往后取，目标 REFERENCE_VOICE_TRIM_TARGET_MS（15 秒）：在 10–20 秒之间找停顿（连着 ≥ 300 毫秒的静音）断开，
//   断在停顿开头往后 200 毫秒（停顿不到 400 毫秒的断在中间），挑离 15 秒最近的；一处都没有就在 15 秒处硬截；
//   说话开始以后剩下的本来就不到 20 秒，整段留到结尾（自然结束，不硬截）；
// - 截出来的就是原来的采样（逐字节照抄），不淡入淡出、不重采样，所以截出来的一定不超过 20 秒（克隆模型的上限不变）。
// 只截、不拒：截出来不到 REFERENCE_VOICE_MIN_MS 的（几乎全是静音）由调用方照"太短"拒。
import { REFERENCE_VOICE_TRIM_MAX_MS, REFERENCE_VOICE_TRIM_MIN_MS, REFERENCE_VOICE_TRIM_TARGET_MS } from "@ergo/protocol";
import { sliceWav, type WavInfo } from "./wav.ts";

/** 算响度的一帧多长（毫秒） */
const TRIM_FRAME_MS = 10;
/** 静音连着多久才算一处停顿（毫秒） */
const TRIM_PAUSE_MIN_MS = 300;
/** 断在停顿开头往后多少（毫秒）：留一点尾音的余韵 */
const PAUSE_TAIL_MS = 200;
/** 开头的静音去掉时，说话开始之前留多少（毫秒） */
const LEAD_IN_MS = 100;
/** 连着几帧有声音才算开始说话 */
const ONSET_FRAMES = 3;
/** 底噪取响度的第几百分位、人声取第几百分位（人声取得高：长录音里大半是静音时也取得到说话的响度） */
const FLOOR_PERCENTILE = 0.1;
const SPEECH_PERCENTILE = 0.99;

/** 截出来的那段 */
export interface ReferenceTrim {
  /** 截出来的 WAV（格式和原来的一样，44 字节的标准头） */
  wav: Buffer;
  durationMs: number;
  /** 从原录音的第几毫秒起（去掉的开头静音有多长） */
  startMs: number;
  /** 怎么断的：pause 断在说话的停顿处；hard 找不到停顿，在目标长度处硬截；end 说话开始以后剩下的不长，留到结尾 */
  cut: "pause" | "hard" | "end";
}

/** 每帧的响度（dBFS；全是 0 的帧是 -Infinity）。只收 16 位 PCM 单声道 */
function frameLevels(bytes: Buffer, info: WavInfo, frameSamples: number): Float64Array {
  const count = Math.floor(info.dataLength / 2 / frameSamples);
  const levels = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const base = info.dataOffset + f * frameSamples * 2;
    for (let i = 0; i < frameSamples; i++) {
      const x = bytes.readInt16LE(base + i * 2) / 32768;
      sum += x * x;
    }
    levels[f] = 10 * Math.log10(sum / frameSamples);
  }
  return levels;
}

/** 第 p 百分位（0–1） */
function percentile(sorted: Float64Array, p: number): number {
  return sorted.length === 0 ? -Infinity : sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
}

/**
 * 静音的门槛（dBFS，低于它的帧算静音）：底噪往上 10 dB，但至少比人声低 20 dB；底噪几乎没有（数字静音）时取人声往下 40 dB。
 * 底噪和人声都取整段录音每帧响度的百分位（第 10、第 99）
 */
function silenceThresholdDb(levels: Float64Array): number {
  const sorted = levels.toSorted();
  const floor = percentile(sorted, FLOOR_PERCENTILE);
  const speech = percentile(sorted, SPEECH_PERCENTILE);
  return Math.min(speech - 20, Math.max(floor + 10, speech - 40));
}

/**
 * 截一段当参考（见文件开头）。bytes 和 info 是单声道 16 位 PCM 的 WAV（导入时转成的 16 kHz 那份，别的采样率也行）；
 * 调用方只在录音长于 REFERENCE_VOICE_MAX_MS 时调它
 */
export function trimReference(bytes: Buffer, info: WavInfo): ReferenceTrim {
  if (info.encoding !== "pcm" || info.bitsPerSample !== 16 || info.channels !== 1) throw new Error("只截 16 位 PCM 单声道的 WAV"); // @i18n-ignore log：编程错误
  const rate = info.sampleRate;
  const samplesOf = (ms: number) => Math.round((ms * rate) / 1000);
  const msOf = (samples: number) => Math.round((samples / rate) * 1000);
  const total = info.dataLength / 2;
  const frameSamples = samplesOf(TRIM_FRAME_MS);
  const levels = frameLevels(bytes, info, frameSamples);
  const threshold = silenceThresholdDb(levels);
  const silent = (f: number) => levels[f]! < threshold;

  // 开头的静音：第一处连着 ONSET_FRAMES 帧有声音的地方算开始说话（一帧都找不到就从头取）
  let onset = 0;
  for (let f = 0; f + ONSET_FRAMES <= levels.length; f++) {
    let sound = true;
    for (let k = 0; k < ONSET_FRAMES && sound; k++) sound = !silent(f + k);
    if (sound) {
      onset = f;
      break;
    }
  }
  const start = Math.max(0, onset * frameSamples - samplesOf(LEAD_IN_MS));
  const span = (to: number, cut: ReferenceTrim["cut"]): ReferenceTrim => ({ wav: sliceWav(bytes, info, start, to), durationMs: msOf(to - start), startMs: msOf(start), cut });

  // 说话开始以后剩下的不长：整段留到结尾
  if (total - start <= samplesOf(REFERENCE_VOICE_TRIM_MAX_MS)) return span(total, "end");

  // 停顿：说话开始以后连着 ≥ TRIM_PAUSE_MIN_MS 的静音；断点落在 10–20 秒之间的，挑离 15 秒最近的（一样近取早的）
  const minPauseFrames = Math.ceil(TRIM_PAUSE_MIN_MS / TRIM_FRAME_MS);
  const lo = start + samplesOf(REFERENCE_VOICE_TRIM_MIN_MS);
  const hi = start + samplesOf(REFERENCE_VOICE_TRIM_MAX_MS);
  const target = start + samplesOf(REFERENCE_VOICE_TRIM_TARGET_MS);
  let best: number | undefined;
  let runStart = -1;
  for (let f = onset; f <= levels.length; f++) {
    if (f < levels.length && silent(f)) {
      if (runStart < 0) runStart = f;
      continue;
    }
    if (runStart >= 0) {
      const length = f - runStart;
      if (length >= minPauseFrames) {
        const cut = runStart * frameSamples + Math.min(samplesOf(PAUSE_TAIL_MS), Math.floor((length * frameSamples) / 2));
        if (cut >= lo && cut <= hi && (best === undefined || Math.abs(cut - target) < Math.abs(best - target))) best = cut;
      }
      runStart = -1;
    }
    // 往后的停顿从这儿以后才开始，断点只会更远
    if (f * frameSamples > hi) break;
  }
  return best === undefined ? span(target, "hard") : span(best, "pause");
}
