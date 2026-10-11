// 前端协议的 schema（规格第 5 节），用 TypeBox 定义。守护进程和 Web 都用这里生成的类型；
// 守护进程还拿它校验收到的请求（见 request.ts）。
import { type Static, Type } from "typebox";
import {
  CARD_ACTIONS,
  CARD_STATUSES,
  CHANNELS,
  DEVICE_CHANGES,
  DISPOSITIONS,
  ERROR_CODES,
  INBOX_ACTIONS,
  MAINTAINER_CHANNEL_PREFIX,
  MAX_MEMORY_DELETE_MATERIALS,
  MEMORY_DELETE_MODES,
  QUICK_ACTION_BASES,
  REMEMBER_SOURCES,
  REMINDER_CHANGES,
  REMINDER_STATUSES,
  SPEAKERS,
  TOOL_CALL_BLOCKS,
  TOOL_CALL_OUTCOMES,
  TOOL_NATURES,
  TURN_OUTCOMES,
  URGENCIES,
} from "./constants.ts";
import { PAIRING_FINGERPRINT_HEX_DIGITS, PAIRING_SHORT_CODE_DIGITS } from "./pairing.ts";
import { EventTrigger } from "./event-source-schema.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { VOICE_CAPTURE_TEXT_MAX, VOICE_DURATION_SLACK_MS, VOICE_MAX_MS, VOICE_MIC_LOG_MAX, VOICE_WAVEFORM_MAX, VOICE_WAVEFORM_MAX_BARS } from "./voice.ts";

// ───────────────────────── 频道 ─────────────────────────

/** 会话 id（也是会话频道名）：秘书会话，或某个维护者的会话 */
export const ConversationId = Type.Union([Type.Literal(CHANNELS.secretary), Type.TemplateLiteral(`${MAINTAINER_CHANNEL_PREFIX}\${string}`)]);
export type ConversationId = Static<typeof ConversationId>;

/** 全部频道：两类会话频道，加上任务看板、项目列表、待我处理、卡片、活动状态、已配对设备、工作日历、关注类别设置、个人助理 */
export const Channel = Type.Union([
  ConversationId,
  Type.Literal(CHANNELS.board),
  Type.Literal(CHANNELS.projects),
  Type.Literal(CHANNELS.inbox),
  Type.Literal(CHANNELS.cards),
  Type.Literal(CHANNELS.activity),
  Type.Literal(CHANNELS.devices),
  Type.Literal(CHANNELS.workdayCalendar),
  Type.Literal(CHANNELS.watchCategories),
  Type.Literal(CHANNELS.assistantName),
]);
export type Channel = Static<typeof Channel>;

// ───────────────────────── 消息 ─────────────────────────

export const Speaker = Type.Enum(SPEAKERS);
export type Speaker = Static<typeof Speaker>;

export const Disposition = Type.Enum(DISPOSITIONS);
export type Disposition = Static<typeof Disposition>;

export const ToolCallOutcome = Type.Enum(TOOL_CALL_OUTCOMES);
export type ToolCallOutcome = Static<typeof ToolCallOutcome>;
export const ToolNature = Type.Enum(TOOL_NATURES);
export type ToolNature = Static<typeof ToolNature>;

/**
 * 消息的 part：形状对齐 AI SDK 的 UIMessage parts，但类型自己定义。
 * 视频只预留，界面上显示为占位。
 */
export const TextPart = Type.Object({ type: Type.Literal("text"), text: Type.String() });
/** 推理：界面上默认折叠 */
export const ReasoningPart = Type.Object({ type: Type.Literal("reasoning"), text: Type.String() });
export const ImagePart = Type.Object({
  type: Type.Literal("image"),
  mediaId: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
  /** 用户"作为材料投喂"发的（21 号票） */
  asMaterial: Type.Optional(Type.Boolean()),
});
export const FilePart = Type.Object({
  type: Type.Literal("file"),
  mediaId: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  /** 用户经附件菜单"作为材料投喂"发的：这条消息记成"用户主动投喂的材料"素材（21 号票） */
  asMaterial: Type.Optional(Type.Boolean()),
});
/** 波形摘要：每格 0–100 的音量（画语音气泡用，31 号票） */
export const VoiceWaveform = Type.Array(Type.Integer({ minimum: 0, maximum: VOICE_WAVEFORM_MAX }), { maxItems: VOICE_WAVEFORM_MAX_BARS });
/** 语音的时长（毫秒）：最多 60 秒，加上一点浏览器计时的出入 */
export const VoiceDurationMs = Type.Integer({ minimum: 0, maximum: VOICE_MAX_MS + VOICE_DURATION_SLACK_MS });
/**
 * 麦克风诊断记录的一条（61 号票）：麦克风开关、音轨事件的时刻和原因。
 * event：open 开始要麦克风（reason 是原因）、ready 要到了（ms 是 getUserMedia 的毫秒数）、fail 没要到（reason 是错误名）、
 * close 停掉音轨（reason 是原因）、mute / unmute / ended 音轨被系统静音、恢复、收走，silent 录完一段整段是静音（ms 是这一段的毫秒数）。
 * 每条还带上那一刻的页面信号（document.hasFocus()、document.visibilityState），鸿蒙浏览器、原生壳里焦点或前后台报得不对时能查出来。
 * 原因见 docs/dev.md"麦克风让路"一节；以后多出来的事件、原因照收（字符串）
 */
export const VoiceMicLogEntry = Type.Object({
  /** 相对这一段按下的毫秒数（负数是按下之前） */
  atMs: Type.Number(),
  event: Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.reason }),
  reason: Type.Optional(Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.logReason })),
  ms: Type.Optional(Type.Number()),
  /** 那一刻 document.hasFocus() */
  hasFocus: Type.Optional(Type.Boolean()),
  /** 那一刻 document.visibilityState（visible、hidden……） */
  visibility: Type.Optional(Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.visibility })),
});
export type VoiceMicLogEntry = Static<typeof VoiceMicLogEntry>;
/**
 * 录音的诊断（37 号票，麦克风预热；61 号票加了开麦原因、冷启动耗时、整段最大振幅、麦克风诊断记录和浏览器；
 * 63 号票加了录音走哪儿、原生录音器备好用了多久、原生开录到第一块数据）：
 * 按下"按住 说话"到录音器真正开始（浏览器是 MediaRecorder 的 start 事件，鸿蒙 App 的原生录音是第一块数据）花了多少毫秒，
 * 以及这次是不是预热命中（按下时麦克风流已经开着、原生录音器已经备好，按下即录）。只用来在用户手机上看实际数字，不影响别的行为。
 * 这是守护进程整理后存进语音对象（VoiceRecord.capture）的样子；前端随语音 part 带来的（VoicePart.capture）收的时候一概不校验，
 * 守护进程只取认得的、类型对的，数字不合理（负数）的丢掉，带得不对也不拒收这条语音；消息的语音 part 里不留
 */
