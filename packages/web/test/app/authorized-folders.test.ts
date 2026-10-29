// 设置 · 浏览与填框里的"授权的文件夹"（138 号票，app/authorized-folders.ts）：守护进程换成假的。查：
// - 取列表；每行的叉点了马上拿掉并存好（PATCH remove），失败的在这一节里写原因；页面重新显示时再取一次（聊天里刚授权的能看到）；
// - "添加文件夹"的框：先列常用位置和各个盘，点进去列子文件夹、"上一级"回去（盘的根回到常用位置），读不了的写原因；
//   "授权这个文件夹"、贴完整路径按"授权"都是马上加进来、存好、框关掉；失败的框不关、写原因；已授权的认得出来（不分大小写、尾斜杠）。
import { describe, expect, test } from "vitest";
import { AuthorizedFolders } from "../../src/app/authorized-folders.ts";
import { type FolderBrowseView, isAuthorizedFolder, type LocalFoldersChangeBody, type LocalFoldersView } from "../../src/state/index.ts";

const PICTURES = "C:\\Users\\me\\Pictures";
const DOWNLOADS = "C:\\Users\\me\\Downloads";
const TRIP = "C:\\Users\\me\\Pictures\\2026 杭州";

/** 假的守护进程：一份授权的文件夹、一棵文件夹树 */
class FakeDaemon {
  folders: string[] = [];
  missing = new Set<string>();
  changes: LocalFoldersChangeBody[] = [];
  browsed: Array<string | undefined> = [];
  fail: string | undefined;
  localFolders(): Promise<LocalFoldersView> {
    return Promise.resolve({ folders: this.folders.map((path) => ({ path, exists: !this.missing.has(path) })) });
  }
  changeLocalFolders(change: LocalFoldersChangeBody): Promise<LocalFoldersView> {
    this.changes.push(change);
    if (this.fail) return Promise.reject(new Error(this.fail));
    this.folders = [...this.folders.filter((f) => !(change.remove ?? []).includes(f)), ...(change.add ?? []).filter((f) => !this.folders.includes(f))];
    return this.localFolders();
  }
  browseFolders(folder?: string): Promise<FolderBrowseView> {
    this.browsed.push(folder);
    if (folder === undefined) return Promise.resolve({ kind: "roots", places: [{ name: "图片", path: PICTURES }], drives: [{ name: "C:", path: "C:\\" }] });
    if (folder === PICTURES) return Promise.resolve({ kind: "folder", path: PICTURES, parent: "C:\\Users\\me", folders: [{ name: "2026 杭州", path: TRIP }], total: 1 });
    if (folder === "C:\\") return Promise.resolve({ kind: "folder", path: "C:\\", folders: [{ name: "Users", path: "C:\\Users" }], total: 1 });
    return Promise.resolve({ kind: "unreadable", path: folder, parent: "C:\\", reason: "没有权限读这个文件夹" });
  }
}

function setup() {
  const daemon = new FakeDaemon();
  const folders = new AuthorizedFolders(daemon);
  let updates = 0;
  folders.subscribe(() => updates++);
  return { daemon, folders, updates: () => updates };
}

describe("列表、叉、重新取", () => {
  test("取到列表（找不到了的标着）；有变化就通知", async () => {
    const { daemon, folders, updates } = setup();
    expect(folders.state().folders).toBeUndefined();
    daemon.folders = [PICTURES, DOWNLOADS];
    daemon.missing.add(DOWNLOADS);
    await folders.refresh();
    expect(folders.state().folders).toEqual([
      { path: PICTURES, exists: true },
      { path: DOWNLOADS, exists: false },
    ]);
    expect(updates()).toBeGreaterThan(0);
  });

  test("点叉马上拿掉并存好；失败的写原因，列表不变", async () => {
    const { daemon, folders } = setup();
    daemon.folders = [PICTURES, DOWNLOADS];
    await folders.refresh();
    await folders.remove(DOWNLOADS);
    expect(daemon.changes).toEqual([{ remove: [DOWNLOADS] }]);
    expect(folders.state()).toMatchObject({ folders: [{ path: PICTURES, exists: true }], saving: false });
    expect(folders.state().error).toBeUndefined();

    daemon.fail = "守护进程连不上";
    await folders.remove(PICTURES);
    expect(folders.state()).toMatchObject({ folders: [{ path: PICTURES, exists: true }], saving: false, error: "守护进程连不上" });
  });

  test("页面重新显示时再取一次：聊天里刚授权的能看到", async () => {
    const { daemon, folders } = setup();
    await folders.refresh();
    expect(folders.state().folders).toEqual([]);
    daemon.folders = [PICTURES];
    await folders.refresh();
    expect(folders.state().folders).toEqual([{ path: PICTURES, exists: true }]);
  });
});

