// 设置 · 目录授权（页面在 pages/more/AuthorizedFolders.tsx）：守护进程那台电脑上的一份文件夹，
// 秘书和"浏览"里的二狗共用（在秘书的聊天里授权的也是这一份）。这里管这份列表的状态和动作，不碰 DOM（测试把守护进程换成假的）：
// - 列表：refresh 取一次（页面打开时、页面重新显示时——切回来、窗口重新拿到焦点——各取一次，聊天里刚授权的回来就能看到）；
// - 每行的叉：remove 马上拿掉并存好（PATCH remove），没有确认框；失败的原因写在这一节里；
// - add 把选文件夹的框里选中的加进来、存好；失败的抛出去（框不关、写原因）。选文件夹的框本身是几处共用的那一个（app/folder-picker.ts）。
import type { LocalFolder, LocalFoldersChangeBody, LocalFoldersView } from "../state/index.ts";

/** 这一节要的守护进程接口（DaemonHttp 里的这两个；不引 daemon-http.ts，测试在 Node 里跑、没有 DOM 的 fetch 类型） */
export interface AuthorizedFoldersHttp {
  localFolders(): Promise<LocalFoldersView>;
  changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView>;
}

export interface AuthorizedFoldersState {
  /** 授权的文件夹（还没取到是 undefined） */
  folders?: readonly LocalFolder[] | undefined;
  /** 在存（拿掉一个） */
  saving: boolean;
  /** 取列表、拿掉失败的原因 */
  error?: string | undefined;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class AuthorizedFolders {
  private current: AuthorizedFoldersState = { saving: false };
  private readonly listeners = new Set<() => void>();

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
    this.update({ saving: true, error: undefined });
    let view: LocalFoldersView;
    try {
      view = await this.http.changeLocalFolders({ remove: [path] });
    } catch (err) {
      this.update({ saving: false, error: messageOf(err) });
      return;
    }
    this.update({ saving: false, folders: view.folders });
  }

  /** 授权一个文件夹：马上加进来、存好；失败的抛出去（选文件夹的框写原因） */
  async add(path: string): Promise<void> {
    const view = await this.http.changeLocalFolders({ add: [path] });
    this.update({ folders: view.folders, error: undefined });
  }

  private update(patch: Partial<AuthorizedFoldersState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}
