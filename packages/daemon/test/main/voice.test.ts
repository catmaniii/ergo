// 主切面：语音消息（规格第 22 节，31 号票）。前端把整段录音经分片续传上传，传完发一条带语音 part 的消息；
// 守护进程建出这条语音（VoiceRecord：音频、时长、格式、波形），在后台用 faster-whisper 识别，识别状态的变化经会话频道推给前端；
// agent 收到的是识别出的文字（注明"语音转写"），识别完成前这条输入在 agent 的输入队列里等着。第一阶段不用大模型修正（用户 2026-10-08 定）。
// 语音转写和打的字一样参与快速动作的"点明"判定（气泡下直接显示的识别文字就算用户确认过）。
// 识别进程一律是假的（fixtures/fake-recognizer.mjs）：不加载真模型、不联网、不占显卡。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  type ConversationId,
  type DebugRecognizeResult,
  EVENT_TYPES,
  HISTORY_PAGE_SIZE,
  HTTP_PATHS,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  METHODS,
  type PageVoiceResult,
  type ResponseFrame,
  type RetryVoiceResult,
  type TurnStartEventPayload,
  type VoiceEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { appendMessage } from "../../src/conversation/messages.ts";
import { inputOf } from "../../src/conversation/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { connectFrontend, countAgentSpawns, startTestDaemon, suiteDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { history, materialsApi, media, request, requestJson, sha256Hex } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { eventually, maintainerScript, onePlan, runningTask, tasksOf } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { voiceModelsApi } from "../helpers/tts.ts";
import { fakeRecording, fakeWavRecording, recognizerLog, sendVoice, setFakeLoad, voiceSettled, voiceVersions } from "../helpers/voice.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, turnStart: TURN_START, turnEnd: TURN_END, voice: VOICE } = EVENT_TYPES;

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 秘书（echo_context）最后一条回复：它这次看到的上下文（时间标记去掉） */
function lastEcho(frontend: TestFrontend): string {
  const replies = frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent");
  return stripTimeMarkers(withoutFoldersBlock(textOf(replies.at(-1)!.parts)));
}

/** 会话频道上落盘事件的类型，按序号 */
function channelTypes(frontend: TestFrontend): string[] {
  return frontend.events({ channel: SECRETARY, persistedOnly: true }).map((f) => (f.type === VOICE ? `voice:${(f.payload as VoiceEventPayload).voice.status}` : f.type));
}

/** 一个还没有语音对象 id 的语音 part（前端发送时的样子） */
const voice = (mediaId: string, durationMs = 2000): MessagePart => ({ type: "voice", mediaId, mime: "audio/webm", durationMs, waveform: [] });

async function turnEnds(frontend: TestFrontend, count: number): Promise<void> {
  await waitUntil(() => frontend.events({ channel: SECRETARY, type: TURN_END }).length >= count, { timeoutMs: 20_000, describe: () => channelTypes(frontend).join(" ") });
}

