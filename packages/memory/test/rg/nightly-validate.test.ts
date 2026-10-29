// 267 号票第 4 条：每晚整理完把推理图谱整张查一遍，不合格的结论转待复核，写进整理报告。
// 326 号票起校验是记忆系统自己的图谱自检（graphSelfCheck → rg/graph-check.ts），不起别的程序、不看本机装了什么；
// 这里有用它跑的，也有用假校验器跑的（看结果怎么落：转待复核、跳过、校验器出错）。
// 导出成 YAML（memory:dump-template 用的那一份）还在，单独测一条。
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEngine } from "../../src/engine.ts";
import { exportReasoningTemplate } from "../../src/rg/template-export.ts";
import { graphSelfCheck, validateNightly, type GraphValidation, type GraphValidator } from "../../src/rg/nightly-validate.ts";
import { claimOf, closeEngines, factOf, ingestWeekend, openEngine } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-13T12:00:00+08:00";

async function afterFour() {
  const t = openEngine("2026-10-09T12:00:00+08:00");
  ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
  await t.engine.reflect();
  t.setNow(NOW);
  ingestWeekend(t.engine, ["ev-w04"]);
  return t;
}

/** 假的校验器：记下交来的引擎，按给的结果回 */
function fakeValidator(result: (engine: MemoryEngine) => GraphValidation): GraphValidator & { seen: MemoryEngine[] } {
  const seen: MemoryEngine[] = [];
  return {
    name: "假校验器",
    seen,
    async validate(engine) {
      seen.push(engine);
      return result(engine);
    },
  };
}

/** 绕过写入口直接改库（造不合格的数据） */
const raw = (engine: MemoryEngine, sql: string, ...params: string[]) => engine.store.db.run(sql, ...params);

describe("导出成 YAML（同 memory:dump-template）", () => {
  it("带证据层：证据 → 事实 → 结论（往上抽的结论以别的结论为前提）；顶层有 changelog", async () => {
    const t = await afterFour();
    await t.engine.reflect();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const out = exportReasoningTemplate(t.engine.store.db, { withEvidence: true, questions: false, now: NOW });
    expect(out.yaml).toContain("changelog:");
    expect(out.yaml).toContain(`- id: ${autonomy.id}`);
    expect(out.yaml).toContain("- id: ev-w01");
    expect(out.counts.evidence).toBeGreaterThan(0);
    expect(out.counts.claims).toBe(t.engine.store.listClaims().length);
    expect(out.counts.questions).toBe(0);
  });
});

describe("每晚校验：记忆系统自己的图谱自检", () => {
  it("整理出来的图通过：校验照样做完（不是跳过），报告里写查了几个节点、通过了", async () => {
    const t = await afterFour();
    const result = await t.engine.runNightly({ userActive: false, validator: graphSelfCheck });
    if (!result.ran) throw new Error("应该跑了");
    expect(result.report.validation).toMatchObject({ state: "ok", validator: "图谱自检", claimIds: [], problems: [] });
    expect(result.report.validation!.nodes).toBeGreaterThan(10);
    expect(result.report.text).toContain(`每晚校验：查了 ${result.report.validation!.nodes} 个节点，图谱自检通过`);
  });

  it("前提事实被纠正了（绕过写入口改的）：图谱自检点名那条已验证的结论，照传播铁律降回猜测（下游跟着降），修订写明是每晚校验、留痕记夜班", async () => {
    const t = await afterFour();
    await t.engine.reflect();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    const premise = t.engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!.premiseIds.find((id) => id.startsWith("fa-"))!;
    raw(t.engine, "UPDATE facts SET status = 'corrected', retracted_by = 'ev-w01' WHERE id = ?", premise);
    t.setNow("2026-10-14T12:00:00+08:00");
    const result = await t.engine.runNightly({ userActive: false, validator: graphSelfCheck });
    if (!result.ran) throw new Error("应该跑了");
    const v = result.report.validation!;
    expect(v.state).toBe("failed");
    expect(v.problems.find((line) => line.startsWith(`${autonomy.id}：`))).toContain(`${premise}（被纠正了）`);
    // 329 号票：违反传播铁律的不再转待复核，降回猜测（前提照挂、保留）；报告里记"降回猜测"
    expect(v.downgraded).toContain(autonomy.id);
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("contested");
    expect(t.engine.store.revisions(autonomy.id, "claim").at(-1)!.reason).toContain("每晚校验");
    expect(t.engine.gate.history(autonomy.id).at(-1)).toMatchObject({ actor: "nightly", op: "validate" });
    expect(result.report.text).toContain("每晚校验：图谱自检报了");
  });

  it("坏数据（JSON 坏了）：校验不抛错，问题照样交回；读不出来的结论改不了，别的照改", async () => {
    const t = await afterFour();
    await t.engine.reflect();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const premise = t.engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!.premiseIds.find((id) => id.startsWith("fa-"))!;
    // 这条事实坏了：以它为前提的结论（主语是事实）转待复核时要沿着它找下游
    raw(t.engine, "UPDATE facts SET status = 'corrected', retracted_by = 'ev-w01' WHERE id = ?", premise);
    // 另一条结论的 JSON 坏了：读不出来，只能报，转不了（整理别的步骤读到坏行会抛错，那不归校验管）
    const broken = t.engine.store.listClaims({ status: ["active", "contested"] }).find((c) => c.id !== autonomy.id)!;
    raw(t.engine, "UPDATE claims SET predicts = '[坏了' WHERE id = ?", broken.id);
    const v = await validateNightly(t.engine, graphSelfCheck);
    expect(v.state).toBe("failed");
    expect(v.problems).toContainEqual(expect.stringContaining(`${broken.id}：结论读不出来`));
    expect([...v.claimIds, ...v.downgraded]).toContain(autonomy.id);
    expect([...v.claimIds, ...v.downgraded]).not.toContain(broken.id);
  });
});