export const VoiceCapture = Type.Object({
  /** 录音走哪儿（63 号票）：web 是浏览器的 getUserMedia + MediaRecorder，native 是鸿蒙 App 的原生录音器（AudioCapturer） */
  backend: Type.Optional(Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.reason })),
  /** 按下 → 录音器真正开始（毫秒；原生录音是按下 → 第一块数据）；录音器没报开始时没有 */
  startDelayMs: Type.Optional(Type.Number()),
  /** 预热命中：按下时麦克风流已经就绪（原生：录音器已经备好） */
  prewarmed: Type.Optional(Type.Boolean()),
  /** 原生录音器备好用了多久（毫秒，createAudioCapturer 从调用到返回；原生的冷启动耗时，63 号票） */
  prepareMs: Type.Optional(Type.Number()),
  /** 原生录音器 start 到第一块数据（毫秒，App 里量的；startDelayMs 减去它就是按下到网页调进 App 的那一截，63 号票） */
  firstDataMs: Type.Optional(Type.Number()),
  /** 录这一段的麦克风流是为什么打开的：enter、visible、focus、edit-out、press、stale、silent、playback-end…… */
  openReason: Type.Optional(Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.reason })),
  /** 打开这个流时 getUserMedia 从调用到返回的毫秒数（冷启动耗时） */
  gumMs: Type.Optional(Type.Number()),
  /** 这一段录音里量到的最大振幅（0–1）：音量分析在跑时才有，看录到的是不是空白 */
  peak: Type.Optional(Type.Number()),
  /** 最近的麦克风开关和音轨事件（最多 VOICE_MIC_LOG_MAX 条，旧的在前） */
  micLog: Type.Optional(Type.Array(VoiceMicLogEntry, { maxItems: VOICE_MIC_LOG_MAX })),
  /** 浏览器（navigator.userAgent） */
  browser: Type.Optional(Type.String({ maxLength: VOICE_CAPTURE_TEXT_MAX.browser })),
});
export type VoiceCapture = Static<typeof VoiceCapture>;
/**
 * 语音（31 号票）：一条语音是一个语音对象（voice-schema.ts 的 VoiceRecord），part 只引用它，带上画气泡要的时长和波形。
 * 用户发的：先经 HTTP 上传整段录音，发消息时不带 voiceId，服务端核对音频、建出语音对象后填上；
 * 识别出的文字和识别状态在 VoiceRecord 里（会话频道上的 voice 事件），不在消息里
 */
export const VoicePart = Type.Object({
  type: Type.Literal("voice"),
  voiceId: Type.Optional(Type.String()),
  mediaId: Type.String(),
  /** 录音的格式；服务端存的是按内容认出的类型 */
  mime: Type.String({ maxLength: 128 }),
  durationMs: VoiceDurationMs,
  waveform: VoiceWaveform,
  /**
   * 录音的诊断（37、61 号票）：只在发送时带，守护进程整理后存进语音对象，消息里不留。
   * 收的时候不校验（只是诊断，带得不对、多带了也不拒收这条语音），类型照 VoiceCapture 写
   */
  capture: Type.Optional(Type.Unsafe<VoiceCapture>(Type.Unknown())),
});
/**
 * agent 发的语音（32 号票的语音回复）：一条是一个 agent 语音对象（voice-schema.ts 的 AgentVoiceRecord），合成完成时运行时追加一条
 * 只有它的消息。part 带上播放和画气泡要的（合成出的音频、格式、时长、波形）；送进 TTS 的原文、所用参考音色、TTS 模型、
 * 对应的完整回复在哪条消息里，在 AgentVoiceRecord 里（会话频道上的 agent_voice 事件）。时长不受用户语音 60 秒的限制。
 * 38 号票起分段合成：音频是各段拼好的完整的一条；合成到一半没合成下去的（partial）同样追加，音频是推出去的那几段拼成的
 */
