// 邮件（MIME）解析（298 号票，Gmail 按需查和"导入我发出的邮件"用；不加依赖，只用 Node 自带的 Buffer 和 TextDecoder）。
// 只做读邮件要的那部分：
// - 信头：续行展开、RFC 2047 的编码字（=?charset?B/Q?…?=，相邻的几段同一字符集先拼字节再解，免得一个汉字被切成两半）、
//   没编码直接写 8 位字节的（UTF-8，不是 UTF-8 的按 GB18030 认——国内一些客户端会这样发）、地址列表（引号、尖括号、注释、组）、日期；
// - 参数：Content-Type / Content-Disposition 的参数，RFC 2231 的续段和字符集（filename*0*=UTF-8''%E8…），引号里塞编码字的（不合规但常见）；
// - 正文：multipart（嵌套、前言后记、截断了没有结束分隔线的）、base64（容忍换行和坏字符）、quoted-printable（软换行）、
//   字符集（TextDecoder：UTF-8、GBK / GB2312 / GB18030、Big5、Shift_JIS、EUC-KR、ISO-8859-*、Windows-125x……认不得的按 UTF-8）、
//   format=flowed；multipart/alternative 挑纯文本（没有才用 HTML 转的文字），mixed 里的几段正文按顺序接起来；
// - 附件：名字、类型、大约多大（base64 按长度估，不解出来），正文里嵌的图片标 inline；转发的整封邮件（message/rfc822）算一个附件。
// - 本人写的（导入我发出的邮件）：去掉回复里引的原文（stripQuoted："On … wrote:" / "… 写道：" 之后、"> " 开头的行、
//   "原始邮件"分隔线之后；HTML 里的 blockquote、gmail_quote 先去掉）——引的是别人的话，不能当本人说的。
// 解析在"每个字节一个字符"的 latin1 字符串上做（找分隔线、信头），要解码的那一段再换回字节交给 TextDecoder。
// 截断的邮件（太大只取了前一段）照样尽量解析：没结束分隔线的最后一段算到末尾，base64 末尾不完整的丢掉那几位。

/** 一个地址：显示的名字（可能没有）和邮箱 */
export interface MailAddress {
  name?: string;
  address: string;
}

/** 一个附件 */
export interface MailAttachment {
  filename: string;
  contentType: string;
  /** 大约多少字节（base64 按长度估） */
  size: number;
  /** 正文里嵌的（HTML 正文引用的图片：Content-Disposition inline 或带 Content-ID） */
  inline?: boolean;
}

/** 解析出的一封邮件 */
export interface ParsedMail {
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** Date 信头（解析不了的没有） */
  date?: Date;
  messageId?: string;
  /** 正文的纯文本（multipart/alternative 挑纯文本那份；只有 HTML 的转成文字） */
  text: string;
  /** 正文是从 HTML 转来的 */
  fromHtml: boolean;
  /** 正文的 HTML（只有 HTML、或者 alternative 里有 HTML 时；本人写的要先去掉引用再转文字） */
  html?: string;
  attachments: MailAttachment[];
}

/** 信头：小写的名字 → 原样的值（展开了续行、没解码；同名的按出现先后） */
export type RawHeaders = Map<string, string[]>;

const CRLF2 = /\r?\n\r?\n/;

/** latin1 字符串（一个字符一个字节）→ 字节 */
const bytesOf = (s: string) => Buffer.from(s, "latin1");

/** 字符集的别名：TextDecoder 认得的名字（GB2312、GBK 都按 GB18030 解：它是两者的超集） */
const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  gb2312: "gb18030",
  "gb_2312-80": "gb18030",
  gbk: "gb18030",
  "x-gbk": "gb18030",
  cp936: "gb18030",
  "euc-cn": "gb18030",
  "x-euc-cn": "gb18030",
  hz: "gb18030",
  utf8: "utf-8",
  "ks_c_5601-1987": "euc-kr",
  "x-sjis": "shift_jis",
  sjis: "shift_jis",
  "us-ascii": "utf-8",
  ascii: "utf-8",
  ansi_x3_4_1968: "utf-8",
  "iso-8859-8-i": "iso-8859-8",
  cp1252: "windows-1252",
  "x-unknown": "utf-8",
  unknown: "utf-8",
  "unknown-8bit": "utf-8",
};