describe("发一条语音", () => {
  /**
   * 245 号票：下面三条"诊断"用例只看自己发的那几条语音（按 messageId 找、按自己这一刻往后收的事件数），
   * 对守护进程的数据目录没有别的假设，所以共用一个。别的用例要么在验重启 / 识别进程闲置退出 / 特定配置，
   * 要么要看"历史分页里只有这一条"，仍旧每例一个。
   */
  const shared = suiteDaemon();
  it("建出这条语音（音频哈希、时长、格式、波形），识别状态的变化经频道推给前端；秘书收到识别出的文字，识别完成前这条输入在队列里等着", async () => {
    const hold = path.join(makeTempDir("ergo-hold-"), "go");
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });

    const bytes = fakeRecording({ text: "明天早上九点钟提醒我交报告", seconds: 3.2, holdFile: hold });
    const uploaded = await media.upload(url, bytes, { name: "语音.webm", mime: "audio/webm;codecs=opus" });
    const sent = await frontend.sendParts([{ type: "voice", mediaId: uploaded.mediaId, mime: "audio/webm;codecs=opus", durationMs: 3240, waveform: [5, 30, 88, 60, 12] }]);

    // 消息里的语音 part 带上了语音对象的 id；语音对象和消息同一事务建出，排队识别
    const recognizing = await voiceSettled(frontend, "recognizing");
    const message = frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).find((m) => m.id === sent.messageId)!;
    expect(message.parts).toEqual([{ type: "voice", voiceId: recognizing.id, mediaId: uploaded.mediaId, mime: "audio/webm", durationMs: 3240, waveform: [5, 30, 88, 60, 12] }]);
    expect(voiceVersions(frontend)[0]).toMatchObject({
      id: recognizing.id,
      messageId: sent.messageId,
      conversation: SECRETARY,
      mediaId: sha256Hex(bytes),
      mime: "audio/webm",
      durationMs: 3240,
      waveform: [5, 30, 88, 60, 12],
      status: "queued",
      attempt: 1,
      version: 1,
    });
    // 识别还没完：秘书没开始处理这条（没有 turn_start）
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toEqual([]);
    expect(daemon.secretary.status).toBe("idle");

    fs.writeFileSync(hold, "");
    const done = await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    expect(done).toMatchObject({
      status: "done",
      recognition: {
        text: "明天早上九点钟提醒我交报告",
        language: "zh",
        segments: [{ start: 0, end: 3.2, text: "明天早上九点钟提醒我交报告" }],
        model: "large-v3",
        device: "cuda",
        computeType: "int8_float16",
        audioSeconds: 3.2,
      },
      version: 3,
    });
    expect(done).not.toHaveProperty("correction");
    expect(done.recognition!.elapsedMs).toBeGreaterThanOrEqual(300);
    // 识别有了结局之后秘书才开始处理这条，它看到的是识别出的文字（就是 faster-whisper 的结果），注明"语音转写"
    expect(channelTypes(frontend).slice(0, 5)).toEqual(["message", "voice:queued", "voice:recognizing", "voice:done", "turn_start"]);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：明天早上九点钟提醒我交报告");

    // 识别进程拿到的：配置里的默认模型（显卡上的 large-v3、退回 CPU 的 small）、媒体库里的录音、中文和提示
    const entries = recognizerLog(log);
    expect(entries.find((e) => e.event === "init")).toMatchObject({
      primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
      fallback: { device: "cpu", model: "small", computeType: "int8" },
    });
    expect(entries.find((e) => e.event === "transcribe")).toMatchObject({
      path: path.join(dataDirLayout(daemon.config.dataDir).media, uploaded.mediaId),
      language: "zh",
      initialPrompt: "以下是普通话的句子。",
    });

    // 录音按音频类型在页面里直接播放（支持 Range）
    const audio = await request(url, `/api/media/${uploaded.mediaId}`, { headers: { range: "bytes=0-3" } });
    expect(audio.status).toBe(206);
    expect(audio.headers["content-type"]).toBe("audio/webm");
    expect(audio.headers["content-disposition"]).toMatch(/^inline/);
  });

  it("维护者会话里发语音：识别完成前不唤起维护者；完成后唤起它，交给它的是识别出的文字；这条语音带上所属的项目", async () => {
    const hold = path.join(makeTempDir("ergo-hold-"), "go");
    const { url, daemon } = await startTestDaemon({ maintainer: [{ kind: "echo_context" }] });
    const project = seedProject(daemon, "家庭账本");
    const pm = maintainerChannel(project.maintainerId);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [pm]: 0 });
    const spawns = countAgentSpawns(daemon);
    await sendVoice(frontend, url, { text: "把上个月的流水导进来", holdFile: hold }, { conversation: pm });
    const recognizing = await voiceSettled(frontend, "recognizing");
    expect(recognizing).toMatchObject({ conversation: pm, projectId: project.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawns()).toBe(0);

    fs.writeFileSync(hold, "");
    await voiceSettled(frontend, "done");
    await waitUntil(() => frontend.events({ channel: pm, type: TURN_END }).length > 0, { timeoutMs: 20_000 });
    expect(spawns()).toBe(1);
    const echo = frontend.events({ channel: pm, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent").at(-1)!;
    expect(stripTimeMarkers(textOf(echo.parts))).toContain("[user] 语音转写：把上个月的流水导进来");
  });

  it("显卡不可用时退回 CPU：识别结果里记下实际用的模型和原因", async () => {
    const td = shared();
    const frontend = await connectFrontend(td, [SECRETARY]);
    await sendVoice(frontend, td.url, { text: "试一下", fallback: "没有可用的显卡" });
    expect((await voiceSettled(frontend, "done")).recognition).toMatchObject({ model: "small", device: "cpu", computeType: "int8", fallbackReason: "没有可用的显卡" });
  });

  it("历史分页带上这一页语音消息的 VoiceRecord（它们的 voice 事件可能早于第一次补发的那一页）", async () => {
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "记一下" });
    const done = await voiceSettled(frontend, "done");
    const page = await frontend.history(SECRETARY);
    expect(page.voices).toEqual([done]);
  });

  it("录音的诊断（37 号票）：按下 → 开录的毫秒数、是不是预热命中，存进语音对象（整数），本机的历史分页取得到；消息里不留。宽松：多带的字段、不合理的数字丢掉不拒收，没带就没有", async () => {
    const td = shared();
    const url = td.url;
    const frontend = await connectFrontend(td, [SECRETARY]);
    const send = async (capture: unknown) => {
      const audio = await media.upload(url, fakeRecording({ text: "试一下" }), { name: "语音.webm", mime: "audio/webm" });
      const sent = await frontend.sendParts([{ ...voice(audio.mediaId), ...(capture === undefined ? {} : { capture }) } as MessagePart]);
      return { sent, stored: await waitForMessage(frontend, sent.messageId) };
    };
    const warm = await send({ startDelayMs: 11.6, prewarmed: true });
    const cold = await send({ startDelayMs: -3, prewarmed: false, futureField: "x" });
    const odd = await send({ startDelayMs: -1 });
    const old = await send(undefined);
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "done").length === 4, { timeoutMs: 20_000 });

    const byMessage = (messageId: string) => voiceVersions(frontend).find((v) => v.messageId === messageId)!;
    expect(byMessage(warm.sent.messageId).capture).toEqual({ startDelayMs: 12, prewarmed: true });
    expect(byMessage(cold.sent.messageId).capture).toEqual({ prewarmed: false });
    expect(byMessage(odd.sent.messageId)).not.toHaveProperty("capture");
    expect(byMessage(old.sent.messageId)).not.toHaveProperty("capture");
    // 消息的语音 part 里不留诊断
    for (const { stored } of [warm, cold, odd, old]) expect(stored.parts[0]).not.toHaveProperty("capture");
    // 本机的历史分页接口（GET /api/conversations/secretary/messages）带着它，识别完了也还在
    const page = await history(url, SECRETARY);
    expect(page.status).toBe(200);
    const listed = page.body.voices!.find((v) => v.messageId === warm.sent.messageId)!;
    expect(listed).toMatchObject({ status: "done", capture: { startDelayMs: 12, prewarmed: true } });
  });

  it("麦克风诊断记录（61 号票）：开麦原因、冷启动耗时、最大振幅、最近的麦克风开关、浏览器存进语音对象，本机的历史分页取得到。宽松：类型不对的字段、记录里坏掉的条目丢掉，超长的截断，诊断整个不是对象也不拒收", async () => {
    const td = shared();
    const url = td.url;
    const frontend = await connectFrontend(td, [SECRETARY]);
    const send = async (capture: unknown) => {
      const audio = await media.upload(url, fakeRecording({ text: "试一下" }), { name: "语音.webm", mime: "audio/webm" });
      return frontend.sendParts([{ ...voice(audio.mediaId), capture } as MessagePart]);
    };
    const ua = "Mozilla/5.0 (Linux; Android 14; HUAWEI) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";
    const full = await send({
      startDelayMs: 0,
      prewarmed: true,
      openReason: "edit-out",
      gumMs: 120.4,
      peak: 0.25,
      micLog: [
        { atMs: -6820.4, event: "open", reason: "enter", hasFocus: true, visibility: "visible" },
        { atMs: -6620, event: "ready", ms: 200, hasFocus: true, visibility: "visible" },
        { atMs: -5620, event: "close", reason: "edit-in", hasFocus: false, visibility: "visible" },
      ],
      browser: ua,
    });
    const messy = await send({
      openReason: "x".repeat(40),
      gumMs: -1,
      peak: 3,
      browser: "b".repeat(600),
      micLog: [
        { atMs: "x", event: "open" },
        { atMs: 1, event: 7 },
        { atMs: 2, event: "close", reason: 9, ms: -4, hasFocus: "yes", visibility: 1 },
        "not an entry",
        ...Array.from({ length: 45 }, (_, i) => ({ atMs: -i, event: "mute", reason: "r".repeat(80), visibility: "v".repeat(20) })),
      ],
    });
    const wrongTypes = await send({ startDelayMs: "12", prewarmed: "yes", openReason: 5, gumMs: "120", peak: "0.3", micLog: "x", browser: 42 });
    const notObject = await send("诊断");
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "done").length === 4, { timeoutMs: 20_000 });

    const byMessage = (messageId: string) => voiceVersions(frontend).find((v) => v.messageId === messageId)!;
    expect(byMessage(full.messageId).capture).toEqual({
      startDelayMs: 0,
      prewarmed: true,
      openReason: "edit-out",
      gumMs: 120,
      peak: 0.25,
      micLog: [
        { atMs: -6820, event: "open", reason: "enter", hasFocus: true, visibility: "visible" },
        { atMs: -6620, event: "ready", ms: 200, hasFocus: true, visibility: "visible" },
        { atMs: -5620, event: "close", reason: "edit-in", hasFocus: false, visibility: "visible" },
      ],
      browser: ua,
    });
    // 超长的截断（上限在协议包 VOICE_CAPTURE_TEXT_MAX）：开麦原因 32、记录里的原因 64、可见状态 16、UA 512
    const tidy = byMessage(messy.messageId).capture!;
    expect(tidy.openReason).toBe("x".repeat(32));
    expect(tidy.browser).toBe("b".repeat(512));
    expect(tidy).not.toHaveProperty("gumMs");
    expect(tidy).not.toHaveProperty("peak");
    // 坏掉的条目丢掉、条目里坏掉的字段丢掉；只留最后 40 条
    expect(tidy.micLog).toHaveLength(40);
    expect(tidy.micLog![0]).toEqual({ atMs: -5, event: "mute", reason: "r".repeat(64), visibility: "v".repeat(16) });
    expect(tidy.micLog!.at(-1)).toMatchObject({ atMs: -44, event: "mute" });
    expect(byMessage(wrongTypes.messageId)).not.toHaveProperty("capture");
    expect(byMessage(notObject.messageId)).not.toHaveProperty("capture");

    const page = await history(url, SECRETARY);
    expect(page.body.voices!.find((v) => v.messageId === full.messageId)!.capture).toMatchObject({ openReason: "edit-out", gumMs: 120, browser: ua });
  });

  it("鸿蒙 App 的原生录音（63 号票）：WAV（16 kHz 单声道 16 位 PCM）从上传到识别完成，照常播放；诊断标明是原生录的，带上备好用了多久、按下到第一块数据、原生开录到第一块数据", async () => {
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const bytes = fakeWavRecording({ text: "把明天的会推到下午", seconds: 2.4 });
    const uploaded = await media.upload(url, bytes, { name: "语音.wav", mime: "audio/wav" });
    const capture = {
      backend: "native",
      prewarmed: true,
      startDelayMs: 41.4,
      firstDataMs: 33.6,
      prepareMs: 12.2,
      openReason: "enter",
      peak: 0.31,
      micLog: [
        { atMs: -5200, event: "open", reason: "enter", hasFocus: true, visibility: "visible" },
        { atMs: -5188, event: "ready", reason: "PREPARED", ms: 12, hasFocus: true, visibility: "visible" },
      ],
      browser: "Mozilla/5.0 (Phone; OpenHarmony 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.1.0.0 Mobile",
    };
    const sent = await frontend.sendParts([{ type: "voice", mediaId: uploaded.mediaId, mime: "audio/wav", durationMs: 2400, waveform: [10, 60, 40], capture } as MessagePart]);

    const done = await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    expect(done).toMatchObject({ messageId: sent.messageId, mime: "audio/wav", durationMs: 2400, recognition: { text: "把明天的会推到下午", audioSeconds: 2.4 } });
    expect(lastEcho(frontend)).toContain("[user] 语音转写：把明天的会推到下午");
    // 识别进程拿到的就是媒体库里的这段 WAV
    expect(recognizerLog(log).find((e) => e.event === "transcribe")?.path).toBe(path.join(dataDirLayout(daemon.config.dataDir).media, uploaded.mediaId));

    // 诊断：后端、备好用了多久、按下到第一块数据、原生开录到第一块数据（整数）
    expect(done.capture).toEqual({
      backend: "native",
      prewarmed: true,
      startDelayMs: 41,
      firstDataMs: 34,
      prepareMs: 12,
      openReason: "enter",
      peak: 0.31,
      micLog: capture.micLog,
      browser: capture.browser,
    });
    const page = await history(url, SECRETARY);
    expect(page.body.voices!.find((v) => v.messageId === sent.messageId)!.capture).toMatchObject({ backend: "native", prepareMs: 12, firstDataMs: 34 });

    // 宽松：后端不是字符串、毫秒数是负数或不是数字的丢掉，后端超长的截断
    const sendWav = async (text: string, report: unknown) => {
      const wav = await media.upload(url, fakeWavRecording({ text }), { name: "语音.wav", mime: "audio/wav" });
      return frontend.sendParts([{ type: "voice", mediaId: wav.mediaId, mime: "audio/wav", durationMs: 1500, waveform: [], capture: report } as MessagePart]);
    };
    const odd = await sendWav("嗯嗯", { backend: 5, prepareMs: -2, firstDataMs: "3" });
    const longer = await sendWav("好的", { backend: "n".repeat(40) });
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "done").length === 3, { timeoutMs: 20_000 });
    expect(voiceVersions(frontend).find((v) => v.messageId === odd.messageId)).not.toHaveProperty("capture");
    expect(voiceVersions(frontend).find((v) => v.messageId === longer.messageId)!.capture).toEqual({ backend: "n".repeat(32) });

    // 录音按 WAV 在页面里直接播放
    const audio = await request(url, `/api/media/${uploaded.mediaId}`, { headers: { range: "bytes=0-3" } });
    expect(audio.status).toBe(206);
    expect(audio.headers["content-type"]).toBe("audio/wav");
  });
});

describe("语音消息的规矩", () => {
  it("不是认得的音频、不到 1 秒、和文字或别的语音一起发、语音对象 id 前端说了不算、超过 60 秒：拒收（带引用的卡片可以，见下面的点明；带附件可以，见下面的「语音连同附件一起发」）", async () => {
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const audio = await media.upload(url, fakeRecording({ text: "嗯" }), { name: "a.webm", mime: "audio/webm" });
    const text = await media.upload(url, new TextEncoder().encode("不是音频"), { name: "a.webm", mime: "audio/webm" });
    const rejected = async (parts: MessagePart[]) => {
      const res: ResponseFrame = await frontend.trySendParts(parts);
      return res.ok ? undefined : res.error;
    };
    expect(await rejected([voice(text.mediaId)])).toMatchObject({ code: "bad_params", message: expect.stringMatching(/不是认得的音频/) });
    expect(await rejected([voice(audio.mediaId, 800)])).toMatchObject({ code: "bad_params", message: "说话时间太短" });
    expect(await rejected([voice(audio.mediaId), { type: "text", text: "还有这句" }])).toMatchObject({ code: "bad_params", message: expect.stringMatching(/只能有一段语音/) });
    expect(await rejected([voice(audio.mediaId), voice(audio.mediaId)])).toMatchObject({ code: "bad_params", message: expect.stringMatching(/只能有一段语音/) });
    expect(await rejected([voice(audio.mediaId, 70_000)])).toMatchObject({ code: "bad_params" });
    expect(await rejected([voice("0".repeat(64))])).toMatchObject({ code: "bad_params", message: expect.stringMatching(/没有入库/) });

    const sent = await frontend.sendParts([{ ...voice(audio.mediaId), voiceId: "v-前端编的" } as MessagePart]);
    const stored = await waitForMessage(frontend, sent.messageId);
    expect(stored.parts[0]).toMatchObject({ type: "voice" });
    expect((stored.parts[0] as { voiceId: string }).voiceId).not.toBe("v-前端编的");
  });

  it("同一个幂等键重发：不多出消息，也不多出语音对象", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const first = await sendVoice(frontend, url, { text: "一遍" }, { idempotencyKey: "k-voice" });
    const again = await frontend.sendParts([{ type: "voice", mediaId: first.mediaId, mime: "audio/webm", durationMs: 3200, waveform: [] }], { idempotencyKey: "k-voice" });
    expect(again.messageId).toBe(first.messageId);
    await voiceSettled(frontend, "done");
    expect(daemon.store.read(SECRETARY, 0, EVENT_TYPES.voice).filter((e) => (e.payload as VoiceEventPayload).voice.status === "queued")).toHaveLength(1);
  });
});

