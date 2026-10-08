// 显式记忆命令（规格第 14、15 节，21 号票）：快速动作的第一种。登记进快速动作的执行器注册表：
// - 记住（remember）：用户说"记住……"，内容作为"显式记忆命令"素材入库。"点明了"的判定：用户这条消息里（打的字或语音转写）
//   有"记住"一类的触发词，前面没有否定词，而且提议的内容和触发词后面到句末的那一段（去掉标点和空白）一致；那一段只是"这个""这段"之类的指代时，
//   内容要和用户的引用块或引用的卡片一致。点明了直接执行，秘书推断出来的一律先问。来源按内容从哪里来标（REMEMBER_SOURCES）。
//   第一阶段不产出任何记忆；
// - 忘掉（forget）、彻底删除（purge）、别推断（no_infer）：秘书先用素材检索工具找出匹配的素材，再提议；
//   总要过一张记忆删除卡由用户核对（可以去掉几条、换一种删法），确认后执行（deletion.ts）：
//   - 忘掉：素材及其原文副本从 memory.db 删除，聊天记录里仍看得到原话；
//   - 彻底删除：再改写事件日志里的原始事件和带原话的记录，会话文件里的原文由秘书跟着改（purge.ts、messages_purged）；
//   - 别推断：素材和索引保留，标上"不参与推断"。
// 每条命令都是素材频道上的一条 memory_command 事件：素材模块据此产生"显式记忆命令"素材、删除或标记素材（ADR-0006），
// 和操作记录、卡片更新在同一事务里。
import {
  MAX_MEMORY_DELETE_MATERIALS,
  MEMORY_COMMAND_LABEL,
  MEMORY_DELETE_MODE_INFO,
  MEMORY_DELETE_MODES,
  type MemoryDeleteCardPayload,
  MemoryDeleteCardPayload as MemoryDeleteCardPayloadSchema,
  MemoryDeleteInput,
  type MemoryDeleteMatch,
  type MemoryDeleteMode,
  type RememberCommandPayload,
  Type,
} from "@ergou/protocol";
import { defineCardType, type CardActionEffect } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import { type Material, MATERIAL_KIND_LABEL, type Materials } from "../materials/index.ts";
import {
  actionContext,
  bareText,
  commandTails,
  defineQuickAction,
  type ExplicitFinding,
  type QuickActionContext,
  type QuickActionExecutor,
  type QuickActionService,
  type UserTurn,
} from "../quick-actions/index.ts";
import { deletionEvents, memoryCommandEvent } from "./deletion.ts";
import type { PurgeDeps } from "./purge.ts";

/** 卡片上、检索结果里摘录的长度 */
const EXCERPT_CHARS = 60;

/** "记住"的触发词 */
export const REMEMBER_TRIGGERS: readonly string[] = ["记住", "记下来", "记下", "记一下"];

/** 触发词后面只是指代（"记住这个"），内容在引用块或引用的卡片里 */
const DEICTIC = new Set(["", "这个", "这条", "这段", "这句", "这句话", "这些", "下面这段", "下面的", "以下", "以下内容", "它", "引用的", "引用的内容", "卡片上的", "这张卡"]);

export interface MemoryCommandsOptions extends PurgeDeps {
  materials: Materials;
}

