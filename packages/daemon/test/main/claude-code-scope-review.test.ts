// 主切面：Claude Code 的范围审视由二狗另起、二狗 skill 的斜杠写法自动换（309 号票）。真的守护进程走组合根和插件清单，清单里的 Claude Code 插件经
// extraPlugins 换成子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程、钩子都是真的；SDK 按 faux 剧本扮演 claude，/compact 扮演
// Claude Code 的手动压缩、先叫 PreCompact 钩子），审视用的便宜模型由 faux 扮演；不启动真的 claude、不花额度、不碰用户真实的 ~/.claude。
// - Claude 子进程里调不了二狗的审视模型：压缩前（PreCompact 钩子报 compacting）守护进程按自己记下的这段会话事件另起一次一次性审视（审视的模型、
//   pi 的同一套提示和写法），结果照 pi 的格式记下——范围记录（trigger compaction）、时间线、待我处理（越界）、产出区或项目档案；用量记在任务名下；
//   下一次压缩只审视上次压缩之后的那段；
// - 工单结束时的审视也走它（不送给 Claude 子进程）；能力清单 scope_review 是 true；
// - 用户按 pi 的习惯打 /<目录名>（或 /skill:<目录名>），是工具包里的 skill 的，交给 Claude Code 的是 /ergo:<目录名>；和 Claude Code 自己的命令
//   同名时 Claude Code 的优先（原样交）；补全里两个都列。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type Plan,
  type ScopeRecordEventPayload,
  type SlashCommandList,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkOrderEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { CLAUDE_CODE_CAPABILITIES } from "../../src/claude-code/runtime.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { samplePlan } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { byMaintainer, internalTask, seedProject } from "../helpers/projects.ts";

