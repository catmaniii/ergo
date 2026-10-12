// 任务控制快速动作（规格第 14 节、第 9 节"快速动作的确认"，22 号票）：用户在对话里说"暂停 / 继续 / 取消任务 X"，
// 秘书用"提议快速动作"提出 pause_task / resume_task / cancel_task，按 21 号票的快速动作流程执行。
// - 参数：任务（编号或完整标题，照抄用户的说法；同名的要写编号）。规范化时认出是哪个任务；现在能不能做只看
//   "谁能改"表推出的 availableTaskActions（assertUserCan），做不了的提议直接被拒（不出卡），说法是 taskActRefusal；
// - "点明了"（运行时判定，照记忆命令的做法从严：取消是终态，误判代价大）：
//   - 只看用户自己说的话（打的字，以及语音识别出的文字：31 号票，语音转写和打的字一样参与判定），一句一句、一个分句一个分句地看（句号、问号、分号、换行分句，逗号、顿号分分句）；
//   - 问句不算：以问号结尾，或者以"吗""么""呢""没有"这类收尾的（"t-3 取消了吗？"）；
//   - 分句里有这个动作的说法（暂停；继续、恢复；取消），它前面（同一分句里）没有否定词；
//   - 任务（编号作为一个词，或完整标题）出现在动作词后面到这一分句结束的那一段里（"取消 t-3"），或者是"把 X 暂停"的 X；
//     那一段只是指代（"取消这个"）时，任务要在用户引用的卡片上；
//   - 认任务（103 号票评审起，这里和下面 100 号票的两个都是）：编号或完整标题，子串不算——标题前面紧挨着的要是段首、标点、空白或引导词，
//     别的任务更长的标题把它盖住时算那个（"取消 AI 日报"不算点明取消"日报"，"日报汇总"不算"日报"），拿不准的出卡（mentionsRef）；
//   - 否则算推断（"取消提醒 r-1，t-3 怎么样了"），推断出来的一律先问（confirm: ask_when_inferred），不论关注类别设置如何。
//   不落入任何内置类别（用户的自定义类别照样能按 quick_action:pause_task 匹配它）；
// - 执行走执行控制器的结构化接口 prepareAct：任务控制算用户改的状态（by: user，按"谁能改"表里用户那一行校验），
//   和快速动作卡、操作记录同一事务追加；执行时再查一次能不能做（确认之前任务可能变了），做不了卡片保持待处理。
//   暂停、取消落到维护者身上的效果（中止手头这一轮）、名额满了回到排队中都是控制器和维护者模块的事（13 号票）。
// 100 号票照同一套加了两个（taskRunActions）：run_task_now（定时 / 事件触发的任务立即运行一次，走触发底座的 prepareRunNow）、
// set_voice_announce（开关跑完自动播报，走 tasks.buildVoiceAnnounce）。点明的判定照任务控制从严：同一个分句（所在的句子不是问句）里
// 同时写着这个任务（编号或完整标题）和这个说法、方向对——立即运行一次（"再跑一次""立即运行"……）前面没有否定词；打开是念出来的说法
// （"念给我""播报"……）加上说的是以后每次（"以后""每次""跑完""自动"……），没有否定和关掉；关掉是否定词紧挨着念、读、播报，
// 或者"关掉、取消……"和播报在一起。
// 提出时就看能不能做（上一次还在跑、不是定时触发的、项目内部的……），不能的直接拒、原因交回秘书，不出卡。
import { isProjectInternal, type Task, type TaskAction, TASK_STATE_LABEL, taskName, Type } from "@ergou/protocol";
import { VIEW_BOARD_TOOL } from "../board/tool-names.ts";
import {
  bareText,
  clausesOf,
  defineQuickAction,
  type ExplicitFinding,
  isQuestion,
  mentionsRef,
  type NamedRef,
  NEGATIONS,
  type NormalizedQuickAction,
  ownWords,
  type QuickActionExecutor,
  sentencesOf,
  type UserTurn,
} from "../quick-actions/index.ts";
import { RequestRejected } from "../errors.ts";
import type { ScheduledJobs } from "../scheduled-jobs/jobs.ts";
import { findByIdOrName } from "../util/find-by-ref.ts";
import type { TaskExecution } from "./execution.ts";
import { assertUserCan } from "./state-machine.ts";
import type { TaskService } from "./tasks.ts";

/** 三种任务控制的动作类型（秘书的系统提示、工具说明里引用） */
export const TASK_CONTROL_ACTION = { pause: "pause_task", resume: "resume_task", cancel: "cancel_task" } as const;

