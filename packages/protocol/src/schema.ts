// 前端协议的 schema（规格第 5 节），用 TypeBox 定义。守护进程和 Web 都用这里生成的类型；
// 守护进程还拿它校验收到的请求（见 request.ts）。
import { type Static, Type } from "typebox";
import {
  CARD_ACTIONS,
  CARD_STATUSES,
  CHANNELS,
  DEVICE_BATCH_ACTIONS,
  DEVICE_BATCH_SKIPS,
  DEVICE_CHANGES,
  DISPOSITIONS,
  ERROR_CODES,
  INBOX_ACTION_MAX,
  INBOX_ACTIONS,
  MAINTAINER_CHANNEL_PREFIX,
  MAX_MEMORY_DELETE_MATERIALS,
  MEMORY_DELETE_MODES,
  MEMORY_RECALL_HITS_MAX,
  MEMORY_BRIEF_REASONS,
  MEMORY_BRIEF_ROUTES,
  MEMORY_RECALL_SOURCES,
  QUICK_ACTION_BASES,
  REMEMBER_SOURCES,
  REMINDER_ACTION_MAX,
  REMINDER_ACTIONS,
  REMINDER_CHANGES,
  REMINDER_STATUSES,
  SPEAKERS,
  TOOL_CALL_BLOCKS,
  TOOL_CALL_OUTCOMES,
  TOOL_CALL_MARKS,
  TOOL_NATURES,
  TURN_OUTCOMES,
  URGENCIES,
} from "./constants.ts";
import { DEVICE_BATCH_MAX, DEVICE_EXTEND_MAX_DAYS, PAIRING_FINGERPRINT_HEX_DIGITS, PAIRING_SHORT_CODE_DIGITS } from "./pairing.ts";
import { EventTrigger } from "./event-source-schema.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { PageCommandMark } from "./page-commands.ts";
import { BrowsingContext, BrowsingMark } from "./browsing.ts";
import { SentFrom } from "./user-words.ts";
import { VOICE_CAPTURE_TEXT_MAX, VOICE_DURATION_SLACK_MS, VOICE_MAX_MS, VOICE_MIC_LOG_MAX, VOICE_WAVEFORM_MAX, VOICE_WAVEFORM_MAX_BARS } from "./voice.ts";

// ───────────────────────── 频道 ─────────────────────────

/** 会话 id（也是会话频道名）：秘书会话，或某个维护者的会话 */
export const ConversationId = Type.Union([Type.Literal(CHANNELS.secretary), Type.TemplateLiteral(`${MAINTAINER_CHANNEL_PREFIX}\${string}`)]);
export type ConversationId = Static<typeof ConversationId>;

/** 全部频道：两类会话频道，加上任务看板、项目列表、待我处理、卡片、活动状态、已配对设备、工作日历、关注类别设置、个人助理、已读位置、语言、插件 */
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
  Type.Literal(CHANNELS.readMarks),
  Type.Literal(CHANNELS.language),
  Type.Literal(CHANNELS.plugins),
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
 * 原因见 docs/developer-guide.md"麦克风让路"一节；以后多出来的事件、原因照收（字符串）
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

/**
 * 一次调用记忆找到、读到的一条素材（187 号票）：只有编号和几样说明，没有原话——网页按素材 id 现取原文（GET /api/materials/<素材 id>），
 * 素材被忘掉、彻底删除之后就取不到了（显示"这条记忆已删除"）
 */
export const MemoryRecallHit = Type.Object({
  materialId: Type.String(),
  /** 素材的种类（守护进程 materials/types.ts 的 MATERIAL_KINDS：user_utterance、approval_decision……），不是中文名 */
  kind: Type.String(),
  /** 素材的时间（带时区的 ISO：那句话、那个决定是什么时候的） */
  time: Type.String(),
  /** 来源会话（秘书主线、某个维护者的会话）；不来自会话的没有 */
  conversation: Type.Optional(Type.String()),
  /** 怎么找出来的：关键词命中（检索素材才有；读全文的没有） */
  keyword: Type.Optional(Type.Literal(true)),
  /** 怎么找出来的：语义相近，余弦相似度（检索素材才有） */
  semantic: Type.Optional(Type.Number()),
});
export type MemoryRecallHit = Static<typeof MemoryRecallHit>;

/**
 * 一次调用记忆（187 号票）：从哪来、为什么查、查了什么、找到读到的素材。给模型的文字照旧，这一份是给网页画"回忆了 N 条记忆 ›"
 * 和"这次用到的记忆"的结构化部分。现在挂在检索素材、读素材的工具调用 part 上（ToolCallPart.recall）；以后的记忆简报、推理图谱
 * 不是工具调用，另起一种 part 带同样的这一份
 */
