// 主切面：agent 用语音回复（规格第 21、22 节，32 号票）。用户发语音时，agent 这一轮的回复由运行时合成语音：
// 回复短的整段合成（合成好只出语音），长的（或有念不出来的内容）合成口语总结，详细内容照常是文字和附件——总结 agent 用工具写；
// 没写的先追问它一次（这一次不算新回复），还是没写才由运行时兜底。
// 语音经本机 LSM 托管的 audio.cpp 合成，用设置里导入的参考音色克隆；服务没开、忙、合成失败或超时、存不进去时退回只发文字，
// 会话里一条说明。
// 合成服务一律是假的（helpers/tts.ts，空闲端口）：不碰本机 8090 上的真服务、不占显卡。识别进程也是假的（31 号票的底座）。
// 参考音色一律是编的示例（示例音色、v-sample），不是谁的真声音。
import fs from "node:fs";
import path from "node:path";
import {
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type VoiceEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxUsage } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { request, sha256Hex } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import {
  agentVoiceSettled,
  agentVoiceVersions,
  FAKE_SPEECH_BUSY,
  fakeSpeechSeconds,
  importReferenceVoice,
  makeWav,
  referenceVoicesApi,
  SAMPLE_VOICE,
  startFakeSpeechService,
} from "../helpers/tts.ts";
import { sendVoice } from "../helpers/voice.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, turnStart: TURN_START, turnEnd: TURN_END } = EVENT_TYPES;

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 会话里的消息（按到达顺序） */
function messages(frontend: TestFrontend, conversation: string = SECRETARY): MessageEnvelope[] {
  return frontend.events({ channel: conversation, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message);
}

/** agent 发的、有文字的消息的文字 */
function agentTexts(frontend: TestFrontend, conversation: string = SECRETARY): string[] {
  return messages(frontend, conversation)
    .filter((m) => m.speaker === "agent" && textOf(m.parts) !== "")
    .map((m) => textOf(m.parts));
}

/** 会话频道上落盘事件的类型，按序号（agent 语音带上状态） */
function channelTypes(frontend: TestFrontend, conversation: string = SECRETARY): string[] {
  return frontend
    .events({ channel: conversation, persistedOnly: true })
    .map((f) => (f.type === EVENT_TYPES.agentVoice ? `agent_voice:${(f.payload as AgentVoiceEventPayload).voice.status}` : f.type));
}

/** agent 语音的各个版本：方式和状态 */
function voiceSteps(frontend: TestFrontend): string[] {
  return agentVoiceVersions(frontend).map((v) => `${v.mode ?? "-"}:${v.status}`);
}

async function turnEnds(frontend: TestFrontend, count: number, conversation: string = SECRETARY): Promise<void> {
  await waitUntil(() => frontend.events({ channel: conversation, type: TURN_END }).length >= count, { timeoutMs: 20_000, describe: () => channelTypes(frontend, conversation).join(" ") });
}

const usage = (cacheMiss: number, output: number): FauxUsage => ({ cacheHit: 0, cacheMiss, output });

describe("设置里的参考音色", () => {
  it("导入（WAV、逐字稿、名字）存进数据目录的 voices 区，目录和文件用英文 id、显示名另存；能列出、试听（支持 Range）、选用哪一个、删除", async () => {
    const { url, dataDir } = await startTestDaemon();
    expect((await referenceVoicesApi.list(url)).body).toEqual({ voices: [] });

    const wav = makeWav(3);
    const imported = await referenceVoicesApi.import(url, { name: "示例音色", referenceText: "大家好，这是一段示例参考录音。", wav });
    expect(imported.status).toBe(201);
    const first = imported.body;
    expect(first).toMatchObject({ name: "示例音色", referenceText: "大家好，这是一段示例参考录音。", durationMs: 3000 });
    expect(first.id).toMatch(/^v-[0-9a-z-]+$/);
    // 数据目录里：以英文 id 命名的目录，参考录音、逐字稿（UTF-8）、voice.json（显示名另存）
    const dir = path.join(dataDir, "voices", first.id);
    expect(fs.readFileSync(path.join(dir, "reference.wav"))).toEqual(wav);
    expect(fs.readFileSync(path.join(dir, "reference.txt"), "utf8")).toBe("大家好，这是一段示例参考录音。");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "voice.json"), "utf8"))).toEqual({
      format: 1,
      id: first.id,
      name: "示例音色",
      audioFile: "reference.wav",
      referenceTextFile: "reference.txt",
      durationMs: 3000,
      sha256: first.sha256,
      importedAt: first.importedAt,
    });
    // 只有一个、没选过：就用它
    expect((await referenceVoicesApi.list(url)).body).toEqual({ voices: [first], currentId: first.id });

    // 同样的录音和名字再导一次：拿到同一个，不多出一份
    expect((await referenceVoicesApi.import(url, { name: "示例音色", referenceText: "大家好，这是一段示例参考录音。", wav })).body).toEqual(first);

    const second = await importReferenceVoice(url, "另一个音色", "今天我们来聊聊天气。");
    expect((await referenceVoicesApi.list(url)).body).toEqual({ voices: [first, second], currentId: first.id });
    expect((await referenceVoicesApi.select(url, second.id)).body).toEqual({ voices: [first, second], currentId: second.id });
    expect((await referenceVoicesApi.list(url)).body.currentId).toBe(second.id);

    // 试听：参考录音本身，按音频在页面里直接播放；和媒体同一套发文件，支持 Range（拖动进度条）
    const audio = await request(url, HTTP_PATHS.referenceVoiceAudio(first.id));
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.headers["accept-ranges"]).toBe("bytes");
    expect(audio.headers["cache-control"]).toBe("no-store");
    expect(audio.body).toEqual(wav);
    const part = await request(url, HTTP_PATHS.referenceVoiceAudio(first.id), { headers: { range: "bytes=44-99" } });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 44-99/${wav.length}`);
    expect(part.body).toEqual(wav.subarray(44, 100));

    // 删掉现在用的那个：退回剩下的那个；目录一起删掉
    expect((await referenceVoicesApi.remove(url, second.id)).body).toEqual({ voices: [first], currentId: first.id });
    expect(fs.existsSync(path.join(dataDir, "voices", second.id))).toBe(false);
    expect((await referenceVoicesApi.remove(url, second.id)).status).toBe(404);
    expect((await referenceVoicesApi.select(url, "v-没有")).status).toBe(404);
    expect((await request(url, HTTP_PATHS.referenceVoiceAudio(second.id))).status).toBe(404);
  });

  it("数据目录里早先放好的参考音色（同样的格式）照常列出；没选过时用最早导入的那个", async () => {
    const { url, dataDir, daemon } = await startTestDaemon();
    const dir = path.join(dataDir, "voices", "v-sample");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "reference.wav"), makeWav(4));
    fs.writeFileSync(path.join(dir, "reference.txt"), "这是一段示例参考录音。", "utf8");
    fs.writeFileSync(
      path.join(dir, "voice.json"),
      JSON.stringify({ format: 1, id: "v-sample", name: "示例音色", audioFile: "reference.wav", referenceTextFile: "reference.txt", durationMs: 4000, sha256: "ab".repeat(32), importedAt: "2026-01-01T10:00:00+08:00" }),
    );
    const later = await importReferenceVoice(url, "另一个音色");
    const list = (await referenceVoicesApi.list(url)).body;
    expect(list.voices.map((v) => v.id)).toEqual(["v-sample", later.id]);
    expect(list.voices[0]).toEqual({ id: "v-sample", name: "示例音色", referenceText: "这是一段示例参考录音。", durationMs: 4000, sha256: "ab".repeat(32), importedAt: "2026-01-01T10:00:00+08:00" });
    expect(list.currentId).toBe("v-sample");
    expect(daemon.layout.voices).toBe(path.join(dataDir, "voices"));
  });

  it("导入的规矩：要是 WAV、1 到 30 秒、有名字和逐字稿；不合的拒绝，什么都不写", async () => {
    const { url, dataDir } = await startTestDaemon();
    const reject = async (voice: { name: string; referenceText: string; wav: Buffer }) => {
      const res = await referenceVoicesApi.import(url, voice);
      expect(res.status).toBe(400);
      return res.body.message;
    };
    expect(await reject({ name: "示例音色", referenceText: "你好", wav: Buffer.from("不是录音") })).toMatch(/WAV/);
    expect(await reject({ name: "示例音色", referenceText: "你好", wav: makeWav(0.5) })).toMatch(/1 秒/);
    expect(await reject({ name: "示例音色", referenceText: "你好", wav: makeWav(31) })).toMatch(/30 秒/);
    expect(await reject({ name: "示例音色", referenceText: "", wav: makeWav(3) })).toBeTruthy();
    expect(await reject({ name: "", referenceText: "你好", wav: makeWav(3) })).toBeTruthy();
    expect(fs.existsSync(path.join(dataDir, "voices")) ? fs.readdirSync(path.join(dataDir, "voices")) : []).toEqual([]);
    // 32 位浮点、双声道的 WAV 也收（时长按 WAV 头量）
    const float = await referenceVoicesApi.import(url, { name: "浮点", referenceText: "你好", wav: makeWav(2.5, { float: true, channels: 2, sampleRate: 16000 }) });
    expect(float.status).toBe(201);
    expect(float.body.durationMs).toBe(2500);
  });
});

describe("用户发语音，agent 用语音回复", () => {
  it("回复短：这一轮一开始就建出语音对象（回复中），整段合成；绑定音频、时长、原文、参考音色、实际的 TTS 模型和完整回复所在的消息", async () => {
    const tts = await startFakeSpeechService();
    const reply = "好的，明早九点提醒你交报告。";
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: reply }, { kind: "reply", text: "你好呀。" }], speechUrl: tts.url });
    const reference = await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" });

    const done = await agentVoiceSettled(frontend, "done");
    const replyMessage = messages(frontend).find((m) => m.speaker === "agent" && textOf(m.parts) === reply)!;
    const wav = makeWav(fakeSpeechSeconds(reply));
    const turnStart = frontend.events({ channel: SECRETARY, type: TURN_START })[0]!;
    expect(done).toMatchObject({
      conversation: SECRETARY,
      scope: {},
      inputMessageId: sent.messageId,
      turnSeq: turnStart.seq,
      replyMessageIds: [replyMessage.id],
      mode: "whole",
      text: reply,
      referenceVoice: { id: reference.id, name: SAMPLE_VOICE.name },
      // 实际的模型：问合成服务的模型列表（GET /v1/models）问到的
      model: "fish_audio（audio.cpp/tts）",
      status: "done",
      mediaId: sha256Hex(wav),
      mime: "audio/wav",
      durationMs: Math.round(fakeSpeechSeconds(reply) * 1000),
      version: 3,
    });
    expect(done).not.toHaveProperty("summaryBy");
    expect(done.waveform).toHaveLength(32);
    expect(Math.max(...done.waveform!)).toBe(100);
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(tts.modelQueries).toBe(1);
    // 这一轮一开始（turn_start 紧跟着）就是"回复中"：前端据此不流式显示回复的文字；回合结束时定口语稿去合成，
    // 合成完成时同一事务追加新版本和载着它的消息（agent 一侧的语音气泡）
    expect(voiceSteps(frontend)).toEqual(["-:replying", "whole:synthesizing", "whole:done"]);
    expect(agentVoiceVersions(frontend)[0]).toMatchObject({ status: "replying", turnSeq: turnStart.seq, replyMessageIds: [], version: 1 });
    expect(agentVoiceVersions(frontend)[0]).not.toHaveProperty("text");
    const types = channelTypes(frontend);
    expect(types.slice(types.indexOf(TURN_START), types.indexOf(TURN_START) + 2)).toEqual([TURN_START, "agent_voice:replying"]);
    expect(types.slice(types.indexOf(TURN_END))).toEqual([TURN_END, "agent_voice:synthesizing", "agent_voice:done", MESSAGE]);
    const voiceMessage = messages(frontend).find((m) => m.id === done.messageId)!;
    expect(voiceMessage.speaker).toBe("agent");
    expect(voiceMessage.parts).toEqual([{ type: "tts_audio", voiceId: done.id, mediaId: done.mediaId, mime: "audio/wav", durationMs: done.durationMs, waveform: done.waveform }]);

    // 合成请求：audio.cpp 的接口，参考录音（数据目录里英文路径的 WAV）和逐字稿同时给
    expect(tts.requests).toHaveLength(1);
    const call = tts.requests[0]!;
    expect(call).toMatchObject({ model: "tts", input: reply, referenceText: SAMPLE_VOICE.referenceText });
    expect(call.voiceRef).toBe(path.join(daemon.layout.voices, reference.id, "reference.wav"));
    expect(call.voiceRef).toMatch(/^[ -~]+$/);
    expect(call.voiceRefBytes).toEqual(makeWav(3));

    // 合成出的音频入库（按内容哈希），按音频在页面里直接播放
    const audio = await request(url, HTTP_PATHS.media(done.mediaId!));
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.body).toEqual(wav);

    // 历史分页带上这一页 agent 语音消息的 agent 语音对象
    expect((await frontend.history(SECRETARY)).agentVoices).toEqual([done]);

    // 用户发文字：只回文字，不合成，也不建语音对象
    await frontend.sendText("在吗");
    await turnEnds(frontend, 2);
    await daemon.voiceReplies.whenIdle();
    expect(agentVoiceVersions(frontend)).toHaveLength(3);
    expect(tts.requests).toHaveLength(1);
  });

  it("交给 agent 的语音输入后面跟一条说明：这次的回复会合成语音，回复长时用口语总结工具；用户发文字时没有", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "reply", text: "好" }, { kind: "echo_context" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "今天有什么安排" });
    await turnEnds(frontend, 1);
    const echo = agentTexts(frontend).at(-1)!;
    expect(echo).toContain("语音转写：今天有什么安排");
    expect(echo).toContain("用户这条是语音。你这次的回复会由运行时合成语音发给用户");
    expect(echo).toContain("spoken_summary");
    // 工具列表里有口语总结（秘书的装配里就有它）
    expect(echo).toMatch(/\[tool\] spoken_summary/);
    await agentVoiceSettled(frontend, "done");
    await frontend.sendText("今天有什么安排");
    await turnEnds(frontend, 2);
    const second = agentTexts(frontend).at(-1)!;
    expect(second.split("[user]").at(-1)).not.toContain("合成语音");
  });
});

/** 一段念出来远超 60 秒的回复（360 个汉字） */
const LONG_REPLY = "这份周报我整理好了，下面分几块说清楚。".repeat(20);

describe("回复长的：合成口语总结，详细内容照常是文字", () => {
  it("agent 这一轮用口语总结工具写了：合成它；完整回复所在的消息照常在会话里", async () => {
    const tts = await startFakeSpeechService();
    const summary = "周报我整理好了，一共三块，细节都发在聊天里了，你有空看一眼。";
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: LONG_REPLY, toolCalls: [{ name: "spoken_summary", arguments: { text: summary } }] }, { kind: "reply", text: "就这些。" }],
      speechUrl: tts.url,
    });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "把这周的周报整理一下" });
    const done = await agentVoiceSettled(frontend, "done");
    const replies = messages(frontend).filter((m) => m.speaker === "agent" && textOf(m.parts) !== "");
    expect(replies.map((m) => textOf(m.parts))).toEqual([LONG_REPLY, "就这些。"]);
    expect(done).toMatchObject({ inputMessageId: sent.messageId, mode: "summary", summaryBy: "agent", text: summary, replyMessageIds: replies.map((m) => m.id) });
    expect(voiceSteps(frontend)).toEqual(["-:replying", "summary:synthesizing", "summary:done"]);
    expect(tts.requests.map((r) => r.input)).toEqual([summary]);
    // 口语总结工具照常经守卫（不落入任何关注类别，直接做），调用记录在会话里
    const toolCall = messages(frontend).flatMap((m) => m.parts).find((p) => p.type === "tool_call" && p.tool === "spoken_summary");
    expect(toolCall).toMatchObject({ outcome: "done", categoryTitles: [] });
  });

  it("agent 没写口语总结：先追问它一次，补写了就用它——追问不算新回复：它说的不进会话，用量照常记账", async () => {
    const tts = await startFakeSpeechService();
    const summary = "周报整理好了，分三块，细节在聊天里。";
    const { url, daemon } = await startTestDaemon({
      secretary: [
        { kind: "reply", text: LONG_REPLY, usage: usage(1000, 100) },
        // 追问：调口语总结工具，再随口说一句（这句不进会话）
        { kind: "reply", toolCalls: [{ name: "spoken_summary", arguments: { text: summary } }], usage: usage(2000, 20) },
        { kind: "reply", text: "好的，写好了。", usage: usage(2100, 5) },
        { kind: "echo_context" },
      ],
      speechUrl: tts.url,
    });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "把这周的周报整理一下" });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ inputMessageId: sent.messageId, mode: "summary", summaryBy: "agent", text: summary });
    expect(voiceSteps(frontend)).toEqual(["-:replying", "summary:summarizing", "summary:synthesizing", "summary:done"]);
    expect(tts.requests.map((r) => r.input)).toEqual([summary]);
    // 不是新的一轮：只有那一轮的 turn_start、turn_end；追问时它说的话不进会话（只有工具调用记录照常在）
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toHaveLength(1);
    expect(frontend.events({ channel: SECRETARY, type: TURN_END })).toHaveLength(1);
    expect(agentTexts(frontend)).toEqual([LONG_REPLY]);
    expect(messages(frontend).flatMap((m) => m.parts).filter((p) => p.type === "tool_call" && p.tool === "spoken_summary")).toHaveLength(1);
    // 用量照常记账（秘书的是系统开销）
    await waitUntil(() => daemon.ledger.entries(null).filter((e) => e.role === "secretary").length === 3);
    expect(daemon.ledger.entries(null).filter((e) => e.role === "secretary").map((e) => e.tokens)).toEqual([usage(1000, 100), usage(2000, 20), usage(2100, 5)]);

    // agent 的会话里有这次追问（运行时的话和它的回答），下一轮接着往下
    await frontend.sendText("在吗");
    await turnEnds(frontend, 2);
    const echo = agentTexts(frontend).at(-1)!;
    expect(echo).toContain("请调用 spoken_summary 工具，给刚才的回复写一段");
    expect(echo).toContain("好的，写好了。");
  });

  it("追问了还是没写：运行时兜底——回复开头念得完的几句，加一句「详细内容我发在聊天里了」", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: LONG_REPLY }, { kind: "reply", text: "这段不用总结吧。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "把这周的周报整理一下" });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ mode: "summary", summaryBy: "runtime" });
    expect(voiceSteps(frontend)).toEqual(["-:replying", "summary:summarizing", "summary:synthesizing", "summary:done"]);
    expect(done.text!.startsWith("这份周报我整理好了，下面分几块说清楚。")).toBe(true);
    expect(done.text!.endsWith("详细内容我发在聊天里了。")).toBe(true);
    // 念得完：60 秒按每秒 4.5 个汉字估，不超过 270 个汉字
    expect([...done.text!.matchAll(/\p{Script=Han}/gu)].length).toBeLessThanOrEqual(270);
    expect(done.text!.length).toBeLessThan(LONG_REPLY.length);
    expect(tts.requests.map((r) => r.input)).toEqual([done.text]);
    expect(agentTexts(frontend)).toEqual([LONG_REPLY]);
  });

  it("短但有念不出来的内容（代码、链接）：不整段念，合成口语总结（追问没写时兜底，去掉代码和链接）", async () => {
    const tts = await startFakeSpeechService();
    const reply = "装依赖用这条命令：\n```\nnpm ci\n```\n文档在 https://example.com/docs 里。";
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: reply }, { kind: "reply", text: "嗯。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "怎么装依赖" });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ mode: "summary", summaryBy: "runtime" });
    expect(done.text).not.toMatch(/npm ci|https?:|```/);
    expect(done.text).toContain("装依赖用这条命令");
    expect(done.text!.endsWith("详细内容我发在聊天里了。")).toBe(true);
  });

  it("Markdown 的标记不念：整段合成的是去掉标记的口语稿；问不到实际模型时记配置里写的模型名", async () => {
    const tts = await startFakeSpeechService();
    tts.models({ status: 404 });
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "**好的**，今天要做两件事：\n- 买菜\n- 交报告" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "今天要做什么" });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ mode: "whole", text: "好的，今天要做两件事：买菜。交报告", model: "audio.cpp/tts" });
  });
});

