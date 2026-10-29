// 前端协议里走 HTTP 的那部分（规格第 5 节）：上传附件（分片续传）、往上翻历史、媒体的地址；
// 设置里按会话、按时间段删除素材（21 号票），看范围里的素材和一条的完整内容（158 号票）；设置里的工作日历改个人设置（29 号票：改完守护进程在工作日历频道上推事件）；
// 消耗页的汇总和粗估成本（24 号票）；设置里的语音页：参考音色的列出、导入、选用、删除、试听（32 号票）；
// skill 库、已登记的 MCP，导入 skill（27 号票；导入并改名、整套导入集合、秘书用的 skill，72 号票）；主导航的日历按月取每一天的日历条目（35 号票）；
// 分段合成的 agent 语音边收边播时一段的地址（38 号票）；设置里改个人助理的名字（43 号票：改完守护进程在名字频道上推事件）；
// 我的名字（249 号票：用户自己的名字，GET 取、PUT 改，不走事件）；
// 设置 · 语言、网页的词典、换语言（168 号票：换完守护进程在语言频道上推事件）；
// 设置 · 语音里两个语音模型的状态（45 号票）；详情页里一次工具调用的完整参数和返回（56 号票，接口是 53 号票的）；
// 设置里工具调用的完整内容占了多大、"现在就清理"（65 号票）。设置里的系统提示：看、保存、恢复默认（71 号票）。
// 输入框里打 / 弹出的候选：这个会话能用的斜杠命令（82 号票）。
// 设置里的"模型"：取、整份存、连通测试（73 号票）。报告页取文本类附件的内容（113 号票）。设置 · 插件：列出、停用 / 启用 / 移除（211 号票）。
// 网页现在是哪一版（116 号票：切回前台时问一次，和页面自己的对不上就提示刷新）。项目页上的"规范"一块（258 号票）。
// Debug 工具集的语音组：录一段送识别、合成念一句（124 号票，不经会话）。
// 每个 agent 的会话里的 ⚙：面板、单独的提示词、清空当前对话、现在压缩（114 号票）；项目、任务的维护者单独配模型（120 号票）。
// 和 Connection 一样只在 App.tsx 里注入一次（StoreProvider 的 http）：页面由守护进程提供时是 HttpDaemonClient，
// 直接打开构建产物（file://）时是原型的假实现（prototype/fake-http.ts）。
import { type AgentModelBody, type AgentPromptBody, type AgentRuntimeBody, type RuntimeFolderBody, type RuntimeSessionsView, type WorkFolderCheckResult, type TakeoverAction, type TakeOverBody, type TakeOverResult, type AgentRoleAssignmentBody, type AgentRoleBody, type AgentRolesView, type AgentRoleUpdateBody, type AgentSettingsView, type AssistantNameResult, type BranchView, type CalendarMonthView, type ConversationId, type DebugRecognizeBody, type DebugRecognizeResult, type DebugSpeakBody, type DebugSpeakResult, type DeleteMaterialsBody, type DeleteMaterialsResult, type FileTextResult, type FolderBrowseView, type FramePreview, type HistoryPage, HTTP_PATHS, type HttpErrorBody, type ImportReferenceVoiceBody, type ImportSkillBody, type ImportSkillResult, type InterviewStartResult, type InterviewStatusView, type LanguageResult, type LocaleDictionaryView, type LocaleListView, type LocalFoldersBody, type LocalFoldersChangeBody, type LocalFoldersView, type MaterialDetailView, type MaterialListFilter, type MaterialListPage, type MaterialScope, type MaterialScopeSummary, type MediaTextResult, type MediaTextView, type MemoryClaimDetailView, type MemoryClaimListPage, type MemoryClaimQuery, type MemoryDeleteMode, type MemoryQuestionsView, type MemoryStrategiesView, type MemorySettingsBody, type MemorySettingsView, type MemorySummaryView, type SafetySettingsBody, type SafetySettingsView, type ModelSettingsBody, type ModelSettingsView, type ModelTestResult, type PageVoiceBody, type PageVoiceResult, type PluginAction, type PluginActionResult, type PluginsView, type ProjectStandardView, type ReferenceVoice, type ReferenceVoiceList, type RollbackPreview, type RollbackTarget, type SaveWebPageBody, type SaveWebPageResult, type SecretarySkillsBody, type SecretarySkillsView, type SlashCommandList, type SystemPromptBody, type SystemPromptDetail, type SystemPromptList, t, type TaskStageView, type ToolCallCleanupResult, type ToolCallDetail, type ToolCallStorageView, type BackupStatusView, type ToolkitCatalog, type UploadedMedia, type UsageSummary, type UserNameResult, type UserNameView, type AddPersonBody, type PersonalFileChangeBody, type PersonalFileDeleteBody, type PersonalFileDeleteResult, type PersonalFileLearnedView, type PersonalFilesView, type PersonalFileView, type VoiceModelsView, type WebSettingsBody, type WebSettingsView, type WebVersionView, type WorkdayChange, type WorkdayChangeResult, type RuntimesView, type DataSourceActionBody, type DataSourceActionResult, type DataSourcesView, type ImportFolderActionBody, type ImportFolderActionResult, type DataSourcePushBody, type DataSourcePushResult, type ModelKeyBody, type ModelKeyView, type ModelKeyWriteResult, type ComponentAction, type ComponentImportResult, type ComponentsView } from "../state/index.ts";
import { fetchFileText } from "./file-source.ts";
import { httpErrorMessage, notJsonMessage } from "./http-error.ts";
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
  /**
   * HTML、SVG 附件在报告页的框里看的地址（117 号票）：HTML 给 <iframe sandbox>，SVG 给 <img>；守护进程按媒体 id 发出原文，
   * 带把它关进沙箱的响应头。没有真文件（原型的假附件也没有内容）时为 undefined
   */
  mediaFrameUrl(mediaId: string, frame: FramePreview): string | undefined;
  /**
   * 内置浏览器里渲染文件时取内容（160 号票）：守护进程转发的服务里的文件（/apps/…，同源，带着凭证），只读开头 1 MB；
   * 不是能渲染的文本（网页）回 page，取不到回 error（不抛错）。原型里是几份编的样例（prototype/fake-app-files.ts）
   */
  appFileText(url: string, signal?: AbortSignal): Promise<FileTextResult>;
  /** 素材范围里有几条（不给范围是全部），以及有素材的会话 */
  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary>;
  /** 对范围内的全部素材执行一种删法（幂等键：重发只执行一次），返回处理了几条 */
  deleteMaterials(scope: MaterialScope, mode: MemoryDeleteMode, idempotencyKey: string): Promise<DeleteMaterialsResult>;
  /** 范围里的素材，一页（158 号票：新的在前；offset 从 0 起）；167 号票起可以再按时间段、种类、会话、关键词筛（filter） */
  materialList(scope: MaterialScope | undefined, page: { offset: number; limit: number }, filter?: MaterialListFilter): Promise<MaterialListPage>;
  /** 一条素材的完整内容和来源（158 号票，每次打开现取）；没有这条（删了）是 undefined */
  material(materialId: string, signal?: AbortSignal): Promise<MaterialDetailView | undefined>;
  /**
   * 记忆的推理库概览（233 号票）：各层、各状态各几条、问题箱开着几个、最近一次整理的时间和新增条数。
   * 推理库还没建、版本对不上、正被每晚整理占着都是 ready: false 加一句原因（接口照旧成功）
   */
  memorySummary(): Promise<MemorySummaryView>;
  /** 结论列表（233 号票）：按层、按状态筛，一页（默认 50 条，最多 MEMORY_CLAIMS_MAX 条）；每次现取 */
  memoryClaims(query?: MemoryClaimQuery): Promise<MemoryClaimListPage>;
  /** 一条结论的完整解释（233 号票）：证据链、支持/反对、只当背景的、竞争解释、推理、修订；没有这条结论是 undefined */
  memoryClaim(claimId: string, signal?: AbortSignal): Promise<MemoryClaimDetailView | undefined>;
  /** 问题箱（233 号票）：问什么、为什么问、能区分哪几条、优先级、状态；每次现取 */
  memoryQuestions(query?: { limit?: number }): Promise<MemoryQuestionsView>;
  /** 330 号票：做法（交互策略）列表 */
  memoryStrategies(): Promise<MemoryStrategiesView>;
  /** 记忆的设置（264 号票）：秘书顺口问开不开 */
  memorySettings(): Promise<MemorySettingsView>;
  saveMemorySettings(body: MemorySettingsBody): Promise<MemorySettingsView>;
  /** 安全和预算的两个开关（315 号票）：先问我、任务的预算；改哪项给哪项，守护进程写进配置文件、马上生效 */
  safetySettings(): Promise<SafetySettingsView>;
  saveSafetySettings(body: SafetySettingsBody): Promise<SafetySettingsView>;
  /** 了解你访谈的样子（284 号票）：开着的那次、聊过哪几个主题、下次聊什么、约访开没开；记忆插件没启用时出错 */
  memoryInterview(): Promise<InterviewStatusView>;
  /** 记忆管理员对话里的"开始访谈"（284 号票；285 号票前是记忆页的"找管理员聊聊"）：开一次访谈（已经开着就是那一次） */
  startInterview(): Promise<InterviewStartResult>;
  /** "浏览"的 ⋮ 菜单里"存进二狗的素材"（165 号票）：存这一页的标题、地址、正文；同一个幂等键重发只存一次 */
  saveWebPage(body: SaveWebPageBody): Promise<SaveWebPageResult>;
  /** 改个人工作日历（加删额外规则、把某天标成上班或休息、清掉标记）；结果随后在工作日历频道上推来 */
  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult>;
  /** 改个人助理的名字（"恢复默认"就是改回默认的名字）；不合规时抛错，message 是原因；名字随后在名字频道上推来 */
  setAssistantName(name: string): Promise<AssistantNameResult>;
  /**
   * 我的名字（249 号票）：用户**自己**的名字，GET /api/user-name 现取（改完也是改的那台设备现取，不走事件）；
   * 没设（文件不在、读坏了只当没设）时没有 name
   */
  userName(): Promise<UserNameView>;
  /** 改我的名字（PUT /api/user-name，null 或者空串 = 清除）；不合规时抛错，message 是原因 */
  setUserName(name: string | null): Promise<UserNameResult>;
  /** 个人档案（281 号票）：本人那份在最前，然后是重要的人；每次打开现取（不走事件） */
  personalFiles(): Promise<PersonalFilesView>;
  /** 一份档案：三块（固定信息连同历史、记下的事、二狗了解到的位置）；没有这份抛错 */
  personalFile(personId: string): Promise<PersonalFileView>;
  /** 加一个重要的人（改了就算确认）；不合规、重名时抛错，message 是原因 */
  addPerson(body: AddPersonBody): Promise<PersonalFileView>;
  /** 在档案页里改：写字段、记下一件事、撤销一个字段最近一次写入；回这份档案现在的样子 */
  changePersonalFile(personId: string, body: PersonalFileChangeBody): Promise<PersonalFileView>;
  /** 删一个人、一个字段、一件事：忘掉或彻底删除（可以连出处的原话一起） */
  deletePersonalFile(personId: string, body: PersonalFileDeleteBody): Promise<PersonalFileDeleteResult>;
  /** 二狗了解到的（283 号票）：经记忆插件现取；插件没启用时 ready 是 false、写明原因 */
  personalFileLearned(personId: string): Promise<PersonalFileLearnedView>;
  /** 设置 · 语言（168 号票）：选的、实际在用的、有哪些语言（从哪来、缺几句）、~/.ergo/locales 在哪、读语言文件出的问题；每次打开现取 */
  locales(): Promise<LocaleListView>;
  /** 网页的词典（168 号票）：实际在用的语言（自带 + ~/.ergo/locales 里的，合好的），不是中文时连同中文的 */
  locale(): Promise<LocaleDictionaryView>;
  /** 换语言（168 号票，全局一个，所有设备一起变）：列表里没有的抛错，message 是原因；随后语言频道上推来 */
  setLanguage(language: string): Promise<LanguageResult>;
  /** 消耗页：from 到 to（本地日期，含两头）按天、按 agent 的用量，系统开销单列，粗估成本 */
  usage(range: { from: string; to: string }): Promise<UsageSummary>;
  /** 日历：某个月（YYYY-MM）每一天的日历条目（工作日判定、当天的提醒和定时作业） */
  calendarMonth(month: string): Promise<CalendarMonthView>;
  /** 参考音色：全部（按导入的先后）和现在用的那个 */
  referenceVoices(): Promise<ReferenceVoiceList>;
  /** 导入一个参考音色（名字、音频；逐字稿不给就自动识别，230 号票）；不合规矩的抛错，message 是原因 */
  importReferenceVoice(input: { name: string; referenceText?: string; audio: Blob }): Promise<ReferenceVoice>;
  /** 选它作为语音回复用的 */
  selectReferenceVoice(voiceId: string): Promise<ReferenceVoiceList>;
  /** 删掉一个参考音色 */
  removeReferenceVoice(voiceId: string): Promise<ReferenceVoiceList>;
  /** 试听：参考录音的地址；原型里没有真录音时为 undefined */
  referenceVoiceAudioUrl(voiceId: string): string | undefined;
  /** 分段合成的 agent 语音里合成好的第 index 段的地址（38 号票）；原型里没有真语音时为 undefined */
  agentVoiceSegmentUrl(voiceId: string, index: number): string | undefined;
  /**
   * 项目的服务首页缩略图的地址（140 号票）：按项目编号和服务名；at 是手里这张的截图时间（换了新图换地址），seen 见协议包的
   * serviceThumbnailSeen（旧了、还没有时每 6 小时换一次，让"有人在看"的请求发得出去）。原型里没有真截图的为 undefined
   */
  serviceThumbnailUrl(projectId: string, name: string, query: { at?: string | undefined; seen?: string | undefined }): string | undefined;
  /**
   * 项目规范（258 号票，项目页每次打开现取，不缓存）：用的模板版本、每份文档在不在、检查清单进度、规范改写；
   * 没有这个项目（删掉了）是 undefined
   */
  projectStandard(projectId: string, signal?: AbortSignal): Promise<ProjectStandardView | undefined>;
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
  /** 回退前的确认（150 号票）：回到这一条之前会放弃掉的那一段已经做了的事；回不到那里时拒绝（带原因） */
  rollbackPreview(conversation: ConversationId, before: RollbackTarget, signal?: AbortSignal): Promise<RollbackPreview>;
  /**
   * 一条分支的样子（151 号票）：它路径上不在 against（不给是当前分支）路径上的那一段——消息、记录、遗留效果、分支摘要。
   * 废弃分支的 ⑂ 预览、详情取它；切换分支之后补手里缺的那一段也取它
   */
  branchView(conversation: ConversationId, branchId: string, against?: string, signal?: AbortSignal): Promise<BranchView>;
  /** 设置里：工具调用的完整内容占了多大、保留多久、总量上限、照现在的规则马上清会清掉多少（65 号票） */
  toolCallStorage(): Promise<ToolCallStorageView>;
  /** 设置里的"现在就清理"：按现在的规则马上清一次，回清了多少（点之前界面先确认） */
  cleanupToolCalls(): Promise<ToolCallCleanupResult>;
  /** 设置里的"备份"（335 号票）：谁来定时、下一次、同步目录、最新的快照、最近一次、现在有没有一份在做（每次现取） */
  backupStatus(): Promise<BackupStatusView>;
  /** "立即备份"：守护进程排一次，不等做完，回现在的状况（做完的结果接着取 backupStatus） */
  backupRun(): Promise<BackupStatusView>;
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
  /** 模型的 key 配没配（315 号票）：不查模型目录、马上回；会话页上"还没配模型"的提示用 */
  modelKey(): Promise<ModelKeyView>;
  /**
   * 在网页上填一个模型的 key（319 号票）：写进密钥区的文件、换成现在用的，回配好了、什么时候生效。
   * key 太短、太长时抛错（message 是原因）；回的、界面上的都没有 key 的内容
   */
  saveModelKey(key: string): Promise<ModelKeyWriteResult>;
  /** 设置里 agent 的联网搜索、读网页（154 号票）：默认的搜索方式、读网页用不用 DeepSeek、DeepSeek 的 key 配没配、最近一次余额不足 */
  webSettings(): Promise<WebSettingsView>;
  /** 整份存（不合规时抛错，message 是原因），回存好之后的；下一次搜索、读网页就按新的 */
  saveWebSettings(body: WebSettingsBody): Promise<WebSettingsView>;
  /** 设置 · 插件（211 号票）：清单里的全部插件（给人看的字按守护进程当前的语言）；每次打开、插件的状况变了现取 */
  plugins(): Promise<PluginsView>;
  /**
   * 停用、启用（移除了的就是装回）、移除一个插件，马上生效；移除时 purgeData 连它的数据一起彻底删除。做不了的抛错（message 是原因）。
   * 状况随后在插件频道上推来（网页插件跟着装、停）
   */
  pluginAction(name: string, body: { action: PluginAction; purgeData?: boolean; idempotencyKey: string }): Promise<PluginActionResult>;
  /**
   * 设置 · 数据源（295 号票）：插件登记的全部数据源（停用的插件的也在，写明没启用）和导入文件夹（路径、留着没导入的、最近导入的）；
   * 每次打开、插件的状况变了、正在同步时隔一会儿现取
   */
  dataSources(): Promise<DataSourcesView>;
  /** 立即同步、断开（purge：连已导入的一起删）、开关一种用法、填设置（值交给数据源存进密钥区）；做不了的抛错（message 是原因） */
  dataSourceAction(id: string, body: DataSourceActionBody): Promise<DataSourceActionResult>;
  /** 导入文件夹：现在看一遍（出错过的也再试）、在电脑上打开 */
  importFolderAction(body: ImportFolderActionBody): Promise<ImportFolderActionResult>;
  /** 设备交来的（299 号票：手机上的二狗 App 读本机的通讯录、日历）；不收的抛错（message 是原因） */
  dataSourcePush(id: string, body: DataSourcePushBody): Promise<DataSourcePushResult>;
  /** 设置 · 组件（323 号票）：清单里的全部组件现在的样子（装了没有、大小、版本、下载进度）；每次打开、正在下时每秒现取 */
  components(): Promise<ComponentsView>;
  /** 装、更新、删、暂停、继续、取消一个组件（下载在守护进程的后台做，马上回）；做不了的抛错（message 是原因） */
  componentAction(id: string, action: ComponentAction): Promise<ComponentsView>;
  /** 装上照默认该装、还没装的 */
  installDefaultComponents(): Promise<ComponentsView>;
  /** 离线导入守护进程那台电脑上的一个文件、文件夹或 .tar / .tgz 包（按清单里的大小和校验值认）；路径不在、包坏了抛错 */
  importComponents(path: string): Promise<ComponentImportResult>;
  /**
   * 登记了的 agent 运行时（286 号票）：pi 和插件登记的，连同能力清单、可选模型和设置项、现在能不能用（插件停用了写明原因）；
   * 每次现取（插件的状况变了跟着变）。这一张只接通，289 号票起新建任务、项目和 ⚙ 用它
   */
  runtimes(): Promise<RuntimesView>;
  /** 能选工作文件夹的运行时新建时的默认文件夹（305 号票）：null 是不设；路径不对抛错（message 是原因），交回改过的运行时清单 */
  setRuntimeFolder(runtimeId: string, folder: string | null): Promise<RuntimesView>;
  /** 核对一个已有的文件夹（305 号票，新建对话框交之前）：能用交回真实路径，不能用抛错（message 是原因） */
  checkRuntimeFolder(runtimeId: string, folder: string): Promise<WorkFolderCheckResult>;
  /** 一个 agent 的 ⚙ 面板（114 号票）：单独的提示词和通用模板、实际用的系统提示、清空、上下文用量和压缩；每次打开现取 */
  agentSettings(agentId: string): Promise<AgentSettingsView>;
  /** 存这个 agent 单独的提示词：占位符写错时抛错，message 写明第几行错在哪；从它的下一轮起生效 */
  saveAgentPrompt(agentId: string, body: AgentPromptBody): Promise<AgentSettingsView>;
  /** 恢复用通用模板 */
  resetAgentPrompt(agentId: string): Promise<AgentSettingsView>;
  /** 清空当前对话（界面先确认过）：在处理一条时等它说完再清；幂等键重发只清一次 */
  clearAgent(agentId: string, idempotencyKey: string): Promise<AgentSettingsView>;
  /** 现在压缩：不等压完（面板按 compaction 的状态再取） */
  compactAgent(agentId: string): Promise<AgentSettingsView>;
  /** 项目、任务的维护者单独配模型（120 号票）：模型目录里没有的、只读的抛错（message 是原因）；下一个新会话起生效 */
  setAgentModel(agentId: string, body: AgentModelBody): Promise<AgentSettingsView>;
  /** 改回跟随它那一行（设置 · 模型里的项目维护者 / 任务维护者） */
  followAgentModel(agentId: string): Promise<AgentSettingsView>;
  /** 项目、任务的维护者用哪个运行时、给它选的模型和设置项（289 号票）：换运行时的等手头这一条做完、原来的写好交接摘要才换 */
  setAgentRuntime(agentId: string, body: AgentRuntimeBody): Promise<AgentSettingsView>;
  /** 这个运行时在本机能接管的会话（290 号票，每次现取）：正被占着的、二狗自己在管的写明 */
  runtimeSessions(runtimeId: string): Promise<RuntimeSessionsView>;
  /** 从选中的会话接管成任务或项目（290 号票）：被占着的不分叉就抛错（message 写明在哪开着） */
  takeOver(runtimeId: string, body: TakeOverBody): Promise<TakeOverResult>;
  /** 接管来的会话交还给运行时 / 收回（290 号票）：在做一轮的不交还、别处开着的不收回（抛错，message 是原因） */
  agentTakeover(agentId: string, action: TakeoverAction): Promise<AgentSettingsView>;
  /**
   * 角色（248 号票，每次现取、不缓存）：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色、参考音色；
   * 增删改、设默认、给 agent 换角色之后回的都是整份（AgentRolesView）
   */
  agentRoles(): Promise<AgentRolesView>;
  /** 新建一个角色：名字不合规、音色不存在、语音插件没启用时写音色抛错（message 是原因） */
  createAgentRole(body: AgentRoleBody): Promise<AgentRolesView>;
  /** 改名 / 换音色（只写要改的；默认角色会同时改全局名字 / 全局选中的音色） */
  updateAgentRole(roleId: string, body: AgentRoleUpdateBody): Promise<AgentRolesView>;
  /** 删一个角色：默认角色、还有 agent 在用的抛错（message 写明是谁） */
  deleteAgentRole(roleId: string): Promise<AgentRolesView>;
  /** 把某个角色设成默认 */
  setDefaultAgentRole(roleId: string): Promise<AgentRolesView>;
  /** 给一个 agent 选角色：null = 跟默认 */
  assignAgentRole(agentId: string, roleId: string | null): Promise<AgentRolesView>;
  /** 守护进程现在提供的网页是哪一版（116 号票，切回前台时问一次，不缓存）；不知道时没有 version */
  webVersion(signal?: AbortSignal): Promise<WebVersionView>;
  /** Debug 工具集（124 号票）：录的一段送识别，不经会话；识别不了回 ok: false 和原因，接口本身出错（太旧的守护进程没有）抛错 */
  debugRecognize(audio: Blob): Promise<DebugRecognizeResult>;
  /** Debug 工具集：用当前参考音色合成念一句，回 WAV（base64）和耗时；合成不了回 ok: false 和原因 */
  debugSpeak(text: string): Promise<DebugSpeakResult>;
  /** 悬浮按钮上按住说的一段送识别（149 号票）：回认出来的字；没认出回 ok: false 和原因，接口本身出错抛错 */
  pageVoice(body: PageVoiceBody): Promise<PageVoiceResult>;
  /** 要交进上传框的一个文件的地址（凭取件码） */
  pageFileUrl(token: string): string;
  /** 候选的缩略图的地址（149 号票，凭取件码；守护进程缩好的小图，挑图片窗口、会话里的候选卡用它，不下原图） */
  pageFileThumbUrl(token: string): string;
  /** 要交进上传框的一个文件的字节（交给 App 之前先取回来） */
  pageFileBytes(token: string): Promise<Uint8Array>;
  /** 授权的文件夹（134 号票，138 号票起叫这个名字：秘书和"浏览"里的二狗共用，设置 · 浏览与填框里看、改） */
  localFolders(): Promise<LocalFoldersView>;
  /** 整份换掉授权的文件夹；路径不对抛错（message 是原因） */
  setLocalFolders(folders: readonly string[]): Promise<LocalFoldersView>;
  /** 授权的文件夹加几个、拿掉几个，马上存（138 号票）；路径不对、超过上限抛错（message 是原因） */
  changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView>;
  /** 选文件夹的框（138 号票）：列守护进程那台电脑上的子文件夹；不给路径是常用位置和各个盘 */
  browseFolders(folder?: string): Promise<FolderBrowseView>;
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
    if (!res.ok) throw new Error(t("app.daemonHttp.historyFailed", { status: res.status }));
    return (await res.json()) as HistoryPage;
  }

  mediaUrl(mediaId: string, name: string, options: { download?: boolean } = {}): string {
    return `${this.baseUrl}${HTTP_PATHS.media(mediaId, { name, download: options.download })}`;
  }

  mediaFrameUrl(mediaId: string, frame: FramePreview): string {
    return `${this.baseUrl}${frame === "html" ? HTTP_PATHS.mediaHtml(mediaId) : HTTP_PATHS.mediaSvg(mediaId)}`;
  }

  appFileText(url: string, signal?: AbortSignal): Promise<FileTextResult> {
    return fetchFileText((input, init) => fetch(input, init), url, signal);
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

  materialList(scope: MaterialScope | undefined, page: { offset: number; limit: number }, filter?: MaterialListFilter): Promise<MaterialListPage> {
    return this.post<MaterialListPage>(HTTP_PATHS.materialsList, { ...(scope === undefined ? {} : { scope }), ...page, ...(filter === undefined ? {} : { filter }) });
  }

  async material(materialId: string, signal?: AbortSignal): Promise<MaterialDetailView | undefined> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.material(materialId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (res.status === 404) return undefined;
    return this.json<MaterialDetailView>(res);
  }

  saveWebPage(body: SaveWebPageBody): Promise<SaveWebPageResult> {
    return this.post<SaveWebPageResult>(HTTP_PATHS.materialsWebPage, body);
  }

  // 记忆的推理库只读看（233 号票）：每次现取不缓存（每晚整理完结论会变；整理正占着库的时候返回 ready: false）
  async memorySummary(): Promise<MemorySummaryView> {
    return this.json<MemorySummaryView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memorySummary}`, { cache: "no-store" }));
  }

  async memoryClaims(query: MemoryClaimQuery = {}): Promise<MemoryClaimListPage> {
    return this.json<MemoryClaimListPage>(await fetch(`${this.baseUrl}${HTTP_PATHS.memoryClaims(query)}`, { cache: "no-store" }));
  }

  async memoryClaim(claimId: string, signal?: AbortSignal): Promise<MemoryClaimDetailView | undefined> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.memoryClaim(claimId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (res.status === 404) return undefined;
    return this.json<MemoryClaimDetailView>(res);
  }

  async memoryQuestions(query: { limit?: number } = {}): Promise<MemoryQuestionsView> {
    return this.json<MemoryQuestionsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memoryQuestions(query)}`, { cache: "no-store" }));
  }

  async memoryStrategies(): Promise<MemoryStrategiesView> {
    return this.json<MemoryStrategiesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memoryStrategies()}`, { cache: "no-store" }));
  }

  async memorySettings(): Promise<MemorySettingsView> {
    return this.json<MemorySettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memorySettings}`, { cache: "no-store" }));
  }

  async saveMemorySettings(body: MemorySettingsBody): Promise<MemorySettingsView> {
    return this.json<MemorySettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memorySettings}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async safetySettings(): Promise<SafetySettingsView> {
    return this.json<SafetySettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.safetySettings}`, { cache: "no-store" }));
  }

  async saveSafetySettings(body: SafetySettingsBody): Promise<SafetySettingsView> {
    return this.json<SafetySettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.safetySettings}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async memoryInterview(): Promise<InterviewStatusView> {
    return this.json<InterviewStatusView>(await fetch(`${this.baseUrl}${HTTP_PATHS.memoryInterview}`, { cache: "no-store" }));
  }

  startInterview(): Promise<InterviewStartResult> {
    return this.post<InterviewStartResult>(HTTP_PATHS.memoryInterview, {});
  }

  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult> {
    return this.post<WorkdayChangeResult>(HTTP_PATHS.workdayCalendar, { change });
  }

  setAssistantName(name: string): Promise<AssistantNameResult> {
    return this.post<AssistantNameResult>(HTTP_PATHS.assistantName, { name });
  }

  // 我的名字（249 号票）：现取现写，不缓存（设置里改完马上读得到）
  async userName(): Promise<UserNameView> {
    return this.json<UserNameView>(await fetch(`${this.baseUrl}${HTTP_PATHS.userName}`, { cache: "no-store" }));
  }

  async setUserName(name: string | null): Promise<UserNameResult> {
    return this.json<UserNameResult>(await fetch(`${this.baseUrl}${HTTP_PATHS.userName}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
  }

  // 个人档案（281 号票）：现取，不缓存（别处刚确认了核对卡，打开就要读得到）
  async personalFiles(): Promise<PersonalFilesView> {
    return this.json<PersonalFilesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.personalFiles}`, { cache: "no-store" }));
  }

  async personalFile(personId: string): Promise<PersonalFileView> {
    return this.json<PersonalFileView>(await fetch(`${this.baseUrl}${HTTP_PATHS.personalFile(personId)}`, { cache: "no-store" }));
  }

  addPerson(body: AddPersonBody): Promise<PersonalFileView> {
    return this.post<PersonalFileView>(HTTP_PATHS.personalFiles, body);
  }

  changePersonalFile(personId: string, body: PersonalFileChangeBody): Promise<PersonalFileView> {
    return this.post<PersonalFileView>(HTTP_PATHS.personalFile(personId), body);
  }

  deletePersonalFile(personId: string, body: PersonalFileDeleteBody): Promise<PersonalFileDeleteResult> {
    return this.post<PersonalFileDeleteResult>(HTTP_PATHS.personalFileDelete(personId), body);
  }

  async personalFileLearned(personId: string): Promise<PersonalFileLearnedView> {
    return this.json<PersonalFileLearnedView>(await fetch(`${this.baseUrl}${HTTP_PATHS.personalFileLearned(personId)}`, { cache: "no-store" }));
  }

  async locales(): Promise<LocaleListView> {
    return this.json<LocaleListView>(await fetch(`${this.baseUrl}${HTTP_PATHS.locales}`, { cache: "no-store" }));
  }

  async locale(): Promise<LocaleDictionaryView> {
    return this.json<LocaleDictionaryView>(await fetch(`${this.baseUrl}${HTTP_PATHS.locale}`, { cache: "no-store" }));
  }

  setLanguage(language: string): Promise<LanguageResult> {
    return this.post<LanguageResult>(HTTP_PATHS.language, { language });
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

  async importReferenceVoice(input: { name: string; referenceText?: string; audio: Blob }): Promise<ReferenceVoice> {
    const body: ImportReferenceVoiceBody = { name: input.name, ...(input.referenceText === undefined ? {} : { referenceText: input.referenceText }), audioBase64: await base64Of(input.audio) };
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

  serviceThumbnailUrl(projectId: string, name: string, query: { at?: string | undefined; seen?: string | undefined }): string {
    return `${this.baseUrl}${HTTP_PATHS.serviceThumbnail(projectId, name, query)}`;
  }

  // 项目规范（258 号票）：档案里的文件随时会改，每次现取
  async projectStandard(projectId: string, signal?: AbortSignal): Promise<ProjectStandardView | undefined> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.projectStandard(projectId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (res.status === 404) return undefined;
    return this.json<ProjectStandardView>(res);
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

  async rollbackPreview(conversation: ConversationId, before: RollbackTarget, signal?: AbortSignal): Promise<RollbackPreview> {
    return this.json<RollbackPreview>(await fetch(`${this.baseUrl}${HTTP_PATHS.rollbackPreview(conversation, before)}`, { cache: "no-store", ...(signal ? { signal } : {}) }));
  }

  async branchView(conversation: ConversationId, branchId: string, against?: string, signal?: AbortSignal): Promise<BranchView> {
    return this.json<BranchView>(await fetch(`${this.baseUrl}${HTTP_PATHS.branchView(conversation, branchId, against)}`, { cache: "no-store", ...(signal ? { signal } : {}) }));
  }

  async toolCallStorage(): Promise<ToolCallStorageView> {
    return this.json<ToolCallStorageView>(await fetch(`${this.baseUrl}${HTTP_PATHS.toolCallStorage}`, { cache: "no-store" }));
  }

  async cleanupToolCalls(): Promise<ToolCallCleanupResult> {
    return this.json<ToolCallCleanupResult>(await fetch(`${this.baseUrl}${HTTP_PATHS.toolCallStorageCleanup}`, { method: "POST" }));
  }

  async backupStatus(): Promise<BackupStatusView> {
    return this.json<BackupStatusView>(await fetch(`${this.baseUrl}${HTTP_PATHS.backup}`, { cache: "no-store" }));
  }

  async backupRun(): Promise<BackupStatusView> {
    return this.json<BackupStatusView>(await fetch(`${this.baseUrl}${HTTP_PATHS.backupRun}`, { method: "POST" }));
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

  async modelKey(): Promise<ModelKeyView> {
    return this.json<ModelKeyView>(await fetch(`${this.baseUrl}${HTTP_PATHS.modelSettingsKey}`, { cache: "no-store" }));
  }

  saveModelKey(key: string): Promise<ModelKeyWriteResult> {
    const body: ModelKeyBody = { key };
    return this.post<ModelKeyWriteResult>(HTTP_PATHS.modelSettingsKey, body);
  }

  async webSettings(): Promise<WebSettingsView> {
    return this.json<WebSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.webSettings}`, { cache: "no-store" }));
  }

  saveWebSettings(body: WebSettingsBody): Promise<WebSettingsView> {
    return this.post<WebSettingsView>(HTTP_PATHS.webSettings, body);
  }

  // 设置 · 插件（211 号票）：每次现取，不缓存
  async plugins(): Promise<PluginsView> {
    return this.json<PluginsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.plugins}`, { cache: "no-store" }));
  }

  pluginAction(name: string, body: { action: PluginAction; purgeData?: boolean; idempotencyKey: string }): Promise<PluginActionResult> {
    return this.post<PluginActionResult>(HTTP_PATHS.plugin(name), body);
  }

  // 设置 · 数据源（295 号票）：每次现取，不缓存
  async dataSources(): Promise<DataSourcesView> {
    return this.json<DataSourcesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.dataSources}`, { cache: "no-store" }));
  }

  dataSourceAction(id: string, body: DataSourceActionBody): Promise<DataSourceActionResult> {
    return this.post<DataSourceActionResult>(HTTP_PATHS.dataSource(id), body);
  }

  importFolderAction(body: ImportFolderActionBody): Promise<ImportFolderActionResult> {
    return this.post<ImportFolderActionResult>(HTTP_PATHS.importFolder, body);
  }

  dataSourcePush(id: string, body: DataSourcePushBody): Promise<DataSourcePushResult> {
    return this.post<DataSourcePushResult>(HTTP_PATHS.dataSourcePush(id), body);
  }

  // 设置 · 组件（323 号票）：每次现取，不缓存
  async components(): Promise<ComponentsView> {
    return this.json<ComponentsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.components}`, { cache: "no-store" }));
  }

  componentAction(id: string, action: ComponentAction): Promise<ComponentsView> {
    return this.post<ComponentsView>(HTTP_PATHS.component(id), { action });
  }

  installDefaultComponents(): Promise<ComponentsView> {
    return this.post<ComponentsView>(HTTP_PATHS.components, { action: "install_defaults" });
  }

  importComponents(path: string): Promise<ComponentImportResult> {
    return this.post<ComponentImportResult>(HTTP_PATHS.componentImport, { path });
  }

  // agent 运行时（286 号票）：每次现取，不缓存
  async runtimes(): Promise<RuntimesView> {
    return this.json<RuntimesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.runtimes}`, { cache: "no-store" }));
  }

  checkRuntimeFolder(runtimeId: string, folder: string): Promise<WorkFolderCheckResult> {
    return this.post<WorkFolderCheckResult>(HTTP_PATHS.runtimeFolder(runtimeId), { folder } satisfies RuntimeFolderBody);
  }

  async setRuntimeFolder(runtimeId: string, folder: string | null): Promise<RuntimesView> {
    return this.json<RuntimesView>(
      await fetch(`${this.baseUrl}${HTTP_PATHS.runtimeFolder(runtimeId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder } satisfies RuntimeFolderBody) }),
    );
  }

  // 每个 agent 的 ⚙（114 号票）：每次打开现取（用量、压缩的进度在变），不缓存
  async agentSettings(agentId: string): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentSettings(agentId)}`, { cache: "no-store" }));
  }

  async saveAgentPrompt(agentId: string, body: AgentPromptBody): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentPrompt(agentId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async resetAgentPrompt(agentId: string): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentPrompt(agentId)}`, { method: "DELETE" }));
  }

  clearAgent(agentId: string, idempotencyKey: string): Promise<AgentSettingsView> {
    return this.post<AgentSettingsView>(HTTP_PATHS.agentClear(agentId), { idempotencyKey });
  }

  compactAgent(agentId: string): Promise<AgentSettingsView> {
    return this.post<AgentSettingsView>(HTTP_PATHS.agentCompact(agentId), {});
  }

  async setAgentModel(agentId: string, body: AgentModelBody): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentModel(agentId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async followAgentModel(agentId: string): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentModel(agentId)}`, { method: "DELETE" }));
  }

  async setAgentRuntime(agentId: string, body: AgentRuntimeBody): Promise<AgentSettingsView> {
    return this.json<AgentSettingsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRuntime(agentId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  // 接管已有会话（290 号票）：会话列表每次现取，不缓存
  async runtimeSessions(runtimeId: string): Promise<RuntimeSessionsView> {
    return this.json<RuntimeSessionsView>(await fetch(`${this.baseUrl}${HTTP_PATHS.runtimeSessions(runtimeId)}`, { cache: "no-store" }));
  }

  takeOver(runtimeId: string, body: TakeOverBody): Promise<TakeOverResult> {
    return this.post<TakeOverResult>(HTTP_PATHS.runtimeTakeOver(runtimeId), body);
  }

  agentTakeover(agentId: string, action: TakeoverAction): Promise<AgentSettingsView> {
    return this.post<AgentSettingsView>(HTTP_PATHS.agentTakeover(agentId), { action });
  }

  // 角色（248 号票）：每次现取（配置改了要跟着变），不缓存；增删改之后回的都是整份
  async agentRoles(): Promise<AgentRolesView> {
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRoles}`, { cache: "no-store" }));
  }

  async createAgentRole(body: AgentRoleBody): Promise<AgentRolesView> {
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRoles}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async updateAgentRole(roleId: string, body: AgentRoleUpdateBody): Promise<AgentRolesView> {
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRole(roleId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async deleteAgentRole(roleId: string): Promise<AgentRolesView> {
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRole(roleId)}`, { method: "DELETE" }));
  }

  async setDefaultAgentRole(roleId: string): Promise<AgentRolesView> {
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentDefaultRole}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId }) }));
  }

  async assignAgentRole(agentId: string, roleId: string | null): Promise<AgentRolesView> {
    const body: AgentRoleAssignmentBody = { roleId };
    return this.json<AgentRolesView>(await fetch(`${this.baseUrl}${HTTP_PATHS.agentRoleAssignment(agentId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  /**
   * 响应体当 JSON 读。
   * 守护进程重启的几十秒里、隧道断了一下、前面的 nginx 回了 502：body 是 HTML 错误页，
   * 不能直接 `res.json()`（那会抛出 "Unexpected token '<', "<html> <h"… is not valid JSON"，用户看不懂）。
   * 先看状态码，状态不对就尽量读 `{ message }`，读不出来给一句人话；状态对但 body 不是 JSON 也说清楚。
   */
  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(httpErrorMessage(res.status, body));
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(notJsonMessage());
    }
  }

  async toolkitCatalog(): Promise<ToolkitCatalog> {
    return this.json<ToolkitCatalog>(await fetch(`${this.baseUrl}${HTTP_PATHS.toolkitCatalog}`));
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

  async debugRecognize(audio: Blob): Promise<DebugRecognizeResult> {
    const body: DebugRecognizeBody = { audioBase64: await base64Of(audio), mime: audio.type || "application/octet-stream" };
    return this.post<DebugRecognizeResult>(HTTP_PATHS.debugRecognize, body);
  }

  debugSpeak(text: string): Promise<DebugSpeakResult> {
    const body: DebugSpeakBody = { text };
    return this.post<DebugSpeakResult>(HTTP_PATHS.debugSpeak, body);
  }

  pageVoice(body: PageVoiceBody): Promise<PageVoiceResult> {
    return this.post<PageVoiceResult>(HTTP_PATHS.pageVoice, body);
  }

  pageFileUrl(token: string): string {
    return `${this.baseUrl}${HTTP_PATHS.pageFile(token)}`;
  }

  pageFileThumbUrl(token: string): string {
    return `${this.baseUrl}${HTTP_PATHS.pageFileThumb(token)}`;
  }

  async pageFileBytes(token: string): Promise<Uint8Array> {
    const res = await fetch(this.pageFileUrl(token), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? t("app.daemonHttp.fileGone") : `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  localFolders(): Promise<LocalFoldersView> {
    return fetch(`${this.baseUrl}${HTTP_PATHS.localFolders}`, { cache: "no-store" }).then((res) => this.json<LocalFoldersView>(res));
  }

  async setLocalFolders(folders: readonly string[]): Promise<LocalFoldersView> {
    const body: LocalFoldersBody = { folders: [...folders] };
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.localFolders}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return this.json<LocalFoldersView>(res);
  }

  async changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.localFolders}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    return this.json<LocalFoldersView>(res);
  }

  browseFolders(folder?: string): Promise<FolderBrowseView> {
    return fetch(`${this.baseUrl}${HTTP_PATHS.localFoldersBrowse(folder)}`, { cache: "no-store" }).then((res) => this.json<FolderBrowseView>(res));
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
