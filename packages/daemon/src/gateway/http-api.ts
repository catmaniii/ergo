// 网关的 HTTP 接口（规格第 5 节）：媒体的分片续传上传、按媒体 id 下载（支持 Range）、文本类附件的内容（113 号票，报告页用）、
// HTML、SVG 附件在沙箱里预览用的两个接口（117 号票：带沙箱的 CSP 发出原文）、会话历史分页；
// 设置里按会话、按时间段删除素材（21 号票），看范围里的素材和一条的完整内容（158 号票），"浏览"里存一页网页进素材（165 号票），记忆 · 素材按时间段、种类、会话、关键词取（167 号票，这几样 167 号票起在"记忆"页，不在设置里）；设置里的工作日历：按月看、改个人设置（29 号票）；主导航的日历：按月给出每一天的
// 日历条目（35 号票）；消耗页的汇总（24 号票）；
// 记忆的推理库只读看（233 号票，GET /api/memory/summary、/claims、/claims/<编号>、/questions）：概览、结论列表、一条结论的完整解释、问题箱，
// 库没建、版本对不上、正被每晚整理占着都是 200 加 ready=false 和一句原因（不 500）。
// 设置里的语音页：参考音色的列出、导入、选用、删除、试听（32 号票）；分段合成里合成好的一段（38 号票）；
// 两个语音模型的状态（45 号票：模型预热）。
// 工具包里能选的东西（skill 库、登记的 MCP）和设置里的 skill 库页导入 skill（27 号票；导入并改名、整套导入集合，72 号票）、
// 看和改秘书用的 skill（72 号票）。设置里改个人助理的名字（43 号票）。设置 · 语言、网页的词典、换语言（168 号票）。
// 一个会话能用的斜杠命令（输入框里打 / 弹出的候选，82 号票）。
// 按调用 id 取一次工具调用的完整参数和返回（53 号票，详情页用）。设置里的工具调用完整内容：占了多大、"现在就清理"（65 号票）。
// 设置里的"备份"：现在的状况、"立即备份"（335 号票）。
// 设置里的系统提示：全部、一份、保存、恢复默认（71 号票）。
// 设置里的"模型"：取、整份存、连通测试（73 号票；API key 只有状态，接口里没有 key 的内容，请求体也放不进 key）。
// 首次设置向导：五步各自做完了没有、标"以后再说"/"看过了"（319 号票）。
// 设置里 agent 的联网搜索、读网页走哪条路：取、整份存（154 号票）。
// 长程任务一个阶段的授权已用几次、从这里重做的范围和已经做了的事（84 号票，阶段详情用）。
// 每个 agent 的会话里的 ⚙：面板、单独的提示词（存、恢复用通用模板）、清空当前对话、现在压缩（114 号票）。
// Debug 工具集的语音组：录一段送识别、用当前参考音色合成念一句（124 号票，不经会话）。
// 网页上下指令、要交进上传框的文件、授权的文件夹（134 号票）和设置页选文件夹的框列子文件夹（138 号票）。
// 项目的服务首页的缩略图（140 号票：守护进程自己截的，按项目编号和服务名取）。项目规范的只读视图（258 号票）。
// 路径怎么拆、查询参数叫什么都从共享协议包取（http.ts 的 parseHttpPath、HTTP_QUERY），请求体和响应体见 http-schema.ts。
// 来源校验（Host、Origin）在网关入口已经做过。
// 错误一律按协议的错误码回；错误码到 HTTP 状态码的对应只有下面 STATUS_OF 这一张表。
import fs from "node:fs";
import type http from "node:http";
import {
  AgentClearBody,
  AgentDefaultRoleBody,
  AgentModelBody,
  AgentRuntimeBody,
  TakeoverActionBody,
  TakeOverBody,
  RuntimeFolderBody,
  type WorkFolderCheckResult,
  AgentPromptBody,
  AgentRoleAssignmentBody,
  AgentRoleBody,
  AgentRoleUpdateBody,
  ASSISTANT_NAME_MARK,
  AssistantNameBody,
  UserNameBody,
  AddPersonBody,
  PersonalFileChangeBody,
  PersonalFileDeleteBody,
  MemorySettingsBody,
  SafetySettingsBody,
  SetupMarkBodySchema,
  InterviewStartBody,
  LanguageBody,
  t,
  checkHttpBody,
  CompleteUploadBody,
  CreateUploadBody,
  DEBUG_AUDIO_MAX_BYTES,
  DebugRecognizeBody,
  DebugSpeakBody,
  DeleteMaterialsBody,
  LocalFoldersBody,
  LocalFoldersChangeBody,
  PAGE_COMMAND_AUDIO_MAX_BYTES,
  PageVoiceBody,
  type HttpErrorBody,
  type HttpErrorCode,
  type HttpRoute,
  HTTP_QUERY,
  framePreviewOf,
  type FramePreview,
  HTML_PREVIEW_SANDBOX,
  MEDIA_FRAME_MAX_BYTES,
  ImportReferenceVoiceBody,
  ImportSkillBody,
  SecretarySkillsBody,
  isMediaId,
  ModelSettingsBody,
  ModelKeyBody,
  PluginActionBody,
  DataSourceActionBody,
  DataSourcePushBody,
  ImportFolderActionBody,
  ComponentActionBody,
  ComponentsActionBody,
  ComponentImportBody,
  WebSettingsBody,
  ModelTestBody,
  LocalDate,
  MaterialListBody,
  MaterialScopeBody,
  MEDIA_TEXT_MAX_BYTES,
  MEMORY_CLAIM_STATUSES,
  MEMORY_CLAIM_TIERS,
  type MemoryClaimQuery,
  type MemoryClaimStatus,
  type MemoryClaimTier,
  type MediaTextView,
  type ProjectStandardView,
  parseHttpPath,
  parseLocalDate,
  REFERENCE_VOICE_MAX_BYTES,
  SaveWebPageBody,
  schemaChecker,
  SystemPromptBody,
  type SlashCommandList,
  type TaskStageView,
  type BranchView,
  type RollbackPreview,
  type RollbackTarget,
  textPreviewOf,
  WorkdayChangeBody,
} from "@ergo/protocol";
import type { AgentSettings } from "../agent-settings/index.ts";
import type { TakeoverService } from "../takeover/index.ts";
import type { WorkFolders } from "../work-folders/index.ts";
import type { AssistantNameService } from "../assistant/index.ts";
import type { UserNameService } from "../user-name/index.ts";
import type { PersonalFilesService } from "../personal-files/index.ts";
import type { CalendarService } from "../calendar/api.ts";
import { latestAttachment } from "../conversation/attachments-view.ts";
import { historyPage, isConversationChannel } from "../conversation/history.ts";
import { RequestRejected } from "../errors.ts";
import type { LanguageService } from "../i18n/index.ts";
import type { BulkMaterialDeletion, MaterialBrowser, MemoryGraphReader, MemorySettingsService } from "../memory/index.ts";
import type { MemoryInterviews } from "../memory/api.ts";
import type { SecretarySkills } from "../skills/secretary-skills.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ToolCallDetailRetention } from "../guard-runtime/detail-retention.ts";
import type { BackupService } from "../backup/backup.ts";
import { findToolCallDetail } from "../guard-runtime/tool-call-details.ts";
import type { TokenLedger } from "../ledger/index.ts";
import { decodeUtf8, sizeLabel } from "../media/file-types.ts";
import { sniffImage } from "../media/image.ts";
import { MediaError, type MediaStore } from "../media/media-store.ts";
import type { PromptLibrary } from "../prompts/index.ts";
import type { ModelSettingsService } from "../model-settings/index.ts";
import type { SafetySettingsService } from "../config/safety-settings.ts";
import type { SetupStateService } from "../config/setup-state.ts";
import type { DoctorService } from "../doctor/doctor.ts";
import type { WebSettingsService } from "../web/index.ts";
import type { PluginSettings } from "../plugins/settings.ts";
import type { RuntimeRegistry } from "../runtime/index.ts";
import type { DataSources } from "../data-sources/index.ts";
import type { Components } from "../components/index.ts";
import { AudioConvertError, ReferenceVoiceTranscribeFailed, type VoiceApi, voiceOffReason } from "../voice/api.ts";
import type { ToolkitService } from "../toolkit/toolkit.ts";
import { browsingOff, type BrowsingService } from "../browsing/api.ts";
import type { FolderBrowser } from "../folders/folder-browser.ts";
import type { LocalFolders } from "../folders/local-folders.ts";
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
  // 230 号票：导参考音色时本机的 ffmpeg 不在、识别进程不可用
  service_unavailable: 503,
  internal: 500,
};

