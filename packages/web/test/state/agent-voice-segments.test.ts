// 分段合成的 agent 语音的前端状态（38 号票）：守护进程把口语稿按句切段依次合成，合成好一段推一段（agent 语音对象的新版本带着
// 已合成的段），全部完成后拼成一条完整音频、追加载着它的消息。前端第一段到了就出 agent 的语音气泡（时长随已到的段增长、标"合成中"），
// 算"新到的"（开着自动播放时立刻开始播，后面的段接着排）；合成完了气泡换成载着完整音频的那条消息，重播用完整音频。
// 合成到一半没合成下去的（partial）：推出去的段拼成一条，同样有语音消息；回复的文字照常显示，会话里一条说明。
// 一条 agent 语音此刻交给播放器什么（agentVoicePlayback、playbackSource）是纯函数，表格测在最后。
// 回放主切面录下的真实事件流（daemon/test/main/voice-reply.test.ts 的"分段合成"演示流程），再用手写的序列测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentVoiceArrivals,
  agentVoiceBubble,
  agentVoicePhase,
  type AgentVoicePlayback,
  agentVoicePlayback,
  type AgentVoiceRecord,
  type MessageEnvelope,
  type MessagePart,
  playbackSource,
  replay,
  streamingAgentVoiceBubble,
  streamingAgentVoices,
  timelineItems,
  type UiInput,
  voiceBubbleWidth,
} from "../../src/state/index.ts";
import { frame, msg } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type TtsPart = Extract<MessagePart, { type: "tts_audio" }>;
type State = ReturnType<typeof replay>;
const textOf = (m: MessageEnvelope) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** 时间线上显示的消息 */
function shown(state: State): MessageEnvelope[] {
  return timelineItems(state, "secretary")
    .filter((it) => it.kind === "message")
    .map((it) => msg(it as Parameters<typeof msg>[0]));
}
const agentTexts = (state: State) =>
  shown(state)
    .filter((m) => m.speaker === "agent")
    .map(textOf)
    .filter((t) => t !== "");
const ttsParts = (state: State) => shown(state).flatMap((m) => m.parts.filter((p): p is TtsPart => p.type === "tts_audio"));

const voiceFrame = (status: string, segments?: number) => (i: UiInput) => {
  if (i.kind !== "frame" || i.frame.type !== "agent_voice") return false;
  const voice = (i.frame.payload as { voice: AgentVoiceRecord }).voice;
  return voice.status === status && (segments === undefined || voice.segments?.length === segments);
};

/** 合成中、还没有段的那一版 */
const beforeSegments = (i: UiInput) => voiceFrame("synthesizing")(i) && i.kind === "frame" && (i.frame.payload as { voice: AgentVoiceRecord }).voice.segments === undefined;

/** 回放到第 nth 个（1 起）符合条件的输入为止（含它） */
function upTo(inputs: UiInput[], match: (i: UiInput) => boolean, nth = 1): State {
  let seen = 0;
  const at = inputs.findIndex((i) => match(i) && ++seen === nth);
  expect(at).toBeGreaterThanOrEqual(0);
  return replay(inputs.slice(0, at + 1));
}

const REPLY = "好的，我把这周的周报整理好了，下面分几块说清楚。第一块是进度，基本按计划走。第二块是风险，主要在测试环境。";

/** 测试里的地址 */
const URLS = { segment: (voiceId: string, index: number) => `/seg/${voiceId}/${index}`, media: (mediaId: string) => `/media/${mediaId}` };

