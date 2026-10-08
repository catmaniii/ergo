// 主切面里走任务流程的小工具（14 号票起；13 号票的 task-execution.test.ts 里有同样的一份，各用各的）：
// 维护者 faux 剧本的步骤、从前端收到的事件里挑任务、卡片、待我处理事项、会话消息，建任务、确认计划。
import fs from "node:fs";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  type Task,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
} from "@ergou/protocol";
import type { FauxStep } from "../../src/runtime/index.ts";
import type { TestDaemon } from "./daemon.ts";
import { TestFrontend } from "./frontend.ts";
import { samplePlan, submitPlanStep } from "./plans.ts";
import { waitUntil } from "./process.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;

export const say = (text: string): FauxStep => ({ kind: "reply", text });
export const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
export const write = (file: string, content: string) => call("write", { path: file, content });
export const completeStage = (stageId: string, summary = `阶段 ${stageId} 做完了`) => call("complete_stage", { stageId, summary });
/** bash 里的路径用正斜杠 */
export const fwd = (p: string) => p.replaceAll("\\", "/");
/** 真实路径（测试的临时目录常带 8.3 短名，守卫看的是真实路径） */
export const real = (p: string) => fs.realpathSync.native(p);

export const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
export const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
export const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
/** 每张卡的最新样子 */
export const latestCards = (frontend: TestFrontend): Card[] => [...new Map(cardsOf(frontend).map((c) => [c.id, c])).values()];
export const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
export const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
export const stageStates = (task: Task) => Object.fromEntries((task.stages?.list ?? []).map((s) => [s.stageId, s.state]));
/** 会话里的时间线记录（25 号票的 timeline_record：偏离、计划变更、自行调整计划……） */
export const recordsOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload);
/** 维护者会话里交给它的系统通知 */
export const noticesOf = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput && m.message.speaker === "system");

export type ToolCallRecord = { tool: string; argsSummary: string; disposition?: string; withinGrant?: boolean; blockedBy?: string; outcome: string; resultSummary?: string };
export const toolCallsOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts)
    .filter((p) => p.type === "tool_call") as unknown as ToolCallRecord[];

export const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

export async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
export const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
export const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
export const itemWhere = (frontend: TestFrontend, match: (item: InboxItem) => boolean, what = "待我处理事项") => eventually(() => inboxOf(frontend), match, what);
/** 等某个维护者处理完 n 条输入 */
export const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 维护者会话里的输入（用户的话、交给它的系统通知）都处理完了（作为一轮，或者作为插话收下）：录事件流之前等它安静下来 */
export async function inputsDone(frontend: TestFrontend, channel: string): Promise<void> {
  const done = () => {
    const ended = new Set(frontend.events({ channel, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as { inputMessageId: string }).inputMessageId));
    return messagesOf(frontend, channel).every((m) => !(m.message.speaker === "user" || m.agentInput) || ended.has(m.message.id));
  };
  await waitUntil(done, { timeoutMs: 30_000, describe: () => `等 ${channel} 的输入都处理完` });
  // 处理完的最后一轮可能还带出别的事件（比如阶段推进）：稍等一下再看一遍
  await new Promise((r) => setTimeout(r, 300));
  await waitUntil(done, { timeoutMs: 30_000, describe: () => `等 ${channel} 的输入都处理完` });
}

/** 两个阶段：s1 收集资料（脚本验收），s2 写报告（评审验收，在 s1 之后）；不涉及授权、不涉及定时作业 */
export function twoStagePlan(overrides: Partial<Plan> = {}): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "收集资料",
        deliverables: ["资料清单 sources.md"],
        acceptance: [{ criterion: "资料清单存在", method: "script", script: "test -f sources.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 0, toolCalls: 0 },
      },
      {
        stageId: "s2",
        title: "写报告",
        deliverables: ["调研报告 report.md"],
        acceptance: [{ criterion: "报告文件存在", method: "script", script: "test -f report.md" }],
        mode: "open",
        dependsOn: ["s1"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 0, toolCalls: 0 },
      },
    ],
    stageGroups: [],
    scheduledJobs: [],
    stops: { count: 0, where: [] },
    ...overrides,
  };
}

const brief = { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" };

/** 连上前端，订阅看板、卡片、待我处理和前几个维护者的会话 */
export async function connect(url: string, maintainers = 1) {
  const frontend = await TestFrontend.connect(url);
  const channels = [BOARD, CARDS, INBOX, ...Array.from({ length: maintainers }, (_, i) => maintainerChannel(`tm-${i + 1}`))];
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 建一个任务、写好任务书，等维护者起草并交出计划；返回任务 id 和计划卡 */
export async function draftTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<{ taskId: string; card: Card }> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
  return { taskId: task.id, card };
}

/** 在计划卡上确认 */
export async function confirmPlan(frontend: TestFrontend, draft: { taskId: string; card: Card }): Promise<string> {
  ok(await frontend.cardAction({ cardId: draft.card.id, action: "confirm", expectedVersion: 1, input: {} }));
  return draft.taskId;
}

/** 建一个任务、写好任务书（维护者起草并交出计划），等它起草的这一轮结束（录下的事件流先后才固定），在计划卡上确认；返回任务 id */
export async function confirmTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<string> {
  const draft = await draftTask(td, frontend, title);
  await inputsDone(frontend, maintainerChannel(td.daemon.tasks.get(draft.taskId)!.maintainerId));
  return confirmPlan(frontend, draft);
}

/** 维护者的剧本：第一次唤起起草计划，之后（按计划装配重新拉起）照 run 执行 */
export const maintainerScript =
  (plan: Plan, run: FauxStep[] | ((spawn: number) => FauxStep[])) =>
  (_maintainerId: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : typeof run === "function" ? run(spawn) : run;
