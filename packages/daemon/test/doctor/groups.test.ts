// 体检按块拼（409，src/doctor/doctor.ts 的 view）：注入假的八项探测器、登记表、插件 / 数据源 / 运行时的现状——
// - 二狗本身在最前（八项 + 内核登记的），每个在跑、没装上的插件一块（插件本身、数据源、运行时，再是它登记的），停用、移除了的只列名字；
// - 五种结果：八项坏了按 BAD_LEVEL 算注意或坏了，查不了的是没查出来；块的结果、总状态取最差的，"没查出来""不适用"不拉低；
//   不适用的项排在块的最后；有问题的插件块排在前面；
// - 一项超时、抛错只算这一项没查出来，别的照常（所有项并行查，整页不等串起来的时间）；
// - 每项的句子按当前语言拼好（中英），插件的键也拼得出；
// - include 只查挑中的。
import { activeLocale, activeLocaleFrom, DOCTOR_CHECKS, DOCTOR_CORE_GROUP, type DoctorCheckDataById, type DoctorCheckId, type DoctorView, type PluginInfo, setActiveLocale, sortDoctorGroups, worstLevel } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DataSourceDoctorFacts } from "../../src/data-sources/service.ts";
import { createDoctorChecks, type DoctorFinding } from "../../src/doctor/checks.ts";
import { createDoctor, type DoctorOptions, type DoctorProbes, legacyLevel, overallLevel } from "../../src/doctor/doctor.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";

const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 120.5, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};

function probes(overrides: Partial<Record<DoctorCheckId, () => unknown>> = {}): DoctorProbes {
  return Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, overrides[id] ?? (() => GOOD[id])])) as DoctorProbes;
}

function plugin(name: string, title: string, state: PluginInfo["state"], extra: Partial<PluginInfo> = {}): PluginInfo {
  return { name, title, summary: "", state, brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [], ...extra };
}

const PLUGINS: PluginInfo[] = [
  plugin("reminders", "提醒", "running"),
  plugin("memory", "记忆", "running"),
  plugin("calendar", "日历", "disabled"),
  plugin("voice", "语音", "skipped", { problem: "装配出错：识别进程起不来" }),
  plugin("looki", "Looki", "running"),
  plugin("codex", "Codex", "skipped", { problem: "没装 Codex", missing: true }),
  plugin("google", "Google", "removed"),
];

const LOOKI: DataSourceDoctorFacts = {
  view: {
    id: "looki",
    title: "Looki",
    summary: "",
    plugin: "looki",
    pluginTitle: "Looki",
    available: true,
    connection: "connected",
    usages: [{ usage: "import", on: true }],
    sensitive: [],
    count: 0,
    syncing: false,
    canSync: true,
    schedule: "每天 02:30",
    files: [],
    configurable: true,
  } as DataSourceDoctorFacts["view"],
  lastOkAt: "2026-11-04T02:30:00+08:00",
  everyMs: 24 * 3_600_000,
};

const at = Date.parse("2026-11-07T15:30:00+08:00");
const ok = (key: string): DoctorFinding => ({ level: "ok", fact: { key } });

function doctor(extra: Partial<DoctorOptions> = {}) {
  return createDoctor({
    probes: probes(),
    now: () => at,
    plugins: () => PLUGINS,
    dataSources: () => [LOOKI],
    runtimes: () => [{ id: "codex", title: "Codex", plugin: "codex", available: false, missing: true, unavailable: "没装 Codex", capabilities: {} as never, settings: [] }],
    ...extra,
  });
}

const groupIds = (view: DoctorView) => view.groups.map((g) => g.id);
const itemsOf = (view: DoctorView, group: string) => view.groups.find((g) => g.id === group)!.items;

const before = activeLocale();
afterEach(() => setActiveLocale(before));