interface Decoder {
  decode(input: Uint8Array): string;
}
const decoders = new Map<string, Decoder>();
/** 这个字符集的解码器（认不得的给 UTF-8） */
function decoderFor(charset: string | undefined): Decoder {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  const name = CHARSET_ALIASES[label] ?? label;
  let d: Decoder | undefined = decoders.get(name);
  if (!d) {
    try {
      d = new TextDecoder(name);
    } catch {
      d = new TextDecoder("utf-8");
    }
    decoders.set(name, d);
  }
  return d;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const GB18030 = new TextDecoder("gb18030");

/** 字节按字符集解成文字。没写字符集（或写的是 ASCII）而又有 8 位字节的：先试 UTF-8，不是就按 GB18030 */
export function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const label = charset?.trim().toLowerCase();
  if (label === undefined || label === "" || label === "us-ascii" || label === "ascii" || label === "utf-8" || label === "utf8") {
    if (!bytes.some((b) => b >= 0x80)) return Buffer.from(bytes).toString("latin1");
    try {
      return UTF8_FATAL.decode(bytes);
    } catch {
      return label === "utf-8" || label === "utf8" ? decoderFor("utf-8").decode(bytes) : GB18030.decode(bytes);
    }
  }
  return decoderFor(label).decode(bytes);
}

/** base64 → 字节（容忍换行、空白和别的坏字符；末尾不完整的几位丢掉） */
export function decodeBase64(text: string): Buffer {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  return Buffer.from(clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0)), "base64");
}

/** quoted-printable → 字节（"=" 加换行是软换行；"=XX" 是一个字节；行尾空白去掉） */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const s = text.replace(/[ \t]+(\r?\n)/g, "$1");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */) {
      const next = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(next)) {
        out.push(parseInt(next, 16));
        i += 2;
        continue;
      }
      if (s[i + 1] === "\r" && s[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (s[i + 1] === "\n") {
        i += 1;
        continue;
      }
      out.push(c);
      continue;
    }
    out.push(c & 0xff);
  }
  return Buffer.from(out);
}

/** 按传输编码解成字节 */
function decodeTransfer(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return bytesOf(body);
}

/** 信头原样的值里没编码的 8 位字节：UTF-8，不是就按 fallback（GB18030） */
function decodeRaw8bit(value: string, fallback?: string): string {
  if (!/[\x80-\xff]/.test(value)) return value;
  const bytes = bytesOf(value);
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return fallback ? decoderFor(fallback).decode(bytes) : GB18030.decode(bytes);
  }
}

/** Q 编码（编码字里的）→ 字节："_" 是空格 */
function decodeQ(text: string): Buffer {
  return decodeQuotedPrintable(text.replace(/_/g, " "));
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * RFC 2047 的编码字解成文字（原样的值可以带没编码的 8 位字节）：相邻的编码字之间只有空白的，空白去掉；
 * 同一字符集的相邻几段先把字节拼起来再解（一个汉字被切在两段里也能解对）
 */
export function decodeWords(value: string, fallbackCharset?: string): string {
  const parts: Array<{ kind: "text"; text: string } | { kind: "word"; charset: string; bytes: Buffer }> = [];
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, m.index);
    if (between.length > 0) parts.push({ kind: "text", text: between });
    const charset = m[1]!.split("*")[0]!.toLowerCase();
    const bytes = m[2]!.toUpperCase() === "B" ? decodeBase64(m[3]!) : decodeQ(m[3]!);
    parts.push({ kind: "word", charset, bytes });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push({ kind: "text", text: value.slice(last) });
  // 两个编码字之间只有空白：去掉
  const kept = parts.filter((p, i) => !(p.kind === "text" && /^[ \t\r\n]+$/.test(p.text) && parts[i - 1]?.kind === "word" && parts[i + 1]?.kind === "word"));
  let out = "";
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i]!;
    if (p.kind === "text") {
      out += decodeRaw8bit(p.text, fallbackCharset);
      continue;
    }
    const chunks = [p.bytes];
    while (kept[i + 1]?.kind === "word" && (kept[i + 1] as { charset: string }).charset === p.charset) chunks.push((kept[++i] as { bytes: Buffer }).bytes);
    out += decodeCharset(Buffer.concat(chunks), p.charset);
  }
  return out;
}

