// 主切面：两种任务、只有用户点明了才发起（规格第 7 节"任务的发起"，ADR 0019，58 号票）。
// 真的守护进程，秘书接 faux 剧本，测试扮演前端：
// - 点明流程（"按流程做"、/流程）：秘书用 start_workflow 建流程；点明长程任务（"发起任务"、/任务，只说"发起任务"的按长程任务）：create_task；
// - 没点明：秘书去建任务被运行时拒绝（原因交回秘书），按普通对话处理，最多给一张"建议发起任务"卡；
// - 建议卡上"作为流程""作为长程任务"两个按钮：点哪个建哪种（用户发起），秘书收到通知；
// - 发起对话框里先选了种类：不经秘书，建出的就是这种；
// - 种类建卡时定下，看板上的任务带着它；之前建的任务没有记种类，算长程任务。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type MessageEventPayload,
  type ResponseFrame,
  type TaskEventPayload,
  taskKind,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { seedProject } from "../helpers/projects.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const startWorkflow = call("start_workflow", { title: "整理下载目录", summary: "把下载目录按类型整理好" });
const createTask = call("create_task", { title: "家用 NAS 调研", summary: "调研家用 NAS，预算 3000 以内" });
const suggest = call("suggest_task", { title: "整理下载目录", why: "下载目录里堆了很多安装包和截图" });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 });
  return frontend;
}

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs: 20_000, describe: () => `等${what}` });
  return found!;
}

/** 秘书最后一次模型调用看到的上下文（剧本最后一步 echo_context 的回显） */
const seenBySecretary = (frontend: TestFrontend) => textOf(messagesOf(frontend, SECRETARY).at(-1)!);

describe("点明了才发起：消息里点明", () => {
  it("说了“按流程做”：秘书用 start_workflow 建出流程（规划中，秘书按用户的要求建）", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [startWorkflow, { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "按流程做：把下载目录按类型整理好");

    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created).toMatchObject({ by: "secretary", task: { id: "t-1", title: "整理下载目录", state: "planning", origin: "request", kind: "workflow" } });
    expect(seenBySecretary(frontend)).toContain("[toolResult] start_workflow: 已建好流程 t-1「整理下载目录」（规划中）");
    expect(cardsOf(frontend).filter((c) => c.type === "suggest_task")).toEqual([]);
    expect(daemon.tasks.get("t-1")?.kind).toBe("workflow");
  });

  it("输入 /流程：一样是点明了流程", async () => {
    const { url } = await startTestDaemon({ secretary: [startWorkflow, say("建好了")] });
    const frontend = await connect(url);
    await tell(frontend, "/流程 把下载目录按类型整理好");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created.task.kind).toBe("workflow");
  });

  it("说了“发起任务”没说种类：按长程任务，秘书用 create_task 建；输入 /任务 也一样", async () => {
    const { url } = await startTestDaemon({ secretary: [createTask, say("建好了"), createTask, { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "发起任务：调研家用 NAS，预算 3000 以内");
    await tell(frontend, "/任务 再调研一次家用 NAS");

    const created = tasksOf(frontend).filter((e) => e.change === "created");
    expect(created.map((e) => [e.task.id, e.task.kind, e.task.origin])).toEqual([
      ["t-1", "long_running", "request"],
      ["t-2", "long_running", "request"],
    ]);
    expect(seenBySecretary(frontend)).toContain("[toolResult] create_task: 已建好长程任务 t-2「家用 NAS 调研」（规划中）");
  });

  it("点明的是另一种：拒绝并告诉秘书该用哪个工具，不建任务", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [createTask, { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "按流程做：把下载目录按类型整理好");
    expect(seenBySecretary(frontend)).toMatch(/\[toolResult\] create_task: 用户这一轮点明的是流程，不是长程任务：用 start_workflow 发起/);
    expect(daemon.tasks.list()).toEqual([]);
  });
});

describe("没点明：按普通对话处理，最多给一张建议卡", () => {
  it("用户只说了要做的事：秘书去建任务被拒（原因交回秘书），改给一张“建议发起任务”卡；一轮只能给一张；不建任务", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [createTask, startWorkflow, suggest, suggest, { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "下载目录太乱了，帮我整理一下");

    const seen = seenBySecretary(frontend);
    expect(seen).toContain("[toolResult] create_task: 用户这一轮没有点明要发起任务");
    expect(seen).toContain("[toolResult] start_workflow: 用户这一轮没有点明要发起任务");
    expect(seen).toContain("[toolResult] suggest_task: 这一轮已经给过一张“建议发起任务”卡了，一轮最多一张。");
    const suggestions = cardsOf(frontend).filter((c) => c.type === "suggest_task");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ status: "pending", payload: { title: "整理下载目录" } });
    expect(daemon.tasks.list()).toEqual([]);
    expect(tasksOf(frontend)).toEqual([]);
  });

  it("问句、带否定词的不算点明：“要不要发起任务？”“不用发起任务”", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [createTask, say("好"), createTask, say("好")] });
    const frontend = await connect(url);
    await tell(frontend, "这件事要不要发起任务？");
    await tell(frontend, "不用发起任务，你直接告诉我就行");
    expect(daemon.tasks.list()).toEqual([]);
  });
});

