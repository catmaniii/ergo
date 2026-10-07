// HTTP 接口（上传、下载、历史分页；10 号票起还有"被信任吗"和设备配对）的请求体和响应体，用 TypeBox 定义。
// 路径和错误码在 http.ts。
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CREDENTIAL_REJECTIONS, PAIRING_REQUEST_STATUSES } from "./constants.ts";
import { HTTP_ERROR_CODES, MEDIA_ID_PATTERN } from "./http.ts";
import { MessageEnvelope } from "./schema.ts";

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

/** 历史分页里的一条消息：它的 message 事件在会话频道里的序号，连同事件负载 */
export const HistoryMessage = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  message: MessageEnvelope,
  idempotencyKey: Type.Optional(Type.String()),
});
export type HistoryMessage = Static<typeof HistoryMessage>;

/** 一页历史：序号小于 before 的最近若干条消息，按序号从早到晚；hasMore 表示更早还有 */
export const HistoryPage = Type.Object({
  conversation: Type.String(),
  messages: Type.Array(HistoryMessage),
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
