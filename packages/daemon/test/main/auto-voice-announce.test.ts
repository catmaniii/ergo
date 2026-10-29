// 主切面：定时任务跑完自动语音播报（任务级开关）、"立即运行一次"（100 号票）。真的守护进程，秘书、维护者接 faux 剧本，测试扮演前端：
// - 开着"跑完自动播报"：手动跑一次定时任务，跑完秘书收到的任务做完的通知标着自动播报（不问要不要念），秘书用 send_voice 念成
//   语音气泡（tool 模式，转文字是口语稿）；关着照 99 号票问要不要念，那一轮发不了语音；
// - 别的运行时通知引起的一轮照旧发不了语音；语音服务没开时语音没发出去、会话里有原因，秘书照规矩改用文字；
// - 一次运行只播报一次：秘书念到一半守护进程重启，那条语音起来后合成好了才重新交、写明念过了、不再放行语音，语音只有那一条；
//   没合成出来的不算念过，原样重新交、秘书再念一次；开着、关着的两件同时做完时开着的单独一条，只有那一条的一轮能发语音；
// - 立即运行一次：触发记成手动、不改时间表；上一次还在跑时被拒、原因清楚；暂停着的能跑一次、照旧暂停；之后到点照常运行；
// - 秘书的入口：用户说"把 t-1 再跑一次""以后 t-1 跑完直接念给我"，秘书用快速动作提出，点明了直接执行，没点明的出卡确认。
// 第一个用例的事件流录下来给前端回放（task-done-voice：任务做完、秘书念，109 号票的顶上提醒、红点、不在时念的语音小栏用；
// 重新录：ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/auto-voice-announce.test.ts -t 开着）。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  nowIso,
  type ResponseFrame,
  type RunJobNowResult,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
  type TaskTrigger,
  type TurnEndEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { AUTO_ANNOUNCE_TAG, TASK_DONE_TAG } from "../../src/secretary/task-done.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { agentVoiceSettled, agentVoiceVersions, importReferenceVoice, startFakeSpeechService } from "../helpers/tts.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX } = CHANNELS;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const voiceCall = (text: string): FauxStep => call("send_voice", { text });
const propose = (type: string, params: Record<string, unknown>): FauxStep => call("propose_quick_action", { type, params });
/** 对话审批关着（正式的默认）：普通任务的 agent 在工作目录里写文件直接做 */
const APPROVALS_OFF = { guard: { conversationApprovals: "off" } };
const DAILY_8 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "08:00" } } satisfies TaskTrigger;
const DAILY_9 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } } satisfies TaskTrigger;
/** 秘书念的口语稿（念得出来：没有链接、表格、代码） */
const SPOKEN = "今天的 AI 新闻有三条要点：第一，新模型发布；第二，开源社区很热闹；第三，芯片又涨价了。链接在任务里。";

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
/** 秘书会话里任务做完的通知 */
const doneNotices = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && textOf(m).startsWith(TASK_DONE_TAG));
const doneTexts = (frontend: TestFrontend) => doneNotices(frontend).map(textOf);
/** 秘书在主线里说的话（有文字的） */
const secretarySaid = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY)
    .filter((m) => m.message.speaker === "agent")
    .map((m) => m.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .filter((t) => t !== "");
/** 秘书会话里给人看的系统说明 */
const notes = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true).map(textOf);
/** 秘书调发语音的每次结果（同一次调用取最后的样子） */
const voiceResults = (frontend: TestFrontend) => {
  const calls = new Map<string, { outcome: string; resultSummary?: string }>();
  for (const m of messagesOf(frontend, SECRETARY)) for (const p of m.message.parts) if (p.type === "tool_call" && p.tool === "send_voice") calls.set(p.callId, p);
  return [...calls.values()];
};
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
/** 被拒的说法："错误码 原因" */
const refusalOf = (r: ResponseFrame) => (r.ok ? "（没被拒）" : `${r.error.code} ${r.error.message}`);
const outcomes = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as TurnEndEventPayload).outcome);

