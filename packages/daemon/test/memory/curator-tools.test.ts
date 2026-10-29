// 263 号票：记忆管理员的 review_memory_claim 走引擎的表态接口（recordClaimVerdict），不直接改库——
// 管理员按用户的话确认、撤回以后，下一次整理计分不会把它改回去。临时目录里的真 rg.db、规则版整理，不调模型。
// 例子是周末社交案例（任务书第 11 节那几句，自己写的）：前三条时那组四种解释都还拿不准；第 4 条进来以后
// "重视周末自主安排"成立、"不喜欢社交"被"我不反感见朋友"撤回。
import path from "node:path";
import { type Claim, type EvidenceDraft, type MemoryEngine } from "@ergo/memory";
import type { ConversationId } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { HostTool } from "../../src/agent-manager/host-tools.ts";
import type { Materials } from "../../src/materials/index.ts";
import { curatorTools } from "../../src/memory/curator-tools.ts";
import { createMemoryGraphReader } from "../../src/memory/graph.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const GROUP = "repeated_decline|weekend|social";

const say = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: ["weekend", "social"],
  eventTime: at,
  observedAt: at,
  sourceRef: `mat-${id}`,
  ...over,
});

const FIRST_THREE: readonly EvidenceDraft[] = [
  say("ev-w01", "这周六的聚会我就不去了，最近周末想好好休息。", "2026-10-01T20:10:00+08:00"),
  say("ev-w02", "主动报名参加了周三晚上的技术交流会。", "2026-10-03T19:30:00+08:00", { mode: "do", kind: "action", context: ["workday", "work", "social"] }),
  say("ev-w03", "推掉了朋友安排得很紧凑的周末活动。", "2026-10-08T21:00:00+08:00", { mode: "do", kind: "action" }),
  say("ev-u01", "同事说他其实很讨厌社交。", "2026-10-09T10:00:00+08:00", { sourceLevel: "untrusted", context: ["social"], eventTime: null }),
];
const FOURTH = say("ev-w04", "我不反感见朋友，只是不喜欢周末被提前排满。", "2026-10-12T22:00:00+08:00");

interface Db {
  file: string;
  /** 引擎的"现在"（每次打开都按它） */
  now: { value: string };
  with<T>(fn: (engine: MemoryEngine) => T): T;
  /** 跑一次整理：再来一条无关的话（有新证据才整一遍），规则版 reflect */
  consolidate(at: string): Promise<void>;
}

/** 330 号票（R14）：随口说的不再自动算决定性——用户再纠正一句"我不是不喜欢社交"，纠正算决定性，"不喜欢社交"才被它撤回 */
async function correctSocial(db: Db): Promise<void> {
  db.now.value = "2026-10-14T12:00:00+08:00";
  const opened = openReasoningDb({ file: db.file, clock: () => db.now.value, model: "deepseek-flash" });
  if (!opened.ok) throw new Error(`推理库打不开：${opened.issue.code}`);
  try {
    opened.engine.ingestEvidence(say("ev-w05", "我不是不喜欢社交，之前那么说不对，跟朋友见面我挺乐意的。", "2026-10-14T11:00:00+08:00", { kind: "correction" }));
    await opened.engine.reflect();
  } finally {
    opened.engine.close();
  }
}

/** 临时目录里的 rg.db：灌证据、按规则版整理（前三条一次；four 时第 4 条再一次） */
async function weekendDb(four: boolean): Promise<Db> {
  const file = path.join(makeTempDir("ergo-curator-tools-"), "db", "rg.db");
  const now = { value: "2026-10-09T12:00:00+08:00" };
  const open = () => {
    const opened = openReasoningDb({ file, clock: () => now.value, model: "deepseek-flash" });
    if (!opened.ok) throw new Error(`推理库打不开：${opened.issue.code}`);
    return opened.engine;
  };
  const withEngine = async <T>(fn: (engine: MemoryEngine) => T | Promise<T>): Promise<T> => {
    const engine = open();
    try {
      return await fn(engine);
    } finally {
      engine.close();
    }
  };
  await withEngine(async (engine) => {
    for (const draft of FIRST_THREE) engine.ingestEvidence(draft);
    await engine.reflect();
  });
  if (four) {
    now.value = "2026-10-13T12:00:00+08:00";
    await withEngine(async (engine) => {
      engine.ingestEvidence(FOURTH);
      await engine.reflect();
    });
  }
  let chatter = 0;
  return {
    file,
    now,
    with: (fn) => {
      const engine = open();
      try {
        return fn(engine);
      } finally {
        engine.close();
      }
    },
    consolidate: (at) =>
      withEngine(async (engine) => {
        now.value = at;
        chatter += 1;
        engine.ingestEvidence(say(`ev-n${chatter}`, "今天中午吃了碗面。", at, { context: [] }));
        const report = await engine.reflect();
        expect(report.skipped).toBeUndefined();
      }),
  };
}

