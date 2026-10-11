// 语音消息的前端状态（31 号票）：每条语音（VoiceRecord）跟着会话频道上的 voice 事件走，气泡要的东西（时长、宽度、识别状态、
// 气泡下方默认显示的识别文字）从这里取。第一阶段不用大模型修正：文字就是 faster-whisper 识别出的。
// 先回放主切面录下的真实事件流（daemon/test/main/voice.test.ts 的"演示流程"），再用手写的事件序列测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentVoiceBubbleLook,
  BASE_VOICE_BAR,
  conversationView,
  type MessageEnvelope,
  type MessagePart,
  replay,
  type UiInput,
  voiceBubble,
  voiceBubbleLook,
  type VoiceBarSizes,
  voiceBubbleWidth,
  voiceDurationLabel,
  voiceOf,
  type VoiceRecord,
  voiceWave,
  voiceWidthIn,
} from "../../src/state/index.ts";
import { frame, msg } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type VoicePart = Extract<MessagePart, { type: "voice" }>;
const voicePartOf = (m: MessageEnvelope): VoicePart | undefined => m.parts.find((p): p is VoicePart => p.type === "voice");

describe("回放：发语音、识别完成、秘书回复；识别失败后重新识别（voice-message）", () => {
  const inputs = load("voice-message");

  test("语音消息是一个带时长和波形的气泡；识别完成后气泡下方直接显示识别出的文字", () => {
    const state = replay(inputs);
    const messages = conversationView(state, "secretary").filter((it) => it.kind === "message").map(msg);
    const voices = messages.filter((m) => m.speaker === "user").map((m) => voicePartOf(m)!);
    expect(voices.map((v) => [v.durationMs, v.waveform.length])).toEqual([
      [4200, 10],
      [2100, 3],
    ]);
    const first = voiceBubble(state, voices[0]!);
    expect(first).toMatchObject({
      status: "done",
      label: "已识别",
      text: "明天早上九点提醒我交报告",
      caption: { kind: "text", text: "明天早上九点提醒我交报告" },
      canRetry: false,
      duration: "4″",
    });
    expect(first).not.toHaveProperty("corrected");
    // 秘书的回复跟在后面
    expect(messages.filter((m) => m.speaker === "agent").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))).toEqual([
      "好的，明早九点提醒你交报告。",
      "这条语音没识别出来，能再说一遍吗？",
      "好，下午去买菜。",
    ]);
  });

  test("识别的过程：排队 → 识别中 → 完成；失败的能重新识别，重新识别后是新的一次（attempt 2）", () => {
    const voiceFrames = inputs.filter((i): i is Extract<UiInput, { kind: "frame" }> => i.kind === "frame" && i.frame.type === "voice");
    const firstFailedAt = voiceFrames.findIndex((f) => (f.frame.payload as { voice: VoiceRecord }).voice.status === "failed");
    // 停在失败的那一刻：气泡下方标"识别失败"，菜单里能重新识别
    const failedState = replay(inputs.slice(0, inputs.indexOf(voiceFrames[firstFailedAt]!) + 1));
    const failedVoice = (voiceFrames[firstFailedAt]!.frame.payload as { voice: VoiceRecord }).voice;
    const failedPart: VoicePart = { type: "voice", voiceId: failedVoice.id, mediaId: failedVoice.mediaId, mime: failedVoice.mime, durationMs: failedVoice.durationMs, waveform: [] };
    expect(voiceBubble(failedState, failedPart)).toMatchObject({
      status: "failed",
      label: "识别失败",
      canRetry: true,
      text: undefined,
      caption: { kind: "failed", text: "识别失败" },
    });
    // 识别中（停在第二条语音开始识别的那一刻）：气泡下方是"识别中…"
    const recognizingAt = voiceFrames.findIndex((f) => {
      const v = (f.frame.payload as { voice: VoiceRecord }).voice;
      return v.id === failedVoice.id && v.status === "recognizing";
    });
    expect(voiceBubble(replay(inputs.slice(0, inputs.indexOf(voiceFrames[recognizingAt]!) + 1)), failedPart).caption).toEqual({ kind: "pending", text: "识别中…" });
    const done = voiceOf(replay(inputs), failedVoice.id)!;
    expect(done).toMatchObject({ status: "done", attempt: 2 });
    expect(voiceBubble(replay(inputs), failedPart)).toMatchObject({ canRetry: false, caption: { kind: "text", text: "下午去买菜" } });
  });
});

