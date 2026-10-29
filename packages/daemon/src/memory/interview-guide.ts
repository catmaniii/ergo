// @i18n-ignore-file model：整份是交给记忆管理员（模型）看的话——访谈开场的系统消息、每个主题从哪问起、收尾时工具交回的提示（174 号票：给模型看的照旧中文）。
//
// 了解你访谈（284 号票）的问法。总的规矩（一次一个问题、往深一次一层、带选项不连追"为什么"、十来个来回、"这个别记"、收尾）写在
// 管理员的系统提示里（prompts/memory-curator.md 的"了解你访谈"一节，用户在设置 · 系统提示里能改）；这里是每一次访谈里交给它的：
// - 开场的系统消息（interviewOpening）：只有一行"【了解你访谈】这次聊：<主题>"——它在会话里用户看得到，不写内部的东西
//   （从哪开的、访谈编号），也不写长篇的问法；
// - 跟在输入后面的上下文（不显示在会话里，照秘书的看板变化那一套；interview-tools.ts 的 interviewInputContext 挑哪一段）：开场那一轮
//   带从哪开的、访谈编号、这次的主题从哪几方面问起和问法要点（interviewOpeningContext），之后用户的每一次回答带一句"进行中、第几个来回"
//   和要点提醒（interviewTurnContext，十来个来回就收尾）——用户改过提示词、删了那一节时照样把要点带到。
// 档案信息（用户 2026-10-25 定）：聊的时候听到了就用 propose_personal_file 记下（不出卡、不打断），收尾 finish_interview 时这次记下的
// 合成一张核对卡逐条确认——不一项一张，283 号票的"每天一张"也不并进来（访谈刚聊完时核对最顺）。
// 依据：Park 等人的 1000 人访谈研究（一次认真的访谈抵得上几个月的零碎聊天）；05 号调研的提醒：大模型做阶梯访谈时容易把动机往高处拔，
// 所以只往深问一层、给选项让用户挑，不替他总结成价值观。
import { INTERVIEW_TOPIC_LABEL, type InterviewStarter, type InterviewTopic, forModel } from "@ergo/protocol";

/** 访谈开场那条系统消息的开头（会话里那一行的开头；管理员认它） */
export const INTERVIEW_TAG = "【了解你访谈】";

/** 每个主题从哪几方面问起（不用全问到，挑用户愿意聊的往下走） */
const TOPIC_GUIDE: Readonly<Record<InterviewTopic, readonly string[]>> = {
  family: [
    "家里现在都有谁、住在一起的是谁、各自在做什么（上学、工作、退休）；",
    "平时谁照顾谁、谁接送孩子、多久回一次父母家；",
    "顺手听到的固定信息（家人的生日、电话、单位或学校、过敏用药）听到了就用 propose_personal_file 记下（不出卡、不用跟用户说），收尾时合成一张核对卡——聊的时候别一项项追问号码。",
  ],
  work_day: ["做什么工作、在什么样的地方做、做了多久；", "工作日一天大概怎么过（几点起、几点到、几点回、晚上做什么）；周末怎么过；", "一周里什么时候最忙、最累，什么时候最松。"],
  choices: [
    "请用户挑一两次自己觉得重要的选择（换工作、搬家、选专业、结婚生子……），一次只聊一次选择；",
    "每次选择只往深问一层：「当时主要图什么」，给两三个可能的选项让他挑（也可以都不是），不连着追问「为什么」；",
    "别替他把选择总结成人生道理或价值观，他怎么说就怎么记。",
  ],
  cares: ["最近最在意的一两件事、最烦的一两件事；", "多用「我注意到……是不是……」带两三个选项问；", "健康、钱、感情这类用户不想细说就跳过，不追。"],
  help: ["希望二狗多做什么、少做什么；", "什么时候别打扰、什么事要先问再做；", "喜欢什么样的说话方式（简短还是详细、直接还是委婉）。"],
  changes: ["上次聊过以后有什么变化：家里、工作、身体、住处、打算；", "有变化的往下问一层（「主要是因为什么」，给选项）；", "没什么变化也没关系，聊几句就收尾。"],
};

