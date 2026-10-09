// 会话条目层（52 号票）：照 AgentSense 的 ChatItem，把会话拆成条目——用户消息、思考、回复、工具调用组（含出了状况的调用）、
// 卡片、系统说明、时间线记录、工单分隔、语音。先回放主切面录下的真实事件流（秘书会话、任务的维护者会话、项目的维护者会话），
// 录像覆盖不到的情形（思考并进组、各种状况、内部工具、换 agent、往上翻、乐观显示……）按共享协议的 schema 构造事件。
import fs from "node:fs";
import path from "node:path";
import { HistoryPage as HistoryPageSchema, MessageEventPayload as MessageEventPayloadSchema, schemaChecker, TimelineRecordEventPayload as TimelineRecordSchema } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  type CallIssue,
  type ChatItem,
  chatItems,
  type EventFrame,
  type HistoryPage,
  gistView,
  INTERNAL_TOOLS,
  isInternalTool,
  locateChatItem,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  replay,
  type TimelineRecordEventPayload,
  type UiInput,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const checkMessage = schemaChecker(MessageEventPayloadSchema);
const checkRecord = schemaChecker(TimelineRecordSchema);
/** 按共享协议的 schema 构造的事件负载（不合 schema 就让测试先红） */
function checked<T>(check: { firstError(v: unknown): string | undefined }, payload: T): T {
  const problem = check.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return payload;
}

const TM = "maintainer:tm-9";
/** 10 点几分几秒 */
const at = (s: string) => `2026-10-09T10:${s}.000+08:00`;

