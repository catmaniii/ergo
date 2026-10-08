// 按内容认音频（31 号票的语音消息）：浏览器的 MediaRecorder 能录什么格式就收什么格式（Chrome、Edge 是 webm/opus，
// Firefox 是 ogg/opus，Safari 是 mp4/aac），服务端不看文件名和前端声明的类型，按开头的字节认。
// 认出来的才能作为语音发出，下载时也只有它们按音频类型在页面里直接播放（其余一律作为附件下载）。

/** 认出来的音频 */
export interface AudioInfo {
  /** 播放、记进语音对象用的类型 */
  mime: string;
}

/** 认格式要看开头多少字节 */
export const AUDIO_HEADER_BYTES = 12;

const ascii = (bytes: Uint8Array, start: number, text: string) => text.split("").every((c, i) => bytes[start + i] === c.charCodeAt(0));

/** 开头的字节像哪种音频；认不出是 undefined */
export function sniffAudio(head: Uint8Array): AudioInfo | undefined {
  // WebM（Matroska 的 EBML 头）：Chrome、Edge 的 MediaRecorder
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { mime: "audio/webm" };
  // Ogg：Firefox 的 MediaRecorder
  if (ascii(head, 0, "OggS")) return { mime: "audio/ogg" };
  // MP4 / M4A（ftyp 盒子）：Safari 的 MediaRecorder
  if (ascii(head, 4, "ftyp")) return { mime: "audio/mp4" };
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return { mime: "audio/wav" };
  if (ascii(head, 0, "fLaC")) return { mime: "audio/flac" };
  if (ascii(head, 0, "ID3")) return { mime: "audio/mpeg" };
  if (head[0] === 0xff && head[1] !== undefined) {
    // ADTS 封装的 AAC（FF F1 / FF F9），MPEG 音频帧（FF E? / FF F? 里剩下的）
    if ((head[1] & 0xf6) === 0xf0) return { mime: "audio/aac" };
    if ((head[1] & 0xe0) === 0xe0) return { mime: "audio/mpeg" };
  }
  return undefined;
}
