// 原型用的假 HTTP（直接打开构建产物、没有守护进程时）：上传只在浏览器里假装走一遍进度，
// 选的图片用本地的 object URL 显示；没有更早的历史。假历史里的图片、文件没有真媒体，界面画占位图。
// 改工作日历交给假连接（它在工作日历频道上推事件，和守护进程一样）。消耗页的汇总由假账本算（fake-data.ts 的 fakeUsageSummary）。
// 改个人助理的名字（43 号票）也交给假连接（它在名字频道上推事件）。
// 参考音色（32 号票）只记在内存里，导入的录音用本地的 object URL 试听。日历（35 号票）也交给假连接（它按自己的工作日历算）。
// 两个语音模型的状态（45 号票）是固定的一份：都已就绪。工具调用的完整内容（56 号票的详情页）按假会话里的摘要编一份。
// 设置里工具调用的完整内容占了多大（65 号票）是编的一份，"现在就清理"把可清的清掉（只在内存里）。
// 设置里的系统提示（71 号票）是编的几份（fake-system-prompts.ts），改的只记在内存里。
// 输入框里打 / 弹出的候选（82 号票）：二狗自己的命令加一份编的 skill（FAKE_SLASH_SKILLS），任务详情里的会话不列命令；
// 310 号票：记忆管理员的会话列 /interview、/consolidate；用 Claude Code 的维护者另列工具包里的 skill（/ergo:…）；说明、参数提示是守护进程换好的样子；
// 289 号票起用 Claude Code 的维护者列 Claude Code 报的命令（fake-runtimes.ts）。
// 设置里的"模型"（73 号票）是编的一份（DeepSeek 两个模型、key 已配置），改了只记在内存里，连通测试回一个编的延迟。
// 每个 agent 的 ⚙（114 号票）是编的（fake-agent-settings.ts）：通用模板取上面那几份系统提示，单独的提示词、清空、压缩只记在内存里。
// 附件卡片和报告页（113 号票）：假会话里的附件见 fake-media.ts，下载给一段说明文字；报告页照真接口的规矩回内容（超过 1 MB 的截断）
// 或错误；原型里刚上传的文本文件也能预览（读选的那个文件）。
// 设置里的删除素材（158 号票起能看每条的内容；167 号票起在记忆 · 素材，能按时间段、种类、会话、关键词筛）：假素材照假会话编
// （fake-materials.ts），删了只在这一页的内存里。
import type { DaemonHttp } from "../app/daemon-http.ts";
import { FakePersonalFiles } from "./fake-personal-files.ts";
import type { UploadProgress } from "../app/uploader.ts";
import { wavOf } from "../app/voice-wav.ts";
import type {
  ProjectStandardView,
  DebugRecognizeResult,
  DebugSpeakResult,
  AgentModelBody,
  AgentRuntimeBody,
  AgentRoleBody,
  AgentRolesView,
  AgentRoleUpdateBody,
  AgentPromptBody,
  AgentSettingsView,
  AssistantNameResult,
  UserNameResult,
  UserNameView,
  AddPersonBody,
  PersonalFileChangeBody,
  PersonalFileDeleteBody,
  PersonalFileDeleteResult,
  PersonalFileLearnedView,
  PersonalFilesView,
  PersonalFileView,
  LanguageResult,
  PluginAction,
  PluginActionResult,
  PluginsView,
  RuntimesView,
  RuntimeSessionsView,
  TakeoverAction,
  TakeOverBody,
  TakeOverResult,
  WorkFolderCheckResult,
  DataSourceActionBody,
  DataSourceActionResult,
  DataSourcesView,
  ImportFolderActionBody,
  ImportFolderActionResult,
  DataSourcePushBody,
  DataSourcePushResult,
  ComponentAction,
  ComponentImportResult,
  ComponentsView,
  LocaleDictionaryView,
  LocaleListView,
  CalendarMonthView,
  DeleteMaterialsResult,
  FileTextResult,
  FramePreview,
  HistoryPage,
  ImportSkillBody,
  MediaTextResult,
  ImportSkillResult,
  SecretarySkillsView,
  SlashCommandList,
  MaterialDetailView,
  MaterialListFilter,
  MaterialListPage,
  MaterialScope,
  MaterialScopeSummary,
  SaveWebPageBody,
  SaveWebPageResult,
  MemoryDeleteMode,
  ModelSettings,
  ModelApiKeyStatus,
  ModelCustomModel,
  ModelCustomModelsResult,
  ModelOptionView,
  ModelProviderView,
  ModelTestBody,
  ModelSettingsBody,
  ModelSettingsView,
  ModelKeyView,
  ModelKeyWriteResult,
  WebSettings,
  WebSettingsBody,
  WebSettingsView,
  ModelTestResult,
  ReferenceVoice,
  ReferenceVoiceList,
  MessageEnvelope,
  MessagePart,
  SystemPromptDetail,
  SystemPromptList,
  TaskStageView,
  ToolCallCleanupResult,
  ToolCallDetail,
  ToolCallStorageView,
  BackupStatusView,
  ToolkitCatalog,
  UploadedMedia,
  UsageSummary,
  VoiceModelsView,
  WebVersionView,
  WorkdayChange,
  WorkdayChangeResult,
  LocalFoldersView,
  LocalFoldersChangeBody,
  FolderBrowseView,
  FolderEntry,
  PageVoiceResult,
  ConversationId,
  RollbackPreview,
  BranchView,
  RollbackTarget,
  MemoryClaimDetailView,
  MemoryClaimListPage,
  MemoryClaimQuery,
  MemoryQuestionsView,
  MemoryStrategiesView,
  MemorySettingsBody,
  SafetySettingsBody,
  SafetySettingsView,
  MemorySettingsView,
  InterviewStartResult,
  InterviewStatusView,
  MemorySummaryView,
} from "../state/index.ts";
import { copyWebSettings, nowIso, CUSTOM_PROVIDER_ID, DEFAULT_MEMORY_SETTINGS, MEMORY_CURATOR_CONVERSATION, DEFAULT_SECRETARY_SKILLS, DEFAULT_WEB_SETTINGS, effectiveModelChoice, effectiveWebQueue, framePreviewOf, IMPORT_NAME_PATTERN, MEDIA_FRAME_MAX_BYTES, MEDIA_TEXT_MAX_BYTES, MODEL_AGENTS, modelKeyOf, reopenScope, t, textPreviewOf, webSettingsProblem } from "../state/index.ts";
import { fakeServerWebVersion } from "./fake-connection.ts";
import { fakeMemoryClaim, fakeMemoryClaims, fakeMemoryQuestions, fakeMemoryStrategies, fakeMemorySummary } from "./fake-memory-graph.ts";
import { FakeDataSources } from "./fake-data-sources.ts";
import { FakeComponents } from "./fake-components.ts";
import { FAKE_HISTORY, FAKE_TAKEOVER_TASK } from "./fake-conversations.ts";
import { FAKE_CURATOR_COMMANDS, FAKE_GRANT_USES, FAKE_SESSIONS, FAKE_SLASH_COMMANDS, FAKE_SLASH_SKILLS, FAKE_STAGE_EFFECTS, FAKE_TOOLKIT_CATALOG, fakeUsageSummary, taskDetailOf } from "./fake-data.ts";
import { longTaskStageView } from "./fake-long-tasks.ts";
import { FakeAgentSettings } from "./fake-agent-settings.ts";
import { FAKE_CLAUDE_CODE, FAKE_CLAUDE_COMMANDS, FAKE_CLAUDE_MAINTAINERS, FAKE_CLAUDE_SKILLS, fakeRuntimes, setFakeDefaultFolder } from "./fake-runtimes.ts";
import { fakeTakeoverSessions } from "./fake-takeover.ts";
import { fakeAppFileText } from "./fake-app-files.ts";
import { fakeMedia } from "./fake-media.ts";
import { fakeMaterialConversations, fakeMaterialDetail, fakeMaterialsIn, fakeSaveWebPage } from "./fake-materials.ts";
import { fakeServiceThumbnail } from "./fake-operations.ts";
import { fakeProjectStandard } from "./fake-standard.ts";
import { FakeSystemPrompts } from "./fake-system-prompts.ts";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 原型里自定义（OpenAI 兼容）服务商"拉取列表"拉到的几个模型：编的 id，和谁家的都不对应（演示页不联网） */
const FAKE_CUSTOM_MODELS: readonly ModelCustomModel[] = [
  { id: "fake-chat-pro", name: "Fake Chat Pro", ownedBy: "fake" },
  { id: "fake-chat-mini", name: "Fake Chat Mini", ownedBy: "fake" },
  { id: "fake-reasoner", ownedBy: "fake" },
];

