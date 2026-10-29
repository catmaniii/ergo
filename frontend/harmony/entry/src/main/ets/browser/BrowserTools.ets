import { webview } from '@kit.ArkWeb';
import { common, Want, wantConstant } from '@kit.AbilityKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { originOf, ServerAddress } from '../common/ServerAddress';
import { isWebUrl } from './InAppBrowser';

/** 文字大小（百分比）：和网页一侧 packages/web/src/state/browse-tools.ts 的 TEXT_ZOOM 一致 */
const ZOOM_NORMAL = 100;
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
/** 下载记录存在 App 的文件目录里（不进缓存：清缓存不清它），最多记这么多条 */
const DOWNLOADS_FILE = 'browser-downloads.json';
const DOWNLOADS_MAX = 200;
/** 清 Cookie 时留下的二狗自己的 cookie 再写回去时的有效期（秒）：和守护进程的设备凭证一样 400 天（每次用都会重新下发） */
const OWN_COOKIE_MAX_AGE = 34560000;
/** 主机名像样：字母数字、点、横线（IPv6 带方括号） */
const HOST = new RegExp('^(\\[[0-9a-f:.]+\\]|[a-z0-9.-]{1,253})$');
/** 二狗的网页交来的浏览器标识只认这样的（Mozilla/5.0 开头、不太长） */
const USER_AGENT = new RegExp('^Mozilla/5\\.0 [\\x20-\\x7e]{10,400}$');

/** browserTool 各操作的参数（网页一侧 packages/web/src/app/native-browser.ts 的 wrapToolControl 发的 JSON） */
interface ToolArgs {
  text?: string;
  forward?: boolean;
  open?: boolean;
  desktopUserAgent?: string;
  desktop?: string[];
  zoom?: Record<string, number>;
  title?: string;
  url?: string;
  cache?: boolean;
  cookies?: boolean;
  scope?: string;
  id?: string;
  ids?: string[];
}

class ToolOutcome {
  ok: boolean;
  reason?: string;

  constructor(ok: boolean, reason: string) {
    this.ok = ok;
    if (reason.length > 0) {
      this.reason = reason;
    }
  }
}

function outcome(ok: boolean, reason: string): string {
  return JSON.stringify(new ToolOutcome(ok, reason));
}

/** 清数据的结果：要告诉用户的几句（缓存只能整个清、有几个 Cookie 没清掉……） */
class ClearResult {
  ok: boolean = true;
  notes: string[] = [];
  reason?: string;
}

/** 推给二狗的网页的：查找结果（第几个，从 0 数；一共几个；数完了没有） */
class FindMessage {
  type: string = 'find';
  active: number;
  total: number;
  done: boolean;

  constructor(active: number, total: number, done: boolean) {
    this.active = active;
    this.total = total;
    this.done = done;
  }
}

/** 推给二狗的网页的：查找栏开着时按了返回，收起查找栏 */
class FindClose {
  type: string = 'find-close';
}

/** 一条下载记录：名字、大小（字节）、存好的时间（毫秒）、存在哪（系统"保存到"给的地址）、类型 */
export class DownloadEntry {
  id: string = '';
  name: string = '';
  size: number = 0;
  time: number = 0;
  uri: string = '';
  mime: string = '';
}

class DownloadList {
  ok: boolean = true;
  downloads: DownloadEntry[] = [];
}

function parseArgs(json: string): ToolArgs {
  try {
    const value = JSON.parse(json) as ToolArgs;
    return value !== null && typeof value === 'object' ? value : {};
  } catch (e) {
    return {};
  }
}

/** http(s) 地址的主机名（小写，去掉用户名和端口）；不是 http(s) 是空串 */
export function hostOf(url: string): string {
  const m = new RegExp('^https?://([^/?#]*)', 'i').exec(url);
  if (m === null) {
    return '';
  }
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    authority = authority.substring(at + 1);
  }
  const host = (authority.startsWith('[') ? authority.substring(0, authority.indexOf(']') + 1) :
  authority.replace(new RegExp(':\\d*$'), '')).toLowerCase();
  return HOST.test(host) ? host : '';
}

