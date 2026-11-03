// 主切面：秘书提议定时任务（schedule_task）。真的守护进程，秘书、负责人接 faux 剧本，调度器的时钟换成手动拨的（ManualClock），
// 测试扮演前端：
// - 秘书调用后看板上没有新任务，聊天里出现一张"定时任务"卡：时间表（规则文字、接下来三次）、任务书全文、按什么模型跑；
//   还没有同类运行时不写每次花多少；
// - 点确认：建出的和发起对话框里选"定时"建出来的一样（普通任务、运营中、登记触发），到点真的跑（假时钟）；秘书收到"建好了"；
//   之后再提议时，卡上按刚才那次运行的用量写每次大概花多少；
// - 点取消：什么都不建，秘书收到"用户取消了"，卡算关掉（回避信号）；
// - 一轮最多出一张；参数错了（钟点、start 早于第一次、没启用的运行时）把原因交回秘书、不出卡，改了能再出；
//   每 N 天的起算日在提议那一刻定下（没写是今天，写了 start 就是 start）。
import {
  type Card,
  type CardDismissedEventPayload,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type ResponseFrame,
  type ScheduledJobEventPayload,
  type ScheduleTaskCardPayload,
  type TaskEventPayload,
  tokenTotal,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, secretary: SECRETARY } = CHANNELS;