/** 三种任务控制：动作类型、对应的用户控制、中文名和动词、用户说它时的说法 */
const CONTROLS = [
  { type: TASK_CONTROL_ACTION.pause, action: "pause", title: "暂停任务", verb: "暂停", usage: "用户要暂停某个任务", triggers: ["暂停"] },
  {
    type: TASK_CONTROL_ACTION.resume,
    action: "resume",
    title: "继续任务",
    verb: "继续",
    usage: "用户要已暂停的（或卡住求助、他已经回过话的）任务接着执行",
    triggers: ["继续", "恢复"],
  },
  { type: TASK_CONTROL_ACTION.cancel, action: "cancel", title: "取消任务", verb: "取消", usage: "用户要取消某个还没结束的（或失败了的）任务", triggers: ["取消"] },
] as const satisfies ReadonlyArray<{ type: string; action: TaskAction; title: string; verb: string; usage: string; triggers: readonly string[] }>;

const Params = Type.Object(
  { task: Type.String({ minLength: 1, description: "哪个任务：任务编号（t-3，看板上有）或完整的任务标题，尽量照抄用户的说法" }) },
  { additionalProperties: false },
);

/** 动作词后面只是指代：任务要在引用的卡片上 */
const DEICTIC = new Set(["", "这个", "这个任务", "那个", "那个任务", "它", "这张卡", "卡上的", "卡片上的", "引用的"]);

/**
 * 这段话里点到了这个任务：编号，或者完整标题（排版上的差别不算）。子串不算（103 号票评审起：取消不可逆，"日报"不该直接命中"AI 日报"），
 * 别的任务更长的标题把这一处盖住时算那个（others）；判法在 quick-actions/explicit.ts 的 mentionsRef，按句、分句、问句的判法也在那里
 */
const mentions = (text: string, task: Task, others: readonly NamedRef[]): boolean => mentionsRef(text, { id: task.id, name: task.title }, others);

/** 别的任务（认标题时更长的那个优先；项目内部的也算上，只用来比，不往外说） */
const othersThan = (tasks: TaskService, task: Task): NamedRef[] => tasks.list().flatMap((t) => (t.id === task.id ? [] : [{ id: t.id, name: t.title }]));

/**
 * 用户说的一段话里，这个动作的每个说法（不在问句里、前面没有否定词）指着的那一段：动作词后面到分句结束的那一段，
 * 以及"把 X 暂停"的 X
 */
function controlTargets(text: string, triggers: readonly string[]): string[] {
  const targets: string[] = [];
  for (const sentence of sentencesOf(text)) {
    if (isQuestion(sentence)) continue;
    for (const clause of clausesOf(sentence)) {
      for (const trigger of triggers) {
        for (let at = clause.indexOf(trigger); at >= 0; at = clause.indexOf(trigger, at + 1)) {
          const before = clause.slice(0, at);
          if (NEGATIONS.some((n) => before.includes(n))) continue;
          targets.push(clause.slice(at + trigger.length));
          const ba = before.lastIndexOf("把");
          if (ba >= 0) targets.push(before.slice(ba + 1));
        }
      }
    }
  }
  return targets;
}

/** 用户这一轮点明了这个任务和这个动作（见文件开头）；没点明是 undefined */
function explicitControl(task: Task, triggers: readonly string[], turn: UserTurn, others: readonly NamedRef[]): ExplicitFinding | undefined {
  let deictic = false;
  for (const { text, source } of ownWords(turn)) {
    const targets = controlTargets(text, triggers);
    if (targets.some((t) => mentions(t, task, others))) return { source };
    deictic ||= targets.some((t) => DEICTIC.has(bareText(t).replace(/(吧|了|掉|一下)+$/u, "")));
  }
  if (deictic && turn.cards.some((card) => card.some((text) => mentions(text, task, others)))) return { source: "card" };
  return undefined;
}

/** 规范化后的参数（存进卡片和操作记录、执行时交回）里的任务编号 */
const taskIdOf = (params: unknown): string => (params as { taskId: string }).taskId;

/** 控制之后的说法 */
function resultText(task: Task, state: Task["state"]): string {
  if (state === "queued") return `${taskName(task)}要接着执行，但执行名额满了，回到排队中，名额空出来就接着执行`;
  return `${taskName(task)}现在是${TASK_STATE_LABEL[state]}`;
}

// ───────────────────────── 立即运行一次、跑完自动播报（100 号票） ─────────────────────────

/** 立即运行一次、开关跑完自动播报的快速动作类型（秘书的系统提示、工具说明里引用） */
export const TASK_RUN_ACTION = { runNow: "run_task_now", announce: "set_voice_announce" } as const;

