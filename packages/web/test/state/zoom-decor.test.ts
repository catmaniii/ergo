// 缩小后条外的装饰（55 号票，state/zoom-decor.ts）：右侧标注的 ×N、左侧任务卡或工单卡、底色带、书脊的分段和颜色、重开之前的已废弃。
// 先回放主切面录下的真实事件流：任务的维护者会话（timeline-zoom：两个阶段都验收通过；task-execution：做完后返工重开 s2）、
// 项目维护者的会话（work-orders-queue：四张工单，项目维护者执行两个任务）、涉及多个项目的任务（multi-project：任务维护者的会话
// 和两个项目维护者的会话）、计划变更（task-plan-change：一个阶段停下等你、另一个先做完）。
// 录不出来的按共享协议的 schema 构造：验收退回、第 3 次还不过（未通过）、任务取消和计划变更去掉阶段（作废）、流程（不画书脊）、
// 秘书主线跨天（守护进程的消息时间是真钟）、连着几块一样的标注（×N）。
import fs from "node:fs";
import path from "node:path";
import {
  MessageEventPayload as MessageEventPayloadSchema,
  ProgressCardPayload as ProgressCardPayloadSchema,
  schemaChecker,
  TaskEventPayload as TaskEventPayloadSchema,
  TimelineRecordEventPayload as TimelineRecordEventPayloadSchema,
} from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChatItem,
  chatItems,
  type ConversationId,
  type EventFrame,
  globalView,
  type MessageEnvelope,
  type MessagePart,
  type ProgressCardPayload,
  replay,
  SPINE_STATE_LABEL,
  type Task,
  type TaskStage,
  type UiInput,
  type UiState,
  zoomBands,
  zoomDecor,
  zoomRects,
  zoomTaskFacts,
  zoomWorkOrderFacts,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 一段书脊写成一个短串：阶段 结果 第几条到第几条（条目的位置） */
function spinesOf(state: UiState, conversation: ConversationId): string[] {
  const items = chatItems(state, conversation);
  const at = new Map(items.map((it, i) => [it.id, i]));
  return zoomDecor(state, conversation, items).spines.map((s) => `${s.taskId}/${s.stageId} ${s.state} ${at.get(s.firstId)}-${at.get(s.lastId)}`);
}

/** 一块底色写成一个短串：种类 标签 第几条到第几条 深浅 */
function bandsOf(state: UiState, conversation: ConversationId): string[] {
  const items = chatItems(state, conversation);
  const at = new Map(items.map((it, i) => [it.id, i]));
  return zoomBands(state, conversation, items).map((b) => {
    const label = b.kind === "day" ? `${b.month}月${b.date}日` : `${b.kind === "task" ? "任务" : "工单"}${b.no} · ${b.title}`;
    return `${label} ${at.get(b.firstId)}-${at.get(b.lastId)} n${b.index % 2}`;
  });
}

const keyLines = (items: readonly ChatItem[], from: number, to: number) => items.slice(from, to + 1).map((it) => it.keyLine.slice(0, 12));

