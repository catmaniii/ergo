// 主切面：语音识别的两种接入并存（250 号票，用户 2026-10-23 定的"服务化两个并存"）：
// - 默认的 mode: "spawn" 是守护进程自己拉起 recognizer.py（31 号票起一直在用的那条，行为一个字没改）；
// - mode: "lsm" 改成经 HTTP 调 LSM 托管的那条服务（deploy/lsm/ergo-asr.example.yaml），守护进程不拉起、不结束它。
// 这一条用例把两格都走一遍：真的守护进程连着真的（假的）识别服务进程识别、文字进语音和素材；把服务杀了再发，
// 语音失败、待办里一条说明、别的照旧；同一条用例里另起一个 spawn 的守护进程，照旧能识别。
// 识别服务一律是假的（fixtures/fake-asr-service.mjs）：不加载真模型、不占显卡、不碰本机真的 8091。
import { CHANNELS, EVENT_TYPES, type InboxItemEventPayload, type MessageEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { asrLog, startFakeAsrService } from "../helpers/asr.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { voiceModelsApi } from "../helpers/tts.ts";
import { sendVoice, voiceSettled } from "../helpers/voice.ts";

const SECRETARY = CHANNELS.secretary;

/** 待我处理里"语音识别不可用"的说明（各个版本） */
const unavailableNotices = (frontend: TestFrontend) =>
  frontend
    .events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem })
    .map((f) => (f.payload as InboxItemEventPayload).item)
    .filter((i) => i.kind === "notice" && i.notice === "voice_recognizer_unavailable");

/** 会话频道上秘书回复完了几轮 */
const turnsEnded = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;

/** 秘书最后一条回复的文字（echo_context 会把这一轮看到的上下文复述回来；时间标记和授权文件夹那块去掉） */
const lastReplyText = (frontend: TestFrontend) => {
  const text = frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .filter((m) => m.speaker === "agent")
    .at(-1)
    ?.parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");
  return text === undefined ? undefined : stripTimeMarkers(withoutFoldersBlock(text));
};

describe("两种识别接入并存", () => {
  it("mode: lsm 连上 LSM 托管的那条服务：识别出的文字进语音和素材，设置页的状态照旧；服务被杀了再发，语音失败、待办里一条说明、别的照旧；同一个用例里 mode: spawn 照旧能识别", async () => {
    // ── 1. mode: lsm：预热带上了配置里的模型，识别走的假服务（两条 echo_context：语音一轮、之后打的字一轮）──
    const asr = await startFakeAsrService({ directive: { text: "明天早上九点钟提醒我交报告", seconds: 3.2 } });
    const hosted = await startTestDaemon({
      secretary: [{ kind: "echo_context" }, { kind: "echo_context" }],
      config: { voice: { recognizer: { mode: "lsm", url: asr.url } } },
    });
    const frontend = await TestFrontend.connect(hosted.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await waitUntil(() => hosted.daemon.secretary.status === "idle", { timeoutMs: 20_000 });

    const sent = await sendVoice(frontend, hosted.url, {});
    const done = await voiceSettled(frontend, "done");
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
    });
    await waitUntil(() => turnsEnded(frontend) >= 1, { timeoutMs: 20_000 });
    expect(lastReplyText(frontend)).toContain("[user] 语音转写：明天早上九点钟提醒我交报告");

    // 转写进素材：按 voice_transcript 记一条用户发言
    await waitUntil(() => hosted.daemon.materials.list().some((m) => m.ref.messageId === sent.messageId));
    expect(hosted.daemon.materials.list().filter((m) => m.ref.messageId === sent.messageId)).toMatchObject([
      { kind: "user_utterance", context: [SECRETARY, "voice_transcript"], segments: [{ form: "voice", source: "self", text: "明天早上九点钟提醒我交报告" }] },
    ]);

    // 假服务看到的：先预热（模型是配置里那套），识别带语言和给模型的提示，录音按 base64 到了（字节数对得上）
    const hostedLog = asrLog(asr.log);
    expect(hostedLog.find((e) => e.event === "warmup")?.init).toEqual({
      primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
      fallback: { device: "cpu", model: "small", computeType: "int8" },
    });
    expect(hostedLog.find((e) => e.event === "transcribe")).toMatchObject({ language: "zh", initialPrompt: "以下是普通话的句子。" });
    expect(hostedLog.find((e) => e.event === "transcribe")!.bytes).toBeGreaterThan(0);

    // 设置 · 语音要的状态照旧（它只认 Recognizer 接口，不知道背后是哪条路）
    expect((await voiceModelsApi.get(hosted.url)).body).toMatchObject({ recognizer: { status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16" } });

    // ── 2. 服务被杀了（LSM 还没来得及拉起）再发一条：语音失败，待我处理里一条说明；文字消息照常回 ──
    await asr.down();
    await sendVoice(frontend, hosted.url, {});
    const failed = await voiceSettled(frontend, "failed");
    expect(failed.error).toMatch(/^语音识别不可用：连不上语音识别服务（http:\/\/127\.0\.0\.1:\d+）：/);
    await waitUntil(() => unavailableNotices(frontend).length > 0);
    expect(unavailableNotices(frontend)[0]).toMatchObject({ title: "语音识别不可用", urgency: "non_blocking", body: expect.stringMatching(/ergo-asr/) });
    // 别的照旧：打的字照常交给秘书、照常回（这一轮结束之后才断言）
    await frontend.sendText("还在吗");
    await waitUntil(() => turnsEnded(frontend) >= 2 && (lastReplyText(frontend) ?? "").includes("还在吗"), {
      timeoutMs: 20_000,
      describe: () => `回了几轮：${turnsEnded(frontend)}，最后一条回复：${lastReplyText(frontend) ?? "（还没有）"}`,
    });

    // ── 3. 同一个用例里，mode: spawn 的守护进程照旧自己拉起识别进程 ──
    const own = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const ownFrontend = await TestFrontend.connect(own.url);
    await ownFrontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => own.daemon.secretary.status === "idle", { timeoutMs: 20_000 });
    await sendVoice(ownFrontend, own.url, { text: "这是自己拉起的识别进程" });
    const ownDone = await voiceSettled(ownFrontend, "done");
    expect(ownDone).toMatchObject({ recognition: { text: "这是自己拉起的识别进程", model: "large-v3", device: "cuda", computeType: "int8_float16" } });
    // 两条路互不相干：这个守护进程压根没碰过假服务
    expect(asrLog(asr.log).filter((e) => e.event === "transcribe")).toHaveLength(1);
  }, 60_000);
});