/** 立即运行一次的说法（"跑一下""念"这类宽的不算） */
const RUN_NOW_SAYINGS = ["立即运行", "马上运行", "现在运行", "运行一次", "跑一次", "再跑", "重跑", "跑一遍", "马上跑", "现在跑", "触发一次"];
/** 跑完自动播报打开：要有念出来的说法…… */
const ANNOUNCE_READ = ["念给我", "念出来", "读给我", "读出来", "播报"];
/** ……还要说的是以后每次（"把 t-5 这次结果念给我"是现在念一下，不是开开关） */
const ANNOUNCE_STANDING = ["以后", "往后", "今后", "每次", "每回", "跑完", "做完", "自动", "打开", "开着"];
/** 跑完自动播报关掉：否定词紧挨着念、读、播报（中间可以有"再""自动""直接"），或者"关掉、关闭、取消……"和播报在一起 */
const ANNOUNCE_OFF = [/(别|不要|不用|不必|无需|甭|不再)(再|自动|直接)*(念|读|播报)/u, /(关掉|关闭|关了|取消|停掉|停了)[^，,、]*播报/u, /播报[^，,、]*(关掉|关闭|关了|取消|停掉|停了)/u];

/** 立即运行一次：分句里有这个说法，它前面没有否定词 */
const saysRunNow = (clause: string) => RUN_NOW_SAYINGS.some((s) => clause.includes(s) && !NEGATIONS.some((n) => clause.slice(0, clause.indexOf(s)).includes(n)));
/** 跑完自动播报关掉 */
const saysAnnounceOff = (clause: string) => ANNOUNCE_OFF.some((re) => re.test(clause));
/** 跑完自动播报打开：念出来的说法、说的是以后每次，分句里没有否定、没有关掉的说法 */
const saysAnnounceOn = (clause: string) =>
  ANNOUNCE_READ.some((s) => clause.includes(s)) && ANNOUNCE_STANDING.some((s) => clause.includes(s)) && !saysAnnounceOff(clause) && !NEGATIONS.some((n) => clause.includes(n));

/**
 * 用户这一轮点明了（照任务控制从严）：自己说的话里有一个分句（所在的句子不是问句）同时写着这个任务（编号或完整标题）和这个说法、
 * 方向对（says 认它）——说法和是哪个任务绑在同一个分句里，"t-5 以后别念了，t-6 念给我"里的 t-5 没有点明打开。
 * 没点明是 undefined（推断出来的出卡确认）
 */
function explicitSaying(task: Task, turn: UserTurn, says: (clause: string) => boolean, others: readonly NamedRef[]): ExplicitFinding | undefined {
  for (const { text, source } of ownWords(turn)) {
    for (const sentence of sentencesOf(text)) {
      if (isQuestion(sentence)) continue;
      if (clausesOf(sentence).some((clause) => mentions(clause, task, others) && says(clause))) return { source };
    }
  }
  return undefined;
}

const RunNowParams = Type.Object(
  { task: Type.String({ minLength: 1, description: "哪个任务（定时或事件触发的）：任务编号（t-5，看板上有）或完整的任务标题，尽量照抄用户的说法" }) },
  { additionalProperties: false },
);

const AnnounceParams = Type.Object(
  {
    task: Type.String({ minLength: 1, description: "哪个任务：任务编号（t-5，看板上有）或完整的任务标题，尽量照抄用户的说法" }),
    on: Type.Boolean({ description: "true 是打开（以后做完直接念给用户听），false 是关掉（照旧先问要不要念）" }),
  },
  { additionalProperties: false },
);

