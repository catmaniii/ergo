// 个人档案（281 号票）的接口和卡片的 schema。字段有哪些、叫什么、哪些算号码、值合不合规在 personal-files.ts（不引用 TypeBox）。
// 档案不走前端频道：档案页打开时经 HTTP 取（GET /api/personal-files、/api/personal-files/<编号>），改完用接口回的那份
// （和"我的名字"一样，别的设备要等它自己再取）。事件在守护进程内部的频道上（personal_files，前端订阅不了）。
// 283 号票加了：生日、纪念日的每年提醒（字段上的 annual、改的请求 set_reminder、核对卡上的勾）；"二狗了解到的"
// （GET /api/personal-files/<编号>/learned，经记忆插件现取）；每晚整理攒的候选合成的核对卡（卡片类型 personal_file_suggest）。
// 285 号票加了分组：列表和一份档案上的 group（没选时按关系猜，groupGuessed）、建人时的 group、改分组的请求 set_group。
import { type Static, Type } from "typebox";
import { QUICK_ACTION_BASES } from "./constants.ts";
import { ANNUAL_REMINDER_MAX_DAYS, PERSON_GROUPS } from "./personal-files.ts";
import { LocalDate } from "./workday-calendar.ts";

/**
 * 档案里的东西是怎么写进来的：用户在档案页里直接改的（改了就算确认）、秘书转达的（用户原话里明说了直接写，或者在核对卡上确认）、
 * 记忆管理员提议的（283 号票：每晚整理攒的候选、284 号票的访谈，用户在候选核对卡上点了才写）
 */
export const PERSONAL_FILE_VIAS = ["page", "secretary", "curator"] as const;
export type PersonalFileVia = (typeof PERSONAL_FILE_VIAS)[number];

/**
 * 候选从哪来：每晚整理（白天听到的）、284 号票的访谈、秘书直接写进档案以后问的一句（要不要每年提醒；302 号票起直接写的按默认直接建、
 * 不再问，留着认以前出的卡）、299 号票用户在手机上的二狗 App 里从通讯录挑的人（contacts：用户自己挑的，不用提到几次就上卡，
 * 电话、住址也收，号码在卡上逐位核对）、301 号票用户放进导入文件夹的通讯录 vCard（vcard：Google 联系人导出的；和 contacts 一样不用
 * 提到几次、电话住址也收，另外收关系、别名、纪念日；拒过的不再提）
 */
export const PERSONAL_SUGGEST_ORIGINS = ["nightly", "interview", "secretary", "contacts", "vcard"] as const;
export type PersonalSuggestOrigin = (typeof PERSONAL_SUGGEST_ORIGINS)[number];

/** 留痕：谁写的、经谁转达、根据哪句话（原话按消息编号现取，消息彻底删了就写"已删除"） */
export const PersonalFileSource = Type.Object({
  via: Type.Enum(PERSONAL_FILE_VIAS),
  /** 经秘书转达的：用户原话里明说了直接写的（explicit）、在核对卡上确认的（confirmed） */
  basis: Type.Optional(Type.Enum(QUICK_ACTION_BASES)),
  /** 什么时候写的 */
  at: Type.String(),
  /** 根据哪句话：用户的那条消息 */
  messageId: Type.Optional(Type.String()),
  /** 那句话的原文（截短的；现取） */
  quote: Type.Optional(Type.String()),
  /** 那句话已经不在了（彻底删除了） */
  messageGone: Type.Optional(Type.Boolean()),
  /** 经候选核对卡写的（via curator）：候选从哪来（299 号票：从手机通讯录挑的写 contacts，档案页据此写"从手机通讯录挑的"；301 号票：导入的通讯录 vCard 写 vcard） */
  origin: Type.Optional(Type.Enum(PERSONAL_SUGGEST_ORIGINS)),
});
export type PersonalFileSource = Static<typeof PersonalFileSource>;

/**
 * 一个字段的一个值：从哪天起、到哪天为止（现在的值没有 until）、怎么写进来的。本人的姓名取自"我的名字"（设置里填的），
 * 那里不记时间、不留痕，所以没有 since、source
 */