describe("回放：任务的维护者会话", () => {
  test("timeline-zoom：一个任务一整块底色，从任务书到最后一个阶段的验收结论（做完之后的说明、回复不包）；两个阶段各一段书脊，都是验收通过", () => {
    const state = replay(load("timeline-zoom"));
    const conv = "maintainer:tm-1";
    const items = chatItems(state, conv);
    expect(bandsOf(state, conv)).toEqual(["任务1 · 整理笔记和报告 0-11 n0"]);
    expect(keyLines(items, 11, 13)).toEqual(["验收通过（脚本检查）：任", "系统：全部阶段验收通过，", "回复：两个阶段都做完了"]);
    // s1 从"计划已确认，开始执行"到它的验收结论；s2 从它的第一组调用到它的验收结论。验收通过之后还带着 s2 的说明、回复不算新的一轮
    expect(spinesOf(state, conv)).toEqual(["t-1/s1 ok 3-8", "t-1/s2 ok 9-11"]);
    expect(SPINE_STATE_LABEL.ok).toBe("验收通过");
    const decor = zoomDecor(state, conv, items);
    // 左边一张任务卡，挂在这个任务的第一条上：只写一句总结（计划的目标），任务已经完成
    expect([...decor.left]).toEqual([[items[0]!.id, { kind: "task", taskId: "t-1", no: "1", summary: "整理笔记，再写一份报告", live: false }]]);
    expect(decor.stale.size).toBe(0);
    // 验收通过不在右侧标（照 AgentSense：书脊那一段变绿就是通过了）；条目层的要点照旧有它（25 号票要点层的基准不变）
    const rects = new Map(zoomRects(items).map((r) => [r.id, r]));
    for (const i of [8, 11]) {
      expect(items[i]!.marks.map((m) => [m.kind, m.passed])).toEqual([["acceptance", true]]);
      expect(rects.get(items[i]!.id)!.marks).toEqual([]);
    }
    // 点开：你交代的、目标、计划进度、授权、过程中（被拦下的一次、问过你的一次）；能进计划详情（那张计划卡）
    const facts = zoomTaskFacts(state, "t-1", items, "1");
    expect(facts).toMatchObject({
      title: "任务 1",
      live: false,
      rows: [
        ["你交代的", "整理笔记和报告"],
        ["目标", "整理笔记，再写一份报告"],
        ["计划", "长程任务计划 v1 · 2/2 已验收"],
        ["授权", "⚠ 授权 1 类操作"],
        ["过程中", "↺ 检查介入 1 次 · 当场找你 1 次"],
      ],
    });
    expect(items.find((it) => it.id === facts.planItemId)?.keyLine).toMatch(/^计划：整理笔记和报告/);
  });

  test("task-execution：返工重开 s2——返工之前 s2 那一轮是已重开（那张验收结论淡一点、标已废弃），返工后的一轮验收通过；s1 不受影响", () => {
    const state = replay(load("task-execution"));
    const conv = "maintainer:tm-1";
    // 看板上 change 为 rework 的那条任务事件：返工那一刻没验收的就是重开的
    expect(state.taskReopens["t-1"]).toEqual([{ time: "2026-10-08T12:11:56.104+08:00", stageIds: ["s2"] }]);
    // 这段录像早于消息带阶段（25 号票），只有验收结论的进度卡知道是哪个阶段
    expect(spinesOf(state, conv)).toEqual(["t-1/s1 ok 6-6", "t-1/s2 stale 9-9", "t-1/s2 ok 15-15"]);
    const items = chatItems(state, conv);
    expect([...zoomDecor(state, conv, items).stale]).toEqual([items[9]!.id]);
    expect(items[12]!.keyLine).toMatch(/^系统：用户要求返工阶段 s2/);
    // 底色带到最后那张验收结论（返工后的一轮）为止
    expect(bandsOf(state, conv)).toEqual(["任务1 · X 的调研 0-15 n0"]);
  });

  test("task-plan-change：s1 停下等你（还在做），s2 先做完；两个阶段交替着，一轮被隔成几截，颜色都按这一轮", () => {
    const state = replay(load("task-plan-change"));
    expect(spinesOf(state, "maintainer:tm-1")).toEqual(["t-1/s1 live 3-3", "t-1/s2 ok 4-9", "t-1/s1 live 10-10", "t-1/s2 ok 11-14", "t-1/s1 live 15-16"]);
    const items = chatItems(state, "maintainer:tm-1");
    expect(zoomTaskFacts(state, "t-1", items)).toMatchObject({ live: true, rows: expect.arrayContaining([["计划", "长程任务计划 v3 · 1/2 已验收"]]) });
  });
});