export const TtsAudioPart = Type.Object({
  type: Type.Literal("tts_audio"),
  voiceId: Type.String(),
  mediaId: Type.String(),
  mime: Type.String({ maxLength: 128 }),
  durationMs: Type.Integer({ minimum: 0 }),
  waveform: VoiceWaveform,
});
/** 视频（预留） */
export const VideoPart = Type.Object({ type: Type.Literal("video"), mediaId: Type.String() });
export const ToolCallPart = Type.Object({
  type: Type.Literal("tool_call"),
  callId: Type.String(),
  /** 工具名（模型调用的工具；通用 bash 是 bash） */
  tool: Type.String(),
  /** 参数摘要（一行） */
  argsSummary: Type.String(),
  /** 命中的关注类别显示用的名字（比如"越出项目目录"；用户自定义的类别是它的名字），不是类别 id */
  categoryTitles: Type.Array(Type.String()),
  /** 守卫的处置（六档之一）；守卫判定出错时没有（blockedBy 为 judge_error） */
  disposition: Type.Optional(Disposition),
  /**
   * 被拦下的原因不是处置时：硬拒绝、按规则退回（这时 disposition 只说明按处置会怎么判）、判定出错；
   * 流程执行时按计划引回前置步骤、计划检查直接拦下（59 号票）
   */
  blockedBy: Type.Optional(Type.Enum(TOOL_CALL_BLOCKS)),
  /** 是否属于授权内 */
  withinGrant: Type.Boolean(),
  /** 是否通用 bash（没有事先规定类型的 bash 调用） */
  genericBash: Type.Boolean(),
  outcome: ToolCallOutcome,
  /** 结果摘要 */
  resultSummary: Type.Optional(Type.String()),
  /**
   * 这次调用做了什么性质的事：只看、动手、删改（54 号票，守护进程按守卫的判定定，被拦下的也按要做的事记；界面上没执行的按只看画）。
   * 54 号票之前的记录、守卫判定出错的没有：前端按工具名估
   */
  nature: Type.Optional(ToolNature),
  /**
   * 这次调用读了密钥文件（.env 这类，放行执行了的；结果摘要不记文件内容，67 号票）：界面在说人话的那一句前面加 🔒
   * （照 AgentSense 读了敏感数据的标法）。只在是的时候带；67 号票之前的记录没有
   */
  readsSecretFile: Type.Optional(Type.Boolean()),
  /**
   * 流程执行时这次调用和授权的计划比对的结果（60 号票，照 AgentSense 每次调用记下的 stepId、offPlan、findings、correction）：
   * 算在哪一步（对上的那一步；没对上时是同一工具的第一步，给人看的）、计划里没有这个工具的步骤、查出的问题（没被放行的那几种的类别：
   * off_plan、out_of_scope、out_of_order、repeat、forbidden、rule:<规则 id>、rule_unknown:<规则 id>、checker_error）、
   * 真的用上了的自动纠偏（rewrite 按计划改回参数后执行、redirect 没执行、引回前置步骤）。
   * 界面"接下来的计划"虚线框据此把偏离标在那一格。不在流程里的调用、60 号票之前的记录没有
   */
  plan: Type.Optional(
    Type.Object({
      stepId: Type.Optional(Type.String()),
      offPlan: Type.Optional(Type.Literal(true)),
      findings: Type.Optional(Type.Array(Type.String())),
      correction: Type.Optional(Type.Union([Type.Literal("rewrite"), Type.Literal("redirect")])),
    }),
  ),
});
export const CardRefPart = Type.Object({ type: Type.Literal("card_ref"), cardId: Type.String() });
/** 维护者会话的分段线：工单段带工单号；用户直接对话（含立项问答）开的"对话段"工单号为空 */
export const WorkOrderDividerPart = Type.Object({
  type: Type.Literal("work_order_divider"),
  workOrderId: Type.String(),
  title: Type.String(),
  from: Type.String(),
});

/**
 * 定时触发的任务的会话里一次运行的分段线（76 号票）：每次运行开始时画一条，任务详情按运行分段（缩小后按运行聚色块）。
 * jobId、runId 是触发登记和这次运行；title 是"第 3 次运行 · 10-08 09:00 到点"
 */
export const RunDividerPart = Type.Object({
  type: Type.Literal("run_divider"),
  jobId: Type.String(),
  runId: Type.String(),
  title: Type.String(),
});
export type RunDividerPart = Static<typeof RunDividerPart>;

export const MessagePart = Type.Union([
  TextPart,
  ReasoningPart,
  ImagePart,
  FilePart,
  VoicePart,
  TtsAudioPart,
  VideoPart,
  ToolCallPart,
  CardRefPart,
  WorkOrderDividerPart,
  RunDividerPart,
]);
export type MessagePart = Static<typeof MessagePart>;

/** 消息信封：一条消息由若干 part 组成。 */
export const MessageEnvelope = Type.Object({
  id: Type.String(),
  /** 所属会话，同时也是它所在的频道名 */
  conversation: ConversationId,
  speaker: Speaker,
  /** 带时区偏移的 ISO 时间 */
  time: Type.String(),
  parts: Type.Array(MessagePart),
});
export type MessageEnvelope = Static<typeof MessageEnvelope>;

// ───────────────────────── 卡片 ─────────────────────────

export const CardAction = Type.Enum(CARD_ACTIONS);
export type CardAction = Static<typeof CardAction>;

export const CardStatus = Type.Enum(CARD_STATUSES);
export type CardStatus = Static<typeof CardStatus>;

export const Urgency = Type.Enum(URGENCIES);
export type Urgency = Static<typeof Urgency>;

/** 卡片实体：消息里只放引用，状态只有一份，在聊天、待我处理、时间线里同步。 */
export const Card = Type.Object({
  id: Type.String(),
  /** 卡片类型；前端可能还不认识，用 isCardType 收窄 */
  type: Type.String(),
  /** 负载的版本（卡片类型注册表登记的版本）；前端认识的版本比它低时，和不认识的类型一样处理 */
  typeVersion: Type.Integer({ minimum: 1 }),
  /** 每次状态变化加 1；按钮动作带上期望版本，服务端按版本条件更新 */
  version: Type.Integer({ minimum: 1 }),
  status: CardStatus,
  /** 按卡片类型注册表里的 schema 校验过的负载 */
  payload: Type.Unknown(),
  /** 纯文本降级版本（注册表按负载生成）：不认识这种卡的前端显示它，加上"去 Web 处理"的链接 */
  text: Type.String(),
  urgency: Type.Optional(Urgency),
  createdAt: Type.String(),
  handledAt: Type.Optional(Type.String()),
  /** 处理结果：点了哪个动作，附带的说明（打回意见、勾掉了哪几项授权……） */
  outcome: Type.Optional(Type.Object({ action: CardAction, note: Type.Optional(Type.String()) })),
  /** 系统让它作废时的说明（status 为 expired；84 号票：从某个阶段重做之后旧的审批卡、计划变更卡），再点旧按钮回这句 */
  expiredNote: Type.Optional(Type.String()),
});
export type Card = Static<typeof Card>;

// ───────────────────────── 帧 ─────────────────────────

/** 请求帧 `{id, 方法, 参数, 幂等键?}`。有副作用的方法必须带幂等键，重发不会做两次。 */
export const RequestFrame = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  method: Type.String({ minLength: 1 }),
  params: Type.Unknown(),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type RequestFrame = Static<typeof RequestFrame>;

export const ErrorBody = Type.Object({ code: Type.Enum(ERROR_CODES), message: Type.String() });
export type ErrorBody = Static<typeof ErrorBody>;

/** 响应帧 `{id, 成功与否, 结果或错误}`。请求帧连 id 都读不出来时，id 为 null。 */
export const ResponseFrame = Type.Union([
  Type.Object({ id: Type.Union([Type.String(), Type.Null()]), ok: Type.Literal(true), result: Type.Unknown() }),
  Type.Object({ id: Type.Union([Type.String(), Type.Null()]), ok: Type.Literal(false), error: ErrorBody }),
]);
export type ResponseFrame = Static<typeof ResponseFrame>;

