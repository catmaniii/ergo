// 前端协议里走 HTTP 的那部分（规格第 5 节）：上传附件（分片续传）、往上翻历史、媒体的地址；
// 设置里按会话、按时间段删除素材（21 号票）；设置里的工作日历改个人设置（29 号票：改完守护进程在工作日历频道上推事件）；
// 消耗页的汇总和粗估成本（24 号票）；设置里的语音页：参考音色的列出、导入、选用、删除、试听（32 号票）；
// skill 库、已登记的 MCP，导入 skill（27 号票；导入并改名、整套导入集合、秘书用的 skill，72 号票）；主导航的日历按月取每一天的日历条目（35 号票）；
// 分段合成的 agent 语音边收边播时一段的地址（38 号票）；设置里改个人助理的名字（43 号票：改完守护进程在名字频道上推事件）；
// 设置 · 语音里两个语音模型的状态（45 号票）；详情页里一次工具调用的完整参数和返回（56 号票，接口是 53 号票的）；
// 设置里工具调用的完整内容占了多大、"现在就清理"（65 号票）。设置里的系统提示：看、保存、恢复默认（71 号票）。
// 输入框里打 / 弹出的候选：这个会话能用的斜杠命令（82 号票）。
// 设置里的"模型"：取、整份存、连通测试（73 号票）。报告页取文本类附件的内容（113 号票）。
// 网页现在是哪一版（116 号票：切回前台时问一次，和页面自己的对不上就提示刷新）。
// 和 Connection 一样只在 App.tsx 里注入一次（StoreProvider 的 http）：页面由守护进程提供时是 HttpDaemonClient，
// 直接打开构建产物（file://）时是原型的假实现（prototype/fake-http.ts）。
import {
  type AssistantNameResult,
  type CalendarMonthView,
  type ConversationId,
  type DeleteMaterialsBody,
  type DeleteMaterialsResult,
  type HistoryPage,
  type HttpErrorBody,
  type ImportSkillBody,
  type ImportSkillResult,
  type SecretarySkillsBody,
  type SecretarySkillsView,
  type SlashCommandList,
  type ToolkitCatalog,
  type ToolCallCleanupResult,
  type TaskStageView,
  type ToolCallDetail,
  type ToolCallStorageView,
  HTTP_PATHS,
  type MaterialScope,
  type MaterialScopeSummary,
  type MemoryDeleteMode,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelTestResult,
  type ImportReferenceVoiceBody,
  type MediaTextResult,
  type MediaTextView,
  type ReferenceVoice,
  type ReferenceVoiceList,
  type SystemPromptBody,
  type SystemPromptDetail,
  type SystemPromptList,
  type UploadedMedia,
  type UsageSummary,
  type VoiceModelsView,
  type WebVersionView,
  type WorkdayChange,
  type WorkdayChangeResult,
} from "../state/index.ts";
import { type UploadProgress, uploadFile } from "./uploader.ts";

