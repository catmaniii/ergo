// 主切面：了解你访谈（284 号票）。走真实的装配路径（真的守护进程、真的事件日志、真的素材库，模型全是假的）：
// - 记忆管理员每周六上午在待办里约一次（不卡事的卡，"开始""下次再说""不想做了"）；点"开始"→ 管理员在自己的会话里一问一答；
// - 访谈里用户说的话作为本人的话进素材、标上"来自访谈"，管理员问的那一句作为上下文排在前面（标明是管理员问的，不算本人的话）；
//   说"这个别记"的那一段由管理员忘掉，不留在素材里；
// - 档案信息：聊的时候管理员听到了就记下（不出卡）；收尾时说"今天我记下了这些"，这次记下的合成一张档案核对卡，逐条确认
//   （确认的经 281 的写入口写进档案，前一条新建的人后一条写进他那份；不记的不写）；管理员自己的总结不进素材、不写成结论；
//   这个主题记成聊过，下次换下一个；
// - "下次再说"一周后再约，"不想做了"以后不再约（设置 · 记忆里的约访开关跟着关）；
// - 用户主动开：记忆管理员对话里的"开始访谈"（285 号票起；以前是记忆页的"找管理员聊聊"，POST /api/memory/interview）、跟秘书说"我想做个访谈"（快速动作 start_interview）都进同一个访谈；
// - 语音插件开着时：访谈里按住说话，管理员的回话由运行时合成语音（和秘书、维护者同一套），语音转写的素材也标"来自访谈"。
// 示例对话全是编的。时钟从周六 09:00 起（这一夜的 03:00 已经过了，不会唤醒管理员去整理）；整理关着（memory.enabled=false），只看访谈。
import {
  CHANNELS,
  type Card,
  EVENT_TYPES,
  HTTP_PATHS,
  type InterviewFilesCardPayload,
  type InterviewStartResult,
  type InterviewStatusView,
  type MessageEventPayload,
  type PersonalFileDeleteResult,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MEMORY_CURATOR_CONVERSATION } from "../../src/memory/curator.ts";
import { evidenceDraftOf } from "../../src/memory/evidence-source.ts";
import { INTERVIEW_EVENT } from "../../src/memory/interview.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { ManualClock } from "../helpers/clock.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { agentVoiceSettled, importReferenceVoice, startFakeSpeechService } from "../helpers/tts.ts";
import { sendVoice } from "../helpers/voice.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const CURATOR = MEMORY_CURATOR_CONVERSATION;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-10 是周六） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 只看访谈：每晚整理关着（不建推理库、不唤醒管理员去整理） */
const NO_NIGHTLY = { memory: { enabled: false } };

type TestDaemon = Awaited<ReturnType<typeof startTestDaemon>>;

/** 会话频道上的消息（按先后） */
function messagesOf(td: TestDaemon, channel: string) {
  return td.daemon.store.read(channel, 0, EVENT_TYPES.message).map((event) => event.payload as MessageEventPayload);
}