/**
 * 事件帧 `{频道, 序号, 类型, 负载}`：守护进程在某个频道上推给前端的一条事件。
 * 落盘事件的序号在频道内从 1 起连续递增；临时事件（流式增量）的序号是它所在频道当时最后一条落盘事件的序号。
 */
export const EventFrame = Type.Object({
  channel: Type.String(),
  seq: Type.Integer({ minimum: 0 }),
  type: Type.String(),
  payload: Type.Unknown(),
});
export type EventFrame = Static<typeof EventFrame>;

// ───────────────────────── 方法的参数与结果 ─────────────────────────

export const SubscribeParams = Type.Object({
  protocolVersion: Type.Integer(),
  /** 每个要订阅的频道，以及前端在这个频道上最后收到的序号（没收到过是 0） */
  cursors: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type SubscribeParams = Static<typeof SubscribeParams>;

export const SubscribeResult = Type.Object({
  protocolVersion: Type.Integer(),
  /**
   * 要重新同步的频道：前端带来的序号比服务端这个频道的最后序号还大（比如数据目录恢复成了旧快照）。
   * 前端清掉这些频道的状态；服务端从头补发它们的事件。
   */
  resync: Type.Array(Type.String()),
});
export type SubscribeResult = Static<typeof SubscribeResult>;

export const SendMessageParams = Type.Object({
  conversation: ConversationId,
  parts: Type.Array(MessagePart, { minItems: 1, maxItems: 64 }),
  /**
   * 这句话是在哪个任务的详情里说的（75 号票）：项目的维护者的会话里同时有好几件事，项目内部的普通任务做完之后用户在它的详情里
   * 接着说，靠它认出说的是这件事——消息属于这个任务，任务回到执行中、派一张执行的工单接着做。别的会话、别的任务不看它
   */
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
});
export type SendMessageParams = Static<typeof SendMessageParams>;

/** 发消息的结果：落盘后的消息 id 和它在会话频道里的序号（同一幂等键重发拿到同一个结果） */
export const SendMessageResult = Type.Object({ messageId: Type.String(), seq: Type.Integer() });
export type SendMessageResult = Static<typeof SendMessageResult>;

/** 对卡片做动作：`{卡片 id, 动作, 期望版本, 幂等键}`；服务端按版本条件更新，先到先得 */
export const CardActionParams = Type.Object({
  cardId: Type.String(),
  action: CardAction,
  expectedVersion: Type.Integer({ minimum: 1 }),
  /** 动作附带的说明（打回意见、勾掉了哪几项授权、选了哪些答案） */
  note: Type.Optional(Type.String()),
  /** 动作附带的结构化输入（比如改提醒的新时间），按卡片类型注册表里这个动作的 schema 校验 */
  input: Type.Optional(Type.Unknown()),
});
export type CardActionParams = Static<typeof CardActionParams>;

/** 卡片动作的 ack：生效后卡片的版本（同一幂等键重发拿到同一个结果）；卡片本身随后在卡片频道推送 */
export const CardActionResult = Type.Object({ cardId: Type.String(), version: Type.Integer({ minimum: 1 }) });
export type CardActionResult = Static<typeof CardActionResult>;

// ───────────────────────── 事件负载 ─────────────────────────

/**
 * 会话里一条消息（或时间线上的一条记录）的归属，只有这一份定义（25 号票起）：消息事件、历史分页、时间线记录都摊开带着这几个字段，
 * 取值用 message-scope.ts 的 pickMessageScope。
 */
export const MessageScope = Type.Object({
  /** 属于哪个任务、哪个项目（维护者会话里的消息由 13、15、16 号票带上；秘书会话里没有）。素材的"任务或项目"取自这里 */
  taskId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  /** 属于任务的：那时任务在哪个阶段（开始执行之后才有；工具调用记录取守卫判定时的阶段）。时间线的全局层据此按阶段聚色块 */
  stageId: Type.Optional(Type.String()),
  /** 属于哪个定时作业的一次运行（19 号票交给维护者执行作业时带上）；维护者处理它时的 token 用量记在作业名下（24 号票） */
  scheduledJobId: Type.Optional(Type.String()),
  /** 哪个 agent 说的：一个会话里不止一个 agent 时写明（20 号票的子 agent）；只有一个 agent 的会话不写 */
  agentId: Type.Optional(Type.String()),
});
export type MessageScope = Static<typeof MessageScope>;

/** `message` 事件：定稿的消息；是用户自己发的就带上发送请求的幂等键（乐观显示的消息靠它被替换）。 */
export const MessageEventPayload = Type.Object({
  message: MessageEnvelope,
  idempotencyKey: Type.Optional(Type.String()),
  /** 这条消息的归属：任务、项目、阶段、agent（MessageScope） */
  ...MessageScope.properties,
  /**
   * 运行时给 agent 的通知（发言方是 system）：和用户消息一样排进 agent 的输入队列，交给 agent 处理
   * （比如"某某已获批准，可以重试"、"交给我做"的事用户已完成）。普通的系统说明没有这一项
   */
  agentInput: Type.Optional(Type.Boolean()),
  /**
   * 运行时给 agent 的通知里，agent 正在干活时以插话送达的（14 号票：现在只有无进展的催促）：
   * 在下一次模型调用之前插入，不等这一轮结束；agent 闲着时和别的通知一样排队处理
   */
  interject: Type.Optional(Type.Boolean()),
});
export type MessageEventPayload = Static<typeof MessageEventPayload>;

/** `turn_start` 事件：agent 开始处理会话里的一条用户消息 */
export const TurnStartEventPayload = Type.Object({ inputMessageId: Type.String() });
export type TurnStartEventPayload = Static<typeof TurnStartEventPayload>;

/** `turn_end` 事件：agent 处理完会话里的一条用户消息（出队） */
export const TurnEndEventPayload = Type.Object({
  /** 处理的是哪条用户消息 */
  inputMessageId: Type.String(),
  outcome: Type.Enum(TURN_OUTCOMES),
  error: Type.Optional(Type.String()),
});
export type TurnEndEventPayload = Static<typeof TurnEndEventPayload>;

/**
 * `stream` 事件（临时）：agent 回复的流式增量。messageId 就是定稿后那条消息的 id。
 * 每段增量写明落在第几个 part、从这个 part 的第几个字符起（UTF-16 下标），
 * 前端据此判断有没有漏掉中间的增量（比如断线重连、或者回复说到一半才打开页面）。
 */
export const StreamDelta = Type.Object({
  part: Type.Integer({ minimum: 0 }),
  type: Type.Union([Type.Literal("text"), Type.Literal("reasoning")]),
  offset: Type.Integer({ minimum: 0 }),
  text: Type.String(),
});
export type StreamDelta = Static<typeof StreamDelta>;

export const StreamEventPayload = Type.Object({ messageId: Type.String(), deltas: Type.Array(StreamDelta) });
export type StreamEventPayload = Static<typeof StreamEventPayload>;

/** `card` 事件：卡片的最新版本 */
export const CardEventPayload = Type.Object({ card: Card });
export type CardEventPayload = Static<typeof CardEventPayload>;

/** `card_dismissed` 事件：用户关掉了一张卡（不处理）。回避信号的素材 */
export const CardDismissedEventPayload = Type.Object({
  cardId: Type.String(),
  cardType: Type.String(),
  /** 关掉用的是哪个动作（"不用了"、"取消"……） */
  action: CardAction,
  /** 用户关掉时附带的说明（用户自己的话，素材里记成本人） */
  note: Type.Optional(Type.String()),
  /** 卡片的纯文本降级（类型和标题）：素材里作为引用的说明进关键词索引 */
  cardText: Type.Optional(Type.String()),
  time: Type.String(),
});
export type CardDismissedEventPayload = Static<typeof CardDismissedEventPayload>;

/** `card_stale` 事件：建议卡、提问卡长期没处理（08 号票计时并产生）。回避信号的素材 */
export const CardStaleEventPayload = Type.Object({
  cardId: Type.String(),
  cardType: Type.String(),
  /** 从什么时候起一直待处理 */
  pendingSince: Type.String(),
  /** 到期的时刻（建卡时间加上天数；守护进程那时没在运行、事后补发的，也记到期的时刻） */
  time: Type.String(),
  /** 卡片的纯文本降级（类型和标题）：素材里作为引用的说明进关键词索引 */
  cardText: Type.Optional(Type.String()),
});
export type CardStaleEventPayload = Static<typeof CardStaleEventPayload>;

/**
 * 彻底删除（规格第 15 节，21 号票做）改写后的事件负载：事件的频道、序号、类型、时间不变，负载整个换成这个标记，原文一个字不留。
 * 事件日志不可修改，例外有三个（彻底删除、删除项目、工具调用完整内容的保留期清理），整条换成这个标记的只有前两个。素材采集遇到它一律跳过；前端在原来的位置显示"已删除"。判断用 deleted-event.ts 的 isDeletedEventPayload。
 */
export const DeletedEventPayload = Type.Object({
  deleted: Type.Literal(true),
  /** 什么时候删的 */
  deletedAt: Type.String(),
  /** 原来是一条消息的：留下消息 id 和发送时间（界面上在原来的位置显示"已删除"），内容不留 */
  messageId: Type.Optional(Type.String()),
  messageTime: Type.Optional(Type.String()),
});
export type DeletedEventPayload = Static<typeof DeletedEventPayload>;

// ───────────────────────── 项目内部（64 号票） ─────────────────────────

/**
 * 项目内部的标记（64 号票，ADR-0023）：项目内部任务，以及跟着它的待我处理事项、定时作业、项目的维护者给的建议卡，
 * 都带着它属于哪个项目。只在项目内部看得到（判断只用 project-internal.ts 的 isProjectInternal）
 */
export const ProjectInternal = Type.Object({ projectId: Type.String(), projectName: Type.String() });
export type ProjectInternal = Static<typeof ProjectInternal>;

// ───────────────────────── 待我处理 ─────────────────────────

/** 两种事项共有的字段 */
const inboxItemBase = {
  id: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  /** 来自哪里："简单提醒"、"任务「…」"、"项目「…」"、"系统" */
  source: Type.String(),
  urgency: Urgency,
  /** 置顶（到点的提醒） */
  pinned: Type.Boolean(),
  createdAt: Type.String(),
  read: Type.Boolean(),
  archived: Type.Boolean(),
  deleted: Type.Boolean(),
  /**
   * 项目内部的事项（64 号票）：项目内部任务的计划卡、审批、卡住求助……建的时候标上。秘书看不到它的细节
   * （列出待我处理只有一行"项目「X」内部的事项"，卡片不能放进秘书的聊天）
   */
  internal: Type.Optional(ProjectInternal),
};

/** 卡片事项：要处理的那张卡。处理没处理看卡片本身的状态（在聊天里处理了，这里同步） */
export const CardInboxItem = Type.Object({ ...inboxItemBase, kind: Type.Literal("card"), cardId: Type.String() });
export type CardInboxItem = Static<typeof CardInboxItem>;

/** 通知类事项：点了它的某个动作就算处理了 */
export const NoticeInboxItem = Type.Object({
  ...inboxItemBase,
  kind: Type.Literal("notice"),
  /** 通知的种类（NOTICE_TYPES）；前端可能还不认识 */
  notice: Type.String(),
  body: Type.Optional(Type.String()),
  /** 可选的处理动作；点了任意一个就算处理了 */
  actions: Type.Array(Type.String()),
  /** 处理结果：点了哪个动作 */
  handled: Type.Optional(Type.String()),
  handledAt: Type.Optional(Type.String()),
  /** 系统替你记成处理过（作废）时的说明（84 号票：从某个阶段重做之后旧的等你验收、卡住求助……），再点旧按钮回这句 */
  handledNote: Type.Optional(Type.String()),
  /** 相关的卡（比如到点的提醒对应的提醒卡），可以没有 */
  cardId: Type.Optional(Type.String()),
  /** 某种通知自己的结构化内容（比如归档清单的每一项），由产生它的票定 */
  data: Type.Optional(Type.Unknown()),
});
export type NoticeInboxItem = Static<typeof NoticeInboxItem>;

/**
 * 待我处理事项：要处理的卡片，或者通知类事项。按紧急度三档排序，置顶的排在最前；
 * 可标已读、归档、删除（删除也是一次更新：deleted 为 true，前端把它拿掉）。
 * 处理过没有用 inbox.ts 的 isInboxItemProcessed 判断（守护进程和前端共用）。
 */
export const InboxItem = Type.Union([CardInboxItem, NoticeInboxItem]);
export type InboxItem = Static<typeof InboxItem>;

export const InboxAction = Type.Enum(INBOX_ACTIONS);
export type InboxAction = Static<typeof InboxAction>;

/**
 * 对待我处理事项的动作。一次可以对多项做同一个动作（"全部标已读"），要么全部生效、要么全部不生效：
 * 卡着任务（紧急度前两档）的事项处理之前归档或删除会被拒（not_allowed），message 写明原因。
 */
export const InboxActionParams = Type.Object({
  itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: 500 }),
  action: InboxAction,
  /** 处理通知类事项时选的动作（必须是事项的 actions 之一） */
  choice: Type.Optional(Type.String()),
});
export type InboxActionParams = Static<typeof InboxActionParams>;

