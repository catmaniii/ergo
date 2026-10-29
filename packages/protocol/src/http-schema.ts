// HTTP 接口（上传、下载、历史分页；10 号票起还有"被信任吗"和设备配对）的请求体和响应体，用 TypeBox 定义。
// 路径和错误码在 http.ts。
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { t } from "./i18n/runtime.ts";
import {
  CREDENTIAL_REJECTIONS,
  EVENT_TYPES,
  MATERIAL_FACETS,
  MATERIAL_LIST_MAX,
  MATERIAL_QUERY_MAX,
  MATERIAL_SEGMENT_FORMS,
  MATERIAL_SEGMENT_NOTES,
  MATERIAL_SOURCE_LEVELS,
  PAIRING_REQUEST_STATUSES,
} from "./constants.ts";
import { HTTP_ERROR_CODES, MEDIA_ID_PATTERN, TOOL_CALL_CLEAR_REASONS } from "./http.ts";
import {
  ConversationId,
  DeletedEventPayload,
  MaterialScope,
  MemoryDeleteMode,
  MessageEnvelope,
  MessagePart,
  MessageScope,
  ProjectInternal,
  QuickActionExecutedEventPayload,
  ToolCallOutcome,
} from "./schema.ts";
import { TimelineRecordEventPayload } from "./timeline.ts";
import { AgentVoiceRecord, VoiceRecord } from "./voice-schema.ts";
import { DayVerdict, HOLIDAY_REGIONS, WorkdayChange, WorkdaySettings } from "./workday-calendar.ts";

const validators = new Map<TSchema, ReturnType<typeof Compile>>();

/** 守护进程校验收到的请求体：符合 schema 就给出类型确定的值，否则给出哪里不对 */
export function checkHttpBody<S extends TSchema>(schema: S, value: unknown): { ok: true; value: Static<S> } | { ok: false; message: string } {
  let validator = validators.get(schema);
  if (!validator) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  if (validator.Check(value)) return { ok: true, value: value as Static<S> };
  const first = validator.Errors(value)[0];
  return { ok: false, message: first ? `${first.instancePath || "/"} ${first.message}` : t("protocol.http.badFormat") };
}

/** 错误响应 */
export const HttpErrorBody = Type.Object({
  code: Type.Enum(HTTP_ERROR_CODES),
  message: Type.String(),
  /** offset_mismatch 时：服务端已收到的字节数 */
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type HttpErrorBody = Static<typeof HttpErrorBody>;

/**
 * 文本类附件的内容（113 号票，报告页用，GET /api/media/<媒体 id>/text）。名字、类型取消息里最近一次引用它的文件 part；
 * text 是按 UTF-8 解好的文字，文件超过 MEDIA_TEXT_MAX_BYTES 时只有开头那么多（截在字符边上，truncated 为真）；
 * bytes 是整个文件的字节数；sentAt 是引用它的那条消息发出的时间。
 * 117 号票：HTML、SVG 附件的内容不经这里给（text 是空的、truncated 为假），frame 写明在框里看哪一种——报告页用 HTTP_PATHS 的
 * mediaHtml（<iframe sandbox>）或 mediaSvg（<img>）显示
 */
export const MediaTextView = Type.Object({
  mediaId: Type.String({ pattern: MEDIA_ID_PATTERN.source }),
  name: Type.String(),
  mime: Type.String(),
  text: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  sentAt: Type.Optional(Type.String()),
  frame: Type.Optional(Type.Union([Type.Literal("html"), Type.Literal("svg")])),
});
export type MediaTextView = Static<typeof MediaTextView>;

/** 建上传：文件名、前端声明的类型、总字节数 */
export const CreateUploadBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 1024 }),
  mime: Type.String({ maxLength: 255 }),
  size: Type.Integer({ minimum: 0 }),
});
export type CreateUploadBody = Static<typeof CreateUploadBody>;

/** 一个上传的进度（建上传、写分片、查进度的响应） */
export const UploadStatus = Type.Object({
  uploadId: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  /** 服务端已收到的字节数：下一个分片从这里写 */
  offset: Type.Integer({ minimum: 0 }),
});
export type UploadStatus = Static<typeof UploadStatus>;

/** 收尾：原始上传字节的 sha256（64 位小写十六进制） */
export const CompleteUploadBody = Type.Object({ sha256: Type.String({ pattern: MEDIA_ID_PATTERN.source }) });
export type CompleteUploadBody = Static<typeof CompleteUploadBody>;

