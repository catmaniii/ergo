// 88 号票：宽屏长程任务的阶段栏开着还是藏掉（照 AgentSense 整栏藏掉，用户 2026-10-11 定），按设备记住（存在这台设备的浏览器里，和外观、风格一样），默认开着；
// 存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效、不报错。存储换成假的。
import { describe, expect, test } from "vitest";
import { PROJECT_SIDE_KEY, stageSideSettingIn } from "../../src/app/stage-side-setting.ts";

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

describe("阶段栏开着还是藏掉：按设备记住", () => {
  test("没改过：开着", () => {
    expect(stageSideSettingIn(() => memoryStorage()).pref()).toBe("open");
  });

  test("藏掉：马上生效、告诉界面，下次打开还是藏着；再打开：回到默认，不留记号", () => {
    const storage = memoryStorage();
    const setting = stageSideSettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.set("closed");
    expect(setting.pref()).toBe("closed");
    expect(notified).toBe(1);
    expect(storage.items.get("ergou-stage-side")).toBe("closed");
    expect(stageSideSettingIn(() => storage).pref()).toBe("closed");

    setting.set("open");
    expect(setting.pref()).toBe("open");
    expect(notified).toBe(2);
    expect(storage.items.size).toBe(0);
    expect(stageSideSettingIn(() => storage).pref()).toBe("open");
  });

  test("记住的值认不出（比如以前的“collapsed”）：按开着", () => {
    const storage = memoryStorage();
    storage.items.set("ergou-stage-side", "collapsed");
    expect(stageSideSettingIn(() => storage).pref()).toBe("open");
  });

  test("存储用不了：读不出按开着；藏掉只在这次打开里生效，不报错", () => {
    const setting = stageSideSettingIn(unavailableStorage);
    expect(setting.pref()).toBe("open");
    expect(() => setting.set("closed")).not.toThrow();
    expect(setting.pref()).toBe("closed");
    expect(stageSideSettingIn(unavailableStorage).pref()).toBe("open");
  });

  test("一样的值不再通知；退订之后不再通知", () => {
    const setting = stageSideSettingIn(() => memoryStorage());
    let notified = 0;
    const unsubscribe = setting.subscribe(() => notified++);
    setting.set("open");
    expect(notified).toBe(0);
    unsubscribe();
    setting.set("closed");
    expect(notified).toBe(0);
  });
});

describe("宽屏项目的档案栏开着还是藏掉（104 号票）：同一个做法，和阶段栏分开记", () => {
  test("默认开着；藏掉记在自己的键上，阶段栏不跟着变；打开擦掉记号", () => {
    const storage = memoryStorage();
    const side = stageSideSettingIn(() => storage, PROJECT_SIDE_KEY);
    expect(side.pref()).toBe("open");
    side.set("closed");
    expect(storage.items.get("ergou-project-side")).toBe("closed");
    expect(stageSideSettingIn(() => storage).pref()).toBe("open");
    expect(stageSideSettingIn(() => storage, PROJECT_SIDE_KEY).pref()).toBe("closed");
    side.set("open");
    expect(storage.items.size).toBe(0);
  });
});
