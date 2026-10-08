// 按内容认音频（media/audio.ts，31 号票）：浏览器的 MediaRecorder 录出来的几种格式都认，别的不认（不看文件名和声明的类型）。
import { describe, expect, it } from "vitest";
import { sniffAudio } from "../src/media/audio.ts";

const bytes = (...parts: Array<string | number[]>) => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));

describe("认音频", () => {
  it.each([
    ["WebM（Chrome、Edge）", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]), "audio/webm"],
    ["Ogg（Firefox）", bytes("OggS", [0, 2, 0, 0]), "audio/ogg"],
    ["MP4（Safari）", bytes([0, 0, 0, 0x1c], "ftypM4A ", [0, 0]), "audio/mp4"],
    ["WAV", bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "), "audio/wav"],
    ["FLAC", bytes("fLaC", [0, 0, 0, 0x22]), "audio/flac"],
    ["MP3（ID3 头）", bytes("ID3", [4, 0, 0]), "audio/mpeg"],
    ["MP3（帧头）", bytes([0xff, 0xfb, 0x90, 0x44]), "audio/mpeg"],
    ["AAC（ADTS）", bytes([0xff, 0xf1, 0x50, 0x80]), "audio/aac"],
  ])("%s", (_name, head, mime) => {
    expect(sniffAudio(head)).toEqual({ mime });
  });

  it("不是音频的不认：图片、文字、空的", () => {
    expect(sniffAudio(bytes([0x89], "PNG\r\n", [0x1a, 0x0a]))).toBeUndefined();
    expect(sniffAudio(bytes("hello world"))).toBeUndefined();
    expect(sniffAudio(new Uint8Array())).toBeUndefined();
    expect(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBeUndefined();
  });
});
