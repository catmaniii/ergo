// 设置向导"能力"那一步（347 号票）的纯逻辑：列哪几项、默认勾不勾（和清单一致：向量模型和记忆勾，语音不勾）、勾上要下多大、
// 勾了之后调哪些接口——要确认许可的先过确认框、没同意不发请求；一项失败不挡别的；不勾语音时不碰语音相关的东西。页面见 test/pages/capabilities-step.test.ts。
import { describe, expect, test } from "vitest";
import {
  applyCapabilities,
  type CapabilityApi,
  capabilityActive,
  capabilityPlan,
  capabilityRows,
  capabilityTotal,
  defaultTicked,
  installedNow,
  progressOwner,
  retryCapability,
  stoppedDependency,
} from "../../src/app/setup-capabilities.ts";
import type { ComponentAction, ComponentsView, ComponentView, PluginInfo, PluginState } from "../../src/state/index.ts";

function component(id: string, extra: Partial<ComponentView> = {}): ComponentView {
  return { id, title: id, summary: `${id} 能做什么`, version: "1", state: "missing", default: "ask", defaultText: "问了再装", wanted: false, size: 100, enables: [], dependsOn: [], sources: [], location: "x", ...extra };
}

/** 新装的样子：向量模型默认装，语音问了再装（共用程序 audio.cpp），Claude Code 检测到才装 */
function fresh(over: Record<string, Partial<ComponentView>> = {}): ComponentsView {
  const components = [
    component("bge-m3", { wanted: true, default: "install", size: 570, enables: [{ id: "memory.semantic", title: "按意思检索" }], ...over["bge-m3"] }),
    component("asr", { size: 1000, dependsOn: ["audiocpp"], enables: [{ id: "voice.input", title: "按住说话" }], license: { name: "FunASR", summary: "s", url: "https://x", confirm: true, accepted: false }, ...over.asr }),
    component("audiocpp", { size: 850, ...over.audiocpp }),
    component("tts", { size: 6000, dependsOn: ["audiocpp"], enables: [{ id: "voice.reply", title: "语音回复" }], license: { name: "Fish", summary: "s", url: "https://x", confirm: true, accepted: false }, ...over.tts }),
    component("claude-code", { default: "detected", size: 110, enables: [{ id: "runtime.claude-code", title: "Claude Code" }], ...over["claude-code"] }),
  ];
  return { components, features: [], manifest: { release: "0.4.0", signed: false }, defaultsMissing: [] };
}

function plugin(name: string, state: PluginState = "running", extra: Partial<PluginInfo> = {}): PluginInfo {
  return { name, title: name, summary: `${name} 能做什么`, state, brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [], ...extra };
}

const SDK_MISSING = { missing: true as const, problem: "没装 SDK", cannotEnable: "没装 SDK" };
/** 插件清单默认全开；Claude Code 没装 SDK 时没装上 */
const pluginsFresh = (over: Record<string, Partial<PluginInfo> & { state?: PluginState }> = {}): PluginInfo[] =>
  ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone"].map((name) => (name === "claude-code" ? plugin(name, "skipped", { ...SDK_MISSING, ...over[name] }) : plugin(name, over[name]?.state ?? "running", over[name])));

function fakeApi(over: { fail?: Record<string, string>; accept?: boolean; view?: ComponentsView } = {}) {
  const calls: string[] = [];
  const licenses: string[] = [];
  const api: CapabilityApi = {
    componentAction(id: string, action: ComponentAction, extra?: { licenseAccepted?: boolean }) {
      calls.push(`component ${id} ${action}${extra?.licenseAccepted ? " accepted" : ""}`);
      const reason = over.fail?.[id];
      return reason ? Promise.reject(new Error(reason)) : Promise.resolve(over.view ?? fresh());
    },
    pluginAction(name) {
      calls.push(`plugin ${name} enable`);
      const reason = over.fail?.[name];
      return reason ? Promise.reject(new Error(reason)) : Promise.resolve({ changed: [name], plugins: [plugin(name)] });
    },
    confirmLicense(c) {
      licenses.push(c.id);
      return Promise.resolve(over.accept ?? true);
    },
    newKey: () => "key",
  };
  return { api, calls, licenses };
}

