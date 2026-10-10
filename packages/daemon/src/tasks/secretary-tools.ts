// 秘书在任务发起上的工具（守护进程代为执行，规格第 7 节）：
// - start_workflow / create_task：用户点明了要发起流程 / 长程任务（58 号票，ADR 0019：只有点明了才发起），直接建任务卡（规划中）。
//   "点明"由运行时判定（launch-intent.ts，和项目的维护者共用 launch-tools.ts）：用户这一轮没点明、或者点明的是另一种的，拒绝并把原因交回秘书；
//   用户点明了要做的是某一个项目的事（projects 只写它，64 号票，2026-10-09 用户定）：替用户建成这个项目的内部任务——由项目的维护者
//   和用户对齐、执行，只在项目里看得到，通知交给维护者；秘书只说"已在项目「X」里建了内部任务"，看不到细节；
// - suggest_task：秘书觉得该发起、但用户没点明的事，只给一张"建议发起任务"卡，不建任务（卡上"作为流程""作为长程任务"由用户点；
//   卡上写了一个项目的点了建成这个项目的内部任务，通知交给项目的维护者，秘书收不到）；
// - ask_questions：意图澄清，提问卡成批提问，每题带推荐答案（用户的回答作为一条通知交回秘书）；
// - write_task_brief：澄清完写任务书，运行时交给执行的维护者起草计划；
// - delegate_task（75 号票，ADR 0025）：用户交代的事要花时间、要跑很多步、要联网下载……秘书自己决定交给后台，建一个普通任务
//   （有任务卡、有自己的 agent，不规划、不授权、不检查；只写了一个项目的建成这个项目的内部任务，由项目的维护者做），不必等用户点明。
//   工具说明写清楚什么时候该交、什么时候在对话里自己做；做完了运行时交给秘书一句结果，它在对话里转告。
// 秘书没有建定时作业的工具：定时作业只通过任务的计划建（19 号票登记）。这些工具都只产生卡片或改任务看板，
// 不落入任何关注类别。秘书答应的事当场建（承诺即任务）的提示词和"查看板"工具在 22 号票。
import { isProjectInternal, nowIso, QuestionDraft, type Task, TaskBrief, type TaskKind, TASK_KIND_LABEL, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import { delegateRefusal, LAUNCH_COMMANDS } from "./launch-intent.ts";
import { guarded, LAUNCH_PARAMS, LAUNCH_TOOLS, launchTool, oncePerTurn, type UserTurnOf } from "./launch-tools.ts";
import { delegatedText } from "./plain.ts";
import { parseLocalDateTime } from "../reminders/schedule.ts";
import type { TaskService } from "./tasks.ts";
import { TASK_TOOL } from "./tool-names.ts";

export { TASK_TOOL } from "./tool-names.ts";

const CreateTaskParams = Type.Object(
  {
    ...LAUNCH_PARAMS,
    projects: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
        maxItems: 10,
        description:
          "涉及的项目（项目列表里的名字）：用户要做的是某一个项目的事时只写它——建成这个项目的内部任务，由项目的维护者和用户对齐、起草、执行，只在项目里看得到；" +
          "说不清是哪个项目时先问用户，不要猜。涉及多个项目的长程任务写上全部（流程只能在一个项目里做）；不涉及项目的不写",
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
        description:
          "涉及的项目（项目列表里的名字）：只涉及一个项目时写上它——用户点了建成这个项目的内部任务，由项目的维护者和用户对齐、起草、执行，只在项目里看得到" +
          "（通知交给维护者，你收不到，也看不到它的细节）；涉及多个或不涉及项目的不写",
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

const DelegateTaskParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80, description: "任务卡上的标题（短，说清是什么事）" }),
    instructions: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "任务书：交给后台 agent 的话（怎么写见工具说明：要做什么、做到什么程度、交付什么，只带完成这件事需要的信息）",
    }),
    projects: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
        maxItems: 10,
        description:
          "涉及的项目（项目列表里的名字）：只涉及某一个项目的事只写它——交给这个项目的维护者在项目里做（项目内部的普通任务，你看不到细节）；不涉及项目的不写；说不清是哪个项目时先问用户，不要猜",
      }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "某个时间再做（比如用户说“明天早上 9 点帮我查一下航班”）：本地日期时间 YYYY-MM-DD HH:mm，要在将来（用户消息前标着当前的本地日期、星期和时间）。不给就是现在做",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * 交给后台（75 号票）的工具说明：什么时候该交、什么时候在对话里自己做、和别的发起工具的界线、任务书怎么写，只写在这里
 * （秘书的系统提示里只说"照这个工具的说明"，交出去之后的工具结果只说怎么告诉用户）
 */
