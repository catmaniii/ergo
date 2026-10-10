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
// 主导航的日历（35 号票）：GET /api/calendar?month=2026-10 按月给出每一天的日历条目——上班或休息及原因、当天的简单提醒、
// 当天的定时作业（时间表展开到当天，跑过的带着这一次的结果），连同算的时候任务看板、工作日历两个频道的序号（前端据此知道旧没旧）。
//
// 消耗页（24 号票）：GET /api/usage?from=2026-10-01&to=2026-10-08 选定范围（含两头）按天、按 agent 的 token 汇总，
// 秘书单列为系统开销，成本是用量乘配置里的单价（每次现读配置，粗估）。
//
// 设置里的语音页（32 号票）：参考音色（个人数据，数据目录的 voices 区）。GET /api/reference-voices 列出来（和现在用哪一个）；
// POST /api/reference-voices 导入一个（名字、逐字稿、WAV 的 base64，同样的录音和名字再导一次拿到同一个）；
// POST /api/reference-voices/<id>/select 选它；DELETE /api/reference-voices/<id> 删掉；GET /api/reference-voices/<id>/audio 试听参考录音。
//
// 设置里的个人助理的名字（43 号票）：POST /api/assistant-name 改名（请求体 { name }，按 checkAssistantName 的规则查，
// 不合规回 400）。改动本身是幂等的（同样的名字再改没有变化），所以不带幂等键；改了之后名字频道上推一条 assistant_name 事件。
// 现在的名字从频道上来（前端一打开就订阅），不另设 GET。
//
// 分段合成（38 号票）：GET /api/agent-voices/<agent 语音 id>/segments/<第几段> 取一段合成好的音频（audio/wav，不缓存）。
// 段的音频是临时的：这条语音合成完了，等下一条语音合成完（或者守护进程重启）就删掉，重播、下载用拼好的完整音频（媒体）。
//
// 设置里的 skill 库页（27、72 号票）：GET /api/toolkit-catalog 列出 skill 库（集合显示成一项）和登记的 MCP；
// POST /api/skills/import 导入一个 skill（可以改名）或把一个目录作为集合整套导入；GET、POST /api/skills/secretary 看、改秘书用的 skill
// （整份名单，改动本身幂等，不带幂等键；改了之后秘书做完手头这一条就按新名单重新装配）。
//
// 输入框里打 / 弹出的候选（82 号票）：GET /api/conversations/<会话>/slash-commands 给出这个会话能用的斜杠命令
// （二狗自己的命令和这个会话能用的 skill，SlashCommandList），每次弹出时现取（工具包随时会变）。
//
// 工具调用的完整参数和返回（53 号票，详情页用）：GET /api/tool-calls/<调用 id> 取 ToolCallDetail（http-schema.ts）。
// 调用 id 就是聊天里工具调用 part 的 callId（按 encodeURIComponent 写进路径，什么字符都行）；没有这次调用的完整内容
// （本票之前的调用、不是经守卫的调用）回 404。消息里的工具调用 part 照旧只带摘要。
// 向后兼容：以后只加可选字段，前端认不得的字段不管、没有的可选字段当作没有。
// 完整内容有保留期和总量上限（65 号票）：过了保留期的、超出总量上限时从最旧的起，只剩摘要（ToolCallDetail.cleared 注明原因），
// 接口照样回 200。设置里：GET /api/tool-call-storage 看占了多大、保留多久、照现在的规则清会清掉多少（ToolCallStorageView）；
// POST /api/tool-call-storage/cleanup 是"现在就清理"：按现在的规则马上清一次（不带请求体，再点一次没有可清的就什么都不做，
// 所以不带幂等键），回清了多少（ToolCallCleanupResult）。
//
// 设置里的系统提示（71 号票，请求体和响应体见 system-prompt-schema.ts）：GET /api/system-prompts 列出全部；
// GET /api/system-prompts/<编号> 取一份；PUT 保存（{ content }，占位符写错回 400）；DELETE 恢复默认。改动本身是幂等的
// （同样的内容再存一遍、已经是默认的再恢复默认都没有变化），所以不带幂等键。

/** 单个文件的默认上限（字节）：200 MB，数据目录的配置里可以改（media.maxUploadBytes） */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 工具调用的完整参数和返回里单个值的上限（UTF-8 字节，53 号票）：返回的文字、参数里的每个字符串各算一个值，
 * 超过的只留开头这么多，末尾注明"已截断"和原长（ToolCallDetail.truncated 里也列出）
 */
export const TOOL_CALL_VALUE_MAX_BYTES = 200 * 1024;