/** 配置里写明测试的模型（faux）看得了图（79 号票起不写也按模型目录算看得了，这里写明，不依赖目录），秘书回显上下文 */
async function visionDaemon() {
  const dataDir = makeTempDir("ergo-data-");
  fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config", "ergo.json"), JSON.stringify({ models: { faux: { vision: true } } }));
  return startTestDaemon({ secretary: [{ kind: "echo_context" }], cardTypes: [suggestTaskFixture], reuse: { dataDir, homeDir: makeTempDir("ergo-home-") } });
}

describe("语音连同附件一起发（2026-10-10 用户改：附件不再选了就单独发，等下一条消息带走）", () => {
  it("引用的卡片、图片（作为材料投喂）和语音是同一条消息：识别完成前整条在队里等着；交给秘书的是同一条输入，先卡片和图片、后语音转写，支持视觉的模型同时收到图片；图片记成投喂的材料，转写另成一条素材", async () => {
    const hold = path.join(makeTempDir("ergo-hold-"), "go");
    const { url, daemon } = await visionDaemon();
    const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "重复照片太多" } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });

    // pi 发给模型前会解码、缩放图片，所以用一张能解码的 PNG
    const image = await media.upload(url, png({ width: 8, height: 8, exif: true }), { name: "猫.png", mime: "image/png" });
    const audio = await media.upload(url, fakeRecording({ text: "帮我看看这是什么猫", holdFile: hold }), { name: "语音.webm", mime: "audio/webm" });
    // 前端发的顺序：引用的卡片、等着的附件、说完的语音（和文字模式的"卡片、附件、打的字"一样）
    const sent = await frontend.sendParts([
      { type: "card_ref", cardId: card.id },
      { type: "image", mediaId: image.mediaId, name: "猫.png", mime: "image/png", asMaterial: true },
      voice(audio.mediaId, 2600),
    ]);
    const recognizing = await voiceSettled(frontend, "recognizing");
    const message = await waitForMessage(frontend, sent.messageId);
    expect(message.parts).toEqual([
      { type: "card_ref", cardId: card.id },
      { type: "image", mediaId: image.mediaId, name: "猫.png", mime: "image/png", width: 8, height: 8, asMaterial: true },
      { type: "voice", voiceId: recognizing.id, mediaId: audio.mediaId, mime: "audio/webm", durationMs: 2600, waveform: [] },
    ]);
    // 识别还没完：整条（连同图片）在队里等着，秘书没开始处理
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toEqual([]);

    fs.writeFileSync(hold, "");
    await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    // 秘书收到的是同一条输入：卡片的摘要、图片的编号、语音转写依次在正文里，图片本身跟在正文后面
    const echo = lastEcho(frontend);
    // （投影第 2 版本来就逐个 part 投影、空一行连起来，语音和附件在同一条里不改它的规则，所以没有另加版本）
    expect(echo).toContain(`[user] [卡片：建议发起任务：整理家庭照片（重复照片太多）]\n\n[图片 1：猫.png（附件引用 ${image.mediaId}）]\n\n语音转写：帮我看看这是什么猫\n[image image/png]`);
    expect(echo.match(/\[user\]/g)).toHaveLength(1);
    expect(channelTypes(frontend).filter((t) => t === TURN_START)).toHaveLength(1);

    // 素材：图片由消息产生一条"用户主动投喂的材料"（标着这条消息还有语音），转写由识别完成的语音另产生一条，指向同一条消息
    await waitUntil(() => daemon.materials.list().filter((m) => m.conversation === SECRETARY).length === 2);
    const materials = daemon.materials.list().filter((m) => m.conversation === SECRETARY);
    expect(materials.find((m) => m.kind === "fed_material")).toMatchObject({
      source: "self",
      context: [SECRETARY, "with_attachment", "with_voice"],
      ref: { messageId: sent.messageId },
      segments: [
        { form: "agent_output", cardId: card.id },
        { form: "attachment", source: "external_untrusted", sha256: image.mediaId, label: "猫.png" },
      ],
    });
    expect(materials.find((m) => m.kind === "user_utterance")).toMatchObject({
      context: [SECRETARY, "voice_transcript"],
      ref: { messageId: sent.messageId, recordId: recognizing.id },
      segments: [{ form: "voice", source: "self", text: "帮我看看这是什么猫", media: { mediaId: audio.mediaId } }],
    });
    expect(daemon.materials.searchKeyword("猫.png").map((m) => m.kind)).toEqual(["fed_material"]);
  });

  it("语音识别失败时：秘书收到图片和「[语音，识别失败]」，图片照样记成素材", async () => {
    const { url, daemon } = await visionDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const image = await media.upload(url, png({ width: 8, height: 8 }), { name: "账单.png", mime: "image/png" });
    const audio = await media.upload(url, fakeRecording({ error: "听不清" }), { name: "语音.webm", mime: "audio/webm" });
    const sent = await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "账单.png", mime: "image/png" }, voice(audio.mediaId)]);
    await voiceSettled(frontend, "failed");
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain(`[user] [图片 1：账单.png（附件引用 ${image.mediaId}）]\n\n[语音，识别失败]\n[image image/png]`);
    await waitUntil(() => daemon.materials.list().some((m) => m.ref.messageId === sent.messageId));
    expect(daemon.materials.list().filter((m) => m.conversation === SECRETARY)).toMatchObject([
      { kind: "user_utterance", context: [SECRETARY, "with_attachment", "with_voice"], segments: [{ form: "attachment", label: "账单.png" }] },
    ]);
  });
});

describe("识别失败和重新识别", () => {
  it("引用了卡片的语音识别失败：照旧交给 agent，语音那段是「[语音，识别失败]」；用户在气泡菜单里重新识别，成功后另交给 agent 一条带文字的通知", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "重复照片太多" } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const audio = await media.upload(url, fakeRecording({ text: "下午买菜", errorUnless: ok }), { name: "语音.webm", mime: "audio/webm" });
    await frontend.sendParts([{ type: "card_ref", cardId: card.id }, voice(audio.mediaId)]);
    const failed = await voiceSettled(frontend, "failed");
    expect(failed.error).toBe("识别出错：听不清");
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[语音，识别失败]");

    // 识别失败的才能重新识别；同一个幂等键重发拿到同一个结果
    fs.writeFileSync(ok, "");
    const retried = await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry");
    expect(retried).toMatchObject({ ok: true, result: { voiceId: failed.id, version: failed.version + 1 } satisfies RetryVoiceResult });
    expect(await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry")).toMatchObject({ ok: true, result: { voiceId: failed.id, version: failed.version + 1 } });
    const done = await voiceSettled(frontend, (v) => v.status === "done" && v.attempt === 2);
    expect(done).toMatchObject({ recognition: { text: "下午买菜" } });
    expect(done).not.toHaveProperty("error");
    // 那条输入已经交给过秘书（当时是识别失败）：另交给它一条通知，带上识别出的文字
    await turnEnds(frontend, 2);
    expect(lastEcho(frontend)).toMatch(/\[user\] \[系统通知\]\n用户重新识别了之前没识别出来的那条语音，转写如下：\n语音转写：下午买菜/);

    expect(await frontend.request(METHODS.retryVoice, { voiceId: done.id }, "k-retry-2")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await frontend.request(METHODS.retryVoice, { voiceId: "v-没有" }, "k-retry-3")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("识别进程起不来（Python 路径不对、没装）：识别状态为失败，待我处理里放一条说明（开着的只有一条），只有语音的消息不交给秘书，守护进程照常运行", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "在的" }], recognizerCommand: [path.join(makeTempDir("ergo-nopy-"), "python.exe"), "recognizer.py"] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await sendVoice(frontend, url, { text: "第一条" });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed.error).toMatch(/^语音识别不可用：识别进程起不来/);
    await sendVoice(frontend, url, { text: "第二条" });
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "failed").length === 2);
    const notices = () =>
      frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item).filter((i) => i.kind === "notice" && i.notice === "voice_recognizer_unavailable");
    await waitUntil(() => notices().length > 0);
    expect(new Set(notices().map((i) => i.id)).size).toBe(1);
    expect(notices()[0]).toMatchObject({ title: "语音识别不可用", urgency: "non_blocking", body: expect.stringMatching(/voice\.recognizer\.python/) });
    // 守护进程照常：文字消息照常回（两条语音都没交给秘书，208 号票）
    await frontend.sendText("在吗");
    await turnEnds(frontend, 1);
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toHaveLength(1);
  });

  it("模型加载失败：这次识别失败、待我处理里说明；之后识别成功了，那条说明收进归档", async () => {
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await sendVoice(frontend, url, { fatal: "CUDA failed with error out of memory" });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed.error).toBe("语音识别不可用：模型加载失败：CUDA failed with error out of memory");
    const notice = () =>
      frontend
        .events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem })
        .map((f) => (f.payload as InboxItemEventPayload).item)
        .filter((i) => i.kind === "notice" && i.notice === "voice_recognizer_unavailable")
        .at(-1);
    await waitUntil(() => notice() !== undefined);
    await sendVoice(frontend, url, { text: "这回好了" });
    await voiceSettled(frontend, "done");
    await waitUntil(() => notice()?.archived === true);
  });
});

/** 208 号票：语音各个版本的状态，带第几次自动重试（"queued#2"） */
const retryVersions = (frontend: TestFrontend) => voiceVersions(frontend).map((v) => `${v.status}${v.autoRetry ? `#${v.autoRetry}` : ""}`);
/** 假识别进程识别过几次 */
const transcribes = (log: string) => recognizerLog(log).filter((e) => e.event === "transcribe").length;
/** 待我处理里"语音识别不可用"的说明（各个版本） */
const unavailableNotices = (frontend: TestFrontend) =>
  frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item).filter((i) => i.kind === "notice" && i.notice === "voice_recognizer_unavailable");
