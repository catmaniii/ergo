// 鸿蒙 App "浏览"页签的原生浏览器里，能渲染的文件用二狗的渲染打开（160 号票）。原生浏览器是 App 叠在网页上面的另一个 ArkWeb，
// 二狗的网页画不到它上面，所以渲染层画在"浏览"页的内容区里、把原生浏览器藏起来（pages/BrowsePage.tsx）：
// - App 报来的文件（native-browser.ts 的 document）：浏览器里加载完的一页（带 document.contentType——服务端回 text/markdown、text/plain、
//   JSON……时浏览器显示原始文本），或者拦下的一个下载（服务端一律当下载发的 .md 这类，App 先存进自己的缓存，带着服务端给的文件名）；
//   按 state/file-view.ts 的 fileRenderOf 定渲不渲染：能渲染的出渲染层，拦下的下载不能渲染就照常保存（交回 App 弹"保存到"）；
// - 浏览器换了页（地址变了，只差 # 的不算），渲染层收起；拦下的下载收起时、换成别的时，App 缓存里那份放掉；
// - 取内容、下载、用系统浏览器打开都交给 App（browserDoc）；"看原文"在渲染层里切（ui/file-view.tsx），不用露出原生浏览器；
// - 返回手势（原生浏览器藏着，App 交给网页的返回栈）：页面上的文件浏览器能后退就后退（换了页渲染层自己收）、不能就收起露出原文；
//   拦下的下载收起。
// 整个页面一份（page-browse.ts 开场接上），切走再回来照旧。不碰页面的全局变量，测试在 Node 里跑（test/app/browse-files.test.ts）。
import { fileNameOf, fileRenderOf, type FileRenderKind, type FileTextResult } from "../../state/index.ts";
import { nativeFileText } from "../../app/file-source.ts";
import { BLANK_BROWSER, type BrowserDoc, type BrowserState, type NativeBrowserEvent, type NativeDocControl } from "../../app/native-browser.ts";

/** 渲染层看着的文件：App 报的那一个（文件名没给的取地址最后一段）、怎么画、第几次（刷新加一，渲染层据此重新取） */
export interface BrowseFileView extends BrowserDoc {
  readonly kind: FileRenderKind;
  readonly seq: number;
}

/** 去掉 # 后面的 */
function withoutHash(url: string): string {
  const at = url.indexOf("#");
  return at >= 0 ? url.slice(0, at) : url;
}

export class BrowseFiles {
  private readonly docs: NativeDocControl;
  /** 浏览器后退一页 */
  private readonly goBack: () => void;
  private current: BrowseFileView | undefined;
  private seq = 0;
  private state: BrowserState = BLANK_BROWSER;
  /** 拦下的下载报来时浏览器在哪一页（换了页就收起） */
  private downloadFrom = "";
  private readonly listeners = new Set<() => void>();

  constructor(options: { docs: NativeDocControl; back(): void }) {
    this.docs = options.docs;
    this.goBack = options.back;
  }

  readonly snapshot = (): BrowseFileView | undefined => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** App 推过来的：浏览器的样子（换了页收起）、报来的文件 */
  handle(event: NativeBrowserEvent): void {
    if (event.type === "state") return this.browserChanged(event.state);
    if (event.type === "document") this.document(event.doc);
  }

  /** 浏览器现在的样子（开场接上时也给一次） */
  browserChanged(state: BrowserState): void {
    this.state = state;
    const now = this.current;
    if (!now) return;
    const away = now.via === "page" ? withoutHash(state.url) !== withoutHash(now.url) : state.url !== this.downloadFrom;
    if (away) this.show(undefined);
  }

  private document(doc: BrowserDoc): void {
    const kind = fileRenderOf({ url: doc.url, mime: doc.mime, name: doc.name || undefined });
    if (doc.via === "download" && !kind) {
      // 不能渲染的下载：照常保存
      this.docs.save(doc.id);
      return;
    }
    if (doc.via === "download") this.downloadFrom = this.state.url;
    this.show(kind ? { ...doc, name: doc.name || fileNameOf(doc.url), kind, seq: ++this.seq } : undefined);
  }

  /** 换成 next（没有是收起）；换掉的是拦下的下载就放掉 App 缓存里那份 */
  private show(next: BrowseFileView | undefined): void {
    const old = this.current;
    if (old === next) return;
    if (old?.via === "download" && old.id !== next?.id) this.docs.drop(old.id);
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  /** 取内容（经 App），换成和网页一样的结果；类型用 App 报的 */
  async load(view: BrowseFileView): Promise<FileTextResult> {
    return nativeFileText(await this.docs.source(view.id), view.mime);
  }

  /** 关闭渲染层：页面上的露出原生网页显示的原文，拦下的放掉 */
  close(): void {
    this.show(undefined);
  }

  /** 返回手势：页面上的文件浏览器能后退就后退，不能就收起；拦下的下载收起 */
  back(): void {
    const now = this.current;
    if (!now) return;
    if (now.via === "page" && this.state.canGoBack) this.goBack();
    else this.close();
  }

  /** 刷新：再取一次 */
  reload(): void {
    const now = this.current;
    if (now) this.show({ ...now, seq: ++this.seq });
  }

  /** 下载（页面上的经浏览器重新下载，拦下的弹"保存到"） */
  save(): void {
    if (this.current) this.docs.save(this.current.id);
  }

  /** 用系统浏览器打开 */
  outside(): void {
    if (this.current) this.docs.outside(this.current.id);
  }
}