/** 会话里的文字（按先后） */
function texts(td: TestDaemon, channel: string): string[] {
  return messagesOf(td, channel).flatMap((p) => p.message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
}

/** 待我处理里某种卡（按先后） */
function inboxCards(td: TestDaemon, type: string): Card[] {
  return td.daemon.inbox
    .list()
    .flatMap((item) => (item.kind === "card" ? [td.daemon.cards.get(item.cardId)] : []))
    .filter((card): card is Card => card !== undefined && card.type === type)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 事件库里负载含这段文字的事件（彻底删除后应该一条都没有） */
const eventsContaining = (td: TestDaemon, text: string) =>
  td.daemon.store.reader.all<{ channel: string; type: string }>("SELECT channel, type FROM events WHERE instr(payload, ?) > 0", text).map((r) => `${r.channel}/${r.type}`);

/** 访谈的记录（internal 频道上的事件） */
function interviewRecords(td: TestDaemon): Array<{ change: string; interviewId: string; topic?: string; by?: string; covered?: boolean }> {
  return td.daemon.store.read(INTERNAL_CHANNEL, 0, INTERVIEW_EVENT).map((event) => event.payload as never);
}

/** 访谈的样子（GET /api/memory/interview） */
async function status(td: TestDaemon): Promise<InterviewStatusView> {
  const res = await requestJson<InterviewStatusView>(td.url, HTTP_PATHS.memoryInterview);
  expect(res.status).toBe(200);
  return res.body;
}

/** 用户在管理员的会话里说一句，等它这一轮做完 */
async function answer(frontend: TestFrontend, text: string): Promise<void> {
  const before = frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length;
  await frontend.sendText(text, { conversation: CURATOR });
  await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length > before, { timeoutMs: 20_000, describe: () => "等管理员回话" });
}

describe("了解你访谈", () => {
  it(
    "每周约访的卡 → 点开始 → 一问一答几轮（听到档案信息先记下）→ 「这个别记」那一段忘掉 → 今天我记下了这些 → 合成一张档案核对卡逐条确认 → 素材里有带访谈标记的本人原话、连着管理员问的那句",
    { timeout: 120_000 },
    async () => {
      const clock = new ManualClock(at(10, 10, 9, 0));
      const td = await startTestDaemon({
        clock,
        memoryPlugin: true,
        config: NO_NIGHTLY,
        curator: [
          // 点了开始：开场，问第一个问题
          say("今天想聊聊家里的人，大概十来分钟，随时能跳过或者停下；你说「这个别记」我就不记。先问一个：现在家里都有谁？"),
          // 一次一个问题，带选项
          say("我注意到你提到女儿。平时接送她主要是你、你爱人，还是老人帮忙？"),
          // 听到档案信息：先记下（不出卡、不打断），接着问
          call("propose_personal_file", { person: "妈妈", relation: "母亲", fields: [{ field: "生日", value: "3月2日" }, { field: "电话", value: "13812345678" }] }),
          call("propose_personal_file", { person: "女儿", relation: "女儿", fields: [{ field: "单位或学校", value: "实验小学" }] }),
          say("明白。你妈妈住得离你们近吗？"),
          // 用户说"这个别记"：忘掉这一句，接着聊
          call("forget_interview_answers", { count: 1, reason: "用户说这个别记" }),
          say("好，这段不记。今天我记下了这些：你和爱人、女儿住，女儿六岁、在实验小学，平时主要是你爱人接送；你妈妈生日是 3 月 2 日。这些是我的理解，对不对？要改哪里？"),
          // 用户说对：收尾（记下的档案信息合成一张核对卡）
          call("finish_interview", { covered: true }),
          say("听到的档案信息放了一张核对卡，你看一眼再确认。这次就聊到这里，谢谢你。"),
        ],
      });
      const frontend = await TestFrontend.connect(td.url);
      await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
      expect(inboxCards(td, "interview")).toEqual([]);

      // 周六 10:00：待办里多一张不卡事的约访卡，这次聊家里的人
      clock.advanceTo(at(10, 10, 10, 0));
      await td.daemon.internalJobs.whenIdle();
      const [invite] = inboxCards(td, "interview");
      expect(invite).toMatchObject({ status: "pending", urgency: "non_blocking", payload: { kind: "weekly", topic: "family" } });
      expect(invite!.text).toContain("家里的人");

      // 点"开始"：卡片处理完（记着是哪次访谈），管理员的会话里多一条开场的系统消息，它问第一个问题
      const turnEnds = () => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length;
      expect((await frontend.cardAction({ cardId: invite!.id, action: "start", expectedVersion: invite!.version })).ok).toBe(true);
      await waitUntil(() => turnEnds() >= 1, { timeoutMs: 20_000, describe: () => "等管理员开场" });
      const started = td.daemon.cards.get(invite!.id)!;
      expect(started).toMatchObject({ status: "handled", payload: { result: "started" } });
      const live = await status(td);
      expect(live.active).toMatchObject({ topic: "family" });
      expect((started.payload as { interviewId?: string }).interviewId).toBe(live.active!.id);
      // 开场那一行只写这次聊什么（从哪开的、访谈编号不给用户看）
      expect(texts(td, CURATOR).filter((text) => text.startsWith("【了解你访谈】"))).toEqual(["【了解你访谈】这次聊：家里的人和基本情况"]);
      expect(texts(td, CURATOR).at(-1)).toContain("现在家里都有谁");

      // 一问一答几轮
      await answer(frontend, "我和爱人、女儿住，女儿今年六岁。");
      await answer(frontend, "主要是我爱人接送，我下班晚。对了，我妈生日是3月2日，电话13812345678；女儿在实验小学。");
      // 记下了档案信息，但聊的时候不出卡
      expect(inboxCards(td, "interview_files")).toEqual([]);
      expect(inboxCards(td, "personal_file")).toEqual([]);
      await answer(frontend, "我跟我爸关系一般，这个别记。");
      await answer(frontend, "对，就是这些。");

      // 素材：访谈里说的话标着"来自访谈"；说"这个别记"的那一句忘掉了，不在素材里
      // （管理员按"这个别记"下的那条忘掉的命令另算一条记忆命令的素材，不是用户在访谈里的话）
      const said = td.daemon.materials.list().filter((m) => m.conversation === CURATOR && m.kind === "user_utterance");
      const textOf = (m: (typeof said)[number]) => m.segments.map((s) => s.text ?? "").join("");
      const kept = said.map(textOf);
      expect(kept).toEqual(expect.arrayContaining(["我和爱人、女儿住，女儿今年六岁。", "主要是我爱人接送，我下班晚。对了，我妈生日是3月2日，电话13812345678；女儿在实验小学。", "对，就是这些。"]));
      expect(kept.some((text) => text.includes("关系一般"))).toBe(false);
      for (const m of said) {
        expect(m.source).toBe("self");
        expect(m.context).toContain("interview");
        // 本人的原文只有用户说的话；管理员问的那句排在前面，是 agent 的产出、只记说明（标明是管理员问的）
        expect(m.segments.filter((seg) => seg.source === "self").map((seg) => seg.text)).toEqual([textOf(m)]);
        expect(m.segments[0]).toMatchObject({ form: "agent_output", source: "agent", locator: { field: "interviewQuestion" } });
        expect(m.segments[0]!.text).toBeUndefined();
        expect(m.segments[0]!.label).toMatch(/^记忆管理员问：/);
      }
      const asked = (text: string) => said.find((m) => textOf(m) === text)!.segments[0]!.label;
      expect(asked("我和爱人、女儿住，女儿今年六岁。")).toMatch(/先问一个：现在家里都有谁？$/);
      expect(asked("主要是我爱人接送，我下班晚。对了，我妈生日是3月2日，电话13812345678；女儿在实验小学。")).toBe("记忆管理员问：我注意到你提到女儿。平时接送她主要是你、你爱人，还是老人帮忙？");
      // "对，就是这些。"单看没意思：连着问的那句（今天我记下了这些……对不对？）当晚整理时一起读
      const short = said.find((m) => textOf(m) === "对，就是这些。")!;
      expect(asked("对，就是这些。")).toMatch(/对不对？要改哪里？$/);
      expect(evidenceDraftOf(short)!.text).toMatch(/^记忆管理员问：.*对不对？要改哪里？\n对，就是这些。$/s);
      // 管理员自己的话（开场、总结）不是素材
      expect(kept.some((text) => text.includes("今天我记下了这些"))).toBe(false);

      // 档案核对卡：收尾时这次记下的合成一张（不是一项一张），出在管理员的会话里、进待办；用户确认之前什么都没写
      expect(inboxCards(td, "personal_file")).toEqual([]);
      const [check] = inboxCards(td, "interview_files");
      expect(check).toMatchObject({ status: "pending", urgency: "non_blocking" });
      const payload = check!.payload as InterviewFilesCardPayload;
      expect(payload).toMatchObject({ conversation: CURATOR, interviewId: live.active!.id, topic: "family" });
      expect(payload.items.map((i) => [i.person.name, i.person.isNew, i.person.relation, i.field?.label, i.field?.value, i.field?.number, i.state])).toEqual([
        ["妈妈", true, "母亲", "生日", "3月2日", false, "pending"],
        ["妈妈", true, "母亲", "电话", "13812345678", true, "pending"],
        ["女儿", true, "女儿", "单位或学校", "实验小学", false, "pending"],
      ]);
      // 生日那条带每年提醒的勾（283 号票：默认勾着、提前 3 天），电话、学校没有
      expect(payload.items.map((i) => i.remind?.daysBefore)).toEqual([3, undefined, undefined]);
      const cardRefs = messagesOf(td, CURATOR).flatMap((p) => p.message.parts.flatMap((part) => (part.type === "card_ref" ? [part.cardId] : [])));
      expect(cardRefs).toContain(check!.id);
      expect(td.daemon.personalFiles.list().files.some((f) => f.name === "妈妈")).toBe(false);
      // 逐条确认：第一条新建妈妈的档案；卡还没处理完
      const act = async (action: "confirm" | "reject", item: string) => {
        const card = td.daemon.cards.get(check!.id)!;
        expect((await frontend.cardAction({ cardId: card.id, action, input: { item }, expectedVersion: card.version })).ok).toBe(true);
      };
      await act("confirm", payload.items[0]!.id);
      expect(td.daemon.cards.get(check!.id)).toMatchObject({ status: "pending" });
      // 第二条写进同一份（不再建一个"妈妈"）
      await act("confirm", payload.items[1]!.id);
      // 第三条不记：卡上都定了，处理完
      await act("reject", payload.items[2]!.id);
      const settled = td.daemon.cards.get(check!.id)!;
      expect(settled.status).toBe("handled");
      expect((settled.payload as InterviewFilesCardPayload).items.map((i) => i.state)).toEqual(["written", "written", "skipped"]);
      const moms = td.daemon.personalFiles.list().files.filter((f) => f.name === "妈妈");
      expect(moms).toHaveLength(1);
      expect(td.daemon.personalFiles.list().files.some((f) => f.name === "女儿")).toBe(false);
      // 留痕写明是记忆管理员提议、用户确认的
      const momFile = td.daemon.personalFiles.file(moms[0]!.id)!;
      expect(momFile.fields.find((f) => f.field === "birthday")!.current).toMatchObject({ value: "3月2日", source: { via: "curator", basis: "confirmed" } });
      // 确认时没改勾：照默认建了每年提醒
      expect(momFile.fields.find((f) => f.field === "birthday")!.annual).toMatchObject({ daysBefore: 3 });
      expect(momFile.fields.find((f) => f.field === "phone")!.current).toMatchObject({ value: "13812345678", source: { via: "curator", basis: "confirmed" } });

      // 访谈结束：家里的人记成聊过，下一个是工作和一天怎么过；会话里有一句结束的说明
      const after = await status(td);
      expect(after.active).toBeUndefined();
      expect(after).toMatchObject({ covered: ["family"], next: "work_day", invites: true });
      expect(interviewRecords(td).map((r) => r.change)).toEqual(["invited", "started", "ended"]);
      expect(interviewRecords(td)[1]).toMatchObject({ by: "card", cardId: invite!.id, topic: "family" });
      expect(interviewRecords(td)[2]).toMatchObject({ covered: true, answers: 3, filesCardId: check!.id });
      expect(texts(td, CURATOR).some((text) => text.startsWith("这次访谈结束了") && text.includes("3 段"))).toBe(true);
      // 结束以后再说的话不算访谈
      await frontend.sendText("谢谢", { conversation: CURATOR });
      await waitUntil(() => td.daemon.materials.list().some((m) => m.conversation === CURATOR && m.segments.some((s) => s.text === "谢谢")), { timeoutMs: 10_000 });
      expect(td.daemon.materials.list().find((m) => m.segments.some((s) => s.text === "谢谢"))!.context).not.toContain("interview");

      // 彻底删除妈妈的生日（连出处那句话）：档案里没了，事件库里一条都不留——核对卡的每个版本、操作记录、记下它的那次调用
      // （按核对卡上这一条记着的调用编号找："3月2日"太短，不按正文找别的工具的调用）、用户的原话
      expect(eventsContaining(td, "3月2日").length).toBeGreaterThan(0);
      const removed = await requestJson<PersonalFileDeleteResult>(td.url, HTTP_PATHS.personalFileDelete(moms[0]!.id), {
        method: "POST",
        body: { target: { kind: "field", field: "birthday" }, mode: "purge", withSources: true },
      });
      expect(removed.status).toBe(200);
      expect(eventsContaining(td, "3月2日")).toEqual([]);
    },
  );

  it("「下次再说」一周后再约；「不想做了」以后不再约（设置 · 记忆里的约访跟着关）", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 10, 9, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, config: NO_NIGHTLY });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    clock.advanceTo(at(10, 10, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    const [first] = inboxCards(td, "interview");
    expect((await frontend.cardAction({ cardId: first!.id, action: "later", expectedVersion: first!.version })).ok).toBe(true);
    expect(td.daemon.cards.get(first!.id)).toMatchObject({ status: "handled", payload: { result: "later" } });
    // 没开始访谈：管理员的会话里什么都没有
    expect(texts(td, CURATOR)).toEqual([]);

    // 下一个周六：再约一次，还是家里的人（上次没聊）
    clock.advanceTo(at(10, 17, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    const second = inboxCards(td, "interview").find((card) => card.id !== first!.id)!;
    expect(second).toMatchObject({ status: "pending", payload: { kind: "weekly", topic: "family" } });

    // 不想做了：卡片处理完，约访关掉
    expect((await frontend.cardAction({ cardId: second.id, action: "decline", expectedVersion: second.version })).ok).toBe(true);
    expect(td.daemon.cards.get(second.id)).toMatchObject({ status: "handled", payload: { result: "declined" } });
    const settings = await requestJson<{ interviewInvites: boolean }>(td.url, HTTP_PATHS.memorySettings);
    expect(settings.body.interviewInvites).toBe(false);
    expect((await status(td)).invites).toBe(false);

    // 再过两个周六：不再约
    clock.advanceTo(at(10, 24, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    clock.advanceTo(at(10, 31, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(inboxCards(td, "interview")).toHaveLength(2);

    // 设置里重新打开：下一个周六照常约
    expect((await requestJson(td.url, HTTP_PATHS.memorySettings, { method: "PUT", body: { interviewInvites: true } })).status).toBe(200);
    clock.advanceTo(at(11, 7, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(inboxCards(td, "interview")).toHaveLength(3);
  });

  it("用户主动开：记忆管理员对话里的「开始访谈」、跟秘书说「我想做个访谈」都进同一个访谈；开着的时候不再约", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 10, 9, 0));
    const td = await startTestDaemon({
      clock,
      memoryPlugin: true,
      config: NO_NIGHTLY,
      curator: [say("好，今天聊聊家里的人。先问一个：现在家里都有谁？")],
      secretary: [call("propose_quick_action", { type: "start_interview", params: {} }), say("记忆管理员已经在等你了，去「记忆 · 管理员」那里接着聊。")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });

    // 记忆管理员对话里点"开始访谈"
    const opened = await requestJson<InterviewStartResult>(td.url, HTTP_PATHS.memoryInterview, { method: "POST", body: {} });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ topic: "family", already: false });
    await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000 });
    expect(texts(td, CURATOR).at(-1)).toContain("现在家里都有谁");

    // 再点一次：还是同一个，不重开
    const again = await requestJson<InterviewStartResult>(td.url, HTTP_PATHS.memoryInterview, { method: "POST", body: {} });
    expect(again.body).toMatchObject({ interviewId: opened.body.interviewId, already: true });

    // 跟秘书说：快速动作 start_interview（用户点明了"访谈"，直接执行）——进的还是同一个
    await frontend.sendText("我想做个访谈");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const executed = td.daemon.store
      .read(SECRETARY, 0, EVENT_TYPES.quickActionExecuted)
      .map((event) => event.payload as { action: { type: string }; result: { ok: boolean; summary: string } })
      .find((record) => record.action.type === "start_interview")!;
    expect(executed.result.ok).toBe(true);
    expect(interviewRecords(td).filter((r) => r.change === "started")).toHaveLength(1);
    expect((await status(td)).active?.id).toBe(opened.body.interviewId);

    // 访谈开着：周六 10:00 不再约
    clock.advanceTo(at(10, 10, 10, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(inboxCards(td, "interview")).toEqual([]);
  });

  it("秘书那里先开：快速动作开一次访谈，管理员在自己的会话里开场；聊天里的回执卡写着去哪接着聊", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({
      config: NO_NIGHTLY,
      curator: [say("好，今天聊聊工作和一天怎么过。先问一个：你平时几点开始上班？")],
      secretary: [call("propose_quick_action", { type: "start_interview", params: { topic: "work_day" } }), say("记忆管理员已经在等你了。")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
    await frontend.sendText("我想做个访谈，聊聊工作");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000 });
    expect(interviewRecords(td)[0]).toMatchObject({ change: "started", topic: "work_day", by: "secretary" });
    expect(texts(td, CURATOR).at(-1)).toContain("几点开始上班");
    const record = td.daemon.store
      .read(SECRETARY, 0, EVENT_TYPES.quickActionExecuted)
      .map((event) => event.payload as { cardId: string; action: { type: string } })
      .find((r) => r.action.type === "start_interview")!;
    expect(td.daemon.cards.get(record.cardId)).toMatchObject({ type: "quick_action", status: "handled" });
  });

  it("问法跟在管理员的输入后面（会话里看不到）：开场那一轮带主题从哪问起和问法，之后每次回答带第几个来回；开场的系统消息只有一行", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ config: NO_NIGHTLY, curator: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
    await requestJson(td.url, HTTP_PATHS.memoryInterview, { method: "POST", body: { topic: "choices" } });
    await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000 });
    // 会话里那条开场的系统消息只有一行（给人看的）：这次聊什么；从哪开的、访谈编号不写
    const opening = texts(td, CURATOR).find((text) => text.startsWith("【了解你访谈】"))!;
    expect(opening).toBe("【了解你访谈】这次聊：人生里几次重要的选择");
    // 交给管理员的那一轮：从哪开的、访谈编号、问法要点跟在后面；它有访谈的四个工具
    const first = texts(td, CURATOR).at(-1)!;
    expect(first).toMatch(/用户在和你的对话里点了「开始访谈」，访谈编号 iv-[0-9a-f]{8}/);
    expect(first).toContain("当时主要图什么");
    expect(first).toContain("一次只问一个");
    for (const tool of ["begin_interview", "finish_interview", "forget_interview_answers", "propose_personal_file"]) expect(first).toContain(`[tool] ${tool}`);
    await answer(frontend, "换工作那次吧。");
    // 用户的话后面跟着那一句上下文（第几个来回、要点）
    const second = texts(td, CURATOR).at(-1)!;
    expect(second.indexOf("换工作那次吧。")).toBeGreaterThan(-1);
    expect(second.indexOf("这是用户第 1 次回答")).toBeGreaterThan(second.indexOf("换工作那次吧。"));
  });

  it("330 号票（R15）：访谈是用户同意开的，问题箱里攒着的可以一并问几个——开场那一轮带上还开着的几个（最多 3 个，一次还是只问一个）", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 10, 9, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, curator: [{ kind: "echo_context" }] });
    // 问题箱里放四个开着的问题（两条分不出胜负的结论）
    const opened = openReasoningDb({ file: td.daemon.layout.rgDb, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
    const asks = ["周末有人约你，你更想自己定时间吗？", "那次推掉聚会，是因为太累吗？", "你更看重自己安排，还是不想去那类场合？", "工作日晚上的活动，你也不太想去吗？"];
    try {
      const { engine } = opened;
      for (const [id, statement, other] of [
        ["cl-0001", "周末想自己安排时间", "cl-0002"],
        ["cl-0002", "不喜欢那类聚会", "cl-0001"],
      ] as const)
        engine.store.insertClaim({ id, tier: "need", statement, kind: "hypothesis", epistemic: "inferred", method: "abduction", status: "contested", confidence: "low", context: [], validFrom: null, validTo: null, inferredAt: clockIso(clock), reviewedAt: null, retractedBy: null, supersededBy: null, competesWith: [other], predicts: [] });
      asks.forEach((text, i) =>
        engine.questions.offer(
          {
            key: `ask-${i}`,
            topic: `topic-${i}`,
            kind: "unresolved",
            sources: ["unresolved"],
            text,
            why: "两条还分不清",
            targets: [{ id: "cl-0001", kind: "claim", statement: "周末想自己安排时间" }],
            answers: { yes: { supports: ["cl-0001"], refutes: ["cl-0002"], maxWeight: "decisive", note: "是" }, no: { supports: ["cl-0002"], refutes: ["cl-0001"], maxWeight: "decisive", note: "不是" } },
            domains: ["schedule"],
            scenes: [],
            terms: [],
            probeId: null,
            validUntil: null,
            separation: 1 - i * 0.1,
            closeness: 1,
            frequency: 1,
          },
          clockIso(clock),
        ),
      );
    } finally {
      opened.engine.close();
    }
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
    await requestJson(td.url, HTTP_PATHS.memoryInterview, { method: "POST", body: { topic: "cares" } });
    await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000 });
    const first = texts(td, CURATOR).at(-1)!;
    expect(first).toContain("问题箱里攒着几个想弄清的");
    expect(first).toContain("这次可以一并问几个");
    expect(first).toContain("一次一个");
    // 按优先级最多 3 个
    for (const text of asks.slice(0, 3)) expect(first).toContain(text);
    expect(first).not.toContain(asks[3]!);
  });

  it("语音插件开着：访谈里按住说话，管理员的回话合成语音；语音转写的素材也标着来自访谈", { timeout: 90_000 }, async () => {
    const tts = await startFakeSpeechService();
    const td = await startTestDaemon({
      config: NO_NIGHTLY,
      speechUrl: tts.url,
      curator: [say("好，今天聊聊家里的人。现在家里都有谁？"), say("明白了。平时主要是谁接送女儿？")],
    });
    await importReferenceVoice(td.url);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
    await requestJson(td.url, HTTP_PATHS.memoryInterview, { method: "POST", body: {} });
    await waitUntil(() => frontend.events({ channel: CURATOR, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000 });

    const sent = await sendVoice(frontend, td.url, { text: "我和爱人还有女儿一起住" }, { conversation: CURATOR });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done).toMatchObject({ conversation: CURATOR, inputMessageId: sent.messageId, mode: "whole", text: "明白了。平时主要是谁接送女儿？" });
    await waitUntil(() => td.daemon.materials.list().some((m) => m.conversation === CURATOR && m.context.includes("voice_transcript")), { timeoutMs: 10_000 });
    const spoken = td.daemon.materials.list().find((m) => m.conversation === CURATOR && m.context.includes("voice_transcript"))!;
    expect(spoken.context).toContain("interview");
    // 管理员问的那句排在转写前面（上下文）
    expect(spoken.segments.map((seg) => [seg.form, seg.source])).toEqual([
      ["agent_output", "agent"],
      ["voice", "self"],
    ]);
    expect(spoken.segments[0]!.label).toBe("记忆管理员问：好，今天聊聊家里的人。现在家里都有谁？");
  });
});