describe("回放：项目维护者的会话", () => {
  test("work-orders-queue：每张工单那一段一块底色、相邻的深浅错开，分段和全局层的按段一样；分隔线左边一张工单卡；项目维护者执行的任务照样画书脊", () => {
    const state = replay(load("work-orders-queue"));
    const conv = "maintainer:pm-1";
    expect(bandsOf(state, conv)).toEqual([
      "工单1 · 起草计划：记账本出周报 0-3 n0",
      "工单2 · 起草计划：记账本出月报 4-7 n1",
      "工单3 · 执行：记账本出周报 8-15 n0",
      "工单4 · 执行：记账本出月报 16-23 n1",
    ]);
    const items = chatItems(state, conv);
    expect(zoomBands(state, conv, items).map((b) => (b.kind === "work_order" ? `工单 ${b.workOrderId} · ${b.title}` : ""))).toEqual(globalView(state, conv).map((b) => b.title));
    const decor = zoomDecor(state, conv, items);
    expect([...decor.left].map(([id, c]) => [items.findIndex((it) => it.id === id), c.kind, c.summary, c.live])).toEqual([
      [0, "work_order", "起草计划：记账本出周报", false],
      [4, "work_order", "起草计划：记账本出月报", false],
      [8, "work_order", "执行：记账本出周报", false],
      [16, "work_order", "执行：记账本出月报", false],
    ]);
    expect(spinesOf(state, conv)).toEqual(["t-1/s1 ok 9-12", "t-2/s1 ok 17-20"]);
    // 工单卡点开：来自、要做的、所属任务、状态
    expect(zoomWorkOrderFacts(state, "wo-3", "执行：记账本出周报")).toMatchObject({
      title: "工单 3",
      live: false,
      rows: expect.arrayContaining([["工单", "执行：记账本出周报"], ["来自", "你"], ["要做的", "执行"]]),
    });
  });

  test("multi-project：书脊只画在执行任务的维护者的会话里（验收结论在那里）；两个项目维护者那边只有工单段的底色和工单卡；连着两条一样的工单记录标 ×2", () => {
    const state = replay(load("multi-project"));
    expect(spinesOf(state, "maintainer:tm-1")).toEqual(["t-1/s1 ok 3-3", "t-1/s2 ok 4-4", "t-1/s1 ok 5-12", "t-1/s2 ok 13-24"]);
    expect(spinesOf(state, "maintainer:pm-1")).toEqual([]);
    expect(spinesOf(state, "maintainer:pm-2")).toEqual([]);
    expect(bandsOf(state, "maintainer:pm-2")).toEqual(["工单2 · 按记账本的导出说明加导入说明 import.md 0-5 n0", "工单3 · 调整：只加一份导入说明 import.md，不动现有的表 6-11 n1"]);
    const items = chatItems(state, "maintainer:tm-1");
    const decor = zoomDecor(state, "maintainer:tm-1", items);
    expect(keyLines(items, 3, 4)).toEqual(["工单：建出工单 wo-1", "工单：建出工单 wo-2"]);
    expect([...decor.repeats]).toEqual([
      [items[3]!.id, 2],
      [items[4]!.id, 0],
    ]);
  });
});

// ───────────────────────── 按 schema 构造的事件 ─────────────────────────

const checkTask = schemaChecker(TaskEventPayloadSchema);
const checkMessage = schemaChecker(MessageEventPayloadSchema);
const checkRecord = schemaChecker(TimelineRecordEventPayloadSchema);
const checkProgress = schemaChecker(ProgressCardPayloadSchema);
function checked<T>(check: { firstError(v: unknown): string | undefined }, what: string, v: T): T {
  const problem = check.firstError(v);
  if (problem) throw new Error(`构造的${what}不合 schema：${problem}`);
  return v;
}

const CONV = "maintainer:tm-9";
const at = (minute: number) => `2026-10-09T10:${String(minute).padStart(2, "0")}:00.000+08:00`;