/** 访谈是从哪开的（给管理员的一句，跟在开场那一轮的输入后面；用户看不到） */
const STARTER_TEXT: Readonly<Record<InterviewStarter, string>> = {
  card: "用户在待办里的约访卡上点了「开始」",
  page: "用户在和你的对话里点了「开始访谈」",
  secretary: "用户在主对话里说想做个访谈，转到你这里来了",
  curator: "用户在你这里说想做个访谈",
};

/** 访谈的要点（开场的系统消息、begin_interview 交回的都带上） */
function guideLines(topic: InterviewTopic): string[] {
  const label = forModel(() => INTERVIEW_TOPIC_LABEL[topic]);
  return [
    `这次的主题：${label}。可以从这些方面问起（不用全问到，挑用户愿意聊的往下走）：`,
    ...TOPIC_GUIDE[topic].map((line) => `- ${line}`),
    "照提示词里「了解你访谈」那一节的问法：先用一两句开场（这次聊什么、大概十来分钟、随时能跳过或停下、说「这个别记」就不记），然后只问第一个问题。" +
      "一次只问一个；往深只问一层；用「我注意到……是不是……」带两三个选项，不连着追问「为什么」；回话要短，像打电话。",
    "用户说「这个别记」：调 forget_interview_answers（count 写要忘掉的用户的话有几条，连说「别记」的这一句算上），说一句「好，这段不记」接着聊。",
    "听到档案信息（生日、电话、住址、单位或学校、过敏用药……）就调 propose_personal_file 记下：现在不出卡，收尾时这次记下的合成一张核对卡让用户逐条确认；" +
      "值照抄原话，用户改口了就再记一次（同一个人的同一项以后记的为准）。",
    "聊到十来个来回、或者用户要停：先说「今天我记下了这些」（三五条要点，说明是你的理解），问对不对、要改哪里；用户答了以后调 finish_interview 结束" +
      "（这个主题聊透了 covered 写 true，中途停的写 false），这次记下的档案信息会合成一张核对卡放进会话和待办。",
    "你的总结只是复述给用户听，不会写成结论；不要用 review_memory_claim 把访谈里的理解写进记忆。用户的原话已经作为素材记下，夜里整理。",
  ];
}

/** 开场的系统消息（会话里用户看得到）：一行，这次聊什么。从哪开的、访谈编号、问法跟在输入后面另给（interviewOpeningContext） */
export function interviewOpening(topic: InterviewTopic): string {
  return `${INTERVIEW_TAG}这次聊：${forModel(() => INTERVIEW_TOPIC_LABEL[topic])}`;
}

/** 开场那一轮跟在输入后面的：从哪开的、访谈编号、这次的主题从哪几方面问起、问法要点 */
export function interviewOpeningContext(interviewId: string, topic: InterviewTopic, by: InterviewStarter, box: readonly InterviewBoxQuestion[] = []): string {
  return [
    `${INTERVIEW_TAG}访谈开始了（${STARTER_TEXT[by]}，访谈编号 ${interviewId}）。从这一句起用户说的话会标上「来自访谈」记进素材。`,
    ...guideLines(topic),
    ...interviewBoxLines(box),
    "现在就开场、问第一个问题。",
  ].join("\n");
}

/** 330 号票（R15）：问题箱里攒着的一个"了解你问题"（编号、问法） */
export interface InterviewBoxQuestion {
  id: string;
  text: string;
}

/** 访谈里一次最多带几个问题箱里的问题 */
export const INTERVIEW_BOX_MAX = 3;

/**
 * 330 号票（R15）：平时聊天一次对话最多顺口问一个；访谈是用户同意开的，问题箱里攒着的可以一并问几个（还是一次一个、聊到相关的地方再问）。
 * 没有就不写
 */