async function connect(url: string, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const td = await startTestDaemon(options);
  return { ...td, frontend: await connect(td.url, channels) };
}

const noticesArrived = (frontend: TestFrontend, n: number) =>
  waitUntil(() => doneNotices(frontend).length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 条任务做完的通知（现在：${JSON.stringify(doneTexts(frontend))}）` });
const secretaryTurns = (frontend: TestFrontend, n: number) =>
  waitUntil(() => outcomes(frontend).length >= n, { timeoutMs: 30_000, describe: () => `等秘书处理完 ${n} 条输入（现在：${JSON.stringify(outcomes(frontend))}）` });
const registered = (frontend: TestFrontend) => waitUntil(() => jobsOf(frontend).some((e) => e.change === "registered"), { timeoutMs: 30_000, describe: () => "等登记" });
const runEnded = (frontend: TestFrontend, n: number) =>
  waitUntil(() => jobsOf(frontend).filter((e) => e.change === "run_finished").length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 次运行结束` });
/** 真等一会儿（确认某件事没有发生） */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("跑完自动播报", () => {
  it("开着：立即运行一次，跑完秘书收到标着自动播报的通知（不问），用 send_voice 念成语音气泡，转文字是口语稿；运行记成手动、不改时间表", async () => {
    const tts = await startFakeSpeechService();
    // 前端回放还要已读位置（109 号票）：一起订阅
    const { url, frontend } = await setup(
      {
        config: APPROVALS_OFF,
        speechUrl: tts.url,
        secretary: [voiceCall(SPOKEN), say("AI 新闻日报出好了，要点念给你听了。")],
        maintainer: [call(TOOL.write, { path: "ai-news.md", content: "# AI 新闻\n- 新模型发布\n- 开源社区\n- 芯片涨价\n" }), say("日报写好了：ai-news.md，三条要闻")],
      },
      [BOARD, SECRETARY, CARDS, INBOX, CHANNELS.readMarks],
    );
    await importReferenceVoice(url);
    // 发起对话框里先勾上了"跑完自动播报"
    ok(await frontend.startTask("每天出 AI 新闻日报\n汇总昨天的 AI 新闻，写成 ai-news.md", "k-news", [], "plain", DAILY_8, { voiceAnnounce: true }));
    await registered(frontend);
    expect(tasksOf(frontend)[0]!.task).toMatchObject({ id: "t-1", state: "operating", voiceAnnounce: true });
    const nextAt = jobsOf(frontend).at(-1)!.job.nextAt;
    expect(nextAt).toBeDefined();

    const result = ok(await frontend.runJobNow({ jobId: "j-1" }, "k-now-1")) as RunJobNowResult;
    expect(result).toMatchObject({ jobId: "j-1", runId: "j-1-r1" });
    // 同一个幂等键重发拿到同一次运行（不另起一次）
    expect(ok(await frontend.runJobNow({ jobId: "j-1" }, "k-now-1"))).toMatchObject({ jobId: "j-1", runId: "j-1-r1" });

    await noticesArrived(frontend, 1);
    const [notice] = doneNotices(frontend);
    const text = textOf(notice!);
    expect(text.startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}后台有一件事做完了（运行时发来的，不是用户说的）：`)).toBe(true);
    expect(text).toMatch(/定时触发的普通任务 t-1「每天出 AI 新闻日报」的第 1 次运行做完了（触发：.+ 你让它立即运行一次）。这件开了跑完自动播报。\n它最后说：\n日报写好了：ai-news\.md，三条要闻\n/);
    // 秘书拿得到内容：交付的文件连同产出区的位置（可以读）
    expect(text).toMatch(/交付的文件（在任务的产出区 .+t-1 里，要细节可以读）：ai-news\.md/);
    expect(text).toContain("不用问，直接用 send_voice 把结果的要点念给用户听");
    expect(text).not.toContain("要我念给你听吗");

    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice).toMatchObject({ conversation: SECRETARY, mode: "tool", text: SPOKEN, status: "done", inputMessageId: notice!.message.id });
    expect(tts.requests.map((r) => r.input).join("")).toBe(SPOKEN);
    // 聊天里是一个语音气泡（不是附件）
    const bubble = messagesOf(frontend, SECRETARY).find((m) => m.message.id === voice.messageId)!;
    expect(bubble.message.parts).toEqual([{ type: "tts_audio", voiceId: voice.id, mediaId: voice.mediaId, mime: "audio/wav", durationMs: voice.durationMs, waveform: voice.waveform }]);
    expect(voiceResults(frontend)).toMatchObject([{ outcome: "done" }]);

    // 这次运行的触发记成手动；时间表、下一次都没变
    const finished = jobsOf(frontend).find((e) => e.change === "run_finished")!;
    expect(finished.run).toMatchObject({ trigger: "manual", state: "done", events: [{ source: "manual" }] });
    expect(finished.job).toMatchObject({ state: "active", schedule: DAILY_8.schedule, nextAt });
    expect(jobsOf(frontend).find((e) => e.change === "triggered")).toMatchObject({ by: "user", job: { nextAt } });

    // 这一轮结束、语音定了收不收这一轮的文字，再录（秘书会话、看板、已读位置各走各的，按频道核对）
    await secretaryTurns(frontend, 1);
    await waitUntil(() => agentVoiceVersions(frontend, voice.id).at(-1)?.coversReply !== undefined, { describe: () => "等语音定了收不收这一轮的文字" });
    saveOrCheckRecording("task-done-voice", frontend.recording, { perChannel: true });
  }, 60_000);

  it("关着（菜单里关掉）：照 99 号票问要不要念，秘书这一轮调 send_voice 发不了", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({
      speechUrl: tts.url,
      secretary: [voiceCall(SPOKEN), say("AI 新闻日报出好了，要我念给你听吗？")],
      maintainer: [say("日报写好了，三条要闻")],
    });
    await importReferenceVoice(url);
    ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8, { voiceAnnounce: true }));
    await registered(frontend);
    // 任务操作菜单里"跑完自动播报：关"：记一条用户改的 voice_announce_set，状态不变；同一个幂等键重发拿到同一个结果
    expect(ok(await frontend.setVoiceAnnounce({ taskId: "t-1", on: false }, "k-off"))).toEqual({ taskId: "t-1", on: false });
    expect(ok(await frontend.setVoiceAnnounce({ taskId: "t-1", on: false }, "k-off"))).toEqual({ taskId: "t-1", on: false });
    const set = tasksOf(frontend).filter((e) => e.change === "voice_announce_set");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ by: "user", from: "operating", task: { state: "operating", voiceAnnounce: false } });

    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await noticesArrived(frontend, 1);
    const [text] = doneTexts(frontend);
    expect(text!.startsWith(`${TASK_DONE_TAG}后台有一件事做完了`)).toBe(true);
    expect(text).not.toContain(AUTO_ANNOUNCE_TAG);
    expect(text).toContain("然后问“要我念给你听吗？”");
    await secretaryTurns(frontend, 1);
    expect(secretarySaid(frontend)).toEqual(["AI 新闻日报出好了，要我念给你听吗？"]);
    // 运行时通知引起的一轮：发不了语音，没有建出语音
    expect(voiceResults(frontend)).toMatchObject([{ outcome: "error", resultSummary: expect.stringContaining("发不了语音") }]);
    expect(agentVoiceVersions(frontend)).toEqual([]);
  }, 60_000);

  it("别的运行时通知引起的一轮照旧发不了语音（标记不在开头的也不算）", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup({
      speechUrl: tts.url,
      secretary: [voiceCall(SPOKEN), say("知道了"), voiceCall(SPOKEN), say("知道了")],
    });
    await importReferenceVoice(url);
    daemon.store.append(buildAgentNotice(SECRETARY, "「发邮件」已获批准，可以重试", "k-approved").event);
    await secretaryTurns(frontend, 1);
    daemon.store.append(buildAgentNotice(SECRETARY, `看板上有变化：${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}不是开头`, "k-spoof").event);
    await secretaryTurns(frontend, 2);
    expect(voiceResults(frontend)).toMatchObject([
      { outcome: "error", resultSummary: expect.stringContaining("发不了语音") },
      { outcome: "error", resultSummary: expect.stringContaining("发不了语音") },
    ]);
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
  }, 60_000);

  it("语音服务没开：语音没发出去，会话里有原因，秘书照规矩把要点用文字发出来", async () => {
    const fallback = "AI 新闻日报出好了，要点：新模型发布、开源社区很热闹、芯片涨价。（语音服务没开，这次没念成。）";
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [voiceCall(SPOKEN), say(fallback)], maintainer: [say("日报写好了，三条要闻")] });
    await importReferenceVoice(url);
    // audio.cpp 没开（端口还在，连不上）
    await tts.down();
    ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8, { voiceAnnounce: true }));
    await registered(frontend);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await noticesArrived(frontend, 1);
    const voice = await agentVoiceSettled(frontend, "failed");
    expect(voice).toMatchObject({ mode: "tool", conversation: SECRETARY });
    expect(voice.error).toContain("语音合成服务没开");
    await secretaryTurns(frontend, 1);
    expect(voiceResults(frontend)).toMatchObject([{ outcome: "error", resultSummary: expect.stringContaining("语音没发出去") }]);
    // 不静默：会话里一条说明；秘书的文字照常显示（没有收进气泡）
    expect(notes(frontend).some((t) => t.startsWith("这条语音没发出去（") && t.includes("语音合成服务没开"))).toBe(true);
    expect(secretarySaid(frontend)).toEqual([fallback]);
    expect(agentVoiceVersions(frontend, voice.id).at(-1)).toMatchObject({ status: "failed", coversReply: false });
  }, 60_000);

  it("一次运行只播报一次：念到一半守护进程重启，那条语音起来后合成好了才重新交，写明念过了、不再放行语音，语音只有那一条", async () => {
    const { reuse, tts, told, synthesizing } = await stopWhileAnnouncing();
    tts.behave("ok");
    tts.release();
    const second = await startTestDaemon({ reuse, speechUrl: tts.url, secretary: [voiceCall(SPOKEN), say("刚才已经念给你听了")] });
    const after = await connect(second.url, [SECRETARY]);
    await noticesArrived(after, 2);
    const [, again] = doneTexts(after);
    expect(again!.startsWith(`${TASK_DONE_TAG}后台有一件事做完了`)).toBe(true);
    expect(again).not.toContain(AUTO_ANNOUNCE_TAG);
    expect(again).toContain("上次处理这条通知时已经用 send_voice 念过了");
    expect(told.startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`)).toBe(true);
    // 停机前建出的那条语音起来后合成好（合成那边重启重做）；合成好了才重新交
    expect((await agentVoiceSettled(after, "done")).id).toBe(synthesizing.id);
    const frames = after.events({ channel: SECRETARY });
    const doneAt = frames.find((f) => f.type === EVENT_TYPES.agentVoice && (f.payload as { voice: { status: string } }).voice.status === "done")!.seq;
    const againAt = frames.filter((f) => f.type === EVENT_TYPES.message && textOf(f.payload as MessageEventPayload).startsWith(TASK_DONE_TAG))[1]!.seq;
    expect(againAt).toBeGreaterThan(doneAt);
    await waitUntil(() => outcomes(after).length >= 2, { timeoutMs: 30_000, describe: () => "等重新交的那条处理完" });
    expect(outcomes(after)).toEqual(["interrupted", "completed"]);
    // 重新交的那一轮再调 send_voice：发不了；语音一共只有一条
    expect(voiceResults(after).at(-1)).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("发不了语音") });
    expect(new Set(agentVoiceVersions(after).map((v) => v.id))).toEqual(new Set([synthesizing.id]));
    await pause(300);
    expect(doneNotices(after)).toHaveLength(2);
  }, 90_000);

  it("念到一半守护进程重启，那条语音起来后没合成出来：不算念过，原样重新交（还能发语音），秘书再念一次", async () => {
    const { reuse, tts, told, synthesizing } = await stopWhileAnnouncing();
    // 起来后重做停机前那条的第一段就出错：没合成出来；之后的照常
    tts.behave("ok");
    tts.script({ status: 500, body: '{"error":{"message":"fake failure"}}' });
    tts.release();
    const second = await startTestDaemon({ reuse, speechUrl: tts.url, secretary: [voiceCall(SPOKEN), say("刚才没念成，再念一次")] });
    const after = await connect(second.url, [SECRETARY]);
    await noticesArrived(after, 2);
    const [, again] = doneNotices(after);
    expect(textOf(again!)).toBe(told);
    expect((await agentVoiceSettled(after, "failed")).id).toBe(synthesizing.id);
    const retold = await agentVoiceSettled(after, "done");
    expect(retold.id).not.toBe(synthesizing.id);
    expect(retold).toMatchObject({ mode: "tool", inputMessageId: again!.message.id, text: SPOKEN });
  }, 90_000);

  it("开着、关着的两件差不多同时做完：开着的单独交一条（只有那一条的一轮能发语音），关着的照旧问、发不了", async () => {
    const clock = new ManualClock(at(5, 8));
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({
      clock,
      speechUrl: tts.url,
      secretary: [voiceCall(SPOKEN), say("说完了"), voiceCall(SPOKEN), say("说完了")],
      maintainer: (id) => [say(`${id} 做完了`)],
    });
    await importReferenceVoice(url);
    ok(await frontend.startTask("AI 新闻日报", "k-1", [], "plain", undefined, { voiceAnnounce: true }));
    ok(await frontend.startTask("整理照片", "k-2", [], "plain"));
    await waitUntil(() => tasksOf(frontend).filter((e) => e.change === "completed").length >= 2, { timeoutMs: 30_000, describe: () => "等两件都做完" });
    clock.advance(1000);
    await noticesArrived(frontend, 2);
    const notices = doneNotices(frontend);
    const on = notices.find((n) => textOf(n).startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`))!;
    const off = notices.find((n) => !textOf(n).includes(AUTO_ANNOUNCE_TAG))!;
    expect(textOf(on)).toContain("普通任务 t-1「AI 新闻日报」在后台做完了。这件开了跑完自动播报。");
    expect(textOf(on)).not.toContain("t-2");
    expect(textOf(off)).toContain("普通任务 t-2「整理照片」在后台做完了。");
    expect(textOf(off)).not.toContain("t-1");
    expect(textOf(off)).toContain("然后问“要我念给你听吗？”");
    await secretaryTurns(frontend, 2);
    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice.inputMessageId).toBe(on.message.id);
    expect(new Set(agentVoiceVersions(frontend).map((v) => v.id)).size).toBe(1);
    expect(voiceResults(frontend).map((r) => r.outcome).toSorted()).toEqual(["done", "error"]);
  }, 60_000);
});

/**
 * 开着自动播报的定时任务立即运行一次，秘书念到一半（合成一直不回）就停掉守护进程：给出数据目录、假的合成服务（还 hold 着）、
 * 第一次交的通知和停机前建出的那条语音
 */
async function stopWhileAnnouncing() {
  const reuse = { dataDir: makeTempDir("ergo-data-"), homeDir: makeTempDir("ergo-home-") };
  const tts = await startFakeSpeechService();
  tts.behave("hold");
  const first = await startTestDaemon({ reuse, speechUrl: tts.url, secretary: [voiceCall(SPOKEN), say("念好了")], maintainer: [say("日报写好了，三条要闻")] });
  await importReferenceVoice(first.url);
  const before = await connect(first.url);
  ok(await before.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8, { voiceAnnounce: true }));
  await registered(before);
  ok(await before.runJobNow({ jobId: "j-1" }));
  await noticesArrived(before, 1);
  const told = doneTexts(before)[0]!;
  const synthesizing = await agentVoiceSettled(before, "synthesizing");
  await waitUntil(() => tts.held > 0, { timeoutMs: 20_000, describe: () => "等合成请求被 hold 住" });
  await before.close();
  await first.daemon.stop();
  return { reuse, tts, told, synthesizing };
}

/** 本地时间 2026 年 1 月 d 日 hh:mm（2026-01-05 是周一） */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 0, d, hh, mm);

describe("立即运行一次", () => {
  it("触发记成手动、不改时间表；上一次还在跑时被拒、原因清楚；暂停着的能跑一次、照旧暂停；恢复后到点照常运行", async () => {
    const clock = new ManualClock(at(5, 8));
    const td = await startTestDaemon({
      clock,
      // 维护者说得慢：第一次运行要跑一会儿
      maintainerTokensPerSecond: 40,
      secretary: [say("好"), say("好"), say("好")],
      maintainer: (_id, spawn) => [say(spawn === 1 ? `第一次跑完了：${"今天的新闻都汇总好了，".repeat(12)}` : `第 ${spawn} 次跑完了`)],
    });
    // 新建的普通任务 t-1 由它自己的 agent tm-1 做：交给它的那条也看
    const frontend = await connect(td.url, [BOARD, SECRETARY, CARDS, INBOX, maintainerChannel("tm-1")]);
    ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_9));
    await registered(frontend);
    const nextAt = nowIso(at(5, 9));
    expect(jobsOf(frontend).at(-1)!.job.nextAt).toBe(nextAt);

    const first = ok(await frontend.runJobNow({ jobId: "j-1" })) as RunJobNowResult;
    expect(first).toEqual({ jobId: "j-1", runId: "j-1-r1", state: "running" });
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "run_started"), { timeoutMs: 30_000, describe: () => "等这次运行开始" });
    // 上一次还在跑：不开始，原因清楚
    expect(refusalOf(await frontend.runJobNow({ jobId: "j-1" }))).toBe("not_allowed 「每天出 AI 新闻日报」上一次还在跑，跑完再说");
    await runEnded(frontend, 1);
    const run1 = jobsOf(frontend).find((e) => e.change === "run_finished")!;
    expect(run1.run).toMatchObject({ runId: "j-1-r1", trigger: "manual", state: "done", dueAt: nowIso(at(5, 8)), events: [{ source: "manual", summary: "1 月 5 日（周一）08:00 你让它立即运行一次" }] });
    // 不改时间表、不算错过补发：下一次还是 09:00
    expect(run1.job).toMatchObject({ state: "active", nextAt, runCount: 1 });
    // 交给 agent 的那条写着怎么触发的
    expect(tasksOf(frontend)[0]!.task.maintainerId).toBe("tm-1");
    expect(messagesOf(frontend, maintainerChannel("tm-1")).some((m) => m.agentInput === true && textOf(m).includes("触发：1 月 5 日（周一）08:00 你让它立即运行一次"))).toBe(true);

    // 暂停着：能跑一次，跑完照旧暂停（没有下一次）
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }));
    clock.advanceTo(at(5, 8, 30));
    const second = ok(await frontend.runJobNow({ jobId: "j-1" })) as RunJobNowResult;
    expect(second).toMatchObject({ runId: "j-1-r2" });
    await runEnded(frontend, 2);
    const run2 = jobsOf(frontend).filter((e) => e.change === "run_finished")[1]!;
    expect(run2.run).toMatchObject({ trigger: "manual", state: "done" });
    expect(run2.job).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(run2.job.nextAt).toBeUndefined();
    expect(jobsOf(frontend).some((e) => e.change === "resumed")).toBe(false);

    // 恢复之后到点照常运行（到点的触发记成 scheduled）
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" }));
    clock.advanceTo(at(5, 9));
    await runEnded(frontend, 3);
    expect(jobsOf(frontend).filter((e) => e.change === "run_finished")[2]!.run).toMatchObject({ runId: "j-1-r3", trigger: "scheduled", state: "done" });

    // 取消了的、没有的：被拒
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "cancel" }));
    expect(refusalOf(await frontend.runJobNow({ jobId: "j-1" }))).toMatch(/^not_allowed .*已取消/);
    expect(refusalOf(await frontend.runJobNow({ jobId: "j-9" }))).toMatch(/^not_found /);
  }, 90_000);
});

describe("秘书的入口", () => {
  it("用户说“把 t-1 再跑一次”“以后 t-1 跑完直接念给我”：点明了直接执行；没点明是哪个任务的出卡，确认后才执行", async () => {
    const { frontend } = await setup({
      secretary: [
        propose("run_task_now", { task: "t-1" }),
        say("好，开始跑了"),
        say("跑完了，要我念给你听吗？"),
        propose("set_voice_announce", { task: "t-1", on: true }),
        say("好，以后跑完直接念给你听"),
        propose("set_voice_announce", { task: "t-1", on: false }),
        say("要关掉 t-1 的自动播报吗？卡片上点一下"),
      ],
      maintainer: [say("日报写好了")],
    });
    ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8));
    await registered(frontend);

    await frontend.sendText("把 t-1 再跑一次");
    await runEnded(frontend, 1);
    expect(jobsOf(frontend).find((e) => e.change === "triggered")).toMatchObject({ by: "user", run: { trigger: "manual" } });
    const [runCard] = cardsOf(frontend).filter((c) => c.type === "quick_action");
    expect(runCard).toMatchObject({ status: "handled", outcome: { action: "execute" }, payload: { action: { type: "run_task_now", params: { taskId: "t-1" } }, explicit: true } });
    // 跑完的通知那一轮也处理完了再说下一句
    await secretaryTurns(frontend, 2);

    await frontend.sendText("以后 t-1 跑完直接念给我");
    await waitUntil(() => tasksOf(frontend).some((e) => e.change === "voice_announce_set"), { timeoutMs: 30_000, describe: () => "等开关打开" });
    expect(tasksOf(frontend).find((e) => e.change === "voice_announce_set")).toMatchObject({ by: "user", task: { id: "t-1", voiceAnnounce: true } });
    await secretaryTurns(frontend, 3);

    // 没点明是哪个任务：出卡，确认之前不变
    await frontend.sendText("那个日报以后别自动念了");
    await secretaryTurns(frontend, 4);
    const pending = cardsOf(frontend).filter((c) => c.type === "quick_action").at(-1)!;
    expect(pending).toMatchObject({ status: "pending", payload: { action: { type: "set_voice_announce", params: { taskId: "t-1", on: false } }, explicit: false } });
    expect(tasksOf(frontend).filter((e) => e.change === "voice_announce_set")).toHaveLength(1);
    ok(await frontend.cardAction({ cardId: pending.id, action: "execute", expectedVersion: pending.version }));
    await waitUntil(() => tasksOf(frontend).filter((e) => e.change === "voice_announce_set").length >= 2, { timeoutMs: 30_000, describe: () => "等开关关上" });
    expect(tasksOf(frontend).at(-1)).toMatchObject({ change: "voice_announce_set", task: { voiceAnnounce: false } });
  }, 60_000);

  it("上一次还在跑时秘书提“再跑一次”：直接被拒，原因交回秘书（不出卡）", async () => {
    const { frontend } = await setup({
      maintainerTokensPerSecond: 20,
      secretary: [propose("run_task_now", { task: "t-1" }), say("上一次还在跑，跑完再说")],
      maintainer: [say(`跑完了：${"今天的新闻都汇总好了，".repeat(15)}`)],
    });
    ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8));
    await registered(frontend);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await waitUntil(() => jobsOf(frontend).some((e) => e.change === "run_started"), { timeoutMs: 30_000, describe: () => "等这次运行开始" });
    await frontend.sendText("把 t-1 再跑一次");
    await secretaryTurns(frontend, 1);
    const calls = messagesOf(frontend, SECRETARY)
      .flatMap((m) => m.message.parts)
      .filter((p) => p.type === "tool_call" && p.tool === "propose_quick_action");
    expect(calls.at(-1)).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("上一次还在跑，跑完再说") });
    expect(cardsOf(frontend).filter((c) => c.type === "quick_action")).toEqual([]);
    expect(jobsOf(frontend).filter((e) => e.change === "triggered")).toHaveLength(1);
  }, 60_000);
});
