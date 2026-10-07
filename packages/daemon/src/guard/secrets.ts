// 密钥形态：底线"把凭据写进对外内容固定为永不"用它检查对外内容。
// 05 号票的 v1 模板"对外内容不许含密钥"也用这一套、同一个取内容的口径（outboundTextOf），两处说法保持一致。
// 只认形态，不认真假：宁可把像密钥的东西拦下，也不放过真的。
// 30 号票起"对外内容"扩展到 GET 的网址（含查询串、网址里的用户信息）和联网命令的参数，不管之前读没读过密钥。
// 剩余风险：密钥被编码或变形（base64、拆开拼接……）之后再放进网址或参数，正则认不出。
import { isUnknown } from "./planguard/expr.ts";
import { sendsOut, type ToolDescriptor } from "./tool-registry.ts";

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
  // 网址里的凭据：`https://用户名:密码@host`、`https://<一长串 token>@host`
  { id: "url_credentials", title: "网址里的密码或 token", pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@:]*:[^\s/?#@]+|[A-Za-z0-9._~-]{20,})@/i },
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

/**
 * 要发出去的内容：会联网发东西的工具（tool-registry.ts 的 sendsOut：联网的、会把内容发出去的、带"以我的名义对外发送"标签的），
 * 除路径参数以外的全部参数——对外内容、收件人、网址（GET 的也算，含查询串和网址里的用户信息）、联网命令的其他参数
 * （推送的远端、要装的包……），数组参数逐个算；从 bash 拆出的再加上那段命令原文。不联网发东西的工具没有对外内容。
 */
export function outboundTextOf(tool: ToolDescriptor, args: Readonly<Record<string, unknown>>, text: string | undefined): string {
  if (!sendsOut(tool)) return "";
  const parts: string[] = [];
  for (const [name, v] of Object.entries(args)) {
    if (tool.args[name]?.kind === "path" || v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) parts.push(textOf(x));
  }
  if (text) parts.push(text);
  return parts.join("\n");
}

/** 参数值当文字看：字符串原样，"未知"取它的原文，别的转成 JSON */
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (isUnknown(v)) return v.desc === null || v.desc === undefined ? "" : textOf(v.desc);
  return JSON.stringify(v) ?? "";
}
