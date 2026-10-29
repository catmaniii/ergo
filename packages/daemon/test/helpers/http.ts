// 主切面的 HTTP 那一半：模拟前端经本机端口上传媒体（分片续传）、下载媒体、翻历史。
// 只用 node:http，能精确控制每个请求发出去多少字节，也能在请求体发到一半时掐断连接（模拟断网）。
import { createHash } from "node:crypto";
import http from "node:http";
import {
  type AgentModelBody,
  type AgentRuntimeBody,
  type AgentProfilesView,
  type AgentPromptBody,
  type AgentRoleAssignmentBody,
  type AgentRoleBody,
  type AgentRolesView,
  type AgentRoleUpdateBody,
  type AgentSettingsView,
  type AssistantNameResult,
  type BackupStatusView,
  type LanguageResult,
  type LocaleDictionaryView,
  type LocaleListView,
  type CalendarMonthView,
  type DeleteMaterialsBody,
  type DeleteMaterialsResult,
  HTTP_PATHS,
  type HistoryPage,
  type HttpErrorBody,
  type MaterialDetailView,
  type MaterialListBody,
  type MaterialListPage,
  type MaterialScope,
  type MaterialScopeSummary,
  type MediaTextView,
  type MemoryClaimDetailView,
  type MemoryClaimListPage,
  type MemoryQuestionsView,
  type MemorySettingsBody,
  type MemorySettingsView,
  type MemorySummaryView,
  type PluginActionBody,
  type PluginActionResult,
  type PluginsView,
  type RuntimesView,
  type RuntimeSessionsView,
  type TakeoverAction,
  type TakeOverBody,
  type TakeOverResult,
  type DataSourceActionBody,
  type DataSourceActionResult,
  type DataSourcesView,
  type ImportFolderActionBody,
  type ImportFolderActionResult,
  type SaveWebPageResult,
  type SystemPromptDetail,
  type SystemPromptList,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelKeyView,
  type ModelKeyWriteResult,
  type SafetySettingsBody,
  type SafetySettingsView,
  type SetupMarkBody,
  type SetupView,
  type DoctorView,
  type ModelTestResult,
  type ToolCallCleanupResult,
  type ToolCallDetail,
  type ToolCallStorageView,
  type UploadedMedia,
  type UploadStatus,
  type UsageSummary,
  type WebSettingsBody,
  type WebSettingsView,
  type WorkdayChange,
  type WorkdayChangeResult,
  type WorkdayMonthView,
  type UserNameResult,
  type UserNameView,
} from "@ergo/protocol";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
}

/** 发一个请求，读完整个响应 */
export function request(baseUrl: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : Buffer.from(options.body));
  });
}

