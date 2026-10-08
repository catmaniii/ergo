// agent 发的语音的前端状态（32 号票）：用户发语音时 agent 的回复合成语音，在 agent 一侧显示成和用户语音一样的气泡，
// 长按「转文字」才展开送进 TTS 的原文。用户 2026-10-08 定的显示：这一轮不流式显示回复，只有"正在回复…"；
// 短回复（整段合成）合成中显示"正在合成语音…"，合成好只出语音气泡；长回复（口语总结）文字和附件照常显示，合成好再加气泡；
// 没合成出来的照常是文字和一条说明。往上翻取回的历史、重连补发的同一套规则。
// 先回放主切面录下的真实事件流（daemon/test/main/voice-reply.test.ts 的"演示流程"），再用手写的事件序列测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentVoiceBubble,
  agentVoiceOf,
  agentVoicePhase,
  type AgentVoiceRecord,
  type MessageEnvelope,
  type MessagePart,
  replay,
  timelineItems,
  type UiInput,
  voiceBubbleWidth,
} from "../../src/state/index.ts";
import { frame, msg, textMessage } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type TtsPart = Extract<MessagePart, { type: "tts_audio" }>;
type State = ReturnType<typeof replay>;
const ttsPartOf = (m: MessageEnvelope): TtsPart | undefined => m.parts.find((p): p is TtsPart => p.type === "tts_audio");
const textOf = (m: MessageEnvelope) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** 时间线上显示的消息 */
function shown(state: State): MessageEnvelope[] {
  return timelineItems(state, "secretary")
    .filter((it) => it.kind === "message")
    .map((it) => msg(it as Parameters<typeof msg>[0]));
}

/** 时间线上显示的 agent 的文字 */
const agentTexts = (state: State) =>
  shown(state)
    .filter((m) => m.speaker === "agent")
    .map(textOf)
    .filter((t) => t !== "");

/** 时间线上有没有正在生成的回复 */
const streaming = (state: State) => timelineItems(state, "secretary").some((it) => it.kind === "streaming");

const isFrame = (type: string, status?: string) => (i: UiInput) =>
  i.kind === "frame" && i.frame.type === type && (status === undefined || (i.frame.payload as { voice: AgentVoiceRecord }).voice.status === status);

/** 回放到第 nth 个（1 起）符合条件的输入为止（含它） */
function upTo(inputs: UiInput[], match: (i: UiInput) => boolean, nth = 1): State {
  let seen = 0;
  const at = inputs.findIndex((i) => match(i) && ++seen === nth);
  expect(at).toBeGreaterThanOrEqual(0);
  return replay(inputs.slice(0, at + 1));
}

const SHORT = "好的，明早九点提醒你交报告。";

