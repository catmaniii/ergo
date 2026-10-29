// 设置 · 插件（211 号票）：
// - 走真实的装配路径：守护进程主切面（packages/daemon/test/main/plugin-status.test.ts）里在设置里运行中停用、启用记忆插件，
//   移除提醒插件并连数据删，录下网页收到的事件流（recordings/plugins-hot-toggle.json）；这里原样一条一条交给状态层，每收到一次插件的状况
//   就用真的网页插件清单建的宿主装、停，查页面和栏目马上收起、启用后回来；删除记录到了以后手里以前的提醒和提醒卡拿掉；
//   213 号票：运行中停用、再启用日历插件的那一段（recordings/plugins-calendar-hot.json）：导航里的日历马上收起、启用后回来；
// - 设置里那一块（PluginList）和确认框（PluginConfirm）用 React 在 Node 里渲染出来查：状况、它带来了什么、依赖、按钮，
//   停用时列出一起停的、启用时列出一起开的、移除时"连它的数据一起彻底删除"的勾选（默认不勾），勾了第二步写明删哪些、删不掉哪些、不能恢复。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { confirmText, PluginConfirm, type PluginConfirming, PluginList, pluginLines } from "../../src/pages/more/PluginsPage.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { initialUiState, navItemsFor, type PluginInfo, reduce, type UiInput, type UiState } from "../../src/state/index.ts";
import { card, frame } from "../state/events.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state/recordings", `${name}.json`), "utf8")) as UiInput[];

