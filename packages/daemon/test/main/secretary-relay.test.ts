// 主切面：秘书转达（103 号票）。用户在和秘书说话时要它给已有的任务、项目的维护者捎一句话，秘书（faux）用"提议快速动作"提出
// tell_task / tell_project：
// - 用户点明了（这句话里原样写着转给谁、转什么）：运行时直接插进对方的会话，走用户在任务详情 / 维护者会话里直接说话的那条路——
//   普通任务在干活时是插话、做完了的重新进行中接着做；长程任务闲着时唤起；定时触发的任务、项目的维护者照用户在那里说话的做法；
//   对方收到的输入开头写明是秘书转达的，会话里的那条消息标着 relayedBy；秘书的聊天里留"已执行"卡；
// - 没点明：出卡（写明发给谁、发什么）、进待我处理，用户确认了才发；
// - 已归档、已取消、不存在的目标，项目内部的任务、已归档的项目：提出时就拒，原因交回秘书，不出卡、不发；
// - 转达的那一句不进"本人"素材（用户的原话在秘书会话里采过）。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type QuickActionCardPayload,
  type ResponseFrame,
  type TaskEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { SECRETARY_RELAY_HEAD } from "../../src/conversation/messages.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { onePlan } from "../helpers/running-task.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const TM2 = maintainerChannel("tm-2");
const PM1 = maintainerChannel("pm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const tellTask = (task: string, message: string) => call("propose_quick_action", { type: "tell_task", params: { task, message } });
const tellProject = (project: string, message: string) => call("propose_quick_action", { type: "tell_project", params: { project, message } });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const changesOf = (frontend: TestFrontend, taskId: string) => tasksOf(frontend).filter((e) => e.task.id === taskId).map((e) => e.change);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
/** 快速动作卡（同一张卡取最新的版本） */
const quickCards = (frontend: TestFrontend) => [...new Map(cardsOf(frontend).filter((c) => c.type === "quick_action").map((c) => [c.id, c])).values()];
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
/** 会话里秘书转达的那几条 */
const relayedIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.message.relayedBy !== undefined);
/** agent 最后一次模型调用看到的上下文（剧本里 echo_context 的回显），去掉时间标记 */
const lastEcho = (frontend: TestFrontend, channel: string) => stripTimeMarkers(textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!));
/** 秘书看到的最后一个工具结果 */
const lastToolResult = (frontend: TestFrontend) =>
  messagesOf(frontend, SECRETARY)
    .flatMap((m) => m.message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call")
    .at(-1);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
/** 某个会话处理完了 n 条输入（作为一轮，或者作为插话收下） */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
const turnEnds = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string; outcome: string });

async function setup(options: StartTestDaemonOptions, channels: string[]) {
  const td = await startTestDaemon(options);
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return { ...td, frontend };
}

