// 原型用的假 HTTP（直接打开构建产物、没有守护进程时）：上传只在浏览器里假装走一遍进度，
// 选的图片用本地的 object URL 显示；没有更早的历史。假历史里的图片、文件没有真媒体，界面画占位图。
// 改工作日历交给假连接（它在工作日历频道上推事件，和守护进程一样）。消耗页的汇总由假账本算（fake-data.ts 的 fakeUsageSummary）。
// 改个人助理的名字（43 号票）也交给假连接（它在名字频道上推事件）。
// 参考音色（32 号票）只记在内存里，导入的录音用本地的 object URL 试听。日历（35 号票）也交给假连接（它按自己的工作日历算）。
// 两个语音模型的状态（45 号票）是固定的一份：都已就绪。工具调用的完整内容（56 号票的详情页）按假会话里的摘要编一份。
// 设置里工具调用的完整内容占了多大（65 号票）是编的一份，"现在就清理"把可清的清掉（只在内存里）。
// 设置里的系统提示（71 号票）是编的几份（fake-system-prompts.ts），改的只记在内存里。
// 输入框里打 / 弹出的候选（82 号票）：二狗自己的命令加一份编的 skill（FAKE_SLASH_SKILLS），任务详情里的会话不列命令。
// 设置里的"模型"（73 号票）是编的一份（DeepSeek 两个模型、key 已配置），改了只记在内存里，连通测试回一个编的延迟。
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { UploadProgress } from "../app/uploader.ts";
import type {
  AssistantNameResult,
  CalendarMonthView,
  DeleteMaterialsResult,
  HistoryPage,
  ImportSkillBody,
  ImportSkillResult,
  SecretarySkillsView,
  SlashCommandList,
  MaterialScope,
  MaterialScopeSummary,
  ModelSettings,
  ModelSettingsBody,
  ModelSettingsView,
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
  ToolkitCatalog,
  UploadedMedia,
  UsageSummary,
  VoiceModelsView,
  WorkdayChange,
  WorkdayChangeResult,
} from "../state/index.ts";
import { DEFAULT_SECRETARY_SKILLS, effectiveModelChoice, IMPORT_NAME_PATTERN, MODEL_AGENTS, reopenScope } from "../state/index.ts";
import { FAKE_HISTORY } from "./fake-conversations.ts";
import { FAKE_GRANT_USES, FAKE_SESSIONS, FAKE_SLASH_COMMANDS, FAKE_SLASH_SKILLS, FAKE_STAGE_EFFECTS, FAKE_TOOLKIT_CATALOG, fakeUsageSummary, taskDetailOf } from "./fake-data.ts";
import { FakeSystemPrompts } from "./fake-system-prompts.ts";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

/** 假连接里改个人助理的名字的那一半（43 号票） */
export interface FakeAssistantName {
  setAssistantName(name: string): AssistantNameResult;
}

export class FakeDaemonHttp implements DaemonHttp {
  private seq = 0;
  private readonly urls = new Map<string, string>();
  private readonly workdayCalendar: FakeWorkdayCalendar | undefined;
  private readonly assistantName: FakeAssistantName | undefined;
  /** 原型"启动"的时间（语音模型的状态用） */
  private readonly startedAt = new Date().toISOString();
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
  /** 原型的系统提示（71 号票） */
  private readonly prompts = new FakeSystemPrompts();

  /** fake：原型的假连接（它在工作日历频道、名字频道上推事件，和守护进程一样） */
  constructor(fake?: FakeWorkdayCalendar & FakeAssistantName) {
    this.workdayCalendar = fake;
    this.assistantName = fake;
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
    return this.urls.get(mediaId);
  }

  /** 原型：按选择粗算一个条数 */
  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary> {
    const conversations = FAKE_SESSIONS.map((s, i) => ({ conversation: s.id, count: 120 + i * 37 }));
    const count =
      scope === undefined
        ? conversations.reduce((n, c) => n + c.count, 0)
        : scope.kind === "conversation"
          ? (conversations.find((c) => c.conversation === scope.conversation)?.count ?? 0)
          : Math.max(0, Math.round((Date.parse(scope.to) - Date.parse(scope.from)) / 86_400_000) * 9);
    return Promise.resolve({ count, conversations });
  }

  /** 原型：没有真的删 */
  deleteMaterials(scope: MaterialScope): Promise<DeleteMaterialsResult> {
    return this.materialScope(scope).then(({ count }) => ({ count }));
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

  /** 原型：秘书和项目的会话先列二狗自己的命令，任务详情里的不列；skill 都是同一份编的 */
  slashCommands(conversation: string): Promise<SlashCommandList> {
    // 任务自己的维护者 id 是 tm- 开头（ownMaintainerId）
    const commands = conversation.startsWith("maintainer:tm-") ? [] : FAKE_SLASH_COMMANDS;
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

  setAssistantName(name: string): Promise<AssistantNameResult> {
    if (!this.assistantName) return Promise.reject(new Error("原型里不能改名字"));
    try {
      return Promise.resolve(this.assistantName.setAssistantName(name));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
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

  importReferenceVoice(input: { name: string; referenceText: string; audio: Blob }): Promise<ReferenceVoice> {
    const id = `v-proto${++this.seq}`;
    const voice: ReferenceVoice = { id, name: input.name.trim(), referenceText: input.referenceText.trim(), durationMs: 0, sha256: "", importedAt: new Date().toISOString() };
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

  /** 阶段详情现取的（84 号票）：授权已用几次、重做的范围（协议包的 reopenScope：它和依赖它的、开始过的）、这几个阶段这一轮已经做了的事 */
  taskStage(taskId: string, stageId: string): Promise<TaskStageView | undefined> {
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

  /** 原型的模型设置（73 号票）：只在内存里 */
  private models: ModelSettings = { provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} };

  modelSettings(): Promise<ModelSettingsView> {
    const settings = this.models;
    const vision = (key: string, catalog: boolean) => (settings.vision[key] === undefined ? { vision: catalog, visionSource: "catalog" as const } : { vision: settings.vision[key], visionSource: "settings" as const });
    return Promise.resolve({
      providers: [{ id: "deepseek", label: "DeepSeek" }],
      apiKey: { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true },
      models: [
        { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", inCatalog: true, catalogVision: true, thinkingLevels: ["off", "low", "high"], ...vision("deepseek/deepseek-flash", true) },
        { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inCatalog: true, catalogVision: false, thinkingLevels: ["off", "high"], ...vision("deepseek/deepseek-v4-pro", false) },
      ],
      settings: structuredClone(settings),
      effective: Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, effectiveModelChoice(settings, agent)])) as ModelSettingsView["effective"],
      secretarySession: { modelId: "deepseek-flash", thinkingLevel: "high", vision: true },
    });
  }

  saveModelSettings(body: ModelSettingsBody): Promise<ModelSettingsView> {
    this.models = structuredClone(body) as ModelSettings;
    return this.modelSettings();
  }

  /** 原型：编一个延迟 */
  testModel(modelId?: string): Promise<ModelTestResult> {
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, modelId: modelId ?? this.models.default.modelId, firstTokenMs: 640, totalMs: 1180 }), 400));
  }

  private voiceList(): ReferenceVoiceList {
    const current = this.voices.find((v) => v.id === this.currentVoice) ?? this.voices[0];
    return { voices: this.voices, ...(current ? { currentId: current.id } : {}) };
  }
}