export const MemoryRecall = Type.Object({
  source: Type.Enum(MEMORY_RECALL_SOURCES),
  /** 为什么查（search_materials 的 why：为了回答什么去查记忆）；读全文的、187 号票之前的记录没有 */
  why: Type.Optional(Type.String()),
  /** 查了什么（search_materials 的 query）；读全文的没有 */
  query: Type.Optional(Type.String()),
  /** 找到的（检索）、读到的（读全文，一条）素材，按结果里的先后；查了没找到是空的 */
  hits: Type.Array(MemoryRecallHit, { maxItems: MEMORY_RECALL_HITS_MAX }),
});
export type MemoryRecall = Static<typeof MemoryRecall>;

export const ToolCallPart = Type.Object({
  type: Type.Literal("tool_call"),
  callId: Type.String(),
  /** 工具名（模型调用的工具；通用 bash 是 bash） */
  tool: Type.String(),
  /** 参数摘要（一行） */
  argsSummary: Type.String(),
  /** 命中的关注类别显示用的名字（比如"越出项目目录"；用户自定义的类别是它的名字），不是类别 id */
  categoryTitles: Type.Array(Type.String()),
  /**
   * 命中的关注类别的 id（和 categoryTitles 一一对应；内置的是 delete_or_overwrite 这类，自定义的是它的 id）。173 号票起：名字按记下时的
   * 语言写，认类别要看 id。没命中的、173 号票之前的记录没有
   */
  categories: Type.Optional(Type.Array(Type.String())),
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
   * 这次调用要动的是对外的事（out，"外"）还是本机的敏感权限（perm，"权"）（93 号票，见 constants.ts 的 TOOL_CALL_MARKS）：
   * 命中了关注类别的才有（被拦下的也照"要做的事"记，界面只标放行执行完的）。93 号票之前的记录没有，界面不标
   */
  mark: Type.Optional(Type.Enum(TOOL_CALL_MARKS)),
  /**
   * 这次调用读了密钥文件（.env 这类，放行执行了的；结果摘要不记文件内容，67 号票）：界面在说人话的那一句前面加 🔒
   * （读了敏感数据的标法）。只在是的时候带；67 号票之前的记录没有
   */
  readsSecretFile: Type.Optional(Type.Boolean()),
  /**
   * 超出授权、先不管（101 号票）：对话审批关着时，任务的 agent（秘书以外的 agent）这次调用本来要先问用户——"先问我"类别、
   * "计划里列了才做"没被授权项覆盖的（超出授权、没预料到的类别）、判断不了的——按直接做执行了。界面在"守卫怎么判的"后面写明。
   * 只在是的时候带；101 号票之前的记录没有
   */
  beyondGrant: Type.Optional(Type.Literal(true)),
  /**
   * 流程执行时这次调用和授权的计划比对的结果（60 号票：每次调用记下对上的步骤、是否计划外、判定、修回）：
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
  /**
   * 调用记忆的结构化部分（187 号票）：检索素材、读素材执行了的才有——为什么查、查了什么、找到读到的素材（编号、种类、时间、来源会话、
   * 怎么找出来的）。网页据此把这两个工具单独画成"回忆了 N 条记忆 ›"，不算进"调用了 N 个工具"。187 号票之前的记录没有
   * （网页从参数摘要、结果里认）；彻底删除时 why、query 换成删除标记
   */
  recall: Type.Optional(MemoryRecall),
  /**
   * 子代理里的调用（288 号票：Claude Code 的 Agent 工具派出去的子代理自己调的工具，也过守卫、也留记录）：调用这个子代理的那次调用的 callId。
   * 主线的调用、pi 的调用没有；界面暂时照普通调用画
   */
  parentCallId: Type.Optional(Type.String()),
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

/**
 * 清空当前对话的分隔线（114 号票）：用户在会话的 ⚙ 里点了"清空当前对话"，agent 从这里起新开一段会话、不再带着之前的聊天
 * （旧消息不删，界面上收在分隔线上面"更早的对话"里，往上翻照样能看）。时间就是这条消息的时间。项目维护者的"清空"是重置维护者，
 * 照旧用工单分隔线（work_order_divider）
 */
export const ConversationClearedPart = Type.Object({ type: Type.Literal("conversation_cleared") });
export type ConversationClearedPart = Static<typeof ConversationClearedPart>;

/**
 * 分支摘要（150 号票，会话回退）：用户在缩小视图里点 ↶ 回到某条之前，会话树上长出一条新分支，开头这一条写着给被放弃的
 * 那段写的摘要（做到了哪一步、对外产生了哪些效果、风险点）。对话层显示 🧭 加摘要，缩放层标题"分支摘要"；它本身也是回退点
 * （撤回到这条分支开始前）。branchId 是这条新分支（session-branches.ts）。系统消息，不进 agent 的输入队列（摘要已经在模型的上下文里）
 */
/**
 * 撤回时运行时把它改过的文件恢复了没有（293 号票，能力清单 rewind_files：Claude Code 的文件检查点，只追它自己的 Write、Edit 改的文件）：
 * 恢复了哪些文件（运行时报的路径，没有要恢复的是空的）；撤回点是一次工具调用前后（阶段、步骤开始前）时不恢复（skipped：检查点只按整条输入记）；
 * 恢复出错时 error 是原因（对话照样撤回了）。运行时撤回不动文件的（pi）没有这一项
 */
export const BranchFilesRewind = Type.Object({
  restored: Type.Array(Type.String()),
  skipped: Type.Optional(Type.Literal("call_point")),
  error: Type.Optional(Type.String()),
});
export type BranchFilesRewind = Static<typeof BranchFilesRewind>;

export const BranchSummaryPart = Type.Object({
  type: Type.Literal("branch_summary"),
  branchId: Type.String(),
  summary: Type.String(),
  /** 运行时把文件恢复到撤回点没有（293 号票，见 BranchFilesRewind）；撤回不动文件的运行时没有 */
  files: Type.Optional(BranchFilesRewind),
  /**
   * 撤回之后交给 agent 接着做的那句（152 号票：长程任务回退之后运行时替维护者重新开始一个阶段的交代，撤回后让维护者
   * 接着做的提醒）：这条分支摘要已经说清楚了，界面上不重复显示那条通知。没有接着做的没有
   */
  notice: Type.Optional(Type.String()),
});
export type BranchSummaryPart = Static<typeof BranchSummaryPart>;

/** 记忆简报里的一条（266 号票）：为什么带、说到的结论（编号，网页按编号现取说法）、经哪几条路过的相关门槛 */
export const MemoryBriefItem = Type.Object({
  /** 记带过没有用的键：claim:<结论编号>、group:<组>、strategy:<策略编号> */
  key: Type.String(),
  kind: Type.Union([Type.Literal("claim"), Type.Literal("hard"), Type.Literal("group"), Type.Literal("strategy")]),
  reason: Type.Enum(MEMORY_BRIEF_REASONS),
  /** 说到的结论：结论、禁忌是它自己；组是还没排除的几种解释；策略没有 */
  claimIds: Type.Array(Type.String()),
  /** 过相关门槛经的路；禁忌、策略没有 */
  routes: Type.Array(Type.Enum(MEMORY_BRIEF_ROUTES)),
});
export type MemoryBriefItem = Static<typeof MemoryBriefItem>;

/**
 * 记忆简报（266 号票）：用户这句话有相关的记忆时，守护进程自动追加在秘书这一轮输入尾部的那块简报的结构化部分，挂在秘书这一轮的
 * （第一条）回话上——网页把它和调用记忆的工具一起算进"回忆了 N 条记忆 ›"，点开能看到为什么带它。给模型的正文不在这里（在会话文件里）；
 * 这里只有编号、哈希和数：命中的素材（素材 id）、为什么带的那几条（结论编号）、带过的指纹（同一段对话里没变的不再带，重启后从这里认）、
 * 估的 token 数和字数。没有原话、没有用户这句话的文字（彻底删除不用改写它）
 */
export const MemoryBriefPart = Type.Object({
  type: Type.Literal("memory_brief"),
  /** source 是 brief；命中是简报里引用的证据背后的素材；没有 why、query */
  recall: MemoryRecall,
  items: Type.Array(MemoryBriefItem),
  /** 带过的：键 → 指纹（结论的状态、把握、谁说的、说法的哈希） */
  brought: Type.Record(Type.String(), Type.String()),
  /** 估的 token 数（DeepSeek 的经验值：一个汉字约 0.6 个 token） */
  tokens: Type.Integer({ minimum: 0 }),
  /** 交给秘书的那块有多少字 */
  chars: Type.Integer({ minimum: 0 }),
});
export type MemoryBriefPart = Static<typeof MemoryBriefPart>;

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
  ConversationClearedPart,
  BranchSummaryPart,
  MemoryBriefPart,
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
  /**
   * 谁转达的（103 号票）：秘书按用户的话往任务、项目维护者的会话里转达的那一句。发言方照旧是用户（对方照用户在这里直接说话处理：
   * 在干活时是插话、闲着时唤起、做完了的普通任务接着做），只是标上是秘书转达的——交给 agent 时开头写明，界面上标出来，
   * 不算用户"本人"的原话素材（原话在秘书会话里采过）。用户自己发的消息没有这一项
   */
  relayedBy: Type.Optional(Type.Literal("secretary")),
  /**
   * 秘书转达的那一句是用户在秘书那里哪句话（125 号票）：秘书处理那条用户消息时提出的转达，记下那条消息的 id。
   * 维护者引用转达进它会话的这一句，守护进程按它换成用户的原话核实（转达者只供审计）；之前转达的、秘书不是在回用户的话时转达的没有
   */
  relayOf: Type.Optional(Type.String()),
  /**
   * 一句话总结（115 号票）：别的 agent 或运行时写给 agent 的来信（agent-letters.ts：任务做完、维护者来信、秘书转达……）在会话里
   * 折成一行时显示的那句——任务做完的由运行时拼（"t-5「AI 日报」第 2 次运行做完了，交了 1 个文件"），维护者来信是 tell_secretary
   * 的总结参数，秘书转达是转达的话的第一句。只给界面看，交给 agent 的照旧是全文；旧消息没有，界面取正文的第一句
   */
  summary: Type.Optional(Type.String()),
  /**
   * 网页上下的指令（134–148 号票）：用户在"浏览"里某个网页的框上打字或说话让二狗填，一次性的页面助手处理完记进秘书会话的那一句（用户消息）。
   * 记着在哪个网页、哪个框上说的、是不是说的；已经处理过了，不进秘书的输入队列。149 号票起悬浮按钮发的是带 browsing（via: "button"）的
   * 普通消息，这个只留给以前的记录
   */
  pageCommand: Type.Optional(PageCommandMark),
  /**
   * 浏览侧边栏里发的（147 号票）：用户在"浏览"右边的二狗侧边栏里跟秘书说的这句，当时内置浏览器里开着哪个网页、选中了哪个框，
   * 哪个浏览器（秘书的网页工具据此找到发消息的那台设备）。交给秘书时写明；会话里这条下面标"在网页「X」上说"。秘书页签里发的没有。
   * 149 号票起悬浮按钮上发的也是它（via: "button"，带目标框、是不是说的），下面标"在网页「X」的「框」上打字 / 说"
   */
  browsing: Type.Optional(BrowsingMark),
  /**
   * agent 的这条回复说到一半被停下了（144 号票：用户点了停止，或者任务暂停、取消时中止了这一轮）：已经说出来的留着，界面上标"已停止"。
   * 说完了的、之前的消息没有
   */
  stopped: Type.Optional(Type.Literal(true)),
  /**
   * agent 从这里新开了一段会话（150 号票）：换模型新开会话的那条说明（83 号票）带上它，之前的聊天不在 agent 的上下文里，回退点只在这之后
   * （session-branches.ts 的 agentSessionStart；清空的分隔线、会话分段线按 part 认，150 号票之前的换模型说明按文字认）
   */
  sessionStart: Type.Optional(Type.Literal(true)),
  /**
   * agent 的这条回复后面跟着调用的工具（152 号票：模型同一条回复里的工具调用 id）：撤回到"开始阶段"那次调用之前时，这条回复连同
   * 它说的话一起回到废弃分支上（会话树上回到这条回复之前）。没调用工具的、之前的消息没有
   */
  calls: Type.Optional(Type.Array(Type.String())),
  /**
   * 第一版任务书交给维护者的那条系统说明（172 号票）：网页的对话层照常显示它（不收进阶段框），按这一项认，不认文字
   * （这句交给维护者，照旧中文；之后改过的任务书、之前的消息没有这一项，之前的那条网页按开头的"任务书："认）
   */
  taskBrief: Type.Optional(Type.Literal(true)),
  /**
   * 前情（290 号票）：从运行时已有的会话接管时，从运行时自己的会话记录里读出来的主线最近一段（用户说的、它回的、工具调用），
   * 导进维护者的会话给人看（缩放三档照常）。运行时那边本来就有这些，不交给 agent（不进输入队列），也不采成用户的原话素材
   * （那是用户跟运行时说的，原文在运行时自己的记录里）。更早的留在运行时自己的记录里。别的消息没有
   */
  prelude: Type.Optional(Type.Literal(true)),
  /**
   * 在官方 App 里发生的（292 号票，只读跟随）：会话交给官方 App（Remote Control）期间，用户在那边说的、运行时回的、调用的工具，二狗读运行时
   * 自己的会话记录补记进维护者的会话（不重复记）。和前情一样：运行时那边本来就有，不交给 agent、不采成用户的原话素材；界面上标"在官方 App 里"。
   * 别的消息没有
   */
  remote: Type.Optional(Type.Literal(true)),
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
  /**
   * 守护进程现在提供的网页是哪一版（116 号票，web-version.ts）：页面和自己的对不上就提示刷新。index.html 里没有版本号（这张票之前构建的）、
   * 还没构建时不带
   */
  webVersion: Type.Optional(Type.String()),
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
  /** 浏览侧边栏里、悬浮按钮上（149 号票）发的（只认秘书会话）：当时的网页、选中的框、哪个浏览器 */
  browsing: Type.Optional(BrowsingContext),
});
export type SendMessageParams = Static<typeof SendMessageParams>;