describe("回放：回复整段分段合成，合成好一段推一段；再发一条，合成到一半服务忙（voice-reply-segments）", () => {
  const inputs = load("voice-reply-segments");
  const state = replay(inputs);

  test("第一段到了：会话末尾出 agent 的语音气泡（合成中，时长是已到的段），不再是「正在合成语音…」；回复的文字照样收着", () => {
    const first = upTo(inputs, voiceFrame("synthesizing", 1));
    const [voice] = streamingAgentVoices(first, "secretary");
    expect(voice?.segments).toHaveLength(1);
    expect(streamingAgentVoiceBubble(voice!)).toMatchObject({ duration: "3″", width: voiceBubbleWidth(3000), text: REPLY, mode: "whole" });
    expect(agentVoicePhase(first, "secretary")).toBeUndefined();
    expect(agentTexts(first)).toEqual([]);
    expect(ttsParts(first)).toEqual([]);
  });

  test("还没有段：会话末尾是「正在合成语音…」，没有气泡", () => {
    const before = upTo(inputs, beforeSegments);
    expect(agentVoicePhase(before, "secretary")).toBe("synthesizing");
    expect(streamingAgentVoices(before, "secretary")).toEqual([]);
  });

  test("后面的段陆续到：气泡的时长随已到的段增长（各段加段间的停顿）", () => {
    const third = upTo(inputs, voiceFrame("synthesizing", 3));
    const [voice] = streamingAgentVoices(third, "secretary");
    // 第三段从 5.2 秒起、长 2.8 秒
    expect(streamingAgentVoiceBubble(voice!).duration).toBe("8″");
    expect(agentVoicePlayback(voice!, URLS)).toEqual({
      kind: "stream",
      stream: {
        segments: [
          { url: `/seg/${voice!.id}/0`, offsetMs: 0, durationMs: 3000 },
          { url: `/seg/${voice!.id}/1`, offsetMs: 3200, durationMs: 1800 },
          { url: `/seg/${voice!.id}/2`, offsetMs: 5200, durationMs: 2800 },
        ],
        complete: false,
      },
      file: undefined,
    });
  });

  test("第一段到了就算新到的（开着自动播放就开始播）；之后的段、合成完成都不再算", () => {
    expect(agentVoiceArrivals(upTo(inputs, voiceFrame("synthesizing", 1)))).toHaveLength(1);
    expect(agentVoiceArrivals(upTo(inputs, beforeSegments))).toEqual([]);
    const first = upTo(inputs, voiceFrame("synthesizing", 1));
    const [id] = agentVoiceArrivals(first);
    const seen = replay([{ kind: "agent_voice_arrival_seen", voiceId: id! }], first);
    const done = replay(inputs.slice(inputs.findIndex(voiceFrame("synthesizing", 1)) + 1, inputs.findIndex(voiceFrame("done")) + 1), seen);
    expect(agentVoiceArrivals(done)).toEqual([]);
    // 整个流程：两条语音各算一次
    expect(agentVoiceArrivals(state)).toHaveLength(2);
  });

  test("合成完了：会话末尾的气泡换成载着完整音频的消息（总时长）；段照样在（正在边收边播的接着播完）", () => {
    const done = upTo(inputs, (i) => i.kind === "frame" && i.frame.type === "message" && (i.frame.payload as { message: MessageEnvelope }).message.parts.some((p) => p.type === "tts_audio"));
    expect(streamingAgentVoices(done, "secretary")).toEqual([]);
    const [part] = ttsParts(done);
    expect(agentVoiceBubble(done, part!)).toMatchObject({ duration: "11″", text: REPLY, mode: "whole" });
    expect(agentTexts(done)).toEqual([]);
    const playback = agentVoicePlayback(done.agentVoices[part!.voiceId]!, URLS);
    expect(playback).toMatchObject({ kind: "stream", stream: { complete: true }, file: `/media/${part!.mediaId}` });
    expect(playback.kind === "stream" && playback.stream.segments).toHaveLength(4);
  });

  test("合成到一半服务忙：推出去的两段拼成一条语音消息；回复的文字照常显示（整段合成的也补出来），带一条说明", () => {
    const partial = state.agentVoices[ttsParts(state)[1]!.voiceId]!;
    expect(partial.status).toBe("partial");
    expect(agentVoiceBubble(state, ttsParts(state)[1]!).duration).toBe("5″");
    expect(agentTexts(state)).toEqual([REPLY]);
    expect(shown(state).filter((m) => m.speaker === "system").map(textOf)).toEqual(["语音只合成了前面一部分（语音服务忙），回复的文字照常显示。"]);
    expect(streamingAgentVoices(state, "secretary")).toEqual([]);
    expect(agentVoicePhase(state, "secretary")).toBeUndefined();
    expect(agentVoicePlayback(partial, URLS)).toMatchObject({ kind: "stream", stream: { complete: true, segments: [{ url: `/seg/${partial.id}/0` }, { url: `/seg/${partial.id}/1` }] } });
    // 顺序：第一轮用户的语音、语音气泡；第二轮用户的语音、回复的文字、语音气泡、说明
    expect(shown(state).map((m) => (m.parts.some((p) => p.type === "tts_audio") ? "tts" : m.speaker))).toEqual(["user", "tts", "user", "agent", "tts", "system"]);
  });

  test("重连时重新同步、从头补发：显示的一样，补发的段不算新到的", () => {
    const resynced = replay(
      inputs.filter((i) => i.kind === "frame").map((i) => ({ ...i, catchUp: true })),
      replay([{ kind: "resync", channel: "secretary" }], state),
    );
    expect(shown(resynced)).toEqual(shown(state));
    expect(agentVoiceArrivals(resynced)).toEqual([]);
  });
});