/** 用户在秘书主线里说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  const sent = await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend, SECRETARY).some((e) => e.inputMessageId === sent.messageId), { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
  return sent;
}

const MP3 = "以后都下成 320k 的";
const FLAC = "再转成 flac";

describe("用户点明了：普通任务", () => {
  it("在干活时作为插话在下一步之前送到；做完了的重新进行中接着做；对方收到的开头写明秘书转达，消息标着 relayedBy；秘书聊天里留“已执行”卡；转达的话不进本人素材", async () => {
    const { frontend, daemon } = await setup(
      {
        // 第 1 句：转给干着活的 t-1；中间一轮是 t-1 做完的通知；第 2 句：转给做完了的 t-1
        secretary: [tellTask("t-1", MP3), say("已经转给「把《晴天》下成 mp3」了"), say("t-1 做完了，要我念给你听吗？"), tellTask("t-1", FLAC), say("转过去了")],
        // t-1 的 agent：先跑一个慢命令（转达的话这时到），再回显上下文；做完后接着说时再回显一次
        maintainer: [call("bash", { command: "sleep 5" }), ECHO, ECHO],
      },
      [BOARD, SECRETARY, CARDS, INBOX, TM1],
    );
    ok(await frontend.startTask("把《晴天》下成 mp3", "k-plain", [], "plain"));
    await eventually(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnStart }), () => true, "t-1 开始干活");
    await new Promise((r) => setTimeout(r, 1500));

    // 它在跑 sleep 时，用户在秘书那里点明了：转给 t-1
    await tell(frontend, `告诉 t-1，${MP3}`);
    const [first] = relayedIn(frontend, TM1);
    expect(first).toMatchObject({ taskId: "t-1", message: { speaker: "user", relayedBy: "secretary", parts: [{ type: "text", text: MP3 }] } });
    // 115 号票：会话里折成一行时的一句话总结是转达的话本身的第一句
    expect(first!.message.summary).toBe(MP3);
    const [card] = quickCards(frontend);
    expect(card).toMatchObject({
      status: "handled",
      outcome: { action: "execute" },
      payload: {
        action: { type: "tell_task", params: { taskId: "t-1", message: MP3 } },
        name: "转达给任务",
        title: "转达给任务 t-1「把《晴天》下成 mp3」",
        target: "任务 t-1「把《晴天》下成 mp3」",
        content: MP3,
        explicit: true,
        disposition: "do",
        result: "已经转给任务 t-1「把《晴天》下成 mp3」了",
      } satisfies Partial<QuickActionCardPayload>,
    });
    expect(lastToolResult(frontend)).toMatchObject({ tool: "propose_quick_action", outcome: "done" });
    expect(lastToolResult(frontend)!.resultSummary).toContain("已经转给任务 t-1「把《晴天》下成 mp3」了");
    // 卡不进待我处理
    expect(inboxOf(frontend)).toEqual([]);

    // 插话：在 sleep 的结果之后、下一次模型调用之前进了上下文，不另起一轮；它先于交代任务的那条输入结束
    await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "t-1 第一轮做完");
    await turnsOf(frontend, TM1, 2);
    const seen = lastEcho(frontend, TM1);
    const order = ["[toolResult] bash", SECRETARY_RELAY_HEAD, MP3].map((x) => seen.indexOf(x));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(seen).toContain(`${SECRETARY_RELAY_HEAD}\n${MP3}`);
    const ends = turnEnds(frontend, TM1);
    expect(ends.map((e) => e.inputMessageId).indexOf(first!.message.id)).toBe(0);
    expect(ends).toHaveLength(2);

    // 做完了：等 t-1 做完的通知交到秘书手里（那一轮回完），再转第 2 句——任务重新进行中，接着做
    await waitUntil(() => turnEnds(frontend, SECRETARY).length >= 2, { timeoutMs: 30_000, describe: () => "秘书收到任务做完的通知" });
    await tell(frontend, `跟 t-1 说：${FLAC}`);
    await waitUntil(() => changesOf(frontend, "t-1").filter((c) => c === "completed").length >= 2, { timeoutMs: 30_000, describe: () => `等 t-1 第二轮做完（现在：${changesOf(frontend, "t-1").join("、")}）` });
    expect(changesOf(frontend, "t-1")).toEqual(["created", "started", "completed", "continued", "completed"]);
    expect(tasksOf(frontend).find((e) => e.change === "continued")).toMatchObject({ by: "user", from: "done", task: { state: "running" } });
    expect(relayedIn(frontend, TM1).map((m) => [textOf(m), m.taskId])).toEqual([
      [MP3, "t-1"],
      [FLAC, "t-1"],
    ]);
    expect(lastEcho(frontend, TM1)).toContain(`${SECRETARY_RELAY_HEAD}\n${FLAC}`);
    expect(quickCards(frontend).at(-1)!.payload).toMatchObject({ explicit: true, result: "已经转给任务 t-1「把《晴天》下成 mp3」了：它已经做完了，收到后重新进行中、接着做" });

    // 素材：用户在秘书那里说的两句是本人发言；转达进 t-1 会话的两句不是（发起对话框里写的那段另有一条，不在哪个会话里）
    const spokenInSecretary = () => daemon.materials.list({ kind: "user_utterance" }).filter((m) => m.conversation === SECRETARY);
    await waitUntil(() => spokenInSecretary().length >= 2, { timeoutMs: 10_000, describe: () => "用户在秘书那里的发言素材" });
    await new Promise((r) => setTimeout(r, 300));
    expect(spokenInSecretary()).toHaveLength(2);
    expect(daemon.materials.list().filter((m) => m.conversation === TM1 && m.source === "self")).toEqual([]);
  }, 90_000);
});

describe("长程任务：没点明出卡，确认了才发；闲着时唤起", () => {
  it("“跟那个发票任务说一声……”没写编号和完整标题：出卡（写明发给谁、发什么）、进待我处理，确认之前不发；确认后插进维护者的会话、唤起闲置退出的维护者", async () => {
    const plan = onePlan();
    const { frontend, daemon } = await setup(
      {
        config: { agents: { idleMinutes: 0.02 } },
        secretary: [tellTask("t-1", "先做 2025 年的"), say("要转给它吗？")],
        maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : spawn === 2 ? [say("开始做了")] : [ECHO]),
      },
      [BOARD, SECRETARY, CARDS, INBOX, TM1],
    );
    const task = daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    daemon.tasks.writeBrief(task.id, { goal: "整理发票", acceptanceCriteria: ["整理完"], constraints: [], projects: [], memoryScope: "" });
    const planCard = await eventually(() => cardsOf(frontend), (c) => c.type === "plan", "计划卡");
    ok(await frontend.cardAction({ cardId: planCard.id, action: "confirm", expectedVersion: planCard.version, input: {} }));
    await eventually(() => tasksOf(frontend), (e) => e.change === "started", "开始执行");
    await waitUntil(() => turnEnds(frontend, TM1).length >= 2 && !daemon.agents.live().some((a) => a.agentId === "tm-1"), { timeoutMs: 15_000, describe: () => "维护者闲置退出" });

    await tell(frontend, "跟那个发票任务说一声，先做 2025 年的");
    const [card] = quickCards(frontend);
    expect(card).toMatchObject({
      status: "pending",
      payload: { action: { type: "tell_task" }, target: "任务 t-1「整理发票」", content: "先做 2025 年的", explicit: false, disposition: "ask_first" },
    });
    expect(lastToolResult(frontend)!.resultSummary).toContain("等用户确认");
    expect(await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card!.id, "待我处理里的卡")).toMatchObject({ title: "确认快速动作：转达给任务" });
    // 确认之前不发
    await new Promise((r) => setTimeout(r, 500));
    expect(relayedIn(frontend, TM1)).toEqual([]);

    ok(await frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: card!.version }));
    const relayed = await eventually(() => relayedIn(frontend, TM1), () => true, "转达的那一句");
    expect(relayed).toMatchObject({ taskId: "t-1", message: { speaker: "user", relayedBy: "secretary", parts: [{ type: "text", text: "先做 2025 年的" }] } });
    expect(quickCards(frontend)[0]).toMatchObject({ status: "handled", payload: { result: "已经转给任务 t-1「整理发票」了" } });
    // 闲着：唤起它，这句话作为一轮输入交给它，开头写明是秘书转达的
    await waitUntil(() => turnEnds(frontend, TM1).some((e) => e.inputMessageId === relayed.message.id), { timeoutMs: 20_000, describe: () => "维护者被唤起处理转达的话" });
    expect(lastEcho(frontend, TM1)).toContain(`${SECRETARY_RELAY_HEAD}\n先做 2025 年的`);
    // 秘书会话里有操作记录（凭什么执行的：用户在卡上确认后）
    const executed = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload as { action: { type: string }; basis: string; explicit: boolean });
    expect(executed).toMatchObject([{ action: { type: "tell_task" }, basis: "confirmed", explicit: false }]);
  }, 90_000);
});

describe("定时触发的任务、项目的维护者；收不了的目标", () => {
  it("运营中的定时任务、项目维护者的会话照用户在那里说话一样收到（项目的开一个对话段）；已取消、已归档、不存在的任务，项目内部的任务（和没有的同一个说法）、已归档的项目被拒，原因交回秘书，不出卡、不发", async () => {
    const DAILY_9 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };
    const { frontend, daemon } = await setup(
      {
        secretary: [
          tellTask("t-1", "以后把 GitHub 热门也加上"),
          say("转了"),
          tellProject("记账本", "下个月起信用卡账单也要导入"),
          say("转了"),
          tellTask("t-2", "还是做吧"),
          say("不行"),
          tellTask("t-3", "归档的也说一句"),
          say("不行"),
          tellTask("t-99", "没有这个任务"),
          say("不行"),
          tellTask("t-4", "内部的"),
          say("不行"),
          tellProject("旧相册", "归档的项目"),
          say("不行"),
        ],
        maintainer: [ECHO],
      },
      [BOARD, SECRETARY, CARDS, INBOX, PROJECTS, TM1, PM1, TM2],
    );
    // t-1：定时触发的普通任务，运营中（还没到点，没有运行）
    ok(await frontend.startTask("每天出 AI 新闻日报\n汇总昨天的 AI 新闻", "k-daily", [], "plain", DAILY_9));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.state === "operating", "t-1 运营中");
    await tell(frontend, "告诉 t-1，以后把 GitHub 热门也加上");
    const timed = await eventually(() => relayedIn(frontend, TM1), () => true, "转给 t-1 的那一句");
    expect(timed).toMatchObject({ taskId: "t-1", message: { relayedBy: "secretary", parts: [{ type: "text", text: "以后把 GitHub 热门也加上" }] } });
    await waitUntil(() => turnEnds(frontend, TM1).some((e) => e.inputMessageId === timed.message.id), { timeoutMs: 20_000, describe: () => "t-1 的 agent 处理转达的话" });
    expect(lastEcho(frontend, TM1)).toContain(`${SECRETARY_RELAY_HEAD}\n以后把 GitHub 热门也加上`);

    // 项目的维护者：开一个对话段，消息属于这个项目
    const ledger = seedProject(daemon, "记账本", { state: "in_use", charterConfirmed: true });
    await tell(frontend, "告诉记账本的维护者：下个月起信用卡账单也要导入");
    const toProject = await eventually(() => relayedIn(frontend, PM1), () => true, "转给记账本维护者的那一句");
    expect(toProject).toMatchObject({ projectId: ledger.id, message: { relayedBy: "secretary", parts: [{ type: "text", text: "下个月起信用卡账单也要导入" }] } });
    await waitUntil(() => turnEnds(frontend, PM1).some((e) => e.inputMessageId === toProject.message.id), { timeoutMs: 20_000, describe: () => "记账本的维护者处理转达的话" });
    expect(lastEcho(frontend, PM1)).toContain(`${SECRETARY_RELAY_HEAD}\n下个月起信用卡账单也要导入`);
    expect(quickCards(frontend).map((c) => [(c.payload as QuickActionCardPayload).action.type, c.status, (c.payload as QuickActionCardPayload).result])).toEqual([
      ["tell_task", "handled", "已经转给任务 t-1「每天出 AI 新闻日报」了"],
      ["tell_project", "handled", "已经转给项目「记账本」的维护者了"],
    ]);

    // 收不了的：t-2 已取消、t-3 已归档、t-99 没有、t-4 是记账本内部的任务（当没有）、旧相册已归档
    const cancelled = daemon.tasks.createByRequest({ title: "写周报", summary: "写周报" });
    ok(await frontend.taskAction({ taskId: cancelled.id, action: "cancel" }));
    const archived = daemon.tasks.createByRequest({ title: "旧手机数据迁移", summary: "旧手机数据迁移" });
    ok(await frontend.taskAction({ taskId: archived.id, action: "cancel" }));
    ok(await frontend.taskAction({ taskId: archived.id, action: "archive" }));
    const inner = internalTask(daemon, "记账本", "导出 10 月账单");
    seedProject(daemon, "旧相册", { state: "archived" });
    expect([cancelled.id, archived.id, inner.id]).toEqual(["t-2", "t-3", "t-4"]);
    const cardsBefore = quickCards(frontend).length;
    const reasons: string[] = [];
    for (const text of ["告诉 t-2，还是做吧", "告诉 t-3，归档的也说一句", "告诉 t-99，没有这个任务", "告诉 t-4，内部的", "告诉旧相册的维护者，归档的项目"]) {
      await tell(frontend, text);
      const result = lastToolResult(frontend)!;
      expect(result).toMatchObject({ tool: "propose_quick_action", outcome: "error" });
      reasons.push(result.resultSummary ?? "");
    }
    expect(reasons[0]).toContain("任务「写周报」已取消，不再收消息");
    expect(reasons[1]).toContain("任务「旧手机数据迁移」已归档，不再收消息");
    expect(reasons[2]).toBe("不能这样做：没有任务「t-99」：用 view_board 查看板，写任务编号；项目里的事请用 tell_project 转给项目的维护者");
    // 项目内部的任务和真没有的一个说法（64、66 号票）：不带项目名、不说它在不在，免得按编号试出项目内部有哪些任务
    expect(reasons[3]).toBe(reasons[2]!.replace("t-99", "t-4"));
    expect(reasons[3]).not.toContain("记账本");
    expect(reasons[4]).toContain("项目「旧相册」已归档：维护者会话只读");
    for (const reason of reasons) expect(reason).toMatch(/^不能这样做：/);
    expect(quickCards(frontend)).toHaveLength(cardsBefore);
    expect(relayedIn(frontend, TM2)).toEqual([]);
    expect(relayedIn(frontend, TM1)).toHaveLength(1);
    expect(relayedIn(frontend, PM1)).toHaveLength(1);
  }, 120_000);
});
