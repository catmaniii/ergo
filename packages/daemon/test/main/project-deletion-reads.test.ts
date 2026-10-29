// 主切面：删除项目时补齐清理（66 号票）——项目之外读过这个项目的调用。真的守护进程，秘书、维护者、评审子 agent 接 faux 剧本，
// 测试扮演前端。
// - 秘书读过这个项目的（文件工具读写死的路径、经草稿区里的目录联接读、读项目档案的工具、列项目区这个上级目录）：删项目之后
//   完整内容和返回都取不到，详情注明"已随项目删除"（purgedBy；过了保留期清掉过的也不再注明清掉），聊天里的工具调用记录只剩
//   删除标记（messages_purged 给出改写后的样子），效果日志、秘书的会话文件里也没有了；秘书当时据此说的话不改；读别的项目、
//   读项目外文件的不受影响；删除的二次确认上写着删不掉的（PROJECT_DELETE_LIMITS）；
// - 涉及多个项目的任务自己的维护者读项目档案读到的、评审子 agent 读过这个项目的（工作目录、项目档案、经别的项目工作目录里的
//   联接读到的）：一样取不到，任务维护者的聊天记录和会话文件也改；读别的项目的不受影响。
// 找哪些调用的规矩（包含关系、真实路径、通配符、按返回开头的项目编号）的表格在 test/projects/outside-reads.test.ts。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  METHODS,
  nowIso,
  type Plan,
  type PlanCardPayload,
  PROJECT_DELETE_LIMITS,
  type Card,
  type CardEventPayload,
  type ProjectEventPayload,
  PURGED_TEXT,
  type ResponseFrame,
  type TaskEventPayload,
  type ToolCallDetail,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import { BUILTIN_CATEGORY_IDS, BUILTIN_TOOL_REGISTRY, type EffectRecord } from "../../src/guard/index.ts";
import { clearDetails } from "../../src/guard-runtime/tool-call-details.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { toolCallDetail } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const messagesOf = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] => messagesOf(frontend).flatMap((p) => p.message.parts.filter((part): part is ToolCallPart => part.type === "tool_call"));
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
/** 效果日志里的全部记录（守卫频道上的 effect_recorded） */
const effectLog = (store: EventStore): EffectRecord[] => store.read(GUARD_CHANNEL, 0, GUARD_EVENTS.effectRecorded).flatMap((e) => (e.payload as EffectRecordedPayload).records);
/** 事件日志里的全部事件 */
const everything = (store: EventStore) => JSON.stringify(store.readGlobal(0, 1_000_000));
/** 某个 agent 会话目录里全部会话文件的内容 */
function sessionText(sessionsDir: string, agentId: string): string {
  const dir = path.join(sessionsDir, agentId);
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/**
 * 删除一个已归档的项目：项目页上点删除，待我处理里二次确认（确认上如实写着删不掉的，PROJECT_DELETE_LIMITS），
 * 确认删除，等项目列表上的 deleted
 */
async function deleteProject(frontend: TestFrontend, projectId: string) {
  const asked = ok(await frontend.request(METHODS.projectAction, { projectId, action: "delete" }, `k-delete-${projectId}`)) as { confirmItemId: string };
  const confirm = await eventually(
    () => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item),
    (item) => item.id === asked.confirmItemId,
    "删除的二次确认",
  );
  expect(confirm).toMatchObject({ kind: "notice", notice: "project_delete", body: expect.stringContaining(PROJECT_DELETE_LIMITS) });
  expect(PROJECT_DELETE_LIMITS).toContain("python -c");
  expect(PROJECT_DELETE_LIMITS).toContain("环境变量");
  expect(PROJECT_DELETE_LIMITS).toContain("pi-bash");
  ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
  await eventually(() => projectEventsOf(frontend), (e) => e.project.id === projectId && e.change === "deleted", "项目删掉");
}

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），两个项目的档案目录先建好、放上内容 */
function places() {
  const dataDir = makeTempDir("ergo-data-");
  const layout = dataDirLayout(realPathOf(dataDir)!);
  const recordsA = path.join(layout.projects, "p-1");
  const recordsB = path.join(layout.projects, "p-2");
  for (const records of [recordsA, recordsB]) fs.mkdirSync(path.join(records, "workdir"), { recursive: true });
  return { dataDir, homeDir: makeTempDir("ergo-home-"), layout, recordsA, recordsB };
}