/**
 * 完整内容为什么清掉了（65 号票，ToolCallDetail.cleared.reason）：过了保留期（expired）、超出总量上限时从最旧的清（over_limit）。
 * 清掉的只是完整参数和返回，只剩摘要；工具调用记录、效果记录、时间线照旧
 */
export const TOOL_CALL_CLEAR_REASONS = ["expired", "over_limit"] as const;
export type ToolCallClearReason = (typeof TOOL_CALL_CLEAR_REASONS)[number];

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
  /** 工作日历、日历：哪个月（YYYY-MM） */
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
const SLASH_COMMANDS = "slash-commands";
const MATERIALS = "materials";
const SCOPE = "scope";
const DELETE = "delete";
const WORKDAY_CALENDAR = "workday-calendar";
const CALENDAR = "calendar";
const USAGE = "usage";
const REFERENCE_VOICES = "reference-voices";
const SELECT = "select";
const AUDIO = "audio";
const AGENT_VOICES = "agent-voices";
const SEGMENTS = "segments";
const TOOLKIT_CATALOG = "toolkit-catalog";
const SKILLS = "skills";
const IMPORT = "import";
const SECRETARY = "secretary";
const ASSISTANT_NAME = "assistant-name";
const TOOL_CALLS = "tool-calls";
const VOICE_MODELS = "voice-models";
const TOOL_CALL_STORAGE = "tool-call-storage";
const CLEANUP = "cleanup";
const SYSTEM_PROMPTS = "system-prompts";

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
  /** 这个会话能用的斜杠命令：二狗自己的命令和 skill（GET，响应 SlashCommandList，82 号票） */
  slashCommands: (conversation: string) => api(CONVERSATIONS, conversation, SLASH_COMMANDS),
  /** 素材范围里有几条（POST，请求体 MaterialScopeBody） */
  materialsScope: api(MATERIALS, SCOPE),
  /** 对范围内的全部素材执行一种删法（POST，请求体 DeleteMaterialsBody） */
  materialsDelete: api(MATERIALS, DELETE),
  /** 工作日历：改个人设置（POST，请求体 WorkdayChangeBody，响应 WorkdayChangeResult） */
  workdayCalendar: api(WORKDAY_CALENDAR),
  /** 工作日历：某个月（YYYY-MM）每天上班或休息及原因（GET，响应 WorkdayMonthView） */
  workdayMonth: (month: string) => `${api(WORKDAY_CALENDAR)}${query({ [HTTP_QUERY.month]: month })}`,
  /** 日历：某个月（YYYY-MM）每一天的日历条目（GET，响应 CalendarMonthView，35 号票） */
  calendarMonth: (month: string) => `${api(CALENDAR)}${query({ [HTTP_QUERY.month]: month })}`,
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
  /** 分段合成里合成好的一段音频（GET，audio/wav，38 号票）：index 是第几段（0 起） */
  agentVoiceSegment: (voiceId: string, index: number) => api(AGENT_VOICES, voiceId, SEGMENTS, String(index)),
  /** 工具包里能选的东西：skill 库和登记的 MCP（GET，响应 ToolkitCatalog，27 号票） */
  toolkitCatalog: api(TOOLKIT_CATALOG),
  /** 设置里的 skill 库页导入一个 skill 或一个集合（POST，请求体 ImportSkillBody，响应 ImportSkillResult，27、72 号票） */
  skillImport: api(SKILLS, IMPORT),
  /** 秘书用的 skill：GET 看（SecretarySkillsView），POST 改（请求体 SecretarySkillsBody，响应 SecretarySkillsView），72 号票 */
  secretarySkills: api(SKILLS, SECRETARY),
  /** 改个人助理的名字（POST，请求体 AssistantNameBody，响应 AssistantNameResult，43 号票） */
  assistantName: api(ASSISTANT_NAME),
  /** 一次工具调用的完整参数和返回（GET，响应 ToolCallDetail，53 号票）：callId 是工具调用 part 的 callId */
  toolCall: (callId: string) => api(TOOL_CALLS, callId),
  /** 设置里：工具调用的完整内容占了多大、保留多久、照现在的规则清会清掉多少（GET，响应 ToolCallStorageView，65 号票） */
  toolCallStorage: api(TOOL_CALL_STORAGE),
  /** 设置里的"现在就清理"：按现在的规则马上清一次（POST，不带请求体，响应 ToolCallCleanupResult，65 号票） */
  toolCallStorageCleanup: api(TOOL_CALL_STORAGE, CLEANUP),
  /** 语音识别模型、合成模型现在的状态和识别引擎的清单（GET，响应 VoiceModelsView，45 号票）；变了另经活动状态频道推 voice_models */
  voiceModels: api(VOICE_MODELS),
  /** 设置里的系统提示：全部（GET，响应 SystemPromptList，71 号票） */
  systemPrompts: api(SYSTEM_PROMPTS),
  /** 一份系统提示：GET 取（SystemPromptDetail）、PUT 保存（请求体 SystemPromptBody）、DELETE 恢复默认，响应都是 SystemPromptDetail */
  systemPrompt: (id: string) => api(SYSTEM_PROMPTS, id),
} as const;

