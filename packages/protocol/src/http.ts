// 前端协议里走 HTTP 的那部分（规格第 5 节）：媒体的分片续传上传、按 sha256 下载、会话历史分页。
// 只有常量和路径，不引用 TypeBox（请求和响应体的 schema 在 http-schema.ts）。
// 路径怎么拼（HTTP_PATHS）、怎么拆（parseHttpPath）、查询参数叫什么（HTTP_QUERY）都只写在这里，
// 守护进程的路由和 Web、测试的请求都从这里取。
//
// 上传是自定义的分片续传协议：
// 1. 建上传：POST /api/uploads，带文件名、类型、字节数；超过单文件上限当场拒绝；
// 2. 按偏移写分片：PUT /api/uploads/<上传 id>?offset=<偏移>，请求体是从这个偏移起的一段原始字节。
//    偏移必须等于服务端已收到的字节数，不等就回 409 和服务端的偏移；连接中途断了，已经收到的字节照样算数；
// 3. 查进度：GET /api/uploads/<上传 id>，断网恢复后从服务端已收到的偏移接着传，不重传已收到的字节；
// 4. 收尾：POST /api/uploads/<上传 id>/complete，带原始上传字节的 sha256。不符就拒绝、不入库。
//    图片入库前剥掉 EXIF，入库版本的 sha256 就是媒体 id（消息里的图片、文件 part 和素材都引用它）。
//
// 下载：GET /api/media/<媒体 id>，支持 Range（206）。
//
// 设置里按会话、按时间段删除素材（21 号票）：POST /api/materials/scope 看范围里有几条（和有素材的会话），
// POST /api/materials/delete 对范围内的全部素材执行一种删法（请求体带幂等键，重发只执行一次）。
//
// 设置里的工作日历（29 号票）：GET /api/workday-calendar?month=2026-10 按月看每天上班或休息及原因；
// POST /api/workday-calendar 改个人设置（加删额外规则、把某天标成上班或休息、清掉标记）。改动本身是幂等的
// （同一条规则只有一份、同样的标记再标没有变化），所以不带幂等键；改了之后工作日历频道上推一条 workday_settings 事件。
//
// 消耗页（24 号票）：GET /api/usage?from=2026-10-01&to=2026-10-08 选定范围（含两头）按天、按 agent 的 token 汇总，
// 秘书单列为系统开销，成本是用量乘配置里的单价（每次现读配置，粗估）。
//
// 设置里的语音页（32 号票）：参考音色（个人数据，数据目录的 voices 区）。GET /api/reference-voices 列出来（和现在用哪一个）；
// POST /api/reference-voices 导入一个（名字、逐字稿、WAV 的 base64，同样的录音和名字再导一次拿到同一个）；
// POST /api/reference-voices/<id>/select 选它；DELETE /api/reference-voices/<id> 删掉；GET /api/reference-voices/<id>/audio 试听参考录音。

/** 单个文件的默认上限（字节）：200 MB，数据目录的配置里可以改（media.maxUploadBytes） */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 历史分页一页最多多少条消息（也是前端第一次订阅会话频道时补发的最近消息条数） */
export const HISTORY_PAGE_SIZE = 50;

/** 媒体 id：入库版本内容的 sha256，64 位小写十六进制（收尾时带的原始字节 sha256 也是这个格式） */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{64}$/;

export function isMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}

/** HTTP 接口都在这个前缀下 */
export const HTTP_API_PREFIX = "/api/";

/** 查询参数的名字 */
export const HTTP_QUERY = {
  /** 写分片：这个分片从第几个字节起 */
  offset: "offset",
  /** 下载：文件名 */
  name: "name",
  /** 下载：为 1 时一律作为附件下载（不在页面里打开） */
  download: "download",
  /** 历史分页：只要序号小于它的消息 */
  before: "before",
  /** 历史分页：最多几条 */
  limit: "limit",
  /** 工作日历：哪个月（YYYY-MM） */
  month: "month",
  /** 消耗页：范围从哪天起（YYYY-MM-DD，含） */
  from: "from",
  /** 消耗页：范围到哪天（YYYY-MM-DD，含） */
  to: "to",
} as const;