export const PersonalFieldValue = Type.Object({
  value: Type.String(),
  since: Type.Optional(Type.String()),
  until: Type.Optional(Type.String()),
  source: Type.Optional(PersonalFileSource),
});
export type PersonalFieldValue = Static<typeof PersonalFieldValue>;

/** 公历的某月某日（档案里的生日、纪念日认出来的；每年提醒按它往前数） */
export const PersonalMonthDay = Type.Object({ month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }) });
export type PersonalMonthDay = Static<typeof PersonalMonthDay>;

/** 每年提醒提前几天（0 是当天） */
const ReminderDays = Type.Integer({ minimum: 0, maximum: ANNUAL_REMINDER_MAX_DAYS });

/** 每年提醒开不了的原因：值不是认得出的公历日子（农历、写法认不出）、提醒插件没启用 */
export const PERSONAL_ANNUAL_BLOCKS = ["not_gregorian", "reminders_off"] as const;

/**
 * 生日、纪念日这类字段上的每年提醒（283 号票）：值里认出的公历日子；开着时提前几天、下一次几点响；开不了的写原因。
 * 字段的值改了提醒跟着改，字段删了提醒跟着删
 */
export const PersonalAnnualView = Type.Object({
  monthDay: Type.Optional(PersonalMonthDay),
  /** 开着：提前几天提醒（0 是当天） */
  daysBefore: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 开着：下一次响的时间（协议时间） */
  nextAt: Type.Optional(Type.String()),
  blocked: Type.Optional(Type.Enum(PERSONAL_ANNUAL_BLOCKS)),
});
export type PersonalAnnualView = Static<typeof PersonalAnnualView>;

/** 一个字段：默认字段没填的也列出来（没有 current）；history 是以前的值，新的在前 */
export const PersonalFieldView = Type.Object({
  field: Type.String(),
  label: Type.String(),
  /** 用户自己加的字段 */
  custom: Type.Boolean(),
  /** 号码类（核对卡上逐位列出） */
  number: Type.Boolean(),
  /** 和别处是同一个来源：本人的姓名就是设置 · 身份里的"我的名字"（改一边另一边跟着变；没有历史） */
  linked: Type.Optional(Type.Literal("user_name")),
  current: Type.Optional(PersonalFieldValue),
  history: Type.Array(PersonalFieldValue),
  /** 生日、纪念日这类字段（283 号票）：每年提醒；别的字段没有 */
  annual: Type.Optional(PersonalAnnualView),
});
export type PersonalFieldView = Static<typeof PersonalFieldView>;

/** 记下的一件事 */
export const PersonalNoteView = Type.Object({
  id: Type.String(),
  text: Type.String(),
  /** 事情的日期（不是记下的时间） */
  date: LocalDate,
  source: PersonalFileSource,
});
export type PersonalNoteView = Static<typeof PersonalNoteView>;

/**
 * 一份档案（GET /api/personal-files/<编号>）：本人的编号是 SELF_PERSON_ID。name 是本人的"我的名字"（没设没有）、重要的人的称呼。
 * "二狗了解到的"那一块另外取（GET /api/personal-files/<编号>/learned，283 号票：经记忆插件现取，开推理库慢，不拖着档案本身）
 */
/** 285：档案里的人分在哪一组（家人、重要的人、其他人；本人那份没有） */
export const PersonGroupSchema = Type.Enum(PERSON_GROUPS);

/**
 * 一份档案、列表上的一份带的分组（285 号票）：group 是现在归哪组（重要的人那几份才有）；groupGuessed 是用户没选、按"和我的关系"猜的
 */
const GroupFields = {
  group: Type.Optional(PersonGroupSchema),
  groupGuessed: Type.Optional(Type.Boolean()),
};

export const PersonalFileView = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("self"), Type.Literal("person")]),
  name: Type.Optional(Type.String()),
  ...GroupFields,
  fields: Type.Array(PersonalFieldView),
  notes: Type.Array(PersonalNoteView),
});
export type PersonalFileView = Static<typeof PersonalFileView>;

