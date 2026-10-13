// 网关的 HTTP 接口（规格第 5 节）：媒体的分片续传上传、按媒体 id 下载（支持 Range）、文本类附件的内容（113 号票，报告页用）、
// 会话历史分页；
// 设置里按会话、按时间段删除素材（21 号票）；设置里的工作日历：按月看、改个人设置（29 号票）；主导航的日历：按月给出每一天的
// 日历条目（35 号票）；消耗页的汇总（24 号票）；
// 设置里的语音页：参考音色的列出、导入、选用、删除、试听（32 号票）；分段合成里合成好的一段（38 号票）；
// 两个语音模型的状态（45 号票：模型预热）。
// 工具包里能选的东西（skill 库、登记的 MCP）和设置里的 skill 库页导入 skill（27 号票；导入并改名、整套导入集合，72 号票）、
// 看和改秘书用的 skill（72 号票）。设置里改个人助理的名字（43 号票）。
// 一个会话能用的斜杠命令（输入框里打 / 弹出的候选，82 号票）。
// 按调用 id 取一次工具调用的完整参数和返回（53 号票，详情页用）。设置里的工具调用完整内容：占了多大、"现在就清理"（65 号票）。
// 设置里的系统提示：全部、一份、保存、恢复默认（71 号票）。
// 设置里的"模型"：取、整份存、连通测试（73 号票；API key 只有状态，接口里没有 key 的内容，请求体也放不进 key）。
// 长程任务一个阶段的授权已用几次、从这里重做的范围和已经做了的事（84 号票，阶段详情用）。
// 路径怎么拆、查询参数叫什么都从共享协议包取（http.ts 的 parseHttpPath、HTTP_QUERY），请求体和响应体见 http-schema.ts。
// 来源校验（Host、Origin）在网关入口已经做过。
// 错误一律按协议的错误码回；错误码到 HTTP 状态码的对应只有下面 STATUS_OF 这一张表。
import fs from "node:fs";
import type http from "node:http";
import {
  ASSISTANT_NAME_MARK,
  AssistantNameBody,
  checkHttpBody,
  CompleteUploadBody,
  CreateUploadBody,
  DeleteMaterialsBody,
  type HttpErrorBody,
  type HttpErrorCode,
  type HttpRoute,
  HTTP_QUERY,
  ImportReferenceVoiceBody,
  ImportSkillBody,
  SecretarySkillsBody,
  isMediaId,
  ModelSettingsBody,
  ModelTestBody,
  LocalDate,
  MaterialScopeBody,
  MEDIA_TEXT_MAX_BYTES,
  type MediaTextView,
  parseHttpPath,
  parseLocalDate,
  REFERENCE_VOICE_MAX_BYTES,
  schemaChecker,
  SystemPromptBody,
  type SlashCommandList,
  type TaskStageView,
  textPreviewOf,
  type VoiceModelsView,
  WorkdayChangeBody,
} from "@ergou/protocol";
import type { AssistantNameService } from "../assistant/index.ts";
import type { CalendarService } from "../calendar/calendar.ts";
import { latestAttachment } from "../conversation/attachments-view.ts";
import { historyPage, isConversationChannel } from "../conversation/history.ts";
import { RequestRejected } from "../errors.ts";
import type { BulkMaterialDeletion } from "../memory/index.ts";
import type { SecretarySkills } from "../skills/secretary-skills.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ToolCallDetailRetention } from "../guard-runtime/detail-retention.ts";
import { findToolCallDetail } from "../guard-runtime/tool-call-details.ts";
import type { TokenLedger } from "../ledger/index.ts";
import { decodeUtf8 } from "../media/file-types.ts";
import { MediaError, type MediaStore } from "../media/media-store.ts";
import type { PromptLibrary } from "../prompts/index.ts";
import type { ModelSettingsService } from "../model-settings/index.ts";
import type { ReferenceVoices } from "../voice/index.ts";
import type { ToolkitService } from "../toolkit/toolkit.ts";
import type { WorkdayCalendarService } from "../workday/index.ts";

/** 错误码 → HTTP 状态码 */
const STATUS_OF: Readonly<Record<HttpErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  too_large: 413,
  offset_mismatch: 409,
  busy: 409,
  sha256_mismatch: 422,
  incomplete: 409,
  unauthorized: 401,
  forbidden: 403,
  too_many_requests: 429,
  unsupported_type: 415,
  undecodable: 422,
  internal: 500,
};

