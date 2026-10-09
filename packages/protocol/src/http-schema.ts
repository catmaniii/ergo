// HTTP 接口（上传、下载、历史分页；10 号票起还有"被信任吗"和设备配对）的请求体和响应体，用 TypeBox 定义。
// 路径和错误码在 http.ts。
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CREDENTIAL_REJECTIONS, EVENT_TYPES, PAIRING_REQUEST_STATUSES } from "./constants.ts";
import { HTTP_ERROR_CODES, MEDIA_ID_PATTERN } from "./http.ts";
import { ConversationId, DeletedEventPayload, MaterialScope, MemoryDeleteMode, MessageEnvelope, MessageScope, QuickActionExecutedEventPayload, ToolCallOutcome } from "./schema.ts";
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
  return { ok: false, message: first ? `${first.instancePath || "/"} ${first.message}` : "格式不对" };
}

/** 错误响应 */
export const HttpErrorBody = Type.Object({
  code: Type.Enum(HTTP_ERROR_CODES),
  message: Type.String(),
  /** offset_mismatch 时：服务端已收到的字节数 */
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type HttpErrorBody = Static<typeof HttpErrorBody>;

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
});
export type ToolCallEffect = Static<typeof ToolCallEffect>;

/**
 * 一次工具调用的完整参数和返回（GET /api/tool-calls/<调用 id>）。秘书、维护者、子 agent、评审的调用都有，
 * 被拦下的、出错的也有；调用结束时由守护进程另存一份，重启后照样取得到。
 * - 和聊天里的工具调用记录一样经过隐私处理：读过的密钥值换成"（密钥）"；读了密钥文件的不记返回（resultWithheld）；
 * - 单个值（返回的文字、参数里的每个字符串）超过 TOOL_CALL_VALUE_MAX_BYTES 的只留开头，末尾注明"已截断"和原长，truncated 里列出；
 * - 二进制内容（图片）不内联：返回的文字里是 [image] 这样的占位，media 里说明是什么、多大；
 * - 彻底删除过的（21 号票的口径）：参数和返回里的文字都换成删除标记，purged 为 true。
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
  /** 完整参数（模型给的原样，没有规范化） */
  args: Type.Unknown(),
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
   * 这次调用的效果记录（56 号票，取的时候从效果日志里找，顺带返回）：执行成功（outcome 是 done）的调用才有这个字段，
   * 找不到时是空数组（守护进程加上调用 id 之前的旧记录按"紧跟在这次调用的记录后面"找）；没执行的、彻底删除过的没有
   */
  effects: Type.Optional(Type.Array(ToolCallEffect)),
});
export type ToolCallDetail = Static<typeof ToolCallDetail>;
