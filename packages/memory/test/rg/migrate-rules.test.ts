// 329 号票（R16 ①，ADR-0032）：老库照新规矩迁移一次——待复核改成复核标记、恢复被 326 号票改过的身份、用户确认过的改挂依据、
// 传播铁律降回猜测、悬空的加复核标记；经唯一写入口（规矩迁移），跑两遍结果一样。老库的样子用绕过写入口直接改库造出来
// （连同当年那一笔修订），只在临时库上跑（不碰真库）。
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";
import { migrateToRules } from "../../src/rg/migrate-rules.ts";
import { closeEngines } from "./helpers.ts";
import { member, NEED, statedOf, storyEngine, VALUE, WEEKEND_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

const AT = "2026-10-12T12:00:00+08:00";

/** 绕过写入口直接改库，连同一笔修订（老代码当年写的样子） */
function legacy(engine: MemoryEngine, id: string, column: string, from: string, to: string, reason: string): void {
  const field = column === "status" ? "status" : column;
  engine.store.db.run(`UPDATE claims SET ${column} = ? WHERE id = ?`, to, id);
  engine.store.db.run(
    "INSERT INTO revisions (object_type, object_id, op, changes, cause_evidence_id, reason, at) VALUES ('claim', ?, 'update', ?, NULL, ?, ?)",
    id,
    JSON.stringify({ [field]: { from, to } }),
    reason,
    AT,
  );
}

/** 一个老库：需求转了待复核（推断一起停用）、明说的那条被 326 降成了假设、价值层压在拿不准的需求上还算成立 */
async function oldStore() {
  const t = await storyEngine();
  const need = member(t.engine, NEED, "need_autonomy");
  const value = member(t.engine, VALUE, "value_enduring");
  const stated = statedOf(t.engine, "ev-w3", "dislikes");
  const guess = member(t.engine, WEEKEND_GROUP, "recent_state");
  legacy(t.engine, need.id, "status", "active", "needs_review", "传播：前提失效（老代码转待复核）");
  for (const inf of t.engine.store.inferencesOf(need.id)) t.engine.store.db.run("UPDATE inferences SET status = 'needs_review' WHERE id = ?", inf.id);
  legacy(t.engine, stated.id, "kind", "conclusion", "hypothesis", "326：前提里有拿不准的事实，只能算假设");
  // 价值层还当成立、压在一条猜测上（绕过写入口留下的）
  const valueInference = t.engine.store.inferencesOf(value.id).find((i) => i.status === "active")!;
  t.engine.store.db.run("UPDATE inferences SET premise_ids = ? WHERE id = ?", JSON.stringify([guess.id]), valueInference.id);
  return { ...t, need, value, stated, guess };
}

describe("老库照新规矩迁移一次（migrateToRules）", () => {
  it("待复核 → 复核标记（状态回到之前的已验证，停用的推断恢复）；326 改过的身份改回去；压在猜测上的已验证降回猜测；自检全绿", async () => {
    const t = await oldStore();
    const report = migrateToRules(t.engine, { at: AT });
    expect(report.refused).toEqual([]);
    expect(report.reviewToFlag).toEqual([t.need.id]);
    expect(t.engine.store.getClaim(t.need.id)).toMatchObject({ status: "active", needsReview: true });
    expect(t.engine.store.inferencesOf(t.need.id).find((i) => i.status === "active")).toBeDefined();
    expect(report.kindsRestored).toEqual([t.stated.id]);
    expect(t.engine.store.getClaim(t.stated.id)!.kind).toBe("conclusion");
    expect(report.downgraded).toContain(t.value.id);
    expect(t.engine.store.getClaim(t.value.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(t.engine.store.inferencesOf(t.value.id).find((i) => i.status === "active")!.premiseIds).toEqual([t.guess.id]);
    expect(report.changed).toBe(true);
    // 每一笔都经写入口，记成规矩迁移
    expect(t.engine.gate.history(t.need.id).at(-1)).toMatchObject({ op: "migrate", actor: "nightly" });
    expect(t.engine.store.db.all("SELECT id FROM claims WHERE status = 'needs_review'")).toEqual([]);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });

  it("跑两遍结果一样：第二遍什么都不写", async () => {
    const t = await oldStore();
    migrateToRules(t.engine, { at: AT });
    const snapshot = JSON.stringify(t.engine.store.listClaims());
    const seq = t.engine.store.latestRevisionSeq();
    const again = migrateToRules(t.engine, { at: AT });
    expect(again).toEqual({ reviewToFlag: [], kindsRestored: [], directAttached: [], downgraded: [], flagged: [], refused: [], changed: false });
    expect(t.engine.store.latestRevisionSeq()).toBe(seq);
    expect(JSON.stringify(t.engine.store.listClaims())).toBe(snapshot);
  });

  it("用户确认过、还没改挂依据的：依据改挂到确认上、已验证；推理链记作历史", async () => {
    const t = await storyEngine();
    const guess = member(t.engine, WEEKEND_GROUP, "recent_state");
    const verdict = t.engine.recordClaimVerdict(guess.id, "confirm", { note: "测试" });
    // 老库：确认过的照旧挂在推理链上（直接证实那条推断不存在）
    for (const inf of t.engine.store.inferencesOf(guess.id)) {
      if (inf.rationale.startsWith("直接证实")) t.engine.store.db.run("DELETE FROM inferences WHERE id = ?", inf.id);
      else t.engine.store.db.run("UPDATE inferences SET status = 'active' WHERE id = ?", inf.id);
    }
    const report = migrateToRules(t.engine, { at: AT });
    expect(report.directAttached).toEqual([guess.id]);
    const active = t.engine.store.inferencesOf(guess.id).filter((i) => i.status === "active");
    expect(active.map((i) => i.premiseIds)).toEqual([[verdict.evidenceId]]);
    expect(t.engine.store.inferencesOf(guess.id).some((i) => i.status === "history")).toBe(true);
    expect(t.engine.store.getClaim(guess.id)!.status).toBe("active");
    expect(migrateToRules(t.engine, { at: AT }).changed).toBe(false);
  });

  it("悬空的（前提都撤了还活着）：加复核标记，下一次整理重判时撤回、墓碑指不在了的前提", async () => {
    const t = await storyEngine();
    const value = member(t.engine, VALUE, "value_phase");
    const need = member(t.engine, NEED, "need_autonomy");
    t.engine.store.db.run("UPDATE claims SET status = 'retracted', retracted_by = 'ev-w1' WHERE id = ?", need.id);
    t.engine.store.db.run("UPDATE inferences SET status = 'retracted' WHERE conclusion_claim_id = ?", need.id);
    const report = migrateToRules(t.engine, { at: AT });
    expect(report.flagged).toContain(value.id);
    expect(t.engine.store.getClaim(value.id)).toMatchObject({ status: "contested", needsReview: true });
    expect(checkReasoningGraph(t.engine.store).problems.filter((p) => p.subject === value.id)).toEqual([]);
  });
});