/** 会话里的一条消息事件（归属摊开带着） */
function messageFrame(seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[], extra: Omit<MessageEventPayload, "message"> = {}, conversation: MessageEnvelope["conversation"] = TM): EventFrame {
  const payload: MessageEventPayload = { message: { id, conversation, speaker, time: at(`00:${String(seq).padStart(2, "0")}`), parts }, ...extra };
  return frame(conversation, seq, "message", checked(checkMessage, payload));
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
const reasoning = (t: string): MessagePart => ({ type: "reasoning", text: t });
function tool(callId: string, overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: "tool_call", callId, tool: "write", argsSummary: `${callId}.md`, categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", ...overrides };
}
/** 一次工具调用单独一条消息（守卫在调用结束时追加的） */
const callFrame = (seq: number, callId: string, overrides: Partial<ToolCallPart> = {}, extra: Omit<MessageEventPayload, "message"> = {}) => messageFrame(seq, `m-${callId}`, "agent", [tool(callId, overrides)], extra);

/** 时间线记录事件 */
const recordFrame = (seq: number, payload: TimelineRecordEventPayload) => frame(TM, seq, "timeline_record", checked(checkRecord, payload));
/** 一张某种类型的卡片（卡片频道上），和会话里引用它的系统消息 */
const cardFrames = (cardSeq: number, seq: number, id: string, type: string): EventFrame[] => [
  frame("cards", cardSeq, "card", { card: card(`c-${id}`, 1, { type, text: `${type} 卡` }) }),
  messageFrame(seq, id, "system", [{ type: "card_ref", cardId: `c-${id}` }]),
];

/** 一条的样子：种类，工具调用组带上算进 N 的工具名 */
function shape(item: ChatItem): string {
  return item.kind === "tool_group" ? `tool_group[${item.calls.map((c) => c.part.tool).join(",")}]` : item.kind;
}

/** 组里的每一步：思考写"思考"，调用写工具名（顺利执行的内部工具标出来） */
function steps(item: ChatItem | undefined): string[] {
  if (item?.kind !== "tool_group") throw new Error("这一条应当是工具调用组");
  return item.steps.map((s) => (s.kind === "thinking" ? "思考" : `${s.call.part.tool}${s.call.counted ? "" : "（内部）"}`));
}

/** 组上出了状况的计数，比如 ["blocked×1"] */
function issues(item: ChatItem | undefined): string[] {
  if (item?.kind !== "tool_group") throw new Error("这一条应当是工具调用组");
  return item.issues.map((i) => `${i.issue}×${i.count}`);
}

/** 回放之后各条的 id */
const idsAfter = (inputs: Array<EventFrame | UiInput>) => chatItems(replay(inputs), TM).map((it) => it.id);

describe("回放：任务的维护者会话（timeline-zoom）", () => {
  // 录制在 packages/daemon/test/main/timeline.test.ts：两阶段任务，第一阶段里写文件、通用 bash（ls）、授权内的建目录（bash）、
  // 做完告诉我的提交、问过的读主目录（审批卡、批准）、脚本验收；第二阶段写报告、写围栏外被硬拒绝、脚本验收
  const state = replay(load("timeline-zoom"));
  const items = chatItems(state, "maintainer:tm-1");

  test("切法：两段话之间的调用按先后成一组，出了状况的（问过、被拦下）也在组里；审批卡隔开组；换了阶段另起一组；内部工具不显示", () => {
    expect(items.map(shape)).toEqual([
      "system",
      "card",
      "reply",
      "system",
      "tool_group[write,bash,bash,git_commit]",
      "card",
      "tool_group[read]",
      "system",
      "card",
      "tool_group[write,write]",
      "system",
      "card",
      "system",
      "reply",
    ]);
    expect(items.filter((it) => it.kind === "tool_group").map(issues)).toEqual([[], ["asked×1"], ["blocked×1"]]);
  });

  test("内部工具（提交计划、宣布阶段完成）不显示：挂在代表它的卡片上（计划卡、那个阶段的验收卡），按调用的 id 找得到", () => {
    const attached = items.map((it) => it.internalCalls.map((c) => `${c.part.tool}${c.scope.stageId ? `@${c.scope.stageId}` : ""}`));
    expect(attached).toEqual([[], ["submit_plan"], [], [], [], [], [], [], ["complete_stage@s1"], [], [], ["complete_stage@s2"], [], []]);
    const plan = items[1]!;
    const call = plan.internalCalls[0]!;
    expect([call.internal, call.counted]).toEqual([true, false]);
    expect(locateChatItem(items, call.id)).toEqual({ item: plan, call });
  });

  test("要点层那一行和性质色：组写调了几个、哪几种工具和出的状况，性质色取组里最显眼的", () => {
    const tmp = /^<临时目录>\\ergou-home-[^\\]+\\/;
    expect(items.map((it) => [it.keyLine, it.tone ?? null])).toEqual([
      ["系统：任务书：任务 t-1「整理笔记和报告」", null],
      ["计划：整理笔记和报告（第 1 版，2 个阶段，约 320000 token） · 已处理", null],
      ["回复：计划交上去了", null],
      ["系统：计划已确认，开始执行任务 t-1「整理笔记和报告」。", null],
      ["调用了 4 个工具：write、bash ×2、git_commit", "notify"],
      [expect.stringMatching(/^审批（任务「整理笔记和报告」）：读文件「.+readme\.txt」 · 越出项目目录 · 已处理$/), null],
      ["调用了 1 个工具：read（1 次问过你）", "stopped"],
      ["系统：维护者宣布阶段 s1「整理笔记」完成（第 1 次）：笔记在 notes.md", null],
      ["验收通过（脚本检查）：任务「整理笔记和报告」第 1/2 阶段「整理笔记」。验收通过。", null],
      ["调用了 2 个工具：write ×2（1 次被拦下）", "stopped"],
      ["系统：维护者宣布阶段 s2「写报告」完成（第 1 次）：报告在 report.md", null],
      ["验收通过（脚本检查）：任务「整理笔记和报告」第 2/2 阶段「写报告」。验收通过。", null],
      ["系统：全部阶段验收通过，任务完成。", null],
      ["回复：两个阶段都做完了", null],
    ]);
    const troubled = items.flatMap((it) => (it.kind === "tool_group" ? it.calls.filter((c) => c.issue !== undefined) : []));
    expect(troubled.map((c) => [c.issue, c.outcome ?? null, c.part.argsSummary.replace(tmp, "")])).toEqual([
      ["asked", null, "readme.txt"],
      ["blocked", "硬拒绝", "outside.md"],
    ]);
  });

  test("两侧标注：每条带着自己的要点（25 号票 marksOf 推出的），合起来和原来要点层的一样，一个不多一个不少", () => {
    expect(items.map((it) => it.marks.map((m) => (m.kind === "tool" ? `${m.toolCall!.tool}${m.style ? `[${m.style}]` : ""}${m.genericBash ? "{通用 bash}" : ""}` : m.kind)))).toEqual([
      [],
      [],
      [],
      [],
      ["bash{通用 bash}", "bash[granted]{通用 bash}", "git_commit[notify]"],
      ["approval"],
      ["read[stopped]"],
      [],
      ["acceptance"],
      ["write[stopped]"],
      [],
      ["acceptance"],
      [],
      [],
    ]);
    expect(items.flatMap((it) => it.marks)).toEqual(gistView(state, "maintainer:tm-1").flatMap((r) => (r.kind === "marks" ? r.marks : [])));
  });

  test("内容类型和详情：用户、思考、回复、说明能看文本详情，组、卡片各有各的详情", () => {
    expect(items.map((it) => `${it.content}/${it.detail ?? "-"}`)).toEqual([
      "context/text",
      "plan/card",
      "reply/text",
      "context/text",
      "tool/tool_group",
      "plan/card",
      "tool/tool_group",
      "context/text",
      "plan/card",
      "tool/tool_group",
      "context/text",
      "plan/card",
      "context/text",
      "reply/text",
    ]);
    // 归属跟着消息走：组落在它的阶段里
    expect(items.filter((it) => it.kind === "tool_group").map((it) => it.scope.stageId ?? null)).toEqual(["s1", "s1", "s2"]);
  });
});

describe("回放：任务里你拒绝了（task-rejections）", () => {
  // 录制在 packages/daemon/test/main/deviation.test.ts：授权内建了一个目录，之后五次要越出项目目录的建目录都被你拒绝，
  // 第五次之后任务先暂停（时间线上一条偏离），你让它继续
  const items = chatItems(replay(load("task-rejections")), "maintainer:tm-1");

  test("授权内的那次成组；每次审批卡一条、被你拒绝的那次调用一组（1 次你拒绝了）；暂停的偏离记录一条；提交计划挂在计划卡上", () => {
    const denied = ["card", "tool_group[bash]"];
    expect(items.map(shape)).toEqual(["system", "card", "reply", "system", "tool_group[bash]", ...denied, ...denied, ...denied, ...denied, "card", "record", "tool_group[bash]", "system"]);
    expect(items[1]!.internalCalls.map((c) => c.part.tool)).toEqual(["submit_plan"]);
    const deniedGroups = items.filter((it) => it.kind === "tool_group").slice(1);
    expect(deniedGroups.map((it) => [it.keyLine, it.tone, issues(it)])).toEqual([1, 2, 3, 4, 5].map(() => ["调用了 1 个工具：bash（1 次你拒绝了）", "stopped", ["denied×1"]]));
    expect(items[4]).toMatchObject({ kind: "tool_group", tone: "granted", issues: [], marks: [{ reason: "granted", genericBash: true, categories: ["越出项目目录"] }] });
    expect(items.find((it) => it.kind === "record")).toMatchObject({
      keyLine: "偏离：你累计拒绝了 5 次（审批、计划变更），任务先暂停：看过之后可以继续，或者取消任务",
      scope: { taskId: "t-1", stageId: "s1" },
      marks: [{ kind: "deviation", severity: "notice" }],
    });
  });
});

describe("回放：秘书会话", () => {
  test("闲聊（secretary-chat）：思考和回复在同一条消息里，拆成思考、回复两条；有正文的思考不并进别处", () => {
    const items = chatItems(replay(load("secretary-chat")), "secretary");
    expect(items.map((it) => [it.kind, it.keyLine, it.content])).toEqual([
      ["user", "你：在吗", "user"],
      ["thinking", "思考：用户在打招呼，先回应，再问有什么事。", "thinking"],
      ["reply", "回复：在的。今天有什么要我帮忙的？", "reply"],
      ["user", "你：帮我记一下：周五交房租", "user"],
      ["reply", "回复：好，周五交房租，我记下了。不过现在我还不能建提醒，到时候需要你自己留意。", "reply"],
    ]);
  });

  test("先问我（secretary-approval）：审批卡一条（名字留着占位，界面画成名字标签）；批准后执行的那次读文件在组里，记 1 次问过你", () => {
    const items = chatItems(replay(load("secretary-approval")), "secretary");
    expect(items.map(shape)).toEqual(["user", "card", "tool_group[read]", "reply"]);
    expect(items.map((it) => [it.keyLine, it.tone ?? null])).toEqual([
      ["你：看看 ~/notes.txt", null],
      ["审批（⟦个人助理⟧对话）：读文件「~/notes.txt」 · 越出项目目录 · 已处理", null],
      ["调用了 1 个工具：read（1 次问过你）", "stopped"],
      ["回复：读到了：周五交房租。", null],
    ]);
    expect(items[2]).toMatchObject({ kind: "tool_group", detail: "tool_group", issues: [{ issue: "asked", count: 1 }], marks: [{ kind: "tool", categories: ["越出项目目录"], reason: "asked" }] });
    expect(items[1]!.marks.map((m) => m.kind)).toEqual(["approval"]);
  });

  test("语音（voice-message）：每条语音各成一条，要点那一行写时长和识别出的文字；系统说明一条", () => {
    const items = chatItems(replay(load("voice-message")), "secretary");
    expect(items.map((it) => [it.kind, it.keyLine])).toEqual([
      ["voice", "你：[语音 4″] 明天早上九点提醒我交报告"],
      ["reply", "回复：好的，明早九点提醒你交报告。"],
      ["voice", "你：[语音 2″] 下午去买菜"],
      ["reply", "回复：这条语音没识别出来，能再说一遍吗？"],
      ["system", "系统：用户重新识别了之前没识别出来的那条语音，转写如下："],
      ["reply", "回复：好，下午去买菜。"],
    ]);
    expect(items.filter((it) => it.kind === "voice").map((it) => [it.speaker, it.content, it.detail])).toEqual([
      ["user", "user", "text"],
      ["user", "user", "text"],
    ]);
  });

  test("用语音回复（voice-reply）：agent 的语音一条（文字收进语音的那几轮没有回复）；口语总结的那一轮回复照常，写口语总结的调用不显示、挂在那段回复上", () => {
    const items = chatItems(replay(load("voice-reply")), "secretary");
    expect(items.map(shape)).toEqual(["voice", "voice", "voice", "reply", "voice", "voice", "reply", "system"]);
    expect(items[3]!.internalCalls.map((c) => c.part.tool)).toEqual(["spoken_summary"]);
    const agent = items.filter((it) => it.kind === "voice" && it.speaker === "agent");
    expect(agent.map((it) => [it.keyLine.replace(/\[语音 \d+″\]/, "[语音]"), it.content])).toEqual([
      ["回复：[语音] 好的，明早九点提醒你交报告。", "reply"],
      ["回复：[语音] 周报整理好了，细节都在聊天里。", "reply"],
    ]);
  });

  test("彻底删除（memory-purge）：被删的消息只剩一条已删除；改写过的工具调用照样成组；卡片隔开两组；操作记录一条", () => {
    const items = chatItems(replay(load("memory-purge")), "secretary");
    expect(items.map(shape)).toEqual(["user", "reply", "deleted", "reply", "user", "tool_group[search_materials]", "card", "tool_group[propose_quick_action]", "reply", "record", "user", "reply"]);
    expect(items[2]).toMatchObject({ kind: "deleted", keyLine: "已删除", content: "context", detail: undefined });
    expect(items[9]).toMatchObject({ kind: "record", keyLine: "操作记录：彻底删除 1 条素材", detail: "record" });
    expect(JSON.stringify(items)).not.toContain("房东要卖房");
  });
});

describe("回放：项目的维护者会话（work-orders-queue）", () => {
  // 录制在 packages/daemon/test/main/work-orders.test.ts：项目维护者依次起草两张工单的计划，再依次执行
  const items = chatItems(replay(load("work-orders-queue")), "maintainer:pm-1");

  test("工单分隔线各成一条；一张工单里两段话之间的调用成一组，验收的说明和卡片把它隔开；内部工具不显示", () => {
    // 起草：分隔线、开始工单的说明、计划卡、回复；执行：分隔线、开始执行的说明、写文件、宣布完成的说明和验收卡、收尾的一组、回复
    const drafting = ["divider", "system", "card", "reply"];
    const executing = ["divider", "system", "tool_group[write]", "system", "card", "system", "tool_group[edit]", "reply"];
    expect(items.map(shape)).toEqual([...drafting, ...drafting, ...executing, ...executing]);
    // 起草计划的那几次调用都是内部工具：提交计划挂在计划卡上，写回进展、写摘要只是记账，挂在紧挨着的前一条（也是计划卡）上
    expect(items.filter((it) => it.kind === "card").map((it) => it.internalCalls.map((c) => c.part.tool))).toEqual([
      ["submit_plan", "write_progress", "write_segment_summary"],
      ["submit_plan", "write_progress", "write_segment_summary"],
      [],
      [],
    ]);
    // 收尾那一组：宣布阶段完成、写摘要留在组的步骤里（详情里看得到），不算进 N
    const closing = items.filter((it) => it.kind === "tool_group")[1]!;
    expect([closing.keyLine, steps(closing)]).toEqual(["调用了 1 个工具：edit", ["complete_stage（内部）", "edit", "write_segment_summary（内部）"]]);
    expect(items.filter((it) => it.kind === "divider").map((it) => it.keyLine)).toEqual([
      "工单 wo-1 · 起草计划：记账本出周报",
      "工单 wo-2 · 起草计划：记账本出月报",
      "工单 wo-3 · 执行：记账本出周报",
      "工单 wo-4 · 执行：记账本出月报",
    ]);
    expect(items.filter((it) => it.kind === "divider").every((it) => it.content === "context" && it.detail === undefined)).toBe(true);
    // 组跟着工单走：归属是那张工单的任务
    expect(items.filter((it) => it.kind === "tool_group").map((it) => it.scope.taskId)).toEqual(["t-1", "t-1", "t-2", "t-2"]);
  });
});

describe("录像覆盖不到的：出了状况的调用也在组里、按先后排（用户 2026-10-09 改）", () => {
  test.each([
    ["顺利执行", {}, null, null, null],
    ["授权内放行", { withinGrant: true, categoryTitles: ["越出项目目录"] }, null, null, "granted"],
    ["做完告诉我", { disposition: "do_then_tell" }, null, null, "notify"],
    ["硬拒绝", { blockedBy: "hard_refusal", outcome: "blocked" }, "blocked", "硬拒绝", "stopped"],
    ["按规则退回", { blockedBy: "pull_back", disposition: "ask_first", outcome: "blocked" }, "blocked", "按规则退回", "stopped"],
    ["判定出错", { blockedBy: "judge_error", disposition: undefined, outcome: "blocked" }, "blocked", "判定出错", "stopped"],
    ["永不", { disposition: "never", outcome: "blocked", categoryTitles: ["以我的名义对外发送或发布"] }, "blocked", "被拦下", "stopped"],
    ["交给我做", { disposition: "hand_to_me", outcome: "blocked" }, "blocked", "被拦下", "stopped"],
    ["先问我、在等你批准", { disposition: "ask_first", outcome: "blocked", categoryTitles: ["删除或覆盖"] }, "waiting", "等你批准", "stopped"],
    ["计划里列了才做、不在授权内、在等你批准", { disposition: "planned_only", outcome: "blocked" }, "waiting", "等你批准", "stopped"],
    ["你拒绝了", { disposition: "ask_first", outcome: "denied", categoryTitles: ["删除或覆盖"] }, "denied", "你拒绝了", "stopped"],
    ["出错", { outcome: "error", resultSummary: "磁盘满了" }, "error", "出错", null],
    ["问过你、批准后执行了", { disposition: "planned_only", outcome: "done", categoryTitles: ["删除或覆盖"] }, "asked", null, "stopped"],
  ] as const)("%s：在组里，带着出的状况、结果的说法；组的性质色", (_name, overrides, issue, outcome, tone) => {
    const items = chatItems(replay([callFrame(1, "x", overrides as Partial<ToolCallPart>)]), TM);
    expect(items).toHaveLength(1);
    const group = items[0]!;
    if (group.kind !== "tool_group") throw new Error("应当是工具调用组");
    expect([group.calls[0]!.issue ?? null, group.calls[0]!.outcome ?? null, group.tone ?? null, group.error]).toEqual([issue, outcome, tone, issue === "error"]);
    expect(group.issues).toEqual(issue === null ? [] : [{ issue: issue as CallIssue, count: 1 }]);
  });

  test("一组里按发生的先后排：顺利的、被拦下的、思考、出错的；组上带着各种状况的计数，那一行写出来，性质色取最显眼的", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("推上去")]),
        callFrame(2, "a", { disposition: "do_then_tell" }),
        callFrame(3, "b", { tool: "git_push", blockedBy: "pull_back", disposition: "ask_first", outcome: "blocked" }),
        messageFrame(4, "r4", "agent", [reasoning("先跑一下测试")]),
        callFrame(5, "c", { tool: "run_tests", outcome: "error" }),
        callFrame(6, "d", { tool: "git_push", blockedBy: "hard_refusal", outcome: "blocked" }),
        messageFrame(7, "r7", "agent", [text("推不上去")]),
      ]),
      TM,
    );
    expect(items.map(shape)).toEqual(["user", "tool_group[write,git_push,run_tests,git_push]", "reply"]);
    const group = items[1]!;
    expect(steps(group)).toEqual(["write", "git_push", "思考", "run_tests", "git_push"]);
    expect(issues(group)).toEqual(["blocked×2", "error×1"]);
    expect([group.keyLine, group.tone, group.error]).toEqual(["调用了 4 个工具：write、git_push ×2、run_tests（2 次被拦下、1 次出错）", "stopped", true]);
  });

  test("审批卡照旧单独一张，把组隔成前后两段，先后顺序不乱", () => {
    const items = chatItems(
      replay([
        frame("cards", 1, "card", { card: card("c-ap", 1, { type: "approval", text: "审批：删除 a.md" }) }),
        callFrame(1, "a"),
        messageFrame(2, "k2", "agent", [{ type: "card_ref", cardId: "c-ap" }]),
        callFrame(3, "b", { disposition: "ask_first", outcome: "done", categoryTitles: ["删除或覆盖"] }),
        callFrame(4, "c"),
      ]),
      TM,
    );
    expect(items.map((it) => [shape(it), it.kind === "tool_group" ? it.issues.map((i) => i.issue) : []])).toEqual([
      ["tool_group[write]", []],
      ["card", []],
      ["tool_group[write,write]", ["asked"]],
    ]);
  });

  test("顺利执行的组：性质色取最显眼的（做完告诉我 > 授权内），没有处置可说的组没有性质色", () => {
    const items = chatItems(
      replay([
        callFrame(1, "a", { withinGrant: true, categoryTitles: ["越出项目目录"] }),
        callFrame(2, "b", { tool: "bash", argsSummary: "ls", genericBash: true }),
        messageFrame(3, "r1", "agent", [text("接着")]),
        callFrame(4, "c", { disposition: "do_then_tell", categoryTitles: ["删除或覆盖"] }),
        callFrame(5, "d", { withinGrant: true }),
        messageFrame(6, "r2", "agent", [text("再来")]),
        callFrame(7, "e"),
      ]),
      TM,
    );
    expect(items.map((it) => [shape(it), it.tone ?? null, it.marks.map((m) => m.reason ?? (m.genericBash ? "通用 bash" : "-"))])).toEqual([
      ["tool_group[write,bash]", "granted", ["granted", "通用 bash"]],
      ["reply", null, []],
      ["tool_group[write,write]", "notify", ["notify", "granted"]],
      ["reply", null, []],
      ["tool_group[write]", null, []],
    ]);
  });

  test("换了 agent（子 agent）、换了阶段都另起一组：一组只属于一个 agent 的一个阶段", () => {
    const items = chatItems(
      replay([
        callFrame(1, "a", {}, { taskId: "t-9", stageId: "s1" }),
        callFrame(2, "b", {}, { taskId: "t-9", stageId: "s1", agentId: "sa-1" }),
        callFrame(3, "c", { outcome: "error" }, { taskId: "t-9", stageId: "s1", agentId: "sa-1" }),
        callFrame(4, "d", {}, { taskId: "t-9", stageId: "s2", agentId: "sa-1" }),
        callFrame(5, "e", {}, { taskId: "t-9", stageId: "s2" }),
      ]),
      TM,
    );
    expect(items.map((it) => [it.id, it.kind === "tool_group" ? it.calls.map((c) => c.part.callId) : []])).toEqual([
      ["group:m-a#0", ["a"]],
      ["group:m-b#0", ["b", "c"]],
      ["group:m-d#0", ["d"]],
      ["group:m-e#0", ["e"]],
    ]);
    expect(items.map((it) => [it.scope.agentId ?? null, it.scope.stageId])).toEqual([
      [null, "s1"],
      ["sa-1", "s1"],
      ["sa-1", "s2"],
      [null, "s2"],
    ]);
  });
});

