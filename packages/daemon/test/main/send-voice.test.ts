// 主切面：用户打字时 agent 也能发语音气泡（86 号票，规格第 22 节"用户打字时也能发语音"）。
// 和用户直接对话的 agent 用"发语音"工具（send_voice）把一段口语稿合成成和语音回复一样的语音气泡：同一个合成服务、参考音色、
// 分段推送、入库、追加 tts_audio 消息、失败说明、重启重做——和语音回复共用 voice-synthesis.ts 那一半。
// 这一轮另写的文字照语音轮的规矩：普通的话收进气泡（coversReply），代码、表格、链接这类念不出来的照常显示。
// 用户发语音的那一轮调它返回"已经在合成了"；后台在做的任务、定时 / 事件触发的运行里用不了；失败时工具交回原因。
// 认"用户在说话的那一轮"看子进程收下、已经进了上下文的插话（宿主协议 16），送进去还排着的不算。
// 一轮里能发几条；没发出去的说明只说这一条没发出去（不说"这次只发文字"）。等合成最多等 sendVoiceWaitMs，等不完先交回"还在合成"。
// 守护进程被杀：语音重启后重做，agent 的会话里那次调用补上"会自己补发、不要重发"。
// 合成服务一律是假的（helpers/tts.ts，空闲端口）：不碰本机 8090 上的真服务、不占显卡。参考音色一律是编的示例。
import fs from "node:fs";
import path from "node:path";
import {
  agentVoiceCoversReply,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  CHANNELS,
  EVENT_TYPES,
  type EventTrigger,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type ResponseFrame,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { request, sha256Hex } from "../helpers/http.ts";
import { restartAfterKill, startKillableDaemon } from "../helpers/killable-daemon.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { maintainerScripts, RUNNING_TASK_ID, SECRETARY_BRIEFS, startRunningTask } from "../helpers/running-task.ts";
import {
  agentVoiceSettled,
  agentVoiceVersions,
  dataDirWithoutReferenceVoices,
  FAKE_SPEECH_BUSY,
  type FakeSpeechBehavior,
  fakeSpeechSeconds,
  importReferenceVoice,
  makeWav,
  SAMPLE_VOICE,
  startFakeSpeechService,
} from "../helpers/tts.ts";
import { sendVoice } from "../helpers/voice.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";

const SECRETARY = CHANNELS.secretary;
const TM1 = maintainerChannel("tm-1");
const TM2 = maintainerChannel("tm-2");
const { message: MESSAGE, turnStart: TURN_START, turnEnd: TURN_END } = EVENT_TYPES;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const sendVoiceCall = (text: string, before?: string): FauxStep => ({ kind: "reply", ...(before === undefined ? {} : { text: before }), toolCalls: [{ name: "send_voice", arguments: { text } }] });

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 会话里的消息（按到达顺序） */
function messages(frontend: TestFrontend, conversation: string = SECRETARY): MessageEnvelope[] {
  return frontend.events({ channel: conversation, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message);
}

/** agent 发的、有文字的消息 */
const agentTextMessages = (frontend: TestFrontend, conversation: string = SECRETARY) => messages(frontend, conversation).filter((m) => m.speaker === "agent" && textOf(m.parts) !== "");

/** 会话里的发语音调用记录（结束了的，按先后） */
const sendVoiceCalls = (frontend: TestFrontend, conversation: string = SECRETARY): ToolCallPart[] =>
  messages(frontend, conversation).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call" && p.tool === "send_voice"));

/** 等第 n 次发语音调用结束，交回它的调用记录 */
async function finishedSendVoice(frontend: TestFrontend, n = 1, conversation: string = SECRETARY): Promise<ToolCallPart> {
  await waitUntil(() => sendVoiceCalls(frontend, conversation).length >= n, { timeoutMs: 30_000, describe: () => JSON.stringify(sendVoiceCalls(frontend, conversation)) });
  return sendVoiceCalls(frontend, conversation)[n - 1]!;
}

/** 会话里的语音消息 */
const ttsMessages = (frontend: TestFrontend, conversation: string = SECRETARY) => messages(frontend, conversation).filter((m) => m.parts.some((p) => p.type === "tts_audio"));

/** 会话里的系统说明 */
const notes = (frontend: TestFrontend, conversation: string = SECRETARY) =>
  messages(frontend, conversation)
    .filter((m) => m.speaker === "system")
    .map((m) => textOf(m.parts));

/** 会话频道上落盘事件的类型，按序号（agent 语音带上状态） */
function channelTypes(frontend: TestFrontend, conversation: string = SECRETARY): string[] {
  return frontend
    .events({ channel: conversation, persistedOnly: true })
    .map((f) => (f.type === EVENT_TYPES.agentVoice ? `agent_voice:${(f.payload as AgentVoiceEventPayload).voice.status}` : f.type));
}

async function turnEnds(frontend: TestFrontend, count: number, conversation: string = SECRETARY): Promise<void> {
  await waitUntil(() => frontend.events({ channel: conversation, type: TURN_END }).length >= count, { timeoutMs: 30_000, describe: () => channelTypes(frontend, conversation).join(" ") });
}

/** 这条工具发的语音回合结束时定下的那一版（这一轮另写的文字收不收进气泡） */
async function closedVoice(frontend: TestFrontend, voiceId?: string): Promise<AgentVoiceRecord> {
  const found = () => agentVoiceVersions(frontend, voiceId).find((v) => v.mode === "tool" && v.coversReply !== undefined);
  await waitUntil(() => found() !== undefined, { timeoutMs: 30_000, describe: () => JSON.stringify(agentVoiceVersions(frontend).map((v) => [v.status, v.coversReply])) });
  return found()!;
}

/** 请求成功就拿到结果，失败就抛出 */
function ok(r: ResponseFrame): unknown {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.result;
}

async function connect(url: string, channels: string[] = [SECRETARY, CHANNELS.inbox]): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 一句短的口语稿：一段合成完 */
const SHORT = "明早九点开会，记得带上周报。";
/** 会切成 4 段的口语稿（念出来约 10 秒）：第一段按逗号切短，之后一句一段 */
const SEGMENTED = "好的，我把这周的周报整理好了，下面分几块说清楚。第一块是进度，基本按计划走。第二块是风险，主要在测试环境。";
const SEGMENTS = ["好的，我把这周的周报整理好了，", "下面分几块说清楚。", "第一块是进度，基本按计划走。", "第二块是风险，主要在测试环境。"];

describe("用户打字，个人助理发语音", () => {
  it("用户打字让个人助理念一句话：聊天里出现语音气泡（能播放、有波形和时长、用当前参考音色），语音对象建全；守卫不弹审批；这一轮普通的文字收进气泡", async () => {
    const tts = await startFakeSpeechService();
    const logs: string[] = [];
    const { url, daemon } = await startTestDaemon({ secretary: [sendVoiceCall(SHORT), say("好的，念给你听了。")], speechUrl: tts.url, log: (line) => logs.push(line) });
    const reference = await importReferenceVoice(url);
    const frontend = await connect(url);
    const sent = await frontend.sendText("念给我听：明早九点开会");
    await turnEnds(frontend, 1);

    const done = await agentVoiceSettled(frontend, "done");
    const turnStart = frontend.events({ channel: SECRETARY, type: TURN_START })[0]!;
    const wav = makeWav(fakeSpeechSeconds(SHORT));
    expect(done).toMatchObject({
      conversation: SECRETARY,
      scope: {},
      inputMessageId: sent.messageId,
      turnSeq: turnStart.seq,
      replyMessageIds: [],
      mode: "tool",
      text: SHORT,
      referenceVoice: { id: reference.id, name: SAMPLE_VOICE.name },
      model: "fish_audio（audio.cpp/tts）",
      status: "done",
      mediaId: sha256Hex(wav),
      mime: "audio/wav",
      durationMs: Math.round(fakeSpeechSeconds(SHORT) * 1000),
      segmentCount: 1,
    });
    expect(done.waveform).toHaveLength(32);
    expect(done).not.toHaveProperty("coversReply");
    // 合成完成时同一事务追加新版本和载着它的消息（agent 一侧的语音气泡），在这一轮里（回合结束之前）
    const voiceMessage = messages(frontend).find((m) => m.id === done.messageId)!;
    expect(voiceMessage.speaker).toBe("agent");
    expect(voiceMessage.parts).toEqual([{ type: "tts_audio", voiceId: done.id, mediaId: done.mediaId, mime: "audio/wav", durationMs: done.durationMs, waveform: done.waveform }]);
    const types = channelTypes(frontend);
    expect(types.indexOf("agent_voice:done")).toBeLessThan(types.indexOf(TURN_END));
    expect(types.indexOf("agent_voice:synthesizing")).toBeGreaterThan(types.indexOf(TURN_START));

    // 回合结束时照语音轮的规矩定：这一轮另写的是普通的话（念得出来、念得完）→ 收进气泡，长按"转文字"时接在原文后面
    const closed = await closedVoice(frontend);
    const extra = agentTextMessages(frontend);
    expect(extra.map((m) => textOf(m.parts))).toEqual(["好的，念给你听了。"]);
    expect(closed).toMatchObject({ id: done.id, status: "done", coversReply: true, replyMessageIds: [extra[0]!.id] });
    expect(agentVoiceCoversReply(closed)).toBe(true);
    expect(agentVoiceVersions(frontend).map((v) => `${v.mode}:${v.status}:${v.coversReply ?? "-"}`)).toEqual(["tool:synthesizing:-", "tool:done:-", "tool:done:true"]);
    expect(channelTypes(frontend).slice(channelTypes(frontend).indexOf(TURN_END))).toEqual([TURN_END, "agent_voice:done"]);

    // 工具交回 agent 的结果：发出去了、多长；守卫照常判定，不落入任何关注类别，不弹审批
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall).toMatchObject({ outcome: "done", categoryTitles: [] });
    expect(toolCall.resultSummary).toContain("已经把这段话合成语音发给用户了");
    expect(daemon.inbox.list().filter((i) => i.kind !== "notice")).toEqual([]);

    // 合成请求：audio.cpp 的接口，参考录音和逐字稿同时给；合成出的音频入库，按音频直接播放
    expect(tts.requests.map((r) => r.input)).toEqual([SHORT]);
    expect(tts.requests[0]).toMatchObject({ model: "tts", referenceText: SAMPLE_VOICE.referenceText });
    expect(tts.requests[0]!.voiceRef).toBe(path.join(daemon.layout.voices, reference.id, "reference.wav"));
    const audio = await request(url, HTTP_PATHS.media(done.mediaId!));
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.body).toEqual(wav);
    // 历史分页带上它（转文字看得到送进 TTS 的原文）
    expect((await frontend.history(SECRETARY)).agentVoices).toEqual([closed]);
    // 87 号票：分页正好切在气泡和发语音的调用记录之间时，只有调用记录的那一页也带上它建出的语音（前端据此认出这次调用发出了气泡、不单独显示）
    const callSeq = frontend.events({ channel: SECRETARY, type: MESSAGE }).find((f) => (f.payload as MessageEventPayload).message.parts.some((p) => p.type === "tool_call" && p.tool === "send_voice"))!.seq;
    const callOnly = await frontend.history(SECRETARY, { before: callSeq + 1, limit: 1 });
    expect(callOnly.messages.map((m) => m.seq)).toEqual([callSeq]);
    expect(callOnly.agentVoices).toEqual([closed]);

    // 日志只写字数、参考音色的 id、参考录音的文件名：不写正文、不写参考录音的完整路径
    const toolLog = logs.find((l) => l.includes("发语音工具"))!;
    expect(toolLog).toContain(`${[...SHORT].length} 字`);
    expect(toolLog).toContain(`参考音色 ${reference.id}（reference.wav）`);
    expect(logs.join("\n")).not.toContain(SHORT);
    expect(logs.join("\n")).not.toContain(daemon.layout.voices);
  });

  it("长一点的分段合成：第一段合成好就推（工具还在等、这一轮还没结束），全部完成后拼成一条；工具等到完成才交回结果", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall(SEGMENTED), say("就这些。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("把这周的周报用语音讲一下");

    await waitUntil(() => tts.held === 1);
    expect(tts.requests.map((r) => r.input)).toEqual([SEGMENTS[0]]);
    tts.releaseNext();
    const first = () => agentVoiceVersions(frontend).find((v) => v.status === "synthesizing" && v.segments?.length === 1);
    await waitUntil(() => first() !== undefined, { timeoutMs: 20_000 });
    expect(first()).toMatchObject({ mode: "tool", segmentCount: 4, segments: [{ durationMs: 3000, offsetMs: 0 }] });
    // 第一段的音频照常能取（前端边收边播）；这时工具还在等，这一轮还没结束
    expect((await request(url, HTTP_PATHS.agentVoiceSegment(first()!.id, 0))).status).toBe(200);
    expect(sendVoiceCalls(frontend)).toEqual([]);
    expect(frontend.events({ channel: SECRETARY, type: TURN_END })).toEqual([]);
    for (let i = 1; i < SEGMENTS.length; i++) {
      await waitUntil(() => tts.held === 1);
      tts.releaseNext();
    }
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ segmentCount: 4, durationMs: 3000 + 1800 + 2800 + 3000 + 200 * 3, text: SEGMENTED });
    expect(tts.requests.map((r) => r.input)).toEqual(SEGMENTS);
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall.resultSummary).toContain("约 11.2 秒");
    await turnEnds(frontend, 1);
  });

  it("这一轮另写的文字带代码、表格或链接：照常显示（不收进气泡）；没写别的文字的也不收", async () => {
    const tts = await startFakeSpeechService();
    const table = "| 时间 | 事项 |\n| --- | --- |\n| 09:00 | 开会 |";
    const { url } = await startTestDaemon({
      secretary: [sendVoiceCall(SHORT), say(`明天的安排：\n${table}`), sendVoiceCall("好的，链接发给你了。", "文档在这里：https://example.com/docs"), say("就这些。"), sendVoiceCall("收到。"), { kind: "reply" }],
      speechUrl: tts.url,
    });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("用语音念一下明天的安排");
    await turnEnds(frontend, 1);
    const withTable = await closedVoice(frontend);
    expect(withTable).toMatchObject({ coversReply: false, replyMessageIds: agentTextMessages(frontend).map((m) => m.id) });
    expect(agentVoiceCoversReply(withTable)).toBe(false);

    // 链接写在调用之前的那条消息里：同一轮的文字一起算
    await frontend.sendText("把文档链接发我，再用语音说一声");
    await turnEnds(frontend, 2);
    const ids = agentVoiceVersions(frontend).filter((v) => v.version === 1).map((v) => v.id);
    const withLink = await closedVoice(frontend, ids[1]);
    expect(withLink.coversReply).toBe(false);
    expect(withLink.replyMessageIds).toHaveLength(2);

    // 只发了语音、没写别的文字：没有要收的
    await frontend.sendText("说一声收到");
    await turnEnds(frontend, 3);
    const only = await closedVoice(frontend, agentVoiceVersions(frontend).filter((v) => v.version === 1)[2]!.id);
    expect(only).toMatchObject({ coversReply: false, replyMessageIds: [] });
  });
});

