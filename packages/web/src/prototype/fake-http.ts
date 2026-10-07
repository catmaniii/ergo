// 原型用的假 HTTP（直接打开构建产物、没有守护进程时）：上传只在浏览器里假装走一遍进度，
// 选的图片用本地的 object URL 显示；没有更早的历史。假历史里的图片、文件没有真媒体，界面画占位图。
// 改工作日历交给假连接（它在工作日历频道上推事件，和守护进程一样）。
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { UploadProgress } from "../app/uploader.ts";
import type { DeleteMaterialsResult, HistoryPage, MaterialScope, MaterialScopeSummary, UploadedMedia, WorkdayChange, WorkdayChangeResult } from "../state/index.ts";
import { FAKE_SESSIONS } from "./fake-data.ts";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 假连接里改工作日历的那一半 */
export interface FakeWorkdayCalendar {
  changeWorkday(change: WorkdayChange): WorkdayChangeResult;
}

export class FakeDaemonHttp implements DaemonHttp {
  private seq = 0;
  private readonly urls = new Map<string, string>();
  private readonly calendar: FakeWorkdayCalendar | undefined;

  constructor(calendar?: FakeWorkdayCalendar) {
    this.calendar = calendar;
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
        if (image) this.urls.set(mediaId, URL.createObjectURL(file));
        resolve({ mediaId, kind: image ? "image" : "file", name: file.name, mime: file.type || "application/octet-stream", size: total });
      };
      options.onProgress({ state: "uploading", sent: 0, total });
      setTimeout(tick, 150);
    });
  }

  history(conversation: string): Promise<HistoryPage> {
    return Promise.resolve({ conversation, messages: [], hasMore: false });
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

  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult> {
    if (!this.calendar) return Promise.reject(new Error("原型里没有工作日历"));
    try {
      return Promise.resolve(this.calendar.changeWorkday(change));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
