// 记忆插件对外的接口（129 号票，ADR-0027）：内核和别的插件只从这里拿记忆插件的东西——服务名（经插件宿主按名字取，
// 插件没启用时取到 undefined）和它的类型；不 import 记忆插件的别的文件（test/memory/boundary.test.ts 检查，例外写在那里）。
// 二期的记忆系统（记忆管理者、做梦阶段、记忆简报、用户卡、动机挖掘）往这个插件里加，对外要给的接口也加在这里。
// 242 号票起多一个服务 MEMORY_NIGHTLY：记忆管理员（内核那个按需拉起的 agent）用它跑"同一份整理"、挂"03:00 唤醒我"的委派；
// 它和 MEMORY 一起由记忆插件提供（插件停用就都没有）。
// 284 号票起多一个服务 MEMORY_INTERVIEWS：了解你访谈（开着的那次、开一次、结束、每周约访）——记忆管理员的访谈工具、组合根给用户在
// 管理员会话里说的话标访谈编号、网关的 GET / POST /api/memory/interview 用它。
import type { MemoryDeleteMode, PersonalFileKind, PersonalFileLearnedView } from "@ergo/protocol";
import { serviceKey } from "../plugins/host.ts";
import type { QuickActionContext, QuickActionOutcome } from "../quick-actions/index.ts";
import type { MemoryInterviews } from "./interview.ts";
import type { MemoryNightlyRecord } from "./nightly-record.ts";
import type { MemoryNightlyWake, MemoryNightlyWakeResult } from "./nightly-job.ts";

export interface MemoryService {
  /**
   * 记忆删除卡上确认的删除（忘掉、彻底删除、别推断）：按删法交给快速动作执行，事件、操作记录和卡片更新同一事务。
   * 卡片动作现取（插件没启用时抛"记忆插件没启用"）
   */
  confirmDeletion(mode: MemoryDeleteMode, materialIds: readonly string[], context: QuickActionContext, title: string): QuickActionOutcome;
  /**
   * 283 号票：个人档案的"二狗了解到的"——档案里的人（称呼、别名；本人对用户自己）对到事实图谱的人物实体，列和他有关的结论、事实、原话。
   * 只读、现取；推理库读不了时 ready 是 false、写明原因
   */
  learnedAbout(subject: { kind: PersonalFileKind; names: readonly string[] }): PersonalFileLearnedView;
}

/** 记忆每晚整理（242 号票：从插件里露出来的那一小半，给记忆管理员用） */
export interface MemoryNightlyService {
  /** 现在为什么跑不了（已经翻成用户的语言）；能跑是 undefined */
  blocked(): string | undefined;
  /** 立即整理一次（235 号票的"立即整理一次"：trigger 记 manual，不吃那一夜的定时水位） */
  runNow(): Promise<MemoryNightlyRecord | undefined>;
  /**
   * 挂上"03:00 的委派"：到点时作业先叫它（管理员被唤醒，自己调 run），交回这一夜管理员调了几次模型和跑成的记录；
   * 它这一夜没调成时作业照旧补跑一次。返回取消挂上的函数。同一时间只挂一个
   */
  wakeWith(wake: (info: MemoryNightlyWake) => Promise<MemoryNightlyWakeResult | undefined>): () => void;
}

/** 记忆插件提供的服务 */
export const MEMORY = serviceKey<MemoryService>("memory");
/** 记忆插件提供的服务：每晚整理（242 号票；只有记忆管理员用） */
export const MEMORY_NIGHTLY = serviceKey<MemoryNightlyService>("memory-nightly");
/** 记忆插件提供的服务：了解你访谈（284 号票） */
export const MEMORY_INTERVIEWS = serviceKey<MemoryInterviews>("memory-interviews");
export type { InterviewSession, MemoryInterviews } from "./interview.ts";