describe("录像覆盖不到的：思考并进工具调用组（用户 2026-10-09 定）", () => {
  const scope = { taskId: "t-9", stageId: "s1" };
  const long = "先看看目录里有什么，".repeat(13); // 130 字

  test("两段话之间没有正文的思考不论长短都并进组：组里按时间顺序留着每一步，要点那一行只说工具；思考不隔开组；按思考的 id 找得到这一组", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("把笔记整理一下")], scope),
        messageFrame(2, "r1", "agent", [reasoning("  先写目录  ")], scope),
        callFrame(3, "c1", {}, scope),
        messageFrame(4, "r2", "agent", [reasoning(long)], scope),
        callFrame(5, "c2", {}, scope),
        callFrame(6, "c3", {}, scope),
        messageFrame(7, "r3", "agent", [reasoning("写完了，收个尾")], scope),
        messageFrame(8, "r4", "agent", [text("整理好了")], scope),
      ]),
      TM,
    );
    expect(items.map(shape)).toEqual(["user", "tool_group[write,write,write]", "reply"]);
    const group = items[1]!;
    if (group.kind !== "tool_group") throw new Error("第二条应当是工具调用组");
    expect(group.steps.map((s) => (s.kind === "thinking" ? `思考：${s.text.slice(0, 6)}` : s.call.part.callId))).toEqual(["思考：  先写目录", "c1", "思考：先看看目录里", "c2", "c3", "思考：写完了，收个"]);
    expect([group.id, group.seq, group.keyLine]).toEqual(["group:m-c1#0", 2, "调用了 3 个工具：write ×3"]);
    // 被组吸收的思考：按它自己的 id 找得到所在的组
    for (const id of ["r1:think", "r2:think", "r3:think"]) expect(locateChatItem(items, id)?.item.id).toBe("group:m-c1#0");
  });

  test("带着正文的思考照常单独一条、排在回复前面，把前后的调用隔开；前后都没有调用的思考单独一条；换了 agent 另起一组", () => {
    const items = chatItems(
      replay([
        callFrame(1, "c1", {}, scope),
        messageFrame(2, "r2", "agent", [reasoning("看一眼"), text("我先看一眼")], scope),
        callFrame(3, "c3", {}, scope),
        messageFrame(4, "r4", "agent", [reasoning("剩下的交给子 agent")], scope),
        callFrame(5, "c5", {}, { ...scope, agentId: "sa-1" }),
        messageFrame(6, "u6", "user", [text("好")], scope),
        messageFrame(7, "r7", "agent", [reasoning("想想怎么回")], scope),
        messageFrame(8, "r8", "agent", [text("嗯")], scope),
      ]),
      TM,
    );
    expect(items.map((it) => [shape(it), it.id])).toEqual([
      ["tool_group[write]", "group:m-c1#0"],
      ["thinking", "r2:think"],
      ["reply", "r2"],
      ["tool_group[write]", "group:m-c3#0"],
      ["tool_group[write]", "group:m-c5#0"],
      ["user", "u6"],
      ["thinking", "r7:think"],
      ["reply", "r8"],
    ]);
    expect(steps(items[3])).toEqual(["write", "思考"]);
  });

  test("出了状况的调用前面的思考（不论长短）就是组里的一步", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "r1", "agent", [reasoning("推上去")], scope),
        callFrame(2, "c2", { tool: "git_push", blockedBy: "pull_back", disposition: "ask_first", outcome: "blocked" }, scope),
        messageFrame(3, "r3", "agent", [reasoning(long)], scope),
        callFrame(4, "c4", { tool: "git_push", disposition: "ask_first", outcome: "denied" }, scope),
      ]),
      TM,
    );
    expect(items.map(shape)).toEqual(["tool_group[git_push,git_push]"]);
    expect(steps(items[0])).toEqual(["思考", "git_push", "思考", "git_push"]);
    expect(issues(items[0])).toEqual(["blocked×1", "denied×1"]);
  });

  test("实时：正在生成的思考单独一条（还不知道后面有没有正文）；定稿后没有正文就并进前面的组，组的 id 不变，按思考的 id 找得到", () => {
    const live: Array<EventFrame | UiInput> = [callFrame(1, "c1", {}, scope), frame(TM, 1, "stream", { messageId: "a2", deltas: [{ part: 0, type: "reasoning", offset: 0, text: "接着写" }] })];
    expect(chatItems(replay(live), TM).map((it) => [shape(it), it.id])).toEqual([
      ["tool_group[write]", "group:m-c1#0"],
      ["thinking", "a2:think"],
    ]);
    const settled = chatItems(replay([...live, messageFrame(2, "a2", "agent", [reasoning("接着写")], scope), callFrame(3, "c3", {}, scope)]), TM);
    expect(settled.map((it) => [shape(it), it.id])).toEqual([["tool_group[write,write]", "group:m-c1#0"]]);
    expect(locateChatItem(settled, "a2:think")?.item.id).toBe("group:m-c1#0");
  });
});

