// WAV（32 号票）：参考音色只收 WAV，audio.cpp 合成出来的也是 WAV。这里读 WAV 头量时长（导入参考音色时核对、
// 合成出的语音记进语音对象），再从采样算出画气泡用的波形摘要。只认 PCM（8/16/24/32 位整数）和 32 位浮点。
// 38 号票起分段合成：各段依次拼成一条（joinWavs，段间留停顿、接缝做淡入淡出），各段在整条里的位置（wavOffsetsMs）。

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

/** -1–1 换成 bits 位的有符号整数（截到边上） */
const toInt = (x: number, bits: number) => Math.max(-(2 ** (bits - 1)), Math.min(2 ** (bits - 1) - 1, Math.round(x * 2 ** (bits - 1))));

/** 写回一个采样（-1–1，超出的截到边上） */
function writeSampleAt(bytes: Buffer, at: number, info: WavInfo, value: number): void {
  const v = Math.max(-1, Math.min(1, value));
  if (info.encoding === "float") return void bytes.writeFloatLE(v, at);
  switch (info.bitsPerSample) {
    case 8:
      return void bytes.writeUInt8(toInt(v, 8) + 128, at);
    case 16:
      return void bytes.writeInt16LE(toInt(v, 16), at);
    case 24:
      return void bytes.writeIntLE(toInt(v, 24), at, 3);
    default:
      return void bytes.writeInt32LE(toInt(v, 32), at);
  }
}

// ───────────── 分段合成的拼接（38 号票） ─────────────

/** 两段 WAV 的格式一样吗（采样率、声道、位深、编码）：一样才能直接拼 */
export function sameWavFormat(a: WavInfo, b: WavInfo): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitsPerSample === b.bitsPerSample && a.encoding === b.encoding;
}

/** 每帧（各声道各一个采样）几个字节 */
const blockOf = (info: WavInfo) => info.channels * (info.bitsPerSample / 8);

/** 段间的停顿有多少帧 */
const gapFramesOf = (info: WavInfo, gapMs: number) => Math.round((gapMs * info.sampleRate) / 1000);

/** 依次拼接时各段在整条里从第几毫秒起（前面各段加上段间的停顿，按帧算再换成毫秒；采样率取第一段的） */
export function wavOffsetsMs(infos: readonly WavInfo[], gapMs: number): number[] {
  const first = infos[0];
  if (!first) return [];
  const gap = gapFramesOf(first, gapMs);
  let frames = 0;
  return infos.map((info) => {
    const at = Math.round((frames / first.sampleRate) * 1000);
    frames += info.dataLength / blockOf(info) + gap;
    return at;
  });
}

/**
 * 把同样格式的几段 WAV 依次拼成一条（44 字节的标准头，格式和各段一样）：段间留 gapMs 的静音，
 * 接缝两边各做 fadeMs 的淡出、淡入（段的头尾不在零点上时，接到静音会出爆音）。调用方先用 sameWavFormat 核对过格式
 */
export function joinWavs(parts: ReadonlyArray<{ bytes: Buffer; info: WavInfo }>, options: { gapMs: number; fadeMs: number }): Buffer {
  const format = parts[0]?.info;
  if (!format) throw new Error("没有要拼的 WAV"); // @i18n-ignore log：编程错误
  const block = blockOf(format);
  const gapBytes = gapFramesOf(format, options.gapMs) * block;
  const dataLength = parts.reduce((sum, p) => sum + p.info.dataLength, 0) + gapBytes * (parts.length - 1);
  // 8 位 PCM 的静音是 128，别的是 0
  const out = Buffer.alloc(44 + dataLength, format.encoding === "pcm" && format.bitsPerSample === 8 ? 128 : 0);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataLength, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format.encoding === "float" ? WAVE_FORMAT_FLOAT : WAVE_FORMAT_PCM, 20);
  out.writeUInt16LE(format.channels, 22);
  out.writeUInt32LE(format.sampleRate, 24);
  out.writeUInt32LE(format.sampleRate * block, 28);
  out.writeUInt16LE(block, 32);
  out.writeUInt16LE(format.bitsPerSample, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataLength, 40);
  const fadeFrames = Math.round((options.fadeMs * format.sampleRate) / 1000);
  const bytesPerSample = format.bitsPerSample / 8;
  let offset = 44;
  for (const [i, { bytes, info }] of parts.entries()) {
    bytes.copy(out, offset, info.dataOffset, info.dataOffset + info.dataLength);
    const frames = info.dataLength / block;
    const fade = Math.min(fadeFrames, Math.floor(frames / 2));
    /** 这一段的第 f 帧乘上 gain */
    const scale = (f: number, gain: number) => {
      for (let c = 0; c < format.channels; c++) {
        const at = offset + (f * format.channels + c) * bytesPerSample;
        writeSampleAt(out, at, format, sampleAt(out, at, format) * gain);
      }
    };
    // 接缝这一侧从 0 渐变到 1：后面还有段的淡出结尾，前面有段的淡入开头
    for (let f = 0; f < fade; f++) {
      if (i > 0) scale(f, f / fade);
      if (i < parts.length - 1) scale(frames - 1 - f, f / fade);
    }
    offset += info.dataLength + gapBytes;
  }
  return out;
}
