// 失效传播（第 7.3 节）：沿依赖一路往下传到底（267 号票起不设深度上限，主会话 2026-10-25 按 ADR-0030 定），每一步写修订；轻的支持被拿掉只重算置信度；1 版的库补上关联的多重。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "../../src/domain/types.ts";
import { MemoryStore } from "../../src/store/store.ts";
import { closeEngines, explicitClaimOf, factOf, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-20T12:00:00+08:00";

function chainClaim(engine: ReturnType<typeof openEngine>["engine"], premise: string, i: number): Claim {
  const claim = engine.store.insertClaim({
    tier: "need",
    statement: `第 ${i} 层的推断`,
    kind: "hypothesis",
    epistemic: "inferred",
    method: "induction",
    status: "active",
    confidence: "low",
    context: [],
    validFrom: null,
    validTo: null,
    inferredAt: NOW,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
  });
  engine.store.insertInference({ conclusionClaimId: claim.id, premiseIds: [premise], method: "induction", rationale: "", by: "rule:1", status: "active" });
  return claim;
}

describe("沿依赖往下传", () => {
  it("前提失效（忘掉）→ 前提都不在了的撤回、不留悬空，一层层往下传到底（12 层的链最后一层也撤，不设深度上限）；墓碑指上一层，每一步一条修订", async () => {
    const { engine } = openEngine(NOW);
    engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    await engine.reflect();
    const root = explicitClaimOf(engine, factOf(engine, "ev-1", "prefers", "爬山"));
    const chain: Claim[] = [];
    let premise = root.id;
    for (let i = 1; i <= 12; i++) {
      const c = chainClaim(engine, premise, i);
      chain.push(c);
      premise = c.id;
    }
    const fact = factOf(engine, "ev-1", "prefers", "爬山");
    engine.invalidateEvidence("ev-1", "忘掉");
    // 329 号票：忘掉 = 来源失效。明说的跟着事实撤回（墓碑指那条事实）；往下每一层的前提都只剩撤了的那条 → 撤回（墓碑指上一层），不留悬空
    expect(engine.store.getClaim(root.id)).toMatchObject({ status: "retracted", retractedBy: fact.id });
    const statuses = chain.map((c) => engine.store.getClaim(c.id)!.status);
    expect(statuses).toEqual(Array(12).fill("retracted"));
    chain.forEach((c, i) => {
      expect(engine.store.getClaim(c.id)!.retractedBy).toBe(i === 0 ? root.id : chain[i - 1]!.id);
      const r = engine.store.revisions(c.id, "claim").at(-1)!;
      expect(r).toMatchObject({ causeEvidenceId: "ev-1" });
      expect(r.reason).toMatch(/前提都不在了/);
      expect(engine.store.inferencesOf(c.id)[0]!.status).toBe("retracted");
    });
  });

  it("轻的支持被拿掉、判定不变：只重算置信度，不待复核", async () => {
    const { engine } = openEngine(NOW);
    engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.ingestEvidence(say("ev-2", "周末去了爬山", "2026-10-04T10:00:00+08:00", { mode: "do", kind: "action", context: ["weekend"] }));
    await engine.reflect();
    const root = explicitClaimOf(engine, factOf(engine, "ev-1", "prefers", "爬山"));
    // 手工记一条弱支持（别的证据），不在推断的前提里
    const hike = factOf(engine, "ev-2", "participated_in", "爬山");
    engine.store.putLink({ claimId: root.id, target: hike.id, polarity: "supports", weight: "weak", rationale: "周末去爬了" });
    engine.invalidateEvidence("ev-2", "忘掉");
    expect(engine.store.getClaim(root.id)!.status).toBe("active");
    expect(engine.store.linksOf(root.id).map((l) => l.target)).toEqual([factOf(engine, "ev-1", "prefers", "爬山").id]);
  });
});

describe("存储：1 版的库", () => {
  it("打开 188 号票的 1 版库时给关联表补上多重这一列", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-v1-"));
    try {
      const file = path.join(dir, "v1.db");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.exec("CREATE TABLE links (claim_id TEXT NOT NULL, target TEXT NOT NULL, polarity TEXT NOT NULL, rationale TEXT NOT NULL, PRIMARY KEY (claim_id, target, polarity))");
      raw.exec("INSERT INTO links VALUES ('cl-0001', 'ev-1', 'supports', '旧的')");
      raw.exec("PRAGMA user_version = 1");
      raw.close();
      const store = MemoryStore.open(file, { clock: () => NOW });
      expect(store.linksOf("cl-0001")).toEqual([{ claimId: "cl-0001", target: "ev-1", polarity: "supports", rationale: "旧的", weight: "weak" }]);
      store.putLink({ claimId: "cl-0001", target: "ev-1", polarity: "supports", rationale: "旧的", weight: "strong" });
      expect(store.linksOf("cl-0001")[0]!.weight).toBe("strong");
      expect(Number(store.db.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(2);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
