// 选本机文件夹的框（app/folder-picker.ts，463 号票从授权的文件夹里拆出来、几处共用）：守护进程换成假的。查：
// - 打开先列常用位置和各个盘，点进去列子文件夹，"上一级"回去（盘的根回到常用位置），读不了的写原因；
// - 选中（当前文件夹、贴的完整路径）交给调用方：做完了框关掉，调用方抛错的框不关、写原因；贴的是空的不交；
// - 点得快时只认最后一次列的结果；框关了以后才回来的结果不再打开它（打开时的、点进去的、选中后做完的都一样）。
import { describe, expect, test } from "vitest";
import { FolderPicker } from "../../src/app/folder-picker.ts";
import type { FolderBrowseView } from "../../src/state/index.ts";

const PICTURES = "C:\\Users\\me\\Pictures";
const TRIP = "C:\\Users\\me\\Pictures\\2026 杭州";

/** 假的守护进程：一棵文件夹树 */
function tree(folder?: string): FolderBrowseView {
  if (folder === undefined) return { kind: "roots", places: [{ name: "图片", path: PICTURES }], drives: [{ name: "C:", path: "C:\\" }] };
  if (folder === PICTURES) return { kind: "folder", path: PICTURES, parent: "C:\\Users\\me", folders: [{ name: "2026 杭州", path: TRIP }], total: 1 };
  if (folder === TRIP) return { kind: "folder", path: TRIP, parent: PICTURES, folders: [], total: 0 };
  if (folder === "C:\\") return { kind: "folder", path: "C:\\", folders: [{ name: "Users", path: "C:\\Users" }], total: 1 };
  return { kind: "unreadable", path: folder, parent: "C:\\", reason: "没有权限读这个文件夹" };
}

/** 等着手动放行的一次调用 */
interface Pending<T> {
  arg: string | undefined;
  resolve(value: T): void;
}

/** 调用方：选中的记下来，做完没做完、成没成由 settle 定（不给是马上做完） */
function caller(settle?: Promise<void>) {
  const chosen: string[] = [];
  const deliver = (path: string) => {
    chosen.push(path);
    return settle;
  };
  return { chosen, deliver };
}

/** 一个由测试放行的结果 */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const browsed: Array<string | undefined> = [];
  const http = {
    browseFolders: (folder?: string) => {
      browsed.push(folder);
      return Promise.resolve(tree(folder));
    },
  };
  const picker = new FolderPicker(http);
  let updates = 0;
  picker.subscribe(() => updates++);
  return { picker, browsed, updates: () => updates };
}

/** 列文件夹的结果由测试放行（看先后） */
function manual() {
  const pending: Pending<FolderBrowseView>[] = [];
  const http = {
    browseFolders: (folder?: string) => new Promise<FolderBrowseView>((resolve) => pending.push({ arg: folder, resolve })),
  };
  const picker = new FolderPicker(http);
  return { picker, pending };
}

describe("列、点进、上一级", () => {
  test("关着是 undefined；打开先列常用位置和各个盘，有变化就通知", async () => {
    const { picker, browsed, updates } = setup();
    expect(picker.state()).toBeUndefined();
    await picker.open();
    expect(browsed).toEqual([undefined]);
    expect(picker.state()).toMatchObject({ roots: { places: [{ name: "图片", path: PICTURES }], drives: [{ name: "C:", path: "C:\\" }] }, loading: false, draft: "", busy: false });
    expect(picker.state()?.current).toBeUndefined();
    expect(updates()).toBeGreaterThan(0);
  });

  test("点进去列子文件夹；上一级回去，盘的根再上一级回到常用位置；读不了的写原因，上一级回到它的上一级", async () => {
    const { picker } = setup();
    await picker.open();
    await picker.browse(PICTURES);
    expect(picker.state()?.current).toMatchObject({ kind: "folder", path: PICTURES, folders: [{ name: "2026 杭州" }] });
    await picker.browse(TRIP);
    await picker.up();
    expect(picker.state()?.current).toMatchObject({ kind: "folder", path: PICTURES });

    await picker.browse("C:\\");
    await picker.up();
    expect(picker.state()?.current).toBeUndefined();

    await picker.browse("C:\\System");
    expect(picker.state()?.current).toEqual({ kind: "unreadable", path: "C:\\System", parent: "C:\\", reason: "没有权限读这个文件夹" });
    await picker.up();
    expect(picker.state()?.current).toMatchObject({ kind: "folder", path: "C:\\" });
  });

  test("列不出来的写原因", async () => {
    const picker = new FolderPicker({ browseFolders: () => Promise.reject(new Error("守护进程连不上")) });
    await picker.open();
    expect(picker.state()).toMatchObject({ loading: false, error: "守护进程连不上" });
    expect(picker.state()?.roots).toBeUndefined();
  });

  test("点得快：先点的后回来，只认最后一次列的结果", async () => {
    const { picker, pending } = manual();
    const opening = picker.open();
    pending.shift()!.resolve(tree());
    await opening;

    const first = picker.browse(PICTURES);
    const second = picker.browse("C:\\");
    expect(pending.map((p) => p.arg)).toEqual([PICTURES, "C:\\"]);
    pending[1]!.resolve(tree("C:\\"));
    await second;
    pending[0]!.resolve(tree(PICTURES));
    await first;
    expect(picker.state()).toMatchObject({ current: { kind: "folder", path: "C:\\" }, loading: false });
  });
});

