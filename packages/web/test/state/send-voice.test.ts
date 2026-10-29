// 用户打字时 agent 也能发语音（86 号票）的前端状态：agent 用"发语音"工具发的语音（mode 是 tool）和语音回复一样显示成 agent 一侧的
// 语音气泡（播放条、时长、波形，长按「转文字」看送进 TTS 的原文，分段的边收边播）。这一轮 agent 另写的文字照语音轮的规矩
// （用户 2026-10-11 定"只出气泡、文字收进去"）：
// - 发语音之前写的照常流式显示（这时还不知道要发语音）；调用之后这一轮还没结束时，和语音轮"还在回复"一样不显示这一轮 agent 的文字、
//   不显示正在生成的回复，会话末尾在合成时是「正在合成语音…」（第一段到了换成合成中的气泡），合成好了、这一轮还没结束是「正在回复…」；
// - 回合结束时定：普通的话收进气泡（长按「转文字」接在原文后面），有代码、表格、链接这类念不出来的照常显示；
// - 没合成出来、只合成了一部分的：文字照常显示（会话里另有一条说明）。
// 先回放主切面录下的真实事件流（daemon/test/main/send-voice.test.ts 的"演示流程"），再用手写的事件序列测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentVoiceBubble,
  agentVoiceBubbleLook,
  agentVoicePhase,
  type AgentVoiceRecord,
  type MessageEnvelope,
  type MessagePart,
  replay,
  timelineItems,
  type UiInput,
} from "../../src/state/index.ts";
import { frame, msg, textMessage } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type TtsPart = Extract<MessagePart, { type: "tts_audio" }>;
type State = ReturnType<typeof replay>;
const textOf = (m: MessageEnvelope) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const ttsPartOf = (m: MessageEnvelope): TtsPart | undefined => m.parts.find((p): p is TtsPart => p.type === "tts_audio");

/** 时间线上显示的消息 */
function shown(state: State): MessageEnvelope[] {
  return timelineItems(state, "secretary")
    .filter((it) => it.kind === "message")
    .map((it) => msg(it as Parameters<typeof msg>[0]));
}
/** 时间线上显示的消息，写成一行：语音气泡是 tts，有文字的写文字，只有工具调用记录的不写 */
const outline = (state: State) =>
  shown(state).flatMap((m) => {
    if (ttsPartOf(m)) return ["tts"];
    const text = textOf(m);
    return text ? [`${m.speaker}:${text.split("\n")[0]}`] : [];
  });
const streaming = (state: State) => timelineItems(state, "secretary").some((it) => it.kind === "streaming");

const isFrame = (type: string, match: (payload: never) => boolean = () => true) => (i: UiInput) => i.kind === "frame" && i.frame.type === type && match(i.frame.payload as never);
const voiceIs = (status: string, coversReply?: boolean | "unset") =>
  isFrame("agent_voice", ({ voice }: { voice: AgentVoiceRecord }) => voice.status === status && (coversReply === undefined || (coversReply === "unset" ? voice.coversReply === undefined : voice.coversReply === coversReply)));

/** 回放到第 nth 个（1 起）符合条件的输入为止（含它） */
function upTo(inputs: UiInput[], match: (i: UiInput) => boolean, nth = 1): State {
  let seen = 0;
  const at = inputs.findIndex((i) => match(i) && ++seen === nth);
  expect(at).toBeGreaterThanOrEqual(0);
  return replay(inputs.slice(0, at + 1));
}

const SHORT = "明早九点开会，记得带上周报。";