export interface DaemonHttp {
  /** 上传一个文件（分片续传，断网恢复后接着传），进度经 onProgress 报；取消用 signal */
  upload(file: File, options: { onProgress(progress: UploadProgress): void; signal: AbortSignal }): Promise<UploadedMedia>;
  /** 某个会话里序号小于 before 的一页更早的消息 */
  /** 某个会话更早的一页（limit 不填用服务端默认的 50 条，最多 200） */
  history(conversation: ConversationId, before: number | undefined, limit?: number): Promise<HistoryPage>;
  /** 媒体的地址：图片直接显示，download 时作为附件下载（文件名用 name）；没有真媒体（原型）时为 undefined */
  mediaUrl(mediaId: string, name: string, options?: { download?: boolean }): string | undefined;
  /**
   * 文本类附件的内容（113 号票，报告页每次打开现取，不缓存）：取不到时不抛错，回错误码和原因
   * （报告页按它说"文件不在了""不能预览"）；连不上守护进程是 network
   */
  mediaText(mediaId: string, signal?: AbortSignal): Promise<MediaTextResult>;
  /** 素材范围里有几条（不给范围是全部），以及有素材的会话 */
  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary>;
  /** 对范围内的全部素材执行一种删法（幂等键：重发只执行一次），返回处理了几条 */
  deleteMaterials(scope: MaterialScope, mode: MemoryDeleteMode, idempotencyKey: string): Promise<DeleteMaterialsResult>;
  /** 改个人工作日历（加删额外规则、把某天标成上班或休息、清掉标记）；结果随后在工作日历频道上推来 */
  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult>;
  /** 改个人助理的名字（"恢复默认"就是改回默认的名字）；不合规时抛错，message 是原因；名字随后在名字频道上推来 */
  setAssistantName(name: string): Promise<AssistantNameResult>;
  /** 消耗页：from 到 to（本地日期，含两头）按天、按 agent 的用量，系统开销单列，粗估成本 */
  usage(range: { from: string; to: string }): Promise<UsageSummary>;
  /** 日历：某个月（YYYY-MM）每一天的日历条目（工作日判定、当天的提醒和定时作业） */
  calendarMonth(month: string): Promise<CalendarMonthView>;
  /** 参考音色：全部（按导入的先后）和现在用的那个 */
  referenceVoices(): Promise<ReferenceVoiceList>;
  /** 导入一个参考音色（WAV、逐字稿、名字）；不合规矩的抛错，message 是原因 */
  importReferenceVoice(input: { name: string; referenceText: string; audio: Blob }): Promise<ReferenceVoice>;
  /** 选它作为语音回复用的 */
  selectReferenceVoice(voiceId: string): Promise<ReferenceVoiceList>;
  /** 删掉一个参考音色 */
  removeReferenceVoice(voiceId: string): Promise<ReferenceVoiceList>;
  /** 试听：参考录音的地址；原型里没有真录音时为 undefined */
  referenceVoiceAudioUrl(voiceId: string): string | undefined;
  /** 分段合成的 agent 语音里合成好的第 index 段的地址（38 号票）；原型里没有真语音时为 undefined */
  agentVoiceSegmentUrl(voiceId: string, index: number): string | undefined;
  /** skill 库（框架自带的和导入的，集合显示成一项）、已登记的 MCP（27、72 号票） */
  toolkitCatalog(): Promise<ToolkitCatalog>;
  /** 导入一个 skill 目录（含 SKILL.md，可以改名），或者把一个目录作为集合整套导入：复制一份进数据目录的 skill 区（72 号票） */
  importSkill(request: ImportSkillBody): Promise<ImportSkillResult>;
  /** 秘书用的 skill（72 号票） */
  secretarySkills(): Promise<SecretarySkillsView>;
  /** 这个会话能用的斜杠命令：二狗自己的命令和 skill（82 号票，输入框里打 / 时现取） */
  slashCommands(conversation: ConversationId): Promise<SlashCommandList>;
  /** 改秘书用的 skill：整份名单，只能选 skill 库里有的；不合规矩的抛错，message 是原因 */
  setSecretarySkills(skills: readonly string[]): Promise<SecretarySkillsView>;
  /** 两个语音模型（识别、合成）现在的状态和识别引擎的清单（45 号票）；之后的变化经活动状态频道推来 */
  voiceModels(): Promise<VoiceModelsView>;
  /**
   * 一次工具调用的完整参数和返回（53 号票，详情页每次打开现取，不缓存）；
   * 没有存完整内容的（53 号票之前的调用、还在执行的）是 undefined，详情页退回摘要
   */
  toolCallDetail(callId: string, signal?: AbortSignal): Promise<ToolCallDetail | undefined>;
  /**
   * 长程任务一个阶段从守护进程现取的（84 号票，阶段详情每次打开、点"从这里重做"时取，不缓存）：授权已用几次、从这里重做的范围、
   * 这几个阶段这一轮已经做了的事；没有这个任务或阶段的是 undefined
   */
  taskStage(taskId: string, stageId: string, signal?: AbortSignal): Promise<TaskStageView | undefined>;
  /** 设置里：工具调用的完整内容占了多大、保留多久、总量上限、照现在的规则马上清会清掉多少（65 号票） */
  toolCallStorage(): Promise<ToolCallStorageView>;
  /** 设置里的"现在就清理"：按现在的规则马上清一次，回清了多少（点之前界面先确认） */
  cleanupToolCalls(): Promise<ToolCallCleanupResult>;
  /** 设置里的系统提示（71 号票）：全部，各自用的是默认还是改过的 */
  systemPrompts(): Promise<SystemPromptList>;
  /** 一份系统提示：现在用的、默认的内容，能用的占位符 */
  systemPrompt(id: string): Promise<SystemPromptDetail>;
  /** 保存一份系统提示：占位符写错时抛错，message 写明第几行错在哪；和默认的一样等于恢复默认 */
  saveSystemPrompt(id: string, content: string): Promise<SystemPromptDetail>;
  /** 恢复默认 */
  resetSystemPrompt(id: string): Promise<SystemPromptDetail>;
  /** 设置里的"模型"（73 号票）：服务商、API key 的状态（只说配没配）、可选的模型和看图能力、设置、各个 agent 实际会用的 */
  modelSettings(): Promise<ModelSettingsView>;
  /** 整份存（不合规时抛错，message 是原因），回存好之后的；下一个新会话起生效 */
  saveModelSettings(body: ModelSettingsBody): Promise<ModelSettingsView>;
  /** 连通测试：用这个模型（不给是默认模型）发一条极短的请求，回通不通、首 token 延迟 */
  testModel(modelId?: string): Promise<ModelTestResult>;
  /** 守护进程现在提供的网页是哪一版（116 号票，切回前台时问一次，不缓存）；不知道时没有 version */
  webVersion(signal?: AbortSignal): Promise<WebVersionView>;
}