/**
 * 发消息的结果：落盘后的消息 id 和它在会话频道里的序号（同一幂等键重发拿到同一个结果）。
 * 二狗正在回复时发的排进了队（144 号票，queued）：序号是排进来的那条 message_queue 事件的，消息 id 是交出去时那条消息的
 */
export const SendMessageResult = Type.Object({ messageId: Type.String(), seq: Type.Integer(), queued: Type.Optional(Type.Literal(true)) });
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
  /**
   * 属于哪一次了解你访谈（284 号票）：访谈开着时用户在记忆管理员的会话里说的话带上它（语音对象跟着带），
   * 素材据此标上"来自访谈"。别的会话、访谈没开着时没有
   */
  interviewId: Type.Optional(Type.String()),
  /**
   * 这句话答的是管理员的哪一问（284 号票）：访谈开着时，用户说话那一刻管理员在这次访谈里最近的一段话（取末尾 200 字）。
   * 素材据此把问的那句放进上下文（标明是管理员问的，不算本人的话）。和 interviewId 一起有
   */
  interviewQuestion: Type.Optional(Type.String()),
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
  /**
   * 用户自己发的消息从哪来（125 号票）：本机端口，或者外网端口上的已配对设备。运行时核实用户原话时写"从哪台设备来的"；
   * 125 号票之前的、秘书转达的、agent 和系统的消息没有
   */
  sentFrom: Type.Optional(SentFrom),
  /**
   * 排队交出的那一批（144 号票）：二狗回复时用户又发的几句先排队，这一轮做完（或者用户点了停止）一起交出去、追加成普通的用户消息，
   * 同一批的带同一个值，agent 把它们作为一轮的输入一起处理。不是从队里交出的没有
   */
  queueDelivery: Type.Optional(Type.String()),
  /**
   * 不交给 agent（180 号票只管串词，208 号票起识别失败的都是）：排队时就识别失败的语音消息（消息里只有这段语音），交出去时照常成为会话里的消息，
   * 但不进 agent 的输入队列（等同于没发；之后手动重新识别成功了再回到队里）。别的消息没有
   */
  dropInput: Type.Optional(Type.Literal(true)),
});
export type MessageEventPayload = Static<typeof MessageEventPayload>;

