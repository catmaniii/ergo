// 发了语音气泡就不再显示"调用了 1 个工具"（87 号票）：agent 用"发语音"工具（send_voice，86 号票）发出了语音气泡的那次调用，
// 会话层的"调用了 N 个工具"不算它（这一轮只有它时整行不出），缩放各档逐个画调用时也不画它；它挂在发出的那个气泡上，
// 气泡的"详情 ›"里看得到这次调用（和单次工具调用的详情一样的内容）。只认确实发出了气泡的（合成好、只发出一部分；还在合成的
// 先不露出来，没合成出来时才露出）——没发出去的（服务忙、没开、太长、没有参考音色、语音轮里调用……）照常显示那一行。
// 气泡和调用按语音对象上记的工具调用 id（AgentVoiceRecord.toolCallId，86 号票）对上。
// 先回放主切面录下的真实事件流（daemon/test/main/send-voice.test.ts 的"演示流程"），再用手写的事件序列测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type AgentVoiceRecord,
  type ChatItem,
  chatItems,
  detailContent,
  type EventFrame,
  locateChatItem,
  type MessageEnvelope,
  type MessagePart,
  replay,
  type ToolCallOutcome,
  type UiInput,
  type UiState,
  zoomBlocks,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
type TtsPart = Extract<MessagePart, { type: "tts_audio" }>;

/** 条目写成一行：种类，工具调用组带上组里每次调用的工具名，agent 的语音带上挂着的那次调用的工具名 */
function outline(items: readonly ChatItem[]): string[] {
  return items.map((it) => {
    if (it.kind === "tool_group") return `tool_group(${it.calls.map((c) => c.part.tool).join(",")})`;
    if (it.kind === "voice") return it.speaker === "user" ? "voice:user" : `voice:agent${it.toolCall ? `(${it.toolCall.part.tool})` : ""}`;
    return it.kind;
  });
}

/** 会话层、缩放各档里单独画出来的发语音调用：组里算进 N 的，和缩小后逐次画的每一块 */
function drawnSendVoice(items: readonly ChatItem[]): string[] {
  const inGroups = items.flatMap((it) => (it.kind === "tool_group" ? it.calls.filter((c) => c.part.tool === "send_voice").map((c) => c.part.callId) : []));
  const inZoom = items.flatMap(zoomBlocks).flatMap((b) => (b.kind === "call" && b.call.part.tool === "send_voice" ? [b.call.part.callId] : []));
  expect(inZoom).toEqual(inGroups);
  return inGroups;
}

