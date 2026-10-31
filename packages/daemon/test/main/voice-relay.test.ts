// 主切面：项目、任务的进展用负责人自己的声音汇报（354 号票，用户 2026-11-01 定）。真的守护进程，秘书、维护者接 faux 剧本，
// 合成服务是假的（helpers/tts.ts，空闲端口），参考音色都是编的示例：
// - 不增加打扰，只是换声音：开了自动播报的任务做完、开关开着的任务或项目的进展来信、用户打字或说话问进展，都是秘书开场 + 负责人的声音；
//   开关关着、用户也没问的照旧是文字，发不了语音；
// - 负责人没配音色、音色和秘书的一样、音色被删了（包括排队时才被删）：退回一条秘书的语音；
// - 第二段没合成出来：只合成了一部分，说明里写清谁的话没念到和那段话，文字不丢；重启重做不重复发；
// - 模型指定不了别的 agent 的声音：工具没有这种参数；relay.source 只能是这一轮的通知（或者交过的通知）写着的，声音按通知上记的发信人查角色；
// - 项目的"自动播报"开关：默认关，用户在项目页或让秘书开关；
// - 负责人不能直接发：只有秘书的会话能带 relay；负责人那段不进素材（不当成用户说的）。
import fs from "node:fs";
import path from "node:path";
import {
  agentVoiceCoversReply,
  type AgentVoiceEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type ProjectEventPayload,
  PURGED_TEXT,
  type ReferenceVoice,
  type ResponseFrame,
  type TaskTrigger,
  type TurnEndEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../../src/secretary/notice-tags.ts";
import { AUTO_ANNOUNCE_TAG } from "../../src/secretary/task-done.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentRolesApi, pluginsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { agentVoiceSettled, agentVoiceVersions, FAKE_SPEECH_BUSY, type FakeSpeechService, importReferenceVoice, makeWav, referenceVoicesApi, SAMPLE_VOICE, startFakeSpeechService } from "../helpers/tts.ts";
import { sendVoice } from "../helpers/voice.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");
const DAILY_8 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "08:00" } } satisfies TaskTrigger;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 秘书开场 */
const OPENING = "日报有消息了，小张来说。";
/** 负责人那段（第一人称，只转述信里有的） */
const OWNER_SAYS = "我把日报写好了，共三条。";
const MERGED = `${OPENING}\n${OWNER_SAYS}`;
const relayCall = (source: string, opening = OPENING, owner = OWNER_SAYS): FauxStep => call("send_voice", { text: opening, relay: { source, text: owner } });
const tell = (text: string, summary = "日报写好了"): FauxStep => call("tell_secretary", { summary, text });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
/** 秘书会话里运行时交的通知 */
const notices = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && m.message.speaker === "system");
/** 给人看的系统说明 */
const notes = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "system" && m.agentInput !== true).map(textOf);
const ttsMessages = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.parts.some((p) => p.type === "tts_audio"));
const agentTexts = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent").map(textOf).filter((x) => x !== "");
/** 发语音的每次调用（同一次取最后的样子） */
const voiceCalls = (frontend: TestFrontend, channel: string = SECRETARY) => {
  const calls = new Map<string, ToolCallPart>();
  for (const m of messagesOf(frontend, channel)) for (const p of m.message.parts) if (p.type === "tool_call" && p.tool === "send_voice") calls.set(p.callId, p);
  return [...calls.values()];
};
const turnsOf = (frontend: TestFrontend, channel: string = SECRETARY) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as TurnEndEventPayload).outcome);
const turnsDone = (frontend: TestFrontend, n: number, channel: string = SECRETARY) =>
  waitUntil(() => turnsOf(frontend, channel).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条（现在 ${JSON.stringify(turnsOf(frontend, channel))}，通知：${JSON.stringify(notices(frontend).map(textOf))}）` });
const noticesArrived = (frontend: TestFrontend, n: number) => waitUntil(() => notices(frontend).length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 条通知（现在：${JSON.stringify(notices(frontend).map(textOf))}）` });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const registered = (frontend: TestFrontend) => waitUntil(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).length > 0, { timeoutMs: 30_000, describe: () => "等登记" });

/** 请求里的参考录音是哪个音色的（voices/<音色 id>/reference.wav） */
const voiceIdOfRequest = (r: { voiceRef: string }) => path.basename(path.dirname(r.voiceRef));
const voicesAsked = (tts: FakeSpeechService) => tts.requests.map(voiceIdOfRequest);