describe("每晚校验：结果怎么落（假校验器）", () => {
  it("校验通过：什么都不改，报告里写一句通过了；校验器拿到的是这一份引擎", async () => {
    const t = await afterFour();
    const validator = fakeValidator(() => ({ state: "ok" }));
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    expect(validator.seen).toEqual([t.engine]);
    expect(result.report.validation).toMatchObject({ state: "ok", claimIds: [] });
    expect(result.report.text).toMatch(/每晚校验：.*通过/);
  });

  it("不合格的结论加复核标记（真值状态不动）：修订写明是每晚校验，留痕记成夜班，整理报告里列出来", async () => {
    const t = await afterFour();
    const id = claimOf(t.engine, "scene_autonomy").id;
    const validator = fakeValidator((engine) => ({ state: "failed", problems: engine.store.getClaim(id) ? [`${id}：成立，但推出它的前提不成立了`] : [] }));
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy).toMatchObject({ status: "active", needsReview: true });
    expect(result.report.validation).toMatchObject({ state: "failed", claimIds: [autonomy.id] });
    expect(t.engine.store.revisions(autonomy.id, "claim").at(-1)!.reason).toContain("每晚校验");
    expect(t.engine.gate.history(autonomy.id).at(-1)).toMatchObject({ actor: "nightly", op: "validate" });
    expect(result.report.needsReview.map((c) => c.id)).toContain(autonomy.id);
    expect(result.report.text).toContain("每晚校验");
    expect(result.report.text).toContain(autonomy.id);
  });

  it("主语是一条事实：以它为前提或支持的结论加复核标记", async () => {
    const t = await afterFour();
    await t.engine.reflect();
    const party = factOf(t.engine, "ev-w01", "declined", "聚会");
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    t.setNow("2026-10-14T12:00:00+08:00");
    const validator = fakeValidator(() => ({ state: "failed", problems: [`${party.id}：事实字段不合格：statement 应为非空字符串`] }));
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", needsReview: true });
    expect(result.report.validation!.claimIds).toContain(autonomy.id);
  });

  it("行里顺带提到的别的结论不算：只转行首那一条（主语）", async () => {
    const t = await afterFour();
    await t.engine.reflect();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const others = t.engine.store.listClaims({ status: ["active", "contested"] }).filter((c) => c.id !== autonomy.id);
    expect(others.length).toBeGreaterThan(0);
    t.setNow("2026-10-14T12:00:00+08:00");
    const other = others[0]!;
    const validator = fakeValidator(() => ({ state: "failed", problems: [`${other.id}：成立，但推出它的前提 ${autonomy.id}（拿不准）不成立了`] }));
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    expect(result.report.validation!.claimIds).toEqual([other.id]);
    expect(t.engine.store.getClaim(autonomy.id)!.status).not.toBe("needs_review");
  });

  it("校验器说跳过：报告里写明原因，什么都不改", async () => {
    const t = await afterFour();
    const validator = fakeValidator(() => ({ state: "skipped", reason: "这一夜不查" }));
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    expect(result.report.validation).toMatchObject({ state: "skipped", reason: "这一夜不查", claimIds: [] });
    expect(result.report.text).toContain("每晚校验：跳过（这一夜不查）");
  });

  it("校验器自己出错：按跳过记，整理不失败", async () => {
    const t = await afterFour();
    const validator: GraphValidator = {
      name: "broken",
      async validate() {
        throw new Error("校验器崩了");
      },
    };
    const result = await t.engine.runNightly({ userActive: false, validator });
    if (!result.ran) throw new Error("应该跑了");
    expect(result.report.validation).toMatchObject({ state: "skipped" });
    expect(result.report.validation!.reason).toContain("校验器崩了");
  });
});
