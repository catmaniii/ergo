// 对外内容里的密钥：底线"把凭据写进对外内容固定为永不"用它检查对外内容。
// 05 号票的 v1 模板"对外内容不许含密钥"也用这一套、同一个取内容的口径（outboundTextOf），两处说法保持一致。
// 两种认法：
// - 密钥形态（SECRET_PATTERNS）：只认形态，不认真假：宁可把像密钥的东西拦下，也不放过真的；
// - 读过的密钥值（30 号票）：agent 读过的 .env 和密钥文件里的值由守护进程收在内存里，作为环境事实 secretValues 交进来
//   （guard-runtime/read-secrets.ts），出现在对外内容里（原样、URL 编码、base64）就算——没有前缀的随机串正则认不出，靠它。
// 对外内容是会联网的工具除路径以外的全部参数（GET 的网址、查询串、网址里的用户信息、请求头和请求体、联网命令的其他参数），
// 不管之前读没读过密钥。
// 剩余风险：密钥被拆开拼接、自定义变形（倒序、换字符集、嵌进更长的 base64 里错开对齐……）之后正则和读过的值都认不出；
// 守护进程重启后读过的值就丢了（"读过之后不许往外送"的规则照旧）。
import { t } from "@ergo/protocol";
import { isUnknown } from "./planguard/expr.ts";
import { argEntriesOf, usesNetwork, type ToolDescriptor } from "./tool-registry.ts";

export interface SecretPattern {
  id: string;
  title: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  // OpenAI、Anthropic、DeepSeek 等 sk- 开头的 key
  { id: "sk_key", get title() { return t("guard.secrets.sk_key"); }, pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "github_token", get title() { return t("guard.secrets.github_token"); }, pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: "github_pat", get title() { return t("guard.secrets.github_pat"); }, pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: "aws_access_key", get title() { return t("guard.secrets.aws_access_key"); }, pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "google_api_key", get title() { return t("guard.secrets.google_api_key"); }, pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "slack_token", get title() { return t("guard.secrets.slack_token"); }, pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "stripe_key", get title() { return t("guard.secrets.stripe_key"); }, pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { id: "private_key", get title() { return t("guard.secrets.private_key"); }, pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { id: "jwt", get title() { return t("guard.secrets.jwt"); }, pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // 网址里的凭据：`https://用户名:密码@host`，或者像令牌的一长串（20 位以上、字母数字都有）`@host`；
  // `ssh://git@host`、纯字母的用户名不算
  {
    id: "url_credentials",
    get title() {
      return t("guard.secrets.url_credentials");
    },
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@:]*:[^\s/?#@]+|(?=[A-Za-z0-9._~-]*\d)(?=[A-Za-z0-9._~-]*[A-Za-z])[A-Za-z0-9._~-]{20,})@/i,
  },
  {
    id: "assigned_secret",
    get title() {
      return t("guard.secrets.assigned_secret");
    },
    pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?[^\s"']{12,}/i,
  },
]);

/** 读过的密钥值出现在对外内容里时，说明里怎么称呼它（不带值本身） */
export const readSecretTitle = () => t("guard.secrets.readValue");

/** 找出文本里的密钥形态（每种最多报一次） */
export function findSecretShapes(text: string): SecretPattern[] {
  return SECRET_PATTERNS.filter((p) => p.pattern.test(text));
}

/** 要发出去的内容里的密钥：密钥形态的名字，出现了读过的密钥值时再加 READ_SECRET_TITLE（说明里不带值本身） */
export function secretsIn(text: string, readValues: readonly string[] = []): string[] {
  const titles = findSecretShapes(text).map((s) => s.title);
  if (containsReadSecret(text, readValues)) titles.push(readSecretTitle());
  return titles;
}

/**
 * 读过的密钥值有没有出现在文本里：原样、URL 编码（%xx，表单里空格写成 +）、base64（标准和网址安全两种，不管补位），
 * 去掉空白之后也比（多行的私钥）
 */
export function containsReadSecret(text: string, values: readonly string[]): boolean {
  if (values.length === 0 || text === "") return false;
  const decoded = [text, percentDecoded(text), percentDecoded(text.replaceAll("+", " "))];
  const haystacks = [...new Set(decoded.flatMap((h) => [h, h.replace(/\s+/g, "")]))];
  return values.some((value) => needlesOf(value).some((needle) => haystacks.some((h) => h.includes(needle))));
}

/** 擦掉读过的密钥值时换成的字 */
export const REDACTED_SECRET = "（密钥）"; // @i18n-ignore data：擦掉密钥值时换进记录里的标记（记录的内容不翻）

/**
 * 把文本里读过的密钥值擦掉（换成 REDACTED_SECRET）：原样、base64（标准和网址安全两种，不管补位）、URL 编码（encodeURIComponent）。
 * 守卫接入把工具调用记录、效果日志、审批、"交给我做"写进事件日志之前用它擦一遍；去掉空白才对得上的（多行的私钥原文）擦不到
 */
export function redactSecretValues(text: string, values: readonly string[]): string {
  if (values.length === 0 || text === "") return text;
  const needles = new Set<string>();
  for (const value of values) {
    for (const needle of needlesOf(value)) needles.add(needle);
    needles.add(encodeURIComponent(value));
  }
  let out = text;
  // 长的先换：一个值是另一个值的一部分时不会只擦掉一半
  for (const needle of [...needles].toSorted((a, b) => b.length - a.length)) {
    if (needle.length >= MIN_NEEDLE_LENGTH) out = out.replaceAll(needle, REDACTED_SECRET);
  }
  return out;
}

/** 太短的写法不擦（base64 去掉补位后可能只剩几个字符，会误伤） */
const MIN_NEEDLE_LENGTH = 8;

/** 名字看着是密钥的环境变量、参数（登记里写明文、秘书带参调用的脱敏都用它） */
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|PASSWORD|CREDENTIAL|AUTH)/i;

/**
 * 名字看着是密钥（SECRET_NAME）的参数值换成 REDACTED_SECRET，字符串里认得出的密钥形态也擦掉；对象、数组递归。
 * 240 号票：秘书带参调用 MCP 时，聊天里的工具调用摘要和卡片、事件日志里不出现它们的原值（按登记注入的凭据值由调用方先换成来路）。
 * 别的就不动：不是密钥的参数照原样留着（摘要要看得懂发生了什么）
 */
export function maskSecretArgValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecretArgValues);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_NAME.test(k) ? REDACTED_SECRET : maskSecretArgValues(v)]));
  }
  return typeof value === "string" ? redactSecretShapes(value) : value;
}

