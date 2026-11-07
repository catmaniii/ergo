// 二狗替插件生成的几项（409，src/doctor/auto.ts）和定期导入大约多久一次（data-sources/service.ts 的 scheduleEveryMs）：
// - 插件本身：在跑正常；没装上坏了（附原因、跳设置 · 插件）；外部组件没装只是提示（不适用）；停用、移除了的没有这一行；
// - 数据源：插件没装上、没连、两种用法都关着不适用；要重新授权、连接出错坏了；定期导入超过间隔 3 倍没同步成功算过期（注意，
//   从上次成功起）；最近一次同步出错注意；别的正常；
// - 运行时：能用正常；没装、没人用不适用；没装、有任务或项目用着坏了；插件没装上（别的原因）不适用。
import type { AgentRuntimeView, DataSourceView, PluginInfo } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { scheduleEveryMs } from "../../src/data-sources/index.ts";
import type { DataSourceDoctorFacts } from "../../src/data-sources/service.ts";
import { doctorTime, pluginItem, runtimeItem, SOURCE_STALE_FACTOR, sourceItem } from "../../src/doctor/auto.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-07T15:30:00+08:00");

function info(state: PluginInfo["state"], extra: Partial<PluginInfo> = {}): PluginInfo {
  return { name: "looki", title: "Looki", summary: "", state, brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [], ...extra };
}

function source(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "looki",
    title: "Looki",
    summary: "",
    plugin: "looki",
    pluginTitle: "Looki",
    available: true,
    connection: "connected",
    usages: [
      { usage: "query", on: true },
      { usage: "import", on: true },
    ],
    sensitive: [],
    count: 3,
    syncing: false,
    canSync: true,
    schedule: "每天 02:30",
    files: [],
    configurable: true,
    ...extra,
  } as DataSourceView;
}

const facts = (view: DataSourceView, extra: Partial<Omit<DataSourceDoctorFacts, "view">> = {}): DataSourceDoctorFacts => ({ view, ...extra });

function runtime(extra: Partial<AgentRuntimeView> = {}): AgentRuntimeView {
  return { id: "codex", title: "Codex", plugin: "codex", available: true, capabilities: {} as AgentRuntimeView["capabilities"], settings: [], ...extra };
}

describe("插件本身那一行", () => {
  it("在跑：正常；没装上：坏了，附原因，修法和动作指向设置 · 插件；外部组件没装：不适用（提示）；停用、移除了：没有", () => {
    expect(pluginItem(info("running"))).toEqual({ id: "plugin", level: "ok", title: { key: "doctor.plugin.title" }, fact: { key: "doctor.plugin.running" } });
    expect(pluginItem(info("skipped", { problem: "装配出错：读不了配置" }))).toEqual({
      id: "plugin",
      level: "error",
      title: { key: "doctor.plugin.title" },
      fact: { key: "doctor.plugin.skipped", params: { reason: "装配出错：读不了配置" } },
      fix: { key: "doctor.fix.pluginSkipped" },
      action: { kind: "open", route: "#/more/plugins" },
    });
    expect(pluginItem(info("skipped", { problem: "没装 Agent SDK", missing: true }))).toMatchObject({ level: "na", fact: { key: "doctor.plugin.missing", params: { reason: "没装 Agent SDK" } } });
    expect(pluginItem(info("disabled"))).toBeUndefined();
    expect(pluginItem(info("removed"))).toBeUndefined();
  });
});

/** 几小时前（ISO） */
const okAt = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