/** 守护进程里已经有对应卡片、说明或记录的内部工具，和代表它的那一条（用户点名的五个，加上检查过的其他维护者内部工具） */
const INTERNAL: ReadonlyArray<readonly [string, "card" | "record" | "system" | "reply" | "none", string?]> = [
  ["submit_plan", "card", "plan"],
  ["complete_stage", "card", "progress"],
  ["write_progress", "none"],
  ["write_segment_summary", "none"],
  ["spoken_summary", "reply"],
  ["report_progress", "card", "progress"],
  ["propose_plan_change", "card", "plan_change"],
  ["revise_plan", "record", "plan_revision"],
  ["mark_infeasible", "record", "deviation"],
  ["fail_task", "system"],
  ["propose_parallel", "card", "parallel"],
  ["submit_charter", "card", "charter"],
  ["request_toolkit_change", "card", "toolkit_change"],
  ["adjust_skills", "record", "toolkit"],
  ["dispatch_work_order", "record", "work_order"],
];

/** 代表内部工具的那一条（序号 1；卡片在卡片频道上序号 1） */
function representing(kind: string, sub: string | undefined): EventFrame[] {
  if (kind === "card") return cardFrames(1, 1, "rep", sub!);
  if (kind === "record") return [recordFrame(1, { record: { id: "rep", kind: sub!, summary: "记一笔", time: at("00:01") } })];
  if (kind === "reply") return [messageFrame(1, "rep", "agent", [text("周报整理好了")])];
  return [messageFrame(1, "rep", "system", [text("维护者判任务失败：做不下去")])];
}