const { board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const echo: FauxStep = { kind: "echo_context" };

/** 审视模型的回复：一条记录，说明里放着它这次收到的全部输入（核对审视的输入） */
const finding = (kind: "scope_change" | "out_of_scope", summary: string, basis?: string): FauxStep => ({
  kind: "reply_with_context",
  text: JSON.stringify({ records: [{ kind, summary, detail: "@@", ...(basis === undefined ? {} : { basis }) }] }).replace('"@@"', '"审视的输入：{{context}}"'),
});

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (parts: readonly MessagePart[]) => parts.map((p) => ("text" in p ? p.text : "")).join("");
const scopeRecordsOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.scopeRecord }).map((f) => (f.payload as ScopeRecordEventPayload).record);
const timelineOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => (f.payload as TimelineRecordEventPayload).record);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const inboxOf = (frontend: TestFrontend) => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const failureNotes = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.message.speaker === "system" && textOf(m.message.parts).startsWith("范围审视没做成"));
/** 审视的输入里工作记录那一段（对照物里也列着用户的话，核对"审视了哪段对话"只看这一段） */
const workLogOf = (detail: string | undefined) => {
  const at = detail?.indexOf("<work-log>") ?? -1;
  return at < 0 ? "" : detail!.slice(at);
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

async function connect(url: string, channels: string[]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

const scopeUsage = (td: TestDaemon, taskId: string) => td.daemon.ledger.entries({ kind: "task", id: taskId }).filter((e) => e.purpose === "scope_review");

describe("Claude Code 的范围审视由二狗另起（假 SDK、假模型）", () => {
  it("能力清单：scope_review 是 true（Claude 子进程里不做，二狗按自己记下的事件另起一次）", () => {
    expect(CLAUDE_CODE_CAPABILITIES.scope_review).toBe(true);
  });

  it("任务的维护者用 Claude Code：压缩前守护进程按自己记下的这段会话另起一次审视，照 pi 的格式记下；下一次压缩只审视上次压缩之后的", async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      secretary: [say("好的")],
      maintainer: (id) => (id === "tm-1" ? [say("收到任务书"), say("好，先导出分类表 CSV"), say("图表也画好了")] : []),
      // 每次审视是另起的一次性子进程：剧本每次从头取
      scopeReviewer: (id) => (id === "tm-1" ? [finding("scope_change", "按用户说的先导出了分类表 CSV", "用户在会话里说：先帮我导出分类表 CSV")] : []),
    });
    const TM1 = maintainerChannel("tm-1");
    const frontend = await connect(td.url, [BOARD, INBOX, TM1]);
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研", runtime: CLAUDE_CODE_RUNTIME_ID });
    expect(task.runtime).toBe(CLAUDE_CODE_RUNTIME_ID);
    td.daemon.tasks.writeBrief(task.id, { goal: "调研 X 的现状", acceptanceCriteria: ["有调研报告"], constraints: ["只看公开资料"], projects: [], memoryScope: "" });
    await turnsOf(frontend, TM1, 1);
    await frontend.sendText("先帮我导出分类表 CSV", { conversation: TM1 });
    await turnsOf(frontend, TM1, 2);

    // 用户打 /compact（原样交给 Claude Code）：Claude 压缩之前叫 PreCompact，守护进程按自己的记录另起一次审视
    await frontend.sendText("/compact", { conversation: TM1 });
    const record = await eventually(() => scopeRecordsOf(frontend, BOARD), (r) => r.kind === "scope_change", "看板频道上的范围记录");
    expect(record).toMatchObject({ summary: "按用户说的先导出了分类表 CSV", basis: "用户在会话里说：先帮我导出分类表 CSV", trigger: "compaction", maintainerId: "tm-1", taskId: task.id });
    // 审视的输入：pi 的同一套（审视的说明、对照物、按 pi 的写法转成文字的工作记录——用户的话、Claude 的回复）
    expect(record.detail).toContain("范围审视员");
    expect(record.detail).toContain("<scope-reference>");
    expect(record.detail).toContain("调研 X 的现状");
    expect(record.detail).toContain("只看公开资料");
    const log1 = workLogOf(record.detail);
    expect(log1).toContain("[User]: 先帮我导出分类表 CSV");
    expect(log1).toContain("[Assistant]: 好，先导出分类表 CSV");
    // 照 pi 的格式记下：时间线（范围变更、压缩过一次）、任务产出区的范围记录；用量记在任务名下（purpose: scope_review）
    await waitUntil(() => timelineOf(frontend, TM1).some((r) => r.kind === "compaction"), { describe: () => "等压缩完的时间线记录" });
    expect(timelineOf(frontend, TM1).filter((r) => r.kind === "scope_change")).toHaveLength(1);
    const file = path.join(td.daemon.layout.outputs, task.id, "scope-records.md");
    await waitUntil(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("按用户说的先导出了分类表 CSV"), { describe: () => "等范围记录写进任务的产出区" });
    expect(fs.readFileSync(file, "utf8")).toContain("范围变更 · 压缩会话时：按用户说的先导出了分类表 CSV");
    await waitUntil(() => scopeUsage(td, task.id).length >= 1, { describe: () => "等审视的用量记账" });
    expect(scopeUsage(td, task.id).map((e) => e.agentId)).toEqual(["tm-1"]);
    expect(failureNotes(frontend, TM1)).toEqual([]);

    // 再说一句、再压缩一次：这次只审视上次压缩之后的那段
    await turnsOf(frontend, TM1, 3);
    await frontend.sendText("再把图表也画了", { conversation: TM1 });
    await turnsOf(frontend, TM1, 4);
    await frontend.sendText("/compact", { conversation: TM1 });
    await waitUntil(() => scopeRecordsOf(frontend, BOARD).length >= 2, { describe: () => "等第二次压缩的范围记录" });
    const log2 = workLogOf(scopeRecordsOf(frontend, BOARD)[1]!.detail);
    expect(log2).toContain("[User]: 再把图表也画了");
    expect(log2).toContain("[Assistant]: 图表也画好了");
    expect(log2).not.toContain("先帮我导出分类表 CSV");
    await waitUntil(() => scopeUsage(td, task.id).length >= 2, { describe: () => "等第二次审视的用量记账" });
  }, 150_000);

  it("项目的维护者用 Claude Code：工单结束时的审视也由二狗另起（不送给 Claude 子进程），越界照 pi 的格式记下", async () => {
    const plan: Plan = { ...samplePlan(), toolkit: { skills: [], mcp: [], bash: false, network: false } };
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      secretary: [say("好的")],
      maintainer: (id, spawn) =>
        id === "pm-1" && spawn === 1
          ? [
              call("mcp__ergo__submit_plan", plan as unknown as Record<string, unknown>),
              call("mcp__ergo__write_progress", { content: "周报：计划交上去了。" }),
              call("mcp__ergo__write_segment_summary", { summary: "起草了周报计划" }),
              say("计划交上去了"),
            ]
          : [],
      scopeReviewer: (id) => (id === "pm-1" ? [finding("out_of_scope", "起草计划时顺手翻了别的项目的账本")] : []),
    });
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "other", runtime: CLAUDE_CODE_RUNTIME_ID, toolkit: { skills: [], mcp: [], bash: false, network: false } });
    fs.writeFileSync(path.join(td.daemon.projects.records(project.id).charter), "# 立项书\n\n## 范围\n\n- 只做记账和报表\n");
    const PM1 = maintainerChannel(project.maintainerId);
    const frontend = await connect(td.url, [BOARD, INBOX, PROJECTS, PM1]);

    internalTask(td.daemon, "记账本", "给记账本加周报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
    td.daemon.tasks.writeBrief(created.task.id, { goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: ["别动账本数据"], projects: ["记账本"], memoryScope: "" }, byMaintainer(td.daemon, created.task.id));

    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束", 90_000);
    const [record] = scopeRecordsOf(frontend, PROJECTS);
    expect(scopeRecordsOf(frontend, PROJECTS)).toHaveLength(1);
    expect(record).toMatchObject({ kind: "out_of_scope", summary: "起草计划时顺手翻了别的项目的账本", trigger: "work_order_end", maintainerId: "pm-1", projectId: project.id, workOrderId: ended.workOrder.id });
    // 审视的输入：立项书、任务书的约束，和这一段工作的记录（Claude 调的二狗的工具记成二狗的名字）
    expect(record!.detail).toContain("只做记账和报表");
    expect(record!.detail).toContain("别动账本数据");
    expect(workLogOf(record!.detail)).toContain("submit_plan(");
    expect(workLogOf(record!.detail)).toContain("[Assistant]: 计划交上去了");
    // 越界：待我处理里一条不推送的通知；时间线上标出；会话里没有"范围审视没做成"（不是送给 Claude 子进程、它回"不做"）
    expect(inboxOf(frontend).some((i) => i.kind === "notice" && i.notice === "out_of_scope")).toBe(true);
    expect(timelineOf(frontend, PM1).filter((r) => r.kind === "out_of_scope")).toHaveLength(1);
    expect(failureNotes(frontend, PM1)).toEqual([]);
    await waitUntil(() => scopeUsage(td, created.task.id).length >= 1, { describe: () => "等审视的用量记账" });
    expect(scopeUsage(td, created.task.id).map((e) => e.agentId)).toEqual(["pm-1"]);
  }, 150_000);
});

