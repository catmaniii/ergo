// 165 号票：⋮ 菜单里的"在页面里查找"在网页这一侧的状态。查找栏画在"浏览"顶栏下面（pages/BrowsePage.tsx，浏览器跟着变矮、照样看得见），
// 网页里的高亮、第几个由 App 用 ArkWeb 自带的页内查找做（browserTool find / findNext / findClear，结果推 find）。
// - 打字停一下（FIND_DEBOUNCE_MS）才交给 App 查，连着打只查最后一次；字清空了马上清掉高亮；
// - 回车：还没交出去的马上查，查过了就是下一个；上一个、下一个；
// - 关掉（×、返回手势）清掉高亮；换了网页收起（新的一页上的高亮、计数都不算数了）；再打开接着上次的字查；
// - 开着没开告诉 App（findBar）：返回手势先收起查找栏（App 推 find-close），再退网页历史。
// 不碰浏览器的全局变量（定时由参数给），测试在 Node 里跑；页面上那一份在 page-browse.ts。
import type { FindResult } from "../../state/index.ts";
import type { NativeBrowserEvent, NativeToolControl } from "../../app/native-browser.ts";

/** 打字停多久才查（毫秒） */
export const FIND_DEBOUNCE_MS = 250;

export interface BrowseFindView {
  readonly open: boolean;
  readonly query: string;
  /** App 推回的结果（这一次的字查出来的；还没回是没有） */
  readonly result?: FindResult;
}

export interface BrowseFindDeps {
  tools: Pick<NativeToolControl, "find" | "findNext" | "findClear" | "findBar">;
  /** 过 ms 毫秒做 fn；返回取消 */
  later(fn: () => void, ms: number): () => void;
}

export class BrowseFind {
  private readonly deps: BrowseFindDeps;
  private view: BrowseFindView = { open: false, query: "" };
  private readonly listeners = new Set<() => void>();
  /** 等着交出去的那一次（取消用）；没有是 undefined */
  private pending: (() => void) | undefined;
  /** 这一次的字交给 App 查过了（回车就是下一个） */
  private searched = false;

  constructor(deps: BrowseFindDeps) {
    this.deps = deps;
  }

  readonly snapshot = (): BrowseFindView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private set(next: BrowseFindView): void {
    this.view = next;
    for (const listener of this.listeners) listener();
  }

  private cancel(): void {
    this.pending?.();
    this.pending = undefined;
  }

  /** 交给 App 查（现在的字） */
  private search(): void {
    this.cancel();
    this.searched = true;
    this.deps.tools.find(this.view.query);
  }

  private schedule(): void {
    this.cancel();
    this.searched = false;
    this.pending = this.deps.later(() => {
      this.pending = undefined;
      this.search();
    }, FIND_DEBOUNCE_MS);
  }

  /** 打开查找栏；上次的字还在就接着查 */
  open(): void {
    if (this.view.open) return;
    this.deps.tools.findBar(true);
    this.set({ open: true, query: this.view.query });
    if (this.view.query.trim() !== "") this.schedule();
  }

  /** 关掉：清掉高亮，等着的不查了 */
  close(): void {
    if (!this.view.open) return;
    this.cancel();
    this.searched = false;
    this.deps.tools.findClear();
    this.deps.tools.findBar(false);
    this.set({ open: false, query: this.view.query });
  }

  setQuery(query: string): void {
    if (query === this.view.query && this.view.open) return;
    this.set({ open: this.view.open, query });
    if (query.trim() === "") {
      this.cancel();
      this.searched = false;
      this.deps.tools.findClear();
      return;
    }
    this.schedule();
  }

  /** 回车：还没交出去的马上查，查过了就是下一个 */
  submit(): void {
    if (this.view.query.trim() === "") return;
    if (this.searched) this.deps.tools.findNext(true);
    else this.search();
  }

  next(): void {
    if (this.view.query.trim() !== "" && this.searched) this.deps.tools.findNext(true);
  }

  prev(): void {
    if (this.view.query.trim() !== "" && this.searched) this.deps.tools.findNext(false);
  }

  /** App 推的：查找结果（开着才认）；查找栏开着时按了返回（收起） */
  handle(event: NativeBrowserEvent): void {
    if (event.type === "find-close") return this.close();
    if (event.type !== "find" || !this.view.open || this.view.query.trim() === "") return;
    this.set({ ...this.view, result: event.result });
  }

  /** 换了网页：收起 */
  pageChanged(): void {
    this.close();
  }
}