describe("一轮里发几条", () => {
  it("连着发两条都发出去了：两个气泡按先后；这一轮另写的普通的话收进最后一条（记在最后一条上），前一条只有它自己的原文", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall("第一件事，明早九点开会。"), sendVoiceCall("第二件事，下午交周报。"), say("就这两件。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("用语音说说明天的两件事");
    await turnEnds(frontend, 1);
    const ids = agentVoiceVersions(frontend)
      .filter((v) => v.version === 1)
      .map((v) => v.id);
    expect(ids).toHaveLength(2);
    const [first, second] = [await closedVoice(frontend, ids[0]), await closedVoice(frontend, ids[1])];
    const extra = agentTextMessages(frontend);
    expect(extra.map((m) => textOf(m.parts))).toEqual(["就这两件。"]);
    expect(first).toMatchObject({ status: "done", text: "第一件事，明早九点开会。", coversReply: true, replyMessageIds: [] });
    expect(second).toMatchObject({ status: "done", text: "第二件事，下午交周报。", coversReply: true, replyMessageIds: [extra[0]!.id] });
    // 两个气泡按先后，各有各的语音消息；两次调用都交回发出去了
    expect(ttsMessages(frontend).map((m) => (m.parts[0] as { voiceId: string }).voiceId)).toEqual(ids);
    expect(sendVoiceCalls(frontend).map((p) => p.outcome)).toEqual(["done", "done"]);
    expect(tts.requests.map((r) => r.input)).toEqual(["第一件事，明早九点开会。", "第二件事，下午交周报。"]);
    expect(notes(frontend)).toEqual([]);
  });

  it("前一条没发出去、后一条发出去了：会话里的说明只说那一条没发出去和原因（不说只发文字，和后面的气泡不矛盾），另写的话收进发出去的那条", async () => {
    const tts = await startFakeSpeechService();
    tts.script(FAKE_SPEECH_BUSY, "ok");
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall(SHORT), sendVoiceCall("再试一次：明早九点开会。"), say("这次发出去了。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("念给我听：明早九点开会");
    await turnEnds(frontend, 1);
    const [failedCall, doneCall] = sendVoiceCalls(frontend);
    expect(failedCall).toMatchObject({ outcome: "error", resultSummary: "语音没发出去：语音服务忙。照常用文字回复用户。" });
    expect(doneCall!.resultSummary).toContain("已经把这段话合成语音发给用户了");
    expect(notes(frontend)).toEqual(["这条语音没发出去（语音服务忙）。"]);
    expect(notes(frontend).join("")).not.toContain("只发文字");
    const ids = agentVoiceVersions(frontend)
      .filter((v) => v.version === 1)
      .map((v) => v.id);
    const [failed, sent] = [await closedVoice(frontend, ids[0]), await closedVoice(frontend, ids[1])];
    expect(failed).toMatchObject({ status: "failed", coversReply: false, replyMessageIds: [] });
    expect(sent).toMatchObject({ status: "done", coversReply: true, replyMessageIds: agentTextMessages(frontend).map((m) => m.id) });
    expect(ttsMessages(frontend)).toHaveLength(1);
    // 说明在发出去的那条气泡之前（按发生的先后）
    const order = messages(frontend).flatMap((m) => (m.speaker === "system" ? ["note"] : m.parts.some((p) => p.type === "tts_audio") ? ["tts"] : []));
    expect(order).toEqual(["note", "tts"]);
  });
});

describe("等合成等太久", () => {
  it("排队、合成得慢，超过最多等的时间：工具先交回「还在合成」（不中止这一轮），语音照样合成，合成好自己出现在聊天里；另写的话照规矩收进气泡", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall(SHORT), say("好的，念给你听。")], speechUrl: tts.url, sendVoiceWaitMs: 500 });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("念给我听：明早九点开会");
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall).toMatchObject({ outcome: "done", resultSummary: "语音还在合成（排在别的语音后面，或者合成得慢）：合成好会自己出现在聊天里，不要重发，接着做别的就行。" });
    await turnEnds(frontend, 1);
    // 回合结束时语音还在合成：马上定下这一轮另写的话收进气泡
    const closed = await closedVoice(frontend);
    expect(closed).toMatchObject({ status: "synthesizing", coversReply: true });
    expect(ttsMessages(frontend)).toEqual([]);
    await waitUntil(() => tts.held === 1);
    tts.releaseNext();
    const done = await agentVoiceSettled(frontend, "done");
    // 合成那边在最新的一版上接着写：回合结束时定的不被冲掉
    expect(done).toMatchObject({ id: closed.id, coversReply: true, replyMessageIds: agentTextMessages(frontend).map((m) => m.id) });
    expect(agentVoiceCoversReply(done)).toBe(true);
    expect(ttsMessages(frontend)).toHaveLength(1);
    const types = channelTypes(frontend);
    expect(types.indexOf(TURN_END)).toBeLessThan(types.indexOf("agent_voice:done"));
  });
});

