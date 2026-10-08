// 原型用的假 HTTP（直接打开构建产物、没有守护进程时）：上传只在浏览器里假装走一遍进度，
// 选的图片用本地的 object URL 显示；没有更早的历史。假历史里的图片、文件没有真媒体，界面画占位图。
// 改工作日历交给假连接（它在工作日历频道上推事件，和守护进程一样）。消耗页的汇总由假账本算（fake-data.ts 的 fakeUsageSummary）。
// 参考音色（32 号票）只记在内存里，导入的录音用本地的 object URL 试听。
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { UploadProgress } from "../app/uploader.ts";
import type {
  DeleteMaterialsResult,
  HistoryPage,
  MaterialScope,
  MaterialScopeSummary,
  ReferenceVoice,
  ReferenceVoiceList,
  UploadedMedia,
  UsageSummary,
  WorkdayChange,
  WorkdayChangeResult,
} from "../state/index.ts";
import { FAKE_SESSIONS, fakeUsageSummary } from "./fake-data.ts";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 假连接里改工作日历的那一半 */
export interface FakeWorkdayCalendar {
  changeWorkday(change: WorkdayChange): WorkdayChangeResult;
}

export class FakeDaemonHttp implements DaemonHttp {
  private seq = 0;
  private readonly urls = new Map<string, string>();
  private readonly workdayCalendar: FakeWorkdayCalendar | undefined;
  /** 原型的参考音色（只在内存里） */
  private voices: ReferenceVoice[] = [];
  private currentVoice: string | undefined;

  constructor(workdayCalendar?: FakeWorkdayCalendar) {
    this.workdayCalendar = workdayCalendar;
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

  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult> {
    if (!this.workdayCalendar) return Promise.reject(new Error("原型里没有工作日历"));
    try {
      return Promise.resolve(this.workdayCalendar.changeWorkday(change));
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

  private voiceList(): ReferenceVoiceList {
    const current = this.voices.find((v) => v.id === this.currentVoice) ?? this.voices[0];
    return { voices: this.voices, ...(current ? { currentId: current.id } : {}) };
  }
}