/**
 * 入库后的媒体（收尾的响应）。mediaId 是入库版本的 sha256：图片剥掉 EXIF 之后的内容，
 * 和原始上传字节的 sha256 不一定相同。kind 由服务端看内容判断（浏览器能直接显示的 JPEG、PNG、GIF、WebP 算图片），
 * 前端据此发图片 part 还是文件 part。
 */
export const UploadedMedia = Type.Object({
  mediaId: Type.String(),
  kind: Type.Union([Type.Literal("image"), Type.Literal("file")]),
  name: Type.String(),
  mime: Type.String(),
  /** 入库版本的字节数 */
  size: Type.Integer({ minimum: 0 }),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
});
export type UploadedMedia = Static<typeof UploadedMedia>;

/**
 * 历史分页里的一条消息：它的 message 事件在会话频道里的序号，连同事件负载（含归属：任务、项目、阶段——时间线的全局层按它聚色块，25 号票）。
 * 被彻底删除的消息（21 号票）只有"已删除"标记（消息 id 和时间），原文不在了
 */
export const HistoryMessage = Type.Union([
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    message: MessageEnvelope,
    idempotencyKey: Type.Optional(Type.String()),
    ...MessageScope.properties,
    /** 排队交出的那一批（144 号票，消息事件里的 queueDelivery）：同一批里第一条之后的不是回退点（150 号票，它们和第一条一起交给 agent） */
    queueDelivery: Type.Optional(Type.String()),
  }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), deleted: DeletedEventPayload }),
]);
export type HistoryMessage = Static<typeof HistoryMessage>;

/**
 * 历史分页里消息之间的一条时间线记录（25 号票）：时间线记录（偏离、范围变更、越界……）或快速动作的执行（操作记录），
 * 连同它在会话频道里的序号和事件负载。工具调用记录本身就是消息，跟着消息走
 */
export const HistoryRecord = Type.Union([
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal(EVENT_TYPES.timelineRecord), payload: TimelineRecordEventPayload }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal(EVENT_TYPES.quickActionExecuted), payload: QuickActionExecutedEventPayload }),
]);
export type HistoryRecord = Static<typeof HistoryRecord>;

/**
 * 一页里长程任务阶段开始的记号（152 号票，stage_start 事件，StageStartEventPayload）：缩小视图在那一处画"撤回到阶段「…」开始前"
 */
export const HistoryStageStart = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  payload: Type.Object({
    id: Type.String(),
    conversation: ConversationId,
    taskId: Type.String(),
    stageId: Type.String(),
    title: Type.String(),
    code: Type.Optional(Type.String()),
    via: Type.Union([Type.Object({ notice: Type.String() }), Type.Object({ call: Type.String(), tool: Type.String(), after: Type.Boolean() })]),
    time: Type.String(),
  }),
});
export type HistoryStageStart = Static<typeof HistoryStageStart>;

/**
 * 一页历史：序号小于 before 的最近若干条消息，按序号从早到晚；hasMore 表示更早还有。
 * records 是落在这一页里的时间线记录（序号从这一页第一条消息起、小于 before；更早没有了的，从头起），按序号从早到晚
 */
export const HistoryPage = Type.Object({
  conversation: Type.String(),
  messages: Type.Array(HistoryMessage),
  records: Type.Array(HistoryRecord),
  hasMore: Type.Boolean(),
  /**
   * 这一页的语音消息引用的语音对象的最新状态（31 号票）：它们的 voice 事件可能早于 WebSocket 第一次补发的那一页，
   * 往上翻时跟着这一页一起取回。没有语音时不带
   */
  voices: Type.Optional(Type.Array(VoiceRecord)),
  /** 这一页里 agent 的语音消息引用的 agent 语音对象的最新状态（32 号票：送进 TTS 的原文在这里）。没有时不带 */
  agentVoices: Type.Optional(Type.Array(AgentVoiceRecord)),
  /** 这一页覆盖的序号里长程任务阶段开始的记号（152 号票，和 records 同一个范围，回退过的只留当前分支上的）。没有时不带 */
  stageStarts: Type.Optional(Type.Array(HistoryStageStart)),
});
export type HistoryPage = Static<typeof HistoryPage>;

// ───────────────────────── 设备配对（10 号票） ─────────────────────────