describe("建议卡上的两个按钮", () => {
  it("点“作为流程”：建出流程（用户发起），卡上记着种类和任务编号，秘书收到通知；另一张点“作为长程任务”建出长程任务", async () => {
    const { url } = await startTestDaemon({ secretary: [suggest, say("要不要发起一个任务？"), { kind: "echo_context" }, suggest, say("这个也可以"), { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "下载目录太乱了");
    const first = await eventually(() => cardsOf(frontend), (c) => c.type === "suggest_task", "建议卡");
    expect(first.version).toBe(1);

    ok(await frontend.cardAction({ cardId: first.id, action: "start_workflow", expectedVersion: 1 }));
    const workflow = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的流程");
    expect(workflow).toMatchObject({ by: "user", task: { id: "t-1", title: "整理下载目录", origin: "suggestion", kind: "workflow", state: "planning" } });
    const handled = await eventually(() => cardsOf(frontend), (c) => c.id === first.id && c.status === "handled", "处理过的建议卡");
    expect(handled.payload).toMatchObject({ taskId: "t-1", kind: "workflow" });
    expect(handled.outcome?.action).toBe("start_workflow");
    // 秘书收到通知（系统消息），接着澄清
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(seenBySecretary(frontend)).toContain("用户在建议卡上点了「作为流程」。流程 t-1「整理下载目录」已建好（规划中）");

    await tell(frontend, "桌面也乱");
    const second = await eventually(() => cardsOf(frontend), (c) => c.type === "suggest_task" && c.id !== first.id, "第二张建议卡");
    ok(await frontend.cardAction({ cardId: second.id, action: "start_task", expectedVersion: 1 }));
    const longRunning = await eventually(() => tasksOf(frontend), (e) => e.change === "created" && e.task.id === "t-2", "建出的长程任务");
    expect(longRunning.task).toMatchObject({ origin: "suggestion", kind: "long_running" });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(seenBySecretary(frontend)).toContain("用户在建议卡上点了「作为长程任务」。长程任务 t-2「整理下载目录」已建好（规划中）");
  }, 60_000);
});

describe("发起对话框里先选了种类", () => {
  it("选了流程：不经秘书建出流程，秘书收到的通知写明是流程；不选是长程任务", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const frontend = await connect(url);
    expect(ok(await frontend.startTask("整理下载目录\n按类型分文件夹", "k-flow", undefined, "workflow"))).toEqual({ taskId: "t-1" });
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的流程");
    expect(created).toMatchObject({ by: "user", task: { origin: "button", kind: "workflow" } });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(seenBySecretary(frontend)).toContain("用户点「发起任务」发起了流程：整理下载目录");

    ok(await frontend.startTask("调研家用 NAS", "k-long"));
    const second = await eventually(() => tasksOf(frontend), (e) => e.change === "created" && e.task.id === "t-2", "建出的长程任务");
    expect(second.task.kind).toBe("long_running");
  });

  it("流程暂时只做不涉及项目的事：选了项目的流程被拒，说明原因", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [] });
    seedProject(daemon, "记账本");
    const frontend = await connect(url);
    const r = await frontend.startTask("给记账本加周报", "k-p", ["记账本"], "workflow");
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining("流程暂时只能做不涉及项目的事") } });
    expect(daemon.tasks.list()).toEqual([]);
  });
});

describe("种类", () => {
  it("两种分开之前建的任务没有记种类：算长程任务", () => {
    expect(taskKind({})).toBe("long_running");
    expect(taskKind({ kind: "workflow" })).toBe("workflow");
  });
});
