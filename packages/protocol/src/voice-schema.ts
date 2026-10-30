// 语音消息的 schema（规格第 22 节，31 号票）：一条语音 = 一个数据对象，音频和它的文字绑在一起。
// 消息里的语音 part（schema.ts 的 VoicePart）只引用它（voiceId）并带上画气泡要的时长和波形；
// 识别的结果和识别状态在 VoiceRecord 里，随会话频道上的 voice 事件更新。
// （用户 2026-10-08 改：第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果。）
import { type Static, Type } from "typebox";
import { ConversationId, MessageScope, VoiceCapture, VoiceDurationMs, VoiceWaveform } from "./schema.ts";
import { AGENT_VOICE_MODES, AGENT_VOICE_STATUSES, REFERENCE_VOICE_NAME_MAX, REFERENCE_VOICE_TEXT_MAX, VOICE_MODEL_STATUSES, VOICE_STATUSES } from "./voice.ts";

/** faster-whisper 给出的一段：起止时间（秒）和这段的原文 */
export const VoiceSegment = Type.Object({ start: Type.Number(), end: Type.Number(), text: Type.String() });
export type VoiceSegment = Static<typeof VoiceSegment>;

/** faster-whisper 直接识别的结果 */
export const VoiceRecognition = Type.Object({
  /** 识别出的文字 */
  text: Type.String(),
  /** 识别出的语言（比如 zh） */
  language: Type.String(),
  segments: Type.Array(VoiceSegment),
  /** 实际用的模型、设备、计算精度（显卡不可用或显存不够时退回 CPU，记的是退回后的） */
  model: Type.String(),
  device: Type.String(),
  computeType: Type.String(),
  /** 退回 CPU 的原因（没退回没有） */
  fallbackReason: Type.Optional(Type.String()),
  /** 识别进程量出的音频时长（秒） */
  audioSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  /** 从开始识别到出结果花了多久（毫秒；含拉起识别进程、加载模型） */
  elapsedMs: Type.Integer({ minimum: 0 }),
  time: Type.String(),
});
export type VoiceRecognition = Static<typeof VoiceRecognition>;

export const VoiceStatus = Type.Enum(VOICE_STATUSES);
export type VoiceStatus = Static<typeof VoiceStatus>;

/** 一条语音（用户发的）：音频、时长、格式、波形摘要、识别出的文字、识别状态 */
export const VoiceRecord = Type.Object({
  id: Type.String(),
  /** 发这条语音的消息 */
  messageId: Type.String(),
  conversation: ConversationId,
  /** 消息所属的任务、项目（维护者会话里的；素材的"任务或项目"取自这里） */
  taskId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  /** 消息属于哪一次了解你访谈（284 号票：访谈开着时在记忆管理员的会话里说的；语音转写的素材据此标上"来自访谈"） */
  interviewId: Type.Optional(Type.String()),
  /** 访谈里这句话答的是管理员的哪一问（消息归属的 interviewQuestion；素材把它放进上下文） */
  interviewQuestion: Type.Optional(Type.String()),
  /** 音频：入库的媒体（按内容哈希） */
  mediaId: Type.String(),
  /** 格式：服务端按内容认出的音频类型（audio/webm、audio/mp4……） */
  mime: Type.String(),
  durationMs: VoiceDurationMs,
  waveform: VoiceWaveform,
  status: VoiceStatus,
  /** 第几次识别（用户手动重新识别加 1；自动重试不算，见 autoRetry） */
  attempt: Type.Integer({ minimum: 1 }),
  /**
   * 第几次自动重试（208 号票）：识别没做成（识别进程出错、超时、退出、不可用）时隔一会儿自动再试，最多几次由配置定
   * （voice.recognizer.autoRetrySeconds，默认隔 15 秒、60 秒、3 分钟三次）。等着重试、正在重试时气泡上写"识别中（第 N 次重试）"；
   * 有了结局之后留着（重试了几次）。只有第一次识别会自动重试，手动重新识别时去掉
   */
  autoRetry: Type.Optional(Type.Integer({ minimum: 1 })),
  /** 等着自动重试时下一次重试的时刻（208 号票；状态是排队）。守护进程重启后到点接着试；开始识别时去掉 */
  retryAt: Type.Optional(Type.String()),
  recognition: Type.Optional(VoiceRecognition),
  /** 识别失败的原因（自动重试完了还不行的，是最后一次的原因） */
  error: Type.Optional(Type.String()),
  /**
   * 识别出来的只有模型自带的串词（180 号票："请不吝点赞 订阅 转发……"，识别时剔掉后什么都不剩）：状态是失败、不自动重试。
   * 208 号票起识别失败的都当作没说过——消息里只有这段语音的，不交给 agent（见 VoiceEventPayload.dropInput、MessageEventPayload.dropInput）。
   * 重新识别时去掉
   */
  onlyFiller: Type.Optional(Type.Literal(true)),
  /**
   * 录音的诊断（37 号票）：前端随语音带来的"按下 → 录音器真正开始"的毫秒数（整数）和是不是预热命中；
   * 前端没带（旧版本）、带的不合理时没有。本机的历史分页接口（GET /api/conversations/<会话>/messages 的 voices）取得到
   */
  capture: Type.Optional(VoiceCapture),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
});
export type VoiceRecord = Static<typeof VoiceRecord>;