describe("回放：发语音、另写普通的话收进气泡；发语音、另写的表照常显示；语音服务忙交回原因（send-voice）", () => {
  const inputs = load("send-voice");
  const state = replay(inputs);

  test("最后的样子：第一轮只有语音气泡；第二轮气泡下面是那张表；第三轮没合成出来，是一条说明和 agent 的文字", () => {
    expect(outline(state)).toEqual([
      "user:念给我听：明早九点开会",
      "tts",
      "user:用语音说一下明天的安排，再列个表",
      "tts",
      "agent:| 时间 | 事项 |",
      "user:说声好",
      "system:这条语音没发出去（语音服务忙）。",
      "agent:语音服务忙，我用文字说：好的。",
    ]);
    expect(agentVoicePhase(state, "secretary")).toBeUndefined();
  });

  test("气泡和语音回复的一样（时长、波形）；「转文字」是送进 TTS 的原文，收进去的那句接在后面；没收的只有原文", () => {
    const [first, second] = shown(state).flatMap((m) => ttsPartOf(m) ?? []);
    const bubble = agentVoiceBubble(state, first!);
    expect(bubble).toMatchObject({ mode: "tool", duration: "3″", text: `${SHORT}\n\n好的，念给你听了。` });
    expect(first!.waveform).toHaveLength(32);
    expect(agentVoiceBubbleLook(bubble, true).body).toEqual({ kind: "text", text: `${SHORT}\n\n好的，念给你听了。` });
    expect(agentVoiceBubble(state, second!).text).toBe("明天的安排我列成表了，一共两件事。");
  });

  test("合成中：会话末尾「正在合成语音…」；合成好了、这一轮还没结束：「正在回复…」，这一轮 agent 的文字和正在生成的回复都不显示", () => {
    const synthesizing = upTo(inputs, voiceIs("synthesizing"));
    expect(agentVoicePhase(synthesizing, "secretary")).toBe("synthesizing");
    const done = upTo(inputs, voiceIs("done", "unset"));
    expect(agentVoicePhase(done, "secretary")).toBe("replying");
    // 流式增量到了：不显示
    const during = upTo(inputs, isFrame("stream"));
    expect(during.streams.secretary).toBeDefined();
    expect(streaming(during)).toBe(false);
    // 定稿了、回合还没结束：文字也不显示
    const final = upTo(inputs, isFrame("message", ({ message }: { message: MessageEnvelope }) => textOf(message) === "好的，念给你听了。"));
    expect(outline(final)).toEqual(["user:念给我听：明早九点开会", "tts"]);
    expect(agentVoicePhase(final, "secretary")).toBe("replying");
  });

  test("回合结束、定了收进去：那句话还是不显示，会话末尾没有提示", () => {
    const closed = upTo(inputs, voiceIs("done", true));
    expect(outline(closed)).toEqual(["user:念给我听：明早九点开会", "tts"]);
    expect(agentVoicePhase(closed, "secretary")).toBeUndefined();
  });

  test("另写的有表格：这一轮还没结束时不显示，回合结束定了不收之后照常显示在气泡下面", () => {
    const table = upTo(inputs, isFrame("message", ({ message }: { message: MessageEnvelope }) => textOf(message).startsWith("| 时间")));
    expect(outline(table).at(-1)).toBe("tts");
    expect(agentVoicePhase(table, "secretary")).toBe("replying");
    const closed = upTo(inputs, voiceIs("done", false));
    expect(outline(closed).slice(-2)).toEqual(["tts", "agent:| 时间 | 事项 |"]);
    expect(agentVoicePhase(closed, "secretary")).toBeUndefined();
  });

  test("没合成出来：这一轮的文字照常显示（回合还没结束时也是），带一条说明", () => {
    const failed = upTo(inputs, isFrame("message", ({ message }: { message: MessageEnvelope }) => textOf(message).startsWith("语音服务忙，我用文字说")));
    expect(outline(failed).slice(-2)).toEqual(["system:这条语音没发出去（语音服务忙）。", "agent:语音服务忙，我用文字说：好的。"]);
    expect(agentVoicePhase(failed, "secretary")).toBeUndefined();
  });

  test("重连时重新同步这个频道、从头补发：显示的和原来一样", () => {
    const resynced = replay(
      inputs.filter((i) => i.kind === "frame"),
      replay([{ kind: "resync", channel: "secretary" }], state),
    );
    expect(shown(resynced)).toEqual(shown(state));
  });
});

