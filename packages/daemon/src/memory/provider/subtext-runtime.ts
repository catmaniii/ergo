// @i18n-ignore-file log：这里只有日志和给宿主的出错说明（这一版还没接界面）
// 会意插件的运行接入（337 号票第一段）：组合根只 import memory/provider/ 这个槽（memory/ 里插件内部的那些文件
// 只有插件清单 import，见 test/memory/boundary.test.ts），所以替它把会意插件要的东西备齐：
// - 一份缓存的只读引擎（engine-provider.ts：第一次用时打开、之后一直用、close 时关掉；库还没建、版本对不上、
//   打不开时是 undefined，插件那边就当"这一会儿没有记忆"）；
// - 推理库那一侧的彻底删除（purge-rg.ts 的 purgeMaterials，和记忆插件自己那一份同一个函数）：只按素材删证据和事实，
//   素材库、原话副本是内核的，这里不碰。它的 start()（订阅记忆命令）和 reconcile() 仍然只由记忆插件自己那一份做；
// - 整理记录里最近一次跑完的时间（ergo.db 的 memory_nightly 视图，插件没启用过时没有这张表）、推理库占多少字节；
// - 337 号票第二段：按原话记一条（用户说"帮我记一句"）——落在现有的"显式记忆命令"那条链上，不另造写库路径：
//   追加一条 memory_command（from.kind 是 secretary，带会话/消息/工具调用）→ 素材库照旧把它采成"显式记忆命令"素材 →
//   立刻用每晚整理同一个 evidenceDraftOf 读成证据、经推理库的唯一写入口入库（整理时按出处跳过，不会重复读）。
// 插件自己不带引擎、也不关它：引擎是这一份建、这一份关（组合根的 teardown 里）。
import fs from "node:fs";
import { DEEPSEEK_DEFAULT_MODEL, type Embedder } from "@ergo/memory";
import type { MemoryConfig } from "../../config/config.ts";
import type { EventStore } from "../../events/event-store.ts";
import { materialId, MEMORY_COMMAND_SOURCE, type Materials } from "../../materials/index.ts";
import { clockIso, type Clock } from "../../scheduler/clock.ts";
import { memoryCommandEvent } from "../deletion.ts";
import { createMemoryEngineProvider, createWritableEngineUse } from "../engine-provider.ts";
import { evidenceDraftOf } from "../evidence-source.ts";
import { latestNightlyRecord } from "../nightly-record.ts";
import { createReasoningPurge } from "../purge-rg.ts";
import type { SubtextProviderDeps, SubtextRememberCommand, SubtextRememberRecord } from "./subtext.ts";

/** 337 号票：按原话记一条的写在留痕里记的"经谁转达"（和"记住"这条记忆命令同一个意思：用户发起） */
export const REMEMBER_VIA = "经秘书记一句";

export interface SubtextRuntimeOptions {
  /** 推理库 rg.db 的路径（338 号票起是插件自己的数据目录：<数据目录>/memory/subtext/rg.db） */
  file: string;
  /** 引擎的时钟（"现在"）；整理记录的视图也从它 */
  clock: Clock;
  /** manifest 里记着的整理模型名（默认和每晚整理一致） */
  model?: string;
  /** 向量函数（不给时检索只有关键词；manifest 里也记不上名字） */
  embedder?: Embedder;
  /** 配置的 memory 一节（彻底删除要用的敏感类别和整理记录） */
  config: MemoryConfig;
  /**
   * 事件日志：读整理记录（memory_nightly 的派生视图）；彻底删除那一份要 read / onAppend（这里不订阅，只借它的删除函数）；
   * 337 号票起"记一句"要 append（追加一条 memory_command）
   */
  store: Pick<EventStore, "reader" | "read" | "onAppend" | "append">;
  /** 素材库：把证据的出处对回素材、按来源找素材；"记一句"还要读刚采到的那条素材 */
  materials: Pick<Materials, "get" | "list">;
  log: (line: string) => void;
}

export interface SubtextRuntime {
  /** 交给 subtextProviderFactory 的那些 */
  deps: SubtextProviderDeps;
  /** 关掉那份缓存的只读引擎（组合根在 teardown 里调；插件自己不管引擎） */
  close(): void;
}

