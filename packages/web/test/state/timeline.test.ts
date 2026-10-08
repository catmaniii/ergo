// 时间线的缩放（25 号票）录不出来的边角，手写事件序列回放：秘书主线跨天（守护进程的消息时间是真钟，录不出跨天）、
// 项目维护者的工单段和对话段（16 号票还没做，按共享协议的工单分隔 part 构造）、范围变更和越界（18 号票还没做）、
// 偏离（14 号票还没做）——这几种记录按共享协议 timeline.ts 的 schema 构造，先过 schema 校验。
// 还有快速动作的操作记录（21 号票转来：时间线上可见，按凭什么执行的取样式；彻底删除时跟着卡片换掉原话），
// 往上翻取回的旧页里的记录，活动状态的说明和进度、断线重连后按序号补齐。
import { HistoryPage as HistoryPageSchema, schemaChecker, TimelineRecordEventPayload } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  activityNote,
  agentActivity,
  boardGroups,
  type EventFrame,
  gistView,
  globalView,
  type HistoryPage,
  type MessageEnvelope,
  type MessagePart,
  opReasonOf,
  opStyleOf,
  PURGED_TEXT,
  projectViews,
  replay,
  TIMELINE_TONE_COUNT,
  timelineGrouping,
  timelineItems,
  type TimelineRecordEventPayload as RecordPayload,
  type UiInput,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const checkRecord = schemaChecker(TimelineRecordEventPayload);
/** 按共享协议的 schema 构造的时间线记录事件负载（不合 schema 就让测试先红） */
function checked(payload: RecordPayload): RecordPayload {
  const problem = checkRecord.firstError(payload);
  if (problem) throw new Error(`构造的时间线记录不合 schema：${problem}`);
  return payload;
}
const recordFrame = (channel: string, seq: number, payload: RecordPayload): EventFrame => frame(channel, seq, "timeline_record", checked(payload));