/** GET /api/access：这个请求被信任吗。local：从本机端口进来；device：带着有效凭证的已配对设备；none：还没配对 */
export const AccessInfo = Type.Union([
  Type.Object({ access: Type.Literal("local") }),
  Type.Object({ access: Type.Literal("device"), device: Type.Object({ id: Type.String(), name: Type.String() }) }),
  /**
   * reason：带来的凭证为什么不认（这一次响应同时让浏览器删掉它，所以只有第一次问时有）；没带凭证、凭证认不出时没有。
   * 页面看到 revoked 就在浏览器里留"本设备已被吊销"的记号，刷新后不自动重新申请
   */
  Type.Object({ access: Type.Literal("none"), reason: Type.Optional(Type.Enum(CREDENTIAL_REJECTIONS)) }),
]);
export type AccessInfo = Static<typeof AccessInfo>;

/** 新设备这一侧看到的配对请求（/api/pairing 的响应体 `{ request }`）。凭证不在这里，只在 Set-Cookie 里 */
export const PairingRequestView = Type.Object({
  id: Type.String(),
  status: Type.Enum(PAIRING_REQUEST_STATUSES),
  deviceName: Type.String(),
  shortCode: Type.String(),
  fingerprint: Type.String(),
  /** 待批的请求什么时候过期 */
  expiresAt: Type.String(),
});
export type PairingRequestView = Static<typeof PairingRequestView>;

/** POST /api/pairing 的请求体：设备名可以不给（按 User-Agent 生成） */
export const PairingCreateBody = Type.Object({ deviceName: Type.Optional(Type.String()) });
export type PairingCreateBody = Static<typeof PairingCreateBody>;

/** PATCH /api/pairing 的请求体：新的设备名 */
export const PairingRenameBody = Type.Object({ deviceName: Type.String() });
export type PairingRenameBody = Static<typeof PairingRenameBody>;

// ───────────────────────── 设置里按会话、按时间段删除素材（21 号票） ─────────────────────────

/** 看素材范围里有几条：不给范围就是全部 */
export const MaterialScopeBody = Type.Object({ scope: Type.Optional(MaterialScope) });
export type MaterialScopeBody = Static<typeof MaterialScopeBody>;

/** 范围里有几条素材，以及有素材的会话各有几条（设置页的会话下拉框用） */
export const MaterialScopeSummary = Type.Object({
  count: Type.Integer({ minimum: 0 }),
  conversations: Type.Array(Type.Object({ conversation: Type.String(), count: Type.Integer({ minimum: 0 }) })),
  /** 范围里没有素材的语音（没识别出文字的）有几条：彻底删除时连同录音一起删（31 号票）；没有时不带 */
  voices: Type.Optional(Type.Integer({ minimum: 1 })),
  /** 素材库只保管、不采集新素材（记忆插件没启用，129 号票）：记忆 · 素材页顶上写明（167 号票）；在采集时不带 */
  keepingOnly: Type.Optional(Type.Literal(true)),
});
export type MaterialScopeSummary = Static<typeof MaterialScopeSummary>;

/** 对范围内的全部素材执行一种删法；有副作用，带幂等键（同一个键重发只执行一次） */
export const DeleteMaterialsBody = Type.Object({
  scope: MaterialScope,
  mode: MemoryDeleteMode,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export type DeleteMaterialsBody = Static<typeof DeleteMaterialsBody>;

/** 处理了几条素材 */
export const DeleteMaterialsResult = Type.Object({ count: Type.Integer({ minimum: 0 }) });
export type DeleteMaterialsResult = Static<typeof DeleteMaterialsResult>;

// ───────────────────────── 设置里看素材（158 号票） ─────────────────────────

/**
 * 记忆 · 素材的筛选（167 号票），都可以不给，给了的都要满足：
 * - from / to：时间段（带时区的 ISO 时间，两头都算，按素材的时间），可以只给一头；
 * - facets：种类（MATERIAL_FACETS），算其中任一种就行；空数组等于不筛；
 * - conversation：来源会话（秘书主线、某个维护者的会话）；不来自会话的素材这时不列；
 * - query：关键词，按空白拆开、每个词都要有——用素材库的关键词检索（和秘书的素材检索同一个索引：本人的话、引用的说明、存的网页的正文）；
 *   这时列表里的摘录换成命中的那一段
 */
export const MaterialListFilter = Type.Object({
  from: Type.Optional(Type.String({ minLength: 1 })),
  to: Type.Optional(Type.String({ minLength: 1 })),
  facets: Type.Optional(Type.Array(Type.Enum(MATERIAL_FACETS), { maxItems: MATERIAL_FACETS.length })),
  conversation: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ maxLength: MATERIAL_QUERY_MAX })),
});
export type MaterialListFilter = Static<typeof MaterialListFilter>;