/** 清一个网站的 cookie 时试的 Domain：不写、主机名、带点的主机名、各级上级域名（IP 不试上级） */
function cookieDomains(host: string): string[] {
  const out: string[] = ['', `; Domain=${host}`, `; Domain=.${host}`];
  if (new RegExp('^[0-9.]+$').test(host) || host.startsWith('[')) {
    return out;
  }
  const labels = host.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    out.push(`; Domain=${parent}`, `; Domain=.${parent}`);
  }
  return out;
}

/** 清一个网站的 cookie 时试的 Path：/ 和地址里每一级（最多 5 级） */
function cookiePaths(url: string): string[] {
  const m = new RegExp('^https?://[^/?#]*(/[^?#]*)?', 'i').exec(url);
  const path = m !== null && m[1] !== undefined ? m[1] : '/';
  const out: string[] = ['/'];
  let at = '';
  for (const part of path.split('/').filter((p: string) => p.length > 0).slice(0, 5)) {
    at = `${at}/${part}`;
    out.push(at);
  }
  return out;
}

/** "a=1; b=2" 里的名字和值 */
function cookiePairs(raw: string): string[][] {
  const out: string[][] = [];
  for (const piece of raw.split(';')) {
    const eq = piece.indexOf('=');
    const name = (eq >= 0 ? piece.substring(0, eq) : piece).trim();
    if (name.length === 0) {
      continue;
    }
    out.push([name, eq >= 0 ? piece.substring(eq + 1).trim() : '']);
  }
  return out;
}

/** 某个地址现在带着的 cookie（"a=1; b=2"）；没有、取不到是空串（没有时 ArkWeb 抛 17100002） */
function cookiesOf(url: string): string {
  try {
    return webview.WebCookieManager.fetchCookieSync(url);
  } catch (e) {
    return '';
  }
}

/**
 * "浏览"页签右上角 ⋮ 菜单（165 号票）用到的原生能力，二狗的网页经原生桥 browserTool(op, json) 调（网页一侧
 * packages/web/src/app/native-browser.ts 的 NativeToolControl，都回 JSON）：
 * - find / findNext / findClear：ArkWeb 自带的页内查找（searchAllAsync、searchNext、clearMatches），网页里高亮；结果由 Index.ets 的
 *   onSearchResultReceive 交到 searchResult，推 {type: "find"}；findBar 是网页的查找栏开没开——开着时返回手势先收起它（closeFind，
 *   推 {type: "find-close"}），再退网页历史；
 * - sites：按网站记住的文字大小、桌面版（记在二狗网页那边，整份交过来）。文字大小在每一页开始时（pageBegin）按主机名设
 *   （Web 组件的 textZoomRatio，Index.ets 的 @State）；桌面版用 WebviewController.setUserAgentForHosts（API 20）给这些主机名换成
 *   桌面版的浏览器标识（二狗的网页按自己的标识算好交来），请求发出去之前就生效，网页切换后再重新加载。二狗自己的主机名不换
 *   （setUserAgentForHosts 对整个 App 的 Web 生效，二狗的网页、侧边栏也是 Web）；
 * - share：系统分享面板（ShareKit），分享标题加网址；
 * - clear：清缓存（removeCache，整个 App 一份，没法只清一个网站）、Cookie 和网站数据。cookie 和网页存储整个 App 共用一份，二狗自己的
 *   设备凭证 cookie、网页的本地存储（设置、浏览记录）也在里面：清全部时先取二狗来源的 cookie，清完写回去（HttpOnly、Secure、
 *   SameSite=Strict、Path=/），网页存储按来源删、跳过二狗的来源；只清当前网站时把这个地址带着的 cookie 按几种 Domain、Path 写成过期，
 *   再删这个来源的网页存储，二狗自己的页面不清 cookie（清了二狗会掉线）；
 * - downloads / openDownload / removeDownloads：在浏览器里下载、存好了的文件的记录（WebDownloads 存好时 record 记下，存在 App 的文件
 *   目录里），打开交给系统（viewData，带读权限），删记录不删文件。
 */