/** 发一条语音，等这一轮的语音回复有了结局（失败），返回它和会话里的系统说明 */
async function failedReply(url: string): Promise<{ frontend: TestFrontend; failed: AgentVoiceRecord; notes: string[] }> {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0 });
  await sendVoice(frontend, url, { text: "提醒我喝水" });
  const failed = await agentVoiceSettled(frontend, "failed", 1, 30_000);
  await waitUntil(() => messages(frontend).some((m) => m.speaker === "system"));
  const notes = messages(frontend)
    .filter((m) => m.speaker === "system")
    .map((m) => textOf(m.parts));
  return { frontend, failed, notes };
}

describe("退回只发文字", () => {
  it("合成服务出错：这条语音记成失败（带原因），会话里一条说明，只有文字回复", async () => {
    const tts = await startFakeSpeechService();
    tts.behave({ status: 500, body: '{"error":"model load failed"}' });
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的，十分钟后提醒你。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const { frontend, failed, notes } = await failedReply(url);
    expect(failed.error).toMatch(/HTTP 500.*model load failed/);
    expect(failed).not.toHaveProperty("mediaId");
    expect(notes).toEqual([`语音没合成出来（${failed.error}），这次只发文字。`]);
    expect(messages(frontend).flatMap((m) => m.parts).some((p) => p.type === "tts_audio")).toBe(false);
    expect(agentTexts(frontend)).toEqual(["好的，十分钟后提醒你。"]);
    expect(voiceSteps(frontend)).toEqual(["-:replying", "whole:synthesizing", "whole:failed"]);
  });

  it("语音服务忙（显卡在给别的任务用，HTTP 503）：不等超时、不重试，直接退回只发文字，说明里写「语音服务忙」", async () => {
    const tts = await startFakeSpeechService();
    tts.behave(FAKE_SPEECH_BUSY);
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const started = Date.now();
    const { failed, notes } = await failedReply(url);
    expect(failed.error).toBe("语音服务忙");
    expect(notes).toEqual(["语音没合成出来（语音服务忙），这次只发文字。"]);
    expect(tts.requests).toHaveLength(1);
    // 默认的超时至少 105 秒：没等它
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("合成服务没开：说明里写明", async () => {
    const closed = await startFakeSpeechService();
    await closed.close();
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的。" }], speechUrl: closed.url });
    await importReferenceVoice(url);
    const { failed, notes } = await failedReply(url);
    expect(failed.error).toBe(`语音合成服务没开（${closed.url}）`);
    expect(notes[0]).toContain("语音合成服务没开");
  });

  it("配置里的模型 id 还是示例的占位符：不发请求，说明里写清楚怎么填", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: "好的。" }],
      speechUrl: tts.url,
      config: { voice: { speech: { model: "<audio.cpp 服务上 Fish-Audio S2 Pro 的模型 id>" } } },
    });
    await importReferenceVoice(url);
    const { failed } = await failedReply(url);
    expect(failed.error).toMatch(/voice\.speech\.model 还是示例里的占位符.*Fish-Audio S2 Pro/);
    expect(tts.requests).toEqual([]);
  });

  it("合成超时（超时可配置）：不再等，退回只发文字", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hang");
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: "好的。" }],
      speechUrl: tts.url,
      config: { voice: { speech: { timeout: { baseSeconds: 0.3, coldStartSeconds: 0.3, perSpeechSecond: 0.1 } } } },
    });
    await importReferenceVoice(url);
    const { failed } = await failedReply(url);
    expect(failed.error).toMatch(/^语音合成超时/);
  });

  it("合成出来了但存不进媒体库：同样记成失败、会话里一条说明（不会一直停在合成中）", async () => {
    const tts = await startFakeSpeechService();
    const wav = makeWav(2);
    tts.behave({ wav });
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    // 媒体库里这段音频该放的地方被一个目录占着：入库后读不出来
    fs.mkdirSync(path.join(daemon.layout.media, sha256Hex(wav)), { recursive: true });
    const { frontend, failed, notes } = await failedReply(url);
    expect(failed.error).toMatch(/^合成出的语音存不进去：/);
    expect(notes).toEqual([`语音没合成出来（${failed.error}），这次只发文字。`]);
    expect(messages(frontend).flatMap((m) => m.parts).some((p) => p.type === "tts_audio")).toBe(false);
    expect(voiceSteps(frontend)).toEqual(["-:replying", "whole:synthesizing", "whole:failed"]);
  });

  it("没有任何参考音色：不建语音对象、不合成（回复照常流式显示），待我处理里提示去导入（开着的只有一条）；导入之后这条自动归档", async () => {
    const tts = await startFakeSpeechService();
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: "收到。" }, { kind: "reply", text: "收到。" }], speechUrl: tts.url });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await sendVoice(frontend, url, { text: "第一句" });
    await turnEnds(frontend, 1);
    await sendVoice(frontend, url, { text: "第二句" });
    await turnEnds(frontend, 2);
    const notices = () => daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "voice_reference_missing");
    await waitUntil(() => notices().length > 0);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ title: expect.stringContaining("参考音色"), actions: ["去导入参考音色", "知道了"], archived: false });
    expect(tts.requests).toEqual([]);
    expect(agentVoiceVersions(frontend)).toEqual([]);
    // 会话里没有额外的说明（只有文字回复）
    expect(messages(frontend).filter((m) => m.speaker === "system")).toEqual([]);

    await importReferenceVoice(url);
    await waitUntil(() => notices()[0]?.archived === true);
  });
});