/** `voice` 事件（会话频道上）：一条语音的最新状态（建出、开始识别、等着自动重试、识别完成或失败、重新识别） */
export const VoiceEventPayload = Type.Object({
  voice: VoiceRecord,
  /**
   * 这条语音的消息不交给 agent 了（180 号票：识别出来的只有串词；208 号票起识别失败的都是——自动重试完了还不行、静音之类重试也没用的；
   * 消息里也只有这段语音）：还在 agent 的输入队列里等着的直接出队（记成没交），不唤起 agent、不回话（等同于没发）
   */
  dropInput: Type.Optional(Type.Literal(true)),
  /**
   * 这条语音的消息回到 agent 的输入队列（208 号票）：识别失败时出了队、没交给 agent 的，用户手动重新识别成功了，
   * 作为一条正常的用户输入交过去（第一次交；交过"识别失败"的另交一条通知，不带它）
   */
  restoreInput: Type.Optional(Type.Literal(true)),
});
export type VoiceEventPayload = Static<typeof VoiceEventPayload>;

/** 气泡菜单里的"重新识别"：只有识别失败的能重新识别（一次试一次，不自动重试；208 号票起试之前同样先看识别服务正不正常） */
export const RetryVoiceParams = Type.Object({ voiceId: Type.String({ minLength: 1 }) });
export type RetryVoiceParams = Static<typeof RetryVoiceParams>;

/** 重新识别的结果：这条语音的新版本（随后在会话频道推送） */
export const RetryVoiceResult = Type.Object({ voiceId: Type.String(), version: Type.Integer({ minimum: 1 }) });
export type RetryVoiceResult = Static<typeof RetryVoiceResult>;

// ───────────────────────── agent 发的语音（32 号票） ─────────────────────────

export const AgentVoiceStatus = Type.Enum(AGENT_VOICE_STATUSES);
export type AgentVoiceStatus = Static<typeof AgentVoiceStatus>;

export const AgentVoiceMode = Type.Enum(AGENT_VOICE_MODES);
export type AgentVoiceMode = Static<typeof AgentVoiceMode>;

/**
 * 分段合成里合成好的一段（38 号票）：第几段就是它在 AgentVoiceRecord.segments 里的位置（0 起），
 * 音频从 HTTP_PATHS.agentVoiceSegment(语音 id, 第几段) 取（临时的：合成完了过一阵就删，重播、下载用完整音频）
 */
export const AgentVoiceSegment = Type.Object({
  /** 这一段的时长（毫秒） */
  durationMs: Type.Integer({ minimum: 0 }),
  /** 在整条里从第几毫秒起（前面各段的时长加上段间的停顿）：前端按它把各段首尾相接地排好 */
  offsetMs: Type.Integer({ minimum: 0 }),
});
export type AgentVoiceSegment = Static<typeof AgentVoiceSegment>;

/**
 * agent 发的一条语音（语音回复）：用户发语音时，agent 这一轮的回复由运行时合成语音。
 * 绑定音频（入库的媒体，按内容哈希）、时长、送进 TTS 的原文、所用参考音色、TTS 模型，以及对应的完整回复在哪几条消息里。
 * 86 号票起也可以是 agent 在用户打字的那一轮用"发语音"工具发的（mode 是 tool）：调用时建出，字段同一套
 */