describe("回放：发语音成功两轮、语音服务忙一轮（send-voice）", () => {
  const inputs = load("send-voice");
  const state = replay(inputs);
  const items = chatItems(state, "secretary");
  const voices = Object.values(state.agentVoices).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  test("发出了气泡的两轮只有气泡，没有「调用了 1 个工具」；没发出去的那一轮照常有那一行（和说明一起）", () => {
    expect(outline(items)).toEqual([
      "user",
      "voice:agent(send_voice)",
      "user",
      "voice:agent(send_voice)",
      "reply",
      "user",
      "system",
      "tool_group(send_voice)",
      "reply",
    ]);
    const failedGroup = items.find((it) => it.kind === "tool_group")!;
    expect(failedGroup.kind === "tool_group" && [failedGroup.keyLine, failedGroup.issues]).toEqual(["调用了 1 个工具：发语音（1 次出错）", [{ issue: "error", count: 1 }]]);
  });

  test("气泡和调用按语音对象上的工具调用 id 对上；挂着的调用不算进 N", () => {
    const agentVoices = items.filter((it): it is Extract<ChatItem, { kind: "voice" }> => it.kind === "voice" && it.speaker === "agent");
    expect(agentVoices.map((it) => [(it.part as TtsPart).voiceId, it.toolCall?.part.callId])).toEqual(voices.slice(0, 2).map((v) => [v.id, v.toolCallId]));
    expect(agentVoices.map((it) => it.toolCall?.counted)).toEqual([false, false]);
  });

  test("缩放各档不单独画发出了气泡的发语音，只画没发出去的那一次", () => {
    expect(drawnSendVoice(items)).toEqual([voices[2]!.toolCallId]);
  });

  test("从头一帧一帧回放：发出了气泡的那两轮任何时候都没有出现过那一行（合成中、合成好了、回合结束）；没发出去的那一轮调用记录到了才有", () => {
    const flashed: string[] = [];
    const failedCall = voices[2]!.toolCallId!;
    for (let i = 1; i <= inputs.length; i++) {
      const drawn = drawnSendVoice(chatItems(replay(inputs.slice(0, i)), "secretary"));
      for (const callId of drawn) if (callId !== failedCall) flashed.push(`第 ${i} 帧：${callId}`);
    }
    expect(flashed).toEqual([]);
    const callArrives = inputs.findIndex((x) => x.kind === "frame" && x.frame.type === "message" && JSON.stringify(x.frame.payload).includes(failedCall));
    expect(drawnSendVoice(chatItems(replay(inputs.slice(0, callArrives)), "secretary"))).toEqual([]);
    expect(drawnSendVoice(chatItems(replay(inputs.slice(0, callArrives + 1)), "secretary"))).toEqual([failedCall]);
  });

  test("气泡的「详情 ›」：送进 TTS 的原文，下面是发这条语音的那次调用（说人话的那句、守卫怎么判的、结果）；在对话中定位到气泡", () => {
    const bubble = items.find((it) => it.kind === "voice" && it.speaker === "agent")!;
    const detail = detailContent(state, items, { type: "item", id: bubble.id });
    expect(detail.kind).toBe("text");
    if (detail.kind !== "text") return;
    expect([detail.label, detail.text.split("\n")[0]]).toEqual(["语音回复", "明早九点开会，记得带上周报。"]);
    expect(detail.toolCall).toMatchObject({
      kind: "tool_call",
      itemId: bubble.id,
      position: undefined,
      call: { tool: "send_voice", callId: voices[0]!.toolCallId, sentence: "发语音：明早九点开会，记得带上周报。", outcome: "done", status: "已执行", executed: true, sentVoice: true, grant: "not_needed" },
    });
    expect(detail.toolCall?.call.result).toContain("已经把这段话合成语音发给用户了");
    // 挂着的那次调用不再算进"相关的内部调用"
    expect(detail.internalCalls).toEqual([]);
  });

  test("按调用的 id 也找得到：落在气泡上，打开是这次调用的详情（在对话中定位到气泡）", () => {
    const bubble = items.find((it) => it.kind === "voice" && it.speaker === "agent")!;
    const callId = bubble.kind === "voice" ? bubble.toolCall!.id : "";
    expect(locateChatItem(items, callId)?.item.id).toBe(bubble.id);
    const detail = detailContent(state, items, { type: "item", id: callId });
    expect(detail).toMatchObject({ kind: "tool_call", itemId: bubble.id, position: undefined, call: { tool: "send_voice", sentVoice: true } });
  });
});

describe("语音回复（用户发语音那一轮）的气泡照旧（voice-reply）", () => {
  test("详情里没有工具调用", () => {
    const state = replay(load("voice-reply"));
    const items = chatItems(state, "secretary");
    const agent = items.filter((it) => it.kind === "voice" && it.speaker === "agent");
    expect(agent.length).toBeGreaterThan(0);
    for (const it of agent) {
      expect(it.kind === "voice" && it.toolCall).toBeUndefined();
      const detail = detailContent(state, items, { type: "item", id: it.id });
      expect(detail.kind === "text" && detail.toolCall).toBeUndefined();
    }
  });
});

// ───────────────────────── 手写的边角 ─────────────────────────