export class BrowserTools {
  private readonly context: common.UIAbilityContext;
  private readonly controller: webview.WebviewController;
  /** 往二狗的网页推（Index.ets 调 window.__ergoBrowser） */
  private readonly emit: (json: string) => void;
  /** 二狗现在的地址（清 cookie 时留下它的、不给它换浏览器标识） */
  private readonly server: () => ServerAddress | undefined;
  /** 浏览器现在这一页的地址 */
  private readonly currentUrl: () => string;
  /** 设文字大小（Index.ets 的 @State，Web 组件的 textZoomRatio） */
  private readonly setZoom: (zoom: number) => void;
  private zoomByHost: Map<string, number> = new Map<string, number>();
  private desktopUa: string = '';
  /** 网页的查找栏开着 */
  findOpen: boolean = false;
  private downloadList: DownloadEntry[] = [];
  private downloadsLoaded: boolean = false;
  private downloadSeq: number = 0;

  constructor(context: common.UIAbilityContext, controller: webview.WebviewController, emit: (json: string) => void,
    server: () => ServerAddress | undefined, currentUrl: () => string, setZoom: (zoom: number) => void) {
    this.context = context;
    this.controller = controller;
    this.emit = emit;
    this.server = server;
    this.currentUrl = currentUrl;
    this.setZoom = setZoom;
  }

  /** browserTool(op, json)：回 JSON */
  run(op: string, json: string): Promise<string> {
    const args = parseArgs(json);
    try {
      if (op === 'find') {
        return Promise.resolve(this.find(typeof args.text === 'string' ? args.text : ''));
      }
      if (op === 'findNext') {
        this.controller.searchNext(args.forward !== false);
        return Promise.resolve(outcome(true, ''));
      }
      if (op === 'findClear') {
        this.controller.clearMatches();
        return Promise.resolve(outcome(true, ''));
      }
      if (op === 'findBar') {
        this.findOpen = args.open === true;
        return Promise.resolve(outcome(true, ''));
      }
      if (op === 'sites') {
        return Promise.resolve(this.sites(args));
      }
      if (op === 'share') {
        return this.share(typeof args.title === 'string' ? args.title : '', typeof args.url === 'string' ? args.url : '');
      }
      if (op === 'clear') {
        return this.clear(args);
      }
      if (op === 'downloads') {
        const list = new DownloadList();
        list.downloads = this.loadDownloads();
        return Promise.resolve(JSON.stringify(list));
      }
      if (op === 'openDownload') {
        return this.openDownload(typeof args.id === 'string' ? args.id : '');
      }
      if (op === 'removeDownloads') {
        return Promise.resolve(this.removeDownloads(Array.isArray(args.ids) ? args.ids : []));
      }
    } catch (e) {
      // Web 组件还没接上 controller（17100001）这类：当失败，网页照常
      hilog.warn(DOMAIN, TAG, 'browser tool %{public}s failed: %{public}s', op, JSON.stringify(e));
      return Promise.resolve(outcome(false, t('harmony.browserTools.notReady')));
    }
    return Promise.resolve(outcome(false, t('harmony.browserTools.unknownOp', { 'op': op })));
  }

  // ───────────────────────── 页内查找 ─────────────────────────

