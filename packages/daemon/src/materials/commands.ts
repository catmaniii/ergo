// 显式记忆命令（规格第 14、15 节，21 号票）在素材模块这一侧。memory_command 事件有两个作用：
// - 它是"显式记忆命令"素材的来源（每条命令一条：记住、忘掉、彻底删除、别推断都算；删除项目时随项目彻底删除的不算——
//   那不是用户下的记忆命令，66 号票）；
// - 它是删除（忘掉、彻底删除）和标记（别推断）素材的依据。memory.db 是派生的（ADR-0006），
//   所以删除也记在事件日志里，删掉 memory.db 重建、从原文副本补回时照样删掉、照样标上。
// 彻底删除另外要改写原始事件，那是记忆命令模块（memory/）在追加这条命令的同一事务里做的；"记住"的命令事件被彻底删除时，
// 只把要记住的内容换成删除标记（rememberCommandPurge），删除类的命令事件永不改写（它是"这些被删了"的记录）。
import {
  type DeleteCommandPayload,
  EVENT_TYPES,
  type MaterialScope,
  MEMORY_COMMAND_LABEL,
  type MemoryCommandEventPayload,
  PURGED_TEXT,
  type RememberCommandPayload,
} from "@ergou/protocol";
import type { PurgeRewriter } from "../events/purge.ts";
import type { MaterialSource } from "./capture.ts";
import { type MaterialPiece, segmentPieces } from "./segments.ts";
import { conversationKind } from "./sources.ts";

/** 记忆命令事件所在的频道：守护进程内部的素材频道（前端不订阅） */
export const MATERIALS_CHANNEL = "materials";

/** 这条命令对已有素材的作用：忘掉哪些（含彻底删除）、标记哪些不参与推断；purge 表示是彻底删除 */
export function commandEffect(payload: MemoryCommandEventPayload): { forget: readonly string[]; noInfer: readonly string[]; purge: boolean } {
  if (payload.command === "remember") return { forget: [], noInfer: [], purge: false };
  if (payload.command === "no_infer") return { forget: [], noInfer: payload.materialIds, purge: false };
  return { forget: payload.materialIds, noInfer: [], purge: payload.command === "purge" };
}

/** 时间写到分钟："2026-10-01 00:00" */
const minuteOf = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** 范围的说法（素材里、卡片上用）："会话 secretary"、"2026-10-01 00:00 到 2026-10-07 23:59" */
export function scopeLabel(scope: MaterialScope): string {
  if (scope.kind === "conversation") return `会话 ${scope.conversation}`;
  return `${minuteOf(scope.from)} 到 ${minuteOf(scope.to)}`;
}

/**
 * "记住"的内容按它从哪里来标来源：用户自己打的字 → 本人打的字；用户语音里说的 → 本人，注明"转写"（31 号票）；只在引用块里 → 外部、不可信（只留引用和哈希）；
 * 只在用户引用的卡片里、或者秘书推断出来用户确认的 → 用户的选择，注明 agent 先提出
 */
function rememberPiece(p: RememberCommandPayload): MaterialPiece {
  const locator = { field: "content" };
  switch (p.source) {
    case "typed":
      return { form: "typed", text: p.content, locator };
    case "voice":
      return { form: "voice", transcript: p.content, locator };
    case "quote":
      return { form: "quote", text: p.content, locator };
    case "card":
    case "proposed":
      return { form: "choice", text: p.content, locator };
  }
}

/** 用户下的删除类命令：对话里的、设置里的（删除项目时随项目删的不产生素材） */
type UserDeleteCommand = DeleteCommandPayload & { from: Exclude<DeleteCommandPayload["from"], { kind: "project_deletion" }> };

/** 忘掉、彻底删除、别推断：只记删法和条数，不含被删素材的原话（不然刚忘掉的话又进了素材库） */
function deletionPiece(p: UserDeleteCommand): MaterialPiece {
  const label = MEMORY_COMMAND_LABEL[p.command];
  const count = p.materialIds.length;
  const locator = { field: "materialIds" };
  return p.from.kind === "chat"
    ? { form: "choice", text: `${label} ${count} 条素材`, locator }
    : { form: "text", text: `${label}：${scopeLabel(p.from.scope)} 里的 ${count} 条素材`, locator };
}

/**
 * 显式记忆命令素材（来源本人：命令是用户下的）。对话里删除类的命令是秘书检索出来、用户核对确认的（用户的选择，注明 agent 先提出）；
 * 设置里是用户自己选的范围
 */
export const memoryCommandSource: MaterialSource = {
  name: "memory-command",
  eventType: EVENT_TYPES.memoryCommand,
  capture(event) {
    const p = event.payload as MemoryCommandEventPayload;
    // 删除项目时随项目彻底删掉的内部记录（66 号票）：不是用户下的记忆命令，不产生素材（事件本身就是"这些被删了"的记录）
    if (p.command !== "remember" && p.from.kind === "project_deletion") return [];
    const piece = p.command === "remember" ? rememberPiece(p) : deletionPiece(p as UserDeleteCommand);
    const chat = p.from.kind === "chat" ? p.from : undefined;
    return [
      {
        kind: "memory_command",
        source: "self",
        ...(chat ? { conversation: chat.conversation } : {}),
        context: [`command:${p.command}`, chat ? conversationKind(chat.conversation) : "settings"],
        segments: segmentPieces([piece]),
        ref: { recordId: p.commandId, ...(chat ? { cardId: chat.cardId } : {}) },
      },
    ];
  },
};

/** 彻底删除"记住"过的内容：命令事件只换掉内容，命令 id、来源、出处不变。删除类的命令不会被改写（记忆模块不把它当目标） */
export const rememberCommandPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.memoryCommand,
  rewrite(event) {
    const p = event.payload as MemoryCommandEventPayload;
    if (p.command !== "remember") throw new Error(`删除类的记忆命令（${p.command}）不改写：它是"这些素材被删了"的记录`);
    return { ...p, content: PURGED_TEXT } satisfies RememberCommandPayload;
  },
};
