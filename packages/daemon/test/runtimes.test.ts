// agent 运行时的登记表（286 号票，runtime/runtimes.ts）：pi 照运行时的接口登记、一直能用；插件登记的带上插件，能不能用跟着插件
// 在不在运行（不能用的写明"X插件没启用"）；不认得的运行时也算不能用；拉起时解析子进程入口；给网页的清单 pi 在最前；登记时查规矩。
import { RUNTIME_OPERATIONS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../src/errors.ts";
import { createRuntimeRegistry, piRuntime, type RuntimeOwner } from "../src/runtime/index.ts";
import { PI_CHILD_ENTRY } from "../src/runtime/agent-process.ts";
import { FAKE_RUNTIME_ENTRY, fakeRuntime } from "./helpers/fake-runtime.ts";

/** 一个开关得了的"插件" */
function owner(title = "假运行时"): RuntimeOwner & { on: boolean } {
  return {
    on: true,
    plugin: "fake-runtime",
    title,
    running() {
      return this.on;
    },
  };
}

function registry() {
  const logs: string[] = [];
  const runtimes = createRuntimeRegistry({ log: (line) => logs.push(line) });
  runtimes.register(piRuntime);
  return { runtimes, logs };
}

describe("agent 运行时的登记表", () => {
  it("pi 照运行时的接口登记：子进程入口是 agent-child/main，一直能用，能力清单逐项写明", () => {
    const { runtimes } = registry();
    expect(runtimes.resolve("pi").entry).toBe(PI_CHILD_ENTRY);
    expect(runtimes.unavailable("pi")).toBeUndefined();
    expect(Object.keys(piRuntime.capabilities).toSorted()).toEqual([...RUNTIME_OPERATIONS].toSorted());
    expect(runtimes.supports("pi", "rollback")).toBe(true);
    expect(runtimes.supports("pi", "slash_passthrough")).toBe(false);
    expect(runtimes.supports("pi", "take_over")).toBe(false);
  });

  it("插件登记的：能不能用跟着插件在不在运行，不能用时写明哪个插件没启用、拉起时抛 not_allowed；再启用照常", () => {
    const { runtimes } = registry();
    const plugin = owner();
    runtimes.register(fakeRuntime, plugin);
    expect(runtimes.resolve("fake").entry).toBe(FAKE_RUNTIME_ENTRY);
    plugin.on = false;
    expect(runtimes.unavailable("fake")).toEqual({ reason: "假运行时插件没启用", plugin: "假运行时" });
    expect(() => runtimes.resolve("fake")).toThrow(RequestRejected);
    expect(() => runtimes.resolve("fake")).toThrow("假运行时插件没启用");
    // 停用了也认得、照它登记的说能做什么
    expect(runtimes.get("fake")).toBe(fakeRuntime);
    expect(runtimes.supports("fake", "interject")).toBe(true);
    plugin.on = true;
    expect(runtimes.unavailable("fake")).toBeUndefined();
  });

  it("不认得的运行时（登记它的插件不在清单里了）也算不能用，写明没有这个运行时", () => {
    const { runtimes } = registry();
    expect(runtimes.unavailable("codex")).toEqual({ reason: "没有运行时「codex」（登记它的插件不在了）", plugin: "codex" });
    expect(() => runtimes.resolve("codex")).toThrow("没有运行时「codex」");
    expect(runtimes.supports("codex", "interject")).toBe(false);
  });

  it("给网页的清单：pi 在最前，插件的带插件名、能不能用和原因、能力清单、可选模型、设置项", () => {
    const { runtimes } = registry();
    const plugin = owner();
    runtimes.register(fakeRuntime, plugin);
    plugin.on = false;
    const view = runtimes.view();
    expect(view.runtimes.map((r) => r.id)).toEqual(["pi", "fake"]);
    expect(view.runtimes[0]).toEqual({ id: "pi", title: "pi", available: true, capabilities: { ...piRuntime.capabilities }, settings: [] });
    expect(view.runtimes[1]).toEqual({
      id: "fake",
      title: "假运行时",
      plugin: "fake-runtime",
      available: false,
      unavailable: "假运行时插件没启用",
      capabilities: { ...fakeRuntime.capabilities },
      models: [{ id: "fake-1", title: "假模型一号" }],
      settings: [{ id: "mode", title: "模式", options: [{ value: "calm", title: "稳" }, { value: "fast", title: "快" }], default: "calm" }],
    });
  });

  it("列能接管的会话（290 号票）：能接管、能用才列；不能接管、停用了的回 not_allowed 和原因", async () => {
    const { runtimes } = registry();
    const plugin = owner();
    runtimes.register(fakeRuntime, plugin);
    expect(await runtimes.sessions("fake")).toEqual([{ id: "s-1", title: "以前的会话", cwd: "D:/work/demo", updatedAt: "2026-10-25T09:00:00+08:00" }]);
    await expect(runtimes.sessions("pi")).rejects.toThrow("pi不能接管已有的会话");
    plugin.on = false;
    await expect(runtimes.sessions("fake")).rejects.toThrow("假运行时插件没启用");
  });

  it("登记时查规矩：id 不合规矩、重复了、能力清单没写全、说能接管却没给 sessions 都抛错；撤销后不在了", () => {
    const { runtimes } = registry();
    expect(() => runtimes.register({ ...fakeRuntime, id: "Claude Code" })).toThrow("运行时的 id 不合规矩");
    expect(() => runtimes.register({ ...piRuntime })).toThrow("运行时 pi 已经登记过了");
    const { interject: _i, ...partial } = fakeRuntime.capabilities;
    expect(() => runtimes.register({ ...fakeRuntime, capabilities: partial as typeof fakeRuntime.capabilities })).toThrow("能力清单没写全：interject");
    const { sessions: _s, ...noSessions } = fakeRuntime;
    expect(() => runtimes.register(noSessions)).toThrow("说能接管已有会话，却没给全 sessions()");
    const undo = runtimes.register(fakeRuntime, owner());
    expect(runtimes.get("fake")).toBeDefined();
    undo();
    expect(runtimes.get("fake")).toBeUndefined();
  });

  it("changed() 通知订阅的（插件运行中停用、启用时组合根叫）；订阅出错只记日志，不拦着别的", () => {
    const { runtimes, logs } = registry();
    const seen: string[] = [];
    runtimes.onChange(() => {
      throw new Error("坏了");
    });
    const off = runtimes.onChange(() => seen.push("a"));
    runtimes.changed();
    expect(seen).toEqual(["a"]);
    expect(logs.some((l) => l.includes("坏了"))).toBe(true);
    off();
    runtimes.changed();
    expect(seen).toEqual(["a"]);
  });
});
