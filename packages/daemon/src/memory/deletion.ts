// 记一条记忆命令、做一次删除（规格第 15 节，21 号票）：对话里的记忆删除卡和设置里的批量删除共用这一个函数。
// - 先在事件日志里记一条 memory_command（ADR-0006：否则重建时素材会回来），素材模块据此删除、标记素材、删原文副本；
// - 彻底删除另外在同一事务里改写原始事件和带原话的记录（purge.ts），追加 messages_purged 和改写后的卡片新版本。
import { randomUUID } from "node:crypto";
import { type DeleteCommandPayload, EVENT_TYPES, type MemoryCommandEventPayload, type MemoryDeleteMode } from "@ergou/protocol";
import type { NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import { type Material, MATERIALS_CHANNEL } from "../materials/index.ts";
import { type PurgeDeps, purgePlan } from "./purge.ts";

/** 记忆命令事件（素材频道）；命令 id 在这里生成 */
export function memoryCommandEvent(payload: DistributiveOmit<MemoryCommandEventPayload, "commandId">, idempotencyKey?: string): NewEvent {
  const full = { commandId: `mc-${randomUUID()}`, ...payload } as MemoryCommandEventPayload;
  return { channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: full, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface DeletionRequest {
  mode: MemoryDeleteMode;
  materials: readonly Material[];
  from: DeleteCommandPayload["from"];
  /** 命令事件的幂等键（设置里的批量删除带：同一个请求重发只执行一次） */
  idempotencyKey?: string;
  /** 彻底删除时不追加新版本的卡（记忆删除卡自己的动作会追加） */
  exceptCard?: string;
  /** 彻底删除时另外要改写的原始事件（没有素材的语音，31 号票） */
  extraTargets?: readonly StoredEvent[];
}

/** 一次删除要追加的事件（记忆命令在最前）和要改写的事件 */
export function deletionEvents(deps: PurgeDeps, request: DeletionRequest): { events: NewEvent[]; purge: PurgeRewrite[] } {
  const command = memoryCommandEvent({ command: request.mode, materialIds: request.materials.map((m) => m.id), from: request.from }, request.idempotencyKey);
  if (request.mode !== "purge") return { events: [command], purge: [] };
  const plan = purgePlan(deps, request.materials, {
    ...(request.exceptCard === undefined ? {} : { exceptCard: request.exceptCard }),
    ...(request.extraTargets === undefined ? {} : { extraTargets: request.extraTargets }),
  });
  return { events: [command, ...plan.events], purge: plan.purge };
}
