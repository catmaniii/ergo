// 前端状态层：记忆管理员（242 号票）。看板"运营中"多一张"记忆整理 · 每天 03:00"的卡，点进去落在记忆页的管理员那一层
// （#/more/memory/curator）；记忆插件没在运行时不出现（和别的插件条目一样）。
import { describe, expect, test } from "vitest";
import { boardGroups, replay } from "../../src/state/index.ts";
import { isMemoryItem, MEMORY_ITEMS } from "../../src/plugins/memory/route.ts";
import { frame } from "./events.ts";

/** 插件频道上的插件状况（网页按它装、停插件） */
function pluginStatus(memory: "running" | "disabled") {
  return frame("plugins", 1, "plugin_status", {
    plugins: [
      { name: "memory", title: "记忆", state: memory },
      { name: "reminders", title: "提醒", state: "running" },
    ],
  });
}

describe("看板上的记忆整理", () => {
  test("记忆插件在运行时，运营中一组多一张记忆整理卡，带着跳转的地址", () => {
    const ui = replay([pluginStatus("running")]);
    const ops = boardGroups(ui).find((group) => group.group === "ops")!;
    expect(ops.items).toContainEqual({
      kind: "memory_curator",
      route: { tab: "more", page: "memory", item: "curator" },
    });
  });

  test("记忆插件没在运行时没有这张卡", () => {
    const ui = replay([pluginStatus("disabled")]);
    expect(boardGroups(ui).flatMap((group) => group.items)).not.toContainEqual(expect.objectContaining({ kind: "memory_curator" }));
  });
});

describe("记忆页的管理员那一层", () => {
  test("地址里的那一段认得 curator，和素材、结论、证据与推理、问题箱并列", () => {
    expect(MEMORY_ITEMS).toContain("curator");
    expect(isMemoryItem("curator")).toBe(true);
    expect(isMemoryItem("nope")).toBe(false);
  });
});
