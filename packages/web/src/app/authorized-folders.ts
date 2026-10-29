// 设置 · 浏览与填框里的"授权的文件夹"（138 号票，页面在 pages/more/AuthorizedFolders.tsx）：守护进程那台电脑上的一份文件夹，
// 秘书和"浏览"里的二狗共用（在秘书的聊天里授权的也是这一份）。这里管这一节的状态和动作，不碰 DOM（测试把守护进程换成假的）：
// - 列表：refresh 取一次（页面打开时、页面重新显示时——切回来、窗口重新拿到焦点——各取一次，聊天里刚授权的回来就能看到）；
// - 每行的叉：remove 马上拿掉并存好（PATCH remove），没有确认框；失败的原因写在这一节里；
// - "添加文件夹"的框：openPicker 先列常用位置和各个盘，browse 点进一个文件夹列它的子文件夹，up 回上一级（盘的根回到常用位置）；
//   authorize 把当前文件夹（或贴的完整路径 authorizeDraft）马上加进来、存好、框关掉；失败的框不关、写原因。
//   框关掉之后才回来的结果不再打开它；点得快时只认最后一次列的结果。
import type { FolderBrowseView, FolderEntry, LocalFolder, LocalFoldersChangeBody, LocalFoldersView } from "../state/index.ts";

/** 这一节要的守护进程接口（DaemonHttp 里的这三个；不引 daemon-http.ts，测试在 Node 里跑、没有 DOM 的 fetch 类型） */
export interface AuthorizedFoldersHttp {
  localFolders(): Promise<LocalFoldersView>;
  changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView>;
  browseFolders(folder?: string): Promise<FolderBrowseView>;
}

/** 选文件夹的框 */
export interface FolderPickerState {
  /** 常用位置和各个盘（还没取到是 undefined） */
  roots?: { places: readonly FolderEntry[]; drives: readonly FolderEntry[] } | undefined;
  /** 当前文件夹：子文件夹，或者读不了的原因；还没点进任何文件夹是 undefined（列常用位置和各个盘） */
  current?: Exclude<FolderBrowseView, { kind: "roots" }> | undefined;
  /** 在列 */
  loading: boolean;
  /** 贴的完整路径 */
  draft: string;
  /** 在授权（加进来、存） */
  busy: boolean;
  error?: string | undefined;
}

export interface AuthorizedFoldersState {
  /** 授权的文件夹（还没取到是 undefined） */
  folders?: readonly LocalFolder[] | undefined;
  /** 在存（拿掉一个） */
  saving: boolean;
  /** 取列表、拿掉失败的原因 */
  error?: string | undefined;
  /** 开着的选文件夹的框 */
  picker?: FolderPickerState | undefined;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class AuthorizedFolders {
  private current: AuthorizedFoldersState = { saving: false };
  private readonly listeners = new Set<() => void>();
  /** 第几次打开框、第几次列（只认最新的那次的结果） */
  private pickerSeq = 0;
  private browseSeq = 0;

  private readonly http: AuthorizedFoldersHttp;

  constructor(http: AuthorizedFoldersHttp) {
    this.http = http;
  }

  /** 现在的样子（React 的 useSyncExternalStore 用） */
  readonly state = (): AuthorizedFoldersState => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 取一次列表 */
  async refresh(): Promise<void> {
    try {
      const view = await this.http.localFolders();
      this.update({ folders: view.folders, error: undefined });
    } catch (err) {
      this.update({ error: messageOf(err) });
    }
  }

  /** 每行的叉：马上拿掉并存好 */
  async remove(path: string): Promise<void> {
    await this.save({ remove: [path] });
  }

  /** 打开"添加文件夹"的框：先列常用位置和各个盘 */
  async openPicker(): Promise<void> {
    const seq = ++this.pickerSeq;
    this.update({ picker: { loading: true, draft: "", busy: false } });
    try {
      const view = await this.http.browseFolders();
      if (view.kind === "roots") this.updatePicker(seq, { roots: { places: view.places, drives: view.drives }, loading: false });
    } catch (err) {
      this.updatePicker(seq, { loading: false, error: messageOf(err) });
    }
  }

  closePicker(): void {
    this.pickerSeq += 1;
    this.update({ picker: undefined });
  }

  /** 点进一个文件夹 */
  async browse(path: string): Promise<void> {
    const seq = this.pickerSeq;
    const call = ++this.browseSeq;
    this.updatePicker(seq, { loading: true, error: undefined });
    try {
      const view = await this.http.browseFolders(path);
      if (call !== this.browseSeq) return;
      this.updatePicker(seq, view.kind === "roots" ? { roots: { places: view.places, drives: view.drives }, current: undefined, loading: false } : { current: view, loading: false });
    } catch (err) {
      if (call === this.browseSeq) this.updatePicker(seq, { loading: false, error: messageOf(err) });
    }
  }

  /** 上一级：盘的根（没有上一级）回到常用位置和各个盘 */
  async up(): Promise<void> {
    const parent = this.current.picker?.current?.parent;
    if (parent !== undefined) return this.browse(parent);
    this.browseSeq += 1;
    this.updatePicker(this.pickerSeq, { current: undefined, loading: false, error: undefined });
  }

  /** 改贴的完整路径 */
  setDraft(draft: string): void {
    this.updatePicker(this.pickerSeq, { draft, error: undefined });
  }

  /** 授权这个文件夹：马上加进来、存好，框关掉；失败的框不关、写原因 */
  async authorize(path: string): Promise<void> {
    const seq = this.pickerSeq;
    this.updatePicker(seq, { busy: true, error: undefined });
    try {
      const view = await this.http.changeLocalFolders({ add: [path] });
      this.update({ folders: view.folders, error: undefined, ...(seq === this.pickerSeq ? { picker: undefined } : {}) });
      if (seq === this.pickerSeq) this.pickerSeq += 1;
    } catch (err) {
      this.updatePicker(seq, { busy: false, error: messageOf(err) });
    }
  }

  /** 贴的完整路径按"授权" */
  async authorizeDraft(): Promise<void> {
    const path = this.current.picker?.draft.trim() ?? "";
    if (path !== "") await this.authorize(path);
  }

  private async save(change: LocalFoldersChangeBody): Promise<void> {
    this.update({ saving: true, error: undefined });
    let view: LocalFoldersView;
    try {
      view = await this.http.changeLocalFolders(change);
    } catch (err) {
      this.update({ saving: false, error: messageOf(err) });
      return;
    }
    this.update({ saving: false, folders: view.folders });
  }

  private updatePicker(seq: number, patch: Partial<FolderPickerState>): void {
    const picker = this.current.picker;
    if (!picker || seq !== this.pickerSeq) return;
    this.update({ picker: { ...picker, ...patch } });
  }

  private update(patch: Partial<AuthorizedFoldersState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}