describe("分块", () => {
  it("二狗本身在最前（八项），插件块：有问题的在前，同一档照清单的先后；停用、移除了的不成块，只列名字", async () => {
    const view = await doctor().view();
    // voice 没装上（坏了）、looki 过期（注意）排前面；reminders、memory 正常；codex 只有不适用的
    expect(groupIds(view)).toEqual([DOCTOR_CORE_GROUP, "voice", "looki", "reminders", "memory", "codex"]);
    expect(view.groups[0]).toMatchObject({ kind: "core", title: "二狗本身", level: "ok" });
    expect(itemsOf(view, DOCTOR_CORE_GROUP).map((i) => i.id)).toEqual([...DOCTOR_CHECKS]);
    expect(view.off).toEqual([
      { plugin: "calendar", title: "日历", state: "disabled" },
      { plugin: "google", title: "Google", state: "removed" },
    ]);
    // 插件块：插件本身、数据源、运行时
    expect(itemsOf(view, "looki").map((i) => i.id)).toEqual(["plugin", "source:looki"]);
    expect(itemsOf(view, "codex").map((i) => [i.id, i.level])).toEqual([
      ["plugin", "na"],
      ["runtime:codex", "na"],
    ]);
    expect(view.groups.find((g) => g.id === "codex")!.level).toBe("na");
    expect(itemsOf(view, "voice")).toMatchObject([{ id: "plugin", level: "error", action: { kind: "open", route: "#/more/plugins" } }]);
  });

  it("总状态取最差的，数得出坏了、要注意、没查出来各几项", async () => {
    const view = await doctor().view();
    expect(view.level).toBe("error");
    expect(view.counts).toEqual({ error: 1, warn: 1, unknown: 0 });
    // 只剩注意的：总状态是注意
    const calm = await doctor({ plugins: () => PLUGINS.filter((p) => p.name !== "voice") }).view();
    expect(calm.level).toBe("warn");
  });

  it("每项的句子按当前语言拼好：中文、英文；插件块的标题是插件给人看的名字", async () => {
    const zh = await doctor().view();
    const source = itemsOf(zh, "looki").find((i) => i.id === "source:looki")!;
    expect(source.text).toEqual({ title: "数据源：Looki", fact: "85 小时没同步成功了（定期导入是每天 02:30）", fix: "去设置 · 数据源点开它，点「立即同步」看看还报不报错" });
    expect(source.since).toBe("2026-11-04T02:30:00+08:00");
    expect(itemsOf(zh, DOCTOR_CORE_GROUP)[0]!.text).toEqual({ title: "端口", fact: "本机端口 8810：在听，是二狗自己；外网端口 8811：在听，是二狗自己" });
    expect(itemsOf(zh, "voice")[0]!.text).toEqual({ title: "插件本身", fact: "没装上：装配出错：识别进程起不来", fix: "去设置 · 插件看看原因，修好之后在那里启用它（或者重启二狗）" });

    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const en = await doctor().view();
    expect(en.groups[0]!.title).toBe("ergo itself");
    expect(itemsOf(en, "looki").find((i) => i.id === "source:looki")!.text.fact).toBe("No successful sync for 85 hours (scheduled import: 每天 02:30)");
    expect(itemsOf(en, "codex").find((i) => i.id === "runtime:codex")!.text).toEqual({ title: "Runtime: Codex", fact: "Not installed (no task or project uses it): 没装 Codex" });
  });

  it("没装的运行时有任务或项目用着：坏了", async () => {
    const view = await doctor({ runtimeUsers: (id) => (id === "codex" ? 1 : 0) }).view();
    expect(itemsOf(view, "codex").find((i) => i.id === "runtime:codex")).toMatchObject({ level: "error", text: { fact: "没装，可有 1 个任务或项目用着它：没装 Codex" } });
    expect(view.groups.find((g) => g.id === "codex")!.level).toBe("error");
  });
});

describe("登记的检查", () => {
  it("插件登记的进它那一块（排在二狗替它生成的后面），内核登记的进二狗本身；不适用的排在块的最后", async () => {
    const checks = createDoctorChecks();
    checks.register({ plugin: "memory", id: "brief", title: "doctor.plugin.title", cost: "passive", run: () => ({ level: "na", fact: { key: "doctor.source.notConnected" } }) });
    checks.register({ plugin: "memory", id: "index", title: { key: "doctor.source.title", params: { name: "向量索引" } }, cost: "passive", run: () => ({ level: "warn", fact: { key: "doctor.source.never" }, action: { kind: "compact", agentId: "secretary" } }) });
    checks.register({ id: "backup", title: "doctor.plugin.title", cost: "passive", run: () => ok("doctor.plugin.running") });
    const view = await doctor({ checks }).view();
    expect(itemsOf(view, "memory").map((i) => [i.id, i.level])).toEqual([
      ["plugin", "ok"],
      ["index", "warn"],
      ["brief", "na"],
    ]);
    expect(itemsOf(view, "memory")[1]).toMatchObject({ title: { key: "doctor.source.title", params: { name: "向量索引" } }, text: { title: "数据源：向量索引" }, action: { kind: "compact", agentId: "secretary" } });
    expect(itemsOf(view, DOCTOR_CORE_GROUP).map((i) => i.id)).toEqual([...DOCTOR_CHECKS, "backup"]);
    // 不在插件清单里的（只给了登记表）照插件名单独一块
    const loose = await createDoctor({ probes: probes(), checks }).view();
    expect(groupIds(loose)).toEqual([DOCTOR_CORE_GROUP, "memory"]);
  });

  it("一项超时、抛错只算这一项没查出来，别的照常；没查出来不拉低总状态；所有项并行查", async () => {
    const checks = createDoctorChecks();
    checks.register({ plugin: "memory", id: "slow", title: "doctor.plugin.title", cost: "local", timeoutMs: 400, run: () => new Promise<DoctorFinding>(() => {}) });
    checks.register({ plugin: "memory", id: "slow-too", title: "doctor.plugin.title", cost: "local", timeoutMs: 400, run: () => new Promise<DoctorFinding>(() => {}) });
    checks.register({
      plugin: "memory",
      id: "broken",
      title: "doctor.plugin.title",
      cost: "passive",
      run: () => {
        throw new Error("推理库打不开");
      },
    });
    checks.register({ plugin: "memory", id: "fine", title: "doctor.plugin.title", cost: "passive", run: () => ok("doctor.plugin.running") });
    const started = Date.now();
    const view = await doctor({ checks, plugins: () => PLUGINS.filter((p) => p.name === "memory"), dataSources: () => [] }).view();
    // 两项各 400 毫秒超时，并行：不到两倍的时间
    expect(Date.now() - started).toBeLessThan(790);
    expect(itemsOf(view, "memory").map((i) => [i.id, i.level])).toEqual([
      ["plugin", "ok"],
      ["slow", "unknown"],
      ["slow-too", "unknown"],
      ["broken", "unknown"],
      ["fine", "ok"],
    ]);
    expect(itemsOf(view, "memory").find((i) => i.id === "broken")!.text).toEqual({ title: "插件本身", fact: "这次没查出来：查的时候出错了（推理库打不开）", fix: expect.stringContaining("再查一遍") });
    expect(view.groups.find((g) => g.id === "memory")!.level).toBe("ok");
    expect(view.level).toBe("ok");
    expect(view.counts).toEqual({ error: 0, warn: 0, unknown: 3 });
  });
});

