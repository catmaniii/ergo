// 插件开发手册（docs/guides/plugin-development.md，215 号票）的例子：照手册写的网页插件"笔记"（notes-example/plugin.tsx），
// 按守护进程报的状况（插件频道上的 plugin_status）装上、停用、启用、移除：插槽里的东西跟着收起、放回，停用时它拥有的位置交回占位用的名字。
// 这条测试也是手册的例子（plugin-guide-doc.test.ts 核对手册里的摘录和代码对得上）。走真实装配路径的那条见 assembly.test.ts。
import { describe, expect, test } from "vitest";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import type { PluginStatusView } from "../../src/state/index.ts";
import { notesWebPlugin } from "./notes-example/plugin.tsx";

/** 守护进程报的笔记插件的状况 */
const status = (state: PluginStatusView["state"]): PluginStatusView[] => [state === "skipped" ? { name: "notes", title: "笔记", state, reason: "没装上" } : { name: "notes", title: "笔记", state }];

describe("手册的例子：笔记的网页插件", () => {
  test("在运行就装上；停用、移除就收起，拥有的位置显示\"笔记插件没启用\"；再启用回来", () => {
    const host = createWebPluginHost({ plugins: [notesWebPlugin] });
    host.apply(status("running"));
    expect(host.list("pages").map((p) => p.id)).toEqual(["notes"]);
    expect(host.get("cards", "note")).toBeDefined();
    expect(host.unavailable("cards", "note")).toBeUndefined();

    host.apply(status("disabled"));
    expect(host.list("pages")).toEqual([]);
    expect(host.get("cards", "note")).toBeUndefined();
    expect(host.unavailable("cards", "note")).toBe("笔记");
    expect(host.unavailable("pages", "notes")).toBe("笔记");

    host.apply(status("running"));
    expect(host.get("cards", "note")).toBeDefined();

    host.apply(status("removed"));
    expect(host.running("notes")).toBe(false);
    expect(host.unavailable("cards", "note")).toBe("笔记");
  });

  test("还没收到守护进程报的状况（原型、旧的守护进程）当作全开；守护进程清单里没有它的当作没装", () => {
    const host = createWebPluginHost({ plugins: [notesWebPlugin] });
    host.apply(undefined);
    expect(host.running("notes")).toBe(true);
    host.apply([]);
    expect(host.running("notes")).toBe(false);
  });
});