/** 动作生效后各事项的版本（没有变化的事项版本不变）；事项本身随后在待我处理频道推送 */
export const InboxActionResult = Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), version: Type.Integer({ minimum: 1 }) })) });
export type InboxActionResult = Static<typeof InboxActionResult>;

/** `inbox_item` 事件：一条事项的最新状态 */
export const InboxItemEventPayload = Type.Object({ item: InboxItem });
export type InboxItemEventPayload = Static<typeof InboxItemEventPayload>;

/** `notify` 事件（临时）：马上告诉用户的一件事。前端在任意页面给出页面内提示，用户允许时再发浏览器通知 */
export const NotifyEventPayload = Type.Object({
  /** 这次通知的 id（浏览器通知用它去重：同一件事在几个窗口里只弹一条） */
  id: Type.String(),
  title: Type.String(),
  body: Type.Optional(Type.String()),
  /** 对应的待我处理事项 */
  itemId: Type.Optional(Type.String()),
});
export type NotifyEventPayload = Static<typeof NotifyEventPayload>;

// ───────────────────────── 简单提醒 ─────────────────────────

export const ReminderStatus = Type.Enum(REMINDER_STATUSES);
export type ReminderStatus = Static<typeof ReminderStatus>;

/** 简单提醒（任务看板上"运营中 · 待触发"；已触发的一次性提醒归"最近结束"） */
export const Reminder = Type.Object({
  id: Type.String(),
  /** 提醒什么 */
  text: Type.String(),
  /** 到点提醒的：时间表（事件发生时提醒的没有） */
  schedule: Type.Optional(ReminderSchedule),
  /** 事件发生时提醒（77 号票）：哪个事件来源、哪几种事件、过滤条件；一直待触发，每来一次事件发一条通知 */
  event: Type.Optional(EventTrigger),
  status: ReminderStatus,
  /** 下一次响的时间；已触发的一次性提醒和已取消的没有 */
  nextAt: Type.Optional(Type.String()),
  /** 最近一次响的时间（事件发生时提醒的是那次事件的时刻） */
  lastFiredAt: Type.Optional(Type.String()),
  /** 事件发生时提醒的（77 号票）：最近一次是什么事件（一句话） */
  lastEvent: Type.Optional(Type.String()),
  /** 它的提醒卡 */
  cardId: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Reminder = Static<typeof Reminder>;

/**
 * `reminder` 事件：一条简单提醒的最新状态，以及这次是什么变化、谁做的（秘书是 agent，用户点卡上的按钮，调度器是 system）。
 * 到点时守护进程没在运行（或者机器睡着了）、晚了才响的，带上晚了多少分钟：60 分钟以内照发（fired），更晚的改放进待我处理（missed）。
 */
export const ReminderEventPayload = Type.Object({
  reminder: Reminder,
  change: Type.Enum(REMINDER_CHANGES),
  by: Speaker,
  lateMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ReminderEventPayload = Static<typeof ReminderEventPayload>;

/** 简单提醒卡的负载（卡片类型注册表里 reminder 的 schema） */
export const ReminderCardPayload = Type.Object({
  reminderId: Type.String(),
  text: Type.String(),
  schedule: Type.Optional(ReminderSchedule),
  /** 事件发生时提醒的（77 号票）：在等什么事件；卡上不能改时间 */
  event: Type.Optional(EventTrigger),
  status: ReminderStatus,
  nextAt: Type.Optional(Type.String()),
  lastFiredAt: Type.Optional(Type.String()),
});
export type ReminderCardPayload = Static<typeof ReminderCardPayload>;

// ───────────────────────── 审批 ─────────────────────────

/**
 * 审批卡的负载（卡片类型注册表里 approval 的 schema）：守卫判定"先问我"的一次工具调用。
 * 动作：批准这一次（approve）、拒绝（deny，可附说明）。同一张卡出现在聊天和待我处理里。
 */
export const ApprovalCardPayload = Type.Object({
  approvalId: Type.String(),
  /** 来源：对话里是"秘书对话"，任务里写任务和阶段 */
  source: Type.String(),
  /** 任务里的审批：所属任务和阶段（对话里没有） */
  taskId: Type.Optional(Type.String()),
  stageId: Type.Optional(Type.String()),
  /** 要做什么：工具名（通用 bash 是 bash）、它的中文名、参数摘要 */
  tool: Type.String(),
  toolTitle: Type.String(),
  argsSummary: Type.String(),
  /** 命中的关注类别显示用的名字（不是类别 id） */
  categoryTitles: Type.Array(Type.String()),
  /** 守卫为什么要问 */
  reason: Type.String(),
});
export type ApprovalCardPayload = Static<typeof ApprovalCardPayload>;

/** 提醒卡上"改"（动作 save）的输入：新的时间或重复规则，可以连内容一起改 */
export const ReminderEditInput = Type.Object({
  schedule: ReminderSchedule,
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type ReminderEditInput = Static<typeof ReminderEditInput>;

/**
 * 发起对话框里选了"只提醒我"（create_reminder，76 号票）：提醒什么、什么时候（一次性的，或者和定时触发的任务同一套重复时间表，
 * "按我的工作日"跟着个人工作日历）。不用 agent，到点只发一条通知；用户建的，建出照样有提醒卡
 */
export const CreateReminderParams = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 500 }),
  /** 到点提醒：时间表（和 event 二选一） */
  schedule: Type.Optional(ReminderSchedule),
  /** 事件发生时提醒（77 号票）：哪个事件来源、哪几种事件、过滤条件（和 schedule 二选一） */
  event: Type.Optional(EventTrigger),
});
export type CreateReminderParams = Static<typeof CreateReminderParams>;

/** 建出的提醒（同一幂等键重发拿到同一条） */
export const CreateReminderResult = Type.Object({ reminderId: Type.String() });
export type CreateReminderResult = Static<typeof CreateReminderResult>;


// ───────────────────────── 设备配对与已配对设备 ─────────────────────────

/**
 * 配对请求卡的负载（卡片类型注册表里 pairing 的 schema）：新设备上显示的设备名、6 位短码、8 位十六进制短指纹，
 * 供用户在本机或已配对的设备上核对后批准。新设备改了设备名，卡片跟着改（版本加 1）。
 */
export const PairingCardPayload = Type.Object({
  requestId: Type.String(),
  deviceName: Type.String({ minLength: 1 }),
  shortCode: Type.String({ pattern: `^[0-9]{${PAIRING_SHORT_CODE_DIGITS}}$` }),
  fingerprint: Type.String({ pattern: `^[0-9a-f]{${PAIRING_FINGERPRINT_HEX_DIGITS}}$` }),
  /** 来源："经隧道 · 203.0.113.24"（经隧道的以 nginx 覆盖写的 X-Real-IP 为准）；是本机地址（前门转发）时"经前门转发，无法识别" */
  from: Type.String(),
  /** 待批的请求什么时候过期 */
  expiresAt: Type.String(),
});
export type PairingCardPayload = Static<typeof PairingCardPayload>;

/** 一台已配对设备（设置里的"已配对设备"）。凭证本身只在设备的 HttpOnly cookie 里，这里没有 */
export const PairedDevice = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** 配对请求从哪里来的（和配对请求卡上的一样） */
  from: Type.String(),
  pairedAt: Type.String(),
  /**
   * 第一次带着凭证来过了没有。领到凭证（paired）时是 false，界面上显示"等待首次使用"：
   * 领取的响应丢了，凭证就到不了设备手里，这样的记录在 DEVICE_FIRST_USE_WINDOW_MS 之后自动作废（expiresAt 到期）
   */
  activated: Type.Boolean(),
  /** 最近一次使用（续期）；记录有节流，最多差一小时。还没启用时是领到凭证的时间 */
  lastUsedAt: Type.String(),
  /** 凭证什么时候失效：启用之后是最近一次使用之后 365 天；还没启用时是领到凭证之后 24 小时 */
  expiresAt: Type.String(),
  revoked: Type.Boolean(),
  revokedAt: Type.Optional(Type.String()),
});
export type PairedDevice = Static<typeof PairedDevice>;