describe("列哪几项", () => {
  test("插件是记忆、日历、语音、浏览、Claude Code；组件是向量模型、语音识别、语音合成；程序 audio.cpp 不单列", () => {
    const rows = capabilityRows(fresh(), pluginsFresh());
    expect(rows.filter((r) => r.kind === "plugin").map((r) => r.id)).toEqual(["memory", "calendar", "voice", "browsing", "claude-code"]);
    expect(rows.filter((r) => r.kind === "component").map((r) => r.id)).toEqual(["bge-m3", "asr", "tts"]);
    // 每项一句它能做什么
    expect(rows.every((r) => r.summary.endsWith("能做什么"))).toBe(true);
  });

  test("还没取到的那一半不列；清单里没有的不编", () => {
    expect(capabilityRows(undefined, undefined)).toEqual([]);
    expect(capabilityRows(fresh(), undefined).map((r) => r.kind)).toEqual(["component", "component", "component"]);
    expect(capabilityRows(undefined, [plugin("memory")]).map((r) => r.id)).toEqual(["memory"]);
  });

  test("要下多大：写它自己加上还没有的依赖；程序已经有了就不算；插件不用下载", () => {
    const rows = capabilityRows(fresh(), pluginsFresh());
    expect(rows.find((r) => r.id === "tts")).toMatchObject({ download: 6850, downloadWith: ["audiocpp"] });
    expect(rows.find((r) => r.id === "bge-m3")).toMatchObject({ download: 570, downloadWith: [] });
    expect(rows.find((r) => r.id === "calendar")).toMatchObject({ download: 0 });
    expect(capabilityRows(fresh({ audiocpp: { state: "installed" } }), pluginsFresh()).find((r) => r.id === "tts")).toMatchObject({ download: 6000, downloadWith: [] });
  });

  test("两个语音模型共用一个程序：总量只算一次", () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh());
    expect(capabilityTotal(rows, new Set(["component:tts", "component:asr"]), view)).toBe(6000 + 1000 + 850);
    expect(capabilityTotal(rows, new Set(["plugin:calendar"]), view)).toBe(0);
  });
});

describe("默认勾不勾（和清单一致）", () => {
  test("新装：只勾向量模型；语音不勾；运行中的插件不用勾", () => {
    const rows = capabilityRows(fresh(), pluginsFresh());
    expect([...defaultTicked(rows)]).toEqual(["component:bge-m3"]);
    expect(rows.find((r) => r.id === "memory")?.status).toBe("on");
  });

  test("记忆插件停着：默认勾回来；别的停着的插件不勾（用户自己停的）", () => {
    const rows = capabilityRows(fresh(), pluginsFresh({ memory: { state: "disabled" }, voice: { state: "disabled" }, calendar: { state: "removed" } }));
    expect([...defaultTicked(rows)].toSorted()).toEqual(["component:bge-m3", "plugin:memory"]);
  });

  test("默认不是写死的：清单改成语音默认装，这里跟着勾；本机检测到 Claude Code 跟着勾", () => {
    expect([...defaultTicked(capabilityRows(fresh({ tts: { wanted: true } }), pluginsFresh()))]).toContain("component:tts");
    expect([...defaultTicked(capabilityRows(fresh({ "claude-code": { wanted: true } }), pluginsFresh()))]).toContain("plugin:claude-code");
    expect([...defaultTicked(capabilityRows(fresh({ "bge-m3": { wanted: false } }), pluginsFresh()))]).toEqual([]);
  });

  test("已经有了的、不能从这里装的不勾，写原因", () => {
    const view = fresh({
      "bge-m3": { state: "installed", installedVersion: "4de1" },
      tts: { state: "provided", providedBy: "已有自己配的语音合成", cannotInstall: "要改用这里装的，先撤掉" },
      asr: { cannotInstall: "数据目录路径带中文" },
    });
    const rows = capabilityRows(view, pluginsFresh());
    expect(rows.find((r) => r.id === "bge-m3")?.status).toBe("on");
    expect(rows.find((r) => r.id === "tts")).toMatchObject({ status: "on", note: "已有自己配的语音合成" });
    expect(rows.find((r) => r.id === "asr")).toMatchObject({ status: "locked", note: "数据目录路径带中文" });
    expect([...defaultTicked(rows)]).toEqual([]);
  });

  test("插件启用不了的写原因（它要的插件有问题）", () => {
    const rows = capabilityRows(fresh(), pluginsFresh({ calendar: { state: "disabled", cannotEnable: "要的东西没有谁提供" } }));
    expect(rows.find((r) => r.id === "calendar")).toMatchObject({ status: "locked", note: "要的东西没有谁提供" });
  });
});

