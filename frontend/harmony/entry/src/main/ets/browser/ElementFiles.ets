import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { window as ohWindow } from '@kit.ArkUI';
import { url, util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { originOf } from '../common/ServerAddress';
import { safeFileName } from '../download/WebDownloads';

/** 重定向最多跟几次（和安卓一样） */
const MAX_REDIRECTS = 10;
/** 分段读出来时一段多少字节（base64 之后约 512 KB） */
const READ_BYTES = 384 * 1024;
/** 下载开头等多久（毫秒）：这么久里失败的回原因，还在下的先回"开始了" */
const DOWNLOAD_WAIT_MS = 5000;
/** 不限大小时的上限（字节）：和 App 能存的差不多，只防跑飞 */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
/** http 组件的错误码：重定向次数到上限（maxRedirects 是 0 时遇到重定向就是它） */
const REDIRECT_LIMIT_ERROR = 2300047;
/** 这时按哪个状态码算 */
const REDIRECT_CODE = 302;

/** 下载整个文件时一跳最多等多久（毫秒）：http 组件的读超时管的是整段传输，大文件 60 秒不够；卡住了也要有个头 */
const DOWNLOAD_READ_TIMEOUT_MS = 30 * 60 * 1000;
/** 请求结束后最多等"数据收完"多久（毫秒） */
const DATA_END_WAIT_MS = 3000;
/** 取内容时的读超时（毫秒） */
const FETCH_READ_TIMEOUT_MS = 60000;
/** 地址上看不出后缀时按类型补（安卓的 URLUtil.guessFileName 会自己补） */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/html': 'html',
};

/** 按来源页该带什么 Referer（和安卓的 refererFor 一样，见那里的说明）；不带是空串 */
export function refererFor(page: string, target: string): string {
  const from = originOf(page);
  const to = originOf(target);
  if (from.length === 0 || to.length === 0) {
    return '';
  }
  if (from === to) {
    const at = page.indexOf('#');
    return at < 0 ? page : page.substring(0, at);
  }
  if (from.startsWith('https:') && to.startsWith('http:')) {
    return '';
  }
  return `${from}/`;
}

/** 二狗的设备凭证只给二狗自己的页面发起的请求（和安卓 download/WebDownloads.kt 的 cookieAllowed 一样） */
function cookieAllowed(target: string, initiator: string, serverOrigin: string): boolean {
  if (serverOrigin.length === 0 || originOf(target) !== serverOrigin) {
    return true;
  }
  return originOf(initiator) === serverOrigin;
}

/** 服务端给的文件名（filename* 优先，再 filename，再按地址的最后一段） */
function fileNameOf(target: string, disposition: string): string {
  const extended = new RegExp("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").exec(disposition);
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch (e) {
      // 解不开就按下面的
    }
  }
  const plain = new RegExp('filename\\s*=\\s*"?([^";]+)"?').exec(disposition);
  if (plain !== null) {
    return plain[1].trim();
  }
  const at = target.search(new RegExp('[?#]'));
  const path = at < 0 ? target : target.substring(0, at);
  const last = path.substring(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch (e) {
    return last;
  }
}

/** 文件名没有后缀时按类型补上 */
function withExtension(name: string, mime: string): string {
  const ext = EXTENSIONS[mime];
  return name.indexOf('.') < 0 && ext !== undefined ? `${name}.${ext}` : name;
}

/** 响应头里的一项（名字不分大小写）；没有是空串 */
function headerOf(headers: Object, name: string): string {
  const record = headers as Record<string, Object>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      const value = record[key];
      return Array.isArray(value) ? String(value[0]) : String(value);
    }
  }
  return '';
}

