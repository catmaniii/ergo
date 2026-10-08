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
  EVENT_TYPES,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  METHODS,
  type ResponseFrame,
  type RetryVoiceResult,
  type VoiceEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { countAgentSpawns, startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, media, request, sha256Hex } from "../helpers/http.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { eventually, maintainerScript, onePlan, runningTask, tasksOf } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeRecording, recognizerLog, sendVoice, voiceSettled, voiceVersions } from "../helpers/voice.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, turnStart: TURN_START, turnEnd: TURN_END, voice: VOICE } = EVENT_TYPES;

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 秘书（echo_context）最后一条回复：它这次看到的上下文（时间标记去掉） */
function lastEcho(frontend: TestFrontend): string {
  const replies = frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent");
  return stripTimeMarkers(textOf(replies.at(-1)!.parts));
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
  it("建出这条语音（音频哈希、时长、格式、波形），识别状态的变化经频道推给前端；秘书收到识别出的文字，识别完成前这条输入在队列里等着", async () => {
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
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
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
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
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "试一下", fallback: "没有可用的显卡" });
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
});

describe("语音消息的规矩", () => {
  it("不是认得的音频、不到 1 秒、和文字或别的语音一起发、语音对象 id 前端说了不算、超过 60 秒：拒收（带引用的卡片可以，见下面的点明）", async () => {
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

describe("识别失败和重新识别", () => {
  it("识别失败时 agent 收到「[语音，识别失败]」；用户在气泡菜单里重新识别，成功后按正常流程交给 agent", async () => {
    const ok = path.join(makeTempDir("ergou-asr-ok-"), "ok");
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "下午买菜", errorUnless: ok });
    const failed = await voiceSettled(frontend, "failed");
    expect(failed.error).toBe("识别出错：听不清");
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] [语音，识别失败]");

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

  it("识别进程起不来（Python 路径不对、没装）：识别状态为失败，待我处理里放一条说明（开着的只有一条），守护进程照常运行", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "收到语音" }, { kind: "reply", text: "收到第二条" }, { kind: "reply", text: "在的" }], recognizerCommand: [path.join(makeTempDir("ergou-nopy-"), "python.exe"), "recognizer.py"] });
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
    // 守护进程照常：文字消息照常回
    await turnEnds(frontend, 2);
    await frontend.sendText("在吗");
    await turnEnds(frontend, 3);
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

describe("识别进程", () => {
  it("按需拉起（环境照 agent 子进程的白名单，没有守护进程的密钥），闲置超过配置的时间自动退出；再来语音时重新拉起", async () => {
    const { url, recognizerLog: log } = await startTestDaemon({
      config: { voice: { recognizer: { idleMinutes: 0.01 } } },
      env: { DEEPSEEK_API_KEY: "sk-不该给识别进程", ERGOU_SENTINEL_VOICE: "x" },
    });
    // 还没有语音：识别进程没起来
    expect(recognizerLog(log)).toEqual([]);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "第一条" });
    await voiceSettled(frontend, "done");
    const first = recognizerLog(log).find((e) => e.event === "start")!;
    expect(first.env).toEqual(expect.arrayContaining(["PATH", "HF_HUB_OFFLINE"]));
    expect(first.env!.map((n) => n.toUpperCase())).not.toContain("DEEPSEEK_API_KEY");
    expect(first.env).not.toContain("ERGOU_SENTINEL_VOICE");
    // 闲置 0.6 秒后退出
    await waitUntil(() => recognizerLog(log).some((e) => e.event === "exit") && !isProcessAlive(first.pid!), { timeoutMs: 10_000 });

    await sendVoice(frontend, url, { text: "第二条" });
    await waitUntil(() => voiceVersions(frontend).filter((v) => v.status === "done").length === 2);
    const starts = recognizerLog(log).filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.pid).not.toBe(first.pid);
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
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
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

    await sendVoice(frontend, td.url, { error: "听不清" });
    await turnEnds(frontend, 2);
    expect(quickCards(frontend).at(-1)).toMatchObject({ status: "pending", payload: { explicit: false, disposition: "ask_first" } });
  });
});