const TM1 = maintainerChannel("tm-1");

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const MAIL = { title: "每天收邮件", instructions: "收一遍工作邮箱的新邮件，挑出要我回的，每封一句话说要回什么", when: { kind: "daily" }, time: "08:10" };
const propose = (args: Record<string, unknown> = MAIL) => call("schedule_task", args);

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const scheduleCards = (frontend: TestFrontend) => cardsOf(frontend).filter((c) => c.type === "schedule_task");
/** 交给 agent 的通知（运行时发的、排进它的输入队列的系统消息） */
const noticesIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true).map(textOf);
/** 秘书最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend) => {
  const last = messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent").at(-1);
  return last === undefined ? "" : textOf(last);
};
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length).split("\n[")[0]!;
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

async function setup(options: StartTestDaemonOptions) {
  const clock = new ManualClock(START);
  const td = await startTestDaemon({ clock, ...options });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [SECRETARY]: 0, [TM1]: 0 });
  return { td, clock, frontend };
}

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  const ended = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
  await frontend.sendText(text);
  await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length > ended, { timeoutMs: 60_000, describe: () => `等秘书处理完「${text}」` });
}

describe("秘书提议定时任务：只出卡", () => {
  it("调用后看板上没有新任务，聊天里出现定时任务卡（时间表、接下来三次、任务书、模型）；点确认建出运营中的定时任务（和发起对话框里建的一样），到点真的跑，秘书收到通知；之后再提议时卡上写每次大概花多少", async () => {
    const { td, clock, frontend } = await setup({
      secretary: [
        propose(),
        ECHO,
        // 点确认之后的通知
        ECHO,
        // （运行做完的通知要拨钟才交：这里不再拨，下一轮是用户的话）
        propose({ title: "整理下载目录", instructions: "把下载目录里的安装包、截图、文档分到三个文件夹", when: { kind: "weekly", weekdays: [1] }, time: "09:00" }),
        ECHO,
        say("好"),
        say("好"),
      ],
      maintainer: [say("收好了：3 封要回")],
    });
    await tell(frontend, "以后每天早上 8:10 帮我收一下邮件，挑出要回的");

    // 看板上没有新任务；聊天里出现一张定时任务卡
    expect(tasksOf(frontend)).toEqual([]);
    expect(td.daemon.tasks.list()).toEqual([]);
    const card = await eventually(() => scheduleCards(frontend), () => true, "定时任务卡");
    const payload = card.payload as ScheduleTaskCardPayload;
    expect(card).toMatchObject({ status: "pending", typeVersion: 1, text: "定时任务：每天收邮件（每天 08:10，第一次 10 月 8 日（周四）08:10）" });
    expect(payload).toMatchObject({ title: "每天收邮件", instructions: MAIL.instructions, schedule: { kind: "daily", time: "08:10" } });
    expect(payload.upcoming.map((x) => new Date(x).getTime())).toEqual([at(10, 8, 8, 10), at(10, 9, 8, 10), at(10, 10, 8, 10)].map((d) => d.getTime()));
    // pi 跑：写任务负责人那一行现在的模型；还没有同类运行，估不出每次花多少
    expect(payload.model).toEqual(expect.any(String));
    expect(payload.runtime).toBeUndefined();
    expect(payload.estimate).toBeUndefined();
    // 卡放进了秘书的聊天（这一轮的回复里引着它）
    const refs = messagesOf(frontend, SECRETARY).flatMap((m) => m.message.parts.flatMap((p) => (p.type === "card_ref" ? [p.cardId] : [])));
    expect(refs).toContain(card.id);
    const seen = lastEcho(frontend);
    expect(seen).toContain("[tool] schedule_task");
    expect(toolResultOf(seen, "schedule_task")).toBe(
      "已在聊天里放了一张“定时任务”卡（任务还没建）：「每天收邮件」，每天 08:10，第一次是 10 月 8 日（周四）08:10。用户点卡上的“确认”才会建成定时任务（任务看板的“运营中”），点“取消”什么都不建；结果会通知你。不要说已经建好了。",
    );

    // 点确认：建出的是定时触发的普通任务，运营中，登记了触发（和发起对话框里选"定时"建出来的一样）
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created).toMatchObject({
      by: "user",
      task: { id: "t-1", title: "每天收邮件", summary: MAIL.instructions, kind: "plain", state: "operating", origin: "suggestion", trigger: { kind: "schedule", schedule: { kind: "daily", time: "08:10" } }, maintainerId: "tm-1", projects: [], projectScope: "none" },
    });
    expect(created.task.internal).toBeUndefined();
    const registered = await eventually(() => jobsOf(frontend), (e) => e.change === "registered", "登记的触发");
    expect(registered.job).toMatchObject({ id: "j-1", ownerTaskId: "t-1", state: "active", schedule: { kind: "daily", time: "08:10" }, nextAt: expect.stringMatching(/^2026-10-08T08:10:00/) });
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toMatch(/## 运营中（1）\n- 任务 t-1「每天收邮件」：运营中；定时触发：每天 08:10；下一次 /);
    const handled = await eventually(() => scheduleCards(frontend), (c) => c.id === card.id && c.status === "handled", "卡片已处理");
    expect(handled).toMatchObject({ outcome: { action: "confirm" }, payload: { taskId: "t-1" }, text: "定时任务：每天收邮件（每天 08:10），已建成 t-1" });
    // 秘书收到"建好了"（下一轮的上下文里）
    await waitUntil(() => lastEcho(frontend).includes("用户在“定时任务”卡上点了确认"), { timeoutMs: 60_000, describe: () => "等秘书收到确认的通知" });
    expect(lastEcho(frontend)).toContain("已建好定时触发的普通任务 t-1「每天收邮件」，在任务看板的“运营中”，时间表：每天 08:10，下一次是 10 月 8 日（周四）08:10。");
    // 同一张卡不能再点：不会建出第二个
    expect((await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version })).ok).toBe(false);
    expect(td.daemon.tasks.list()).toHaveLength(1);

    // 到点真的跑：交给任务自己的 agent，任务书就是卡上那一份
    clock.advanceTo(at(10, 8, 8, 10));
    await eventually(() => jobsOf(frontend), (e) => e.change === "run_finished" && e.run?.runId === "j-1-r1", "第一次运行结束");
    expect(noticesIn(frontend, TM1)[0]).toContain(`要做的事——\n${MAIL.instructions}`);
    expect(td.daemon.scheduledJobs.get("j-1")).toMatchObject({ runCount: 1, lastRun: { state: "done" }, nextAt: expect.stringMatching(/^2026-10-09T08:10:00/) });
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
    await settled(td, "tm-1");

    // 再提议一个：卡上按刚才那次同类运行的用量写每次大概花多少（faux 模型没有单价，不写钱数）
    const run = td.daemon.scheduledJobs.get("j-1")!.lastRun!;
    const used = td.daemon.ledger
      .entries({ kind: "task", id: "t-1" })
      .filter((e) => Date.parse(e.time) >= Date.parse(run.startedAt!) && Date.parse(e.time) <= Date.parse(run.endedAt!))
      .reduce((n, e) => n + tokenTotal(e.tokens), 0);
    expect(used).toBeGreaterThan(0);
    await tell(frontend, "每周一早上 9 点帮我整理下载目录");
    const second = await eventually(() => scheduleCards(frontend), (c) => c.id !== card.id, "第二张定时任务卡");
    expect((second.payload as ScheduleTaskCardPayload).estimate).toEqual({ runs: 1, tokens: used });
    expect((second.payload as ScheduleTaskCardPayload).upcoming[0]).toMatch(/^2026-10-12T09:00:00/);
  }, 120_000);

  it("点取消：什么都不建，秘书收到“用户取消了”，卡算关掉（回避信号）", async () => {
    const { td, frontend } = await setup({ secretary: [propose(), say("卡在上面"), ECHO, say("好")] });
    await tell(frontend, "以后每天早上 8:10 帮我收一下邮件");
    const card = await eventually(() => scheduleCards(frontend), () => true, "定时任务卡");

    ok(await frontend.cardAction({ cardId: card.id, action: "cancel", expectedVersion: card.version }));
    const closed = await eventually(() => scheduleCards(frontend), (c) => c.id === card.id && c.status !== "pending", "卡片关掉");
    expect(closed).toMatchObject({ status: "dismissed", outcome: { action: "cancel" } });
    expect((closed.payload as ScheduleTaskCardPayload).taskId).toBeUndefined();
    const dismissed = frontend.events({ channel: CARDS, type: EVENT_TYPES.cardDismissed }).map((f) => f.payload as CardDismissedEventPayload);
    expect(dismissed).toEqual([expect.objectContaining({ cardId: card.id, cardType: "schedule_task", action: "cancel" })]);
    await waitUntil(() => lastEcho(frontend).includes("用户在“定时任务”卡上点了取消"), { timeoutMs: 60_000, describe: () => "等秘书收到取消的通知" });
    expect(lastEcho(frontend)).toContain("用户在“定时任务”卡上点了取消：「每天收邮件」没有建，什么都没变。");
    // 什么都没建
    expect(tasksOf(frontend)).toEqual([]);
    expect(td.daemon.tasks.list()).toEqual([]);
    expect(jobsOf(frontend)).toEqual([]);
  }, 60_000);
});

describe("秘书提议定时任务：参数和一轮一张", () => {
  it("一轮最多一张；钟点不对、start 早于第一次、没启用的运行时把原因交回秘书、不出卡，改了能再出；每 N 天的起算日在提议那一刻定下", async () => {
    const { frontend } = await setup({
      secretary: [
        // 第一轮：钟点写错（不算这一轮的那张）→ 改对了出卡 → 再出一张被拒
        propose({ ...MAIL, time: "8点10分" }),
        propose(),
        propose({ ...MAIL, title: "又一张" }),
        ECHO,
        // 第二轮：每天的从下周一开始（第一次早于它）被拒；没启用的运行时被拒；每 3 天从下周一起（起算日就是 start）出卡
        propose({ ...MAIL, start: "2026-10-12" }),
        propose({ ...MAIL, runtime: "gemini" }),
        propose({ title: "浇花", instructions: "看一眼阳台的花要不要浇水", when: { kind: "everyNDays", interval: 3 }, time: "20:00", start: "2026-10-12" }),
        ECHO,
        // 第三轮：每 2 天没写起算日：从今天（提议那一刻）起
        propose({ title: "吃药", instructions: "提醒我吃降脂药并记一笔", when: { kind: "everyNDays", interval: 2 }, time: "20:00" }),
        ECHO,
      ],
    });
    await tell(frontend, "以后每天早上 8:10 帮我收一下邮件");
    const first = lastEcho(frontend);
    expect(first).toContain("[toolResult] schedule_task: time 要写成 HH:mm（24 小时制），比如 08:10；写的是 8点10分");
    expect(first).toContain("[toolResult] schedule_task: 已在聊天里放了一张“定时任务”卡（任务还没建）：「每天收邮件」");
    expect(toolResultOf(first, "schedule_task")).toBe("这一轮已经给过一张“定时任务”卡了，一轮最多一张。");
    expect(scheduleCards(frontend).map((c) => (c.payload as ScheduleTaskCardPayload).title)).toEqual(["每天收邮件"]);

    await tell(frontend, "从下周一开始；还有每三天晚上 8 点看一眼阳台的花");
    const second = lastEcho(frontend);
    expect(second).toContain("[toolResult] schedule_task: 按这个时间表从现在起第一次是 10 月 8 日（周四）08:10，早于 start（2026-10-12）；现在的时间表只有每 N 天能定从哪天起");
    expect(second).toMatch(/\[toolResult\] schedule_task: .*gemini/);
    const water = await eventually(() => scheduleCards(frontend), (c) => (c.payload as ScheduleTaskCardPayload).title === "浇花", "浇花的卡");
    expect((water.payload as ScheduleTaskCardPayload).schedule).toEqual({ kind: "everyNDays", time: "20:00", interval: 3, anchor: "2026-10-12" });
    expect((water.payload as ScheduleTaskCardPayload).upcoming[0]).toMatch(/^2026-10-12T20:00:00/);
    expect(water.text).toBe("定时任务：浇花（每 3 天 20:00，从 10 月 12 日起，第一次 10 月 12 日（周一）20:00）");

    await tell(frontend, "每两天晚上 8 点提醒我吃降脂药并记一笔");
    const pills = await eventually(() => scheduleCards(frontend), (c) => (c.payload as ScheduleTaskCardPayload).title === "吃药", "吃药的卡");
    expect((pills.payload as ScheduleTaskCardPayload).schedule).toEqual({ kind: "everyNDays", time: "20:00", interval: 2, anchor: "2026-10-08" });
    expect((pills.payload as ScheduleTaskCardPayload).upcoming.map((x) => x.slice(0, 16))).toEqual(["2026-10-08T20:00", "2026-10-10T20:00", "2026-10-12T20:00"]);
  }, 90_000);
});