/** 列表上的一份：称呼、和我的关系、填了几项、记了几件事 */
export const PersonalFileSummary = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("self"), Type.Literal("person")]),
  name: Type.Optional(Type.String()),
  relation: Type.Optional(Type.String()),
  ...GroupFields,
  filled: Type.Integer({ minimum: 0 }),
  notes: Type.Integer({ minimum: 0 }),
});
export type PersonalFileSummary = Static<typeof PersonalFileSummary>;

/** GET /api/personal-files：本人那份在最前（一直在），然后是重要的人（按建的先后） */
export const PersonalFilesView = Type.Object({ files: Type.Array(PersonalFileSummary) });
export type PersonalFilesView = Static<typeof PersonalFilesView>;

/** POST /api/personal-files：加一个人（称呼必填，和我的关系可不填；285：分组可不选，不选按关系猜） */
export const AddPersonBody = Type.Object({ name: Type.String(), relation: Type.Optional(Type.String()), group: Type.Optional(PersonGroupSchema) }, { additionalProperties: false });
export type AddPersonBody = Static<typeof AddPersonBody>;

/**
 * POST /api/personal-files/<编号>：在档案页里改（改了就算确认）——
 * set_field 写一个字段（field 是字段编号，自定义的写 "custom:<名字>"；旧值记成历史）；add_note 记下一件事（date 不给是今天）；
 * undo_field 撤销这个字段最近一次写入（回到上一个值，没有上一个就空着；撤销的那个值不进历史）；
 * set_reminder 生日、纪念日这类字段的每年提醒（283 号票）：daysBefore 是提前几天，null 是关掉；
 * set_group 改分组（285 号票，本人那份没有分组）
 */