describe("各个会话和各种情况", () => {
  it("维护者会话里一样：用户发语音，维护者的回复合成语音；语音消息带上所属的项目", async () => {
    const tts = await startFakeSpeechService();
    const { url, daemon } = await startTestDaemon({ maintainer: [{ kind: "reply", text: "好的，我把上个月的流水导进来。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const project = seedProject(daemon, "家庭账本");
    const pm = maintainerChannel(project.maintainerId);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [pm]: 0 });
    const sent = await sendVoice(frontend, url, { text: "把上个月的流水导进来" }, { conversation: pm });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ conversation: pm, scope: { projectId: project.id }, inputMessageId: sent.messageId, mode: "whole", text: "好的，我把上个月的流水导进来。" });
    const event = frontend.events({ channel: pm, type: MESSAGE }).find((f) => (f.payload as MessageEventPayload).message.id === done.messageId)!;
    expect(event.payload).toMatchObject({ projectId: project.id, message: { speaker: "agent", parts: [{ type: "tts_audio", voiceId: done.id }] } });
  });

  it("重新识别成功后交给 agent 的那条通知也算用户的语音：这一轮同样用语音回复", async () => {
    const tts = await startFakeSpeechService();
    const ok = path.join(makeTempDir("ergou-asr-ok-"), "ok");
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "没听清，能再说一遍吗？" }, { kind: "reply", text: "好，下午去买菜。" }], speechUrl: tts.url });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "下午去买菜", errorUnless: ok });
    const first = await agentVoiceSettled(frontend, "done");
    expect(first.text).toBe("没听清，能再说一遍吗？");
    fs.writeFileSync(ok, "");
    const failed = frontend
      .events({ type: EVENT_TYPES.voice })
      .map((f) => (f.payload as VoiceEventPayload).voice)
      .find((v) => v.status === "failed")!;
    await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry");
    const second = await agentVoiceSettled(frontend, "done", 2);
    const notice = messages(frontend).find((m) => m.speaker === "system" && textOf(m.parts).includes("重新识别"))!;
    expect(second).toMatchObject({ inputMessageId: notice.id, text: "好，下午去买菜。" });
  });

  it("合成到一半守护进程停了：重启后这条接着重做（合成只是一次 HTTP 调用），不算中断不确定", async () => {
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const first = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的，记下了。" }], speechUrl: tts.url });
    await importReferenceVoice(first.url);
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, first.url, { text: "记一下明天开会" });
    const synthesizing = await agentVoiceSettled(frontend, "synthesizing");
    await waitUntil(() => tts.requests.length === 1);
    await frontend.close();
    await first.daemon.stop();

    tts.behave("ok");
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir }, speechUrl: tts.url });
    const again = await TestFrontend.connect(second.url);
    await again.subscribe({ [SECRETARY]: 0 });
    const done = await agentVoiceSettled(again, "done");
    expect(done).toMatchObject({ id: synthesizing.id, text: "好的，记下了。", version: 3 });
    expect(tts.requests.map((r) => r.input)).toEqual(["好的，记下了。", "好的，记下了。"]);
    expect(messages(again).filter((m) => m.speaker === "system")).toEqual([]);
    expect(second.daemon.inbox.list().filter((i) => i.kind === "notice" && i.notice === "interrupted")).toEqual([]);
  });
});

