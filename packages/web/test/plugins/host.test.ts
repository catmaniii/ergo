// 网页插件宿主（193 号票，ADR-0027 的网页插槽，plugins/host.ts）：类型化插槽的登记和撤销、按守护进程报的状态装和停、
// 停用的插件拥有的位置给占位用的名字。照守护进程的插件宿主（packages/daemon/src/plugins/host.ts）借 Cordis 的规矩：
// 每次登记都返回撤销函数、记在插件名下，停用时倒着撤，停了以后再经它登记直接报错。
import { describe, expect, test } from "vitest";
import { createWebPluginHost, type WebPluginDefinition } from "../../src/plugins/host.ts";
import type { CardSlot, ChatItemSlot, PageSlot, SettingsSectionSlot } from "../../src/plugins/slots.ts";

const Nothing = () => null;

const page = (id: string, order: number): PageSlot => ({
  id,
  order,
  icon: "layers",
  get navLabel() {
    return id;
  },
  get title() {
    return id;
  },
  get sub() {
    return id;
  },
  Section: Nothing,
  Column: Nothing,
});
const card = (type: string): CardSlot => ({ type, Card: Nothing });
const chatItem = (kind: ChatItemSlot["kind"]): ChatItemSlot => ({ kind, Item: Nothing });
const section = (id: string, order: number): SettingsSectionSlot => ({ id, order, Section: Nothing });

/** 一个笔记插件：一页、一种卡、一种对话条目；trace 记下登记和撤销的先后 */
function notes(trace: string[] = []): WebPluginDefinition {
  return {
    name: "notes",
    get title() {
      return "笔记";
    },
    owns: { pages: ["notes"], cards: ["note"], chatItems: ["recall"] },
    setup(ctx) {
      trace.push("setup");
      ctx.register("pages", page("notes", 85));
      ctx.register("cards", card("note"));
      ctx.register("chatItems", chatItem("recall"));
      ctx.effect(() => {
        trace.push("effect");
        return () => trace.push("effect undone");
      });
    },
  };
}

function hostOf(plugins: readonly WebPluginDefinition[]) {
  const logs: string[] = [];
  const host = createWebPluginHost({ plugins, log: (line) => logs.push(line) });
  return { host, logs };
}

describe("插槽的登记和撤销", () => {
  test("一建好就按全开装上（还没收到守护进程报的状况时当作全开）：登记的都取得到，按插槽的键取、按 order 排", () => {
    const tidy: WebPluginDefinition = {
      name: "tidy",
      title: "整理",
      owns: { pages: ["tidy"], settingsSections: ["tidy-a", "tidy-b"] },
      setup(ctx) {
        ctx.register("settingsSections", section("tidy-b", 20));
        ctx.register("settingsSections", section("tidy-a", 10));
        ctx.register("pages", page("tidy", 75));
      },
    };
    const { host } = hostOf([notes(), tidy]);
    expect(host.running("notes")).toBe(true);
    expect(host.get("cards", "note")?.type).toBe("note");
    expect(host.get("cards", "other")).toBeUndefined();
    expect(host.list("pages").map((p) => p.id)).toEqual(["tidy", "notes"]);
    expect(host.list("settingsSections").map((s) => s.id)).toEqual(["tidy-a", "tidy-b"]);
  });

  test("停用：它登记的全部倒着撤掉（effect 交回的撤销函数也叫），别的插件的不动；再启用重新装配", () => {
    const trace: string[] = [];
    const other: WebPluginDefinition = { name: "other", title: "别的", owns: { cards: ["other"] }, setup: (ctx) => void ctx.register("cards", card("other")) };
    const { host } = hostOf([notes(trace), other]);
    expect(trace).toEqual(["setup", "effect"]);
    host.disable("notes");
    expect(trace).toEqual(["setup", "effect", "effect undone"]);
    expect(host.running("notes")).toBe(false);
    expect(host.get("pages", "notes")).toBeUndefined();
    expect(host.get("cards", "note")).toBeUndefined();
    expect(host.get("chatItems", "recall")).toBeUndefined();
    expect(host.get("cards", "other")?.type).toBe("other");
    // 停了再停：什么都不做
    host.disable("notes");
    expect(trace).toHaveLength(3);
    host.enable("notes");
    expect(trace).toEqual(["setup", "effect", "effect undone", "setup", "effect"]);
    expect(host.get("pages", "notes")?.id).toBe("notes");
  });

  test("每次登记交回的撤销函数：撤掉这一个（只撤一次），停用时不再重复撤", () => {
    let undo: (() => void) | undefined;
    const plugin: WebPluginDefinition = {
      name: "p",
      title: "p",
      owns: { cards: ["a", "b"] },
      setup(ctx) {
        undo = ctx.register("cards", card("a"));
        ctx.register("cards", card("b"));
      },
    };
    const { host } = hostOf([plugin]);
    undo!();
    undo!();
    expect(host.get("cards", "a")).toBeUndefined();
    expect(host.get("cards", "b")?.type).toBe("b");
    host.disable("p");
    expect(host.get("cards", "b")).toBeUndefined();
  });

  test("停了以后再经它的 ctx 登记直接报错（迟到的登记不会悄悄漏掉）", () => {
    let late: (() => void) | undefined;
    const plugin: WebPluginDefinition = {
      name: "p",
      title: "p",
      owns: { cards: ["a"] },
      setup(ctx) {
        ctx.register("cards", card("a"));
        late = () => void ctx.register("cards", card("a"));
      },
    };
    const { host } = hostOf([plugin]);
    host.disable("p");
    expect(() => late!()).toThrow("插件 p 已经停了");
  });

  test("变了通知订阅的（版本号跟着加）；取消订阅以后不再通知", () => {
    const { host } = hostOf([notes()]);
    const seen: number[] = [];
    const off = host.subscribe(() => seen.push(host.version()));
    const before = host.version();
    host.disable("notes");
    host.enable("notes");
    expect(seen).toEqual([before + 1, before + 2]);
    off();
    host.disable("notes");
    expect(seen).toHaveLength(2);
  });
});

