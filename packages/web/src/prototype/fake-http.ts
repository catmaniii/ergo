// 原型用的假 HTTP（直接打开构建产物、没有守护进程时）：上传只在浏览器里假装走一遍进度，
// 选的图片用本地的 object URL 显示；没有更早的历史。假历史里的图片、文件没有真媒体，界面画占位图。
// 改工作日历交给假连接（它在工作日历频道上推事件，和守护进程一样）。消耗页的汇总由假账本算（fake-data.ts 的 fakeUsageSummary）。
// 改个人助理的名字（43 号票）也交给假连接（它在名字频道上推事件）。
// 参考音色（32 号票）只记在内存里，导入的录音用本地的 object URL 试听。日历（35 号票）也交给假连接（它按自己的工作日历算）。
// 两个语音模型的状态（45 号票）是固定的一份：都已就绪。
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { UploadProgress } from "../app/uploader.ts";
import type {
  AssistantNameResult,
  CalendarMonthView,
  DeleteMaterialsResult,
  HistoryPage,
  ImportSkillResult,
  MaterialScope,
  MaterialScopeSummary,
  ReferenceVoice,
  ReferenceVoiceList,
  ToolkitCatalog,
  UploadedMedia,
  UsageSummary,
  VoiceModelsView,
  WorkdayChange,
  WorkdayChangeResult,
} from "../state/index.ts";
import { FAKE_SESSIONS, FAKE_TOOLKIT_CATALOG, fakeUsageSummary } from "./fake-data.ts";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

  /** 原型：按文件夹名当 skill 名，不读文件 */
  importSkill(path: string): Promise<ImportSkillResult> {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) return Promise.reject(new Error(`skill 名 ${name} 不合规矩：只能用小写字母、数字和短横线`));
    if (this.catalog.skills.some((s) => s.name === name)) return Promise.reject(new Error(`skill 库里已经有叫 ${name} 的 skill 了`));
    const skill = { name, description: "刚导入的 skill（原型）", origin: "imported" as const };
    this.catalog = { ...this.catalog, skills: [...this.catalog.skills, skill] };
    return Promise.resolve({ skill });
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

  private voiceList(): ReferenceVoiceList {
    const current = this.voices.find((v) => v.id === this.currentVoice) ?? this.voices[0];
    return { voices: this.voices, ...(current ? { currentId: current.id } : {}) };
  }
}
