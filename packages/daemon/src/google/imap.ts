// 只读的 IMAP 客户端（298 号票，Gmail 按需查用；不加依赖，用 Node 自带的 tls）。只做查邮件要的那几条命令：
// CAPABILITY、LOGIN、LIST、EXAMINE（只读打开）、UID SEARCH、UID FETCH（只取 BODY.PEEK[...]，不会把邮件标成已读）、LOGOUT、NOOP。
// - **只读**：发命令的那一处只放行上面这几条（assertReadOnly）；SELECT、STORE、EXPUNGE、APPEND、COPY、MOVE、DELETE……一律拒绝、不发出去；
//   FETCH 里不许有 BODY[...]（不带 PEEK 的会标已读）和 RFC822 / RFC822.TEXT。EXAMINE 回来的不是 [READ-ONLY] 的也不往下做；
// - 只走 TLS（993 端口；测试连本机的假服务，用测试的自签证书经 ca 交进来），不发明文；
// - 回应按字节读：literal（{n} 之后 n 个字节）原样留成 Buffer，邮件正文不经字符串转换；引号串、atom、列表、NIL 解成 ImapValue；
//   带方括号的 atom（BODY[HEADER.FIELDS (DATE FROM)]、BODY[]<0>）整个算一个；
// - 命令里的字符串：可打印 ASCII 写成引号串，有中文的（搜索词）用 literal（等服务端的"+"再发），搜索带 CHARSET UTF-8；
// - 超时：多久没收到东西算超时（默认 30 秒），断开、中止信号都让正在等的命令出错；
// - 出错按种类分（连不上、证书不对、超时、登录没通过、服务端拒绝、协议不对、被拒绝的写命令），给人看的原因由用它的地方（gmail.ts）写，
//   这里的消息只给开发者看，**从不带密码**（LOGIN 那条命令的文字不进任何消息、日志）。
import net from "node:net";
import tls from "node:tls";

/** 连哪（测试换成本机的假服务和测试证书） */
export interface ImapEndpoint {
  host: string;
  port: number;
  /** 信任的证书（测试的自签证书）；不给用系统的 */
  ca?: string | Buffer;
  /** TLS 的服务器名（不给按 host；host 是 IP 时不发） */
  servername?: string;
}