/** 原型里的服务商登记表（和守护进程的登记表一样两项：DeepSeek，和自定义的 OpenAI 兼容服务商）：名字照守护进程换好的样子 */
function fakeModelProviders(): ModelProviderView[] {
  return [
    { id: "deepseek", label: "DeepSeek" },
    { id: CUSTOM_PROVIDER_ID, label: t("ui.modelProvider.customLabel") },
  ];
}

/** 原型里两个服务商的 key 都配着：按服务商说它从哪个环境变量、哪个文件来（值都是编的） */
function fakeApiKey(provider: string): ModelApiKeyStatus {
  return provider === CUSTOM_PROVIDER_ID
    ? { configured: true, envVar: "CUSTOM_MODEL_API_KEY", secretFile: "secrets/custom-model-api-key.txt", lsm: true }
    : { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true };
}

/** 同步的假实现包成 Promise：抛的错变成被拒（和真接口回错误一样） */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 假连接里改工作日历、按月看日历的那一半 */
export interface FakeWorkdayCalendar {
  changeWorkday(change: WorkdayChange): WorkdayChangeResult;
  calendarMonth(month: string): CalendarMonthView;
}

/** 原型的会话回退（150 号票）：回退前的确认由假连接按假会话编（fake-branches.ts） */
export interface FakeRollbacks {
  rollbackPreview(conversation: ConversationId, before: RollbackTarget): RollbackPreview;
  /** 一条分支的样子（151 号票） */
  branchView(conversation: ConversationId, branchId: string, against?: string): BranchView;
}

/** 假连接里改个人助理的名字的那一半（43 号票） */
export interface FakeAssistantName {
  setAssistantName(name: string): AssistantNameResult;
}

/** 假连接里"我的名字"那一半（249 号票）：用户自己的名字，null / 空串是清除 */
export interface FakeUserName {
  userNameView(): UserNameView;
  setUserName(name: string | null): UserNameResult;
}

/** 假连接里语言的那一半（168 号票）：原型里只有打包进去的几种语言，换了在语言频道上推事件 */
export interface FakeLanguage {
  localeList(): LocaleListView;
  localeView(): LocaleDictionaryView;
  setLanguage(language: string): LanguageResult;
}

/** 假连接里插件的那一半（211 号票）：清单、停用 / 启用 / 移除，变了在插件频道上推新的状况 */
export interface FakePluginSettings {
  pluginList(): PluginsView;
  pluginAction(name: string, action: PluginAction, purgeData: boolean): PluginActionResult;
}

