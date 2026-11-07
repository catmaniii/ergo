// 体检项的登记表和跑法（409，src/doctor/checks.ts）：
// - 登记返回撤销函数；id 的规矩、二狗自己用的 id、同一块里重名都拒；不同插件可以同名；
// - 查一项：交回的结果原样（只留认得的几样）；超时（到点置中止信号）、同步抛错、异步抛错、交回的东西不像样都只算"没查出来"，
//   修法是"再查一遍"，从不抛错；不给超时用默认的 1.5 秒。
import { DOCTOR_FIX_UNKNOWN } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDoctorChecks, DOCTOR_CHECK_TIMEOUT_MS, type DoctorCheck, type DoctorFinding, runDoctorCheck, validFinding } from "../../src/doctor/checks.ts";

const ok: DoctorFinding = { level: "ok", fact: { key: "doctor.plugin.running" } };

const check = (id: string, run: DoctorCheck["run"], extra: Partial<DoctorCheck> = {}): DoctorCheck => ({ id, title: "doctor.plugin.title", cost: "passive", run, ...extra });

describe("登记表", () => {
  it("登记、列出（按先后）、撤销；撤销两次没事", () => {
    const registry = createDoctorChecks();
    const undoA = registry.register({ ...check("index", () => ok), plugin: "memory" });
    registry.register({ ...check("speech", () => ok), plugin: "voice" });
    registry.register(check("backup", () => ok));
    expect(registry.list().map((c) => `${c.plugin ?? "-"}:${c.id}`)).toEqual(["memory:index", "voice:speech", "-:backup"]);
    undoA();
    undoA();
    expect(registry.list().map((c) => c.id)).toEqual(["speech", "backup"]);
  });

  it("id 不合规矩、是二狗自己用的、同一块里重名、cost 不认得：都拒；不同插件可以同名", () => {
    const registry = createDoctorChecks();
    expect(() => registry.register(check("Index", () => ok))).toThrow(/不合规矩/);
    expect(() => registry.register(check("source:x", () => ok))).toThrow(/不合规矩/);
    expect(() => registry.register({ ...check("plugin", () => ok), plugin: "memory" })).toThrow(/二狗自己用的/);
    expect(() => registry.register(check("ports", () => ok))).toThrow(/二狗自己用的/);
    expect(() => registry.register(check("index", () => ok, { cost: "network" as never }))).toThrow(/cost/);
    registry.register({ ...check("index", () => ok), plugin: "memory" });
    expect(() => registry.register({ ...check("index", () => ok), plugin: "memory" })).toThrow(/重名/);
    registry.register({ ...check("index", () => ok), plugin: "voice" });
    expect(registry.list()).toHaveLength(2);
  });
});

describe("查一项", () => {
  it("交回的结果原样（五种结果、事实、怎么修、从什么时候起、动作），认不得的字段不带", async () => {
    const finding = {
      level: "warn",
      fact: { key: "doctor.source.stale", params: { hours: 80, schedule: "每天 02:30" } },
      fix: { key: "doctor.fix.sourceSync" },
      since: "2026-11-04T02:30:00+08:00",
      action: { kind: "open", route: "#/more/data-sources/looki" },
      extra: "不要",
    };
    expect(await runDoctorCheck(check("looki", () => finding as unknown as DoctorFinding))).toEqual({
      level: "warn",
      fact: { key: "doctor.source.stale", params: { hours: 80, schedule: "每天 02:30" } },
      fix: { key: "doctor.fix.sourceSync" },
      since: "2026-11-04T02:30:00+08:00",
      action: { kind: "open", route: "#/more/data-sources/looki" },
    });
    expect(await runDoctorCheck(check("na", async () => ({ level: "na", fact: { key: "doctor.source.notConnected" } })))).toEqual({ level: "na", fact: { key: "doctor.source.notConnected" } });
  });

  it("超时：到点置中止信号，算没查出来（事实写几秒，修法是再查一遍），日志记一行", async () => {
    let aborted = false;
    const logs: string[] = [];
    const started = Date.now();
    const finding = await runDoctorCheck(
      check(
        "slow",
        (signal) =>
          new Promise<DoctorFinding>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => resolve(ok), 5_000).unref?.();
          }),
        { timeoutMs: 50 },
      ),
      (line) => logs.push(line),
    );
    expect(finding).toEqual({ level: "unknown", fact: { key: "doctor.unknown.timeout", params: { seconds: 0.1 } }, fix: { key: DOCTOR_FIX_UNKNOWN } });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs.join("\n")).toMatch(/slow 50 毫秒没查完/);
  });

  it("同步抛错、异步抛错：算没查出来，事实里带出错的原文（压成一行、截短）", async () => {
    const sync = await runDoctorCheck(
      check("sync", () => {
        throw new Error("读不了\n索引文件");
      }),
    );
    expect(sync).toEqual({ level: "unknown", fact: { key: "doctor.unknown.failed", params: { message: "读不了 索引文件" } }, fix: { key: DOCTOR_FIX_UNKNOWN } });
    const async = await runDoctorCheck(check("async", () => Promise.reject(new Error("x".repeat(500)))));
    expect(async.level).toBe("unknown");
    expect(String(async.fact.params?.message).length).toBeLessThanOrEqual(161);
  });

  it("交回的东西不像样（结果不是五种之一、没有事实、动作不认得、时间不是时间）：算没查出来", async () => {
    for (const bad of [undefined, "ok", { level: "fine", fact: { key: "x" } }, { level: "ok" }, { level: "ok", fact: { key: "" } }, { level: "ok", fact: { key: "x" }, action: { kind: "restart" } }, { level: "ok", fact: { key: "x" }, action: { kind: "open", route: "http://x" } }, { level: "ok", fact: { key: "x" }, since: "昨天" }]) {
      expect(validFinding(bad)).toBeUndefined();
      expect((await runDoctorCheck(check("bad", () => bad as unknown as DoctorFinding))).fact).toEqual({ key: "doctor.unknown.bad" });
    }
    expect(validFinding({ level: "error", fact: { key: "x" }, action: { kind: "compact", agentId: "secretary" } })).toEqual({ level: "error", fact: { key: "x" }, action: { kind: "compact", agentId: "secretary" } });
  });

  it("不给超时用默认的 1.5 秒", () => {
    expect(DOCTOR_CHECK_TIMEOUT_MS).toBe(1_500);
  });
});