export function interviewBoxLines(box: readonly InterviewBoxQuestion[]): string[] {
  const shown = box.slice(0, INTERVIEW_BOX_MAX);
  if (shown.length === 0) return [];
  return [
    `问题箱里攒着几个想弄清的（访谈是用户同意开的，这次可以一并问几个：还是一次一个，聊到相关的地方用你自己的话自然地问，不合适就不问，不说是从问题箱来的）：${shown.map((q) => `${q.id}「${q.text}」`).join("；")}`,
  ];
}

/** 访谈里用户每回答一次跟在输入后面的：进行中、第几个来回、要点提醒（十来个来回就收尾） */
export function interviewTurnContext(topic: InterviewTopic, round: number): string {
  const label = forModel(() => INTERVIEW_TOPIC_LABEL[topic]);
  const pace = round >= 10 ? "已经十来个来回了：这一轮或下一轮就收尾。" : round >= 8 ? "快到十来个来回了，准备收尾。" : "";
  return [
    `${INTERVIEW_TAG}访谈进行中（主题：${label}），这是用户第 ${round} 次回答。${pace}`,
    "一次只问一个问题；往深只问一层；用「我注意到……是不是……」带两三个选项，不连着追问「为什么」；不把用户的话往高处拔；回话要短。",
    "听到档案信息就 propose_personal_file 记下（不出卡）。用户说「这个别记」：调 forget_interview_answers。要停或者聊够了：先说「今天我记下了这些」、问对不对，用户答了再 finish_interview（记下的档案信息那时合成一张核对卡）。",
  ].join("\n");
}

/** begin_interview（用户在管理员的会话里直接说想做访谈）交回的：同一份要点，接着就开场 */
export function interviewBeginText(interviewId: string, topic: InterviewTopic): string {
  return [`访谈开始了（编号 ${interviewId}）。从这一句起用户说的话会标上「来自访谈」记进素材。`, ...guideLines(topic), "现在就开场、问第一个问题。"].join("\n");
}

/** 已经在聊的时候又要开：交回的提示 */
export function interviewAlreadyText(interviewId: string, topic: InterviewTopic): string {
  return `已经在聊了（编号 ${interviewId}，主题：${forModel(() => INTERVIEW_TOPIC_LABEL[topic])}），接着问下一个问题就行，不用再开场。`;
}

/** finish_interview 交回的：记了几段、档案核对卡上几条、哪几个主题还没聊 */
export function interviewFinishedText(input: { topic: InterviewTopic; covered: boolean; answers: number; files: number; remaining: readonly InterviewTopic[] }): string {
  const label = forModel(() => INTERVIEW_TOPIC_LABEL[input.topic]);
  const left = input.remaining.length === 0 ? "五个主题都聊过了，以后每月约一次「最近有什么变化」。" : `还没聊的：${input.remaining.map((topic) => forModel(() => INTERVIEW_TOPIC_LABEL[topic])).join("、")}。`;
  return [
    `访谈结束了：「${label}」${input.covered ? "记成聊过" : "这次没聊完，下次接着聊"}；用户这次说的 ${input.answers} 段话标着「来自访谈」进了素材，今晚整理时当证据用。${left}`,
    input.files > 0
      ? `这次记下的档案信息合成了一张核对卡（${input.files} 条），已经放进会话和待办，用户逐条确认了才写进档案。请用户看一眼那张卡，再道别；不要再问新问题。`
      : "这次没有记下档案信息，没有核对卡。最后用一两句跟用户道别就行，不要再问新问题。",
  ].join("\n");
}

/** propose_personal_file 在访谈里交回的：记下了哪几条（不出卡），没记下的为什么 */
export function interviewFileCollectedText(titles: readonly string[], problems: readonly string[]): string {
  if (titles.length === 0) return `一条也没记下：${problems.join("；")}。改好参数再记，拿不准的问用户。`;
  const bad = problems.length > 0 ? `没记下的：${problems.join("；")}。` : "";
  return `记下了：${titles.join("、")}。${bad}现在不出卡、不用跟用户说；收尾调 finish_interview 时，这次记下的档案信息合成一张核对卡，用户逐条确认。`;
}