/** 210 号票：晚交的语音后面那句说明里的"几点几分"（消息的时间按守护进程的时区；测试底座不写 timeZone，就是本机的） */
const clockOf = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** 210 号票：交给秘书的各轮各是哪条消息（turn_start 的 inputMessageId，按先后） */
const turnInputs = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: TURN_START }).map((f) => (f.payload as TurnStartEventPayload).inputMessageId);
/** 210 号票：放行假识别进程某一次识别的文件（还没放上） */
const holdFile = () => path.join(makeTempDir("ergo-asr-hold-"), "go");
/** 210 号票：正在第 n 次自动重试（停在识别中）的语音 */
const retrying = (n: number) => (v: { status: string; autoRetry?: number }) => v.status === "recognizing" && v.autoRetry === n;

describe("识别没做成时自动重试（208 号票：不再把空白交给二狗）", () => {
  /** 正式的是隔 15 秒、60 秒、3 分钟重试；测试里隔 50 毫秒 */
  const RETRY = { voice: { recognizer: { autoRetrySeconds: [0.05, 0.05, 0.05] } } };
  const FILLER = "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目";

  it("第 1、2 次失败、第 3 次成功：中间等着重试时这条输入一直在队里等着，没交过「识别失败」；交给秘书的是识别出的文字；每次重试前先问一句识别进程", async () => {
    const { url, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "明天上午去银行", failTimes: 2 });
    const done = await voiceSettled(frontend, "done");
    expect(done).toMatchObject({ attempt: 1, autoRetry: 2, recognition: { text: "明天上午去银行" } });
    expect(done).not.toHaveProperty("retryAt");
    expect(done).not.toHaveProperty("error");
    // 气泡跟着走：识别中 → 等着第 1 次重试 → 第 1 次重试 → 等着第 2 次 → 第 2 次重试 → 完成
    expect(retryVersions(frontend)).toEqual(["queued", "recognizing", "queued#1", "recognizing#1", "queued#2", "recognizing#2", "done#2"]);
    const waiting = voiceVersions(frontend).filter((v) => v.status === "queued" && v.autoRetry);
    for (const v of waiting) {
      expect(Date.parse(v.retryAt!)).toBeGreaterThan(Date.parse(v.updatedAt));
      expect(v).not.toHaveProperty("error");
    }
    await turnEnds(frontend, 1);
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toHaveLength(1);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：明天上午去银行");
    expect(lastEcho(frontend)).not.toContain("识别失败");
    expect(recognizerLog(log).flatMap((e) => (e.event === "ping" || e.event === "transcribe" ? [e.event] : []))).toEqual(["transcribe", "ping", "transcribe", "ping", "transcribe"]);
  });

  it("识别时识别进程崩了：重试前先把它重新拉起来，这次照常识别", async () => {
    const { url, recognizerLog: log } = await startTestDaemon({ config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "又好了", crashTimes: 1 });
    expect(await voiceSettled(frontend, "done")).toMatchObject({ autoRetry: 1, recognition: { text: "又好了" } });
    expect(new Set(recognizerLog(log).filter((e) => e.event === "start").map((e) => e.pid)).size).toBeGreaterThanOrEqual(2);
  });

  it("4 次都失败（第一次和自动重试 3 次）：记成识别失败、写明原因；只有这段语音的消息不交给秘书（不唤起、不回话）；单条语音失败不进待我处理；之后打的字秘书只看到那一句", async () => {
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });
    const sent = await sendVoice(frontend, url, { text: "不会出来的", failTimes: 9 });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed).toMatchObject({ attempt: 1, autoRetry: 3, error: "识别出错：第 4 次没听清" });
    expect(failed).not.toHaveProperty("retryAt");
    expect(transcribes(log)).toBe(4);
    expect(retryVersions(frontend)).toEqual(["queued", "recognizing", "queued#1", "recognizing#1", "queued#2", "recognizing#2", "queued#3", "recognizing#3", "failed#3"]);
    // 失败的那条 voice 事件带着 dropInput：这条输入出队，秘书没被唤起
    expect((frontend.events({ channel: SECRETARY, type: VOICE }).at(-1)!.payload as VoiceEventPayload).dropInput).toBe(true);
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toEqual([]);
    expect(daemon.secretary.status).toBe("idle");
    expect(transcribes(log)).toBe(4);
    expect(unavailableNotices(frontend)).toEqual([]);

    await frontend.sendText("在吗");
    await turnEnds(frontend, 1);
    const echo = lastEcho(frontend);
    expect(echo).toContain("[user] 在吗");
    expect(echo.match(/\[user\]/g)).toHaveLength(1);
    expect(echo).not.toContain("识别失败");
  });

  it("带着附件的 4 次都失败：照旧交给秘书，图片照常、语音那段是「[语音，识别失败]」，后面一句说明这条消息是几点发的（210 号票：进过自动重试的晚交了）", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const image = await media.upload(url, png({ width: 8, height: 8 }), { name: "账单.png", mime: "image/png" });
    const audio = await media.upload(url, fakeRecording({ failTimes: 9 }), { name: "语音.webm", mime: "audio/webm" });
    const sent = await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "账单.png", mime: "image/png" }, voice(audio.mediaId)]);
    expect(await voiceSettled(frontend, "failed")).toMatchObject({ autoRetry: 3 });
    expect((frontend.events({ channel: SECRETARY, type: VOICE }).at(-1)!.payload as VoiceEventPayload).dropInput).toBeUndefined();
    await turnEnds(frontend, 1);
    const { time } = await waitForMessage(frontend, sent.messageId);
    expect(lastEcho(frontend)).toContain(`[user] [图片 1：账单.png（附件引用 ${image.mediaId}）]\n\n[语音，识别失败]\n（这条消息是 ${clockOf(time)} 发的，语音识别晚了，最后也没识别出来）`);
  });

  it("静音、只有串词的：重试也没用，不自动重试，直接记成失败；只有这段语音的不交给秘书", async () => {
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const silent = await sendVoice(frontend, url, { text: "" });
    expect(await voiceSettled(frontend, (v) => v.messageId === silent.messageId && v.status === "failed")).toMatchObject({ error: "没有识别出说话的内容" });
    const filler = await sendVoice(frontend, url, { text: FILLER });
    expect(await voiceSettled(frontend, (v) => v.messageId === filler.messageId && v.status === "failed")).toMatchObject({ onlyFiller: true });
    expect(voiceVersions(frontend).some((v) => v.autoRetry !== undefined)).toBe(false);
    expect(transcribes(log)).toBe(2);
    expect(inputOf(daemon.store.reader, silent.messageId)?.status).toBe("dropped");
    expect(inputOf(daemon.store.reader, filler.messageId)?.status).toBe("dropped");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toEqual([]);
  });

  it("手动重新识别：一次只试一次（重试前照样先看识别服务）；成功后这条语音作为一条正常的用户输入交给秘书（就是那条消息，第一次交，不是通知）", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "下午去买菜", errorUnless: ok });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed).toMatchObject({ attempt: 1, autoRetry: 3 });
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");

    // 重新识别又失败了：只试这一次，不再自动连试；照旧不交
    expect((await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-1")).ok).toBe(true);
    const again = await voiceSettled(frontend, (v) => v.status === "failed" && v.attempt === 2);
    expect(again).not.toHaveProperty("autoRetry");
    expect(transcribes(log)).toBe(5);
    expect(recognizerLog(log).at(-2)?.event).toBe("ping");
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");

    // 这回成功了：那条消息回到输入队列，秘书看到的是这条用户输入（语音转写），没有"重新识别"的通知
    fs.writeFileSync(ok, "");
    expect((await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-2")).ok).toBe(true);
    const done = await voiceSettled(frontend, (v) => v.status === "done" && v.attempt === 3);
    expect(done).toMatchObject({ recognition: { text: "下午去买菜" } });
    expect((frontend.events({ channel: SECRETARY, type: VOICE }).at(-1)!.payload as VoiceEventPayload).restoreInput).toBe(true);
    await turnEnds(frontend, 1);
    expect((frontend.events({ channel: SECRETARY, type: TURN_START })[0]!.payload as TurnStartEventPayload).inputMessageId).toBe(sent.messageId);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：下午去买菜");
    expect(lastEcho(frontend)).not.toContain("用户重新识别了之前没识别出来的那条语音");
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("done");
  });

  it("识别服务不正常（模型加载不了）：每次重试前先重新拉起它；3 次都失败才在待我处理里放一条说明（开着的只有一条）；修好后手动重新识别成功，说明收进归档", async () => {
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: RETRY, recognizerLoad: { fatal: "CUDA failed" }, recognizerRetryMs: [60_000] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    const loadsBefore = () => recognizerLog(log).filter((e) => e.event === "load").length;
    await waitUntil(() => loadsBefore() >= 1);
    const sent = await sendVoice(frontend, url, { text: "第一条" });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed).toMatchObject({ autoRetry: 3, error: "语音识别不可用：模型加载失败：CUDA failed" });
    // 第一次和 3 次重试各拉起、加载了一次（预热那一次另算）
    expect(loadsBefore()).toBeGreaterThanOrEqual(4);
    await waitUntil(() => unavailableNotices(frontend).length > 0);
    // 说明是 3 次都失败之后才放的
    const events = daemon.store.readGlobal(0, 100_000);
    const noticeAt = events.findIndex((e) => e.type === EVENT_TYPES.inboxItem && (e.payload as InboxItemEventPayload).item.kind === "notice");
    const lastWaitAt = events.findLastIndex((e) => e.type === VOICE && (e.payload as VoiceEventPayload).voice.status === "recognizing" && (e.payload as VoiceEventPayload).voice.autoRetry === 3);
    expect(noticeAt).toBeGreaterThan(lastWaitAt);
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");

    // 修好了：手动重新识别先重新拉起识别进程，成功；那条说明收进归档
    setFakeLoad(log, undefined);
    expect((await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-fixed")).ok).toBe(true);
    expect(await voiceSettled(frontend, (v) => v.status === "done" && v.attempt === 2)).toMatchObject({ recognition: { text: "第一条" } });
    await waitUntil(() => unavailableNotices(frontend).at(-1)?.archived === true);
    expect(new Set(unavailableNotices(frontend).map((i) => i.id)).size).toBe(1);
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：第一条");
  });

  it("守护进程重启时，重试中的语音接着重试：等着的到点再试，次数接着算", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    const first = await startTestDaemon({ config: { voice: { recognizer: { autoRetrySeconds: [0.05, 2, 0.05] } } } });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, first.url, { text: "重启前说的", errorUnless: ok });
    const waiting = await voiceSettled(frontend, (v) => v.status === "queued" && v.autoRetry === 2);
    await frontend.close();
    await first.daemon.stop();

    fs.writeFileSync(ok, "");
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const again = await TestFrontend.connect(second.url);
    await again.subscribe({ [SECRETARY]: 0 });
    const done = await voiceSettled(again, "done");
    expect(done).toMatchObject({ attempt: 1, autoRetry: 2, recognition: { text: "重启前说的" } });
    expect(Date.parse(done.recognition!.time)).toBeGreaterThanOrEqual(Date.parse(waiting.retryAt!));
    // 重启后只识别了一次（第 2 次重试），没有从头再来
    expect(transcribes(second.recognizerLog)).toBe(1);
  });
});