describe("八项的结果几种", () => {
  it("好的正常，查不了的没查出来；坏了：端口、pi、模型的 key、磁盘是坏了，Node、服务管家、组件、外网入口是注意", async () => {
    const view = await createDoctor({
      probes: probes({
        ports: () => ({ ...GOOD.ports, externalUp: false }),
        node: () => ({ running: "24.1.0", expected: "22" }),
        disk: () => {
          throw new Error("读不了");
        },
        components: () => ({ missing: ["memory.semantic"] }),
        external: () => ({ configured: false }),
      }),
    }).view();
    const levels = Object.fromEntries(view.groups[0]!.items.map((i) => [i.id, i.level]));
    expect(levels).toEqual({ ports: "error", node: "warn", pi: "ok", supervisor: "ok", model: "ok", components: "warn", disk: "unknown", external: "warn" });
    for (const [id, data, level] of [
      ["pi", {}, "error"],
      ["model", { configured: false }, "error"],
      ["disk", { ...GOOD.disk, freeGb: 0.5 }, "error"],
      ["supervisor", { running: false }, "warn"],
    ] as const) {
      const one = await createDoctor({ probes: probes({ [id]: () => data }) }).view();
      expect(one.groups[0]!.items.find((i) => i.id === id)!.level).toBe(level);
    }
  });
});

describe("只查挑中的（include）", () => {
  it("挑掉的八项不在 checks 里、挑掉的项不在块里，没剩下一项的块不出现", async () => {
    const checks = createDoctorChecks();
    let ran = 0;
    checks.register({
      plugin: "memory",
      id: "index",
      title: "doctor.plugin.title",
      cost: "local",
      run: () => {
        ran += 1;
        return ok("doctor.plugin.running");
      },
    });
    const view = await doctor({ checks }).view({ include: (c) => c.cost === "passive" && c.id !== "pi" && c.group !== "voice" });
    expect(view.checks.map((c) => c.id)).toEqual(["node", "model", "components", "disk", "external"]);
    expect(ran).toBe(0);
    expect(groupIds(view)).not.toContain("voice");
    expect(itemsOf(view, "memory").map((i) => i.id)).toEqual(["plugin"]);
  });
});

/** 一块：这几项的结果 */
const g = (levels: ("ok" | "warn" | "error" | "unknown" | "na")[]) => ({ id: "x", kind: "plugin" as const, title: "x", level: worstLevel(levels), items: levels.map((level, i) => ({ id: String(i), level, title: { key: "k" }, fact: { key: "k" }, text: { title: "", fact: "" } })) });

describe("汇总的纯函数", () => {
  it("最差的：坏了 > 注意 > 正常；没查出来、不适用不拉低；全是没查出来是没查出来，全不适用是不适用，空的是正常", () => {
    expect(worstLevel(["ok", "warn", "unknown", "na"])).toBe("warn");
    expect(worstLevel(["unknown", "error"])).toBe("error");
    expect(worstLevel(["ok", "unknown"])).toBe("ok");
    expect(worstLevel(["unknown", "na"])).toBe("unknown");
    expect(worstLevel(["na"])).toBe("na");
    expect(worstLevel([])).toBe("ok");
  });

  it("总状态只看坏了、注意、正常；八项的结果几种照表", () => {
    expect(overallLevel([g(["unknown"]), g(["na"])])).toBe("ok");
    expect(overallLevel([g(["unknown"]), g(["warn"])])).toBe("warn");
    expect(legacyLevel({ id: "model", ok: false, data: { configured: false }, fix: "doctor.fix.model" })).toBe("error");
    expect(legacyLevel({ id: "model", ok: false, data: { configured: false }, fix: "doctor.fix.retry" })).toBe("unknown");
    // 块的先后：二狗本身不动，插件块坏了的在前
    expect(sortDoctorGroups([{ ...g(["ok"]), id: "core", kind: "core" }, { ...g(["ok"]), id: "a" }, { ...g(["warn"]), id: "b" }, { ...g(["error"]), id: "c" }, { ...g(["na"]), id: "d" }]).map((x) => x.id)).toEqual(["core", "c", "b", "a", "d"]);
  });
});