describe("发不出去：工具交回原因，不出空气泡", () => {
  it.each<[string, FakeSpeechBehavior | "closed", RegExp, Record<string, unknown>?]>([
    ["服务没开", "closed", /^语音合成服务没开（/],
    ["服务忙（503）", FAKE_SPEECH_BUSY, /^语音服务忙$/],
    ["合成超时", "hang", /^语音合成超时/, { voice: { speech: { timeout: { baseSeconds: 0.3, coldStartSeconds: 0.3, perSpeechSecond: 0.1 } } } }],
    ["回的不是 WAV", { wav: Buffer.from("这不是一段 WAV") }, /^语音合成服务回的不是能播放的 WAV$/],
  ])("%s：语音对象记成失败、会话里一条说明，工具交回原因（agent 照常发文字说明），没有语音消息", async (_name, behavior, reason, config) => {
    const tts = await startFakeSpeechService();
    if (behavior === "closed") await tts.close();
    else tts.behave(behavior);
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall(SHORT), say("语音没发出去，我用文字说：明早九点开会。")], speechUrl: tts.url, ...(config ? { config } : {}) });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("念给我听：明早九点开会");
    const failed = await agentVoiceSettled(frontend, "failed", 1, 30_000);
    expect(failed.error).toMatch(reason);
    expect(failed).not.toHaveProperty("mediaId");
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall.outcome).toBe("error");
    expect(toolCall.resultSummary).toBe(`语音没发出去：${failed.error}。照常用文字回复用户。`);
    await turnEnds(frontend, 1);
    expect(ttsMessages(frontend)).toEqual([]);
    // 会话里的说明只说这条语音没发出去和原因（用户 2026-10-11 定：不说"这次只发文字"）
    expect(notes(frontend)).toEqual([`这条语音没发出去（${failed.error}）。`]);
    expect(agentTextMessages(frontend).map((m) => textOf(m.parts))).toEqual(["语音没发出去，我用文字说：明早九点开会。"]);
    // 没合成出来的：这一轮的文字照常显示（没有气泡可收）
    const closed = await closedVoice(frontend);
    expect(closed).toMatchObject({ status: "failed", coversReply: false });
    expect(agentVoiceCoversReply(closed)).toBe(false);
  });

  it("合成出来了但存不进媒体库：同样记成失败，工具交回原因", async () => {
    const tts = await startFakeSpeechService();
    const wav = makeWav(2);
    tts.behave({ wav });
    const { url, daemon } = await startTestDaemon({ secretary: [sendVoiceCall(SHORT), say("没发出去。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    fs.mkdirSync(path.join(daemon.layout.media, sha256Hex(wav)), { recursive: true });
    const frontend = await connect(url);
    await frontend.sendText("念给我听");
    const failed = await agentVoiceSettled(frontend, "failed");
    expect(failed.error).toMatch(/^合成出的语音存不进去：/);
    expect((await finishedSendVoice(frontend)).resultSummary).toContain("语音没发出去：合成出的语音存不进去：");
    expect(ttsMessages(frontend)).toEqual([]);
  });

  it("分段合成到一半服务忙：照语音轮的 partial 规矩（推出去的段拼成一条、会话里一条说明，文字照常显示），工具交回只发了一部分", async () => {
    const tts = await startFakeSpeechService();
    tts.script("ok", "ok", FAKE_SPEECH_BUSY);
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall(SEGMENTED), say("后面的我用文字补上。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("用语音讲讲周报");
    const partial = await agentVoiceSettled(frontend, "partial", 1, 30_000);
    expect(partial).toMatchObject({ mode: "tool", error: "语音服务忙", segmentCount: 4, durationMs: 3000 + 200 + 1800 });
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall.resultSummary).toBe("语音只发出去了前面一部分（约 5 秒；语音服务忙）。后面没念到的内容要让用户知道的话，照常用文字发。");
    await turnEnds(frontend, 1);
    expect(ttsMessages(frontend)).toHaveLength(1);
    expect(notes(frontend)).toEqual(["这条语音只发出去了前面一部分（语音服务忙）。"]);
    expect(agentVoiceCoversReply(await closedVoice(frontend))).toBe(false);
  });

  it("没有任何参考音色：工具交回原因（不静默改走文字），待我处理里提示去导入（开着的只有一条），不建语音对象、不合成", async () => {
    const tts = await startFakeSpeechService();
    const { url, daemon } = await startTestDaemon({ reuse: dataDirWithoutReferenceVoices(), secretary: [sendVoiceCall(SHORT), say("还没有参考音色，我用文字说。"), sendVoiceCall(SHORT), say("同上。")], speechUrl: tts.url });
    const frontend = await connect(url);
    await frontend.sendText("念给我听");
    await turnEnds(frontend, 1);
    await frontend.sendText("再念一次");
    await turnEnds(frontend, 2);
    const results = sendVoiceCalls(frontend).map((p) => [p.outcome, p.resultSummary]);
    const reason = "还没有参考音色（用户要先在设置 · 语音里导入一段参考录音），这次发不了语音，已经在待我处理里提示用户去导入；照常用文字回复。";
    expect(results).toEqual([
      ["error", reason],
      ["error", reason],
    ]);
    const missing = daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "voice_reference_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ title: "要合成语音，得先导入参考音色", actions: ["去导入参考音色", "知道了"], archived: false });
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
    await importReferenceVoice(url);
    await waitUntil(() => daemon.inbox.list().find((i) => i.kind === "notice" && i.notice === "voice_reference_missing")?.archived === true);
  });

  it("太长（超过 voice.reply.maxSeconds）：交回「太长了，缩到 N 秒以内」，工具里不截、不合成；有念不出来的内容（链接、代码）的让它去掉", async () => {
    const tts = await startFakeSpeechService();
    const long = "这份周报我整理好了，下面分几块说清楚。".repeat(20);
    const { url } = await startTestDaemon({
      secretary: [sendVoiceCall(long), sendVoiceCall("周报整理好了，一共三块。"), say("发了。"), sendVoiceCall("详情见 https://example.com/report"), say("好。")],
      speechUrl: tts.url,
      config: { voice: { reply: { maxSeconds: 30 } } },
    });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await frontend.sendText("用语音念一下周报");
    await turnEnds(frontend, 1);
    const [tooLong, shortened] = sendVoiceCalls(frontend);
    expect(tooLong).toMatchObject({ outcome: "error" });
    expect(tooLong!.resultSummary).toBe("太长了，没有发：念出来约 76 秒，缩到 30 秒以内（大约 135 个字）再发，放不下就分几次发。");
    expect(shortened!.resultSummary).toContain("已经把这段话合成语音发给用户了");
    // 只合成了缩短后的那段
    expect(tts.requests.map((r) => r.input)).toEqual(["周报整理好了，一共三块。"]);

    await frontend.sendText("把报告链接念给我");
    await turnEnds(frontend, 2);
    expect(sendVoiceCalls(frontend)[2]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("念不出来的内容，没有发") });
    expect(tts.requests).toHaveLength(1);
  });
});

describe("谁能用", () => {
  it("用户发语音的那一轮调它：直接交回「已经在合成了」，语音回复照常（整段合成），不多出一条语音", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({ secretary: [sendVoiceCall("好的，明早九点提醒你。"), say("好的，明早九点提醒你。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await connect(url);
    await sendVoice(frontend, url, { text: "明天早上九点提醒我" });
    const done = await agentVoiceSettled(frontend, "done");
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall).toMatchObject({ outcome: "done" });
    expect(toolCall.resultSummary).toBe("用户这一轮发的是语音，你的回复会由运行时合成语音发给用户（已经在合成了），不用再发语音；照常回复就行。");
    // 语音回复照常：回复中 → 整段合成 → 完成，只有这一条
    expect(agentVoiceVersions(frontend).map((v) => `${v.mode ?? "-"}:${v.status}`)).toEqual(["-:replying", "whole:synthesizing", "whole:done"]);
    expect(done).toMatchObject({ mode: "whole", text: "好的，明早九点提醒你。" });
    expect(tts.requests.map((r) => r.input)).toEqual(["好的，明早九点提醒你。"]);
  });

  it("用户发语音、但还没有参考音色：语音回复其实没在合成，交回「没有参考音色」（不说已经在合成了），待我处理里只有一条提示", async () => {
    const tts = await startFakeSpeechService();
    const { url, daemon } = await startTestDaemon({ reuse: dataDirWithoutReferenceVoices(), secretary: [sendVoiceCall("好的，明早九点提醒你。"), say("好的，明早九点提醒你。")], speechUrl: tts.url });
    const frontend = await connect(url);
    await sendVoice(frontend, url, { text: "明天早上九点提醒我" });
    const toolCall = await finishedSendVoice(frontend);
    expect(toolCall).toMatchObject({
      outcome: "error",
      resultSummary: "还没有参考音色（用户要先在设置 · 语音里导入一段参考录音），这次发不了语音，已经在待我处理里提示用户去导入；照常用文字回复。",
    });
    await turnEnds(frontend, 1);
    const missing = daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "voice_reference_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ title: "要合成语音，得先导入参考音色" });
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
  });

  it("用户直接跟项目维护者说话：一样能发，语音消息带上所属的项目", async () => {
    const tts = await startFakeSpeechService();
    const { url, daemon } = await startTestDaemon({ maintainer: [sendVoiceCall("上个月的流水导进来了。"), say("好了。")], speechUrl: tts.url });
    await importReferenceVoice(url);
    const project = seedProject(daemon, "家庭账本");
    const pm = maintainerChannel(project.maintainerId);
    const frontend = await connect(url, [pm]);
    const sent = await frontend.sendText("导完用语音跟我说一声", { conversation: pm });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ conversation: pm, scope: { projectId: project.id }, inputMessageId: sent.messageId, mode: "tool", text: "上个月的流水导进来了。" });
    const event = frontend.events({ channel: pm, type: MESSAGE }).find((f) => (f.payload as MessageEventPayload).message.id === done.messageId)!;
    expect(event.payload).toMatchObject({ projectId: project.id, message: { speaker: "agent", parts: [{ type: "tts_audio", voiceId: done.id }] } });
    expect((await finishedSendVoice(frontend, 1, pm)).categoryTitles).toEqual([]);
  });

  it("后台在做的任务里用不了；用户在任务详情里说话（维护者在忙，排队，144 号票）：这一轮里还不算，这一轮做完交出去、下一轮能用", async () => {
    const tts = await startFakeSpeechService();
    // 第二步一次调两个工具：先跑 sleep，再发语音——用户在 sleep 时说的话排着队（这一轮做完才交给它）
    const sleepThenVoice: FauxStep = {
      kind: "reply",
      toolCalls: [
        { name: "bash", arguments: { command: "sleep 3" } },
        { name: "send_voice", arguments: { text: "命令跑完了。" } },
      ],
    };
    const td = await startTestDaemon({
      secretary: SECRETARY_BRIEFS,
      maintainer: (_id, n) => maintainerScripts([sendVoiceCall("开始整理笔记了。"), sleepThenVoice, say("接着整理。"), sendVoiceCall("好的，我先写结论部分。"), say("写好了。")])[n - 1] ?? [],
      speechUrl: tts.url,
    });
    await importReferenceVoice(td.url);
    const frontend = await connect(td.url, [CHANNELS.board, CHANNELS.cards, TM1]);
    await startRunningTask(frontend);
    // 执行开始的那一轮是运行时的通知引起的：后台在做，发不了
    const background = await finishedSendVoice(frontend, 1, TM1);
    expect(background).toMatchObject({ outcome: "error" });
    expect(background.resultSummary).toBe("这一轮不是用户在和你直接说话（是后台在做的任务、定时或事件触发的运行、运行时的通知），发不了语音；要告诉用户的照常写文字。");
    // 它在跑 sleep 时用户在任务详情里说了一句：排进队
    await new Promise((r) => setTimeout(r, 1000));
    const asked = await frontend.sendText("先写结论部分，写好用语音跟我说", { conversation: TM1 });
    expect(asked.queued).toBe(true);
    // 这一轮里紧跟着的发语音：用户的话还排着（模型还没看到用户说话），不算用户在说话的那一轮
    expect(await finishedSendVoice(frontend, 2, TM1)).toMatchObject({ outcome: "error", resultSummary: background.resultSummary });
    // 这一轮做完，排着的那句交出去作为下一轮：这一轮能发
    const done = await agentVoiceSettled(frontend, "done", 1, 30_000);
    expect(done).toMatchObject({ conversation: TM1, inputMessageId: asked.messageId, mode: "tool", text: "好的，我先写结论部分。", scope: { taskId: RUNNING_TASK_ID } });
    expect((await finishedSendVoice(frontend, 3, TM1)).resultSummary).toContain("已经把这段话合成语音发给用户了");
    expect(tts.requests.map((r) => r.input)).toEqual(["好的，我先写结论部分。"]);
  }, 60_000);

  it("定时触发、事件触发的运行和后台的普通任务里用不了：交回原因，不合成", async () => {
    const tts = await startFakeSpeechService();
    const clock = new ManualClock(new Date(2026, 9, 8, 8, 0));
    const td = await startTestDaemon({
      clock,
      secretary: [say("好"), say("好"), say("好")],
      maintainer: (id) => [sendVoiceCall(`${id} 做完了。`), say(`${id} 做完了`)],
      speechUrl: tts.url,
    });
    await importReferenceVoice(td.url);
    const frontend = await connect(td.url, [CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1, TM2, maintainerChannel("tm-3")]);
    const jobs = () => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
    // 事件触发：t-2（后台的普通任务）做完时跑一次 tm-1
    const trigger: EventTrigger = { kind: "event", source: "ergo", events: ["task_done"], filter: { taskId: "t-2" } };
    ok(await frontend.startTask("整理桌面做完了就检查一遍\n看看桌面齐不齐", "k-after", [], "plain", trigger));
    await waitUntil(() => jobs().some((e) => e.change === "registered"));
    await waitUntil(() => td.daemon.eventTriggers.subscriptions().length >= 1);
    ok(await frontend.startTask("整理一下桌面", "k-desk", [], "plain"));
    await waitUntil(() => jobs().some((e) => e.change === "run_finished" && e.run?.runId === "j-1-r1"), { timeoutMs: 60_000 });
    // 定时触发：每天 09:00 跑一次 tm-3
    ok(await frontend.startTask("每天早上出简报\n汇总昨天的新闻", "k-daily", [], "plain", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
    await waitUntil(() => jobs().filter((e) => e.change === "registered").length >= 2);
    clock.advanceTo(new Date(2026, 9, 8, 9, 0));
    await waitUntil(() => jobs().some((e) => e.change === "run_finished" && e.run?.runId === "j-2-r1"), { timeoutMs: 60_000 });
    await waitUntil(() => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.task }).some((f) => (f.payload as TaskEventPayload).task.id === "t-2" && (f.payload as TaskEventPayload).task.state === "done"));

    for (const channel of [TM2, TM1, maintainerChannel("tm-3")]) {
      const toolCall = await finishedSendVoice(frontend, 1, channel);
      expect({ channel, outcome: toolCall.outcome, result: toolCall.resultSummary }).toEqual({
        channel,
        outcome: "error",
        result: "这一轮不是用户在和你直接说话（是后台在做的任务、定时或事件触发的运行、运行时的通知），发不了语音；要告诉用户的照常写文字。",
      });
    }
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
  }, 120_000);
});

describe("守护进程在合成途中停了", () => {
  it("重启后照语音轮的规矩重做（推过的段收回，从第一段重新合成），不算中断不确定；那一轮被打断，另写的文字照常显示", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const first = await startTestDaemon({ secretary: [sendVoiceCall(SEGMENTED), say("就这些。")], speechUrl: tts.url });
    await importReferenceVoice(first.url);
    const frontend = await connect(first.url);
    await frontend.sendText("把这周的周报用语音讲一下");
    await waitUntil(() => tts.held === 1);
    tts.releaseNext();
    await waitUntil(() => agentVoiceVersions(frontend).some((v) => v.segments?.length === 1), { timeoutMs: 20_000 });
    await waitUntil(() => tts.held === 1);
    const pushed = agentVoiceVersions(frontend).at(-1)!;
    await frontend.close();
    await first.daemon.stop();

    tts.behave("ok");
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir }, speechUrl: tts.url });
    const again = await connect(second.url);
    const done = await agentVoiceSettled(again, "done");
    expect(done).toMatchObject({ id: pushed.id, mode: "tool", text: SEGMENTED, segmentCount: 4, coversReply: false });
    expect(tts.requests.map((r) => r.input)).toEqual([SEGMENTS[0], SEGMENTS[1], ...SEGMENTS]);
    // 重启时先定下那一轮另写的文字照常显示，再收回推过的段、一段一段重推
    const after = agentVoiceVersions(again).filter((v) => v.version > pushed.version);
    expect(after.map((v) => [v.status, v.segments?.length ?? 0, v.coversReply])).toEqual([
      ["synthesizing", 1, false],
      ["synthesizing", 0, false],
      ["synthesizing", 1, false],
      ["synthesizing", 2, false],
      ["synthesizing", 3, false],
      ["done", 4, false],
    ]);
    expect(ttsMessages(again)).toHaveLength(1);
    // 不当成"中断不确定"：待我处理里没有那种事项（语音由合成那边重做）
    expect(second.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "interrupted")).toEqual([]);
  }, 60_000);
});

