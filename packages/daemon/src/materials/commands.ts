// 显式记忆命令（规格第 14、15 节，21 号票）在素材模块这一侧。memory_command 事件有两个作用：
// - 它是"显式记忆命令"素材的来源（每条命令一条：记住、忘掉、彻底删除、别推断都算；删除项目时随项目彻底删除的不算——
//   那不是用户下的记忆命令，66 号票）；
// - 它是删除（忘掉、彻底删除）和标记（别推断）素材的依据。materials.db 是派生的（ADR-0006），
//   所以删除也记在事件日志里，删掉 materials.db 重建、从原文副本补回时照样删掉、照样标上。
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
  t,
} from "@ergo/protocol";
import type { PurgeRewriter } from "../events/purge.ts";
import type { MaterialSource } from "./capture.ts";
import { type MaterialPiece, segmentPieces } from "./segments.ts";
import { conversationKind } from "./sources.ts";

/** 记忆命令事件所在的频道：守护进程内部的素材频道（前端不订阅） */
export const MATERIALS_CHANNEL = "materials";

/** "显式记忆命令"这种素材来源的名字：素材 id 由它和事件算出来，改了就换 id。按原话记一条（337）也用它认刚采到的那条 */
export const MEMORY_COMMAND_SOURCE = "memory-command";

/** 这条命令对已有素材的作用：忘掉哪些（含彻底删除）、标记哪些不参与推断；purge 表示是彻底删除 */
export function commandEffect(payload: MemoryCommandEventPayload): { forget: readonly string[]; noInfer: readonly string[]; purge: boolean } {
  if (payload.command === "remember") return { forget: [], noInfer: [], purge: false };
  if (payload.command === "no_infer") return { forget: [], noInfer: payload.materialIds, purge: false };
  return { forget: payload.materialIds, noInfer: [], purge: payload.command === "purge" };
}

/** 时间写到分钟："2026-10-01 00:00" */
const minuteOf = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** 范围的说法（素材里、卡片上用）："会话 secretary"、"2026-10-01 00:00 到 2026-10-07 23:59"、"设置里点开看过的这一条素材"（158 号票） */
export function scopeLabel(scope: MaterialScope): string {
  if (scope.kind === "conversation") return t("materials.scope.conversation", { conversation: scope.conversation });
  if (scope.kind === "material") return t("materials.scope.material");
  return t("materials.scope.range", { from: minuteOf(scope.from), to: minuteOf(scope.to) });
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

/** 用户下的删除类命令：对话里的、设置里的、记忆管理员按用户的话下的（242 号票；删除项目、删除任务、断开数据源连数据删时随着删的不产生素材） */
type UserDeleteCommand = DeleteCommandPayload & { from: Exclude<DeleteCommandPayload["from"], { kind: "project_deletion" } | { kind: "task_deletion" } | { kind: "data_source" }> };

/** 忘掉、彻底删除、别推断：只记删法和条数，不含被删素材的原话（不然刚忘掉的话又进了素材库） */
function deletionPiece(p: UserDeleteCommand): MaterialPiece {
  const label = MEMORY_COMMAND_LABEL[p.command];
  const count = p.materialIds.length;
  const locator = { field: "materialIds" };
  // 242 号票：记忆管理员按用户的话下的命令（没有卡片，记下是哪个会话）
  if (p.from.kind === "curator") return { form: "choice", text: t("materials.deletion.curator", { command: label, count, n: count }), locator };
  // 281 号票：删个人档案里的东西时用户选了连出处一起删（档案页上亲手选的）
  if (p.from.kind === "personal_file") return { form: "text", text: t("materials.deletion.personalFile", { command: label, count, n: count }), locator };
  return p.from.kind === "chat"
    ? { form: "choice", text: t("materials.deletion.chat", { command: label, count, n: count }), locator }
    : {
        form: "text",
        text:
          p.from.scope.kind === "material"
            ? t("materials.deletion.one", { command: label, scope: scopeLabel(p.from.scope) })
            : t("materials.deletion.scope", { command: label, scope: scopeLabel(p.from.scope), count, n: count }),
        locator,
      };
}

/**
 * 显式记忆命令素材（来源本人：命令是用户下的）。对话里删除类的命令是秘书检索出来、用户核对确认的（用户的选择，注明 agent 先提出）；
 * 设置里是用户自己选的范围
 */
export const memoryCommandSource: MaterialSource = {
  name: MEMORY_COMMAND_SOURCE,
  eventType: EVENT_TYPES.memoryCommand,
  capture(event) {
    const p = event.payload as MemoryCommandEventPayload;
    // 删除项目时随项目彻底删掉的内部记录（66 号票）、删除任务时随任务删掉的系统记录（186 号票）、断开数据源时连已导入的一起删的
    // （295 号票：数据源导入的记录采成的素材）：不是用户下的记忆命令，不产生素材（事件本身就是"这些被删了"的记录）
    if (p.command !== "remember" && (p.from.kind === "project_deletion" || p.from.kind === "task_deletion" || p.from.kind === "data_source")) return [];
    const piece = p.command === "remember" ? rememberPiece(p) : deletionPiece(p as UserDeleteCommand);
    const chat = p.from.kind === "chat" ? p.from : undefined;
    // 337 号票：秘书按用户的话记的（没有卡片、没有快速动作），记下那个会话，并把原话来自哪条消息写进出处（检索、删除都靠它）
    const secretary = p.command === "remember" && p.from.kind === "secretary" ? p.from : undefined;
    // 242 号票：记忆管理员在它的会话里下的命令也算用户下的（用户是让它做的），记下那个会话
    const curator = p.command !== "remember" && p.from.kind === "curator" ? p.from : undefined;
    const conversation = chat?.conversation ?? secretary?.conversation ?? curator?.conversation;
    return [
      {
        kind: "memory_command",
        source: "self",
        ...(conversation === undefined ? {} : { conversation }),
        context: [`command:${p.command}`, conversation === undefined ? "settings" : conversationKind(conversation)],
        segments: segmentPieces([piece]),
        ref: { recordId: p.commandId, ...(chat ? { cardId: chat.cardId } : {}), ...(secretary?.inputMessageId === undefined ? {} : { messageId: secretary.inputMessageId }) },
      },
    ];
  },
};

/** 彻底删除"记住"过的内容：命令事件只换掉内容，命令 id、来源、出处不变。删除类的命令不会被改写（记忆模块不把它当目标） */
export const rememberCommandPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.memoryCommand,
  rewrite(event) {
    const p = event.payload as MemoryCommandEventPayload;
    if (p.command !== "remember") throw new Error(`删除类的记忆命令（${p.command}）不改写：它是"这些素材被删了"的记录`); // @i18n-ignore log：编程错误
    return { ...p, content: PURGED_TEXT } satisfies RememberCommandPayload;
  },
};
