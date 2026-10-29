// 了解你访谈（284 号票）的卡片和接口的 schema。主题、频率这些取值表在 memory-interview.ts（不引用 TypeBox）。
// - 约访卡（卡片类型 interview）：记忆管理员每周在待办里放一张不卡事的卡，"开始""下次再说""不想做了"；
// - GET /api/memory/interview：现在有没有开着的访谈、哪几个主题聊过、下次聊什么、约访开没开（记忆页、设置用）；
// - POST /api/memory/interview：记忆页的"找管理员聊聊"开一次访谈（已经开着就是那一次）；
// - 访谈的档案核对卡（卡片类型 interview_files）：一次访谈收尾时，这次听到的档案信息合成一张，逐条确认（写进 281 号票的个人档案）。
import { type Static, Type } from "typebox";
import { INTERVIEW_ALL_TOPICS, INTERVIEW_CADENCES, INTERVIEW_FILE_STATES, INTERVIEW_INVITE_RESULTS, INTERVIEW_STARTERS, INTERVIEW_TOPICS } from "./memory-interview.ts";
import { PersonalFileCardField, PersonalFileCardRemind, PersonalFileExecuteInput } from "./personal-files-schema.ts";

const Topic = Type.Enum(INTERVIEW_ALL_TOPICS);

/**
 * 约访卡的负载：每周的（五个主题没聊完）还是每月的（"最近有什么变化"）、这次聊哪个主题；点过以后记着结局，
 * 开始了的记着是哪一次访谈（网页据此给"去和管理员聊"的入口）
 */
export const InterviewCardPayload = Type.Object({
  kind: Type.Enum(INTERVIEW_CADENCES),
  topic: Topic,
  result: Type.Optional(Type.Enum(INTERVIEW_INVITE_RESULTS)),
  interviewId: Type.Optional(Type.String()),
});
export type InterviewCardPayload = Static<typeof InterviewCardPayload>;

/** 开着的那次访谈 */
export const ActiveInterviewView = Type.Object({
  id: Type.String(),
  topic: Topic,
  startedAt: Type.String(),
  by: Type.Enum(INTERVIEW_STARTERS),
});
export type ActiveInterviewView = Static<typeof ActiveInterviewView>;

/** GET /api/memory/interview：访谈现在的样子 */
export const InterviewStatusView = Type.Object({
  /** 开着的那次（没有就是没在聊） */
  active: Type.Optional(ActiveInterviewView),
  /** 五个主题里聊过的（按先后） */
  covered: Type.Array(Type.Enum(INTERVIEW_TOPICS)),
  /** 下次聊哪个（五个都聊过了是"最近有什么变化"） */
  next: Topic,
  /** 约访的频率：五个主题没聊完每周一次，都聊过以后每月一次 */
  cadence: Type.Enum(INTERVIEW_CADENCES),
  /** 约访开没开（设置 · 记忆；约访卡上点了"不想做了"会关掉） */
  invites: Type.Boolean(),
});
export type InterviewStatusView = Static<typeof InterviewStatusView>;

/** POST /api/memory/interview 的请求体：想聊哪个主题（不给是下一个没聊过的） */
export const InterviewStartBody = Type.Object({ topic: Type.Optional(Topic) }, { additionalProperties: false });
export type InterviewStartBody = Static<typeof InterviewStartBody>;

/** POST /api/memory/interview 的结果：开的是哪一次、聊哪个主题；already 是"已经开着，进的是同一次" */
export const InterviewStartResult = Type.Object({ interviewId: Type.String(), topic: Topic, already: Type.Boolean() });
export type InterviewStartResult = Static<typeof InterviewStartResult>;

/** 一张档案核对卡上最多几条（一次访谈听到的） */
export const INTERVIEW_FILES_MAX = 40;

/**
 * 访谈的档案核对卡上的一条：一个人的一个字段（或者记下的一件事）。确认时运行时按 raw 再规范化一遍、经快速动作 personal_file 的执行器写进档案
 * （和秘书提议、用户在 281 号票的核对卡上确认的同一个写入口；前面一条刚新建的人，后面的就写进他那份），留痕写"记忆管理员提议、用户确认的"
 */
export const InterviewFileItem = Type.Object({
  /** 这一条的动作编号（qa-…）：确认时的操作记录、档案的留痕按它；也是卡片动作的输入 */
  id: Type.String({ maxLength: 64 }),
  /** 谁：本人写"我"，别人写称呼；新建的写明（关系） */
  person: Type.Object({ name: Type.String(), isNew: Type.Boolean(), relation: Type.Optional(Type.String()) }),
  /** 一个字段（号码类 number，网页一位一位列出；原来有值的写着 previous） */
  field: Type.Optional(PersonalFileCardField),
  /** 记下的一件事 */
  note: Type.Optional(Type.Object({ text: Type.String(), date: Type.String() })),
  /** 生日、纪念日：每年提前几天提醒（283 号票，和个人档案的核对卡一样默认勾着、提前 3 天；确认时一起建） */
  remind: Type.Optional(PersonalFileCardRemind),
  /** 管理员提它时在处理的那条用户消息（档案上的"根据哪句话"） */
  inputMessageId: Type.Optional(Type.String()),
  /** 提它的那次工具调用（守护进程用：彻底删除档案里的值时连同这次调用的记录一起改写） */
  toolCallId: Type.Optional(Type.String()),
  /** 待确认 / 写进去了 / 不记 / 档案里已经是这个值（没再写） */
  state: Type.Enum(INTERVIEW_FILE_STATES),
  /** 确认之后的结果（"已写进妈妈的档案：生日"） */
  result: Type.Optional(Type.String()),
  /** 确认时交给 personal_file 的参数（管理员给的原样，校验过） */
  raw: Type.Object({
    person: Type.String(),
    relation: Type.Optional(Type.String()),
    fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), value: Type.String() }))),
    note: Type.Optional(Type.String()),
    noteDate: Type.Optional(Type.String()),
  }),
});
export type InterviewFileItem = Static<typeof InterviewFileItem>;

/** 访谈的档案核对卡的负载：哪一次访谈、聊的什么主题、在哪个会话里（管理员的），这次听到的每一条 */
export const InterviewFilesCardPayload = Type.Object({
  interviewId: Type.String(),
  topic: Topic,
  conversation: Type.String(),
  items: Type.Array(InterviewFileItem, { minItems: 1, maxItems: INTERVIEW_FILES_MAX }),
});
export type InterviewFilesCardPayload = Static<typeof InterviewFilesCardPayload>;

/** 档案核对卡上"确认""不记"的输入：哪一条；"确认"可以带每年提醒勾了哪几个、提前几天（不带照卡上默认的建；空的是不建） */
export const InterviewFileItemInput = Type.Object(
  { item: Type.String({ minLength: 1, maxLength: 64 }), remind: Type.Optional(PersonalFileExecuteInput.properties.remind) },
  { additionalProperties: false },
);
export type InterviewFileItemInput = Static<typeof InterviewFileItemInput>;