describe("守护进程被直接杀掉", () => {
  it("工具在等合成时被杀（LSM 重启那样）：重启后语音照样重做发出来，不算中断不确定；agent 的会话里那次调用补上「会自己补发、不要重发」", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const killable = await startKillableDaemon({ secretary: [sendVoiceCall(SHORT)], speechUrl: tts.url });
    await importReferenceVoice(killable.url);
    const frontend = await connect(killable.url);
    await frontend.sendText("念给我听：明早九点开会");
    await waitUntil(() => tts.held === 1, { timeoutMs: 30_000 });
    // 工具还在等合成：这次调用还没结束
    expect(agentVoiceVersions(frontend).map((v) => v.status)).toEqual(["synthesizing"]);
    expect(sendVoiceCalls(frontend)).toEqual([]);
    await killable.kill();

    tts.behave("ok");
    const td = await restartAfterKill(killable, { secretary: [{ kind: "echo_context" }], speechUrl: tts.url });
    ok(await frontend.reconnect([SECRETARY, CHANNELS.inbox], td.url));
    const done = await agentVoiceSettled(frontend, "done", 1, 30_000);
    // 那一轮被打断：另写的文字照常显示
    expect(done).toMatchObject({ mode: "tool", text: SHORT, coversReply: false });
    expect(ttsMessages(frontend)).toHaveLength(1);
    // 不当成"中断不确定"：语音由合成那边重做
    expect(td.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "interrupted")).toEqual([]);

    // agent 接着会话：那次调用的结果是"会自己补发、不要重发"
    await frontend.sendText("刚才的语音发了吗");
    const echoed = () => agentTextMessages(frontend).find((m) => withoutFoldersBlock(textOf(m.parts)).startsWith("[system]"));
    await waitUntil(() => echoed() !== undefined, { timeoutMs: 30_000, describe: () => "秘书回显上下文" });
    expect(stripTimeMarkers(textOf(echoed()!.parts))).toContain(
      "[toolResult] send_voice: 这次调用被中断了：执行时守护进程（或 agent 子进程）重启了，这条语音已经交给运行时合成，会自己补发出来（发不出去时会话里有说明），不要重发。",
    );
  }, 150_000);
});