describe("录像覆盖不到的：内部工具不算进组（用户 2026-10-09 定）", () => {
  test("名单就是这些（一处常量）；开始阶段、转为等我这类在会话里没有别的痕迹的不算；评审子 agent 的调用不进会话，也不在名单里", () => {
    expect(Object.keys(INTERNAL_TOOLS).toSorted()).toEqual(INTERNAL.map(([name]) => name).toSorted());
    expect(Object.fromEntries(Object.entries(INTERNAL_TOOLS).map(([name, info]) => [name, info.shownAs.kind]))).toEqual(Object.fromEntries(INTERNAL.map(([name, kind]) => [name, kind])));
    expect(["start_stage", "wait_for_user", "summarize_receipts", "ask_clarification", "submit_receipt", "submit_review", "bash", "write"].some(isInternalTool)).toBe(false);
  });

  test.each(INTERNAL.map(([name, kind, sub]) => ({ name, kind, sub })))("$name：顺利执行时不显示，挂在代表它的那一条（$kind）上，越过中间别的条目；夹在别的调用中间时留在组的步骤里、不算进 N；被拦下、出错的照旧算进组里", ({ name, kind, sub }) => {
    // 代表它的那一条，然后一张不相干的提问卡，然后这次调用
    const decoy = cardFrames(2, 2, "decoy", "questions");
    const alone = chatItems(replay([...representing(kind, sub), ...decoy, callFrame(3, "i", { tool: name }), messageFrame(4, "r4", "agent", [text("好了")])]), TM);
    const target = { none: "decoy#0", card: "rep#0", record: "record:rep", system: "rep", reply: "rep" }[kind];
    expect(alone.filter((it) => it.internalCalls.length > 0).map((it) => [it.id, it.internalCalls.map((c) => c.part.callId)])).toEqual([[target, ["i"]]]);
    expect(alone.some((it) => it.kind === "tool_group")).toBe(false);
    expect(locateChatItem(alone, "m-i#0")).toMatchObject({ item: { id: target }, call: { internal: true, counted: false, part: { tool: name } } });

    const inside = chatItems(replay([callFrame(1, "a"), callFrame(2, "i", { tool: name }), callFrame(3, "b")]), TM);
    expect(inside.map((it) => [shape(it), it.keyLine])).toEqual([["tool_group[write,write]", "调用了 2 个工具：write ×2"]]);
    expect(steps(inside[0])).toEqual(["write", `${name}（内部）`, "write"]);
    expect(locateChatItem(inside, "m-i#0")).toMatchObject({ item: { id: "group:m-a#0" }, call: { part: { tool: name } } });

    const troubled = chatItems(replay([callFrame(1, "x", { tool: name, blockedBy: "hard_refusal", outcome: "blocked" }), callFrame(2, "y", { tool: name, outcome: "error" })]), TM);
    expect(troubled.map((it) => [shape(it), it.keyLine, it.tone ?? null])).toEqual([[`tool_group[${name},${name}]`, `调用了 2 个工具：${name} ×2（1 次被拦下、1 次出错）`, "stopped"]]);
  });

  test("挂在哪：在这一轮里找，不越过用户的输入；找不到代表它的那一条就挂在紧挨着的前一条上", () => {
    const items = chatItems(replay([...cardFrames(1, 1, "old", "plan"), messageFrame(2, "u2", "user", [text("再交一次")]), messageFrame(3, "s3", "system", [text("开始")]), callFrame(4, "i", { tool: "submit_plan" })]), TM);
    expect(items.filter((it) => it.internalCalls.length > 0).map((it) => it.id)).toEqual(["s3"]);
  });

  test("挂在哪：会话开头就是内部工具调用（前面一条都没有），挂到下一条上", () => {
    const items = chatItems(replay([callFrame(1, "i", { tool: "submit_plan" }), ...cardFrames(1, 2, "k2", "plan")]), TM);
    expect(items.map((it) => [it.id, it.internalCalls.map((c) => c.part.callId)])).toEqual([["k2#0", ["i"]]]);
  });
});