export const PersonalFileChangeBody = Type.Union([
  Type.Object({ kind: Type.Literal("set_field"), field: Type.String(), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("add_note"), text: Type.String(), date: Type.Optional(LocalDate) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("undo_field"), field: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("set_reminder"), field: Type.String(), daysBefore: Type.Union([ReminderDays, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("set_group"), group: PersonGroupSchema }, { additionalProperties: false }),
]);
export type PersonalFileChangeBody = Static<typeof PersonalFileChangeBody>;

/** 删什么：整个人（本人那份不能删）、一个字段（连同历史）、一件记下的事 */
export const PersonalFileDeleteTarget = Type.Union([
  Type.Object({ kind: Type.Literal("person") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("field"), field: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("note"), noteId: Type.String() }, { additionalProperties: false }),
]);
export type PersonalFileDeleteTarget = Static<typeof PersonalFileDeleteTarget>;

/** 两种删法：忘掉（档案里没有了，事件日志里原话还在）、彻底删除（字段值和历史连同核对卡、读过它的调用记录一起改写掉） */
export const PERSONAL_FILE_DELETE_MODES = ["forget", "purge"] as const;
export type PersonalFileDeleteMode = (typeof PERSONAL_FILE_DELETE_MODES)[number];

/**
 * POST /api/personal-files/<编号>/delete。withSources：彻底删除时连出处那句话（用户的原话，和它的素材）一起彻底删除——
 * 照删素材的规矩由用户在页面上选，不选就只删档案里的
 */
export const PersonalFileDeleteBody = Type.Object(
  { target: PersonalFileDeleteTarget, mode: Type.Enum(PERSONAL_FILE_DELETE_MODES), withSources: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export type PersonalFileDeleteBody = Static<typeof PersonalFileDeleteBody>;

/** 删完：这份档案现在的样子（删的是整个人就没有）、连带彻底删除了几句出处的原话 */
export const PersonalFileDeleteResult = Type.Object({ file: Type.Optional(PersonalFileView), sources: Type.Integer({ minimum: 0 }) });
export type PersonalFileDeleteResult = Static<typeof PersonalFileDeleteResult>;

/** 核对卡上的一个字段：值照原样，号码类（number）逐位列出（numberGroups）；原来有值的写上原来的 */
export const PersonalFileCardField = Type.Object({
  field: Type.String(),
  label: Type.String(),
  value: Type.String(),
  number: Type.Boolean(),
  previous: Type.Optional(Type.String()),
});
export type PersonalFileCardField = Static<typeof PersonalFileCardField>;

/**
 * 核对卡上一个生日、纪念日字段的每年提醒（283 号票）：卡上默认勾着"每年提前 daysBefore 天提醒"；值认不出公历日子的不列
 */
export const PersonalFileCardRemind = Type.Object({
  field: Type.String(),
  label: Type.String(),
  month: Type.Integer({ minimum: 1, maximum: 12 }),
  day: Type.Integer({ minimum: 1, maximum: 31 }),
  daysBefore: ReminderDays,
});
export type PersonalFileCardRemind = Static<typeof PersonalFileCardRemind>;

/**
 * 核对卡"确认写入"时带的（283 号票）：勾着的每年提醒、各提前几天。不带（不认得这个勾的前端、纯文本降级）就照卡上默认勾着的建；
 * 带了空数组就一条都不建
 */
export const PersonalFileExecuteInput = Type.Object(
  { remind: Type.Optional(Type.Array(Type.Object({ field: Type.String(), daysBefore: ReminderDays }, { additionalProperties: false }), { maxItems: 20 })) },
  { additionalProperties: false },
);
export type PersonalFileExecuteInput = Static<typeof PersonalFileExecuteInput>;

/**
 * 个人档案的核对卡（281 号票，卡片类型 personal_file）：秘书提议写档案、要用户核对的（号码类不论点没点明都要核对；推断出来的、
 * 新建一个人的也要）——写给谁（新建的写明）、哪些字段（号码逐位列出）、记下哪件事。按钮"确认写入""取消"，确认后由运行时写进档案，
 * 和操作记录同一事务。原话里明说了的非号码类不出这张卡，直接写、聊天里留快速动作的"已执行"卡。
 * 版本 2（283 号票）：写生日、纪念日的卡上带着每年提醒的勾（remind），确认时一起建。
 */
export const PersonalFileCardPayload = Type.Object({
  actionId: Type.String(),
  conversation: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
  /** 提出它的那次工具调用（守护进程用：彻底删除档案里的值时连同这次调用的记录、会话文件里的参数一起改写） */
  toolCallId: Type.Optional(Type.String()),
  /** 一句话（"记进档案：我 · 身份证号"） */
  title: Type.String(),
  person: Type.Object({
    /** 已有的档案的编号（新建的没有） */
    id: Type.Optional(Type.String()),
    name: Type.String(),
    kind: Type.Union([Type.Literal("self"), Type.Literal("person")]),
    isNew: Type.Boolean(),
    relation: Type.Optional(Type.String()),
  }),
  fields: Type.Array(PersonalFileCardField),
  note: Type.Optional(Type.Object({ text: Type.String(), date: LocalDate })),
  /** 283 号票：生日、纪念日的每年提醒（卡上的勾，默认勾着）；彻底删除时整个去掉（302 号票：带着月日） */
  remind: Type.Optional(Type.Array(PersonalFileCardRemind)),
  /** 执行结果（确认后才有） */
  result: Type.Optional(Type.String()),
});
export type PersonalFileCardPayload = Static<typeof PersonalFileCardPayload>;

// ---------- 283 号票：二狗了解到的 ----------

/** "二狗了解到的"里的一条结论（统一记忆里和这个人有关的；推断出来的照样标明） */
export const PersonalLearnedClaim = Type.Object({
  id: Type.String(),
  statement: Type.String(),
  /** 层、状态、把握、认知来源：取值同记忆页（协议包 memory.ts 的 MEMORY_CLAIM_TIERS 这几张表） */
  tier: Type.String(),
  status: Type.String(),
  confidence: Type.String(),
  epistemic: Type.String(),
});
export type PersonalLearnedClaim = Static<typeof PersonalLearnedClaim>;

/** "二狗了解到的"里的一条事实（事实图谱里这个人的、现在还成立的） */
export const PersonalLearnedFact = Type.Object({ id: Type.String(), statement: Type.String(), observedAt: Type.String() });
export type PersonalLearnedFact = Static<typeof PersonalLearnedFact>;

/** "二狗了解到的"里的一句原话（那几条事实背后的本人证据） */
export const PersonalLearnedQuote = Type.Object({ id: Type.String(), text: Type.String(), at: Type.String() });
export type PersonalLearnedQuote = Static<typeof PersonalLearnedQuote>;

/**
 * GET /api/personal-files/<编号>/learned（283 号票）：统一记忆里和这个人有关的结论、事实、原话，经记忆插件现取、只读、不另存。
 * 档案里的人和事实图谱的人物实体按称呼、别名对齐（entities 是对上的实体的名字）；本人那份对的是用户自己。
 * 读不了（记忆插件没启用、推理库还没建、正被整理占着）时 ready 是 false，reason 是给人看的一句话，几样都是空的
 */
export const PersonalFileLearnedView = Type.Object({
  ready: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  entities: Type.Array(Type.String()),
  claims: Type.Array(PersonalLearnedClaim),
  facts: Type.Array(PersonalLearnedFact),
  quotes: Type.Array(PersonalLearnedQuote),
});
export type PersonalFileLearnedView = Static<typeof PersonalFileLearnedView>;

// ---------- 283 号票：候选的核对卡（卡片类型 personal_file_suggest） ----------


/**
 * 候选核对卡上的一条：建一份档案（create：还没有档案、提到够几次的人）、写一个字段（field）、给已经写好的生日开每年提醒（reminder）。
 * 候选都是推断出来的，用户逐条勾了才写。号码类照样逐位列出（number）；原来有值的写原来的（previous）；
 * 生日、纪念日的字段带着每年提醒的勾（remind，默认勾着）。heard 是从哪几天的话里听到的（日期，不抄原话）
 */
export const PersonalFileSuggestItem = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("create"), Type.Literal("field"), Type.Literal("reminder")]),
  person: Type.Object({
    /** 已有的档案（新建的没有） */
    id: Type.Optional(Type.String()),
    name: Type.String(),
    relation: Type.Optional(Type.String()),
    isNew: Type.Boolean(),
  }),
  field: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  previous: Type.Optional(Type.String()),
  number: Type.Optional(Type.Boolean()),
  /** 建档提议：提到了几次 */
  mentions: Type.Optional(Type.Integer({ minimum: 0 })),
  remind: Type.Optional(Type.Object({ month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }), daysBefore: ReminderDays })),
  heard: Type.Array(LocalDate),
  origin: Type.Enum(PERSONAL_SUGGEST_ORIGINS),
  /** 处理以后：写了、没写 */
  decision: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("rejected")])),
});
export type PersonalFileSuggestItem = Static<typeof PersonalFileSuggestItem>;