/** JSON 请求：带 JSON 请求体，按 JSON 解析响应 */
export async function requestJson<T = unknown>(baseUrl: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: http.IncomingHttpHeaders }> {
  const res = await request(baseUrl, path, {
    method: options.method ?? "GET",
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = res.body.toString("utf8");
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as T };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type UploadReply<T> = { status: number; body: T };

async function reply<T>(pending: Promise<{ status: number; body: T }>): Promise<UploadReply<T>> {
  const { status, body } = await pending;
  return { status, body };
}

/** 媒体接口：建上传、写分片、查进度、收尾、下载、文本类附件的内容 */
export const media = {
  create(baseUrl: string, file: { name: string; mime: string; size: number }): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.uploads, { method: "POST", body: file }));
  },
  status(baseUrl: string, uploadId: string): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.upload(uploadId)));
  },
  async put(baseUrl: string, uploadId: string, offset: number, bytes: Uint8Array): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    const res = await request(baseUrl, HTTP_PATHS.uploadChunk(uploadId, offset), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    return { status: res.status, body: JSON.parse(res.body.toString("utf8")) as UploadStatus & HttpErrorBody };
  },
  complete(baseUrl: string, uploadId: string, sha256: string): Promise<UploadReply<UploadedMedia & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.uploadComplete(uploadId), { method: "POST", body: { sha256 } }));
  },
  /** 整个文件按 chunkSize 分片传完并收尾（收尾带原始字节的 sha256）；任何一步不对就抛错 */
  async upload(baseUrl: string, bytes: Uint8Array, file: { name: string; mime: string }, chunkSize = 64 * 1024): Promise<UploadedMedia> {
    const created = await media.create(baseUrl, { ...file, size: bytes.length });
    if (created.status !== 201) throw new Error(`建上传失败：${created.status} ${JSON.stringify(created.body)}`);
    const { uploadId } = created.body;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const put = await media.put(baseUrl, uploadId, offset, bytes.subarray(offset, offset + chunkSize));
      if (put.status !== 200) throw new Error(`写分片失败：${put.status} ${JSON.stringify(put.body)}`);
    }
    const done = await media.complete(baseUrl, uploadId, sha256Hex(bytes));
    if (done.status !== 200) throw new Error(`收尾失败：${done.status} ${JSON.stringify(done.body)}`);
    return done.body;
  },
  download(baseUrl: string, mediaId: string, options: { range?: string; method?: string; name?: string; download?: boolean } = {}): Promise<HttpResult> {
    const { range, method, ...query } = options;
    return request(baseUrl, HTTP_PATHS.media(mediaId, query), { method: method ?? "GET", ...(range === undefined ? {} : { headers: { range } }) });
  },
  /** 文本类附件的内容（113 号票，报告页用） */
  text(baseUrl: string, mediaId: string): Promise<{ status: number; body: MediaTextView & HttpErrorBody; headers: http.IncomingHttpHeaders }> {
    return requestJson<MediaTextView & HttpErrorBody>(baseUrl, HTTP_PATHS.mediaText(mediaId));
  },
};

/**
 * 写一个分片，只发出请求体的前 sent 个字节（请求头里声明的是整段的长度），等 settleMs 让服务端收下，
 * 然后掐断连接：模拟"传到一半网断了"。
 */
export async function putThenDrop(baseUrl: string, uploadId: string, offset: number, chunk: Uint8Array, sent: number, settleMs = 300): Promise<void> {
  const url = new URL(HTTP_PATHS.uploadChunk(uploadId, offset), baseUrl);
  const req = http.request(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(chunk.length) } });
  req.on("error", () => {});
  req.flushHeaders();
  await new Promise<void>((resolve) => req.write(chunk.subarray(0, sent), () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  req.destroy();
}

/** 历史分页 */
export function history(baseUrl: string, conversation: string, options: { before?: number; limit?: number } = {}): Promise<UploadReply<HistoryPage & HttpErrorBody>> {
  return reply(requestJson(baseUrl, HTTP_PATHS.history(conversation, options)));
}

/** 设置里按会话、按时间段删除素材（21 号票）；看素材（158 号票） */
export const materialsApi = {
  /** 范围里有几条素材、有素材的会话 */
  scope: (baseUrl: string, scope?: MaterialScope) =>
    requestJson<MaterialScopeSummary | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsScope, { method: "POST", body: scope === undefined ? {} : { scope } }),
  /** 对范围内的全部素材执行一种删法 */
  delete: (baseUrl: string, body: DeleteMaterialsBody) => requestJson<DeleteMaterialsResult | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsDelete, { method: "POST", body }),
  /** 范围里的素材，一页（158 号票） */
  list: (baseUrl: string, body: MaterialListBody = {}) => requestJson<MaterialListPage | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsList, { method: "POST", body }),
  /** 一条素材的完整内容和来源（158 号票） */
  detail: (baseUrl: string, materialId: string) => requestJson<MaterialDetailView | HttpErrorBody>(baseUrl, HTTP_PATHS.material(materialId)),
  /** "浏览"里存一页网页进素材（165 号票）；body 故意不限类型，测坏请求 */
  saveWebPage: (baseUrl: string, body: Record<string, unknown>) => requestJson<SaveWebPageResult | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsWebPage, { method: "POST", body }),
};