/** `device` 事件：一台已配对设备的最新状态，以及这次是什么变化 */
export const DeviceEventPayload = Type.Object({ device: PairedDevice, change: Type.Enum(DEVICE_CHANGES) });
export type DeviceEventPayload = Static<typeof DeviceEventPayload>;

/** 吊销一台已配对设备 */
export const RevokeDeviceParams = Type.Object({ deviceId: Type.String({ minLength: 1 }) });
export type RevokeDeviceParams = Static<typeof RevokeDeviceParams>;

export const RevokeDeviceResult = Type.Object({ deviceId: Type.String() });
export type RevokeDeviceResult = Static<typeof RevokeDeviceResult>;

/// ───────────────────────── 快速动作与记忆命令（21 号票） ─────────────────────────

/**
 * 规范化后的快速动作：动作类型（执行器注册表里登记的）和参数。参数的形状由各动作类型的执行器定（它自带参数的 schema），
 * 卡片和操作记录里原样存着，用户确认时按它执行。
 */
export const QuickActionSpec = Type.Object({ type: Type.String(), params: Type.Unknown() });
export type QuickActionSpec = Static<typeof QuickActionSpec>;

/**
 * 快速动作卡的负载（卡片类型注册表里 quick_action 的 schema）。
 * 用户这一轮明确点了对象和内容的（explicit，由运行时判定）：卡片出来就是"已执行"，只展示规范化后的动作；
 * 秘书推断出来的：按动作类型登记的关注类别和对话处置判，"先问我"时卡片待确认（执行 / 取消），同时进待我处理。
 */
