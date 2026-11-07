// "和二狗有关"的判定（428，设置 · 服务和体检共用）：五条规则各自认得出、别的服务一个都不带。
import { describe, expect, it } from "vitest";
import { type ErgoRelatedService, ergoRelated, localPortOf } from "../src/index.ts";

/** 照用户这台的样子编：二狗经 ergo-tunnel 出网、开着 tailnet 入口、软依赖手工登记的 audiocpp；混着和二狗无关的 */
const SERVICES: ErgoRelatedService[] = [
  { id: "drama-server", port: 3000, state: "RUNNING" },
  { id: "ergo-daemon", port: 8810, state: "RUNNING", via: "ergo-tunnel", tailnet: true, dependsOn: [{ id: "audiocpp", type: "soft" }] },
  { id: "ergo-tunnel", port: null, role: "tunnel", state: "RUNNING", dependsOn: [{ id: "net-up", type: "hard" }, { id: "metrics", type: "soft" }] },
  { id: "net-up", port: 9100, state: "RUNNING" },
  { id: "metrics", port: 9200, state: "RUNNING" },
  { id: "tail-gw", port: 9300, state: "RUNNING" },
  { id: "audiocpp", port: 8090, state: "STOPPED" },
  { id: "ergo-asr", port: 8091, state: "RUNNING" },
  { id: "ergo-daemon--p-1-web", port: 18080, state: "RUNNING" },
  { id: "comfyui", port: 8188, state: "RUNNING", via: "comfy-tunnel" },
  { id: "comfy-tunnel", port: 8090, role: "tunnel", state: "RUNNING" },
  { id: "notes-sync", port: 7000, state: "STOPPED", ergo: true },
  { id: "old-tts", port: 8091, state: "STOPPED" },
];

const CTX = { self: "ergo-daemon", speechPort: 8090, recognizerPort: 8091, tailnetGateway: "tail-gw" };

describe("和二狗有关的服务", () => {
  it("五条规则：二狗自己、名下的、语音按端口对上的、隧道 / 网关 / 依赖（连同隧道的硬依赖）、标了 ergo: true 的；二狗自己在最前", () => {
    const related = ergoRelated(SERVICES, CTX);
    expect([...related]).toEqual([
      ["ergo-daemon", ["self"]],
      ["audiocpp", ["speech", "dependency"]],
      ["ergo-asr", ["recognizer"]],
      ["ergo-tunnel", ["tunnel"]],
      ["tail-gw", ["gateway"]],
      ["net-up", ["dependency"]],
      ["ergo-daemon--p-1-web", ["owned"]],
      ["notes-sync", ["marked"]],
    ]);
  });

  it("和二狗无关的一个都不带：别的项目、它们的隧道、隧道的软依赖、同一个端口上没在跑的旧登记", () => {
    const related = ergoRelated(SERVICES, CTX);
    expect(["drama-server", "comfyui", "comfy-tunnel", "metrics", "old-tts"].filter((id) => related.has(id))).toEqual([]);
  });

  it("没在用语音、没开 tailnet、没有隧道时那几条就没有；服务管家不知道 tailnet 网关（老版本）时网关不算", () => {
    const bare = SERVICES.map((s) => (s.id === "ergo-daemon" ? { id: s.id, port: 8810, state: "RUNNING" } : s));
    expect([...ergoRelated(bare, { self: "ergo-daemon" }).keys()]).toEqual(["ergo-daemon", "ergo-daemon--p-1-web", "notes-sync"]);
    expect(ergoRelated(SERVICES, { ...CTX, tailnetGateway: undefined }).has("tail-gw")).toBe(false);
  });

  it("同一个端口登记了几个：挑在跑的那个；都没在跑挑第一个", () => {
    const twins: ErgoRelatedService[] = [
      { id: "ergo-daemon", port: 8810 },
      { id: "tts-old", port: 8090, state: "STOPPED" },
      { id: "tts-new", port: 8090, state: "RUNNING" },
    ];
    expect([...ergoRelated(twins, { self: "ergo-daemon", speechPort: 8090 }).keys()]).toEqual(["ergo-daemon", "tts-new"]);
    const stopped = twins.map((s) => ({ ...s, state: "STOPPED" }));
    expect([...ergoRelated(stopped, { self: "ergo-daemon", speechPort: 8090 }).keys()]).toEqual(["ergo-daemon", "tts-old"]);
  });

  it("写了却没登记的（隧道、网关、依赖不在列表里）不算；依赖回到二狗自己不打转", () => {
    const loose: ErgoRelatedService[] = [
      { id: "ergo-daemon", via: "gone-tunnel", tailnet: true, dependsOn: [{ id: "gone" }, { id: "loop" }] },
      { id: "loop", dependsOn: [{ id: "ergo-daemon", type: "hard" }, { id: "loop", type: "hard" }] },
    ];
    expect([...ergoRelated(loose, { self: "ergo-daemon", tailnetGateway: "gone-gw" })]).toEqual([
      ["ergo-daemon", ["self"]],
      ["loop", ["dependency"]],
    ]);
  });

  it("二狗不在服务管家的列表里（不是它拉起来的）：只剩名下的和标了的", () => {
    expect([...ergoRelated(SERVICES.filter((s) => s.id !== "ergo-daemon"), CTX).keys()]).toEqual(["audiocpp", "ergo-asr", "ergo-daemon--p-1-web", "notes-sync"]);
  });

  it("本机地址才交回端口", () => {
    expect(localPortOf("http://127.0.0.1:8090")).toBe(8090);
    expect(localPortOf("http://localhost:8091/asr")).toBe(8091);
    expect(localPortOf("http://[::1]:7000")).toBe(7000);
    expect(localPortOf("http://127.0.0.1")).toBe(80);
    expect(localPortOf("https://localhost")).toBe(443);
    expect(localPortOf("http://192.168.1.5:8090")).toBeUndefined();
    expect(localPortOf("不是地址")).toBeUndefined();
  });
});