const PART: VoicePart = { type: "voice", voiceId: "v-1", mediaId: "a".repeat(64), mime: "audio/webm", durationMs: 3000, waveform: [10, 20] };

function voiceRecord(version: number, overrides: Partial<VoiceRecord> = {}): VoiceRecord {
  return {
    id: "v-1",
    messageId: "m-1",
    conversation: "secretary",
    mediaId: PART.mediaId,
    mime: "audio/webm",
    durationMs: 3000,
    waveform: [10, 20],
    status: "queued",
    attempt: 1,
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    version,
    ...overrides,
  };
}

const recognized = (version: number, text: string): VoiceRecord =>
  voiceRecord(version, {
    status: "done",
    recognition: { text, language: "zh", segments: [], model: "large-v3", device: "cuda", computeType: "int8_float16", elapsedMs: 1200, time: "2026-10-08T09:00:02.000+08:00" },
  });

const voiceMessage = (id = "m-1"): MessageEnvelope => ({ id, conversation: "secretary", speaker: "user", time: "2026-10-08T09:00:00.000+08:00", parts: [PART] });

describe("语音对象", () => {
  test("按版本归并：旧版本迟到不覆盖新版本", () => {
    const state = replay([frame("secretary", 1, "voice", { voice: voiceRecord(1) }), frame("secretary", 2, "voice", { voice: recognized(3, "你好") })]);
    expect(voiceOf(state, "v-1")?.version).toBe(3);
    const late = replay([{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [], records: [], hasMore: false, voices: [voiceRecord(2, { status: "recognizing" })] } }], state);
    expect(voiceOf(late, "v-1")?.status).toBe("done");
  });

  test("气泡下方那一行：排队、识别中都是「识别中…」，没有文字可复制；识别完了是识别出的文字；识别完了却没有文字（只录到噪声）的说明一句", () => {
    for (const status of ["queued", "recognizing"] as const) {
      expect(voiceBubble(replay([frame("secretary", 1, "voice", { voice: voiceRecord(2, { status }) })]), PART)).toMatchObject({
        status,
        text: undefined,
        caption: { kind: "pending", text: "识别中…" },
      });
    }
    expect(voiceBubble(replay([frame("secretary", 1, "voice", { voice: recognized(3, "原文") })]), PART)).toMatchObject({ status: "done", text: "原文", caption: { kind: "text", text: "原文" } });
    expect(voiceBubble(replay([frame("secretary", 1, "voice", { voice: recognized(3, "  ") })]), PART)).toMatchObject({ text: undefined, caption: { kind: "empty", text: "没有识别出文字" } });
  });

  test("乐观显示的语音（还没有语音对象 id）：气泡照样有时长和宽度，状态是发送中", () => {
    const state = replay([{ kind: "send_message", conversation: "secretary", idempotencyKey: "k1", parts: [{ ...PART, voiceId: undefined } as MessagePart], time: "2026-10-08T09:00:00.000+08:00" }]);
    const pending = conversationView(state, "secretary")[0]!;
    expect(pending.kind).toBe("pending");
    expect(voiceBubble(state, voicePartOf(msg(pending))!)).toMatchObject({ status: "sending", label: "发送中", duration: "3″", width: voiceBubbleWidth(3000), caption: { kind: "pending", text: "发送中…" } });
  });

  test("往上翻取回的一页带着语音对象：并进来", () => {
    const state = replay([{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [{ seq: 1, message: voiceMessage() }], records: [], hasMore: false, voices: [recognized(3, "早")] } }]);
    expect(voiceBubble(state, PART)).toMatchObject({ status: "done", text: "早" });
  });

  test("彻底删除：被删的消息的语音对象也拿掉（文字不留在前端）；重新同步会话频道：这个会话的语音对象清掉", () => {
    const base = replay([frame("secretary", 1, "message", { message: voiceMessage() }), frame("secretary", 2, "voice", { voice: recognized(3, "秘密") })]);
    const purged = replay([frame("secretary", 3, "messages_purged", { messages: [{ seq: 1, messageId: "m-1" }], materialIds: [], toolCallIds: [], mediaIds: [PART.mediaId], deletedAt: "2026-10-08T10:00:00.000+08:00" })], base);
    expect(voiceOf(purged, "v-1")).toBeUndefined();
    expect(voiceOf(replay([{ kind: "resync", channel: "secretary" }], base), "v-1")).toBeUndefined();
  });

  test("气泡宽度随时长变：越长越宽，有最小和最大宽度", () => {
    const widths = [1000, 2000, 5000, 10_000, 30_000, 60_000].map(voiceBubbleWidth);
    expect(widths).toEqual(widths.toSorted((a, b) => a - b));
    expect(new Set(widths).size).toBe(widths.length);
    expect(voiceBubbleWidth(0)).toBe(voiceBubbleWidth(1000));
    expect(voiceBubbleWidth(120_000)).toBe(voiceBubbleWidth(60_000));
  });
});