const DELEGATE_DESCRIPTION =
  "把用户交代的一件事交给后台去做：建一个普通任务（有任务卡、有自己的 agent，在后台直接一轮轮做，不规划、不授权、不检查；做完自动算完成，你会收到一条带结果的通知）。不用等用户点明，你自己判断。" +
  "该交出去的：要几分钟以上才做得完的——要下载东西、要批量处理很多文件、要跑很多步、要搜索和读很多网页再整理的（比如“去搜一下这首歌，把音频下下来”“把这十几个网页的内容整理成一张表”“批量处理这个目录里的照片”）；交出去之后用户能接着跟你聊别的。" +
  "在对话里自己做、不要交出去的：几句话就能回答的、查一两次就知道的、在草稿区里一两步能算完的、要和用户来回商量才定得下来的。" +
  `和别的发起工具的界线：用户点明了要发起流程或长程任务（说了“按流程做”“发起任务”“长程任务”之类，或者输入 ${LAUNCH_COMMANDS.workflow}、${LAUNCH_COMMANDS.long_running}）时不能用它，用 ${TASK_TOOL.startWorkflow}、${TASK_TOOL.createTask}（运行时会拒绝）；` +
  `要事先规划、让用户授权、但用户没点明的，用 ${TASK_TOOL.suggestTask} 给建议卡，也不用它。` +
  "instructions 是任务书：写清要做什么、做到什么程度、交付什么（文件放哪、要什么格式），只带完成这件事需要的信息（链接、文件在哪、和这件事有关的要求），不带无关的私人内容——任务书在任务看板、任务详情、工单里都看得到；执行的 agent 看不到你们的对话。" +
  "用户要的是将来某个时间再做的（“明天早上帮我……”“下午三点去查一下……”），给 at：任务建好后等到那个时间才开始，做完一样算完成、通知你；只是到点提醒用户、不用 agent 干活的，用建提醒的工具，不用它。要按时间表反复做的（每天、每周）你建不了，请用户在“发起任务”对话框里选“定时”。";

/** 替用户在项目里建好内部任务之后交回秘书的话：它看不到细节，只告诉用户建在哪儿 */
export const internalLaunchedText = (task: Pick<Task, "internal">) => {
  const name = task.internal?.projectName ?? "";
  return (
    `已在项目「${name}」里建了内部任务：由这个项目的维护者和用户对齐、起草、执行，只在项目里看得到（你看不到它的细节，不用问，也不要写任务书、出提问卡）。` +
    `只告诉用户“已在项目「${name}」里建了内部任务”，接下来在项目页和维护者对齐。`
  );
};

/**
 * 秘书的发起：只写了一个项目的建成这个项目的内部任务（64 号票，用户定：只涉及一个项目的一律是内部任务，由 TaskService 按这一条定），
 * 秘书只知道建在哪个项目里；别的建全局任务（涉及几个项目的流程被拒）
 */
function secretaryLaunch(tasks: TaskService, kind: TaskKind) {
  return (args: { title: string; summary: string; projects?: string[] | undefined }): string => {
    const task = tasks.createByRequest({ title: args.title, summary: args.summary, kind, ...(args.projects ? { projects: args.projects } : {}) });
    if (isProjectInternal(task)) return internalLaunchedText(task);
    return `已建好${TASK_KIND_LABEL[kind]} ${task.id}「${task.title}」（规划中），用户在任务看板上能看到。先说出你的理解（“我理解你要的是……，对吗？”），需要时用 ${TASK_TOOL.askQuestions} 成批提问，对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书。`;
  };
}

