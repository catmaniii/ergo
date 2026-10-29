// 337 号票第一段：记忆插件宿主。只验宿主规矩（单活、切换、数据目录、版本、转发、简报回落），
// 不碰真的守护进程、会意插件和模型：临时目录 + 两个假插件（test/memory/provider/），llm/embed/identity 是宿主注入的回调。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryItem } from "@ergo/protocol";
import { createMemoryHost, createMemoryProviderRegistry, type MemoryHost, type MemoryHostOptions, type MemoryProviderFactory } from "../../src/memory/provider/host.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeA } from "./provider/fake-a.ts";
import { fakeB } from "./provider/fake-b.ts";

/** 假时钟（宿主给插件的 ctx.now() 就是它） */
const NOW = new Date("2026-10-28T09:00:00.000Z");

/** 一个宿主：注册表里放给的假插件；身份、时钟、日志都是固定的 */
function makeHost(rootDir: string, factories: readonly MemoryProviderFactory[], extra: Partial<MemoryHostOptions> = {}): MemoryHost {
  const registry = createMemoryProviderRegistry();
  for (const factory of factories) registry.register(factory);
  return createMemoryHost({
    rootDir,
    registry,
    identity: () => ({ language: "zh", userName: "小明", assistantName: "二狗" }),
    now: () => NOW,
    log: () => {},
    ...extra,
  });
}

/** 数组的第一个（没有就报错，省得每处都写 ?. 和 !） */
function firstOf<T>(list: readonly T[]): T {
  const value = list[0];
  if (value === undefined) throw new Error("这里本该至少有一条");
  return value;
}

/** 一条通用条目 */
function itemOf(id: string, text: string, sources: MemoryItem["sources"] = []): MemoryItem {
  return { id, kind: "note", text, createdAt: "2026-10-28T09:00:00.000Z", sources };
}