describe("录像覆盖不到的：时间线记录、附件、引用的卡片、系统消息里的卡片", () => {
  test("偏离、范围变更、越界、不认识的记录各成一条，写种类和摘要；进要点层的带要点，不认识的不带", () => {
    const items = chatItems(
      replay([
        callFrame(1, "a", {}, { taskId: "t-9", stageId: "s1" }),
        recordFrame(2, { record: { id: "dv-1", kind: "deviation", summary: "计划外多查了一家店", time: at("01:00") }, taskId: "t-9", stageId: "s1" }),
        callFrame(3, "b", {}, { taskId: "t-9", stageId: "s1" }),
        recordFrame(4, { record: { id: "sc-1", kind: "scope_change", summary: "加了一个导出步骤", time: at("02:00") } }),
        recordFrame(5, { record: { id: "os-1", kind: "out_of_scope", summary: "顺手整理了文档目录", time: at("03:00") } }),
        recordFrame(6, { record: { id: "x-1", kind: "something_new", summary: "以后的票加的记录", time: at("04:00") } }),
      ]),
      TM,
    );
    expect(items.map((it) => [it.id, it.kind, it.keyLine, it.marks.map((m) => m.kind), it.detail ?? null])).toEqual([
      ["group:m-a#0", "tool_group", "调用了 1 个工具：write", [], "tool_group"],
      ["record:dv-1", "record", "偏离：计划外多查了一家店", ["deviation"], "record"],
      ["group:m-b#0", "tool_group", "调用了 1 个工具：write", [], "tool_group"],
      ["record:sc-1", "record", "范围变更：加了一个导出步骤", ["scope_change"], "record"],
      ["record:os-1", "record", "越界：顺手整理了文档目录", ["out_of_scope"], "record"],
      ["record:x-1", "record", "记录：以后的票加的记录", [], "record"],
    ]);
    expect(items[1]).toMatchObject({ time: at("01:00"), scope: { taskId: "t-9", stageId: "s1" }, content: "context" });
  });

  test("用户只发附件：那一行写附件；引用的卡片跟着用户消息走，不另成一条；系统消息里的说明和卡片各一条；旧说法换成现在的", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [{ type: "image", mediaId: "md-1", name: "收据.png", mime: "image/png" }, { type: "file", mediaId: "md-2", name: "账单_10月.pdf", mime: "application/pdf", size: 10 }]),
        messageFrame(2, "u2", "user", [text("这张卡什么意思"), { type: "card_ref", cardId: "c-1" }]),
        messageFrame(3, "s1", "system", [text("维护者宣布阶段完成"), { type: "card_ref", cardId: "c-2" }]),
        messageFrame(4, "s4", "system", [text("秘书这次没能回复：模型出错")]),
      ]),
      TM,
    );
    expect(items.map((it) => [it.id, it.kind, it.keyLine])).toEqual([
      ["u1", "user", "你：[图片：收据.png] [附件：账单_10月.pdf]"],
      ["u2", "user", "你：这张卡什么意思"],
      ["s1", "system", "系统：维护者宣布阶段完成"],
      ["s1#1", "card", "卡片"],
      ["s4", "system", "系统：⟦个人助理⟧这次没能回复：模型出错"],
    ]);
    // 还没收到的卡片打不开详情
    expect(items[3]!.detail).toBeUndefined();
  });
});