/** 记忆的推理库只读看（233 号票）：概览、结论列表、一条结论、问题箱 */
export const memoryApi = {
  summary: (baseUrl: string) => requestJson<MemorySummaryView & HttpErrorBody>(baseUrl, HTTP_PATHS.memorySummary),
  /** 结论列表；tier、status、limit 按原样放进查询串（测参数不对时用） */
  claims: (baseUrl: string, query: { tier?: string; status?: string; limit?: string | number } = {}) =>
    requestJson<MemoryClaimListPage & HttpErrorBody>(baseUrl, HTTP_PATHS.memoryClaims({ tier: query.tier, status: query.status, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) })),
  detail: (baseUrl: string, claimId: string) => requestJson<MemoryClaimDetailView & HttpErrorBody>(baseUrl, HTTP_PATHS.memoryClaim(claimId)),
  questions: (baseUrl: string, query: { limit?: number } = {}) => requestJson<MemoryQuestionsView & HttpErrorBody>(baseUrl, HTTP_PATHS.memoryQuestions(query)),
  /** 记忆的设置（264 号票）：顺口问开不开 */
  settings: (baseUrl: string) => requestJson<MemorySettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.memorySettings),
  saveSettings: (baseUrl: string, body: MemorySettingsBody) => requestJson<MemorySettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.memorySettings, { method: "PUT", body }),
};

/** 设置里的工作日历（29 号票） */
export const workdayApi = {
  /** 某个月（YYYY-MM）每天上班或休息及原因 */
  month: (baseUrl: string, month: string) => requestJson<WorkdayMonthView & HttpErrorBody>(baseUrl, HTTP_PATHS.workdayMonth(month)),
  /** 改个人设置 */
  change: (baseUrl: string, change: WorkdayChange) => requestJson<WorkdayChangeResult & HttpErrorBody>(baseUrl, HTTP_PATHS.workdayCalendar, { method: "POST", body: { change } }),
};

/** 设置里的个人助理的名字（43 号票） */
export const assistantNameApi = {
  /** 改名（"恢复默认"就是改回默认的名字） */
  change: (baseUrl: string, name: string) => requestJson<AssistantNameResult & HttpErrorBody>(baseUrl, HTTP_PATHS.assistantName, { method: "POST", body: { name } }),
};

/** 角色（248 号票）：角色页、⚙ 面板的两个入口，增删改之后回的都是整份 */
export const agentRolesApi = {
  /** GET /api/agent-roles：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色 */
  list: (baseUrl: string) => requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRoles),
  /** POST /api/agent-roles：新建一个角色 */
  create: (baseUrl: string, body: AgentRoleBody) => requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRoles, { method: "POST", body }),
  /** PUT /api/agent-roles/<角色 id>：改名 / 换音色 */
  update: (baseUrl: string, roleId: string, body: AgentRoleUpdateBody) => requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRole(roleId), { method: "PUT", body }),
  /** DELETE /api/agent-roles/<角色 id>：删一个（默认角色、还有 agent 在用的回 400） */
  remove: (baseUrl: string, roleId: string) => requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRole(roleId), { method: "DELETE" }),
  /** PUT /api/agent-roles/default：把某个角色设成默认 */
  setDefault: (baseUrl: string, roleId: string) => requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentDefaultRole, { method: "PUT", body: { roleId } }),
  /** PUT /api/agent-roles/assignments/<agent id>：null = 跟默认 */
  assign: (baseUrl: string, agentId: string, roleId: string | null) =>
    requestJson<AgentRolesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRoleAssignment(agentId), { method: "PUT", body: { roleId } satisfies AgentRoleAssignmentBody }),
};