function stage(stageId: string, state: TaskStage["state"]): TaskStage {
  return { stageId, title: `阶段 ${stageId}`, state, dependsOn: [], acceptance: [], attempts: 0 };
}

function taskFrame(seq: number, overrides: Partial<Task>, change: "started" | "cancelled" | "plan_revised" = "started"): EventFrame {
  const task: Task = {
    id: "t-9",
    title: "写一份周报",
    summary: "写一份周报",
    state: "running",
    origin: "request",
    maintainerId: "tm-9",
    projects: [],
    createdAt: at(0),
    updatedAt: at(0),
    stages: { total: 2, current: 1, list: [stage("s1", "running"), stage("s2", "pending")] },
    ...overrides,
  };
  return frame("board", seq, "task", checked(checkTask, "任务事件", { task, change, from: "running", by: "system" }));
}

function messageFrame(seq: number, minute: number, stageId: string | undefined, parts: MessagePart[], speaker: MessageEnvelope["speaker"] = "agent"): EventFrame {
  const message: MessageEnvelope = { id: `m${seq}`, conversation: CONV, speaker, time: at(minute), parts };
  return frame(CONV, seq, "message", checked(checkMessage, "消息事件", { message, taskId: "t-9", ...(stageId ? { stageId } : {}) }));
}

/** 一张验收结论的进度卡（cards 频道）和会话里引用它的那条消息 */
function acceptanceFrames(seq: number, cardSeq: number, minute: number, stageId: string, passed: boolean): EventFrame[] {
  const payload: ProgressCardPayload = checked(checkProgress, "进度卡", {
    taskId: "t-9",
    taskTitle: "写一份周报",
    stageId,
    stageTitle: `阶段 ${stageId}`,
    stageIndex: stageId === "s1" ? 1 : 2,
    stageTotal: 2,
    kind: "acceptance",
    text: passed ? "验收通过。" : "没通过 1 条，交回维护者修改。",
    acceptance: { passed, judgedBy: "script", results: [{ criterion: "有周报", method: "script", passed }] },
  });
  const cardId = `c-acc-${seq}`;
  return [
    frame("cards", cardSeq, "card", { card: card(cardId, 1, { type: "progress", status: "handled", payload, text: payload.text }) }),
    messageFrame(seq, minute, stageId, [{ type: "card_ref", cardId }], "system"),
  ];
}

function deviationFrame(seq: number, minute: number, stageId: string): EventFrame {
  const record = { id: `r${seq}`, kind: "deviation", summary: `第 1 阶段「阶段 ${stageId}」停下等你（卡住求助）：验收退回了 3 次`, time: at(minute) };
  return frame(CONV, seq, "timeline_record", checked(checkRecord, "时间线记录", { record, taskId: "t-9", stageId }));
}

const say = (t: string): MessagePart[] => [{ type: "text", text: t }];

/** s1：做一轮被退回，再做一轮第 3 次还不过（停下找你），你让它接着做的第三轮；s2 开了个头 */
function roundsEvents(): EventFrame[] {
  return [
    taskFrame(1, {}),
    messageFrame(1, 1, undefined, say("计划交了"), "agent"),
    messageFrame(2, 2, "s1", say("开始做 s1")),
    ...acceptanceFrames(3, 1, 3, "s1", false),
    messageFrame(4, 4, "s1", say("改了一版")),
    ...acceptanceFrames(5, 2, 5, "s1", false),
    deviationFrame(6, 5, "s1"),
    messageFrame(7, 6, "s1", say("按你说的接着做")),
    messageFrame(8, 7, "s2", say("顺手开了 s2 的头")),
  ];
}