/**
 * 素材列表的一页（POST /api/materials/list）：范围同上（不给是全部），新的在前（按素材的时间）；offset 从 0 起。
 * 167 号票起可以再给筛选（filter），在范围里再筛
 */
export const MaterialListBody = Type.Object({
  scope: Type.Optional(MaterialScope),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MATERIAL_LIST_MAX })),
  filter: Type.Optional(MaterialListFilter),
});
export type MaterialListBody = Static<typeof MaterialListBody>;

/**
 * 素材上的标记：说过"别推断"的（21 号票）；在会话回退留下的废弃分支里的（150 号票，查询时现算，切回去就不在了）；
 * 项目内部的记录（64 号票：由系统记下的、秘书检索不到，删项目时随项目删）。没有的不带
 */
export const MaterialMarks = Type.Object({
  noInfer: Type.Optional(Type.Literal(true)),
  abandoned: Type.Optional(Type.Literal(true)),
  internal: Type.Optional(ProjectInternal),
  /** 来自了解你访谈（284 号票：访谈开着时在记忆管理员的会话里说的） */
  interview: Type.Optional(Type.Literal(true)),
});
export type MaterialMarks = Static<typeof MaterialMarks>;

/** 素材列表里的一条 */
export const MaterialListItem = Type.Object({
  id: Type.String(),
  /** 素材的种类（中文名："用户发言"） */
  kind: Type.String(),
  time: Type.String(),
  /** 来源会话（不来自会话的没有） */
  conversation: Type.Optional(Type.String()),
  /** 开头一段（本人的话、附件的文件名、卡片的说明） */
  excerpt: Type.String(),
  marks: MaterialMarks,
});
export type MaterialListItem = Static<typeof MaterialListItem>;

/** 一页素材和范围里一共几条 */
export const MaterialListPage = Type.Object({ items: Type.Array(MaterialListItem), total: Type.Integer({ minimum: 0 }) });
export type MaterialListPage = Static<typeof MaterialListPage>;

/**
 * 素材的一段（守护进程的 MaterialSegment 加上从出处的消息里取的）：本人的段带文字（text）；别的只记了引用和哈希，
 * 出处的消息还在时补上——引用块的原文（quoted），附件、语音在消息里的那个 part（part：界面照会话里的样子画图片、文件、语音条）
 */
export const MaterialSegmentView = Type.Object({
  form: Type.Enum(MATERIAL_SEGMENT_FORMS),
  source: Type.Enum(MATERIAL_SOURCE_LEVELS),
  notes: Type.Array(Type.Enum(MATERIAL_SEGMENT_NOTES)),
  text: Type.Optional(Type.String()),
  /** 引用的说明：附件的文件名、网页的网址、卡片的类型和标题 */
  label: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  cardId: Type.Optional(Type.String()),
  /** 内容哈希（sha256 十六进制） */
  sha256: Type.Optional(Type.String()),
  media: Type.Optional(Type.Object({ mediaId: Type.String(), name: Type.Optional(Type.String()), mime: Type.Optional(Type.String()) })),
  /** 引用块的原文（素材只记了哈希）：出处的消息还在时从消息里取 */
  quoted: Type.Optional(Type.String()),
  /** 附件、语音在出处的消息里的那个 part（图片、文件、视频、语音） */
  part: Type.Optional(MessagePart),
  /**
   * 你存的网页（165 号票，网页那一段）：存下的标题、正文（网页上的外部数据，素材里只记了网址和哈希）、截没截、原文一共多少字——
   * 原始事件还在、没被彻底删除时从事件里取
   */
  saved: Type.Optional(Type.Object({ title: Type.String(), text: Type.String(), truncated: Type.Boolean(), total: Type.Integer({ minimum: 0 }) })),
});
export type MaterialSegmentView = Static<typeof MaterialSegmentView>;

/** 出处的消息现在怎样：还在当前分支上（能跳过去）、在废弃分支里、已经不在了（彻底删除了，或者随项目删了） */
export const MATERIAL_MESSAGE_STATES = ["shown", "abandoned", "gone"] as const;