/** 我的名字（249 号票）：用户自己的名字，GET 取、PUT 改（null 或者空串 = 清除） */
export const userNameApi = {
  get: (baseUrl: string) => requestJson<UserNameView & HttpErrorBody>(baseUrl, HTTP_PATHS.userName),
  change: (baseUrl: string, name: string | null) => requestJson<UserNameResult & HttpErrorBody>(baseUrl, HTTP_PATHS.userName, { method: "PUT", body: { name } }),
};

/** 每个 agent 的名字和音色（241 号票）：248 号票起只剩 GET 只读兼容，改角色的入口是 /api/agent-roles/assignments/<agent id> */
export const agentProfilesApi = {
  /** GET /api/agent-profiles：从角色算出来的结果（形状照旧） */
  list: (baseUrl: string) => requestJson<AgentProfilesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentProfiles),
  /** PUT /api/agent-profiles/<agent id>：248 号票起回 400（改用 /api/agent-roles/assignments/<agent id>） */
  change: (baseUrl: string, agentId: string, body: { name?: string | null; voiceId?: string | null }) =>
    requestJson<AgentProfilesView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentProfile(agentId), { method: "PUT", body }),
};

/** 多语言（168 号票）：设置 · 语言、网页的词典、换语言 */
export const languageApi = {
  list: (baseUrl: string) => requestJson<LocaleListView & HttpErrorBody>(baseUrl, HTTP_PATHS.locales),
  dictionary: (baseUrl: string) => requestJson<LocaleDictionaryView & HttpErrorBody>(baseUrl, HTTP_PATHS.locale),
  change: (baseUrl: string, language: string) => requestJson<LanguageResult & HttpErrorBody>(baseUrl, HTTP_PATHS.language, { method: "POST", body: { language } }),
};

/** 主导航的日历（35 号票）：某个月（YYYY-MM）每一天的日历条目 */
export const calendarApi = {
  month: (baseUrl: string, month: string) => requestJson<CalendarMonthView & HttpErrorBody>(baseUrl, HTTP_PATHS.calendarMonth(month)),
};

/** 工具调用的完整参数和返回（53 号票）：按调用 id 取 */
export function toolCallDetail(baseUrl: string, callId: string): Promise<{ status: number; body: ToolCallDetail & HttpErrorBody }> {
  return requestJson<ToolCallDetail & HttpErrorBody>(baseUrl, HTTP_PATHS.toolCall(callId));
}

/** 设置里的工具调用完整内容（65 号票）：占了多大、"现在就清理" */
export const toolCallStorageApi = {
  view: (baseUrl: string) => requestJson<ToolCallStorageView & HttpErrorBody>(baseUrl, HTTP_PATHS.toolCallStorage),
  cleanup: (baseUrl: string) => requestJson<ToolCallCleanupResult & HttpErrorBody>(baseUrl, HTTP_PATHS.toolCallStorageCleanup, { method: "POST" }),
};

/** 设置里的"备份"（335 号票）：现在的状况、立即备份（排一次，不等做完） */
export const backupApi = {
  status: (baseUrl: string) => requestJson<BackupStatusView & HttpErrorBody>(baseUrl, HTTP_PATHS.backup),
  run: (baseUrl: string) => requestJson<BackupStatusView & HttpErrorBody>(baseUrl, HTTP_PATHS.backupRun, { method: "POST" }),
};

/** 消耗页（24 号票）：from 到 to（YYYY-MM-DD，含两头）按天、按 agent 的用量和粗估成本 */
export const usageApi = {
  summary: (baseUrl: string, range: { from: string; to: string }) => requestJson<UsageSummary & HttpErrorBody>(baseUrl, HTTP_PATHS.usage(range)),
};