/** 组里某个模板的结论 */
function member(engine: MemoryEngine, template: string): Claim {
  const m = engine.rg.registry.members(GROUP).find((x) => x.template === template);
  if (!m) throw new Error(`没有模板 ${template}`);
  return engine.store.getClaim(m.claimId)!;
}

/** 管理员的 review_memory_claim（别的依赖这一票用不到，给最小的假的） */
function reviewTool(db: Db): HostTool {
  const tools = curatorTools({
    file: db.file,
    now: () => db.now.value,
    model: "deepseek-flash",
    store: { append: () => ({}) as never },
    conversation: "maintainer:memory-curator" as ConversationId,
    graph: { claim: () => undefined, questions: () => ({ ready: true, items: [], total: 0, open: 0 }) } as never,
    materials: { get: (id: string) => (id.startsWith("mat-ev-w") ? ({ id } as never) : undefined) } as unknown as Materials,
    materialOptions: {},
    consolidate: async () => undefined,
    blocked: () => undefined,
  });
  return tools.find((tool) => tool.spec.name === "review_memory_claim")!;
}

async function review(db: Db, claimId: string, status: "active" | "retracted" | "needs_review", reason?: string) {
  return reviewTool(db).run({ claimId, status, ...(reason === undefined ? {} : { reason }) }, { toolCallId: "call-review" });
}