export const QuickActionCardPayload = Type.Object({
  actionId: Type.String(),
  /** 动作是在哪个会话里提出的（执行后的操作记录追加在这里）、秘书当时在处理哪条用户消息 */
  conversation: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
  action: QuickActionSpec,
  /** 动作的名字（执行器的中文名："记住"） */
  name: Type.String(),
  /** 规范化后的动作，一句话（"记住：下周三上午体检"） */
  title: Type.String(),
  /** 对谁做（展示用；没有对象的动作不给） */
  target: Type.Optional(Type.String()),
  /** 做什么、内容（展示用） */
  content: Type.Optional(Type.String()),
  /** 用户这一轮明确点了对象和内容（运行时判定，不由秘书自报） */
  explicit: Type.Boolean(),
  /** 推断出来时命中的关注类别（中文名，含用户的自定义类别）；判定的处置 */
  categories: Type.Array(Type.String()),
  disposition: Disposition,
  /** 执行结果的说明（执行后才有） */
  result: Type.Optional(Type.String()),
  /** 提出这个动作的那次工具调用（守护进程用：彻底删除"记住"的内容时，连同聊天里这次调用的记录、会话文件里的参数和结果一起改写） */
  toolCallId: Type.Optional(Type.String()),
});
export type QuickActionCardPayload = Static<typeof QuickActionCardPayload>;

/** `quick_action_executed` 事件：一次快速动作的执行（操作记录），在动作提出的会话频道上 */
export const QuickActionExecutedEventPayload = Type.Object({
  actionId: Type.String(),
  /** 规范化后的动作（类型和参数） */
  action: QuickActionSpec,
  /** 动作的名字（执行器的中文名） */
  name: Type.String(),
  /** 规范化后的动作，一句话 */
  title: Type.String(),
  explicit: Type.Boolean(),
  /**
   * 凭什么执行的：用户点明的、在已有授权内、用户确认后（QUICK_ACTION_BASES；时间线按它取样式，25 号票）。
   * 25 号票之前的操作记录没有这一项：点明的看 explicit，其余的不知道
   */
  basis: Type.Optional(Type.Enum(QUICK_ACTION_BASES)),
  /** 对应的卡片（快速动作卡或记忆删除卡） */
  cardId: Type.String(),
  result: Type.Object({ ok: Type.Boolean(), summary: Type.String() }),
});
export type QuickActionExecutedEventPayload = Static<typeof QuickActionExecutedEventPayload>;