const UPLOADS = "uploads";
const COMPLETE = "complete";
const MEDIA = "media";
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const MATERIALS = "materials";
const SCOPE = "scope";
const DELETE = "delete";
const WORKDAY_CALENDAR = "workday-calendar";
const USAGE = "usage";
const REFERENCE_VOICES = "reference-voices";
const SELECT = "select";
const AUDIO = "audio";

/** 拼查询串（不用 URLSearchParams：前端状态层既没有 DOM 也没有 Node 的类型） */
function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

const api = (...segments: string[]) => `${HTTP_API_PREFIX}${segments.map(encodeURIComponent).join("/")}`;

/** HTTP 接口的路径 */
export const HTTP_PATHS = {
  /** GET：这个请求被信任吗（本机端口、带着有效凭证的已配对设备、都不是）。两个端口都有，不需要凭证（10） */
  access: `${HTTP_API_PREFIX}access`,
  /**
   * 设备配对，只在外网端口上、不需要凭证（10）：POST 发起（`{ deviceName? }`，不给就按 User-Agent 生成，
   * 同一来源 10 分钟内最多 5 个）；GET 查自己这个请求，已批准就在这次响应里领到设备凭证（Set-Cookie）；
   * PATCH 改设备名（`{ deviceName }`，只在待批时能改）。认哪个请求靠发起时下发的配对 cookie（HttpOnly）
   */
  pairing: `${HTTP_API_PREFIX}pairing`,
  uploads: api(UPLOADS),
  upload: (uploadId: string) => api(UPLOADS, uploadId),
  /** 写分片：从 offset 起 */
  uploadChunk: (uploadId: string, offset: number) => `${api(UPLOADS, uploadId)}${query({ [HTTP_QUERY.offset]: String(offset) })}`,
  uploadComplete: (uploadId: string) => api(UPLOADS, uploadId, COMPLETE),
  /** 下载媒体；name 用作下载时的文件名，download 为真时一律作为附件下载（不在页面里打开） */
  media: (mediaId: string, options: { name?: string | undefined; download?: boolean | undefined } = {}) =>
    `${api(MEDIA, mediaId)}${query({ [HTTP_QUERY.name]: options.name, [HTTP_QUERY.download]: options.download ? "1" : undefined })}`,
  /** 某个会话更早的消息：before 是前端手里最早那条消息的序号（不填取最近的一页） */
  history: (conversation: string, options: { before?: number | undefined; limit?: number | undefined } = {}) =>
    `${api(CONVERSATIONS, conversation, MESSAGES)}${query({ [HTTP_QUERY.before]: options.before?.toString(), [HTTP_QUERY.limit]: options.limit?.toString() })}`,
  /** 素材范围里有几条（POST，请求体 MaterialScopeBody） */
  materialsScope: api(MATERIALS, SCOPE),
  /** 对范围内的全部素材执行一种删法（POST，请求体 DeleteMaterialsBody） */
  materialsDelete: api(MATERIALS, DELETE),
  /** 工作日历：改个人设置（POST，请求体 WorkdayChangeBody，响应 WorkdayChangeResult） */
  workdayCalendar: api(WORKDAY_CALENDAR),
  /** 工作日历：某个月（YYYY-MM）每天上班或休息及原因（GET，响应 WorkdayMonthView） */
  workdayMonth: (month: string) => `${api(WORKDAY_CALENDAR)}${query({ [HTTP_QUERY.month]: month })}`,
  /** 消耗页：from 到 to（YYYY-MM-DD，含两头）的用量汇总和粗估成本（GET，响应 UsageSummary，24 号票） */
  usage: (range: { from: string; to: string }) => `${api(USAGE)}${query({ [HTTP_QUERY.from]: range.from, [HTTP_QUERY.to]: range.to })}`,
  /** 参考音色：GET 列出（ReferenceVoiceList），POST 导入一个（ImportReferenceVoiceBody → ReferenceVoice）（32 号票） */
  referenceVoices: api(REFERENCE_VOICES),
  /** 一个参考音色：DELETE 删掉（响应 ReferenceVoiceList） */
  referenceVoice: (voiceId: string) => api(REFERENCE_VOICES, voiceId),
  /** 选这个参考音色作为语音回复用的（POST，响应 ReferenceVoiceList） */
  referenceVoiceSelect: (voiceId: string) => api(REFERENCE_VOICES, voiceId, SELECT),
  /** 试听：参考录音本身（GET，audio/wav） */
  referenceVoiceAudio: (voiceId: string) => api(REFERENCE_VOICES, voiceId, AUDIO),
} as const;

