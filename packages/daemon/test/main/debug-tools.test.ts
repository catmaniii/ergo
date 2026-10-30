// 主切面：设置里的"关于二狗"和 Debug 工具集（124 号票）要守护进程做的几样。
// - daemon_info：守护进程的版本（packages/daemon 的 package.json）、什么时候起来的、它此刻的时间——关于页显示版本和已运行多久，
//   Debug 工具集"测一次延迟"量它的往返；只读，不带幂等键；
// - 完整链路的测试提醒：页面按守护进程的时钟算出"N 秒后"，用发起对话框"只提醒我"的同一个方法（create_reminder）建一条标着【测试】
//   的一次性提醒，真的走提醒模块——到点待我处理里置顶一条、推一条 notify（页面顶上提示、系统通知、点开去待办那一项），做完能删；
// - 语音组：录一段送识别、用当前参考音色合成念一句（POST /api/debug/recognize、/api/debug/speak），不经会话、不进秘书的上下文，
//   识别不了、合成不了回 200 和原因。
import fs from "node:fs";
import {
  CHANNELS,
  type DaemonInfo,
  type DebugRecognizeResult,
  type DebugSpeakResult,
  EVENT_TYPES,
  HTTP_PATHS,
  type InboxItemEventPayload,
  METHODS,
  type NotifyEventPayload,
  nowIso,
  type ResponseFrame,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { dataDirWithoutReferenceVoices, importReferenceVoice, SAMPLE_VOICE, startFakeSpeechService } from "../helpers/tts.ts";
import { fakeRecording, fakeWavRecording, recognizerLog } from "../helpers/voice.ts";

const START = new Date(2026, 9, 14, 21, 0, 0);
const DAEMON_VERSION = (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const ok = <T>(r: ResponseFrame): T => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as T;
};

describe("守护进程的版本（关于页、测一次延迟）", () => {
  it("daemon_info 回版本、起来的时间和此刻的时间（守护进程的钟）；不用幂等键，过了一阵再问，起来的时间不变", async () => {
    const clock = new ManualClock(START);
    const { url } = await startTestDaemon({ clock });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });

    const first = ok<DaemonInfo>(await frontend.request(METHODS.daemonInfo, {}));
    expect(first).toEqual({ version: DAEMON_VERSION, startedAt: nowIso(START), now: nowIso(START) });

    clock.advance(3 * 3_600_000 + 12 * 60_000);
    const later = ok<DaemonInfo>(await frontend.request(METHODS.daemonInfo, {}));
    expect(later).toEqual({ version: DAEMON_VERSION, startedAt: nowIso(START), now: nowIso(new Date(START.getTime() + 3 * 3_600_000 + 12 * 60_000)) });
    // 参数不对照样回 bad_params，连接不断
    expect(await frontend.request(METHODS.daemonInfo, "x")).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(ok<DaemonInfo>(await frontend.request(METHODS.daemonInfo, {})).version).toBe(DAEMON_VERSION);
  });
});

describe("完整链路的测试提醒", () => {
  it("按守护进程的钟定一条 5 秒后的【测试】提醒：到点待我处理里置顶一条、推一条 notify 指向它；做完能在待办里删", async () => {
    const clock = new ManualClock(START);
    const { url } = await startTestDaemon({ clock });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.board]: 0, [CHANNELS.inbox]: 0, [CHANNELS.cards]: 0 });

    // 页面先问守护进程的钟，再定 5 秒后（手机和电脑的钟差几秒也不碍事）
    const { now } = ok<DaemonInfo>(await frontend.request(METHODS.daemonInfo, {}));
    const at = nowIso(new Date(new Date(now).getTime() + 5_000));
    const text = "【测试】Debug 工具集的测试提醒（5 秒）";
    expect(await frontend.createReminder(text, { kind: "once", at }, "k-debug-reminder")).toMatchObject({ ok: true, result: { reminderId: "r-1" } });
    await frontend.next(CHANNELS.board, EVENT_TYPES.reminder);

    // 还差 1 秒：不响
    clock.advance(4_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.notify })).toEqual([]);

    clock.advance(1_000);
    const notify = (await frontend.next(CHANNELS.inbox, EVENT_TYPES.notify)).payload as NotifyEventPayload;
    expect(notify).toMatchObject({ title: `提醒：${text}`, itemId: expect.any(String) });
    const items = frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
    expect(items.find((i) => i.id === notify.itemId)).toMatchObject({ kind: "notice", notice: "reminder_due", title: `提醒：${text}`, pinned: true });
    // 提醒变成已触发
    await waitUntil(() => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.reminder }).length >= 2);

    // 做完在待办里删掉
    expect(await frontend.inboxAction({ itemIds: [notify.itemId!], action: "delete" })).toMatchObject({ ok: true });
    await waitUntil(() =>
      frontend
        .events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem })
        .some((f) => (f.payload as InboxItemEventPayload).item.id === notify.itemId && (f.payload as InboxItemEventPayload).item.deleted),
    );
  });
});

