// 效果日志里内容类参数的"长度 + 摘要哈希"（68 号票）：缩是 effect-log.ts 的 effectLogArgs，按哈希计次是 grants.ts。
// 缩过的值是 `{"$digest": {length, sha256}}`，和规则引擎的 `{"$unknown": …}` 一样是只有一个键的对象。
// 哈希的原文是授权项对象范围里的写法（scopeValueText，也放在这里：缩和计次用同一份，比哈希和比原文结果才一样）。
import { createHash } from "node:crypto";
import { isPlainObject } from "./planguard/expr.ts";

/**
 * 一个参数值在对象范围里的写法（对象范围里只有字符串）：字符串照原样，数字、真假按字面，别的按 JSON。
 * 授权项判定、计次时（grants.ts 的 valueCovered）、流程推授权项时（workflow-steps.ts）、缩内容类参数时（摘要哈希的原文）都按它
 */
export function scopeValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export const CONTENT_DIGEST_KEY = "$digest";

export interface ContentDigest {
  /** 原文的字符数 */
  length: number;
  /** 原文（UTF-8）的 SHA-256，十六进制 */
  sha256: string;
}

export type DigestedValue = { [CONTENT_DIGEST_KEY]: ContentDigest };

export const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** 一段原文换成长度 + 摘要哈希 */
export function digestOfText(text: string): DigestedValue {
  return { [CONTENT_DIGEST_KEY]: { length: text.length, sha256: sha256Of(text) } };
}

/** 是不是缩过的值 */
export function isDigested(value: unknown): value is DigestedValue {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const d = value[CONTENT_DIGEST_KEY];
  return keys.length === 1 && keys[0] === CONTENT_DIGEST_KEY && isPlainObject(d) && typeof d.sha256 === "string" && typeof d.length === "number";
}