describe("秘书读过的项目档案", () => {
  it("删项目之后：秘书读这个项目的调用（写死的路径、经草稿区里的联接、读项目档案的工具、列项目区这个上级目录）完整内容和返回都取不到，详情注明已随项目删除（过了保留期清掉过的也是）；聊天记录、效果日志、会话文件里也没有；秘书的回复不改；读别的项目、项目外文件的不受影响", async () => {
    const { dataDir, homeDir, layout, recordsA, recordsB } = places();
    fs.writeFileSync(path.join(recordsA, "spec.md"), "记账本规格：每月十号对一次信用卡账单\n");
    fs.writeFileSync(path.join(recordsA, "charter.md"), "记账本立项书：只记家里的日常开销\n");
    fs.writeFileSync(path.join(recordsA, "progress.md"), "记账本进展：月度导出已经做完\n");
    fs.writeFileSync(path.join(recordsB, "spec.md"), "家电档案规格：保修卡拍照存档\n");
    fs.mkdirSync(layout.scratch, { recursive: true });
    fs.writeFileSync(path.join(layout.scratch, "memo.txt"), "草稿区备忘：周五交水费\n");
    // 草稿区里一个目录联接，指向记账本的项目档案：经它读到的也算读了这个项目
    fs.symlinkSync(recordsA, path.join(layout.scratch, "link"), "junction");
    const reply = "看过了，两个项目的规格都在";

    // 秘书改写会话文件后重新拉起，faux 剧本从头再来：第一步留给那时的 echo_context（看它的上下文）
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      secretary: [
        { kind: "echo_context" },
        call("read", { path: path.join(recordsA, "spec.md") }),
        call("read", { path: "link/charter.md" }),
        call("read_project_records", { project: "记账本", docs: ["progress"] }),
        // 列项目区：读了这个项目的上级目录
        call("ls", { path: layout.projects }),
        call("read", { path: path.join(recordsB, "spec.md") }),
        call("read", { path: path.join(layout.scratch, "memo.txt") }),
        say(reply),
      ],
    });
    seedProject(td.daemon, "记账本", { state: "archived", charterConfirmed: true, kind: "dev" });
    seedProject(td.daemon, "家电档案", { state: "in_use", charterConfirmed: true, kind: "dev" });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [PROJECTS]: 0, [INBOX]: 0 });
    await tell(frontend, "你好");
    await tell(frontend, "看看记账本和家电档案的规格");

    const parts = toolPartsOf(frontend);
    expect(parts.map((p) => [p.tool, p.outcome])).toEqual([
      ["read", "done"],
      ["read", "done"],
      ["read_project_records", "done"],
      ["ls", "done"],
      ["read", "done"],
      ["read", "done"],
    ]);
    const [spec, viaLink, records, listing, other, memo] = parts as [ToolCallPart, ToolCallPart, ToolCallPart, ToolCallPart, ToolCallPart, ToolCallPart];
    const ours = [spec, viaLink, records, listing];
    expect((await toolCallDetail(td.url, spec.callId)).body.result).toContain("每月十号对一次信用卡账单");
    expect((await toolCallDetail(td.url, viaLink.callId)).body.result).toContain("只记家里的日常开销");
    expect((await toolCallDetail(td.url, records.callId)).body.result).toContain("月度导出已经做完");
    expect((await toolCallDetail(td.url, listing.callId)).body.result).toContain("p-1/");
    expect(effectLog(td.daemon.store).filter((r) => r.agentId === "secretary").map((r) => r.callId)).toEqual(parts.map((p) => p.callId));
    // 读项目档案的那次过了保留期，完整内容清掉了只剩摘要（65 号票）：返回开头照样写着是哪个项目
    const recordsDetail = td.daemon.store.read("tool_calls").find((e) => (e.payload as ToolCallDetail).callId === records.callId)!;
    clearDetails(td.daemon.store, [{ globalSeq: recordsDetail.globalSeq, reason: "expired" }], nowIso(), BUILTIN_TOOL_REGISTRY);
    expect((await toolCallDetail(td.url, records.callId)).body).toMatchObject({ cleared: { reason: "expired" }, result: expect.stringContaining("月度导出已经做完") });
    const secretaryPid = td.daemon.secretary.pid;

    await deleteProject(frontend, "p-1");

    // 聊天里的那四次工具调用记录：只换掉参数摘要和结果摘要，还是一次工具调用（工具名、结局不变）；会话文件里这四次调用也要改
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(purged).toMatchObject({ materialIds: [], mediaIds: [], toolCallIds: ours.map((p) => p.callId) });
    expect(purged.messages.map((m) => m.replacement?.parts)).toEqual(
      ours.map((p) => [expect.objectContaining({ type: "tool_call", callId: p.callId, tool: p.tool, outcome: "done", argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT })]),
    );

    // 完整内容：参数和返回只剩删除标记，注明已随项目删除，不再带效果记录；工具、结局、agent、会话不变；清掉过的不再注明过了保留期
    for (const p of ours) {
      const { status, body } = await toolCallDetail(td.url, p.callId);
      expect(status).toBe(200);
      expect(body).toMatchObject({ tool: p.tool, outcome: "done", agentId: "secretary", conversation: SECRETARY, purged: true, purgedBy: "project_deletion", result: PURGED_TEXT });
      expect(body).not.toHaveProperty("effects");
      expect(body).not.toHaveProperty("cleared");
    }
    // 读别的项目、读项目外文件的：照旧
    expect((await toolCallDetail(td.url, other.callId)).body).toMatchObject({ result: expect.stringContaining("保修卡拍照存档"), effects: [expect.objectContaining({ tool: "read" })] });
    expect((await toolCallDetail(td.url, memo.callId)).body).toMatchObject({ result: expect.stringContaining("周五交水费") });
    expect((await toolCallDetail(td.url, other.callId)).body).not.toHaveProperty("purged");
    // 效果日志：那四次的摘要换成删除标记、调用 id 去掉；别的照旧
    const effects = effectLog(td.daemon.store).filter((r) => r.agentId === "secretary");
    expect(effects.map((r) => [r.tool, r.summary === PURGED_TEXT, r.callId ?? null])).toEqual([
      ["read", true, null],
      ["read", true, null],
      ["read_project_records", true, null],
      ["ls", true, null],
      ["read", false, other.callId],
      ["read", false, memo.callId],
    ]);

    // 事件日志里一个字都不剩（聊天记录、完整内容、效果日志）；别的项目、项目外的文件、秘书的回复、用户的话都还在
    const log = everything(td.daemon.store);
    for (const gone of ["每月十号对一次信用卡账单", "只记家里的日常开销", "月度导出已经做完"]) expect(log).not.toContain(gone);
    for (const kept of ["保修卡拍照存档", "周五交水费"]) expect(log).toContain(kept);
    expect(messagesOf(frontend).filter((m) => m.message.speaker === "agent").map(textOf)).toContain(reply);
    expect(td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).map((e) => textOf(e.payload as MessageEventPayload))).toEqual(expect.arrayContaining([reply, "看看记账本和家电档案的规格"]));

    // 秘书的会话文件也改了：秘书停下、改写、接着同一个会话再拉起；之后它看到的上下文里那四次调用只剩删除标记
    await waitUntil(() => td.daemon.secretary.pid !== undefined && td.daemon.secretary.pid !== secretaryPid && td.daemon.secretary.status === "idle", { timeoutMs: 60_000 });
    const session = sessionText(td.daemon.layout.sessions, "secretary");
    for (const gone of ["每月十号对一次信用卡账单", "只记家里的日常开销", "月度导出已经做完"]) expect(session).not.toContain(gone);
    expect(session).toContain("保修卡拍照存档");
    await tell(frontend, "刚才看到了什么");
    const seen = textOf(messagesOf(frontend).at(-1)!);
    expect(seen).toContain(`[toolResult] read: ${PURGED_TEXT}`);
    expect(seen).toContain("保修卡拍照存档");
    expect(seen).not.toContain("每月十号对一次信用卡账单");
    expect(seen).toContain(reply);
  }, 180_000);
});

