// 前端协议里走 HTTP 的那部分（规格第 5 节）：上传附件（分片续传）、往上翻历史、媒体的地址；
// 设置里按会话、按时间段删除素材（21 号票）；设置里的工作日历改个人设置（29 号票：改完守护进程在工作日历频道上推事件）；
// 消耗页的汇总和粗估成本（24 号票）。
// 和 Connection 一样只在 App.tsx 里注入一次（StoreProvider 的 http）：页面由守护进程提供时是 HttpDaemonClient，
// 直接打开构建产物（file://）时是原型的假实现（prototype/fake-http.ts）。
import {
  type ConversationId,
  type DeleteMaterialsBody,
  type DeleteMaterialsResult,
  type HistoryPage,
  type HttpErrorBody,
  HTTP_PATHS,
  type MaterialScope,
  type MaterialScopeSummary,
  type MemoryDeleteMode,
  type UploadedMedia,
  type UsageSummary,
  type WorkdayChange,
  type WorkdayChangeResult,
} from "../state/index.ts";
import { type UploadProgress, uploadFile } from "./uploader.ts";

export interface DaemonHttp {
  /** 上传一个文件（分片续传，断网恢复后接着传），进度经 onProgress 报；取消用 signal */
  upload(file: File, options: { onProgress(progress: UploadProgress): void; signal: AbortSignal }): Promise<UploadedMedia>;
  /** 某个会话里序号小于 before 的一页更早的消息 */
  history(conversation: ConversationId, before: number | undefined): Promise<HistoryPage>;
  /** 媒体的地址：图片直接显示，download 时作为附件下载（文件名用 name）；没有真媒体（原型）时为 undefined */
  mediaUrl(mediaId: string, name: string, options?: { download?: boolean }): string | undefined;
  /** 素材范围里有几条（不给范围是全部），以及有素材的会话 */
  materialScope(scope?: MaterialScope): Promise<MaterialScopeSummary>;
  /** 对范围内的全部素材执行一种删法（幂等键：重发只执行一次），返回处理了几条 */
  deleteMaterials(scope: MaterialScope, mode: MemoryDeleteMode, idempotencyKey: string): Promise<DeleteMaterialsResult>;
  /** 改个人工作日历（加删额外规则、把某天标成上班或休息、清掉标记）；结果随后在工作日历频道上推来 */
  changeWorkday(change: WorkdayChange): Promise<WorkdayChangeResult>;
  /** 消耗页：from 到 to（本地日期，含两头）按天、按 agent 的用量，系统开销单列，粗估成本 */
  usage(range: { from: string; to: string }): Promise<UsageSummary>;
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

  async history(conversation: ConversationId, before: number | undefined): Promise<HistoryPage> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.history(conversation, { before })}`);
    if (!res.ok) throw new Error(`取历史失败（HTTP ${res.status}）`);
    return (await res.json()) as HistoryPage;
  }

  mediaUrl(mediaId: string, name: string, options: { download?: boolean } = {}): string {
    return `${this.baseUrl}${HTTP_PATHS.media(mediaId, { name, download: options.download })}`;
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

  async usage(range: { from: string; to: string }): Promise<UsageSummary> {
    const res = await fetch(`${this.baseUrl}${HTTP_PATHS.usage(range)}`);
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as UsageSummary;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new Error((json as Partial<HttpErrorBody>).message ?? `HTTP ${res.status}`);
    return json as T;
  }
}
