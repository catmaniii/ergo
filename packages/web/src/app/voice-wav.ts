// 原生录音交出来的 PCM 做成 WAV（63 号票）：鸿蒙 App 的 AudioCapturer 录的是裸 PCM（16 kHz、单声道、16 位小端），
// 网页加上 44 字节的标准头就是守护进程认得的 audio/wav（按开头的 RIFF/WAVE 认，见 packages/daemon/src/media/audio.ts），照常上传、识别。
// 顺带量整段的最大振幅：不发空白语音（61 号票）在原生录音上直接看样本。
import type { PcmFormat } from "./native-voice.ts";

function writeAscii(view: DataView, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
}

/** PCM 加上标准的 WAV 头（格式 1：PCM） */
export function wavOf(pcm: Uint8Array, format: PcmFormat): Uint8Array<ArrayBuffer> {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** 整段的最大振幅（0–1）；只认 16 位，别的位深判断不了，当作有声音（1） */
export function pcmPeak(pcm: Uint8Array, format: PcmFormat): number {
  if (format.bitsPerSample !== 16) return 1;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let at = 0; at + 1 < pcm.byteLength; at += 2) peak = Math.max(peak, Math.abs(view.getInt16(at, true)));
  return peak / 32768;
}