describe("录像覆盖不到的：正在生成的回复、乐观显示", () => {
  const S = "secretary";
  const stream = (seq: number, messageId: string, deltas: Array<{ part: number; type: "text" | "reasoning"; offset: number; text: string }>) => frame(S, seq, "stream", { messageId, deltas });

  test("正在生成：思考和回复各一条、标着正在生成，id 就是定稿后的 id；定稿后 id 不变", () => {
    const sent: Array<EventFrame | UiInput> = [
      { kind: "send_message", conversation: S, idempotencyKey: "k-1", parts: [text("帮我查查")], time: at("00:00") },
      messageFrame(1, "u1", "user", [text("帮我查查")], { idempotencyKey: "k-1" }, S),
      stream(1, "a1", [
        { part: 0, type: "reasoning", offset: 0, text: "查一下" },
        { part: 1, type: "text", offset: 0, text: "好的" },
      ]),
    ];
    const live = chatItems(replay(sent), S);
    expect(live.map((it) => [it.id, it.kind, it.kind === "thinking" || it.kind === "reply" ? it.streaming : null])).toEqual([
      ["k:k-1", "user", null],
      ["a1:think", "thinking", true],
      ["a1", "reply", true],
    ]);
    const done = chatItems(replay([...sent, messageFrame(2, "a1", "agent", [reasoning("查一下"), text("好的，查到了")], {}, S)]), S);
    expect(done.map((it) => [it.id, it.kind, it.kind === "thinking" || it.kind === "reply" ? it.streaming : null])).toEqual([
      ["k:k-1", "user", null],
      ["a1:think", "thinking", false],
      ["a1", "reply", false],
    ]);
    expect(done[2]!.keyLine).toBe("回复：好的，查到了");
  });

  test("漏了中间增量的回复：只占一条“正在回复”，不拼残缺的文字", () => {
    const items = chatItems(replay([stream(0, "a1", [{ part: 0, type: "text", offset: 5, text: "后半句" }])]), S);
    expect(items).toMatchObject([{ id: "a1", kind: "reply", streaming: true, broken: true, text: "", keyLine: "回复：（正在回复）" }]);
  });

  test("乐观显示：发送中、发送失败的用户消息带着状态；权威消息到了原地换掉，id 不变", () => {
    const sending = replay([{ kind: "send_message", conversation: S, idempotencyKey: "k-2", parts: [text("在吗")], time: at("00:00") }]);
    expect(chatItems(sending, S)).toMatchObject([{ id: "k:k-2", kind: "user", pending: { status: "sending" }, keyLine: "你：在吗" }]);
    const failed = replay([{ kind: "request_failed", idempotencyKey: "k-2", error: "断线了" }], sending);
    expect(chatItems(failed, S)).toMatchObject([{ id: "k:k-2", pending: { status: "failed", error: "断线了" } }]);
    const confirmed = replay([messageFrame(1, "u9", "user", [text("在吗")], { idempotencyKey: "k-2" }, S)], sending);
    expect(chatItems(confirmed, S)).toMatchObject([{ id: "k:k-2", kind: "user", pending: undefined, seq: 1 }]);
  });
});