export interface ImapConnectOptions extends ImapEndpoint {
  /** 多久没收到东西算超时（毫秒） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ImapErrorKind = "connect" | "tls" | "timeout" | "auth" | "no" | "bad" | "bye" | "protocol" | "aborted" | "refused" | "closed";

/** IMAP 出的错：种类、服务端的话（不带密码）、响应码（AUTHENTICATIONFAILED、ALERT……）或者网络错的 code */
export class ImapError extends Error {
  readonly kind: ImapErrorKind;
  readonly code: string | undefined;
  constructor(kind: ImapErrorKind, message: string, code?: string) {
    super(message);
    this.name = "ImapError";
    this.kind = kind;
    this.code = code;
  }
}

/** IMAP 的值：atom 是字符串，引号串和 literal 是 Buffer，NIL 是 null，括号是数组 */
export type ImapValue = string | Buffer | null | ImapValue[];

/** 读到的一条回应：几段文字（latin1，一个字符一个字节）和夹在中间的 literal */
export interface RawResponse {
  readonly parts: ReadonlyArray<string | Buffer>;
}

/** 一个邮箱（LIST 回来的） */
export interface ImapMailbox {
  /** 原样的名字（修改过的 UTF-7，命令里用它） */
  readonly name: string;
  /** 给人看的名字（解开 UTF-7："[Gmail]/已发邮件"） */
  readonly display: string;
  readonly delimiter: string | null;
  /** 属性（小写）：\noselect、\all、\sent、\trash…… */
  readonly flags: readonly string[];
}

/** EXAMINE 的结果 */
export interface ImapExamined {
  readonly exists: number;
  readonly uidValidity: number;
  readonly uidNext?: number;
}

/** 搜索条件（日期是本地日期 YYYY-MM-DD，按服务端的日期比） */
export interface ImapSearch {
  since?: string;
  /** 这一天之前（不含这一天） */
  before?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** 信头和正文里有 */
  text?: string;
  /** UID 从多少起（含） */
  uidFrom?: number;
}

/** 要取的 */
export interface ImapFetchRequest {
  size?: boolean;
  internalDate?: boolean;
  flags?: boolean;
  /** 只取这几个信头（BODY.PEEK[HEADER.FIELDS (...)]） */
  headerFields?: readonly string[];
  /** 取整封（BODY.PEEK[]），maxBytes 给了只取前这么多（BODY.PEEK[]<0.n>） */
  body?: { maxBytes?: number };
}

export interface ImapFetched {
  uid: number;
  size?: number;
  internalDate?: string;
  flags?: string[];
  header?: Buffer;
  body?: Buffer;
}

export interface ImapSession {
  readonly capabilities: ReadonlySet<string>;
  login(user: string, password: string): Promise<void>;
  list(): Promise<ImapMailbox[]>;
  /** 只读打开一个邮箱 */
  examine(name: string): Promise<ImapExamined>;
  /** UID SEARCH：交回 UID（升序） */
  search(criteria: ImapSearch): Promise<number[]>;
  /** UID FETCH */
  fetch(uids: readonly number[], request: ImapFetchRequest): Promise<ImapFetched[]>;
  /** 礼貌地退出（出错不管）再断开 */
  logout(): Promise<void>;
  /** 直接断开 */
  close(): void;
}

/** 默认多久没收到东西算超时 */
export const IMAP_TIMEOUT_MS = 30_000;
/** 一个 literal 最大多少字节（防服务端乱报） */
const MAX_LITERAL = 64 * 1024 * 1024;

const ALLOWED = /^(?:CAPABILITY|NOOP|LOGIN|LIST|EXAMINE|LOGOUT|UID SEARCH|UID FETCH)(?: |$)/i;

/** 只放行只读的命令：别的（SELECT、STORE、EXPUNGE、APPEND、COPY、MOVE……）、会标已读的 FETCH 都拒绝 */
export function assertReadOnly(command: string): void {
  const verb = /^(UID \S+|\S+)/i.exec(command)?.[1]?.toUpperCase() ?? "";
  if (!ALLOWED.test(command)) throw new ImapError("refused", `refused non read-only IMAP command: ${verb}`);
  if (/^UID FETCH/i.test(command) && (/BODY\[/i.test(command) || /\bRFC822(?:\.TEXT)?(?![.\w])/i.test(command))) throw new ImapError("refused", "refused FETCH that would set \\Seen (use BODY.PEEK)");
}

/** 修改过的 UTF-7（RFC 3501 5.1.3）的邮箱名 → 给人看的 */
export function decodeMailboxName(raw: string): string {
  return raw.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (b64 === "") return "&";
    const bytes = Buffer.from(b64.replace(/,/g, "/"), "base64");
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  });
}