/** 一条素材的完整内容（GET /api/materials/<素材 id>） */
export const MaterialDetailView = Type.Object({
  id: Type.String(),
  /** 种类的中文名 */
  kind: Type.String(),
  /** 说还是做 */
  mode: Type.Union([Type.Literal("say"), Type.Literal("do")]),
  time: Type.String(),
  conversation: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  /** 来源等级（这件事是谁做的、谁说的；每段另有各自的来源） */
  source: Type.Enum(MATERIAL_SOURCE_LEVELS),
  /** 情境标签 */
  context: Type.Array(Type.String()),
  segments: Type.Array(MaterialSegmentView),
  /** 产生这条素材的原始事件 */
  event: Type.Object({ channel: Type.String(), seq: Type.Integer({ minimum: 1 }), type: Type.String() }),
  /** 出处的消息（来自消息的才有） */
  message: Type.Optional(Type.Object({ id: Type.String(), state: Type.Enum(MATERIAL_MESSAGE_STATES) })),
  cardId: Type.Optional(Type.String()),
  /** 别的原始记录（审批、语音、记忆命令……）的编号 */
  recordId: Type.Optional(Type.String()),
  /** 原文副本（本人素材才有）：相对素材区的路径 */
  original: Type.Optional(Type.String()),
  marks: MaterialMarks,
});
export type MaterialDetailView = Static<typeof MaterialDetailView>;

// ───────────────────────── 设置里的工作日历（29 号票） ─────────────────────────

/** 改个人设置（POST /api/workday-calendar） */
export const WorkdayChangeBody = Type.Object({ change: WorkdayChange });
export type WorkdayChangeBody = Static<typeof WorkdayChangeBody>;

/** 改了之后的个人设置，和这次有没有变化（同一条规则再加、同样的标记再标都没有变化） */
export const WorkdayChangeResult = Type.Object({ settings: WorkdaySettings, changed: Type.Boolean() });
export type WorkdayChangeResult = Static<typeof WorkdayChangeResult>;

/** 某个月每天上班或休息及原因（GET /api/workday-calendar?month=YYYY-MM），连同个人设置和这一年缺哪边的节假日数据 */
export const WorkdayMonthView = Type.Object({
  month: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}$" }),
  days: Type.Array(DayVerdict),
  settings: WorkdaySettings,
  missing: Type.Array(Type.Enum(HOLIDAY_REGIONS)),
});
export type WorkdayMonthView = Static<typeof WorkdayMonthView>;

// ───────────────────────── 工具调用的完整参数和返回（53 号票） ─────────────────────────

/**
 * 工具返回里没有内联的一块二进制内容（比如读图片时的图片）：只说是什么、多大。
 * 宿主协议的 tool_call_end.media 也是这个形状（守护进程只引类型，同一份定义）
 */
export const ToolResultMedia = Type.Object({
  /** 内容块的种类（现在只有 image） */
  type: Type.String(),
  mimeType: Type.Optional(Type.String()),
  /** 内容的字节数（pi 给的是 base64，按解码后的算） */
  bytes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ToolResultMedia = Static<typeof ToolResultMedia>;

/** 截断了的一个值：在哪（JSON Pointer，比如 /args/content、/result）和原长（UTF-8 字节） */
export const TruncatedValue = Type.Object({ pointer: Type.String(), bytes: Type.Integer({ minimum: 0 }) });
export type TruncatedValue = Static<typeof TruncatedValue>;

/**
 * 一次效果涉及的一个对象（56 号票）：按工具登记里的参数规则认的路径、收件人、网址。
 * 路径是规范化后的绝对路径；access 是这个路径怎么碰的（读、写、删，unknown 是拆出来的命令不知道读还是写）。
 * uncertain：守卫当时没法确定的值（比如命令里的变量），value 是原文
 */
export const ToolCallEffectObject = Type.Object({
  kind: Type.Union([Type.Literal("path"), Type.Literal("recipient"), Type.Literal("url")]),
  access: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("delete"), Type.Literal("unknown")])),
  value: Type.String(),
  uncertain: Type.Optional(Type.Literal(true)),
});
export type ToolCallEffectObject = Static<typeof ToolCallEffectObject>;

/**
 * 一次调用的一条效果记录（56 号票）：守卫的效果日志里记下的，执行成功的调用才有。通用 bash 拆出来的每条操作各一条。
 * summary 是效果摘要（做了什么、改动的文件、成功与否、结果的开头一小段），和效果日志里的一样经过隐私处理。
 * objects 只认得内置工具、带类型的 bash 工具和伪工具的参数规则；别的工具（MCP、二狗自己的工具）是空的，涉及的文件写在摘要里
 */