// 36 号票：语音和它的文字在同一个气泡框里——播放条和时长在上，文字在下。用户发的语音识别完成就显示文字，
// 识别中、失败、没识别出文字的说法沿用 31 号票；框的宽度随时长变，有文字时它是最小宽度、按文字撑开。
/** 收到这一版语音对象（没有就是还没收到）时，这个语音 part 的框是什么样子 */
const lookAt = (voice: VoiceRecord | undefined, part: VoicePart = PART) => voiceBubbleLook(voiceBubble(replay(voice ? [frame("secretary", 1, "voice", { voice })] : []), part));

describe("气泡框的样子：播放条和时长在上，文字在下", () => {
  test("识别中（排队、识别中）：框里下面一行是「识别中…」，宽度随时长、按内容撑开", () => {
    expect(lookAt(voiceRecord(2, { status: "recognizing" }))).toEqual({ body: { kind: "pending", text: "识别中…" }, width: { min: voiceBubbleWidth(3000) } });
    expect(lookAt(voiceRecord(1))).toEqual({ body: { kind: "pending", text: "识别中…" }, width: { min: voiceBubbleWidth(3000) } });
  });

  test("识别完成：识别出的文字直接显示在框里", () => {
    expect(lookAt(recognized(3, "明天早上九点提醒我交报告"))).toEqual({ body: { kind: "text", text: "明天早上九点提醒我交报告" }, width: { min: voiceBubbleWidth(3000) } });
  });

  test("识别失败、没识别出文字：框里是说明", () => {
    expect(lookAt(voiceRecord(2, { status: "failed" })).body).toEqual({ kind: "failed", text: "识别失败" });
    expect(lookAt(recognized(3, " ")).body).toEqual({ kind: "empty", text: "没有识别出文字" });
  });

  test("还在发送（乐观显示，没有语音对象 id）：框里是「发送中…」", () => {
    expect(lookAt(undefined, { ...PART, voiceId: undefined } as VoicePart).body).toEqual({ kind: "pending", text: "发送中…" });
  });
});

// 69 号票：播放条里的波形只占它自己那几格，时长紧跟在后面；格数按时长定，框因为文字变宽时多出来的空白留在行尾。
/** 波形摘要：32 格（前端录音、守护进程合成都是这么多格） */
const SUMMARY_32 = Array.from({ length: 32 }, (_, i) => (i * 3) % 100);

describe("播放条里的波形：格数按时长定", () => {
  test("越长的语音波形越长；1 秒的只有 1 格，24 秒的（框宽 176）24 格", () => {
    const counts = [1000, 2000, 5000, 10_000, 24_000, 45_000, 60_000].map((ms) => voiceWave(SUMMARY_32, ms).length);
    expect(counts).toEqual(counts.toSorted((a, b) => a - b));
    expect(new Set(counts).size).toBe(counts.length);
    // 浏览器里量过：24 秒的框（176 宽）里图标、两处间隔、"24″"之外剩 95.5 像素，放得下 24 格（每格 2 像素加 2 像素间隔，共 94）
    expect(voiceWave(SUMMARY_32, 24_000)).toHaveLength(24);
    expect(voiceWave(SUMMARY_32, 1000)).toHaveLength(1);
  });

  test("格数比摘要少：每格取它盖住的那几格里最大的（留住峰）", () => {
    // 3 秒的（框宽 105）画 8 格：16 格的摘要两两并成一格
    const summary = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80].map((v, i) => (i % 2 === 0 ? v : 100 - v));
    expect(voiceWave(summary, 3000)).toEqual([90, 80, 70, 60, 50, 55, 65, 75]);
  });

  test("格数比摘要多：按位置插值，从头到尾的走势不变", () => {
    const wave = voiceWave([0, 100], 60_000);
    expect(wave.length).toBeGreaterThan(2);
    expect(wave[0]).toBe(0);
    expect(wave.at(-1)).toBe(100);
    expect(wave).toEqual(wave.toSorted((a, b) => a - b));
  });

  test("没有波形（分段合成中的 agent 语音）就不画", () => {
    expect(voiceWave([], 8000)).toEqual([]);
  });
});