function message(id: string, conversation: MessageEnvelope["conversation"], time: string, parts: MessagePart[], speaker: MessageEnvelope["speaker"] = "agent"): MessageEnvelope {
  return { id, conversation, speaker, time, parts };
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
function tool(callId: string, overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: "tool_call", callId, tool: "write", argsSummary: "a.md", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", ...overrides };
}

/** 一张已执行的快速动作卡和它的操作记录（basis 不给就是 25 号票之前的记录） */
function quickAction(
  conversation: string,
  seq: number,
  cardSeq: number,
  o: { id: string; title: string; explicit: boolean; basis?: "explicit" | "within_grant" | "confirmed"; categories?: string[]; disposition?: string; handledAt: string },
): EventFrame[] {
  const action = { type: "remember", params: {} };
  return [
    frame("cards", cardSeq, "card", {
      card: card(`qa-${o.id}`, 2, {
        status: "handled",
        handledAt: o.handledAt,
        payload: { actionId: o.id, conversation, action, name: "记住", title: o.title, explicit: o.explicit, categories: o.categories ?? [], disposition: o.disposition ?? "do", result: "记住了" },
      }),
    }),
    frame(conversation, seq, "quick_action_executed", {
      actionId: o.id,
      action,
      name: "记住",
      title: o.title,
      explicit: o.explicit,
      ...(o.basis ? { basis: o.basis } : {}),
      cardId: `qa-${o.id}`,
      result: { ok: true, summary: "记住了" },
    }),
  ];
}

describe("工具调用的三种样式和更细的说法（opStyleOf、opReasonOf）", () => {
  test.each([
    ["直接做的", {}, null, null],
    ["授权内放行", { withinGrant: true, categoryTitles: ["越出项目目录"] }, "granted", "granted"],
    ["计划里列了、在授权内", { disposition: "planned_only", withinGrant: true }, "granted", "granted"],
    ["做完告诉我", { disposition: "do_then_tell" }, "notify", "notify"],
    ["做完告诉我、也在授权内", { disposition: "do_then_tell", withinGrant: true }, "notify", "notify"],
    ["先问过、批准后执行", { disposition: "ask_first" }, "stopped", "asked"],
    ["计划里没列，当场问的", { disposition: "planned_only" }, "stopped", "asked"],
    ["交给我做", { disposition: "hand_to_me", outcome: "blocked" }, "stopped", "blocked"],
    ["永不", { disposition: "never", outcome: "blocked" }, "stopped", "blocked"],
    ["硬拒绝", { blockedBy: "hard_refusal", outcome: "blocked" }, "stopped", "blocked"],
    ["按规则退回", { blockedBy: "pull_back", outcome: "blocked", withinGrant: false }, "stopped", "blocked"],
    ["你拒绝了", { disposition: "ask_first", outcome: "denied" }, "stopped", "blocked"],
  ] as const)("%s", (_name, overrides, style, reason) => {
    const part = tool("c", overrides as Partial<ToolCallPart>);
    expect(opStyleOf(part) ?? null).toBe(style);
    expect(opReasonOf(part) ?? null).toBe(reason);
  });
});

describe("秘书主线：全局层按天聚色块", () => {
  const S = "secretary";
  const inputs: Array<EventFrame | UiInput> = [
    frame(S, 1, "message", { message: message("m1", S, "2026-10-06T09:00:00.000+08:00", [text("周一早")], "user") }),
    frame(S, 2, "message", { message: message("m2", S, "2026-10-06T09:00:05.000+08:00", [text("早")]) }),
    frame(S, 3, "message", { message: message("m3", S, "2026-10-07T21:00:00.000+08:00", [text("帮我跑个脚本")], "user") }),
    frame(S, 4, "message", { message: message("m4", S, "2026-10-07T21:00:03.000+08:00", [tool("c1", { tool: "bash", argsSummary: "node calc.js", genericBash: true })]) }),
    frame(S, 5, "message", { message: message("m5", S, "2026-10-07T21:00:04.000+08:00", [tool("c2", { tool: "read", argsSummary: "D:\\notes\\a.txt", categoryTitles: ["越出项目目录"], disposition: "ask_first", outcome: "denied" })]) }),
    frame(S, 6, "message", { message: message("m6", S, "2026-10-08T08:00:00.000+08:00", [text("记住下周三体检")], "user") }),
    frame(S, 7, "message", { message: message("m7", S, "2026-10-08T08:00:02.000+08:00", [{ type: "card_ref", cardId: "qa-a1" }]) }),
    // 推断出来、先问过，用户在卡上点了执行（操作记录在动作提出的会话频道上，时间取卡片处理的时间）
    ...quickAction(S, 8, 1, { id: "a1", title: "记住：下周三体检", explicit: false, basis: "confirmed", categories: ["使用授权范围外的记忆"], disposition: "ask_first", handledAt: "2026-10-08T08:00:30.000+08:00" }),
    // 用户点明了的：直接执行
    ...quickAction(S, 9, 2, { id: "a2", title: "下周一不上班", explicit: true, basis: "explicit", handledAt: "2026-10-08T08:05:00.000+08:00" }),
    // 推断出来、处置是直接做（在已有授权内）：直接执行
    ...quickAction(S, 10, 3, { id: "a3", title: "记住：喜欢靠窗", explicit: false, basis: "within_grant", handledAt: "2026-10-08T08:06:00.000+08:00" }),
    // 25 号票之前的操作记录：没写凭什么执行的，推断出来的不知道
    ...quickAction(S, 11, 4, { id: "a4", title: "记住：早年的", explicit: false, handledAt: "2026-10-08T08:07:00.000+08:00" }),
  ];
  const state = replay(inputs);

  test("秘书主线按天分组；每块写明是哪天、几条，块上仍标出通用 bash、关注类别命中、问过的操作和操作记录", () => {
    expect(timelineGrouping(state, S)).toBe("day");
    const blocks = globalView(state, S);
    expect(blocks.map((b) => [b.title, b.count])).toEqual([
      ["10 月 6 日", 2],
      ["10 月 7 日", 3],
      ["10 月 8 日", 6],
    ]);
    expect(new Set(blocks.map((b) => b.tone)).size).toBe(3);
    expect(blocks.every((b) => b.tone >= 0 && b.tone < TIMELINE_TONE_COUNT)).toBe(true);
    expect(blocks[0]!.marks).toEqual([]);
    expect(blocks[1]!.marks.map((m) => [m.kind, m.genericBash, m.style ?? null, m.reason ?? null, m.outcome ?? null, m.categories])).toEqual([
      ["tool", true, null, null, null, []],
      ["tool", false, "stopped", "blocked", "你拒绝了", ["越出项目目录"]],
    ]);
  });

  test("操作记录按凭什么执行的取样式：点明的、确认后的算问过或用户决定的，授权内的算授权内；之前的推断记录没有样式", () => {
    const marks = globalView(state, S)[2]!.marks;
    expect(marks.map((m) => [m.kind, m.title, m.style ?? null, m.reason ?? null, m.outcome, m.categories])).toEqual([
      ["operation", "记住：下周三体检", "stopped", "confirmed", "记住了", ["使用授权范围外的记忆"]],
      ["operation", "下周一不上班", "stopped", "explicit", "记住了", []],
      ["operation", "记住：喜欢靠窗", "granted", "granted", "记住了", []],
      ["operation", "记住：早年的", null, null, "记住了", []],
    ]);
  });

  test("操作记录在时间线上可见：完整视图里按序号排在动作卡之后，时间取卡片处理的时间", () => {
    const items = timelineItems(state, S);
    expect(items.map((it) => it.kind)).toEqual(["message", "message", "message", "message", "message", "message", "message", "record", "record", "record", "record"]);
    expect(items[7]).toMatchObject({ kind: "record", time: "2026-10-08T08:00:30.000+08:00", record: { type: "operation", operation: { title: "记住：下周三体检", result: { ok: true } } } });
    expect(items[8]).toMatchObject({ kind: "record", time: "2026-10-08T08:05:00.000+08:00", record: { type: "operation", operation: { title: "下周一不上班" } } });
  });

  test("要点层只留通用 bash、关注类别命中、问过的操作和操作记录（每次执行都标出），其余收起、写明几条、带着收起的第一条", () => {
    const rows = gistView(state, S);
    expect(rows.map((r) => (r.kind === "folded" ? `收起 ${r.count}` : r.marks.map((m) => `${m.kind}:${m.title}`).join("|")))).toEqual([
      "收起 3",
      "tool:bash node calc.js",
      "tool:read D:\\notes\\a.txt",
      "收起 2",
      "operation:记住：下周三体检",
      "operation:下周一不上班",
      "operation:记住：喜欢靠窗",
      "operation:记住：早年的",
    ]);
    expect(rows.flatMap((r) => (r.kind === "folded" ? [r.itemKey] : []))).toEqual(["m1", "m6"]);
  });

  test("彻底删除：快速动作卡换成去掉原话的新版本，操作记录跟着换掉标题、参数和结果", () => {
    const purged = replay(
      [
        frame("cards", 5, "card", {
          card: card("qa-a1", 3, {
            status: "handled",
            handledAt: "2026-10-08T08:00:30.000+08:00",
            payload: { actionId: "a1", conversation: S, action: { type: "remember", params: null }, name: "记住", title: `记住：${PURGED_TEXT}`, explicit: false, categories: [], disposition: "ask_first", result: PURGED_TEXT },
          }),
        }),
      ],
      state,
    );
    const item = timelineItems(purged, S).find((it) => it.kind === "record" && it.record.type === "operation" && it.record.operation.actionId === "a1");
    expect(item).toMatchObject({ record: { operation: { title: `记住：${PURGED_TEXT}`, action: { params: null }, result: { summary: PURGED_TEXT } } } });
    // （用户的原话那条消息由 messages_purged 换成标记，这里没有发）
    expect(JSON.stringify(purged.conversations[S]!.records)).not.toContain("下周三体检");
  });
});

const divider = (workOrderId: string, title: string): MessagePart => ({ type: "work_order_divider", workOrderId, title, from: workOrderId ? "任务 t-3" : "你" });
/** 10 点几分几秒 */
const T = (s: string) => `2026-10-08T10:${s}.000+08:00`;
/** 11 点几分几秒 */
const T11 = (s: string) => `2026-10-08T11:${s}.000+08:00`;

describe("项目维护者的会话：全局层按工单段聚色块，对话段也各成一块；范围变更和越界单独标出", () => {
  const PM = "maintainer:pm-1";
  const project = {
    id: "p-1",
    name: "家庭网盘",
    goal: "把照片收拢",
    state: "in_use",
    origin: "suggestion",
    maintainerId: "pm-1",
    workdir: { external: false },
    charterConfirmed: true,
    createdAt: "2026-10-01T09:00:00.000+08:00",
    updatedAt: "2026-10-01T09:00:00.000+08:00",
  };
  const inputs: Array<EventFrame | UiInput> = [
    frame("projects", 1, "project", { project, change: "created", from: null, by: "user" }),
    // 立项问答（16 号票之前没有分隔线）
    frame(PM, 1, "message", { message: message("p1", PM, T("00:00"), [text("这个项目做什么？")], "user"), projectId: "p-1" }),
    frame(PM, 2, "message", { message: message("p2", PM, T("00:10"), [text("先问几个问题")]), projectId: "p-1" }),
    // 第一张工单
    frame(PM, 3, "message", { message: message("p3", PM, T("01:00"), [divider("W-1", "扫描重复照片")], "system"), projectId: "p-1", taskId: "t-3" }),
    frame(PM, 4, "message", { message: message("p4", PM, T("01:10"), [tool("c1", { tool: "bash", argsSummary: "fdupes -r .", genericBash: true })]), projectId: "p-1", taskId: "t-3" }),
    recordFrame(PM, 5, { record: { id: "sr-1", kind: "out_of_scope", summary: "顺手整理了文档目录（立项书没写）", time: T("01:20"), workOrderId: "W-1" }, projectId: "p-1", taskId: "t-3" }),
    // 用户直接对它说话：对话段
    frame(PM, 6, "message", { message: message("p6", PM, T("02:00"), [divider("", "先帮我看下相册")], "system"), projectId: "p-1" }),
    frame(PM, 7, "message", { message: message("p7", PM, T("02:01"), [text("先帮我看下相册")], "user"), projectId: "p-1" }),
    recordFrame(PM, 8, { record: { id: "sr-2", kind: "scope_change", summary: "看了相册（你在会话里让做的）", time: T("02:10") }, projectId: "p-1" }),
    // 第二张工单
    frame(PM, 9, "message", { message: message("p9", PM, T("03:00"), [divider("W-2", "出清单")], "system"), projectId: "p-1", taskId: "t-3" }),
    frame(PM, 10, "message", { message: message("p10", PM, T("03:05"), [tool("c2", { tool: "move_files", argsSummary: "回收区", categoryTitles: ["删除或覆盖"], disposition: "do_then_tell" })]), projectId: "p-1", taskId: "t-3" }),
    // 新前端还不认识的记录：完整视图里照样显示，要点层不收
    recordFrame(PM, 11, { record: { id: "x-1", kind: "something_new", summary: "以后的票加的记录", time: T("03:06") }, projectId: "p-1" }),
  ];
  const state = replay(inputs);

  test("项目维护者的会话按段：开头的立项问答、工单 W-1、对话段、工单 W-2 各一块，块上标出越界、范围变更和做完告诉我的操作", () => {
    expect(timelineGrouping(state, PM)).toBe("segment");
    const blocks = globalView(state, PM);
    expect(blocks.map((b) => [b.title, b.count])).toEqual([
      ["对话段", 2],
      ["工单 W-1 · 扫描重复照片", 3],
      ["对话段 · 先帮我看下相册", 3],
      ["工单 W-2 · 出清单", 3],
    ]);
    expect(blocks.map((b) => b.marks.map((m) => [m.kind, m.style ?? null, m.severity ?? null]))).toEqual([
      [],
      [
        ["tool", null, null],
        ["out_of_scope", null, "alert"],
      ],
      [["scope_change", null, "info"]],
      [["tool", "notify", null]],
    ]);
    // 工单段和对话段的颜色分开，都在色板里
    expect(blocks[1]!.tone).not.toBe(blocks[2]!.tone);
    expect(blocks.every((b) => b.tone >= 0 && b.tone < TIMELINE_TONE_COUNT)).toBe(true);
  });

  test("要点层：越界、范围变更各自成一条要点，写着摘要；不认识的记录不进要点层，完整视图里照样有", () => {
    const marks = gistView(state, PM).flatMap((r) => (r.kind === "marks" ? r.marks : []));
    expect(marks.map((m) => [m.kind, m.title])).toEqual([
      ["tool", "bash fdupes -r ."],
      ["out_of_scope", "顺手整理了文档目录（立项书没写）"],
      ["scope_change", "看了相册（你在会话里让做的）"],
      ["tool", "move_files 回收区"],
    ]);
    expect(timelineItems(state, PM).flatMap((it) => (it.kind === "record" && it.record.type === "timeline" ? [it.record.timeline.kind] : []))).toEqual(["out_of_scope", "scope_change", "something_new"]);
  });
});

describe("任务的维护者会话：偏离记录（14 号票）进要点层，并落在它所在阶段的色块上", () => {
  const TM = "maintainer:tm-5";
  const task = {
    id: "t-5",
    title: "换路由器",
    summary: "换路由器",
    state: "running",
    origin: "button",
    maintainerId: "tm-5",
    projects: [],
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    stages: {
      total: 2,
      current: 2,
      list: [
        { stageId: "s1", title: "比价", state: "accepted", dependsOn: [], acceptance: [], attempts: 1 },
        { stageId: "s2", title: "下单", state: "running", dependsOn: ["s1"], acceptance: [], attempts: 0 },
      ],
    },
  };
  const state = replay([
    frame("board", 1, "task", { task, change: "created", from: null, by: "user" }),
    frame(TM, 1, "message", { message: message("t1", TM, T11("00:00"), [text("任务书")], "system"), taskId: "t-5" }),
    frame(TM, 2, "message", { message: message("t2", TM, T11("01:00"), [text("开始执行")], "system"), taskId: "t-5", stageId: "s1" }),
    recordFrame(TM, 3, { record: { id: "dv-1", kind: "deviation", summary: "计划外：多查了一家店的价格（在授权范围内）", time: T11("01:30") }, taskId: "t-5", stageId: "s1" }),
    frame(TM, 4, "message", { message: message("t4", TM, T11("02:00"), [text("比价做完了")]), taskId: "t-5", stageId: "s2" }),
  ]);

  test("全局层：规划、第 1 阶段、第 2 阶段各一块，偏离标在第 1 阶段上；要点层只剩这条偏离", () => {
    expect(timelineGrouping(state, TM)).toBe("stage");
    const blocks = globalView(state, TM);
    expect(blocks.map((b) => [b.title, b.count, b.marks.map((m) => [m.kind, m.severity])])).toEqual([
      ["规划", 1, []],
      ["第 1 阶段 · 比价", 2, [["deviation", "notice"]]],
      ["第 2 阶段 · 下单", 1, []],
    ]);
    expect(gistView(state, TM).flatMap((r) => (r.kind === "marks" ? r.marks.map((m) => m.title) : [`收起 ${r.count}`]))).toEqual(["收起 2", "计划外：多查了一家店的价格（在授权范围内）", "收起 1"]);
  });
});

describe("往上翻：旧页里的时间线记录跟着那一页回来，三层都看得到", () => {
  const TM = "maintainer:tm-7";
  const scope = { taskId: "t-7", stageId: "s1" };
  const msgAt = (seq: number) => ({ seq, message: message(`h${seq}`, TM, T11(`${String(seq).padStart(2, "0")}:00`), [text(`第 ${seq} 条`)]), ...scope });
  // WebSocket 上只补发了最近一页（序号 5 起）
  const live: Array<EventFrame | UiInput> = [
    frame(TM, 5, "message", { message: message("h5", TM, T11("05:00"), [text("第 5 条")]), ...scope }),
    recordFrame(TM, 6, { record: { id: "dv-new", kind: "deviation", summary: "最近一页里的偏离", time: T11("05:30") }, ...scope }),
    frame(TM, 7, "message", { message: message("h7", TM, T11("07:00"), [text("第 7 条")]), ...scope }),
  ];
  const page: HistoryPage = {
    conversation: TM,
    messages: [msgAt(1), msgAt(3), msgAt(4)],
    records: [
      { seq: 2, type: "timeline_record", payload: checked({ record: { id: "dv-old", kind: "deviation", summary: "旧页里的偏离", time: T11("01:30") }, ...scope }) },
      // 和手里已有的重叠的（交界处）：不重复
      { seq: 6, type: "timeline_record", payload: checked({ record: { id: "dv-new", kind: "deviation", summary: "最近一页里的偏离", time: T11("05:30") }, ...scope }) },
    ],
    hasMore: false,
  };

  test("翻回来之前要点层只有最近一页的偏离；翻回来之后旧页里的偏离按序号排在前面，全局层落在同一阶段的色块上", () => {
    expect(schemaChecker(HistoryPageSchema).firstError(page)).toBeUndefined();
    const before = replay(live);
    expect(gistView(before, TM).flatMap((r) => (r.kind === "marks" ? r.marks.map((m) => m.title) : []))).toEqual(["最近一页里的偏离"]);

    const after = replay([{ kind: "history_page", conversation: TM, page }], before);
    expect(timelineItems(after, TM).map((it) => it.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(gistView(after, TM).flatMap((r) => (r.kind === "marks" ? r.marks.map((m) => m.title) : [`收起 ${r.count}`]))).toEqual(["收起 1", "旧页里的偏离", "收起 3", "最近一页里的偏离", "收起 1"]);
    const blocks = globalView(after, TM);
    expect(blocks.map((b) => [b.title, b.count, b.marks.map((m) => m.title)])).toEqual([["阶段 s1", 7, ["旧页里的偏离", "最近一页里的偏离"]]]);
  });
});

describe("活动状态：说明、干活中的进度、断线重连后按序号补齐", () => {
  const A = "activity";
  const task = {
    id: "t-1",
    title: "X 的调研",
    summary: "X 的调研",
    state: "running",
    origin: "button",
    maintainerId: "tm-1",
    projects: [],
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
  };
  const project = {
    id: "p-1",
    name: "家庭网盘",
    goal: "把照片收拢",
    state: "in_use",
    origin: "suggestion",
    maintainerId: "pm-1",
    workdir: { external: false },
    charterConfirmed: true,
    createdAt: "2026-10-01T09:00:00.000+08:00",
    updatedAt: "2026-10-01T09:00:00.000+08:00",
  };
  const since = "2026-10-08T09:00:00.000+08:00";
  const handling = { kind: "handling_input" } as const;
  const approval = { kind: "approval", tool: "读文件" } as const;
  const calling = { kind: "calling_tool", tool: "写文件" } as const;
  const base = [
    frame("board", 1, "task", { task, change: "created", from: null, by: "user" }),
    frame("projects", 1, "project", { project, change: "created", from: null, by: "user" }),
    frame(A, 1, "activity", { agentId: "tm-1", state: "working", since, detail: handling }),
    frame(A, 2, "activity", { agentId: "pm-1", state: "waiting_for_user", since, detail: approval }),
  ];

  test("干活中的进度（临时事件）盖过落盘的说明；状态变了以落盘的为准；不在干活中的不收进度；说明的文字由协议包的表生成", () => {
    const working = replay([...base, frame(A, 2, "activity_progress", { agentId: "tm-1", detail: calling })]);
    expect(agentActivity(working, "tm-1")).toEqual({ state: "working", detail: calling });
    expect(activityNote(agentActivity(working, "tm-1"))).toBe("调用：写文件");
    expect(boardGroups(working)[1]!.items[0]).toMatchObject({ kind: "task", activity: { state: "working", detail: calling } });
    // 等你的 agent 不收进度
    expect(agentActivity(replay([...base, frame(A, 2, "activity_progress", { agentId: "pm-1", detail: calling })]), "pm-1")).toEqual({ state: "waiting_for_user", detail: approval });
    // 项目列表上的小圆点：维护者等你
    expect(projectViews(working)[0]).toMatchObject({ activity: { state: "waiting_for_user", detail: approval } });
    expect(activityNote(projectViews(working)[0]!.activity)).toBe("等你批准：读文件");
    const after = replay([frame(A, 3, "activity", { agentId: "tm-1", state: "sleeping", since, detail: { kind: "idle" } })], working);
    expect(agentActivity(after, "tm-1")).toEqual({ state: "sleeping", detail: { kind: "idle" } });
    // 比已收到的落盘事件旧的进度（迟到的）丢掉
    expect(agentActivity(replay([frame(A, 2, "activity_progress", { agentId: "tm-1", detail: { kind: "replying", chars: 9 } })], after), "tm-1")).toEqual({ state: "sleeping", detail: { kind: "idle" } });
  });

  test("断线重连：服务端按序号补发断线期间的活动状态事件，重复的丢掉，小圆点是最新的；重新同步清掉活动状态（回到默认的休眠）", () => {
    const state = replay([
      ...base,
      { kind: "connection", status: "offline" },
      { kind: "connection", status: "connecting" },
      frame(A, 2, "activity", { agentId: "pm-1", state: "waiting_for_user", since, detail: approval }),
      frame(A, 3, "activity", { agentId: "pm-1", state: "working", since, detail: handling }),
      frame(A, 4, "activity", { agentId: "tm-1", state: "sleeping", since, detail: { kind: "idle_exit" } }),
      { kind: "connection", status: "online" },
    ]);
    expect(agentActivity(state, "pm-1")).toEqual({ state: "working", detail: handling });
    expect(boardGroups(state)[1]!.items[0]).toMatchObject({ activity: { state: "sleeping", detail: { kind: "idle_exit" } } });
    expect(agentActivity(replay([{ kind: "resync", channel: A }], state), "tm-1")).toEqual({ state: "sleeping" });
    // 没收到过活动状态的维护者：休眠
    expect(agentActivity(initialState(), "pm-9")).toEqual({ state: "sleeping" });
  });
});

function initialState() {
  return replay([]);
}
