// agent 的语音自动播放（36 号票）：会话里新到一条 agent 的语音（合成完成），页面在前台、开着这个会话、设置里的开关开着，
// 就自动播放这一条；用户正按着"按住 说话"时不播，松手后再播。打开页面、翻历史、断线重连补发的旧语音不自动播。
// 新到的：合成完成的那一版 agent_voice 是实时推来的（连接把补发的帧标成 catchUp，见 app/ws-connection.ts），
// 不是往上翻取回的一页里带的。
import { describe, expect, test } from "vitest";
import { type AgentVoiceRecord, type AutoplayEnv, agentVoiceArrivals, agentVoiceAutoplay, autoplaySettingOf, type MessagePart, replay, type UiInput } from "../../src/state/index.ts";
import { frame } from "./events.ts";

type TtsPart = Extract<MessagePart, { type: "tts_audio" }>;
const PART: TtsPart = { type: "tts_audio", voiceId: "av-1", mediaId: "b".repeat(64), mime: "audio/wav", durationMs: 2800, waveform: [30, 100, 60] };

function agentVoice(version: number, overrides: Partial<AgentVoiceRecord> = {}): AgentVoiceRecord {
  return {
    id: "av-1",
    conversation: "secretary",
    scope: {},
    inputMessageId: "m-user",
    replyMessageIds: ["m-reply"],
    mode: "whole",
    text: "好的。",
    status: "synthesizing",
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    version,
    ...overrides,
  };
}

const synthesizing = (seq: number, catchUp = false): UiInput => ({ kind: "frame", frame: frame("secretary", seq, "agent_voice", { voice: agentVoice(1) }), ...(catchUp ? { catchUp } : {}) });
const done = (seq: number, catchUp = false, id = "av-1"): UiInput => ({
  kind: "frame",
  frame: frame("secretary", seq, "agent_voice", {
    voice: agentVoice(2, { id, status: "done", mediaId: PART.mediaId, mime: "audio/wav", durationMs: 2800, waveform: PART.waveform, messageId: `m-voice-${id}` }),
  }),
  ...(catchUp ? { catchUp } : {}),
});

describe("新到的 agent 语音", () => {
  test("合成完成的那一版是实时推来的：算新到的", () => {
    expect(agentVoiceArrivals(replay([synthesizing(1), done(2)]))).toEqual(["av-1"]);
  });

  test("打开页面、断线重连时补发的（连接标了 catchUp）：不算，哪怕合成中的那一版是之前实时收到的", () => {
    expect(agentVoiceArrivals(replay([synthesizing(1, true), done(2, true)]))).toEqual([]);
    expect(agentVoiceArrivals(replay([synthesizing(1), done(2, true)]))).toEqual([]);
  });

  test("往上翻取回的一页里带着合成好的语音：不算", () => {
    const state = replay([{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [], records: [], hasMore: false, agentVoices: [agentVoice(2, { status: "done", mediaId: PART.mediaId })] } }]);
    expect(agentVoiceArrivals(state)).toEqual([]);
  });

  test("同一版收到两次、合成好之后又来了新版本：只算一次；还在合成中的不算", () => {
    expect(agentVoiceArrivals(replay([synthesizing(1)]))).toEqual([]);
    const twice = replay([synthesizing(1), done(2), done(2)]);
    expect(agentVoiceArrivals(twice)).toEqual(["av-1"]);
  });

  test("界面决定过了（播了或者不播）就去掉；先后到的两条按到的顺序", () => {
    const state = replay([done(1, false, "av-1"), done(2, false, "av-2")]);
    expect(agentVoiceArrivals(state)).toEqual(["av-1", "av-2"]);
    expect(agentVoiceArrivals(replay([{ kind: "agent_voice_arrival_seen", voiceId: "av-1" }], state))).toEqual(["av-2"]);
  });

  test("重新同步这个会话（之后从头补发）：没决定的也清掉", () => {
    const state = replay([done(1)]);
    expect(agentVoiceArrivals(replay([{ kind: "resync", channel: "secretary" }], state))).toEqual([]);
  });
});

/** 都满足的样子：开关开着、页面在前台、开着秘书的会话、没在录音 */
const OK: AutoplayEnv = { enabled: true, foreground: true, openConversations: ["secretary"], recording: false };

describe("这条该不该自动播", () => {
  const live = replay([synthesizing(1), done(2)]);
  const caughtUp = replay([synthesizing(1, true), done(2, true)]);

  test.each<[string, Partial<AutoplayEnv>, ReturnType<typeof agentVoiceAutoplay>, ReturnType<typeof agentVoiceAutoplay>]>([
    // 名字、和 OK 不同的地方、新到的（实时推来）怎么办、补发的怎么办
    ["都满足", {}, "play", "skip"],
    ["设置里关了", { enabled: false }, "skip", "skip"],
    ["页面在后台", { foreground: false }, "skip", "skip"],
    ["开着的是别的会话", { openConversations: ["maintainer:pm-1"] }, "skip", "skip"],
    ["没开着任何会话（在看板、设置页上）", { openConversations: [] }, "skip", "skip"],
    ["正按着按住说话：松手后再播", { recording: true }, "after_recording", "skip"],
    ["正按着按住说话、开关又关着", { recording: true, enabled: false }, "skip", "skip"],
    ["正按着按住说话、页面在后台", { recording: true, foreground: false }, "skip", "skip"],
    ["宽屏上同时开着两个会话，其中一个是它", { openConversations: ["maintainer:pm-1", "secretary"] }, "play", "skip"],
  ])("%s", (_name, env, fresh, old) => {
    expect(agentVoiceAutoplay(live, "av-1", { ...OK, ...env })).toBe(fresh);
    expect(agentVoiceAutoplay(caughtUp, "av-1", { ...OK, ...env })).toBe(old);
  });

  test("往上翻取回的、没见过的语音：不播", () => {
    const state = replay([{ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages: [], records: [], hasMore: false, agentVoices: [agentVoice(2, { status: "done", mediaId: PART.mediaId })] } }]);
    expect(agentVoiceAutoplay(state, "av-1", OK)).toBe("skip");
    expect(agentVoiceAutoplay(live, "av-unknown", OK)).toBe("skip");
  });

  test("决定过了（播过、或者当时不播）就不再播；会话重新同步后拿掉的也不播", () => {
    expect(agentVoiceAutoplay(replay([{ kind: "agent_voice_arrival_seen", voiceId: "av-1" }], live), "av-1", OK)).toBe("skip");
    expect(agentVoiceAutoplay(replay([{ kind: "resync", channel: "secretary" }], live), "av-1", OK)).toBe("skip");
  });
});

describe("设置里的开关（按设备记住）", () => {
  test.each<[string | null, boolean]>([
    [null, true],
    ["off", false],
    ["on", true],
    ["不认识的值", true],
  ])("记住的是 %j：%s", (raw, enabled) => {
    expect(autoplaySettingOf(raw)).toBe(enabled);
  });
});