/**
 * 同一轮一起交给 agent 的另外几条输入（144 号票：排队交出的一批），按先后；inputMessageId 是这一批的第一条。只有一条时不带
 */
const MoreInputMessageIds = Type.Optional(Type.Array(Type.String(), { minItems: 1 }));

/** `turn_start` 事件：agent 开始处理会话里的一条用户消息（144 号票起可以是一起交出的一批） */
export const TurnStartEventPayload = Type.Object({ inputMessageId: Type.String(), moreInputMessageIds: MoreInputMessageIds });
export type TurnStartEventPayload = Static<typeof TurnStartEventPayload>;

/** `turn_end` 事件：agent 处理完会话里的一条用户消息（出队；144 号票起一起交出的一批同时出队） */
export const TurnEndEventPayload = Type.Object({
  /** 处理的是哪条用户消息 */
  inputMessageId: Type.String(),
  moreInputMessageIds: MoreInputMessageIds,
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

/**
 * 事项从哪来（105 号票）：待我处理里"去看看 ›"跳过去的地方，守护进程建事项时记下（任务的事项经 project-internal.ts 的 taskInboxOrigin 一起带上）。
 * 都是编号，彻底删除、删除项目改写事项时原样留着。旧事项没有；系统的事项（备份、节假日、语音、关注类别……）不记，
 * 前端按通知的种类认去处
 */
export const InboxOrigin = Type.Object({
  /** 任务（含定时 / 事件触发的任务、项目内部任务）：去这个任务的整页（负责它的 agent 的会话） */
  taskId: Type.Optional(Type.String()),
  /** 项目：去这个项目的整页（维护者的会话）。项目内部任务的事项有 taskId 时先去任务 */
  projectId: Type.Optional(Type.String()),
  /** 卡片或调用所在的会话（秘书会话、某个维护者的会话）：没有任务、项目时按它去 */
  conversation: Type.Optional(Type.String()),
  /** 那次工具调用：到了会话里定位到它（卡片事项按卡片定位，不用它） */
  toolCallId: Type.Optional(Type.String()),
  /** 任务的哪个阶段 */
  stageId: Type.Optional(Type.String()),
});
export type InboxOrigin = Static<typeof InboxOrigin>;

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
  /** 从哪来（105 号票）：待我处理里"去看看 ›"去的地方；旧事项、系统的事项没有 */
  origin: Type.Optional(InboxOrigin),
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
  itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: INBOX_ACTION_MAX }),
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