/** 守护进程报的两个插件的样子（设置 · 插件的清单） */
function plugin(name: "reminders" | "memory", extra: Partial<PluginInfo> = {}): PluginInfo {
  const base: PluginInfo =
    name === "reminders"
      ? {
          name,
          title: "提醒",
          summary: "到点或者某件事发生时提醒你一声",
          state: "running",
          brings: { tools: ["建简单提醒", "改简单提醒", "取消简单提醒", "归档简单提醒"], cards: ["提醒卡"], jobs: [] },
          needs: [],
          neededBy: [],
          stopsWith: [],
          startsWith: [],
          removal: { deletes: ["全部提醒", "提醒卡的每个版本"], keeps: ["秘书会话里提到过的提醒内容", "备份快照里的一份"] },
        }
      : { name, title: "记忆", summary: "把你说过的话采成素材", state: "running", brings: { tools: ["检索素材", "读素材"], cards: ["记忆删除卡"], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [] };
  return { ...base, ...extra };
}

const webBrings = (name: string) => WEB_PLUGIN_MANIFEST.find((p) => p.name === name)?.brings ?? [];
const noop = () => {};
/** 一条提醒（状态层只看 id 和建的时间） */
const reminder = (id: string, createdAt: string) => ({ id, text: id, status: "pending", createdAt, updatedAt: createdAt, by: "user" });
/** 设置里的插件那一块渲染出来 */
const render = (plugins: PluginInfo[], options: { busy?: string; removedOpen?: boolean } = {}) =>
  renderToStaticMarkup(createElement(PluginList, { plugins, web: webBrings, busy: options.busy, removedOpen: options.removedOpen ?? false, onToggleRemoved: noop, onAct: noop }));

describe("运行中停用、启用、移除：网页插件跟着收起、放回（录下的真守护进程的事件流）", () => {
  test("每收到一次插件的状况就装、停：记忆停用时记忆页没了、启用后回来；提醒移除后看板、日历里的提醒没了；删除记录到了以后手里以前的提醒和提醒卡拿掉", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    const seen: string[] = [];
    let state: UiState = initialUiState;
    let reminderCards = 0;
    for (const input of load("plugins-hot-toggle")) {
      state = reduce(state, input);
      if (input.kind !== "frame") continue;
      if (input.frame.type === EVENT_TYPES.card) reminderCards = Object.values(state.cards).filter((c) => c.card.type === "reminder").length;
      if (input.frame.type !== EVENT_TYPES.pluginStatus) continue;
      host.apply(state.pluginStatus?.plugins);
      seen.push(`${host.list("pages").map((p) => p.id).join(",") || "-"} | ${host.list("calendar").map((c) => c.id).join(",") || "-"} | ${host.list("boardEntries").map((b) => b.kind).join(",") || "-"}`);
    }
    expect(seen).toEqual([
      "calendar,memory | reminders | reminder,memory_curator",
      "calendar | reminders | reminder",
      "calendar,memory | reminders | reminder,memory_curator",
      "calendar,memory | - | memory_curator",
    ]);
    // 停了的拥有的位置交回占位的名字
    expect(host.unavailable("cards", "reminder")).toBe("提醒");
    // 连数据删：删除记录到了，手里那时之前的提醒、提醒卡拿掉
    expect(reminderCards).toBe(1);
    expect(Object.values(state.reminders)).toEqual([]);
    expect(Object.values(state.cards).filter((c) => c.card.type === "reminder")).toEqual([]);
  });

  test("运行中停用、再启用日历插件（213 号票）：导航里的日历马上收起、#/calendar 交回\"日历\"（写没启用），启用后回来；提醒、记忆一直在", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    const seen: string[] = [];
    let state: UiState = initialUiState;
    for (const input of load("plugins-calendar-hot")) {
      state = reduce(state, input);
      if (input.kind !== "frame" || input.frame.type !== EVENT_TYPES.pluginStatus) continue;
      host.apply(state.pluginStatus?.plugins);
      seen.push(`${navItemsFor({ browse: false, plugins: host.list("pages") }).join(",")} | ${host.unavailable("pages", "calendar") ?? "-"} | ${host.list("calendar").map((c) => c.id).join(",") || "-"}`);
    }
    expect(seen).toEqual([
      "secretary,tasks,projects,inbox,calendar,usage,memory,settings | - | reminders",
      "secretary,tasks,projects,inbox,usage,memory,settings | 日历 | reminders",
      "secretary,tasks,projects,inbox,calendar,usage,memory,settings | - | reminders",
    ]);
  });

  test("删除记录按时间认：那时之前的卡片、提醒拿掉，之后建的留着（重新打开页面时补发的先后不要紧）；被改写成\"已删除\"的提醒事件不认", () => {
    const at = "2026-10-20T10:00:00.000+08:00";
    const old = card("c-old", 1, { type: "reminder", createdAt: "2026-10-20T09:00:00.000+08:00" });
    const later = card("c-new", 1, { type: "reminder", createdAt: "2026-10-20T11:00:00.000+08:00" });
    const other = card("c-other", 1, { type: "quick_action", createdAt: "2026-10-20T09:00:00.000+08:00" });
    let state: UiState = initialUiState;
    const inputs: UiInput[] = [
      { kind: "frame", frame: frame(CHANNELS.board, 1, EVENT_TYPES.reminder, { reminder: reminder("r-1", "2026-10-20T09:00:00.000+08:00"), change: "created", by: "user" }) },
      { kind: "frame", frame: frame(CHANNELS.board, 2, EVENT_TYPES.reminder, { deleted: true, deletedAt: at }) },
      { kind: "frame", frame: frame(CHANNELS.board, 3, EVENT_TYPES.reminder, { reminder: reminder("r-2", "2026-10-20T11:00:00.000+08:00"), change: "created", by: "user" }) },
      ...[old, later, other].map((c, i): UiInput => ({ kind: "frame", frame: frame(CHANNELS.cards, i + 1, EVENT_TYPES.card, { card: c }) })),
      {
        kind: "frame",
        frame: frame(CHANNELS.plugins, 1, EVENT_TYPES.pluginDataPurged, { plugin: "reminders", at, eventTypes: ["reminder"], cardTypes: ["reminder"], counts: { events: 1, cards: 1, inboxItems: 0, files: 0 } }),
      },
    ];
    for (const input of inputs) state = reduce(state, input);
    expect(Object.keys(state.cards).toSorted()).toEqual(["c-new", "c-other"]);
    expect(Object.keys(state.reminders)).toEqual(["r-2"]);
  });
});

