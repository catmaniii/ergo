// 全量重判一次（333 号票，328 规矩 R16 ②，ADR-0032 的"全量重判一次"一节）：规矩改了以后，把现有的结论按新规矩全过一遍——
// 不只判当晚动过的。规矩、提示词和每晚整理是同一套（同一个 reflect、同一个写入口、同一个模型），只是这一次的范围是"已有的全部结论"，
// 不碰新证据（新证据留给下一次每晚整理）。一次做这几步（每步都经唯一写入口、进留痕）：
//
//   1. 快照（给了 backupFile 才做）：VACUUM INTO 一份，"撤回这一次"就是换回它（undoFullRejudge）；
//   2. 规矩迁移（329 号票 rg/migrate-rules.ts）：待复核改成复核标记、恢复被 326 改过的身份、用户确认过的改挂、照铁律降到不动为止；
//   3. 被错撤的复活（R8、R11、Q2）：墓碑没指着真正推翻它的东西的（老代码"组不成立了"就撤、前提只是拿不准就撤的）回到猜测，
//      推理链恢复、连带撤回的跟着回来；它那组不在了的照 Q2 留成猜测、把握降一档（StatusKeeper.retractionHasRefuter / reviveWronglyRetracted）；
//   4. 老账本里落空了、还没往回打的预测往回打来源（R10，330 号票留给这里）；
//   5. 每个活着的组按新规矩当场重定（R2、R4、R7、R12、R13、R14，代码判）；变了的加复核标记（ReasoningGraph.settleForRejudge）；
//   6. 整理一次（reflect 的 full 模式，模型是每晚那一个）：明说的跟着事实走、转述、标着复核的组按道重跑追问（模型重判）、联动、
//      往上抽（猜测也能往上推，R4）、写回、标着复核又不在组里的重判、对抗复核、预测、编策略；
//   7. 编交互策略、从推理图谱出问题、图谱自检（和每晚整理末尾一样）；
//   8. 报告：每一步动了哪几条、每条结论之前 → 之后、调了几次模型、花了多少钱、用了多久；记进 nightly_runs（键 `<日期>#full-<时分>`）。
//
// 跑两遍结果一样（第二遍什么都不改）。进度：onProgress 每一步开始、结束各报一次（整理那一步把 reflect 的每一步也转出来），
// 带上已经用了多久、花了多少（调用方给 spend 时）。
// 撤回：跑之前存了快照的，undoFullRejudge 换回快照——跑完以后库里又写过别的（修订、留痕的序号变了）就不换，交回原因。
import fs from "node:fs";
import type { Claim, Confidence } from "./domain/types.ts";
import { localDate } from "./domain/time.ts";
import type { MemoryEngine } from "./engine.ts";
import { migrateToRules, type RulesMigrationReport } from "./rg/migrate-rules.ts";
import { graphSelfCheck, validateNightly, type GraphValidator, type NightlyValidation } from "./rg/nightly-validate.ts";
import { generateQuestions } from "./rg/question-sources.ts";
import type { DroppedOutput, ReflectReport, ReflectStepEvent } from "./rg/types.ts";
import { openDatabase } from "./store/sqlite.ts";

/** 全量重判一次默认最多调几次模型（每晚整理是 200；这一次要把标着复核的组都重跑一遍，给宽一些） */
export const FULL_REJUDGE_MAX_MODEL_CALLS = 1000;

/** 花了多少（调用方的模型计量给的：几次调用、多少 token、多少钱；价格表里没有这个模型时 yuan 是 null） */
export interface FullRejudgeSpend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  yuan: number | null;
}

/** 全量重判的几步（按先后） */
export const FULL_REJUDGE_PHASES = ["backup", "migrate", "revive", "backprop", "settle", "reflect", "strategies", "questions", "validate", "done"] as const;
export type FullRejudgePhase = (typeof FULL_REJUDGE_PHASES)[number];

/** 进度：一步开始（start）或做完（end）；整理那一步里 reflect 的每一步也转出来（step） */
export interface FullRejudgeProgress {
  phase: FullRejudgePhase;
  state: "start" | "end";
  /** 整理那一步里 reflect 走到哪了 */
  step?: ReflectStepEvent;
  detail?: string;
  /** 从开始到现在多少毫秒（墙钟） */
  elapsedMs: number;
  /** 到现在花了多少（给了 spend 才有） */
  spend?: FullRejudgeSpend;
}