/**
 * 简单提醒（任务看板上"运营中 · 待触发"；已触发的一次性提醒、已取消的归"最近结束"，归档了的在"已归档"，删了的不上看板——
 * 分组只看协议包的 boardGroupOfReminder）
 */
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
  /** 归档了（185 号票）：只有已经结束的（一次性的已触发、已取消）能归档；任务没有取消归档，提醒也没有 */
  archived: Type.Optional(Type.Boolean()),
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
  /** 归档了（185 号票）：卡上写"已归档"，还能删 */
  archived: Type.Optional(Type.Boolean()),
});
export type ReminderCardPayload = Static<typeof ReminderCardPayload>;

// ───────────────────────── 停止和排队（144 号票） ─────────────────────────

/**
 * 排队中的一条消息：二狗正在回复时用户发的话（排进来时按发消息的规矩核对过附件、收下了语音）。交出去时照它追加一条用户消息——
 * 消息 id、时间、正文就是这里的（时间是用户说这句话的时候），归属按交出去那一刻重新认（项目维护者的会话分段可能已经换了）
 */
export const QueuedMessage = Type.Object({
  message: MessageEnvelope,
  /** 发送请求的幂等键：乐观显示的那条靠它换成排队的、交出去后再换成正式的消息（界面上同一个气泡） */
  idempotencyKey: Type.String(),
  /** 排进来时认的归属（交出去时认不出来就用它） */
  ...MessageScope.properties,
  /** 在哪个任务的详情里说的（75 号票，发消息时的 taskId）：交出去时据此认归属 */
  inTask: Type.Optional(Type.String()),
  sentFrom: Type.Optional(SentFrom),
});
export type QueuedMessage = Static<typeof QueuedMessage>;