describe("回放：推了两段，守护进程重启收回推过的段，从第一段重做、合成完成（voice-reply-segments-restart）", () => {
  const inputs = load("voice-reply-segments-restart");
  const state = replay(inputs);
  const twoPushed = upTo(inputs, voiceFrame("synthesizing", 2));
  const [voiceId] = agentVoiceArrivals(twoPushed);

  test("重启前：两段到了，会话末尾是合成中的气泡，交给播放器的是这两段（边收边播）", () => {
    const [voice] = streamingAgentVoices(twoPushed, "secretary");
    expect(agentVoicePlayback(voice!, URLS)).toMatchObject({ kind: "stream", stream: { complete: false, segments: [{ url: `/seg/${voiceId}/0` }, { url: `/seg/${voiceId}/1` }] } });
  });

  test("收回推过的段：气泡没了、回到「正在合成语音…」，交给播放器的是「没有能播的」（在播的停掉放开）", () => {
    const reset = upTo(inputs, beforeSegments, 2);
    expect(streamingAgentVoices(reset, "secretary")).toEqual([]);
    expect(agentVoicePhase(reset, "secretary")).toBe("synthesizing");
    expect(agentVoicePlayback(reset.agentVoices[voiceId!]!, URLS)).toEqual({ kind: "none" });
  });

  test("重做的第一段到了：又算新到的（第一次的已经决定过了），交给播放器的是新的一段", () => {
    const seen = replay([{ kind: "agent_voice_arrival_seen", voiceId: voiceId! }], twoPushed);
    const afterReset = inputs.slice(inputs.findIndex(voiceFrame("synthesizing", 2)) + 1);
    const reset = replay(afterReset.slice(0, afterReset.findIndex(beforeSegments) + 1), seen);
    expect(agentVoiceArrivals(reset)).toEqual([]);
    const redone = replay(afterReset.slice(afterReset.findIndex(beforeSegments) + 1, afterReset.findIndex(voiceFrame("synthesizing", 1)) + 1), reset);
    expect(agentVoiceArrivals(redone)).toEqual([voiceId]);
    expect(agentVoicePlayback(redone.agentVoices[voiceId!]!, URLS)).toMatchObject({ kind: "stream", stream: { complete: false, segments: [{ url: `/seg/${voiceId}/0` }] } });
  });

  test("重做完成：一条载着完整音频的语音消息（四段的总时长），文字收进语音", () => {
    const parts = ttsParts(state);
    expect(parts).toHaveLength(1);
    expect(agentVoiceBubble(state, parts[0]!).duration).toBe("11″");
    expect(agentTexts(state)).toEqual([]);
    expect(streamingAgentVoices(state, "secretary")).toEqual([]);
    expect(playbackSource(agentVoicePlayback(state.agentVoices[voiceId!]!, URLS))).toBe(`/media/${parts[0]!.mediaId}`);
  });
});

describe("边角", () => {
  const base: AgentVoiceRecord = {
    id: "av-1",
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    replyMessageIds: ["m-reply"],
    mode: "whole",
    text: "第一句。第二句。",
    status: "synthesizing",
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    version: 3,
  };
  const withSegments = (version: number, count: number): AgentVoiceRecord => ({
    ...base,
    version,
    segmentCount: 3,
    segments: Array.from({ length: count }, (_, i) => ({ durationMs: 1000, offsetMs: i * 1200 })),
  });

  test("守护进程重启后重做：推过的段收回（会话末尾回到「正在合成语音…」），再到的第一段又算新到的", () => {
    const pushed = replay([frame("secretary", 1, "agent_voice", { voice: withSegments(4, 2) })]);
    const seen = replay([{ kind: "agent_voice_arrival_seen", voiceId: "av-1" }], pushed);
    const reset = replay([frame("secretary", 2, "agent_voice", { voice: { ...base, version: 5 } })], seen);
    expect(streamingAgentVoices(reset, "secretary")).toEqual([]);
    expect(agentVoicePhase(reset, "secretary")).toBe("synthesizing");
    const again = replay([frame("secretary", 3, "agent_voice", { voice: withSegments(6, 1) })], reset);
    expect(agentVoiceArrivals(again)).toEqual(["av-1"]);
    expect(agentVoicePlayback(again.agentVoices["av-1"]!, URLS)).toMatchObject({ kind: "stream", stream: { segments: [{ url: "/seg/av-1/0" }] } });
  });

  test("只有一段的（不推段）：没有段可排，合成好那一版才算新到的（和以前一样）", () => {
    const done: AgentVoiceRecord = { ...base, version: 4, status: "done", segmentCount: 1, mediaId: "b".repeat(64), durationMs: 2000, messageId: "m-voice" };
    expect(agentVoicePlayback(done, URLS)).toEqual({ kind: "file", file: `/media/${"b".repeat(64)}` });
    expect(agentVoiceArrivals(replay([frame("secretary", 1, "agent_voice", { voice: base }), frame("secretary", 2, "agent_voice", { voice: done })]))).toEqual(["av-1"]);
  });
});