export interface FullRejudgeOptions {
  /** 现在几点：要和引擎的时钟一致；不给就是引擎的时钟 */
  at?: string;
  /** 整理那一步最多调几次模型（对抗复核另算，同每晚整理）；默认 FULL_REJUDGE_MAX_MODEL_CALLS */
  maxModelCalls?: number;
  /** 跑之前把库 VACUUM INTO 到这里（文件不能已经在）；撤回就换回它 */
  backupFile?: string;
  /** 图谱自检（默认记忆系统自己的 graphSelfCheck，同每晚整理） */
  validator?: GraphValidator;
  onProgress?: (event: FullRejudgeProgress) => void;
  /** 到现在花了多少（调用方包在模型外面的计量，比如 MeteredChat.report()）；不给就不报钱 */
  spend?: () => FullRejudgeSpend;
}

/** 一条结论在某一刻的样子（老库里状态可能还是 needs_review） */
export interface RejudgeClaimState {
  status: string;
  confidence: Confidence;
  kind: Claim["kind"];
  needsReview: boolean;
  retractedBy: string | null;
  supersededBy: string | null;
}

/** 一条结论之前 → 之后 */
export interface RejudgeClaimChange {
  id: string;
  tier: Claim["tier"];
  statement: string;
  epistemic: Claim["epistemic"];
  /** 跑之前没有这条（这一次新出的）是 null */
  from: RejudgeClaimState | null;
  to: RejudgeClaimState;
}

/** 库里修订日志、留痕到哪一条了（撤回时核对跑完以后没再写过） */
export interface RejudgeMark {
  revisionSeq: number;
  writeSeq: number;
}