/** 队列这次怎么变的：排进来、拿掉（用户叉掉）、改顺序（用户拖动）、交出去 */
export const QUEUE_CHANGES = ["queued", "removed", "reordered", "delivered"] as const;
export type QueueChange = (typeof QUEUE_CHANGES)[number];

/**
 * `message_queue` 事件（会话频道，落盘）：这个会话排队的消息的最新样子（整队，先交的在前）和这次的变化。
 * 交出去的那一条和追加的用户消息同一事务（消息在前）
 */
export const MessageQueueEventPayload = Type.Object({
  change: Type.Enum(QUEUE_CHANGES),
  /** 这次说到的消息：排进来、拿掉的那一条；改顺序是新的顺序；交出去的那几条按先后 */
  messageIds: Type.Array(Type.String()),
  queue: Type.Array(QueuedMessage),
  /** 用户请求的幂等键（排进来、拿掉、改顺序；交出去没有）：界面据此收掉自己先显示的那一步 */
  requestKey: Type.Optional(Type.String()),
});
export type MessageQueueEventPayload = Static<typeof MessageQueueEventPayload>;

/** 停下这个会话的 agent 正在回复的这一轮（stop_reply） */
export const StopReplyParams = Type.Object({ conversation: ConversationId });
export type StopReplyParams = Static<typeof StopReplyParams>;

/** 停没停：在回复才停（没在回复时点了是 false，什么都不做） */
export const StopReplyResult = Type.Object({ stopped: Type.Boolean() });
export type StopReplyResult = Static<typeof StopReplyResult>;

/** 聊天区里排队的消息（queued_message_action）：叉掉一条，或者按拖完的样子给出新的顺序 */
export const QueuedMessageActionParams = Type.Union([
  Type.Object({ conversation: ConversationId, action: Type.Literal("remove"), messageId: Type.String({ minLength: 1 }) }),
  Type.Object({ conversation: ConversationId, action: Type.Literal("reorder"), messageIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }) }),
]);
export type QueuedMessageActionParams = Static<typeof QueuedMessageActionParams>;

/** 变没变（已经交出去了的叉不掉、顺序一样的不算变），和变化之后的整队 */
export const QueuedMessageActionResult = Type.Object({ changed: Type.Boolean(), queue: Type.Array(QueuedMessage) });
export type QueuedMessageActionResult = Static<typeof QueuedMessageActionResult>;

