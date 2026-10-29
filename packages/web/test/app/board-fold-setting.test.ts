// 90 号票：看板每组标题点一下收起 / 展开，每台设备记住（存在这台设备的浏览器里），默认"已归档"收起、其它展开；
// 存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效、不报错。存储换成假的。
import { describe, expect, test } from "vitest";
import { boardFoldSettingIn, foldSettingIn, PROJECT_FOLD } from "../../src/app/board-fold-setting.ts";
import { boardFoldedOf, boardFoldedText, toggleBoardGroup } from "../../src/state/index.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

function unavailableStorage(): never {
  throw new Error("SecurityError");
}

describe("记住的值怎么认、怎么写（state/board-fold.ts）", () => {
  test("没记过：已归档收起，其它展开", () => {
    expect([...boardFoldedOf(null)]).toEqual(["archived"]);
  });

  test("记过的按记的：空串是全展开；认不出的组名丢掉", () => {
    expect([...boardFoldedOf("")]).toEqual([]);
    expect([...boardFoldedOf("ended,archived")]).toEqual(["ended", "archived"]);
    expect([...boardFoldedOf("ops,nonsense")]).toEqual(["ops"]);
  });

  test("和默认一样不记；不一样的按看板上的先后连起来", () => {
    expect(boardFoldedText(new Set(["archived"]))).toBeUndefined();
    expect(boardFoldedText(new Set())).toBe("");
    expect(boardFoldedText(new Set(["archived", "waiting"]))).toBe("waiting,archived");
  });

  test("点一下标题：收起的展开，展开的收起", () => {
    expect([...toggleBoardGroup(new Set(["archived"]), "archived")]).toEqual([]);
    expect([...toggleBoardGroup(new Set(["archived"]), "ops")].toSorted()).toEqual(["archived", "ops"]);
  });
});

describe("看板分组收起 / 展开：按设备记住", () => {
  test("没改过：已归档收起", () => {
    expect([...boardFoldSettingIn(() => memoryStorage()).folded()]).toEqual(["archived"]);
  });

  test("收起最近结束、展开已归档：马上生效、告诉界面，下次打开还是这样；改回默认不留记号", () => {
    const storage = memoryStorage();
    const setting = boardFoldSettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.toggle("ended");
    setting.toggle("archived");
    expect([...setting.folded()]).toEqual(["ended"]);
    expect(notified).toBe(2);
    expect(storage.items.get("ergo-board-folded")).toBe("ended");
    expect([...boardFoldSettingIn(() => storage).folded()]).toEqual(["ended"]);

    setting.toggle("ended");
    setting.toggle("archived");
    expect([...setting.folded()]).toEqual(["archived"]);
    expect(storage.items.size).toBe(0);
  });

  test("全展开也记得住（空串）", () => {
    const storage = memoryStorage();
    boardFoldSettingIn(() => storage).toggle("archived");
    expect(storage.items.get("ergo-board-folded")).toBe("");
    expect([...boardFoldSettingIn(() => storage).folded()]).toEqual([]);
  });

  test("存储用不了：读不出按默认；改了只在这次打开里生效，不报错", () => {
    const setting = boardFoldSettingIn(unavailableStorage);
    expect([...setting.folded()]).toEqual(["archived"]);
    expect(() => setting.toggle("archived")).not.toThrow();
    expect([...setting.folded()]).toEqual([]);
    expect([...boardFoldSettingIn(unavailableStorage).folded()]).toEqual(["archived"]);
  });

  test("退订之后不再通知", () => {
    const setting = boardFoldSettingIn(() => memoryStorage());
    let notified = 0;
    const off = setting.subscribe(() => notified++);
    off();
    setting.toggle("ops");
    expect(notified).toBe(0);
  });
});

describe("项目一览的分组收起（104 号票）：同一个做法，和任务看板分开记", () => {
  test("没改过：已归档收起；收起已停用、展开已归档记在自己的键上，任务看板不跟着变", () => {
    const storage = memoryStorage();
    const projects = foldSettingIn(() => storage, PROJECT_FOLD);
    expect([...projects.folded()]).toEqual(["archived"]);
    projects.toggle("retired");
    projects.toggle("archived");
    expect(storage.items.get("ergo-project-folded")).toBe("retired");
    expect(storage.items.has("ergo-board-folded")).toBe(false);
    expect([...foldSettingIn(() => storage, PROJECT_FOLD).folded()]).toEqual(["retired"]);
    expect([...boardFoldSettingIn(() => storage).folded()]).toEqual(["archived"]);
  });

  test("存储用不了：按默认，改了不报错", () => {
    const setting = foldSettingIn(unavailableStorage, PROJECT_FOLD);
    expect(() => setting.toggle("archived")).not.toThrow();
    expect([...setting.folded()]).toEqual([]);
  });
});