describe("演示流程（录给前端回放）", () => {
  it("发语音 → 短回复整段合成；再发 → 长回复，追问后 agent 补写口语总结；再发 → 语音服务忙，退回只发文字", async () => {
    const tts = await startFakeSpeechService();
    const summary = "周报整理好了，细节都在聊天里。";
    const { url } = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "好的，明早九点提醒你交报告。" },
        { kind: "reply", text: LONG_REPLY },
        { kind: "reply", toolCalls: [{ name: "spoken_summary", arguments: { text: summary } }] },
        { kind: "reply", text: "写好了。" },
        { kind: "reply", text: "好的，十分钟后提醒你喝水。" },
      ],
      speechUrl: tts.url,
    });
    await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" }, { durationMs: 4200, waveform: [4, 18, 52, 80, 64, 30, 12, 40, 70, 22] });
    await agentVoiceSettled(frontend, "done", 1);
    await waitUntil(() => messages(frontend).some((m) => m.parts.some((p) => p.type === "tts_audio")));
    await sendVoice(frontend, url, { text: "把这周的周报整理一下" }, { durationMs: 2600, waveform: [20, 60, 30] });
    await agentVoiceSettled(frontend, "done", 2);
    await waitUntil(() => messages(frontend).filter((m) => m.parts.some((p) => p.type === "tts_audio")).length === 2);
    tts.behave(FAKE_SPEECH_BUSY);
    await sendVoice(frontend, url, { text: "十分钟后提醒我喝水" }, { durationMs: 1800, waveform: [30, 50] });
    await agentVoiceSettled(frontend, "failed", 1);
    await waitUntil(() => messages(frontend).some((m) => m.speaker === "system"));
    expect(voiceSteps(frontend)).toEqual([
      "-:replying",
      "whole:synthesizing",
      "whole:done",
      "-:replying",
      "summary:summarizing",
      "summary:synthesizing",
      "summary:done",
      "-:replying",
      "whole:synthesizing",
      "whole:failed",
    ]);
    expect(agentTexts(frontend)).toEqual(["好的，明早九点提醒你交报告。", LONG_REPLY, "好的，十分钟后提醒你喝水。"]);
    saveOrCheckRecording("voice-reply", frontend.recording);
  }, 60_000);
});
