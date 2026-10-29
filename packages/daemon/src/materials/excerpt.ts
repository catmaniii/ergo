// 素材的摘录：记忆删除卡、秘书的素材检索结果（21 号票），设置里的素材列表（158 号票）都用这一个。
// 158 号票从记忆插件（memory/memory-commands.ts）挪进素材库：设置里看素材是内核的（记忆插件停用时照样能看、能删）。
// 167 号票：挨着检索词的一段（snippetOf，166 号票秘书的检索结果里存的网页那一段）也挪进来：记忆 · 素材搜的时候列表里的摘录换成命中的那一段。
import { INTERVIEW_QUESTION_FIELD } from "@ergo/protocol";
import type { Material } from "./types.ts";

/** 卡片上、检索结果里摘录的长度 */
const EXCERPT_CHARS = 60;

/**
 * 素材的摘录：本人的话，加上引用的说明（附件的文件名、卡片的标题）；太长截断。
 * 访谈里管理员问的那一句（284 号票，排在用户的话前面的上下文）不进摘录：列表、检索结果里先看到的是用户自己的话
 */
export function excerptOf(material: Material, max = EXCERPT_CHARS): string {
  const text = material.segments
    .filter((s) => s.locator.field !== INTERVIEW_QUESTION_FIELD)
    .map((s) => (s.source === "self" ? s.text : s.label))
    .filter((t): t is string => t !== undefined && t.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 检索词：按空白拆开（空的不算） */
export function queryTerms(query: string): string[] {
  return query.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * 一段文字里挨着检索词的一段：从最早出现的那个检索词（不分大小写）前面留 lead 个字起，一共 chars 个字；没有检索词出现的给开头。
 * 空白压成一个空格，截掉的写省略号
 */
export function snippetOf(text: string, query: string, size: { chars: number; lead: number }): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = queryTerms(query)
    .map((t) => lower.indexOf(t.toLowerCase()))
    .filter((i) => i >= 0);
  const start = hits.length === 0 ? 0 : Math.max(0, Math.min(...hits) - size.lead);
  const end = Math.min(flat.length, start + size.chars);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