/** 被占着、在做一轮（RequestRejected 的 conflict，290 号票的接管、交还、收回）回 409，别的照常 */
async function busyAs409<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RequestRejected && err.code === "conflict") throw new HttpError("busy", err.message);
    throw err;
  }
}

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
  /** 设置里看素材（158）：范围里的素材列表、一条的完整内容和来源 */
  materialBrowser: MaterialBrowser;
  /**
   * 记忆的推理库只读视图（233 号票）：概览、结论列表、一条结论的完整解释、问题箱。和素材一样是内核这一侧的：
   * 记忆插件停用了也能看已有的（这四个接口本身不报"没启用"）。不给就没有这四个接口
   */
  memoryGraph?: MemoryGraphReader;
  /** 记忆的设置（264 号票）：秘书顺口问开不开，GET 取、PUT 整份存；不走事件。不给就没有这个接口 */
  memorySettings?: MemorySettingsService;
  /**
   * 了解你访谈（284 号票，记忆插件的服务，现取）：GET 取现在的样子、POST 开一次（记忆管理员对话里的"开始访谈"，285 号票）。
   * 取到 undefined（记忆插件没启用）回"记忆插件没启用"；不给就没有这个接口
   */
  memoryInterviews?: () => MemoryInterviews | undefined;
  /** 设置里的工作日历：按月看、改个人设置 */
  workdayCalendar: WorkdayCalendarService;
  /** 设置里的个人助理的名字：改名（43 号票） */
  assistantName: AssistantNameService;
  /** 我的名字（249 号票）：用户自己的名字，GET 取、PUT 改（null 或者空串 = 清除）；不走事件 */
  userName: UserNameService;
  /** 个人档案（281 号票）：档案页的列表、一份、加人、改、删；不走前端频道。不给就没有这几个接口 */
  personalFiles?: PersonalFilesService;
  /** 多语言（168 号票）：设置 · 语言、网页的词典、换语言 */
  language: Pick<LanguageService, "list" | "dictionary" | "change">;
  /**
   * 主导航的日历：按月给出每一天的日历条目（35 号票）。213 号票起是日历插件的服务，组合根经插件宿主现取，
   * 日历插件没启用时抛 not_allowed"日历插件没启用"（回 400 带这句）
   */
  calendar: CalendarService;
  /** token 账本：消耗页的汇总和粗估成本 */
  ledger: TokenLedger;
  /**
   * 语音插件的服务（214 号票，现取）：设置里的语音页（参考音色、两个语音模型的状态）、分段合成里合成好的一段（38 号票）、
   * Debug 工具集的语音组（124 号票：录一段送识别、合成念一句）。插件没在运行（回 undefined）、不给时这几个接口回 404"语音插件没启用"
   */
  voice?: () => VoiceApi | undefined;
  /** 工具包：skill 库和登记的 MCP、导入 skill（27、72 号票）；不给就没有这两个接口 */
  toolkits?: Pick<ToolkitService, "catalog" | "importSkill">;
  /** 秘书用的 skill（72 号票）：设置里的 skill 库页看、改；不给就没有这个接口 */
  secretarySkills?: Pick<SecretarySkills, "view" | "set">;
  /** 这个会话能用的斜杠命令（82 号票）；没有这个会话时 undefined；不给就没有这个接口 */
  slashCommands?: (conversation: string) => SlashCommandList | undefined;
  /** 工具调用完整内容的保留期和总量上限：设置里看占了多大、"现在就清理"（65 号票）；不给就没有这两个接口 */
  toolCallStorage?: Pick<ToolCallDetailRetention, "view" | "cleanup">;
  /** 设置里的"备份"（335 号票）：现在的状况、"立即备份"（排一次，不等做完）；不给就没有这两个接口 */
  backup?: Pick<BackupService, "status" | "startNow">;
  /** 设置里的系统提示：全部、一份、保存、恢复默认（71 号票）；不给就没有这几个接口 */
  systemPrompts?: Pick<PromptLibrary, "list" | "detail" | "save" | "reset">;
  /** 设置里的"模型"（73 号票；319 号票起还能在网页上填 key）；不给就没有这几个接口 */
  modelSettings?: Pick<ModelSettingsService, "view" | "change" | "test" | "keyView" | "saveKey">;
  /** 安全和预算的两个开关（315 号票）：GET / PUT /api/safety-settings；不给就没有这个接口 */
  safetySettings?: Pick<SafetySettingsService, "view" | "change">;
  /** 首次设置向导（319 号票）：GET / POST /api/setup（五步各自做完了没有、标"以后再说"/"看过了"）；不给就没有这个接口 */
  setup?: Pick<SetupStateService, "view" | "mark">;
  /** 体检（319 号票的 319b）：GET /api/doctor（八项检查现在的样子，每次现算）；不给就没有这个接口 */
  doctor?: Pick<DoctorService, "view">;
  /** 设置里 agent 的联网搜索、读网页走哪条路（154 号票）；不给就没有这个接口 */
  webSettings?: Pick<WebSettingsService, "view" | "problem" | "change">;
  /** 设置 · 插件（211 号票）：列出、运行中停用、启用、移除；不给就没有这两个接口 */
  plugins?: PluginSettings;
  /** agent 运行时的登记表（286 号票）：GET /api/runtimes 列出登记了的运行时；不给就回一个空的清单 */
  runtimes?: Pick<RuntimeRegistry, "view">;
  /** 从运行时已有的会话接管（290 号票）：列本机会话、接管成任务或项目；不给就没有这两个接口 */
  takeover?: Pick<TakeoverService, "sessions" | "takeOver">;
  /** 新建时的默认工作文件夹（305 号票）：PUT /api/runtimes/<运行时>/work-folder；不给就没有这个接口 */
  workFolders?: Pick<WorkFolders, "setDefault" | "check">;
  /** 设置 · 数据源（295 号票）：GET /api/data-sources、POST /api/data-sources/<id>、POST /api/import-folder；不给就没有这几个接口 */
  dataSources?: Pick<DataSources, "view" | "act" | "folder" | "push">;
  /** 设置 · 组件（323 号票）：GET / POST /api/components、POST /api/components/<id>、POST /api/component-import；不给就没有这几个接口 */
  components?: Pick<Components, "view" | "act" | "installDefaults" | "importFrom">;
  /** 长程任务一个阶段的授权已用几次、从这里重做的范围和已经做了的事（84 号票）；没有这个任务或阶段时 undefined；不给就没有这个接口 */
  taskStage?: (taskId: string, stageId: string) => TaskStageView | undefined;
  /** 回退前的确认要的（150 号票）：回到这一条之前会放弃掉的那一段已经做了的事；不给就没有这个接口 */
  rollbackPreview?: (conversation: string, before: RollbackTarget) => RollbackPreview;
  /** 一条分支的样子（151 号票）：它路径上不在 against（不给是当前分支）路径上的那一段；不给就没有这个接口 */
  branchView?: (conversation: string, branchId: string, against: string | undefined) => BranchView;
  /** 每个 agent 的会话里的 ⚙（114 号票）；不给就没有这几个接口 */
  agentSettings?: AgentSettings;
  /**
   * 浏览插件（212 号票）给的，现取（插件没启用时回 undefined，这几个接口回"内置浏览器插件没启用"）：悬浮按钮上说的一段送识别（149 号票）、
   * 要交进上传框的文件的取件码（134 号票）、候选的缩略图（149 号票）、"浏览"的 ⋮ 菜单里"存进二狗的素材"（165 号票）。不给就没有这几个接口
   */
  browsing?: () => BrowsingService | undefined;
  /** 授权的文件夹（134 号票，138 号票起叫这个名字）和设置页选文件夹的框列子文件夹（138 号票）；不给就没有这两个接口 */
  localFolders?: LocalFolders;
  folderBrowser?: FolderBrowser;
  /**
   * 项目的服务首页的缩略图（140 号票）：按项目编号和服务名给文件和截图时间（顺带算"有人在看"，旧了的守护进程补截一张）；
   * 没有是 undefined；不给就没有这个接口
   */
  serviceThumbnail?: (projectId: string, name: string) => { file: string; takenAt: string } | undefined;
  /** 项目规范的只读视图（258 号票）：没有这个项目（删掉了的也是）是 undefined；不给就没有这个接口 */
  projectStandard?: (projectId: string) => ProjectStandardView | undefined;
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
/** 设备交来的（299 号票）：手机日历一次交几个月的日程（最多 PHONE_CALENDAR_EVENTS_MAX 条），放宽到 1 MB */
const MAX_DATA_SOURCE_PUSH_BODY = 1024 * 1024;
/** 存一页网页的请求体上限（165 号票：正文最多 BROWSER_PAGE_TEXT_MAX 字，中文一个字 3 字节，转义的另算） */
const SAVE_WEB_PAGE_MAX_BODY = 256 * 1024;
/** 保存系统提示的请求体上限（71 号票）：秘书的提示有一万多字节，留足余量 */
const MAX_PROMPT_BODY = 1024 * 1024;
/** 导入参考音色的请求体上限：录音的 base64（比原文件大三分之一）加上名字和逐字稿 */
const MAX_REFERENCE_VOICE_BODY = Math.ceil((REFERENCE_VOICE_MAX_BYTES * 4) / 3) + MAX_JSON_BODY;
/** Debug 工具集送识别的请求体上限（124 号票）：录音的 base64 加上类型 */
const MAX_DEBUG_AUDIO_BODY = Math.ceil((DEBUG_AUDIO_MAX_BYTES * 4) / 3) + MAX_JSON_BODY;
/** 悬浮按钮上说的一段的请求体上限（149 号票）：录的一段的 base64 加上类型 */
const MAX_PAGE_VOICE_BODY = Math.ceil((PAGE_COMMAND_AUDIO_MAX_BYTES * 4) / 3) + MAX_JSON_BODY;

