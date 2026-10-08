// 主切面里要一个"执行中"的任务，两种走法：
// - runningTask（22 号票：秘书的看板感知、任务控制）：任务直接经任务服务建出、写好任务书，维护者（faux）交一份只有一个阶段的计划，
//   测试在计划卡上确认，有名额就开始执行。
//   用法：startTestDaemon({ maintainer: maintainerScript() })，连上订阅了看板和卡片频道的前端，再 runningTask(td, frontend, "标题")。
// - startRunningTask（23 号票的被杀恢复、LSM 报忙）：只经前端协议走，守护进程在测试进程里、在独立进程里都能用。
//   前端点"发起任务"，秘书按剧本写任务书交给 t-1 的维护者 tm-1，维护者按剧本交一份一个阶段、开 bash 的计划，前端在计划卡上确认。
//     const td = await startTestDaemon({ secretary: SECRETARY_BRIEFS, maintainer: (_id, n) => maintainerScripts(执行时的剧本)[n - 1] ?? [] });
//     const frontend = await TestFrontend.connect(td.url);
//     await frontend.subscribe({ [CHANNELS.board]: 0, [CHANNELS.cards]: 0 });
//     await startRunningTask(frontend);
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

/** bashPlan 里那条授权项的目录：项目外的一个固定路径，测试不会去建它 */
const OUTSIDE_DIR = "Z:\\ergou-test\\outside";

export const RUNNING_TASK_ID = "t-1";
export const RUNNING_TASK_TITLE = "整理笔记";

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 秘书收到"发起任务"按钮的通知后写好任务书，交给 t-1 的维护者 tm-1 */
export const SECRETARY_BRIEFS: FauxStep[] = [
  call("write_task_brief", { taskId: RUNNING_TASK_ID, goal: RUNNING_TASK_TITLE, acceptanceCriteria: ["notes.md 写好"], constraints: [], projects: [], memoryScope: "" }),
  { kind: "reply", text: "任务书写好了" },
];

/**
 * 一个阶段、工具包开 bash 不联网、脚本验收的计划。带一条在项目外建目录的授权项（不会真用到）：计划因此"预料到了"越出项目目录
 * 这一类，任务里读写项目外的文件判为超出授权——先问用户、调用等着用户批准（14 号票：计划完全没涉及的类别会马上挂起这一支，
 * 不等），这里的主切面要的是"调用在等审批"
 */
export function bashPlan(): Plan {
  return {
    ...samplePlan(),
    stages: [
      {
        stageId: "s1",
        title: "整理",
        deliverables: ["notes.md"],
        acceptance: [{ criterion: "notes.md 存在", method: "script", script: "test -f notes.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [{ id: "outside-dir", tool: "make_dir", title: "在项目外建一个目录", scope: { path: OUTSIDE_DIR } }], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: true, network: false },
    scheduledJobs: [],
    stops: { count: 0, where: [] },
  };
}

/** 维护者每次唤起的剧本：第一次交计划（bashPlan），确认后（按计划重新装配）照 run 执行 */
export function maintainerScripts(run: FauxStep[]): FauxStep[][] {
  return [[submitPlanStep(bashPlan()), { kind: "reply", text: "计划交上去了" }], run];
}

/** 点"发起任务"、秘书写任务书、维护者交计划、在计划卡上确认：任务 t-1 开始执行（前端要订阅了看板和卡片） */
export async function startRunningTask(frontend: TestFrontend): Promise<void> {
  ok(await frontend.startTask(RUNNING_TASK_TITLE));
  const plan = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === RUNNING_TASK_ID, "计划卡");
  ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: plan.version, input: {} }));
  await eventually(() => tasksOf(frontend), (e) => e.task.id === RUNNING_TASK_ID && e.change === "started", "任务开始执行");
}