/** 设置里的系统提示（71 号票）：全部、一份、保存、恢复默认 */
export const systemPromptsApi = {
  list: (baseUrl: string) => requestJson<SystemPromptList & HttpErrorBody>(baseUrl, HTTP_PATHS.systemPrompts),
  get: (baseUrl: string, id: string) => requestJson<SystemPromptDetail & HttpErrorBody>(baseUrl, HTTP_PATHS.systemPrompt(id)),
  save: (baseUrl: string, id: string, content: string) => requestJson<SystemPromptDetail & HttpErrorBody>(baseUrl, HTTP_PATHS.systemPrompt(id), { method: "PUT", body: { content } }),
  reset: (baseUrl: string, id: string) => requestJson<SystemPromptDetail & HttpErrorBody>(baseUrl, HTTP_PATHS.systemPrompt(id), { method: "DELETE" }),
};

/** 设置里的"模型"（73 号票）：取、整份存、连通测试；raw 原样发请求体（测多出来的字段被拒） */
export const modelSettingsApi = {
  view: (baseUrl: string) => requestJson<ModelSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.modelSettings),
  /** 取的时候原样的响应文字（测里面没有 key 的内容） */
  viewText: async (baseUrl: string) => (await request(baseUrl, HTTP_PATHS.modelSettings)).body.toString("utf8"),
  change: (baseUrl: string, settings: ModelSettingsBody | Record<string, unknown>) => requestJson<ModelSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.modelSettings, { method: "POST", body: settings }),
  test: (baseUrl: string, modelId?: string) => requestJson<ModelTestResult & HttpErrorBody>(baseUrl, HTTP_PATHS.modelSettingsTest, { method: "POST", body: modelId === undefined ? {} : { modelId } }),
  /** 模型的 key 配没配（315 号票） */
  key: (baseUrl: string) => requestJson<ModelKeyView & HttpErrorBody>(baseUrl, HTTP_PATHS.modelSettingsKey),
  /** 在网页上填模型的 key（319 号票）：给一个字符串就当请求体的 key；给对象原样发（能测空的、太短的、多出来的字段） */
  keySet: (baseUrl: string, key: string | Record<string, unknown>) =>
    requestJson<ModelKeyWriteResult & HttpErrorBody>(baseUrl, HTTP_PATHS.modelSettingsKey, { method: "POST", body: typeof key === "string" ? { key } : key }),
};

/** 安全和预算的两个开关（315 号票）：取、改哪项给哪项 */
export const safetyApi = {
  view: (baseUrl: string) => requestJson<SafetySettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.safetySettings),
  change: (baseUrl: string, body: SafetySettingsBody | Record<string, unknown>) => requestJson<SafetySettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.safetySettings, { method: "PUT", body }),
};

/** 首次设置向导（319 号票）：五步做完了没有、标"以后再说"/"看过了" */
export const setupApi = {
  view: (baseUrl: string) => requestJson<SetupView & HttpErrorBody>(baseUrl, HTTP_PATHS.setup),
  mark: (baseUrl: string, body: SetupMarkBody | Record<string, unknown>) => requestJson<SetupView & HttpErrorBody>(baseUrl, HTTP_PATHS.setup, { method: "POST", body }),
};

/** 体检（319 号票的 319b）：八项检查现在的样子 */
export const doctorApi = {
  view: (baseUrl: string) => requestJson<DoctorView & HttpErrorBody>(baseUrl, HTTP_PATHS.doctor),
};

/** 设置里 agent 的联网搜索、读网页（154 号票）：取、整份存 */
export const webSettingsApi = {
  view: (baseUrl: string) => requestJson<WebSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.webSettings),
  change: (baseUrl: string, settings: WebSettingsBody | Record<string, unknown>) => requestJson<WebSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.webSettings, { method: "POST", body: settings }),
};

/** 设置 · 插件（211 号票）：列出、停用 / 启用 / 移除一个插件 */
export const pluginsApi = {
  view: (baseUrl: string) => requestJson<PluginsView & HttpErrorBody>(baseUrl, HTTP_PATHS.plugins),
  act: (baseUrl: string, name: string, body: PluginActionBody | Record<string, unknown>) =>
    requestJson<PluginActionResult & HttpErrorBody>(baseUrl, HTTP_PATHS.plugin(name), { method: "POST", body }),
};