/** 给人看的邮箱名 → 修改过的 UTF-7（测试的假服务用） */
export function encodeMailboxName(name: string): string {
  let out = "";
  let pending = "";
  const flush = () => {
    if (pending === "") return;
    const bytes = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) bytes.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += `&${bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
    pending = "";
  };
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === "&" ? "&-" : ch;
    } else pending += ch;
  }
  flush();
  return out;
}

/** 按字节读回应：一行一行，行尾是 {n} 的接着读 n 个字节的 literal */
export class ResponseReader {
  private line: Buffer[] = [];
  private parts: Array<string | Buffer> = [];
  private literal: { need: number; got: number; chunks: Buffer[] } | undefined;

  push(chunk: Buffer): RawResponse[] {
    const out: RawResponse[] = [];
    let data = chunk;
    while (data.length > 0) {
      if (this.literal) {
        const take = Math.min(this.literal.need - this.literal.got, data.length);
        this.literal.chunks.push(data.subarray(0, take));
        this.literal.got += take;
        data = data.subarray(take);
        if (this.literal.got < this.literal.need) break;
        this.parts.push(Buffer.concat(this.literal.chunks));
        this.literal = undefined;
        continue;
      }
      const nl = data.indexOf(0x0a);
      if (nl < 0) {
        this.line.push(data);
        break;
      }
      this.line.push(data.subarray(0, nl));
      data = data.subarray(nl + 1);
      const text = Buffer.concat(this.line).toString("latin1").replace(/\r$/, "");
      this.line = [];
      this.parts.push(text);
      const m = /\{(\d+)\+?\}$/.exec(text);
      if (m) {
        const need = Number(m[1]);
        if (need > MAX_LITERAL) throw new ImapError("protocol", `literal too large: ${need}`);
        this.literal = { need, got: 0, chunks: [] };
        if (need === 0) {
          this.parts.push(Buffer.alloc(0));
          this.literal = undefined;
        }
        continue;
      }
      out.push({ parts: this.parts });
      this.parts = [];
    }
    return out;
  }
}

/** 一条回应解成值（数据回应用；OK / NO 这类状态回应的文字不解，按正则看） */
export function tokenize(response: RawResponse): ImapValue[] {
  const root: ImapValue[] = [];
  const stack: ImapValue[][] = [root];
  const top = () => stack[stack.length - 1]!;
  for (const part of response.parts) {
    if (Buffer.isBuffer(part)) {
      top().push(part);
      continue;
    }
    const s = part;
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === " ") {
        i++;
      } else if (c === "(") {
        const list: ImapValue[] = [];
        top().push(list);
        stack.push(list);
        i++;
      } else if (c === ")") {
        if (stack.length > 1) stack.pop();
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let out = "";
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\" && j + 1 < s.length) {
            out += s[j + 1];
            j += 2;
          } else out += s[j++];
        }
        top().push(Buffer.from(out, "latin1"));
        i = j + 1;
      } else if (c === "{" && /^\{\d+\+?\}$/.test(s.slice(i))) {
        // literal 的标记：值是下一段（Buffer）
        i = s.length;
      } else {
        let j = i;
        let depth = 0;
        while (j < s.length) {
          const d = s[j]!;
          if (d === "[") depth++;
          else if (d === "]") depth = Math.max(0, depth - 1);
          else if (depth === 0 && (d === " " || d === "(" || d === ")" || d === '"')) break;
          j++;
        }
        const atom = s.slice(i, j);
        top().push(atom.toUpperCase() === "NIL" ? null : atom);
        i = j;
      }
    }
  }
  return root;
}

/** 值 → 文字（引号串、literal 按 UTF-8；atom 原样） */
export const textOf = (v: ImapValue | undefined): string => (v === null || v === undefined ? "" : Buffer.isBuffer(v) ? v.toString("utf8") : Array.isArray(v) ? "" : v);

/** 一条回应的第一段文字 */
const head = (r: RawResponse) => (typeof r.parts[0] === "string" ? r.parts[0] : "");

/** 状态回应：* OK [CODE] text / A1 NO [CODE] text */
const STATUS = /^(\*|\+|[A-Za-z0-9]+) (OK|NO|BAD|BYE|PREAUTH)(?: \[([^\]]*)\])?(?: (.*))?$/i;

interface Status {
  tag: string;
  status: string;
  code?: string;
  text: string;
}

function statusOf(r: RawResponse): Status | undefined {
  const m = STATUS.exec(head(r));
  if (!m) return undefined;
  return { tag: m[1]!, status: m[2]!.toUpperCase(), ...(m[3] === undefined ? {} : { code: m[3] }), text: m[4] ?? "" };
}

/** 命令里的一个字符串：可打印 ASCII 写成引号串，别的用 literal */
type Arg = string | { literal: Buffer };
function astring(value: string | Buffer): Arg {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.every((b) => b >= 0x20 && b <= 0x7e)) return `"${bytes.toString("latin1").replace(/(["\\])/g, "\\$1")}"`;
  return { literal: bytes };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** YYYY-MM-DD → IMAP 的日期（24-Oct-2026） */
