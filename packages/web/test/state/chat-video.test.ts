// 聊天里的视频附件（state/chat-video.ts）：哪些显示成视频（第一帧、播放键、时长）还是照旧画卡片、取第一帧的地址、
// 读到元数据之后是能放还是退回卡片、角上的时长怎么写、退回的卡片长什么样。
// 气泡在真页面上取第一帧、点开大播放器、关掉、放不了退回卡片，由 test/chat-video-page.test.ts 查。
import { describe, expect, test } from "vitest";
import {
  fileCards,
  type FilePartValue,
  isChatVideo,
  unplayableVideoCard,
  VIDEO_THUMB_UNPLAYABLE,
  videoDurationLabel,
  videoThumbOf,
  videoThumbSrc,
} from "../../src/state/index.ts";

const file = (name: string, mime: string, size = 1024): FilePartValue => ({ type: "file", mediaId: `m-${name}`, name, mime, size });

describe("哪些附件在聊天里直接显示成视频", () => {
  test.each([
    ["周会.mp4", "video/mp4"],
    ["片段.m4v", "video/x-m4v"],
    ["手机录的.MOV", "video/quicktime"],
    ["下载的.mkv", "video/x-matroska"],
    ["录屏.webm", "video/webm"],
    // 扩展名说了算：Windows 报成别的类型也一样
    ["周会.mp4", "application/octet-stream"],
    // 没有扩展名的看 part 上的类型
    ["录屏", "video/mp4"],
  ])("%s（%s）：视频", (name, mime) => {
    expect(isChatVideo({ name, mime })).toBe(true);
  });

  test.each([
    // 只有声音的 webm 按音频（报告页的音频播放器），不是视频
    ["语音.webm", "audio/webm"],
    ["歌.mp3", "audio/mpeg"],
    // 浏览器都放不了的格式照旧只能下载，不去试
    ["老录像.avi", "video/x-msvideo"],
    ["老录像.wmv", "video/x-ms-wmv"],
    ["截图.png", "image/png"],
    ["清单.md", "text/markdown"],
    ["资料", "application/octet-stream"],
  ])("%s（%s）：照旧是卡片", (name, mime) => {
    expect(isChatVideo({ name, mime })).toBe(false);
  });
});

describe("取第一帧", () => {
  test("地址带上媒体片段 #t=0.1，停在开头那一帧；原来带 # 的换掉", () => {
    expect(videoThumbSrc("/api/media/sha256%3Aabc?name=a.mp4")).toBe("/api/media/sha256%3Aabc?name=a.mp4#t=0.1");
    expect(videoThumbSrc("blob:null/1234#x")).toBe("blob:null/1234#t=0.1");
  });

  test("读到画面宽高的能放：按它的比例画，时长写在角上", () => {
    expect(videoThumbOf({ videoWidth: 1920, videoHeight: 1080, duration: 7.4 })).toEqual({ kind: "ready", width: 1920, height: 1080, duration: 7.4 });
    // 竖着拍的
    expect(videoThumbOf({ videoWidth: 1080, videoHeight: 1920, duration: 63 })).toEqual({ kind: "ready", width: 1080, height: 1920, duration: 63 });
  });

  test("读不出时长（直播流是 Infinity、还没读到是 NaN）：照样能放，只是不写时长", () => {
    expect(videoThumbOf({ videoWidth: 640, videoHeight: 360, duration: Number.POSITIVE_INFINITY })).toEqual({ kind: "ready", width: 640, height: 360, duration: undefined });
    expect(videoThumbOf({ videoWidth: 640, videoHeight: 360, duration: Number.NaN })).toEqual({ kind: "ready", width: 640, height: 360, duration: undefined });
  });

  test("元数据里没有画面宽高（只有声音、画面的编码浏览器解不了，比如 Chrome 遇到不支持的 HEVC）：放不了，退回卡片", () => {
    expect(videoThumbOf({ videoWidth: 0, videoHeight: 0, duration: 12 })).toBe(VIDEO_THUMB_UNPLAYABLE);
    expect(videoThumbOf({ videoWidth: 640, videoHeight: 0, duration: 12 })).toBe(VIDEO_THUMB_UNPLAYABLE);
  });
});

describe("角上的时长", () => {
  test.each([
    [0.2, "0:01"],
    [3, "0:03"],
    [7.4, "0:07"],
    [59.6, "1:00"],
    [750, "12:30"],
    [3723, "1:02:03"],
    [36_000, "10:00:00"],
  ])("%s 秒写成 %s", (seconds, label) => {
    expect(videoDurationLabel(seconds)).toBe(label);
  });

  test("读不出来的不写", () => {
    expect(videoDurationLabel(undefined)).toBeUndefined();
    expect(videoDurationLabel(0)).toBeUndefined();
    expect(videoDurationLabel(Number.NaN)).toBeUndefined();
    expect(videoDurationLabel(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("放不了退回的卡片", () => {
  test("不给预览（报告页一样放不了），点图标就是下载、写仅下载；标题下面一行写网页里放不了，下载看", () => {
    const card = fileCards([file("老摄像机-生日会.mov", "video/quicktime", 12_296)])[0]!;
    // 原来的卡片：能预览（报告页的播放器）
    expect(card.preview).toBe("video");
    const fallback = unplayableVideoCard(card);
    expect(fallback.preview).toBeUndefined();
    expect(fallback.iconAction).toBe("download");
    expect(fallback.iconHint).toBe("仅下载：这段视频网页里放不了，点了直接下载");
    expect(fallback.note).toBe("网页里放不了，下载看");
    // 别的照旧：类型、标题、悬停的全名和大小
    expect(fallback.label).toBe(card.label);
    expect(fallback.title).toBe(card.title);
    expect(fallback.tooltip).toBe(card.tooltip);
  });
});
