// 267 号票：推理图谱的唯一写入口（ADR-0030），守护进程这一侧。
// - 守护进程的代码不直接写推理库（证据、事实、结论、关联、推断、追问、预测），一律经 @ergo/memory 的 engine.gate；
// - 秘书和维护者没有写的路：秘书只有只读的素材、问记忆工具（问记忆那份引擎的写入口开成只读，写一律拒），记忆页也只读；
//   能写的工具只在记忆管理员的工具包里；维护者拿不到任何记忆工具；
// - 记忆命令（忘掉、彻底删除、别推断）在推理库里记成"用户发起"，经谁转达进留痕；
// - 每晚校验用的是 @ergo/memory 自己的图谱自检（326 号票起不再起 Python、不找本机的东西）：插件接上的就是它。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DeleteCommandPayload, EVENT_TYPES, type MemoryCommandEventPayload } from "@ergo/protocol";
import { graphSelfCheck, type MemoryEngine, type QuestionDraft, ReasoningWriteRefused } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { SENSITIVE_CATEGORIES } from "../../src/config/config.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import type { Materials } from "../../src/materials/index.ts";
import { askMemoryTool } from "../../src/memory/ask-tool.ts";
import { CURATOR_TOOL_NAMES, consolidationText } from "../../src/memory/curator-tools.ts";
import { createMemoryEngineProvider, createWritableEngineUse } from "../../src/memory/engine-provider.ts";
import { createWovenQuestions, WOVEN_VIA } from "../../src/memory/woven-questions.ts";
import { MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { lockedSensitiveTags } from "../../src/memory/privacy.ts";
import { createReasoningPurge } from "../../src/memory/purge-rg.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { readMaterialTool, searchMaterialsTool } from "../../src/memory/search-tool.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MODEL = "deepseek-flash";

/** 存储上写推理图谱（和它底下的证据、事实层）的操作（同 @ergo/memory 的 write-gate-boundary.test.ts） */
const GATED_WRITES = [
  "insertEvidence",
  "updateEvidence",
  "deleteEvidence",
  "insertFact",
  "updateFact",
  "deleteFact",
  "insertClaim",
  "updateClaim",
  "putLink",
  "removeLink",
  "insertInference",
  "updateInference",
  "insertProbe",
  "updateProbe",
  "putPrediction",
  "updatePrediction",
];
const DIRECT = new RegExp(`\\.store\\.(${GATED_WRITES.join("|")})\\(`);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("守护进程不绕过唯一写入口", () => {
  it("守护进程的代码里没有直接调推理库存储的写操作（engine.store.updateClaim 这类），写一律经 engine.gate 或引擎的写接口", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replaceAll("\\", "/");
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (DIRECT.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

/** 规则版整理过一遍的 rg.db（有结论），返回文件和一条结论 */
async function builtDb(): Promise<{ file: string; claimId: string; t: ReturnType<typeof materialsSetup> }> {
  const t = materialsSetup();
  postMessage(t.store, [text("这周六的聚会我就不去了，最近周末想好好休息。")]);
  postMessage(t.store, [text("我不反感见朋友，只是不喜欢周末被提前排满。")]);
  const file = path.join(t.root, "db", "rg.db");
  const opened = openReasoningDb({ file, clock: () => clockIso(t.clock), model: MODEL });
  if (!opened.ok) throw new Error(JSON.stringify(opened.issue));
  const engine = opened.engine;
  try {
    const source = new MaterialsEvidenceSource({ materials: t.materials, clock: t.clock, inferableSensitiveCategories: SENSITIVE_CATEGORIES });
    for (const draft of source.read()) engine.ingestEvidence(draft);
    await engine.reflect();
    const claim = engine.store.listClaims()[0];
    if (!claim) throw new Error("整理完没有结论");
    return { file, claimId: claim.id, t };
  } finally {
    engine.close();
  }
}

/** 随用随开一份可写的引擎（和顺口问、管理员的工具一样） */
function withWritable<T>(file: string, t: ReturnType<typeof materialsSetup>, fn: (engine: MemoryEngine) => T): T {
  let ran = false;
  const result = createWritableEngineUse({ file, clock: () => clockIso(t.clock), model: MODEL })((engine) => {
    ran = true;
    return fn(engine);
  });
  if (!ran) throw new Error("推理库打不开");
  return result as T;
}

/** 问题箱里放一个要弄清这条结论的问题 */
function offerQuestion(engine: MemoryEngine, claimId: string): string {
  const claim = engine.store.getClaim(claimId)!;
  const draft: QuestionDraft = {
    key: `q-${claimId}`,
    topic: `claim:${claimId}`,
    kind: "unresolved",
    sources: ["unresolved"],
    text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
    why: "两条解释分不清",
    targets: [{ id: claimId, kind: "claim", statement: claim.statement }],
    answers: {
      yes: { supports: [claimId], refutes: [], maxWeight: "strong", note: "是" },
      no: { supports: [], refutes: [claimId], maxWeight: "strong", note: "不是" },
    },
    domains: ["social"],
    scenes: [],
    terms: ["周末活动"],
    probeId: null,
    validUntil: null,
    separation: 1,
    closeness: 1,
    frequency: 1,
  };
  const offered = engine.questions.offer(draft, engine.store.now());
  if (offered.question === undefined) throw new Error(`问题没进箱：${offered.skipped}`);
  return offered.question.id;
}

describe("秘书和维护者没有写推理图谱的路", () => {
  it("秘书的记忆工具只读（检索素材、读素材、问记忆；271 号票的标顺口问只在内存里记个标记），能写的工具只在记忆管理员的工具包里", () => {
    const materials = {} as Materials;
    const woven = createWovenQuestions({ withEngine: () => undefined, store: {} as never, materials, enabled: () => true, inferableSensitiveCategories: () => [], log: () => {} });
    const tools = [searchMaterialsTool(materials), readMaterialTool(materials), askMemoryTool({ get: () => undefined }), woven.markTool()];
    for (const tool of tools) expect(tool.descriptor).toMatchObject({ readOnlyOrIdempotent: true, nature: "look" });
    const writers = ["review_memory_claim", "forget_material", "no_infer_material", "run_memory_consolidation"];
    expect(tools.map((tool) => tool.spec.name).filter((name) => writers.includes(name))).toEqual([]);
    for (const name of writers) expect(CURATOR_TOOL_NAMES).toContain(name);
  });

  it("记忆插件只把记忆工具给秘书（记忆管理员的另装），维护者拿不到", () => {
    const plugin = fs.readFileSync(path.join(SRC, "memory", "plugin.ts"), "utf8");
    const targets = [...plugin.matchAll(/tools\.register\(\{\s*to:\s*\{\s*agents:\s*\[([^\]]*)\]/g)].map((m) => m[1]!.trim());
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toBe('"secretary"');
  });

  it("问记忆、每轮简报那一份引擎的写入口是只读的：表态、忘掉、写证据、改问题箱一律被拒，库里什么都没变", async () => {
    const { file, claimId, t } = await builtDb();
    const questionId = withWritable(file, t, (engine) => offerQuestion(engine, claimId));
    const provider = createMemoryEngineProvider({ file, clock: () => clockIso(t.clock), model: MODEL });
    try {
      const engine = provider.get()!;
      expect(engine.gate.isReadOnly).toBe(true);
      const before = engine.store.getClaim(claimId)!.status;
      expect(() => engine.recordClaimVerdict(claimId, "doubt")).toThrow(ReasoningWriteRefused);
      expect(() => engine.gate.write({ op: "mark_review", reason: "测试" }, () => engine.gate.updateClaim(claimId, { needsReview: true }, { reason: "测试" }))).toThrow(ReasoningWriteRefused);
      expect(() => engine.invalidateEvidence(engine.store.listEvidence()[0]!.id, "测试")).toThrow(ReasoningWriteRefused);
      // 问题箱也改不了（264 号票的顺口问要写，得用随用随开的可写引擎）
      expect(() => engine.markQuestionAsked(questionId, { via: WOVEN_VIA })).toThrow(ReasoningWriteRefused);
      expect(() => engine.declineQuestion(questionId, { via: WOVEN_VIA })).toThrow(ReasoningWriteRefused);
      expect(engine.listQuestions().find((q) => q.id === questionId)!.status).toBe("open");
      expect(engine.store.getClaim(claimId)!.status).toBe(before);
    } finally {
      provider.close();
    }
  });

  it("记忆页（只读打开）那一份引擎也写不进去", async () => {
    const { file, claimId, t } = await builtDb();
    const opened = openReasoningDb({ file, clock: () => clockIso(t.clock), model: MODEL, readOnly: true });
    if (!opened.ok) throw new Error(JSON.stringify(opened.issue));
    try {
      expect(opened.engine.gate.isReadOnly).toBe(true);
      expect(() => opened.engine.recordClaimVerdict(claimId, "confirm")).toThrow(ReasoningWriteRefused);
    } finally {
      opened.engine.close();
    }
  });
});

describe("顺口问的写经唯一写入口（264 号票接进线上的那几条路）", () => {
  it("随用随开的可写引擎：记问过是记忆管理员、跳过是用户的表态、别问这个是用户发起，都经秘书顺口问；别问这个不能由管理员自己下", async () => {
    const { file, claimId, t } = await builtDb();
    const questionId = withWritable(file, t, (engine) => offerQuestion(engine, claimId));
    withWritable(file, t, (engine) => {
      engine.markQuestionAsked(questionId, { via: WOVEN_VIA });
      engine.recordQuestionSkipped(questionId, { via: WOVEN_VIA });
      expect(() => engine.declineQuestion(questionId, { actor: "curator", via: WOVEN_VIA })).toThrow(ReasoningWriteRefused);
      engine.declineQuestion(questionId, { via: WOVEN_VIA });
      const rows = engine.gate.history(questionId).filter((r) => r.op !== "question");
      expect(rows.map((r) => [r.op, r.actor, r.via])).toEqual([
        ["ask", "curator", WOVEN_VIA],
        ["skip", "user_verdict", WOVEN_VIA],
        ["decline", "user", WOVEN_VIA],
      ]);
      expect(engine.questions.isBlocked(`claim:${claimId}`)).toBe(true);
    });
  });

  it("库还没建：可写引擎不顺手建库，什么都不做", () => {
    const dir = makeTempDir("ergo-woven-nodb-");
    const file = path.join(dir, "db", "rg.db");
    const use = createWritableEngineUse({ file, clock: () => "2026-10-25T10:00:00+08:00", model: MODEL });
    expect(use(() => "做了")).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("记忆命令在推理库里记成用户发起", () => {
  it("记忆管理员转达的忘掉：证据和依赖的结论的留痕写着'用户发起 · 经记忆管理员'；删项目连带的彻底删除也记成用户发起", async () => {
    const { file, t } = await builtDb();
    const [first, second] = t.materials.list();
    const purge = createReasoningPurge({
      file,
      store: t.store,
      clock: t.clock,
      config: { maxModelCalls: 200, extractor: "model", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } },
      log: () => {},
    });
    const off = purge.start();
    try {
      const fromCurator: DeleteCommandPayload["from"] = { kind: "curator", conversation: "memory-curator" };
      t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: { commandId: "cmd-267-1", command: "forget", materialIds: [first!.id], from: fromCurator } as MemoryCommandEventPayload });
      const fromProject: DeleteCommandPayload["from"] = { kind: "project_deletion", projectId: "p-267" };
      t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: { commandId: "cmd-267-2", command: "purge", materialIds: [second!.id], from: fromProject } as MemoryCommandEventPayload });
    } finally {
      off();
    }
    const opened = openReasoningDb({ file, clock: () => clockIso(t.clock), model: MODEL });
    if (!opened.ok) throw new Error(JSON.stringify(opened.issue));
    const engine: MemoryEngine = opened.engine;
    try {
      const forgotten = engine.store.listEvidence().find((e) => e.sourceRef === first!.id)!;
      expect(engine.gate.history(forgotten.id).at(-1)).toMatchObject({ actor: "user", via: "经记忆管理员", op: "forget" });
      const purged = engine.gate.records({ op: "purge" });
      expect(purged.length).toBeGreaterThan(0);
      expect(purged.every((r) => r.actor === "user" && r.via === "删项目时连带")).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("没打开的敏感类别交给写入口（不在上面推断）：默认锁健康，打开了就不锁", () => {
    expect(lockedSensitiveTags([])).toEqual(["health"]);
    expect(lockedSensitiveTags(["health"])).toEqual([]);
  });
});

describe("每晚校验接的是记忆系统自己的图谱自检（326 号票）", () => {
  it("记忆插件给每晚整理的校验器是 graphSelfCheck：不起 Python、不找本机的 skill 目录、没有要配的环境变量", () => {
    const plugin = fs.readFileSync(path.join(SRC, "memory", "plugin.ts"), "utf8");
    expect(plugin).toMatch(/validator:\s*graphSelfCheck\b/);
    expect(graphSelfCheck.name).toBe("图谱自检");
    for (const file of walk(path.join(SRC, "memory"))) {
      expect({ file: path.basename(file), hit: fs.readFileSync(file, "utf8").match(/child_process|\bpython\b|RG_SKILL|[.]claude.skills/i)?.[0] }).toEqual({ file: path.basename(file), hit: undefined });
    }
  });
});

describe("整理记录给记忆管理员的那段话", () => {
  const ran: MemoryNightlyRecord = {
    night: "2026-10-25",
    at: "2026-10-25T03:10:00+08:00",
    state: "ran",
    trigger: "scheduled",
    deferrals: 0,
    newClaims: 1,
    changedClaims: 0,
    reviewed: 0,
    needsReview: 1,
    questions: { added: 0, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 0 },
    modelCalls: 3,
    budgetExhausted: false,
    processedEvidence: 2,
    pendingEvidence: 0,
  };

  it("每晚校验加了复核标记、降回了猜测、写入口拒了几处：照实告诉管理员", () => {
    const said = consolidationText({ ...ran, validation: { state: "failed", problems: 2, claimIds: ["cl-0003"], downgraded: ["cl-0004"] }, refused: 1 });
    expect(said).toContain("每晚校验报了 2 个问题，1 条结论加了复核标记（cl-0003），1 条已验证的压在没验证的前提上、降回猜测（cl-0004）");
    expect(said).toContain("写入口拒了 1 处");
  });

  it("每晚校验跳过了：写明原因；通过了一句话带过", () => {
    expect(consolidationText({ ...ran, validation: { state: "skipped", problems: 0, claimIds: [], reason: "校验器出错：坏了" } })).toContain("每晚校验跳过了（校验器出错：坏了）");
    expect(consolidationText({ ...ran, validation: { state: "ok", problems: 0, claimIds: [] } })).toContain("每晚校验通过了");
  });

  it("270：整理完几条新证据、还积压几条、预算按道花在哪，照实告诉管理员；以前的记录没有这一项就不说", () => {
    const said = consolidationText({ ...ran, pendingEvidence: 38, spend: { limit: 200, newEvidence: 145, rejudge: 5, lift: 33, predictions: 0, strategies: 0, review: 0 } });
    expect(said).toContain("新证据整理完 2 条、还积压 38 条");
    expect(said).toContain("新证据 145、判回答 0、重跑旧追问 5、往上抽 33、判预测 0、编策略 0（上限 200），对抗复核另算 0 次");
    expect(consolidationText(ran)).not.toContain("还积压");
  });

  it("271：这一夜判了顺口问的回答，告诉管理员答了几个、没在答几个、拿不准几个；没动静不说", () => {
    const said = consolidationText({ ...ran, spend: { limit: 200, newEvidence: 10, replies: 3, rejudge: 0, lift: 0, predictions: 0, strategies: 0, review: 0 }, replies: { calls: 3, answered: 1, notAnswered: 1, unsure: 1, waiting: 0 } });
    expect(said).toContain("判回答 3");
    expect(said).toContain("看了白天顺口问以后用户说的话：答了 1 个（回写成本人证据）、没在答 1 个（算跳过一次）、拿不准 1 个（留到下一夜）。");
    expect(consolidationText({ ...ran, replies: { calls: 0, answered: 0, notAnswered: 0, unsure: 0, waiting: 0 } })).not.toContain("顺口问");
  });
});