/** 处理 /api/ 下的请求 */
export type HttpApi = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;

export function createHttpApi(options: HttpApiOptions): HttpApi {
  const { media, store, log } = options;

  /** 个人档案（281 号票）：没给就没有这几个接口 */
  const personalFiles = (): PersonalFilesService => {
    if (!options.personalFiles) throw new HttpError("not_found", t("gateway.http.noPersonalFiles"));
    return options.personalFiles;
  };

  /** 每个接口支持的方法和处理函数（HEAD 按 GET 处理） */
  const handlersOf = (route: HttpRoute): Partial<Record<string, Handler>> => {
    switch (route.route) {
      case "uploads":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CreateUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badUploadStart", { message: body.message }));
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
            if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError("bad_request", t("gateway.http.needOffset", { offset: HTTP_QUERY.offset }));
            sendJson(res, 200, await media.writeChunk(route.uploadId, offset, req));
          },
        };
      case "upload_complete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CompleteUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badUploadFinish", { message: body.message }));
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
      case "media_html":
        // HTML 附件本身（117 号票，报告页的沙箱框里看）：带沙箱的 CSP 发出原文
        return { GET: (req, res) => serveFramed(req, res, route.mediaId, "html") };
      case "media_svg":
        // SVG 附件本身（117 号票，报告页的 <img> 里看）
        return { GET: (req, res) => serveFramed(req, res, route.mediaId, "svg") };
      case "history":
        return {
          GET(_req, res, url) {
            if (!isConversationChannel(route.conversation)) throw new HttpError("not_found", t("gateway.http.noConversation", { conversation: route.conversation }));
            const before = optionalInt(url, HTTP_QUERY.before, 1);
            const limit = optionalInt(url, HTTP_QUERY.limit, 1);
            sendJson(res, 200, historyPage(store, route.conversation, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }));
          },
        };
      case "slash_commands":
        return {
          // 输入框里打 / 弹出的候选（82 号票）：工具包随时会变，每次现算
          GET(_req, res) {
            if (!options.slashCommands) throw new HttpError("not_found", t("gateway.http.noSlashCommands"));
            const list = isConversationChannel(route.conversation) ? options.slashCommands(route.conversation) : undefined;
            if (!list) throw new HttpError("not_found", t("gateway.http.noConversation", { conversation: route.conversation }));
            sendJson(res, 200, list);
          },
        };
      case "materials_scope":
        return {
          async POST(req, res) {
            const body = checkHttpBody(MaterialScopeBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badMaterialScope", { message: body.message }));
            sendJson(res, 200, options.materialDeletion.summary(body.value.scope));
          },
        };
      case "materials_delete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(DeleteMaterialsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badMaterialDelete", { message: body.message }));
            sendJson(res, 200, options.materialDeletion.delete(body.value.scope, body.value.mode, body.value.idempotencyKey));
          },
        };
      case "materials_list":
        return {
          async POST(req, res) {
            const body = checkHttpBody(MaterialListBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badMaterialList", { message: body.message }));
            sendJson(res, 200, options.materialBrowser.list(body.value.scope, { offset: body.value.offset, limit: body.value.limit }, body.value.filter));
          },
        };
      case "materials_web_page":
        return {
          async POST(req, res) {
            const body = checkHttpBody(SaveWebPageBody, await readJson(req, SAVE_WEB_PAGE_MAX_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSavePage", { message: body.message }));
            sendJson(res, 200, browsing(t("gateway.http.noSavedPages")).savedPages.save(body.value));
          },
        };
      case "material":
        return {
          GET(_req, res) {
            const view = options.materialBrowser.detail(route.materialId);
            if (!view) throw new HttpError("not_found", t("gateway.http.noMaterial"));
            sendJson(res, 200, view);
          },
        };
      // 记忆的推理库（233 号票，只读）：概览、结论列表、一条结论的完整解释、问题箱。
      // 库没建、版本对不上、正被整理作业占着都是 200 加 ready=false 和一句原因，不 500
      case "memory_summary":
        return {
          GET(_req, res) {
            sendJson(res, 200, memoryGraph().summary());
          },
        };
      case "memory_claims":
        return {
          GET(_req, res, url) {
            const query = memoryClaimQuery(url);
            sendJson(res, 200, memoryGraph().claims(query));
          },
        };
      case "memory_claim":
        return {
          GET(_req, res) {
            const view = memoryGraph().claim(route.claimId);
            if (!view) throw new HttpError("not_found", t("gateway.http.noMemoryClaim", { claimId: route.claimId }));
            sendJson(res, 200, view);
          },
        };
      case "memory_questions":
        return {
          GET(_req, res, url) {
            sendJson(res, 200, memoryGraph().questions({ limit: optionalInt(url, HTTP_QUERY.limit, 0) }));
          },
        };
      // 330 号票：做法（交互策略）列表，标"建在猜测上""理由没了"
      case "memory_strategies":
        return {
          GET(_req, res) {
            sendJson(res, 200, memoryGraph().strategies());
          },
        };
      // 记忆的设置（264 号票）：秘书顺口问开不开；现取现写，不缓存
      case "memory_settings":
        return {
          GET(_req, res) {
            sendJson(res, 200, memorySettings().current());
          },
          async PUT(req, res) {
            const body = checkHttpBody(MemorySettingsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badMemorySettings", { message: body.message }));
            sendJson(res, 200, memorySettings().change(body.value));
          },
        };
      // 了解你访谈（284 号票）：GET 现在的样子；POST 开一次（已经开着就是那一次），开场的系统消息交给记忆管理员
      case "memory_interview":
        return {
          GET(_req, res) {
            sendJson(res, 200, memoryInterviews().status());
          },
          async POST(req, res) {
            const body = checkHttpBody(InterviewStartBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badInterview", { message: body.message }));
            const started = memoryInterviews().start({ by: "page", ...(body.value.topic === undefined ? {} : { topic: body.value.topic }) });
            sendJson(res, 200, { interviewId: started.interviewId, topic: started.topic, already: started.already });
          },
        };
      case "workday_calendar":
        return {
          GET(_req, res, url) {
            sendJson(res, 200, options.workdayCalendar.month(url.searchParams.get(HTTP_QUERY.month) ?? ""));
          },
          async POST(req, res) {
            const body = checkHttpBody(WorkdayChangeBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badWorkday", { message: body.message }));
            sendJson(res, 200, options.workdayCalendar.change(body.value.change, "settings"));
          },
        };
      case "assistant_name":
        return {
          async POST(req, res) {
            const body = checkHttpBody(AssistantNameBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badRename", { message: body.message }));
            sendJson(res, 200, options.assistantName.change(body.value.name, "settings"));
          },
        };
      case "user_name":
        return {
          // 我的名字（249 号票）：现取现写，不缓存（设置里改了要马上读得到）
          GET(_req, res) {
            sendJson(res, 200, options.userName.view());
          },
          async PUT(req, res) {
            const body = checkHttpBody(UserNameBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badUserName", { message: body.message }));
            sendJson(res, 200, options.userName.change(body.value.name));
          },
        };
      case "personal_files":
        return {
          // 个人档案（281 号票）：现取；加一个重要的人（档案页里点的，改了就算确认）
          GET(_req, res) {
            sendJson(res, 200, personalFiles().list());
          },
          async POST(req, res) {
            const body = checkHttpBody(AddPersonBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badPersonalFile", { message: body.message }));
            sendJson(res, 200, personalFiles().addPerson(body.value));
          },
        };
      case "personal_file":
        return {
          GET(_req, res) {
            const file = personalFiles().file(route.personId);
            if (!file) throw new HttpError("not_found", t("gateway.http.noPersonalFile", { id: route.personId }));
            sendJson(res, 200, file);
          },
          async POST(req, res) {
            const body = checkHttpBody(PersonalFileChangeBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badPersonalFile", { message: body.message }));
            sendJson(res, 200, personalFiles().change(route.personId, body.value));
          },
        };
      case "personal_file_delete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(PersonalFileDeleteBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badPersonalFile", { message: body.message }));
            sendJson(res, 200, personalFiles().remove(route.personId, body.value));
          },
        };
      case "personal_file_learned":
        return {
          // 283 号票："二狗了解到的"，经记忆插件现取（插件没启用时 200、ready: false、写明原因）；没有这份是 404
          GET(_req, res) {
            sendJson(res, 200, personalFiles().learned(route.personId));
          },
        };
      case "locales":
        return {
          GET(_req, res) {
            sendJson(res, 200, options.language.list());
          },
        };
      case "locale":
        return {
          GET(_req, res) {
            sendJson(res, 200, options.language.dictionary());
          },
        };
      case "language":
        return {
          async POST(req, res) {
            const body = checkHttpBody(LanguageBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("i18n.badBody", { message: body.message }));
            sendJson(res, 200, options.language.change(body.value.language, "settings"));
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
            if (!isLocalDate(from) || !isLocalDate(to)) throw new HttpError("bad_request", t("gateway.http.badUsageRange", { from: HTTP_QUERY.from, to: HTTP_QUERY.to }));
            if (from > to) throw new HttpError("bad_request", t("gateway.http.rangeReversed", { from, to }));
            sendJson(res, 200, options.ledger.summary({ from, to }));
          },
        };
      case "reference_voices":
        return {
          GET(_req, res) {
            sendJson(res, 200, voice().referenceVoices.list());
          },
          async POST(req, res) {
            const body = checkHttpBody(ImportReferenceVoiceBody, await readJson(req, MAX_REFERENCE_VOICE_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badVoiceImport", { message: body.message }));
            const { name, referenceText, audioBase64 } = body.value;
            try {
              const { voice: imported, created } = await voice().referenceVoices.import({
                name,
                ...(referenceText === undefined ? {} : { referenceText }),
                audio: Buffer.from(audioBase64, "base64"),
              });
              sendJson(res, created ? 201 : 200, imported);
            } catch (err) {
              // 230 号票：本机没有 ffmpeg、识别用不了回 503；这段音频转不了回 400；别的（参数不对）照旧
              if (err instanceof AudioConvertError) throw new HttpError(err.kind === "missing" ? "service_unavailable" : "bad_request", err.message);
              if (err instanceof ReferenceVoiceTranscribeFailed) throw new HttpError("service_unavailable", err.message);
              throw err;
            }
          },
        };
      case "reference_voice":
        return {
          DELETE(_req, res) {
            sendJson(res, 200, voice().referenceVoices.remove(route.voiceId));
          },
        };
      case "reference_voice_select":
        return {
          POST(_req, res) {
            sendJson(res, 200, voice().referenceVoices.select(route.voiceId));
          },
        };
      case "reference_voice_audio":
        return {
          // 试听：和媒体同一套发文件（支持 Range）；参考录音会被删掉，不缓存
          GET(req, res) {
            const file = voice().referenceVoices.audioPath(route.voiceId);
            const size = file === undefined ? undefined : fileSize(file);
            if (file === undefined || size === undefined) throw new HttpError("not_found", t("gateway.http.noReferenceVoice", { voiceId: route.voiceId }));
            // @i18n-ignore-next log：label 只进读文件出错的日志
            serveFile(req, res, { file, size, label: `参考音色 ${route.voiceId}`, headers: { "Cache-Control": "no-store", "Content-Type": "audio/wav", "Content-Disposition": "inline" } });
          },
        };
      case "agent_voice_segment":
        return {
          // 分段合成的一段（38 号票）：临时的，合成完了过一阵就删；重做时同一段的内容会变，不缓存
          GET(req, res) {
            const file = voice().segmentFile(route.voiceId, route.index);
            const size = file === undefined ? undefined : fileSize(file);
            if (file === undefined || size === undefined) throw new HttpError("not_found", t("gateway.http.noVoiceSegment", { voiceId: route.voiceId, index: route.index }));
            // @i18n-ignore-next log：label 只进读文件出错的日志
            serveFile(req, res, { file, size, label: `语音 ${route.voiceId} 第 ${route.index} 段`, headers: { "Cache-Control": "no-store", "Content-Type": "audio/wav", "Content-Disposition": "inline" } });
          },
        };
      case "voice_models":
        return {
          // 两个语音模型现在的状态（会变，不缓存）
          GET(_req, res) {
            sendJson(res, 200, voice().models());
          },
        };
      case "toolkit_catalog":
        return {
          GET(_req, res) {
            if (!options.toolkits) throw new HttpError("not_found", t("gateway.http.noToolkits"));
            sendJson(res, 200, options.toolkits.catalog());
          },
        };
      case "skill_import":
        return {
          async POST(req, res) {
            if (!options.toolkits) throw new HttpError("not_found", t("gateway.http.noSkills"));
            const body = checkHttpBody(ImportSkillBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSkillImport", { message: body.message }));
            sendJson(res, 200, options.toolkits.importSkill(body.value));
          },
        };
      case "secretary_skills":
        return {
          // 秘书用的 skill（72 号票）：现读设置文件
          GET(_req, res) {
            if (!options.secretarySkills) throw new HttpError("not_found", t("gateway.http.noSecretarySkills", { assistant: ASSISTANT_NAME_MARK }));
            sendJson(res, 200, options.secretarySkills.view());
          },
          // 整份名单（改动本身幂等，不带幂等键）：只能选 skill 库里有的；改了之后秘书做完手头这一条就按新名单重新装配
          async POST(req, res) {
            if (!options.secretarySkills) throw new HttpError("not_found", t("gateway.http.noSecretarySkills", { assistant: ASSISTANT_NAME_MARK }));
            const body = checkHttpBody(SecretarySkillsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSecretarySkills", { assistant: ASSISTANT_NAME_MARK, message: body.message }));
            sendJson(res, 200, options.secretarySkills.set(body.value.skills));
          },
        };
      case "tool_call":
        return {
          // 一次工具调用的完整参数和返回（53 号票）：调用结束时另存的那份（已经过隐私处理和截断）
          GET(_req, res) {
            const detail = findToolCallDetail(store, route.callId);
            if (!detail) throw new HttpError("not_found", t("gateway.http.noToolCall", { callId: route.callId }));
            sendJson(res, 200, detail);
          },
        };
      case "task_stage":
        return {
          // 长程任务的阶段详情（84 号票）：每次打开现取
          GET(_req, res) {
            const view = options.taskStage?.(route.taskId, route.stageId);
            if (!view) throw new HttpError("not_found", t("gateway.http.noStage", { taskId: route.taskId, stageId: route.stageId }));
            sendJson(res, 200, view);
          },
        };
      case "rollback_preview":
        return {
          // 回退前的确认（150 号票）：回到这条消息之前（message）或这条分支开始前（branch）会放弃掉的那一段已经做了的事
          GET(req, res) {
            if (!options.rollbackPreview) throw new HttpError("not_found", t("gateway.http.noRollback"));
            const url = new URL(req.url ?? "/", "http://localhost");
            const messageId = url.searchParams.get(HTTP_QUERY.message);
            const branchId = url.searchParams.get(HTTP_QUERY.branch);
            // 152 号票：长程任务一个阶段开始前（stage_start 记号的 id）
            const stageStart = url.searchParams.get(HTTP_QUERY.stage);
            const given = [messageId, branchId, stageStart].filter((v) => v);
            if (given.length !== 1) throw new HttpError("bad_request", t("gateway.http.oneOf", { message: HTTP_QUERY.message, branch: HTTP_QUERY.branch, stage: HTTP_QUERY.stage }));
            sendJson(res, 200, options.rollbackPreview(route.conversation, messageId ? { messageId } : branchId ? { branchId } : { stageStart: stageStart! }));
          },
        };
      case "branch_view":
        return {
          // 一条分支的样子（151 号票）：废弃分支的 ⑂ 预览、详情；切换分支之后别的设备取新的当前分支上手里没有的那一段
          GET(req, res) {
            if (!options.branchView) throw new HttpError("not_found", t("gateway.http.noBranchView"));
            const url = new URL(req.url ?? "/", "http://localhost");
            const branchId = url.searchParams.get(HTTP_QUERY.branch);
            if (!branchId) throw new HttpError("bad_request", t("gateway.http.needBranch", { branch: HTTP_QUERY.branch }));
            sendJson(res, 200, options.branchView(route.conversation, branchId, url.searchParams.get(HTTP_QUERY.against) ?? undefined));
          },
        };
      case "tool_call_storage":
        return {
          // 设置里的"工具调用的完整内容"：占了多大、规则、照现在的规则马上清会清掉多少（65 号票）
          GET(_req, res) {
            if (!options.toolCallStorage) throw new HttpError("not_found", t("gateway.http.noToolCallStorage"));
            sendJson(res, 200, options.toolCallStorage.view());
          },
        };
      case "tool_call_storage_cleanup":
        return {
          // "现在就清理"：按现在的规则马上清一次（前端点之前已经确认过）；再点一次没有可清的就什么都不做
          async POST(_req, res) {
            if (!options.toolCallStorage) throw new HttpError("not_found", t("gateway.http.noToolCallStorage"));
            sendJson(res, 200, await options.toolCallStorage.cleanup("manual"));
          },
        };
      case "backup":
        return {
          // 设置里的"备份"（335 号票）：谁来定时、下一次、同步目录、最新的快照、最近一次、现在有没有一份在做（每次现取）
          GET(_req, res) {
            if (!options.backup) throw new HttpError("not_found", t("gateway.http.noBackup"));
            sendJson(res, 200, options.backup.status());
          },
        };
      case "backup_run":
        return {
          // "立即备份"：守护进程排一次（和它自己到点的同一条队列、同一把锁），不等做完，马上回现在的状况
          POST(_req, res) {
            if (!options.backup) throw new HttpError("not_found", t("gateway.http.noBackup"));
            sendJson(res, 200, options.backup.startNow());
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
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSystemPrompt", { message: body.message }));
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
            if (!options.modelSettings) throw new HttpError("not_found", t("gateway.http.noModelSettings"));
            sendJson(res, 200, await options.modelSettings.view());
          },
          // 整份存：查过合规再写（不合规回 400），下一个新会话起生效
          async POST(req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", t("gateway.http.noModelSettings"));
            const body = checkHttpBody(ModelSettingsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badModelSettings", { message: body.message }));
            sendJson(res, 200, await options.modelSettings.change(body.value));
          },
        };
      case "plugins":
        return {
          // 设置 · 插件（211 号票）：清单里的全部插件，给人看的字按守护进程当前的语言
          GET(_req, res) {
            if (!options.plugins) throw new HttpError("not_found", t("gateway.http.noPlugins"));
            sendJson(res, 200, options.plugins.view());
          },
        };
      case "plugin":
        return {
          // 停用、启用（装回）、移除（purgeData：连数据一起彻底删除）一个插件，马上生效；做不了的回 400 和原因，不认得的回 404
          async POST(req, res) {
            if (!options.plugins) throw new HttpError("not_found", t("gateway.http.noPlugins"));
            const body = checkHttpBody(PluginActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badPluginAction", { message: body.message }));
            sendJson(res, 200, await options.plugins.act(route.name, body.value));
          },
        };
      case "data_sources":
        return {
          // 设置 · 数据源（295 号票）：插件登记的全部数据源（停用的插件的也在，写明没启用）和导入文件夹，给人看的字按守护进程当前的语言
          GET(_req, res) {
            if (!options.dataSources) throw new HttpError("not_found", t("gateway.http.noDataSources"));
            sendJson(res, 200, options.dataSources.view());
          },
        };
      case "data_source":
        return {
          // 立即同步、断开（purge：连已导入的一起删）、开关一种用法、填设置；做不了的回 400 和原因，不认得的回 404。
          // 填设置的值只交给数据源（存进密钥区），不写日志
          async POST(req, res) {
            if (!options.dataSources) throw new HttpError("not_found", t("gateway.http.noDataSources"));
            const body = checkHttpBody(DataSourceActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badDataSourceAction", { message: body.message }));
            sendJson(res, 200, await options.dataSources.act(route.id, body.value));
          },
        };
      case "data_source_push":
        return {
          // 设备交来的（299 号票：手机上的二狗 App 读本机的通讯录、日历）：data 按那个数据源登记的 schema 查，不收的回 400 和原因、
          // 不认得的回 404；同一个幂等键重发只收一次。交来的内容不写日志
          async POST(req, res) {
            if (!options.dataSources) throw new HttpError("not_found", t("gateway.http.noDataSources"));
            const body = checkHttpBody(DataSourcePushBody, await readJson(req, MAX_DATA_SOURCE_PUSH_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badDataSourcePush", { message: body.message }));
            sendJson(res, 200, await options.dataSources.push(route.id, body.value));
          },
        };
      case "import_folder":
        return {
          // 导入文件夹（295 号票）：现在看一遍（出错过的也再试一次）、在电脑上打开
          async POST(req, res) {
            if (!options.dataSources) throw new HttpError("not_found", t("gateway.http.noDataSources"));
            const body = checkHttpBody(ImportFolderActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badImportFolderAction", { message: body.message }));
            sendJson(res, 200, await options.dataSources.folder(body.value));
          },
        };
      case "components":
        return {
          // 设置 · 组件（323 号票）：清单里的全部组件现在的样子（装了没有、多大、哪个版本、下载进度），给人看的字按守护进程当前的语言
          GET(_req, res) {
            if (!options.components) throw new HttpError("not_found", t("gateway.http.noComponents"));
            sendJson(res, 200, options.components.view());
          },
          // 装上照默认该装、还没装的（排队下载，马上回）
          async POST(req, res) {
            if (!options.components) throw new HttpError("not_found", t("gateway.http.noComponents"));
            const body = checkHttpBody(ComponentsActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badComponentAction", { message: body.message }));
            sendJson(res, 200, await options.components.installDefaults());
          },
        };
      case "component":
        return {
          // 装、更新、删、暂停、继续、取消一个组件：下载在后台做，马上回现在的样子；做不了的回 400 和原因，不认得的回 404
          async POST(req, res) {
            if (!options.components) throw new HttpError("not_found", t("gateway.http.noComponents"));
            const body = checkHttpBody(ComponentActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badComponentAction", { message: body.message }));
            sendJson(res, 200, await options.components.act(route.id, body.value.action));
          },
        };
      case "component_import":
        return {
          // 离线导入这台电脑上的一个文件、文件夹或 .tar / .tgz 包：按清单里的大小和校验值认，凑齐了就装上（等装完才回）
          async POST(req, res) {
            if (!options.components) throw new HttpError("not_found", t("gateway.http.noComponents"));
            const body = checkHttpBody(ComponentImportBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badComponentImport", { message: body.message }));
            sendJson(res, 200, await options.components.importFrom(body.value.path));
          },
        };
      case "runtimes":
        return {
          // 登记了的 agent 运行时（286 号票）：pi 在最前，插件的按清单的先后（停用了的也在，写明不能用的原因），连同能力清单、可选模型和设置项
          GET(_req, res) {
            sendJson(res, 200, options.runtimes?.view() ?? { runtimes: [] });
          },
        };
      case "runtime_sessions":
        return {
          // 这个运行时在本机能接管的会话（290 号票）：每次打开现取；正被别处占着、二狗自己在管的写明
          async GET(_req, res) {
            if (!options.takeover) throw new HttpError("not_found", t("gateway.http.noTakeover"));
            sendJson(res, 200, await options.takeover.sessions(route.runtimeId));
          },
        };
      case "runtime_take_over":
        return {
          // 从选中的会话接管成任务或项目（290 号票）：被占着的不分叉回 409；同一个幂等键重发拿到第一次建出的
          async POST(req, res) {
            if (!options.takeover) throw new HttpError("not_found", t("gateway.http.noTakeover"));
            const body = checkHttpBody(TakeOverBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badTakeOver", { message: body.message }));
            sendJson(res, 200, await busyAs409(() => options.takeover!.takeOver(route.runtimeId, body.value)));
          },
        };
      case "runtime_folder":
        return {
          // 能选工作文件夹的运行时新建时的默认文件夹（305 号票）：路径不对回 400（写明原因），响应是改过的运行时清单
          async PUT(req, res) {
            if (!options.workFolders) throw new HttpError("not_found", t("gateway.http.noWorkFolders"));
            const body = checkHttpBody(RuntimeFolderBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badRuntimeFolder", { message: body.message }));
            options.workFolders.setDefault(route.runtimeId, body.value.folder);
            sendJson(res, 200, options.runtimes?.view() ?? { runtimes: [] });
          },
          // 只核对一个已有的文件夹（新建对话框交之前看一眼）：不对的回 400 写明原因
          async POST(req, res) {
            if (!options.workFolders) throw new HttpError("not_found", t("gateway.http.noWorkFolders"));
            const body = checkHttpBody(RuntimeFolderBody, await readJson(req));
            if (!body.ok || body.value.folder === null) throw new HttpError("bad_request", t("gateway.http.badRuntimeFolder", { message: body.ok ? "folder" : body.message }));
            sendJson(res, 200, { folder: options.workFolders.check(body.value.folder) } satisfies WorkFolderCheckResult);
          },
        };
      case "web_settings":
        return {
          // 设置里 agent 的联网搜索、读网页（154 号票；162 号票起是 DeepSeek、浏览器、agent-browser 三种方式的队列）：存着的队列、
          // 实际用的顺序、DeepSeek 的 key 配没配（只说配没配）、最近一次余额不足
          GET(_req, res) {
            if (!options.webSettings) throw new HttpError("not_found", t("gateway.http.noWebSettings"));
            sendJson(res, 200, options.webSettings.view());
          },
          // 整份存：查过合规再写（不合规回 400：三种各一项、至少留一个启用而且用得上的），下一次搜索、读网页就按新的
          async POST(req, res) {
            if (!options.webSettings) throw new HttpError("not_found", t("gateway.http.noWebSettings"));
            const body = checkHttpBody(WebSettingsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badWebSettings", { message: body.message }));
            const problem = options.webSettings.problem(body.value);
            if (problem) throw new HttpError("bad_request", t("gateway.http.badWebSettings", { message: problem }));
            sendJson(res, 200, options.webSettings.change(body.value));
          },
        };
      case "safety_settings":
        return {
          // 安全和预算的两个开关（315 号票）：现在的；改哪项给哪项，写进配置文件、马上生效
          GET(_req, res) {
            if (!options.safetySettings) throw new HttpError("not_found", t("gateway.http.noSafetySettings"));
            sendJson(res, 200, options.safetySettings.view());
          },
          async PUT(req, res) {
            if (!options.safetySettings) throw new HttpError("not_found", t("gateway.http.noSafetySettings"));
            const body = checkHttpBody(SafetySettingsBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSafetySettings", { message: body.message }));
            sendJson(res, 200, options.safetySettings.change(body.value));
          },
        };
      case "setup":
        return {
          // 首次设置向导（319 号票）：五步各自做完了没有。ready 是条件现在满不满足（现算），done 还含"以后再说"和"看过了"
          GET(_req, res) {
            if (!options.setup) throw new HttpError("not_found", t("gateway.http.noSetup"));
            sendJson(res, 200, options.setup.view());
          },
          // 标一步：skip 为真写"以后再说"，否则写"看过了/做完了"；写进配置文件，回打完之后的整份
          async POST(req, res) {
            if (!options.setup) throw new HttpError("not_found", t("gateway.http.noSetup"));
            const body = checkHttpBody(SetupMarkBodySchema, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSetup", { message: body.message }));
            sendJson(res, 200, options.setup.mark(body.value));
          },
        };
      case "doctor":
        return {
          // 体检（319 号票的 319b）：八项检查现在的样子，每次现算；只查本机（除探本机端口外不联网、不调用模型、不改状态）
          async GET(_req, res) {
            if (!options.doctor) throw new HttpError("not_found", t("gateway.http.noDoctor"));
            sendJson(res, 200, await options.doctor.view());
          },
        };
      case "model_settings_key":
        return {
          // 模型的 key 配没配（315 号票）：不查模型目录、马上回；会话页上"还没配模型"的提示用
          GET(_req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", t("gateway.http.noModelSettings"));
            sendJson(res, 200, options.modelSettings.keyView());
          },
          // 在网页上填一个 key（319 号票）：写进密钥区的文件、换成现在用的；太短、太长的回 400，回的响应和日志里都没有 key 的内容
          async POST(req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", t("gateway.http.noModelSettings"));
            const body = checkHttpBody(ModelKeyBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badModelKey", { message: body.message }));
            sendJson(res, 200, options.modelSettings.saveKey(body.value.key));
          },
        };
      case "model_settings_test":
        return {
          // 连通测试：发一条极短的请求（在一次性子进程里，守护进程自己不跑模型），回通不通、首 token 延迟。
          // 同一时间只跑一个：上一个还没测完时回 409"上一个还没测完"
          async POST(req, res) {
            if (!options.modelSettings) throw new HttpError("not_found", t("gateway.http.noModelSettings"));
            const body = checkHttpBody(ModelTestBody, (await readJson(req)) ?? {});
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badModelTest", { message: body.message }));
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
      case "agent_settings":
        return {
          // 一个 agent 的 ⚙ 面板（114 号票）：每次打开现取（用量、压缩的进度在变）
          GET(_req, res) {
            sendJson(res, 200, agentSettings().view(route.agentId));
          },
        };
      case "agent_prompt":
        return {
          // 存这个 agent 单独的提示词：占位符照它的通用模板查，写错的拒收（400，写明第几行）；从它的下一轮起生效
          async PUT(req, res) {
            const body = checkHttpBody(AgentPromptBody, await readJson(req, MAX_PROMPT_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentPrompt", { message: body.message }));
            sendJson(res, 200, agentSettings().savePrompt(route.agentId, body.value));
          },
          // 恢复用通用模板
          DELETE(_req, res) {
            sendJson(res, 200, agentSettings().resetPrompt(route.agentId));
          },
        };
      case "agent_clear":
        return {
          // 清空当前对话（前端点之前已经确认过）：在处理一条时等它说完再清；幂等键重发只清一次
          async POST(req, res) {
            const body = checkHttpBody(AgentClearBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badClear", { message: body.message }));
            sendJson(res, 200, agentSettings().clear(route.agentId, body.value.idempotencyKey));
          },
        };
      case "agent_compact":
        return {
          // 现在压缩：不等压完（面板按 compaction 的状态再取）
          POST(_req, res) {
            sendJson(res, 200, agentSettings().compact(route.agentId));
          },
        };
      case "agent_model":
        return {
          // 项目、任务的维护者单独配模型（120 号票）：模型目录里没有的拒收（400）；下一个新会话起生效
          async PUT(req, res) {
            const body = checkHttpBody(AgentModelBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentModel", { message: body.message }));
            sendJson(res, 200, await agentSettings().setModel(route.agentId, body.value));
          },
          // 改回跟随它那一行（设置 · 模型里的项目维护者 / 任务维护者）
          DELETE(_req, res) {
            sendJson(res, 200, agentSettings().followRoleModel(route.agentId));
          },
        };
      case "agent_runtime":
        return {
          // 项目、任务的维护者用哪个运行时、给它选的模型和设置项（289 号票）：不认得的、没启用的、不在列表里的拒收（400）；
          // 换运行时的等手头这一条做完、原来的写好交接摘要才换
          async PUT(req, res) {
            const body = checkHttpBody(AgentRuntimeBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentRuntime", { message: body.message }));
            sendJson(res, 200, agentSettings().setRuntime(route.agentId, body.value));
          },
        };
      case "agent_takeover":
        return {
          // 接管来的会话交还给运行时 / 收回到二狗（290 号票）：在做一轮的不交还（409），交还等子进程退干净才回；收回先核对没在别处开着
          async POST(req, res) {
            const body = checkHttpBody(TakeoverActionBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badTakeOver", { message: body.message }));
            sendJson(res, 200, await busyAs409(() => agentSettings().takeoverAction(route.agentId, body.value.action)));
          },
        };
      case "agent_profiles":
        return {
          // 每个 agent 的名字和音色（241 号票）：248 号票起只保留 GET 只读兼容，返回从角色算出来的结果；
          // 前端的设置页已经全部换成"角色与声音"（/api/agent-roles）
          GET(_req, res) {
            sendJson(res, 200, agentSettings().profiles());
          },
        };
      case "agent_profile":
        return {
          // 改一个 agent 的名字和音色：248 号票起不做了（改成给这个 agent 选一个角色），回 400 指路
          PUT: () => {
            throw new HttpError("bad_request", t("gateway.http.agentProfileGone"));
          },
          DELETE: () => {
            throw new HttpError("bad_request", t("gateway.http.agentProfileGone"));
          },
        };
      case "agent_roles":
        return {
          // 设置 · 角色与声音（248 号票）：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色、参考音色；每次现取，不缓存
          GET(_req, res) {
            sendJson(res, 200, agentSettings().rolesView());
          },
          // 新建一个角色：名字按 43 号票的规矩查、音色要现在有的；不合规回 400 带原因
          async POST(req, res) {
            const body = checkHttpBody(AgentRoleBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentRole", { message: body.message }));
            sendJson(res, 200, agentSettings().createRole(body.value));
          },
        };
      case "agent_role":
        return {
          // 改名 / 换音色（只写要改的；默认角色会同时改全局名字 / 全局选中的音色）
          async PUT(req, res) {
            const body = checkHttpBody(AgentRoleUpdateBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentRole", { message: body.message }));
            sendJson(res, 200, agentSettings().updateRole(route.roleId, body.value));
          },
          // 删一个角色：默认角色、还有 agent 在用的回 400，写明是谁在用
          DELETE(_req, res) {
            sendJson(res, 200, agentSettings().deleteRole(route.roleId));
          },
        };
      case "agent_default_role":
        return {
          // 把某个角色设成默认：全局名字和音色跟着变成那个角色的
          async PUT(req, res) {
            const body = checkHttpBody(AgentDefaultRoleBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentRoleDefault", { message: body.message }));
            sendJson(res, 200, agentSettings().setDefaultRole(body.value.roleId));
          },
        };
      case "agent_role_assignment":
        return {
          // 给一个 agent 选角色（null = 跟默认）：名字和音色同时换成那个角色的，从它的下一轮 / 下一次合成就生效
          async PUT(req, res) {
            const body = checkHttpBody(AgentRoleAssignmentBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badAgentRoleAssignment", { message: body.message }));
            sendJson(res, 200, agentSettings().assignRole(route.agentId, body.value));
          },
        };
      case "debug_recognize":
        return {
          // Debug 工具集（124 号票）：录的一段交给识别进程，回文字和耗时；识别不了也是 200（带原因）
          async POST(req, res) {
            const body = checkHttpBody(DebugRecognizeBody, await readJson(req, MAX_DEBUG_AUDIO_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badRecognize", { message: body.message }));
            const audio = Buffer.from(body.value.audioBase64, "base64");
            if (audio.length === 0 || audio.length > DEBUG_AUDIO_MAX_BYTES) throw new HttpError("bad_request", t("gateway.http.audioEmptyOrLarge"));
            sendJson(res, 200, await voice().recognize(audio, body.value.mime));
          },
        };
      case "debug_speak":
        return {
          // Debug 工具集（124 号票）：用当前参考音色合成念一句，回 WAV 和耗时；合成不了也是 200（带原因）
          async POST(req, res) {
            const body = checkHttpBody(DebugSpeakBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badSpeech", { message: body.message }));
            sendJson(res, 200, await voice().speak(body.value.text));
          },
        };
      case "page_voice":
        return {
          // 悬浮按钮上按住说的一段（149 号票）：认出来的字回给二狗的网页，它再作为一条消息发进秘书的主会话；没认出也是 200（ok: false 和原因）
          async POST(req, res) {
            const body = checkHttpBody(PageVoiceBody, await readJson(req, MAX_PAGE_VOICE_BODY));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badRecording", { message: body.message }));
            const audio = Buffer.from(body.value.audio.base64, "base64");
            if (audio.length === 0) throw new HttpError("bad_request", t("gateway.http.audioEmpty"));
            if (audio.length > PAGE_COMMAND_AUDIO_MAX_BYTES) throw new HttpError("too_large", t("gateway.http.audioTooLong"));
            sendJson(res, 200, await browsing(t("gateway.http.noPageVoice")).pageVoice(audio, body.value.audio.mime));
          },
        };
      case "page_file":
        return {
          // 要交进上传框的文件（134 号票）：凭这次指令发的取件码；图片（认得的类型）在页面里直接显示（面板上的缩略图），别的作为附件下载
          GET(req, res) {
            const entry = browsing(t("gateway.http.noPageFiles")).pageFiles.get(route.token);
            if (!entry) throw new HttpError("not_found", t("gateway.http.badPickup"));
            const image = entry.image ? sniffImage(readHead(entry.path, 16))?.mime : undefined;
            serveFile(req, res, {
              file: entry.path,
              size: entry.size,
              label: `要交的文件「${entry.name}」`, // @i18n-ignore log：只进读文件出错的日志
              headers: {
                "Cache-Control": "private, no-store",
                "Content-Type": image ?? "application/octet-stream",
                "Content-Disposition": contentDisposition(image ? "inline" : "attachment", entry.name),
              },
            });
          },
        };
      case "page_file_thumb":
        return {
          // 候选的缩略图（149 号票）：凭取件码，守护进程缩的小图（缓存区里有就直接用）；不是图片、做不出来的 404（网页显示文件图标和名字）
          async GET(req, res) {
            const { pageFiles, pageThumbnails } = browsing(t("gateway.http.noThumbnails"));
            const entry = pageFiles.get(route.token);
            if (!entry) throw new HttpError("not_found", t("gateway.http.badPickup"));
            if (!entry.image) throw new HttpError("not_found", t("gateway.http.notImage"));
            const thumb = await pageThumbnails.get({ path: entry.path, mime: entry.mime, image: entry.image });
            if (!thumb) throw new HttpError("not_found", t("gateway.http.thumbFailed"));
            serveFile(req, res, {
              file: thumb.file,
              size: fs.statSync(thumb.file).size,
              label: `「${entry.name}」的缩略图`, // @i18n-ignore log：只进读文件出错的日志
              headers: { "Cache-Control": "private, max-age=900", "Content-Type": thumb.mime },
            });
          },
        };
      case "local_folders":
        return {
          // 授权的文件夹（134 号票，138 号票起叫这个名字）：秘书在聊天里和"浏览"里共用，设置 · 浏览与填框里看、改
          GET(_req, res) {
            sendJson(res, 200, localFolders().view());
          },
          async PUT(req, res) {
            const body = checkHttpBody(LocalFoldersBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badFolders", { message: body.message }));
            sendJson(res, 200, localFolders().set(body.value.folders));
          },
          // 设置页的"添加文件夹"和每行的叉（138 号票）：加几个、拿掉几个，马上存
          async PATCH(req, res) {
            const body = checkHttpBody(LocalFoldersChangeBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", t("gateway.http.badFolders", { message: body.message }));
            const folders = localFolders();
            folders.change(body.value);
            sendJson(res, 200, folders.view());
          },
        };
      case "service_thumbnail":
        return {
          // 项目的服务首页的缩略图（140 号票）：JPEG；每次都问一声有没有换（no-cache + ETag 是截图时间），换了新图前端也会换地址
          GET(req, res) {
            const shot = options.serviceThumbnail?.(route.projectId, route.name);
            let size: number | undefined;
            try {
              size = shot && fs.statSync(shot.file).size;
            } catch {
              size = undefined;
            }
            if (!shot || size === undefined) throw new HttpError("not_found", t("gateway.http.noServiceShot", { name: route.name }));
            const etag = `"${shot.takenAt}"`;
            const headers = { "Cache-Control": "private, no-cache", ETag: etag };
            if (req.headers["if-none-match"] === etag) {
              res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
              return void res.end();
            }
            // @i18n-ignore-next log：label 只进读文件出错的日志
            serveFile(req, res, { file: shot.file, size, label: `服务 ${route.projectId}-${route.name} 的首页缩略图`, headers: { ...headers, "Content-Type": "image/jpeg", "Content-Disposition": "inline" } });
          },
        };
      case "project_standard":
        return {
          // 项目规范（258 号票）：每次现算（档案里的文件随时会改），不缓存
          GET(_req, res) {
            const view = options.projectStandard?.(route.projectId);
            if (!view) throw new HttpError("not_found", t("gateway.http.noProject", { projectId: route.projectId }));
            sendJson(res, 200, view);
          },
        };
      case "local_folders_browse":
        return {
          // 设置页选文件夹的框（138 号票）：不给路径是常用位置和各个盘，给了是它的子文件夹；读不了的也是 200（原因在响应里）
          async GET(_req, res, url) {
            if (!options.folderBrowser) throw new HttpError("not_found", t("gateway.http.noFolderBrowser"));
            sendJson(res, 200, await options.folderBrowser.browse(url.searchParams.get(HTTP_QUERY.path) ?? undefined));
          },
        };
    }
  };

  /**
   * 浏览插件给的（212 号票）：不给这个选项是这个版本还没有（missing，原来的说法）；插件没启用（配置里停用、运行中停用、移除了）
   * 回"内置浏览器插件没启用"（和插件数据契约里的请求同一个说法、同一个错误码）
   */
  const browsing = (missing: string): BrowsingService => {
    if (!options.browsing) throw new HttpError("not_found", missing);
    const service = options.browsing();
    if (!service) throw new RequestRejected("not_allowed", browsingOff());
    return service;
  };

  const localFolders = () => {
    if (!options.localFolders) throw new HttpError("not_found", t("gateway.http.noLocalFolders"));
    return options.localFolders;
  };
  /** 语音插件的服务（214 号票）：没在运行时 404"语音插件没启用" */
  const voice = (): VoiceApi => {
    const api = options.voice?.();
    if (!api) throw new HttpError("not_found", voiceOffReason());
    return api;
  };

  /** 记忆的推理库只读视图（233 号票）：这个版本没有这几个接口时 404 */
  const memorySettings = (): MemorySettingsService => {
    if (!options.memorySettings) throw new HttpError("not_found", t("gateway.http.noMemorySettings"));
    return options.memorySettings;
  };
  /** 了解你访谈（284 号票）：这个版本没有这个接口时 404；记忆插件没启用时回"记忆插件没启用" */
  const memoryInterviews = (): MemoryInterviews => {
    if (!options.memoryInterviews) throw new HttpError("not_found", t("gateway.http.noMemoryInterview"));
    const service = options.memoryInterviews();
    if (!service) throw new HttpError("not_found", t("plugins.notEnabled", { title: t("memory.plugin.title") }));
    return service;
  };
  const memoryGraph = (): MemoryGraphReader => {
    if (!options.memoryGraph) throw new HttpError("not_found", t("gateway.http.noMemoryGraph"));
    return options.memoryGraph;
  };

  const agentSettings = () => {
    if (!options.agentSettings) throw new HttpError("not_found", t("gateway.http.noAgentSettings"));
    return options.agentSettings;
  };

  const systemPrompts = () => {
    if (!options.systemPrompts) throw new HttpError("not_found", t("gateway.http.noSystemPrompts"));
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
    if (!info) throw new HttpError("not_found", t("gateway.http.noMedia", { mediaId }));
    const name = url.searchParams.get(HTTP_QUERY.name) ?? mediaId;
    // 只有认得的图片在页面里直接显示、认得的音频直接播放（语音消息，31 号票），类型是按内容认出的；
    // 其他一律作为附件下载，不按前端声明的类型发出（免得 HTML、SVG 在本机源下跑脚本）
    const inlineType = info.image?.mime ?? info.audio?.mime;
    const inline = inlineType !== undefined && url.searchParams.get(HTTP_QUERY.download) !== "1";
    serveFile(req, res, {
      file: media.filePath(mediaId),
      size: info.size,
      label: `媒体 ${mediaId}`, // @i18n-ignore log：只进读文件出错的日志
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
    const { attachment, info } = previewable(mediaId);
    const { name, mime } = attachment;
    // HTML、SVG（117 号票）：内容不经这里给，告诉报告页在框里看哪一种（太大的不预览）
    const frame = attachment.kind === "file" ? framePreviewOf(attachment) : undefined;
    if (frame) {
      checkFrameSize(name, info.size);
      return { mediaId, name, mime, text: "", bytes: info.size, truncated: false, sentAt: attachment.time, frame };
    }
    if (attachment.kind !== "file" || !textPreviewOf(attachment)) throw new HttpError("unsupported_type", t("gateway.http.noPreview", { name, mime }));
    const truncated = info.size > MEDIA_TEXT_MAX_BYTES;
    const text = decodeUtf8(media.readHead(mediaId, MEDIA_TEXT_MAX_BYTES), { cut: truncated });
    if (text === undefined) throw new HttpError("undecodable", t("gateway.http.notUtf8", { name }));
    return { mediaId, name, mime, text, bytes: info.size, truncated, sentAt: attachment.time };
  };

  /** 预览的附件：只按媒体 id 取（内容寻址，不接受路径），名字、类型以消息里最近一次引用它的 part 为准；没有消息引用它、文件不在了都是 404 */
  const previewable = (mediaId: string) => {
    const attachment = isMediaId(mediaId) ? latestAttachment(store.reader, mediaId) : undefined;
    if (!attachment) throw new HttpError("not_found", t("gateway.http.noAttachment", { mediaId }));
    const info = media.info(mediaId);
    if (!info) throw new HttpError("not_found", t("gateway.http.attachmentGone", { name: attachment.name }));
    return { attachment, info };
  };

  /**
   * HTML、SVG 附件本身（117 号票）：只按媒体 id 取，part 上是这一种（协议包的 framePreviewOf）、不超过上限的才给，原样发出，
   * 带着把它关进沙箱的响应头（FRAME_HEADERS）。HTML 末尾加一小段让页面里的链接在新窗口打开的脚本（LINKS_IN_NEW_WINDOW）；
   * 是 UTF-8 的写明 charset，不是的不写（按页面自己的 meta 认）。不缓存、不支持 Range（报告页每次打开现取）
   */
  const serveFramed = (req: http.IncomingMessage, res: http.ServerResponse, mediaId: string, kind: FramePreview) => {
    const { attachment, info } = previewable(mediaId);
    const { name, mime } = attachment;
    if (attachment.kind !== "file" || framePreviewOf(attachment) !== kind) throw new HttpError("unsupported_type", t("gateway.http.wrongFrameKind", { name, mime, kind: kind === "html" ? "HTML" : "SVG" }));
    checkFrameSize(name, info.size);
    const raw = media.readHead(mediaId, info.size);
    const utf8 = decodeUtf8(raw) !== undefined;
    const body = kind === "html" ? Buffer.concat([raw, Buffer.from(LINKS_IN_NEW_WINDOW, "ascii")]) : raw;
    res.writeHead(200, {
      ...FRAME_HEADERS[kind],
      "Content-Type": kind === "html" ? `text/html${utf8 ? "; charset=utf-8" : ""}` : "image/svg+xml",
      "Content-Disposition": contentDisposition("inline", name),
      "Content-Length": String(body.length),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  return (req, res, url) => {
    const route = parseHttpPath(url.pathname);
    const handlers = route ? handlersOf(route) : undefined;
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const handler = handlers?.[method];
    const run = (): Promise<void> | void => {
      if (!handlers) throw new HttpError("not_found", t("gateway.noSuchPath"));
      if (!handler) throw new HttpError("method_not_allowed", t("gateway.methodNotAllowed", { method: req.method }));
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
        sendError(res, "internal", t("gateway.internal"));
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

/**
 * HTML 附件预览的 CSP（117 号票）。用户 2026-10-13 定"一阶段，不要加什么限制"：页面的功能一律放开，只留让二狗本身安全的——
 * - sandbox（HTML_PREVIEW_SANDBOX）不给 allow-same-origin：页面是一个"陌生来源"，拿不到二狗的 cookie、本地存储，也冒充不了
 *   二狗的页面；不给 allow-top-navigation 那几种：不能把整页导航走；
 * - 网关照旧不接受 Origin: null 的请求（gateway.ts 的 checkLocalRequest、checkExternalOrigin）：框里的脚本就算连二狗的地址
 *   （接口、WebSocket）也被拒；二狗的页面本身不许嵌框（X-Frame-Options: DENY）；
 * - frame-ancestors 'self'：只有二狗自己的报告页能把它放进框里。
 * 别的都给：脚本内联、'unsafe-eval'（Alpine、Vue 的模板编译能跑）、从 https: 拉脚本、样式、图片、字体、媒体、嵌套的框、worker
 * （另许 data:、blob:）；connect-src https: wss:（页面能从外网取数据，另许 data:、blob:）；form-action https:（表单能提交到外网）。
 * 只许 https:、wss:、data:、blob:，不许 http:——二狗自己（本机 http://127.0.0.1）和局域网里的 http 服务都连不上
 */
const HTML_PREVIEW_CSP = [
  `sandbox ${HTML_PREVIEW_SANDBOX}`,
  "default-src https: data: blob:",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "connect-src https: wss: data: blob:",
  "form-action https:",
  "frame-ancestors 'self'",
].join("; ");

/** SVG 附件预览的 CSP（117 号票）：报告页用 <img> 显示（<img> 里的 SVG 本来就不跑脚本），直接打开这个地址也不跑脚本、不发请求 */
const SVG_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** HTML、SVG 预览的响应头：nosniff、不缓存、不带 Referer；HTML 只许二狗自己的页面嵌（SAMEORIGIN，和 frame-ancestors 'self' 一致） */
const FRAME_HEADERS: Readonly<Record<FramePreview, Record<string, string>>> = {
  html: { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "Content-Security-Policy": HTML_PREVIEW_CSP },
  svg: { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "Content-Security-Policy": SVG_PREVIEW_CSP },
};

/**
 * 加在 HTML 附件末尾的一小段脚本（117 号票：页面里的链接点了在新窗口打开——鸿蒙 App 里由主页面的导航拦截交给系统浏览器）：
 * 点到没写 target 的链接时补上 target="_blank"；页内锚点（#…）、javascript: 照旧。放在末尾、只用 ASCII，不改原文的编码和
 * doctype；在沙箱里跑，和页面自己的脚本一样拿不到二狗的任何东西
 */
export const LINKS_IN_NEW_WINDOW =
  '\n<script>document.addEventListener("click",function(e){var a=e.target;while(a&&a.nodeName!=="A")a=a.parentNode;' +
  'if(!a||!a.getAttribute||a.hasAttribute("target"))return;var h=(a.getAttribute("href")||"").trim();' +
  'if(!h||h.charAt(0)==="#"||/^javascript:/i.test(h))return;a.setAttribute("target","_blank");a.setAttribute("rel","noopener noreferrer")},true);</script>\n';

/** HTML、SVG 超过预览的上限（117 号票，照 113 的 1 MB）：没法截一半看，只给下载 */
function checkFrameSize(name: string, size: number): void {
  if (size > MEDIA_FRAME_MAX_BYTES) throw new HttpError("too_large", t("gateway.http.frameTooLarge", { name, size: sizeLabel(size), max: sizeLabel(MEDIA_FRAME_MAX_BYTES) }));
}

/** 回 JSON（带安全响应头、不缓存）；本机端口和外网端口的 JSON 响应都走这里 */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 文件开头几个字节（认图片类型用）；读不了是空的 */
function readHead(file: string, bytes: number): Uint8Array {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(bytes);
    return head.subarray(0, fs.readSync(fd, head, 0, bytes, 0));
  } catch {
    return new Uint8Array(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) throw new HttpError("bad_request", t("gateway.http.notInteger", { name, min }));
  return value;
}

/**
 * 结论列表的查询串（233 号票）：tier、status 只能是协议包里的那几个值（不认识的回 400），limit 是 0 起；
 * 不给就是全部层、全部状态、默认条数
 */
function memoryClaimQuery(url: URL): MemoryClaimQuery {
  const tier = url.searchParams.get(HTTP_QUERY.tier);
  const status = url.searchParams.get(HTTP_QUERY.status);
  if (tier !== null && !(MEMORY_CLAIM_TIERS as readonly string[]).includes(tier)) {
    throw new HttpError("bad_request", t("gateway.http.badMemoryTier", { tier, allowed: MEMORY_CLAIM_TIERS.join(" / ") }));
  }
  if (status !== null && !(MEMORY_CLAIM_STATUSES as readonly string[]).includes(status)) {
    throw new HttpError("bad_request", t("gateway.http.badMemoryStatus", { status, allowed: MEMORY_CLAIM_STATUSES.join(" / ") }));
  }
  const limit = optionalInt(url, HTTP_QUERY.limit, 0);
  return {
    ...(tier === null ? {} : { tier: tier as MemoryClaimTier }),
    ...(status === null ? {} : { status: status as MemoryClaimStatus }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function readJson(req: http.IncomingMessage, limit = MAX_JSON_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError("too_large", t("gateway.tooLarge")));
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
        reject(new HttpError("bad_request", t("gateway.badJson")));
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