// ───────────────────────── 已读位置（109 号票） ─────────────────────────

/**
 * `read_mark` 事件（已读位置频道上）：这个会话已读到哪个序号（会话频道上的序号，这之前的都算看过）。只往后挪；
 * 启动时还没有秘书会话的记录时补的那条位置是秘书会话那时的最后一条（升级上来的历史消息不算没看过）
 */
export const ReadMarkEventPayload = Type.Object({
  conversation: ConversationId,
  seq: Type.Integer({ minimum: 0 }),
  time: Type.String(),
});
export type ReadMarkEventPayload = Static<typeof ReadMarkEventPayload>;

/** 记下会话看到哪一条了（mark_read）：比记着的还靠前的不挪；比会话的最后一条还靠后的按最后一条记 */
export const MarkReadParams = Type.Object({
  conversation: ConversationId,
  seq: Type.Integer({ minimum: 0 }),
});
export type MarkReadParams = Static<typeof MarkReadParams>;

/** 记完之后这个会话已读到的序号 */
export const MarkReadResult = Type.Object({ conversation: ConversationId, seq: Type.Integer({ minimum: 0 }) });
export type MarkReadResult = Static<typeof MarkReadResult>;

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

/**
 * 对一条或几条简单提醒做同一件事（reminder_action，185 号票）：取消、归档、删除。看板卡的菜单、提醒卡上的按钮交一条，看板多选交几条
 */
export const ReminderActionParams = Type.Object({
  reminderIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: REMINDER_ACTION_MAX, uniqueItems: true }),
  action: Type.Enum(REMINDER_ACTIONS),
});
export type ReminderActionParams = Static<typeof ReminderActionParams>;

/** 一条提醒的结果：做成了是之后的状态和归没归档；没做成是错误码和原因（已经响过了不能取消、还没结束不能归档……） */
export const ReminderActionItemResult = Type.Union([
  Type.Object({ reminderId: Type.String(), ok: Type.Literal(true), status: ReminderStatus, archived: Type.Optional(Type.Boolean()) }),
  Type.Object({ reminderId: Type.String(), ok: Type.Literal(false), code: Type.Enum(ERROR_CODES), message: Type.String() }),
]);
export type ReminderActionItemResult = Static<typeof ReminderActionItemResult>;

/** 逐条的结果，按请求里的先后（同一幂等键重发：做成了的拿到同一个结果，没做成的再试一次） */
export const ReminderActionResult = Type.Object({ results: Type.Array(ReminderActionItemResult) });
export type ReminderActionResult = Static<typeof ReminderActionResult>;


// ───────────────────────── 设备配对与已配对设备 ─────────────────────────

/**
 * 配对请求看起来像网络上的自动访问（137 号票）：守护进程收到请求时按浏览器标识判断（协议包 pairing.ts 的 automatedAccess），
 * 原因给人看（"浏览器标识带「HeadlessChrome」，是无界面浏览器"）。只是提示，批准照样能批
 */
export const PairingAutomated = Type.Object({ reason: Type.String({ minLength: 1 }) });
export type PairingAutomated = Static<typeof PairingAutomated>;

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
  /** 看起来像网络上的自动访问（137 号票）：卡上和批准页上一句醒目的提示；像普通浏览器的没有这一项 */
  automated: Type.Optional(PairingAutomated),
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
  /**
   * 凭证什么时候失效：启用之后是最近一次使用之后 365 天；还没启用时是领到凭证之后 24 小时。
   * 123 号票起可以延期（往后推，过期、作废了的因此重新有效）；使用时的续期只往后推、不把延期缩回去
   */
  expiresAt: Type.String(),
  revoked: Type.Boolean(),
  revokedAt: Type.Optional(Type.String()),
  /** 最近一次延期（123 号票）；没延期过的没有 */
  extendedAt: Type.Optional(Type.String()),
  /** 删除于（123 号票）：删了的不在列表里、凭证一律不认（删之前先吊销）；事件日志里的记录留着 */
  deletedAt: Type.Optional(Type.String()),
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

/**
 * 一次对几台已配对设备做同一件事（device_batch_action，123 号票：设置里的多选，单台的"⋯"菜单也走它）：
 * 延期（days 天，延期时必填）、吊销、删除。能做的都做，不能做的跳过（DEVICE_BATCH_SKIPS），设备不能重复
 */
export const DeviceBatchActionParams = Type.Object({
  action: Type.Enum(DEVICE_BATCH_ACTIONS),
  deviceIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: DEVICE_BATCH_MAX, uniqueItems: true }),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: DEVICE_EXTEND_MAX_DAYS })),
});
export type DeviceBatchActionParams = Static<typeof DeviceBatchActionParams>;

