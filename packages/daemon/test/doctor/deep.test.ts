// 深度体检（415，src/doctor/deep.ts、deep-checks.ts）：点了才跑、真试一遍——
// - 测模型的几种结局：假模型回 503 / 500 → 服务商忙（坏了）；到点中止 → 超时（注意）；Key 不对、欠费、限流、连不上、别的出错各一种、各配修法；
//   回了但首字很慢是注意；没配 Key 不发（不适用）；
// - 数据库完整性：没问题正常（写大小、用时），有不对的坏了（跳设置 · 备份）；真的 SQLite：好的临时库正常、写坏的文件坏了；
// - 数据源"测一下"：Key 不认坏了、到点没回注意、没连不测；
// - 平时体检（view）不跑 deep 那一档（跑了会记次数），deepPlan 才列出来，二狗本身在前、插件的按清单；
// - 跑法：同时最多两项、测完一项记一项（取的时候看得到测完的和还在测的）；结果缓存（只取不跑）、"几分钟前"的依据（finishedAt、now）；
//   防连点（测完不到一分钟再点抛 DeepDoctorTooSoon，拨过一分钟能再测）；正在测时再点不另起一次；一项抛错只算它没查出来。
import fs from "node:fs";
import path from "node:path";
import { DOCTOR_CHECKS, DOCTOR_CORE_GROUP, type DoctorCheckDataById, type DoctorCheckId, doctorItemText, type ModelTestResult, type PluginInfo } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDoctorChecks, type DoctorFinding } from "../../src/doctor/checks.ts";
import { createDeepDoctor, DEEP_DOCTOR_MIN_GAP_MS, DeepDoctorTooSoon } from "../../src/doctor/deep.ts";
import { judgeDatabase, judgeModelProbe, judgeSourceProbe, MODEL_PROBE_SLOW_MS, modelProbeFailure, registerDeepDoctorChecks } from "../../src/doctor/deep-checks.ts";
import type { DataSourceDoctorFacts } from "../../src/data-sources/service.ts";
import { createDoctor, type DoctorDeepCheck, type DoctorProbes } from "../../src/doctor/doctor.ts";
import { integrityCheck, openDatabase } from "../../src/storage/sqlite.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一项结果拼成句子（和 doctor.ts 一样） */
const said = (finding: DoctorFinding) => doctorItemText({ title: { key: "doctor.check.modelProbe.title" }, fact: finding.fact, ...(finding.fix ? { fix: finding.fix } : {}) });

const failed = (error: string, extra: Partial<ModelTestResult> = {}): ModelTestResult => ({ ok: false, modelId: "deepseek-flash", totalMs: 420, error, ...extra });

