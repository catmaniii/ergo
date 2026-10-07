// 前端协议里走 HTTP 的那部分（规格第 5 节）：上传附件（分片续传）、往上翻历史、媒体的地址。
// 和 Connection 一样只在 App.tsx 里注入一次（StoreProvider 的 http）：页面由守护进程提供时是 HttpDaemonClient，
// 直接打开构建产物（file://）时是原型的假实现（prototype/fake-http.ts）。
import { type ConversationId, type HistoryPage, HTTP_PATHS, type UploadedMedia } from "../state/index.ts";
import { type UploadProgress, uploadFile } from "./uploader.ts";

export interface DaemonHttp {
  /** 上传一个文件（分片续传，断网恢复后接着传），进度经 onProgress 报；取消用 signal */
  upload(file: File, options: { onProgress(progress: UploadProgress): void; signal: AbortSignal }): Promise<UploadedMedia>;
  /** 某个会话里序号小于 before 的一页更早的消息 */
  history(conversation: ConversationId, before: number | undefined): Promise<HistoryPage>;
  /** 媒体的地址：图片直接显示，download 时作为附件下载（文件名用 name）；没有真媒体（原型）时为 undefined */
  mediaUrl(mediaId: string, name: string, options?: { download?: boolean }): string | undefined;
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
}