describe("条目 id：往上翻、实时追加之后不变（例外：组跨两页时组的 id 会变，靠 locateChatItem 找）", () => {
  test("回放（timeline-history）：翻回更早的一页之后，原来手里的每一条 id 不变、内容不变，更早的排在前面", () => {
    // 录制在 packages/daemon/test/main/history.test.ts：维护者会话、秘书会话各 60 条消息，第一次补发只到最近 50 条，旧页里另有记录
    const inputs = load("timeline-history");
    const firstPage = inputs.findIndex((i) => i.kind === "history_page");
    for (const conversation of ["maintainer:tm-1", "secretary"] as const) {
      const before = chatItems(replay(inputs.slice(0, firstPage)), conversation);
      const after = chatItems(replay(inputs), conversation);
      expect(after.length).toBeGreaterThan(before.length);
      const kept = after.slice(after.length - before.length);
      expect(kept.map((it) => [it.id, it.kind, it.keyLine])).toEqual(before.map((it) => [it.id, it.kind, it.keyLine]));
      expect(new Set(after.map((it) => it.id)).size).toBe(after.length);
    }
  });

  const scope = { taskId: "t-9", stageId: "s1" };

  test("实时追加：组里追加调用（顺利的、出了状况的），组的 id 不变；后面来了正文，组就收住，再来的调用另起一组", () => {
    const one = [messageFrame(1, "u1", "user", [text("开始")], scope), callFrame(2, "c1", {}, scope)];
    expect(idsAfter(one)).toEqual(["u1", "group:m-c1#0"]);
    const two = [...one, callFrame(3, "c2", { outcome: "error" }, scope)];
    expect(idsAfter(two)).toEqual(["u1", "group:m-c1#0"]);
    const more = [...two, messageFrame(4, "r1", "agent", [text("好了")], scope), callFrame(5, "c3", {}, scope)];
    expect(idsAfter(more)).toEqual(["u1", "group:m-c1#0", "r1", "group:m-c3#0"]);
  });

  test("例外：翻回来的一页末尾也是同一组的调用，组并上更早的调用，id 换成新的第一次调用的；按原来的 id、组里任何一次调用的 id 都还找得到它", () => {
    const live: Array<EventFrame | UiInput> = [callFrame(5, "c5", {}, scope), callFrame(6, "c6", {}, scope), messageFrame(7, "r7", "agent", [text("都写好了")], scope)];
    const page: HistoryPage = {
      conversation: TM,
      messages: [
        { seq: 3, message: { id: "u3", conversation: TM, speaker: "user", time: at("00:03"), parts: [text("写三个文件")] }, ...scope },
        { seq: 4, message: { id: "m-c4", conversation: TM, speaker: "agent", time: at("00:04"), parts: [tool("c4")] }, ...scope },
      ],
      records: [],
      hasMore: true,
    };
    expect(schemaChecker(HistoryPageSchema).firstError(page)).toBeUndefined();
    const before = chatItems(replay(live), TM);
    expect(before.map((it) => it.id)).toEqual(["group:m-c5#0", "r7"]);
    const after = chatItems(replay([{ kind: "history_page", conversation: TM, page }], replay(live)), TM);
    expect(after.map(shape)).toEqual(["user", "tool_group[write,write,write]", "reply"]);
    expect(after.map((it) => it.id)).toEqual(["u3", "group:m-c4#0", "r7"]);
    // 详情页存着原来的组 id：照样找得到并上之后的那一组；按调用的 id 找到的是组里的那一次
    expect(locateChatItem(after, "group:m-c5#0")?.item.id).toBe("group:m-c4#0");
    expect(locateChatItem(after, "group:m-c5#0")?.call).toBeUndefined();
    expect(locateChatItem(after, "m-c6#0")).toMatchObject({ item: { id: "group:m-c4#0" }, call: { id: "m-c6#0", part: { callId: "c6" } } });
    expect(locateChatItem(after, "r7")?.item.kind).toBe("reply");
    expect(locateChatItem(after, "不存在")).toBeUndefined();
  });

  test("按调用的 id 找出了状况的那次调用：找到的是它所在的组和那一次", () => {
    const items = chatItems(replay([callFrame(1, "a"), callFrame(2, "x", { outcome: "error" })]), TM);
    expect(locateChatItem(items, "m-x#0")).toMatchObject({ item: { kind: "tool_group", id: "group:m-a#0" }, call: { id: "m-x#0", issue: "error" } });
  });
});