/** 拆出来的 HTTP 接口路径（和 HTTP_PATHS 一一对应） */
export type HttpRoute =
  | { route: "uploads" }
  | { route: "upload"; uploadId: string }
  | { route: "upload_complete"; uploadId: string }
  | { route: "media"; mediaId: string }
  | { route: "history"; conversation: string }
  | { route: "materials_scope" }
  | { route: "materials_delete" }
  | { route: "workday_calendar" }
  | { route: "usage" }
  | { route: "reference_voices" }
  | { route: "reference_voice"; voiceId: string }
  | { route: "reference_voice_select"; voiceId: string }
  | { route: "reference_voice_audio"; voiceId: string };

/** 把请求的路径（不含查询串）拆成接口和参数；不是 HTTP 接口的路径返回 undefined */
export function parseHttpPath(pathname: string): HttpRoute | undefined {
  if (!pathname.startsWith(HTTP_API_PREFIX)) return undefined;
  let segments: string[];
  try {
    segments = pathname.slice(HTTP_API_PREFIX.length).split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [head, id, tail, ...rest] = segments;
  if (rest.length > 0 || segments.some((s) => s === "")) return undefined;
  if (head === UPLOADS) {
    if (id === undefined) return { route: "uploads" };
    if (tail === undefined) return { route: "upload", uploadId: id };
    if (tail === COMPLETE) return { route: "upload_complete", uploadId: id };
  }
  if (head === MEDIA && id !== undefined && tail === undefined) return { route: "media", mediaId: id };
  if (head === CONVERSATIONS && id !== undefined && tail === MESSAGES) return { route: "history", conversation: id };
  if (head === MATERIALS && tail === undefined && id === SCOPE) return { route: "materials_scope" };
  if (head === MATERIALS && tail === undefined && id === DELETE) return { route: "materials_delete" };
  if (head === WORKDAY_CALENDAR && id === undefined) return { route: "workday_calendar" };
  if (head === USAGE && id === undefined) return { route: "usage" };
  if (head === REFERENCE_VOICES) {
    if (id === undefined) return { route: "reference_voices" };
    if (tail === undefined) return { route: "reference_voice", voiceId: id };
    if (tail === SELECT) return { route: "reference_voice_select", voiceId: id };
    if (tail === AUDIO) return { route: "reference_voice_audio", voiceId: id };
  }
  return undefined;
}

/** HTTP 接口错误响应里的错误码 */
export const HTTP_ERROR_CODES = [
  "bad_request",
  "not_found",
  /** 这个地址不支持这个方法 */
  "method_not_allowed",
  /** 超过单文件上限，或者请求体太大 */
  "too_large",
  /** 写分片的偏移和服务端已收到的字节数不一致（响应里带服务端的偏移） */
  "offset_mismatch",
  /** 同一个上传正有另一个分片在写 */
  "busy",
  /** 收尾的 sha256 和收到的原始字节对不上：拒绝，不入库 */
  "sha256_mismatch",
  /** 收尾时还没收全 */
  "incomplete",
  /** 外网端口上没有有效的设备凭证（还没配对、被吊销、太久没用）：只能看页面本身和配对接口（10） */
  "unauthorized",
  /** 不允许这样做（比如配对请求已经不在等批准了，不能再改设备名） */
  "forbidden",
  /** 太频繁了（同一来源 10 分钟内的配对请求超过上限），稍后再试 */
  "too_many_requests",
  "internal",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];