describe("自动重试期间不挡后面的输入（210 号票，用户 2026-10-20：语音重试期间，我发的文字可以先发给二狗）", () => {
  /** 正式的是隔 15 秒、60 秒、3 分钟重试；测试里隔 50 毫秒，"重试中"由假识别进程停住（holdEach），测试放行 */
  const RETRY = { voice: { recognizer: { autoRetrySeconds: [0.05, 0.05, 0.05] } } };
  /** 秘书每一轮都回显它看到的上下文（几轮就几步） */
  const ECHO = Array.from({ length: 4 }, () => ({ kind: "echo_context" as const }));

  it("第一次识别照旧挡着后面打的字；第一次识别失败、开始等重试的那一刻起，排在它后面的马上交、秘书回话，重试中再打的照常交；重试成功后语音的文字带一句「几点说的、识别晚了」作为新输入排在最后交过去", async () => {
    const first = holdFile();
    const retry = holdFile();
    const { url, daemon } = await startTestDaemon({ secretary: ECHO, config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });
    const sent = await sendVoice(frontend, url, { text: "明天上午去银行", failTimes: 1, holdEach: [first, retry] });
    await voiceSettled(frontend, (v) => v.status === "recognizing" && v.autoRetry === undefined);

    // 第一次识别中（平时几秒钟）：后面打的字照旧在它后面等着，保证二狗按说话的顺序看
    const weather = await frontend.sendText("先帮我查下天气");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(turnInputs(frontend)).toEqual([]);

    // 第一次识别失败、开始等重试：已经排在它后面的那句马上交给秘书
    fs.writeFileSync(first, "");
    await turnEnds(frontend, 1);
    expect(turnInputs(frontend)).toEqual([weather.messageId]);
    expect(lastEcho(frontend)).toContain("[user] 先帮我查下天气");
    expect(lastEcho(frontend)).not.toContain("语音转写");

    // 重试中再打的字照常交
    await voiceSettled(frontend, retrying(1));
    const traffic = await frontend.sendText("再查下路况");
    await turnEnds(frontend, 2);
    expect(turnInputs(frontend)).toEqual([weather.messageId, traffic.messageId]);
    expect(voiceVersions(frontend).at(-1)).toMatchObject({ status: "recognizing", autoRetry: 1 });
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("pending");

    // 重试成功：语音的文字作为一条新输入交过去，排在最后，带一句给秘书看的说明（几点说的、识别晚了）
    fs.writeFileSync(retry, "");
    expect(await voiceSettled(frontend, "done")).toMatchObject({ autoRetry: 1, recognition: { text: "明天上午去银行" } });
    await turnEnds(frontend, 3);
    expect(turnInputs(frontend)).toEqual([weather.messageId, traffic.messageId, sent.messageId]);
    const { time } = await waitForMessage(frontend, sent.messageId);
    const echo = lastEcho(frontend);
    expect(echo).toContain(`[user] 语音转写：明天上午去银行\n（这条语音是 ${clockOf(time)} 说的，识别晚了）`);
    expect(echo.indexOf("再查下路况")).toBeLessThan(echo.indexOf("语音转写"));
    expect(echo.match(/识别晚了/g)).toHaveLength(1);
  });

  it("第一次就识别成功的、手动重新识别成功的：照旧，不带「识别晚了」的说明", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    const { url } = await startTestDaemon({ secretary: ECHO, config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "一次就好" });
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：一次就好");
    expect(lastEcho(frontend)).not.toContain("识别晚了");

    const sent = await sendVoice(frontend, url, { text: "下午去买菜", errorUnless: ok });
    const failed = await voiceSettled(frontend, (v) => v.messageId === sent.messageId && v.status === "failed");
    fs.writeFileSync(ok, "");
    expect((await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-210")).ok).toBe(true);
    await turnEnds(frontend, 2);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：下午去买菜");
    expect(lastEcho(frontend)).not.toContain("识别晚了");
  });

  it("重试完了还不行（只有这段语音的）：照 208 号票不交、不唤起；重试期间打的字照常交，秘书只看到打的字", async () => {
    const retry = holdFile();
    const { url, daemon } = await startTestDaemon({ secretary: ECHO, config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "不会出来的", failTimes: 9, holdEach: [null, retry] });
    await voiceSettled(frontend, retrying(1));
    const text = await frontend.sendText("在吗");
    await turnEnds(frontend, 1);
    expect(turnInputs(frontend)).toEqual([text.messageId]);

    fs.writeFileSync(retry, "");
    expect(await voiceSettled(frontend, "failed")).toMatchObject({ autoRetry: 3 });
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(turnInputs(frontend)).toEqual([text.messageId]);
    expect(daemon.secretary.status).toBe("idle");
    expect(lastEcho(frontend)).not.toContain("语音转写");
    expect(lastEcho(frontend)).not.toContain("识别失败");
  });

  it("语音带着附件的：整条等这段语音定了再交，但不挡后面的；重试成功后整条作为新输入交过去（图片照常、语音转写后面带说明）", async () => {
    const retry = holdFile();
    const { url } = await startTestDaemon({ secretary: ECHO, config: RETRY });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const image = await media.upload(url, png({ width: 8, height: 8 }), { name: "账单.png", mime: "image/png" });
    const audio = await media.upload(url, fakeRecording({ text: "这张账单对吗", failTimes: 1, holdEach: [null, retry] }), { name: "语音.webm", mime: "audio/webm" });
    const sent = await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "账单.png", mime: "image/png" }, voice(audio.mediaId)]);
    await voiceSettled(frontend, retrying(1));
    const text = await frontend.sendText("顺便看下明天的日程");
    await turnEnds(frontend, 1);
    expect(turnInputs(frontend)).toEqual([text.messageId]);
    expect(lastEcho(frontend)).not.toContain("账单.png");

    fs.writeFileSync(retry, "");
    await voiceSettled(frontend, "done");
    await turnEnds(frontend, 2);
    expect(turnInputs(frontend)).toEqual([text.messageId, sent.messageId]);
    const { time } = await waitForMessage(frontend, sent.messageId);
    expect(lastEcho(frontend)).toContain(`[user] [图片 1：账单.png（附件引用 ${image.mediaId}）]\n\n语音转写：这张账单对吗\n（这条语音是 ${clockOf(time)} 说的，识别晚了）`);
  });

  it("守护进程重启后规矩一样：重试中的语音接着重试，不挡重启后打的字；重试成功后照样带说明交过去", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    // 假识别进程按它的记录文件数第几次识别，重启后的守护进程是新的一份（又从第 1 次数）：
    // 重启前第 1 次不停、识别出错，第 2 次（第 1 次重试）停住；重启前拿掉 gate，重启后接着的第 1 次重试（新记录里的第 1 次）停住
    const gate = holdFile();
    fs.writeFileSync(gate, "");
    const first = await startTestDaemon({ config: RETRY });
    const before = await TestFrontend.connect(first.url);
    await before.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(before, first.url, { text: "重启前说的", errorUnless: ok, holdEach: [gate, holdFile()] });
    await voiceSettled(before, retrying(1));
    await before.close();
    await first.daemon.stop();
    fs.rmSync(gate);

    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir }, secretary: ECHO });
    const frontend = await TestFrontend.connect(second.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const text = await frontend.sendText("重启后打的字");
    await turnEnds(frontend, 1);
    expect(turnInputs(frontend)).toEqual([text.messageId]);
    expect(lastEcho(frontend)).not.toContain("重启前说的");
    expect(voiceVersions(frontend).at(-1)).toMatchObject({ status: "recognizing", autoRetry: 1 });

    fs.writeFileSync(ok, "");
    fs.writeFileSync(gate, "");
    expect(await voiceSettled(frontend, "done")).toMatchObject({ autoRetry: 1, recognition: { text: "重启前说的" } });
    await turnEnds(frontend, 2);
    expect(turnInputs(frontend)).toEqual([text.messageId, sent.messageId]);
    const { time } = await waitForMessage(frontend, sent.messageId);
    expect(lastEcho(frontend)).toContain(`[user] 语音转写：重启前说的\n（这条语音是 ${clockOf(time)} 说的，识别晚了）`);
  });
});

describe("识别进程", () => {
  it("守护进程一起来就拉起、加载模型（45 号票的预热；环境照 agent 子进程的白名单，没有守护进程的密钥）；配了闲置退出的，闲置超过配置的时间自动退出、不重拉，再来语音时重新拉起", async () => {
    const { url, recognizerLog: log } = await startTestDaemon({
      config: { voice: { recognizer: { idleMinutes: 0.01 } } },
      env: { DEEPSEEK_API_KEY: "sk-不该给识别进程", ERGO_SENTINEL_VOICE: "x" },
    });
    // 还没有语音：识别进程已经起来、加载了模型
    await waitUntil(() => recognizerLog(log).some((e) => e.event === "load"));
    const first = recognizerLog(log).find((e) => e.event === "start")!;
    expect(first.env).toEqual(expect.arrayContaining(["PATH", "HF_HUB_OFFLINE"]));
    expect(first.env!.map((n) => n.toUpperCase())).not.toContain("DEEPSEEK_API_KEY");
    expect(first.env).not.toContain("ERGO_SENTINEL_VOICE");
    // 闲置 0.6 秒后退出；不重拉
    await waitUntil(() => recognizerLog(log).some((e) => e.event === "exit") && !isProcessAlive(first.pid!), { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recognizerLog(log).filter((e) => e.event === "start")).toHaveLength(1);
    expect((await voiceModelsApi.get(url)).body.recognizer.status).toBe("unloaded");

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "第一条" });
    await voiceSettled(frontend, "done");
    await waitUntil(() => recognizerLog(log).filter((e) => e.event === "exit").length === 2, { timeoutMs: 10_000 });

    await sendVoice(frontend, url, { text: "第二条" });
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "done").length === 2);
    // 预热的一次、两条语音各一次，每次都是新进程
    const starts = recognizerLog(log).filter((e) => e.event === "start");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((s) => s.pid)).size).toBe(3);
  });

  it("识别进程在识别时退出了：这条识别失败，下一条重新拉起照常识别", async () => {
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { crash: "Segmentation fault" });
    expect((await voiceSettled(frontend, "failed")).error).toMatch(/识别进程退出了.*Segmentation fault/);
    await sendVoice(frontend, url, { text: "又好了" });
    await voiceSettled(frontend, "done");
  });

  it("守护进程重启后，上次排队、识别中的语音接着识别", async () => {
    const hold = path.join(makeTempDir("ergo-hold-"), "go");
    const first = await startTestDaemon();
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, first.url, { text: "重启前说的", holdFile: hold });
    await voiceSettled(frontend, "recognizing");
    await first.daemon.stop();

    fs.writeFileSync(hold, "");
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const again = await TestFrontend.connect(second.url);
    await again.subscribe({ [SECRETARY]: 0 });
    expect((await voiceSettled(again, "done")).recognition).toMatchObject({ text: "重启前说的" });
  });
});