describe("回放：短回复整段合成、长回复追问后合成口语总结、语音服务忙退回只发文字（voice-reply）", () => {
  const inputs = load("voice-reply");
  const state = replay(inputs);
  const messages = shown(state);
  const bubbles = messages.filter((m) => m.speaker === "agent").flatMap((m) => ttsPartOf(m) ?? []);

  test("agent 的语音是 agent 一侧的气泡，带时长和波形；点开「转文字」的是送进 TTS 的原文", () => {
    expect(bubbles).toHaveLength(2);
    const first = agentVoiceBubble(state, bubbles[0]!);
    expect(first).toMatchObject({ mode: "whole", text: SHORT, duration: "3″", width: voiceBubbleWidth(bubbles[0]!.durationMs) });
    expect(bubbles[0]!.waveform.length).toBeGreaterThan(0);
    expect(agentVoiceBubble(state, bubbles[1]!)).toMatchObject({ mode: "summary", text: "周报整理好了，细节都在聊天里。" });
  });

  test("短回复合成好只出语音气泡（文字收进语音）；长回复的文字照常显示，追问时 agent 说的不在会话里；没合成出来的是文字和一条说明", () => {
    const texts = agentTexts(state);
    expect(texts).not.toContain(SHORT);
    expect(texts[0]!.startsWith("这份周报我整理好了")).toBe(true);
    expect(texts).not.toContain("写好了。");
    expect(texts.at(-1)).toBe("好的，十分钟后提醒你喝水。");
    const notes = messages.filter((m) => m.speaker === "system").map(textOf);
    expect(notes).toEqual(["语音没合成出来（语音服务忙），这次只发文字。"]);
    // 顺序：用户的语音、（收起的回复）、agent 的语音气泡
    expect(messages.slice(0, 2).map((m) => (ttsPartOf(m) ? "tts" : m.speaker))).toEqual(["user", "tts"]);
    expect(agentVoicePhase(state, "secretary")).toBeUndefined();
  });

  test("这一轮还在回复：不流式显示，回复的文字也不显示，会话末尾是「正在回复…」", () => {
    // 第一轮的流式增量到了
    const during = upTo(inputs, isFrame("stream"));
    expect(agentVoicePhase(during, "secretary")).toBe("replying");
    expect(during.streams.secretary).toBeDefined();
    expect(streaming(during)).toBe(false);
    // 回复定稿了、回合还没结束
    const final = upTo(inputs, (i) => i.kind === "frame" && i.frame.type === "message" && (i.frame.payload as { message: MessageEnvelope }).message.speaker === "agent");
    expect(agentVoicePhase(final, "secretary")).toBe("replying");
    expect(agentTexts(final)).toEqual([]);
  });

  test("短回复合成中：文字照样不显示，会话末尾是「正在合成语音…」；合成好了出语音气泡", () => {
    const synthesizing = upTo(inputs, isFrame("agent_voice", "synthesizing"));
    expect(agentVoicePhase(synthesizing, "secretary")).toBe("synthesizing");
    expect(agentTexts(synthesizing)).toEqual([]);
    const done = upTo(inputs, isFrame("message"), 3);
    expect(agentVoicePhase(done, "secretary")).toBeUndefined();
    expect(shown(done).map((m) => (ttsPartOf(m) ? "tts" : m.speaker))).toEqual(["user", "tts"]);
  });

  test("长回复：回合结束后文字照常显示（追问口语总结、合成时都在），会话末尾是「正在合成语音…」", () => {
    const summarizing = upTo(inputs, isFrame("agent_voice", "summarizing"));
    expect(agentVoicePhase(summarizing, "secretary")).toBe("synthesizing");
    expect(agentTexts(summarizing).some((t) => t.startsWith("这份周报我整理好了"))).toBe(true);
    const synthesizing = upTo(inputs, isFrame("agent_voice", "synthesizing"), 2);
    expect(agentTexts(synthesizing).some((t) => t.startsWith("这份周报我整理好了"))).toBe(true);
  });

  test("没合成出来：这一轮的文字回到时间线上，带一条说明", () => {
    const failed = upTo(inputs, isFrame("agent_voice", "failed"));
    expect(agentTexts(failed).at(-1)).toBe("好的，十分钟后提醒你喝水。");
    expect(agentVoicePhase(failed, "secretary")).toBeUndefined();
  });

  test("重连时重新同步这个频道、从头补发：显示的和原来一样（合成好的短回复只出气泡）", () => {
    const resynced = replay(
      inputs.filter((i) => i.kind === "frame"),
      replay([{ kind: "resync", channel: "secretary" }], state),
    );
    expect(shown(resynced)).toEqual(messages);
  });
});

const VOICE_ID = "av-1";
const PART: TtsPart = { type: "tts_audio", voiceId: VOICE_ID, mediaId: "b".repeat(64), mime: "audio/wav", durationMs: 2800, waveform: [30, 100, 60] };

function agentVoice(version: number, overrides: Partial<AgentVoiceRecord> = {}): AgentVoiceRecord {
  return {
    id: VOICE_ID,
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    replyMessageIds: ["m-reply"],
    mode: "whole",
    text: "好的。",
    referenceVoice: { id: "v-sample", name: "示例音色" },
    model: "audio.cpp/tts",
    status: "synthesizing",
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    version,
    ...overrides,
  };
}

const done = (version = 2) => agentVoice(version, { status: "done", mediaId: PART.mediaId, mime: "audio/wav", durationMs: 2800, waveform: PART.waveform, messageId: "m-voice" });
const voiceMessage: MessageEnvelope = { id: "m-voice", conversation: "secretary", speaker: "agent", time: "2026-10-08T09:00:03.000+08:00", parts: [PART] };