/** 信头那一段（latin1）→ 小写名字 → 原样的值（续行展开） */
export function parseHeaders(text: string): RawHeaders {
  const headers: RawHeaders = new Map();
  const lines = text.split(/\r?\n/);
  let current: { name: string; value: string } | undefined;
  const flush = () => {
    if (!current) return;
    const list = headers.get(current.name) ?? [];
    list.push(current.value.trim());
    headers.set(current.name, list);
    current = undefined;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) };
  }
  flush();
  return headers;
}

const first = (headers: RawHeaders, name: string) => headers.get(name)?.[0];

/** 按分隔符切开（引号里、尖括号里、括号里的不切） */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depthParen = 0;
  let inAngle = false;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuote) {
      if (c === "\\") i++;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === "(") depthParen++;
    else if (c === ")") depthParen = Math.max(0, depthParen - 1);
    else if (c === "<") inAngle = true;
    else if (c === ">") inAngle = false;
    else if (c === separator && depthParen === 0 && !inAngle) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** 去掉引号（处理反斜杠转义） */
function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
}

/** 地址列表（To、Cc、From 的原样的值）→ 地址；名字里的编码字解开 */
export function parseAddresses(raw: string | undefined, fallbackCharset?: string): MailAddress[] {
  if (!raw) return [];
  const out: MailAddress[] = [];
  // 组："朋友: a@x, b@y;"——把组名去掉，里面的照样拆
  const flat = raw.replace(/(^|,)\s*[^,"<>:;@]+:\s*([^;]*);/g, (_m, lead: string, inner: string) => `${lead}${inner}`);
  for (const piece of splitTopLevel(flat, ",")) {
    const text = piece.trim();
    if (text === "") continue;
    const angle = /<([^<>]*)>\s*$/.exec(text);
    let address: string;
    let name: string;
    if (angle) {
      // 名字 <a@b>：名字里的注释去掉
      address = angle[1]!;
      name = text.slice(0, angle.index).replace(/\([^()]*\)/g, "");
    } else {
      // a@b (名字)
      const comment = /\(([^()]*)\)\s*$/.exec(text);
      address = comment ? text.slice(0, comment.index) : text;
      name = comment ? comment[1]! : "";
    }
    address = decodeRaw8bit(address.replace(/^\s*mailto:/i, "").replace(/\s+/g, ""), fallbackCharset);
    const decodedName = decodeWords(unquote(name), fallbackCharset).replace(/\s+/g, " ").trim();
    if (address === "" && decodedName === "") continue;
    out.push({ ...(decodedName === "" || decodedName === address ? {} : { name: decodedName }), address });
  }
  return out;
}

/** 给人看的地址："张三 <zhang@example.com>"，没有名字只写邮箱 */
export function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Date 信头 → 时间（注释去掉；解析不了的 undefined） */
export function parseMailDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const ms = Date.parse(text);
  if (!Number.isNaN(ms)) return new Date(ms);
  // "24 Oct 2026 10:00:00 +0800" 这种 Date.parse 有时不认的：换成 ISO
  const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Z]{1,5})?/.exec(text);
  if (!m) return undefined;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(m[2]!.toLowerCase());
  if (month < 0) return undefined;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const zone = m[7] && /^[+-]\d{4}$/.test(m[7]) ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : "Z";
  const iso = `${year}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}T${m[4]!.padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}${zone}`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