describe("维护者干活时的插话", () => {
  const M1 = maintainerChannel("tm-1");
  const echo: FauxStep = { kind: "echo_context" };
  const turnEndsOf = (frontend: TestFrontend) => frontend.events({ channel: M1, type: TURN_END }).map((f) => f.payload as { inputMessageId: string });

  it("排在没识别完的语音后面的话不越过它当插话：都留在队里，语音识别完了按先后作为输入交给维护者", async () => {
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
    const td = await startTestDaemon({
      maintainer: (_maintainerId, spawn) =>
        spawn === 1
          ? [submitPlanStep(onePlan()), { kind: "reply", text: "计划交上去了" }]
          : [{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "sleep 3" } as never }] }, echo, echo, echo],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [M1]: 0, [CHANNELS.cards]: 0, [CHANNELS.board]: 0 });
    await runningTask(td, frontend, "整理发票");
    // 维护者开始执行（在跑 sleep 3）：这时先发一条语音（识别卡住），再打一句字
    await waitUntil(() => frontend.events({ channel: M1, type: TURN_START }).length >= 2, { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const spoken = await sendVoice(frontend, td.url, { text: "先做三月的", holdFile: hold }, { conversation: M1 });
    const typed = await frontend.sendText("再做四月的", { conversation: M1 });
    await waitUntil(() => turnEndsOf(frontend).length >= 2, { timeoutMs: 20_000, describe: () => "执行的那一轮结束" });
    // 那一轮结束时没收下打的那句（它没越过语音当插话）
    expect(turnEndsOf(frontend).map((e) => e.inputMessageId)).not.toContain(typed.messageId);

    fs.writeFileSync(hold, "");
    await waitUntil(() => turnEndsOf(frontend).length >= 4, { timeoutMs: 20_000, describe: () => "语音和打的字都处理完" });
    expect(turnEndsOf(frontend).slice(2).map((e) => e.inputMessageId)).toEqual([spoken.messageId, typed.messageId]);
    const last = frontend.events({ channel: M1, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent").at(-1)!;
    const context = stripTimeMarkers(textOf(last.parts));
    expect(context.indexOf("[user] 语音转写：先做三月的")).toBeGreaterThanOrEqual(0);
    expect(context.indexOf("[user] 语音转写：先做三月的")).toBeLessThan(context.indexOf("再做四月的"));
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
    // 秘书的会话文件里那条输入也改写了
    const sessionDir = path.join(daemon.layout.sessions, "secretary");
    await waitUntil(() => fs.readdirSync(sessionDir).every((f) => !fs.readFileSync(path.join(sessionDir, f), "utf8").includes("体检报告")), { timeoutMs: 20_000 });
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

describe("演示流程（录给前端回放）", () => {
  it("发语音 → 识别中 → 识别完成、秘书回复；再发一条识别失败的 → 重新识别成功", async () => {
    const ok = path.join(makeTempDir("ergou-asr-ok-"), "ok");
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: "好的，明早九点提醒你交报告。" }, { kind: "reply", text: "这条语音没识别出来，能再说一遍吗？" }, { kind: "reply", text: "好，下午去买菜。" }],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" }, { durationMs: 4200, waveform: [4, 18, 52, 80, 64, 30, 12, 40, 70, 22] });
    await voiceSettled(frontend, "done");
    await turnEnds(frontend, 1);
    await sendVoice(frontend, url, { text: "下午去买菜", errorUnless: ok }, { durationMs: 2100, waveform: [10, 50, 30] });
    const failed = await voiceSettled(frontend, "failed");
    await turnEnds(frontend, 2);
    fs.writeFileSync(ok, "");
    await frontend.request(METHODS.retryVoice, { voiceId: failed.id }, "k-retry-demo");
    await voiceSettled(frontend, (v) => v.id === failed.id && v.status === "done");
    await turnEnds(frontend, 3);
    expect(voiceVersions(frontend).map((v) => v.status)).toEqual(["queued", "recognizing", "done", "queued", "recognizing", "failed", "queued", "recognizing", "done"]);
    saveOrCheckRecording("voice-message", frontend.recording);
  }, 60_000);
});

async function waitForMessage(frontend: TestFrontend, messageId: string) {
  await waitUntil(() => frontend.events({ channel: SECRETARY, type: MESSAGE }).some((f) => (f.payload as MessageEventPayload).message?.id === messageId));
  return frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).find((m) => m.id === messageId)!;
}
