// 设置里的换行键（用户 2026-11-01 要的）：默认 Ctrl，按设备记住；存储用不了时按默认，改了只在这次打开里生效。
import { describe, expect, test } from "vitest";
import { newlineKeySettingIn } from "../../src/app/composer-keys-setting.ts";

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

describe("换行键：按设备记住", () => {
  test("没改过是 Ctrl", () => {
    expect(newlineKeySettingIn(() => memoryStorage()).key()).toBe("ctrl");
  });

  test("换成 Shift：马上生效、告诉界面，下次打开还是 Shift；换回 Ctrl 记号擦掉", () => {
    const storage = memoryStorage();
    const setting = newlineKeySettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    setting.set("shift");
    expect(setting.key()).toBe("shift");
    expect(notified).toBe(1);
    expect(newlineKeySettingIn(() => storage).key()).toBe("shift");
    setting.set("ctrl");
    expect(storage.items.size).toBe(0);
    expect(newlineKeySettingIn(() => storage).key()).toBe("ctrl");
  });

  test("存储用不了：按默认，改了这次打开里照样生效", () => {
    const setting = newlineKeySettingIn(unavailableStorage);
    expect(setting.key()).toBe("ctrl");
    setting.set("shift");
    expect(setting.key()).toBe("shift");
  });
});
