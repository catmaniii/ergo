import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';

/** 文件名里不能有的字符换成下划线，太长的截短；空的叫"下载的文件" */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.substring(0, 120) : '下载的文件';
}

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

  constructor(context: common.UIAbilityContext, notify: (text: string) => void) {
    this.context = context;
    this.notify = notify;
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
      item.start(`${dir}/${Date.now()}-${name}`);
      this.notify(`正在下载「${name}」…`);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'start download failed: %{public}s', JSON.stringify(e));
      this.notify(`下载不了「${name}」`);
    }
  }

  private finish(item: webview.WebDownloadItem): void {
    const name = this.takeName(item);
    const src = item.getFullPath();
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = [name];
    new picker.DocumentViewPicker(this.context).save(options)
      .then((uris: Array<string>) => {
        if (uris.length === 0) {
          this.remove(src);
          this.notify(`没有保存「${name}」`);
          return;
        }
        this.copyTo(src, uris[0], name);
      })
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'save picker failed: %{public}s', JSON.stringify(err));
        this.remove(src);
        this.notify(`保存「${name}」没成功`);
      });
  }

  private copyTo(src: string, uri: string, name: string): void {
    let out: fs.File;
    try {
      out = fs.openSync(uri, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'open save target failed: %{public}s', JSON.stringify(e));
      this.remove(src);
      this.notify(`保存「${name}」没成功`);
      return;
    }
    fs.copyFile(src, out.fd)
      .then(() => this.notify(`已保存「${name}」`))
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'copy download failed: %{public}s', JSON.stringify(err));
        this.notify(`保存「${name}」没成功`);
      })
      .finally(() => {
        fs.closeSync(out);
        this.remove(src);
      });
  }

  private fail(item: webview.WebDownloadItem): void {
    const name = this.takeName(item);
    hilog.warn(DOMAIN, TAG, 'download failed: %{public}d', item.getLastErrorCode());
    this.remove(item.getFullPath());
    this.notify(`下载「${name}」失败（错误码 ${item.getLastErrorCode()}）`);
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