/** userTurn：秘书正在处理的那条用户消息里用户说了什么（quick-actions 的 readUserTurn） */
export function taskTools(tasks: TaskService, cards: CardService, userTurn: UserTurnOf): HostTool[] {
  /** 一轮最多一张建议卡 */
  const suggestedThisTurn = oncePerTurn();
  return [
    launchTool(userTurn, "workflow", {
      title: "发起流程",
      description:
        `用户点明了要按流程做（说了“按流程做”“发起一个流程”“作为流程”之类，或者输入 ${LAUNCH_COMMANDS.workflow}）时，建一个流程的任务卡（规划中）。` +
        "流程是：维护者把要做的事事先排成一串步骤（每步一次工具调用，连同它要满足的条件），审查修补后用户一次授权，执行时按步骤做，执行中不能改步骤。" +
        "做的是某一个项目的事时 projects 只写它：建成这个项目的内部任务（由项目的维护者起草、执行）。" +
        `用户没点明的不能用它（运行时会拒绝）。建好后先说出你的理解，再澄清、写任务书（项目内部任务不用）。`,
      parameters: CreateTaskParams,
      create: secretaryLaunch(tasks, "workflow"),
    }),
    launchTool(userTurn, "long_running", {
      title: "发起长程任务",
      description:
        `用户点明了要发起任务（说了“发起任务”“长程任务”“建个任务”之类，或者输入 ${LAUNCH_COMMANDS.long_running}；只说“发起任务”没说种类的就是它）时，建一个长程任务的任务卡（规划中）。` +
        "长程任务是：维护者把工作拆成几个阶段，逐阶段执行和验收，执行中可以提计划变更。" +
        "做的是某一个项目的事时 projects 只写它：建成这个项目的内部任务（由项目的维护者起草、执行）。" +
        `用户没点明的不能用它（运行时会拒绝），也不要出建议卡；点明的是流程时用 ${TASK_TOOL.startWorkflow}。建好后先说出你的理解，再澄清、写任务书（项目内部任务不用）。`,
      parameters: CreateTaskParams,
      create: secretaryLaunch(tasks, "long_running"),
    }),
    defineHostTool({
      name: TASK_TOOL.delegateTask,
      title: "交给后台（普通任务）",
      description: DELEGATE_DESCRIPTION,
      parameters: DelegateTaskParams,
      // 每调用一次多一个任务
      readOnlyOrIdempotent: false,
      run: (args, call) =>
        guarded(() => {
          // 用户这一轮点明了要发起流程或长程任务：那是他要的做法，不能改成交给后台
          const refused = delegateRefusal(userTurn(call.inputMessageId), LAUNCH_TOOLS);
          if (refused) return { text: refused, isError: true };
          const at = args.at === undefined ? undefined : nowIso(parseLocalDateTime(args.at));
          return { text: delegatedText(tasks.delegate({ title: args.title, instructions: args.instructions, ...(args.projects?.length ? { projects: args.projects } : {}), ...(at === undefined ? {} : { at }) })) };
        }),
    }),
    defineHostTool({
      name: TASK_TOOL.suggestTask,
      title: "建议发起任务",
      description:
        "用户没点明要发起任务、你觉得这件事值得发起一个任务时，给用户一张“建议发起任务”卡（一轮最多一张）。它不建任务：卡上有“作为流程”“作为长程任务”两个按钮，用户点了才建出。" +
        "卡上没写项目的，建出后你会收到通知，接着澄清、写任务书；卡上写了一个项目的，建成这个项目的内部任务，通知交给项目的维护者，你收不到。" +
        `用户点明了要发起的不要用它，直接用 ${TASK_TOOL.startWorkflow} 或 ${TASK_TOOL.createTask}。`,
      parameters: SuggestTaskParams,
      readOnlyOrIdempotent: false,
      run: (args, call) => {
        if (suggestedThisTurn(call.inputMessageId)) return { text: "这一轮已经给过一张“建议发起任务”卡了，一轮最多一张。", isError: true };
        const card = cards.create({ type: "suggest_task", payload: { title: args.title, why: args.why, ...(args.projects?.length ? { projects: args.projects } : {}) } });
        const when = args.projects?.length === 1 ? `建成项目「${args.projects[0]}」的内部任务，通知交给它的维护者（你收不到）` : "到时你会收到通知";
        return { text: `已在聊天里放了一张“建议发起任务”卡（任务还没建）。用户点卡上的“作为流程”或“作为长程任务”才会建出，${when}；不要口头答应去做。`, cardIds: [card.id] };
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
          // 项目内部任务对秘书来说没有（64 号票：它的维护者在项目会话里直接问用户）
          const asked = args.taskId === undefined ? undefined : tasks.get(args.taskId);
          if (args.taskId !== undefined && (!asked || isProjectInternal(asked))) throw new RequestRejected("not_found", `没有编号为 ${args.taskId} 的任务`);
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
      description:
        "和用户对齐意图之后，写出任务书（目标、验收标准、约束、涉及的项目、记忆范围提议）。运行时把它交给执行的维护者起草计划；计划卡会放进用户的待我处理，用户确认之前维护者不会动手。" +
        "建卡时没写项目、这一版只涉及一个项目的，任务交给这个项目的维护者，成了它的内部任务（只在项目里看得到，之后你看不到它的细节）。",
      parameters: WriteTaskBriefParams,
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { taskId, ...brief } = args;
          const { task, revision } = tasks.writeBrief(taskId, brief);
          // 第一版任务书只涉及一个项目：成了这个项目的内部任务（64 号票），从此你看不到它的细节
          if (task.internal) {
            return {
              text:
                `任务书写好了：只涉及项目「${task.internal.projectName}」，任务交给了这个项目的维护者，成了它的内部任务（由它起草、执行，只在项目里看得到，你看不到它的细节）。` +
                `告诉用户：已转到项目「${task.internal.projectName}」里做，计划卡会放进待我处理。`,
            };
          }
          return {
            text: `${revision > 1 ? `任务书已改（第 ${revision} 版）` : "任务书已写好"}，交给了任务 ${task.id}「${task.title}」的维护者。它会起草计划，计划卡放进用户的待我处理；进了待我处理的事你不用转述。`,
          };
        }),
    }),
  ];
}