/** browserTool 这一组的参数（网页一侧 packages/web/src/app/native-browser.ts 的 wrapElementFiles 发的 JSON） */
interface ElementArgs {
  id?: string;
  url?: string;
  maxBytes?: number;
  offset?: number;
  base64?: string;
  name?: string;
  mime?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** 回给二狗的网页的结果 */
class ElementReply {
  ok: boolean = true;
  code?: string;
  status?: number;
  id?: string;
  name?: string;
  mime?: string;
  size?: number;
  base64?: string;
  done?: boolean;
}

function failure(code: string, status?: number): string {
  const out = new ElementReply();
  out.ok = false;
  out.code = code;
  if (status !== undefined && status > 0) {
    out.status = status;
  }
  return JSON.stringify(out);
}

function okReply(): string {
  return JSON.stringify(new ElementReply());
}

/** 取的时候不成：too-large 太大、http 服务端回了错（status）、bad-url 地址不对、network 连不上 */
class FetchFailure extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** 取到的：服务端给的名字和类型 */
class Fetched {
  name: string = '';
  mime: string = '';
}

/** 缓存里的一份 */
class Entry {
  path: string;
  name: string = '';
  mime: string = '';

  constructor(path: string) {
    this.path = path;
  }
}

/**
 * 长按网页元素的圆钮（359 号票，对应安卓 browser/ElementFiles.kt，那边写着每一项是干什么的）：都经 browserTool（op 以 element 开头）。
 * 自己发请求（http 组件，流式写进缓存）：带这个地址该带的 cookie（WebCookieManager）和来源页，不自动跟重定向（maxRedirects 0），每一跳重新算；
 * 截图用窗口截图再裁（window.snapshot）。存走 WebDownloads.saveFile，和网页里的下载一样弹"保存到"、进下载记录。
 */
export class ElementFiles {
  private context: common.UIAbilityContext;
  private controller: webview.WebviewController;
  private serverOrigin: () => string;
  /** 浏览器这一块在窗口里的位置（物理像素） */
  private webOffset: () => number[];
  private notify: (text: string) => void;
  private save: (path: string, name: string, mime: string) => void;
  private entries: Map<string, Entry> = new Map<string, Entry>();
  private next: number = 1;
  private dir: string;

  constructor(context: common.UIAbilityContext, controller: webview.WebviewController, serverOrigin: () => string, webOffset: () => number[],
    notify: (text: string) => void, save: (path: string, name: string, mime: string) => void) {
    this.context = context;
    this.controller = controller;
    this.serverOrigin = serverOrigin;
    this.webOffset = webOffset;
    this.notify = notify;
    this.save = save;
    this.dir = `${context.cacheDir}/element-files`;
    this.clean();
  }

  /** 上次留下的：App 被杀时还没放掉的 */
  private clean(): void {
    try {
      if (fs.accessSync(this.dir)) {
        fs.rmdirSync(this.dir);
      }
      fs.mkdirSync(this.dir);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'clean element files failed: %{public}s', JSON.stringify(e));
    }
  }

  run(op: string, json: string): Promise<string> {
    let args: ElementArgs = {};
    try {
      args = JSON.parse(json) as ElementArgs;
    } catch (e) {
      // 形状不对的当没有参数
    }
    if (op === 'elementFetch') {
      return this.fetchFile(args.url ?? '', args.maxBytes ?? NO_LIMIT);
    }
    if (op === 'elementShot') {
      return this.shot(args);
    }
    if (op === 'elementRead') {
      return Promise.resolve(this.read(args.id ?? '', args.offset ?? 0));
    }
    if (op === 'elementWrite') {
      return Promise.resolve(this.write(args.id ?? '', args.base64 ?? ''));
    }
    if (op === 'elementSave') {
      return Promise.resolve(this.saveEntry(args.id ?? '', args.name ?? '', args.mime ?? ''));
    }
    if (op === 'elementDownload') {
      return this.download(args.url ?? '');
    }
    if (op === 'elementDrop') {
      this.drop(args.id ?? '');
      return Promise.resolve(okReply());
    }
    return Promise.resolve(failure('bad-op'));
  }

  private newEntry(): string {
    const id = `c${this.next++}`;
    this.entries.set(id, new Entry(`${this.dir}/${id}`));
    return id;
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (entry !== undefined) {
      this.remove(entry.path);
    }
  }

  private remove(path: string): void {
    try {
      if (fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'remove element file failed: %{public}s', JSON.stringify(e));
    }
  }

  private described(id: string, entry: Entry): string {
    const out = new ElementReply();
    out.id = id;
    out.name = entry.name;
    out.mime = entry.mime;
    out.size = fs.statSync(entry.path).size;
    return JSON.stringify(out);
  }