export const AgentVoiceRecord = Type.Object({
  id: Type.String(),
  conversation: ConversationId,
  /** 这条语音所在的消息（和 agent 的回复一样）带上的归属：任务、项目、阶段…… */
  scope: MessageScope,
  /**
   * 这一轮回复的是用户的哪条语音（或者重新识别后交给 agent 的那条通知）；工具发的是触发它的那条用户消息
   * （这一轮交给 agent 的那条，用户的话是插话时是插话里最后一句）
   */
  inputMessageId: Type.String(),
  /**
   * 这一轮开始（turn_start 事件）在会话频道上的序号：回复还没定（replying）时，这之后 agent 发的消息都算这一轮的回复
   * （前端据此不显示它们的文字）；回合结束时 agent 用语音回复的那一轮才有（插话里有语音的、回合结束时才知道的没有）。
   * 工具发的（86 号票）调用时就有：这一轮还没结束（coversReply 还没定）时，前端同样不显示这之后 agent 发的消息的文字
   */
  turnSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * 对应的完整回复：agent 这一轮发出的文字、图片、文件、卡片所在的消息，按先后（回合结束时定；agent 只写了口语总结时可以为空）。
   * 工具发的（86 号票）回合结束时定，记在这一轮最后一条工具发的语音上（同一轮发了几条时，前面的是空的）
   */
  replyMessageIds: Type.Array(Type.String()),
  /** 送进 TTS 的是整段回复、口语总结，还是 agent 用"发语音"工具给的口语稿（86 号票的 tool；前两种回合结束时定，tool 调用时就定） */
  mode: Type.Optional(AgentVoiceMode),
  /**
   * 工具发的语音（86 号票，mode 是 tool）：这一轮 agent 另写的文字收进气泡（true，长按"转文字"时接在原文后面）还是照常显示（false）。
   * 照语音轮的规矩，回合结束时定：这一轮回复的文字去掉 Markdown 标记后念得完、又没有代码表格链接这类念不出来的才收进去；
   * 没回复完的、没有别的文字的、那时已经没合成出来的是 false（之后才没合成出来的，agentVoiceCoversReply 按状态不收）。
   * 回合还没结束的没有（守护进程重启时那一轮已经被打断，定成 false）；整段合成、口语总结的语音没有
   */
  coversReply: Type.Optional(Type.Boolean()),
  /** 工具发的语音（86 号票）：发它的那次工具调用的 id（守护进程重启后给 agent 的会话补那次调用的结果用）；别的没有 */
  toolCallId: Type.Optional(Type.String()),
  /**
   * 口语总结是谁写的：agent 用工具写的（这一轮里写的，或者运行时追问后补写的），或者追问了还没写、运行时从回复开头截的
   * （只有 summary 有，口语稿定了才有）
   */
  summaryBy: Type.Optional(Type.Enum(["agent", "runtime"])),
  /** 送进 TTS 的原文（"转文字"展开的就是它；口语稿定了才有；工具发的是 agent 给的口语稿去掉 Markdown 标记的样子） */
  text: Type.Optional(Type.String()),
  /** 所用的参考音色：id 和当时的显示名（回合结束时定；工具发的调用时定） */
  referenceVoice: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
  /** TTS 模型：合成服务报出来的实际模型（比如 fish_audio（audio.cpp/tts）），报不出来时是配置里写的模型名（合成时定） */
  model: Type.Optional(Type.String()),
  status: AgentVoiceStatus,
  /**
   * 分段合成（38 号票）：口语稿切成了几段（第一段合成好时定）。只有一段的不推段，合成好直接是完成
   */
  segmentCount: Type.Optional(Type.Integer({ minimum: 1 })),
  /** 已经合成好、推给前端的段，按先后（不止一段时才有；完成时是全部，合成到一半失败时是失败前的那几段） */
  segments: Type.Optional(Type.Array(AgentVoiceSegment)),
  /** 合成出的音频：入库的媒体（按内容哈希）、格式、时长、波形摘要（合成完成才有；分段的是拼好的完整音频） */
  mediaId: Type.Optional(Type.String()),
  mime: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  waveform: Type.Optional(VoiceWaveform),
  /** 载着这条语音的消息（合成完成时追加的那条） */
  messageId: Type.Optional(Type.String()),
  /** 从开始合成到第一段出来花了多久（毫秒；第一声只等它，38 号票）。只有一段的就是整条的耗时 */
  firstSegmentMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 从开始合成到出结果（整条拼好入库）花了多久（毫秒；含 audio.cpp 第一次用到时加载模型） */
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 合成失败的原因（只合成了一部分的，是后面那段没合成出来的原因），或者最后没用语音回复的原因 */
  error: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
});
export type AgentVoiceRecord = Static<typeof AgentVoiceRecord>;