async function setup(options: StartTestDaemonOptions, channels: string[] = [BOARD, SECRETARY, CARDS, INBOX]) {
  const td = await startTestDaemon(options);
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return { ...td, frontend };
}

/** 再导入一个音色（不选用） */
async function importVoice(url: string, name: string, seconds = 4): Promise<ReferenceVoice> {
  const res = await referenceVoicesApi.import(url, { name, referenceText: SAMPLE_VOICE.referenceText, audio: makeWav(seconds) });
  if (res.status !== 201) throw new Error(`导入音色失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 秘书用一个音色，建一个带另一个音色的角色"小张" */
async function secretaryAndOwnerVoices(url: string) {
  const secretary = await importReferenceVoice(url, "秘书的声音");
  const owner = await importVoice(url, "小张的声音");
  const created = await agentRolesApi.create(url, { name: "小张", voiceId: owner.id });
  if (created.status !== 200 && created.status !== 201) throw new Error(`建角色失败：${created.status} ${JSON.stringify(created.body)}`);
  const role = created.body.roles.find((r) => r.name === "小张")!;
  const roles = (await agentRolesApi.list(url)).body;
  const assistantName = roles.roles.find((r) => r.id === roles.defaultRoleId)!.name;
  return { secretary, owner, role, assistantName };
}

/** 开着自动播报（或关着）的定时任务 t-1：登记好了，tm-1 配好了角色，交给调用方点"立即运行一次" */
async function scheduledTask(frontend: TestFrontend, voiceAnnounce: boolean) {
  ok(await frontend.startTask("每天出 AI 新闻日报", "k-news", [], "plain", DAILY_8, voiceAnnounce ? { voiceAnnounce: true } : {}));
  await registered(frontend);
}

/** 使用中的项目 p-1（维护者 pm-1），开关开着或关着 */
const inUseProject = { state: "in_use" as const, charterConfirmed: true, kind: "dev" as const, toolkit: { skills: [], mcp: [], bash: true, network: true } };

describe("什么时候用负责人的声音", () => {
  it("开了自动播报的任务做完：秘书开场 + 负责人的声音，两段各带对的参考音色，拼成一条语音、一个气泡", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), say("念好了")], maintainer: [say("日报写好了，三条要闻")] });
    const { secretary, owner, role, assistantName } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);

    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await noticesArrived(frontend, 1);
    const [notice] = notices(frontend);
    const text = textOf(notice!);
    expect(text.startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`)).toBe(true);
    // 通知写明负责人有自己的声音、relay 怎么写；声音是运行时定的
    expect(text).toContain("负责人有自己的声音（小张）");
    expect(text).toContain("relay.source 写 t-1");
    expect(notice!.message.relaySources).toEqual([{ source: "t-1", agentId: "tm-1" }]);

    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice).toMatchObject({
      mode: "tool",
      status: "done",
      text: MERGED,
      referenceVoice: { id: secretary.id, name: "秘书的声音" },
      parts: [
        { text: OPENING, referenceVoice: { id: secretary.id, name: "秘书的声音" }, speaker: { agentId: SECRETARY, name: assistantName } },
        { text: OWNER_SAYS, referenceVoice: { id: owner.id, name: "小张的声音" }, speaker: { agentId: "tm-1", name: "小张" } },
      ],
    });
    // 假服务收到的：两段各带自己的参考录音，也各带自己的逐字稿
    expect(tts.requests.map((r) => r.input)).toEqual([OPENING, OWNER_SAYS]);
    expect(voicesAsked(tts)).toEqual([secretary.id, owner.id]);
    expect(tts.requests[0]!.voiceRefBytes!.length).not.toBe(tts.requests[1]!.voiceRefBytes!.length);
    // 拼成一条：一条语音消息，时长是两段加段间停顿
    const [bubble] = ttsMessages(frontend);
    expect(ttsMessages(frontend)).toHaveLength(1);
    const [first, second] = voice.segments!;
    expect(voice.durationMs).toBe(first!.durationMs + 200 + second!.durationMs);
    expect(bubble!.message.parts).toEqual([{ type: "tts_audio", voiceId: voice.id, mediaId: voice.mediaId, mime: "audio/wav", durationMs: voice.durationMs, waveform: voice.waveform }]);
    // 工具结果写明哪段是谁说的（负责人那段不是秘书自己的结论）
    await turnsDone(frontend, 1);
    expect(voiceCalls(frontend)[0]).toMatchObject({ outcome: "done", resultSummary: expect.stringContaining("小张") });
  }, 60_000);

  it("开关开着的项目，负责人的进展来信：通知标着自动播报（不问），秘书开场 + 负责人的声音", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup(
      { speechUrl: tts.url, secretary: [relayCall("p-1"), say("念好了")], maintainer: (id) => (id === "pm-1" ? [tell("日报写好了，三条要闻都在里面。"), say("写回了")] : []) },
      [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1],
    );
    const { owner, role } = await secretaryAndOwnerVoices(url);
    seedProject(daemon, "简报站", inUseProject);
    expect((await agentRolesApi.assign(url, "pm-1", role.id)).status).toBe(200);
    expect(ok(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: true }, "k-on"))).toEqual({ projectId: "p-1", on: true });

    await frontend.sendText("把今天的日报写一下", { conversation: PM1 });
    await noticesArrived(frontend, 1);
    const [notice] = notices(frontend);
    const text = textOf(notice!);
    expect(text.startsWith(`${MAINTAINER_LETTER_TAG}${AUTO_ANNOUNCE_TAG}`)).toBe(true);
    expect(text).toContain("负责人有自己的声音（小张）");
    expect(text).toContain("relay.source 写 p-1");
    expect(text).not.toContain("要我念给你听吗");
    expect(notice!.message.relaySources).toEqual([{ source: "p-1", agentId: "pm-1" }]);

    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice.parts!.map((p) => p.speaker)).toEqual([expect.objectContaining({ agentId: SECRETARY }), { agentId: "pm-1", name: "小张" }]);
    expect(voicesAsked(tts).at(-1)).toBe(owner.id);
  }, 60_000);

  it("开关开着的任务，负责人的进展来信：来信和做完的通知都能念，各用各的", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({
      speechUrl: tts.url,
      secretary: [relayCall("t-1"), say("念好了"), relayCall("t-1", "这件做完了，小张说：", "全部写完了。"), say("念好了")],
      maintainer: [tell("写到一半，有三条要闻。"), say("日报写好了")],
    });
    const { owner, role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 2);
    const texts = notices(frontend).map(textOf);
    expect(texts.some((x) => x.startsWith(`${MAINTAINER_LETTER_TAG}${AUTO_ANNOUNCE_TAG}`))).toBe(true);
    expect(texts.some((x) => x.startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`))).toBe(true);
    await agentVoiceSettled(frontend, "done", 2);
    // 两条语音（同一条合成好之后还会记下收不收这一轮的文字，按 id 算），后面一段都是负责人的声音
    const voices = [...new Map(agentVoiceVersions(frontend).filter((v) => v.status === "done").map((v) => [v.id, v])).values()];
    expect(voices.map((v) => v.parts!.at(-1)!.referenceVoice.id)).toEqual([owner.id, owner.id]);
  }, 60_000);

  it("用户打字问进展（之前来过信）：那一轮秘书开场 + 负责人的声音；开关关着也行，因为是用户问的；负责人那段不算用户的话，历史里带着谁说的", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup({
      speechUrl: tts.url,
      secretary: [say("t-1 来信了：日报写好了。要我念给你听吗？"), say("任务做完了。"), relayCall("t-1"), say("就这些。")],
      maintainer: [tell("日报写好了，三条要闻都在里面。"), say("日报写好了")],
    });
    const { owner, secretary, role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, false);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 2);
    expect(agentVoiceVersions(frontend)).toEqual([]);

    const sent = await frontend.sendText("t-1 现在进展怎么样？");
    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice).toMatchObject({ mode: "tool", inputMessageId: sent.messageId });
    expect(voicesAsked(tts)).toEqual([secretary.id, owner.id]);
    expect(voice.parts!.map((p) => p.text)).toEqual([OPENING, OWNER_SAYS]);

    // 记忆：用户问的那句是素材，负责人那段不是（只在语音对象上，不进用户的原话）
    const materials = JSON.stringify(daemon.materials.list());
    expect(materials).toContain("现在进展怎么样");
    expect(materials).not.toContain(OWNER_SAYS);
    // 往上翻：语音对象随页带着两段和谁说的，老的读者读到的 text 是连起来的
    await turnsDone(frontend, 3);
    const page = await frontend.history(SECRETARY);
    expect(page.agentVoices?.find((v) => v.id === voice.id)).toMatchObject({ text: MERGED, parts: [{ speaker: { agentId: SECRETARY } }, { speaker: { agentId: "tm-1", name: "小张" } }] });
    // 交回模型的结果写明后面那段是谁说的（不是秘书自己的结论）
    expect(voiceCalls(frontend).at(-1)!.resultSummary).toContain("算它说的，不是你的结论");
  }, 60_000);

  it("用户说话问进展：语音回复也是两段；回复的文字照常显示（语音是转述，不是这段文字）", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({
      speechUrl: tts.url,
      secretary: [say("t-1 来信了：日报写好了。"), say("任务做完了。"), relayCall("t-1"), say("详细的在任务里。")],
      maintainer: [tell("日报写好了，三条要闻都在里面。"), say("日报写好了")],
    });
    const { owner, secretary, role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, false);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 2);

    await sendVoice(frontend, url, { text: "t-1 现在进展怎么样" });
    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice).toMatchObject({ mode: "summary", summaryBy: "agent", text: MERGED });
    expect(voice.parts!.map((p) => p.referenceVoice.id)).toEqual([secretary.id, owner.id]);
    expect(voicesAsked(tts)).toEqual([secretary.id, owner.id]);
    expect(agentVoiceCoversReply(voice)).toBe(false);
    expect(agentTexts(frontend).at(-1)).toBe("详细的在任务里。");
    // 语音轮只有这一条语音：工具没有另建一条
    expect(new Set(agentVoiceVersions(frontend).map((v) => v.id)).size).toBe(1);
    expect(ttsMessages(frontend)).toHaveLength(1);
    expect(voiceCalls(frontend).at(-1)).toMatchObject({ outcome: "done", resultSummary: expect.stringContaining("这一轮的语音回复") });
  }, 60_000);

  it("开关关着、用户也没问：负责人的来信还是文字，这一轮发不了语音", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup(
      { speechUrl: tts.url, secretary: [relayCall("p-1"), say("小张说日报写好了，要我念给你听吗？")], maintainer: (id) => (id === "pm-1" ? [tell("日报写好了，三条要闻都在里面。"), say("写回了")] : []) },
      [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1],
    );
    const { role } = await secretaryAndOwnerVoices(url);
    seedProject(daemon, "简报站", inUseProject);
    expect((await agentRolesApi.assign(url, "pm-1", role.id)).status).toBe(200);
    await frontend.sendText("把今天的日报写一下", { conversation: PM1 });
    await noticesArrived(frontend, 1);
    const text = textOf(notices(frontend)[0]!);
    expect(text.startsWith(`${MAINTAINER_LETTER_TAG}后台`)).toBe(true);
    expect(text).toContain("要我念给你听吗");
    await turnsDone(frontend, 1);
    expect(voiceCalls(frontend)).toMatchObject([{ outcome: "error", resultSummary: expect.stringContaining("发不了语音") }]);
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
    expect(agentTexts(frontend)).toEqual(["小张说日报写好了，要我念给你听吗？"]);
  }, 60_000);
});

/**
 * 开了自动播报的任务 t-1 做完，秘书照样写了两段：看最后合成的是什么样子（通知里写没写负责人有自己的声音、语音分没分段、
 * 用了哪几个音色、几个气泡、念了哪些字）
 */
async function relayedWith(prepare: (ctx: { url: string; secretary: ReferenceVoice }) => Promise<void>) {
  const tts = await startFakeSpeechService();
  const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), say("念好了")], maintainer: [say("日报写好了")] });
  const secretary = await importReferenceVoice(url, "秘书的声音");
  await scheduledTask(frontend, true);
  await prepare({ url, secretary });
  ok(await frontend.runJobNow({ jobId: "j-1" }));
  await noticesArrived(frontend, 1);
  const voice = await agentVoiceSettled(frontend, "done");
  await turnsDone(frontend, 1);
  return {
    hinted: textOf(notices(frontend)[0]!).includes("负责人有自己的声音"),
    parts: voice.parts,
    text: voice.text,
    voices: [voice.referenceVoice!.id, ...new Set(voicesAsked(tts))],
    bubbles: ttsMessages(frontend).length,
    spoken: tts.requests.map((r) => r.input).join(""),
    secretary: secretary.id,
  };
}

/** 退回一条秘书的语音的样子：不分段，文字没丢（两段都念了），只用秘书的音色，一个气泡 */
const SINGLE = { hinted: false, parts: undefined, text: MERGED, bubbles: 1, spoken: MERGED.replace("\n", "") };

describe("退回一条秘书的语音", () => {
  it("负责人没配音色（跟默认）", async () => {
    const result = await relayedWith(async () => {});
    expect(result).toMatchObject(SINGLE);
    expect(result.voices).toEqual([result.secretary, result.secretary]);
  }, 60_000);

  it("角色只有名字、音色跟默认：一样算没配", async () => {
    const result = await relayedWith(async ({ url }) => {
      const created = await agentRolesApi.create(url, { name: "小张" });
      await agentRolesApi.assign(url, "tm-1", created.body.roles.find((r) => r.name === "小张")!.id);
    });
    expect(result).toMatchObject(SINGLE);
    expect(result.voices).toEqual([result.secretary, result.secretary]);
  }, 60_000);

  it("音色和秘书的一样", async () => {
    const result = await relayedWith(async ({ url, secretary }) => {
      const created = await agentRolesApi.create(url, { name: "小张", voiceId: secretary.id });
      await agentRolesApi.assign(url, "tm-1", created.body.roles.find((r) => r.name === "小张")!.id);
    });
    expect(result).toMatchObject(SINGLE);
    expect(result.voices).toEqual([result.secretary, result.secretary]);
  }, 60_000);

  it("音色被删了（通知之前）", async () => {
    const result = await relayedWith(async ({ url }) => {
      const owner = await importVoice(url, "小张的声音");
      const created = await agentRolesApi.create(url, { name: "小张", voiceId: owner.id });
      await agentRolesApi.assign(url, "tm-1", created.body.roles.find((r) => r.name === "小张")!.id);
      const removed = await referenceVoicesApi.remove(url, owner.id);
      if (removed.status !== 200) throw new Error(`删音色失败：${removed.status}`);
    });
    expect(result).toMatchObject(SINGLE);
    expect(result.voices).toEqual([result.secretary, result.secretary]);
  }, 60_000);

  it("音色在排队时才被删（已经建出两段的语音）：起来重做时退回一条秘书的语音", async () => {
    const reuse = { dataDir: makeTempDir("ergo-data-"), homeDir: makeTempDir("ergo-home-") };
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const first = await setup({ reuse, speechUrl: tts.url, secretary: [relayCall("t-1"), say("念好了")], maintainer: [say("日报写好了")] });
    const { owner, secretary, role } = await secretaryAndOwnerVoices(first.url);
    await scheduledTask(first.frontend, true);
    expect((await agentRolesApi.assign(first.url, "tm-1", role.id)).status).toBe(200);
    ok(await first.frontend.runJobNow({ jobId: "j-1" }));
    await agentVoiceSettled(first.frontend, "synthesizing");
    await waitUntil(() => tts.held > 0, { timeoutMs: 20_000, describe: () => "等合成请求被 hold 住" });
    await first.frontend.close();
    await first.daemon.stop();
    // 停着的时候音色没了（voices 区里的文件就是真相）
    fs.rmSync(path.join(first.dataDir, "voices", owner.id), { recursive: true, force: true });
    tts.requests.length = 0;
    tts.behave("ok");
    tts.release();

    const second = await setup({ reuse, speechUrl: tts.url, secretary: [say("刚才念过了")] }, [SECRETARY]);
    const voice = await agentVoiceSettled(second.frontend, "done");
    expect(voice.parts).toBeUndefined();
    expect(voice).toMatchObject({ text: MERGED, referenceVoice: { id: secretary.id } });
    expect(voicesAsked(tts).every((id) => id === secretary.id)).toBe(true);
  }, 90_000);
});

describe("第二段没合成出来", () => {
  it("只合成了一部分：气泡是第一段，说明里写清谁的话没念到和那段话，语音对象上两段的文字都在；工具把结局交回", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), say("小张那段语音服务忙，没念出来。")], maintainer: [say("日报写好了")] });
    const { secretary, owner, role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    tts.script("ok", FAKE_SPEECH_BUSY);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    const voice = await agentVoiceSettled(frontend, "partial");
    expect(voicesAsked(tts)).toEqual([secretary.id, owner.id]);
    expect(voice.text).toBe(MERGED);
    expect(voice.parts!.map((p) => p.text)).toEqual([OPENING, OWNER_SAYS]);
    expect(voice.segments).toHaveLength(1);
    expect(ttsMessages(frontend)).toHaveLength(1);
    expect(voice.durationMs).toBe(voice.segments![0]!.durationMs);
    await turnsDone(frontend, 1);
    const note = notes(frontend).find((t) => t.includes("只发出去了"))!;
    expect(note).toContain("语音服务忙");
    expect(note).toContain("小张");
    expect(note).toContain(OWNER_SAYS);
    expect(voiceCalls(frontend)[0]).toMatchObject({ outcome: "done", resultSummary: expect.stringContaining("只发出去了") });
    // 这一轮另写的文字照常显示（只合成了一部分的不收）
    expect(agentVoiceCoversReply(agentVoiceVersions(frontend, voice.id).at(-1)!)).toBe(false);
  }, 60_000);

  it("第一段都没出来：记成失败，秘书照规矩用文字发（文字不丢）", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), say("语音服务忙，文字发你：日报写好了。")], maintainer: [say("日报写好了")] });
    const { role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    tts.behave(FAKE_SPEECH_BUSY);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await agentVoiceSettled(frontend, "failed");
    await turnsDone(frontend, 1);
    expect(notes(frontend).some((t) => t.startsWith("这条语音没发出去（"))).toBe(true);
    expect(voiceCalls(frontend)[0]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("语音没发出去") });
    expect(agentTexts(frontend)).toEqual(["语音服务忙，文字发你：日报写好了。"]);
    expect(ttsMessages(frontend)).toEqual([]);
  }, 60_000);

  it("合成到第二段时守护进程停了：起来从第一段重做，还是两段各带对的音色，只发一条，通知重新交时写明念过了", async () => {
    const reuse = { dataDir: makeTempDir("ergo-data-"), homeDir: makeTempDir("ergo-home-") };
    const tts = await startFakeSpeechService();
    const first = await setup({ reuse, speechUrl: tts.url, secretary: [relayCall("t-1"), say("念好了")], maintainer: [say("日报写好了")] });
    const { owner, secretary, role } = await secretaryAndOwnerVoices(first.url);
    await scheduledTask(first.frontend, true);
    expect((await agentRolesApi.assign(first.url, "tm-1", role.id)).status).toBe(200);
    tts.script("ok", "hold");
    ok(await first.frontend.runJobNow({ jobId: "j-1" }));
    await waitUntil(() => tts.held > 0, { timeoutMs: 30_000, describe: () => `等第二段被 hold 住（${tts.requests.length}）` });
    const pending = agentVoiceVersions(first.frontend).at(-1)!;
    expect(pending).toMatchObject({ status: "synthesizing", segments: [expect.anything()] });
    await first.frontend.close();
    await first.daemon.stop();
    tts.requests.length = 0;
    tts.behave("ok");
    tts.release();

    const second = await setup({ reuse, speechUrl: tts.url, secretary: [say("刚才念过了")] }, [SECRETARY]);
    const voice = await agentVoiceSettled(second.frontend, "done");
    expect(voice.id).toBe(pending.id);
    expect(voice.parts!.map((p) => p.referenceVoice.id)).toEqual([secretary.id, owner.id]);
    expect(voicesAsked(tts)).toEqual([secretary.id, owner.id]);
    expect(ttsMessages(second.frontend)).toHaveLength(1);
    // 被打断的通知重新交：写明念过了，这一轮不再放行语音
    await waitUntil(() => notices(second.frontend).length >= 2, { timeoutMs: 30_000, describe: () => `等重新交（${JSON.stringify(notices(second.frontend).map(textOf))}）` });
    const again = textOf(notices(second.frontend)[1]!);
    expect(again).not.toContain(AUTO_ANNOUNCE_TAG);
    expect(again).toContain("念过了");
    expect(notices(second.frontend)[1]!.message.relaySources).toEqual([{ source: "t-1", agentId: "tm-1" }]);
    expect(new Set(agentVoiceVersions(second.frontend).map((v) => v.id))).toEqual(new Set([pending.id]));
  }, 90_000);
});

describe("进展来信念到一半守护进程停了", () => {
  it("一次只念一回：起来后语音合成好了才重新交，还是来信的通知，写明念过了、不再放行语音", async () => {
    const reuse = { dataDir: makeTempDir("ergo-data-"), homeDir: makeTempDir("ergo-home-") };
    const tts = await startFakeSpeechService();
    tts.behave("hold");
    const first = await setup(
      { reuse, speechUrl: tts.url, secretary: [relayCall("p-1"), say("念好了")], maintainer: (id) => (id === "pm-1" ? [tell("日报写好了，共三条。"), say("写回了")] : []) },
      [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, PM1],
    );
    const { role } = await secretaryAndOwnerVoices(first.url);
    seedProject(first.daemon, "简报站", inUseProject);
    expect((await agentRolesApi.assign(first.url, "pm-1", role.id)).status).toBe(200);
    ok(await first.frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: true }, "k-on"));
    await first.frontend.sendText("把今天的日报写一下", { conversation: PM1 });
    const pending = await agentVoiceSettled(first.frontend, "synthesizing");
    await waitUntil(() => tts.held > 0, { timeoutMs: 20_000, describe: () => "等合成请求被 hold 住" });
    await first.frontend.close();
    await first.daemon.stop();
    tts.behave("ok");
    tts.release();

    const second = await setup({ reuse, speechUrl: tts.url, secretary: [relayCall("p-1"), say("刚才念过了")] }, [SECRETARY]);
    await waitUntil(() => notices(second.frontend).length >= 2, { timeoutMs: 30_000, describe: () => `等重新交（${JSON.stringify(notices(second.frontend).map(textOf))}）` });
    const again = textOf(notices(second.frontend)[1]!);
    expect(again.startsWith(MAINTAINER_LETTER_TAG)).toBe(true);
    expect(again).not.toContain(AUTO_ANNOUNCE_TAG);
    expect(again).toContain("念过了");
    await turnsDone(second.frontend, 2);
    expect(voiceCalls(second.frontend).at(-1)).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("发不了语音") });
    expect(new Set(agentVoiceVersions(second.frontend).map((v) => v.id))).toEqual(new Set([pending.id]));
    expect(ttsMessages(second.frontend)).toHaveLength(1);
  }, 90_000);
});

describe("模型指定不了别的 agent 的声音", () => {
  it("工具没有指定声音的参数：写了音色、agent 的调用不合参数，不合成", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({
      speechUrl: tts.url,
      secretary: [
        call("send_voice", { text: OPENING, relay: { source: "t-1", text: OWNER_SAYS, voiceId: "v-1" } }),
        call("send_voice", { text: OPENING, voiceId: "v-1" }),
        call("send_voice", { text: OPENING, relay: { source: "t-1", text: OWNER_SAYS, agentId: "tm-1" } }),
        { kind: "echo_context" },
      ],
      maintainer: [say("日报写好了")],
    });
    const { role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 1);
    // 参数不合的调用到不了工具：模型收到校验的错，语音没建、合成没调
    const seen = agentTexts(frontend).at(-1)!;
    expect(seen.match(/Validation failed for tool "send_voice"/g)).toHaveLength(3);
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
  }, 60_000);

  it("relay.source 只能是这条通知写着的：别的任务、agent 的编号、编的都拒，不建语音", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup({
      speechUrl: tts.url,
      secretary: [relayCall("p-1"), relayCall("tm-1"), relayCall("secretary"), relayCall("随便写的"), say("好")],
      maintainer: [say("日报写好了")],
    });
    const { role } = await secretaryAndOwnerVoices(url);
    seedProject(daemon, "简报站", inUseProject);
    expect((await agentRolesApi.assign(url, "pm-1", role.id)).status).toBe(200);
    await scheduledTask(frontend, true);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 1);
    const calls = voiceCalls(frontend);
    expect(calls.map((c) => c.outcome)).toEqual(["error", "error", "error", "error"]);
    expect(calls[0]!.resultSummary).toContain("这条通知");
    expect(agentVoiceVersions(frontend)).toEqual([]);
    expect(tts.requests).toEqual([]);
  }, 60_000);

  it("用户问的那一轮：还没给秘书来过信或做完通知的任务没有可转述的，拒；不带 relay 照常是一条秘书的语音", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), call("send_voice", { text: "t-1 还在做，它还没来过信。" }), say("好")], maintainer: [] });
    const { secretary, role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, false);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    await frontend.sendText("t-1 进展怎么样？");
    const voice = await agentVoiceSettled(frontend, "done");
    expect(voice.parts).toBeUndefined();
    expect(voicesAsked(tts).every((id) => id === secretary.id)).toBe(true);
    expect(voiceCalls(frontend)[0]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("没有可转述的") });
  }, 60_000);

  it("负责人不能直接发：任务自己的会话里带 relay 被拒；两段加起来太长也被拒", async () => {
    const tts = await startFakeSpeechService();
    const long = "这段话很长，".repeat(120);
    const { url, frontend } = await setup(
      {
        speechUrl: tts.url,
        secretary: [say("t-1 来信了。"), say("做完了。"), relayCall("t-1", OPENING, long), say("太长了")],
        // 用户在任务详情里接着说时这个 agent 可能是接着跑的，也可能是重新拉起的：两种都走到带 relay 的那一步
        maintainer: (_id, spawn) => (spawn === 1 ? [tell("日报写好了。"), say("日报写好了"), relayCall("t-1"), say("好")] : [relayCall("t-1"), say("好")]),
      },
      [BOARD, SECRETARY, CARDS, INBOX, TM1],
    );
    const { role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, false);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await turnsDone(frontend, 2);

    await frontend.sendText("直接跟我说说", { conversation: TM1, taskId: "t-1" });
    await waitUntil(() => voiceCalls(frontend, TM1).length > 0 && voiceCalls(frontend, TM1)[0]!.outcome !== "running", { timeoutMs: 30_000, describe: () => JSON.stringify(voiceCalls(frontend, TM1)) });
    expect(voiceCalls(frontend, TM1)[0]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("只有") });

    await frontend.sendText("t-1 现在进展怎么样？");
    await turnsDone(frontend, 3);
    expect(voiceCalls(frontend)[0]).toMatchObject({ outcome: "error", resultSummary: expect.stringContaining("太长了") });
    expect(agentVoiceVersions(frontend)).toEqual([]);
  }, 90_000);
});

describe("移除语音插件并连数据删", () => {
  it("两段的文字都换成删除标记", async () => {
    const tts = await startFakeSpeechService();
    const { url, frontend, daemon } = await setup({ speechUrl: tts.url, secretary: [relayCall("t-1"), say("念好了")], maintainer: [say("日报写好了")] });
    const { role } = await secretaryAndOwnerVoices(url);
    await scheduledTask(frontend, true);
    expect((await agentRolesApi.assign(url, "tm-1", role.id)).status).toBe(200);
    ok(await frontend.runJobNow({ jobId: "j-1" }));
    await agentVoiceSettled(frontend, "done");
    await turnsDone(frontend, 1);
    expect((await pluginsApi.act(url, "voice", { action: "remove", purgeData: true, idempotencyKey: "k-remove" })).status).toBe(200);
    const voices = daemon.store.ofType(EVENT_TYPES.agentVoice).map((e) => (e.payload as AgentVoiceEventPayload).voice);
    const withParts = voices.filter((v) => v.parts !== undefined);
    expect(withParts.length).toBeGreaterThan(0);
    expect(withParts.flatMap((v) => v.parts!.map((p) => p.text)).every((text) => text === PURGED_TEXT)).toBe(true);
    expect(JSON.stringify(voices)).not.toContain(OWNER_SAYS);
  }, 60_000);
});

describe("项目的自动播报开关", () => {
  it("默认关；开关记一条 voice_announce_set（状态不变），同一个幂等键拿到同一个结果；没有的、已归档的拒", async () => {
    const { frontend, daemon } = await setup({ secretary: [] }, [PROJECTS]);
    seedProject(daemon, "简报站", inUseProject);
    seedProject(daemon, "旧项目", { ...inUseProject, state: "archived", archivedFrom: "in_use" });
    expect(daemon.projects.get("p-1")?.voiceAnnounce).toBeUndefined();
    expect(ok(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: true }, "k-1"))).toEqual({ projectId: "p-1", on: true });
    expect(ok(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: true }, "k-1"))).toEqual({ projectId: "p-1", on: true });
    // 本来就是这样的不另记
    expect(ok(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: true }, "k-2"))).toEqual({ projectId: "p-1", on: true });
    const changes = () => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload).filter((p) => p.change === "voice_announce_set");
    await waitUntil(() => changes().length >= 1, { describe: () => "等开关的事件" });
    expect(changes()).toHaveLength(1);
    expect(changes()[0]).toMatchObject({ by: "user", from: "in_use", project: { id: "p-1", state: "in_use", voiceAnnounce: true } });
    expect(ok(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-1", on: false }, "k-3"))).toEqual({ projectId: "p-1", on: false });
    const refused = await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-2", on: true }, "k-4");
    expect(refused).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await frontend.request(METHODS.setProjectVoiceAnnounce, { projectId: "p-9", on: true }, "k-5")).toMatchObject({ ok: false, error: { code: "not_found" } });
  }, 60_000);

  it("用户跟秘书说：点明了直接开，没点明的出卡确认", async () => {
    const { frontend, daemon } = await setup(
      {
        secretary: [
          call("propose_quick_action", { type: "set_project_voice_announce", params: { project: "p-1", on: true } }),
          say("好，简报站以后有进展直接念给你"),
          call("propose_quick_action", { type: "set_project_voice_announce", params: { project: "p-1", on: false } }),
          say("要关掉吗？卡片上点一下"),
        ],
      },
      [SECRETARY, CARDS, PROJECTS],
    );
    seedProject(daemon, "简报站", inUseProject);
    await frontend.sendText("以后简报站有进展直接念给我");
    await turnsDone(frontend, 1);
    expect(daemon.projects.get("p-1")?.voiceAnnounce).toBe(true);
    await frontend.sendText("那个站别自动念了");
    await turnsDone(frontend, 2);
    expect(daemon.projects.get("p-1")?.voiceAnnounce).toBe(true);
  }, 60_000);
});
