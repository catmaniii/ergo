// 330 号票（R3，用户 10-27 放宽）：别人转述的——可以让二狗起一个猜测、往问题箱出问题找你确认；只有转述、你没确认过的永远只是猜测，
// 不算进"已验证"的证据；转述打不下已验证的结论，最多出一个问题。例子是自己编的（不看 fixtures/truth）。
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEngine } from "../../src/engine.ts";
import { premiseVerified, storeLookup } from "../../src/rg/graph-rules.ts";
import { generateQuestions } from "../../src/rg/question-sources.ts";
import { isRelayedGuess, RELAYED_BASIS } from "../../src/rg/relayed.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-12T12:00:00+08:00";
const LATER = "2026-10-13T03:00:00+08:00";
const ANSWER_AT = "2026-10-13T20:00:00+08:00";

const relay = (id: string, text: string, at = "2026-10-10T10:00:00+08:00") => say(id, text, at, { sourceLevel: "untrusted", context: ["weekend"] });

/** 起了的转述猜测（还活着的、撤了的都算） */
const relayedGuesses = (engine: MemoryEngine) => engine.store.listClaims().filter((c) => isRelayedGuess(engine.store, c.id));

/** 出问题（同每晚整理），交回"别人转述的"那几条还开着的 */
function relayedQuestions(engine: MemoryEngine, at: string) {
  engine.questions.refresh(generateQuestions(engine.rg, at).drafts, at);
  return engine.listQuestions().filter((q) => q.kind === "relayed" && (q.status === "open" || q.status === "asked"));
}

async function relayedStory() {
  const t = openEngine(NOW);
  t.engine.ingestEvidence(relay("ev-r1", "小王说你周末最喜欢一个人宅着"));
  await t.engine.reflect();
  const [guess] = relayedGuesses(t.engine);
  return { ...t, guess: guess! };
}

