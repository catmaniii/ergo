// 选本机文件夹的框（463 号票从 app/authorized-folders.ts 拆出来，几处共用）：选的是守护进程那台电脑上的文件夹。
// 这里管框的状态和动作，不碰 DOM（测试把守护进程换成假的）；画法和外面那层框在 ui/folder-picker.tsx：
// - open 先列常用位置和各个盘；browse 点进一个文件夹列它的子文件夹；up 回上一级（盘的根回到常用位置）；setDraft 改贴的完整路径；
// - choose 把当前文件夹（chooseDraft 是贴的完整路径）交给调用方给的 deliver——马上授权、填进表单、还是校验备份目录，调用方定：
//   成了框关掉；deliver 抛错的框不关、写原因；
// - 框关掉之后才回来的结果不再打开它；点得快时只认最后一次列的结果。
import type { FolderBrowseView, FolderEntry } from "../state/index.ts";

/** 要的守护进程接口（DaemonHttp 里的这一个；不引 daemon-http.ts，测试在 Node 里跑、没有 DOM 的 fetch 类型） */
export interface FolderPickerHttp {
  browseFolders(folder?: string): Promise<FolderBrowseView>;
}

/** 开着的框 */
export interface FolderPickerState {
  /** 常用位置和各个盘（还没取到是 undefined） */
  roots?: { places: readonly FolderEntry[]; drives: readonly FolderEntry[] } | undefined;
  /** 当前文件夹：子文件夹，或者读不了的原因；还没点进任何文件夹是 undefined（列常用位置和各个盘） */
  current?: Exclude<FolderBrowseView, { kind: "roots" }> | undefined;
  /** 在列 */
  loading: boolean;
  /** 贴的完整路径 */
  draft: string;
  /** 选中的交给调用方了，还没做完 */
  busy: boolean;
  error?: string | undefined;
}

/** 选中一个文件夹以后做什么（调用方给）：抛错的话框不关 */
export type ChooseFolder = (path: string) => Promise<void> | void;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class FolderPicker {
  /** 关着是 undefined */
  private current: FolderPickerState | undefined;
  private readonly listeners = new Set<() => void>();
  /** 第几次打开框、第几次列（只认最新的那次的结果） */
  private openSeq = 0;
  private browseSeq = 0;

  private readonly http: FolderPickerHttp;

  constructor(http: FolderPickerHttp) {
    this.http = http;
  }

  /** 现在的样子（React 的 useSyncExternalStore 用）；关着是 undefined */
  readonly state = (): FolderPickerState | undefined => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 打开：先列常用位置和各个盘 */
  async open(): Promise<void> {
    const seq = ++this.openSeq;
    this.set({ loading: true, draft: "", busy: false });
    try {
      const view = await this.http.browseFolders();
      if (view.kind === "roots") this.patch(seq, { roots: { places: view.places, drives: view.drives }, loading: false });
    } catch (err) {
      this.patch(seq, { loading: false, error: messageOf(err) });
    }
  }

  close(): void {
    this.openSeq += 1;
    this.set(undefined);
  }

  /** 点进一个文件夹 */
  async browse(path: string): Promise<void> {
    const seq = this.openSeq;
    const call = ++this.browseSeq;
    this.patch(seq, { loading: true, error: undefined });
    try {
      const view = await this.http.browseFolders(path);
      if (call !== this.browseSeq) return;
      this.patch(seq, view.kind === "roots" ? { roots: { places: view.places, drives: view.drives }, current: undefined, loading: false } : { current: view, loading: false });
    } catch (err) {
      if (call === this.browseSeq) this.patch(seq, { loading: false, error: messageOf(err) });
    }
  }

  /** 上一级：盘的根（没有上一级）回到常用位置和各个盘 */
  async up(): Promise<void> {
    const parent = this.current?.current?.parent;
    if (parent !== undefined) return this.browse(parent);
    this.browseSeq += 1;
    this.patch(this.openSeq, { current: undefined, loading: false, error: undefined });
  }

  /** 改贴的完整路径 */
  setDraft(draft: string): void {
    this.patch(this.openSeq, { draft, error: undefined });
  }

  /** 选这个文件夹：交给调用方的 deliver，做完了框关掉；deliver 抛错的框不关、message 写在框里 */
  async choose(path: string, deliver: ChooseFolder): Promise<void> {
    const seq = this.openSeq;
    if (!this.current || this.current.busy) return;
    this.patch(seq, { busy: true, error: undefined });
    try {
      await deliver(path);
    } catch (err) {
      this.patch(seq, { busy: false, error: messageOf(err) });
      return;
    }
    if (seq === this.openSeq) this.close();
  }

  /** 贴的完整路径按"用这个路径"；空的不交 */
  async chooseDraft(deliver: ChooseFolder): Promise<void> {
    const path = this.current?.draft.trim() ?? "";
    if (path !== "") await this.choose(path, deliver);
  }

  private patch(seq: number, patch: Partial<FolderPickerState>): void {
    if (!this.current || seq !== this.openSeq) return;
    this.set({ ...this.current, ...patch });
  }

  private set(next: FolderPickerState | undefined): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