/** 私钥整块：从 BEGIN 到 END（没有 END 的擦到末尾）；SECRET_PATTERNS 里的 private_key 只认开头那一行 */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g;

/** 一种密钥形态擦成什么：默认整段换掉；赋值形式的留下名字，网址里的留下协议和 @ */
const SHAPE_REPLACERS: Readonly<Record<string, (match: string) => string>> = {
  // 名字、等号（冒号）和引号留下，后面的值擦掉
  assigned_secret: (m) => m.replace(/^([^:=]*[:=]\s*["']?)[\s\S]*$/, `$1${REDACTED_SECRET}`),
  url_credentials: (m) => m.replace(/^([a-z][a-z0-9+.-]*:\/\/)[\s\S]*@$/i, `$1${REDACTED_SECRET}@`),
};

/**
 * 把文本里认得出的密钥形态（SECRET_PATTERNS）擦掉，换成 REDACTED_SECRET。工具调用记录的摘要、完整参数和返回（53 号票）、
 * 效果日志、审批这些写进事件日志之前和读过的值一起擦（read-secrets.ts 的 CallPrivacy），比如 bash 输出里的 token。
 * 和底线检查同一套形态：宁可多擦（像密钥的都擦），擦不到的是正则认不出的（没有前缀的随机串靠读过的值）
 */
export function redactSecretShapes(text: string): string {
  if (text === "") return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED_SECRET);
  for (const { id, pattern } of SECRET_PATTERNS) {
    if (id === "private_key") continue;
    const replace = SHAPE_REPLACERS[id] ?? (() => REDACTED_SECRET);
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), replace);
  }
  return out;
}

/** 一个值要找的几种写法 */
function needlesOf(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  const out = new Set<string>();
  for (const v of [value, compact]) {
    if (v === "") continue;
    out.add(v);
    const base64 = Buffer.from(v, "utf8").toString("base64").replace(/=+$/, "");
    out.add(base64);
    out.add(base64.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...out];
}

/** 把文本里的 %xx 解开（解不开的原样留着） */
function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/**
 * 要发出去的内容：会联网的工具（tool-registry.ts 的 usesNetwork，不管往外送还是往下拉），除路径参数以外的全部登记过的参数——
 * 对外内容、收件人、网址（GET 的也算，含查询串和网址里的用户信息）、联网命令的其他参数（推送的远端、要装的包……），
 * 数组参数逐个算；从 bash 拆出的再加上那段命令原文（请求头、请求体都在里面）。不联网的工具没有对外内容。
 */
export function outboundTextOf(tool: ToolDescriptor, args: Readonly<Record<string, unknown>>, text: string | undefined): string {
  if (!usesNetwork(tool)) return "";
  const parts = argEntriesOf(tool, args, { except: ["path"] }).map(([, v]) => textOf(v));
  if (text) parts.push(text);
  return parts.join("\n");
}

/** 参数值当文字看：字符串原样，"未知"取它的原文，别的转成 JSON */
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (isUnknown(v)) return v.desc === null || v.desc === undefined ? "" : textOf(v.desc);
  return JSON.stringify(v) ?? "";
}
