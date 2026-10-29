// "立即整理一次"（235 号票）：记忆插件的一个快速动作，给用户（和演示、验收）一个不用等到 03:00 的入口。
//
// 走同一份作业：调的是记忆插件的每晚整理作业（`nightly-job.ts` 的 `runNow`）——同一个引擎、同一份 `memory.maxModelCalls` 预算、
// 同一条整理记录（`memory_nightly` 事件和视图，trigger 记 manual，报告里 late 是 false）；不是另写一套整理。
// **增量靠引擎自己的簿记**：素材按 sourceRef 跳过、抽事实按 extraction_log 每条证据一次、假设/追问/往上抽走 rg_* 的记账，
// 连点两次第二次几乎不调模型；也**不动那一夜的定时水位**——01:00 手动整理过，当天 03:00 的定时那次照常跑。
// 用户看得见的结果写在卡片的"结果"和操作记录里：整理完交回新增 / 变化几条、问题箱里开着几个、调了几次模型；没跑成写明原因
// （关着整理、推理库要重建、没配 key、上一次还在跑……）。
//
// **默认不要被模型随便调用**：它不是给秘书的工具（agent 那边只有 search_materials / read_material / ask_memory），模型只能在
// "提议快速动作"里提一句；`confirm: "always"` 让它总要用户核对后执行——推断出来的、用户点明了的都出一张卡，用户点了"执行"才跑。
//
// 为什么是异步执行器（`perform`）：一次整理要调模型、要几十秒甚至几十分钟，不能卡住卡片动作那一拍；卡片先记成"正在执行"，
// 跑完补上结果和操作记录（和 27 号票调 MCP 工具同一个机制）。插件停用、守护进程停止时作业那边会把这次整理中止（AbortError），
// 卡片结果写"没跑成"。
import { Type, t } from "@ergo/protocol";
import { defineQuickAction, type QuickActionExecutor, type QuickActionPerformed } from "../quick-actions/index.ts";
import type { MemoryNightlyRecord } from "./nightly-record.ts";

/** 动作类型（秘书在"提议快速动作"里写它） */
export const MEMORY_NIGHTLY_ACTION = "memory_nightly";

export interface MemoryNightlyActionOptions {
  /** 跑一次整理（同一份作业）；记忆整理关着、推理库用不了时不传（跑了也没意义） */
  run?: () => Promise<MemoryNightlyRecord | undefined>;
  /** 现在为什么跑不了（已经翻成用户的语言）；能跑是 undefined */
  blocked: () => string | undefined;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 一条整理记录 → 卡片上的一句话。整理完（ran）：新增、变化、问题箱、模型调用次数；没跑成：写原因（没配 key、
 * 要重建推理库、上一次还在跑、失败了……）
 */
export function nightlyActionSummary(record: MemoryNightlyRecord | undefined): QuickActionPerformed {
  if (record === undefined) return { ok: false, summary: t("memory.nightly.manual.failed", { detail: t("memory.nightly.manual.noRecord") }) };
  if (record.state === "ran") {
    const summary = t("memory.nightly.manual.done", {
      newClaims: record.newClaims,
      changedClaims: record.changedClaims,
      open: record.questions.open,
      modelCalls: record.modelCalls,
    });
    return { ok: true, summary: record.budgetExhausted ? `${summary}${t("memory.nightly.manual.budget")}` : summary };
  }
  return { ok: false, summary: t("memory.nightly.manual.notRun", { reason: record.reason ?? "" }) };
}

/** 登记"立即整理一次"这个快速动作（记忆插件的 setup 里登记，插件停用随它撤销） */
export function memoryNightlyAction(options: MemoryNightlyActionOptions): QuickActionExecutor {
  return defineQuickAction({
    type: MEMORY_NIGHTLY_ACTION,
    get title() {
      return t("memory.nightly.manual.title");
    },
    // @i18n-ignore-next model：给秘书的用法（写进"提议快速动作"工具的说明）
    usage: "用户想马上整理一次记忆、不用等到凌晨 03:00 时用（把这阵子新说的话整理成结论、更新对你的了解）",
    params: Type.Object({}, { additionalProperties: false }),
    // 不落入任何类别；但总要用户核对（模型只能提议，点了才跑）
    watch: { categories: [] },
    confirm: "always",
    normalize() {
      return { params: {}, title: t("memory.nightly.manual.title") };
    },
    async perform(): Promise<QuickActionPerformed> {
      const blocked = options.blocked();
      if (blocked !== undefined) return { ok: false, summary: blocked };
      if (options.run === undefined) return { ok: false, summary: t("memory.nightly.manual.off") };
      try {
        return nightlyActionSummary(await options.run());
      } catch (err) {
        return { ok: false, summary: t("memory.nightly.manual.failed", { detail: messageOf(err) }) };
      }
    },
  });
}