describe("review_memory_claim 走引擎的表态接口", () => {
  it("用户说这条对：还拿不准的那条记成用户确认过、已验证；跑一次整理还是已验证（以前直接改库会被计分改回拿不准）", async () => {
    const db = await weekendDb(false);
    const autonomy = db.with((engine) => member(engine, "scene_autonomy"));
    expect(autonomy.status).toBe("contested");

    const output = await review(db, autonomy.id, "active", "用户说就是这样");
    expect(output.isError ?? false).toBe(false);
    expect(output.text).toContain("用户确认过");
    expect(output.text).toContain("现在是已验证");
    db.with((engine) => {
      expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
      // 记了一条本人的表态证据（修订里写着是记忆管理员按用户的话记的），当决定性的支持
      const link = engine.store.linksOf(autonomy.id).find((l) => l.polarity === "supports" && l.weight === "decisive")!;
      const evidence = engine.getEvidence(link.target)!;
      expect(evidence).toMatchObject({ sourceLevel: "self", sourceRef: `verdict:${autonomy.id}` });
      expect(evidence.text).toContain("经记忆管理员");
      expect(engine.store.revisions(evidence.id, "evidence")[0]!.reason).toContain("记忆管理员按用户的话改成已验证：用户说就是这样");
    });

    await db.consolidate("2026-10-10T03:00:00+08:00");
    db.with((engine) => expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" }));
    // 再说一次对：已经是用户确认过的已验证，不重复记
    const again = await review(db, autonomy.id, "active");
    expect(again.text).toContain("已经是用户确认过的已验证了");
  });

  it("用户说这条不对：成立的那条撤回（墓碑指向这句表态）；跑一次整理还是撤回", async () => {
    const db = await weekendDb(true);
    const autonomy = db.with((engine) => member(engine, "scene_autonomy"));
    expect(autonomy.status).toBe("active");

    const output = await review(db, autonomy.id, "retracted", "用户说不是这样");
    expect(output.isError ?? false).toBe(false);
    expect(output.text).toContain("现在是已撤回");
    const retractedBy = db.with((engine) => {
      const claim = engine.store.getClaim(autonomy.id)!;
      expect(claim.status).toBe("retracted");
      expect(engine.getEvidence(claim.retractedBy!)!.sourceRef).toBe(`verdict:${autonomy.id}`);
      return claim.retractedBy;
    });

    await db.consolidate("2026-10-14T03:00:00+08:00");
    db.with((engine) => expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "retracted", retractedBy }));

    // 用户改主意又说对：先前那句否认收回，恢复成立
    const back = await review(db, autonomy.id, "active");
    expect(back.text).toContain("收回了");
    db.with((engine) => expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" }));
  });

  it("用户说拿不准：加复核标记（真值状态不动，329 号票），下一次整理按证据重判、摘掉标记", async () => {
    const db = await weekendDb(true);
    const autonomy = db.with((engine) => member(engine, "scene_autonomy"));
    const output = await review(db, autonomy.id, "needs_review", "用户让我核对这条");
    expect(output.text).toContain("加了复核标记");
    expect(output.text).toContain("下一次整理会按证据重判");
    db.with((engine) => {
      expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", needsReview: true });
      expect(engine.store.revisions(autonomy.id, "claim").at(-1)!.reason).toContain("记忆管理员");
    });
    await db.consolidate("2026-10-14T03:00:00+08:00");
    db.with((engine) => expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", needsReview: false }));
  });

  it("用户自己明说的撤不掉：照实说、交回那句话是哪条素材，让管理员用别推断或忘掉；库里不动", async () => {
    const db = await weekendDb(true);
    const stated = db.with((engine) => {
      const fact = engine.store.factsByEvidence("ev-w04").find((f) => f.predicate === "dislikes" && !f.negated)!;
      return engine.store.getClaim(engine.rg.registry.explicitClaimOf(fact.id)!)!;
    });
    expect(stated.epistemic).toBe("explicit");
    const before = db.with((engine) => engine.store.listEvidence().length);
    const output = await review(db, stated.id, "retracted");
    expect(output.isError).toBe(true);
    expect(output.text).toContain("mat-ev-w04");
    expect(output.text).toMatch(/no_infer_material|forget_material/);
    db.with((engine) => {
      expect(engine.store.getClaim(stated.id)!.status).toBe("active");
      expect(engine.store.listEvidence()).toHaveLength(before);
    });
  });

  it("因为依据不在了才撤回的（被用户的纠正推翻）不能直接改回已验证；没有这条结论照实说", async () => {
    const db = await weekendDb(true);
    await correctSocial(db);
    const social = db.with((engine) => member(engine, "dislike_domain"));
    expect(social.status).toBe("retracted");
    const output = await review(db, social.id, "active");
    expect(output.isError).toBe(true);
    expect(output.text).toContain("不能直接改回");
    db.with((engine) => expect(engine.store.getClaim(social.id)!.status).toBe("retracted"));

    const missing = await review(db, "cl-9999", "active");
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("没有这条结论");
  });
});

// 272 号票第 3 条：问记忆管理员（ask_curator）的回答引了被彻底删除的原话时按证据编号抹（同问记忆）。管理员照它的提示词在回答里引证据编号，
// 所以 inspect_memory 交给它的每段原话前面写上是哪条证据——不然它看到的只有原话，回答里引不出编号，删的时候认不出是哪几行
describe("inspect_memory 的原话带证据编号", () => {
  it("支持、反驳它的每段原话前面写着证据编号（ev-…「原话」）", async () => {
    const db = await weekendDb(true);
    const autonomy = db.with((engine) => member(engine, "scene_autonomy"));
    const graph = createMemoryGraphReader({ file: db.file, clock: new ManualClock(new Date(2026, 9, 13, 12, 0)) });
    const tools = curatorTools({
      file: db.file,
      now: () => db.now.value,
      model: "deepseek-flash",
      store: { append: () => ({}) as never },
      conversation: "maintainer:memory-curator" as ConversationId,
      graph,
      materials: { get: () => undefined } as unknown as Materials,
      materialOptions: {},
      consolidate: async () => undefined,
      blocked: () => undefined,
    });
    const output = await tools.find((tool) => tool.spec.name === "inspect_memory")!.run({ claimId: autonomy.id }, { toolCallId: "call-inspect" });
    expect(output.text).toContain(`${autonomy.id}「`);
    expect(output.text).toMatch(/ev-w04「我不反感见朋友/);
  });
});
