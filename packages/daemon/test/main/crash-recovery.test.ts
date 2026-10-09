// 主切面：被杀后的恢复（规格第 17 节，23 号票）。守护进程在独立进程里跑（helpers/killable-daemon.ts），测试当前端连它，
// 在任务、秘书正做到一半时直接杀掉它（Job 对象把 agent 子进程和孙进程一起清掉，像 LSM 重启时那样），再用同一个数据目录
// 起一个守护进程，看正在做的事按规则恢复：
// - 被杀时所有 agent 子进程和孙进程随之结束，重启后没有旧进程；
// - 正在执行、有副作用的调用：任务转为等我（"中断：不确定 X 是否已执行"），待我处理里一条卡着任务的事项；不自动重做。
//   秘书会话里的：待我处理里一条不卡任务的同样写法的事项，秘书会话照常可用；
// - 正在等审批的调用：重启后审批卡还是那一张、仍待处理，不新建卡、不再提示，任务在等我；它不算"说不清做没做完"。
//   用户事后批准，运行时唤起维护者"可以重试"，重试放行一次；
// - 正在执行、只读或幂等的调用：维护者被唤起接着做，会话文件里那次调用补着"被中断"，由模型决定要不要重做；任务不转等我；
// - 说到一半的回复：历史和会话文件里都没有碎片，会话从最后一个完整回合续上；排着的输入按原顺序处理，不丢也不重复。
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_NAME_MARK,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  INTERRUPTED_ACK,
  INTERRUPTED_ACTIONS,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  PURGED_TEXT,
  type ResponseFrame,
  type TaskEventPayload,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { agentSessionDir } from "../../src/agent-manager/agent-manager.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { GUARD_CHANNEL, GUARD_EVENTS, type ToolCallFinishedPayload, type ToolCallStartedPayload } from "../../src/guard-runtime/events.ts";
import { readPidFile } from "../../src/process/pid-file.ts";
import { RESTART_WAKE_TEXT } from "../../src/recovery/recovery.ts";
import { type FauxStep, INTERRUPTED_TOOL_RESULT } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";
import { type KillableDaemon, type KillableReport, restartAfterKill, startKillableDaemon, survivors } from "../helpers/killable-daemon.ts";
import { waitUntil } from "../helpers/process.ts";
import { maintainerScripts, SECRETARY_BRIEFS, startRunningTask } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const CHANNELS_SEEN = [SECRETARY, BOARD, CARDS, INBOX, M1];

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const echo: FauxStep = { kind: "echo_context" };
/** bash 里用正斜杠写 Windows 路径（Git Bash 认 C:/x/y） */
const fwd = (p: string) => p.replaceAll("\\", "/");

/** 维护者 tm-1：第一次唤起交计划，确认后（按计划重新装配）照 run 执行 */
const maintainerWith = (run: FauxStep[]) => ({ "tm-1": maintainerScripts(run) });

const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const payloadsOf = <T>(frontend: TestFrontend, channel: string, type: string) => frontend.events({ channel, type }).map((f) => f.payload as T);
const tasksOf = (frontend: TestFrontend) => payloadsOf<TaskEventPayload>(frontend, BOARD, EVENT_TYPES.task);
const cardsOf = (frontend: TestFrontend): Card[] => payloadsOf<CardEventPayload>(frontend, CARDS, EVENT_TYPES.card).map((p) => p.card);
const inboxOf = (frontend: TestFrontend): InboxItem[] => payloadsOf<InboxItemEventPayload>(frontend, INBOX, EVENT_TYPES.inboxItem).map((p) => p.item);
const messagesOf = (frontend: TestFrontend, channel: string) => payloadsOf<MessageEventPayload>(frontend, channel, EVENT_TYPES.message);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
type ToolCallRecord = { callId: string; tool: string; argsSummary: string; outcome: string; resultSummary?: string };
const toolCallsOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts)
    .filter((p) => p.type === "tool_call") as unknown as ToolCallRecord[];
/** agent 回复里 echo_context 的回显（去掉时间标记） */
const echoes = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && textOf(m).startsWith("[system]"))
    .map((m) => stripTimeMarkers(textOf(m)));

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