const slashCommands = (url: string, conversation: string) => requestJson<SlashCommandList>(url, HTTP_PATHS.slashCommands(conversation));
/** 会话里最近一条 echo_context 的回显（agent 的回复是那段 JSON） */
const echoes = (frontend: TestFrontend, channel: string): FakeClaudeEcho[] =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && textOf(m.message.parts).includes('"hookContext"'))
    .map((m) => JSON.parse(textOf(m.message.parts)) as FakeClaudeEcho);

describe("二狗 skill 的斜杠写法自动换（Claude Code，假 SDK）", () => {
  it("打 /<目录名>、/skill:<目录名> 交给 Claude 的是 /ergo:<目录名>；和 Claude Code 自己的命令同名时 Claude 的优先；补全两个都列", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: (id) => (id === "pm-1" ? [echo, echo, echo, echo] : []) });
    // 手放进 skill 区的两个 skill：review 和假 SDK 报的 Claude Code 命令 /review 同名
    for (const [name, description] of [
      ["weekly-report", "写周报"],
      ["review", "按二狗的规矩评审"],
    ]) {
      fs.mkdirSync(path.join(td.dataDir, "skills", name!), { recursive: true });
      fs.writeFileSync(path.join(td.dataDir, "skills", name!, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n照着做。\n`);
    }
    const project = seedProject(td.daemon, "记账本", {
      state: "in_use",
      charterConfirmed: true,
      kind: "dev",
      runtime: CLAUDE_CODE_RUNTIME_ID,
      toolkit: { skills: ["weekly-report", "review"], mcp: [], bash: false, network: false },
    });
    const pm = maintainerChannel(project.maintainerId);
    const frontend = await connect(td.url, [pm]);

    // pi 的写法 /<目录名>：交给 Claude Code 的是插件里的写法；会话里记的是用户打的原样
    await frontend.sendText("/weekly-report 写本周的", { conversation: pm });
    await waitUntil(() => echoes(frontend, pm).length >= 1, { timeoutMs: 60_000, describe: () => "等第一条回显" });
    expect(echoes(frontend, pm)[0]!.input).toBe("/ergo:weekly-report 写本周的");
    expect(messagesOf(frontend, pm).some((m) => m.message.speaker === "user" && textOf(m.message.parts) === "/weekly-report 写本周的")).toBe(true);

    // 和 Claude Code 自己的命令同名：Claude Code 的优先，原样交
    await frontend.sendText("/review", { conversation: pm });
    await waitUntil(() => echoes(frontend, pm).length >= 2, { timeoutMs: 60_000, describe: () => "等第二条回显" });
    expect(echoes(frontend, pm)[1]!.input).toBe("/review");

    // 后备写法 /skill:<目录名> 也换；已经是插件写法的原样
    await frontend.sendText("/skill:review 看看这次的改动", { conversation: pm });
    await frontend.sendText("/ergo:weekly-report", { conversation: pm });
    await waitUntil(() => echoes(frontend, pm).length >= 4, { timeoutMs: 60_000, describe: () => "等第四条回显" });
    expect(echoes(frontend, pm)[2]!.input).toBe("/ergo:review 看看这次的改动");
    expect(echoes(frontend, pm)[3]!.input).toBe("/ergo:weekly-report");

    // 补全：二狗的 skill 按插件里的写法列，Claude Code 自己的同名命令也列
    const texts = (await slashCommands(td.url, pm)).body.commands.map((c) => c.text);
    expect(texts).toEqual(expect.arrayContaining(["/ergo:review", "/ergo:weekly-report", "/review"]));
    expect(texts.filter((t) => t === "/ergo:review")).toHaveLength(1);
    expect(texts).not.toContain("/weekly-report");
  }, 120_000);
});