/** Content-Type、Content-Disposition 这类值：主值（小写）和参数（RFC 2231 的续段、字符集，引号里的编码字都解开） */
export function parseParams(raw: string | undefined, fallbackCharset?: string): { value: string; params: Record<string, string> } {
  if (!raw) return { value: "", params: {} };
  const [head = "", ...rest] = splitTopLevel(raw, ";");
  const pieces = new Map<string, Array<{ index: number; extended: boolean; value: string }>>();
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = unquote(part.slice(eq + 1));
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!m) continue;
    const list = pieces.get(m[1]!) ?? [];
    list.push({ index: m[2] === undefined ? 0 : Number(m[2]), extended: m[3] === "*", value });
    pieces.set(m[1]!, list);
  }
  const params: Record<string, string> = {};
  for (const [name, list] of pieces) {
    const sorted = list.toSorted((a, b) => a.index - b.index);
    let charset: string | undefined;
    const bytes: Buffer[] = [];
    for (const [i, p] of sorted.entries()) {
      if (p.extended) {
        let v = p.value;
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (m) {
            charset = m[1] || undefined;
            v = m[2]!;
          }
        }
        bytes.push(Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1"));
      } else bytes.push(bytesOf(p.value));
    }
    const joined = Buffer.concat(bytes);
    const text = charset ? decodeCharset(joined, charset) : decodeRaw8bit(joined.toString("latin1"), fallbackCharset);
    params[name] = text.includes("=?") ? decodeWords(text, fallbackCharset) : text;
  }
  return { value: head.trim().toLowerCase(), params };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  yen: "¥",
  euro: "€",
  pound: "£",
  zwnj: "",
  zwj: "",
  shy: "",
};

