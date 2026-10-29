// 网页按真守护进程报的状况装网页插件（193 号票，ADR-0027："测试可以只起内核加某几个插件；同时要有走真实装配路径的测试"——
// dsh 的复盘 0001：手挂插件的单元测试全过、上线即崩）。这里不手挂插件：
// - 守护进程那边的主切面（packages/daemon/test/main/plugin-status.test.ts）经组合根和插件清单起真的守护进程，停用只经数据目录配置的
//   plugins.disabled，把网页收到的事件流录成 recordings/plugins-*.json；
// - 这里把录下的事件流原样交给前端状态层（replay），再用真的网页插件清单（plugins/manifest.ts）建宿主、按状态层里的插件状况装和停，
//   查页面、导航、设置、对话条目、详情、卡片、看板、日历这几个插槽里有什么，停用的插件拥有的位置交回占位用的名字；
// - 213 号票：日历也是插件（导航里的"日历"、#/calendar 那一页）；停用日历、停用提醒时日历照常（提醒是它的可选依赖）；
// - 对话里的"回忆了 N 条记忆"：按事件构造一段会话，记忆插件停用时换成占位（maskUnavailable），用 React 在 Node 里渲染出那一行。
// - 297 号票：Google 插件（设置 · 数据源里 Google · 日历下面那一块，dataSources 插槽）；停用 Google 时那一块交回"Google"。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS } from "@ergo/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { PluginHostProvider } from "../../src/plugins/react.tsx";
import { type ChatItem, chatItems, type EventFrame, maskUnavailable, type MessagePart, navItemsFor, replay, type UiInput } from "../../src/state/index.ts";
import { ChatItemView } from "../../src/ui/conversation/ChatItemView.tsx";
import { frame } from "../state/events.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state/recordings", `${name}.json`), "utf8")) as UiInput[];

/** 按真守护进程报的状况装好的网页插件宿主 */
function assembled(recording: string) {
  const state = replay(load(recording));
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(state.pluginStatus?.plugins);
  return { state, host };
}

type Host = ReturnType<typeof assembled>["host"];

/** 插槽里现在有的（按插槽列出键；212 号票加了页签） */
const slotsOf = (host: Host) => ({
  pages: host.list("pages").map((p) => p.id),
  tabs: host.list("tabs").map((e) => e.id),
  chatItems: host.list("chatItems").map((e) => e.kind),
  details: host.list("details").map((e) => e.kind),
  cards: host.list("cards").map((e) => e.type),
  boardEntries: host.list("boardEntries").map((e) => e.kind),
  calendar: host.list("calendar").map((e) => e.id),
  dataSources: host.list("dataSources").map((e) => e.id),
});

const at = (s: number) => `2026-10-20T10:00:${String(s).padStart(2, "0")}.000+08:00`;
const render = (host: Host, item: ChatItem) => renderToStaticMarkup(createElement(PluginHostProvider, { host }, createElement(ChatItemView, { item, actions: {} })));
const recallOf = (list: readonly ChatItem[]) => list.find((it) => it.kind === "recall" || (it.kind === "unavailable" && it.was === "recall"))!;

/** 一段秘书会话：用户问一句，秘书检索了一次记忆（187 号票的结构化命中），然后回答 */
function recallConversation(): ChatItem[] {
  const S = CHANNELS.secretary;
  const message = (seq: number, speaker: "user" | "agent", parts: MessagePart[]): EventFrame => frame(S, seq, "message", { message: { id: `m-${seq}`, conversation: S, speaker, time: at(seq), parts } });
  const search: MessagePart = {
    type: "tool_call",
    callId: "c-1",
    tool: "search_materials",
    argsSummary: "query=跑步 why=看你以前怎么说的",
    categoryTitles: [],
    disposition: "do",
    withinGrant: false,
    genericBash: false,
    outcome: "done",
    nature: "look",
    recall: { source: "search", why: "看你以前怎么说的", query: "跑步", hits: [{ materialId: "mat-1", kind: "user_utterance", time: at(0), conversation: S, keyword: true }] },
  };
  const state = replay([message(1, "user", [{ type: "text", text: "我周末想去跑步" }]), message(2, "agent", [search]), message(3, "agent", [{ type: "text", text: "好的。" }])]);
  return chatItems(state, S);
}