export const ToolCallEffect = Type.Object({
  /** 效果日志里的序号 */
  seq: Type.Integer({ minimum: 1 }),
  /** 工具或伪工具 */
  tool: Type.String(),
  /** 工具的中文名（没登记的没有） */
  toolTitle: Type.Optional(Type.String()),
  summary: Type.String(),
  objects: Type.Array(ToolCallEffectObject),
  /** 写了多少（68 号票：效果日志里写入的全文、编辑的新旧片段只记长度和摘要哈希）：写文件"写入 N 字"、改文件"改了 K 处" */
  content: Type.Optional(Type.String()),
});
export type ToolCallEffect = Static<typeof ToolCallEffect>;

/**
 * 一次工具调用的完整参数和返回（GET /api/tool-calls/<调用 id>）。秘书、维护者、子 agent、评审的调用都有，
 * 被拦下的、出错的也有；调用结束时由守护进程另存一份，重启后照样取得到。
 * - 和聊天里的工具调用记录一样经过隐私处理：读过的密钥值换成"（密钥）"；读了密钥文件的不记返回（resultWithheld）；
 * - 单个值（返回的文字、参数里的每个字符串）超过 TOOL_CALL_VALUE_MAX_BYTES 的只留开头，末尾注明"已截断"和原长，truncated 里列出；
 * - 二进制内容（图片）不内联：返回的文字里是 [image] 这样的占位，media 里说明是什么、多大；
 * - 彻底删除过的（21 号票的口径）：参数和返回里的文字都换成删除标记，purged 为 true；删除项目时照同样的口径一起改写的
 *   （66 号票）另有 purgedBy 为 project_deletion，详情页写"已随项目删除"；
 * - 过了保留期、超出总量上限清掉了的（65 号票）：cleared 注明原因，args 只剩参数摘要（一行文字）、result 只剩结果摘要，
 *   和聊天里工具调用记录的摘要一样长；工具、结局、归属、时间、图片说明、效果记录照旧。
 * 宽松、向后兼容：以后只加可选字段；前端认不得的字段不管
 */
export const ToolCallDetail = Type.Object({
  callId: Type.String(),
  /** 工具名（模型调用的工具；通用 bash 是 bash） */
  tool: Type.String(),
  /** 工具的中文名（没登记的是工具名） */
  toolTitle: Type.Optional(Type.String()),
  /** 归属（和这次调用的工具调用记录一样，判定那一刻取的）：任务、项目、阶段、定时作业 */
  ...MessageScope.properties,
  /** 发起调用的 agent（秘书、维护者、子 agent、评审）：总是有 */
  agentId: Type.String(),
  /** 工具调用记录所在的会话；不在任何会话里的（评审子 agent 的调用）为 null */
  conversation: Type.Union([ConversationId, Type.Null()]),
  /** 结局，和工具调用 part 的 outcome 一样：done、error、blocked、denied */
  outcome: ToolCallOutcome,
  /** 开始判定、调用结束的时间（带时区偏移的 ISO） */
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  /**
   * 完整参数（模型给的原样，没有规范化）。288 号票起：Claude Code 这类运行时的调用，tool 是映射到守卫工具登记表之后的名字（守卫按它判，
   * Bash → bash、Read → read……），这里是运行时自己的工具收到的原样参数，工具名在 nativeTool
   */
  args: Type.Unknown(),
  /** 运行时自己的工具名（288 号票：Claude Code 的 Bash、Read、Edit……）；和 tool 一样的、pi 的调用没有 */
  nativeTool: Type.Optional(Type.String()),
  /** 子代理里的调用（288 号票）：调用这个子代理的那次调用的 callId；主线的没有 */
  parentCallId: Type.Optional(Type.String()),
  /** 完整返回：工具交回模型的文字；被拦下的是模型收到的说明 */
  result: Type.String(),
  /** 返回是否出错（被拦下的也算） */
  isError: Type.Boolean(),
  media: Type.Optional(Type.Array(ToolResultMedia)),
  truncated: Type.Optional(Type.Array(TruncatedValue)),
  /** 返回没有记下来的原因：读了密钥文件（secret_file），result 是一句说明 */
  resultWithheld: Type.Optional(Type.Literal("secret_file")),
  purged: Type.Optional(Type.Literal(true)),
  /**
   * 删掉的是哪种删除（66 号票）：删除项目时一起改写的为 project_deletion——项目维护者会话里的、属于这个项目的调用，
   * 和项目之外读过这个项目的调用（秘书会话里的、跨项目任务的评审）；彻底删除的没有这个字段
   */
  purgedBy: Type.Optional(Type.Literal("project_deletion")),
  /**
   * 完整内容清掉了（65 号票）：为什么（过了保留期 expired、超出总量上限时从最旧的清 over_limit）、什么时候清的。
   * 清掉之后 args 是参数摘要（一行文字）、result 是结果摘要，截断说明跟着去掉
   */
  cleared: Type.Optional(Type.Object({ reason: Type.Enum(TOOL_CALL_CLEAR_REASONS), at: Type.String() })),
  /**
   * 这次调用的效果记录（56 号票，取的时候从效果日志里找，顺带返回）：执行成功（outcome 是 done）的调用才有这个字段，
   * 找不到时是空数组（守护进程加上调用 id 之前的旧记录按"紧跟在这次调用的记录后面"找）；没执行的、彻底删除过的没有
   */
  effects: Type.Optional(Type.Array(ToolCallEffect)),
});
export type ToolCallDetail = Static<typeof ToolCallDetail>;