/** 秘书提议一个快速动作 */
const propose = (type: string, params: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type, params } as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
/** 快速动作卡，每张取最新的样子 */
const quickCards = (frontend: TestFrontend) => [...new Map(cardsOf(frontend).filter((c) => c.type === "quick_action").map((c) => [c.id, c])).values()];

describe("快速动作的点明（语音转写和打的字一样参与判定）", () => {
  it("引用任务的计划卡，用语音说「把这个暂停」；再用语音说「取消任务 t-1」：都算点明，直接执行，不进待我处理", async () => {
    const td = await startTestDaemon({
      secretary: [propose("pause_task", { task: "t-1" }), say("暂停了"), propose("cancel_task", { task: "t-1" }), say("取消了")],
      maintainer: maintainerScript(),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.board]: 0, [CHANNELS.inbox]: 0 });
    const taskId = await runningTask(td, frontend, "整理发票");
    const plan = cardsOf(frontend).find((c) => c.type === "plan")!;

    // 语音消息可以带引用的卡片（一段语音加卡片引用）
    const recording = await media.upload(td.url, fakeRecording({ text: "把这个暂停" }), { name: "语音.webm", mime: "audio/webm" });
    const sent = await frontend.sendParts([{ type: "card_ref", cardId: plan.id }, voice(recording.mediaId)]);
    const stored = await waitForMessage(frontend, sent.messageId);
    expect(stored.parts.map((p) => p.type)).toEqual(["card_ref", "voice"]);
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "paused", "任务暂停")).toMatchObject({ by: "user", task: { id: taskId, state: "paused" } });

    await sendVoice(frontend, td.url, { text: "取消任务 t-1" });
    expect(await eventually(() => tasksOf(frontend), (e) => e.change === "cancelled", "任务取消")).toMatchObject({ by: "user", task: { id: taskId, state: "cancelled" } });

    expect(quickCards(frontend).map((c) => [(c.payload as { action: { type: string } }).action.type, c.status, (c.payload as { explicit: boolean }).explicit])).toEqual([
      ["pause_task", "handled", true],
      ["cancel_task", "handled", true],
    ]);
    const inbox = frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
    expect(inbox.filter((i) => i.kind === "card" && quickCards(frontend).some((c) => c.id === i.cardId))).toEqual([]);
  }, 90_000);

  it("语音里说「记住……」：直接执行，显式记忆命令素材注明是语音转写；识别失败的语音不算点明，推断出来的先问", async () => {
    const td = await startTestDaemon({ secretary: [propose("remember", { content: "下周三上午体检" }), say("记下了"), propose("remember", { content: "周五交房租" }), say("要记下吗")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0 });
    await sendVoice(frontend, td.url, { text: "记住，下周三上午体检。" });
    await turnEnds(frontend, 1);
    expect(quickCards(frontend)).toMatchObject([{ status: "handled", payload: { action: { type: "remember" }, explicit: true } }]);
    expect(td.daemon.materials.list({ kind: "memory_command" })).toMatchObject([
      { source: "self", conversation: SECRETARY, segments: [{ form: "voice", source: "self", notes: ["transcribed"], text: "下周三上午体检" }] },
    ]);

    // 识别失败、只有语音的不交给秘书（208 号票），带着图片的照旧交：语音那段没有文字，不算点明
    const image = await media.upload(td.url, png({ width: 8, height: 8 }), { name: "房租.png", mime: "image/png" });
    const audio = await media.upload(td.url, fakeRecording({ error: "听不清" }), { name: "语音.webm", mime: "audio/webm" });
    await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "房租.png", mime: "image/png" }, voice(audio.mediaId)]);
    await turnEnds(frontend, 2);
    expect(quickCards(frontend).at(-1)).toMatchObject({ status: "pending", payload: { explicit: false, disposition: "ask_first" } });
  });
});

describe("维护者干活时用户发的话排队（144 号票）", () => {
  const M1 = maintainerChannel("tm-1");
  const echo: FauxStep = { kind: "echo_context" };
  const turnEndsOf = (frontend: TestFrontend) => frontend.events({ channel: M1, type: TURN_END }).map((f) => f.payload as { inputMessageId: string });

  it("干活时发的语音（识别还没完）和打的字一起排队：这一轮做完一起交出去，等语音识别完了作为一轮的输入交给维护者（语音在前）", async () => {
    const hold = path.join(makeTempDir("ergo-hold-"), "go");
    const td = await startTestDaemon({
      maintainer: (_maintainerId, spawn) =>
        spawn === 1
          ? [submitPlanStep(onePlan()), { kind: "reply", text: "计划交上去了" }]
          : [{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "sleep 3" } as never }] }, echo, echo],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [M1]: 0, [CHANNELS.cards]: 0, [CHANNELS.board]: 0 });
    await runningTask(td, frontend, "整理发票");
    // 维护者开始执行（在跑 sleep 3）：这时先发一条语音（识别卡住），再打一句字
    await waitUntil(() => frontend.events({ channel: M1, type: TURN_START }).length >= 2, { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const spoken = await sendVoice(frontend, td.url, { text: "先做三月的", holdFile: hold }, { conversation: M1 });
    const typed = await frontend.sendText("再做四月的", { conversation: M1 });
    expect(typed.queued).toBe(true);
    await waitUntil(() => turnEndsOf(frontend).length >= 2, { timeoutMs: 20_000, describe: () => "执行的那一轮结束" });
    // 那一轮里两句都没交给它；结束后一起交出去，语音还没识别完，整批等着
    expect(turnEndsOf(frontend).map((e) => e.inputMessageId)).not.toContain(typed.messageId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frontend.events({ channel: M1, type: TURN_START })).toHaveLength(2);

    fs.writeFileSync(hold, "");
    await waitUntil(() => turnEndsOf(frontend).length >= 3, { timeoutMs: 20_000, describe: () => "语音和打的字都处理完" });
    expect(turnEndsOf(frontend)[2]).toEqual(expect.objectContaining({ inputMessageId: spoken.messageId, moreInputMessageIds: [typed.messageId] }));
    const last = frontend.events({ channel: M1, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent").at(-1)!;
    const context = stripTimeMarkers(textOf(last.parts));
    expect(context.indexOf("[user] 语音转写：先做三月的")).toBeGreaterThanOrEqual(0);
    expect(context.indexOf("[user] 语音转写：先做三月的")).toBeLessThan(context.indexOf("再做四月的"));
  }, 90_000);
});

// 179 号票：排队时就建出语音、识别完了（voice 事件在前），agent 又说了一页多才交出去成为消息（message 事件在后）。
// 新打开的页面（任务页、项目的会话页、秘书主线）第一次订阅只补发最近一页，语音的 voice 事件落在这一页之前——补发要先带上它，
// 不然前端拿不到语音对象，气泡一直是"识别中…"（10-19 日报那一轮的真事）。
/** 新打开一个页面，第一次订阅这个会话（游标 0），等补发到现在的最后一条 */
async function freshPage(td: TestDaemon, conversation: ConversationId): Promise<TestFrontend> {
  const page = await TestFrontend.connect(td.url);
  await page.subscribe({ [conversation]: 0 });
  const last = td.daemon.store.lastSeq(conversation);
  await waitUntil(() => page.events({ channel: conversation, persistedOnly: true }).some((f) => f.seq === last), { timeoutMs: 10_000, describe: () => `补发到 ${last}` });
  return page;
}

/** 补发的这一页里最早那条消息的序号 */
const firstMessageSeq = (page: TestFrontend, conversation: ConversationId) => page.events({ channel: conversation, type: MESSAGE })[0]!.seq;

describe("第一次订阅补发的那一页带上它引用的语音对象（179 号票）", () => {
  /** 说得慢的一大段：吐字放慢后要说好一会儿，够在它说着的时候排队 */
  const LONG = "这是一段很长很长的回复，要说好一会儿。".repeat(60);
  const PM1 = maintainerChannel("pm-1");

  it.each([
    { where: "项目维护者的会话（任务页、项目的会话页）", conversation: PM1 },
    { where: "秘书主线", conversation: SECRETARY },
  ])("$where：回复中发的语音排队时就识别完了，agent 又说了一页多才交出去——新打开的页面里，排着的、交出去之后的这条语音都显示识别出的文字", async ({ conversation }) => {
    const td = await startTestDaemon(
      conversation === PM1
        ? { maintainer: (id) => (id === "pm-1" ? [{ kind: "reply", text: LONG }, { kind: "reply", text: "收到。" }] : []), maintainerTokensPerSecond: 20 }
        : { secretary: [{ kind: "reply", text: LONG }, { kind: "reply", text: "收到。" }], secretaryTokensPerSecond: 20 },
    );
    if (conversation === PM1) seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [conversation]: 0 });
    await frontend.sendText("出今天的日报", { conversation });
    await frontend.next(conversation, EVENT_TYPES.stream, 30_000);

    // 它正说着：发一条语音，排进队；排着的时候就识别完了
    const spoken = await sendVoice(frontend, td.url, { text: "这个权限要审批啊，你为啥要用这个权限呢？" }, { conversation });
    expect(spoken).toMatchObject({ queued: true });
    const done = await voiceSettled(frontend, "done");
    expect(done.messageId).toBe(spoken.messageId);
    // 这一轮里它又说了一页多（直接追加，不惊动它）；还说着时又打了一句字，也排进队
    for (let i = 1; i <= HISTORY_PAGE_SIZE + 5; i++) appendMessage(td.daemon.store, { conversation, speaker: "agent", parts: [{ type: "text", text: `查第 ${i} 个来源` }] });
    expect(await frontend.sendText("先别写了", { conversation })).toMatchObject({ queued: true });
    const lastVoiceSeq = td.daemon.store.read(conversation, 0, VOICE).at(-1)!.seq;

    // 排着的时候新打开一个页面：这一轮还开着，补发从这一轮的开头起，排着的语音照样是识别完的样子
    const queuedPage = await freshPage(td, conversation);
    expect(voiceVersions(queuedPage, done.id).at(-1)).toMatchObject({ status: "done", version: done.version, recognition: { text: "这个权限要审批啊，你为啥要用这个权限呢？" } });

    // 停下这一轮：排着的交出去（这时这条语音才成为会话里的消息），作为下一轮
    expect((await frontend.request(METHODS.stopReply, { conversation }, "k-stop-179")).ok).toBe(true);
    await waitUntil(() => td.daemon.store.read(conversation, 0, TURN_END).length >= 2, { timeoutMs: 30_000, describe: () => channelTypes(frontend).join(" ") });
    const deliveredSeq = td.daemon.store.read(conversation, 0, MESSAGE).find((e) => (e.payload as MessageEventPayload).message.id === spoken.messageId)!.seq;
    expect(deliveredSeq).toBeGreaterThan(lastVoiceSeq);

    // 交出去之后新打开一个页面：这条语音消息在补发的这一页里（这一页从语音的 voice 事件之后起），语音对象也在——
    // 只先补它最新的那一版（序号在这一页之前，按序号先到），这一页之前的别的一概不补
    const page = await freshPage(td, conversation);
    expect(page.events({ channel: conversation, type: MESSAGE }).some((f) => (f.payload as MessageEventPayload).message.id === spoken.messageId)).toBe(true);
    expect(firstMessageSeq(page, conversation)).toBeGreaterThan(lastVoiceSeq);
    expect(page.events({ channel: conversation, persistedOnly: true }).filter((f) => f.seq <= lastVoiceSeq)).toEqual([expect.objectContaining({ seq: lastVoiceSeq, type: VOICE })]);
    expect(voiceVersions(page, done.id)).toEqual([expect.objectContaining({ status: "done", version: done.version, recognition: expect.objectContaining({ text: "这个权限要审批啊，你为啥要用这个权限呢？" }) })]);
    const seqs = page.events({ channel: conversation, persistedOnly: true }).map((f) => f.seq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
  }, 90_000);
});