describe("深度体检：测模型", () => {
  it("假模型回 503 → 服务商忙（坏了），事实写状态码、用时，修法是等一会儿或换一个，带跳设置 · 模型", () => {
    const finding = judgeModelProbe(failed("503 Service Unavailable: server is overloaded"));
    expect(modelProbeFailure(failed("503 Service Unavailable"))).toBe("busy");
    expect(finding).toMatchObject({ level: "error", action: { kind: "open", route: "#/more/models" }, fix: { key: "doctor.fix.modelProbe.busy" } });
    expect(said(finding)).toEqual({
      title: "模型（真发一句）",
      fact: "deepseek-flash 没回成：服务商忙（503）（用了 0.4 秒）",
      fix: "服务商那边忙：等一会儿再测，或者在设置 · 模型里换一个",
    });
    // 500 也归服务商忙
    expect(modelProbeFailure(failed("500 Internal Server Error"))).toBe("busy");
    expect(said(judgeModelProbe(failed("Internal server error")))).toMatchObject({ fact: "deepseek-flash 没回成：服务商忙（用了 0.4 秒）" });
  });

  it("到点中止 → 超时（注意），写 8 秒", () => {
    const finding = judgeModelProbe(failed("超时（8 秒没回完），中止了这次请求", { timedOut: true, totalMs: 8_000 }));
    expect(modelProbeFailure({ timedOut: true })).toBe("timeout");
    expect(finding).toMatchObject({ level: "warn", fix: { key: "doctor.fix.modelProbe.timeout" } });
    expect(said(finding).fact).toBe("deepseek-flash 8 秒内没回完，中止了这次请求");
  });

  it("别的几种各一种、各配修法：Key 不对、欠费是坏了，限流是注意，连不上是坏了，认不出的带原话", () => {
    const cases: Array<[string, string, "error" | "warn"]> = [
      ["401 Authentication Fails, Your api key: ****abcd is invalid", "key", "error"],
      ["402 Insufficient Balance", "balance", "error"],
      ["429 Too Many Requests: rate limit reached", "rate", "warn"],
      ["fetch failed: connect ECONNREFUSED 127.0.0.1:443", "network", "error"],
      ["模型目录里没有 deepseek-nope", "other", "error"],
    ];
    for (const [error, kind, level] of cases) {
      expect(modelProbeFailure(failed(error))).toBe(kind);
      expect(judgeModelProbe(failed(error))).toMatchObject({ level, fix: { key: `doctor.fix.modelProbe.${kind}` } });
    }
    expect(said(judgeModelProbe(failed("402 Insufficient Balance"))).fact).toBe("deepseek-flash 没回成：欠费了（余额或额度不够）（用了 0.4 秒）");
    expect(said(judgeModelProbe(failed("模型目录里没有 deepseek-nope"))).fact).toBe("deepseek-flash 没回成：出错了：模型目录里没有 deepseek-nope（用了 0.4 秒）");
  });

  it("回了：写首字和整次的用时；首字超过 5 秒是注意（回得慢）；没配 Key 不发，不适用", () => {
    const fast = judgeModelProbe({ ok: true, modelId: "deepseek-flash", firstTokenMs: 820, totalMs: 1_240 });
    expect(fast.level).toBe("ok");
    expect(said(fast).fact).toBe("deepseek-flash 回了：首字 0.8 秒，整次 1.2 秒");
    const slow = judgeModelProbe({ ok: true, modelId: "deepseek-flash", firstTokenMs: MODEL_PROBE_SLOW_MS + 1_300, totalMs: 6_900 });
    expect(slow).toMatchObject({ level: "warn", fix: { key: "doctor.fix.modelProbeSlow" } });
    expect(said(slow).fact).toBe("deepseek-flash 回了，但很慢：首字 6.3 秒，整次 6.9 秒");
    expect(judgeModelProbe(undefined)).toEqual({ level: "na", fact: { key: "doctor.modelProbe.noKey" } });
  });
});

describe("深度体检：数据库完整性", () => {
  it("没问题正常（写大小和用时），有不对的坏了（写几处、第一处，跳设置 · 备份）", () => {
    expect(said(judgeDatabase({ problems: [], ms: 2_400, bytes: 312 * 1024 ** 2 })).fact).toBe("ergo.db 完整（312 MB，查了 2.4 秒）");
    expect(said(judgeDatabase({ problems: [], ms: 30, bytes: 2 * 1024 ** 3 })).fact).toBe("ergo.db 完整（2 GB，查了 0 秒）");
    const bad = judgeDatabase({ problems: ["*** in database main ***\nPage 7: btreeInitPage() returns error code 11", "row 3 missing from index"], ms: 1_000 });
    expect(bad).toMatchObject({ level: "error", fix: { key: "doctor.fix.database" }, action: { kind: "open", route: "#/more/backup" } });
    expect(said(bad).fact).toContain("ergo.db 有 2 处不对，第一处：*** in database main ***");
  });

  it("真的 SQLite（工作线程里，只读）：好的临时库没问题；写坏的文件查得出来", async () => {
    const dir = makeTempDir("ergo-deep-db-");
    const good = path.join(dir, "ergo.db");
    const db = openDatabase(good);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b');");
    db.close();
    expect(await integrityCheck(good)).toEqual([]);
    const broken = path.join(dir, "broken.db");
    fs.writeFileSync(broken, Buffer.concat([Buffer.from("SQLite format 3\u0000"), Buffer.alloc(4096, 7)]));
    expect((await integrityCheck(broken)).length).toBeGreaterThan(0);

    // 登记的那一项：读大小、量用时
    const registry = createDoctorChecks();
    registerDeepDoctorChecks(registry, { probeModel: async () => undefined, integrity: () => integrityCheck(good), eventsDb: good });
    const check = registry.list().find((c) => c.id === "database")!;
    expect(check.cost).toBe("deep");
    expect(check.plugin).toBeUndefined();
    expect((await check.run(new AbortController().signal)).level).toBe("ok");
  });
});