export function imapDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new ImapError("protocol", `bad date: ${date}`);
  return `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** UID 列表 → 序列集（"1:3,7"） */
export function uidSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].toSorted((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    ranges.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return ranges.join(",");
}

const TLS_CODES = /^(CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;

/** 网络错 → ImapError */
function networkError(err: unknown): ImapError {
  if (err instanceof ImapError) return err;
  const code = (err as { code?: unknown }).code;
  const c = typeof code === "string" ? code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (c && TLS_CODES.test(c)) return new ImapError("tls", message, c);
  return new ImapError("connect", message, c);
}

interface Pending {
  tag: string;
  untagged: RawResponse[];
  resolve(result: { untagged: RawResponse[]; status: Status }): void;
  reject(err: ImapError): void;
  onContinue?: () => void;
}

/** 连上、读招呼语（拿到能力），交回会话；连不上、证书不对、超时抛 ImapError */
export async function connectImap(options: ImapConnectOptions): Promise<ImapSession> {
  const timeoutMs = options.timeoutMs ?? IMAP_TIMEOUT_MS;
  if (options.signal?.aborted) throw new ImapError("aborted", "aborted");
  const socket = tls.connect({
    host: options.host,
    port: options.port,
    ...(net.isIP(options.host) ? {} : { servername: options.servername ?? options.host }),
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    minVersion: "TLSv1.2",
  });
  const reader = new ResponseReader();
  let pending: Pending | undefined;
  let failure: ImapError | undefined;
  let greeted: { resolve(r: RawResponse): void; reject(e: ImapError): void } | undefined;
  const greeting = new Promise<RawResponse>((resolve, reject) => (greeted = { resolve, reject }));
  let tagSeq = 0;
  const capabilities = new Set<string>();

  const fail = (err: ImapError) => {
    if (!failure) failure = err;
    greeted?.reject(failure);
    greeted = undefined;
    pending?.reject(failure);
    pending = undefined;
  };
  const onAbort = () => socket.destroy(new ImapError("aborted", "aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  socket.setTimeout(timeoutMs, () => socket.destroy(new ImapError("timeout", `no response in ${Math.round(timeoutMs / 1000)}s`)));
  socket.on("error", (err) => fail(networkError(err)));
  socket.on("close", () => {
    options.signal?.removeEventListener("abort", onAbort);
    fail(new ImapError("closed", "connection closed"));
  });
  socket.on("data", (chunk: Buffer) => {
    let responses: RawResponse[];
    try {
      responses = reader.push(chunk);
    } catch (err) {
      socket.destroy(err instanceof ImapError ? err : new ImapError("protocol", String(err)));
      return;
    }
    for (const r of responses) {
      if (greeted) {
        const g = greeted;
        greeted = undefined;
        g.resolve(r);
        continue;
      }
      const line = head(r);
      if (line.startsWith("+")) {
        pending?.onContinue?.();
        continue;
      }
      if (line.startsWith("* ")) {
        pending?.untagged.push(r);
        continue;
      }
      const status = statusOf(r);
      if (pending && status && status.tag === pending.tag) {
        const p = pending;
        pending = undefined;
        p.resolve({ untagged: p.untagged, status });
      }
    }
  });

  const readCapabilities = (text: string) => {
    capabilities.clear();
    for (const c of text.split(/\s+/).filter(Boolean)) capabilities.add(c.toUpperCase());
  };

  /** 发一条命令（先查是不是只读的），等它的结果；NO / BAD 抛 ImapError */
  const run = (args: readonly Arg[]): Promise<{ untagged: RawResponse[]; status: Status }> => {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new ImapError("protocol", "command already running"));
    const words = args.map((a) => (typeof a === "string" ? a : `{${a.literal.length}}`));
    assertReadOnly(words.join(" "));
    const tag = `A${++tagSeq}`;
    // 按 literal 切成几段：每段末尾的 {n} 发出去以后等"+"再发 literal
    const segments: Array<{ text: string; literal?: Buffer }> = [];
    let text = `${tag}`;
    for (const a of args) {
      if (typeof a === "string") text += ` ${a}`;
      else {
        segments.push({ text: `${text} {${a.literal.length}}\r\n`, literal: a.literal });
        text = "";
      }
    }
    segments.push({ text: `${text}\r\n` });
    return new Promise((resolve, reject) => {
      let index = 0;
      const sendNext = () => {
        const seg = segments[index++];
        if (!seg) return;
        socket.write(Buffer.from(seg.text, "latin1"));
        if (seg.literal === undefined) return;
        // 等服务端的"+"
        pending!.onContinue = () => {
          pending!.onContinue = undefined;
          socket.write(seg.literal!);
          sendNext();
        };
      };
      pending = {
        tag,
        untagged: [],
        resolve: ({ untagged, status }) => {
          if (status.status === "OK") resolve({ untagged, status });
          else reject(new ImapError(status.status === "NO" ? "no" : "bad", status.text || status.status, status.code));
        },
        reject,
      };
      sendNext();
    });
  };

  // 招呼语
  try {
    const hello = await greeting;
    const status = statusOf(hello);
    if (!status || status.tag !== "*") throw new ImapError("protocol", "bad greeting");
    if (status.status === "BYE") throw new ImapError("bye", status.text || "server said BYE");
    if (status.code?.toUpperCase().startsWith("CAPABILITY ")) readCapabilities(status.code.slice("CAPABILITY ".length));
    else {
      const caps = await run(["CAPABILITY"]);
      for (const r of caps.untagged) if (/^\* CAPABILITY /i.test(head(r))) readCapabilities(head(r).slice("* CAPABILITY ".length));
    }
  } catch (err) {
    socket.destroy();
    throw err instanceof ImapError ? err : networkError(err);
  }

  const untaggedOf = (rs: readonly RawResponse[], name: string): ImapValue[][] =>
    rs.flatMap((r) => {
      const tokens = tokenize(r);
      return tokens[0] === "*" && typeof tokens[1] === "string" && tokens[1].toUpperCase() === name ? [tokens.slice(2)] : [];
    });

  const session: ImapSession = {
    capabilities,
    async login(user, password) {
      if (capabilities.has("LOGINDISABLED")) throw new ImapError("auth", "LOGIN is disabled by the server");
      let done: { untagged: RawResponse[]; status: Status };
      try {
        done = await run(["LOGIN", astring(user), astring(password)]);
      } catch (err) {
        if (err instanceof ImapError && (err.kind === "no" || err.kind === "bad")) throw new ImapError("auth", err.message, err.code);
        throw err;
      }
      if (done.status.code?.toUpperCase().startsWith("CAPABILITY ")) readCapabilities(done.status.code.slice("CAPABILITY ".length));
    },
    async list() {
      const { untagged } = await run(["LIST", '""', '"*"']);
      return untaggedOf(untagged, "LIST").flatMap((v) => {
        const [flags, delimiter, name] = v;
        if (!Array.isArray(flags) || name === undefined || name === null || Array.isArray(name)) return [];
        const raw = Buffer.isBuffer(name) ? name.toString("latin1") : name;
        return [{ name: raw, display: decodeMailboxName(raw), delimiter: delimiter === null || delimiter === undefined || Array.isArray(delimiter) ? null : textOf(delimiter), flags: flags.map((f) => textOf(f).toLowerCase()) }];
      });
    },
    async examine(name) {
      const { untagged, status } = await run(["EXAMINE", astring(Buffer.from(name, "latin1"))]);
      // 只读打开：服务端没说 [READ-ONLY] 的不往下做
      if (!/^READ-ONLY$/i.test(status.code ?? "")) throw new ImapError("protocol", "EXAMINE did not open the mailbox read-only");
      let exists = 0;
      let uidValidity: number | undefined;
      let uidNext: number | undefined;
      for (const r of untagged) {
        const line = head(r);
        const ex = /^\* (\d+) EXISTS/i.exec(line);
        if (ex) exists = Number(ex[1]);
        const uv = /\[UIDVALIDITY (\d+)\]/i.exec(line);
        if (uv) uidValidity = Number(uv[1]);
        const un = /\[UIDNEXT (\d+)\]/i.exec(line);
        if (un) uidNext = Number(un[1]);
      }
      if (uidValidity === undefined) throw new ImapError("protocol", "EXAMINE gave no UIDVALIDITY");
      return { exists, uidValidity, ...(uidNext === undefined ? {} : { uidNext }) };
    },
    async search(criteria) {
      const keys: Arg[] = [];
      if (criteria.uidFrom !== undefined) keys.push("UID", `${Math.max(1, criteria.uidFrom)}:*`);
      if (criteria.since) keys.push("SINCE", imapDate(criteria.since));
      if (criteria.before) keys.push("BEFORE", imapDate(criteria.before));
      for (const [key, value] of [
        ["FROM", criteria.from],
        ["TO", criteria.to],
        ["SUBJECT", criteria.subject],
        ["TEXT", criteria.text],
      ] as const) {
        if (value !== undefined && value.trim() !== "") keys.push(key, astring(value.trim()));
      }
      if (keys.length === 0) keys.push("ALL");
      const utf8 = keys.some((k) => typeof k !== "string");
      const { untagged } = await run(["UID", "SEARCH", ...(utf8 ? ["CHARSET", "UTF-8"] : []), ...keys]);
      const uids = untaggedOf(untagged, "SEARCH").flatMap((v) => v.flatMap((x) => (typeof x === "string" && /^\d+$/.test(x) ? [Number(x)] : [])));
      // "UID n:*" 至少回最后一封（哪怕它比 n 小）：滤掉
      return [...new Set(uids)].filter((u) => criteria.uidFrom === undefined || u >= criteria.uidFrom).toSorted((a, b) => a - b);
    },
    async fetch(uids, request) {
      if (uids.length === 0) return [];
      const items = ["UID"];
      if (request.size) items.push("RFC822.SIZE");
      if (request.internalDate) items.push("INTERNALDATE");
      if (request.flags) items.push("FLAGS");
      if (request.headerFields) items.push(`BODY.PEEK[HEADER.FIELDS (${request.headerFields.map((f) => f.toUpperCase()).join(" ")})]`);
      if (request.body) items.push(request.body.maxBytes === undefined ? "BODY.PEEK[]" : `BODY.PEEK[]<0.${request.body.maxBytes}>`);
      const { untagged } = await run(["UID", "FETCH", uidSet(uids), `(${items.join(" ")})`]);
      const byUid = new Map<number, ImapFetched>();
      for (const r of untagged) {
        const tokens = tokenize(r);
        if (tokens[0] !== "*" || typeof tokens[2] !== "string" || tokens[2].toUpperCase() !== "FETCH" || !Array.isArray(tokens[3])) continue;
        const list = tokens[3];
        const got: Partial<ImapFetched> = {};
        for (let i = 0; i + 1 < list.length; i += 2) {
          const key = typeof list[i] === "string" ? (list[i] as string).toUpperCase() : "";
          const value = list[i + 1]!;
          if (key === "UID") got.uid = Number(textOf(value));
          else if (key === "RFC822.SIZE") got.size = Number(textOf(value));
          else if (key === "INTERNALDATE") got.internalDate = textOf(value);
          else if (key === "FLAGS" && Array.isArray(value)) got.flags = value.map((f) => textOf(f));
          else if (key.startsWith("BODY[HEADER")) got.header = Buffer.isBuffer(value) ? value : Buffer.from(textOf(value), "latin1");
          else if (/^BODY\[\](<\d+>)?$/.test(key)) got.body = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
        }
        if (got.uid === undefined || Number.isNaN(got.uid)) continue;
        byUid.set(got.uid, { ...byUid.get(got.uid), ...got } as ImapFetched);
      }
      return uids.flatMap((u) => {
        const f = byUid.get(u);
        return f ? [f] : [];
      });
    },
    async logout() {
      try {
        if (!failure) await run(["LOGOUT"]);
      } catch {
        // 退出时出错不管
      } finally {
        socket.end();
        socket.destroy();
      }
    },
    close() {
      socket.destroy();
    },
  };
  return session;
}
