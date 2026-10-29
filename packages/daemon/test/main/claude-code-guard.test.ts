// 主切面：Claude Code 的工具调用都过二狗守卫、全程留记录（288 号票）。真的守护进程走组合根和插件清单，清单里的 Claude Code 插件经
// extraPlugins 换成子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程、守卫的钩子都是真的，SDK 按 faux 剧本扮演 claude，
// 每次工具调用之前走一遍权限流程——PreToolUse 钩子、要问人的 canUseTool——不启动真的 claude、不花额度）。测试扮演前端。
// - 运行时是 Claude Code 的任务：Bash 写受保护区域被守卫拦下（模型收到守卫的说明）；Claude 自带的 TodoWrite 照登记放行（不按工具白名单硬拒绝）；
//   子代理（Agent）里的调用也过守卫（读得到的放行、读密钥区的拦下），记录挂在 Agent 那次调用下面；AskUserQuestion 变成提问卡，前端答了交回 Claude；
//   每条消息、每次工具调用（参数和结果的完整内容，参数是 Claude 的原样）都在事件库里查得到；
// - 流程里按计划改参数：Claude 的 Write 写错了内容，守卫按计划改回、子进程交给 Claude 执行改回的那一版，结果前面写明（和 pi 的一样，
//   照 workflow-guard.test.ts 的那一条；bash 的命令和计划不一样是"超出计划声明的范围"，问用户、不自动改，pi 也一样）。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type ResponseFrame,
  type RuntimeQuestionCardPayload,
  type Task,
  type WorkflowPlanDraft,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardPlaces, TOOL } from "../../src/guard/index.ts";
import { findToolCallDetail } from "../../src/guard-runtime/tool-call-details.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { reviewWorkflowDraft } from "../../src/tasks/workflow-plan.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const messagesOf = (td: TestDaemon, task: Task) => td.daemon.store.read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message);
const toolParts = (td: TestDaemon, task: Task): ToolCallPart[] => messagesOf(td, task).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const cardsOf = (td: TestDaemon): Card[] => td.daemon.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card);
const latestCard = (td: TestDaemon, cardId: string) => cardsOf(td).filter((c) => c.id === cardId).at(-1)!;
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const callsSoFar = (td: TestDaemon, task: Task) => toolParts(td, task).map((p) => `${p.tool}:${p.outcome}${p.blockedBy ? `/${p.blockedBy}` : ""}`).join("、");

