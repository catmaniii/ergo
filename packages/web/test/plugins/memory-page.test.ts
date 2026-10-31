// 285 号票：记忆页的栏目重排——首页列档案、结论、问题箱、素材四栏，记忆管理员是整页对话（不在栏目里）；"证据与推理"并进结论
// （旧地址 #/more/memory/evidence[/<编号>] 换到 #/more/memory/claims[/<编号>]）；记忆插件在用时它的"档案"盖住"更多"里的个人档案
// （#/more/files[/<编号>] 换到 #/more/memory/files[/<编号>]，"更多"里不再列），停用时个人档案照旧在"更多"里。
// 用户 2026-10-31："记忆插件没装 / 没启用时系统也不能崩"——这里查 #/more/memory 那一条地址：
// 插件在用时是记忆页（标题「记忆系统 · 会意 v1.0」），停用了、没装上时写"记忆插件没启用，这一页暂时看不到"、不抛异常。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { MorePage, coveredRoute } from "../../src/pages/MorePage.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { isMemoryItem, MEMORY_ITEMS, MEMORY_ITEMS_WITH_SUB, MEMORY_LAYERS, memoryRedirect } from "../../src/plugins/memory/route.ts";
import { PluginHostProvider } from "../../src/plugins/react.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

function assembled() {
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(undefined);
  return host;
}

type Host = ReturnType<typeof assembled>;

const noop = () => {};
/** 不连线的 StoreProvider（渲染时不跑副作用，连接、HTTP 都用不到） */
const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
/** 按某个插件状况打开"更多"下的记忆页这条地址（竖屏，收进来的导航项为空；item 是地址里再下一级的那一段） */
function moreMemoryAt(host: Host, page = "memory", item?: string): string {
  const tree = createElement(
    StoreProvider,
    offline,
    createElement(PluginHostProvider, { host }, createElement(MorePage, { wide: false, page, folded: [], navigate: noop, ...(item === undefined ? {} : { item }) })),
  );
  return renderToStaticMarkup(tree);
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

describe("记忆插件没启用时记忆页这条地址不会崩（用户 2026-10-31）", () => {
  test("插件在用时 #/more/memory 就是记忆页：标题「记忆系统 · 会意 v1.0」、四栏都在", () => {
    const html = moreMemoryAt(assembled());
    expect(html).toContain("记忆系统 · 会意 v1.0");
    expect(html).toContain("memory-layers");
    expect(html).not.toContain("记忆插件没启用");
  });

  test("配置里停用：写\"记忆插件没启用，这一页暂时看不到\"，不抛异常（不是白屏、不是 undefined）", () => {
    const host = assembled();
    host.disable("memory");
    const html = moreMemoryAt(host);
    expect(html).toContain("记忆插件没启用，这一页暂时看不到");
    // 记忆页自己的东西一样都不画（四栏、设置块、和记忆管理员聊那张卡）
    expect(html).not.toContain("memory-layers");
    expect(html).not.toContain('data-block="memory-settings"');
    expect(html).not.toContain('data-action="curator"');
  });

  test("没装上（守护进程报 skipped）：同一句，不抛异常", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply([
      { name: "memory", title: "记忆", state: "skipped" },
      ...WEB_PLUGIN_MANIFEST.filter((p) => p.name !== "memory").map((p) => ({ name: p.name, title: p.title, state: "running" as const })),
    ]);
    expect(host.running("memory")).toBe(false);
    const html = moreMemoryAt(host);
    expect(html).toContain("记忆插件没启用，这一页暂时看不到");
  });

  test("停用、没装上时记忆页里每一条地址（首页、几栏、管理员、成批删除）都写同一句，别的地方照常", () => {
    const host = assembled();
    host.disable("memory");
    // 地址里再下一级的那一段由插件页面自己认，插件不在就整条都按"没启用"画
    for (const item of [undefined, ...MEMORY_ITEMS]) {
      expect(moreMemoryAt(host, "memory", item)).toContain("记忆插件没启用，这一页暂时看不到");
    }
    // 别的页不受影响（个人档案照旧是"更多"里的那一页）
    expect(moreMemoryAt(host, "files")).not.toContain("记忆插件没启用");
  });
});