describe("选中交给调用方", () => {
  test("用这个文件夹：交给调用方，做完了框关掉", async () => {
    const { picker } = setup();
    const { chosen, deliver } = caller();
    await picker.open();
    await picker.browse(PICTURES);
    await picker.choose(PICTURES, deliver);
    expect(chosen).toEqual([PICTURES]);
    expect(picker.state()).toBeUndefined();
  });

  test("调用方在做时写在做；抛错的框不关、写原因，再改贴的路径原因就清掉", async () => {
    const { picker } = setup();
    const settle = deferred();
    const { deliver } = caller(settle.promise);
    await picker.open();
    picker.setDraft(" D:\\没有 ");
    const choosing = picker.chooseDraft(deliver);
    expect(picker.state()).toMatchObject({ busy: true });
    settle.reject(new Error("这台电脑上没有这个文件夹：D:\\没有"));
    await choosing;
    expect(picker.state()).toMatchObject({ draft: " D:\\没有 ", busy: false, error: "这台电脑上没有这个文件夹：D:\\没有" });

    picker.setDraft(TRIP);
    expect(picker.state()?.error).toBeUndefined();
  });

  test("贴的完整路径去掉两头空白再交；空的不交", async () => {
    const { picker } = setup();
    const { chosen, deliver } = caller();
    await picker.open();
    picker.setDraft("   ");
    await picker.chooseDraft(deliver);
    expect(chosen).toEqual([]);
    expect(picker.state()).toBeDefined();

    picker.setDraft(` ${TRIP} `);
    await picker.chooseDraft(deliver);
    expect(chosen).toEqual([TRIP]);
    expect(picker.state()).toBeUndefined();
  });

  test("在做时再点不重复交", async () => {
    const { picker } = setup();
    const settle = deferred();
    const { chosen, deliver } = caller(settle.promise);
    await picker.open();
    const first = picker.choose(PICTURES, deliver);
    await picker.choose(PICTURES, deliver);
    expect(chosen).toEqual([PICTURES]);
    settle.resolve();
    await first;
    expect(picker.state()).toBeUndefined();
  });
});

describe("框关了以后", () => {
  test("打开时列的结果晚回来：不再打开它", async () => {
    const { picker, pending } = manual();
    const opening = picker.open();
    picker.close();
    pending.shift()!.resolve(tree());
    await opening;
    expect(picker.state()).toBeUndefined();
  });

  test("点进去的结果晚回来：不再打开它；重新打开以后也不算到新的框上", async () => {
    const { picker, pending } = manual();
    const opening = picker.open();
    pending.shift()!.resolve(tree());
    await opening;
    const browsing = picker.browse(PICTURES);
    picker.close();
    const reopening = picker.open();
    pending[0]!.resolve(tree(PICTURES));
    await browsing;
    expect(picker.state()?.current).toBeUndefined();
    pending[1]!.resolve(tree());
    await reopening;
    expect(picker.state()).toMatchObject({ loading: false, roots: { places: [{ name: "图片" }] } });
    expect(picker.state()?.current).toBeUndefined();
  });

  test("调用方失败的原因晚回来：框关了就不再打开它", async () => {
    const { picker } = setup();
    const settle = deferred();
    const { deliver } = caller(settle.promise);
    await picker.open();
    const choosing = picker.choose(PICTURES, deliver);
    picker.close();
    settle.reject(new Error("写不进去"));
    await choosing;
    expect(picker.state()).toBeUndefined();
  });
});
