// 333 号票（R16 ②，ADR-0032 的"全量重判一次"）：规矩改了以后把现有的结论按新规矩全过一遍（假模型）。
// 搭一个小世界：五个话题各两条证据，第一夜照每晚整理建好五组竞争假设、每组一条追问；再绕过写入口把库改成老代码留下的样子——
//   皮划艇：组被老代码当"组不成立了"撤了，两条结论撤回、墓碑指着还在的观察（被错撤的，R8 / Q2）；
//   羽毛球：已验证的那条被老代码转成"待复核"状态（329 的迁移改成复核标记）；
//   电子琴：一句随口说的被当成决定性反证、把"喜欢"撤了（R14 起随口说的按强的算）；
//   乒乓球：两条证据用户都让忘掉了——前提都不在了，撤回站得住；
//   天文台：没动过，模型不重判它。
// 测：每一步做对、标着复核的组才由模型重跑追问；跑两遍结果一样；能撤回；进度和花费对得上。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import { MemoryEngine } from "../../src/engine.ts";
import { FULL_REJUDGE_PHASES, type FullRejudgeProgress, runFullRejudge, undoFullRejudge } from "../../src/full-rejudge.ts";
import { FakeChatModel, type ChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { DEEPSEEK_PRICES } from "../../src/llm/estimate.ts";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { MeteredChat } from "../../src/llm/metered.ts";
import { LlmReasoner } from "../../src/rg/llm-reasoner.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";

const TOPICS = ["皮划艇", "羽毛球", "电子琴", "乒乓球", "天文台"] as const;
/** 判证据时给"喜欢"一条强支持的话题（第一夜就够已验证） */
const SUPPORTED = new Set(["羽毛球", "天文台"]);
const AT = "2026-10-26T03:00:00+08:00";
const RUN_AT = "2026-10-27T13:00:00+08:00";

const topicOf = (text: string) => TOPICS.find((k) => text.includes(k));
const ids = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

const said = (id: string, topic: string, day: number, hour: number): EvidenceDraft => {
  const at = `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  return { id, sourceLevel: "self", mode: "say", kind: "utterance", text: `这周我又去弄了${topic}，挺喜欢的。`, context: ["leisure"], eventTime: at, observedAt: at };
};

/** 假模型（同 nightly-lanes 的小世界）：一条证据一条观察；同一话题两条观察一组（喜欢 / 最近在试）；每组一条追问；判证据记下问了哪个话题 */
function fakeModel() {
  const asked: string[] = [];
  const model = new FakeChatModel((req: ChatRequest) => {
    if (req.purpose === "extract") {
      const lines = req.user.split("\n").filter((l) => l.startsWith("{"));
      return {
        facts: lines.flatMap((l) => {
          const e = JSON.parse(l) as { evidence_id: string; text: string };
          const topic = topicOf(e.text);
          if (topic === undefined) return [];
          const name = `${topic}（${e.evidence_id}）`;
          return [{ evidence_id: e.evidence_id, predicate: "prefers", object: { name, type: "activity" }, negated: false, context: ["leisure"], statement: `用户喜欢${name}`, span: topic }];
        }),
      };
    }
    if (req.purpose === "propose") {
      const batch = req.user.split("这一批的观察")[1]!.split("别的事实")[0]!;
      const byTopic = new Map<string, string[]>();
      for (const line of batch.split("\n").filter((l) => l.startsWith("{"))) {
        const f = JSON.parse(line) as { fact_id: string; evidence: { text: string }[] };
        const topic = topicOf(f.evidence.map((e) => e.text).join(""));
        if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), f.fact_id]);
      }
      return {
        groups: [...byTopic]
          .filter(([, facts]) => facts.length >= 2)
          .map(([topic, facts]) => ({
            observation_ids: facts,
            description: `${topic}这件事`,
            hypotheses: [
              { tier: "preference", statement: `用户喜欢${topic}`, context: ["leisure"], supports: [{ target: facts[0], weight: "strong", rationale: "说喜欢" }], refutes: [] },
              { tier: "state", statement: `用户最近在试${topic}`, context: ["leisure"], valid_to: null, supports: [{ target: facts[1], weight: "weak", rationale: "最近又去" }], refutes: [] },
            ],
          })),
      };
    }
    if (req.purpose === "probes") {
      const topic = topicOf(req.user)!;
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      return { probes: [{ discriminates: [claims[0], claims[1]], ask: `${topic}问一下`, queries: [topic], if_found: claims[0] }] };
    }
    if (req.purpose === "judge") {
      const ask = /追问：(\S+?)（/.exec(req.user)![1]!;
      const topic = topicOf(ask)!;
      asked.push(topic);
      if (!SUPPORTED.has(topic)) return { found_evidence_ids: [], if_found: null, links: [] };
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      const evidence = ids(/"evidence_id":"(ev-[^"]+)"/g, req.user);
      const last = evidence.at(-1)!;
      return { found_evidence_ids: [last], if_found: claims[0], links: [{ claim_id: claims[0], evidence_id: last, polarity: "supports", weight: "strong", rationale: "又说喜欢" }] };
    }
    return {};
  }, "deepseek-flash");
  return { model, asked };
}

/** 换得掉后面那个模型的转接（建世界时用假模型本身，全量重判时换成包了计量的） */
class Relay implements ChatModel {
  readonly name = "deepseek-flash";
  target: ChatModel;
  constructor(target: ChatModel) {
    this.target = target;
  }
  complete(request: ChatRequest) {
    return this.target.complete(request);
  }
}

const open: MemoryEngine[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const e of open.splice(0)) e.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface World {
  engine: MemoryEngine;
  file: string;
  dir: string;
  setNow(at: string): void;
  relay: Relay;
  fake: ReturnType<typeof fakeModel>;
  claim(topic: string, template: "喜欢" | "在试"): Claim;
}

/** 绕过写入口直接改库，连同老代码当年写的那一笔修订 */
function legacy(engine: MemoryEngine, id: string, set: Record<string, string | null>, changes: Record<string, { from: unknown; to: unknown }>, reason: string): void {
  for (const [column, value] of Object.entries(set)) engine.store.db.run(`UPDATE claims SET ${column} = ? WHERE id = ?`, value, id);
  engine.store.db.run("INSERT INTO revisions (object_type, object_id, op, changes, cause_evidence_id, reason, at) VALUES ('claim', ?, 'update', ?, NULL, ?, ?)", id, JSON.stringify(changes), reason, AT);
}

async function world(): Promise<World> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-rejudge-"));
  dirs.push(dir);
  const file = path.join(dir, "rg.db");
  let now = "2026-10-11T03:00:00+08:00";
  const fake = fakeModel();
  const relay = new Relay(fake.model);
  const engine = MemoryEngine.open({ file, clock: () => now, reasoner: new LlmReasoner(relay), extractor: new LlmFactExtractor(relay), joint: false });
  open.push(engine);
  TOPICS.forEach((topic, i) => {
    engine.ingestEvidence(said(`ev-${i}a`, topic, i + 1, 9));
    engine.ingestEvidence(said(`ev-${i}b`, topic, i + 1, 21));
  });
  await engine.reflect({ maxModelCalls: 500 });
  const claim = (topic: string, template: "喜欢" | "在试") => {
    const c = engine.store.listClaims().find((x) => x.statement === `用户${template === "喜欢" ? "喜欢" : "最近在试"}${topic}`);
    if (!c) throw new Error(`没有 ${topic} ${template}`);
    return engine.store.getClaim(c.id)!;
  };
  expect(engine.rg.registry.listGroups({ live: true })).toHaveLength(5);
  expect(claim("羽毛球", "喜欢").status).toBe("active");

  now = AT;
  // 乒乓球：两条证据都让忘掉了（照新规矩当场传播：前提都不在了，撤回；老状态造出来之前做，免得传播碰到老状态）
  engine.invalidateEvidence("ev-3a", "测试：忘掉");
  engine.invalidateEvidence("ev-3b", "测试：忘掉");
  expect(claim("乒乓球", "喜欢").status).toBe("retracted");
  // 皮划艇：老代码"观察模式不成立了，撤回，留墓碑"（墓碑指还在的观察，组撤下）
  const kayak = engine.rg.registry.listGroups().find((g) => g.description.startsWith("皮划艇"))!;
  engine.store.db.run("UPDATE rg_groups SET live = 0 WHERE key = ?", kayak.key);
  for (const t of ["喜欢", "在试"] as const) {
    const c = claim("皮划艇", t);
    legacy(engine, c.id, { status: "retracted", retracted_by: kayak.observationIds[0]! }, { status: { from: c.status, to: "retracted" }, retractedBy: { from: null, to: kayak.observationIds[0] } }, "观察模式不成立了（还剩 1 条观察），撤回，留墓碑");
    engine.store.db.run("UPDATE inferences SET status = 'retracted' WHERE conclusion_claim_id = ?", c.id);
  }
  // 羽毛球：老代码把已验证的转成"待复核"状态（推断一起停用）
  const badminton = claim("羽毛球", "喜欢");
  legacy(engine, badminton.id, { status: "needs_review" }, { status: { from: "active", to: "needs_review" } }, "传播：前提失效（老代码转待复核）");
  engine.store.db.run("UPDATE inferences SET status = 'needs_review' WHERE conclusion_claim_id = ?", badminton.id);
  // 电子琴：一句随口说的被当成决定性反证，"喜欢"撤了
  engine.ingestEvidence({ ...said("ev-casual", "电子琴", 20, 20), text: "电子琴嘛，其实也就那样。" });
  const piano = claim("电子琴", "喜欢");
  engine.store.db.run("INSERT INTO links (claim_id, target, polarity, rationale, weight) VALUES (?, 'ev-casual', 'refutes', '用户明说没那么喜欢', 'decisive')", piano.id);
  legacy(engine, piano.id, { status: "retracted", retracted_by: "ev-casual" }, { status: { from: piano.status, to: "retracted" }, retractedBy: { from: null, to: "ev-casual" } }, "决定性反证 ev-casual：用户明说没那么喜欢");
  engine.store.db.run("UPDATE inferences SET status = 'retracted' WHERE conclusion_claim_id = ?", piano.id);
  now = RUN_AT;
  fake.asked.length = 0;
  fake.model.calls.length = 0;
  return { engine, file, dir, setNow: (at) => (now = at), relay, fake, claim };
}

/** 比较用的样子（不看复核时间这类时间戳） */
const shape = (engine: MemoryEngine) =>
  JSON.stringify({
    claims: engine.store.listClaims().map((c) => [c.id, c.status, c.confidence, c.kind, c.needsReview, c.retractedBy, c.supersededBy]),
    inferences: engine.store.listClaims().flatMap((c) => engine.store.inferencesOf(c.id).map((i) => [i.id, i.status, i.premiseIds])),
    links: engine.store.listClaims().flatMap((c) => engine.store.linksOf(c.id).map((l) => [l.claimId, l.target, l.polarity, l.weight])),
  });

describe("333：全量重判一次（runFullRejudge）", () => {
  it("迁移、被错撤的复活成猜测、随口说的不再推翻、标着复核的组由模型重跑追问；站得住的撤回不动、没动过的组不重判", async () => {
    const w = await world();
    const kayak = [w.claim("皮划艇", "喜欢"), w.claim("皮划艇", "在试")];
    const badminton = w.claim("羽毛球", "喜欢");
    const piano = w.claim("电子琴", "喜欢");
    const pingpong = w.claim("乒乓球", "喜欢");
    const stars = w.claim("天文台", "喜欢");

    const report = await runFullRejudge(w.engine);

    // 规矩迁移：待复核 → 复核标记，状态回到已验证；整理时重跑了它那组的追问、摘掉标记
    expect(report.migration.reviewToFlag).toEqual([badminton.id]);
    expect(w.engine.store.getClaim(badminton.id)).toMatchObject({ status: "active", needsReview: false });
    // 被错撤的（墓碑指着还在的观察、组不成立了）复活成猜测：组不在了，照 Q2 把握降一档、推理链照挂
    expect(report.revived.toSorted()).toEqual(kayak.map((c) => c.id).toSorted());
    for (const c of kayak) {
      expect(w.engine.store.getClaim(c.id)).toMatchObject({ status: "contested", retractedBy: null, needsReview: false, confidence: "low" });
      expect(w.engine.store.inferencesOf(c.id).some((i) => i.status === "active")).toBe(true);
    }
    expect(w.engine.gate.history(kayak[0]!.id).some((r) => r.op === "rejudge")).toBe(true);
    // R14：随口说的按强的算，推翻不了——按新规矩重定时回来（猜测），加了复核标记、整理时重跑了它那组的追问
    expect(report.settled).toContain(piano.id);
    expect(w.engine.store.getClaim(piano.id)).toMatchObject({ status: "contested", retractedBy: null });
    // 前提都被忘掉了：撤回站得住
    expect(w.engine.store.getClaim(pingpong.id)!.status).toBe("retracted");
    // 模型只重判标着复核的组（羽毛球、电子琴）；天文台没动过，不重判；皮划艇那组不在了，没有追问可跑
    expect(w.fake.asked.toSorted()).toEqual(["电子琴", "羽毛球"].toSorted());
    expect(w.engine.store.getClaim(stars.id)!.status).toBe("active");
    // 报告：之前 → 之后
    const change = (id: string) => report.changes.find((c) => c.id === id);
    expect(change(kayak[0]!.id)).toMatchObject({ from: { status: "retracted" }, to: { status: "contested" } });
    expect(change(badminton.id)).toMatchObject({ from: { status: "needs_review" }, to: { status: "active", needsReview: false } });
    expect(change(stars.id)).toBeUndefined();
    expect(report.reflect.dropped.filter((d) => d.stage === "gate")).toEqual([]);
    expect(report.modelCalls).toBe(w.fake.model.calls.length);
    expect(checkReasoningGraph(w.engine.store).problems).toEqual([]);
    // 不碰新证据：那句随口说的没被整理（留给每晚整理）
    expect(w.engine.rg.registry.isReflected("ev-casual", w.engine.rg.reasoner.id)).toBe(false);
    // 记进 nightly_runs（和每晚整理的那一夜分开）
    expect(w.engine.store.db.get<{ night: string }>("SELECT night FROM nightly_runs WHERE night LIKE '%#full-%'")?.night).toBe("2026-10-27#full-1300");
  });

  it("跑两遍结果一样：第二遍什么都不改、不问模型", async () => {
    const w = await world();
    await runFullRejudge(w.engine);
    const once = shape(w.engine);
    w.fake.model.calls.length = 0;
    w.setNow("2026-10-27T14:00:00+08:00");
    const again = await runFullRejudge(w.engine);
    expect(shape(w.engine)).toBe(once);
    expect(again.changes).toEqual([]);
    expect(again.migration.changed).toBe(false);
    expect(again.revived).toEqual([]);
    expect(again.settled).toEqual([]);
    expect(w.fake.model.calls).toHaveLength(0);
  });

  it("能撤回：快照换回去，库回到跑之前；跑完以后又写过别的就不换", async () => {
    const w = await world();
    const before = shape(w.engine);
    const backupFile = path.join(w.dir, "before.db");
    const report = await runFullRejudge(w.engine, { backupFile });
    expect(report.backupFile).toBe(backupFile);
    expect(shape(w.engine)).not.toBe(before);
    expect(report.after.revisionSeq).toBeGreaterThan(report.before.revisionSeq);
    w.engine.close();
    open.splice(open.indexOf(w.engine), 1);
    expect(undoFullRejudge({ file: w.file, backupFile, after: report.after })).toEqual({ restored: true });
    const reopened = MemoryEngine.open({ file: w.file });
    open.push(reopened);
    expect(shape(reopened)).toBe(before);
    reopened.close();
    open.pop();

    // 再跑一次，跑完以后又写了一笔：不让换回去
    let now = RUN_AT;
    const again = MemoryEngine.open({ file: w.file, clock: () => now, reasoner: new LlmReasoner(w.relay), joint: false });
    open.push(again);
    const second = await runFullRejudge(again, { backupFile: path.join(w.dir, "before-2.db") });
    now = "2026-10-27T15:00:00+08:00";
    again.markClaimForReview(again.store.listClaims({ status: "active" })[0]!.id, "测试：跑完以后又写了一笔");
    again.close();
    open.pop();
    const refused = undoFullRejudge({ file: w.file, backupFile: path.join(w.dir, "before-2.db"), after: second.after });
    expect(refused.restored).toBe(false);
    // 快照文件已经在了就不盖
    const third = MemoryEngine.open({ file: w.file, clock: () => now, reasoner: new LlmReasoner(w.relay), joint: false });
    open.push(third);
    await expect(runFullRejudge(third, { backupFile })).rejects.toThrow(/快照文件已经在了/);
  });

  it("进度和花费对得上：每一步开始、结束各报一次，花了多少按 token 和价格表算，和模型真调的次数一致", async () => {
    const w = await world();
    // 空闲时段（周日）：价格按空闲的算
    const meter = new MeteredChat(w.fake.model, { now: () => new Date("2026-10-25T05:00:00Z") });
    w.relay.target = meter;
    const events: FullRejudgeProgress[] = [];
    const spend = () => {
      const r = meter.report();
      return { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, yuan: r.yuan };
    };
    const report = await runFullRejudge(w.engine, { onProgress: (e) => events.push(e), spend });

    // 每一步（不算整理里转出来的小步）按先后各一对开始、结束，最后是"做完"
    const phases = events.filter((e) => e.step === undefined);
    const expected = FULL_REJUDGE_PHASES.filter((p) => p !== "done").flatMap((p) => [`${p}:start`, `${p}:end`]);
    expect(phases.map((e) => `${e.phase}:${e.state}`)).toEqual([...expected, "done:end"]);
    // 整理里的小步也转出来了
    expect(events.some((e) => e.phase === "reflect" && e.step?.step === "judge")).toBe(true);
    // 花费只增不减，最后一条和报告一样
    for (let i = 1; i < events.length; i++) expect(events[i]!.spend!.calls).toBeGreaterThanOrEqual(events[i - 1]!.spend!.calls);
    expect(events.at(-1)!.spend).toEqual(report.spend);
    expect(events.at(-1)!.elapsedMs).toBeGreaterThanOrEqual(0);
    // 和模型真调的次数、报告里的调用次数对得上；钱 = token × 空闲价
    expect(report.spend!.calls).toBe(w.fake.model.calls.length);
    expect(report.spend!.calls).toBe(report.modelCalls);
    expect(report.spend!.calls).toBeGreaterThan(0);
    const price = DEEPSEEK_PRICES["deepseek-flash"]!.offPeak;
    expect(report.spend!.yuan).toBeCloseTo((report.spend!.inputTokens * price.input + report.spend!.outputTokens * price.output) / 1_000_000, 10);
    expect(report.text).toContain(`${report.spend!.calls} 次调用`);
  });
});
