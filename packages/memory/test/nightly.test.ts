// 198 号票：每日整理（runNightly）。模拟时钟，不真起定时器。
// 规则：每天 03:00（可配置）跑一次 reflect；跑之前看用户是不是正在用，在用就往后推 30 分钟，最多推到 05:00（到 05:00 不再推，照跑）；
// 跑完出整理报告：新的、变了的、待复核的、问题队列的变化。
import { afterEach, describe, expect, it } from "vitest";
import { manualRunKey, nightlyDecision, SimClock } from "../src/nightly.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine, say } from "./rg/helpers.ts";

afterEach(closeEngines);

const FIRST_THREE = ["ev-w01", "ev-w02", "ev-w03"];

function weekendEngine() {
  const t = openEngine("2026-10-09T22:00:00+08:00");
  ingestWeekend(t.engine, FIRST_THREE);
  return t;
}

describe("什么时候跑：03:00，用户在用就推后，最晚 05:00", () => {
  it("没到 03:00 不跑，告诉下次几点；到点、用户没在用就跑；同一夜不跑第二次", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T02:10:00+08:00");
    expect(await t.engine.runNightly({ userActive: false })).toMatchObject({ ran: false, reason: "not_due", nextAt: "2026-10-10T03:00:00+08:00", night: "2026-10-10" });
    t.setNow("2026-10-10T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    expect(r).toMatchObject({ ran: true, night: "2026-10-10", deferrals: 0, late: false });
    t.setNow("2026-10-10T03:40:00+08:00");
    expect(await t.engine.runNightly({ userActive: false })).toMatchObject({ ran: false, reason: "already_ran", nextAt: "2026-10-11T03:00:00+08:00" });
  });

  it("用户在用：每次往后推 30 分钟；推到 05:00 不再推，照跑", async () => {
    const t = weekendEngine();
    const tries = ["03:00", "03:30", "04:00", "04:30"];
    for (const [i, hm] of tries.entries()) {
      t.setNow(`2026-10-10T${hm}:00+08:00`);
      const r = await t.engine.runNightly({ userActive: true });
      expect(r).toMatchObject({ ran: false, reason: "user_active", deferrals: i + 1 });
      expect(!r.ran && r.nextAt).toBe(i + 1 < tries.length ? `2026-10-10T${tries[i + 1]}:00+08:00` : "2026-10-10T05:00:00+08:00");
    }
    t.setNow("2026-10-10T05:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: true });
    expect(r).toMatchObject({ ran: true, deferrals: 4, late: true });
    expect(r.ran && r.report.text).toMatch(/05:00/);
  });

  it("没说用户在不在用时，看最近的本人记录：30 分钟里有新说的话就算在用", async () => {
    const t = weekendEngine();
    t.engine.ingestEvidence(say("ev-n1", "睡不着，再刷会儿手机。", "2026-10-10T02:50:00+08:00"));
    t.setNow("2026-10-10T03:00:00+08:00");
    expect(await t.engine.runNightly()).toMatchObject({ ran: false, reason: "user_active", nextAt: "2026-10-10T03:30:00+08:00" });
    t.setNow("2026-10-10T03:30:00+08:00");
    expect(await t.engine.runNightly()).toMatchObject({ ran: true, deferrals: 1 });
    // 也可以直接给最后一次在用的时间
    t.setNow("2026-10-11T03:00:00+08:00");
    expect(await t.engine.runNightly({ lastActiveAt: "2026-10-11T02:45:00+08:00" })).toMatchObject({ ran: false, reason: "user_active" });
  });

  it("时间可以配置（比如 02:00）；错过了（机器关着）白天补跑", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T02:00:00+08:00");
    expect(await t.engine.runNightly({ userActive: false, config: { time: "02:00" } })).toMatchObject({ ran: true });
    t.setNow("2026-10-11T14:00:00+08:00");
    expect(await t.engine.runNightly({ userActive: true })).toMatchObject({ ran: true, late: true });
  });

  it("模拟时钟：at 要和引擎的时钟一致", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T03:00:00+08:00");
    await expect(t.engine.runNightly({ at: "2026-10-10T04:00:00+08:00" })).rejects.toThrow(/时钟/);
  });

  it("推后规则本身（纯函数）", () => {
    const cfg = { time: "03:00", deferMinutes: 30, latest: "05:00", activeWindowMinutes: 30 };
    expect(nightlyDecision("2026-10-10T04:59:00+08:00", { ranNight: null, deferrals: 2 }, cfg, true)).toMatchObject({ run: false, reason: "user_active", nextAt: "2026-10-10T05:00:00+08:00" });
    expect(nightlyDecision("2026-10-10T05:00:00+08:00", { ranNight: null, deferrals: 4 }, cfg, true)).toMatchObject({ run: true, late: true });
    expect(nightlyDecision("2026-10-10T03:10:00+08:00", { ranNight: "2026-10-10", deferrals: 0 }, cfg, false)).toMatchObject({ run: false, reason: "already_ran" });
  });

  // 235 号票：用户点了"立即整理一次"（手动）：几点都跑、不管用户在不在用、这一夜跑过也照样进来；
  // 但不动那一夜的定时水位（03:00 照常跑），增量靠引擎自己的簿记（没新东西时几乎什么都不做）
  it("手动整理一次：没到 03:00、用户正在用、这一夜跑过都照跑；不重复处理，也不吃掉 03:00 那一夜", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T01:00:00+08:00");
    const first = await t.engine.runNightly({ manual: true, userActive: true });
    expect(first).toMatchObject({ ran: true, night: "2026-10-10", late: false, deferrals: 0 });
    expect(first.ran && first.report.reflect.processedEvidenceIds.length).toBeGreaterThan(0);
    const claimsAfterFirst = t.engine.store.listClaims().length;
    // 同一分钟再点：照样进来，但引擎的增量让它什么都不用做（不重复处理证据、不多出结论）
    const second = await t.engine.runNightly({ manual: true, userActive: true });
    expect(second).toMatchObject({ ran: true, night: "2026-10-10" });
    expect(second.ran && second.report.reflect.processedEvidenceIds).toEqual([]);
    expect(t.engine.store.listClaims().length).toBe(claimsAfterFirst);
    // 手动写在自己的运行状态键里，那一夜（night 那一行）还没被写成"已经整理过"
    const keys = () => t.engine.store.db.all<{ night: string }>("SELECT night FROM nightly_runs").map((row) => row.night);
    expect(keys()).toContain(manualRunKey("2026-10-10", "2026-10-10T01:00:00+08:00"));
    expect(keys()).not.toContain("2026-10-10");

    // 同一天 03:00 的定时那次照常跑：只处理这期间的新增量，跑完才把那一夜写成"已经整理过"
    t.engine.ingestEvidence(say("ev-n2", "周日想在家待着。", "2026-10-10T02:30:00+08:00"));
    t.setNow("2026-10-10T03:00:00+08:00");
    const scheduled = await t.engine.runNightly({ userActive: false });
    expect(scheduled).toMatchObject({ ran: true, night: "2026-10-10", late: false });
    expect(scheduled.ran && scheduled.report.reflect.processedEvidenceIds).toEqual(["ev-n2"]);
    expect(keys()).toContain("2026-10-10");
    expect(await t.engine.runNightly({ userActive: false })).toMatchObject({ ran: false, reason: "already_ran" });

    // 纯函数：manual 不看时间、不看用户在不在用、也不看这一夜跑过没有
    const cfg = { time: "03:00", deferMinutes: 30, latest: "05:00", activeWindowMinutes: 30 };
    expect(nightlyDecision("2026-10-10T01:00:00+08:00", { ranNight: null, deferrals: 0 }, cfg, true, { manual: true })).toMatchObject({ run: true, late: false });
    expect(nightlyDecision("2026-10-10T01:00:00+08:00", { ranNight: "2026-10-10", deferrals: 0 }, cfg, true, { manual: true })).toMatchObject({ run: true, late: false });
  });

  it("SimClock：拨时间、往后走", () => {
    const clock = new SimClock("2026-10-10T03:00:00+08:00");
    clock.advanceMinutes(30);
    expect(clock.now()).toBe("2026-10-10T03:30:00+08:00");
    clock.set("2026-10-11T03:00:00+08:00");
    expect(clock.now()).toBe("2026-10-11T03:00:00+08:00");
  });
});