describe("记忆插件宿主（337 号票）", () => {
  it("同时只有一个在跑：激活乙时先把甲停掉，之后的调用都走乙", async () => {
    const root = makeTempDir();
    const a = fakeA();
    const b = fakeB();
    const host = makeHost(root, [a.factory, b.factory]);

    await host.activate("fake-a");
    expect(host.active()).toBe("fake-a");
    expect(host.info()?.id).toBe("fake-a");
    const providerA = firstOf(a.instances);
    expect(providerA.starts).toHaveLength(1);

    await host.activate("fake-b");
    expect(host.active()).toBe("fake-b");
    // 旧的停了（stop 调过一次），它拿到的 signal 也叫停了
    expect(providerA.stops).toBe(1);
    expect(firstOf(providerA.starts).signal.aborted).toBe(true);

    await host.search({ text: "香菜" });
    expect(providerA.searches).toHaveLength(0);
    expect(firstOf(b.instances).searches).toEqual([{ text: "香菜" }]);
  });

  it("同一个 id 再激活直接返回，不重启", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);

    await host.activate("fake-a");
    await host.activate("fake-a");

    expect(a.instances).toHaveLength(1);
    expect(firstOf(a.instances).starts).toHaveLength(1);
    expect(firstOf(a.instances).stops).toBe(0);
    expect(host.active()).toBe("fake-a");
  });

  it("数据目录按 id 分开（<根目录>/memory/<id>/），目录里能写；换走以后旧的原样留着", async () => {
    const root = makeTempDir();
    const a = fakeA();
    const b = fakeB();
    const host = makeHost(root, [a.factory, b.factory]);

    expect(host.dataDir("fake-a")).toBe(path.join(root, "memory", "fake-a"));
    await host.activate("fake-a");
    expect(firstOf(firstOf(a.instances).starts).dataDir).toBe(host.dataDir("fake-a"));
    expect(fs.readFileSync(path.join(host.dataDir("fake-a"), "started.txt"), "utf8")).toBe("fake-a");

    await host.activate("fake-b");
    expect(fs.readFileSync(path.join(root, "memory", "fake-b", "started.txt"), "utf8")).toBe("fake-b");
    // 甲的数据目录不动（换插件不迁移、不删）
    expect(fs.readFileSync(path.join(root, "memory", "fake-a", "started.txt"), "utf8")).toBe("fake-a");
    expect(fs.existsSync(path.join(root, "memory", "fake-a"))).toBe(true);
  });

  it("search / remember / forget / health（还有 observe）都转到当前插件", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);
    await host.activate("fake-a");

    const saved = await host.remember({ text: "记住我不吃香菜", sources: [{ kind: "message", id: "m-3" }] });
    expect(saved).toMatchObject({ id: "a-1", kind: "note", text: "记住我不吃香菜", sources: [{ kind: "message", id: "m-3" }] });

    const found = await host.search({ text: "香菜", limit: 5 });
    expect(found.items.map((item) => item.id)).toEqual(["a-1"]);

    expect(await host.forget({ source: { kind: "message", id: "m-3" } })).toEqual({ removed: 1 });
    expect(await host.health()).toEqual({ items: 1, bytes: 12 });

    const observed = await host.observe({ at: "2026-10-28T09:00:00.000Z", source: { kind: "message", id: "m-4" }, text: "用户说他不吃香菜" });
    expect(observed.status).toBe("stored");

    // 插件那一侧真的收到了这些调用
    const provider = firstOf(a.instances);
    expect(provider.remembered).toEqual([{ text: "记住我不吃香菜", sources: [{ kind: "message", id: "m-3" }] }]);
    expect(provider.searches).toEqual([{ text: "香菜", limit: 5 }]);
    expect(provider.forgot).toEqual([{ source: { kind: "message", id: "m-3" } }]);
    expect(provider.observed).toHaveLength(1);
  });

  it("没有激活时调用报错（not_found），认不出的 id 也是", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);

    expect(host.active()).toBeUndefined();
    expect(host.info()).toBeUndefined();
    // 简报是可选能力：没有在跑就是"这一轮不带"，不抛
    await expect(host.brief({ text: "今天下雨" })).resolves.toBeUndefined();

    const calls: (() => Promise<unknown>)[] = [
      () => host.search({ text: "香菜" }),
      () => host.remember({ text: "记住我不吃香菜" }),
      () => host.forget({ all: true }),
      () => host.health(),
      () => host.observe({ at: "2026-10-28T09:00:00.000Z", source: { kind: "message", id: "m-3" }, text: "原话" }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "not_found" });

    await expect(host.activate("fake-nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("插件写的 api 版本对不上就不启用，说清宿主认哪个、它写的是哪个", async () => {
    const a = fakeA();
    const bad = fakeB({ api: 2 });
    const host = makeHost(makeTempDir(), [a.factory, bad.factory]);

    await expect(host.activate("fake-b")).rejects.toMatchObject({ code: "conflict" });
    await expect(host.activate("fake-b")).rejects.toThrow(/接口版本对不上.*认 1.*写的是 2/);
    // 拒绝在造实例之前：连 start 都没走到
    expect(bad.instances).toHaveLength(0);
    expect(host.active()).toBeUndefined();

    // 已经在跑的那套不受影响（版本不对的那个根本没轮到停旧的）
    await host.activate("fake-a");
    await expect(host.activate("fake-b")).rejects.toMatchObject({ code: "conflict" });
    expect(host.active()).toBe("fake-a");
    expect(firstOf(a.instances).stops).toBe(0);
  });

  it("插件没声明 brief 时，宿主用 search 拼一段带出处的简报（没出处的条目不进）", async () => {
    const b = fakeB();
    const host = makeHost(makeTempDir(), [b.factory]);
    await host.activate("fake-b");
    const provider = firstOf(b.instances);
    provider.result = [itemOf("b-1", "用户不吃香菜", [{ kind: "message", id: "m-3" }]), itemOf("b-2", "一条没有出处的推断")];

    const result = await host.brief({ text: "晚上吃什么" });
    // 宿主按这一轮的话去搜，取前 3 条
    expect(provider.searches).toEqual([{ text: "晚上吃什么", limit: 3 }]);
    // 回落拼出来的没有去重的键、也没有结构化那两样（337 号票：统一成一份）
    expect(result).toMatchObject({ keys: {}, items: [], hits: [] });
    expect(result!.text).toContain("【记忆简报】");
    expect(result!.text).toContain("用户不吃香菜");
    expect(result!.text).toContain("message m-3"); // 每条都带出处
    expect(result!.text).not.toContain("一条没有出处的推断"); // 没有出处的不进简报

    // 搜不到就这一轮不带
    provider.result = [];
    await expect(host.brief({ text: "晚上吃什么" })).resolves.toBeUndefined();
  });

  it("插件声明了 brief 就用插件自己的，不再回落去 search（只回字符串的老实现照样收：keys 是空的）", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);
    await host.activate("fake-a");

    await expect(host.brief({ text: "今天下雨" })).resolves.toEqual({ text: "甲的简报：今天下雨", keys: {}, items: [], hits: [] });
    expect(firstOf(a.instances).searches).toHaveLength(0);
  });

  it("插件回一份（正文 + 键 + 结构化那两样）时原样交给调用方", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);
    await host.activate("fake-a");
    firstOf(a.instances).briefResult = {
      text: "甲的简报：周末的安排",
      keys: { "note:a-1": "abcdef012345" },
      items: [{ key: "note:a-1", kind: "claim", reason: "direct", claimIds: ["a-1"], routes: ["upward"] }],
      hits: [{ materialId: "m-9", kind: "user_utterance", time: "2026-10-28T09:00:00.000Z" }],
    };

    // known 原样交给插件（宿主不解释那套键）
    const result = await host.brief({ text: "周末的安排", known: { "claim:cl-0001": "0123456789ab" } });
    expect(firstOf(a.instances).briefs).toEqual([{ text: "周末的安排", known: { "claim:cl-0001": "0123456789ab" } }]);
    expect(result).toEqual({
      text: "甲的简报：周末的安排",
      keys: { "note:a-1": "abcdef012345" },
      items: [{ key: "note:a-1", kind: "claim", reason: "direct", claimIds: ["a-1"], routes: ["upward"] }],
      hits: [{ materialId: "m-9", kind: "user_utterance", time: "2026-10-28T09:00:00.000Z" }],
    });
    // 没有回落去 search
    expect(firstOf(a.instances).searches).toHaveLength(0);
  });

  it("停用以后不能再用；再启用是新的实例、数据目录还在", async () => {
    const root = makeTempDir();
    const a = fakeA();
    const host = makeHost(root, [a.factory]);
    await host.activate("fake-a");
    const providerA = firstOf(a.instances);

    await host.deactivate();
    expect(host.active()).toBeUndefined();
    expect(providerA.stops).toBe(1);
    expect(firstOf(providerA.starts).signal.aborted).toBe(true);

    await expect(host.search({ text: "香菜" })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.remember({ text: "记住我不吃香菜" })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.forget({ all: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.health()).rejects.toMatchObject({ code: "not_found" });

    // 再停一次没事（不重复 stop、不抛）
    await host.deactivate();
    expect(providerA.stops).toBe(1);

    // 再启用：新的实例，数据目录还是那一个
    await host.activate("fake-a");
    expect(a.instances).toHaveLength(2);
    expect(host.active()).toBe("fake-a");
    expect(fs.existsSync(path.join(host.dataDir("fake-a"), "started.txt"))).toBe(true);
  });

  it("插件没起来（start 抛错）时不留半开的实例：activate 报错、宿主仍是空的", async () => {
    const a = fakeA({ failStart: true });
    const host = makeHost(makeTempDir(), [a.factory]);

    await expect(host.activate("fake-a")).rejects.toThrow(/起不来/);
    // 起来失败的实例收过尾，宿主不认它
    expect(firstOf(a.instances).stops).toBe(1);
    expect(host.active()).toBeUndefined();
    await expect(host.search({ text: "香菜" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("插件上下文里的 identity / llm / embed / now / signal 都是宿主注入的那几个（这一段不接真模型）", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory], {
      llm: async (request) => `答：${request.prompt}`,
      embed: async (texts) => texts.map(() => [0.1, 0.2]),
    });
    await host.activate("fake-a");
    const ctx = firstOf(firstOf(a.instances).starts);

    expect(ctx.now()).toBe(NOW);
    expect(ctx.identity()).toEqual({ language: "zh", userName: "小明", assistantName: "二狗" });
    await expect(ctx.llm({ prompt: "你好" })).resolves.toBe("答：你好");
    await expect(ctx.embed(["一", "二"])).resolves.toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
    expect(ctx.signal.aborted).toBe(false);
  });

  it("没注入模型调用时，插件调 ctx.llm / ctx.embed 报 not_implemented", async () => {
    const a = fakeA();
    const host = makeHost(makeTempDir(), [a.factory]);
    await host.activate("fake-a");
    const ctx = firstOf(firstOf(a.instances).starts);

    await expect(ctx.llm({ prompt: "你好" })).rejects.toMatchObject({ code: "not_implemented" });
    await expect(ctx.embed(["一"])).rejects.toMatchObject({ code: "not_implemented" });
  });
});
