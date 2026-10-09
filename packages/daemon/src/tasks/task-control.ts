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
//   - 否则算推断（"取消提醒 r-1，t-3 怎么样了"），推断出来的一律先问（confirm: ask_when_inferred），不论关注类别设置如何。
//   不落入任何内置类别（用户的自定义类别照样能按 quick_action:pause_task 匹配它）；
// - 执行走执行控制器的结构化接口 prepareAct：任务控制算用户改的状态（by: user，按"谁能改"表里用户那一行校验），
//   和快速动作卡、操作记录同一事务追加；执行时再查一次能不能做（确认之前任务可能变了），做不了卡片保持待处理。
//   暂停、取消落到维护者身上的效果（中止手头这一轮）、名额满了回到排队中都是控制器和维护者模块的事（13 号票）。
import { isProjectInternal, type Task, type TaskAction, TASK_STATE_LABEL, taskName, Type } from "@ergou/protocol";
import { VIEW_BOARD_TOOL } from "../board/tool-names.ts";
import {
  bareText,
  defineQuickAction,
  type ExplicitFinding,
  NEGATIONS,
  type NormalizedQuickAction,
  normalizeForMatch,
  ownWords,
  type QuickActionExecutor,
  type UserTurn,
} from "../quick-actions/index.ts";
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

/** 一句话（连同它结尾的标点）：句号、叹号、问号、分号、换行 */
const SENTENCES = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
/** 分句：逗号、顿号 */
const CLAUSE = /[，,、]/;
/** 问句的收尾（去掉结尾的标点和空白之后） */
const QUESTION_ENDINGS = ["吗", "么", "呢", "没有", "没", "嘛"];
/** 动作词后面只是指代：任务要在引用的卡片上 */
const DEICTIC = new Set(["", "这个", "这个任务", "那个", "那个任务", "它", "这张卡", "卡上的", "卡片上的", "引用的"]);

function isQuestion(sentence: string): boolean {
  if (/[？?]\s*$/.test(sentence)) return true;
  const body = sentence.replace(/[\s\p{P}\p{S}]+$/u, "");
  return QUESTION_ENDINGS.some((ending) => body.endsWith(ending));
}

/** 任务编号作为一个词出现（"t-1" 不算出现在 "t-10" 里；编号只有字母、数字和连字符） */
function mentionsId(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`, "i").test(text);
}

/** 这段话里原样写着这个任务：编号，或者完整标题（排版上的差别不算） */
function mentions(text: string, task: Task): boolean {
  const plain = normalizeForMatch(text);
  const title = normalizeForMatch(task.title);
  return mentionsId(plain, task.id) || (title.length > 0 && plain.includes(title));
}

/**
 * 用户说的一段话里，这个动作的每个说法（不在问句里、前面没有否定词）指着的那一段：动作词后面到分句结束的那一段，
 * 以及"把 X 暂停"的 X
 */
function controlTargets(text: string, triggers: readonly string[]): string[] {
  const targets: string[] = [];
  for (const sentence of text.match(SENTENCES) ?? []) {
    if (isQuestion(sentence)) continue;
    for (const clause of sentence.split(CLAUSE)) {
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
function explicitControl(task: Task, triggers: readonly string[], turn: UserTurn): ExplicitFinding | undefined {
  let deictic = false;
  for (const { text, source } of ownWords(turn)) {
    const targets = controlTargets(text, triggers);
    if (targets.some((t) => mentions(t, task))) return { source };
    deictic ||= targets.some((t) => DEICTIC.has(bareText(t).replace(/(吧|了|掉|一下)+$/u, "")));
  }
  if (deictic && turn.cards.some((card) => card.some((text) => mentions(text, task)))) return { source: "card" };
  return undefined;
}

/** 规范化后的参数（存进卡片和操作记录、执行时交回）里的任务编号 */
const taskIdOf = (params: unknown): string => (params as { taskId: string }).taskId;

/** 控制之后的说法 */
function resultText(task: Task, state: Task["state"]): string {
  if (state === "queued") return `${taskName(task)}要接着执行，但执行名额满了，回到排队中，名额空出来就接着执行`;
  return `${taskName(task)}现在是${TASK_STATE_LABEL[state]}`;
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
        return task ? explicitControl(task, control.triggers, turn) : undefined;
      },
      execute(params, context) {
        const taskId = taskIdOf(params);
        const prepared = deps.execution().prepareAct({ taskId, action: control.action }, `task-control:${context.actionId}`);
        return { events: prepared.events, summary: resultText(tasks.get(taskId)!, prepared.result.state), afterCommit: prepared.afterCommit };
      },
    }),
  );
}