describe("语音组：送识别、合成念一句（不经会话）", () => {
  it("录的一段送识别：回识别出的文字、耗时、模型和设备；App 录的 WAV 也认；秘书的会话里什么都没多；识别出错回原因", async () => {
    const { url, recognizerLog: log } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });

    const webm = Buffer.from(fakeRecording({ text: "测试一下麦克风。" }));
    const res = await requestJson<DebugRecognizeResult>(url, HTTP_PATHS.debugRecognize, { method: "POST", body: { audioBase64: webm.toString("base64"), mime: "audio/webm;codecs=opus" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, text: "测试一下麦克风。", ms: expect.any(Number), model: expect.any(String), device: expect.any(String) });

    const wav = Buffer.from(fakeWavRecording({ text: "原生录音。" }));
    expect((await requestJson<DebugRecognizeResult>(url, HTTP_PATHS.debugRecognize, { method: "POST", body: { audioBase64: wav.toString("base64"), mime: "audio/wav" } })).body).toMatchObject({ ok: true, text: "原生录音。" });

    // 交给识别进程的是临时文件，识别完就删掉了
    const transcribed = recognizerLog(log).filter((e) => e.event === "transcribe");
    expect(transcribed).toHaveLength(2);
    for (const entry of transcribed) expect(fs.existsSync(String(entry.path))).toBe(false);

    const failed = await requestJson<DebugRecognizeResult>(url, HTTP_PATHS.debugRecognize, { method: "POST", body: { audioBase64: Buffer.from(fakeRecording({ error: "解码失败" })).toString("base64"), mime: "audio/webm" } });
    expect(failed).toMatchObject({ status: 200, body: { ok: false, reason: expect.stringContaining("解码失败") } });

    // 请求体不对：400
    expect((await requestJson(url, HTTP_PATHS.debugRecognize, { method: "POST", body: { mime: "audio/wav" } })).status).toBe(400);
    expect((await requestJson(url, HTTP_PATHS.debugRecognize)).status).toBe(405);
    // 秘书的会话里没有多出任何东西
    expect(frontend.events({ channel: CHANNELS.secretary })).toEqual([]);
  });

  it("合成念一句：没有参考音色时说清楚；导入之后用当前参考音色合成，回 WAV、耗时、模型和音色的名字；服务没开回原因", async () => {
    const tts = await startFakeSpeechService();
    // ADR-0036：内置的默认音色装过又被删了（标记在），所以这里一开始一条参考音色都没有
    const { url } = await startTestDaemon({ reuse: dataDirWithoutReferenceVoices(), speechUrl: tts.url });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });

    const none = await requestJson<DebugSpeakResult>(url, HTTP_PATHS.debugSpeak, { method: "POST", body: { text: "你好，我是二狗。" } });
    expect(none).toMatchObject({ status: 200, body: { ok: false, reason: expect.stringContaining("参考音色") } });

    await importReferenceVoice(url);
    const spoken = await requestJson<DebugSpeakResult>(url, HTTP_PATHS.debugSpeak, { method: "POST", body: { text: "你好，我是二狗。" } });
    expect(spoken).toMatchObject({ status: 200, body: { ok: true, mime: "audio/wav", ms: expect.any(Number), model: expect.any(String), voiceName: SAMPLE_VOICE.name } });
    if (!spoken.body.ok) throw new Error("合成失败");
    expect(Buffer.from(spoken.body.audioBase64, "base64").subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(tts.requests.map((r) => r.body.input)).toEqual(["你好，我是二狗。"]);

    await tts.down();
    const off = await requestJson<DebugSpeakResult>(url, HTTP_PATHS.debugSpeak, { method: "POST", body: { text: "再念一句。" } });
    expect(off).toMatchObject({ status: 200, body: { ok: false, reason: expect.any(String) } });
    expect((await requestJson(url, HTTP_PATHS.debugSpeak, { method: "POST", body: { text: "" } })).status).toBe(400);
    expect(frontend.events({ channel: CHANNELS.secretary })).toEqual([]);
  });
});