// 一条 agent 语音此刻交给播放器什么：页面上每次状态变了把它转给播放器（在播、排着的这一条照它接着排、换成完整音频，
// 或者停掉放开），新到的按 playbackSource 从头播。
/** 语音对象里的前 count 段（每段 1 秒，段间 0.2 秒）和交给播放器的样子 */
const segs = (count: number) => Array.from({ length: count }, (_, i) => ({ durationMs: 1000, offsetMs: i * 1200 }));
const playable = (count: number) => Array.from({ length: count }, (_, i) => ({ url: `/seg/av-1/${i}`, offsetMs: i * 1200, durationMs: 1000 }));

describe("交给播放器的：边收边播的段、完整音频，还是没有能播的", () => {
  const base: AgentVoiceRecord = {
    id: "av-1",
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    replyMessageIds: ["m-reply"],
    mode: "whole",
    text: "第一句。第二句。第三句。",
    status: "synthesizing",
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    version: 2,
  };
  const MEDIA = "c".repeat(64);
  const audio = { mediaId: MEDIA, mime: "audio/wav", durationMs: 3400, messageId: "m-voice" };

  test.each<[string, Partial<AgentVoiceRecord>, AgentVoicePlayback, string | "stream" | undefined]>([
    // 名字、语音对象和 base 不同的地方、交给播放器的、从头播时播什么
    ["还在回复", { status: "replying", text: undefined }, { kind: "none" }, undefined],
    ["在追问口语总结", { status: "summarizing", mode: "summary", text: undefined }, { kind: "none" }, undefined],
    ["合成中、还没有段", {}, { kind: "none" }, undefined],
    ["合成中、到了两段：边收边播（没到齐）", { segmentCount: 3, segments: segs(2) }, { kind: "stream", stream: { segments: playable(2), complete: false }, file: undefined }, "stream"],
    [
      "合成完了（三段）：段到齐了，从头播时播完整音频",
      { status: "done", segmentCount: 3, segments: segs(3), ...audio },
      { kind: "stream", stream: { segments: playable(3), complete: true }, file: `/media/${MEDIA}` },
      `/media/${MEDIA}`,
    ],
    ["只有一段的合成完了：只有完整音频", { status: "done", segmentCount: 1, ...audio }, { kind: "file", file: `/media/${MEDIA}` }, `/media/${MEDIA}`],
    [
      "只合成了一部分（推出去两段）：段到齐了（不会再来），从头播时播拼好的那条",
      { status: "partial", segmentCount: 3, segments: segs(2), ...audio, error: "语音服务忙" },
      { kind: "stream", stream: { segments: playable(2), complete: true }, file: `/media/${MEDIA}` },
      `/media/${MEDIA}`,
    ],
    ["一段都没合成出来就失败了", { status: "failed", error: "语音服务忙" }, { kind: "none" }, undefined],
    [
      "推出去了几段、拼好的那条存不进去（失败）：段照样能播",
      { status: "failed", segmentCount: 3, segments: segs(2), error: "合成出的语音存不进去：磁盘满了" },
      { kind: "stream", stream: { segments: playable(2), complete: true }, file: undefined },
      "stream",
    ],
    ["守护进程重启、推过的段被收回（重做中）：没有能播的，在播的停掉放开", { segmentCount: undefined, segments: undefined }, { kind: "none" }, undefined],
    ["重做时第一段就失败了：没有能播的", { status: "failed", error: "语音服务忙" }, { kind: "none" }, undefined],
    ["最后没用语音", { status: "skipped", error: "用户这一轮最后说的一句不是语音" }, { kind: "none" }, undefined],
  ])("%s", (_name, change, playback, source) => {
    const voice = { ...base, ...change } as AgentVoiceRecord;
    expect(agentVoicePlayback(voice, URLS)).toEqual(playback);
    const from = playbackSource(playback);
    expect(typeof from === "object" ? "stream" : from).toBe(source);
  });

  test("原型里拼不出地址（没有真语音）：当没有能播的", () => {
    const none = { segment: () => undefined, media: () => undefined };
    expect(agentVoicePlayback({ ...base, status: "done", segmentCount: 3, segments: segs(3), ...audio }, none)).toEqual({ kind: "none" });
  });
});