describe("素材", () => {
  it("用户的语音算用户发言（本人）：文字取识别出的文字，信封标语音转写；原文副本里同时有识别文字和音频的引用；彻底删除时音频、文字和原文副本一起删", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: "帮我找一下上周的体检报告" });
    const done = await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);

    await waitUntil(() => daemon.materials.searchKeyword("体检报告", { limit: 5 }).length > 0);
    const [material] = daemon.materials.searchKeyword("体检报告", { limit: 5 });
    expect(material).toMatchObject({
      kind: "user_utterance",
      mode: "say",
      source: "self",
      conversation: SECRETARY,
      time: done.createdAt,
      context: [SECRETARY, "voice_transcript"],
      ref: { messageId: sent.messageId, recordId: done.id },
      segments: [{ form: "voice", source: "self", notes: ["transcribed"], text: "帮我找一下上周的体检报告", media: { mediaId: sent.mediaId } }],
    });
    const originalFile = path.join(daemon.layout.materials, ...material!.original!.path.split("/"));
    const original = fs.readFileSync(originalFile, "utf8");
    for (const piece of ["帮我找一下上周的体检报告", sent.mediaId]) expect(original).toContain(piece);

    // 设置里按会话彻底删除
    const secretaryPid = daemon.secretary.pid;
    const deleted = await materialsApi.delete(url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-voice" });
    expect(deleted.status).toBe(200);
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(purged.messages.map((m) => m.messageId)).toContain(sent.messageId);
    expect(purged.mediaIds).toContain(sent.mediaId);
    // 事件日志里：消息换成"已删除"，这条语音识别出的文字和分段都去掉了（状态、模型这些还在）
    const events = daemon.store.read(SECRETARY, 0);
    expect(events.find((e) => (e.payload as { messageId?: string }).messageId === sent.messageId && isDeletedEventPayload(e.payload))).toBeDefined();
    expect(JSON.stringify(events)).not.toMatch(/体检报告/);
    expect(events.filter((e) => e.type === VOICE).map((e) => (e.payload as VoiceEventPayload).voice.status)).toEqual(["queued", "recognizing", "done"]);
    // 原文副本删了，音频没有别的引用也删了
    expect(fs.existsSync(originalFile)).toBe(false);
    await waitUntil(() => !fs.existsSync(path.join(daemon.layout.media, sent.mediaId)));
    expect((await request(url, `/api/media/${sent.mediaId}`)).status).toBe(404);
    // 秘书的会话文件里那条输入也改写了：秘书停下、改写、再拉起（改写做完才拉起），等它拉起来了再读一次会话文件。
    // 255 号票：以前在改写途中反复读会话文件——读的那一刻正好赶上改写子进程改名，Windows 上改名就 EPERM
    // （改写以前碰上一次就放弃、等下次启动，用例空等 20 秒报"等待超时"）；目录里还会列出改写的临时文件，读它时已经改名没了（ENOENT）
    await waitUntil(() => daemon.secretary.pid !== undefined && daemon.secretary.pid !== secretaryPid && daemon.secretary.status === "idle", {
      timeoutMs: 20_000,
      describe: () => `秘书改写会话文件后重新拉起：pid ${daemon.secretary.pid}（删除前 ${secretaryPid}），状态 ${daemon.secretary.status}`,
    });
    const sessionDir = path.join(daemon.layout.sessions, "secretary");
    const sessionFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    expect(sessionFiles.length).toBeGreaterThan(0);
    for (const f of sessionFiles) expect(fs.readFileSync(path.join(sessionDir, f), "utf8")).not.toContain("体检报告");
  });

  it("识别失败的语音没有文字、不产生素材，但设置里按会话、按时间段彻底删除时照样删掉它的消息和音频；忘掉、别推断不碰它", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const first = await sendVoice(frontend, url, { error: "听不清" });
    const failed = await voiceSettled(frontend, "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(daemon.materials.list().filter((m) => m.conversation === SECRETARY)).toEqual([]);
    const audioOf = (mediaId: string) => path.join(daemon.layout.media, mediaId);
    expect(fs.existsSync(audioOf(first.mediaId))).toBe(true);

    // 范围里没有素材，但有一条没识别出文字的语音：数出来告诉设置页
    const scope = { kind: "conversation" as const, conversation: SECRETARY };
    expect((await materialsApi.scope(url, scope)).body).toMatchObject({ count: 0, voices: 1 });
    // 忘掉、别推断只管素材：语音原样留着
    expect((await materialsApi.delete(url, { scope, mode: "forget", idempotencyKey: "forget-failed" })).body).toEqual({ count: 0 });
    expect(fs.existsSync(audioOf(first.mediaId))).toBe(true);

    // 按会话彻底删除：消息换成"已删除"，录音删掉，失败原因也换成删除标记
    expect((await materialsApi.delete(url, { scope, mode: "purge", idempotencyKey: "purge-failed" })).status).toBe(200);
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(purged.messages.map((m) => m.messageId)).toEqual([first.messageId]);
    expect(purged.mediaIds).toEqual([first.mediaId]);
    await waitUntil(() => !fs.existsSync(audioOf(first.mediaId)));
    const voiceEvents = daemon.store.read(SECRETARY, 0, EVENT_TYPES.voice).map((e) => (e.payload as VoiceEventPayload).voice).filter((v) => v.id === failed.id);
    expect(voiceEvents.find((v) => v.status === "failed")!.error).not.toContain("听不清");
    expect((await materialsApi.scope(url, scope)).body).toEqual(expect.not.objectContaining({ voices: expect.anything() }));

    // 按时间段彻底删除：时间按说话的时间
    const second = await sendVoice(frontend, url, { error: "太吵了" });
    const failedAgain = await voiceSettled(frontend, (v) => v.status === "failed" && v.id !== failed.id);
    const range = { kind: "time_range" as const, from: failedAgain.createdAt, to: failedAgain.createdAt };
    expect((await materialsApi.scope(url, range)).body).toMatchObject({ count: 0, voices: 1 });
    expect((await materialsApi.delete(url, { scope: range, mode: "purge", idempotencyKey: "purge-failed-range" })).status).toBe(200);
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.messagesPurged }).length === 2);
    await waitUntil(() => !fs.existsSync(audioOf(second.mediaId)));
    expect(JSON.stringify(daemon.store.read(SECRETARY, 0))).not.toMatch(/听不清|太吵了/);
  });
});

/** 日志里不该有转写的正文（180 号票：串词本身、用户说的话） */
function expectNoTranscript(lines: readonly string[], ...words: string[]) {
  for (const line of lines) for (const word of ["与点点", "请不吝点赞", ...words]) expect(line).not.toContain(word);
}

/** 日志里剔除串词的那几行（180 号票） */
const strippedLines = (lines: readonly string[]) => lines.filter((line) => line.includes("剔除了"));

/** 一段 WAV"录音"的 base64（悬浮按钮、Debug 页送识别的样子） */
const wavBase64 = (text: string) => Buffer.from(fakeWavRecording({ text })).toString("base64");