/** 素材的摘录：本人的话，加上引用的说明（附件的文件名、卡片的标题）；太长截断 */
export function excerptOf(material: Material, max = EXCERPT_CHARS): string {
  const text = material.segments
    .map((s) => (s.source === "self" ? s.text : s.label))
    .filter((t): t is string => t !== undefined && t.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * "记住"点明了没有：触发词（前面没有否定词）后面到句末的那一段和内容一致 → 用户自己打的字或语音转写（按那一段是哪个）；
 * 那一段只是指代时，内容和某个引用块一致 → 引用块，和引用的卡片上的一段文字一致 → 引用的卡片
 */
export function rememberExplicit(content: string, turn: UserTurn): ExplicitFinding | undefined {
  const wanted = bareText(content);
  if (wanted === "") return undefined;
  for (const tail of commandTails(turn, REMEMBER_TRIGGERS)) {
    const said = bareText(tail.text);
    if (said === wanted) return { source: tail.source };
    if (!DEICTIC.has(said)) continue;
    if (turn.quotes.some((q) => bareText(q) === wanted)) return { source: "quote" };
    if (turn.cards.some((texts) => texts.some((t) => bareText(t) === wanted))) return { source: "card" };
  }
  return undefined;
}

/** 对话里的命令从哪里来 */
function chatOrigin(context: QuickActionContext): RememberCommandPayload["from"] {
  return {
    kind: "chat",
    conversation: context.conversation,
    actionId: context.actionId,
    cardId: context.cardId,
    ...(context.inputMessageId === undefined ? {} : { inputMessageId: context.inputMessageId }),
  };
}

/** 记忆命令的四个执行器（登记进快速动作的执行器注册表） */
export function memoryCommandExecutors(options: MemoryCommandsOptions): QuickActionExecutor[] {
  const { materials } = options;

  const remember = defineQuickAction({
    type: "remember",
    title: MEMORY_COMMAND_LABEL.remember,
    usage: "用户说\"记住……\"",
    params: Type.Object({ content: Type.String({ minLength: 1, description: "要记住的那句话：照抄用户说的原话（\"记住\"后面的那一段）" }) }, { additionalProperties: false }),
    // 记住只写素材库，不落入任何内置类别；但推断出来的不是用户的命令，一律先问
    watch: { categories: [] },
    confirm: "ask_when_inferred",
    normalize({ content }) {
      const text = content.trim();
      if (!text) throw new Error("content 不能是空的：要记住的那句话（照抄用户的原话）");
      return { params: { content: text }, title: `${MEMORY_COMMAND_LABEL.remember}：${text}`, content: text };
    },
    explicit: (action, turn) => rememberExplicit(action.content ?? "", turn),
    execute(params, context) {
      const { content } = params as { content: string };
      return {
        events: [memoryCommandEvent({ command: "remember", content, source: context.explicit?.source ?? "proposed", from: chatOrigin(context) })],
        summary: "已作为显式记忆命令存进素材库",
      };
    },
  });

  /** 卡片上要列出的、还在素材库里的素材；不在的说明原因 */
  const existing = (ids: readonly string[]): Material[] => {
    const unique = [...new Set(ids)];
    const found = unique.map((id) => materials.get(id));
    const missing = unique.filter((_, i) => !found[i]);
    if (missing.length > 0) throw new Error(`素材库里没有这些素材：${missing.join("、")}（可能已经删过了；用 search_materials 重新检索）`);
    return found as Material[];
  };

  const deletion = (mode: MemoryDeleteMode): QuickActionExecutor => {
    const label = MEMORY_COMMAND_LABEL[mode];
    return defineQuickAction({
      type: mode,
      title: label,
      usage: MEMORY_DELETE_MODE_INFO[mode].usage,
      params: Type.Object(
        {
          materialIds: Type.Array(Type.String(), {
            minItems: 1,
            maxItems: MAX_MEMORY_DELETE_MATERIALS,
            description: `用 search_materials 检索到的、匹配的素材 id（mat- 开头），一次最多 ${MAX_MEMORY_DELETE_MATERIALS} 条`,
          }),
        },
        { additionalProperties: false },
      ),
      // 要删哪些素材是秘书检索出来的、不是用户点明的：总要过一张记忆删除卡由用户核对
      watch: { categories: [] },
      confirm: "always",
      normalize({ materialIds }) {
        const found = existing(materialIds);
        return { params: { materialIds: found.map((m) => m.id) }, title: `${label} ${found.length} 条素材` };
      },
      proposalCard(action, context) {
        const { materialIds } = action.params as { materialIds: string[] };
        const payload: MemoryDeleteCardPayload = {
          actionId: context.actionId,
          conversation: context.conversation,
          ...(context.inputMessageId === undefined ? {} : { inputMessageId: context.inputMessageId }),
          mode,
          matches: materialIds.flatMap((id) => {
            const m = materials.get(id);
            return m ? [matchOf(m)] : [];
          }),
        };
        return { type: "memory_delete", payload, inboxTitle: `核对要${label}的记忆（${materialIds.length} 条）` };
      },
      execute(params, context) {
        const found = (params as { materialIds: string[] }).materialIds.flatMap((id) => {
          const m = materials.get(id);
          return m ? [m] : [];
        });
        if (found.length === 0) throw new RequestRejected("not_allowed", "要处理的素材都已经不在素材库里了（可能已经删过）");
        const { events, purge } = deletionEvents(options, { mode, materials: found, from: chatOrigin(context), exceptCard: context.cardId });
        return { events, summary: `已${MEMORY_DELETE_MODE_INFO[mode].done} ${found.length} 条素材`, ...(purge.length === 0 ? {} : { purge }) };
      },
    });
  };

  return [remember, ...MEMORY_DELETE_MODES.map(deletion)];
}

/** 卡片上的一条匹配到的素材 */
function matchOf(material: Material): MemoryDeleteMatch {
  return {
    materialId: material.id,
    kind: MATERIAL_KIND_LABEL[material.kind],
    time: material.time,
    ...(material.conversation === null ? {} : { conversation: material.conversation }),
    excerpt: excerptOf(material),
  };
}

/**
 * 记忆删除卡：列出匹配到的素材和要执行的删除方式，用户核对后执行（delete，输入是删法和要删的那几条，只能是卡上列出的），
 * 或者不删了（cancel）。纯文本降级只写删法和条数，不带摘录。彻底删除之后，卡片上被删素材的摘录随之去掉（旧版本一起改写）。
 */
export function memoryDeleteCardType(service: QuickActionService) {
  return defineCardType({
    type: "memory_delete",
    version: 1,
    payload: MemoryDeleteCardPayloadSchema,
    actions: {
      delete: {
        input: MemoryDeleteInput,
        run: ({ card, payload, input }): CardActionEffect<MemoryDeleteCardPayload> => {
          const listed = new Set(payload.matches.map((m) => m.materialId));
          const strangers = input.materialIds.filter((id) => !listed.has(id));
          if (strangers.length > 0) throw new RequestRejected("bad_params", `只能删卡上列出的素材，这些不在卡上：${strangers.join("、")}`);
          const executor = service.registry.get(input.mode);
          if (!executor) throw new RequestRejected("not_allowed", `这种删法（${input.mode}）这个版本不认识`);
          const outcome = service.execute(executor, { materialIds: input.materialIds }, actionContext(card, payload), `${MEMORY_COMMAND_LABEL[input.mode]} ${input.materialIds.length} 条素材`);
          const purged = input.mode === "purge" ? new Set(input.materialIds) : new Set<string>();
          const next: MemoryDeleteCardPayload = { ...purgedMatches(payload, purged), result: { mode: input.mode, count: input.materialIds.length } };
          return { status: "handled", payload: next, events: outcome.events, note: outcome.summary, ...(outcome.purge === undefined ? {} : { purge: outcome.purge }) };
        },
      },
      cancel: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) =>
      p.result === undefined
        ? `记忆删除：${MEMORY_COMMAND_LABEL[p.mode]} ${p.matches.length} 条素材（待核对）`
        : `记忆删除：已${MEMORY_COMMAND_LABEL[p.result.mode]} ${p.result.count} 条素材`,
    // 彻底删除：被删素材的摘录去掉
    purge: (p, context) => purgedMatches(p, context.materialIds),
  });
}

/** 去掉被彻底删除的素材的摘录 */
function purgedMatches(payload: MemoryDeleteCardPayload, purged: ReadonlySet<string>): MemoryDeleteCardPayload {
  return { ...payload, matches: payload.matches.map((m) => (purged.has(m.materialId) ? { ...m, excerpt: "", purged: true } : m)) };
}