const VOICE_ID = "av-tool";
const PART: TtsPart = { type: "tts_audio", voiceId: VOICE_ID, mediaId: "c".repeat(64), mime: "audio/wav", durationMs: 2400, waveform: [20, 90, 40] };

function toolVoice(version: number, overrides: Partial<AgentVoiceRecord> = {}): AgentVoiceRecord {
  return {
    id: VOICE_ID,
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    turnSeq: 3,
    replyMessageIds: [],
    mode: "tool",
    text: "好的，念给你听。",
    referenceVoice: { id: "v-sample", name: "示例音色" },
    status: "synthesizing",
    createdAt: "2026-10-11T09:00:00.000+08:00",
    updatedAt: "2026-10-11T09:00:00.000+08:00",
    version,
    ...overrides,
  };
}
const doneFields = { status: "done" as const, mediaId: PART.mediaId, mime: "audio/wav", durationMs: 2400, waveform: PART.waveform, messageId: "m-voice" };
const voiceMessage: MessageEnvelope = { id: "m-voice", conversation: "secretary", speaker: "agent", time: "2026-10-11T09:00:03.000+08:00", parts: [PART] };

describe("手写的边角", () => {
  /** 上一轮的回复、用户打字、发语音之前写的一句 */
  const before = [
    frame("secretary", 1, "message", { message: textMessage("m-earlier", "agent", "上一轮的回复") }),
    frame("secretary", 2, "message", { message: textMessage("m-user", "user", "念给我听") }),
    frame("secretary", 3, "turn_start", { inputMessageId: "m-user" }),
    frame("secretary", 4, "message", { message: textMessage("m-before", "agent", "好，我念一下。") }),
  ];

  test("发语音之前写的照常显示；调用之后（语音建出来）这一轮的文字收起，之前几轮的、用户的照常", () => {
    expect(outline(replay(before))).toEqual(["agent:上一轮的回复", "user:念给我听", "agent:好，我念一下。"]);
    const calling = replay([...before, frame("secretary", 5, "agent_voice", { voice: toolVoice(1) })]);
    expect(outline(calling)).toEqual(["agent:上一轮的回复", "user:念给我听"]);
    expect(agentVoicePhase(calling, "secretary")).toBe("synthesizing");
  });

  test("回合结束定了收进去：「转文字」把这一轮另写的几句接在原文后面（按先后）", () => {
    const state = replay([
      ...before,
      frame("secretary", 5, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 6, "agent_voice", { voice: toolVoice(2, doneFields) }),
      frame("secretary", 7, "message", { message: voiceMessage }),
      frame("secretary", 8, "message", { message: textMessage("m-after", "agent", "念完了。") }),
      frame("secretary", 9, "turn_end", { inputMessageId: "m-user", outcome: "completed" }),
      frame("secretary", 10, "agent_voice", { voice: toolVoice(3, { ...doneFields, coversReply: true, replyMessageIds: ["m-before", "m-after"] }) }),
    ]);
    expect(outline(state)).toEqual(["agent:上一轮的回复", "user:念给我听", "tts"]);
    expect(agentVoiceBubble(state, PART).text).toBe("好的，念给你听。\n\n好，我念一下。\n\n念完了。");
  });

  test("回合没回复完（中止、被打断：守护进程定成不收）：这一轮的文字回来", () => {
    const state = replay([
      ...before,
      frame("secretary", 5, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 6, "agent_voice", { voice: toolVoice(2, doneFields) }),
      frame("secretary", 7, "message", { message: voiceMessage }),
      frame("secretary", 8, "agent_voice", { voice: toolVoice(3, { ...doneFields, coversReply: false }) }),
    ]);
    expect(outline(state)).toEqual(["agent:上一轮的回复", "user:念给我听", "agent:好，我念一下。", "tts"]);
    expect(agentVoiceBubble(state, PART).text).toBe("好的，念给你听。");
  });

  test("没合成出来（这一轮还没结束）：文字马上回来，会话末尾没有提示", () => {
    const state = replay([...before, frame("secretary", 5, "agent_voice", { voice: toolVoice(1) }), frame("secretary", 6, "agent_voice", { voice: toolVoice(2, { status: "failed", error: "语音服务忙" }) })]);
    expect(outline(state)).toEqual(["agent:上一轮的回复", "user:念给我听", "agent:好，我念一下。"]);
    expect(agentVoicePhase(state, "secretary")).toBeUndefined();
  });

  test("收着只到下一轮开始：回合结束时定收不收的那一版没到（守护进程在这之前停了），下一轮的回复照常显示、照常流式，会话末尾不再是「正在回复…」", () => {
    const held = [
      ...before,
      frame("secretary", 5, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 6, "agent_voice", { voice: toolVoice(2, doneFields) }),
      frame("secretary", 7, "message", { message: voiceMessage }),
      frame("secretary", 8, "message", { message: textMessage("m-after", "agent", "念完了。") }),
      frame("secretary", 9, "turn_end", { inputMessageId: "m-user", outcome: "completed" }),
      frame("secretary", 10, "message", { message: textMessage("m-next", "user", "再说一件事") }),
    ];
    // 下一轮还没开始：这一轮的照旧收着
    expect(outline(replay(held))).toEqual(["agent:上一轮的回复", "user:念给我听", "tts", "user:再说一件事"]);
    expect(agentVoicePhase(replay(held), "secretary")).toBe("replying");
    const next = [...held, frame("secretary", 11, "turn_start", { inputMessageId: "m-next" })];
    const streamingNext = replay([...next, frame("secretary", 11, "stream", { messageId: "a-next", deltas: [{ part: 0, type: "text", offset: 0, text: "好的" }] })]);
    expect(streaming(streamingNext)).toBe(true);
    expect(agentVoicePhase(streamingNext, "secretary")).toBeUndefined();
    const answered = replay([...next, frame("secretary", 12, "message", { message: textMessage("m-next-reply", "agent", "好的，记下了。") })]);
    // 上一轮的那两句还收着（在上一轮开始和这一轮开始之间），这一轮的回复照常显示
    expect(outline(answered)).toEqual(["agent:上一轮的回复", "user:念给我听", "tts", "user:再说一件事", "agent:好的，记下了。"]);
    // 重新同步这个频道、从头补发：一样
    const resynced = replay(
      [...next, frame("secretary", 12, "message", { message: textMessage("m-next-reply", "agent", "好的，记下了。") })],
      replay([{ kind: "resync", channel: "secretary" }], answered),
    );
    expect(outline(resynced)).toEqual(outline(answered));
  });

  test("一轮里收下的插话（回合结束前补上的 turn_start）在这一轮的回复之后：这一轮的回复照样收着", () => {
    const state = replay([
      ...before,
      frame("secretary", 5, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 6, "agent_voice", { voice: toolVoice(2, doneFields) }),
      frame("secretary", 7, "message", { message: voiceMessage }),
      frame("secretary", 8, "message", { message: textMessage("m-after", "agent", "念完了。") }),
      frame("secretary", 9, "turn_start", { inputMessageId: "m-interjected" }),
      frame("secretary", 10, "turn_end", { inputMessageId: "m-interjected", outcome: "completed" }),
    ]);
    expect(outline(state)).toEqual(["agent:上一轮的回复", "user:念给我听", "tts"]);
  });

  test("往上翻取回的一页带着工具发的语音：收进去的照样不显示，「转文字」接在原文后面", () => {
    const page = {
      conversation: "secretary" as const,
      messages: [
        { seq: 1, message: textMessage("m-user", "user", "念给我听") },
        { seq: 3, message: voiceMessage },
        { seq: 4, message: textMessage("m-after", "agent", "念完了。") },
      ],
      records: [],
      hasMore: false,
      agentVoices: [toolVoice(3, { ...doneFields, coversReply: true, replyMessageIds: ["m-after"] })],
    };
    const state = replay([{ kind: "history_page", conversation: "secretary", page }]);
    expect(outline(state)).toEqual(["user:念给我听", "tts"]);
    expect(agentVoiceBubble(state, PART).text).toBe("好的，念给你听。\n\n念完了。");
  });
});
