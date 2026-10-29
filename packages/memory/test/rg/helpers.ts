// 推理图谱测试的小工具：可拨的时钟、按 id 灌周末社交案例（任务书第 11 节 4 条 + 1 条别人转述）、按模板找断言。
import { fileURLToPath } from "node:url";
import type { Claim, EvidenceDraft, Fact } from "../../src/domain/types.ts";
import { MemoryEngine, type MemoryEngineOptions } from "../../src/engine.ts";
import { SyntheticEventsSource } from "../../src/evidence/synthetic.ts";

export const WEEKEND_FIXTURE = fileURLToPath(new URL("../fixtures/weekend-events.json", import.meta.url));

export interface TestEngine {
  engine: MemoryEngine;
  setNow(at: string): void;
}

const open: MemoryEngine[] = [];

export function openEngine(now: string, options: Partial<MemoryEngineOptions> = {}): TestEngine {
  let current = now;
  const engine = MemoryEngine.open({ file: ":memory:", clock: () => current, ...options });
  open.push(engine);
  return {
    engine,
    setNow: (at) => {
      current = at;
    },
  };
}

export function closeEngines(): void {
  for (const e of open.splice(0)) e.close();
}

/** 周末社交案例里的这几条（按 id） */
export function ingestWeekend(engine: MemoryEngine, ids: readonly string[]): void {
  const drafts = SyntheticEventsSource.fromFile(WEEKEND_FIXTURE)
    .read()
    .filter((d) => ids.includes(d.id!));
  for (const d of drafts) engine.ingestEvidence(d);
}

/** 组里某个模板的断言 */
export function claimOf(engine: MemoryEngine, template: string, groupKey?: string): Claim {
  const groups = engine.rg.registry.listGroups();
  for (const g of groups) {
    if (groupKey && g.key !== groupKey) continue;
    const m = engine.rg.registry.members(g.key).find((x) => x.template === template);
    if (m) return engine.store.getClaim(m.claimId)!;
  }
  throw new Error(`没有模板 ${template} 的断言`);
}

/** 某条证据抽出的事实里，谓词和宾语名对得上的那条 */
export function factOf(engine: MemoryEngine, evidenceId: string, predicate: Fact["predicate"], objectName?: string, negated?: boolean): Fact {
  const f = engine.store
    .factsByEvidence(evidenceId)
    .find(
      (x) =>
        x.predicate === predicate &&
        (negated === undefined || x.negated === negated) &&
        (objectName === undefined || (x.object.type === "entity" && engine.getEntity(x.object.id)?.name === objectName)),
    );
  if (!f) throw new Error(`证据 ${evidenceId} 没有 ${predicate}(${objectName ?? "*"})`);
  return f;
}

/** 明说的断言（按事实） */
export function explicitClaimOf(engine: MemoryEngine, fact: Fact): Claim {
  const id = engine.rg.registry.explicitClaimOf(fact.id);
  if (!id) throw new Error(`事实 ${fact.id} 没有明说的断言`);
  return engine.store.getClaim(id)!;
}

export const say = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at,
  ...over,
});

export const targets = (engine: MemoryEngine, claimId: string, polarity: "supports" | "refutes" | "context") =>
  engine.store
    .linksOf(claimId)
    .filter((l) => l.polarity === polarity)
    .map((l) => l.target);