describe("构造：书脊的颜色", () => {
  test("没通过是退回；没通过、紧跟着这一支停下找你（同一事务的偏离记录）是未通过，那条记录算在这一轮里；之后接着做的是在做", () => {
    const state = replay(roundsEvents());
    expect(spinesOf(state, CONV)).toEqual(["t-9/s1 retry 1-2", "t-9/s1 failed 3-5", "t-9/s1 live 6-6", "t-9/s2 live 7-7"]);
    expect(["retry", "failed", "live"].map((s) => SPINE_STATE_LABEL[s as "retry"])).toEqual(["退回", "未通过", "在做"]);
    // 没通过的验收结论照旧标在右侧
    const items = chatItems(state, CONV);
    const rects = new Map(zoomRects(items).map((r) => [r.id, r]));
    expect([2, 4].map((i) => rects.get(items[i]!.id)!.marks.map((m) => `${m.kind}:${m.passed}`))).toEqual([["acceptance:false"], ["acceptance:false"]]);
  });

  test("任务取消了，还没交上来的那一轮是没做完（作废）；计划变更去掉的阶段同样是没做完", () => {
    const cancelled = replay([...roundsEvents(), taskFrame(2, { state: "cancelled", updatedAt: at(8) }, "cancelled")]);
    expect(spinesOf(cancelled, CONV)).toEqual(["t-9/s1 retry 1-2", "t-9/s1 failed 3-5", "t-9/s1 off 6-6", "t-9/s2 off 7-7"]);
    const revised = replay([...roundsEvents(), taskFrame(2, { stages: { total: 1, current: 1, list: [stage("s1", "running")] } }, "plan_revised")]);
    expect(spinesOf(revised, CONV)).toEqual(["t-9/s1 retry 1-2", "t-9/s1 failed 3-5", "t-9/s1 live 6-6", "t-9/s2 off 7-7"]);
    expect(SPINE_STATE_LABEL.off).toBe("没做完");
  });

  test("流程不画书脊（AgentSense 的固定计划也没有）；执行它的不是这个会话的维护者也不画；看板上没收到过这个任务的照画，没交上来的算在做", () => {
    const workflow = replay([...roundsEvents(), taskFrame(2, { kind: "workflow" })]);
    expect(spinesOf(workflow, CONV)).toEqual([]);
    const other = replay([...roundsEvents(), taskFrame(2, { maintainerId: "tm-8" })]);
    expect(spinesOf(other, CONV)).toEqual([]);
    const unknown = replay(roundsEvents().slice(1));
    expect(spinesOf(unknown, CONV)).toEqual(["t-9/s1 retry 1-2", "t-9/s1 failed 3-5", "t-9/s1 live 6-6", "t-9/s2 live 7-7"]);
    // 底色带照铺（一个任务一整块：从第一条到最后一条带阶段的）
    expect(bandsOf(workflow, CONV)).toEqual(["任务1 · 写一份周报 0-7 n0"]);
  });
});

describe("构造：普通任务（75 号票）", () => {
  test("普通任务没有阶段：不画书脊；任务卡照画（总结写任务的标题），点开写无计划；没有计划，不铺底色（照 AgentSense：没有计划的任务不铺）", () => {
    const task: Task = {
      id: "t-9",
      title: "下载《晴天》的音频",
      summary: "搜一下周杰伦《晴天》，把音频下载成 mp3",
      state: "done",
      origin: "delegated",
      kind: "plain",
      maintainerId: "tm-9",
      projects: [],
      createdAt: at(0),
      updatedAt: at(3),
    };
    const state = replay([
      frame("board", 1, "task", checked(checkTask, "任务事件", { task, change: "completed", from: "running", by: "system" })),
      messageFrame(1, 1, undefined, say("普通任务 t-9：要做的事——搜一下周杰伦《晴天》"), "system"),
      messageFrame(2, 2, undefined, say("下好了：晴天.mp3")),
      messageFrame(3, 3, undefined, say("这一轮做完了，任务自动完成。"), "system"),
    ]);
    const items = chatItems(state, CONV);
    const decor = zoomDecor(state, CONV, items);
    expect(decor.spines).toEqual([]);
    expect(decor.bands).toEqual([]);
    expect([...decor.left]).toEqual([[items[0]!.id, { kind: "task", taskId: "t-9", no: undefined, summary: "下载《晴天》的音频", live: false }]]);
    expect(zoomTaskFacts(state, "t-9", items)).toEqual({
      title: "任务",
      live: false,
      rows: [
        ["你交代的", "搜一下周杰伦《晴天》，把音频下载成 mp3"],
        ["计划", "无计划"],
      ],
    });
  });
});

