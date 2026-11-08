// 按内容认音频（media/audio.ts）：浏览器的 MediaRecorder 录出来的几种格式都认，别的不认（不看文件名和声明的类型）。
import { describe, expect, it } from "vitest";
import { sniffAudio, videoTypeOf } from "../src/media/audio.ts";

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
    ["AAC（ADTS）", bytes([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), "audio/aac"],
  ])("%s", (_name, head, mime) => {
    expect(sniffAudio(head)).toEqual({ mime });
  });

  it("开头碰巧是 FF F?、FF E? 的二进制文件不当音频：帧头里有保留值、或者短得放不下帧头", () => {
    // 采样率序号 15（保留）
    expect(sniffAudio(bytes([0xff, 0xf1, 0x3c, 0x80, 0x02, 0x1f, 0xfc]))).toBeUndefined();
    // 帧长 0
    expect(sniffAudio(bytes([0xff, 0xf1, 0x50, 0x80, 0x00, 0x00, 0x00]))).toBeUndefined();
    // MPEG：码率序号 15（不合法）、采样率序号 3（保留）、版本 01（保留）、层 00（保留）
    expect(sniffAudio(bytes([0xff, 0xfb, 0xf0, 0x44]))).toBeUndefined();
    expect(sniffAudio(bytes([0xff, 0xfb, 0x9c, 0x44]))).toBeUndefined();
    expect(sniffAudio(bytes([0xff, 0xeb, 0x90, 0x44]))).toBeUndefined();
    expect(sniffAudio(bytes([0xff, 0xf9, 0x50, 0x80, 0x02, 0x1f, 0xfc]))).toEqual({ mime: "audio/aac" }); // F9 是 MPEG-2 的 ADTS，照样认
    expect(sniffAudio(bytes([0xff, 0xf1]))).toBeUndefined();
  });

  it("开头是 FF 的随机字节，认成音频的从约八分之一降到二十分之一以下", () => {
    let seed = 20261108;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      const head = Uint8Array.from({ length: 12 }, () => next());
      head[0] = 0xff; // 都挑最容易误认的：第一个字节就是 FF
      if (sniffAudio(head)) hits++;
    }
    // 开头是 FF 的随机字节，以前约八分之一会被认成 AAC 或 MP3；现在要整个帧头合法
    expect(hits).toBeLessThan(1_000);
  });

  it("不是音频的不认：图片、文字、空的", () => {
    expect(sniffAudio(bytes([0x89], "PNG\r\n", [0x1a, 0x0a]))).toBeUndefined();
    expect(sniffAudio(bytes("hello world"))).toBeUndefined();
    expect(sniffAudio(new Uint8Array())).toBeUndefined();
    expect(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBeUndefined();
  });
});

describe("当视频发时的类型（作为附件发的视频，part 的扩展名定）", () => {
  it.each([
    ["MP4 家族（mp4、mov 都是 ftyp）", "audio/mp4", "video/mp4"],
    ["Matroska / WebM（webm、mkv 都是 EBML）", "audio/webm", "video/webm"],
    ["Ogg", "audio/ogg", "video/ogg"],
  ])("%s", (_name, audio, video) => {
    expect(videoTypeOf({ mime: audio })).toBe(video);
  });

  it("只装得下声音的容器照旧是音频类型", () => {
    for (const mime of ["audio/wav", "audio/flac", "audio/mpeg", "audio/aac"]) expect(videoTypeOf({ mime })).toBe(mime);
  });
});