describe("添加文件夹的框", () => {
  test("先列常用位置和各个盘；点进去列子文件夹，上一级回去，盘的根再上一级回到常用位置；读不了的写原因", async () => {
    const { daemon, folders } = setup();
    await folders.openPicker();
    expect(daemon.browsed).toEqual([undefined]);
    expect(folders.state().picker).toMatchObject({ roots: { places: [{ name: "图片", path: PICTURES }], drives: [{ name: "C:", path: "C:\\" }] }, loading: false });
    expect(folders.state().picker?.current).toBeUndefined();

    await folders.browse(PICTURES);
    expect(folders.state().picker?.current).toMatchObject({ kind: "folder", path: PICTURES, folders: [{ name: "2026 杭州" }] });
    await folders.browse("C:\\");
    await folders.up();
    expect(folders.state().picker?.current).toBeUndefined();

    await folders.browse("C:\\System");
    expect(folders.state().picker?.current).toEqual({ kind: "unreadable", path: "C:\\System", parent: "C:\\", reason: "没有权限读这个文件夹" });
    await folders.up();
    expect(folders.state().picker?.current).toMatchObject({ kind: "folder", path: "C:\\" });
  });

  test("授权这个文件夹：马上加进来、存好、框关掉", async () => {
    const { daemon, folders } = setup();
    await folders.refresh();
    await folders.openPicker();
    await folders.browse(PICTURES);
    await folders.authorize(PICTURES);
    expect(daemon.changes).toEqual([{ add: [PICTURES] }]);
    expect(folders.state().folders).toEqual([{ path: PICTURES, exists: true }]);
    expect(folders.state().picker).toBeUndefined();
  });

  test("贴完整路径按授权；空的不发；失败的框不关、写原因", async () => {
    const { daemon, folders } = setup();
    await folders.refresh();
    await folders.openPicker();
    folders.setDraft("   ");
    await folders.authorizeDraft();
    expect(daemon.changes).toEqual([]);

    daemon.fail = "这台电脑上没有这个文件夹：D:\\没有";
    folders.setDraft(" D:\\没有 ");
    await folders.authorizeDraft();
    expect(daemon.changes).toEqual([{ add: ["D:\\没有"] }]);
    expect(folders.state().picker).toMatchObject({ draft: " D:\\没有 ", busy: false, error: "这台电脑上没有这个文件夹：D:\\没有" });

    daemon.fail = undefined;
    folders.setDraft(TRIP);
    expect(folders.state().picker?.error).toBeUndefined();
    await folders.authorizeDraft();
    expect(folders.state().folders).toEqual([{ path: TRIP, exists: true }]);
    expect(folders.state().picker).toBeUndefined();
  });

  test("关掉框之后才回来的结果不再打开它", async () => {
    const { folders } = setup();
    const opening = folders.openPicker();
    folders.closePicker();
    await opening;
    expect(folders.state().picker).toBeUndefined();
  });

  test("已授权的认得出来：不分大小写、不管末尾的斜杠", () => {
    const list = [{ path: PICTURES, exists: true }];
    expect(isAuthorizedFolder(list, "c:\\users\\me\\pictures\\")).toBe(true);
    expect(isAuthorizedFolder(list, "C:/Users/me/Pictures")).toBe(true);
    expect(isAuthorizedFolder(list, TRIP)).toBe(false);
    expect(isAuthorizedFolder(undefined, PICTURES)).toBe(false);
  });
});
