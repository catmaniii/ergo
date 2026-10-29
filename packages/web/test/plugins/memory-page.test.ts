// 285 号票：记忆页的栏目重排——首页列档案、结论、问题箱、素材四栏，记忆管理员是整页对话（不在栏目里）；"证据与推理"并进结论
// （旧地址 #/more/memory/evidence[/<编号>] 换到 #/more/memory/claims[/<编号>]）；记忆插件在用时它的"档案"盖住"更多"里的个人档案
// （#/more/files[/<编号>] 换到 #/more/memory/files[/<编号>]，"更多"里不再列），停用时个人档案照旧在"更多"里。
import { describe, expect, test, vi } from "vitest";
import { coveredRoute } from "../../src/pages/MorePage.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { isMemoryItem, MEMORY_ITEMS, MEMORY_ITEMS_WITH_SUB, MEMORY_LAYERS, memoryRedirect } from "../../src/plugins/memory/route.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

function assembled() {
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(undefined);
  return host;
}

describe("记忆页的栏目", () => {
  test("首页四栏：档案、结论、问题箱、素材；记忆管理员、成批删除也是记忆页认的地址，但不在栏目里", () => {
    expect(MEMORY_LAYERS).toEqual(["files", "claims", "questions", "materials"]);
    expect(MEMORY_ITEMS).toEqual(["files", "claims", "questions", "materials", "curator", "materials-delete"]);
    expect(isMemoryItem("curator")).toBe(true);
    // "证据与推理"不再是一栏
    expect(isMemoryItem("evidence")).toBe(false);
  });

  test("有下一级的：档案里点开的一个人、结论里点开的一条（证据链）、素材和成批删除里点开的一条", () => {
    expect(MEMORY_ITEMS_WITH_SUB).toEqual(["files", "claims", "materials", "materials-delete"]);
  });

  test("旧地址：证据与推理（233 号票）换到结论，点开的那一条照旧带着；别的地址不换", () => {
    expect(memoryRedirect("evidence", undefined)).toEqual({ tab: "more", page: "memory", item: "claims" });
    expect(memoryRedirect("evidence", "cl-0001")).toEqual({ tab: "more", page: "memory", item: "claims", sub: "cl-0001" });
    for (const item of [undefined, "claims", "files", "curator", "materials"]) expect(memoryRedirect(item, "x")).toBeUndefined();
  });
});

describe("记忆 · 档案盖住\"更多\"里的个人档案", () => {
  test("记忆插件在用：#/more/files 去记忆 · 档案，点开的一个人照旧带着", () => {
    const host = assembled();
    expect(coveredRoute(host, "files", undefined)).toEqual({ tab: "more", page: "memory", item: "files" });
    expect(coveredRoute(host, "files", "p-1")).toEqual({ tab: "more", page: "memory", item: "files", sub: "p-1" });
    // 成批删除也被记忆页覆盖（设置里不列），但它的地址照旧（不换）
    expect(coveredRoute(host, "materials-delete", undefined)).toBeUndefined();
    expect(coveredRoute(host, "about", undefined)).toBeUndefined();
  });

  test("记忆插件停用：个人档案照旧是\"更多\"里的那一页", () => {
    const host = assembled();
    host.disable("memory");
    expect(coveredRoute(host, "files", undefined)).toBeUndefined();
    expect(coveredRoute(host, "files", "p-1")).toBeUndefined();
  });
});