export interface FullRejudgeReport {
  ranAt: string;
  /** 墙钟：用了多久 */
  durationMs: number;
  backupFile: string | null;
  before: RejudgeMark;
  after: RejudgeMark;
  migration: RulesMigrationReport;
  /** 被错撤的、复活成猜测的（含连带回来的）；它那组不在了的照 Q2 留成猜测 */
  revived: string[];
  /** 复活时被写入口拒了的 */
  reviveRefused: Array<{ claimId: string; reason: string }>;
  /** 老账本里落空、这一次往回打了来源的预测 */
  backprop: string[];
  /** 按新规矩当场重定以后变了的（加了复核标记，整理那一步重跑它那组的追问） */
  settled: string[];
  reflect: ReflectReport;
  strategies: { created: string[]; updated: string[]; statusChanged: string[] };
  questions: { added: string[]; obsolete: string[] };
  validation: NightlyValidation;
  /** 跑之前 → 跑之后变了的结论（状态、把握、身份、复核标记、墓碑、取代者有一样变了就算；新出的 from 是 null） */
  changes: RejudgeClaimChange[];
  /** 调了几次模型（整理那一步 + 对抗复核） */
  modelCalls: number;
  spend?: FullRejudgeSpend;
  /** 写入口拒了几处（整理里的；原因在 reflect.dropped） */
  refused: number;
  text: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** nightly_runs 里这一次的键（和每晚整理的那一夜、手动整理分开） */
export function fullRejudgeRunKey(at: string): string {
  return `${localDate(at)}#full-${at.slice(11, 16).replace(":", "")}`;
}

function stateOf(c: Claim): RejudgeClaimState {
  return { status: c.status, confidence: c.confidence, kind: c.kind, needsReview: c.needsReview === true, retractedBy: c.retractedBy, supersededBy: c.supersededBy };
}

function markOf(engine: MemoryEngine): RejudgeMark {
  const writeSeq = Number(engine.store.db.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM rg_writes")?.seq ?? 0);
  return { revisionSeq: engine.store.latestRevisionSeq(), writeSeq };
}

/** 跑一次全量重判（见文件开头） */
export async function runFullRejudge(engine: MemoryEngine, options: FullRejudgeOptions = {}): Promise<FullRejudgeReport> {
  const store = engine.store;
  const now = store.now();
  const at = options.at ?? now;
  if (at !== now) throw new Error(`runFullRejudge 的 at（${at}）要和引擎的时钟（${now}）一致`);
  const started = Date.now();
  const spend = options.spend;
  const progress = (phase: FullRejudgePhase, state: "start" | "end", extra: { detail?: string; step?: ReflectStepEvent } = {}) =>
    options.onProgress?.({ phase, state, ...extra, elapsedMs: Date.now() - started, ...(spend ? { spend: spend() } : {}) });
  const dropped: DroppedOutput[] = [];

  // 1. 快照
  progress("backup", "start");
  let backupFile: string | null = null;
  if (options.backupFile !== undefined) {
    if (fs.existsSync(options.backupFile)) throw new Error(`快照文件已经在了：${options.backupFile}（换一个名字，免得盖掉以前的）`);
    store.db.run("VACUUM INTO ?", options.backupFile);
    backupFile = options.backupFile;
  }
  const before = markOf(engine);
  const snapshot = new Map(store.listClaims().map((c) => [c.id, stateOf(c)]));
  progress("backup", "end", { detail: backupFile === null ? "没存快照" : `快照：${backupFile}` });

  // 2. 规矩迁移（329 号票）
  progress("migrate", "start");
  const migration = migrateToRules(engine, { at });
  progress("migrate", "end", { detail: `待复核改成标记 ${migration.reviewToFlag.length}、身份恢复 ${migration.kindsRestored.length}、改挂到用户确认 ${migration.directAttached.length}、照铁律降回猜测 ${migration.downgraded.length}、加复核标记 ${migration.flagged.length}` });

  // 3. 被错撤的复活
  progress("revive", "start");
  const revived: string[] = [];
  const reviveRefused: Array<{ claimId: string; reason: string }> = [];
  for (const { id } of store.listClaims({ status: "retracted" })) {
    const claim = store.getClaim(id);
    if (!claim || claim.status !== "retracted" || revived.includes(id)) continue;
    const view = engine.rg.view(at);
    if (engine.rg.keeper.retractionHasRefuter(claim, view)) continue;
    // 墓碑指它自己的反证、又在活着的组里的：那组按新的计分重定（第 5 步），这里不动
    const member = engine.rg.registry.memberOf(id);
    if (claim.retractedBy !== null && store.linksOf(id).some((l) => l.polarity === "refutes" && l.target === claim.retractedBy) && member && engine.rg.registry.getGroup(member.groupKey)?.live) continue;
    const reason = `全量重判：撤回它的 ${claim.retractedBy} 不是推翻它的东西（只是组不成立了、前提只是拿不准），没有推翻者不撤（R8、Q2），复活成猜测`;
    try {
      const back = engine.gate.write({ op: "rejudge", reason }, () => engine.rg.keeper.reviveWronglyRetracted(claim, at, { evidenceId: null, reason }, view));
      for (const r of back) if (!revived.includes(r)) revived.push(r);
    } catch (err) {
      reviveRefused.push({ claimId: id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  progress("revive", "end", { detail: `复活 ${revived.length} 条${reviveRefused.length > 0 ? `，写入口拒了 ${reviveRefused.length} 条` : ""}` });

  // 4. 老账本里落空、还没往回打的预测
  progress("backprop", "start");
  const backprop: string[] = [];
  for (const p of store.listPredictions({ status: "miss" })) {
    if (p.blame !== null) continue;
    const done = engine.gate.write({ op: "predict", actor: "nightly", reason: `全量重判：老账本里落空的预测 ${p.id} 往回打来源（R10）` }, () => engine.rg.backprop.missed(p, at));
    if (done) backprop.push(p.id);
  }
  progress("backprop", "end", { detail: `往回打 ${backprop.length} 条落空的预测` });

  // 5. 每个活着的组按新规矩当场重定
  progress("settle", "start");
  const settled = engine.rg.settleForRejudge(at, dropped);
  progress("settle", "end", { detail: `按新规矩重定以后变了 ${settled.length} 条（加复核标记，接下来重跑它那组的追问）` });

  // 6. 整理一次（full 模式：不碰新证据；标着复核的组按道重跑追问，模型重判）
  progress("reflect", "start");
  const reflect = await engine.reflect({
    full: true,
    maxModelCalls: options.maxModelCalls ?? FULL_REJUDGE_MAX_MODEL_CALLS,
    onStep: (step) => progress("reflect", step.phase === "start" ? "start" : "end", { step, ...(step.detail === undefined ? {} : { detail: step.detail }) }),
  });
  reflect.dropped.unshift(...dropped);
  progress("reflect", "end", { detail: `调了 ${reflect.modelCalls} 次模型${reflect.review ? `，对抗复核另 ${reflect.review.modelCalls} 次` : ""}` });

  // 7. 编交互策略、出问题、图谱自检（同每晚整理末尾）
  progress("strategies", "start");
  const compiled = engine.compileStrategies();
  progress("strategies", "end", { detail: `新编 ${compiled.created.length}、更新 ${compiled.updated.length}、状态变了 ${compiled.statusChanged.length}` });
  progress("questions", "start");
  const generated = generateQuestions(engine.rg, at);
  const refreshed = engine.questions.refresh(generated.drafts, at);
  progress("questions", "end", { detail: `新出 ${refreshed.added.length} 个问题、不用问了 ${refreshed.obsolete.length} 个` });
  progress("validate", "start");
  const validation = await validateNightly(engine, options.validator ?? graphSelfCheck);
  progress("validate", "end", { detail: validation.state === "ok" ? "图谱自检通过" : `图谱自检：${validation.problems.length} 个问题` });

  // 8. 报告
  const changes: RejudgeClaimChange[] = [];
  for (const c of store.listClaims()) {
    const from = snapshot.get(c.id) ?? null;
    const to = stateOf(c);
    if (from !== null && JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ id: c.id, tier: c.tier, statement: c.statement, epistemic: c.epistemic, from, to });
  }
  const report: FullRejudgeReport = {
    ranAt: at,
    durationMs: Date.now() - started,
    backupFile,
    before,
    after: before,
    migration,
    revived,
    reviveRefused,
    backprop,
    settled,
    reflect,
    strategies: { created: compiled.created, updated: compiled.updated, statusChanged: compiled.statusChanged },
    questions: { added: refreshed.added.map((q) => q.id), obsolete: refreshed.obsolete.map((q) => q.id) },
    validation,
    changes,
    modelCalls: reflect.modelCalls + (reflect.review?.modelCalls ?? 0),
    ...(spend ? { spend: spend() } : {}),
    refused: reflect.dropped.filter((d) => d.stage === "gate").length,
    text: "",
  };
  report.text = formatFullRejudgeReport(report);
  store.db.run(
    `INSERT INTO nightly_runs (night, deferrals, last_check_at, ran_at, report) VALUES (?, 0, ?, ?, ?)
     ON CONFLICT (night) DO UPDATE SET last_check_at = excluded.last_check_at, ran_at = excluded.ran_at, report = excluded.report`,
    fullRejudgeRunKey(at),
    at,
    at,
    JSON.stringify(report),
  );
  report.after = markOf(engine);
  progress("done", "end", { detail: `变了 ${changes.length} 条结论，用了 ${Math.round(report.durationMs / 1000)} 秒` });
  return report;
}

/** 一段给人看的总结（命令行打出来、记进 nightly_runs） */
export function formatFullRejudgeReport(r: FullRejudgeReport): string {
  const m = r.migration;
  const count = (pred: (c: RejudgeClaimChange) => boolean) => r.changes.filter(pred).length;
  const lines = [
    `全量重判一次（${r.ranAt}，用了 ${Math.round(r.durationMs / 1000)} 秒）`,
    `- 规矩迁移：待复核改成复核标记 ${m.reviewToFlag.length} 条、身份恢复 ${m.kindsRestored.length} 条、改挂到用户确认 ${m.directAttached.length} 条、照铁律降回猜测 ${m.downgraded.length} 条、加复核标记 ${m.flagged.length} 条${m.refused.length > 0 ? `、被写入口拒了 ${m.refused.length} 处` : ""}`,
    `- 被错撤的复活成猜测：${r.revived.length} 条${r.reviveRefused.length > 0 ? `（写入口拒了 ${r.reviveRefused.length} 条）` : ""}`,
    `- 老账本里落空的预测往回打：${r.backprop.length} 条`,
    `- 按新规矩当场重定以后变了：${r.settled.length} 条（重跑了它们那组的追问）`,
    `- 整理：调了 ${r.reflect.modelCalls} 次模型${r.reflect.review ? `、对抗复核另 ${r.reflect.review.modelCalls} 次` : ""}，跑了 ${r.reflect.probeIds.length} 条追问${r.reflect.budgetExhausted ? "（预算用完，没跑完的留给每晚整理）" : ""}`,
    `- 结论变了 ${r.changes.length} 条：撤回 → 猜测 ${count((c) => c.from?.status === "retracted" && c.to.status === "contested")}、已验证 → 猜测 ${count((c) => c.from?.status === "active" && c.to.status === "contested")}、猜测 → 已验证 ${count((c) => c.from?.status === "contested" && c.to.status === "active")}、新出 ${count((c) => c.from === null)}、撤回 ${count((c) => c.from !== null && c.from.status !== "retracted" && c.to.status === "retracted")}、被取代 ${count((c) => c.from !== null && c.from.status !== "superseded" && c.to.status === "superseded")}`,
    `- 交互策略：新编 ${r.strategies.created.length}、更新 ${r.strategies.updated.length}、状态变了 ${r.strategies.statusChanged.length}；问题箱：新出 ${r.questions.added.length}、不用问了 ${r.questions.obsolete.length}`,
    `- 图谱自检：${r.validation.state === "ok" ? "通过" : r.validation.state === "skipped" ? `跳过（${r.validation.reason ?? ""}）` : `${r.validation.problems.length} 个问题，加复核标记 ${r.validation.claimIds.length} 条`}`,
    `- 花费：${r.spend ? `${r.spend.calls} 次调用、输入 ${r.spend.inputTokens} token、输出 ${r.spend.outputTokens} token、${r.spend.yuan === null ? "价格表里没有这个模型" : `约 ¥${r.spend.yuan.toFixed(2)}`}` : `调了 ${r.modelCalls} 次模型（没给计量，不报钱）`}`,
    `- 撤回：${r.backupFile === null ? "没存快照（要撤回得用跑之前的备份）" : `快照 ${r.backupFile}；跑完以后库里没再写过时可以换回它`}`,
  ];
  if (r.refused > 0) lines.push(`- 写入口拒了 ${r.refused} 处（原因在报告的 reflect.dropped）`);
  return lines.join("\n");
}

/** 撤回的结果 */
export type FullRejudgeUndo = { restored: true } | { restored: false; reason: string };

/**
 * 撤回一次全量重判：把库换回跑之前存的快照。要先关掉打开着这个库的引擎；跑完以后库里又写过别的（修订日志、留痕的序号和报告里的
 * after 不一样了）就不换——那时候换回去会把后来的也丢掉，交回原因，要撤得用备份手动来
 */
export function undoFullRejudge(options: { file: string; backupFile: string; after: RejudgeMark }): FullRejudgeUndo {
  if (!fs.existsSync(options.backupFile)) return { restored: false, reason: `快照不在了：${options.backupFile}` };
  if (!fs.existsSync(options.file)) return { restored: false, reason: `库不在：${options.file}` };
  const db = openDatabase(options.file);
  let mark: RejudgeMark;
  try {
    mark = {
      revisionSeq: Number(db.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM revisions")?.seq ?? 0),
      writeSeq: Number(db.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM rg_writes")?.seq ?? 0),
    };
  } finally {
    db.close();
  }
  if (mark.revisionSeq !== options.after.revisionSeq || mark.writeSeq !== options.after.writeSeq) {
    return { restored: false, reason: `跑完以后库里又写过别的（修订 ${options.after.revisionSeq} → ${mark.revisionSeq}、留痕 ${options.after.writeSeq} → ${mark.writeSeq}），换回快照会把后来的也丢掉` };
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${options.file}${suffix}`, { force: true });
  fs.copyFileSync(options.backupFile, options.file);
  return { restored: true };
}

/** 进度一行（命令行用）：哪一步、多久、花了多少 */
export function formatFullRejudgeProgress(e: FullRejudgeProgress): string {
  const seconds = Math.round(e.elapsedMs / 1000);
  const clock = `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  const where = e.step ? `整理 · ${e.step.step}` : PHASE_CN[e.phase];
  const money = e.spend ? ` · ${e.spend.calls} 次调用${e.spend.yuan === null ? "" : `、¥${e.spend.yuan.toFixed(3)}`}` : "";
  return `[${clock}] ${where} ${e.state === "start" ? "开始" : "完成"}${e.detail ? `：${e.detail}` : ""}${money}`;
}

const PHASE_CN: Readonly<Record<FullRejudgePhase, string>> = {
  backup: "快照",
  migrate: "规矩迁移",
  revive: "被错撤的复活",
  backprop: "落空的预测往回打",
  settle: "按新规矩重定",
  reflect: "整理",
  strategies: "编交互策略",
  questions: "出问题",
  validate: "图谱自检",
  done: "全量重判",
};
