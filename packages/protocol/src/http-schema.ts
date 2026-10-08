// HTTP 接口（上传、下载、历史分页；10 号票起还有"被信任吗"和设备配对）的请求体和响应体，用 TypeBox 定义。
// 路径和错误码在 http.ts。
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CREDENTIAL_REJECTIONS, EVENT_TYPES, PAIRING_REQUEST_STATUSES } from "./constants.ts";
import { HTTP_ERROR_CODES, MEDIA_ID_PATTERN } from "./http.ts";
import { DeletedEventPayload, MaterialScope, MemoryDeleteMode, MessageEnvelope, MessageScope, QuickActionExecutedEventPayload } from "./schema.ts";
import { TimelineRecordEventPayload } from "./timeline.ts";
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