describe("别人转述的可以起一个猜测、出问题", () => {
  it("起一条猜测：推断出来的、把握 low、推断理由写明是转述（依据只当背景，不当证据）；问题箱出一个问题问你确认", async () => {
    const { engine, guess, setNow } = await relayedStory();
    expect(guess).toMatchObject({ kind: "hypothesis", epistemic: "inferred", status: "contested", confidence: "low", tier: "preference" });
    const [inference] = engine.store.inferencesOf(guess.id).filter((i) => i.status === "active");
    expect(inference!.rationale.startsWith(RELAYED_BASIS)).toBe(true);
    expect(engine.store.linksOf(guess.id).every((l) => l.polarity === "context")).toBe(true);
    setNow(LATER);
    const [q] = relayedQuestions(engine, LATER);
    expect(q).toMatchObject({ kind: "relayed", targets: [{ id: guess.id, kind: "claim" }] });
    expect(q!.text).toContain("是这样吗");
    expect(q!.text).not.toContain("用户");
  });

  it("只有转述的永远到不了已验证：再来几条一样的转述、再整理几次，还是猜测", async () => {
    const { engine, guess, setNow } = await relayedStory();
    engine.ingestEvidence(relay("ev-r2", "小李也说你周末最喜欢一个人宅着", "2026-10-11T10:00:00+08:00"));
    engine.ingestEvidence(relay("ev-r3", "听你妈说你周末最喜欢一个人宅着", "2026-10-11T12:00:00+08:00"));
    await engine.reflect();
    setNow(LATER);
    await engine.reflect();
    expect(engine.store.getClaim(guess.id)!.status).toBe("contested");
    expect(relayedGuesses(engine)).toHaveLength(1);
  });

  it("你答'是' → 已验证（你确认过，依据改挂到你这句话上）", async () => {
    const { engine, guess, setNow } = await relayedStory();
    setNow(LATER);
    const [q] = relayedQuestions(engine, LATER);
    setNow(ANSWER_AT);
    engine.recordQuestionAnswer(q!.id, say("ev-yes", "对，周末我就想自己待着。", ANSWER_AT), { reading: { verdict: "yes", clear: true } });
    expect(engine.store.getClaim(guess.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
  });

  it("你答'不是' → 撤回，墓碑是你那句话；以后同一条转述不再起猜测", async () => {
    const { engine, guess, setNow } = await relayedStory();
    setNow(LATER);
    const [q] = relayedQuestions(engine, LATER);
    setNow(ANSWER_AT);
    engine.recordQuestionAnswer(q!.id, say("ev-no", "不是，周末我挺爱出门的。", ANSWER_AT), { reading: { verdict: "no", clear: true } });
    expect(engine.store.getClaim(guess.id)).toMatchObject({ status: "retracted", retractedBy: "ev-no" });
    await engine.reflect();
    expect(relayedGuesses(engine).map((c) => c.id)).toEqual([guess.id]);
  });

  it("你自己说了同样的话 → 转述起的猜测被你明说的那条取代", async () => {
    const { engine, guess } = await relayedStory();
    engine.ingestEvidence(say("ev-s1", "周末我最喜欢一个人宅着", "2026-10-12T09:00:00+08:00", { context: ["weekend"] }));
    await engine.reflect();
    const stated = engine.store.listClaims({ status: "active" }).find((c) => c.epistemic === "explicit")!;
    expect(stated).toBeDefined();
    expect(engine.store.getClaim(guess.id)).toMatchObject({ status: "superseded", supersededBy: stated.id });
  });

  it("转述的那句被忘掉 → 起的猜测撤回（不留悬空）", async () => {
    const { engine, guess } = await relayedStory();
    engine.invalidateEvidence("ev-r1", "用户说忘掉");
    await engine.reflect();
    expect(engine.store.getClaim(guess.id)!.status).toBe("retracted");
  });
});

describe("转述打不下已验证的", () => {
  it("你说过喜欢吃辣（已验证），别人说你不喜欢吃辣：结论照旧已验证、不挨反证、不另起猜测，问题箱出一个问题（最多一个）", async () => {
    const t = openEngine(NOW);
    t.engine.ingestEvidence(say("ev-s1", "我喜欢吃辣", "2026-10-09T11:00:00+08:00"));
    t.engine.ingestEvidence(relay("ev-r1", "同事说你不喜欢吃辣"));
    await t.engine.reflect();
    const stated = t.engine.store.listClaims().find((c) => c.epistemic === "explicit")!;
    expect(stated.status).toBe("active");
    expect(t.engine.store.linksOf(stated.id).filter((l) => l.polarity === "refutes")).toEqual([]);
    expect(relayedGuesses(t.engine)).toEqual([]);
    t.setNow(LATER);
    const questions = relayedQuestions(t.engine, LATER);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.targets.map((x) => x.id)).toContain(stated.id);
    // 再来一条同样的转述、再整理：还是那一个问题
    t.engine.ingestEvidence(relay("ev-r2", "小王也说你不喜欢吃辣", "2026-10-12T10:00:00+08:00"));
    await t.engine.reflect();
    expect(relayedQuestions(t.engine, LATER)).toHaveLength(1);
    expect(t.engine.store.getClaim(stated.id)!.status).toBe("active");
  });

  it("铁律：转述的事实、证据不算已验证的前提（本人的算）", async () => {
    const t = openEngine(NOW);
    t.engine.ingestEvidence(say("ev-s1", "我喜欢吃辣", "2026-10-09T11:00:00+08:00"));
    t.engine.ingestEvidence(relay("ev-r1", "同事说你喜欢爬山"));
    t.engine.extractFacts();
    const lookup = storeLookup(t.engine.store);
    const own = t.engine.store.listFacts().find((f) => f.assertion === "user_stated")!;
    const relayed = t.engine.store.listFacts().find((f) => f.assertion === "third_party_reported")!;
    expect(premiseVerified(lookup, own.id)).toBe(true);
    expect(premiseVerified(lookup, "ev-s1")).toBe(true);
    expect(premiseVerified(lookup, relayed.id)).toBe(false);
    expect(premiseVerified(lookup, "ev-r1")).toBe(false);
  });
});