describe("agent 语音对象", () => {
  test("按版本归并：旧版本迟到（往上翻取回的一页里带的）不覆盖新的", () => {
    const state = replay([frame("secretary", 1, "agent_voice", { voice: agentVoice(1) }), frame("secretary", 2, "agent_voice", { voice: done() })]);
    const late = replay([{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [], records: [], hasMore: false, agentVoices: [agentVoice(1)] } }], state);
    expect(agentVoiceOf(late, VOICE_ID)?.status).toBe("done");
  });

  test("往上翻取回的一页带着 agent 语音对象：并进来，「转文字」有原文；整段合成的回复同样只出气泡", () => {
    const page = { conversation: "secretary" as const, messages: [{ seq: 1, message: textMessage("m-reply", "agent", "好的。") }, { seq: 2, message: voiceMessage }], records: [], hasMore: false, agentVoices: [done()] };
    const state = replay([{ kind: "history_page", conversation: "secretary", page }]);
    expect(agentVoiceBubble(state, PART)).toMatchObject({ text: "好的。", mode: "whole" });
    expect(shown(state).map((m) => m.id)).toEqual(["m-voice"]);
  });

  test("还没收到语音对象：气泡照样能播（时长、宽度在 part 里），「转文字」没有原文", () => {
    expect(agentVoiceBubble(replay([]), PART)).toEqual({ duration: "3″", width: voiceBubbleWidth(2800), text: undefined, mode: undefined });
  });

  test("收起的回复里除了文字还有别的（推理不算）：只收起文字，别的照常显示", () => {
    const reply: MessageEnvelope = { ...textMessage("m-reply", "agent", "好的。"), parts: [{ type: "reasoning", text: "想一想" }, { type: "text", text: "好的。" }, { type: "card_ref", cardId: "c-1" }] };
    const state = replay([frame("secretary", 1, "message", { message: reply }), frame("secretary", 2, "agent_voice", { voice: done() }), frame("secretary", 3, "message", { message: voiceMessage })]);
    expect(shown(state).map((m) => m.parts.map((p) => p.type))).toEqual([["reasoning", "card_ref"], ["tts_audio"]]);
  });

  test("还在回复：这一轮开始之后 agent 的消息不显示文字（之前的、用户的照常）；最后没用语音（skipped）时文字回来", () => {
    const replying: AgentVoiceRecord = {
      id: VOICE_ID,
      conversation: "secretary",
      scope: {},
      inputMessageId: "m-user",
      turnSeq: 3,
      replyMessageIds: [],
      status: "replying",
      createdAt: "2026-10-08T09:00:00.000+08:00",
      updatedAt: "2026-10-08T09:00:00.000+08:00",
      version: 1,
    };
    const inputs = [
      frame("secretary", 1, "message", { message: textMessage("m-earlier", "agent", "上一轮的回复") }),
      frame("secretary", 2, "message", { message: textMessage("m-user", "user", "（语音）") }),
      frame("secretary", 3, "turn_start", { inputMessageId: "m-user" }),
      frame("secretary", 4, "agent_voice", { voice: replying }),
      frame("secretary", 5, "message", { message: textMessage("m-reply", "agent", "这一轮的回复") }),
      frame("secretary", 6, "message", { message: textMessage("m-user-2", "user", "插一句") }),
    ];
    const state = replay(inputs);
    expect(shown(state).map((m) => `${m.id}:${textOf(m)}`)).toEqual(["m-earlier:上一轮的回复", "m-user:（语音）", "m-user-2:插一句"]);
    expect(agentVoicePhase(state, "secretary")).toBe("replying");
    const skipped = replay([frame("secretary", 7, "agent_voice", { voice: { ...replying, status: "skipped", error: "用户这一轮最后说的一句不是语音", version: 2 } })], state);
    expect(agentTexts(skipped)).toEqual(["上一轮的回复", "这一轮的回复"]);
    expect(agentVoicePhase(skipped, "secretary")).toBeUndefined();
  });

  test("重新同步会话频道：这个会话的 agent 语音对象清掉", () => {
    const state = replay([frame("secretary", 1, "agent_voice", { voice: done() })]);
    expect(agentVoiceOf(replay([{ kind: "resync", channel: "secretary" }], state), VOICE_ID)).toBeUndefined();
  });
});
