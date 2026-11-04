// 判"回的是什么"的模型请求：会话里用户说的几句话，各自是接着对方前面的话说的、还是自己开的新话题；接着说的，
// 一两句话写出前文的意思（谁说的、问了什么 / 提议了什么 / 汇报了什么，不抄全文、有长度上限）。
// 每晚整理之前批量判（二狗那边的 daemon/src/memory/reply-context.ts 挑素材、找前文、记结果）；
// 一批一次请求，模型判不了的那几条（没交、字段不对）不算判过，留到下一夜。
import type { ChatModel, ChatRequest } from "./chat.ts";
import { parseModelJson } from "./json.ts";

/** 一批最多几句 */
export const REPLY_CONTEXT_BATCH = 10;
/** 前文总结最多多少字（同二狗素材上的上限） */
export const REPLY_CONTEXT_SUMMARY_MAX = 80;
/** 交给模型的前文、用户这句各最多多少字（前文留结尾：问的、提议的多在最后） */
export const REPLY_CONTEXT_BEFORE_CHARS = 600;
export const REPLY_CONTEXT_USER_CHARS = 300;
/** 每句估的输出 token */
const OUTPUT_PER_ITEM = 120;

/** 要判的一句：编号（这一批里的）、前文是谁说的（"秘书""负责人""记忆管理员""通知""卡片"）、前文原话、用户这句 */
export interface ReplyContextInput {
  id: string;
  by: string;
  before: string;
  user: string;
}

/** 判出来的一句：在接着回（带前文意思的总结）还是新话题 */
export type ReplyContextJudgment = { id: string; reply: true; summary: string } | { id: string; reply: false };

export const REPLY_CONTEXT_SYSTEM = `你是二狗的记忆管理员，每晚整理记忆之前判一件事：用户在会话里说的这几句话，各自是在接着回对方前面说的话，还是自己开了一个新话题。每条给你对方前面说的（谁说的、原话）和用户这句。规则：
- 用户这句在回应、接着前文（回答问题、答应或拒绝提议、对汇报表态、顺着前文补充或追问，包括"好""就这么办""不用"这类单看没信息的）：reply 写 true；summary 用一两句话写出前文的意思——谁说的（照给你的说法写：秘书、负责人、记忆管理员、通知、卡片）、问了什么 / 提议了什么 / 汇报了什么；只写意思、不抄原文，不超过 ${REPLY_CONTEXT_SUMMARY_MAX} 个字，不写用户怎么回的；
- 用户这句自己开了新话题、和前文无关：reply 写 false，不写 summary；隔了多久不要紧，只看内容；
- 只根据给你的话，不编造，不揣测用户的动机；前文里说用户怎样，写成"秘书说……"，不要写成用户的事；
只输出 JSON：{"items": [{"id": "r1", "reply": true, "summary": "秘书问周六要不要一起去爬山"}, {"id": "r2", "reply": false}]}`;

/** 太长的截断：前文留结尾，用户这句留开头 */
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(text.length - max)}` : text);
const head = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 一批的请求（预计费用也用它算） */
export function replyContextRequest(items: readonly ReplyContextInput[]): ChatRequest {
  const lines = items.map((item) => JSON.stringify({ id: item.id, before: { by: item.by, text: tail(item.before.trim(), REPLY_CONTEXT_BEFORE_CHARS) }, user: head(item.user.trim(), REPLY_CONTEXT_USER_CHARS) }));
  return { purpose: "reply_context", system: REPLY_CONTEXT_SYSTEM, user: `要判的话（每行一条）：\n${lines.join("\n")}`, maxTokens: 200 + OUTPUT_PER_ITEM * items.length };
}

/** 模型交回的：只认这一批的编号、reply 是布尔、在接着回的要有总结（超长截到上限）；判不了的不在结果里 */
export function parseReplyContexts(content: string, ids: readonly string[]): ReplyContextJudgment[] {
  const parsed = parseModelJson(content);
  const known = new Set(ids);
  const seen = new Set<string>();
  const out: ReplyContextJudgment[] = [];
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!known.has(id) || seen.has(id) || typeof r.reply !== "boolean") continue;
    if (!r.reply) {
      seen.add(id);
      out.push({ id, reply: false });
      continue;
    }
    const summary = typeof r.summary === "string" ? r.summary.replace(/\s+/g, " ").trim() : "";
    if (summary.length === 0) continue;
    seen.add(id);
    out.push({ id, reply: true, summary: [...summary].length > REPLY_CONTEXT_SUMMARY_MAX ? `${[...summary].slice(0, REPLY_CONTEXT_SUMMARY_MAX - 1).join("")}…` : summary });
  }
  return out;
}

/** 判一批（一次请求）：解析不了、出错的整批交回空（不算判过，下一夜再判） */
export async function judgeReplyContexts(model: ChatModel, items: readonly ReplyContextInput[]): Promise<{ judgments: ReplyContextJudgment[]; error?: string }> {
  if (items.length === 0) return { judgments: [] };
  try {
    const response = await model.complete(replyContextRequest(items));
    return { judgments: parseReplyContexts(response.content, items.map((item) => item.id)) };
  } catch (err) {
    // 中止（守护进程停止、超时）照样往上抛：调用方据此停下
    if ((err as { name?: unknown } | undefined)?.name === "AbortError") throw err;
    return { judgments: [], error: err instanceof Error ? err.message : String(err) };
  }
}