/** 立即运行一次、跑完自动播报两个快速动作（scheduledJobs 现取：触发底座在快速动作登记之后才建） */
export function taskRunActions(deps: { tasks: TaskService; scheduledJobs: () => Pick<ScheduledJobs, "ofTask" | "checkRunNow" | "prepareRunNow"> }): QuickActionExecutor[] {
  const { tasks } = deps;
  const findTask = (ref: string) => findByIdOrName(tasks.list().filter((t) => !isProjectInternal(t)), ref, { nameOf: (t) => t.title, what: "任务", hint: `用 ${VIEW_BOARD_TOOL} 查看板，写任务编号` });
  /** 定时、事件触发的任务的触发登记；不是的抛 RequestRejected */
  const jobOf = (task: Task) => {
    const job = deps.scheduledJobs().ofTask(task.id);
    if (!job) throw new RequestRejected("not_allowed", `${taskName(task)}不是定时或事件触发的任务（或者还没登记好），没有“立即运行一次”`);
    return job;
  };
  return [
    defineQuickAction({
      type: TASK_RUN_ACTION.runNow,
      title: "立即运行一次",
      usage: "用户要某个定时或事件触发的任务现在临时多跑一次（不改时间表，暂停着的跑一次照旧暂停；上一次还在跑的会被拒）",
      params: RunNowParams,
      watch: { categories: [] },
      confirm: "ask_when_inferred",
      normalize({ task: ref }): NormalizedQuickAction {
        const task = findTask(ref);
        // 提出时就看能不能跑：上一次还在跑、取消了……直接拒，原因交回秘书（不出卡）
        deps.scheduledJobs().checkRunNow(jobOf(task).id);
        return { params: { taskId: task.id }, title: `立即运行一次${taskName(task)}`, target: taskName(task) };
      },
      explicit(action, turn) {
        const task = tasks.get(taskIdOf(action.params));
        return task ? explicitSaying(task, turn, saysRunNow, othersThan(tasks, task)) : undefined;
      },
      execute(params, context) {
        const task = tasks.get(taskIdOf(params));
        if (!task) throw new RequestRejected("not_found", `没有任务 ${taskIdOf(params)}`);
        const prepared = deps.scheduledJobs().prepareRunNow(jobOf(task).id, `run-now:${context.actionId}`, "user");
        return { events: prepared.events, summary: `${taskName(task)}开始立即运行一次（运行 ${prepared.runId}）：不改时间表，跑完照常有任务做完的通知`, afterCommit: prepared.afterCommit };
      },
    }),
    defineQuickAction({
      type: TASK_RUN_ACTION.announce,
      title: "跑完自动播报",
      usage: "用户要某个任务以后做完（定时、事件触发的是每次运行完）直接把要点念给他听（on: true），或者不要再直接念、照旧先问（on: false）",
      params: AnnounceParams,
      watch: { categories: [] },
      confirm: "ask_when_inferred",
      normalize({ task: ref, on }): NormalizedQuickAction {
        const task = findTask(ref);
        // 不能开关的（项目内部的、不会再做完的）直接拒
        tasks.buildVoiceAnnounce(task.id, on, "user");
        return { params: { taskId: task.id, on }, title: `${on ? "打开" : "关掉"}${taskName(task)}的跑完自动播报`, target: taskName(task), content: on ? "开" : "关" };
      },
      explicit(action, turn) {
        const { on } = action.params as { on: boolean };
        const task = tasks.get(taskIdOf(action.params));
        return task ? explicitSaying(task, turn, on ? saysAnnounceOn : saysAnnounceOff, othersThan(tasks, task)) : undefined;
      },
      execute(params, context) {
        const { taskId, on } = params as { taskId: string; on: boolean };
        const built = tasks.buildVoiceAnnounce(taskId, on, "user", `voice-announce:${context.actionId}`);
        return { events: built.events, summary: `${taskName(built.task)}跑完自动播报：${on ? "开" : "关"}${built.events.length === 0 ? "（本来就是这样）" : ""}` };
      },
    }),
  ];
}

/** 三个任务控制快速动作（execution 现取：执行控制器在快速动作登记之后才建） */
export function taskControlActions(deps: { tasks: TaskService; execution: () => TaskExecution }): QuickActionExecutor[] {
  const { tasks } = deps;
  return CONTROLS.map((control) =>
    defineQuickAction({
      type: control.type,
      title: control.title,
      usage: control.usage,
      params: Params,
      // 任务控制不落入任何内置类别（用户的自定义类别照样能匹配它）；推断出来的一律先问
      watch: { categories: [] },
      confirm: "ask_when_inferred",
      normalize({ task: ref }): NormalizedQuickAction {
        // 项目内部任务不在全局看板上，秘书控制不了它们（64 号票：要在项目页、任务详情里控制）
        const task = findByIdOrName(tasks.list().filter((t) => !isProjectInternal(t)), ref, { nameOf: (t) => t.title, what: "任务", hint: `用 ${VIEW_BOARD_TOOL} 查看板，写任务编号` });
        assertUserCan(task, control.action, `${taskName(task)}：`);
        return { params: { taskId: task.id }, title: `${control.verb}${taskName(task)}`, target: taskName(task) };
      },
      explicit(action, turn) {
        const task = tasks.get(taskIdOf(action.params));
        return task ? explicitControl(task, control.triggers, turn, othersThan(tasks, task)) : undefined;
      },
      execute(params, context) {
        const taskId = taskIdOf(params);
        const prepared = deps.execution().prepareAct({ taskId, action: control.action }, `task-control:${context.actionId}`);
        return { events: prepared.events, summary: resultText(tasks.get(taskId)!, prepared.result.state), afterCommit: prepared.afterCommit };
      },
    }),
  );
}
