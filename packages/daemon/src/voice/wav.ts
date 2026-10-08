// WAV（32 号票）：参考音色只收 WAV，audio.cpp 合成出来的也是 WAV。这里读 WAV 头量时长（导入参考音色时核对、
// 合成出的语音记进语音对象），再从采样算出画气泡用的波形摘要。只认 PCM（8/16/24/32 位整数）和 32 位浮点。

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** PCM 整数，或者 IEEE 浮点 */
  encoding: "pcm" | "float";
  durationMs: number;
  /** data 块在文件里从哪个字节起、多长 */
  dataOffset: number;
  dataLength: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** 读 WAV 头；不是认得的 WAV 时为 undefined */
export function readWav(bytes: Buffer): WavInfo | undefined {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let format: { code: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      let code = bytes.readUInt16LE(body);
      // 扩展格式：真正的格式在子格式 GUID 的头两个字节
      if (code === WAVE_FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= bytes.length) code = bytes.readUInt16LE(body + 24);
      format = {
        code,
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8),
        blockAlign: bytes.readUInt16LE(body + 12),
        bits: bytes.readUInt16LE(body + 14),
      };
    }
    if (id === "data") {
      if (!format) return undefined;
      const { code, channels, sampleRate, byteRate, blockAlign, bits } = format;
      const encoding = code === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bits) ? "pcm" : code === WAVE_FORMAT_FLOAT && bits === 32 ? "float" : undefined;
      if (!encoding || channels < 1 || sampleRate < 1 || byteRate < 1 || blockAlign !== channels * (bits / 8)) return undefined;
      // 流式写出的 WAV 可能把 data 的长度写成 0 或者全 F：按文件实际剩下的算
      const dataLength = size === 0 || body + size > bytes.length ? bytes.length - body : size;
      const frames = Math.floor(dataLength / blockAlign);
      return { sampleRate, channels, bitsPerSample: bits, encoding, durationMs: Math.round((frames / sampleRate) * 1000), dataOffset: body, dataLength: frames * blockAlign };
    }
    // 块按偶数字节对齐
    offset = body + size + (size % 2);
  }
  return undefined;
}

/**
 * 波形摘要：把整段分成最多 bars 格，每格取采样绝对值的峰值，按整段的峰值换成 0–100 的整数（画气泡用，和用户语音的一样）。
 * 没有声音的是全 0
 */
export function wavWaveform(bytes: Buffer, info: WavInfo, bars: number): number[] {
  const bytesPerSample = info.bitsPerSample / 8;
  const frames = info.dataLength / (bytesPerSample * info.channels);
  const count = Math.min(bars, frames);
  if (count <= 0) return [];
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * frames) / count);
    const to = Math.floor(((i + 1) * frames) / count);
    // 每格最多看 2000 个点，长的语音也不慢
    const step = Math.max(1, Math.floor((to - from) / 2000));
    let peak = 0;
    for (let f = from; f < to; f += step) {
      for (let c = 0; c < info.channels; c++) {
        const at = info.dataOffset + (f * info.channels + c) * bytesPerSample;
        peak = Math.max(peak, Math.abs(sampleAt(bytes, at, info)));
      }
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks);
  if (max <= 0) return peaks.map(() => 0);
  return peaks.map((p) => Math.round((p / max) * 100));
}

/** 一个采样换成 -1–1 */
function sampleAt(bytes: Buffer, at: number, info: WavInfo): number {
  if (info.encoding === "float") return bytes.readFloatLE(at);
  switch (info.bitsPerSample) {
    case 8:
      return (bytes.readUInt8(at) - 128) / 128;
    case 16:
      return bytes.readInt16LE(at) / 32768;
    case 24:
      return bytes.readIntLE(at, 3) / 8388608;
    default:
      return bytes.readInt32LE(at) / 2147483648;
  }
}