// ───────────────────────── 长程任务的阶段详情（84 号票） ─────────────────────────

/** 一件已经做了的事在哪儿生效：本机（改了本机的文件、跑了命令……），对外（往外送：推送、发消息、带数据的请求……） */
export const STAGE_EFFECT_REACHES = ["local", "external"] as const;
export type StageEffectReach = (typeof STAGE_EFFECT_REACHES)[number];

/**
 * 重开的这几个阶段这一轮已经做了的一件事（效果日志里执行成功、不是只看的；同一件只列一次）。
 * argsSummary 和工具调用记录上的参数摘要是同一种写法（前端照它说成人话）
 */
export const StageEffect = Type.Object({
  stageId: Type.String(),
  tool: Type.String(),
  /** 工具的中文名（没登记的没有） */
  toolTitle: Type.Optional(Type.String()),
  argsSummary: Type.String(),
  reach: Type.Enum(STAGE_EFFECT_REACHES),
  /** 做的时间（带时区偏移的 ISO 时间） */
  at: Type.String(),
});
export type StageEffect = Static<typeof StageEffect>;

// ───────────────────────── 阶段"系统查到的结果"（274 号票） ─────────────────────────

/** 对外发送的一件是什么：消息（有收件人）、请求（发给网址的）、别的对外动作（推送、发布、建远端仓库……） */
export const STAGE_SEND_KINDS = ["message", "request", "action"] as const;
export type StageSendKind = (typeof STAGE_SEND_KINDS)[number];

/** 一个文件这一轮怎么了：新建、修改、删除（同一个文件按最后的样子算：新建后又改还是新建，删了又写是修改） */
export const STAGE_FILE_CHANGES = ["created", "modified", "deleted"] as const;
export type StageFileChange = (typeof STAGE_FILE_CHANGES)[number];

/**
 * 维护者宣布完成时写的那一两句里提到的一个文件，和系统查到的对不对得上：found 这一轮新建或改过它；untouched 没查到这一轮新建或
 * 改过它；deleted 这一轮把它删了
 */
export const STAGE_CLAIM_RESULTS = ["found", "untouched", "deleted"] as const;
export type StageClaimResult = (typeof STAGE_CLAIM_RESULTS)[number];

/**
 * 一个阶段这一轮（上次重开之后）系统从效果日志里查到的（274 号票，本该是每轮结束系统直接查到的结果；二狗查不了世界，
 * 用效果日志代替）：
 * - sent：对外发送的每一件（和"从这里重做"列的对外的同一个口径：守卫的 sendsOut），按先后，同一件只列一次；
 * - files：改了哪些文件（效果日志里写、删的路径参数；工作目录、仓库这类"在哪儿做"的参数不算），按第一次动它的先后；
 * - other：本机做的、看不出改了哪些文件的（跑脚本、提交、装依赖、构建……），按工具数——里面改的文件效果日志记不到；
 * - claims：维护者宣布完成时写的那一两句（TaskStage.summary）里提到的文件，各自对不对得上；没写、没提到文件的是空的
 */
export const StageObserved = Type.Object({
  sent: Type.Array(
    Type.Object({
      tool: Type.String(),
      toolTitle: Type.Optional(Type.String()),
      argsSummary: Type.String(),
      kind: Type.Enum(STAGE_SEND_KINDS),
      at: Type.String(),
    }),
  ),
  files: Type.Array(Type.Object({ path: Type.String(), change: Type.Enum(STAGE_FILE_CHANGES) })),
  other: Type.Array(Type.Object({ tool: Type.String(), toolTitle: Type.Optional(Type.String()), n: Type.Integer({ minimum: 1 }) })),
  claims: Type.Array(Type.Object({ text: Type.String(), result: Type.Enum(STAGE_CLAIM_RESULTS) })),
});
export type StageObserved = Static<typeof StageObserved>;

