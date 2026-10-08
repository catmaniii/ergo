// 浏览器里"本设备已被吊销"的记号：存在 localStorage 里，只有一个固定的值；存不了、读不了就当没有。
import { describe, expect, test } from "vitest";
import type { DeviceStorage } from "../../src/app/device-storage.ts";
import { revokedMarkIn } from "../../src/app/revoked-mark.ts";

function memoryStorage(): DeviceStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe("本设备已被吊销的记号", () => {
  test("留下、读到、擦掉；存的只是一个固定的值（不含设备 id、凭证）", () => {
    const storage = memoryStorage();
    const mark = revokedMarkIn(() => storage);
    expect(mark.get()).toBe(false);
    mark.set(true);
    expect(mark.get()).toBe(true);
    expect([...storage.items.values()]).toEqual(["1"]);
    mark.set(false);
    expect(mark.get()).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  test("localStorage 用不了（隐私模式、禁用了站点数据）：当没有记号，也不抛错", () => {
    const mark = revokedMarkIn(() => {
      throw new Error("SecurityError");
    });
    expect(mark.get()).toBe(false);
    expect(() => mark.set(true)).not.toThrow();
  });
});
