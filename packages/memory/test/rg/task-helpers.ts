// 196 号票测试用的例子（自己写的，不看 fixtures/truth）：一个人从 3 月到 10 月，周末、工作日都在推掉别人排好的活动、说不喜欢被排满
// （规则版往上抽出需求"重视自主安排"和价值"长期看重自主安排"），另有一条带"过敏"的忌口和一条早就过期的"最近太累"。
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine, MemoryEngineOptions } from "../../src/engine.ts";
import { openEngine, say, type TestEngine } from "./helpers.ts";

export const NOW = "2026-10-12T12:00:00+08:00";
export const NEED = "lift:need|autonomy";
export const VALUE = "lift:value|autonomy";
export const WEEKEND_GROUP = "repeated_decline|weekend|social";
export const WORKDAY_GROUP = "repeated_decline|workday|work";

const WEEKEND = { context: ["weekend", "social"] };
const WORKDAY = { context: ["workday", "work"] };

export function autonomyStory(): EvidenceDraft[] {
  return [
    say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
    say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
    say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
    say("ev-w3", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
    say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
    say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
    say("ev-t1", "最近太累了", "2026-09-01T10:00:00+08:00"),
    say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
  ];
}

export async function storyEngine(options: Partial<MemoryEngineOptions> = {}, extra: EvidenceDraft[] = []): Promise<TestEngine> {
  const t = openEngine(NOW, options);
  for (const e of [...autonomyStory(), ...extra]) t.engine.ingestEvidence(e);
  await t.engine.reflect();
  return t;
}

export function member(engine: MemoryEngine, key: string, template: string): Claim {
  const m = engine.rg.registry.members(key).find((x) => x.template === template);
  if (!m) throw new Error(`${key} 里没有 ${template}`);
  return engine.store.getClaim(m.claimId)!;
}

/** 明说的断言（按证据 id 和谓词） */
export function statedOf(engine: MemoryEngine, evidenceId: string, predicate: "dislikes" | "prefers" | "said_about"): Claim {
  const fact = engine.store.factsByEvidence(evidenceId).find((f) => f.predicate === predicate);
  if (!fact) throw new Error(`证据 ${evidenceId} 没有 ${predicate}`);
  const id = engine.rg.registry.explicitClaimOf(fact.id);
  if (!id) throw new Error(`事实 ${fact.id} 没有明说的断言`);
  return engine.store.getClaim(id)!;
}

export const ids = (entries: readonly { claimId: string }[]) => entries.map((e) => e.claimId);