  private find(text: string): string {
    try {
      if (text.length === 0) {
        this.controller.clearMatches();
        this.emit(JSON.stringify(new FindMessage(0, 0, true)));
        return outcome(true, '');
      }
      this.controller.searchAllAsync(text.substring(0, 200));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'find in page failed: %{public}s', JSON.stringify(e));
      return outcome(false, t('harmony.browserTools.notReady'));
    }
    return outcome(true, '');
  }

  /** Index.ets 的 onSearchResultReceive：推给网页（activeMatchOrdinal 从 0 数） */
  searchResult(active: number, total: number, done: boolean): void {
    if (!this.findOpen) {
      return;
    }
    this.emit(JSON.stringify(new FindMessage(Math.max(0, active), Math.max(0, total), done)));
  }

  /** 返回手势：查找栏开着就让网页收起它，返回 true */
  closeFind(): boolean {
    if (!this.findOpen) {
      return false;
    }
    this.findOpen = false;
    this.emit(JSON.stringify(new FindClose()));
    return true;
  }

  // ───────────────────────── 按网站记住的文字大小、桌面版 ─────────────────────────

  private sites(args: ToolArgs): string {
    const zoom = new Map<string, number>();
    const given = args.zoom;
    if (given !== undefined && given !== null && typeof given === 'object') {
      for (const host of Object.keys(given)) {
        const value = given[host];
        if (HOST.test(host) && typeof value === 'number' && Number.isFinite(value)) {
          zoom.set(host, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value))));
        }
      }
    }
    this.zoomByHost = zoom;
    const server = this.server();
    const own = server === undefined ? '' : server.host.toLowerCase();
    const hosts = (Array.isArray(args.desktop) ? args.desktop : [])
      .filter((h: string) => typeof h === 'string' && HOST.test(h) && h !== own)
      .slice(0, 1000);
    const ua = typeof args.desktopUserAgent === 'string' && USER_AGENT.test(args.desktopUserAgent) ? args.desktopUserAgent : '';
    this.applyDesktop(ua, hosts);
    // 现在这一页的文字大小跟着变
    this.pageBegin(this.currentUrl());
    return outcome(true, '');
  }

  /** 给这些主机名换成桌面版的浏览器标识（同一个标识再设一次就是换掉名单；换了标识先把旧标识的名单清掉） */
  private applyDesktop(ua: string, hosts: string[]): void {
    try {
      if (this.desktopUa.length > 0 && this.desktopUa !== ua) {
        webview.WebviewController.setUserAgentForHosts(this.desktopUa, []);
      }
      if (ua.length > 0) {
        webview.WebviewController.setUserAgentForHosts(ua, hosts);
      }
      this.desktopUa = ua;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'set desktop user agent failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 浏览器里一页开始了（Index.ets 的 onPageBegin）、按网站的设置变了：按这一页的主机名设文字大小 */
  pageBegin(url: string): void {
    const zoom = this.zoomByHost.get(hostOf(url));
    this.setZoom(zoom === undefined ? ZOOM_NORMAL : zoom);
  }

  // ───────────────────────── 分享 ─────────────────────────

  private share(title: string, url: string): Promise<string> {
    if (!isWebUrl(url)) {
      return Promise.resolve(outcome(false, t('harmony.browserTools.shareWebOnly')));
    }
    const record: systemShare.SharedRecord = {
      utd: uniformTypeDescriptor.UniformDataType.HYPERLINK,
      content: url,
      title: title.length > 0 ? title.substring(0, 300) : url,
      description: url
    };
    const options: systemShare.ShareControllerOptions = {
      previewMode: systemShare.SharePreviewMode.DETAIL,
      selectionMode: systemShare.SelectionMode.SINGLE
    };
    try {
      const controller = new systemShare.ShareController(new systemShare.SharedData(record));
      return controller.show(this.context, options)
        .then(() => outcome(true, ''))
        .catch((err: BusinessError) => {
          hilog.error(DOMAIN, TAG, 'share failed: %{public}s', JSON.stringify(err));
          return outcome(false, t('harmony.browserTools.shareFailed', { 'code': String(err.code) }));
        });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'share failed: %{public}s', JSON.stringify(e));
      return Promise.resolve(outcome(false, t('harmony.browserTools.shareUnsupported')));
    }
  }

  // ───────────────────────── 清除浏览数据 ─────────────────────────

  private async clear(args: ToolArgs): Promise<string> {
    const result = new ClearResult();
    const url = typeof args.url === 'string' ? args.url : '';
    const site = args.scope === 'site' && isWebUrl(url);
    if (args.cache === true) {
      try {
        this.controller.removeCache(true);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'remove cache failed: %{public}s', JSON.stringify(e));
        result.ok = false;
        result.reason = t('harmony.browserTools.clearCacheFailed');
      }
      if (site) {
        result.notes.push(t('harmony.browserTools.cacheAllSites'));
      }
    }
    if (args.cookies === true) {
      if (site) {
        await this.clearSite(url, result);
      } else {
        await this.clearAll(result);
      }
      try {
        await webview.WebCookieManager.saveCookieAsync();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'save cookies failed: %{public}s', JSON.stringify(e));
      }
    }
    return JSON.stringify(result);
  }

  /** 全部网站的 Cookie 和网站数据：二狗自己的留着 */
  private async clearAll(result: ClearResult): Promise<void> {
    const server = this.server();
    const kept = server === undefined ? '' : cookiesOf(server.href);
    try {
      webview.WebCookieManager.clearAllCookiesSync();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'clear cookies failed: %{public}s', JSON.stringify(e));
      result.ok = false;
      result.reason = t('harmony.browserTools.clearCookiesFailed');
      return;
    }
    if (server !== undefined && kept.length > 0) {
      this.restoreOwn(server, kept, result);
    }
    try {
      const origins = await webview.WebStorage.getOrigins();
      for (const origin of origins) {
        if (server !== undefined && originOf(origin.origin) === server.origin) {
          continue;
        }
        try {
          webview.WebStorage.deleteOrigin(origin.origin);
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'delete web storage of an origin failed: %{public}s', JSON.stringify(e));
        }
      }
    } catch (e) {
      // 没有网页存储时 ArkWeb 也会报错：不算没清成
      hilog.info(DOMAIN, TAG, 'list web storage origins: %{public}s', JSON.stringify(e));
    }
  }

  /** 清全部 cookie 之后把二狗来源的写回去（设备凭证是 HttpOnly、Secure、SameSite=Strict、Path=/ 的 __Host- cookie），再核对一遍 */
  private restoreOwn(server: ServerAddress, kept: string, result: ClearResult): void {
    const names: string[] = [];
    for (const pair of cookiePairs(kept)) {
      const name = pair[0];
      const secure = server.scheme === 'https' || name.startsWith('__Host-') || name.startsWith('__Secure-');
      try {
        webview.WebCookieManager.configCookieSync(server.href,
          `${name}=${pair[1]}; Max-Age=${OWN_COOKIE_MAX_AGE}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`, false, true);
        names.push(name);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'restore own cookie failed: %{public}s', JSON.stringify(e));
      }
    }
    const now = cookiePairs(cookiesOf(server.href)).map((p: string[]) => p[0]);
    const lost = cookiePairs(kept).filter((p: string[]) => !now.includes(p[0])).length;
    if (lost > 0) {
      hilog.error(DOMAIN, TAG, 'own cookies lost after clearing: %{public}d', lost);
      result.notes.push(t('harmony.browserTools.ownLoginLost'));
    } else {
      hilog.info(DOMAIN, TAG, 'kept %{public}d own cookies while clearing', names.length);
    }
  }

  /** 只清当前网站：这个地址带着的 cookie 按几种 Domain、Path 写成过期，再删这个来源的网页存储；二狗自己的页面不清 cookie */
  private async clearSite(url: string, result: ClearResult): Promise<void> {
    const server = this.server();
    if (server !== undefined && originOf(url) === server.origin) {
      result.notes.push(t('harmony.browserTools.ownSiteKept'));
      return;
    }
    const host = hostOf(url);
    const names = cookiePairs(cookiesOf(url)).map((p: string[]) => p[0]);
    const secure = url.toLowerCase().startsWith('https:') ? '; Secure' : '';
    for (const name of names) {
      for (const domain of name.startsWith('__Host-') ? [''] : cookieDomains(host)) {
        for (const path of name.startsWith('__Host-') ? ['/'] : cookiePaths(url)) {
          try {
            webview.WebCookieManager.configCookieSync(url, `${name}=; Max-Age=0; Path=${path}${domain}${secure}`, false, true);
          } catch (e) {
            // 这一种 Domain、Path 写不进（比如上级域名不让写）：试下一种
          }
        }
      }
    }
    const left = cookiePairs(cookiesOf(url)).length;
    if (left > 0) {
      result.notes.push(t('harmony.browserTools.cookiesLeft', { 'count': String(left) }));
    }
    try {
      webview.WebStorage.deleteOrigin(originOf(url));
    } catch (e) {
      // 这个来源没有网页存储：不算没清成
      hilog.info(DOMAIN, TAG, 'delete web storage of the site: %{public}s', JSON.stringify(e));
    }
  }

  // ───────────────────────── 下载记录 ─────────────────────────

  private downloadsPath(): string {
    return `${this.context.filesDir}/${DOWNLOADS_FILE}`;
  }

  private loadDownloads(): DownloadEntry[] {
    if (this.downloadsLoaded) {
      return this.downloadList;
    }
    this.downloadsLoaded = true;
    try {
      const path = this.downloadsPath();
      if (fs.accessSync(path)) {
        const value = JSON.parse(fs.readTextSync(path)) as DownloadEntry[];
        if (Array.isArray(value)) {
          this.downloadList = value.filter((d: DownloadEntry) => d !== null && typeof d === 'object' && typeof d.id === 'string' &&
            typeof d.uri === 'string').slice(0, DOWNLOADS_MAX);
        }
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read download records failed: %{public}s', JSON.stringify(e));
    }
    return this.downloadList;
  }

  private saveDownloads(): void {
    try {
      const file = fs.openSync(this.downloadsPath(), fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, JSON.stringify(this.downloadList));
      } finally {
        fs.closeSync(file);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'write download records failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 浏览器里下载的文件存好了（WebDownloads 弹"保存到"、拷过去之后）：记一条 */
  record(name: string, uri: string, size: number, mime: string): void {
    const list = this.loadDownloads();
    const entry = new DownloadEntry();
    this.downloadSeq += 1;
    entry.id = `dl-${Date.now()}-${this.downloadSeq}`;
    entry.name = name;
    entry.size = size;
    entry.time = Date.now();
    entry.uri = uri;
    entry.mime = mime;
    this.downloadList = [entry].concat(list).slice(0, DOWNLOADS_MAX);
    this.saveDownloads();
  }

  /** 打开一个下载的文件：交给系统（viewData，带读权限）；系统没有能打开它的应用、文件被移走或删了时回原因 */
  private openDownload(id: string): Promise<string> {
    const entry = this.loadDownloads().find((d: DownloadEntry) => d.id === id);
    if (entry === undefined) {
      return Promise.resolve(outcome(false, t('harmony.browserTools.recordGone')));
    }
    const want: Want = {
      action: 'ohos.want.action.viewData',
      uri: entry.uri,
      flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION
    };
    if (entry.mime.length > 0) {
      want.type = entry.mime;
    }
    try {
      return this.context.startAbility(want)
        .then(() => outcome(true, ''))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'open download failed: %{public}s', JSON.stringify(err));
          return outcome(false, t('harmony.browserTools.noAppToOpen'));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'open download failed: %{public}s', JSON.stringify(e));
      return Promise.resolve(outcome(false, t('harmony.browserTools.cantOpenFile')));
    }
  }

  /** 删记录（文件留着） */
  private removeDownloads(ids: string[]): string {
    const list = this.loadDownloads();
    this.downloadList = list.filter((d: DownloadEntry) => !ids.includes(d.id));
    this.saveDownloads();
    return outcome(true, '');
  }
}
