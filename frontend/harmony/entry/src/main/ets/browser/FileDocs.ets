import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { DownloadDivert, safeFileName } from '../download/WebDownloads';
import { isWebUrl } from './InAppBrowser';

/** 取多少（和协议的 MEDIA_TEXT_MAX_BYTES 一样，1 MB）；拦下载也只拦这么大以内、大小知道的 */
const TEXT_MAX = 1048576;

/**
 * 只看扩展名时能渲染的（服务端一律当下载发的时候按它粗筛）：和网页一侧 packages/web/src/state/file-view.ts 的 EXTENSION_KIND 一致
 * （网页的测试会核对这一行）
 */
export const RENDER_EXTENSIONS: string[] = ('md markdown mdown mkd mkdn txt text log rst adoc org srt vtt json jsonc geojson webmanifest csv tsv tab ' +
  'jsonl ndjson json5 js mjs cjs jsx ts tsx mts cts ets vue svelte css scss sass less py pyw rb go rs java kt kts scala groovy gradle swift m mm ' +
  'c h cc cpp cxx hpp hh cs fs vb php pl pm lua r dart ex exs erl hs clj sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto ' +
  'yaml yml toml ini cfg conf properties env diff patch tex bib cmake mk tf hcl nix zig sol').split(' ');
/** 网页、会跑脚本的扩展名：不拦 */
const ACTIVE_EXTENSIONS: string[] = ['html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'rss', 'atom'];
/** 说不出是什么的类型：按扩展名 */
const GENERIC_MIMES: string[] = ['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/force-download',
  'application/download', 'application/unknown', 'application/x-unknown', 'application/binary', 'unknown/unknown'];
/** 网页、流式的：不拦（+xml 结尾的也是） */
const PAGE_MIMES: string[] = ['text/html', 'text/xml', 'text/event-stream'];
/** 不是 text/ 开头、也算文本的 */
const TEXT_LIKE_MIMES: string[] = ['application/json', 'text/json', 'application/x-json', 'application/x-ndjson', 'application/ndjson',
  'application/jsonl', 'application/javascript', 'application/x-javascript', 'application/ecmascript', 'application/x-sh',
  'application/x-shellscript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql', 'application/x-sql',
  'application/graphql', 'application/csv', 'application/x-csv'];

/** 页面上显示的字：文本文档是 <body><pre>原文</pre></body>（JSON 新版还多一个格式化的框，取 pre 那份），取不到 pre 取整页的字 */
const SOURCE_SCRIPT = '(function(){var d=document,b=d.body,p=b?b.querySelector(\':scope > pre\'):null,n=p||b||d.documentElement,' +
  `t=(n&&n.textContent)||'',m=${TEXT_MAX};return JSON.stringify({ok:true,kind:'text',mime:d.contentType||'',total:t.length,` +
  'truncated:t.length>m,text:t.length>m?t.slice(0,m):t})})()';

/** 名字的扩展名（小写，不带点）；没有是空串 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.substring(dot + 1).toLowerCase() : '';
}

/** 地址最后一段（去掉查询串和 #） */
function lastSegment(url: string): string {
  const bare = url.replace(/[?#].*$/, '');
  const slash = bare.lastIndexOf('/');
  return slash >= 0 ? bare.substring(slash + 1) : bare;
}

function mimeOf(contentType: string): string {
  const semi = contentType.indexOf(';');
  return (semi >= 0 ? contentType.substring(0, semi) : contentType).trim().toLowerCase();
}

/**
 * 拦下载时先粗筛（160 号票）：可能是能渲染的文本才拦（服务端给的文件名、地址的扩展名、类型），最后由网页的 fileRenderOf 定——
 * 筛进来但网页说不渲染的，网页让 App 照常保存
 */
export function looksText(name: string, url: string, contentType: string): boolean {
  let ext = extensionOf(name);
  if (ext.length === 0) {
    ext = extensionOf(lastSegment(url));
  }
  if (ACTIVE_EXTENSIONS.includes(ext)) {
    return false;
  }
  const mime = mimeOf(contentType);
  if (GENERIC_MIMES.includes(mime)) {
    return RENDER_EXTENSIONS.includes(ext);
  }
  if (PAGE_MIMES.includes(mime) || mime.endsWith('+xml')) {
    return false;
  }
  return mime.startsWith('text/') || mime.endsWith('+json') || TEXT_LIKE_MIMES.includes(mime);
}

/** runJavaScript 回的字符串值是带引号的 JSON 字符串：去掉一层 */
function unquote(result: string): string {
  if (result.length >= 2 && result.charAt(0) === '"') {
    try {
      return JSON.parse(result) as string;
    } catch (e) {
      return result;
    }
  }
  return result;
}

function withoutHash(url: string): string {
  const at = url.indexOf('#');
  return at >= 0 ? url.substring(0, at) : url;
}

/** 报给网页的一个文件（packages/web/src/app/native-browser.ts 的 BrowserDoc）；bytes 不知道是 -1 */
class DocMessage {
  id: string;
  url: string;
  mime: string;
  name: string;
  via: string;
  bytes: number;

  constructor(id: string, url: string, mime: string, name: string, via: string, bytes: number) {
    this.id = id;
    this.url = url;
    this.mime = mime;
    this.name = name;
    this.via = via;
    this.bytes = bytes;
  }
}

class DocEvent {
  type: string = 'document';
  doc: DocMessage;

  constructor(doc: DocMessage) {
    this.doc = doc;
  }
}

class DocOutcome {
  ok: boolean;
  reason: string;

  constructor(ok: boolean, reason: string) {
    this.ok = ok;
    this.reason = reason;
  }
}

/** 拦下的下载的字节（base64）、一共多少字节、截没截 */
class DocBytes {
  ok: boolean = true;
  kind: string = 'bytes';
  base64: string;
  total: number;
  truncated: boolean;

  constructor(base64: string, total: number, truncated: boolean) {
    this.base64 = base64;
    this.total = total;
    this.truncated = truncated;
  }
}

/** 浏览器里现在这一页 */
class PageDoc {
  id: string;
  url: string;

  constructor(id: string, url: string) {
    this.id = id;
    this.url = url;
  }
}

/** 拦下的下载：存在 App 缓存里的那份 */
class FileDoc {
  id: string;
  url: string;
  name: string;
  path: string;

  constructor(id: string, url: string, name: string, path: string) {
    this.id = id;
    this.url = url;
    this.name = name;
    this.path = path;
  }
}

function outcome(ok: boolean, reason: string): string {
  return JSON.stringify(new DocOutcome(ok, reason));
}

/**
 * 原生浏览器里能渲染的文件（160 号票）：markdown 这类文本文件不显示原始文本、不下载，交给二狗的网页用二狗的渲染画（网页一侧
 * packages/web/src/app/browse-files.ts，哪些渲染由网页的 state/file-view.ts 定）。网页说它能渲染文件了（browserDoc enable，
 * 旧版网页不说，这里什么都不做）之后：
 * - 浏览器里每加载完一页，问一下它的 document.contentType，报给网页（document，via page）——服务端回 text/markdown、text/plain、
 *   JSON 这些时浏览器显示原始文本，网页据此盖上渲染层；取内容时现取页面上显示的字（浏览器已经解好了，最多 1 MB）；
 * - 浏览器里的下载先粗筛（looksText，1 MB 以内、大小知道的），可能是能渲染的文本就拦下：照样下进 App 缓存，不提示、不弹"保存到"，
 *   报给网页（via download，带服务端给的文件名）；网页说不渲染的照常弹"保存到"（save）；取内容时读缓存里那份的字节（base64，
 *   由网页按字符集解）。同时只留一份，换成别的、网页说不看了（drop）就删；
 * - 下载（save）：页面上的经浏览器重新下载一次（这次不拦，照常弹"保存到"），拦下的直接弹"保存到"（缓存里那份留着）；
 *   用系统浏览器打开（outside）这个文件的地址。
 * 编号 p…（页面）、d…（下载）由这里发，取内容、下载都凭它，过时的（浏览器已经换了页）回明确的原因。
 */
export class FileDocs implements DownloadDivert {
  /** 网页说它能渲染文件了（主页面重新加载时 Index.ets 清掉，新页面再说） */
  enabled: boolean = false;
  private readonly context: common.UIAbilityContext;
  private readonly controller: webview.WebviewController;
  /** 往二狗的网页推（Index.ets 的 pushBrowser） */
  private readonly emit: (json: string) => void;
  /** 缓存里的文件弹"保存到"（WebDownloads.saveFile；keep 为真时缓存里那份留着） */
  private readonly saveFile: (path: string, name: string, keep: boolean) => void;
  private seq: number = 0;
  /** 每开始加载一页加一：问类型问到一半换了页的不报 */
  private pageToken: number = 0;
  private page: PageDoc | undefined = undefined;
  private file: FileDoc | undefined = undefined;
  /** 点了"下载"、要经浏览器真的下载的地址（这次不拦） */
  private forced: string[] = [];

  constructor(context: common.UIAbilityContext, controller: webview.WebviewController, emit: (json: string) => void,
    saveFile: (path: string, name: string, keep: boolean) => void) {
    this.context = context;
    this.controller = controller;
    this.emit = emit;
    this.saveFile = saveFile;
  }

  /** 浏览器开始加载一页（onPageBegin）：上一页作废 */
  pageBegin(): void {
    this.pageToken += 1;
    this.page = undefined;
  }

  /** 浏览器加载完一页（onPageEnd）：问它的类型，报给网页 */
  pageEnd(url: string): void {
    if (!this.enabled || !isWebUrl(url)) {
      return;
    }
    const token = this.pageToken;
    try {
      this.controller.runJavaScript('document.contentType')
        .then((result: string) => {
          if (token !== this.pageToken || !this.enabled) {
            return;
          }
          this.seq += 1;
          const page = new PageDoc(`p${this.seq}`, url);
          this.page = page;
          this.emit(JSON.stringify(new DocEvent(new DocMessage(page.id, url, unquote(result), '', 'page', -1))));
        })
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'probe content type failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'probe content type failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 要不要拦这个下载（WebDownloads 问）：网页能渲染、不是点了"下载"的、1 MB 以内、粗看是文本 */
  want(item: webview.WebDownloadItem): boolean {
    const url = item.getUrl();
    const at = this.forced.indexOf(url);
    if (at >= 0) {
      this.forced.splice(at, 1);
      return false;
    }
    if (!this.enabled) {
      return false;
    }
    const total = item.getTotalBytes();
    return total > 0 && total <= TEXT_MAX && looksText(item.getSuggestedFileName(), url, item.getMimeType());
  }

  /** 拦下的下完了：换掉上一份，报给网页；网页这时已经不渲染了（重新加载过）就照常弹"保存到" */
  finished(item: webview.WebDownloadItem, path: string): void {
    const name = safeFileName(item.getSuggestedFileName());
    if (!this.enabled) {
      this.saveFile(path, name, false);
      return;
    }
    this.dropFile();
    this.seq += 1;
    const file = new FileDoc(`d${this.seq}`, item.getUrl(), name, path);
    this.file = file;
    this.emit(JSON.stringify(new DocEvent(new DocMessage(file.id, file.url, item.getMimeType(), name, 'download', item.getTotalBytes()))));
  }

  failed(item: webview.WebDownloadItem): void {
    hilog.warn(DOMAIN, TAG, 'diverted download failed: %{public}d', item.getLastErrorCode());
  }

  /** 网页调的（原生桥 browserDoc）：enable / source / save / outside / drop */
  run(op: string, id: string): Promise<string> {
    if (op === 'enable') {
      this.enabled = true;
      // 主页面重新加载过（网页重新说能渲染）：浏览器里现在这一页再报一次，显示着原始文本的照样盖上渲染层
      this.pageEnd(this.currentUrl());
      return Promise.resolve(outcome(true, ''));
    }
    const page = this.page !== undefined && this.page.id === id ? this.page : undefined;
    const file = this.file !== undefined && this.file.id === id ? this.file : undefined;
    if (page === undefined && file === undefined) {
      return Promise.resolve(outcome(false, t('harmony.fileDocs.fileGone')));
    }
    if (op === 'source') {
      return page !== undefined ? this.pageSource(page) : Promise.resolve(this.fileSource(file as FileDoc));
    }
    if (op === 'save') {
      if (file !== undefined) {
        this.saveFile(file.path, file.name, true);
      } else {
        this.download((page as PageDoc).url);
      }
      return Promise.resolve(outcome(true, ''));
    }
    if (op === 'outside') {
      const url = file !== undefined ? file.url : (page as PageDoc).url;
      this.context.openLink(url).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'open file in system browser failed: %{public}s', JSON.stringify(err));
      });
      return Promise.resolve(outcome(true, ''));
    }
    if (op === 'drop') {
      if (file !== undefined) {
        this.dropFile();
      }
      return Promise.resolve(outcome(true, ''));
    }
    return Promise.resolve(outcome(false, t('harmony.fileDocs.unknownOp')));
  }

  /** 浏览器现在的地址；Web 组件还没建、还没接上是空串 */
  private currentUrl(): string {
    try {
      return this.controller.getUrl();
    } catch (e) {
      return '';
    }
  }

  /** 页面上显示的字（浏览器还在这一页才取） */
  private pageSource(page: PageDoc): Promise<string> {
    if (withoutHash(this.currentUrl()) !== withoutHash(page.url)) {
      return Promise.resolve(outcome(false, t('harmony.fileDocs.pageChanged')));
    }
    try {
      return this.controller.runJavaScript(SOURCE_SCRIPT)
        .then((result: string) => {
          const json = unquote(result);
          return json.length > 0 ? json : outcome(false, t('harmony.fileDocs.noPageText'));
        })
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'read page source failed: %{public}s', JSON.stringify(err));
          return outcome(false, t('harmony.fileDocs.noPageText'));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read page source failed: %{public}s', JSON.stringify(e));
      return Promise.resolve(outcome(false, t('harmony.fileDocs.noPageText')));
    }
  }

  /** 缓存里那份的字节（最多 1 MB，base64） */
  private fileSource(file: FileDoc): string {
    let fd: fs.File | undefined = undefined;
    try {
      const size = fs.statSync(file.path).size;
      const length = Math.min(size, TEXT_MAX);
      fd = fs.openSync(file.path, fs.OpenMode.READ_ONLY);
      const buffer = new ArrayBuffer(length);
      const read = length > 0 ? fs.readSync(fd.fd, buffer, { offset: 0, length: length }) : 0;
      const base64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer, 0, read));
      return JSON.stringify(new DocBytes(base64, size, size > read));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'read diverted download failed: %{public}s', JSON.stringify(e));
      return outcome(false, t('harmony.common.readCacheFailed'));
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'close diverted download failed: %{public}s', JSON.stringify(e));
        }
      }
    }
  }

  /** 页面上显示的文件真的下载一次：经浏览器下载（这次不拦，WebDownloads 照常弹"保存到"） */
  private download(url: string): void {
    this.forced.push(url);
    if (this.forced.length > 5) {
      this.forced.shift();
    }
    try {
      this.controller.startDownload(url);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'start download failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 删掉缓存里拦下的那份 */
  private dropFile(): void {
    const file = this.file;
    this.file = undefined;
    if (file === undefined) {
      return;
    }
    try {
      if (fs.accessSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'remove diverted download failed: %{public}s', JSON.stringify(e));
    }
  }
}