describe("识别结果里剔掉模型自带的串词（180 号票：FasterWhisper 自己编进来的「请不吝点赞 订阅 转发……」，当成没说过）", () => {
  const AD = "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目";

  it("串词夹在语音里：气泡下的文字、交给秘书的、素材里都没有它，别的话一字不差、分段对得上；日志里有剔除的记录、没有正文", async () => {
    const lines: string[] = [];
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], log: (line) => lines.push(line) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await sendVoice(frontend, url, { text: `帮我查一下周五的会议室。${AD}。谢谢。`, seconds: 3 });
    const done = await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    expect(done.recognition).toMatchObject({
      text: "帮我查一下周五的会议室。谢谢。",
      segments: [
        { start: 0, end: 1, text: "帮我查一下周五的会议室。" },
        { start: 2, end: 3, text: "谢谢。" },
      ],
    });
    expect(lastEcho(frontend)).toContain("[user] 语音转写：帮我查一下周五的会议室。谢谢。");
    expect(lastEcho(frontend)).not.toMatch(/点赞|明镜/);
    // 素材里是剔过的文字（原文副本里也没有串词）
    await waitUntil(() => daemon.materials.list().some((m) => m.ref.recordId === done.id));
    const mine = daemon.materials.list().filter((m) => m.ref.recordId === done.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.segments).toMatchObject([{ form: "voice", text: "帮我查一下周五的会议室。谢谢。", media: { mediaId: sent.mediaId } }]);
    expect(fs.readFileSync(path.join(daemon.layout.materials, ...mine[0]!.original!.path.split("/")), "utf8")).not.toMatch(/点赞|明镜/);
    // 事件日志里也没有（识别结果在交出来之前就剔掉了）
    expect(JSON.stringify(daemon.store.read(SECRETARY, 0))).not.toMatch(/点赞|明镜/);
    expect(strippedLines(lines)).toEqual([expect.stringMatching(/剔除了 21 字的疑似串词（命中规则 \[请請\]不吝\?\[点點\]\[赞贊讚\]、/)]);
    expectNoTranscript(lines, "会议室", "谢谢");
  });

  it("整条只有串词：等同于没发——语音记成失败、写明是串词已丢弃，这条输入不交给秘书（不唤起、不回话）；素材库没有新增；日志有记录、没有正文；之后说的话秘书照常收到，看不到这条", async () => {
    const lines: string[] = [];
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], log: (line) => lines.push(line) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });
    const before = daemon.materials.list().length;
    const sent = await sendVoice(frontend, url, { text: AD });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed).toMatchObject({ error: "这次识别出来的只有模型自带的串词（求点赞订阅之类），已丢弃", onlyFiller: true });
    expect(failed).not.toHaveProperty("recognition");
    // 失败的那条 voice 事件带着 dropInput：这条输入出队，秘书没被唤起
    const settledEvent = frontend.events({ channel: SECRETARY, type: VOICE }).at(-1)!.payload as VoiceEventPayload;
    expect(settledEvent.dropInput).toBe(true);
    expect(inputOf(daemon.store.reader, sent.messageId)?.status).toBe("dropped");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toEqual([]);
    expect(daemon.secretary.status).toBe("idle");
    expect(daemon.materials.list()).toHaveLength(before);
    expect(JSON.stringify(daemon.store.read(SECRETARY, 0))).not.toMatch(/请不吝|明镜/);
    expect(strippedLines(lines)).toEqual([expect.stringMatching(/剔除了 20 字的疑似串词（命中规则 .*），整条只剩这些/)]);
    expectNoTranscript(lines);

    // 接着打一句字：秘书照常处理，它看到的只有这一句（那条语音从没交给它）
    await frontend.sendText("在吗");
    await turnEnds(frontend, 1);
    const echo = lastEcho(frontend);
    expect(echo).toContain("[user] 在吗");
    expect(echo.match(/\[user\]/g)).toHaveLength(1);
    expect(echo).not.toContain("识别失败");
  });

  it("只有串词、但这条消息还引用了卡片（或带着附件）：照旧交给秘书，语音那段是「[语音，识别失败]」", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "重复照片太多" } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const audio = await media.upload(url, fakeRecording({ text: AD }), { name: "语音.webm", mime: "audio/webm" });
    await frontend.sendParts([{ type: "card_ref", cardId: card.id }, voice(audio.mediaId)]);
    expect(await voiceSettled(frontend, "failed")).toMatchObject({ onlyFiller: true });
    expect((frontend.events({ channel: SECRETARY, type: VOICE }).at(-1)!.payload as VoiceEventPayload).dropInput).toBeUndefined();
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] [卡片：建议发起任务：整理家庭照片（重复照片太多）]\n\n[语音，识别失败]");
  });

  it("秘书回复时发的、排着队就只识别出串词的：交出去时照常成为会话里的消息，但不交给秘书；同一批里打的字照常交", async () => {
    const LONG = "这是一段很长很长的回复，要说好一会儿。".repeat(60);
    const td = await startTestDaemon({ secretary: [{ kind: "reply", text: LONG }, { kind: "reply", text: "好，先停。" }], secretaryTokensPerSecond: 20 });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("出今天的日报");
    await frontend.next(SECRETARY, EVENT_TYPES.stream, 30_000);
    const spoken = await sendVoice(frontend, td.url, { text: AD });
    expect(spoken).toMatchObject({ queued: true });
    expect(await voiceSettled(frontend, "failed")).toMatchObject({ messageId: spoken.messageId, onlyFiller: true });
    const typed = await frontend.sendText("先别写了");
    expect(typed).toMatchObject({ queued: true });

    expect((await frontend.request(METHODS.stopReply, { conversation: SECRETARY }, "k-stop-180")).ok).toBe(true);
    await turnEnds(frontend, 2);
    // 语音那条交出去了（会话里有它，气泡照常在），带着 dropInput、不进秘书的输入队列；下一轮只交了打的字
    const delivered = td.daemon.store.read(SECRETARY, 0, MESSAGE).find((e) => (e.payload as MessageEventPayload).message.id === spoken.messageId);
    expect((delivered!.payload as MessageEventPayload).dropInput).toBe(true);
    expect(inputOf(td.daemon.store.reader, spoken.messageId)?.status).toBe("dropped");
    const starts = frontend.events({ channel: SECRETARY, type: TURN_START }).map((f) => f.payload as TurnStartEventPayload);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual({ inputMessageId: typed.messageId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: SECRETARY, type: TURN_START })).toHaveLength(2);
  }, 90_000);

  it("规则从配置读（voice.recognizer.stripPatterns）：加一条正则不用改代码就生效；写错的正则启动时跳过、写日志，守护进程照常起来", async () => {
    const lines: string[] = [];
    const { url } = await startTestDaemon({
      secretary: [{ kind: "echo_context" }],
      config: { voice: { recognizer: { stripPatterns: ["感谢(收看|观看)", "([写错的"] } } },
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes("([写错的") && line.includes("不是合法的正则"))).toBe(true);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "明天要下雨。感谢收看。" });
    expect((await voiceSettled(frontend, "done")).recognition).toMatchObject({ text: "明天要下雨。", segments: [{ text: "明天要下雨。" }] });
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：明天要下雨。");
  });

  it("普通语音（不带串词）一字不差，不记剔除", async () => {
    const lines: string[] = [];
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], log: (line) => lines.push(line) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "帮我订阅一下这个公众号，再转发给点点。", seconds: 2 });
    expect((await voiceSettled(frontend, "done")).recognition).toMatchObject({ text: "帮我订阅一下这个公众号，再转发给点点。", segments: [{ text: "帮我订阅一下这个公众号，" }, { text: "再转发给点点。" }] });
    expect(strippedLines(lines)).toEqual([]);
  });

  it("悬浮按钮的语音、Debug 页送识别：拿到的也是剔过的；只有串词的悬浮按钮回「已丢弃」不发消息，Debug 页写剔了几个字", async () => {
    const { url } = await startTestDaemon();
    const pageVoice = (text: string) => requestJson<PageVoiceResult>(url, HTTP_PATHS.pageVoice, { method: "POST", body: { audio: { base64: wavBase64(text), mime: "audio/wav" } } });
    expect((await pageVoice(`名字写张三。${AD}`)).body).toEqual({ ok: true, text: "名字写张三。" });
    expect((await pageVoice(AD)).body).toEqual({ ok: false, reason: "只听到模型自带的串词（求点赞订阅之类），已丢弃。再说一次？" });
    const debug = (text: string) => requestJson<DebugRecognizeResult>(url, HTTP_PATHS.debugRecognize, { method: "POST", body: { audioBase64: wavBase64(text), mime: "audio/wav" } });
    expect((await debug(`测试一下。${AD}`)).body).toMatchObject({ ok: true, text: "测试一下。", strippedChars: 20 });
    expect((await debug(AD)).body).toMatchObject({ ok: true, text: "", strippedChars: 20 });
    const plain = (await debug("测试一下。")).body;
    expect(plain).toMatchObject({ ok: true, text: "测试一下。" });
    expect(plain).not.toHaveProperty("strippedChars");
  });
});

describe("演示流程（录给前端回放）", () => {
  it("发语音 → 识别中 → 识别完成、秘书回复；再发一条识别不出来的 → 自动重试 3 次（气泡上显示第几次重试）→ 识别失败、不交给秘书 → 手动重新识别成功、交给秘书", async () => {
    const ok = path.join(makeTempDir("ergo-asr-ok-"), "ok");
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: "好的，明早九点提醒你交报告。" }, { kind: "reply", text: "好，下午去买菜。" }],
      config: { voice: { recognizer: { autoRetrySeconds: [0.05, 0.05, 0.05] } } },
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" }, { durationMs: 4200, waveform: [4, 18, 52, 80, 64, 30, 12, 40, 70, 22] });
    await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    await sendVoice(frontend, url, { text: "下午去买菜", errorUnless: ok }, { durationMs: 2100, waveform: [10, 50, 30] });
    const failed = await voiceSettled(frontend, "failed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frontend.events({ channel: SECRETARY, type: TURN_END })).toHaveLength(1);
    fs.writeFileSync(ok, "");
    await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-demo");
    await voiceSettled(frontend, (v) => v.id === failed.id && v.status === "done");
    await turnEnds(frontend, 2);
    expect(retryVersions(frontend)).toEqual([
      "queued",
      "recognizing",
      "done",
      "queued",
      "recognizing",
      "queued#1",
      "recognizing#1",
      "queued#2",
      "recognizing#2",
      "queued#3",
      "recognizing#3",
      "failed#3",
      "queued",
      "recognizing",
      "done",
    ]);
    saveOrCheckRecording("voice-message", frontend.recording);
  }, 60_000);
});

async function waitForMessage(frontend: TestFrontend, messageId: string) {
  await waitUntil(() => frontend.events({ channel: SECRETARY, type: MESSAGE }).some((f) => (f.payload as MessageEventPayload).message?.id === messageId));
  return frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).find((m) => m.id === messageId)!;
}
