// 334 号票（用户 2026-10-27 选 A，ADR-0032"前后两句对不上"）：你后来说的话不能被以前的话吞掉。
// - 前后两句意思相反、后说的那句没自己说"变了"：当矛盾——两条都是猜测、问题箱出一个"现在更接近哪个"，简报和快照里两句都给得出；
// - 后说的那句自己说了变化（"我以前……现在不……了"）：用户亲口说的变化，照旧新取代旧，旧的到这天为止；
// - 一句话抽出来的事实，开始不早于说这句话的那天（模型给 valid_from: null 时按说话那天算）。
// 例子是自己写的（照 334 号票里 p3 的读博那件事的样子，不看评测的标准答案）。
import { afterEach, describe, expect, it } from "vitest";
import { toMs } from "../../src/domain/time.ts";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { isRootGroup } from "../../src/rg/joint.ts";
import { closeEngines, explicitClaimOf, factOf, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const EARLIER = "2026-08-04T20:00:00+08:00";
const LATER = "2026-10-18T22:00:00+08:00";
const QUIT = "想好了，毕业先工作，不再读博了。";
const BACK = "在公司这两个月天天调同一张报表，挺没意思的，有点想回去读博了。";

/**
 * 假的抽取模型：照 DeepSeek 在 p3 上交的样子——先说的那句 valid_from 给了说话那天，后说的那句给 null（= 一直）；
 * change 都说 true（模型的 change 分不清"说了变了"和"只是相反"）
 */
function phdExtractor(): LlmFactExtractor {
  const model = new FakeChatModel((req: ChatRequest) => {
    const facts: unknown[] = [];
    for (const line of req.user.split("\n").filter((l) => l.startsWith("{"))) {
      const e = JSON.parse(line) as { evidence_id: string; text: string };
      const fact = (negated: boolean, context: string[], validFrom: string | null, statement: string, span: string) => ({
        evidence_id: e.evidence_id,
        predicate: "prefers",
        object: { name: "读博", type: "activity" },
        negated,
        context,
        valid_from: validFrom,
        statement,
        change: true,
        correction: false,
        span,
      });
      if (e.text.includes("不再读博")) facts.push(fact(true, ["learning", "work"], EARLIER, "用户 2026-08-04 表示不再读博", "不再读博了"));
      if (e.text.includes("想回去读博")) facts.push(fact(false, ["work"], null, "用户 2026-10-18 表示有点想回去读博", "有点想回去读博了"));
    }
    return { facts, relations: [], aliases: [] };
  });
  return new LlmFactExtractor(model);
}

async function phdStory() {
  const t = openEngine("2026-08-05T03:00:00+08:00", { extractor: phdExtractor(), embedder: new FakeEmbedder() });
  t.engine.ingestEvidence(say("ev-quit", QUIT, EARLIER, { context: ["learning", "work"] }));
  await t.engine.runNightly({ userActive: false });
  t.setNow("2026-10-19T03:00:00+08:00");
  t.engine.ingestEvidence(say("ev-back", BACK, LATER, { context: ["work"] }));
  await t.engine.runNightly({ userActive: false });
  await t.engine.indexVectors();
  return t;
}

describe("334：前后两句对不上，后说的没自己说变了 → 矛盾，哪边都不自动赢", () => {
  it("08-04「不再读博了」+ 10-18「有点想回去读博了」：两条都是猜测，新那句的有效期不早于 10-18", async () => {
    const { engine } = await phdStory();
    const quit = factOf(engine, "ev-quit", "prefers", "读博", true);
    const back = factOf(engine, "ev-back", "prefers", "读博", false);
    // 新那句没被旧的吞掉：开始不早于说它的那天（模型给的是 null），也没被标成被取代
    expect(back.validFrom).not.toBeNull();
    expect(toMs(back.validFrom!)).toBeGreaterThanOrEqual(toMs("2026-10-18T00:00:00+08:00"));
    expect(back.validTo).toBeNull();
    expect(quit.validFrom).toBe(EARLIER);
    // 事实这一层：真冲突，互相指着
    expect([quit.status, back.status]).toEqual(["contested", "contested"]);
    expect(quit.contestedWith).toEqual([back.id]);
    expect(back.contestedWith).toEqual([quit.id]);
    // 明说的结论：两条都是猜测（contested），互相竞争；谁也没被取代
    const a = explicitClaimOf(engine, quit);
    const b = explicitClaimOf(engine, back);
    expect([a.status, b.status]).toEqual(["contested", "contested"]);
    expect(a.competesWith).toEqual([b.id]);
    expect(b.competesWith).toEqual([a.id]);
    expect(a.supersededBy).toBeNull();
  });

  it("问题箱出一个'现在更接近哪个'：两句都在问法里，带日子；答了才定下来", async () => {
    const { engine } = await phdStory();
    const quit = factOf(engine, "ev-quit", "prefers", "读博", true);
    const back = factOf(engine, "ev-back", "prefers", "读博", false);
    const a = explicitClaimOf(engine, quit);
    const b = explicitClaimOf(engine, back);
    const asks = engine.listQuestions().filter((q) => q.kind === "contradiction");
    expect(asks).toHaveLength(1);
    const [q] = asks;
    expect(q!.targets.map((x) => x.id).toSorted()).toEqual([a.id, b.id].toSorted());
    expect(q!.text).toContain("8 月 4 日");
    expect(q!.text).toContain("10 月 18 日");
    expect(q!.text).toMatch(/更接近/);
    // "是"：现在更接近后说的那句——新的定下来、旧的到期；"不是"：反过来
    expect(q!.answers.yes.facts).toEqual({ activate: [back.id], supersede: [quit.id] });
    expect(q!.answers.no.facts).toEqual({ activate: [quit.id], supersede: [back.id] });
    // 同一件事不重复出"反常输入"（事实层没按观点变化接上）
    expect(engine.listQuestions().filter((x) => x.kind === "out_of_character")).toEqual([]);
  });

  it("334b（用户 10-27）：同一处矛盾只留这一个问题——矛盾根源那组的'是不同场合吗 / 有一条记错了吗 / 想法后来变过吗'不再另出，再整理一夜也一样", async () => {
    const t = await phdStory();
    const quit = factOf(t.engine, "ev-quit", "prefers", "读博", true);
    const back = factOf(t.engine, "ev-back", "prefers", "读博", false);
    const open = () => t.engine.listQuestions({ status: "open" });
    expect(open().map((q) => q.kind)).toEqual(["contradiction"]);
    // 矛盾根源那组照旧在（根源是猜测，简报里还列着），只是不另出问题
    const roots = t.engine.rg.registry.listGroups({ live: true }).filter(isRootGroup);
    expect(roots).toHaveLength(1);
    const sides = roots[0]!.params as { sideA: string[]; sideB: string[] };
    expect([...sides.sideA, ...sides.sideB].toSorted()).toEqual([quit.id, back.id].toSorted());
    t.setNow("2026-10-20T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    expect(open().map((q) => q.kind)).toEqual(["contradiction"]);
  });

  it("简报（D）和用户模型快照里两句都给得出：以前说……、最近又说……", async () => {
    const { engine } = await phdStory();
    const quit = factOf(engine, "ev-quit", "prefers", "读博", true);
    const back = factOf(engine, "ev-back", "prefers", "读博", false);
    const a = explicitClaimOf(engine, quit);
    const b = explicitClaimOf(engine, back);
    const brief = await engine.memoryBrief("他现在对读博怎么看？以前呢？", { at: "2026-10-20T12:00:00+08:00", group: "hybrid_kg_rg" });
    expect(brief.text).toContain("不再读博了");
    expect(brief.text).toContain("有点想回去读博了");
    expect(brief.text).toContain("2026-08-04");
    expect(brief.text).toContain("2026-10-18");
    expect(brief.claimIds).toEqual(expect.arrayContaining([a.id, b.id]));
    for (const id of [a.id, b.id]) expect(brief.profile!.claims.find((c) => c.claimId === id)?.status).toBe("contested");

    const model = engine.getUserModel({ at: "2026-10-20T12:00:00+08:00" });
    expect(model.preferences.map((e) => e.claimId)).not.toEqual(expect.arrayContaining([a.id]));
    const ua = model.uncertain.find((e) => e.claimId === a.id)!;
    const ub = model.uncertain.find((e) => e.claimId === b.id)!;
    expect(ua).toMatchObject({ status: "contested", label: "user_stated", evidenceIds: ["ev-quit"], competesWith: [b.id] });
    expect(ub).toMatchObject({ status: "contested", label: "user_stated", evidenceIds: ["ev-back"], competesWith: [a.id] });
  });
});

describe("334：后说的那句自己说了变化 → 用户亲口说的变化，新取代旧", () => {
  it("「我以前喜欢爬山，现在不喜欢了」：旧的到这天为止、被取代；新的成立；不当矛盾、不出问题", async () => {
    const t = openEngine("2026-03-02T03:00:00+08:00");
    t.engine.ingestEvidence(say("ev-like", "我喜欢爬山", "2026-03-01T10:00:00+08:00"));
    await t.engine.runNightly({ userActive: false });
    t.setNow("2026-10-19T03:00:00+08:00");
    t.engine.ingestEvidence(say("ev-not", "我以前喜欢爬山，现在不喜欢了", LATER));
    await t.engine.runNightly({ userActive: false });
    const old = factOf(t.engine, "ev-like", "prefers", "爬山");
    const neu = factOf(t.engine, "ev-not", "dislikes", "爬山");
    expect(old).toMatchObject({ status: "superseded", supersededBy: neu.id, validTo: LATER });
    expect(neu).toMatchObject({ status: "active", validFrom: LATER, validTo: null });
    expect(explicitClaimOf(t.engine, old)).toMatchObject({ status: "superseded", supersededBy: explicitClaimOf(t.engine, neu).id });
    expect(explicitClaimOf(t.engine, neu)).toMatchObject({ status: "active", confidence: "high" });
    expect(t.engine.listQuestions().filter((q) => q.kind === "contradiction")).toEqual([]);
  });

  it("模型版：后说的那句明说「不再…了」、模型却把 valid_from 给成 null——照样新取代旧，不被旧的吞掉", async () => {
    const model = new FakeChatModel((req: ChatRequest) => {
      const facts: unknown[] = [];
      for (const line of req.user.split("\n").filter((l) => l.startsWith("{"))) {
        const e = JSON.parse(line) as { evidence_id: string; text: string };
        const negated = e.text.includes("不再");
        facts.push({ evidence_id: e.evidence_id, predicate: "prefers", object: { name: "跑步", type: "activity" }, negated, valid_from: null, statement: negated ? "用户不再想跑步" : "用户想跑步", change: false, correction: false, span: e.text });
      }
      return { facts };
    });
    const t = openEngine("2026-03-02T03:00:00+08:00", { extractor: new LlmFactExtractor(model) });
    t.engine.ingestEvidence(say("ev-run", "我想每天跑步", "2026-03-01T10:00:00+08:00"));
    await t.engine.runNightly({ userActive: false });
    t.setNow("2026-10-19T03:00:00+08:00");
    t.engine.ingestEvidence(say("ev-stop", "膝盖不行，我不再想跑步了", LATER));
    await t.engine.runNightly({ userActive: false });
    const old = factOf(t.engine, "ev-run", "prefers", "跑步", false);
    const neu = factOf(t.engine, "ev-stop", "prefers", "跑步", true);
    expect(old).toMatchObject({ status: "superseded", supersededBy: neu.id, validFrom: "2026-03-01T10:00:00+08:00", validTo: LATER });
    expect(neu).toMatchObject({ status: "active", validFrom: LATER });
  });
});