/** 拆出来的 HTTP 接口路径（和 HTTP_PATHS 一一对应） */
export type HttpRoute =
  | { route: "uploads" }
  | { route: "upload"; uploadId: string }
  | { route: "upload_complete"; uploadId: string }
  | { route: "media"; mediaId: string }
  | { route: "history"; conversation: string }
  | { route: "slash_commands"; conversation: string }
  | { route: "materials_scope" }
  | { route: "materials_delete" }
  | { route: "workday_calendar" }
  | { route: "calendar" }
  | { route: "usage" }
  | { route: "reference_voices" }
  | { route: "reference_voice"; voiceId: string }
  | { route: "reference_voice_select"; voiceId: string }
  | { route: "reference_voice_audio"; voiceId: string }
  | { route: "agent_voice_segment"; voiceId: string; index: number }
  | { route: "toolkit_catalog" }
  | { route: "skill_import" }
  | { route: "secretary_skills" }
  | { route: "assistant_name" }
  | { route: "tool_call"; callId: string }
  | { route: "tool_call_storage" }
  | { route: "tool_call_storage_cleanup" }
  | { route: "voice_models" }
  | { route: "system_prompts" }
  | { route: "system_prompt"; id: string };

/** 把请求的路径（不含查询串）拆成接口和参数；不是 HTTP 接口的路径返回 undefined */
export function parseHttpPath(pathname: string): HttpRoute | undefined {
  if (!pathname.startsWith(HTTP_API_PREFIX)) return undefined;
  let segments: string[];
  try {
    segments = pathname.slice(HTTP_API_PREFIX.length).split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [head, id, tail, item, ...rest] = segments;
  if (rest.length > 0 || segments.some((s) => s === "")) return undefined;
  // 四截的只有分段合成的一段
  if (item !== undefined) {
    if (head === AGENT_VOICES && id !== undefined && tail === SEGMENTS && /^\d{1,4}$/.test(item)) return { route: "agent_voice_segment", voiceId: id, index: Number(item) };
    return undefined;
  }
  if (head === UPLOADS) {
    if (id === undefined) return { route: "uploads" };
    if (tail === undefined) return { route: "upload", uploadId: id };
    if (tail === COMPLETE) return { route: "upload_complete", uploadId: id };
  }
  if (head === MEDIA && id !== undefined && tail === undefined) return { route: "media", mediaId: id };
  if (head === CONVERSATIONS && id !== undefined && tail === MESSAGES) return { route: "history", conversation: id };
  if (head === CONVERSATIONS && id !== undefined && tail === SLASH_COMMANDS) return { route: "slash_commands", conversation: id };
  if (head === MATERIALS && tail === undefined && id === SCOPE) return { route: "materials_scope" };
  if (head === MATERIALS && tail === undefined && id === DELETE) return { route: "materials_delete" };
  if (head === WORKDAY_CALENDAR && id === undefined) return { route: "workday_calendar" };
  if (head === CALENDAR && id === undefined) return { route: "calendar" };
  if (head === USAGE && id === undefined) return { route: "usage" };
  if (head === REFERENCE_VOICES) {
    if (id === undefined) return { route: "reference_voices" };
    if (tail === undefined) return { route: "reference_voice", voiceId: id };
    if (tail === SELECT) return { route: "reference_voice_select", voiceId: id };
    if (tail === AUDIO) return { route: "reference_voice_audio", voiceId: id };
  }
  if (head === TOOLKIT_CATALOG && id === undefined) return { route: "toolkit_catalog" };
  if (head === SKILLS && id === IMPORT && tail === undefined) return { route: "skill_import" };
  if (head === SKILLS && id === SECRETARY && tail === undefined) return { route: "secretary_skills" };
  if (head === ASSISTANT_NAME && id === undefined) return { route: "assistant_name" };
  if (head === TOOL_CALLS && id !== undefined && tail === undefined) return { route: "tool_call", callId: id };
  if (head === TOOL_CALL_STORAGE && tail === undefined) {
    if (id === undefined) return { route: "tool_call_storage" };
    if (id === CLEANUP) return { route: "tool_call_storage_cleanup" };
  }
  if (head === VOICE_MODELS && id === undefined) return { route: "voice_models" };
  if (head === SYSTEM_PROMPTS && tail === undefined) return id === undefined ? { route: "system_prompts" } : { route: "system_prompt", id };
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