describe("设置里的插件那一块", () => {

  test("每个插件：名字、状况、一句话、它带来了什么（守护进程写的工具和卡片、网页插件写的页面和栏目）；在运行的有停用、移除", () => {
    const html = render([plugin("reminders"), plugin("memory")]);
    expect(html).toContain('<div class="plugin-row plugin-running" data-plugin="reminders"><div class="plugin-head"><span class="plugin-name">提醒</span><span class="chip chip-ok">运行中</span></div>');
    expect(html).toContain('<div class="plugin-summary">到点或者某件事发生时提醒你一声</div>');
    expect(html).toContain("<li>给二狗的工具 4 个：建简单提醒、改简单提醒、取消简单提醒和归档简单提醒</li><li>卡片：提醒卡</li><li>网页上：看板上的简单提醒和日历里的提醒</li>");
    expect(html).toContain("<li>网页上：导航里的「记忆」页（档案、结论、问题箱、素材，和记忆管理员的对话）、对话里的「回忆了 N 条记忆」、看板上的「记忆整理 · 每天 03:00」和记忆页最下面的「会意 · 设置」：每条消息带简报、顺口问、每周约访谈三个开关</li>");
    expect(html.match(/>停用</g)).toHaveLength(2);
    expect(html.match(/>移除</g)).toHaveLength(2);
    expect(html).not.toContain("已移除（");
  });

  test("停用了的、没装上的（带给人看的原因）、移除了的（收在\"已移除（N）\"里，折叠着，展开后有\"装回\"）；依赖写出来；正在处理的那个写\"正在处理……\"", () => {
    const off = plugin("reminders", { state: "disabled" });
    const broken = plugin("memory", { state: "skipped", problem: "它要用的「提醒」插件没开", needs: ["reminders"], startsWith: ["reminders"] });
    const html = render([off, broken]);
    expect(html).toContain('<span class="chip">已停用</span>');
    expect(html).toContain('<span class="chip chip-no">没装上</span>');
    expect(html).toContain('<div class="field-error">没装上：它要用的「提醒」插件没开</div>');
    expect(html).toContain("<li>要用：「提醒」</li>");
    expect(html.match(/>启用</g)).toHaveLength(2);
    expect(render([plugin("reminders", { neededBy: ["memory"] }), plugin("memory")])).toContain("<li>「记忆」要用它</li>");

    const removed = [plugin("reminders", { state: "removed" }), plugin("memory")];
    const folded = render(removed);
    expect(folded).toContain('<button type="button" class="plugin-fold" aria-expanded="false"><span>已移除（1）</span>');
    expect(folded).not.toContain('data-plugin="reminders"');
    const open = render(removed, { removedOpen: true });
    expect(open).toContain('data-plugin="reminders"');
    expect(open).toContain(">装回<");
    expect(render([plugin("reminders"), plugin("memory")], { busy: "reminders" })).toContain('<span class="muted">正在处理……</span>');
  });

  test("要的外部组件没装（315 号票：Claude Code 的 Agent SDK）：状况写\"没装\"，下面那一句就是没装什么、怎么装（不再套\"没装上：\"）；装好之前没有启用，能停用、移除", () => {
    const how = "没装 Claude Code 的 Agent SDK（@anthropic-ai/claude-agent-sdk）：……运行 npm install --no-save @anthropic-ai/claude-agent-sdk@0.3.296";
    const cc: PluginInfo = { name: "claude-code", title: "Claude Code", summary: "用本机的 Claude Code 跑会话", state: "skipped", missing: true, problem: how, cannotEnable: how, brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [] };
    const html = render([plugin("reminders"), cc]);
    expect(html).toContain('<div class="plugin-row plugin-skipped" data-plugin="claude-code"><div class="plugin-head"><span class="plugin-name">Claude Code</span><span class="chip chip-no">没装</span></div>');
    expect(html).toContain(`<div class="field-error">${how}</div>`);
    expect(html).not.toContain("没装上：");
    const row = html.slice(html.indexOf('data-plugin="claude-code"'));
    expect(row).not.toContain(">启用<");
    expect(row).toContain(">停用<");
    expect(row).toContain(">移除<");
  });

  test("日历（213 号票）：守护进程那一半没带工具、卡片，网页上是导航里的「日历」页；没写明连数据删，移除时没有那个勾选", () => {
    const calendar: PluginInfo = { name: "calendar", title: "日历", summary: "按月看每天上班还是休息", state: "running", brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [] };
    const html = render([plugin("reminders"), plugin("memory"), calendar]);
    expect(html).toContain('<div class="plugin-row plugin-running" data-plugin="calendar"><div class="plugin-head"><span class="plugin-name">日历</span><span class="chip chip-ok">运行中</span></div>');
    expect(pluginLines(calendar, [calendar], webBrings("calendar"))).toEqual(["网页上：导航里的「日历」页"]);
    const confirm = renderToStaticMarkup(createElement(PluginConfirm, { confirming: { kind: "remove", plugin: calendar, purge: false }, plugins: [calendar], busy: false, onPurgeChange: noop, onCancel: noop, onConfirm: noop }));
    expect(confirm).toContain("停用它，收进下面的「已移除」，以后可以装回。");
    expect(confirm).not.toContain("plugin-purge");
  });

  test("几行的写法：没带来东西的写一句", () => {
    expect(pluginLines(plugin("memory", { brings: { tools: [], cards: [], jobs: [] } }), [], [])).toEqual(["没带来工具、卡片和页面"]);
  });
});