/** 网关自己判出来的错误（参数不对、地址不对……）；媒体库的错误是 MediaError，两者都按错误码回 */
export class HttpError extends Error {
  readonly code: HttpErrorCode;
  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HttpApiOptions {
  media: MediaStore;
  /** 事件存储：历史分页、工具调用的完整内容、报告页认附件的名字和类型（113 号票）从这里读 */
  store: EventStore;
  /** 设置里按会话、按时间段删除素材 */
  materialDeletion: BulkMaterialDeletion;
  /** 设置里的工作日历：按月看、改个人设置 */
  workdayCalendar: WorkdayCalendarService;
  /** 设置里的个人助理的名字：改名（43 号票） */
  assistantName: AssistantNameService;
  /** 主导航的日历：按月给出每一天的日历条目（35 号票） */
  calendar: CalendarService;
  /** token 账本：消耗页的汇总和粗估成本 */
  ledger: TokenLedger;
  /** 参考音色（设置里的语音页） */
  referenceVoices: ReferenceVoices;
  /** 分段合成里合成好的一段的文件（38 号票）；没有是 undefined */
  agentVoiceSegment: (voiceId: string, index: number) => string | undefined;
  /** 两个语音模型现在的状态和识别引擎的清单（45 号票）；不给就没有这个接口 */
  voiceModels?: () => VoiceModelsView;
  /** 工具包：skill 库和登记的 MCP、导入 skill（27、72 号票）；不给就没有这两个接口 */
  toolkits?: Pick<ToolkitService, "catalog" | "importSkill">;
  /** 秘书用的 skill（72 号票）：设置里的 skill 库页看、改；不给就没有这个接口 */
  secretarySkills?: Pick<SecretarySkills, "view" | "set">;
  /** 这个会话能用的斜杠命令（82 号票）；没有这个会话时 undefined；不给就没有这个接口 */
  slashCommands?: (conversation: string) => SlashCommandList | undefined;
  /** 工具调用完整内容的保留期和总量上限：设置里看占了多大、"现在就清理"（65 号票）；不给就没有这两个接口 */
  toolCallStorage?: Pick<ToolCallDetailRetention, "view" | "cleanup">;
  /** 设置里的系统提示：全部、一份、保存、恢复默认（71 号票）；不给就没有这几个接口 */
  systemPrompts?: Pick<PromptLibrary, "list" | "detail" | "save" | "reset">;
  /** 设置里的"模型"（73 号票）；不给就没有这两个接口 */
  modelSettings?: Pick<ModelSettingsService, "view" | "change" | "test">;
  /** 长程任务一个阶段的授权已用几次、从这里重做的范围和已经做了的事（84 号票）；没有这个任务或阶段时 undefined；不给就没有这个接口 */
  taskStage?: (taskId: string, stageId: string) => TaskStageView | undefined;
  log: (line: string) => void;
}

const localDateShape = schemaChecker(LocalDate);

/** 协议包的本地日期（YYYY-MM-DD），而且这一天存在 */
function isLocalDate(value: string): boolean {
  if (!localDateShape.check(value)) return false;
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

/** JSON 请求体的上限 */
const MAX_JSON_BODY = 64 * 1024;
/** 保存系统提示的请求体上限（71 号票）：秘书的提示有一万多字节，留足余量 */
const MAX_PROMPT_BODY = 1024 * 1024;
/** 导入参考音色的请求体上限：录音的 base64（比原文件大三分之一）加上名字和逐字稿 */
const MAX_REFERENCE_VOICE_BODY = Math.ceil((REFERENCE_VOICE_MAX_BYTES * 4) / 3) + MAX_JSON_BODY;

/** 处理 /api/ 下的请求 */
export type HttpApi = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;

export function createHttpApi(options: HttpApiOptions): HttpApi {
  const { media, store, log } = options;

  /** 每个接口支持的方法和处理函数（HEAD 按 GET 处理） */
  const handlersOf = (route: HttpRoute): Partial<Record<string, Handler>> => {
    switch (route.route) {
      case "uploads":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CreateUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `建上传的参数不对：${body.message}`);
            sendJson(res, 201, media.createUpload(body.value));
          },
        };
      case "upload":
        return {
          async GET(_req, res) {
            sendJson(res, 200, await media.uploadStatus(route.uploadId));
          },
          async PUT(req, res, url) {
            const offset = Number(url.searchParams.get(HTTP_QUERY.offset));
            if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError("bad_request", `写分片要带偏移：?${HTTP_QUERY.offset}=<非负整数>`);
            sendJson(res, 200, await media.writeChunk(route.uploadId, offset, req));
          },
        };
      case "upload_complete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CompleteUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `收尾的参数不对：${body.message}`);
            sendJson(res, 200, await media.completeUpload(route.uploadId, body.value.sha256));
          },
        };
      case "media":
        return { GET: (req, res, url) => serveMedia(req, res, route.mediaId, url) };
      case "media_text":
        return {
          // 文本类附件的内容（113 号票，报告页用）：只回 JSON，不让浏览器直接渲染文件
          GET(_req, res) {
            sendJson(res, 200, mediaText(route.mediaId));
          },
        };
      case "history":
        return {
          GET(_req, res, url) {
            if (!isConversationChannel(route.conversation)) throw new HttpError("not_found", `没有这个会话：${route.conversation}`);
            const before = optionalInt(url, HTTP_QUERY.before, 1);
            const limit = optionalInt(url, HTTP_QUERY.limit, 1);
            sendJson(res, 200, historyPage(store, route.conversation, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }));
          },
        };
      case "slash_commands":
        return {
          // 输入框里打 / 弹出的候选（82 号票）：工具包随时会变，每次现算
          GET(_req, res) {
            if (!options.slashCommands) throw new HttpError("not_found", "这个版本还没有斜杠命令的候选");
            const list = isConversationChannel(route.conversation) ? options.slashCommands(route.conversation) : undefined;
            if (!list) throw new HttpError("not_found", `没有这个会话：${route.conversation}`);
            sendJson(res, 200, list);
          },
        };
      case "materials_scope":
        return {
          async POST(req, res) {
            const body = checkHttpBody(MaterialScopeBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", `素材范围不对：${body.message}`);
            sendJson(res, 200, options.materialDeletion.summary(body.value.scope));
          },
        };
      case "materials_delete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(DeleteMaterialsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `删除素材的参数不对：${body.message}`);
            sendJson(res, 200, options.materialDeletion.delete(body.value.scope, body.value.mode, body.value.idempotencyKey));
          },
        };
      case "workday_calendar":
        return {
          GET(_req, res, url) {
            sendJson(res, 200, options.workdayCalendar.month(url.searchParams.get(HTTP_QUERY.month) ?? ""));
          },
          async POST(req, res) {
            const body = checkHttpBody(WorkdayChangeBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `改工作日历的参数不对：${body.message}`);
            sendJson(res, 200, options.workdayCalendar.change(body.value.change, "settings"));
          },
        };
      case "assistant_name":
        return {
          async POST(req, res) {
            const body = checkHttpBody(AssistantNameBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `改名的参数不对：${body.message}`);
            sendJson(res, 200, options.assistantName.change(body.value.name, "settings"));
          },
        };
      case "calendar":
        return {
          GET(_req, res, url) {
            sendJson(res, 200, options.calendar.month(url.searchParams.get(HTTP_QUERY.month) ?? ""));
          },
        };
      case "usage":
        return {
          GET(_req, res, url) {
            const from = url.searchParams.get(HTTP_QUERY.from) ?? "";
            const to = url.searchParams.get(HTTP_QUERY.to) ?? "";
            if (!isLocalDate(from) || !isLocalDate(to)) throw new HttpError("bad_request", `消耗页的范围要写成 ?${HTTP_QUERY.from}=YYYY-MM-DD&${HTTP_QUERY.to}=YYYY-MM-DD（日期要存在）`);
            if (from > to) throw new HttpError("bad_request", `范围的起点 ${from} 在终点 ${to} 之后`);
            sendJson(res, 200, options.ledger.summary({ from, to }));
          },
        };
      case "reference_voices":
        return {
          GET(_req, res) {
            sendJson(res, 200, options.referenceVoices.list());
          },
          async POST(req, res) {
            const body = checkHttpBody(ImportReferenceVoiceBody, await readJson(req, MAX_REFERENCE_VOICE_BODY));
            if (!body.ok) throw new HttpError("bad_request", `导入参考音色的参数不对：${body.message}`);
            const { name, referenceText, audioBase64 } = body.value;
            const { voice, created } = options.referenceVoices.import({ name, referenceText, audio: Buffer.from(audioBase64, "base64") });
            sendJson(res, created ? 201 : 200, voice);
          },
        };
      case "reference_voice":
        return {
          DELETE(_req, res) {
            sendJson(res, 200, options.referenceVoices.remove(route.voiceId));
          },
        };
      case "reference_voice_select":
        return {
          POST(_req, res) {
            sendJson(res, 200, options.referenceVoices.select(route.voiceId));
          },
        };
      case "reference_voice_audio":
        return {
          // 试听：和媒体同一套发文件（支持 Range）；参考录音会被删掉，不缓存
          GET(req, res) {
            const file = options.referenceVoices.audioPath(route.voiceId);
            const size = file === undefined ? undefined : fileSize(file);
            if (file === undefined || size === undefined) throw new HttpError("not_found", `没有这个参考音色：${route.voiceId}`);
            serveFile(req, res, { file, size, label: `参考音色 ${route.voiceId}`, headers: { "Cache-Control": "no-store", "Content-Type": "audio/wav", "Content-Disposition": "inline" } });
          },
        };
      case "agent_voice_segment":
        return {
          // 分段合成的一段（38 号票）：临时的，合成完了过一阵就删；重做时同一段的内容会变，不缓存
          GET(req, res) {
            const file = options.agentVoiceSegment(route.voiceId, route.index);
            const size = file === undefined ? undefined : fileSize(file);
            if (file === undefined || size === undefined) throw new HttpError("not_found", `没有这一段语音：${route.voiceId} 第 ${route.index} 段`);
            serveFile(req, res, { file, size, label: `语音 ${route.voiceId} 第 ${route.index} 段`, headers: { "Cache-Control": "no-store", "Content-Type": "audio/wav", "Content-Disposition": "inline" } });
          },
        };
      case "voice_models":
        return {
          // 两个语音模型现在的状态（会变，不缓存）
          GET(_req, res) {
            if (!options.voiceModels) throw new HttpError("not_found", "这个版本还没有语音模型的状态");
            sendJson(res, 200, options.voiceModels());
          },
        };
      case "toolkit_catalog":
        return {
          GET(_req, res) {
            if (!options.toolkits) throw new HttpError("not_found", "这个版本还没有工具包");
            sendJson(res, 200, options.toolkits.catalog());
          },
        };
      case "skill_import":
        return {
          async POST(req, res) {
            if (!options.toolkits) throw new HttpError("not_found", "这个版本还没有 skill 库");
            const body = checkHttpBody(ImportSkillBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `导入 skill 的参数不对：${body.message}`);
            sendJson(res, 200, options.toolkits.importSkill(body.value));
          },
        };
      case "secretary_skills":
        return {
          // 秘书用的 skill（72 号票）：现读设置文件
          GET(_req, res) {
            if (!options.secretarySkills) throw new HttpError("not_found", `这个版本的${ASSISTANT_NAME_MARK}还不能用 skill`);
            sendJson(res, 200, options.secretarySkills.view());
          },
          // 整份名单（改动本身幂等，不带幂等键）：只能选 skill 库里有的；改了之后秘书做完手头这一条就按新名单重新装配
          async POST(req, res) {
            if (!options.secretarySkills) throw new HttpError("not_found", `这个版本的${ASSISTANT_NAME_MARK}还不能用 skill`);
            const body = checkHttpBody(SecretarySkillsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `${ASSISTANT_NAME_MARK}用的 skill 的参数不对：${body.message}`);
            sendJson(res, 200, options.secretarySkills.set(body.value.skills));
          },
        };
      case "tool_call":
        return {
          // 一次工具调用的完整参数和返回（53 号票）：调用结束时另存的那份（已经过隐私处理和截断）
          GET(_req, res) {
            const detail = findToolCallDetail(store, route.callId);
            if (!detail) throw new HttpError("not_found", `没有这次工具调用的完整内容：${route.callId}`);
            sendJson(res, 200, detail);
          },
        };
      case "task_stage":
        return {
          // 长程任务的阶段详情（84 号票）：每次打开现取
          GET(_req, res) {
            const view = options.taskStage?.(route.taskId, route.stageId);
            if (!view) throw new HttpError("not_found", `没有任务 ${route.taskId} 的阶段 ${route.stageId}`);
            sendJson(res, 200, view);
          },
        };
      case "tool_call_storage":
        return {
          // 设置里的"工具调用的完整内容"：占了多大、规则、照现在的规则马上清会清掉多少（65 号票）
          GET(_req, res) {
            if (!options.toolCallStorage) throw new HttpError("not_found", "这个版本还没有工具调用完整内容的清理");
            sendJson(res, 200, options.toolCallStorage.view());
          },
        };
      case "tool_call_storage_cleanup":
        return {
          // "现在就清理"：按现在的规则马上清一次（前端点之前已经确认过）；再点一次没有可清的就什么都不做
          async POST(_req, res) {
            if (!options.toolCallStorage) throw new HttpError("not_found", "这个版本还没有工具调用完整内容的清理");
            sendJson(res, 200, await options.toolCallStorage.cleanup("manual"));
          },
        };
      case "system_prompts":
        return {
          // 设置里的系统提示（71 号票）：全部，各自用的是默认还是改过的（每次现读文件，不缓存）
          GET(_req, res) {
            sendJson(res, 200, systemPrompts().list());
          },
        };
      case "system_prompt":
        return {
          GET(_req, res) {
            sendJson(res, 200, systemPrompts().detail(route.id));
          },
          // 保存：占位符写错的拒收（400，message 写明第几行错在哪）
          async PUT(req, res) {
            const body = checkHttpBody(SystemPromptBody, await readJson(req, MAX_PROMPT_BODY));
            if (!body.ok) throw new HttpError("bad_request", `保存系统提示的参数不对：${body.message}`);
            sendJson(res, 200, systemPrompts().save(route.id, body.value.content));
          },
          // 恢复默认：删掉用户改的那份
          DELETE(_req, res) {
            sendJson(res, 200, systemPrompts().reset(route.id));
          },
        };
      case "model_settings":
        return {
          // 设置里的"模型"（73 号票）：服务商登记表、API key 的状态（只说配没配、从哪来）、可选的模型和看图能力、设置
          async GET(_req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", "这个版本还没有模型设置");
            sendJson(res, 200, await options.modelSettings.view());
          },
          // 整份存：查过合规再写（不合规回 400），下一个新会话起生效
          async POST(req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", "这个版本还没有模型设置");
            const body = checkHttpBody(ModelSettingsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `模型设置的参数不对：${body.message}`);
            sendJson(res, 200, await options.modelSettings.change(body.value));
          },
        };
      case "model_settings_test":
        return {
          // 连通测试：发一条极短的请求（在一次性子进程里，守护进程自己不跑模型），回通不通、首 token 延迟。
          // 同一时间只跑一个：上一个还没测完时回 409"上一个还没测完"
          async POST(req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", "这个版本还没有模型设置");
            const body = checkHttpBody(ModelTestBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", `连通测试的参数不对：${body.message}`);
            let result;
            try {
              result = await options.modelSettings.test(body.value.modelId);
            } catch (err) {
              if (err instanceof RequestRejected && err.code === "conflict") throw new HttpError("busy", err.message);
              throw err;
            }
            sendJson(res, 200, result);
          },
        };
    }
  };

  const systemPrompts = () => {
    if (!options.systemPrompts) throw new HttpError("not_found", "这个版本还没有系统提示的设置");
    return options.systemPrompts;
  };

  /** 发一个文件（支持单个字节区间的 Range）：headers 是类型、缓存这些，长度和区间在这里算 */
  const serveFile = (req: http.IncomingMessage, res: http.ServerResponse, f: { file: string; size: number; label: string; headers: Record<string, string> }) => {
    const range = parseRange(req.headers.range, f.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${f.size}` });
      return void res.end();
    }
    const [start, end] = range ?? [0, f.size - 1];
    const length = f.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...SECURITY_HEADERS,
      ...f.headers,
      "Accept-Ranges": "bytes",
      "Content-Length": String(length),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${f.size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) return void res.end();
    const stream = fs.createReadStream(f.file, { start, end });
    stream.on("error", (err) => {
      log(`读${f.label} 出错：${err.message}`);
      res.destroy();
    });
    stream.pipe(res);
  };

  const serveMedia = (req: http.IncomingMessage, res: http.ServerResponse, mediaId: string, url: URL) => {
    const info = isMediaId(mediaId) ? media.info(mediaId) : undefined;
    if (!info) throw new HttpError("not_found", `没有这个媒体：${mediaId}`);
    const name = url.searchParams.get(HTTP_QUERY.name) ?? mediaId;
    // 只有认得的图片在页面里直接显示、认得的音频直接播放（语音消息，31 号票），类型是按内容认出的；
    // 其他一律作为附件下载，不按前端声明的类型发出（免得 HTML、SVG 在本机源下跑脚本）
    const inlineType = info.image?.mime ?? info.audio?.mime;
    const inline = inlineType !== undefined && url.searchParams.get(HTTP_QUERY.download) !== "1";
    serveFile(req, res, {
      file: media.filePath(mediaId),
      size: info.size,
      label: `媒体 ${mediaId}`,
      headers: {
        // 媒体按内容寻址，内容永远不变
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${mediaId}"`,
        "Content-Type": inline ? inlineType : "application/octet-stream",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", name),
      },
    });
  };

  /**
   * 文本类附件的内容（113 号票）：只按媒体 id 取（内容寻址，不接受路径）；名字、类型以消息里最近一次引用它的 part 为准，
   * 能预览的（协议包的 textPreviewOf：Markdown、纯文本）才给。超过上限的只读开头那么多（截在字符边上）；
   * 只按 UTF-8 解，解不出来如实报错，不猜编码、不吐乱码
   */
  const mediaText = (mediaId: string): MediaTextView => {
    const attachment = isMediaId(mediaId) ? latestAttachment(store.reader, mediaId) : undefined;
    if (!attachment) throw new HttpError("not_found", `没有这个附件：${mediaId}`);
    const { name, mime } = attachment;
    const info = media.info(mediaId);
    if (!info) throw new HttpError("not_found", `附件「${name}」的文件不在了`);
    if (attachment.kind !== "file" || !textPreviewOf(attachment)) throw new HttpError("unsupported_type", `附件「${name}」是 ${mime}，不能预览，只能下载`);
    const truncated = info.size > MEDIA_TEXT_MAX_BYTES;
    const text = decodeUtf8(media.readHead(mediaId, MEDIA_TEXT_MAX_BYTES), { cut: truncated });
    if (text === undefined) throw new HttpError("undecodable", `附件「${name}」不是 UTF-8 编码的文本，预览不了；请下载后用本机的程序打开`);
    return { mediaId, name, mime, text, bytes: info.size, truncated, sentAt: attachment.time };
  };

  return (req, res, url) => {
    const route = parseHttpPath(url.pathname);
    const handlers = route ? handlersOf(route) : undefined;
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const handler = handlers?.[method];
    const run = (): Promise<void> | void => {
      if (!handlers) throw new HttpError("not_found", "没有这个地址");
      if (!handler) throw new HttpError("method_not_allowed", `这个地址不支持 ${req.method}`);
      return handler(req, res, url);
    };
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        // 没读的请求体扔掉，连接才能接着用
        req.resume();
        if (err instanceof MediaError || err instanceof HttpError) return sendError(res, err.code, err.message, err instanceof MediaError ? err.offset : undefined);
        if (err instanceof RequestRejected) return sendError(res, err.code === "not_found" ? "not_found" : "bad_request", err.message);
        log(`处理 ${req.method} ${url.pathname} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        sendError(res, "internal", "守护进程内部出错");
      });
  };
}

/** JSON 响应和下载都带的安全响应头（本机端口、外网端口一样） */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // 下载的内容即使被当成页面打开，也不能跑脚本、不能发请求
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
} as const;

/** 回 JSON（带安全响应头、不缓存）；本机端口和外网端口的 JSON 响应都走这里 */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 回错误：状态码只由 STATUS_OF 按错误码定 */
export function sendError(res: http.ServerResponse, code: HttpErrorCode, message: string, offset?: number): void {
  const body: HttpErrorBody = { code, message, ...(offset === undefined ? {} : { offset }) };
  sendJson(res, STATUS_OF[code], body);
}

/** 查询参数里可选的整数（不小于 min）；格式不对回 400 */
function optionalInt(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) throw new HttpError("bad_request", `${name} 必须是不小于 ${min} 的整数`);
  return value;
}

function readJson(req: http.IncomingMessage, limit = MAX_JSON_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError("too_large", "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        reject(new HttpError("bad_request", "请求体不是合法的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 文件的大小（不在了是 undefined） */
function fileSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

/** 解析 Range 头：只支持单个字节区间；多个区间时整个发（200），不能满足时 416 */
function parseRange(header: string | undefined, size: number): [number, number] | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  let start: number;
  let end: number;
  if (a === "") {
    // 最后 n 个字节
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}

/** Content-Disposition：ASCII 的退路名加 UTF-8 的真名（RFC 6266 / 5987） */
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