/**
 * 长程任务一个阶段从守护进程现取的几样（GET /api/tasks/<任务 id>/stages/<阶段 id>，84 号票）：
 * - grantUses：这一阶段（连同所属阶段组）的每项授权用了几次，和守卫计次同一个口径（效果日志里本任务、这个阶段、授予之后、同一工具、
 *   对象范围之内的）；grantId 是计划里的授权项 id；
 * - reopenScope：从这里重做会重开的阶段（它和依赖它的、开始过的），按计划里的顺序；
 * - effects：这几个阶段这一轮（上次重开之后）已经做了的事。重做不撤回它们，只列出来、告诉维护者；
 * - observed：这个阶段这一轮系统查到的结果（274 号票）；开始过的阶段才有。
 * 宽松、向后兼容：以后只加可选字段
 */
export const TaskStageView = Type.Object({
  taskId: Type.String(),
  stageId: Type.String(),
  grantUses: Type.Array(Type.Object({ grantId: Type.String(), used: Type.Integer({ minimum: 0 }) })),
  reopenScope: Type.Array(Type.String()),
  effects: Type.Array(StageEffect),
  observed: Type.Optional(StageObserved),
});
export type TaskStageView = Static<typeof TaskStageView>;

// ───────────────────────── 完整内容的保留期和总量上限（65 号票） ─────────────────────────

/**
 * 设置里的"工具调用的完整内容"（GET /api/tool-call-storage）：现在占了多大、保留多久、总量上限，照现在的规则马上清会清掉多少。
 * 字节数按存进事件日志的样子算（UTF-8 的 JSON），清掉后剩下的摘要也算在 bytes 里
 */
export const ToolCallStorageView = Type.Object({
  /** 现在占了多大（字节） */
  bytes: Type.Integer({ minimum: 0 }),
  /** 存着完整内容的调用有几次（清掉了的不算） */
  calls: Type.Integer({ minimum: 0 }),
  /** 清掉了、只剩摘要的有几次 */
  cleared: Type.Integer({ minimum: 0 }),
  /** 保留多少天（配置里的） */
  retentionDays: Type.Number({ exclusiveMinimum: 0 }),
  /** 总量上限（字节，配置里的） */
  maxBytes: Type.Integer({ minimum: 1 }),
  /**
   * 照现在的规则马上清（"现在就清理"）会清掉的：几次调用、大约腾出多少字节（超出总量上限的按清掉之后只剩摘要估）；
   * inUse 是到了该清的时候、但还被用着（没结束的任务里的、还在待办里的卡片引用着的）这次不会清的
   */
  due: Type.Object({ calls: Type.Integer({ minimum: 0 }), bytes: Type.Integer({ minimum: 0 }), inUse: Type.Integer({ minimum: 0 }) }),
});
export type ToolCallStorageView = Static<typeof ToolCallStorageView>;

/** 清了一次（定时跑的，或者设置里的"现在就清理"）：清了多少、还被用着没清的有几次、清完占多大 */
export const ToolCallCleanupResult = Type.Object({
  /** 定时跑的（scheduled）还是设置里点的（manual） */
  trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("manual")]),
  /** 什么时候清的 */
  at: Type.String(),
  /** 过了保留期清掉的有几次 */
  expired: Type.Integer({ minimum: 0 }),
  /** 超出总量上限、从最旧的起清掉的有几次 */
  overLimit: Type.Integer({ minimum: 0 }),
  /** 腾出了多少字节 */
  freedBytes: Type.Integer({ minimum: 0 }),
  /** 到了该清的时候、但还被用着这次没清的有几次 */
  keptInUse: Type.Integer({ minimum: 0 }),
  /** 清完之后占多大（字节）、还存着完整内容的有几次 */
  bytes: Type.Integer({ minimum: 0 }),
  calls: Type.Integer({ minimum: 0 }),
});
export type ToolCallCleanupResult = Static<typeof ToolCallCleanupResult>;

// ───────────────────────── 网页是哪一版（116 号票） ─────────────────────────

/** GET /api/web-version：守护进程现在提供的网页是哪一版（index.html 里的版本号，web-version.ts）；没有版本号、还没构建时不带 */
export const WebVersionView = Type.Object({
  version: Type.Optional(Type.String()),
});
export type WebVersionView = Static<typeof WebVersionView>;