function secretaryMessage(seq: number, time: string, parts: MessagePart[], speaker: MessageEnvelope["speaker"] = "agent"): EventFrame {
  const message: MessageEnvelope = { id: `s${seq}`, conversation: "secretary", speaker, time, parts };
  return frame("secretary", seq, "message", checked(checkMessage, "消息事件", { message }));
}

/** 一次直接做的通用 bash（标注只有"通用 bash"） */
const bash = (callId: string): MessagePart => ({
  type: "tool_call",
  callId,
  tool: "bash",
  argsSummary: "ls | wc -l",
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: true,
  outcome: "done",
});

describe("构造：秘书主线按天、×N", () => {
  test("秘书主线每天一块底色，相邻的深浅错开，分段和全局层的按天一样；秘书主线没有左边的卡、没有书脊", () => {
    const state = replay([
      secretaryMessage(1, "2026-10-07T21:00:00+08:00", say("晚上好"), "user"),
      secretaryMessage(2, "2026-10-07T21:00:05+08:00", say("晚上好")),
      secretaryMessage(3, "2026-10-08T08:00:00+08:00", say("早"), "user"),
      secretaryMessage(4, "2026-10-09T09:30:00+08:00", say("今天做什么"), "user"),
      secretaryMessage(5, "2026-10-09T09:30:03+08:00", say("先看待办")),
    ]);
    expect(bandsOf(state, "secretary")).toEqual(["10月7日 0-1 n0", "10月8日 2-2 n1", "10月9日 3-4 n0"]);
    expect(globalView(state, "secretary").map((b) => b.title)).toEqual(["10 月 7 日", "10 月 8 日", "10 月 9 日"]);
    const items = chatItems(state, "secretary");
    const decor = zoomDecor(state, "secretary", items);
    expect(decor.left.size).toBe(0);
    expect(decor.spines).toEqual([]);
  });

  test("连着几块的标注一模一样，只在第一块标、写 ×N：组里三次通用 bash、一段思考（不打断）、又一次通用 bash 是 ×4；中间隔着回复就断开", () => {
    const state = replay([
      secretaryMessage(1, "2026-10-09T09:00:00+08:00", say("数一数文件"), "user"),
      secretaryMessage(2, "2026-10-09T09:00:01+08:00", [bash("b1"), bash("b2"), bash("b3")]),
      secretaryMessage(3, "2026-10-09T09:00:02+08:00", [{ type: "reasoning", text: "再数一次" }]),
      secretaryMessage(4, "2026-10-09T09:00:03+08:00", [bash("b4")]),
      secretaryMessage(5, "2026-10-09T09:00:04+08:00", say("一共 12 个")),
      secretaryMessage(6, "2026-10-09T09:00:05+08:00", [bash("b5")]),
    ]);
    const items = chatItems(state, "secretary");
    const rects = zoomRects(items);
    expect(rects.map((r) => `${r.content}${r.marks.length ? `:${r.marks.length}` : ""}`)).toEqual(["user", "tool:1", "tool:1", "tool:1", "thinking", "tool:1", "reply", "tool:1"]);
    const repeats = zoomDecor(state, "secretary", items).repeats;
    expect(rects.map((r) => repeats.get(r.id))).toEqual([undefined, 4, 0, 0, undefined, 0, undefined, undefined]);
  });
});