describe("深度体检：数据源测一下", () => {
  it("通了写账号和用时；Key 不认坏了（跳到这个数据源）；到点没回、限速是注意；没连不测", () => {
    expect(said(judgeSourceProbe("looki", true, { ok: true, account: "d***@example.com", ms: 640 })).fact).toBe("连上了，账号认得：d***@example.com（0.6 秒）");
    expect(judgeSourceProbe("looki", true, { ok: false, failure: "auth", reason: "Looki 不认这个 Key", ms: 300 })).toMatchObject({
      level: "error",
      fix: { key: "doctor.fix.sourceProbe.auth" },
      action: { kind: "open", route: "#/more/data-sources/looki" },
    });
    expect(judgeSourceProbe("looki", true, { ok: false, failure: "timeout", reason: "等太久没回", ms: 8_000 })).toMatchObject({ level: "warn", fact: { key: "doctor.sourceProbe.timeout" } });
    expect(judgeSourceProbe("looki", true, { ok: false, failure: "rate_limit", reason: "限速了", ms: 100 })).toMatchObject({ level: "warn", fact: { key: "doctor.sourceProbe.rateLimit" }, fix: { key: "doctor.fix.sourceProbe.rateLimit" } });
    expect(judgeSourceProbe("looki", false, undefined)).toEqual({ level: "na", fact: { key: "doctor.sourceProbe.notConnected" } });
  });

  it("二狗替登记了 probe 的数据源生成「连一下」：只给在跑的插件；数据源到点没接住中止、原样抛出来的算到点没回（不是没查出来）", async () => {
    const source = (id: string, owner: string, connection: "connected" | "not_connected") =>
      ({ view: { id, title: id, plugin: owner, connection } as unknown as DataSourceDoctorFacts["view"], probeable: true }) satisfies DataSourceDoctorFacts;
    let calls = 0;
    const doctor = createDoctor({
      probes,
      plugins: () => [plugin("hang", "挂着的"), plugin("off-src", "停着的", "disabled")],
      dataSources: () => [source("slow", "hang", "connected"), source("idle", "hang", "not_connected"), source("never", "off-src", "connected")],
      probeSource: (_id, signal) => {
        calls += 1;
        // 不理时限，只在中止时原样抛出来
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true }));
      },
    });
    const plan = doctor.deepPlan();
    expect(plan.map((c) => `${c.group}:${c.id}`)).toEqual(["hang:probe:slow", "hang:probe:idle"]);
    const [slow, idle] = await Promise.all(plan.map((c) => c.run()));
    expect(slow).toMatchObject({ level: "warn", fact: { key: "doctor.sourceProbe.timeout" } });
    expect(idle).toEqual({ level: "na", fact: { key: "doctor.sourceProbe.notConnected" } });
    expect(calls).toBe(1);
  }, 20_000);
});

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
const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, () => GOOD[id]])) as DoctorProbes;
const plugin = (name: string, title: string, state: PluginInfo["state"] = "running"): PluginInfo => ({ name, title, state }) as PluginInfo;

describe("平时体检不跑深度那一档", () => {
  it("view() 不跑、页面上没有这几项；deepPlan() 列出来（二狗本身在前，插件的按清单，停用的插件没有）", async () => {
    const registry = createDoctorChecks();
    let runs = 0;
    const counted = (): DoctorFinding => {
      runs += 1;
      return { level: "ok", fact: { key: "doctor.plugin.running" } };
    };
    registerDeepDoctorChecks(registry, {
      probeModel: async () => {
        runs += 1;
        return { ok: true, modelId: "deepseek-flash", firstTokenMs: 500, totalMs: 700 };
      },
      integrity: async () => {
        runs += 1;
        return [];
      },
      eventsDb: path.join(makeTempDir("ergo-deep-plan-"), "ergo.db"),
    });
    registry.register({ id: "login", plugin: "codex", title: "codex.doctor.login.title", cost: "deep", run: counted });
    registry.register({ id: "login", plugin: "claude-code", title: "claudeCode.doctor.login.title", cost: "deep", run: counted });
    registry.register({ id: "login", plugin: "off-one", title: "codex.doctor.login.title", cost: "deep", run: counted });
    const doctor = createDoctor({
      probes,
      checks: registry,
      plugins: () => [plugin("claude-code", "Claude Code"), plugin("codex", "Codex"), plugin("off-one", "停着的", "disabled")],
    });

    const view = await doctor.view();
    expect(runs).toBe(0);
    const ids = view.groups.flatMap((g) => g.items.map((i) => `${g.id}:${i.id}`));
    expect(ids).not.toContain(`${DOCTOR_CORE_GROUP}:model-probe`);
    expect(ids).not.toContain(`${DOCTOR_CORE_GROUP}:database`);
    expect(ids).not.toContain("codex:login");

    const plan = doctor.deepPlan();
    expect(plan.map((c) => `${c.group}:${c.id}`)).toEqual([`${DOCTOR_CORE_GROUP}:model-probe`, `${DOCTOR_CORE_GROUP}:database`, "claude-code:login", "codex:login"]);
    expect(runs).toBe(0);
    expect(doctor.groupTitle(DOCTOR_CORE_GROUP)).toBe("二狗本身");
    expect(doctor.groupTitle("codex")).toBe("Codex");
    // include 挑了也挑不到 deep 的（后台盯着走 view）
    await doctor.view({ include: () => true });
    expect(runs).toBe(0);
  });
});

