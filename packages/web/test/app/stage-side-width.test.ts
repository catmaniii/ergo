// 91 号票：宽屏阶段栏和聊天之间的分界线拖到的宽度按设备记住（主会话建议，不记的话刷新回 320；合并前用户点了头），
// 默认 320；存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效、不报错。存储换成假的。
import { describe, expect, test } from "vitest";
import { PROJECT_SIDE_WIDTH, stageSideWidthSettingIn } from "../../src/app/stage-side-width.ts";
import { BROWSE_SIDE_WIDTH } from "../../src/plugins/browsing/browse-side.ts";

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

describe("阶段栏的宽度：按设备记住", () => {
  test("没拖过：320", () => {
    expect(stageSideWidthSettingIn(() => memoryStorage()).width()).toBe(320);
  });

  test("拖过：马上生效、告诉界面，下次打开还是这么宽；拖回 320 不留记号", () => {
    const storage = memoryStorage();
    const setting = stageSideWidthSettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.set(420);
    expect(setting.width()).toBe(420);
    expect(notified).toBe(1);
    expect(storage.items.get("ergo-stage-side-width")).toBe("420");
    expect(stageSideWidthSettingIn(() => storage).width()).toBe(420);

    setting.set(320);
    expect(storage.items.size).toBe(0);
    expect(notified).toBe(2);
  });

  test("拖的时候是小数：记整数", () => {
    const storage = memoryStorage();
    stageSideWidthSettingIn(() => storage).set(401.6);
    expect(storage.items.get("ergo-stage-side-width")).toBe("402");
  });

  test("存储用不了：读不出按 320；拖了只在这次打开里生效，不报错", () => {
    const setting = stageSideWidthSettingIn(unavailableStorage);
    expect(setting.width()).toBe(320);
    expect(() => setting.set(500)).not.toThrow();
    expect(setting.width()).toBe(500);
    expect(stageSideWidthSettingIn(unavailableStorage).width()).toBe(320);
  });

  test("一样的值不再通知", () => {
    const setting = stageSideWidthSettingIn(() => memoryStorage());
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.set(320);
    expect(notified).toBe(0);
  });
});

describe("宽屏项目的档案栏的宽度（104 号票）：同一个做法，初值 380，和阶段栏分开记", () => {
  test("没拖过 380；拖过记在自己的键上，阶段栏不跟着变；拖回 380 不留记号", () => {
    const storage = memoryStorage();
    const side = stageSideWidthSettingIn(() => storage, PROJECT_SIDE_WIDTH);
    expect(side.width()).toBe(380);
    side.set(460.4);
    expect(storage.items.get("ergo-project-side-width")).toBe("460");
    expect(stageSideWidthSettingIn(() => storage).width()).toBe(320);
    expect(stageSideWidthSettingIn(() => storage, PROJECT_SIDE_WIDTH).width()).toBe(460);
    side.set(380);
    expect(storage.items.size).toBe(0);
  });

  test("存储用不了：按 380", () => {
    expect(stageSideWidthSettingIn(unavailableStorage, PROJECT_SIDE_WIDTH).width()).toBe(380);
  });
});

describe("浏览侧边栏的宽度（148 号票）：同一个做法，初值 400，自己的键", () => {
  test("没拖过 400；拖过记在自己的键上，阶段栏、档案栏不跟着变；拖回 400 不留记号", () => {
    const storage = memoryStorage();
    const side = stageSideWidthSettingIn(() => storage, BROWSE_SIDE_WIDTH);
    expect(side.width()).toBe(400);
    let notified = 0;
    side.subscribe(() => notified++);
    side.set(512.3);
    expect(notified).toBe(1);
    expect(storage.items.get("ergo-browse-side-width")).toBe("512");
    expect(stageSideWidthSettingIn(() => storage).width()).toBe(320);
    expect(stageSideWidthSettingIn(() => storage, PROJECT_SIDE_WIDTH).width()).toBe(380);
    expect(stageSideWidthSettingIn(() => storage, BROWSE_SIDE_WIDTH).width()).toBe(512);
    side.set(400);
    expect(storage.items.size).toBe(0);
  });

  test("记着的比最窄还窄、认不出：按 400；存储用不了：按 400，拖了只在这次打开里生效", () => {
    const storage = memoryStorage();
    storage.setItem("ergo-browse-side-width", "150");
    expect(stageSideWidthSettingIn(() => storage, BROWSE_SIDE_WIDTH).width()).toBe(400);
    const off = stageSideWidthSettingIn(unavailableStorage, BROWSE_SIDE_WIDTH);
    expect(off.width()).toBe(400);
    expect(() => off.set(480)).not.toThrow();
    expect(off.width()).toBe(480);
  });
});