describe("数据源那一项", () => {
  it("插件没装上、没连、只靠导入文件夹还没导过、两种用法都关着：不适用", () => {
    expect(sourceItem(facts(source({ available: false })), NOW)).toMatchObject({ id: "source:looki", level: "na", fact: { key: "doctor.pluginOff" } });
    expect(sourceItem(facts(source({ connection: "not_connected" })), NOW)).toMatchObject({ level: "na", fact: { key: "doctor.source.notConnected" } });
    expect(sourceItem(facts(source({ connection: "manual" })), NOW)).toMatchObject({ level: "na", fact: { key: "doctor.source.manualNever" } });
    expect(sourceItem(facts(source({ usages: [{ usage: "query", on: false }, { usage: "import", on: false }] })), NOW)).toMatchObject({ level: "na", fact: { key: "doctor.source.off" } });
  });

  it("名字是数据源的名字；只靠导入文件夹、导过的：正常，写上次导入的时间", () => {
    const item = sourceItem(facts(source({ connection: "manual", lastSync: { at: okAt(5), trigger: "file", added: 4 } })), NOW);
    expect(item).toMatchObject({ title: { key: "doctor.source.title", params: { name: "Looki" } }, level: "ok", fact: { key: "doctor.source.manual", params: { time: doctorTime(okAt(5)) } } });
  });

  it("要重新授权：坏了（有原因带原因），修法是重新授权，动作跳到这个数据源", () => {
    expect(sourceItem(facts(source({ needsAuth: true, problem: "Key 不认" })), NOW)).toEqual({
      id: "source:looki",
      level: "error",
      title: { key: "doctor.source.title", params: { name: "Looki" } },
      fact: { key: "doctor.source.needsAuthWhy", params: { problem: "Key 不认" } },
      fix: { key: "doctor.fix.sourceAuth" },
      action: { kind: "open", route: "#/more/data-sources/looki" },
    });
    expect(sourceItem(facts(source({ needsAuth: true })), NOW)).toMatchObject({ level: "error", fact: { key: "doctor.source.needsAuth" } });
  });

  it("连接出错：坏了，写原因原文", () => {
    expect(sourceItem(facts(source({ connection: "error", problem: "连不上 api.looki.ai" })), NOW)).toMatchObject({ level: "error", fact: { key: "doctor.source.error", params: { problem: "连不上 api.looki.ai" } }, fix: { key: "doctor.fix.sourceError" } });
    expect(sourceItem(facts(source({ connection: "error" })), NOW)).toMatchObject({ level: "error", fact: { key: "doctor.source.errorNoReason" } });
  });

  it("定期导入超过间隔 3 倍没同步成功：注意（过期），写几小时、定期导入的时间，从上次成功起；正好 3 倍以内照常", () => {
    const daily = 24 * HOUR;
    expect(SOURCE_STALE_FACTOR).toBe(3);
    const stale = sourceItem(facts(source(), { lastOkAt: okAt(80), everyMs: daily }), NOW);
    expect(stale).toEqual({
      id: "source:looki",
      level: "warn",
      title: { key: "doctor.source.title", params: { name: "Looki" } },
      fact: { key: "doctor.source.stale", params: { hours: 80, schedule: "每天 02:30" } },
      fix: { key: "doctor.fix.sourceSync" },
      since: okAt(80),
      action: { kind: "open", route: "#/more/data-sources/looki" },
    });
    // 过期了、最近一次还出错：一起写
    const staleFailed = sourceItem(facts(source({ lastSync: { at: okAt(2), trigger: "scheduled", error: "vlog 接口停用了" } }), { lastOkAt: okAt(80), everyMs: daily }), NOW);
    expect(staleFailed).toMatchObject({ level: "warn", fact: { key: "doctor.source.staleFailed", params: { hours: 80, error: "vlog 接口停用了" } } });
    // 71 小时：还没到 3 倍
    expect(sourceItem(facts(source(), { lastOkAt: okAt(71), everyMs: daily }), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.source.synced", params: { time: doctorTime(okAt(71)) } } });
  });

  it("最近一次同步出错（还没过期）：注意，写时间和原因；导入文件出错不算同步出错", () => {
    const failed = sourceItem(facts(source({ lastSync: { at: okAt(1), trigger: "scheduled", error: "429 太快了" } }), { lastOkAt: okAt(25), everyMs: 24 * HOUR }), NOW);
    expect(failed).toMatchObject({ level: "warn", fact: { key: "doctor.source.lastFailed", params: { time: doctorTime(okAt(1)), error: "429 太快了" } }, fix: { key: "doctor.fix.sourceSync" } });
    const file = sourceItem(facts(source({ lastSync: { at: okAt(1), trigger: "file", error: "文件坏了" } }), { lastOkAt: okAt(2), everyMs: 24 * HOUR }), NOW);
    expect(file).toMatchObject({ level: "ok", fact: { key: "doctor.source.synced" } });
  });

  it("连着、只开了按需查：正常（现查）；导入开着、还没同步过：正常；设备交来的（没有定期导入）照最近一次", () => {
    expect(sourceItem(facts(source({ usages: [{ usage: "query", on: true }, { usage: "import", on: false }] })), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.source.query" } });
    expect(sourceItem(facts(source()), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.source.never" } });
    expect(sourceItem(facts(source({ fromDevice: true }), { lastOkAt: okAt(500) }), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.source.synced" } });
  });
});

describe("运行时那一项", () => {
  it("能用：正常；没装、没人用：不适用（提示怎么装）；没装、有任务或项目用着：坏了；插件没装上（别的原因）：不适用", () => {
    expect(runtimeItem(runtime(), 0)).toEqual({ id: "runtime:codex", level: "ok", title: { key: "doctor.runtime.title", params: { name: "Codex" } }, fact: { key: "doctor.runtime.ok" } });
    const missing = runtime({ available: false, missing: true, unavailable: "没装 Codex：npm i -g @openai/codex" });
    expect(runtimeItem(missing, 0)).toMatchObject({ level: "na", fact: { key: "doctor.runtime.missing", params: { reason: "没装 Codex：npm i -g @openai/codex" } } });
    expect(runtimeItem(missing, 2)).toMatchObject({
      level: "error",
      fact: { key: "doctor.runtime.missingUsed", params: { count: 2, reason: "没装 Codex：npm i -g @openai/codex" } },
      fix: { key: "doctor.fix.runtimeMissing" },
      action: { kind: "open", route: "#/more/plugins" },
    });
    expect(runtimeItem(runtime({ available: false, unavailable: "Codex插件没启用" }), 3)).toMatchObject({ level: "na", fact: { key: "doctor.pluginOff" } });
  });
});

describe("定期导入大约多久一次", () => {
  const DAY = 24 * HOUR;
  it("每隔几分钟、每天、每 N 天、每周几（最长隔几天）、每月几号、每年、按工作日；一次性的没有", () => {
    expect(scheduleEveryMs({ kind: "every", minutes: 30 })).toBe(30 * 60_000);
    expect(scheduleEveryMs({ kind: "daily", time: "02:30" })).toBe(DAY);
    expect(scheduleEveryMs({ kind: "everyNDays", time: "02:30", interval: 3, anchor: "2026-11-01" })).toBe(3 * DAY);
    expect(scheduleEveryMs({ kind: "weekly", time: "02:30", weekdays: [1] })).toBe(7 * DAY);
    // 周一、周三、周五：最长是周五到下周一，隔 3 天
    expect(scheduleEveryMs({ kind: "weekly", time: "02:30", weekdays: [5, 1, 3] })).toBe(3 * DAY);
    expect(scheduleEveryMs({ kind: "monthly", time: "02:30", days: [1, 15] })).toBe(17 * DAY);
    expect(scheduleEveryMs({ kind: "yearly", time: "02:30", month: 1, day: 1 })).toBe(366 * DAY);
    expect(scheduleEveryMs({ kind: "workdays", time: "02:30" })).toBe(3 * DAY);
    expect(scheduleEveryMs({ kind: "once", at: "2026-11-08T09:00:00+08:00" })).toBeUndefined();
  });
});