const TIME = "2026-10-11T09:00:00.000+08:00";
const VOICE_ID = "av-tool";
const CALL_ID = "tool:1:send";
const PART: TtsPart = { type: "tts_audio", voiceId: VOICE_ID, mediaId: "c".repeat(64), mime: "audio/wav", durationMs: 2400, waveform: [20, 90, 40] };

function toolVoice(version: number, overrides: Partial<AgentVoiceRecord> = {}): AgentVoiceRecord {
  return {
    id: VOICE_ID,
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    turnSeq: 2,
    replyMessageIds: [],
    mode: "tool",
    toolCallId: CALL_ID,
    text: "好的，念给你听。",
    referenceVoice: { id: "v-sample", name: "示例音色" },
    status: "synthesizing",
    createdAt: TIME,
    updatedAt: TIME,
    version,
    ...overrides,
  };
}
const done = { status: "done" as const, mediaId: PART.mediaId, mime: "audio/wav", durationMs: 2400, waveform: PART.waveform, messageId: "m-voice" };

function call(callId: string, tool: string, argsSummary: string, outcome: ToolCallOutcome = "done", resultSummary?: string): ToolCallPart {
  return { type: "tool_call", callId, tool, argsSummary, categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome, ...(resultSummary ? { resultSummary } : {}) };
}
const message = (id: string, ...parts: MessagePart[]): MessageEnvelope => ({ id, conversation: "secretary", speaker: "agent", time: TIME, parts });
const SEND = call(CALL_ID, "send_voice", "text=好的，念给你听。", "done", "已经把这段话合成语音发给用户了（约 2 秒）");
const READ = call("tool:1:read", "read", "path=notes.md", "done", "12 行");

/** 用户打字、这一轮开始 */
const ask = [frame("secretary", 1, "message", { message: textMessage("m-user", "user", "看看笔记，念给我听") }), frame("secretary", 2, "turn_start", { inputMessageId: "m-user" })];
const items = (frames: readonly EventFrame[], from?: UiState) => chatItems(replay(frames, from), "secretary");