describe("拥有的位置（数据契约）", () => {
  test("登记了不归自己的、自己拥有的却没登记：装配出错，已经登记的撤掉，插件算没装上（别的照常，页面不崩）", () => {
    const sneaky: WebPluginDefinition = { name: "sneaky", title: "s", owns: { cards: ["a"] }, setup: (ctx) => void (ctx.register("cards", card("a")), ctx.register("cards", card("b"))) };
    const lazy: WebPluginDefinition = { name: "lazy", title: "l", owns: { cards: ["c"], pages: ["lazy"] }, setup: (ctx) => void ctx.register("cards", card("c")) };
    const { host, logs } = hostOf([sneaky, lazy, notes()]);
    expect(host.running("sneaky")).toBe(false);
    expect(host.running("lazy")).toBe(false);
    expect(host.get("cards", "a")).toBeUndefined();
    expect(host.get("cards", "c")).toBeUndefined();
    expect(host.running("notes")).toBe(true);
    expect(logs).toEqual([
      "网页插件 sneaky 装配出错：登记了不归它的 cards「b」（它拥有的写在定义的 owns 里）",
      "网页插件 lazy 装配出错：拥有的 pages「lazy」没有登记",
    ]);
  });

  test("两个插件拥有同一个位置、清单里同名：是写错了代码，建宿主时就报错", () => {
    const twin: WebPluginDefinition = { name: "twin", title: "t", owns: { cards: ["note"] }, setup: () => {} };
    expect(() => hostOf([notes(), twin])).toThrow("cards「note」有两个插件拥有：notes、twin");
    expect(() => hostOf([notes(), notes()])).toThrow("网页插件清单里有两个 notes");
  });

  test("unavailable：属于没在用的插件的位置交回它的名字（占位那句里写）；在用的、不归谁的是 undefined", () => {
    const { host } = hostOf([notes()]);
    expect(host.unavailable("cards", "note")).toBeUndefined();
    host.disable("notes");
    expect(host.unavailable("cards", "note")).toBe("笔记");
    expect(host.unavailable("chatItems", "recall")).toBe("笔记");
    expect(host.unavailable("cards", "plan")).toBeUndefined();
    expect(host.ownerOf("pages", "notes")?.name).toBe("notes");
  });
});

describe("按守护进程报的状况装和停", () => {
  test("在运行的装、停用的和没装上的停；守护进程清单里没有的（这个网页认得、守护进程不认得）也停；没报（undefined）当作全开", () => {
    const other: WebPluginDefinition = { name: "other", title: "别的", owns: { cards: ["other"] }, setup: (ctx) => void ctx.register("cards", card("other")) };
    const ghost: WebPluginDefinition = { name: "ghost", title: "没有的", owns: { cards: ["ghost"] }, setup: (ctx) => void ctx.register("cards", card("ghost")) };
    const { host } = hostOf([notes(), other, ghost]);
    host.apply([
      { name: "notes", title: "笔记", state: "disabled" },
      { name: "other", title: "别的", state: "running" },
    ]);
    expect([host.running("notes"), host.running("other"), host.running("ghost")]).toEqual([false, true, false]);
    host.apply([
      { name: "notes", title: "笔记", state: "running" },
      { name: "other", title: "别的", state: "skipped", reason: "缺依赖" },
      { name: "ghost", title: "没有的", state: "running" },
    ]);
    expect([host.running("notes"), host.running("other"), host.running("ghost")]).toEqual([true, false, true]);
    host.apply(undefined);
    expect([host.running("notes"), host.running("other"), host.running("ghost")]).toEqual([true, true, true]);
  });

  test("报的和现在一样：不重新装配、不通知", () => {
    const trace: string[] = [];
    const { host } = hostOf([notes(trace)]);
    const seen: number[] = [];
    host.subscribe(() => seen.push(host.version()));
    host.apply([{ name: "notes", title: "笔记", state: "running" }]);
    expect(trace).toEqual(["setup", "effect"]);
    expect(seen).toEqual([]);
  });
});