/** 独立进程里的守护进程报出来：调用摘要里有这条命令的调用开始执行了 */
const started = (command: string) => (r: KillableReport) =>
  r.guard?.type === GUARD_EVENTS.toolCallStarted && (r.guard.payload as ToolCallStartedPayload).execution.call.includes(command);

/** bash 调用的执行记录（开始、被中断）里记的调用摘要 */
const executionCalls = (td: TestDaemon) =>
  td.daemon.store
    .read(GUARD_CHANNEL)
    .filter((e) => e.type === GUARD_EVENTS.toolCallStarted || e.type === GUARD_EVENTS.toolCallInterrupted)
    .map((e) => (e.payload as ToolCallStartedPayload).execution)
    .filter((execution) => execution.tool === "bash")
    .map((execution) => execution.call);

/** 连上被杀之前的那个守护进程：订阅秘书、看板、卡片、待我处理和 tm-1 的会话 */
async function connect(url: string): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(url);
  ok(await frontend.subscribe(Object.fromEntries(CHANNELS_SEEN.map((c) => [c, 0]))));
  return frontend;
}

/** 等 Job 里至少有这么多进程（工具起的 bash 和它跑的命令也进来了），杀掉守护进程，确认它们一个不剩；返回这些 pid */
async function killWithProcesses(killable: KillableDaemon, atLeast: number): Promise<number[]> {
  let pids: number[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    pids = (await killable.processes()).job;
    if (pids.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(pids.length).toBeGreaterThanOrEqual(atLeast);
  await killable.kill();
  expect(await survivors(pids)).toEqual([]);
  return pids;
}

/** 在重启后的守护进程上重新连上（带着每个频道的游标，只补发重启之后的）；返回重连前收到了多少帧 */
async function reconnect(frontend: TestFrontend, td: TestDaemon): Promise<number> {
  const before = frontend.events().length;
  ok(await frontend.reconnect(CHANNELS_SEEN, td.url));
  return before;
}

describe("任务里被杀", () => {
  it("有副作用的调用执行到一半：子进程和孙进程随之结束；重启后任务转为等我（中断：不确定 X 是否已执行），看板上看得到原因、待我处理里一条卡着任务的事项，不自动重做；用户确认后维护者照他说的接着做", async () => {
    const command = "sleep 60 && echo 发出 >> sent.txt";
    const killable = await startKillableDaemon({ secretary: SECRETARY_BRIEFS, maintainer: maintainerWith([call("bash", { command })]) });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    // bash 开始执行（有副作用：记了"开始执行"）；秘书、维护者、bash、sleep 都在 Job 里
    await killable.waitFor((r) => r.allowed?.agentId === "tm-1" && r.allowed.toolName === "bash", "维护者的 bash 开始执行");
    await killable.waitFor((r) => r.guard?.type === GUARD_EVENTS.toolCallStarted, "记下开始执行");
    const oldPids = await killWithProcesses(killable, 4);

    const td = await restartAfterKill(killable, { maintainer: () => [echo, say("好的")] });
    // 重启后没有旧进程
    expect((td.daemon.job?.processIds() ?? []).filter((pid) => oldPids.includes(pid))).toEqual([]);
    await reconnect(frontend, td);
    const what = `通用 bash「${command}」`;
    const why = `中断：不确定${what}是否已执行`;
    const waiting = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.waitReason === "interrupted", "任务转为等我（中断不确定）");
    expect(waiting).toMatchObject({ change: "waiting", from: "running", by: "system", task: { state: "waiting_for_user", waitReason: "interrupted", waitNote: why } });
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted", "中断不确定事项");
    expect(item).toMatchObject({ title: why, urgency: "blocking", actions: [INTERRUPTED_ACTIONS.executed, INTERRUPTED_ACTIONS.notExecuted], source: "任务「整理笔记」" });
    // 不自动重做：维护者没被唤起，那条命令没再跑过
    await new Promise((r) => setTimeout(r, 1500));
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "bash")).toEqual([]);
    expect(fs.existsSync(path.join(td.daemon.layout.outputs, "t-1", "sent.txt"))).toBe(false);
    expect(td.daemon.agents.live().map((a) => a.agentId)).not.toContain("tm-1");

    // 用户查过：已经执行了。任务接着执行，维护者被唤起，看得到那次调用补上的"不确定"和用户的确认
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: INTERRUPTED_ACTIONS.executed }));
    const resumed = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.change === "resumed", "任务接着执行");
    expect(resumed.task.state).toBe("running");
    expect(resumed.task.waitNote).toBeUndefined();
    await waitUntil(() => echoes(frontend, M1).length > 0, { timeoutMs: 30_000, describe: () => "维护者被唤起" });
    const seen = echoes(frontend, M1).at(-1)!;
    expect(seen).toContain(`[toolResult] bash: 这次调用被中断了：执行时守护进程（或 agent 子进程）重启了，不确定${what}是否已执行。`);
    expect(seen).toContain(`用户确认过了：${what}已经执行了，不要重做`);
  }, 150_000);

  it("同一批里一快一慢、杀在中间：先做完的那次结果还没写进会话，重启后按结束记录补\"已经执行完了\"、不重做；只有慢的那次说不清做没做完", async () => {
    // pi 并行执行这两次调用，全部结束才把结果写进会话
    const fast = "echo 发出 >> sent.txt";
    const slow = "sleep 60";
    const both: FauxStep = {
      kind: "reply",
      toolCalls: [
        { name: "bash", arguments: { command: fast } },
        { name: "bash", arguments: { command: slow } },
      ],
    };
    const killable = await startKillableDaemon({ secretary: SECRETARY_BRIEFS, maintainer: maintainerWith([both]) });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    const fastCall = (await killable.waitFor(started(fast), "快的那次开始")).guard!.payload as ToolCallStartedPayload;
    await killable.waitFor(started(slow), "慢的那次在跑");
    await killable.waitFor(
      (r) => r.guard?.type === GUARD_EVENTS.toolCallFinished && (r.guard.payload as ToolCallFinishedPayload).toolCallId === fastCall.execution.toolCallId,
      "快的那次做完",
    );
    await killable.kill();

    const td = await restartAfterKill(killable, { maintainer: () => [echo, say("好的")] });
    await reconnect(frontend, td);
    const sent = path.join(td.daemon.layout.outputs, "t-1", "sent.txt");
    expect(fs.readFileSync(sent, "utf8")).toBe("发出\n");
    // 只有慢的那次说不清做没做完
    const slowWhy = `中断：不确定通用 bash「${slow}」是否已执行`;
    const waiting = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.waitReason === "interrupted", "任务转为等我（中断不确定）");
    expect(waiting.task.waitNote).toBe(slowWhy);
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted", "中断不确定事项");
    expect(item.title).toBe(slowWhy);
    await new Promise((r) => setTimeout(r, 1000));
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "interrupted" && i.title !== slowWhy)).toEqual([]);

    // 用户说慢的那次没执行：维护者看到快的那次"已经执行完了，不要重做"，慢的那次"不确定"，加上用户的回答；快的那次没再跑
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: INTERRUPTED_ACTIONS.notExecuted }));
    await waitUntil(() => echoes(frontend, M1).length > 0, { timeoutMs: 30_000, describe: () => "维护者被唤起" });
    const seen = echoes(frontend, M1).at(-1)!;
    expect(seen).toContain(`[toolResult] bash: 这次调用已经执行完了（通用 bash「${fast}」，结果：(no output)）。守护进程（或 agent 子进程）重启时结果还没写进会话；不要重做`);
    expect(seen).toContain(`[toolResult] bash: 这次调用被中断了：执行时守护进程（或 agent 子进程）重启了，不确定通用 bash「${slow}」是否已执行。`);
    expect(seen).toContain(`用户确认过了：通用 bash「${slow}」没有执行，重做这一步`);
    expect(fs.readFileSync(sent, "utf8")).toBe("发出\n");
  }, 150_000);

  it("子 agent（20 号票）的有副作用调用执行到一半：同样转为等我、待我处理里一条卡着任务的事项（写明哪个子 agent），不自动重做；交回维护者的\"被打断了\"写明这次调用等用户确认、别重做；用户确认后维护者照他说的做", async () => {
    const command = "sleep 60 && echo 发出 >> sa-sent.txt";
    const killable = await startKillableDaemon({
      secretary: SECRETARY_BRIEFS,
      // 维护者把 s1 交给子 agent sa-1，用户同意后等它交回
      maintainer: maintainerWith([call("propose_parallel", { reason: "交给子 agent 做", agents: [{ stageId: "s1", instructions: "跑那条命令" }] }), say("等你确认"), say("等 sa-1 交回")]),
      subAgent: { "sa-1": [call("bash", { command }), say("做完了")] },
    });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "parallel", "并行确认卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: card.version }));
    await killable.waitFor((r) => r.allowed?.agentId === "sa-1" && r.allowed.toolName === "bash", "sa-1 的 bash 开始执行");
    const startedCall = (await killable.waitFor(started(command), "记下 sa-1 开始执行")).guard!.payload as ToolCallStartedPayload;
    expect(startedCall.execution.origin).toMatchObject({ agentId: "sa-1", taskId: "t-1", stageId: "s1" });
    await killable.kill();

    // 重启后 sa-1 不会被重新拉起（给它空剧本：要是拉起了、一调用就出错）
    const td = await restartAfterKill(killable, { maintainer: () => [echo, say("好的"), say("好")] });
    await reconnect(frontend, td);
    const what = `通用 bash「${command}」`;
    const why = `中断：不确定${what}是否已执行`;
    const waiting = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.waitReason === "interrupted", "任务转为等我（中断不确定）");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitNote: why });
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted", "中断不确定事项");
    expect(item).toMatchObject({ title: why, urgency: "blocking", data: { taskId: "t-1", toolCallId: startedCall.execution.toolCallId, agentId: "sa-1" } });
    expect(item.kind === "notice" && item.body).toContain(`任务「整理笔记」里子 agent sa-1 在阶段 s1 正在执行${what}时，守护进程（或子 agent sa-1 的子进程）重启了`);
    // 交回维护者的"被打断了"写明那次调用等用户确认、不要重做
    const back = await eventually(() => messagesOf(frontend, M1), (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 被打断的说明");
    expect(textOf(back)).toContain(`被打断了（守护进程重启），没有结果。它停下时正在执行的${what}说不清做没做完，已经放进待我处理请用户确认：用户告诉你之前不要重做`);
    // 不自动重做：那条命令没再跑过，sa-1 没被重新拉起
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(path.join(td.daemon.layout.outputs, "t-1", "sa-sent.txt"))).toBe(false);
    expect(td.daemon.agents.live().map((a) => a.agentId)).not.toContain("sa-1");
    expect(td.daemon.tasks.get("t-1")?.state).toBe("waiting_for_user");

    // 用户查过：没执行。任务接着执行，维护者收到的确认写明那是 sa-1 在阶段 s1 的调用
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: INTERRUPTED_ACTIONS.notExecuted }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.change === "resumed", "任务接着执行");
    const answered = await eventually(() => messagesOf(frontend, M1), (m) => m.message.speaker === "system" && textOf(m).includes("用户确认过了"), "交给维护者的确认");
    expect(textOf(answered)).toContain(`用户确认过了：${what}（子 agent sa-1 在阶段 s1 的调用）没有执行，重做这一步`);
  }, 150_000);

  it("正在等审批的调用：重启后审批卡还是那一张、仍待处理，不新建卡也不再提示，任务在等我，不算说不清做没做完；用户事后批准后维护者被唤起重试，放行一次，再来一次重新问", async () => {
    // 工作目录之外的文件：任务里读它要先问（计划里没有授权），等审批时被杀
    const source = path.join(realPathOf(makeTempDir("ergou-outside-"))!, "source.txt");
    fs.writeFileSync(source, "原始资料");
    const killable = await startKillableDaemon({ secretary: SECRETARY_BRIEFS, config: { approvals: { waitMinutes: 2 } }, maintainer: maintainerWith([call("read", { path: source })]) });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval", "审批卡");
    expect(card).toMatchObject({ status: "pending", urgency: "blocking" });
    await killable.waitFor((r) => r.guard?.type === GUARD_EVENTS.approvalRequested, "审批请求落盘");
    await killable.kill();

    // 重启：之后的审批只等 1.2 秒（第二次问的时候不用真等两分钟）
    const td = await restartAfterKill(killable, {
      config: { approvals: { waitMinutes: 0.02 } },
      maintainer: () => [call("read", { path: source }), call("read", { path: source }), echo],
    });
    const before = await reconnect(frontend, td);
    // 任务在等我（审批）：恢复成挂起，审批卡还是那一张、仍待处理
    const waiting = await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.change === "waiting", "任务转等我（审批）");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitReason: "approval" });
    expect(td.daemon.approvals.list()).toMatchObject([{ approvalId: (card.payload as { approvalId: string }).approvalId, status: "pending", suspended: true }]);
    expect(td.daemon.cards.get(card.id)).toMatchObject({ status: "pending", version: card.version });
    // 不新建卡、不再提示，也不算说不清做没做完
    const since = frontend.events().slice(before);
    expect(since.filter((f) => f.type === EVENT_TYPES.card)).toEqual([]);
    expect(since.filter((f) => f.type === EVENT_TYPES.notify)).toEqual([]);
    expect(td.daemon.store.read(GUARD_CHANNEL, 0, GUARD_EVENTS.toolCallInterrupted)).toEqual([]);
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "interrupted")).toEqual([]);

    // 事后批准：一次性授权，维护者被唤起"可以重试"，原样重试放行一次；再来一次重新问（第二张审批卡）
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    await waitUntil(() => echoes(frontend, M1).length > 0, { timeoutMs: 30_000, describe: () => "维护者重试完" });
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "read").map((c) => [c.tool, c.outcome])).toEqual([
      ["read", "done"],
      ["read", "blocked"],
    ]);
    expect(td.daemon.approvals.list().map((a) => [a.status, a.consumed])).toEqual([
      ["approved", true],
      ["pending", false],
    ]);
    expect(new Set(cardsOf(frontend).filter((c) => c.type === "approval").map((c) => c.id)).size).toBe(2);
    // 维护者看到：等审批时被打断的那次没执行（补上的结果），批准的通知，重试拿到的内容
    const seen = echoes(frontend, M1).at(-1)!;
    expect(seen).toContain("[toolResult] read: 已提交审批，等待用户：守护进程（或 agent 子进程）重启时这次调用还在等用户批准，没有执行");
    expect(seen).toContain("已获用户批准，可以重试");
    expect(seen).toContain("[toolResult] read: 原始资料");
  }, 150_000);

  it("只读的调用执行到一半：任务不转等我；维护者被唤起接着做，会话里那次调用补着\"被中断\"，由它决定要不要重做", async () => {
    const killable = await startKillableDaemon({
      secretary: SECRETARY_BRIEFS,
      maintainer: maintainerWith([call("write", { path: "notes.md", content: "第一条笔记\n" }), call("bash", { command: "tail -f notes.md" })]),
    });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    await killable.waitFor((r) => r.allowed?.agentId === "tm-1" && r.allowed.toolName === "bash", "维护者的 tail -f 开始执行");
    await killWithProcesses(killable, 4);

    const td = await restartAfterKill(killable, { maintainer: () => [echo, say("接着做")] });
    await reconnect(frontend, td);
    await waitUntil(() => echoes(frontend, M1).length > 0, { timeoutMs: 30_000, describe: () => "维护者被唤起" });
    const seen = echoes(frontend, M1).at(-1)!;
    expect(seen).toContain(`[toolResult] bash: ${INTERRUPTED_TOOL_RESULT}`);
    expect(seen).toContain(RESTART_WAKE_TEXT);
    // 任务一直在执行中，没有中断不确定
    expect(td.daemon.tasks.get("t-1")).toMatchObject({ state: "running" });
    expect(tasksOf(frontend).filter((e) => e.task.waitReason === "interrupted")).toEqual([]);
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "interrupted")).toEqual([]);
    expect(messagesOf(frontend, M1).filter((m) => m.agentInput && textOf(m) === RESTART_WAKE_TEXT)).toHaveLength(1);
  }, 150_000);

  it("守护进程没被杀、只是维护者的子进程意外退出：正在执行的有副作用的调用同样记成中断，任务转为等我；用户在任务详情里点继续，维护者被提醒先查效果", async () => {
    const td = await startTestDaemon({
      secretary: SECRETARY_BRIEFS,
      maintainer: (_id, spawn) => maintainerScripts([call("bash", { command: "sleep 60" })])[spawn - 1] ?? [echo],
    });
    const frontend = await connect(td.url);
    await startRunningTask(frontend);
    const bashStarted = () => td.daemon.store.read(GUARD_CHANNEL, 0, GUARD_EVENTS.toolCallStarted).some((e) => (e.payload as ToolCallStartedPayload).execution.tool === "bash");
    await waitUntil(bashStarted, { timeoutMs: 30_000, describe: () => "bash 开始执行" });
    const maintainer = td.daemon.agents.live().findLast((a) => a.agentId === "tm-1")!;
    process.kill(maintainer.pid);

    const why = "中断：不确定通用 bash「sleep 60」是否已执行";
    const waiting = await eventually(() => tasksOf(frontend), (e) => e.task.waitReason === "interrupted", "任务转为等我（中断不确定）");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitNote: why });
    await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted" && i.urgency === "blocking", "中断不确定事项");

    // 在任务详情里点继续：维护者被唤起，提醒它先查那次调用的效果；待我处理里那一条不再卡着任务
    ok(await frontend.taskAction({ taskId: "t-1", action: "resume" }));
    await waitUntil(() => echoes(frontend, M1).length > 0, { timeoutMs: 30_000, describe: () => "维护者被唤起" });
    expect(echoes(frontend, M1).at(-1)).toContain(`用户让你继续执行（之前${why}`);
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "interrupted").at(-1)).toMatchObject({ urgency: "non_blocking" });
  }, 120_000);
});