describe("按真守护进程报的状况装网页插件", () => {
  test("还没收到守护进程报的状况（原型、旧的守护进程）：当作全开，插件的东西都在", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply(undefined);
    expect(slotsOf(host)).toEqual({
      pages: ["calendar", "memory"],
      tabs: ["browse"],
      chatItems: ["recall"],
      details: ["recall"],
      cards: ["reminder", "memory_delete", "interview", "interview_files", "browse_pick"],
      boardEntries: ["reminder", "memory_curator"],
      calendar: ["reminders"],
      dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"],
    });
    // 导航和以前一样：记忆排在消耗后面、设置前面
    expect(navItemsFor({ browse: false, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"]);
  });

  test("配置里停用记忆插件（录下的事件流）：记忆页、导航里的记忆、调用记忆的画法、记忆删除卡都没有，拥有的位置交回\"记忆\"；提醒照常", () => {
    const { state, host } = assembled("plugins-memory-off");
    expect(state.pluginStatus?.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "running"],
      ["memory", "disabled"],
      ["calendar", "running"],
      ["voice", "running"],
      ["browsing", "running"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "running"],
      ["looki", "running"],
    ]);
    expect([host.running("reminders"), host.running("memory")]).toEqual([true, false]);
    expect(slotsOf(host)).toEqual({ pages: ["calendar"], tabs: ["browse"], chatItems: [], details: [], cards: ["reminder", "browse_pick"], boardEntries: ["reminder"], calendar: ["reminders"], dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"] });
    expect(navItemsFor({ browse: false, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "calendar", "usage", "settings"]);
    expect(["pages:memory", "chatItems:recall", "details:recall", "cards:memory_delete", "cards:interview", "cards:interview_files", "boardEntries:memory_curator"].map((k) => host.unavailable(k.split(":")[0] as never, k.split(":")[1]!))).toEqual(["记忆", "记忆", "记忆", "记忆", "记忆", "记忆", "记忆"]);
    expect(host.unavailable("cards", "reminder")).toBeUndefined();
    // 没有哪个在用的插件页面包含内核的"删除素材"：设置里列出它
    expect(host.list("pages").flatMap((p) => p.covers ?? [])).toEqual([]);
  });

  test("配置里停用提醒插件（录下的事件流）：提醒卡、看板上的提醒、日历里的提醒都没有，拥有的位置交回\"提醒\"；记忆照常", () => {
    const { host } = assembled("plugins-reminders-off");
    expect([host.running("reminders"), host.running("memory")]).toEqual([false, true]);
    expect(slotsOf(host)).toEqual({ pages: ["calendar", "memory"], tabs: ["browse"], chatItems: ["recall"], details: ["recall"], cards: ["memory_delete", "interview", "interview_files", "browse_pick"], boardEntries: ["memory_curator"], calendar: [], dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"] });
    expect([host.unavailable("cards", "reminder"), host.unavailable("boardEntries", "reminder"), host.unavailable("calendar", "reminders")]).toEqual(["提醒", "提醒", "提醒"]);
    // 285 号票起记忆页的"档案"也盖住"更多"里的个人档案
    expect(host.list("pages").flatMap((p) => p.covers ?? [])).toEqual(["materials-delete", "files"]);
  });

  test("配置里停用日历插件（213 号票，录下的事件流）：导航里没有日历，日历那一页交回\"日历\"（写\"日历插件没启用\"）；提醒、记忆照常，提醒在日历插槽里的照样登记（日历页不在，画不出来）", () => {
    const { state, host } = assembled("plugins-calendar-off");
    expect(state.pluginStatus?.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "running"],
      ["memory", "running"],
      ["calendar", "disabled"],
      ["voice", "running"],
      ["browsing", "running"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "running"],
      ["looki", "running"],
    ]);
    expect([host.running("reminders"), host.running("memory"), host.running("calendar")]).toEqual([true, true, false]);
    expect(slotsOf(host)).toEqual({ pages: ["memory"], tabs: ["browse"], chatItems: ["recall"], details: ["recall"], cards: ["reminder", "memory_delete", "interview", "interview_files", "browse_pick"], boardEntries: ["reminder", "memory_curator"], calendar: ["reminders"], dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"] });
    expect(navItemsFor({ browse: false, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "usage", "memory", "settings"]);
    expect(navItemsFor({ browse: true, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "browse", "usage", "memory", "settings"]);
    expect(host.get("pages", "calendar")).toBeUndefined();
    expect(host.unavailable("pages", "calendar")).toBe("日历");
  });

  test("配置里停用提醒插件（录下的事件流）：日历照常——导航里有日历、日历页在，日历插槽里没有提醒那一栏（提醒是日历的可选依赖）", () => {
    const { host } = assembled("plugins-reminders-off");
    expect(host.running("calendar")).toBe(true);
    expect(host.get("pages", "calendar")).toBeDefined();
    expect(navItemsFor({ browse: false, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"]);
    expect(host.list("calendar")).toEqual([]);
  });

  test("配置里停用浏览插件（212 号票，录下的事件流）：没有\"浏览\"页签（App 里导航也没有这一项）、网页候选卡没有画法，拥有的位置交回\"内置浏览器\"；提醒、记忆照常", () => {
    const { state, host } = assembled("plugins-browsing-off");
    expect(state.pluginStatus?.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "running"],
      ["memory", "running"],
      ["calendar", "running"],
      ["voice", "running"],
      ["browsing", "disabled"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "running"],
      ["looki", "running"],
    ]);
    expect(host.running("browsing")).toBe(false);
    expect(slotsOf(host)).toEqual({ pages: ["calendar", "memory"], tabs: [], chatItems: ["recall"], details: ["recall"], cards: ["reminder", "memory_delete", "interview", "interview_files"], boardEntries: ["reminder", "memory_curator"], calendar: ["reminders"], dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"] });
    expect([host.unavailable("tabs", "browse"), host.unavailable("cards", "browse_pick")]).toEqual(["内置浏览器", "内置浏览器"]);
    // 鸿蒙 App 里（有原生浏览器）导航也没有"浏览"：组合根按页签插槽里有没有它定（App.tsx 的 Shell）
    const browse = host.get("tabs", "browse") !== undefined;
    expect(navItemsFor({ browse, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"]);
    // 再在运行：页签回来，App 里导航又有"浏览"
    host.apply([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "running" },
      { name: "calendar", title: "日历", state: "running" },
      { name: "voice", title: "语音", state: "running" },
      { name: "browsing", title: "内置浏览器", state: "running" },
    ]);
    expect(navItemsFor({ browse: host.get("tabs", "browse") !== undefined, plugins: host.list("pages") })).toEqual(["secretary", "tasks", "projects", "inbox", "browse", "calendar", "usage", "memory", "settings"]);
  });

  test("配置里停用 Google 插件（297 号票，录下的事件流）：设置 · 数据源里没有 Google · 日历、Google · 联系人（301）下面那一块，交回\"Google\"；日历照常", () => {
    const { state, host } = assembled("plugins-google-off");
    expect(state.pluginStatus?.plugins.map((p) => [p.name, p.state]).slice(-2)).toEqual([
      ["google", "disabled"],
      ["looki", "running"],
    ]);
    expect(host.running("google")).toBe(false);
    expect(slotsOf(host)).toMatchObject({ pages: ["calendar", "memory"], dataSources: ["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "looki"] });
    expect(host.unavailable("dataSources", "google-calendar")).toBe("Google");
    expect(host.unavailable("dataSources", "google-contacts")).toBe("Google");
  });

  test("日历的页面（213 号票）：导航里的字、图标和原来一样，点了去它自己的地址 #/calendar（不在 #/more 下面），收进\"更多\"时也是整页", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply(undefined);
    const page = host.get("pages", "calendar")!;
    expect({ id: page.id, order: page.order, icon: page.icon, navLabel: page.navLabel, title: page.title, sub: page.sub, route: page.route, column: page.Column }).toEqual({
      id: "calendar",
      order: 60,
      icon: "calendar",
      navLabel: "日历",
      title: "日历",
      sub: "每天上班还是休息，当天的提醒和定时触发的任务",
      route: { tab: "calendar" },
      column: undefined,
    });
  });

  test("重启后又在运行：装回来", () => {
    const { host } = assembled("plugins-memory-off");
    host.apply([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "running" },
    ]);
    expect(slotsOf(host).pages).toEqual(["memory"]);
    expect(host.get("chatItems", "recall")).toBeDefined();
  });
});

describe("对话里的\"回忆了 N 条记忆\"", () => {
  const items = recallConversation();

  test("记忆插件在运行：照 187 号票画成一行（记忆插件画的）", () => {
    const { host } = assembled("plugins-reminders-off");
    const masked = maskUnavailable(items, (it) => host.unavailable("chatItems", it.kind));
    expect(masked).toBe(items);
    const html = render(host, recallOf(masked));
    expect(html).toContain('class="tool-sum recall-line');
    expect(html).toContain("回忆了 1 条记忆");
  });

  test("记忆插件停用：那一条换成占位（id、时间照旧，打不开详情），画成一行\"（记忆插件没启用，这条内容暂时看不到）\"；别的条目不动", () => {
    const { host } = assembled("plugins-memory-off");
    const masked = maskUnavailable(items, (it) => host.unavailable("chatItems", it.kind));
    const before = recallOf(items);
    const after = recallOf(masked);
    expect(after).toMatchObject({ kind: "unavailable", plugin: "记忆", was: "recall", id: before.id, time: before.time, detail: undefined, keyLine: "（记忆插件没启用，这条内容暂时看不到）" });
    expect(masked.filter((it) => it !== after)).toEqual(items.filter((it) => it !== before));
    expect(render(host, after)).toBe('<div class="msg msg-system"><div class="sys-note msg-unavailable">（记忆插件没启用，这条内容暂时看不到）</div></div>');
    // 没换成占位就交过来（兜底）：同样是占位，不报错
    expect(render(host, before)).toContain("（记忆插件没启用，这条内容暂时看不到）");
  });
});