/** 原型里授权的文件夹：同一个文件夹（不分大小写） */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** 原型里选文件夹的框（138 号票）：常用位置、各个盘和一棵假的文件夹树 */
const FAKE_FOLDER_PLACES: FolderEntry[] = [
  { name: "图片", path: "C:\\Users\\me\\Pictures" },
  { name: "下载", path: "C:\\Users\\me\\Downloads" },
  { name: "桌面", path: "C:\\Users\\me\\Desktop" },
  { name: "文档", path: "C:\\Users\\me\\Documents" },
  { name: "用户目录", path: "C:\\Users\\me" },
];
const FAKE_FOLDER_DRIVES: FolderEntry[] = [
  { name: "C:", path: "C:\\" },
  { name: "D:", path: "D:\\" },
];
const FAKE_FOLDER_TREE: ReadonlyArray<{ path: string; parent?: string; children: readonly string[] }> = [
  { path: "C:\\", children: ["Program Files", "Users", "Windows"] },
  { path: "C:\\Users", parent: "C:\\", children: ["me", "Public"] },
  { path: "C:\\Users\\me", parent: "C:\\Users", children: ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"] },
  { path: "C:\\Users\\me\\Pictures", parent: "C:\\Users\\me", children: ["2025 春节", "2026-10 杭州", "截图"] },
  { path: "C:\\Users\\me\\Downloads", parent: "C:\\Users\\me", children: [] },
  { path: "C:\\Users\\me\\Desktop", parent: "C:\\Users\\me", children: ["待整理"] },
  { path: "C:\\Users\\me\\Documents", parent: "C:\\Users\\me", children: ["发票", "合同"] },
  { path: "D:\\", children: ["照片", "文档", "备份"] },
  { path: "D:\\照片", parent: "D:\\", children: ["2024", "2025", "2026"] },
];

export class FakeDaemonHttp implements DaemonHttp {
  private seq = 0;
  private readonly urls = new Map<string, string>();
  /** 原型里刚上传的文件（113 号票：文本类的报告页读它） */
  private readonly uploads = new Map<string, File>();
  private readonly workdayCalendar: FakeWorkdayCalendar | undefined;
  private readonly rollbacks: FakeRollbacks | undefined;
  private readonly assistantName: FakeAssistantName | undefined;
  private readonly userNames: FakeUserName | undefined;
  private readonly language: FakeLanguage | undefined;
  private readonly pluginSettings: FakePluginSettings | undefined;
  /** 原型"启动"的时间（语音模型的状态用） */
  private readonly startedAt = new Date().toISOString();
  /** 记忆的设置（264 号票） */
  private memorySettingsValue: MemorySettingsView = { ...DEFAULT_MEMORY_SETTINGS };
  /** 原型里开着的访谈（284 号票：点了记忆管理员对话里的"开始访谈"才有） */
  private fakeInterview: string | undefined;
  /** 原型的参考音色（只在内存里） */
  private voices: ReferenceVoice[] = [];
  private currentVoice: string | undefined;
  /** 原型的工具调用完整内容（65 号票）：编的一份，"现在就清理"后可清的清掉 */
  private storage: ToolCallStorageView = {
    bytes: 327_155_712,
    calls: 1234,
    cleared: 56,
    retentionDays: 90,
    maxBytes: 2 * 1024 ** 3,
    due: { calls: 3, bytes: 4_404_019, inUse: 1 },
  };
  /** 原型的备份（335 号票）：编的一份，点了"立即备份"一秒半之后做完、记成最近一次 */
  private backup: BackupStatusView = fakeBackupStatus();
  private backupDoneAt: number | undefined;
  /** 原型的系统提示（71 号票） */
  private readonly prompts = new FakeSystemPrompts();
  /** 原型的个人档案（281 号票）：编的一份，本人的姓名就是原型里的"我的名字" */
  private readonly personalFilesFake = new FakePersonalFiles(
    () => this.userNames?.userNameView().name,
    (name) => void this.userNames?.setUserName(name),
  );
  /** 原型里每个 agent 的 ⚙（114 号票） */
  private readonly agentPanels = new FakeAgentSettings(
    this.prompts,
    () => this.models,
    () => this.voiceList(),
  );

  /** fake：原型的假连接（它在工作日历频道、名字频道上推事件，和守护进程一样） */
  constructor(fake?: FakeWorkdayCalendar & FakeAssistantName & FakeUserName & FakeRollbacks & FakeLanguage & FakePluginSettings) {
    this.workdayCalendar = fake;
    this.rollbacks = fake;
    this.assistantName = fake;
    this.userNames = fake;
    this.language = fake;
    this.pluginSettings = fake;
  }

  upload(file: File, options: { onProgress(progress: UploadProgress): void; signal: AbortSignal }): Promise<UploadedMedia> {
    const total = file.size;
    const mediaId = `fake-upload-${++this.seq}`;
    return new Promise((resolve, reject) => {
      let step = 0;
      const tick = () => {
        if (options.signal.aborted) return reject(new DOMException("上传已取消", "AbortError"));
        step += 1;
        const sent = Math.min(total, Math.round((total * step) / 5));
        if (step < 5) {
          options.onProgress({ state: "uploading", sent, total });
          setTimeout(tick, 150);
          return;
        }
        options.onProgress({ state: "done", sent: total, total });
        const image = DISPLAYABLE.has(file.type);
        // 图片在本地显示，录的语音在本地播放（31 号票）
        if (image || file.type.startsWith("audio/")) this.urls.set(mediaId, URL.createObjectURL(file));
        else this.uploads.set(mediaId, file);
        resolve({ mediaId, kind: image ? "image" : "file", name: file.name, mime: file.type || "application/octet-stream", size: total });
      };
      options.onProgress({ state: "uploading", sent: 0, total });
      setTimeout(tick, 150);
    });
  }

  history(conversation: string): Promise<HistoryPage> {
    return Promise.resolve({ conversation, messages: [], records: [], hasMore: false });
  }

  mediaUrl(mediaId: string): string | undefined {
    const url = this.urls.get(mediaId);
    if (url) return url;
    // 假会话里的附件、刚上传的文件：下载给一段说明文字（原型没有原文件）
    const name = fakeMedia(mediaId)?.part.name ?? this.uploads.get(mediaId)?.name;
    return name === undefined ? undefined : `data:text/plain;charset=utf-8,${encodeURIComponent(`原型里的假附件「${name}」：真的二狗在这里下载原文件。`)}`;
  }

  /**
   * 照守护进程的内容接口：能预览的给文字（超过上限的截在字符边上）；HTML、SVG（117 号票）只给名字、大小和 frame，
   * 超过上限的回太大；别的回不能预览，没有的回不在了
   */
  async mediaText(mediaId: string): Promise<MediaTextResult> {
    const fake = fakeMedia(mediaId);
    const uploaded = this.uploads.get(mediaId);
    const part = fake?.part ?? (uploaded && { mediaId, name: uploaded.name, mime: uploaded.type || "application/octet-stream", size: uploaded.size });
    if (!part) return { ok: false, code: "not_found", message: `没有这个附件：${mediaId}` };
    const frame = framePreviewOf(part);
    if (frame) {
      if (part.size > MEDIA_FRAME_MAX_BYTES) return { ok: false, code: "too_large", message: `附件「${part.name}」超过预览的上限，只能下载` };
      return { ok: true, view: { mediaId, name: part.name, mime: part.mime, text: "", bytes: part.size, truncated: false, sentAt: "2026-10-07T08:05:00.000+08:00", frame } };
    }
    if (!textPreviewOf(part)) return { ok: false, code: "unsupported_type", message: `附件「${part.name}」是 ${part.mime}，不能预览，只能下载` };
    const bytes = new TextEncoder().encode(fake?.text ?? (await uploaded!.text()));
    const truncated = bytes.length > MEDIA_TEXT_MAX_BYTES;
    // 截断处半个字解出来是替换符，去掉
    const text = new TextDecoder().decode(truncated ? bytes.subarray(0, MEDIA_TEXT_MAX_BYTES) : bytes).replace(/\uFFFD+$/, "");
    return { ok: true, view: { mediaId, name: part.name, mime: part.mime, text, bytes: bytes.length, truncated, sentAt: fake?.sentAt ?? "2026-10-07T21:30:00.000+08:00" } };
  }

  /**
   * 原型：HTML、SVG 在框里看的地址（117 号票）——假附件的内容做成 data: 地址，刚上传的用本地的 blob: 地址；报告页照样放进带
   * sandbox 的 iframe（data:、blob: 的页面在沙箱里同样是陌生来源）。没有内容的假附件为 undefined
   */
  /** 原型：内置浏览器里渲染文件（160 号票）用几份编的样例（fake-app-files.ts） */
  appFileText(url: string): Promise<FileTextResult> {
    return Promise.resolve(fakeAppFileText(url));
  }

  mediaFrameUrl(mediaId: string, frame: FramePreview): string | undefined {
    const text = fakeMedia(mediaId)?.text;
    if (text !== undefined) return `data:${frame === "html" ? "text/html" : "image/svg+xml"};charset=utf-8,${encodeURIComponent(text)}`;
    const uploaded = this.uploads.get(mediaId);
    return uploaded ? URL.createObjectURL(uploaded) : undefined;
  }

  /** 原型：这一页里删掉的、标过不参与推断的假素材（158 号票，只在内存里） */
  private readonly deletedMaterials = new Set<string>();
  private readonly noInferMaterials = new Set<string>();

  /** 原型：按假素材（照假会话编的，158 号票）数；假会话里没有素材的会话也列出来（0 条） */
  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary> {
    const counted = fakeMaterialConversations(this.deletedMaterials);
    const conversations = [...counted, ...FAKE_SESSIONS.filter((s) => !counted.some((c) => c.conversation === s.id)).map((s) => ({ conversation: s.id, count: 0 }))];
    return Promise.resolve({ count: fakeMaterialsIn(scope, this.deletedMaterials).length, conversations });
  }

  /** 原型：忘掉、彻底删除从这一页的列表里拿掉，别推断打上标记 */
  deleteMaterials(scope: MaterialScope, mode: MemoryDeleteMode): Promise<DeleteMaterialsResult> {
    const found = fakeMaterialsIn(scope, this.deletedMaterials);
    for (const m of found) (mode === "no_infer" ? this.noInferMaterials : this.deletedMaterials).add(m.id);
    return Promise.resolve({ count: found.length });
  }

  /** 原型：假素材的一页（167 号票起按时间段、种类、会话、关键词筛） */
  materialList(scope: MaterialScope | undefined, page: { offset: number; limit: number }, filter?: MaterialListFilter): Promise<MaterialListPage> {
    const found = fakeMaterialsIn(scope, this.deletedMaterials, filter).map((m) => (this.noInferMaterials.has(m.id) ? { ...m, marks: { ...m.marks, noInfer: true as const } } : m));
    return Promise.resolve({ total: found.length, items: found.slice(page.offset, page.offset + page.limit) });
  }

  /** 原型：一条假素材的详情 */
  material(materialId: string): Promise<MaterialDetailView | undefined> {
    return Promise.resolve(fakeMaterialDetail(materialId, this.deletedMaterials, this.noInferMaterials));
  }

  /** 原型："浏览"里存一页进素材（165 号票）：加进这一页的假素材，记忆 · 素材里看得到 */
  saveWebPage(body: SaveWebPageBody): Promise<SaveWebPageResult> {
    return Promise.resolve(fakeSaveWebPage(body, new Date().toISOString()));
  }

  // 原文型：记忆的推理库只读看（233 号票）——照 weekend 那组编的假结论、证据、问题箱；
  // ?demo-memory-empty 看空数据、?demo-memory-off 看库还没建的样子
  memorySummary(): Promise<MemorySummaryView> {
    return Promise.resolve(fakeMemorySummary());
  }

  memoryClaims(query: MemoryClaimQuery = {}): Promise<MemoryClaimListPage> {
    return Promise.resolve(fakeMemoryClaims(query));
  }

  memoryClaim(claimId: string): Promise<MemoryClaimDetailView | undefined> {
    return Promise.resolve(fakeMemoryClaim(claimId));
  }

  memoryQuestions(query: { limit?: number } = {}): Promise<MemoryQuestionsView> {
    return Promise.resolve(fakeMemoryQuestions(query));
  }

  memoryStrategies(): Promise<MemoryStrategiesView> {
    return Promise.resolve(fakeMemoryStrategies());
  }

  /** 安全和预算的两个开关（315 号票）：原型里只记在内存里，开头都开着（新装的样子） */
  private safetyValue: SafetySettingsView = { conversationApprovals: true, budgetControl: true };

  safetySettings(): Promise<SafetySettingsView> {
    return Promise.resolve({ ...this.safetyValue });
  }

  saveSafetySettings(body: SafetySettingsBody): Promise<SafetySettingsView> {
    this.safetyValue = { conversationApprovals: body.conversationApprovals ?? this.safetyValue.conversationApprovals, budgetControl: body.budgetControl ?? this.safetyValue.budgetControl };
    return this.safetySettings();
  }

  /** 记忆的设置（264 号票）：原型里只记在这一页里，刷新回到默认（开着） */
  memorySettings(): Promise<MemorySettingsView> {
    return Promise.resolve({ ...this.memorySettingsValue });
  }

  saveMemorySettings(body: MemorySettingsBody): Promise<MemorySettingsView> {
    // 266 号票起改哪项给哪项，没给的照旧
    this.memorySettingsValue = {
      wovenQuestions: body.wovenQuestions ?? this.memorySettingsValue.wovenQuestions,
      memoryBrief: body.memoryBrief ?? this.memorySettingsValue.memoryBrief,
      interviewInvites: body.interviewInvites ?? this.memorySettingsValue.interviewInvites,
    };
    return Promise.resolve({ ...this.memorySettingsValue });
  }

  /** 了解你访谈（284 号票）：原型里聊过家里的人，下次聊工作和一天；开一次只记在这一页里 */
  memoryInterview(): Promise<InterviewStatusView> {
    return Promise.resolve({
      ...(this.fakeInterview === undefined ? {} : { active: { id: this.fakeInterview, topic: "work_day", startedAt: new Date().toISOString(), by: "page" } }),
      covered: ["family"],
      next: "work_day",
      cadence: "weekly",
      invites: this.memorySettingsValue.interviewInvites,
    });
  }

  startInterview(): Promise<InterviewStartResult> {
    const already = this.fakeInterview !== undefined;
    this.fakeInterview ??= "iv-demo";
    return Promise.resolve({ interviewId: this.fakeInterview, topic: "work_day", already });
  }

  usage(range: { from: string; to: string }): Promise<UsageSummary> {
    return Promise.resolve(fakeUsageSummary(range));
  }

  /** 原型的 skill 库和 MCP 登记；导入的记在这一页里 */
  private catalog: ToolkitCatalog = FAKE_TOOLKIT_CATALOG;

  toolkitCatalog(): Promise<ToolkitCatalog> {
    return Promise.resolve(this.catalog);
  }

  /** 原型：单个的按文件夹名（或改的名）当 skill 名，不读文件；集合在原型里只记一项、没有成员 */
  importSkill(request: ImportSkillBody): Promise<ImportSkillResult> {
    const named = request.collection?.name ?? request.rename ?? request.path.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
    if (!new RegExp(IMPORT_NAME_PATTERN).test(named)) return Promise.reject(new Error(`名字 ${named} 不合规矩：只能用小写字母、数字和短横线`));
    if (this.catalog.skills.some((s) => s.name === named) || this.catalog.collections.some((c) => c.name === named)) return Promise.reject(new Error(`skill 库里已经有叫 ${named} 的了`));
    if (request.collection) {
      const { name, source, version, description } = request.collection;
      const collection = { name, source, version, description, skills: [] };
      this.catalog = { ...this.catalog, collections: [...this.catalog.collections, collection] };
      return Promise.resolve({ skills: [], collection, report: [], linked: [], excluded: [] });
    }
    const skill = { name: named, description: "刚导入的 skill（原型）", origin: "imported" as const };
    this.catalog = { ...this.catalog, skills: [...this.catalog.skills, skill] };
    return Promise.resolve({ skills: [skill], report: [{ name: named, dir: ".", ok: true }], linked: [], excluded: [] });
  }

  /** 原型的秘书用的 skill：一开始是默认的 */
  private secretary: SecretarySkillsView = this.withPromptSize({ skills: [...DEFAULT_SECRETARY_SKILLS], isDefault: true });

  /** 原型：秘书的系统提示里 skill 说明多长，按假 skill 库里的名字和说明估 */
  private withPromptSize(list: Pick<SecretarySkillsView, "skills" | "isDefault">): SecretarySkillsView {
    const text = list.skills
      .map((n) => this.catalog.skills.find((s) => s.name === n))
      .map((s) => (s ? `<skill><name>${s.name}</name><description>${s.description}</description><location>D:/假的/skills/${s.name}/SKILL.md</location></skill>` : ""))
      .join("");
    return { ...list, promptChars: [...text].length, promptBytes: new TextEncoder().encode(text).length };
  }

  secretarySkills(): Promise<SecretarySkillsView> {
    return Promise.resolve(this.secretary);
  }

  /**
   * 原型：秘书和项目的会话先列二狗自己的命令，任务详情里的不列；skill 都是同一份编的。
   * 289 号票：用 Claude Code 的维护者（个人博客项目的）列 Claude Code 报的命令，不列 skill
   */
  slashCommands(conversation: string): Promise<SlashCommandList> {
    // 310 号票：记忆管理员的会话（含了解你访谈）有 /interview、/consolidate
    if (conversation === MEMORY_CURATOR_CONVERSATION) return Promise.resolve({ commands: FAKE_CURATOR_COMMANDS });
    // 任务自己的维护者 id 是 tm- 开头（ownMaintainerId）
    const commands = conversation.startsWith("maintainer:tm-") ? [] : FAKE_SLASH_COMMANDS;
    if (FAKE_CLAUDE_MAINTAINERS.some((id) => conversation === `maintainer:${id}`)) return Promise.resolve({ commands: [...commands, ...FAKE_CLAUDE_SKILLS, ...FAKE_CLAUDE_COMMANDS] });
    return Promise.resolve({ commands: [...commands, ...FAKE_SLASH_SKILLS] });
  }

  setSecretarySkills(skills: readonly string[]): Promise<SecretarySkillsView> {
    const missing = skills.filter((n) => !DEFAULT_SECRETARY_SKILLS.includes(n) && !this.catalog.skills.some((s) => s.name === n));
    if (missing.length > 0) return Promise.reject(new Error(`skill 库里没有 ${missing.join("、")}（先在 skill 库页导入）`));
    this.secretary = this.withPromptSize({ skills: [...new Set(skills)], isDefault: false });
    return Promise.resolve(this.secretary);
  }

  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult> {
    if (!this.workdayCalendar) return Promise.reject(new Error("原型里没有工作日历"));
    try {
      return Promise.resolve(this.workdayCalendar.changeWorkday(change));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  locales(): Promise<LocaleListView> {
    if (!this.language) return Promise.reject(new Error("原型里没有语言设置"));
    return Promise.resolve(this.language.localeList());
  }

  locale(): Promise<LocaleDictionaryView> {
    if (!this.language) return Promise.reject(new Error("原型里没有语言设置"));
    return Promise.resolve(this.language.localeView());
  }

  setLanguage(language: string): Promise<LanguageResult> {
    if (!this.language) return Promise.reject(new Error("原型里没有语言设置"));
    try {
      return Promise.resolve(this.language.setLanguage(language));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  setAssistantName(name: string): Promise<AssistantNameResult> {
    if (!this.assistantName) return Promise.reject(new Error("原型里不能改名字"));
    try {
      return Promise.resolve(this.assistantName.setAssistantName(name));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  userName(): Promise<UserNameView> {
    return Promise.resolve(this.userNames ? this.userNames.userNameView() : {});
  }

  setUserName(name: string | null): Promise<UserNameResult> {
    if (!this.userNames) return Promise.reject(new Error("原型里不能改我的名字"));
    try {
      return Promise.resolve(this.userNames.setUserName(name));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // 个人档案（281 号票）：只在内存里
  personalFiles(): Promise<PersonalFilesView> {
    return Promise.resolve(this.personalFilesFake.list());
  }

  personalFile(personId: string): Promise<PersonalFileView> {
    return attempt(() => this.personalFilesFake.file(personId));
  }

  addPerson(body: AddPersonBody): Promise<PersonalFileView> {
    return attempt(() => this.personalFilesFake.addPerson(body));
  }

  changePersonalFile(personId: string, body: PersonalFileChangeBody): Promise<PersonalFileView> {
    return attempt(() => this.personalFilesFake.change(personId, body));
  }

  deletePersonalFile(personId: string, body: PersonalFileDeleteBody): Promise<PersonalFileDeleteResult> {
    return attempt(() => this.personalFilesFake.remove(personId, body));
  }

  personalFileLearned(personId: string): Promise<PersonalFileLearnedView> {
    return attempt(() => this.personalFilesFake.learned(personId));
  }

  calendarMonth(month: string): Promise<CalendarMonthView> {
    if (!this.workdayCalendar) return Promise.reject(new Error("原型里没有日历"));
    try {
      return Promise.resolve(this.workdayCalendar.calendarMonth(month));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  referenceVoices(): Promise<ReferenceVoiceList> {
    return Promise.resolve(this.voiceList());
  }

  importReferenceVoice(input: { name: string; referenceText?: string; audio: Blob }): Promise<ReferenceVoice> {
    const id = `v-proto${++this.seq}`;
    // 原型里没有真的识别进程：没给逐字稿时填一段编的（真跑时由守护进程自动识别，230 号票）
    const voice: ReferenceVoice = { id, name: input.name.trim(), referenceText: input.referenceText?.trim() || "这是原型里自动识别出来的逐字稿。", durationMs: 0, sha256: "", importedAt: new Date().toISOString() };
    this.urls.set(`voice:${id}`, URL.createObjectURL(input.audio));
    this.voices = [...this.voices, voice];
    return Promise.resolve(voice);
  }

  selectReferenceVoice(voiceId: string): Promise<ReferenceVoiceList> {
    this.currentVoice = voiceId;
    return Promise.resolve(this.voiceList());
  }

  removeReferenceVoice(voiceId: string): Promise<ReferenceVoiceList> {
    this.voices = this.voices.filter((v) => v.id !== voiceId);
    if (this.currentVoice === voiceId) this.currentVoice = undefined;
    return Promise.resolve(this.voiceList());
  }

  referenceVoiceAudioUrl(voiceId: string): string | undefined {
    return this.urls.get(`voice:${voiceId}`);
  }

  /** 原型里没有分段合成的语音 */
  agentVoiceSegmentUrl(): string | undefined {
    return undefined;
  }

  /** 原型的服务首页缩略图（140 号票）：画好的假网页（fake-operations.ts）；没画的没有 */
  serviceThumbnailUrl(projectId: string, name: string): string | undefined {
    return fakeServiceThumbnail(`${projectId}-${name}`);
  }

  /** 原型的项目规范（258 号票）：照假项目的类型和状态编的（fake-standard.ts） */
  projectStandard(projectId: string): Promise<ProjectStandardView | undefined> {
    return Promise.resolve(fakeProjectStandard(projectId));
  }

  /** 原型：两个模型都已就绪 */
  voiceModels(): Promise<VoiceModelsView> {
    const since = this.startedAt;
    return Promise.resolve({
      recognizerEngines: ["faster-whisper"],
      recognizerEngine: "faster-whisper",
      recognizer: { status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 4200, since },
      speech: { status: "ready", model: "fish_audio（audio.cpp/tts）", loadMs: 1300, alreadyLoaded: true, since },
      startedAt: since,
      revision: 1,
    });
  }

  /** 回退前的确认（150 号票）：假连接按假会话里的工具调用编；回不到那里时拒绝 */
  rollbackPreview(conversation: ConversationId, before: RollbackTarget): Promise<RollbackPreview> {
    try {
      return Promise.resolve(this.rollbacks?.rollbackPreview(conversation, before) ?? { conversation, before, effects: [] });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 一条分支的样子（151 号票）：假连接按假事件日志算；没有这条分支时拒绝 */
  branchView(conversation: ConversationId, branchId: string, against?: string): Promise<BranchView> {
    try {
      if (!this.rollbacks) return Promise.reject(new Error("原型没有这条分支"));
      return Promise.resolve(this.rollbacks.branchView(conversation, branchId, against));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 阶段详情现取的（84 号票）：授权已用几次、重做的范围（协议包的 reopenScope：它和依赖它的、开始过的）、这几个阶段这一轮已经做了的事 */
  taskStage(taskId: string, stageId: string): Promise<TaskStageView | undefined> {
    // 假长程任务（真任务的界面）：照它们的阶段算（274 号票起带"系统查到的结果"）
    const long = longTaskStageView(taskId, stageId);
    if (long) return Promise.resolve(long);
    const stages = taskDetailOf(taskId).stages;
    if (!stages.some((s) => s.id === stageId)) return Promise.resolve(undefined);
    const scope = reopenScope(
      stages.map((s) => ({ stageId: s.id, dependsOn: s.after, started: s.started ?? s.status !== "pending" })),
      stageId,
      (s) => s.started,
    );
    return Promise.resolve({
      taskId,
      stageId,
      grantUses: FAKE_GRANT_USES[taskId]?.[stageId] ?? [],
      reopenScope: scope,
      effects: (FAKE_STAGE_EFFECTS[taskId] ?? []).filter((e) => scope.includes(e.stageId)),
    });
  }

  /**
   * 原型：假会话里的工具调用按摘要编一份"完整内容"（参数摘要里 a=b 的拆成字段，别的当路径或命令；返回是结果摘要），
   * 好在详情页里看按字段画的样子。原型里没有完整内容可言，所以注明是假的
   */
  toolCallDetail(callId: string): Promise<ToolCallDetail | undefined> {
    for (const { payload } of FAKE_HISTORY) {
      const message = (payload as { message?: MessageEnvelope }).message;
      const part = message?.parts.find((p): p is Extract<MessagePart, { type: "tool_call" }> => p.type === "tool_call" && p.callId === callId);
      if (!message || !part) continue;
      const pairs = [...part.argsSummary.matchAll(/(\w+)=(\S+)/g)];
      const args = pairs.length ? Object.fromEntries(pairs.map((m) => [m[1]!, m[2]!])) : { [part.tool === "bash" ? "command" : "path"]: part.argsSummary };
      return Promise.resolve({
        callId,
        tool: part.tool,
        agentId: message.conversation,
        conversation: message.conversation,
        outcome: part.outcome,
        startedAt: message.time,
        endedAt: message.time,
        args,
        result: `${part.resultSummary ?? "（没有返回）"}\n\n（原型：这是按摘要编的假内容）`,
        isError: part.outcome !== "done",
        // 执行成功的顺带一条效果记录（56 号票），涉及的对象按参数里像路径的编
        ...(part.outcome === "done"
          ? {
              effects: [
                {
                  seq: 1,
                  tool: part.tool,
                  summary: `${part.tool}；成功${part.resultSummary ? `；结果：${part.resultSummary.slice(0, 40)}` : ""}`,
                  objects: typeof args.path === "string" ? [{ kind: "path" as const, access: "unknown" as const, value: args.path }] : [],
                },
              ],
            }
          : {}),
      });
    }
    return Promise.resolve(undefined);
  }

  toolCallStorage(): Promise<ToolCallStorageView> {
    return Promise.resolve(this.storage);
  }

  /** 原型："现在就清理"把编的可清的清掉（每次清掉的只剩几百字节的摘要，这里按一个字节不剩算） */
  cleanupToolCalls(): Promise<ToolCallCleanupResult> {
    const { due } = this.storage;
    this.storage = { ...this.storage, bytes: this.storage.bytes - due.bytes, calls: this.storage.calls - due.calls, cleared: this.storage.cleared + due.calls, due: { calls: 0, bytes: 0, inUse: due.inUse } };
    return Promise.resolve({
      trigger: "manual",
      at: new Date().toISOString(),
      expired: due.calls,
      overLimit: 0,
      freedBytes: due.bytes,
      keptInUse: due.inUse,
      bytes: this.storage.bytes,
      calls: this.storage.calls,
    });
  }

  /** 原型的备份（335 号票）：点过"立即备份"、还没到"做完"的时刻时是排着的，到了记成一次成功的手动备份 */
  backupStatus(): Promise<BackupStatusView> {
    if (this.backupDoneAt !== undefined && Date.now() >= this.backupDoneAt) {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const at = nowIso(now);
      const done: BackupStatusView = { ...this.backup, queued: false, latestLocal: date, latestSync: date, last: { by: "daemon", mode: "manual", startedAt: at, finishedAt: at, date, local: "created", sync: "copied" } };
      delete done.running;
      this.backup = done;
      this.backupDoneAt = undefined;
    }
    return Promise.resolve(this.backup);
  }

  backupRun(): Promise<BackupStatusView> {
    if (this.backupDoneAt === undefined) {
      this.backupDoneAt = Date.now() + 1500;
      this.backup = { ...this.backup, queued: true, running: { by: "daemon", pid: 4242, since: nowIso() } };
    }
    return Promise.resolve(this.backup);
  }

  // 系统提示（71 号票）：编的几份，改的只记在内存里
  systemPrompts(): Promise<SystemPromptList> {
    return Promise.resolve(this.prompts.list());
  }

  systemPrompt(id: string): Promise<SystemPromptDetail> {
    return attempt(() => this.prompts.detail(id));
  }

  saveSystemPrompt(id: string, content: string): Promise<SystemPromptDetail> {
    return attempt(() => this.prompts.save(id, content));
  }

  resetSystemPrompt(id: string): Promise<SystemPromptDetail> {
    return attempt(() => this.prompts.reset(id));
  }

  // 每个 agent 的 ⚙（114 号票）：编的，只在内存里
  agentSettings(agentId: string): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.view(agentId));
  }

  saveAgentPrompt(agentId: string, body: AgentPromptBody): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.savePrompt(agentId, body));
  }

  resetAgentPrompt(agentId: string): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.resetPrompt(agentId));
  }

  clearAgent(agentId: string): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.clear(agentId));
  }

  compactAgent(agentId: string): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.compact(agentId));
  }

  // 项目、任务的维护者单独配模型（120 号票）：编的，只在内存里（记账本的维护者配了 v4-pro）
  setAgentModel(agentId: string, body: AgentModelBody): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.setModel(agentId, body));
  }

  followAgentModel(agentId: string): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.followModel(agentId));
  }

  // 项目、任务的维护者用哪个运行时（289 号票）：编的，只在内存里（个人博客的维护者用 Claude Code）
  setAgentRuntime(agentId: string, body: AgentRuntimeBody): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.setRuntime(agentId, body));
  }

  // 从已有的会话接管（290 号票）：本机的会话是编的（fake-takeover.ts）；原型里不真的接管，交回那个编好的接管来的任务
  runtimeSessions(runtimeId: string): Promise<RuntimeSessionsView> {
    if (runtimeId !== FAKE_CLAUDE_CODE) return Promise.reject(new Error(`${runtimeId}不能接管已有的会话`));
    return new Promise((resolve) => setTimeout(() => resolve({ sessions: fakeTakeoverSessions(Date.now()) }), 300));
  }

  takeOver(_runtimeId: string, body: TakeOverBody): Promise<TakeOverResult> {
    const session = fakeTakeoverSessions(Date.now()).find((s) => s.id === body.sessionId);
    if (!session) return Promise.reject(new Error("本机没有这个 Claude Code 会话了（可能被删了）：刷新一下再选"));
    if (session.busy !== undefined && body.fork !== true) return Promise.reject(new Error(`${session.busy}：先在那边关掉再接管，或者分叉一份接管（原会话不动）`));
    return new Promise((resolve) =>
      setTimeout(() => resolve({ taskId: FAKE_TAKEOVER_TASK.id, maintainerId: FAKE_TAKEOVER_TASK.maintainerId, sessionId: body.fork ? `${session.id}-fork` : session.id, prelude: 5 }), 600),
    );
  }

  agentTakeover(agentId: string, action: TakeoverAction): Promise<AgentSettingsView> {
    return attempt(() => this.agentPanels.takeover(agentId, action));
  }

  // 角色（248 号票）：编的，只在内存里
  agentRoles(): Promise<AgentRolesView> {
    return Promise.resolve(this.agentPanels.rolesView());
  }

  createAgentRole(body: AgentRoleBody): Promise<AgentRolesView> {
    return attempt(() => this.agentPanels.createRole(body));
  }

  updateAgentRole(roleId: string, body: AgentRoleUpdateBody): Promise<AgentRolesView> {
    return attempt(() => this.agentPanels.updateRole(roleId, body));
  }

  deleteAgentRole(roleId: string): Promise<AgentRolesView> {
    return attempt(() => this.agentPanels.removeRole(roleId));
  }

  setDefaultAgentRole(roleId: string): Promise<AgentRolesView> {
    return attempt(() => this.agentPanels.setDefaultRole(roleId));
  }

  assignAgentRole(agentId: string, roleId: string | null): Promise<AgentRolesView> {
    return attempt(() => this.agentPanels.assignRole(agentId, { roleId }));
  }

  /** 原型的模型设置（73 号票）：只在内存里。自定义（OpenAI 兼容）服务商那一块（接口地址、模型 id、接口类型）也一样 */
  private models: ModelSettings = { provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} };

  modelSettings(): Promise<ModelSettingsView> {
    const settings = this.models;
    const custom = settings.provider === CUSTOM_PROVIDER_ID ? settings.custom : undefined;
    const vision = (key: string, catalog: boolean) => (settings.vision[key] === undefined ? { vision: catalog, visionSource: "catalog" as const } : { vision: settings.vision[key], visionSource: "settings" as const });
    // 自定义服务商只有一个模型（设置里填的那个）：和守护进程一样，可选的只有它
    const models: ModelOptionView[] =
      custom === undefined
        ? [
            { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", inCatalog: true, catalogVision: true, thinkingLevels: ["off", "low", "high"], ...vision("deepseek/deepseek-flash", true) },
            { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inCatalog: true, catalogVision: false, thinkingLevels: ["off", "high"], ...vision("deepseek/deepseek-v4-pro", false) },
          ]
        : [{ modelId: custom.modelId, inCatalog: true, catalogVision: false, ...vision(modelKeyOf(CUSTOM_PROVIDER_ID, custom.modelId), false) }];
    const effective = Object.fromEntries(
      MODEL_AGENTS.map((agent) => {
        const choice = effectiveModelChoice(settings, agent);
        return [agent, custom === undefined ? choice : { modelId: custom.modelId, thinkingLevel: choice.thinkingLevel }];
      }),
    ) as ModelSettingsView["effective"];
    return Promise.resolve({
      providers: fakeModelProviders(),
      apiKey: fakeApiKey(settings.provider),
      // 设置 · 模型的 API key 一块按服务商逐条列出：原型里两个都配着
      apiKeys: Object.fromEntries(fakeModelProviders().map((p) => [p.id, fakeApiKey(p.id)])),
      models,
      settings: structuredClone(settings),
      effective,
      secretarySession: { modelId: custom?.modelId ?? "deepseek-flash", thinkingLevel: "high", vision: custom === undefined },
      maintainers: this.agentPanels.maintainerModels(),
    });
  }

  /** 原型里 key 一直配着（会话页不出"还没配模型"的提示）；按现在选的服务商说 */
  modelKey(): Promise<ModelKeyView> {
    const provider = fakeModelProviders().find((p) => p.id === this.models.provider) ?? { id: "deepseek", label: "DeepSeek" };
    return Promise.resolve({ provider, apiKey: fakeApiKey(provider.id) });
  }

  /** 原型里照样收下（不真写文件、不回显），回的 key 一直配着；给了 provider 就按那个服务商说（设置 · 模型逐条列 key 用） */
  saveModelKey(key: string, provider?: string): Promise<ModelKeyWriteResult> {
    void key;
    return Promise.resolve({ configured: true, effective: "now", apiKey: fakeApiKey(provider ?? this.models.provider) });
  }

  /** 整份存：只在内存里；没带自定义那一块时留着原来那份（和守护进程一样，切回 DeepSeek 不清空） */
  saveModelSettings(body: ModelSettingsBody): Promise<ModelSettingsView> {
    const custom = body.custom ?? this.models.custom;
    this.models = { ...structuredClone(body), ...(custom === undefined ? {} : { custom: structuredClone(custom) }) } as ModelSettings;
    return this.modelSettings();
  }

  /**
   * 原型：编一个延迟。自定义服务商测的是它里面那个模型 id（和守护进程一样，custom 里的 modelId 优先）
   */
  testModel(body: ModelTestBody = {}): Promise<ModelTestResult> {
    const modelId = body.custom?.modelId ?? body.modelId ?? this.models.default.modelId;
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, modelId, firstTokenMs: 640, totalMs: 1180 }), 400));
  }

  /** 原型里"拉取列表"不联网：过一会儿回几个编的模型 id（假的，和谁都不对应）；没填地址时照守护进程的语气说一句 */
  customModels(baseUrl?: string): Promise<ModelCustomModelsResult> {
    const url = (baseUrl ?? this.models.custom?.baseUrl ?? "").trim();
    if (url === "") return Promise.resolve({ ok: false, models: [], error: "还没填接口地址：先在上面填上再来拉列表" });
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, models: FAKE_CUSTOM_MODELS.map((model) => ({ ...model })) }), 300));
  }

  /** 原型的联网设置（154 号票；162 号票起是三种方式的队列）：只在内存里；假装配了 DeepSeek 的 key */
  private web: WebSettings = copyWebSettings(DEFAULT_WEB_SETTINGS);

  webSettings(): Promise<WebSettingsView> {
    return Promise.resolve({
      settings: copyWebSettings(this.web),
      effective: effectiveWebQueue(this.web, true),
      deepseekKey: { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true },
    });
  }

  saveWebSettings(body: WebSettingsBody): Promise<WebSettingsView> {
    const problem = webSettingsProblem(body, true);
    if (problem) return Promise.reject(new Error(problem));
    this.web = copyWebSettings(body);
    return this.webSettings();
  }

  /** agent 运行时（286 号票）：原型里是内核自带的 pi 和 Claude Code 插件登记的（289 号票起有界面，fake-runtimes.ts） */
  runtimes(): Promise<RuntimesView> {
    return Promise.resolve({ runtimes: fakeRuntimes() });
  }

  // 核对已有的文件夹（305 号票）：原型里只看是不是从盘符写起
  checkRuntimeFolder(_runtimeId: string, folder: string): Promise<WorkFolderCheckResult> {
    const written = folder.trim();
    if (!/^[a-z]:[\\/]/i.test(written)) return Promise.reject(new Error(`「${written}」不是完整的路径：要从盘符写起（比如 D:\\work\\ledger）`));
    return Promise.resolve({ folder: written });
  }

  // 新建时的默认文件夹（305 号票）：编的，只在内存里
  setRuntimeFolder(_runtimeId: string, folder: string | null): Promise<RuntimesView> {
    return attempt(() => {
      setFakeDefaultFolder(folder);
      return { runtimes: fakeRuntimes() };
    });
  }

  /** 设置 · 插件（211 号票）：假连接里的两个插件 */
  plugins(): Promise<PluginsView> {
    if (!this.pluginSettings) return Promise.reject(new Error("原型里没有插件设置"));
    return Promise.resolve(this.pluginSettings.pluginList());
  }

  pluginAction(name: string, body: { action: PluginAction; purgeData?: boolean; idempotencyKey: string }): Promise<PluginActionResult> {
    if (!this.pluginSettings) return Promise.reject(new Error("原型里没有插件设置"));
    const settings = this.pluginSettings;
    // 和守护进程一样要一会儿（停用、装配、连数据删）
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(settings.pluginAction(name, body.action, body.purgeData === true));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, 300),
    );
  }

  /** 设置 · 数据源（295 号票）：原型里编的几个数据源和导入文件夹（prototype/fake-data-sources.ts） */
  private readonly fakeDataSources = new FakeDataSources();

  dataSources(): Promise<DataSourcesView> {
    return this.fakeDataSources.view();
  }

  dataSourceAction(id: string, body: DataSourceActionBody): Promise<DataSourceActionResult> {
    return this.fakeDataSources.act(id, body);
  }

  importFolderAction(body: ImportFolderActionBody): Promise<ImportFolderActionResult> {
    return this.fakeDataSources.folder(body);
  }

  dataSourcePush(id: string, body: DataSourcePushBody): Promise<DataSourcePushResult> {
    return this.fakeDataSources.push(id, body);
  }

  /** 设置 · 组件（323 号票）：原型里编的四个组件（prototype/fake-components.ts） */
  private readonly fakeComponents = new FakeComponents();

  components(): Promise<ComponentsView> {
    return this.fakeComponents.view();
  }

  componentAction(id: string, action: ComponentAction): Promise<ComponentsView> {
    return this.fakeComponents.act(id, action);
  }

  installDefaultComponents(): Promise<ComponentsView> {
    return this.fakeComponents.installDefaults();
  }

  importComponents(path: string): Promise<ComponentImportResult> {
    return this.fakeComponents.importFrom(path);
  }

  /** 网页是哪一版（116 号票）：地址里带 ?demo-update 时是假的新一版（和假连接推的一样），平常不知道（不提示） */
  webVersion(): Promise<WebVersionView> {
    const version = fakeServerWebVersion();
    return Promise.resolve(version === undefined ? {} : { version });
  }

  /** Debug 工具集（124 号票）：原型里没有识别进程，过 0.8 秒回一句假的识别结果 */
  async debugRecognize(audio: Blob): Promise<DebugRecognizeResult> {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { ok: true, text: `（原型里的假结果）收到 ${audio.size} 字节的录音`, ms: 812, model: "faster-whisper large-v3（原型）", device: "cpu", language: "zh" };
  }

  /** Debug 工具集：原型里没有合成服务，过 1.2 秒回一段 1 秒的"嘀"（导入过参考音色的写它的名字） */
  async debugSpeak(): Promise<DebugSpeakResult> {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const sampleRate = 16_000;
    const pcm = new Uint8Array(sampleRate * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < sampleRate; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 660 * i) / sampleRate) * 6000 * Math.min(1, (sampleRate - i) / 2000)), true);
    const wav = wavOf(pcm, { sampleRate, channels: 1, bitsPerSample: 16 });
    let binary = "";
    for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    const voice = this.voices.find((v) => v.id === this.currentVoice) ?? this.voices[0];
    return { ok: true, audioBase64: btoa(binary), mime: "audio/wav", ms: 1203, model: "audio.cpp/tts（原型）", voiceName: voice?.name ?? "原型里的假音色" };
  }

  /** 原型里授权的文件夹（只在内存里，134 号票） */
  private folders: string[] = ["D:\\照片", "D:\\文档"];

  /** 悬浮按钮上说的一段（149 号票）：原型里没有识别，过 0.8 秒回一句假的 */
  async pageVoice(): Promise<PageVoiceResult> {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { ok: true, text: "把我周末在杭州拍的照片贴上来" };
  }

  /** 原型的候选缩略图（149 号票）：和原图一样是画出来的 SVG */
  pageFileThumbUrl(token: string): string {
    return this.pageFileUrl(token);
  }

  pageFileUrl(token: string): string {
    const i = Number(token.replace(/^fake-photo-/, "")) || 0;
    const hue = (i * 47 + 190) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue},55%,62%)"/><circle cx="88" cy="32" r="14" fill="hsl(${hue},80%,88%)"/><path d="M0 120 L40 66 L70 96 L92 74 L120 104 L120 120Z" fill="hsl(${hue},40%,38%)"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  pageFileBytes(token: string): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(`原型里的假照片 ${token}`));
  }

  localFolders(): Promise<LocalFoldersView> {
    return Promise.resolve({ folders: this.folders.map((path) => ({ path, exists: true })) });
  }

  changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView> {
    const bad = (change.add ?? []).find((f) => !/^[A-Za-z]:[\\/]|^\//.test(f.trim()));
    if (bad) return Promise.reject(new Error(`要写完整的路径（比如 D:\\照片）：${bad}`));
    const kept = this.folders.filter((f) => !(change.remove ?? []).some((r) => same(r, f)));
    const added = (change.add ?? []).map((f) => f.trim()).filter((f, i, all) => !kept.some((k) => same(k, f)) && all.findIndex((x) => same(x, f)) === i);
    if (kept.length + added.length > 20) return Promise.reject(new Error("最多授权 20 个文件夹"));
    this.folders = [...kept, ...added];
    return this.localFolders();
  }

  /** 原型里选文件夹的框：一棵假的文件夹树（FAKE_FOLDER_TREE） */
  browseFolders(folder?: string): Promise<FolderBrowseView> {
    if (folder === undefined) return Promise.resolve({ kind: "roots", places: FAKE_FOLDER_PLACES, drives: FAKE_FOLDER_DRIVES });
    const node = FAKE_FOLDER_TREE.find((n) => n.path.toLowerCase() === folder.trim().toLowerCase());
    if (!node) return Promise.resolve({ kind: "unreadable", path: folder, reason: "原型里没有这个文件夹" });
    const join = (name: string) => (node.path.endsWith("\\") ? `${node.path}${name}` : `${node.path}\\${name}`);
    return Promise.resolve({
      kind: "folder",
      path: node.path,
      ...(node.parent === undefined ? {} : { parent: node.parent }),
      folders: node.children.map((name) => ({ name, path: join(name) })),
      total: node.children.length,
    });
  }

  setLocalFolders(folders: readonly string[]): Promise<LocalFoldersView> {
    const bad = folders.find((f) => !/^[A-Za-z]:[\\/]|^\//.test(f.trim()));
    if (bad) return Promise.reject(new Error(`要写完整的路径（比如 D:\\照片）：${bad}`));
    this.folders = [...new Set(folders.map((f) => f.trim()).filter(Boolean))];
    return this.localFolders();
  }

  private voiceList(): ReferenceVoiceList {
    const current = this.voices.find((v) => v.id === this.currentVoice) ?? this.voices[0];
    return { voices: this.voices, ...(current ? { currentId: current.id } : {}) };
  }
}

/** 今天往后数 offset 天的 hh:mm（原型的备份用） */
function fakeDay(offset: number, hh: number, mm: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/** YYYY-MM-DD（本地日期） */
function fakeDateOf(d: Date): string {
  return nowIso(d).slice(0, 10);
}

/** 原型的备份（335 号票）：每天 03:30 守护进程自己做，昨晚那次写进了同步目录；下一次是明天 03:30 */
function fakeBackupStatus(): BackupStatusView {
  const day = fakeDay;
  const dateOf = fakeDateOf;
  const last = day(0, 3, 30);
  return {
    schedule: "internal",
    time: "03:30",
    next: nowIso(day(1, 3, 30)),
    syncDir: { kind: "ready", dir: "D:\\HomeStorage\\ergo-backup" },
    latestLocal: dateOf(last),
    latestSync: dateOf(last),
    last: { by: "daemon", mode: "auto", startedAt: nowIso(last), finishedAt: nowIso(day(0, 3, 31)), date: dateOf(last), local: "created", sync: "copied" },
    queued: false,
  };
}