export function createSubtextRuntime(options: SubtextRuntimeOptions): SubtextRuntime {
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  const engine = createMemoryEngineProvider({
    file: options.file,
    clock: () => clockIso(options.clock),
    model,
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    log: options.log,
  });
  // 只借 purgeMaterials：它的 start()（订阅记忆命令）和 reconcile() 由记忆插件自己那一份做，这里都不叫
  const purge = createReasoningPurge({
    file: options.file,
    store: options.store,
    clock: options.clock,
    config: options.config,
    materials: options.materials,
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    model,
    log: options.log,
  });
  // 337 号票：写推理库那一下随用随开一份可写的（和顺口问同一条路，不在这份缓存的读者引擎上写）
  const withWriteEngine = createWritableEngineUse({
    file: options.file,
    clock: () => clockIso(options.clock),
    model,
    what: "按原话记一条",
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    log: options.log,
  });

  /**
   * 按原话记一条：追加"显式记忆命令"事件（素材库随即采成素材）→ 立刻照每晚整理同一个 evidenceDraftOf 读成证据、
   * 经推理库的唯一写入口入库。库这会儿用不了、素材还没采到时只记了事件/素材，那一夜整理照常读进去。
   */
  const remember = (command: SubtextRememberCommand): SubtextRememberRecord => {
    const appended = options.store.append(
      memoryCommandEvent(
        {
          command: "remember",
          content: command.text,
          // 用户自己说的话（秘书只是照抄过来）：和快速动作那条路的"本人打的字"同一个来源标记
          source: "typed",
          from: {
            kind: "secretary",
            conversation: command.conversation,
            ...(command.inputMessageId === undefined ? {} : { inputMessageId: command.inputMessageId }),
            ...(command.toolCallId === undefined ? {} : { toolCallId: command.toolCallId }),
          },
        },
        command.idempotencyKey,
      ),
    );
    const stored = appended.event;
    // 素材 id 由事件算得出来（同一条事件永远同一个 id），素材库已经在 onAppend 里采过了
    const id = materialId(stored, MEMORY_COMMAND_SOURCE, 0);
    const base = { materialId: id, at: stored.time };
    if (appended.duplicate) {
      // 这句刚才已经记过了（幂等键相同）：不再读成第二条证据，回已经进了检索的那一条
      const existing = withWriteEngine((open) => open.store.listEvidence({ status: "active" }).find((evidence) => evidence.sourceRef === id)?.id);
      options.log(`按原话记一条：这句刚才已经记过了，不重复记（素材 ${id}${existing === undefined ? "" : `，证据 ${existing}`}）`);
      return existing === undefined ? base : { ...base, evidenceId: existing };
    }
    const material = options.materials.get(id);
    if (material === undefined) {
      options.log(`按原话记一条：素材 ${id} 还没采到（素材库这会儿只保管）：只记了事件，等它采成素材以后那一夜整理读进去`);
      return base;
    }
    const draft = evidenceDraftOf(material, options.config.sensitiveCategories);
    if (draft === undefined) {
      options.log(`按原话记一条：素材 ${id} 读不成证据（标了别推断、或者落在没打开的敏感类别里）：只留在素材里`);
      return base;
    }
    const evidence = withWriteEngine((open) =>
      open.gate.write({ op: "ingest", actor: "user", via: REMEMBER_VIA, reason: "用户让秘书记一句" }, () => open.ingestEvidence(draft)),
    );
    if (evidence === undefined) {
      options.log(`按原话记一条：推理库这一会儿用不了，素材 ${id} 先记着，那一夜整理读进去`);
      return base;
    }
    return { ...base, evidenceId: evidence.id };
  };

  return {
    close: () => engine.close(),
    deps: {
      engine: () => engine.get(),
      materials: options.materials,
      remember,
      deleteMaterials: (materialIds) => purge.purgeMaterials(materialIds),
      // 最近一次整理跑完的时间：最近的一条整理记录（只有跑成了的那一夜才有 ranAt；表不在就当作没整理过）
      lastConsolidatedAt: () => {
        try {
          const latest = latestNightlyRecord(options.store.reader);
          return latest === undefined || latest.state !== "ran" ? undefined : (latest.ranAt ?? latest.at);
        } catch {
          return undefined;
        }
      },
      // 会意的数据现在占多少：推理库 rg.db（338 号票起在它自己的数据目录 <数据目录>/memory/subtext/ 里）
      bytes: () => {
        try {
          return fs.statSync(options.file).size;
        } catch {
          return undefined;
        }
      },
    },
  };
}