export const MemoryDeleteMode = Type.Enum(MEMORY_DELETE_MODES);
export type MemoryDeleteMode = Static<typeof MemoryDeleteMode>;

/** 素材的范围（设置里按会话或按时间段删除）：时间段两头都算，按素材的时间（原始记录的时间） */
export const MaterialScope = Type.Union([
  Type.Object({ kind: Type.Literal("conversation"), conversation: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("time_range"), from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }) }),
]);
export type MaterialScope = Static<typeof MaterialScope>;

/** 记忆删除卡上列出的一条匹配到的素材 */
export const MemoryDeleteMatch = Type.Object({
  materialId: Type.String(),
  /** 素材的种类（中文名："用户发言"） */
  kind: Type.String(),
  time: Type.String(),
  /** 来源会话（不来自会话的没有） */
  conversation: Type.Optional(Type.String()),
  /** 开头一段（本人的话、附件的文件名）；彻底删除之后换成空串 */
  excerpt: Type.String(),
  /** 已经彻底删除（卡片上的摘录随之去掉） */
  purged: Type.Optional(Type.Boolean()),
});
export type MemoryDeleteMatch = Static<typeof MemoryDeleteMatch>;

/**
 * 记忆删除卡的负载（卡片类型注册表里 memory_delete 的 schema）：秘书检索出的匹配素材和要执行的删除方式，
 * 用户核对后（可以去掉几条、换一种删法）确认才执行（动作 delete，输入 MemoryDeleteInput）。
 */
export const MemoryDeleteCardPayload = Type.Object({
  actionId: Type.String(),
  /** 在哪个会话里提出的、秘书当时在处理哪条用户消息 */
  conversation: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
  /** 秘书提出的删法 */
  mode: MemoryDeleteMode,
  matches: Type.Array(MemoryDeleteMatch, { maxItems: MAX_MEMORY_DELETE_MATERIALS }),
  /** 执行结果：用的删法、删了（标记了）几条 */
  result: Type.Optional(Type.Object({ mode: MemoryDeleteMode, count: Type.Integer({ minimum: 0 }) })),
});
export type MemoryDeleteCardPayload = Static<typeof MemoryDeleteCardPayload>;

/** 记忆删除卡上"删除"的输入：用哪种删法、删卡上列出的哪几条 */
export const MemoryDeleteInput = Type.Object({
  mode: MemoryDeleteMode,
  materialIds: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_MEMORY_DELETE_MATERIALS }),
});
export type MemoryDeleteInput = Static<typeof MemoryDeleteInput>;

/** 对话里的记忆命令从哪里来：哪个会话、哪个快速动作、哪张卡、秘书当时在处理哪条用户消息 */
const ChatCommandOrigin = Type.Object({
  kind: Type.Literal("chat"),
  conversation: Type.String(),
  actionId: Type.String(),
  cardId: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
});

/** "记住"：要记住的内容和它从哪里来（素材的来源标记跟着它，见 REMEMBER_SOURCES） */
export const RememberCommandPayload = Type.Object({
  commandId: Type.String(),
  command: Type.Literal("remember"),
  content: Type.String(),
  source: Type.Enum(REMEMBER_SOURCES),
  from: ChatCommandOrigin,
});
export type RememberCommandPayload = Static<typeof RememberCommandPayload>;

/**
 * 忘掉、彻底删除、别推断：哪些素材；从对话里的记忆删除卡，或者设置里按会话、按时间段批量删除；
 * 66 号票起还有删除项目时随项目彻底删除的（这个项目的内部任务由系统记下的素材，用户本人的话不在里面）
 */
export const DeleteCommandPayload = Type.Object({
  commandId: Type.String(),
  command: MemoryDeleteMode,
  materialIds: Type.Array(Type.String()),
  from: Type.Union([
    ChatCommandOrigin,
    Type.Object({ kind: Type.Literal("settings"), scope: MaterialScope }),
    Type.Object({ kind: Type.Literal("project_deletion"), projectId: Type.String() }),
  ]),
});
export type DeleteCommandPayload = Static<typeof DeleteCommandPayload>;

/**
 * `memory_command` 事件（守护进程内部的素材频道上）：一条显式记忆命令，按命令种类分两种形状。素材模块据此产生"显式记忆命令"素材，
 * 并删除（忘掉、彻底删除）或标记（别推断）列出的素材；删掉 memory.db 重建时同样照做，所以删掉的素材不会回来。
 */
export const MemoryCommandEventPayload = Type.Union([RememberCommandPayload, DeleteCommandPayload]);
export type MemoryCommandEventPayload = Static<typeof MemoryCommandEventPayload>;

/**
 * `messages_purged` 事件：会话里这些消息被彻底删除了，前端把手里的原话换掉：
 * - 用户的消息：原来的事件已改写成"已删除"标记，前端只留"已删除"；
 * - 带原话的工具调用记录：字段级改写过（参数摘要、结果摘要换成删除标记，别的不变），`replacement` 是改写后的消息，前端换成它。
 * 秘书据此改写会话文件（被删的输入、这些工具调用的参数和结果、检索结果里提到被删素材的行）；被删消息引用过的附件，
 * 没有别的消息引用就删掉媒体文件。
 */
export const MessagesPurgedEventPayload = Type.Object({
  messages: Type.Array(Type.Object({ seq: Type.Integer({ minimum: 1 }), messageId: Type.String(), replacement: Type.Optional(MessageEnvelope) })),
  /** 同时被彻底删除的素材 */
  materialIds: Type.Array(Type.String()),
  /** 被改写的工具调用（提议"记住"的那几次）：会话文件里它们的参数和结果也要改写 */
  toolCallIds: Type.Array(Type.String()),
  /** 被删的消息引用过的附件（媒体 id） */
  mediaIds: Type.Array(Type.String()),
  deletedAt: Type.String(),
});
export type MessagesPurgedEventPayload = Static<typeof MessagesPurgedEventPayload>;
