// 91 号票：宽屏阶段栏和聊天之间的分界线拖到的宽度按设备记住（主会话建议，和 AgentSense 不一样：它不记，刷新回 320；合并前要用户点头），
// 默认 320；存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效、不报错。存储换成假的。
import { describe, expect, test } from "vitest";
import { stageSideWidthSettingIn } from "../../src/app/stage-side-width.ts";

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
    expect(storage.items.get("ergou-stage-side-width")).toBe("420");
    expect(stageSideWidthSettingIn(() => storage).width()).toBe(420);

    setting.set(320);
    expect(storage.items.size).toBe(0);
    expect(notified).toBe(2);
  });

  test("拖的时候是小数：记整数", () => {
    const storage = memoryStorage();
    stageSideWidthSettingIn(() => storage).set(401.6);
    expect(storage.items.get("ergou-stage-side-width")).toBe("402");
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
