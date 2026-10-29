import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';

/** 文件名里不能有的字符换成下划线，太长的截短；空的叫"下载的文件" */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.substring(0, 120) : t('harmony.downloads.defaultName');
}

/**
 * 拦下载（160 号票，原生浏览器里能渲染的文件）：want 说要不要拦——拦下的照样下进缓存，但不提示、不弹"保存到"，
 * 下完 finished 交出缓存里的路径（由拦的人管，删不删、存不存）；失败 failed
 */
export interface DownloadDivert {
  want(item: webview.WebDownloadItem): boolean;
  finished(item: webview.WebDownloadItem, path: string): void;
  failed(item: webview.WebDownloadItem): void;
}

/** 存好了一个文件（165 号票，下载记录）：名字、存在哪（系统"保存到"给的地址）、大小（字节）、类型（不知道是空串） */
export type DownloadSaved = (name: string, uri: string, size: number, mime: string) => void;

/**
 * 网页里的下载（96 号票）：聊天里的文件附件点"⤓"是带 download 的链接，浏览器会下载，ArkWeb 不设下载代理就什么都不做。
 * 这里先下到 App 的缓存目录，下完弹系统的"保存到"让用户选位置（文件名默认用附件的名字），再拷过去、删掉缓存里的那份。
 * 下载照常带着网页的设备凭证 cookie（同一个 WebView 发的请求）。
 */
export class WebDownloads {
  private readonly context: common.UIAbilityContext;
  private readonly notify: (text: string) => void;
  private readonly delegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  /** 下载的 guid → 文件名 */
  private readonly names: Map<string, string> = new Map<string, string>();
  /** 拦下载的（160 号票，只有原生浏览器那一份有） */
  private readonly divert: DownloadDivert | undefined;
  /** 拦下的下载的 guid */
  private readonly diverted: Set<string> = new Set<string>();
  /** 存好了一个文件时记下来（165 号票，只有原生浏览器那一份有：下载记录） */
  private readonly saved: DownloadSaved | undefined;
  /** 缓存里的路径 → 服务端给的类型（存好时记进下载记录） */
  private readonly mimes: Map<string, string> = new Map<string, string>();

  constructor(context: common.UIAbilityContext, notify: (text: string) => void, divert?: DownloadDivert, saved?: DownloadSaved) {
    this.context = context;
    this.notify = notify;
    this.divert = divert;
    this.saved = saved;
    this.delegate.onBeforeDownload((item: webview.WebDownloadItem) => this.begin(item));
    this.delegate.onDownloadFinish((item: webview.WebDownloadItem) => this.finish(item));
    this.delegate.onDownloadFailed((item: webview.WebDownloadItem) => this.fail(item));
  }

  /** Web 组件挂上 controller 之后调（onControllerAttached）；换地址重建 Web 组件时再调一次 */
  attach(controller: webview.WebviewController): void {
    try {
      controller.setDownloadDelegate(this.delegate);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'set download delegate failed: %{public}s', JSON.stringify(e));
    }
  }

  private begin(item: webview.WebDownloadItem): void {
    const name = safeFileName(item.getSuggestedFileName());
    const dir = `${this.context.cacheDir}/downloads`;
    try {
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir);
      }
      this.names.set(item.getGuid(), name);
      // 拦下的（160 号票）：照样下进缓存，不提示
      const diverted = this.divert !== undefined && this.divert.want(item);
      if (diverted) {
        this.diverted.add(item.getGuid());
      }
      const path = `${dir}/${Date.now()}-${name}`;
      if (this.saved !== undefined) {
        this.mimes.set(path, item.getMimeType());
      }
      item.start(path);
      if (!diverted) {
        this.notify(t('harmony.downloads.started', { 'name': name }));
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'start download failed: %{public}s', JSON.stringify(e));
      this.notify(t('harmony.downloads.cantStart', { 'name': name }));
    }
  }

  private finish(item: webview.WebDownloadItem): void {
    const name = this.takeName(item);
    const src = item.getFullPath();
    if (this.diverted.delete(item.getGuid()) && this.divert !== undefined) {
      this.divert.finished(item, src);
      return;
    }
    this.saveFile(src, name, false);
  }

  /**
   * 把缓存里的一个文件弹"保存到"存出去（文件名默认 name）；keep 为真时缓存里那份留着（160 号票：拦下的下载点"下载"，
   * 可能还要再看、再存），否则存完、取消都删掉
   */
  saveFile(src: string, name: string, keep: boolean): void {
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = [name];
    new picker.DocumentViewPicker(this.context).save(options)
      .then((uris: Array<string>) => {
        if (uris.length === 0) {
          if (!keep) {
            this.remove(src);
          }
          this.notify(t('harmony.downloads.notSaved', { 'name': name }));
          return;
        }
        this.copyTo(src, uris[0], name, keep);
      })
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'save picker failed: %{public}s', JSON.stringify(err));
        if (!keep) {
          this.remove(src);
        }
        this.notify(t('harmony.downloads.saveFailed', { 'name': name }));
      });
  }

  private copyTo(src: string, uri: string, name: string, keep: boolean): void {
    const mime = this.mimes.get(src) ?? '';
    this.mimes.delete(src);
    let size = 0;
    try {
      size = fs.statSync(src).size;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'stat download failed: %{public}s', JSON.stringify(e));
    }
    let out: fs.File;
    try {
      out = fs.openSync(uri, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'open save target failed: %{public}s', JSON.stringify(e));
      if (!keep) {
        this.remove(src);
      }
      this.notify(t('harmony.downloads.saveFailed', { 'name': name }));
      return;
    }
    fs.copyFile(src, out.fd)
      .then(() => {
        this.notify(t('harmony.downloads.saved', { 'name': name }));
        // 下载记录（165 号票）
        this.saved?.(name, uri, size, mime);
      })
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'copy download failed: %{public}s', JSON.stringify(err));
        this.notify(t('harmony.downloads.saveFailed', { 'name': name }));
      })
      .finally(() => {
        fs.closeSync(out);
        if (!keep) {
          this.remove(src);
        }
      });
  }

  private fail(item: webview.WebDownloadItem): void {
    const name = this.takeName(item);
    hilog.warn(DOMAIN, TAG, 'download failed: %{public}d', item.getLastErrorCode());
    this.mimes.delete(item.getFullPath());
    this.remove(item.getFullPath());
    if (this.diverted.delete(item.getGuid()) && this.divert !== undefined) {
      this.divert.failed(item);
      this.notify(t('harmony.downloads.openFailed', { 'name': name, 'code': String(item.getLastErrorCode()) }));
      return;
    }
    this.notify(t('harmony.downloads.failed', { 'name': name, 'code': String(item.getLastErrorCode()) }));
  }

  private takeName(item: webview.WebDownloadItem): string {
    const guid = item.getGuid();
    const name = this.names.get(guid) ?? safeFileName(item.getSuggestedFileName());
    this.names.delete(guid);
    return name;
  }

  private remove(path: string): void {
    try {
      if (path.length > 0 && fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'remove temp download failed: %{public}s', JSON.stringify(e));
    }
  }
}