describe("勾上之后调哪些接口", () => {
  test("不勾语音时不碰语音相关的东西：只装向量模型", async () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh());
    const { api, calls, licenses } = fakeApi();
    const plan = capabilityPlan(rows, defaultTicked(rows));
    const result = await applyCapabilities(plan, rows, api);
    expect(calls).toEqual(["component bge-m3 install"]);
    expect(licenses).toEqual([]);
    expect(result.failures.size).toBe(0);
  });

  test("勾语音合成：先过确认框，同意了才带确认标记去装；audio.cpp 由守护进程跟着装，这里不单独发", async () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh());
    const { api, calls, licenses } = fakeApi();
    await applyCapabilities(capabilityPlan(rows, new Set(["component:tts"])), rows, api);
    expect(licenses).toEqual(["tts"]);
    expect(calls).toEqual(["component tts install accepted"]);
  });

  test("确认框点了取消：不发请求、不下载，记成没同意；别的项照做", async () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh());
    const { api, calls } = fakeApi({ accept: false });
    const result = await applyCapabilities(capabilityPlan(rows, new Set(["component:tts", "component:bge-m3"])), rows, api);
    expect(calls).toEqual(["component bge-m3 install"]);
    expect(result.declined).toEqual(["component:tts"]);
  });

  test("确认过的不再问（清单写着 accepted）", async () => {
    const view = fresh({ tts: { license: { name: "Fish", summary: "s", url: "https://x", confirm: true, accepted: true } } });
    const rows = capabilityRows(view, pluginsFresh());
    const { api, calls, licenses } = fakeApi();
    await applyCapabilities(capabilityPlan(rows, new Set(["component:tts"])), rows, api);
    expect(licenses).toEqual([]);
    expect(calls).toEqual(["component tts install"]);
  });

  test("停着的插件走启用接口，先于组件；一项失败不挡别的项，原因记在那一行", async () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh({ memory: { state: "disabled" }, voice: { state: "disabled" } }));
    const { api, calls } = fakeApi({ fail: { memory: "正忙", "bge-m3": "没接上服务管家" } });
    const result = await applyCapabilities(capabilityPlan(rows, new Set(["plugin:memory", "plugin:voice", "component:bge-m3", "component:tts"])), rows, api);
    expect(calls).toEqual(["plugin memory enable", "plugin voice enable", "component bge-m3 install", "component tts install accepted"]);
    expect([...result.failures]).toEqual([
      ["plugin:memory", "正忙"],
      ["component:bge-m3", "没接上服务管家"],
    ]);
    expect(result.plugins?.map((p) => p.name)).toEqual(["voice"]);
  });

  test("Claude Code 没装 SDK：勾它先下 SDK，装好才启用（afterInstall）；不算直接启用", () => {
    const view = fresh();
    const rows = capabilityRows(view, pluginsFresh());
    expect(rows.find((r) => r.id === "claude-code")).toMatchObject({ status: "available", download: 110, component: { id: "claude-code" } });
    const plan = capabilityPlan(rows, new Set(["plugin:claude-code"]));
    expect(plan.plugins).toEqual([]);
    expect(plan.afterInstall).toEqual(["claude-code"]);
    expect(plan.components.map((c) => c.id)).toEqual(["claude-code"]);
    // SDK 装好了：这一行变成能直接启用（页面上等着的就去启用）
    const after = capabilityRows(fresh({ "claude-code": { state: "installed" } }), pluginsFresh());
    const row = after.find((r) => r.id === "claude-code");
    expect(row).toMatchObject({ status: "available", download: 0 });
    expect(row?.component).toBeUndefined();
  });

  test("没勾的、已经有了的都不做", () => {
    const rows = capabilityRows(fresh({ "bge-m3": { state: "installed" } }), pluginsFresh());
    expect(capabilityPlan(rows, new Set(["component:bge-m3", "plugin:memory"]))).toEqual({ plugins: [], components: [], afterInstall: [] });
  });
});

