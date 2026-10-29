// @i18n-ignore-file data：这里的中文是写进推理库修订日志和审计的原因（"为什么撤掉这条"）和日志里的名字，
// 不是界面模板，也不随界面语言变——留着原文，查的时候能对上是哪一条命令。
// 彻底删除登记进推理库（234 号票，接入设计第 3、7 节，ADR-0008）。
//
// 素材库删掉一条素材时，推理库 rg.db 里还留着从它读出来的证据、抽出来的事实、靠它们推的结论和问过的问题。
// 这里跟着记忆命令（materials 频道上的 memory_command）做四件事：
// - 彻底删除（purge）：按素材 id（证据的 sourceRef）找到证据，删证据和只靠它的事实，依赖的结论加复核标记（329 号票：只靠它的推断停用、等整理重推），
//   相关问题标过期，写审计（@ergo/memory 的 purge.ts）；删完做 WAL 检查点，原文不留在库里；
// - 忘掉（forget）：证据清原文、事实撤回，依赖的结论照"来源失效"走（加复核标记、已验证的降回猜测、前提都不在了的撤回）；素材本身留墓碑；
// - 别推断（no_infer）：那条素材不再参与推断。以后读素材时适配器会跳过它；已经进过库的证据、事实从推理库撤掉
//   （不然还拿它当依据），依赖的结论同忘掉。取消标记不会把结论恢复成已验证，下一次整理才重新推；
// - 敏感类别（234 号票）：健康这类默认允许记录、不用于推断；已经进过库的证据在启动时撤掉（健康按 domain=health）。
//   以后读素材时适配器跳过没打开的类别；打开某一类之后，下一夜整理重新读那边的素材。v1 只有健康生效。
//
// 引擎随用随开（照 225 号票的 nightly-job）：每条命令打开一次 rg.db、做完关掉，不在守护进程里长期握着句柄；
// 版本对不上、库打不开时只在日志里说一句，素材删除照常（推理库之后重建）。
//
// 启动时 reconcil 把历史命令补做一遍：记忆插件停用期间下的命令（素材库照样删了）在再启用时补上；
// 敏感类别也在启动时对一遍（以前进过库的健康证据）。
// 303 号票：数据源素材读成的证据（出处是素材 id 或 digest:<素材 id,…>，materialIdsOfRef 拆开）也在启动时对一遍——照现在的设置重读一遍
// （evidence-source.ts 的 dataSourceDraftOf），读不出来了（出处里写的敏感类别没打开）或者原文会变样（位置关了、地点要去掉；
// 位置开了、要带上地点）的撤掉，下一夜照新的设置重新读进来。
//
// 267 号票：推理库这边一律经唯一写入口写（@ergo/memory 的 engine.gate），记成"用户发起"（忘掉、彻底删除、别推断只由用户发起），
// 经谁转达写进留痕（记忆删除卡、设置页、记忆管理员、删项目 / 删任务时连带、敏感类别设置）。
import { existsSync } from "node:fs";
import { DEEPSEEK_DEFAULT_MODEL, type Embedder, type MemoryEngine, type PurgeReport, purgeEvidence, type UserActionOptions } from "@ergo/memory";
import { EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload } from "@ergo/protocol";
import type { MemoryConfig } from "../config/config.ts";
import type { EventStore } from "../events/event-store.ts";
import { commandEffect, MATERIALS_CHANNEL } from "../materials/commands.ts";
import type { Material, Materials } from "../materials/index.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import { materialIdsOfRef } from "./data-source-evidence.ts";
import { dataSourceDraftOf } from "./evidence-source.ts";
import { sensitiveCategoryLabel, sensitiveCategoryOfScene } from "./privacy.ts";
import { openReasoningDb, type ReasoningDbIssue } from "./rg-db.ts";

/** 读历史命令、跟着新命令要用的那两样 */
export type ReasoningPurgeStore = Pick<EventStore, "read" | "onAppend">;

