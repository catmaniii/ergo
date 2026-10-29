// 维护者的运行时闸门（286 号票，agent-host/runtime-gate.ts）：维护者照它的运行时属性（没写是 pi）；运行时插件没在运行时 off 写明原因；
// held 要等维护者做完手头那一轮；能不能用变了、运行时不能用的维护者做完了那一轮都通知。
import { describe, expect, it } from "vitest";
import { createRuntimeGate } from "../../src/agent-host/runtime-gate.ts";
import { createRuntimeRegistry, piRuntime } from "../../src/runtime/index.ts";
import { fakeRuntime } from "../helpers/fake-runtime.ts";

function setup() {
  const runtimes = createRuntimeRegistry({ log: () => {} });
  runtimes.register(piRuntime);
  const plugin = { on: true };
  runtimes.register(fakeRuntime, { plugin: "fake-runtime", title: "假运行时", running: () => plugin.on });
  const runtimeOf: Record<string, string | undefined> = { "tm-1": "fake", "tm-2": undefined, "pm-1": "fake" };
  const gate = createRuntimeGate({ registry: runtimes, runtimeOf: (id) => runtimeOf[id], log: () => {} });
  const changes: number[] = [];
  gate.onChange(() => changes.push(changes.length + 1));
  return { runtimes, plugin, gate, changes };
}

describe("维护者的运行时闸门", () => {
  it("维护者照它的运行时属性，没写是 pi；pi 一直能用", () => {
    const { gate, plugin } = setup();
    expect(gate.runtimeOf("tm-1")).toBe("fake");
    expect(gate.runtimeOf("tm-2")).toBe("pi");
    expect(gate.runtimeOf("tm-9")).toBe("pi");
    plugin.on = false;
    expect(gate.off("tm-2")).toBeUndefined();
    expect(gate.held("tm-2")).toBeUndefined();
  });

  it("运行时插件停用：off、held 写明哪个插件没启用；手头在做一轮的先不 held，做完了才 held 并通知；启用了都清掉", () => {
    const { gate, plugin, runtimes, changes } = setup();
    expect(gate.off("tm-1")).toBeUndefined();
    gate.setBusy("tm-1", true);
    plugin.on = false;
    runtimes.changed();
    expect(changes).toHaveLength(1);
    expect(gate.off("tm-1")).toEqual({ reason: "假运行时插件没启用", plugin: "假运行时" });
    // 手头那一轮还在做：先不转等我
    expect(gate.held("tm-1")).toBeUndefined();
    expect(gate.held("pm-1")).toEqual({ reason: "假运行时插件没启用", plugin: "假运行时" });
    gate.setBusy("tm-1", false);
    expect(changes).toHaveLength(2);
    expect(gate.held("tm-1")).toEqual({ reason: "假运行时插件没启用", plugin: "假运行时" });
    // 运行时能用时做完一轮不通知
    plugin.on = true;
    runtimes.changed();
    expect(changes).toHaveLength(3);
    gate.setBusy("tm-1", true);
    gate.setBusy("tm-1", false);
    expect(changes).toHaveLength(3);
    expect(gate.held("tm-1")).toBeUndefined();
  });

  it("309 号票：范围审视由二狗另起的运行时照它登记的（recordedScopeReview）；运行时报过的斜杠命令名按维护者、它还没跑过时用这个运行时最近报的", () => {
    const { gate, runtimes } = setup();
    runtimes.register({ ...fakeRuntime, id: "fake-recorded", recordedScopeReview: true });
    expect(gate.recordedScopeReview("fake-recorded")).toBe(true);
    expect(gate.recordedScopeReview("fake")).toBe(false);
    expect(gate.recordedScopeReview("pi")).toBe(false);
    expect(gate.commandsOf("fake", "tm-1")).toEqual([]);
    runtimes.noteCatalog("fake", "tm-1", { commands: [{ name: "compact", description: "压缩" }, { name: "review", description: "评审" }] });
    expect(gate.commandsOf("fake", "tm-1")).toEqual(["compact", "review"]);
    expect(gate.commandsOf("fake", "pm-1")).toEqual(["compact", "review"]);
  });
});