describe("Claude Code 的工具调用都过二狗守卫（假 SDK）", () => {
  it("Bash 被拦下、自带的 TodoWrite 照登记放行、子代理里的调用也过守卫、AskUserQuestion 变提问卡；每条消息和每次调用都在事件库里", async () => {
    let td!: TestDaemon;
    const secretsFile = () => path.join(dataDirLayout(td.dataDir).secrets, "keys.env");
    const configFile = () => path.join(dataDirLayout(td.dataDir).config, "config.json");
    td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: () => [
        call("Bash", { command: `echo hacked > "${configFile().replaceAll("\\", "/")}"`, description: "改配置" }),
        call("TodoWrite", { todos: [{ content: "整理下载目录", status: "in_progress", activeForm: "在整理" }] }),
        call("Agent", {
          description: "查资料",
          prompt: "看看说明和密钥",
          fake_subagent_calls: [
            { name: "Read", arguments: { file_path: "notes.md" } },
            { name: "Bash", arguments: { command: `cat "${secretsFile().replaceAll("\\", "/")}"` } },
          ],
        }),
        call("AskUserQuestion", {
          questions: [{ question: "按什么分？", header: "分法", options: [{ label: "按月份", description: "一个月一个文件夹" }, { label: "按类型", description: "图片、文档分开" }], multiSelect: false }],
        }),
        say("按月份整理好了。"),
      ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0 });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录整理一下", runtime: CLAUDE_CODE_RUNTIME_ID });

    // AskUserQuestion：提问卡进维护者的会话和待我处理，活动状态等你；前端答了交回 Claude
    let card: Card | undefined;
    await waitUntil(() => (card = cardsOf(td).find((c) => c.type === "runtime_question" && c.status === "pending")) !== undefined, {
      timeoutMs: 60_000,
      describe: () => `等提问卡；工具调用：${callsSoFar(td, task)}`,
    });
    const payload = card!.payload as RuntimeQuestionCardPayload;
    expect(payload).toMatchObject({ agentId: task.maintainerId, runtimeTitle: "Claude Code", question: { kind: "choices", questions: [{ question: "按什么分？", header: "分法", multiSelect: false }] } });
    expect(messagesOf(td, task).some((m) => m.parts.some((p) => p.type === "card_ref" && p.cardId === card!.id))).toBe(true);
    const inbox = td.daemon.store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem).map((e) => (e.payload as InboxItemEventPayload).item);
    expect(inbox.some((i) => i.kind === "card" && i.cardId === card!.id)).toBe(true);
    // 单选题选两个不行
    const refused = await frontend.cardAction({ cardId: card!.id, action: "answer", expectedVersion: 1, input: { answers: [{ question: "按什么分？", selected: ["按月份", "按类型"] }] } });
    expect(refused.ok).toBe(false);
    ok(await frontend.cardAction({ cardId: card!.id, action: "answer", expectedVersion: 1, input: { answers: [{ question: "按什么分？", selected: ["按月份"] }] } }));

    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 60_000, describe: () => `等任务做完，现在 ${taskNow(td, task.id).state}；工具调用：${callsSoFar(td, task)}` });
    expect(latestCard(td, card!.id)).toMatchObject({ status: "handled", payload: { reply: { kind: "choices", answers: [{ question: "按什么分？", selected: ["按月份"] }] } } });

    // 每次工具调用都有记录（工具名是映射到守卫登记表之后的），子代理里的挂在 Agent 那次下面
    // 记录在调用结束时写：子代理里的两次先结束，Agent 那次在它们后面
    const parts = toolParts(td, task);
    expect(parts.map((p) => p.tool)).toEqual([TOOL.bash, "TodoWrite", TOOL.read, TOOL.bash, "Agent", "AskUserQuestion"]);
    const [bash, todo, read, subBash, agent, ask] = parts;
    expect(bash).toMatchObject({ outcome: "blocked", genericBash: true });
    expect([todo!.outcome, agent!.outcome, read!.outcome, ask!.outcome]).toEqual(["done", "done", "done", "done"]);
    expect(todo!.blockedBy).toBeUndefined();
    expect(read).toMatchObject({ parentCallId: agent!.callId });
    expect(subBash).toMatchObject({ outcome: "blocked", parentCallId: agent!.callId });
    expect(ask!.resultSummary).toContain("按月份");

    // 完整内容（ADR-0020）：参数是 Claude 的原样、工具名另记；拦下的结果是模型收到的说明
    const bashDetail = findToolCallDetail(td.daemon.store, bash!.callId)!;
    expect(bashDetail).toMatchObject({ tool: TOOL.bash, nativeTool: "Bash", outcome: "blocked", isError: true, args: { description: "改配置" } });
    expect(bashDetail.result).not.toBe("");
    expect(findToolCallDetail(td.daemon.store, read!.callId)).toMatchObject({ tool: TOOL.read, nativeTool: "Read", args: { file_path: "notes.md" }, parentCallId: agent!.callId });
    expect(findToolCallDetail(td.daemon.store, todo!.callId)).toMatchObject({ tool: "TodoWrite", args: { todos: [{ content: "整理下载目录" }] } });
    expect(findToolCallDetail(td.daemon.store, todo!.callId)!.nativeTool).toBeUndefined();
    expect(fs.existsSync(configFile()) ? fs.readFileSync(configFile(), "utf8") : "").not.toContain("hacked");

    // 每条消息：交给它的任务书、它的回复都在会话里
    const messages = messagesOf(td, task);
    expect(messages.some((m) => m.speaker !== "agent" && m.parts.some((p) => p.type === "text" && p.text.includes("把下载目录整理一下")))).toBe(true);
    expect(messages.some((m) => m.speaker === "agent" && m.parts.some((p) => p.type === "text" && p.text === "按月份整理好了。"))).toBe(true);
  }, 120_000);

  it("流程里按计划改参数：Claude 的 Write 写错了内容，守卫按计划改回、Claude 执行改回的那一版，结果前面写明；记录标着按计划改回", async () => {
    const execution: FauxStep[] = [call("Write", { file_path: "notes.md", content: "# 笔记\n" }), say("周报写好了。")];
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: (_id, spawn) => (spawn === 1 ? [say("我先想想怎么做。")] : execution),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "写周报", summary: "写周报", kind: "workflow", runtime: CLAUDE_CODE_RUNTIME_ID });
    td.daemon.tasks.writeBrief(task.id, { goal: "写周报", acceptanceCriteria: ["周报写好"], constraints: [], projects: [], memoryScope: "" });
    await waitUntil(() => td.daemon.store.read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.turnEnd).length >= 1, { timeoutMs: 60_000, describe: () => "等起草计划的那一轮" });

    // Claude Code 的维护者还没有二狗的工具（291 号票）：计划由测试照"提交计划"那样审查、交给用户授权
    const real = fs.realpathSync.native(td.dataDir);
    const layout = dataDirLayout(real);
    const places: GuardPlaces = {
      dataDir: { root: layout.root, config: layout.config, secrets: layout.secrets, db: layout.db, projects: layout.projects },
      programDir: fs.realpathSync.native(td.programDir),
      homeDir: fs.realpathSync.native(td.homeDir),
      ownPorts: [],
    };
    const work = path.join(layout.outputs, task.id);
    fs.mkdirSync(work, { recursive: true });
    const draft: WorkflowPlanDraft = {
      goal: "写周报",
      steps: [{ id: "s1", title: "写周报", tool: TOOL.write, args: { path: "notes.md", content: "# 周报\n- 第一条\n" } }],
      rules: [{ id: "weekly-title", title: "周报以「# 周报」开头", trigger: { tool: TOOL.write }, require: { check: { startswith: ["$current.args.content", "# 周报"] } }, on_violation: "pull_back" }],
    };
    const reviewed = await reviewWorkflowDraft(draft, td.daemon.tasks.nextPlanRevision(task.id), { tools: BUILTIN_TOOL_REGISTRY, settings: {}, places, maintainerId: task.maintainerId, cwd: work, now: Date.now() });
    const { cardId } = td.daemon.tasks.submitWorkflowPlan(task.id, task.maintainerId, reviewed);
    expect(reviewed.plan.review.status).not.toBe("blocked");
    ok(await frontend.cardAction({ cardId, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
    await waitUntil(() => taskNow(td, task.id).state === "running", { timeoutMs: 30_000, describe: () => `等流程开始执行，现在 ${JSON.stringify(taskNow(td, task.id))}` });

    let write: ToolCallPart | undefined;
    await waitUntil(() => (write = toolParts(td, task).find((p) => p.tool === TOOL.write)) !== undefined, {
      timeoutMs: 60_000,
      describe: () => `等 Write 的记录；工具调用：${callsSoFar(td, task)}；卡：${JSON.stringify(cardsOf(td).filter((c) => c.type === "approval").map((c) => c.payload))}`,
    });
    expect(write).toMatchObject({ outcome: "done", plan: { stepId: "s1", correction: "rewrite" } });
    expect(cardsOf(td).filter((c) => c.type === "approval")).toEqual([]);
    const detail = findToolCallDetail(td.daemon.store, write!.callId)!;
    // 模型收到的结果：前面写明按计划改回，Claude 执行的是改回的那一版（file_path 换回 Claude 的参数名）
    expect(detail.result).toMatch(/^【自动纠偏】参数和计划对不上，已按计划改回/);
    expect(detail.result).toContain(`（假 SDK 执行了 Write：${JSON.stringify({ file_path: "notes.md", content: "# 周报\n- 第一条\n" })}）`);
    // 完整内容里的参数是 Claude 原样给的
    expect(detail).toMatchObject({ tool: TOOL.write, nativeTool: "Write", args: { file_path: "notes.md", content: "# 笔记\n" } });
  }, 120_000);
});