/** HTML 实体换回字符 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** 去掉某些元素（连同里面的，按同名标签的深度配对）：本人写的邮件去掉引用的原文用 */
function removeElements(html: string, open: RegExp, tag: string): string {
  let out = html;
  for (let guard = 0; guard < 50; guard++) {
    open.lastIndex = 0;
    const m = open.exec(out);
    if (!m) break;
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = out.length;
    for (let t = tagRe.exec(out); t; t = tagRe.exec(out)) {
      depth += t[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

/** HTML 里引用的原文（blockquote、Gmail 的 gmail_quote、Outlook 的 divRplyFwdMsg 之后）去掉 */
export function dropQuotedHtml(html: string): string {
  let out = removeElements(html, /<blockquote\b[^>]*>/gi, "blockquote");
  out = removeElements(out, /<div\b[^>]*class\s*=\s*["']?[^"'>]*\bgmail_quote\b[^>]*>/gi, "div");
  const outlook = /<div\b[^>]*id\s*=\s*["']?divRplyFwdMsg\b/i.exec(out);
  if (outlook) out = out.slice(0, outlook.index);
  return out;
}

/** HTML → 纯文字：脚本、样式去掉，块级的换行，列表项前面加"- "，行内的标签直接去掉（不插空格，中文不被打散），实体换回 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<\/?(p|div|tr|table|h[1-6]|ul|ol|section|article|header|footer|blockquote|pre|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    return /^https?:/i.test(href) && label !== "" && !label.includes(href) ? `${inner}（${href}）` : inner; // @i18n-ignore model：转成文字的邮件正文是给模型读的
  });
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtmlEntities(s);
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** format=flowed（RFC 3676）：行尾带空格的是软换行，接到下一行；DelSp=yes 时那个空格去掉；"-- " 签名线不接 */
function unflow(text: string, delsp: boolean): string {
  const lines = text.split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    const soft = line.endsWith(" ") && line !== "-- ";
    out += soft ? (delsp ? line.slice(0, -1) : line) : `${line}\n`;
  }
  return out.replace(/\n$/, "");
}

/** 一段（叶子）里的正文、附件 */
interface PartResult {
  plain: string[];
  html: string[];
  attachments: MailAttachment[];
}

/** base64 大约解出多少字节（不解） */
function estimatedSize(body: string, encoding: string | undefined): number {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    const len = body.replace(/[^A-Za-z0-9+/=]/g, "").length;
    return Math.max(0, Math.floor((len * 3) / 4) - (body.trimEnd().endsWith("==") ? 2 : body.trimEnd().endsWith("=") ? 1 : 0));
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(body).length;
  return body.length;
}

/** multipart 的正文按分隔线切开（分隔线在行首、后面只能是"--"或空白；截断了没有结束分隔线的：最后一段算到末尾） */
export function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  /** 从 from 起的下一条分隔线（长一截的别的分隔线不算） */
  const find = (from: number): number => {
    for (let i = from; ; ) {
      const j = body.indexOf(delimiter, i);
      if (j < 0) return -1;
      const tail = body.slice(j + delimiter.length, j + delimiter.length + 2);
      if ((j === 0 || body[j - 1] === "\n") && (tail === "--" || tail === "" || /^[ \t\r\n]/.test(tail))) return j;
      i = j + 1;
    }
  };
  const parts: string[] = [];
  let pos = find(0);
  while (pos >= 0) {
    if (body.startsWith("--", pos + delimiter.length)) break;
    const lineEnd = body.indexOf("\n", pos);
    if (lineEnd < 0) break;
    const start = lineEnd + 1;
    const next = find(start);
    if (next < 0) {
      parts.push(body.slice(start));
      break;
    }
    // 下一条分隔线前面的换行属于分隔线
    let end = next - 1;
    if (end > start && body[end - 1] === "\r") end -= 1;
    parts.push(body.slice(start, Math.max(start, end)));
    pos = next;
  }
  return parts;
}

/** 信头和正文分开（开头就是空行的没有信头） */
function splitEntity(raw: string): { head: string; body: string } {
  if (raw.startsWith("\r\n") || raw.startsWith("\n")) return { head: "", body: raw.replace(/^\r?\n/, "") };
  const split = CRLF2.exec(raw);
  return split ? { head: raw.slice(0, split.index), body: raw.slice(split.index + split[0].length) } : { head: raw, body: "" };
}

/** 一段（信头加正文，latin1）解析成正文和附件 */
function walkPart(raw: string, inheritedCharset: string | undefined, depth: number, defaultType = "text/plain"): PartResult {
  const { head, body } = splitEntity(raw);
  return walkEntity(parseHeaders(head), body, inheritedCharset, depth, defaultType);
}

function walkEntity(headers: RawHeaders, body: string, inheritedCharset: string | undefined, depth: number, defaultType = "text/plain"): PartResult {
  const ct = parseParams(first(headers, "content-type"), inheritedCharset);
  const type = ct.value === "" ? defaultType : ct.value;
  const disposition = parseParams(first(headers, "content-disposition"), inheritedCharset);
  const encoding = first(headers, "content-transfer-encoding");
  const filename = disposition.params.filename ?? ct.params.name;
  const result: PartResult = { plain: [], html: [], attachments: [] };

  if (type.startsWith("multipart/") && ct.params.boundary && depth < 20) {
    const children = splitMultipart(body, ct.params.boundary).map((p) => walkPart(p, inheritedCharset, depth + 1, type === "multipart/digest" ? "message/rfc822" : "text/plain"));
    if (type === "multipart/alternative") {
      // 挑一份：有纯文本的用纯文本，没有用 HTML；附件都收
      const withPlain = children.findLast((c) => c.plain.length > 0);
      const withHtml = children.findLast((c) => c.html.length > 0);
      if (withPlain) result.plain.push(...withPlain.plain);
      if (withHtml) result.html.push(...withHtml.html);
      for (const c of children) result.attachments.push(...c.attachments);
      return result;
    }
    for (const c of children) {
      result.plain.push(...c.plain);
      result.html.push(...c.html);
      result.attachments.push(...c.attachments);
    }
    // mixed 里有的段只有 HTML、有的只有纯文本：只有 HTML 的那段也要进正文（转成文字接在后面）
    return result;
  }

  if (type === "message/rfc822") {
    const inner = parseHeaders(splitEntity(body).head);
    const subject = decodeWords(first(inner, "subject") ?? "", inheritedCharset).trim();
    result.attachments.push({ filename: filename ?? `${subject || "message"}.eml`, contentType: type, size: estimatedSize(body, encoding) });
    return result;
  }

  const isText = type === "text/plain" || type === "text/html";
  const dispositionValue = disposition.value;
  const attachment = dispositionValue === "attachment" || (!isText && !type.startsWith("multipart/")) || (filename !== undefined && dispositionValue !== "inline");
  if (attachment) {
    const inline = dispositionValue === "inline" || first(headers, "content-id") !== undefined;
    result.attachments.push({ filename: filename ?? `${type.replace("/", ".")}`, contentType: type, size: estimatedSize(body, encoding), ...(inline && dispositionValue !== "attachment" ? { inline: true } : {}) });
    return result;
  }
  const charset = ct.params.charset ?? inheritedCharset;
  let text = decodeCharset(decodeTransfer(body, encoding), charset);
  if (type === "text/html") {
    result.html.push(text);
    return result;
  }
  if ((ct.params.format ?? "").toLowerCase() === "flowed") text = unflow(text, (ct.params.delsp ?? "").toLowerCase() === "yes");
  result.plain.push(text.replace(/\r\n?/g, "\n"));
  return result;
}

/**
 * 解析一封邮件（原样的字节，BODY.PEEK[] 拿到的）。截断的照样尽量解析。
 * 正文：有纯文本用纯文本（几段接起来）；只有 HTML 的转成文字（fromHtml）
 */
export function parseMail(raw: Uint8Array): ParsedMail {
  const { head, body } = splitEntity(Buffer.from(raw).toString("latin1"));
  const headers = parseHeaders(head);
  // 信头里没编码的 8 位字节：不是 UTF-8 的按正文写的字符集认
  const charset = parseParams(first(headers, "content-type")).params.charset;
  const walked = walkEntity(headers, body, charset, 0);
  const plain = walked.plain.join("\n\n").trim();
  const html = walked.html.length > 0 ? walked.html.join("\n") : undefined;
  const fromHtml = plain === "" && html !== undefined;
  const messageId = first(headers, "message-id")?.trim();
  const date = parseMailDate(first(headers, "date"));
  return {
    subject: decodeWords(first(headers, "subject") ?? "", charset).replace(/\s+/g, " ").trim(),
    from: parseAddresses(first(headers, "from"), charset),
    to: (headers.get("to") ?? []).flatMap((v) => parseAddresses(v, charset)),
    cc: (headers.get("cc") ?? []).flatMap((v) => parseAddresses(v, charset)),
    ...(date ? { date } : {}),
    ...(messageId ? { messageId } : {}),
    text: fromHtml ? htmlToText(html!) : plain,
    fromHtml,
    ...(html === undefined ? {} : { html }),
    attachments: walked.attachments,
  };
}

/** 回复里引用原文开头的那一行（之后都是引的别人的话） */
// @i18n-ignore-start data：认邮件里中英文的回复头（不是界面文字）
const QUOTE_HEADERS: readonly RegExp[] = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^.{0,300}写道[:：]\s*$/,
  /^.{0,300}寫道[:：]\s*$/,
  /^-{2,}\s*(Original Message|Forwarded message|原始邮件|原始郵件|转发的邮件|轉寄的郵件|轉發的郵件)\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^-{5,}\s*$/,
];
const OUTLOOK_FROM = /^\s*(From|发件人|寄件者)\s*[:：]/i;
const OUTLOOK_NEXT = /^\s*(Sent|Date|To|Subject|发送时间|日期|收件人|主题|寄件日期|傳送時間)\s*[:：]/i;
// @i18n-ignore-end

/** 本人写的邮件去掉引用的原文：回复头之后的、"> " 开头的行都去掉（引的是别人的话） */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Gmail 的英文回复头可能被折成两行（"On …, 张三 <" / "x@y> wrote:"）
    const joined = `${line} ${lines[i + 1]?.trim() ?? ""}`.trim();
    if (QUOTE_HEADERS.some((re) => re.test(line)) || (/^On\b/i.test(line) && /\bwrote:\s*$/i.test(joined) && !/wrote:/i.test(line))) {
      end = i;
      break;
    }
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l))) {
      end = i;
      break;
    }
  }
  return lines
    .slice(0, end)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