describe("整理报告：新的、变了的、待复核的、问题队列的变化", () => {
  it("第一夜：新断言、新问题、问题队列（按优先级）；拼好的一段报告", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");
    const { report } = r;
    expect(report.reflect.processedEvidenceIds).toEqual(expect.arrayContaining(FIRST_THREE));
    expect(report.newClaims.map((c) => c.id)).toContain(claimOf(t.engine, "scene_autonomy").id);
    expect(report.questions.added.length).toBeGreaterThan(0);
    expect(report.questions.queue.map((q) => q.id)).toEqual(t.engine.listQuestions({ status: "open" }).map((q) => q.id));
    expect(report.needsReview).toEqual([]);
    expect(report.text).toContain("整理报告");
    expect(report.text).toContain("问题队列");
  });

  it("忘掉一条证据以后：标着复核的在报告里先列出来，整理重判后摘掉标记（真值状态当场就跟着证据变了）", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, [...FIRST_THREE, "ev-w04"]);
    t.setNow("2026-10-13T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.invalidateEvidence("ev-w04", "用户说忘掉");
    t.setNow("2026-10-14T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(r.report.reviewedClaims.map((c) => c.id)).toContain(autonomy.id);
    expect(r.report.text).toContain("跑之前标着复核的");
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "contested", needsReview: false });
    expect(r.report.needsReview.map((c) => c.id)).not.toContain(autonomy.id);
  });

  it("过期：问题到了过期时间还没问到，整理时标过期，不再顺口问", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const tiredQ = t.engine.listQuestions().find((q) => q.targets.some((x) => x.id === claimOf(t.engine, "recent_state").id) && q.kind === "unresolved")!;
    expect(tiredQ.expiresAt).toBe("2026-10-22T21:00:00+08:00");
    t.setNow("2026-10-23T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    expect(r.ran && r.report.questions.expired.map((q) => q.id)).toContain(tiredQ.id);
    expect(t.engine.listQuestions().find((q) => q.id === tiredQ.id)!.status).toBe("expired");
  });

  it("问了没回答，到夜里算跳过一次；永不推送：整理只更新问题箱，不往外发", async () => {
    const t = weekendEngine();
    t.setNow("2026-10-10T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    t.setNow("2026-10-10T20:00:00+08:00");
    const asked = t.engine.pickQuestion("这周六同学约我聚会，我还在想要不要去。");
    t.setNow("2026-10-11T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");
    expect(r.report.questions.skipped.map((q) => q.id)).toContain(asked.question!.id);
    expect(t.engine.listQuestions().find((q) => q.id === asked.question!.id)).toMatchObject({ status: "open", skippedCount: 1 });
    expect(Object.keys(r)).not.toContain("push");
  });
});