describe("彻底删除", () => {
  it("被中断的那次调用的审批决定彻底删除时，同一段调用摘要出现的地方一起改写：执行记录、任务等我的说明、维护者会话里的说明、\"中断不确定\"事项；任务状态不变", async () => {
    const tools = realPathOf(makeTempDir("ergou-tools-"))!;
    const runs = path.join(tools, "runs.log");
    const script = path.join(tools, "slow.js");
    fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "跑了一次\\n");\nsetTimeout(() => {}, 60_000);\n`);
    const command = `node "${fwd(script)}"`;
    const killable = await startKillableDaemon({ secretary: SECRETARY_BRIEFS, maintainer: maintainerWith([call("bash", { command })]) });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    // 工作目录之外的脚本：先问；批准时它还在等，接着执行
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval", "审批卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    await killable.waitFor((r) => r.guard?.type === GUARD_EVENTS.toolCallStarted, "脚本开始执行");
    await waitUntil(() => fs.existsSync(runs), { timeoutMs: 15_000, describe: () => "脚本跑起来" });
    await killable.kill();

    const td = await restartAfterKill(killable, { maintainer: () => [echo] });
    await reconnect(frontend, td);
    const what = `通用 bash「${command}」`;
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.task.waitReason === "interrupted", "任务转为等我（中断不确定）");
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted", "中断不确定事项");
    expect(td.daemon.tasks.get("t-1")?.waitNote).toBe(`中断：不确定${what}是否已执行`);
    /** 维护者会话里还提到这次调用的消息 */
    const mentions = () =>
      td.daemon.store
        .read(M1, 0, EVENT_TYPES.message)
        .filter((e) => !isDeletedEventPayload(e.payload) && textOf(e.payload as MessageEventPayload).includes(what));
    expect(mentions().length).toBeGreaterThan(0);

    expect((await materialsApi.delete(td.url, { scope: { kind: "conversation", conversation: M1 }, mode: "purge", idempotencyKey: "purge-m1" })).status).toBe(200);
    expect(td.daemon.tasks.get("t-1")).toMatchObject({ state: "waiting_for_user", waitReason: "interrupted", waitNote: PURGED_TEXT });
    expect(td.daemon.inbox.list().find((i) => i.id === item.id)).toMatchObject({ title: PURGED_TEXT, body: PURGED_TEXT, urgency: "blocking" });
    expect(mentions()).toEqual([]);
    expect(executionCalls(td)).toEqual([PURGED_TEXT, PURGED_TEXT]);

    // 状态不变：用户回答之后任务照常接着执行
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: INTERRUPTED_ACTIONS.executed }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === "t-1" && e.change === "resumed", "任务接着执行");
    expect(fs.readFileSync(runs, "utf8")).toBe("跑了一次\n");
  }, 150_000);
});

describe("重复启动", () => {
  it("同一个数据目录已经有守护进程在跑：再起一个立即退出、不碰任何状态——正在执行的调用不会被当成被杀时中断的，任务照常执行", async () => {
    const killable = await startKillableDaemon({ secretary: SECRETARY_BRIEFS, maintainer: maintainerWith([call("bash", { command: "sleep 60" })]) });
    const frontend = await connect(killable.url);
    await startRunningTask(frontend);
    await killable.waitFor((r) => r.guard?.type === GUARD_EVENTS.toolCallStarted, "bash 开始执行");
    const pidFile = dataDirLayout(killable.dataDir).pidFile;
    expect(readPidFile(pidFile)).toMatchObject({ pid: killable.pid });
    const seen = frontend.events().length;

    await expect(
      startTestDaemon({ reuse: { dataDir: killable.dataDir, homeDir: killable.homeDir }, webRoot: killable.webRoot, programDir: killable.programDir }),
    ).rejects.toThrow(`已经有一个守护进程在运行（pid 文件里的守护进程（PID ${killable.pid}）还在运行）`);

    // 正在跑的那个不受影响：没有中断、任务没转等我、pid 文件还是它的
    await new Promise((r) => setTimeout(r, 1500));
    expect(killable.reports.filter((r) => r.guard?.type === GUARD_EVENTS.toolCallInterrupted)).toEqual([]);
    expect(frontend.events().slice(seen).filter((f) => f.type === EVENT_TYPES.task || f.type === EVENT_TYPES.inboxItem)).toEqual([]);
    expect(tasksOf(frontend).at(-1)?.task.state).toBe("running");
    expect(readPidFile(pidFile)).toMatchObject({ pid: killable.pid });
  }, 120_000);
});

describe("秘书会话里被杀", () => {
  it("经用户批准、正在跑的草稿区外脚本：重启后待我处理里一条不卡任务的\"中断：不确定 X 是否已执行\"，不自动重做；秘书会话照常可用", async () => {
    const tools = realPathOf(makeTempDir("ergou-tools-"))!;
    const runs = path.join(tools, "runs.log");
    const script = path.join(tools, "slow.js");
    fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "跑了一次\\n");\nsetTimeout(() => {}, 60_000);\n`);
    const command = `node "${fwd(script)}"`;
    const killable = await startKillableDaemon({ secretary: [call("bash", { command }), say("跑完了")] });
    const frontend = await connect(killable.url);
    await frontend.sendText("跑一下我那个脚本");
    // 草稿区外的脚本：先问；批准时它还在等，接着执行
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval", "审批卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    await killable.waitFor((r) => r.guard?.type === GUARD_EVENTS.toolCallStarted, "脚本开始执行");
    await waitUntil(() => fs.existsSync(runs), { timeoutMs: 15_000, describe: () => "脚本跑起来" });
    await killable.kill();

    const td = await restartAfterKill(killable, { secretary: [echo] });
    await reconnect(frontend, td);
    const what = `通用 bash「${command}」`;
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "interrupted", "中断不确定事项");
    expect(item).toMatchObject({ urgency: "non_blocking", source: `${ASSISTANT_NAME_MARK}对话`, actions: [INTERRUPTED_ACK] });
    expect(item.title.startsWith("中断：不确定通用 bash「node")).toBe(true);
    expect(item.kind === "notice" && item.body).toContain(what);
    // 被打断的那条消息照旧不重送，会话里一条说明
    const interrupted = payloadsOf<TurnEndEventPayload>(frontend, SECRETARY, EVENT_TYPES.turnEnd).filter((t) => t.outcome === "interrupted");
    expect(interrupted).toHaveLength(1);
    expect(messagesOf(frontend, SECRETARY).some((m) => m.message.speaker === "system" && textOf(m).includes("「跑一下我那个脚本」处理时中断了"))).toBe(true);

    // 秘书会话照常可用：看得到那次调用"不确定是否已执行"；脚本没有再跑
    await frontend.sendText("刚才那个脚本跑完了吗");
    await waitUntil(() => echoes(frontend, SECRETARY).length > 0, { timeoutMs: 30_000, describe: () => "秘书回复" });
    expect(echoes(frontend, SECRETARY).at(-1)).toContain(`[toolResult] bash: 这次调用被中断了：执行时守护进程（或 agent 子进程）重启了，不确定${what}是否已执行。`);
    expect(fs.readFileSync(runs, "utf8")).toBe("跑了一次\n");

    // 彻底删除秘书主线（含这次调用的审批决定）：同一段调用摘要出现的地方一起改写——执行记录、"中断不确定"事项的标题和正文
    expect((await materialsApi.delete(td.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-secretary" })).status).toBe(200);
    expect(td.daemon.inbox.list().find((i) => i.id === item.id)).toMatchObject({ title: PURGED_TEXT, body: PURGED_TEXT, urgency: "non_blocking" });
    expect(executionCalls(td)).toEqual([PURGED_TEXT, PURGED_TEXT]);
  }, 150_000);

  it("说到一半的回复：历史和会话文件里都没有碎片，会话从最后一个完整回合续上；排着的输入按原顺序处理，不丢也不重复", async () => {
    const reply = "这是一段慢慢说的很长的回复，".repeat(30);
    const killable = await startKillableDaemon({ secretary: [say("第一轮说完了"), say(reply)], secretaryTokensPerSecond: 20 });
    const frontend = await connect(killable.url);
    await frontend.sendText("先打个招呼");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 30_000);
    // 第二条正说到一半：又来了两条，排着
    const a = await frontend.sendText("讲个长故事");
    await frontend.next(SECRETARY, EVENT_TYPES.stream, 30_000);
    const b = await frontend.sendText("第二个问题");
    const c = await frontend.sendText("第三个问题");
    await killable.kill();
    const streamed = frontend
      .events({ channel: SECRETARY, type: EVENT_TYPES.stream })
      .flatMap((f) => (f.payload as { deltas: Array<{ text: string }> }).deltas.map((d) => d.text))
      .join("");
    expect(streamed.length).toBeGreaterThan(0);

    const td = await restartAfterKill(killable, { secretary: [echo, say("第三个的回答")] });
    await reconnect(frontend, td);
    await waitUntil(() => payloadsOf<TurnEndEventPayload>(frontend, SECRETARY, EVENT_TYPES.turnEnd).some((t) => t.inputMessageId === c.messageId), {
      timeoutMs: 30_000,
      describe: () => "第三条处理完",
    });
    // 说到一半的那条以"中断"出队；排着的两条按原顺序各处理一次
    const starts = payloadsOf<TurnStartEventPayload>(frontend, SECRETARY, EVENT_TYPES.turnStart).map((t) => t.inputMessageId);
    const ends = payloadsOf<TurnEndEventPayload>(frontend, SECRETARY, EVENT_TYPES.turnEnd).map((t) => [t.inputMessageId, t.outcome]);
    expect(starts.slice(-3)).toEqual([a.messageId, b.messageId, c.messageId]);
    expect(ends.slice(-3)).toEqual([
      [a.messageId, "interrupted"],
      [b.messageId, "completed"],
      [c.messageId, "completed"],
    ]);
    // 会话从最后一个完整回合续上：模型看到第一轮、被打断的那条、排着的那条，看不到说到一半的碎片
    const seen = echoes(frontend, SECRETARY).at(-1)!;
    expect(seen).toContain("[assistant] 第一轮说完了");
    expect(seen).toContain("[user] 讲个长故事");
    expect(seen).toContain("[user] 第二个问题");
    expect(seen).not.toContain(streamed.slice(0, 10));
    // 历史分页和会话文件里都没有碎片
    const page = await frontend.history(SECRETARY);
    expect(JSON.stringify(page)).not.toContain(streamed.slice(0, 10));
    const sessionDir = agentSessionDir(td.daemon.layout, "secretary");
    const sessionText = fs
      .readdirSync(sessionDir)
      .map((f) => fs.readFileSync(path.join(sessionDir, f), "utf8"))
      .join("");
    expect(sessionText).toContain("第一轮说完了");
    expect(sessionText).not.toContain(streamed.slice(0, 10));
  }, 150_000);
});