/**
 * 候选的核对卡（283 号票，卡片类型 personal_file_suggest）：每晚整理把白天听到的人物信息攒成候选，第二天合成一张（一天一张：
 * 还没处理的那张接着往里加）；283 时秘书直接写进档案的生日问一句要不要每年提醒也是这张卡（只有一条 reminder；302 号票起不再出）。按钮"写进档案"（带勾了哪几条、
 * 每年提醒提前几天）、"都不用"；处理完写结果。确认后由运行时写进档案（留痕：经记忆管理员提议、你在卡上确认）
 */
export const PersonalFileSuggestCardPayload = Type.Object({
  title: Type.String(),
  /** 哪天的卡（本地日期） */
  date: LocalDate,
  items: Type.Array(PersonalFileSuggestItem),
  /** 问每年提醒的那种：是哪次直接写进档案的快速动作、在哪个会话（守护进程用：留痕写成经秘书转达、你在卡上确认） */
  via: Type.Optional(Type.Object({ actionId: Type.String(), conversation: Type.String() })),
  result: Type.Optional(Type.String()),
});
export type PersonalFileSuggestCardPayload = Static<typeof PersonalFileSuggestCardPayload>;

/**
 * 候选核对卡"写进档案"带的：勾了哪几条（条目的 id）；带每年提醒的条目勾着提醒的写提前几天（不在 remind 里的不建提醒）。
 * 不带（纯文本降级、不认得这张卡的前端）就是全写、提醒照卡上默认的建
 */
export const PersonalFileSuggestInput = Type.Object(
  {
    accept: Type.Array(Type.String(), { maxItems: 100 }),
    remind: Type.Optional(Type.Array(Type.Object({ item: Type.String(), daysBefore: ReminderDays }, { additionalProperties: false }), { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export type PersonalFileSuggestInput = Static<typeof PersonalFileSuggestInput>;