// 42 号票：播放条的尺寸每套风格可以不一样（风格的 voice-* token）。随时长的宽度按经典的尺寸定，波形那一段各风格一样长，
// 框宽 = 这套风格的边 + 这一段 + 时长；波形在这一段里按这套风格的竖条、间隔放得下几格画几格。
/** 播放条里除了波形和时长的部分（左右内边距、竖线、播放键、两处间隔） */
const barEdges = (s: VoiceBarSizes) => 2 * s.pad + s.line + s.key + 2 * s.gap;

describe("播放条的尺寸按风格：框宽、波形格数", () => {
  /** 软糖圆角那样的：播放键 36 的圆、间隔 10、竖条 4 隔 3、内边距 12、没有竖线 */
  const BIG: VoiceBarSizes = { pad: 12, line: 0, key: 36, gap: 10, bar: 4, barGap: 3 };
  const DURATIONS = [2000, 3000, 6200, 12_000, 24_000, 45_000, 60_000];

  test("不传尺寸就是经典的：框宽、格数和原来一样（经典的边 13 + 13 + 3 + 16 + 8 + 8 = 61）", () => {
    expect(barEdges(BASE_VOICE_BAR)).toBe(61);
    for (const ms of [1000, ...DURATIONS]) {
      expect(voiceWidthIn(voiceBubbleWidth(ms))).toBe(voiceBubbleWidth(ms));
      expect(voiceWave(SUMMARY_32, ms, BASE_VOICE_BAR)).toEqual(voiceWave(SUMMARY_32, ms));
    }
  });

  test("播放键大、边宽的风格：框宽多出边多出来的那些（这里 80 - 61 = 19），波形那一段一样长", () => {
    for (const ms of DURATIONS) expect(voiceWidthIn(voiceBubbleWidth(ms), BIG)).toBe(voiceBubbleWidth(ms) + 19);
  });

  test("竖条粗的风格格数少：一格 4 像素加 3 像素间隔；6 秒的波形那一段 47 像素放 7 格（经典 12 格）", () => {
    expect(voiceWave(SUMMARY_32, 6200)).toHaveLength(12);
    expect(voiceWave(SUMMARY_32, 6200, BIG)).toHaveLength(7);
    const counts = DURATIONS.map((ms) => voiceWave(SUMMARY_32, ms, BIG).length);
    expect(counts).toEqual(counts.toSorted((a, b) => a - b));
  });

  test.each([
    ["经典", BASE_VOICE_BAR],
    ["播放键大、竖条粗", BIG],
  ] as const)("%s：边、波形、时长加起来放得进框里（2 秒起）", (_name, sizes) => {
    for (const ms of DURATIONS) {
      const bars = voiceWave(SUMMARY_32, ms, sizes).length;
      const used = barEdges(sizes) + bars * (sizes.bar + sizes.barGap) - sizes.barGap + voiceDurationLabel(ms).length * 7;
      expect(used).toBeLessThanOrEqual(voiceWidthIn(voiceBubbleWidth(ms), sizes));
    }
  });

  test("框的样子按尺寸给宽度：用户的语音是最小宽度，agent 的语音收着时是确切宽度", () => {
    const bubble = voiceBubble(replay([]), { type: "voice", mediaId: "m", mime: "audio/webm", durationMs: 6200, waveform: [] } as VoicePart);
    expect(voiceBubbleLook(bubble, BIG).width).toEqual({ min: voiceBubbleWidth(6200) + 19 });
    expect(agentVoiceBubbleLook({ duration: "6″", width: voiceBubbleWidth(6200), text: undefined, mode: undefined }, false, BIG).width).toEqual({ exact: voiceBubbleWidth(6200) + 19 });
  });
});
