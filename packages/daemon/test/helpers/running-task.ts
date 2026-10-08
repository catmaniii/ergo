// 主切面里要一个"执行中"的任务（22 号票：秘书的看板感知、任务控制）：任务直接经任务服务建出、写好任务书，
// 维护者（faux）交一份只有一个阶段的计划，测试在计划卡上确认，有名额就开始执行。
// 用法：startTestDaemon({ maintainer: maintainerScript() })，连上订阅了看板和卡片频道的前端，再 runningTask(td, frontend, "标题")。
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type Plan, type PlanCardPayload, type ResponseFrame, type TaskEventPayload } from "@ergou/protocol";
import type { FauxStep } from "../../src/runtime/index.ts";
import type { TestDaemon } from "./daemon.ts";
import type { TestFrontend } from "./frontend.ts";
import { samplePlan, submitPlanStep } from "./plans.ts";
import { waitUntil } from "./process.ts";

/** 只有一个开放阶段、由用户验收、不涉及授权的计划 */
export function onePlan(): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "动手做",
        deliverables: ["结果"],
        acceptance: [{ criterion: "你看过觉得行", method: "user" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    scheduledJobs: [],
    stops: { count: 1, where: ["由你验收"] },
  };
}

/** 维护者的剧本：第一次唤起交计划，之后（按计划重新装配后）每次唤起只回一句 */
export const maintainerScript =
  (plan: Plan = onePlan()) =>
  (_maintainerId: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [submitPlanStep(plan), { kind: "reply", text: "计划交上去了" }] : [{ kind: "reply", text: "开始做了" }, { kind: "reply", text: "接着做" }];

export const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);

export async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

/** 请求成功就拿到结果，失败就抛出（带错误码和说明） */
export const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

/** 建一个任务、维护者交计划、在计划卡上确认，等它开始执行；返回任务 id（前端要订阅看板和卡片频道） */
export async function runningTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<string> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, { goal: title, acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
  ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
  await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "started", `${task.id} 开始执行`);
  return task.id;
}