/** `agent_voice` 事件（会话频道上）：agent 的一条语音的最新状态（这一轮开始、回合结束、合成完成或失败……见 AGENT_VOICE_STATUSES） */
export const AgentVoiceEventPayload = Type.Object({ voice: AgentVoiceRecord });
export type AgentVoiceEventPayload = Static<typeof AgentVoiceEventPayload>;

// ───────────────────────── 参考音色（32 号票，设置里的语音页） ─────────────────────────

/** 一个参考音色（个人数据，存在数据目录的 voices 区，目录和文件用英文 id 命名，显示名另存） */
export const ReferenceVoice = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** 参考录音的逐字稿 */
  referenceText: Type.String(),
  durationMs: Type.Integer({ minimum: 0 }),
  /** 参考录音的 sha256 */
  sha256: Type.String(),
  importedAt: Type.String(),
  /** 是开源版自带的默认音色（ADR-0036），不是用户导入的；显示名跟着界面语言变 */
  builtin: Type.Optional(Type.Boolean()),
});
export type ReferenceVoice = Static<typeof ReferenceVoice>;

/** 设置页的参考音色列表：按导入的先后；current 是语音回复现在用哪一个（没选过时，只有一个就是它） */
export const ReferenceVoiceList = Type.Object({
  voices: Type.Array(ReferenceVoice),
  currentId: Type.Optional(Type.String()),
});
export type ReferenceVoiceList = Static<typeof ReferenceVoiceList>;

/**
 * 导入一个参考音色：名字、音频（base64，wav、mp3、m4a、aac、opus、ogg、flac、webm 等常见格式，服务端转成 WAV），
 * 可选的逐字稿（230 号票：不给就自动识别；给了照用，兼容旧调用和手工修正）
 */
export const ImportReferenceVoiceBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: REFERENCE_VOICE_NAME_MAX }),
  referenceText: Type.Optional(Type.String({ minLength: 1, maxLength: REFERENCE_VOICE_TEXT_MAX })),
  /** 录音文件的内容，base64（常见音频都行，导入时用本机 ffmpeg 转成 16 kHz 单声道 PCM16 的 WAV） */
  audioBase64: Type.String({ minLength: 1 }),
});
export type ImportReferenceVoiceBody = Static<typeof ImportReferenceVoiceBody>;

// ───────────────────────── 语音模型的状态（45 号票：模型预热） ─────────────────────────

export const VoiceModelStatus = Type.Enum(VOICE_MODEL_STATUSES);
export type VoiceModelStatus = Static<typeof VoiceModelStatus>;

/** 一个模型（识别或合成）现在的状态，见 VOICE_MODEL_STATUSES */
export const VoiceModelState = Type.Object({
  status: VoiceModelStatus,
  /** 用的模型：识别是 faster-whisper 的模型名（large-v3，退回时是 small）；合成是服务报的（比如 fish_audio（audio.cpp/tts）） */
  model: Type.Optional(Type.String()),
  /** 识别用的设备、计算精度（合成的 audio.cpp 不报这两样） */
  device: Type.Optional(Type.String()),
  computeType: Type.Optional(Type.String()),
  /** 加载耗时（毫秒）：识别是识别进程报的加载模型的时间；合成是那次试合成的耗时 */
  loadMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 合成：试合成很快，模型之前就已经加载好了（不是这次加载的） */
  alreadyLoaded: Type.Optional(Type.Boolean()),
  /** 识别退回 CPU 的原因（没退回没有） */
  fallbackReason: Type.Optional(Type.String()),
  /** 没开、出错的原因，等着的说明 */
  reason: Type.Optional(Type.String()),
  /** 从什么时候起是这个状态 */
  since: Type.String(),
});
export type VoiceModelState = Static<typeof VoiceModelState>;

/**
 * 两个语音模型的状态（GET /api/voice-models 的响应，也是活动状态频道上临时事件 voice_models 的负载）。
 * 识别引擎的清单由守护进程给（现在只有 faster-whisper 一项）。startedAt、revision 认新旧：同一次启动里 revision 大的新
 */
export const VoiceModelsView = Type.Object({
  recognizerEngines: Type.Array(Type.String()),
  /** 现在用的识别引擎 */
  recognizerEngine: Type.String(),
  recognizer: VoiceModelState,
  speech: VoiceModelState,
  /** 守护进程这次启动的时间 */
  startedAt: Type.String(),
  /** 这次启动以来第几版（每变一次加 1） */
  revision: Type.Integer({ minimum: 1 }),
});
export type VoiceModelsView = Static<typeof VoiceModelsView>;