/** 一项能从外面放行的检查：started 是开始跑了，finish 交回结果 */
function gate(group: string, id: string) {
  let finish: (finding: DoctorFinding) => void = () => {};
  let started = false;
  const check: DoctorDeepCheck = {
    group,
    id,
    title: { key: "doctor.check.database.title" },
    run: () => {
      started = true;
      return new Promise<DoctorFinding>((resolve) => {
        finish = resolve;
      });
    },
  };
  return { check, finish: (finding: DoctorFinding) => finish(finding), started: () => started };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("深度体检的跑法", () => {
  it("同时最多两项、测完一项记一项；结果缓存（只取不跑）；防连点：不到一分钟再点不让，拨过一分钟能再测；正在测时再点不另起一次", async () => {
    let now = Date.parse("2026-11-07T07:30:00.000Z");
    const a = gate(DOCTOR_CORE_GROUP, "model-probe");
    const b = gate(DOCTOR_CORE_GROUP, "database");
    const c = gate("looki", "probe:looki");
    let plans = 0;
    const deep = createDeepDoctor({
      doctor: {
        deepPlan: () => {
          plans += 1;
          return [a.check, b.check, c.check];
        },
        groupTitle: (group) => (group === DOCTOR_CORE_GROUP ? "二狗本身" : "Looki"),
      },
      now: () => now,
    });
    expect(deep.view()).toMatchObject({ state: "never", items: [] });

    const first = deep.start();
    expect(first.state).toBe("running");
    expect(first.items.map((i) => [i.groupTitle, i.id, i.state])).toEqual([
      ["二狗本身", "model-probe", "pending"],
      ["二狗本身", "database", "pending"],
      ["Looki", "probe:looki", "pending"],
    ]);
    await tick();
    // 同时最多两项：第三项还没开始
    expect([a.started(), b.started(), c.started()]).toEqual([true, true, false]);
    // 正在测时再点：交回正在测的那一份，不另起一次
    expect(deep.start().state).toBe("running");
    expect(plans).toBe(1);

    now += 1_200;
    b.finish({ level: "ok", fact: { key: "doctor.database.okNoSize", params: { seconds: "1.2" } } });
    await tick();
    const mid = deep.view();
    expect(mid.items.map((i) => i.state)).toEqual(["pending", "done", "pending"]);
    expect(mid.items[1]).toMatchObject({ ms: 1_200, item: { level: "ok", text: { title: "数据库完整性", fact: "ergo.db 完整（查了 1.2 秒）" } } });
    expect(c.started()).toBe(true);

    a.finish({ level: "error", fact: { key: "doctor.modelProbe.failed", params: { model: "m", why: "服务商忙（503）", seconds: "0.4" } }, fix: { key: "doctor.fix.modelProbe.busy" } });
    c.finish({ level: "ok", fact: { key: "doctor.sourceProbe.ok", params: { seconds: "0.6" } } });
    await deep.whenIdle();
    const done = deep.view();
    expect(done).toMatchObject({ state: "done", startedAt: "2026-11-07T07:30:00.000Z", finishedAt: "2026-11-07T07:30:01.200Z", counts: { error: 1, warn: 0, unknown: 0 } });
    expect(done.nextAt).toBe(new Date(Date.parse("2026-11-07T07:30:01.200Z") + DEEP_DOCTOR_MIN_GAP_MS).toISOString());

    // 缓存：过了几分钟再取还是那一份（不跑），now 跟着走（网页按它算"几分钟前"），能再测了就没有 nextAt
    now += 3 * 60_000;
    const later = deep.view();
    expect(later.finishedAt).toBe(done.finishedAt);
    expect(later.now).toBe(new Date(now).toISOString());
    expect(later.nextAt).toBeUndefined();
    expect(plans).toBe(1);

    // 防连点：测完不到一分钟再点不让
    const again = deep.start();
    expect(plans).toBe(2);
    expect(again.state).toBe("running");
    a.finish({ level: "ok", fact: { key: "doctor.plugin.running" } });
    b.finish({ level: "ok", fact: { key: "doctor.plugin.running" } });
    await tick();
    c.finish({ level: "ok", fact: { key: "doctor.plugin.running" } });
    await deep.whenIdle();
    now += 10_000;
    expect(() => deep.start()).toThrow(DeepDoctorTooSoon);
    const refused = (() => {
      try {
        deep.start();
        return undefined;
      } catch (err) {
        return err as DeepDoctorTooSoon;
      }
    })();
    expect(refused?.retryAfterMs).toBe(DEEP_DOCTOR_MIN_GAP_MS - 10_000);
    expect(refused?.message).toBe("刚测过，50 秒后再测");
    expect(plans).toBe(2);
    now += DEEP_DOCTOR_MIN_GAP_MS;
    deep.start();
    expect(plans).toBe(3);
  });

  it("一项抛错只算它没查出来，别的照常；没有要测的也照样测完", async () => {
    let now = 1_000_000;
    const deep = createDeepDoctor({
      doctor: {
        deepPlan: () => [
          { group: DOCTOR_CORE_GROUP, id: "boom", title: { key: "doctor.check.database.title" }, run: () => Promise.reject(new Error("炸了")) },
          { group: DOCTOR_CORE_GROUP, id: "fine", title: { key: "doctor.check.database.title" }, run: async () => ({ level: "ok", fact: { key: "doctor.plugin.running" } }) },
        ],
        groupTitle: () => "二狗本身",
      },
      now: () => now,
    });
    deep.start();
    await deep.whenIdle();
    expect(deep.view().items.map((i) => i.item?.level)).toEqual(["unknown", "ok"]);
    expect(deep.view().items[0]!.item!.text.fact).toBe("这次没查出来：查的时候出错了（炸了）");

    now += DEEP_DOCTOR_MIN_GAP_MS;
    const empty = createDeepDoctor({ doctor: { deepPlan: () => [], groupTitle: () => "" }, now: () => now });
    empty.start();
    await empty.whenIdle();
    expect(empty.view()).toMatchObject({ state: "done", items: [] });
  });

  it("超时只算这一项没查出来（登记的时限），测模型自己到点是「超时」那一种（有修法）", async () => {
    const registry = createDoctorChecks();
    registerDeepDoctorChecks(registry, {
      probeModel: async (timeoutMs) => ({ ok: false, modelId: "deepseek-flash", totalMs: timeoutMs, timedOut: true, error: "超时" }),
      integrity: async () => [],
      eventsDb: path.join(makeTempDir("ergo-deep-timeout-"), "ergo.db"),
    });
    registry.register({ id: "slow", plugin: "probe", title: "doctor.plugin.title", cost: "deep", timeoutMs: 100, run: () => new Promise<DoctorFinding>(() => {}) });
    const doctor = createDoctor({ probes, checks: registry });
    const deep = createDeepDoctor({ doctor, now: Date.now });
    deep.start();
    await deep.whenIdle();
    const items = deep.view().items;
    expect(items.map((i) => [i.id, i.item?.level])).toEqual([
      ["model-probe", "warn"],
      ["database", "ok"],
      ["slow", "unknown"],
    ]);
    expect(items[0]!.item!.text.fact).toBe("deepseek-flash 8 秒内没回完，中止了这次请求");
    expect(items[2]!.item!.text.fact).toBe("这次没查出来：0.1 秒内没查完");
  });
});