describe("手写的边角", () => {
  test("同一轮还调了别的工具：那一行只算别的（调用在气泡之前、之后都一样）", () => {
    const before = [
      ...ask,
      frame("secretary", 3, "message", { message: message("m-read", READ) }),
      frame("secretary", 4, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 5, "agent_voice", { voice: toolVoice(2, done) }),
      frame("secretary", 6, "message", { message: message("m-voice", PART) }),
      frame("secretary", 7, "message", { message: message("m-send", SEND) }),
    ];
    const one = items(before);
    expect(outline(one)).toEqual(["user", "tool_group(read)", "voice:agent(send_voice)"]);
    expect(one[1]!.keyLine).toBe("调用了 1 个工具：读文件");
    // 发语音的调用记录后面紧跟着又一次读文件（中间没有别的）：发语音不隔开、也不算进去
    const after = items([
      ...ask,
      frame("secretary", 3, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 4, "agent_voice", { voice: toolVoice(2, done) }),
      frame("secretary", 5, "message", { message: message("m-voice", PART) }),
      frame("secretary", 6, "message", { message: message("m-read", READ) }),
      frame("secretary", 7, "message", { message: message("m-send", SEND) }),
      frame("secretary", 8, "message", { message: message("m-read2", call("tool:1:read2", "read", "path=todo.md")) }),
    ]);
    expect(outline(after)).toEqual(["user", "voice:agent(send_voice)", "tool_group(read,read)"]);
  });

  test("没建出语音的发语音（太长、没有参考音色、语音轮里调用……）照常算进去，和别的调用在一行里", () => {
    const tooLong = call("tool:1:long", "send_voice", "text=……", "error", "太长了，没有发：念出来约 80 秒，缩到 60 秒以内再发");
    const got = items([...ask, frame("secretary", 3, "message", { message: message("m-read", READ) }), frame("secretary", 4, "message", { message: message("m-long", tooLong) })]);
    expect(outline(got)).toEqual(["user", "tool_group(read,send_voice)"]);
    // 语音轮里调用交回"已经在合成了"（不是出错）：没有工具发的语音对上它，照常显示
    const voiceTurn = call("tool:1:again", "send_voice", "text=好的", "done", "用户这一轮发的是语音，你的回复会由运行时合成语音发给用户（已经在合成了）");
    const whole = toolVoice(1, { id: "av-whole", mode: "whole", status: "replying", toolCallId: undefined });
    expect(outline(items([...ask, frame("secretary", 3, "agent_voice", { voice: whole }), frame("secretary", 4, "message", { message: message("m-again", voiceTurn) })]))).toEqual([
      "user",
      "tool_group(send_voice)",
    ]);
  });

  test("只发出去了一部分（partial）：也是发出了气泡，那一行不出，气泡上挂着这次调用；说明照常显示", () => {
    const got = items([
      ...ask,
      frame("secretary", 3, "agent_voice", { voice: toolVoice(1) }),
      frame("secretary", 4, "agent_voice", { voice: toolVoice(2, { ...done, status: "partial", error: "语音服务忙" }) }),
      frame("secretary", 5, "message", { message: message("m-voice", PART) }),
      frame("secretary", 6, "message", { message: { ...textMessage("m-note", "system", "这条语音只发出去了前面一部分（语音服务忙）。") } }),
      frame("secretary", 7, "message", { message: message("m-send", { ...SEND, resultSummary: "语音只发出去了前面一部分（约 2 秒；语音服务忙）" }) }),
    ]);
    expect(outline(got)).toEqual(["user", "voice:agent(send_voice)", "system"]);
  });

  test("等太久先交回（调用记录比气泡先到）：合成中不露出那一行；合成好了挂到后来的气泡上；没合成出来才露出", () => {
    const still = { ...SEND, resultSummary: "语音还在合成（排在别的语音后面，或者合成得慢）：合成好会自己出现在聊天里" };
    const synthesizing = [...ask, frame("secretary", 3, "agent_voice", { voice: toolVoice(1) }), frame("secretary", 4, "message", { message: message("m-send", still) })];
    expect(outline(items(synthesizing))).toEqual(["user"]);
    const sent = items([...synthesizing, frame("secretary", 5, "agent_voice", { voice: toolVoice(2, done) }), frame("secretary", 6, "message", { message: message("m-voice", PART) })]);
    expect(outline(sent)).toEqual(["user", "voice:agent(send_voice)"]);
    const failed = items([
      ...synthesizing,
      frame("secretary", 5, "agent_voice", { voice: toolVoice(2, { status: "failed", error: "语音服务没开" }) }),
      frame("secretary", 6, "message", { message: textMessage("m-note", "system", "这条语音没发出去（语音服务没开）。") }),
    ]);
    expect(outline(failed)).toEqual(["user", "tool_group(send_voice)", "system"]);
  });

  test("往上翻：一页正好只有那次调用（气泡在更早的一页），这一页带着它发出的语音——那次调用不单独显示；翻到更早的一页，挂到气泡上", () => {
    const closed = toolVoice(3, { ...done, coversReply: false });
    const live = replay([frame("secretary", 9, "message", { message: textMessage("m-later", "user", "谢谢") })]);
    const newer = replay(
      [{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [{ seq: 7, message: message("m-send", SEND) }], records: [], hasMore: true, agentVoices: [closed] } }],
      live,
    );
    expect(outline(chatItems(newer, "secretary"))).toEqual(["user"]);
    const older = replay(
      [
        {
          kind: "history_page",
          conversation: "secretary",
          page: { conversation: "secretary", messages: [{ seq: 1, message: textMessage("m-user", "user", "看看笔记，念给我听") }, { seq: 6, message: message("m-voice", PART) }], records: [], hasMore: false, agentVoices: [closed] },
        },
      ],
      newer,
    );
    expect(outline(chatItems(older, "secretary"))).toEqual(["user", "voice:agent(send_voice)", "user"]);
  });
});