/** 登记了的 agent 运行时（286 号票）：pi 和插件登记的，连同能力清单、能不能用 */
export const runtimesApi = {
  view: (baseUrl: string) => requestJson<RuntimesView & HttpErrorBody>(baseUrl, HTTP_PATHS.runtimes),
  /** 新建时的默认文件夹（305 号票）：null 是不设 */
  setFolder: (baseUrl: string, runtimeId: string, folder: string | null) => requestJson<RuntimesView & HttpErrorBody>(baseUrl, HTTP_PATHS.runtimeFolder(runtimeId), { method: "PUT", body: { folder } }),
  /** 核对一个已有的文件夹（305 号票） */
  checkFolder: (baseUrl: string, runtimeId: string, folder: string) => requestJson<{ folder: string } & HttpErrorBody>(baseUrl, HTTP_PATHS.runtimeFolder(runtimeId), { method: "POST", body: { folder } }),
};

/** 设置 · 数据源（295 号票）：全部数据源和导入文件夹、对一个数据源做的事、对导入文件夹做的事 */
export const dataSourcesApi = {
  view: (baseUrl: string) => requestJson<DataSourcesView & HttpErrorBody>(baseUrl, HTTP_PATHS.dataSources),
  act: (baseUrl: string, id: string, body: DataSourceActionBody) => requestJson<DataSourceActionResult & HttpErrorBody>(baseUrl, HTTP_PATHS.dataSource(id), { method: "POST", body }),
  folder: (baseUrl: string, body: ImportFolderActionBody) => requestJson<ImportFolderActionResult & HttpErrorBody>(baseUrl, HTTP_PATHS.importFolder, { method: "POST", body }),
};

/** 每个 agent 的会话里的 ⚙（114 号票）：面板、单独的提示词、清空当前对话、现在压缩 */
export const agentSettingsApi = {
  view: (baseUrl: string, agentId: string) => requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentSettings(agentId)),
  savePrompt: (baseUrl: string, agentId: string, body: AgentPromptBody) =>
    requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentPrompt(agentId), { method: "PUT", body }),
  resetPrompt: (baseUrl: string, agentId: string) => requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentPrompt(agentId), { method: "DELETE" }),
  clear: (baseUrl: string, agentId: string, idempotencyKey: string) =>
    requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentClear(agentId), { method: "POST", body: { idempotencyKey } }),
  compact: (baseUrl: string, agentId: string) => requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentCompact(agentId), { method: "POST" }),
  /** 单独配模型（120 号票）：给 undefined 是改回跟随它那一行 */
  model: (baseUrl: string, agentId: string, choice: AgentModelBody | Record<string, unknown> | undefined) =>
    requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentModel(agentId), choice === undefined ? { method: "DELETE" } : { method: "PUT", body: choice }),
  /** 用哪个运行时、给它选的值（289 号票） */
  runtime: (baseUrl: string, agentId: string, body: AgentRuntimeBody | Record<string, unknown>) =>
    requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentRuntime(agentId), { method: "PUT", body }),
  /** 接管来的会话交还 / 收回（290 号票） */
  takeover: (baseUrl: string, agentId: string, action: TakeoverAction) =>
    requestJson<AgentSettingsView & HttpErrorBody>(baseUrl, HTTP_PATHS.agentTakeover(agentId), { method: "POST", body: { action } }),
};

/** 从运行时已有的会话接管（290 号票）：列本机会话、接管成任务或项目 */
export const takeoverApi = {
  sessions: (baseUrl: string, runtimeId: string) => requestJson<RuntimeSessionsView & HttpErrorBody>(baseUrl, HTTP_PATHS.runtimeSessions(runtimeId)),
  takeOver: (baseUrl: string, runtimeId: string, body: TakeOverBody | Record<string, unknown>) =>
    requestJson<TakeOverResult & HttpErrorBody>(baseUrl, HTTP_PATHS.runtimeTakeOver(runtimeId), { method: "POST", body }),
};
