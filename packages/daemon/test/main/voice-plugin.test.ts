// 主切面：语音拆成插件（214 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件"）。
// 开着时的行为由语音的主切面（voice*.test.ts、send-voice、auto-voice-announce）照旧测，一条不改；这里测停用、启用、移除。
// 走真实的装配路径：经组合根和插件清单起守护进程，设置 · 插件（211 号票的 POST /api/plugins/voice）运行中停用、启用、移除；
// 识别进程是假的（fixtures/fake-recognizer.mjs），合成服务是假的（helpers/tts.ts），模型是 faux。
// - 停用：识别进程停掉、合成不再调用；还没识别完的语音不再挡输入队列（只有语音的先不交，带附件的照交、语音那段是"识别失败"）；
//   历史里的语音照样投影成识别出的文字；秘书没有口语总结、发语音工具，系统提示里不讲念语音；再发语音回"语音插件没启用"；
// - 启用：识别进程起来，停用前排队、识别中的接着识别（同守护进程重启），识别出来交给秘书；停用期间照交了的那条另交一条带文字的通知；
// - 移除并连数据删：录音、合成出的音频、语音事件里的文字、参考音色、待我处理里语音的说明删掉；会话里交给过二狗的那部分不删。
import fs from "node:fs";
import path from "node:path";
import {
  type AgentVoiceEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  PURGED_TEXT,
  type ResponseFrame,
  type TurnStartEventPayload,
  type VoiceEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { listInboxItems } from "../../src/inbox/views.ts";
import { inputOf } from "../../src/conversation/views.ts";
import { VOICE } from "../../src/voice/api.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers, toolsNow } from "../helpers/echo.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { history, media, pluginsApi, request } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { agentVoiceSettled, importReferenceVoice, startFakeSpeechService } from "../helpers/tts.ts";
import { fakeRecording, recognizerLog, sendVoice, voiceSettled, voiceVersions } from "../helpers/voice.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, turnStart: TURN_START, turnEnd: TURN_END } = EVENT_TYPES;

let keys = 0;
/** 设置 · 插件里对语音插件做一件事 */
const act = (url: string, action: "disable" | "enable" | "remove", purgeData = false) =>
  pluginsApi.act(url, "voice", { action, ...(purgeData ? { purgeData } : {}), idempotencyKey: `voice-plugin-${++keys}` });

const textOf = (parts: readonly MessagePart[]) => parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const messages = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message);
/** 秘书（echo_context）最后一条回复：它这次看到的上下文（时间标记去掉） */
const lastEcho = (frontend: TestFrontend) => stripTimeMarkers(withoutFoldersBlock(textOf(messages(frontend).filter((m) => m.speaker === "agent").at(-1)!.parts)));
/** 回显的各行 */
const linesOf = (echo: string) => echo.split("\n");
/** 秘书这一轮有的工具：开头那一份（换了一套工具接着会话也是开头一份、按这次交的先后，会话中途不列增减，273 号票） */
const toolsIn = toolsNow;
/** 秘书这一轮的系统提示：最后一条 [system] 那一段（换了系统提示接着会话时，会话中途另有一条） */
const latestPrompt = (echo: string) => {
  const lines = linesOf(echo);
  const at = lines.findLastIndex((l) => l.startsWith("[system] "));
  const end = lines.findIndex((l, i) => i > at && /^\[(tool|tool-removed|user|assistant|toolResult)\]/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
};
/** 交给秘书的各轮各是哪条消息（turn_start 的 inputMessageId，按先后） */
const turnInputs = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: TURN_START }).map((f) => (f.payload as TurnStartEventPayload).inputMessageId);
const turnEnds = (frontend: TestFrontend, count: number) => waitUntil(() => frontend.events({ channel: SECRETARY, type: TURN_END }).length >= count, { timeoutMs: 20_000 });
/** 放行假识别进程某一次识别的文件（还没放上） */
const holdFile = () => path.join(makeTempDir("ergo-asr-hold-"), "go");
/** 假识别进程里还活着的（记录里 start 的 pid） */
const liveRecognizers = (log: string) => recognizerLog(log).flatMap((e) => (e.event === "start" && e.pid !== undefined && isProcessAlive(e.pid) ? [e.pid] : []));
const refusalOf = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code}: ${r.error.message}`;
};
const ECHO = Array.from({ length: 6 }, () => ({ kind: "echo_context" as const }));

describe("语音插件：运行中停用、启用（214 号票）", () => {
  it("停用：识别进程停掉；还没识别完的语音不再挡队列（只有语音的先不交）；历史照样投影成文字；秘书没有口语总结和发语音；再发语音回没启用。启用：识别进程起来，接着识别、识别出来交给秘书", { timeout: 90_000 }, async () => {
    const hold = holdFile();
    const { url, daemon, recognizerLog: log } = await startTestDaemon({ secretary: ECHO });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.plugins]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });

    // 开着：发一条语音，识别出来交给秘书；秘书有口语总结、发语音，系统提示里讲念语音
    const first = await sendVoice(frontend, url, { text: "上午十点开会" });
    await turnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[user] 语音转写：上午十点开会");
    expect(toolsIn(lastEcho(frontend)).slice(-2)).toEqual(["spoken_summary", "send_voice"]);
    expect(latestPrompt(lastEcho(frontend))).toContain("要我念给你听吗");
    // 识别进程在（预热就拉起了）
    await waitUntil(() => liveRecognizers(log).length === 1);

    // 再发一条只有语音的，停在第一次识别中；后面打的字照旧在它后面等着
    const held = await sendVoice(frontend, url, { text: "下午去买菜", holdFile: hold });
    await voiceSettled(frontend, (v) => v.messageId === held.messageId && v.status === "recognizing");
    const weather = await frontend.sendText("先帮我查下天气");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnInputs(frontend)).toEqual([first.messageId]);

    // 停用（设置 · 插件，马上生效）
    const off = await act(url, "disable");
    expect(off.status).toBe(200);
    expect(off.body.changed).toEqual(["voice"]);
    expect(daemon.plugins.service(VOICE)).toBeUndefined();
    // 识别进程停掉
    await waitUntil(() => liveRecognizers(log).length === 0, { timeoutMs: 15_000, describe: () => JSON.stringify(recognizerLog(log)) });
    // 挡板放开：打的字马上交给秘书；只有语音、还没识别完的那条不交，留在队里（停在识别中）
    await turnEnds(frontend, 2);
    expect(turnInputs(frontend)).toEqual([first.messageId, weather.messageId]);
    expect(inputOf(daemon.store.reader, held.messageId)?.status).toBe("pending");
    expect(voiceVersions(frontend).filter((v) => v.messageId === held.messageId).at(-1)!.status).toBe("recognizing");
    // 秘书按新的装配：没有口语总结、发语音，系统提示里不讲念语音
    const echoOff = lastEcho(frontend);
    expect(echoOff).toContain("[user] 先帮我查下天气");
    expect(toolsIn(echoOff)).not.toContain("spoken_summary");
    expect(toolsIn(echoOff)).not.toContain("send_voice");
    expect(latestPrompt(echoOff)).not.toContain("要我念给你听吗");
    expect(latestPrompt(echoOff)).not.toContain("send_voice");

    // 历史里的语音照样投影成识别出的文字（语音对象的视图是内核的数据契约）；录音照样点得开
    const page = await history(url, SECRETARY);
    expect(page.status).toBe(200);
    expect(page.body.voices?.find((v) => v.messageId === first.messageId)).toMatchObject({ status: "done", recognition: { text: "上午十点开会" } });
    expect((await request(url, `/api/media/${first.mediaId}`)).status).toBe(200);
    // 再发语音、重新识别：语音插件没启用
    const audio = await media.upload(url, fakeRecording({ text: "又说一句" }), { name: "语音.webm", mime: "audio/webm" });
    const refused = await frontend.trySendParts([{ type: "voice", mediaId: audio.mediaId, mime: "audio/webm", durationMs: 2000, waveform: [] }]);
    expect(refusalOf(refused)).toBe("not_allowed: 语音插件没启用");
    const firstVoice = voiceVersions(frontend).find((v) => v.messageId === first.messageId)!;
    expect(refusalOf(await frontend.request(METHODS.retryVoice, { voiceId: firstVoice.id }, "retry-off"))).toBe("not_allowed: 语音插件没启用");
    // 设置 · 语音、两个模型的状态：语音插件没启用
    const models = await request(url, "/api/voice-models");
    expect(models.status).toBe(404);
    expect(models.body.toString("utf8")).toContain("语音插件没启用");

    // 启用：识别进程起来；停用前识别中的那条接着识别（同守护进程重启），识别出来交给秘书
    const on = await act(url, "enable");
    expect(on.body.changed).toEqual(["voice"]);
    await waitUntil(() => liveRecognizers(log).length === 1, { timeoutMs: 15_000 });
    fs.writeFileSync(hold, "");
    await voiceSettled(frontend, (v) => v.messageId === held.messageId && v.status === "done");
    await turnEnds(frontend, 3);
    expect(turnInputs(frontend)).toEqual([first.messageId, weather.messageId, held.messageId]);
    const echoOn = lastEcho(frontend);
    expect(echoOn).toContain("[user] 语音转写：下午去买菜");
    expect(toolsIn(echoOn).slice(-2)).toEqual(["spoken_summary", "send_voice"]);
    expect(latestPrompt(echoOn)).toContain("要我念给你听吗");
  });

  it("停用时还没识别完、带着附件的语音照交给秘书，语音那段是「[语音，识别失败]」；启用回来识别出来了，另交一条带文字的通知", { timeout: 90_000 }, async () => {
    const hold = holdFile();
    const { url, daemon } = await startTestDaemon({ secretary: ECHO });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 20_000 });

    const image = await media.upload(url, png({ width: 8, height: 8 }), { name: "账单.png", mime: "image/png" });
    const audio = await media.upload(url, fakeRecording({ text: "这张账单帮我记一下", holdFile: hold }), { name: "语音.webm", mime: "audio/webm" });
    const sent = await frontend.sendParts([
      { type: "image", mediaId: image.mediaId, name: "账单.png", mime: "image/png" },
      { type: "voice", mediaId: audio.mediaId, mime: "audio/webm", durationMs: 2600, waveform: [] },
    ]);
    await voiceSettled(frontend, "recognizing");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnInputs(frontend)).toEqual([]);

    expect((await act(url, "disable")).body.changed).toEqual(["voice"]);
    await turnEnds(frontend, 1);
    expect(turnInputs(frontend)).toEqual([sent.messageId]);
    expect(lastEcho(frontend)).toContain(`[user] [图片 1：账单.png（附件引用 ${image.mediaId}）]\n\n[语音，识别失败]`);

    expect((await act(url, "enable")).body.changed).toEqual(["voice"]);
    fs.writeFileSync(hold, "");
    await voiceSettled(frontend, "done");
    await turnEnds(frontend, 2);
    expect(lastEcho(frontend)).toContain('用户之前发的那条语音（语音功能停用时交给你的，语音那段当时是"识别失败"）现在识别出来了，转写如下：\n语音转写：这张账单帮我记一下');
  });

  it("配置里停用（重启后）：没有识别进程；语音对象照样在历史里；只有语音、还没识别完的不挡后面打的字；配置里再启用、重启后接着识别", { timeout: 90_000 }, async () => {
    const hold = holdFile();
    const first = await startTestDaemon({ secretary: ECHO });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => first.daemon.secretary.status === "idle", { timeoutMs: 20_000 });
    const held = await sendVoice(frontend, first.url, { text: "晚上七点吃饭", holdFile: hold });
    await voiceSettled(frontend, "recognizing");
    expect((await act(first.url, "disable")).body.changed).toEqual(["voice"]);
    await first.daemon.stop();

    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ secretary: ECHO, reuse });
    expect(second.daemon.plugins.report()).toMatchObject({ disabled: ["voice"], skipped: [] });
    const again = await TestFrontend.connect(second.url);
    await again.subscribe({ [SECRETARY]: 0 });
    const text = await again.sendText("明天几点起");
    await waitUntil(() => again.events({ channel: SECRETARY, type: TURN_END }).length >= 1, { timeoutMs: 20_000 });
    expect(again.events({ channel: SECRETARY, type: TURN_START }).map((f) => (f.payload as TurnStartEventPayload).inputMessageId)).toEqual([text.messageId]);
    expect(inputOf(second.daemon.store.reader, held.messageId)?.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recognizerLog(second.recognizerLog)).toEqual([]);
    expect(second.daemon.plugins.service(VOICE)).toBeUndefined();
    await second.daemon.stop();

    const third = await startTestDaemon({ secretary: ECHO, reuse, config: { plugins: { disabled: [] } } });
    const last = await TestFrontend.connect(third.url);
    await last.subscribe({ [SECRETARY]: 0 });
    fs.writeFileSync(hold, "");
    await voiceSettled(last, (v) => v.messageId === held.messageId && v.status === "done", 20_000);
    await waitUntil(() => last.events({ channel: SECRETARY, type: TURN_START }).some((f) => (f.payload as TurnStartEventPayload).inputMessageId === held.messageId), { timeoutMs: 20_000 });
  });
});

describe("语音插件：移除并连数据删（214 号票）", () => {
  it("删录音、合成出的音频、语音事件里的文字、参考音色、待我处理里语音的说明；会话里交给过二狗的那部分不删", { timeout: 90_000 }, async () => {
    const tts = await startFakeSpeechService();
    const reply = "好的，明早九点提醒你交报告。";
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: reply }], speechUrl: tts.url });
    const reference = await importReferenceVoice(url);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0, [CHANNELS.plugins]: 0 });
    const sent = await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" });
    const synthesized = await agentVoiceSettled(frontend, "done");
    expect(synthesized.mediaId).toBeDefined();
    // 待我处理里一条语音的说明（识别不可用；直接放一条，和识别进程起不来时一样）
    daemon.inbox.add({ kind: "notice", notice: "voice_recognizer_unavailable", title: "语音识别不可用", body: "测试", source: "语音", urgency: "non_blocking", actions: ["知道了"] });

    // 设置 · 插件里看得到它删哪些、删不掉哪些
    const view = await pluginsApi.view(url);
    const voice = view.body.plugins.find((p) => p.name === "voice")!;
    expect(voice).toMatchObject({ title: "语音", state: "running", brings: { tools: ["口语总结", "发语音"], cards: [], jobs: [] } });
    expect(voice.removal!.deletes).toHaveLength(5);
    expect(voice.removal!.keeps[0]).toContain("会话里转写成文字交给过二狗的那部分");

    const removed = await act(url, "remove", true);
    expect(removed.status).toBe(200);
    expect(removed.body.changed).toEqual(["voice"]);
    expect(removed.body.purged).toMatchObject({ inboxItems: 1, cards: 0 });
    expect(removed.body.purged!.events).toBeGreaterThanOrEqual(2);
    // 录音（用户语音的音频）、合成出的音频、参考音色都删掉了
    expect((await request(url, `/api/media/${sent.mediaId}`)).status).toBe(404);
    expect((await request(url, `/api/media/${synthesized.mediaId}`)).status).toBe(404);
    expect(fs.existsSync(path.join(daemon.layout.voices, reference.id))).toBe(false);
    // 语音事件里的文字：识别出的、送进 TTS 的都换成删除标记（状态这些还在）
    const voices = daemon.store.ofType(EVENT_TYPES.voice).map((e) => (e.payload as VoiceEventPayload).voice);
    expect(voices.filter((v) => v.status === "done").map((v) => v.recognition?.text)).toEqual([PURGED_TEXT]);
    const agentVoices = daemon.store.ofType(EVENT_TYPES.agentVoice).map((e) => (e.payload as AgentVoiceEventPayload).voice);
    expect(agentVoices.filter((v) => v.text !== undefined).every((v) => v.text === PURGED_TEXT)).toBe(true);
    // 待我处理里语音的说明删掉了
    expect(listInboxItems(daemon.store.reader).filter((i) => i.kind === "notice" && i.notice === "voice_recognizer_unavailable" && !i.deleted)).toEqual([]);
    // 会话里交给过二狗的那部分（用户的语音消息、秘书的回话）还在
    const kept = daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message);
    expect(kept.some((m) => m.id === sent.messageId)).toBe(true);
    expect(kept.some((m) => m.speaker === "agent" && textOf(m.parts) === reply)).toBe(true);
    // 删除记录在插件频道上；设置里它是"移除了"，能装回
    await waitUntil(() => frontend.events({ channel: CHANNELS.plugins, type: EVENT_TYPES.pluginDataPurged }).length === 1);
    expect((await pluginsApi.view(url)).body.plugins.find((p) => p.name === "voice")!.state).toBe("removed");
    expect((await act(url, "enable")).body.changed).toEqual(["voice"]);
  });
});
