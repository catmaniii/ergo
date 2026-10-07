// 密钥形态：底线"把凭据写进对外内容固定为永不"用它检查对外内容。
// 05 号票的 v1 模板"对外内容不许含密钥"也用这一套、同一个取内容的口径（outboundTextOf），两处说法保持一致。
// 只认形态，不认真假：宁可把像密钥的东西拦下，也不放过真的。
import { isUnknown } from "./planguard/expr.ts";
import { argEntriesOf, type ToolDescriptor } from "./tool-registry.ts";

export interface SecretPattern {
  id: string;
  title: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  // OpenAI、Anthropic、DeepSeek 等 sk- 开头的 key
  { id: "sk_key", title: "sk- 开头的 API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "github_token", title: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: "github_pat", title: "GitHub 细粒度 token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: "aws_access_key", title: "AWS 访问密钥", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "google_api_key", title: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "slack_token", title: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "stripe_key", title: "Stripe 密钥", pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { id: "private_key", title: "私钥", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { id: "jwt", title: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    id: "assigned_secret",
    title: "赋值形式的密码或密钥",
    pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?[^\s"']{12,}/i,
  },
]);

/** 找出文本里的密钥形态（每种最多报一次） */
export function findSecretShapes(text: string): SecretPattern[] {
  return SECRET_PATTERNS.filter((p) => p.pattern.test(text));
}

/** 要发出去的内容：对外内容、收件人、网址类参数；从 bash 拆出的再加上那段命令原文 */
export function outboundTextOf(tool: ToolDescriptor, args: Readonly<Record<string, unknown>>, text: string | undefined): string {
  const parts = argEntriesOf(tool, args, ["content", "recipient", "url"]).map(([, v]) => textOf(v));
  if (text) parts.push(text);
  return parts.join("\n");
}

/** 参数值当文字看：字符串原样，"未知"取它的原文，别的转成 JSON */
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (isUnknown(v)) return v.desc === null || v.desc === undefined ? "" : textOf(v.desc);
  return JSON.stringify(v) ?? "";
}
