// 设置里的"自动播放 agent 的语音"开关（36 号票）：默认开，按设备记住（存在这台设备的浏览器里，和外观一样），改了立即生效；
// 存储用不了（隐私模式、禁用了站点数据）时按默认，改了只在这次打开里生效、不报错。存储换成假的。
import { describe, expect, test } from "vitest";
import { autoplaySettingIn } from "../../src/app/voice-autoplay-setting.ts";

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

describe("自动播放 agent 的语音：按设备记住的开关", () => {
  test("没改过：开着", () => {
    expect(autoplaySettingIn(() => memoryStorage()).enabled()).toBe(true);
  });

  test("关掉：马上生效、告诉界面，下次打开还是关着；再打开：下次打开是开着（回到默认，不留记号）", () => {
    const storage = memoryStorage();
    const setting = autoplaySettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.set(false);
    expect(setting.enabled()).toBe(false);
    expect(notified).toBe(1);
    expect(autoplaySettingIn(() => storage).enabled()).toBe(false);

    setting.set(true);
    expect(setting.enabled()).toBe(true);
    expect(notified).toBe(2);
    expect(storage.items.size).toBe(0);
    expect(autoplaySettingIn(() => storage).enabled()).toBe(true);
  });

  test("存储用不了：按默认开着；关掉只在这次打开里生效，不报错", () => {
    const setting = autoplaySettingIn(unavailableStorage);
    expect(setting.enabled()).toBe(true);
    expect(() => setting.set(false)).not.toThrow();
    expect(setting.enabled()).toBe(false);
    expect(autoplaySettingIn(unavailableStorage).enabled()).toBe(true);
  });

  test("退订之后不再通知", () => {
    const setting = autoplaySettingIn(() => memoryStorage());
    let notified = 0;
    const unsubscribe = setting.subscribe(() => notified++);
    unsubscribe();
    setting.set(false);
    expect(notified).toBe(0);
  });
});