export interface ReasoningPurgeOptions {
  /** rg.db 的路径（338 号票起是 <数据目录>/memory/subtext/rg.db；以前在 db 区） */
  file: string;
  store: ReasoningPurgeStore;
  clock: Clock;
  /** 配置的 memory 一节（敏感类别） */
  config: MemoryConfig;
  /** 303 号票：素材库（启动时对数据源素材的证据要按出处取回素材）；不给就不对这一样 */
  materials?: Pick<Materials, "get">;
  /** 向量函数：只在 manifest 里记名字，删除用不到（不给也照常删） */
  embedder?: Embedder;
  /** 整理用的模型名（写进 manifest；默认 deepseek-flash） */
  model?: string;
  log?: (line: string) => void;
}

export interface ReasoningPurge {
  /** 订阅新的记忆命令；返回取消订阅的函数（插件停用时撤） */
  start(): () => void;
  /** 把历史命令和敏感类别对一遍（启动时做；幂等，重复做只补还没做的） */
  reconcile(): void;
  /** 彻底删除素材：删证据和事实、依赖的结论加复核标记、相关问题过期、写审计（by：经谁转达，留痕用） */
  purgeMaterials(materialIds: readonly string[], reason?: string, by?: UserActionOptions): PurgeReport | undefined;
  /** 忘掉素材：证据清原文、事实撤回、依赖的结论照来源失效走（素材留墓碑，派生内容不删） */
  forgetMaterials(materialIds: readonly string[], by?: UserActionOptions): void;
  /** 别推断：把素材的证据、事实从推理库撤掉，依赖的结论照来源失效走 */
  disableMaterials(materialIds: readonly string[], reason?: string, by?: UserActionOptions): PurgeReport | undefined;
  // 263 号票删了 purgeFacts（事实不经素材直接彻底删）：234 号票留的接口，一直没有调用方（素材库没有删事实的流程，事实只从素材来）。
  // 要的时候 @ergo/memory 的 purgeFacts 还在。
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const issueText = (issue: ReasoningDbIssue): string => {
  switch (issue.code) {
    case "manifest_missing":
      return "推理库还没有 manifest";
    case "schema_mismatch":
      return `推理库的格式版本是 ${issue.found}，代码认识 ${issue.expected}`;
    case "store_schema_mismatch":
      return `推理库的表版本是 ${issue.found}，代码认识 ${issue.expected}`;
    case "open_failed":
      return `推理库打不开：${issue.detail}`;
  }
};

/** 267 号票：一条记忆命令是经谁下的（写进推理库的留痕；数据，不随界面语言变）——都算用户发起 */
export function commandOrigin(payload: MemoryCommandEventPayload): UserActionOptions {
  if (payload.command === "remember") return { actor: "user" };
  switch (payload.from.kind) {
    case "settings":
      return { actor: "user", via: "经设置页成批删除" };
    case "curator":
      return { actor: "user", via: "经记忆管理员" };
    case "project_deletion":
      return { actor: "user", via: "删项目时连带" };
    case "task_deletion":
      return { actor: "user", via: "删任务时连带" };
    case "personal_file":
      return { actor: "user", via: "删个人档案时连带" };
    case "data_source":
      return { actor: "user", via: "断开数据源时连带" };
    default:
      return { actor: "user", via: "经记忆删除卡" };
  }
}

/** 敏感类别的设置撤掉的（默认不用于推断）：用户的设置，算用户发起 */
const SENSITIVE_ORIGIN: UserActionOptions = { actor: "user", via: "敏感类别设置" };

/**
 * 按素材 id 找到证据（sourceRef 是素材 id；忘了的、彻底删掉的也要处理，所以不按状态筛）。
 * 303 号票：几条数据源素材合成的一条（digest:<素材 id,…>）其中一条在里面就算——删一条就撤整条，剩下的下一夜重新合
 */
function evidenceOf(engine: MemoryEngine, materialIds: readonly string[]) {
  const wanted = new Set(materialIds);
  return engine.store.listEvidence().filter((evidence) => materialIdsOfRef(evidence.sourceRef).some((id) => wanted.has(id)));
}

/** 证据背后的素材 id（审计、留痕用） */
const materialsBehind = (evidence: ReadonlyArray<{ sourceRef: string | null }>): string[] => [...new Set(evidence.flatMap((e) => materialIdsOfRef(e.sourceRef)))];

export function createReasoningPurge(options: ReasoningPurgeOptions): ReasoningPurge {
  const log = options.log ?? (() => {});
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;

  /** 打开一次引擎做事，做完关掉；库不能用、出错都只在日志里说一句 */
  const withEngine = <T>(what: string, fn: (engine: MemoryEngine) => T): T | undefined => {
    let engine: MemoryEngine | undefined;
    try {
      const opened = openReasoningDb({
        file: options.file,
        clock: () => clockIso(options.clock),
        model,
        ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
      });
      if (!opened.ok) {
        log(`记忆删除：${what}没做——${issueText(opened.issue)}；素材删除照常，推理库之后重建`);
        return undefined;
      }
      engine = opened.engine;
      const result = fn(engine);
      engine.store.checkpoint();
      return result;
    } catch (err) {
      log(`记忆删除：${what}出错：${messageOf(err)}`);
      return undefined;
    } finally {
      engine?.close();
    }
  };

  const purgeMaterials = (materialIds: readonly string[], reason = "彻底删除素材", by: UserActionOptions = { actor: "user" }): PurgeReport | undefined => {
    const ids = [...new Set(materialIds)];
    if (ids.length === 0) return undefined;
    return withEngine(`彻底删除素材 ${ids.join("、")}`, (engine) => {
      const evidenceIds = evidenceOf(engine, ids).map((evidence) => evidence.id);
      if (evidenceIds.length === 0) return undefined;
      const report = purgeEvidence(engine, evidenceIds, { reason, materialIds: ids, at: clockIso(options.clock), op: "purge", ...by });
      log(`记忆删除：彻底删除素材 ${ids.join("、")}——证据 ${report.evidenceIds.length} 条、事实 ${report.factIds.length} 条，结论标了复核 ${report.claimIds.length} 条，问题过期 ${report.questionIds.length} 个`);
      return report;
    });
  };

  const forgetMaterials = (materialIds: readonly string[], by: UserActionOptions = { actor: "user" }): void => {
    const ids = [...new Set(materialIds)];
    if (ids.length === 0) return;
    withEngine(`忘掉素材 ${ids.join("、")}`, (engine) => {
      let n = 0;
      for (const evidence of evidenceOf(engine, ids)) {
        if (engine.getEvidence(evidence.id)?.status !== "active") continue;
        engine.invalidateEvidence(evidence.id, "素材被忘掉了，不再当依据", by);
        n += 1;
      }
      if (n > 0) log(`记忆删除：忘掉素材 ${ids.join("、")}——证据 ${n} 条不再当依据`);
    });
  };

  const disableMaterials = (materialIds: readonly string[], reason = "别推断：不参与推断", by: UserActionOptions = { actor: "user" }): PurgeReport | undefined => {
    const ids = [...new Set(materialIds)];
    if (ids.length === 0) return undefined;
    return withEngine(`别推断 ${ids.join("、")}`, (engine) => {
      const evidenceIds = evidenceOf(engine, ids).map((evidence) => evidence.id);
      if (evidenceIds.length === 0) return undefined;
      const report = purgeEvidence(engine, evidenceIds, { reason, materialIds: ids, at: clockIso(options.clock), op: "no_infer", ...by });
      log(`记忆删除：素材 ${ids.join("、")} 标了别推断——从推理库撤掉证据 ${report.evidenceIds.length} 条，结论标了复核 ${report.claimIds.length} 条`);
      return report;
    });
  };

  /** 一条记忆命令按它的作用处理（记住没有删除作用，跳过） */
  const handle = (payload: MemoryCommandEventPayload): void => {
    const effect = commandEffect(payload);
    const by = commandOrigin(payload);
    if (effect.purge) purgeMaterials(effect.forget, undefined, by);
    else if (effect.forget.length > 0) forgetMaterials(effect.forget, by);
    if (effect.noInfer.length > 0) disableMaterials(effect.noInfer, undefined, by);
  };

  return {
    start() {
      return options.store.onAppend((event) => {
        if (event.type !== EVENT_TYPES.memoryCommand || isDeletedEventPayload(event.payload)) return;
        try {
          handle(event.payload as MemoryCommandEventPayload);
        } catch (err) {
          // onAppend 的订阅者抛错不影响别的订阅者，这里记一笔就够
          log(`记忆删除：处理记忆命令出错：${messageOf(err)}`);
        }
      });
    },

    reconcile() {
      // 库还没建过就没有要补的（235 号票：memory.enabled = false 时不顺手把 rg.db 建出来；
      // 以前建过的照常补做历史删除和敏感类别）
      if (!existsSync(options.file)) return;
      const commands = options.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand);
      withEngine("补做以前的删除", (engine) => {
        for (const event of commands) {
          if (isDeletedEventPayload(event.payload)) continue;
          const effect = commandEffect(event.payload as MemoryCommandEventPayload);
          const by = commandOrigin(event.payload as MemoryCommandEventPayload);
          if (effect.purge) {
            const evidenceIds = evidenceOf(engine, effect.forget).map((evidence) => evidence.id);
            if (evidenceIds.length > 0) purgeEvidence(engine, evidenceIds, { reason: "彻底删除素材（补做）", materialIds: effect.forget, at: clockIso(options.clock), op: "purge", ...by });
          } else if (effect.forget.length > 0) {
            for (const evidence of evidenceOf(engine, effect.forget)) {
              if (engine.getEvidence(evidence.id)?.status === "active") engine.invalidateEvidence(evidence.id, "素材被忘掉了，不再当依据（补做）", by);
            }
          }
          if (effect.noInfer.length > 0) {
            const evidenceIds = evidenceOf(engine, effect.noInfer).map((evidence) => evidence.id);
            if (evidenceIds.length > 0) purgeEvidence(engine, evidenceIds, { reason: "别推断（补做）", materialIds: effect.noInfer, at: clockIso(options.clock), op: "no_infer", ...by });
          }
        }
        // 敏感类别：已经进过库、现在不允许推断的（v1 只有健康）撤掉；以后读素材时适配器也会跳过
        const allowed = new Set(options.config.sensitiveCategories);
        const sensitive = engine.store.listEvidence().filter((evidence) => {
          const category = sensitiveCategoryOfScene(evidence.context);
          return category !== undefined && !allowed.has(category);
        });
        if (sensitive.length > 0) {
          const categories = new Set(sensitive.map((evidence) => sensitiveCategoryOfScene(evidence.context)).filter((category) => category !== undefined));
          const report = purgeEvidence(engine, sensitive.map((evidence) => evidence.id), {
            reason: `敏感类别（${[...categories].map(sensitiveCategoryLabel).join("、")}）默认不用于推断`,
            materialIds: materialsBehind(sensitive),
            at: clockIso(options.clock),
            op: "no_infer",
            ...SENSITIVE_ORIGIN,
          });
          log(`记忆删除：敏感类别（${[...categories].map(sensitiveCategoryLabel).join("、")}）默认不用于推断——从推理库撤掉证据 ${report.evidenceIds.length} 条`);
        }
        // 303：数据源素材的证据照现在的敏感类别重读一遍，读不出来、原文变样的撤掉（下一夜照新设置重读）
        const materials = options.materials;
        if (materials !== undefined) {
          const drifted = engine.store.listEvidence({ status: "active" }).filter((evidence) => {
            const behind = materialIdsOfRef(evidence.sourceRef)
              .map((id) => materials.get(id))
              .filter((m): m is Material => m !== undefined);
            if (behind.length === 0 || behind.some((m) => m.origin === undefined)) return false;
            return dataSourceDraftOf(behind, options.config.sensitiveCategories)?.text !== evidence.text;
          });
          if (drifted.length > 0) {
            const report = purgeEvidence(engine, drifted.map((evidence) => evidence.id), {
              reason: "数据源素材的敏感类别设置变了，照新的设置重新读",
              materialIds: materialsBehind(drifted),
              at: clockIso(options.clock),
              op: "no_infer",
              ...SENSITIVE_ORIGIN,
            });
            log(`记忆删除：数据源素材的敏感类别设置变了——从推理库撤掉证据 ${report.evidenceIds.length} 条，下一夜照新的设置重新读`);
          }
        }
      });
    },

    purgeMaterials,
    forgetMaterials,
    disableMaterials,
  };
}
