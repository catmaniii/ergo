import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { safeFileName } from '../download/WebDownloads';

/** 页面桥注入到网页的对象名（只有 post 一个方法），和 packages/web/src/page-bridge/protocol.ts 的 PAGE_BRIDGE_HOST 一致 */
export const PAGE_HOST_NAME = 'ergoPageHost';
/** 页面桥脚本（npm run build:harmony 从 packages/web/src/page-bridge 打包进 rawfile）和里面口令的占位 */
const PAGE_BRIDGE_FILE = 'page-bridge.js';
const NONCE_MARK = '__ERGO_PAGE_NONCE__';
/**
 * 网页能调的页面桥方法（交文件那三个由这里自己调）；bubble 是悬浮按钮旁边的气泡画成什么样（146 号票）；
 * 147 号票（浏览侧边栏）多三个：selected（现在选中的框）、text（整页文字）、clearSelection（取消选中）；
 * 149 号票多一个 pick（挑图片窗口画成什么样）；164 号票多两个：snapshot（网页上能点的东西，编号记在页面桥里）、click（按编号点，
 * 页面桥核对还是那一页、元素还在、字没变才点；开新窗口的在这个浏览器里打开）。名字和 packages/web/src/page-bridge/protocol.ts 的
 * PageBridgeApi 一致。旧版 App 没有这两个时回空串，二狗的网页据此说"App 太旧，装新版才能点"。
 * 169 号票多一个 texts：页面桥自己的字（悬浮按钮的说明、气泡和挑图片窗口上的按钮）换成二狗的网页交来的当前语言；旧版 App 没有时页面桥照旧中文。
 * 184 号票多一个 refField：按编号找要填的文本框、要交的上传框（页面桥核对还是那一页、编号认得、种类没变，回框的编号，二狗的网页再照它
 * fill、经 browserFiles 交）；旧版 App 没有时回空串，二狗的网页据此说"App 太旧，装新版才能按编号填和交"
 */
const PAGE_OPS: string[] = ['fields', 'fill', 'mark', 'bubble', 'pick', 'selected', 'text', 'clearSelection', 'snapshot', 'click', 'refField', 'texts'];
/** 收起气泡、挑图片窗口（宿主交给页面桥的样子） */
const BUBBLE_NONE = '{"kind":"none"}';
/** 一个文件最大多少字节（和协议的 PAGE_FILE_MAX_BYTES 一样）；往网页里交时一段多大（原始字节，base64 之后约 512 KB） */
const FILE_MAX_BYTES = 50 * 1024 * 1024;
const PAGE_CHUNK_BYTES = 384 * 1024;
/** 文件的编号（二狗的网页给的）只认这样的 */
const FILE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** 页面桥报来的话里 App 要看的那几样 */
interface PageMessage {
  nonce: string;
  type: string;
  field?: PageMessageField;
}

interface PageMessageField {
  id: string;
}

/** 二狗的网页交给页面桥的气泡的样子里 App 要看的那一样：是不是收起（none） */
interface BubbleKind {
  kind: string;
}

/** 推给二狗的网页的：气泡开着时按了返回，收起气泡（146 号票） */
class BubbleClose {
  type: string = 'bubble-close';
}

/** 推给二狗的网页的：挑图片窗口开着时按了返回，收起窗口（149 号票；会话里的候选卡照样能挑） */
class PickClose {
  type: string = 'pick-close';
}

/** 推给二狗的网页的：页面桥的一句话原样带过去 */
class PageForward {
  type: string = 'page';
  json: string;

  constructor(json: string) {
    this.json = json;
  }
}

/** 推给二狗的网页的：网页弹出选文件对话框了，App 拦下了 */
class ChooserForward {
  type: string = 'chooser';
  accept: string[];
  multiple: boolean;
  capture: boolean;
  fieldId: string;

