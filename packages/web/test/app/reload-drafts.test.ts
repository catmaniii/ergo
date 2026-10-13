// 刷新前留住输入框里没发出去的字（116 号票）：点"有新版本 · 刷新"时，开着的输入框里打了一半的话存进这个标签页的存储，
// 刷新后同一个会话的输入框挂上时放回去（取一次就删掉）。存储换成假的；取不到存储时这次就留不住，不抛错。
import { describe, expect, test } from "vitest";
import type { DeviceStorage } from "../../src/app/device-storage.ts";
import { createComposerDrafts, reloadDraftsIn } from "../../src/app/reload-drafts.ts";

function memoryStorage(): DeviceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const broken = (): DeviceStorage => {
  throw new Error("SecurityError: 禁用了站点数据");
};

describe("刷新前后的草稿", () => {
  test("刷新前存下，刷新后（另一份页面脚本、同一个存储）同一个会话的输入框放回去，取一次就没了", () => {
    const storage = memoryStorage();
    reloadDraftsIn(() => storage).keep({ secretary: "帮我把周报改成三段，第二段写", "maintainer:pm-1": "先别合并" });
    const after = reloadDraftsIn(() => storage);
    expect(after.take("secretary")).toBe("帮我把周报改成三段，第二段写");
    expect(after.take("secretary")).toBeUndefined();
    // 别的会话的还在，等它的输入框挂上时再取
    expect(after.take("maintainer:pm-1")).toBe("先别合并");
    // 都取完了：存储里不留东西
    expect(storage.data.size).toBe(0);
  });

  test("空的、只有空白的不存；没有要存的时候不写存储", () => {
    const storage = memoryStorage();
    reloadDraftsIn(() => storage).keep({ secretary: "  \n", "maintainer:pm-1": "" });
    expect(storage.data.size).toBe(0);
    expect(reloadDraftsIn(() => storage).take("secretary")).toBeUndefined();
  });

  test("存储用不了（隐私模式、禁用了站点数据）、存的东西坏了：不抛错，当作没有", () => {
    expect(() => reloadDraftsIn(broken).keep({ secretary: "写了一半" })).not.toThrow();
    expect(reloadDraftsIn(broken).take("secretary")).toBeUndefined();
    const storage = memoryStorage();
    storage.setItem("ergou.reload_drafts", "{不是 JSON");
    expect(reloadDraftsIn(() => storage).take("secretary")).toBeUndefined();
    storage.setItem("ergou.reload_drafts", JSON.stringify({ secretary: 42 }));
    expect(reloadDraftsIn(() => storage).take("secretary")).toBeUndefined();
  });

  test("开着的输入框：现在打的字（空的不算），输入框拿掉了就不算它", () => {
    const composers = createComposerDrafts();
    let typed = "明早九点";
    const close = composers.open("secretary", () => typed);
    composers.open("maintainer:pm-1", () => "");
    expect(composers.current()).toEqual({ secretary: "明早九点" });
    typed = "明早九点提醒我交电费";
    expect(composers.current()).toEqual({ secretary: "明早九点提醒我交电费" });
    close();
    expect(composers.current()).toEqual({});
  });
});