describe("演示流程（录给前端回放）", () => {
  it("打字 → 个人助理发语音、另写一句普通的话（收进气泡）；再打字 → 发语音、另写一张表（照常显示）；再打字 → 语音服务忙，交回原因、照常发文字", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({
      secretary: [
        sendVoiceCall(SHORT),
        say("好的，念给你听了。"),
        sendVoiceCall("明天的安排我列成表了，一共两件事。"),
        say("| 时间 | 事项 |\n| --- | --- |\n| 09:00 | 开会 |\n| 14:00 | 交周报 |"),
        sendVoiceCall("好的。"),
        say("语音服务忙，我用文字说：好的。"),
      ],
      speechUrl: tts.url,
    });
    await importReferenceVoice(url);
    const frontend = await connect(url, [SECRETARY]);
    await frontend.sendText("念给我听：明早九点开会");
    await turnEnds(frontend, 1);
    await closedVoice(frontend);
    await frontend.sendText("用语音说一下明天的安排，再列个表");
    await turnEnds(frontend, 2);
    await waitUntil(() => agentVoiceVersions(frontend).filter((v) => v.coversReply !== undefined).length === 2);
    tts.behave(FAKE_SPEECH_BUSY);
    await frontend.sendText("说声好");
    await turnEnds(frontend, 3);
    await waitUntil(() => agentVoiceVersions(frontend).filter((v) => v.coversReply !== undefined).length === 3);
    expect(agentVoiceVersions(frontend).map((v) => `${v.status}:${v.coversReply ?? "-"}`)).toEqual([
      "synthesizing:-",
      "done:-",
      "done:true",
      "synthesizing:-",
      "done:-",
      "done:false",
      "synthesizing:-",
      "failed:-",
      "failed:false",
    ]);
    saveOrCheckRecording("send-voice", frontend.recording);
  }, 60_000);
});