  private currentPage(): string {
    try {
      return this.controller.getUrl();
    } catch (e) {
      return '';
    }
  }

  /** 发一跳请求，流式写进文件：回状态码；响应头放进 headers */
  private async hop(target: string, page: string, path: string, maxBytes: number, headers: Object[]): Promise<number> {
    const header: Record<string, string> = {};
    header['User-Agent'] = this.controller.getUserAgent();
    const referer = refererFor(page, target);
    if (referer.length > 0) {
      header['Referer'] = referer;
    }
    if (cookieAllowed(target, page, this.serverOrigin())) {
      const cookie = webview.WebCookieManager.fetchCookieSync(target);
      if (cookie.length > 0) {
        header['Cookie'] = cookie;
      }
    }
    const req = http.createHttp();
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    let total = 0;
    let tooLarge = false;
    req.on('headersReceive', (received: Object) => {
      headers[0] = received;
      const length = Number(headerOf(received, 'content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('dataReceive', (data: ArrayBuffer) => {
      if (tooLarge) {
        return;
      }
      total += data.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        req.destroy();
        return;
      }
      fs.writeSync(file.fd, data);
    });
    // 请求的 Promise 和最后一段数据谁先到系统没说：等到"数据收完"再关文件（等不到也有个头）
    let ended: () => void = () => {
    };
    const finished = new Promise<void>((resolve: () => void) => {
      ended = resolve;
    });
    req.on('dataEnd', () => ended());
    try {
      const code = await req.requestInStream(target, {
        method: http.RequestMethod.GET,
        header: header,
        usingCache: false,
        connectTimeout: 30000,
        readTimeout: maxBytes === NO_LIMIT ? DOWNLOAD_READ_TIMEOUT_MS : FETCH_READ_TIMEOUT_MS,
        maxRedirects: 0,
      });
      await Promise.race([finished, new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, DATA_END_WAIT_MS);
      })]);
      if (tooLarge) {
        throw new FetchFailure('too-large');
      }
      return code;
    } catch (e) {
      if (tooLarge) {
        throw new FetchFailure('too-large');
      }
      // maxRedirects 是 0 时遇到重定向这里报"到上限了"：响应头已经收到（模拟器上核对过），按重定向算，由 fetchInto 接着走下一跳
      if ((e as BusinessError).code === REDIRECT_LIMIT_ERROR && headerOf(headers[0], 'location').length > 0) {
        return REDIRECT_CODE;
      }
      throw e as Error;
    } finally {
      fs.closeSync(file);
      if (!tooLarge) {
        req.destroy();
      }
    }
  }

  /** 把一个地址取进文件：回服务端给的名字和类型；不成抛 FetchFailure，别的算连不上 */
  private async fetchInto(address: string, page: string, maxBytes: number, path: string): Promise<Fetched> {
    let target = address;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (originOf(target).length === 0) {
        throw new FetchFailure('bad-url');
      }
      const headers: Object[] = [new Object()];
      const code = await this.hop(target, page, path, maxBytes, headers);
      if (code >= 300 && code <= 399) {
        const location = headerOf(headers[0], 'location');
        if (location.length === 0) {
          throw new FetchFailure('http', code);
        }
        target = url.URL.parseURL(location, target).href;
        continue;
      }
      if (code >= 400) {
        throw new FetchFailure('http', code);
      }
      const out = new Fetched();
      out.mime = headerOf(headers[0], 'content-type').split(';')[0].trim();
      out.name = safeFileName(withExtension(fileNameOf(target, headerOf(headers[0], 'content-disposition')), out.mime));
      return out;
    }
    throw new FetchFailure('http', 310);
  }

  private failureOf(e: Object): string {
    if (e instanceof FetchFailure) {
      return failure(e.code, e.status);
    }
    hilog.warn(DOMAIN, TAG, 'element fetch failed: %{public}s', JSON.stringify(e));
    return failure('network');
  }

  private async fetchFile(address: string, maxBytes: number): Promise<string> {
    const id = this.newEntry();
    const entry = this.entries.get(id) as Entry;
    try {
      const got = await this.fetchInto(address, this.currentPage(), maxBytes, entry.path);
      entry.name = got.name;
      entry.mime = got.mime;
      return this.described(id, entry);
    } catch (e) {
      this.drop(id);
      return this.failureOf(e as Object);
    }
  }

  private download(address: string): Promise<string> {
    const id = this.newEntry();
    const entry = this.entries.get(id) as Entry;
    const guess = safeFileName(fileNameOf(address, ''));
    this.notify(t('harmony.downloads.started', { 'name': guess }));
    return new Promise<string>((resolve: (text: string) => void) => {
      let replied = false;
      const answer = (text: string): void => {
        if (!replied) {
          replied = true;
          resolve(text);
        }
      };
      setTimeout(() => answer(okReply()), DOWNLOAD_WAIT_MS);
      this.fetchInto(address, this.currentPage(), NO_LIMIT, entry.path)
        .then((got: Fetched) => {
          this.entries.delete(id);
          answer(okReply());
          this.save(entry.path, got.name, got.mime);
        })
        .catch((e: Object) => {
          this.drop(id);
          if (replied) {
            const status = e instanceof FetchFailure ? e.status : -1;
            this.notify(t('harmony.downloads.failed', { 'name': guess, 'code': String(status) }));
          }
          answer(this.failureOf(e));
        });
    });
  }

  /** 截网页的一块：窗口截图再裁（x、y 相对网页这一块，物理像素） */
  private async shot(args: ElementArgs): Promise<string> {
    const offset = this.webOffset();
    const id = this.newEntry();
    const entry = this.entries.get(id) as Entry;
    entry.name = 'element.png';
    entry.mime = 'image/png';
    let map: image.PixelMap | undefined = undefined;
    let packer: image.ImagePacker | undefined = undefined;
    try {
      const win = await ohWindow.getLastWindow(this.context);
      map = await win.snapshot();
      const info = await map.getImageInfo();
      const x = Math.max(0, Math.round(offset[0] + (args.x ?? 0)));
      const y = Math.max(0, Math.round(offset[1] + (args.y ?? 0)));
      const width = Math.min(Math.round(args.width ?? 0), info.size.width - x);
      const height = Math.min(Math.round(args.height ?? 0), info.size.height - y);
      if (width <= 0 || height <= 0) {
        this.drop(id);
        return failure('shot');
      }
      await map.crop({ x: x, y: y, size: { width: width, height: height } });
      packer = image.createImagePacker();
      const data = await packer.packToData(map, { format: 'image/png', quality: 100 });
      const file = fs.openSync(entry.path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, data);
      fs.closeSync(file);
      return this.described(id, entry);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'element shot failed: %{public}s', JSON.stringify(e));
      this.drop(id);
      return failure('shot');
    } finally {
      void packer?.release();
      void map?.release();
    }
  }

  private read(id: string, offset: number): string {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return failure('gone');
    }
    try {
      const size = fs.statSync(entry.path).size;
      const length = Math.min(READ_BYTES, Math.max(0, size - offset));
      const buffer = new ArrayBuffer(length);
      const file = fs.openSync(entry.path, fs.OpenMode.READ_ONLY);
      const n = length > 0 ? fs.readSync(file.fd, buffer, { offset: offset, length: length }) : 0;
      fs.closeSync(file);
      const out = new ElementReply();
      out.base64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer, 0, n));
      out.done = offset + n >= size;
      return JSON.stringify(out);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'element read failed: %{public}s', JSON.stringify(e));
      return failure('gone');
    }
  }

  private write(id: string, base64: string): string {
    const known = this.entries.has(id);
    const used = known ? id : this.newEntry();
    const entry = this.entries.get(used) as Entry;
    try {
      const bytes = new util.Base64Helper().decodeSync(base64);
      const file = fs.openSync(entry.path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.APPEND);
      fs.writeSync(file.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      fs.closeSync(file);
      const out = new ElementReply();
      out.id = used;
      return JSON.stringify(out);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'element write failed: %{public}s', JSON.stringify(e));
      return failure('gone');
    }
  }

  private saveEntry(id: string, name: string, mime: string): string {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return failure('gone');
    }
    this.entries.delete(id);
    this.save(entry.path, safeFileName(name.length > 0 ? name : entry.name), mime.length > 0 ? mime : entry.mime);
    return okReply();
  }
}