describe("进度和失败", () => {
  test("正在下、排队的算 working，每秒要重取；出错了、暂停了算 stopped", () => {
    expect(capabilityRows(fresh({ "bge-m3": { state: "downloading" } }), []).find((r) => r.id === "bge-m3")?.status).toBe("working");
    expect(capabilityRows(fresh({ "bge-m3": { state: "queued" } }), []).find((r) => r.id === "bge-m3")?.status).toBe("working");
    expect(capabilityRows(fresh({ "bge-m3": { state: "failed", error: "下不下来" } }), []).find((r) => r.id === "bge-m3")?.status).toBe("stopped");
    expect(capabilityRows(fresh({ "bge-m3": { state: "paused" } }), []).find((r) => r.id === "bge-m3")?.status).toBe("stopped");
    expect(capabilityActive(fresh({ "bge-m3": { state: "downloading" } }))).toBe(true);
    expect(capabilityActive(fresh({ audiocpp: { state: "installed", service: { state: "starting", port: 8090, autostart: false } } }))).toBe(true);
    expect(capabilityActive(fresh())).toBe(false);
    expect(capabilityActive(undefined)).toBe(false);
  });

  test("模型排着队、程序正在下：进度看程序；程序下不下来：把程序真正的原因带上", () => {
    const view = fresh({ tts: { state: "queued" }, audiocpp: { state: "downloading" } });
    expect(progressOwner(view.components.find((c) => c.id === "tts")!, view.components).id).toBe("audiocpp");
    expect(progressOwner(view.components.find((c) => c.id === "audiocpp")!, view.components).id).toBe("audiocpp");
    const failed = fresh({ tts: { state: "failed", error: "要先装好语音程序" }, audiocpp: { state: "failed", error: "GitHub 连不上" } });
    expect(stoppedDependency(failed.components.find((c) => c.id === "tts")!, failed.components)?.error).toBe("GitHub 连不上");
  });

  test("重试：依赖停着的先接着下，再是它自己；要确认许可的照样过确认框", async () => {
    const view = fresh({ tts: { state: "failed", error: "要先装好语音程序" }, audiocpp: { state: "failed", error: "GitHub 连不上" } });
    const tts = view.components.find((c) => c.id === "tts")!;
    const { api, calls, licenses } = fakeApi({ view });
    await retryCapability(tts, view.components, api);
    expect(calls).toEqual(["component audiocpp resume", "component tts resume accepted"]);
    expect(licenses).toEqual(["tts"]);
  });

  test("重试时没同意许可：不发请求", async () => {
    const view = fresh({ tts: { state: "failed" } });
    const tts = view.components.find((c) => c.id === "tts")!;
    const { api, calls } = fakeApi({ accept: false });
    expect(await retryCapability(tts, view.components, api)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("现在装了什么", () => {
  test("装好的、别处已有的组件，运行中的插件（不止这一步列的那几个）", () => {
    const now = installedNow(fresh({ "bge-m3": { state: "installed", installedVersion: "4de1" }, tts: { state: "provided" }, asr: { state: "downloading" } }), pluginsFresh({ voice: { state: "disabled" } }));
    expect(now.components.map((c) => c.id)).toEqual(["bge-m3", "tts"]);
    expect(now.plugins.map((p) => p.name)).toEqual(["reminders", "memory", "calendar", "browsing", "phone"]);
    expect(installedNow(undefined, undefined)).toEqual({ components: [], plugins: [] });
  });
});