describe("跨项目任务读过的项目内容", () => {
  it("删其中一个项目之后：任务自己的维护者读项目档案读到的、评审子 agent 读这个项目的（工作目录、项目档案、经别的项目工作目录里的联接读到的）完整内容和返回都取不到，详情注明已随项目删除，效果日志、任务维护者的聊天记录和会话文件里也没有；读另一个项目的不受影响", async () => {
    const { dataDir, homeDir, recordsA, recordsB } = places();
    // 家电档案的工作目录里一个目录联接，指向记账本的工作目录：写的路径在家电档案里，真实路径在记账本里
    fs.symlinkSync(path.join(recordsA, "workdir"), path.join(recordsB, "workdir", "link-a"), "junction");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      secretary: [say("好的")],
      reviewer: () => [
        call("read", { path: path.join(recordsA, "workdir", "export.md") }),
        call("read", { path: path.join(recordsA, "progress.md") }),
        call("read", { path: path.join(recordsB, "workdir", "link-a", "export.md") }),
        call("read", { path: path.join(recordsB, "workdir", "import.md") }),
        call("submit_review", { results: [{ index: 1, passed: true, reason: "两边的说明都在" }] }),
        say("评审完了"),
      ],
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          // 规划时先读两个项目的规格
          if (spawn === 1)
            return [
              call("read_project_records", { project: "记账本", docs: ["spec"] }),
              call("read_project_records", { project: "家电档案", docs: ["spec"] }),
              submitPlanStep(twoProjectReviewedPlan()),
              say("计划交了"),
            ];
          // 开始执行、两张回执各一轮；两张都到了宣布 s1 完成，交给评审
          return [say("等回执"), say("收到一张回执"), call("complete_stage", { stageId: "s1", summary: "两边的回执到齐了" }), say("交给评审了"), say("收到"), say("收到"), say("收到")];
        }
        if (id === "pm-1")
          return [
            call("write", { path: "export.md", content: "记账本导出字段：日期、金额、备注\n" }),
            progressEdit(recordsA, "导出说明加好了：记账本导出三列。"),
            call("write_segment_summary", { summary: "给任务 t-1 加了导出说明" }),
            receipt("加好了 export.md"),
            say("交回执了"),
          ];
        if (id === "pm-2")
          return [
            call("write", { path: "import.md", content: "家电档案导入字段：型号、保修期\n" }),
            progressEdit(recordsB, "导入说明加好了。"),
            call("write_segment_summary", { summary: "给任务 t-1 加了导入说明" }),
            receipt("加好了 import.md"),
            say("交回执了"),
          ];
        return [];
      },
    });
    const toolkit = { skills: [], mcp: [], bash: false, network: false };
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit });
    seedProject(td.daemon, "家电档案", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit });
    fs.writeFileSync(path.join(recordsA, "spec.md"), "记账本规格：月底按三列对账\n");
    fs.writeFileSync(path.join(recordsB, "spec.md"), "家电档案规格：保修卡拍照存档\n");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [PROJECTS]: 0, [TM1]: 0 });

    // 用户点"发起任务"、选两个项目；秘书写好任务书（直接写）；确认计划，两张工单派出、交回执，评审通过，任务完成
    ok(await frontend.startTask("记账本导出接家电档案", "start-两个项目", ["记账本", "家电档案"]));
    const taskId = (await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务建出")).task.id;
    td.daemon.tasks.writeBrief(taskId, { goal: "记账本的账单能导进家电档案", acceptanceCriteria: ["两边都改好"], constraints: [], projects: ["记账本", "家电档案"], memoryScope: "" });
    const plan = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === taskId, "计划卡");
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
    await eventually(() => tasksOf(frontend), (e) => e.task.id === taskId && e.change === "completed", "任务完成", 120_000);
    expect(td.daemon.tasks.get(taskId)?.projectScope).toBe("multi");

    // 评审子 agent 的四次读：不在任何会话里，归属是这个任务和阶段，没有项目（任务不属于单个项目）
    const reads = td.daemon.store
      .read("tool_calls")
      .map((e) => e.payload as ToolCallDetail)
      .filter((d) => d.agentId.startsWith("review-") && d.tool === "read");
    expect(reads.map((d) => [d.conversation, d.taskId, d.projectId ?? null, d.outcome])).toEqual(Array.from({ length: 4 }, () => [null, taskId, null, "done"]));
    const [exportRead, progressRead, linkRead, importRead] = reads as [ToolCallDetail, ToolCallDetail, ToolCallDetail, ToolCallDetail];
    expect(exportRead.result).toContain("日期、金额、备注");
    expect(progressRead.result).toContain("记账本导出三列");
    expect(linkRead.result).toContain("日期、金额、备注");
    expect(importRead.result).toContain("型号、保修期");
    // 任务自己的维护者规划时读的两个项目的档案：在它的会话里，归属是这个任务
    const tmReads = td.daemon.store
      .read("tool_calls")
      .map((e) => e.payload as ToolCallDetail)
      .filter((d) => d.agentId === "tm-1" && d.tool === "read_project_records");
    expect(tmReads.map((d) => [d.conversation, d.taskId, d.outcome])).toEqual([
      [TM1, taskId, "done"],
      [TM1, taskId, "done"],
    ]);
    const [tmReadA, tmReadB] = tmReads as [ToolCallDetail, ToolCallDetail];
    expect(tmReadA.result).toContain("月底按三列对账");
    expect(tmReadB.result).toContain("保修卡拍照存档");
    expect(sessionText(td.daemon.layout.sessions, "tm-1")).toContain("月底按三列对账");

    // 记账本归档、删除
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    await deleteProject(frontend, "p-1");

    for (const d of [exportRead, progressRead, linkRead]) {
      const { body } = await toolCallDetail(td.url, d.callId);
      expect(body).toMatchObject({ tool: "read", outcome: "done", conversation: null, taskId, purged: true, purgedBy: "project_deletion", result: PURGED_TEXT });
      expect(body).not.toHaveProperty("effects");
    }
    // 任务维护者读记账本档案的那次：完整内容一样；聊天里的工具调用记录只换掉参数摘要和结果摘要，会话文件里那次调用也改
    expect((await toolCallDetail(td.url, tmReadA.callId)).body).toMatchObject({ tool: "read_project_records", conversation: TM1, purged: true, purgedBy: "project_deletion", result: PURGED_TEXT });
    const tmPurged = (await frontend.next(TM1, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(tmPurged).toMatchObject({ materialIds: [], mediaIds: [], toolCallIds: [tmReadA.callId] });
    expect(tmPurged.messages.map((m) => m.replacement?.parts)).toEqual([[expect.objectContaining({ callId: tmReadA.callId, argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT })]]);
    await waitUntil(() => !sessionText(td.daemon.layout.sessions, "tm-1").includes("月底按三列对账"), { timeoutMs: 60_000, describe: () => "等任务维护者的会话文件改写" });
    expect(sessionText(td.daemon.layout.sessions, "tm-1")).toContain("保修卡拍照存档");
    expect((await toolCallDetail(td.url, tmReadB.callId)).body).toMatchObject({ result: expect.stringContaining("保修卡拍照存档") });
    // 读家电档案的那次照旧（连同效果记录）
    const kept = (await toolCallDetail(td.url, importRead.callId)).body;
    expect(kept).toMatchObject({ result: expect.stringContaining("型号、保修期"), effects: [expect.objectContaining({ tool: "read", summary: expect.stringContaining("型号、保修期") })] });
    expect(kept).not.toHaveProperty("purged");
    // 效果日志：读记账本的三次摘要换成删除标记、调用 id 去掉
    const reviewEffects = effectLog(td.daemon.store).filter((r) => r.agentId.startsWith("review-") && r.tool === "read");
    expect(reviewEffects.map((r) => [r.summary === PURGED_TEXT, r.callId ?? null])).toEqual([
      [true, null],
      [true, null],
      [true, null],
      [false, importRead.callId],
    ]);
    // 事件日志里记账本的内容一个字都不剩（维护者写的、评审读的）；家电档案的还在
    const log = everything(td.daemon.store);
    expect(log).not.toContain("日期、金额、备注");
    expect(log).not.toContain("记账本导出三列");
    expect(log).not.toContain("月底按三列对账");
    expect(log).toContain("型号、保修期");
    expect(log).toContain("保修卡拍照存档");
  }, 240_000);
});

/** 进展文档一开始的那句（项目档案的最小文档集）换成另一句：项目维护者写回项目档案 */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";
const progressEdit = (records: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: PROGRESS_INTRO, newText }] });
/** 项目维护者交回执（完成） */
const receipt = (text: string) => call("submit_receipt", { outcome: "done", summary: text });

/** 一个阶段（评审验收），两个项目各一行 */
function twoProjectReviewedPlan(): Plan {
  return {
    stages: [
      {
        stageId: "s1",
        title: "两边一起改",
        deliverables: ["两边一起改的回执"],
        acceptance: [{ criterion: "各项目的改动都在工作目录里", method: "review" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 10_000_000, toolCalls: 300 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    projects: [
      { project: "记账本", changes: ["加一个导出说明 export.md"], stageId: "s1", acceptance: ["工作目录里有 export.md"] },
      { project: "家电档案", changes: ["加一份导入说明 import.md"], stageId: "s1", acceptance: ["工作目录里有 import.md"] },
    ],
    watchCategories: BUILTIN_CATEGORY_IDS.map((id) => ({ id })),
    assumptions: [],
    stops: { count: 0, where: [] },
    tokenEstimate: 50_000,
  };
}