/** 一台设备的结果：做了是做完之后的样子；跳过是原因和一句话 */
export const DeviceBatchItemResult = Type.Union([
  Type.Object({ deviceId: Type.String(), ok: Type.Literal(true), device: PairedDevice }),
  Type.Object({ deviceId: Type.String(), ok: Type.Literal(false), skip: Type.Enum(DEVICE_BATCH_SKIPS), message: Type.String() }),
]);
export type DeviceBatchItemResult = Static<typeof DeviceBatchItemResult>;

/** 逐台的结果，按请求里的先后（同一幂等键重发：做了的拿到同一个结果，不再做一遍） */
export const DeviceBatchActionResult = Type.Object({ results: Type.Array(DeviceBatchItemResult) });
export type DeviceBatchActionResult = Static<typeof DeviceBatchActionResult>;

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

/**
 * 素材的范围（设置里按会话或按时间段删除）：时间段两头都算，按素材的时间（原始记录的时间）。
 * 158 号票起还有"这一条"（material）：设置里点开一条素材看内容，在详情里删的就是它（彻底删除时不连带范围里没有素材的语音）
 */
export const MaterialScope = Type.Union([
  Type.Object({ kind: Type.Literal("conversation"), conversation: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("time_range"), from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("material"), materialId: Type.String({ minLength: 1 }) }),
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

/**
 * 337 号票："记住"从秘书那里来（用户说"帮我记一句"，秘书调工具记一条）——没有快速动作、没有卡片，所以 actionId / cardId 这两个
 * 字段不存在，不硬编一个假的。记下是哪个会话、哪条用户消息（有就记）、哪次工具调用（有就记，彻底删除时连同那次调用一起改写）。
 * 和 ChatCommandOrigin 并列成联合的一支：老的 chat 来源一个字段不动，老事件照旧解析
 */
const SecretaryCommandOrigin = Type.Object({
  kind: Type.Literal("secretary"),
  conversation: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
});

/** "记住"：要记住的内容和它从哪里来（素材的来源标记跟着它，见 REMEMBER_SOURCES） */
export const RememberCommandPayload = Type.Object({
  commandId: Type.String(),
  command: Type.Literal("remember"),
  content: Type.String(),
  source: Type.Enum(REMEMBER_SOURCES),
  from: Type.Union([ChatCommandOrigin, SecretaryCommandOrigin]),
});
export type RememberCommandPayload = Static<typeof RememberCommandPayload>;

/**
 * 忘掉、彻底删除、别推断：哪些素材；从对话里的记忆删除卡，或者设置里按会话、按时间段批量删除；
 * 66 号票起还有删除项目时随项目彻底删除的（这个项目的内部任务由系统记下的素材，用户本人的话不在里面），186 号票起还有删除任务时随任务删的
 */
export const DeleteCommandPayload = Type.Object({
  commandId: Type.String(),
  command: MemoryDeleteMode,
  materialIds: Type.Array(Type.String()),
  from: Type.Union([
    ChatCommandOrigin,
    Type.Object({ kind: Type.Literal("settings"), scope: MaterialScope }),
    // 242 号票：记忆管理员在它的会话里按用户的话下的命令（没有卡片、没有快速动作，记下是哪个会话）
    Type.Object({ kind: Type.Literal("curator"), conversation: Type.String() }),
    Type.Object({ kind: Type.Literal("project_deletion"), projectId: Type.String() }),
    // 186 号票：删除任务时随任务彻底删掉的系统记录（从改写了的任务事件、审批、卡片采到的结局、决定、反应……；用户本人的话不在里面）
    Type.Object({ kind: Type.Literal("task_deletion"), taskId: Type.String() }),
    // 281 号票：彻底删除个人档案里的东西时，用户选了连出处（那句原话的素材）一起彻底删除
    Type.Object({ kind: Type.Literal("personal_file"), personId: Type.String() }),
    // 295 号票：断开一个数据源时用户选了"连已导入的一起删"：由它导入的记录采成的素材随着彻底删除（不产生"显式记忆命令"素材）
    Type.Object({ kind: Type.Literal("data_source"), source: Type.String() }),
  ]),
});
export type DeleteCommandPayload = Static<typeof DeleteCommandPayload>;

/**
 * `memory_command` 事件（守护进程内部的素材频道上）：一条显式记忆命令，按命令种类分两种形状。素材模块据此产生"显式记忆命令"素材，
 * 并删除（忘掉、彻底删除）或标记（别推断）列出的素材；删掉 materials.db 重建时同样照做，所以删掉的素材不会回来。
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
