// 秘书在任务发起上的四个工具（守护进程代为执行，规格第 7 节）：
// - create_task：用户在消息里要秘书去做某件需要任务的事——这个要求就是授权，秘书直接建任务卡（规划中），不出建议卡；
// - suggest_task：秘书自己发现、用户没要求的事，只给一张"建议发起任务"卡，不建任务（用户点卡上的"发起任务"才建）；
// - ask_questions：意图澄清，提问卡成批提问，每题带推荐答案（用户的回答作为一条通知交回秘书）；
// - write_task_brief：澄清完写任务书，运行时交给执行的维护者起草计划。
// 秘书没有建定时作业的工具：定时作业只通过任务的计划建（19 号票登记）。四个工具都只产生卡片或改任务看板，
// 不落入任何关注类别。秘书答应的事当场建（承诺即任务）的提示词和"查看板"工具在 22 号票。
import { QuestionDraft, TaskBrief, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import type { TaskService } from "./tasks.ts";

/** 工具名（秘书的系统提示、测试里引用） */
export const TASK_TOOL = { createTask: "create_task", suggestTask: "suggest_task", askQuestions: "ask_questions", writeTaskBrief: "write_task_brief" } as const;

const CreateTaskParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80, description: "任务的标题（短）" }),
    summary: Type.String({ minLength: 1, maxLength: 2000, description: "用户要做的事，照用户的话概括" }),
    projects: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
        maxItems: 10,
        description: "涉及的项目（项目列表里的名字）：只涉及一个项目时写上它，任务由这个项目的维护者起草计划并执行；涉及多个或不涉及项目的不写",
      }),
    ),
  },
  { additionalProperties: false },
);

const SuggestTaskParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80, description: "建议发起的任务的标题" }),
    why: Type.String({ minLength: 1, maxLength: 1000, description: "为什么建议：你注意到了什么" }),
    projects: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
        maxItems: 10,
        description: "涉及的项目（项目列表里的名字）：只涉及一个项目时写上它，任务由这个项目的维护者起草计划并执行；涉及多个或不涉及项目的不写",
      }),
    ),
  },
  { additionalProperties: false },
);

// 题目和任务书的 schema 在共享协议包（提问卡的负载、任务书事件也用它们），这里只加上任务编号这些
const AskQuestionsParams = Type.Object(
  {
    taskId: Type.Optional(Type.String({ description: "澄清的是哪个任务（比如 t-3）" })),
    intro: Type.Optional(Type.String({ maxLength: 500, description: "卡片开头的一句话" })),
    questions: Type.Array(QuestionDraft, { minItems: 1, description: "这一批问题（已经确认过的不要再问）" }),
  },
  { additionalProperties: false },
);

const WriteTaskBriefParams = Type.Object({ taskId: Type.String({ description: "任务编号，比如 t-3" }), ...TaskBrief.properties }, { additionalProperties: false });

/** 任务号不对、状态不对之类：把原因交回秘书，让它改了再试 */
function guarded(f: () => HostToolOutput): HostToolOutput {
  try {
    return f();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

export function taskTools(tasks: TaskService, cards: CardService): HostTool[] {
  return [
    defineHostTool({
      name: TASK_TOOL.createTask,
      title: "建任务卡",
      description:
        "用户在消息里要你去做某件需要任务的事（要联网、要分阶段干活、要花时间去做的），直接建任务卡：任务以“规划中”出现在任务看板上。用户的要求本身就是授权，不要再出建议卡。建好后先说出你的理解，再澄清、写任务书。",
      parameters: CreateTaskParams,
      // 每调用一次多一个任务
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const task = tasks.createByRequest({ title: args.title, summary: args.summary, ...(args.projects ? { projects: args.projects } : {}) });
          return {
            text: `已建好任务 ${task.id}「${task.title}」（规划中），用户在任务看板上能看到。先说出你的理解（“我理解你要的是……，对吗？”），需要时用 ${TASK_TOOL.askQuestions} 成批提问，对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书。`,
          };
        }),
    }),
    defineHostTool({
      name: TASK_TOOL.suggestTask,
      title: "建议发起任务",
      description: `你自己发现、用户没要求的事，觉得值得发起一个任务时，给用户一张“建议发起任务”卡。它不建任务：用户点卡上的“发起任务”才建出，到时你会收到通知。用户要你做的事不要用它，直接用 ${TASK_TOOL.createTask}。`,
      parameters: SuggestTaskParams,
      readOnlyOrIdempotent: false,
      run: (args) => {
        const card = cards.create({ type: "suggest_task", payload: { title: args.title, why: args.why, ...(args.projects?.length ? { projects: args.projects } : {}) } });
        return { text: "已在聊天里放了一张“建议发起任务”卡（任务还没建）。用户点“发起任务”才会建出，到时你会收到通知；不要口头答应去做。", cardIds: [card.id] };
      },
    }),
    defineHostTool({
      name: TASK_TOOL.askQuestions,
      title: "提问卡",
      description: "意图澄清：把要问的问题成批放进一张提问卡，每题带推荐答案（用户可以一键“全按推荐”）。不限轮数和题数，但已经确认过的不要再问。用户回答后你会收到一条通知，里面是答案。",
      parameters: AskQuestionsParams,
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          if (args.taskId !== undefined && !tasks.get(args.taskId)) throw new RequestRejected("not_found", `没有编号为 ${args.taskId} 的任务`);
          const questions = args.questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
          const card = cards.create({
            type: "questions",
            payload: { ...(args.taskId === undefined ? {} : { taskId: args.taskId }), ...(args.intro === undefined ? {} : { intro: args.intro }), questions },
          });
          return { text: `已在聊天里放了提问卡（${questions.length} 个问题）。用户回答后你会收到一条通知，里面是答案。`, cardIds: [card.id] };
        }),
    }),
    defineHostTool({
      name: TASK_TOOL.writeTaskBrief,
      title: "写任务书",
      description: "和用户对齐意图之后，写出任务书（目标、验收标准、约束、涉及的项目、记忆范围提议）。运行时把它交给执行的维护者起草计划；计划卡会放进用户的待我处理，用户确认之前维护者不会动手。",
      parameters: WriteTaskBriefParams,
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { taskId, ...brief } = args;
          const { task, revision } = tasks.writeBrief(taskId, brief);
          return {
            text: `${revision > 1 ? `任务书已改（第 ${revision} 版）` : "任务书已写好"}，交给了任务 ${task.id}「${task.title}」的维护者。它会起草计划，计划卡放进用户的待我处理；进了待我处理的事你不用转述。`,
          };
        }),
    }),
  ];
}
