// @i18n-ignore-file model：工具的说明、参数说明和交回的文字都是给记忆管理员（模型）看的；工具的名字走 t()。
//
// 记忆管理员做了解你访谈用的四个工具（284 号票；问法写在它的系统提示和开场的系统消息里，见 interview-guide.ts）：
// - begin_interview：用户在管理员的会话里直接说想做访谈时开一次（从约访卡、记忆页、秘书那里开的不用它：那几处已经开好、放了开场的系统消息）；
// - finish_interview：收尾——记下这个主题聊透了没有（聊透了下次换下一个），会话里放一句给用户看的说明；
// - forget_interview_answers：用户说"这个别记"：把这次访谈里用户最近说的几句忘掉（走现有的忘掉：追加一条记忆命令，素材库删掉、
//   推理库里照老规矩处理），不留在素材里；
// - propose_personal_file：访谈里听到的档案信息（生日、电话、单位……）记下（用户 2026-10-25 定）：访谈开着时按 281 号票的快速动作
//   personal_file 的执行器校验、只记在访谈的服务里，不出卡；收尾 finish_interview 时这次记下的合成一张档案核对卡（interview_files），
//   逐条确认，确认的经 personal_file 的执行器写进档案（同一个写入口），留痕写"记忆管理员提议、用户确认的"。不一项一张，
//   283 号票的"每天一张"也不并进来（访谈刚聊完时核对最顺）。没在访谈里时照 281 号票出一人一张的核对卡（总是出卡）。
// 管理员自己的总结只是它的回复：没有把总结写成结论的工具（review_memory_claim 只记用户对已有结论的表态）。
// 另外 interviewInputContext：访谈开着时跟在它每一轮输入后面的问法要点、第几个来回（curator.ts 交给会话的 inputContext）。
import { randomUUID } from "node:crypto";
import { type ConversationId, type DeleteCommandPayload, EVENT_TYPES, INTERVIEW_TOPICS, type InterviewMainTopic, type MessageEnvelope, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { MATERIALS_CHANNEL } from "../materials/commands.ts";
import type { Materials } from "../materials/index.ts";
import type { MemoryInterviews } from "./interview.ts";
import { INTERVIEW_BOX_MAX, type InterviewBoxQuestion, interviewAlreadyText, interviewBeginText, interviewFinishedText, interviewOpeningContext, interviewTurnContext } from "./interview-guide.ts";
import { commandText, CURATOR_COMMAND_ALIASES, CURATOR_COMMANDS } from "../slash-commands/commands.ts";

/** 一次最多忘掉几句 */
const FORGET_MAX = 10;

export interface InterviewToolDeps {
  /** 访谈的服务（记忆插件提供；管理员只在插件运行时才有） */
  interviews: MemoryInterviews;
  /** 事件日志：忘掉的那条记忆命令追加到这里 */
  store: Pick<EventStore, "append">;
  /** 记忆管理员的会话 */
  conversation: ConversationId;
  /** 素材库：认出这几句话的素材 */
  materials: Pick<Materials, "list">;
  /**
   * 没在访谈里时提议写个人档案（281 号票的快速动作 personal_file，总是出核对卡）；组合根给。访谈里的由访谈的服务记下、收尾时合成一张卡
   */
  proposePersonalFile?: (params: unknown, call: HostToolCall) => HostToolOutput | Promise<HostToolOutput>;
  log?: (line: string) => void;
}

const TopicParam = Type.Optional(
  Type.Enum(INTERVIEW_TOPICS, { description: "想聊哪个主题（用户点了名才写）：family 家里的人、work_day 工作和一天、choices 几次重要的选择、cares 在意和烦恼、help 想让二狗怎么帮；不写是下一个没聊过的" }),
);

/** propose_personal_file 的参数：和秘书的 personal_file 快速动作同一份（照抄用户原话里的值） */
const PersonalFileParams = Type.Object(
  {
    person: Type.String({ minLength: 1, description: "谁的档案：用户本人写\"我\"；别人写用户对他的称呼（\"妈妈\"\"小张\"），档案里已有的按称呼或别名找，没有的确认后新建一份" }),
    relation: Type.Optional(Type.String({ description: "新建别人的档案时：和用户的关系（\"母亲\"\"表弟\"\"同事\"）" })),
    fields: Type.Optional(
      Type.Array(Type.Object({ field: Type.String({ minLength: 1 }), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), {
        maxItems: 20,
        description:
          "要写的固定信息，每项 {field, value}。field 写字段名——本人：姓名、身份证号、护照号、驾照号、生日、纪念日、手机、邮箱、住址、单位和职位、过敏和用药；" +
          "别人：别名、和我的关系、生日、纪念日、电话、住址、单位或学校、过敏和用药；纪念日可以有几个，写带名字的（\"结婚纪念日\"）；别的写一个自定义的名字。value 照抄用户原话里的值，号码一位都不能改",
      }),
    ),
    note: Type.Optional(Type.String({ description: "用户特意说要记下的一件事，尽量照抄原话" })),
    noteDate: Type.Optional(Type.String({ description: "那件事的日期 YYYY-MM-DD；不给是今天" })),
  },
  { additionalProperties: false },
);

/**
 * 跟在管理员这一轮输入后面的访谈上下文（不显示在会话里；AgentSession 的 inputContext）：访谈开着时，开场的系统消息那一轮带这次的主题
 * 从哪几方面问起和问法要点，用户的每一次回答带一句"进行中、第几个来回"和要点提醒；别的输入（03:00 的整理、秘书转达、访谈以外的话）没有
 */
export function interviewInputContext(
  interviews: Pick<MemoryInterviews, "active" | "answersOf">,
  message: MessageEnvelope,
  box: () => readonly InterviewBoxQuestion[] = () => [],
): string | undefined {
  const session = interviews.active();
  if (!session) return undefined;
  // 开场的系统消息那一轮（按开始时记下的消息编号认）：从哪开的、访谈编号、问法——这些不写在用户看得到的那一行里；
  // 330 号票（R15）：问题箱里还开着的几个一并交给它（访谈里可以连问几个）
  if (message.speaker === "system") return message.id === session.openingMessageId ? interviewOpeningContext(session.id, session.topic, session.by, box()) : undefined;
  const round = interviews.answersOf(session.id).indexOf(message.id) + 1;
  return round > 0 ? interviewTurnContext(session.topic, round) : undefined;
}

/** 记忆管理员的访谈工具 */
export function interviewTools(deps: InterviewToolDeps): HostTool[] {
  const log = deps.log ?? (() => {});
  return [
    defineHostTool({
      name: "begin_interview",
      title: t("memory.interview.tool.begin"),
      description:
        "开一次了解你访谈：用户在这里直接说想做访谈（「我们来聊聊吧」「做个访谈」）时用；用户打 " +
        commandText(CURATOR_COMMANDS.interview, CURATOR_COMMAND_ALIASES.interview) +
        " 也是要开（后面跟着的字是想聊的主题）。开了以后用户说的话标上「来自访谈」记进素材，交回这次的主题和问法，接着就开场。" +
        "会话里已经有一条「【了解你访谈】」开场的系统消息（用户从约访卡、记忆页或者主对话里开的）时不用再调；已经在聊也不用。",
      parameters: Type.Object({ topic: TopicParam }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      nature: "modify",
      run(args) {
        const started = deps.interviews.start({ by: "curator", ...(args.topic === undefined ? {} : { topic: args.topic as InterviewMainTopic }) });
        return { text: started.already ? interviewAlreadyText(started.interviewId, started.topic) : interviewBeginText(started.interviewId, started.topic) };
      },
    }),
    defineHostTool({
      name: "finish_interview",
      title: t("memory.interview.tool.finish"),
      description:
        "结束这次了解你访谈：先说过「今天我记下了这些」、用户答了对不对以后调；用户中途要停也调。" +
        "covered：这个主题聊透了写 true（下次换下一个主题），中途停的写 false（下次接着聊这个）。这次用 propose_personal_file 记下的档案信息这时合成一张核对卡放进会话和待办。" +
        "结束以后用户再说的话不算访谈。",
      parameters: Type.Object({ covered: Type.Boolean({ description: "这个主题聊透了没有" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      nature: "modify",
      run(args) {
        const done = deps.interviews.finish(args.covered);
        if (!done) return { text: "现在没有开着的访谈（已经结束了，或者开了太久当放下了），不用再收尾。", isError: true };
        // 档案核对卡跟着这次调用进会话（卡片编号交回，会话放一条带卡片的消息）
        return { text: interviewFinishedText(done), ...(done.filesCardId === undefined ? {} : { cardIds: [done.filesCardId] }) };
      },
    }),
    defineHostTool({
      name: "forget_interview_answers",
      title: t("memory.interview.tool.forget"),
      description:
        "用户在访谈里说「这个别记」「刚才那段别记」时用：把这次访谈里用户最近说的几句忘掉（从素材库删掉，聊天记录里还看得到），不当证据用。" +
        "count 写要忘掉的用户的话有几条，从用户这一句往前数，连说「别记」的这一句算上（「我跟我爸关系一般，这个别记」是 1；先说了一段、下一句才说「这个别记」是 2）。拿不准是哪几句先问。",
      parameters: Type.Object(
        {
          count: Type.Integer({ minimum: 1, maximum: FORGET_MAX, description: "从用户这一句往前数，忘掉几条用户的话（连这一句）" }),
          reason: Type.Optional(Type.String({ maxLength: 200, description: "用户怎么说的（一句话；写进推理库的修订记录）" })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      nature: "modify",
      run(args, call) {
        const session = deps.interviews.active() ?? deps.interviews.latest();
        if (!session) return { text: "还没有做过访谈：没有要忘的访谈里的话。用户要忘掉别的，用 search_materials 找出来再 forget_material。", isError: true };
        const answers = deps.interviews.answersOf(session.id);
        // 从这一轮交给你的那几条（最后一条）往前数；这一轮的输入不在这次访谈里时按最后几条算
        const current = [call.inputMessageId, ...(call.moreInputMessageIds ?? [])].filter((id): id is string => id !== undefined && answers.includes(id));
        const end = current.length > 0 ? answers.indexOf(current.at(-1)!) + 1 : answers.length;
        const picked = answers.slice(Math.max(0, end - args.count), end);
        const materialIds = [...new Set(picked.flatMap((messageId) => deps.materials.list({ messageId }).map((m) => m.id)))];
        if (materialIds.length === 0) return { text: "这几句话没有在素材里（已经忘掉了，或者语音还没识别出来）。照实告诉用户这段不会记。" };
        const payload: DeleteCommandPayload = {
          commandId: `curator-interview-${randomUUID().slice(0, 8)}`,
          command: "forget",
          materialIds,
          from: { kind: "curator", conversation: deps.conversation },
        };
        deps.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
        log(`记忆管理员按用户的话忘掉了访谈 ${session.id} 里的 ${picked.length} 句（${materialIds.join("、")}）：${args.reason ?? "这个别记"}`);
        return { text: `忘掉了用户在访谈里说的 ${picked.length} 句：从素材库删掉，不当证据用（聊天记录里还看得到）。说一句「好，这段不记」接着聊，别复述那段内容。` };
      },
    }),
    defineHostTool({
      name: "propose_personal_file",
      title: t("memory.interview.tool.personalFile"),
      description:
        "把访谈里听到的固定信息（生日、电话、住址、单位或学校、过敏用药……）记下，准备写进个人档案：访谈里调用不出卡、不打断聊天，" +
        "收尾 finish_interview 时这次记下的合成一张核对卡（号码一位一位列出），用户逐条确认了才写。听到了就记，参数照抄用户的原话；" +
        "用户改口了再记一次（同一个人的同一项以后记的为准）；推断出来的不写（用户没说出口的不算）。不在访谈里时调用直接出一人一张的核对卡。",
      parameters: PersonalFileParams,
      readOnlyOrIdempotent: false,
      nature: "modify",
      async run(args, call) {
        // 访谈开着：记下，收尾时合成一张核对卡
        const collected = deps.interviews.collectFile(args, call);
        if (collected !== undefined) return collected;
        if (deps.proposePersonalFile === undefined) return { text: "现在提不了个人档案的核对卡（这一版没接上）。照实告诉用户，请他到个人档案页自己填。", isError: true };
        return deps.proposePersonalFile(args, call);
      },
    }),
  ];
}

/** 330 号票（R15）：问题箱里还开着（没问过）的，按优先级最多 INTERVIEW_BOX_MAX 个；推理库读不到是空的 */
export function openBoxQuestions(graph: { questions(query: { limit?: number }): { ready: boolean; items: readonly { id: string; text: string; status: string }[] } }): InterviewBoxQuestion[] {
  try {
    const view = graph.questions({ limit: 50 });
    if (!view.ready) return [];
    return view.items
      .filter((q) => q.status === "open")
      .slice(0, INTERVIEW_BOX_MAX)
      .map((q) => ({ id: q.id, text: q.text }));
  } catch {
    return [];
  }
}