describe("确认框", () => {
  const all = [plugin("reminders", { stopsWith: ["memory"] }), plugin("memory", { needs: ["reminders"] })];
  const renderConfirm = (confirming: PluginConfirming) =>
    renderToStaticMarkup(createElement(PluginConfirm, { confirming, plugins: all, busy: false, onPurgeChange: noop, onCancel: noop, onConfirm: noop }));

  test("停用：马上生效、不用重启，列出会一起停的", () => {
    const html = renderConfirm({ kind: "disable", plugin: all[0]!, purge: false });
    expect(html).toContain('aria-label="停用「提醒」？"');
    expect(html).toContain("马上生效，不用重启");
    expect(html).toContain("<p>这些插件要用它，会一起停用：「记忆」</p>");
    expect(html).toContain('class="btn primary">停用</button>');
  });

  test("启用（装回）：列出它要的、一起开的", () => {
    const off = plugin("memory", { state: "removed", startsWith: ["reminders"] });
    expect(confirmText({ kind: "enable", plugin: off, purge: false }, all)).toEqual({ title: "装回「记忆」？", lines: ["它要用这些插件，会一起启用：「提醒」"], ok: "装回", danger: false });
  });

  test("移除：收进\"已移除\"，有\"连它的数据一起彻底删除\"的勾选、默认不勾；勾了按钮是\"下一步\"；没写明连数据删的插件没有这个勾选", () => {
    const html = renderConfirm({ kind: "remove", plugin: all[0]!, purge: false });
    expect(html).toContain("停用它，收进下面的「已移除」，以后可以装回。");
    expect(html).toContain('<label class="check-row plugin-purge"><input type="checkbox"/><span>连它的数据一起彻底删除</span></label>');
    expect(html).toContain('class="btn primary">移除</button>');
    const checked = renderConfirm({ kind: "remove", plugin: all[0]!, purge: true });
    expect(checked).toContain('<input type="checkbox" checked=""/>');
    expect(checked).toContain('class="btn danger">下一步</button>');
    expect(renderConfirm({ kind: "remove", plugin: all[1]!, purge: false })).not.toContain("plugin-purge");
  });

  test("连数据删的第二步：写明删哪些、删不掉哪些、不能恢复", () => {
    const html = renderConfirm({ kind: "purge", plugin: all[0]!, purge: true });
    expect(html).toContain('aria-label="彻底删除「提醒」的数据？"');
    expect(html).toContain("<p>会删掉：</p><ul class=\"plain-list\"><li>全部提醒</li><li>提醒卡的每个版本</li></ul>");
    expect(html).toContain("<p>删不掉的：</p><ul class=\"plain-list\"><li>秘书会话里提到过的提醒内容</li><li>备份快照里的一份</li></ul>");
    expect(html).toContain('<p class="plugin-final">删了不能恢复。</p>');
    expect(html).toContain('class="btn danger">移除并彻底删除</button>');
  });
});