  constructor(accept: string[], multiple: boolean, capture: boolean, fieldId: string) {
    this.accept = accept;
    this.multiple = multiple;
    this.capture = capture;
    this.fieldId = fieldId;
  }
}

/** 二狗的网页要交的一个文件（字节已经经 browserFileChunk 写到 App 的缓存里） */
interface DeliveryFile {
  id: string;
  name: string;
  mime: string;
}

/** 二狗的网页要交文件：交进页面桥认出的那个框（field），或者交给拦下的选文件对话框（chooser） */
interface Delivery {
  target: string;
  fieldId?: string;
  files: DeliveryFile[];
}

/** 回给二狗的网页的结果 */
class Outcome {
  ok: boolean;
  count: number;
  reason: string;

  constructor(ok: boolean, count: number, reason: string) {
    this.ok = ok;
    this.count = count;
    this.reason = reason;
  }
}

function outcome(ok: boolean, count: number, reason: string): string {
  return JSON.stringify(new Outcome(ok, count, reason));
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

/** 去掉 # 后面的部分 */
function withoutHash(href: string): string {
  const at = href.indexOf('#');
  return at < 0 ? href : href.substring(0, at);
}

/**
 * 页面桥注入后给它的对象（javaScriptProxy，名字 ergoPageHost）：只有 post 一个方法，收页面桥报的话。
 * 网页自己的脚本也调得到它，所以每句话都要带页面桥的口令（PageControl 核对），伪造不了
 */
export class PageHost {
  private control: PageControl;

  constructor(control: PageControl) {
    this.control = control;
  }

  post(json: string): void {
    this.control.received(typeof json === 'string' ? json : '');
  }
}

/**
 * 页面桥（134 号票第二部分）在 App 这一侧：给浏览器的 Web 注入页面桥脚本（换好口令）、收它报的话转给二狗的网页、
 * 替二狗的网页调页面桥（填字、按钮的样子）、把二狗的网页交来的文件交进网页（两条路：页面桥塞进选文件的框；交给拦下的选文件对话框），
 * 以及拦下网页弹出的选文件对话框（onShowFileSelector）问用户"让二狗选 / 自己选"。
 * 浏览器的 Web 不挂二狗的原生桥；网页的脚本能碰到的只有 ergoPageHost.post，没有口令说的话一律不认。
 */
export class PageControl {
  private context: common.UIAbilityContext;
  private controller: webview.WebviewController;
  /** 往二狗的网页推（Index.ets 调 window.__ergoBrowser） */
  private emit: (json: string) => void;
  /** 二狗的网页在不在（有"浏览"页签）：不在时选文件对话框照系统默认的 */
  private webReady: () => boolean;
  /** 这次 App 跑起来的口令：注入时换进脚本，页面桥每句话都带着 */
  private nonce: string = util.generateRandomUUID(false).replace(new RegExp('-', 'g'), '');
  /** 注入的脚本（javaScriptOnDocumentStart）；rawfile 里没有页面桥时是空的，什么都不注入 */
  readonly scripts: ScriptItem[] = [];
  /** 拦下的选文件对话框（等用户选"让二狗选 / 自己选"、等二狗交文件） */
  private chooser: FileSelectorResult | undefined = undefined;
  private chooserMultiple: boolean = false;
  private chooserImages: boolean = false;
  /** 页面桥最近说的"要弹选文件对话框的是这个框"（网站的脚本调 input.click() 时） */
  private chooserField: string = '';
  private chooserFieldAt: number = 0;
  /** 二狗的网页写进来的文件：编号 → 写了多少字节 */
  private staged: Map<string, number> = new Map<string, number>();
  /** 悬浮按钮旁边的气泡开着（146 号票：二狗的网页最近交给页面桥的样子不是 none）：返回手势先收起它 */
  private bubbleOpen: boolean = false;
  /** 挑图片窗口开着（149 号票，同上）：气泡之后收它 */
  private pickOpen: boolean = false;

  constructor(context: common.UIAbilityContext, controller: webview.WebviewController, emit: (json: string) => void,
    webReady: () => boolean) {
    this.context = context;
    this.controller = controller;
    this.emit = emit;
    this.webReady = webReady;
    const script = this.loadScript();
    if (script.length > 0) {
      const item: ScriptItem = { script: script, scriptRules: ['*'] };
      this.scripts.push(item);
    }
    this.clearStaged();
  }

  /** 读 rawfile 里的页面桥，换好口令；没有（没跑 npm run build:harmony 打包）就不注入，记一条 */
  private loadScript(): string {
    try {
      const bytes = this.context.resourceManager.getRawFileContentSync(PAGE_BRIDGE_FILE);
      const text = util.TextDecoder.create('utf-8').decodeToString(bytes);
      if (text.indexOf(NONCE_MARK) < 0) {
        hilog.error(DOMAIN, TAG, 'page bridge script has no nonce mark: not injected');
        return '';
      }
      return text.replace(NONCE_MARK, this.nonce);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'page bridge script missing (run npm run build:harmony): %{public}s', JSON.stringify(e));
      return '';
    }
  }

  private stagingDir(): string {
    return `${this.context.cacheDir}/page-files`;
  }

  /** 清掉上次留下的文件（App 起来时） */
  private clearStaged(): void {
    try {
      const dir = this.stagingDir();
      if (fs.accessSync(dir)) {
        fs.rmdirSync(dir);
      }
      fs.mkdirSync(dir);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'clear page files failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 页面桥报来一句（ergoPageHost.post）：口令对、来自浏览器的主框架才认，转给二狗的网页 */
  received(json: string): void {
    let message: PageMessage;
    try {
      message = JSON.parse(json) as PageMessage;
    } catch (e) {
      return;
    }
    if (message === null || message.nonce !== this.nonce) {
      hilog.warn(DOMAIN, TAG, 'page message refused: bad nonce');
      return;
    }
    let page = '';
    let caller = '';
    try {
      page = this.controller.getUrl();
      caller = this.controller.getLastJavascriptProxyCallingFrameUrl();
    } catch (e) {
      return;
    }
    if (withoutHash(page) !== withoutHash(caller)) {
      hilog.warn(DOMAIN, TAG, 'page message refused: not from the main frame');
      return;
    }
    if (message.type === 'chooser-field' && message.field !== undefined && typeof message.field.id === 'string') {
      this.chooserField = message.field.id;
      this.chooserFieldAt = Date.now();
    }
    this.emit(JSON.stringify(new PageForward(json)));
  }

  /** 二狗的网页调页面桥（fields、fill、mark、bubble、pick、selected、text、clearSelection、snapshot、click、refField、texts）：args 是参数的 JSON 数组（都是字符串） */
  run(op: string, args: string): Promise<string> {
    if (!PAGE_OPS.includes(op)) {
      return Promise.resolve('');
    }
    let list: string[] = [];
    try {
      const parsed = JSON.parse(args) as string[];
      if (Array.isArray(parsed)) {
        list = parsed.map((a: string) => String(a));
      }
    } catch (e) {
      return Promise.resolve('');
    }
    if (op === 'bubble') {
      this.bubbleOpen = list.length > 0 && !this.isBubbleNone(list[0]);
    }
    if (op === 'pick') {
      this.pickOpen = list.length > 0 && !this.isBubbleNone(list[0]);
    }
    return this.callPage(op, list);
  }

  private isBubbleNone(view: string): boolean {
    try {
      const parsed = JSON.parse(view) as BubbleKind;
      return parsed === null || typeof parsed.kind !== 'string' || parsed.kind === 'none';
    } catch (e) {
      return true;
    }
  }

  /**
   * 返回手势（Index.ets 的 onBackPress，浏览器显示着时先问这里）：气泡开着就告诉二狗的网页收起（它收起、交给页面桥 none），
   * 气泡没开、挑图片窗口开着（149 号票）就收窗口，回 true 表示接住了；都没开回 false，照原来的退网页历史
   */
  closeBubble(): boolean {
    if (this.bubbleOpen) {
      this.bubbleOpen = false;
      this.emit(JSON.stringify(new BubbleClose()));
      return true;
    }
    if (this.pickOpen) {
      this.pickOpen = false;
      this.emit(JSON.stringify(new PickClose()));
      return true;
    }
    return false;
  }

  /** 浏览器开始加载别的网页：新页面上没有气泡、挑图片窗口 */
  browserPageBegin(): void {
    this.bubbleOpen = false;
    this.pickOpen = false;
  }

  /** 二狗的网页重新加载、跳走了：没人管的气泡、挑图片窗口收起（新页面开场也会交一次 none） */
  hostPageBegin(): void {
    if (this.bubbleOpen) {
      this.bubbleOpen = false;
      this.callPage('bubble', [BUBBLE_NONE]);
    }
    if (this.pickOpen) {
      this.pickOpen = false;
      this.callPage('pick', [BUBBLE_NONE]);
    }
  }

  /** runJavaScript 调 window.__ergoPage.<op>(口令, ...参数)，回它回的字符串 */
  private callPage(op: string, args: string[]): Promise<string> {
    const params = [this.nonce].concat(args).map((a: string) => JSON.stringify(a)).join(',');
    const script = `(function(){var p=window.__ergoPage;return p&&typeof p.${op}==='function'?p.${op}(${params}):''})()`;
    try {
      return this.controller.runJavaScript(script)
        .then((result: string) => unquote(result))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'page %{public}s failed: %{public}s', op, JSON.stringify(err));
          return '';
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'page %{public}s failed: %{public}s', op, JSON.stringify(e));
      return Promise.resolve('');
    }
  }

  /** 二狗的网页把一个文件的一段（base64）交来：接在 App 缓存里这个文件的后面 */
  writeChunk(id: string, base64: string): Promise<string> {
    if (!FILE_ID.test(id)) {
      return Promise.resolve(outcome(false, 0, t('harmony.pageControl.badFileId')));
    }
    try {
      const bytes = new util.Base64Helper().decodeSync(base64);
      const total = (this.staged.get(id) ?? 0) + bytes.length;
      if (total > FILE_MAX_BYTES) {
        return Promise.resolve(outcome(false, 0, t('harmony.pageControl.tooBig')));
      }
      const file = fs.openSync(`${this.stagingDir()}/${id}.part`, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.APPEND);
      try {
        // 解出来的 Uint8Array 可能只占底下 ArrayBuffer 的一段：只写这一段
        fs.writeSync(file.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      } finally {
        fs.closeSync(file);
      }
      this.staged.set(id, total);
      return Promise.resolve(outcome(true, total, ''));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'write page file failed: %{public}s', JSON.stringify(e));
      return Promise.resolve(outcome(false, 0, t('harmony.pageControl.writeCacheFailed')));
    }
  }

  /**
   * 放掉预备好了没用上的文件（149 号票：候选一出来二狗的网页就把原图写进来，挑完、卡处理掉了、换了网页，没选的那些用不上）：
   * json 是文件编号的数组；不认得的编号跳过。回 {"ok", "count"（删了几个）}
   */
  discard(json: string): Promise<string> {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(json) as string[];
      if (Array.isArray(parsed)) {
        ids = parsed.filter((id: string) => typeof id === 'string' && FILE_ID.test(id));
      }
    } catch (e) {
      return Promise.resolve(outcome(false, 0, t('harmony.pageControl.badParams')));
    }
    let count = 0;
    for (const id of ids) {
      if (!this.staged.has(id)) {
        continue;
      }
      this.staged.delete(id);
      try {
        const path = `${this.stagingDir()}/${id}.part`;
        if (fs.accessSync(path)) {
          fs.unlinkSync(path);
        }
        count++;
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'discard page file failed: %{public}s', JSON.stringify(e));
      }
    }
    return Promise.resolve(outcome(true, count, ''));
  }

  /**
   * 交文件（二狗的网页在面板上确认之后）：target 是 chooser 时交给拦下的选文件对话框（FileSelectorResult.handleFileList，
   * 文件改成原来的名字放在 App 的缓存里）；是 field 时一段一段交给页面桥、由它塞进那个选文件的框（DataTransfer）
   */
  async deliver(json: string): Promise<string> {
    let delivery: Delivery;
    try {
      delivery = JSON.parse(json) as Delivery;
    } catch (e) {
      return outcome(false, 0, t('harmony.pageControl.badParams'));
    }
    if (delivery === null || !Array.isArray(delivery.files) || delivery.files.length === 0) {
      return outcome(false, 0, t('harmony.pageControl.noFiles'));
    }
    for (const f of delivery.files) {
      if (!FILE_ID.test(f.id) || !this.staged.has(f.id)) {
        return outcome(false, 0, t('harmony.pageControl.notStaged'));
      }
    }
    if (delivery.target === 'chooser') {
      return this.deliverToChooser(delivery.files);
    }
    if (delivery.target !== 'field' || typeof delivery.fieldId !== 'string') {
      return outcome(false, 0, t('harmony.pageControl.badParams'));
    }
    return this.deliverToField(delivery.fieldId, delivery.files);
  }

  private deliverToChooser(files: DeliveryFile[]): string {
    const result = this.chooser;
    if (result === undefined) {
      return outcome(false, 0, t('harmony.pageControl.chooserClosed'));
    }
    const paths: string[] = [];
    const take = this.chooserMultiple ? files : files.slice(0, 1);
    for (const f of take) {
      const dir = `${this.stagingDir()}/${f.id}`;
      const path = `${dir}/${safeFileName(f.name)}`;
      try {
        if (!fs.accessSync(dir)) {
          fs.mkdirSync(dir);
        }
        fs.renameSync(`${this.stagingDir()}/${f.id}.part`, path);
        this.staged.delete(f.id);
        paths.push(path);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'stage chooser file failed: %{public}s', JSON.stringify(e));
      }
    }
    this.chooser = undefined;
    // 交 App 沙箱里的路径（真机上要核对 ArkWeb 认不认；不认就换成 fileUri.getUriFromPath(path)）
    result.handleFileList(paths);
    hilog.info(DOMAIN, TAG, 'chooser got %{public}d files from ergo', paths.length);
    return outcome(paths.length > 0, paths.length, paths.length > 0 ? '' : t('harmony.pageControl.filesNotReady'));
  }

  private async deliverToField(fieldId: string, files: DeliveryFile[]): Promise<string> {
    const ids: string[] = [];
    for (const f of files) {
      const path = `${this.stagingDir()}/${f.id}.part`;
      const began = await this.callPage('fileBegin', [f.id, f.name, f.mime]);
      if (began.length === 0) {
        return outcome(false, 0, t('harmony.pageControl.bridgeGone'));
      }
      let file: fs.File | undefined = undefined;
      try {
        file = fs.openSync(path, fs.OpenMode.READ_ONLY);
        const size = fs.statSync(path).size;
        const helper = new util.Base64Helper();
        let offset = 0;
        while (offset < size) {
          const length = Math.min(PAGE_CHUNK_BYTES, size - offset);
          const buffer = new ArrayBuffer(length);
          const read = fs.readSync(file.fd, buffer, { offset: offset, length: length });
          if (read <= 0) {
            break;
          }
          const chunk = helper.encodeToStringSync(new Uint8Array(buffer, 0, read));
          await this.callPage('fileChunk', [f.id, chunk]);
          offset += read;
        }
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'read page file failed: %{public}s', JSON.stringify(e));
        return outcome(false, 0, t('harmony.common.readCacheFailed'));
      } finally {
        try {
          if (file !== undefined) {
            fs.closeSync(file);
          }
          fs.unlinkSync(path);
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'remove page file failed: %{public}s', JSON.stringify(e));
        }
        this.staged.delete(f.id);
      }
      ids.push(f.id);
    }
    const result = await this.callPage('attachFiles', [fieldId, JSON.stringify(ids)]);
    return result.length > 0 ? result : outcome(false, 0, t('harmony.pageControl.bridgeGone'));
  }

  /**
   * 网页弹出选文件对话框（onShowFileSelector）：二狗的网页在、页面桥在时拦下来，问用户"让二狗选 / 自己选"（二狗的网页画面板），
   * 返回 true；不然照系统默认的对话框（返回 false）
   */
  intercept(event: OnShowFileSelectorEvent): boolean {
    if (!this.webReady() || this.scripts.length === 0) {
      return false;
    }
    // 上一个还没回的先当取消
    this.cancelChooser();
    this.chooser = event.result;
    const param = event.fileSelector;
    let accept: string[] = [];
    try {
      accept = param.getAcceptType();
    } catch (e) {
      accept = [];
    }
    this.chooserMultiple = param.getMode() === FileSelectorMode.FileOpenMultipleMode;
    this.chooserImages = accept.length > 0 && accept.every((a: string) => a.startsWith('image/') || a.startsWith('.jpg') ||
      a.startsWith('.jpeg') || a.startsWith('.png') || a.startsWith('.gif') || a.startsWith('.webp') || a.startsWith('.heic'));
    // 页面桥 2 秒内说过是哪个框的才算（网站的脚本调 input.click() 的那一下）
    const fieldId = Date.now() - this.chooserFieldAt < 2000 ? this.chooserField : '';
    this.emit(JSON.stringify(new ChooserForward(accept, this.chooserMultiple, param.isCapture(), fieldId)));
    return true;
  }

  /** 面板上的选择：system 自己选（系统的选择器）、cancel 取消 */
  choose(choice: string): Promise<string> {
    if (this.chooser === undefined) {
      return Promise.resolve(outcome(false, 0, t('harmony.pageControl.chooserClosed')));
    }
    if (choice === 'cancel') {
      this.cancelChooser();
      return Promise.resolve(outcome(true, 0, ''));
    }
    if (choice !== 'system') {
      return Promise.resolve(outcome(false, 0, t('harmony.pageControl.unknownChoice')));
    }
    return this.pickBySystem();
  }

  private cancelChooser(): void {
    const result = this.chooser;
    this.chooser = undefined;
    if (result !== undefined) {
      try {
        result.handleFileList([]);
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'cancel chooser failed: %{public}s', JSON.stringify(e));
      }
    }
  }

  /** 自己选：要图片的用图库选择器，别的用文件选择器；选好交给对话框，取消了也告诉它 */
  private async pickBySystem(): Promise<string> {
    const max = this.chooserMultiple ? 50 : 1;
    let uris: string[] = [];
    try {
      if (this.chooserImages) {
        const options = new photoAccessHelper.PhotoSelectOptions();
        options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
        options.maxSelectNumber = max;
        const selected = await new photoAccessHelper.PhotoViewPicker().select(options);
        uris = selected.photoUris;
      } else {
        const options = new picker.DocumentSelectOptions();
        options.maxSelectNumber = max;
        uris = await new picker.DocumentViewPicker(this.context).select(options);
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'system picker failed: %{public}s', JSON.stringify(e));
    }
    const result = this.chooser;
    this.chooser = undefined;
    if (result !== undefined) {
      result.handleFileList(uris);
    }
    return outcome(uris.length > 0, uris.length, uris.length > 0 ? '' : t('harmony.pageControl.nothingPicked'));
  }
}