/** 连到页面所在的守护进程（同源） */
export class HttpDaemonClient implements DaemonHttp {
  private readonly baseUrl: string;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  upload(file: File, options: { onProgress(progress: UploadProgress): void; signal: AbortSignal }): Promise<UploadedMedia> {
    return uploadFile(file, {
      baseUrl: this.baseUrl,
      fetch: (url, init) => fetch(url, init),
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }

  async history(conversation: ConversationId, before: number | undefined, limit?: number): Promise<HistoryPage> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.history(conversation, { before, limit })}`);
    if (!res.ok) throw new Error(`取历史失败（HTTP ${res.status}）`);
    return (await res.json()) as HistoryPage;
  }

  mediaUrl(mediaId: string, name: string, options: { download?: boolean } = {}): string {
    return `${this.baseUrl}${HTTP_PATHS.media(mediaId, { name, download: options.download })}`;
  }

  async mediaText(mediaId: string, signal?: AbortSignal): Promise<MediaTextResult> {
    try {
      const res = await fetch(`${this.baseUrl}${HTTP_PATHS.mediaText(mediaId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
      const json = (await res.json()) as unknown;
      if (res.ok) return { ok: true, view: json as MediaTextView };
      const error = json as Partial<HttpErrorBody>;
      return { ok: false, code: error.code ?? "internal", message: error.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, code: "network", message: err instanceof Error ? err.message : String(err) };
    }
  }

  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary> {
    return this.post<MaterialScopeSummary>(HTTP_PATHS.materialsScope, scope === undefined ? {} : { scope });
  }

  deleteMaterials(scope: MaterialScope, mode: MemoryDeleteMode, idempotencyKey: string): Promise<DeleteMaterialsResult> {
    const body: DeleteMaterialsBody = { scope, mode, idempotencyKey };
    return this.post<DeleteMaterialsResult>(HTTP_PATHS.materialsDelete, body);
  }

  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult> {
    return this.post<WorkdayChangeResult>(HTTP_PATHS.workdayCalendar, { change });
  }

  setAssistantName(name: string): Promise<AssistantNameResult> {
    return this.post<AssistantNameResult>(HTTP_PATHS.assistantName, { name });
  }

  async usage(range: { from: string; to: string }): Promise<UsageSummary> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.usage(range)}`);
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as UsageSummary;
  }

  async calendarMonth(month: string): Promise<CalendarMonthView> {
    return this.json<CalendarMonthView>(await fetch(`${this.baseUrl}${HTTP_PATHS.calendarMonth(month)}`));
  }

  async referenceVoices(): Promise<ReferenceVoiceList> {
    return this.json<ReferenceVoiceList>(await fetch(`${this.baseUrl}${HTTP_PATHS.referenceVoices}`));
  }

  async importReferenceVoice(input: { name: string; referenceText: string; audio: Blob }): Promise<ReferenceVoice> {
    const body: ImportReferenceVoiceBody = { name: input.name, referenceText: input.referenceText, audioBase64: await base64Of(input.audio) };
    return this.post<ReferenceVoice>(HTTP_PATHS.referenceVoices, body);
  }

  selectReferenceVoice(voiceId: string): Promise<ReferenceVoiceList> {
    return this.post<ReferenceVoiceList>(HTTP_PATHS.referenceVoiceSelect(voiceId), {});
  }

  async removeReferenceVoice(voiceId: string): Promise<ReferenceVoiceList> {
    return this.json<ReferenceVoiceList>(await fetch(`${this.baseUrl}${HTTP_PATHS.referenceVoice(voiceId)}`, { method: "DELETE" }));
  }

  referenceVoiceAudioUrl(voiceId: string): string {
    return `${this.baseUrl}${HTTP_PATHS.referenceVoiceAudio(voiceId)}`;
  }

  agentVoiceSegmentUrl(voiceId: string, index: number): string {
    return `${this.baseUrl}${HTTP_PATHS.agentVoiceSegment(voiceId, index)}`;
  }

  async voiceModels(): Promise<VoiceModelsView> {
    return this.json<VoiceModelsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.voiceModels}`, { cache: "no-store" }));
  }

  async toolCallDetail(callId: string, signal?: AbortSignal): Promise<ToolCallDetail | undefined> {
    // 不缓存（53 号票：彻底删除只靠完整内容找到的调用时，会话里不会有通知，每次打开都现取）
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.toolCall(callId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (res.status === 404) return undefined;
    return this.json<ToolCallDetail>(res);
  }

  async taskStage(taskId: string, stageId: string, signal?: AbortSignal): Promise<TaskStageView | undefined> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.taskStage(taskId, stageId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (res.status === 404) return undefined;
    return this.json<TaskStageView>(res);
  }

  async toolCallStorage(): Promise<ToolCallStorageView> {
    return this.json<ToolCallStorageView>(await fetch(`${this.baseUrl}${HTTP_PATHS.toolCallStorage}`, { cache: "no-store" }));
  }

  async cleanupToolCalls(): Promise<ToolCallCleanupResult> {
    return this.json<ToolCallCleanupResult>(await fetch(`${this.baseUrl}${HTTP_PATHS.toolCallStorageCleanup}`, { method: "POST" }));
  }

  // 系统提示（71 号票）：每次打开现取（文件可能被直接改过），不缓存
  async systemPrompts(): Promise<SystemPromptList> {
    return this.json<SystemPromptList>(await fetch(`${this.baseUrl}${HTTP_PATHS.systemPrompts}`, { cache: "no-store" }));
  }

  async systemPrompt(id: string): Promise<SystemPromptDetail> {
    return this.json<SystemPromptDetail>(await fetch(`${this.baseUrl}${HTTP_PATHS.systemPrompt(id)}`, { cache: "no-store" }));
  }

  async saveSystemPrompt(id: string, content: string): Promise<SystemPromptDetail> {
    const body: SystemPromptBody = { content };
    return this.json<SystemPromptDetail>(await fetch(`${this.baseUrl}${HTTP_PATHS.systemPrompt(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async resetSystemPrompt(id: string): Promise<SystemPromptDetail> {
    return this.json<SystemPromptDetail>(await fetch(`${this.baseUrl}${HTTP_PATHS.systemPrompt(id)}`, { method: "DELETE" }));
  }

  async modelSettings(): Promise<ModelSettingsView> {
    return this.json<ModelSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.modelSettings}`, { cache: "no-store" }));
  }

  saveModelSettings(body: ModelSettingsBody): Promise<ModelSettingsView> {
    return this.post<ModelSettingsView>(HTTP_PATHS.modelSettings, body);
  }

  testModel(modelId?: string): Promise<ModelTestResult> {
    return this.post<ModelTestResult>(HTTP_PATHS.modelSettingsTest, modelId === undefined ? {} : { modelId });
  }

  private async json<T>(res: Response): Promise<T> {
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as T;
  }

  async toolkitCatalog(): Promise<ToolkitCatalog> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.toolkitCatalog}`);
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as ToolkitCatalog;
  }

  importSkill(request: ImportSkillBody): Promise<ImportSkillResult> {
    return this.post<ImportSkillResult>(HTTP_PATHS.skillImport, request);
  }

  async secretarySkills(): Promise<SecretarySkillsView> {
    return this.json<SecretarySkillsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.secretarySkills}`));
  }

  setSecretarySkills(skills: readonly string[]): Promise<SecretarySkillsView> {
    const body: SecretarySkillsBody = { skills: [...skills] };
    return this.post<SecretarySkillsView>(HTTP_PATHS.secretarySkills, body);
  }

  async slashCommands(conversation: ConversationId): Promise<SlashCommandList> {
    return this.json<SlashCommandList>(await fetch(`${this.baseUrl}${HTTP_PATHS.slashCommands(conversation)}`, { cache: "no-store" }));
  }

  async webVersion(signal?: AbortSignal): Promise<WebVersionView> {
    return this.json<WebVersionView>(await fetch(`${this.baseUrl}${HTTP_PATHS.webVersion}`, { cache: "no-store", ...(signal ? { signal } : {}) }));
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as T;
  }
}

/** 文件内容的 base64（分段转，长录音也不爆调用栈） */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
