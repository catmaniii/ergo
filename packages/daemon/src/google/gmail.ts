// Gmail（298 号票）：Google 插件的服务里 Gmail 这一块。用户在设置 · 数据源填 Gmail 地址和应用专用密码（要先开两步验证，调研 37、39），
// 这里经只读的 IMAP（imap.ts，imap.gmail.com:993，TLS）：
// - 存设置（DataSourceSecrets：address、password；密码去掉空格，Google 给的 16 位中间带空格）：先连一遍（登录、列邮箱）测试连接，过了才存；
//   事件、日志、页面上只有打了码的地址（"t***@example.com"），密码哪儿都不出；
// - 按需查（gmail-tools.ts）：搜邮件（发件人、收件人、主题、关键词、日期，在全部邮件 / 收件箱 / 已发邮件里）、读一封（正文和附件列表）。
//   每次现连、现登录、用完退出（不常开着连接）；邮箱只用 EXAMINE 只读打开、只取 BODY.PEEK——不发信、不删信、不改已读；
// - 导入我发出的邮件（数据源的 sync，导入默认关）："已发邮件"里新的几封（第一次只看最近 30 天，每次最多 50 封，从旧到新）取下来、
//   去掉回复里引的原文（mime.ts 的 stripQuoted），写成 google_gmail_sent（events.ts），采成"本人写的"素材；
//   每封按关键词写窄敏感类别（gmail-sensitive.ts：明显是财务、健康的标上，判不准的不标）；
//   导到哪按"已发邮件"的 UIDVALIDITY 和 UID 记（同一封 Message-ID 导过的不再导）；
// - 登录没通过（密码失效：改过 Google 账号密码会让应用专用密码全失效）记下来，数据源页上写成出错，下一次登录过了清掉。
// 出错的原因给人看（GmailProblem，走 t()）；IMAP 那边的消息不带密码，内核记下之前还会把密钥换成 ***。
import { isDeletedEventPayload, nowIso, t } from "@ergo/protocol";
import type { DataSourceContext, DataSourceRecheckContext, DataSourceSecrets, DataSourceStatus, DataSourceSyncContext, DataSourceSyncResult } from "../data-sources/api.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { GOOGLE_CHANNEL, GOOGLE_GMAIL_CURSOR, GOOGLE_GMAIL_SENT, type GoogleGmailCursorPayload, type GoogleGmailSentPayload } from "./events.ts";
import { maskId } from "./feed-fetch.ts";
import { sentMailSensitive } from "./gmail-sensitive.ts";
import { connectImap, type ImapEndpoint, ImapError, type ImapSession } from "./imap.ts";
import { dropQuotedHtml, htmlToText, type MailAddress, type MailAttachment, parseMail, parseMailDate, stripQuoted } from "./mime.ts";

/** Gmail 这个数据源的 id（定了别改：用法开关、密钥区、同步记录按它记） */
export const GOOGLE_GMAIL_SOURCE = "google-gmail";
/** Gmail 的 IMAP（Google 公开的通用设置） */
export const GMAIL_IMAP: ImapEndpoint = { host: "imap.gmail.com", port: 993 };

/** 密钥区里的两项 */
const ADDRESS_KEY = "address";
const PASSWORD_KEY = "password";

/** 读一封最多取多少字节（再大的只取前这么多，写明没读全） */
export const READ_MAX_BYTES = 10 * 1024 * 1024;
/** 导入时一封最多取多少字节（只要正文） */
const SENT_MAX_BYTES = 2 * 1024 * 1024;
/** 第一次导入只看最近几天 */
export const SENT_FIRST_DAYS = 30;
/** 一次最多导几封（多的下次接着） */
export const SENT_MAX_PER_SYNC = 50;
/** 导入的一封正文最多多少字 */
const SENT_TEXT_MAX = 6000;
/** 搜一次最多列几封 */
export const SEARCH_MAX = 30;
export const SEARCH_DEFAULT = 10;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 在哪找：全部邮件（Gmail 的 [Gmail]/All Mail，不含垃圾邮件和已删除）、收件箱、已发邮件 */
export type GmailBox = "all" | "inbox" | "sent";

/** 给人看的原因（不带密码） */
export class GmailProblem extends Error {
  /** 登录没通过（密码失效、不对） */
  readonly auth: boolean;
  constructor(message: string, auth = false) {
    super(message);
    this.name = "GmailProblem";
    this.auth = auth;
  }
}

/** 搜什么 */
export interface GmailQuery {
  from?: string;
  to?: string;
  subject?: string;
  keyword?: string;
  /** 从这天起（含，本地日期 YYYY-MM-DD） */
  since?: string;
  /** 到这天为止（含） */
  until?: string;
  in?: GmailBox;
  limit?: number;
}

/** 搜到的一封（只有信头） */
export interface GmailListed {
  id: string;
  date?: Date;
  from: MailAddress[];
  to: MailAddress[];
  subject: string;
  size?: number;
}

export interface GmailSearchResult {
  /** 实际在哪找的（没有"全部邮件"的只找了收件箱） */
  box: GmailBox;
  /** 要找全部邮件、但没有那个文件夹，只找了收件箱 */
  fellBack: boolean;
  /** 一共搜到几封 */
  total: number;
  /** 列出的（新的在前） */
  messages: GmailListed[];
}

/** 读到的一封 */
export interface GmailMessage {
  id: string;
  box: GmailBox;
  date?: Date;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  fromHtml: boolean;
  attachments: MailAttachment[];
  /** 整封多大（字节） */
  size: number;
  /** 太大只读了前一段 */
  partial: boolean;
  /** 这个账号自己发的（发件人是填的 Gmail 地址） */
  mine: boolean;
}

export interface GmailOptions {
  store: EventStore;
  clock: Pick<Clock, "now">;
  /** 连哪（测试换成本机的假服务和测试证书） */
  endpoint?: ImapEndpoint;
  /** 多久没回应算超时（毫秒） */
  timeoutMs?: number;
  log: (line: string) => void;
}

export interface GmailService {
  /** 填了地址和密码没有 */
  configured(ctx: DataSourceContext): boolean;
  /** 连接状态：填了的算连着（登录没通过过的算出错），带打了码的地址 */
  status(ctx: DataSourceContext): DataSourceStatus;
  /** 填设置：address、password（不填的用存着的）；先测试连接，过了才存 */
  configure(values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus>;
  /** 搜邮件 */
  search(ctx: DataSourceContext, query: GmailQuery, signal?: AbortSignal): Promise<GmailSearchResult>;
  /** 读一封（编号是 search 给的） */
  read(ctx: DataSourceContext, id: string, signal?: AbortSignal): Promise<GmailMessage>;
  /** 导入我发出的邮件：新的几封 */
  syncSent(ctx: DataSourceSyncContext): Promise<DataSourceSyncResult>;
  /** 出错后再试（306 号票，内核每小时叫）：用存着的地址、密码再登录一次（不碰邮件），过了就清掉"登录没通过" */
  recheck(ctx: DataSourceRecheckContext): Promise<void>;
  /** 导入的有几封（有正文的那些） */
  sentCount(): number;
  /** 断开时的清理：记着的登录没通过清掉（密钥区那一格、导入的由内核删） */
  disconnect(): void;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** YYYY-MM-DD 的下一天 */
const nextDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return isoDate(new Date(y, m - 1, d + 1));
};
/** INTERNALDATE（"24-Oct-2026 10:00:00 +0800"）→ 时间 */
const internalDate = (text: string | undefined) => (text ? parseMailDate(text.replace(/^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/, "$1 $2 $3")) : undefined);

/** 邮件编号：在哪个邮箱、UIDVALIDITY、UID */
const idOf = (box: GmailBox, uidValidity: number, uid: number) => `${box}-${uidValidity}-${uid}`;
export const GMAIL_ID = /^(all|inbox|sent)-(\d+)-(\d+)$/;

/** 密钥区里的地址和密码 */
function credentialsOf(secrets: Pick<DataSourceSecrets, "get">): { address: string; password: string } | undefined {
  const address = secrets.get(ADDRESS_KEY);
  const password = secrets.get(PASSWORD_KEY);
  return address && password ? { address, password } : undefined;
}

/** IMAP 出的错 → 给人看的原因 */
function problemOf(err: unknown, timeoutMs: number): unknown {
  if (err instanceof GmailProblem) return err;
  if (!(err instanceof ImapError)) return new GmailProblem(t("google.gmail.error.server", { reason: err instanceof Error ? err.message : String(err) }));
  switch (err.kind) {
    case "aborted":
      return err;
    case "auth":
      if (/application-specific password required/i.test(err.message)) return new GmailProblem(t("google.gmail.error.needAppPassword"), true);
      if (/web ?browser|WEBALERT/i.test(`${err.message} ${err.code ?? ""}`)) return new GmailProblem(t("google.gmail.error.webLogin"), true);
      return new GmailProblem(t("google.gmail.error.auth"), true);
    case "tls":
      return new GmailProblem(t("google.gmail.error.tls", { code: err.code ?? err.message }));
    case "timeout":
      return new GmailProblem(t("google.gmail.error.timeout", { seconds: Math.round(timeoutMs / 1000) }));
    case "connect":
      return new GmailProblem(t("google.gmail.error.unreachable", { reason: err.code ?? err.message }));
    case "closed":
    case "bye":
      return new GmailProblem(t("google.gmail.error.closed"));
    default:
      return new GmailProblem(t("google.gmail.error.server", { reason: err.message }));
  }
}

/** 某个邮箱（只读打开用的原样的名字）：全部邮件按 \All 找（没有的退回收件箱），已发邮件按 \Sent 找（再按常见的名字） */
async function mailboxOf(imap: ImapSession, box: GmailBox): Promise<{ name: string; box: GmailBox; fellBack: boolean }> {
  if (box === "inbox") return { name: "INBOX", box, fellBack: false };
  const list = (await imap.list()).filter((b) => !b.flags.includes("\\noselect"));
  const found = list.find((b) => b.flags.includes(box === "all" ? "\\all" : "\\sent"));
  if (found) return { name: found.name, box, fellBack: false };
  if (box === "sent") {
    const named = list.find((b) => /^(\[Gmail\]\/|\[Google Mail\]\/)?Sent( Mail| Messages| Items)?$/i.test(b.display));
    if (named) return { name: named.name, box, fellBack: false };
    throw new GmailProblem(t("google.gmail.error.noSent"));
  }
  return { name: "INBOX", box: "inbox", fellBack: true };
}

/** 本人写的：去掉引用的原文；纯文本优先，只有 HTML 的先去掉引用块再转文字 */
function ownText(parsed: ReturnType<typeof parseMail>): string {
  if (!parsed.fromHtml && parsed.text !== "") return stripQuoted(parsed.text);
  return parsed.html ? stripQuoted(htmlToText(dropQuotedHtml(parsed.html))) : "";
}

export function createGmail(options: GmailOptions): GmailService {
  const { store, log } = options;
  const endpoint = options.endpoint ?? GMAIL_IMAP;
  const timeoutMs = options.timeoutMs ?? 30_000;
  /** 上次登录没通过的原因（重启就没了；下次登录过了清掉） */
  let authProblem: string | undefined;

  /** 现连、现登录，做完退出；出错换成给人看的原因（登录没通过的记下来） */
  const withSession = async <T>(creds: { address: string; password: string }, signal: AbortSignal | undefined, fn: (imap: ImapSession) => Promise<T>): Promise<T> => {
    let imap: ImapSession | undefined;
    try {
      imap = await connectImap({ ...endpoint, timeoutMs, ...(signal ? { signal } : {}) });
      await imap.login(creds.address, creds.password);
      authProblem = undefined;
      return await fn(imap);
    } catch (err) {
      const problem = problemOf(err, timeoutMs);
      if (problem instanceof GmailProblem && problem.auth) {
        authProblem = problem.message;
        log(`Gmail 登录没通过（${maskId(creds.address)}）`);
      }
      throw problem;
    } finally {
      await imap?.logout();
    }
  };
  const session = <T>(ctx: DataSourceContext, signal: AbortSignal | undefined, fn: (imap: ImapSession, creds: { address: string; password: string }) => Promise<T>): Promise<T> => {
    const creds = credentialsOf(ctx.secrets);
    if (!creds) return Promise.reject(new GmailProblem(t("google.gmail.error.notConfigured")));
    return withSession(creds, signal, (imap) => fn(imap, creds));
  };

  const status = (ctx: DataSourceContext): DataSourceStatus => {
    const creds = credentialsOf(ctx.secrets);
    if (!creds) return { connection: "not_connected" };
    return { connection: authProblem === undefined ? "connected" : "error", account: maskId(creds.address), ...(authProblem === undefined ? {} : { problem: authProblem }) };
  };

  const configure = async (values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus> => {
    const saved = credentialsOf(ctx.secrets);
    const address = (values.address ?? "").trim() || saved?.address || "";
    const typed = (values.password ?? "").replace(/\s+/g, "");
    const password = typed || (saved && saved.address.toLowerCase() === address.toLowerCase() ? saved.password : "");
    if (address === "") return { connection: "error", problem: t("google.gmail.address.empty") };
    if (!EMAIL.test(address)) return { connection: "error", problem: t("google.gmail.address.bad") };
    if (password === "") return { connection: "error", problem: t("google.gmail.password.empty") };
    const before = authProblem;
    try {
      // 测试连接：登录、找得到邮箱（不碰任何邮件）
      await withSession({ address, password }, undefined, async (imap) => void (await imap.list()));
    } catch (err) {
      // 填的这一份没过：存着的那份照旧（原因由内核写在出错那一行）
      authProblem = before;
      return { connection: "error", problem: err instanceof Error ? err.message : String(err) };
    }
    ctx.secrets.set(ADDRESS_KEY, address);
    ctx.secrets.set(PASSWORD_KEY, password);
    authProblem = undefined;
    ctx.log(`连上了 Gmail（${maskId(address)}）`);
    return status(ctx);
  };

  const search = (ctx: DataSourceContext, query: GmailQuery, signal?: AbortSignal): Promise<GmailSearchResult> =>
    session(ctx, signal, async (imap) => {
      const where = await mailboxOf(imap, query.in ?? "all");
      const box = await imap.examine(where.name);
      const uids = await imap.search({
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.subject ? { subject: query.subject } : {}),
        ...(query.keyword ? { text: query.keyword } : {}),
        ...(query.since ? { since: query.since } : {}),
        ...(query.until ? { before: nextDay(query.until) } : {}),
      });
      const limit = Math.min(SEARCH_MAX, Math.max(1, query.limit ?? SEARCH_DEFAULT));
      // UID 越大越新到：取最新的几封
      const newest = uids.slice(-limit);
      const fetched = await imap.fetch(newest, { size: true, internalDate: true, headerFields: ["DATE", "FROM", "TO", "CC", "SUBJECT", "MESSAGE-ID", "CONTENT-TYPE"] });
      const messages = fetched
        .map((f): GmailListed => {
          const p = parseMail(f.header ?? Buffer.alloc(0));
          const date = p.date ?? internalDate(f.internalDate);
          return { id: idOf(where.box, box.uidValidity, f.uid), ...(date ? { date } : {}), from: p.from, to: p.to, subject: p.subject, ...(f.size === undefined ? {} : { size: f.size }) };
        })
        .toSorted((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
      return { box: where.box, fellBack: where.fellBack, total: uids.length, messages };
    });

  const read = (ctx: DataSourceContext, id: string, signal?: AbortSignal): Promise<GmailMessage> => {
    const m = GMAIL_ID.exec(id.trim());
    if (!m) return Promise.reject(new GmailProblem(t("google.gmail.error.badId")));
    const [, which, validity, uidText] = m as unknown as [string, GmailBox, string, string];
    return session(ctx, signal, async (imap, creds) => {
      const where = await mailboxOf(imap, which);
      const box = await imap.examine(where.name);
      if (box.uidValidity !== Number(validity)) throw new GmailProblem(t("google.gmail.error.stale"));
      const uid = Number(uidText);
      const [f] = await imap.fetch([uid], { size: true, internalDate: true, body: { maxBytes: READ_MAX_BYTES } });
      if (!f?.body || f.body.length === 0) throw new GmailProblem(t("google.gmail.error.notFound"));
      const parsed = parseMail(f.body);
      const date = parsed.date ?? internalDate(f.internalDate);
      const size = f.size ?? f.body.length;
      return {
        id: idOf(which, box.uidValidity, uid),
        box: which,
        ...(date ? { date } : {}),
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        text: parsed.text,
        fromHtml: parsed.fromHtml,
        attachments: parsed.attachments,
        size,
        partial: size > f.body.length,
        mine: which === "sent" || parsed.from.some((a) => a.address.toLowerCase() === creds.address.toLowerCase()),
      };
    });
  };

  /** 导入的（还没删掉的）你发出的邮件和导到哪了 */
  const imported = () => {
    const sent: GoogleGmailSentPayload[] = [];
    const cursors: GoogleGmailCursorPayload[] = [];
    for (const e of store.read(GOOGLE_CHANNEL)) {
      if (isDeletedEventPayload(e.payload)) continue;
      if (e.type === GOOGLE_GMAIL_SENT) sent.push(e.payload as GoogleGmailSentPayload);
      else if (e.type === GOOGLE_GMAIL_CURSOR) cursors.push(e.payload as GoogleGmailCursorPayload);
    }
    return { sent, cursors };
  };

  const syncSent = (ctx: DataSourceSyncContext): Promise<DataSourceSyncResult> =>
    session(ctx, ctx.signal, async (imap) => {
      const where = await mailboxOf(imap, "sent");
      const box = await imap.examine(where.name);
      const { sent, cursors } = imported();
      const lastUid = Math.max(0, ...sent.filter((p) => p.uidValidity === box.uidValidity).map((p) => p.uid), ...cursors.filter((c) => c.uidValidity === box.uidValidity).map((c) => c.uid));
      const knownMessageIds = new Set(sent.flatMap((p) => (p.messageId ? [p.messageId] : [])));
      const since = isoDate(new Date(options.clock.now() - SENT_FIRST_DAYS * 86_400_000));
      const uids = lastUid > 0 ? await imap.search({ uidFrom: lastUid + 1 }) : await imap.search({ since });
      const batch = uids.slice(0, SENT_MAX_PER_SYNC);
      const fetched = await imap.fetch(batch, { internalDate: true, body: { maxBytes: SENT_MAX_BYTES } });
      const at = nowIso(new Date(options.clock.now()));
      const events: NewEvent[] = [];
      let maxWritten = 0;
      for (const f of fetched) {
        if (ctx.signal.aborted) break;
        const parsed = parseMail(f.body ?? Buffer.alloc(0));
        // UIDVALIDITY 变了以后同一封又出现：按 Message-ID 认出来，不再导
        if (parsed.messageId && knownMessageIds.has(parsed.messageId)) continue;
        const body = ownText(parsed);
        const full = [parsed.subject, body].filter((s) => s !== "").join("\n\n");
        if (body === "") continue;
        const text = full.length > SENT_TEXT_MAX ? full.slice(0, SENT_TEXT_MAX) : full;
        const date = parsed.date ?? internalDate(f.internalDate) ?? new Date(options.clock.now());
        const people = [...new Set([...parsed.to, ...parsed.cc].map((a) => a.name ?? a.address))];
        events.push({
          channel: GOOGLE_CHANNEL,
          type: GOOGLE_GMAIL_SENT,
          payload: {
            id: `${box.uidValidity}-${f.uid}`,
            uidValidity: box.uidValidity,
            uid: f.uid,
            ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
            at: nowIso(date),
            subject: parsed.subject,
            to: people,
            text,
            ...(full.length > SENT_TEXT_MAX ? { truncated: true as const } : {}),
            sensitive: sentMailSensitive(text),
          } satisfies GoogleGmailSentPayload,
        });
        maxWritten = Math.max(maxWritten, f.uid);
      }
      // 最后几封都跳过了（没正文、导过的）：记一下导到哪，下次不再取它们
      const maxSeen = Math.max(0, ...fetched.map((f) => f.uid));
      if (maxSeen > maxWritten && maxSeen > lastUid) events.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_CURSOR, payload: { uidValidity: box.uidValidity, uid: maxSeen, at } satisfies GoogleGmailCursorPayload });
      if (events.length > 0) store.appendBatch(events);
      const added = events.filter((e) => e.type === GOOGLE_GMAIL_SENT).length;
      const rest = uids.length - batch.length;
      const summary = t("google.gmail.sync.summary", { count: added, n: added });
      if (rest > 0) ctx.log(`已发邮件还有 ${rest} 封没导，下次接着`);
      return { added, summary: rest > 0 ? t("google.gmail.sync.more", { summary, count: rest, n: rest }) : summary };
    });

  return {
    configured: (ctx) => credentialsOf(ctx.secrets) !== undefined,
    status,
    configure,
    search,
    read,
    syncSent,
    async recheck(ctx) {
      const creds = credentialsOf(ctx.secrets);
      if (!creds || authProblem === undefined) return;
      try {
        // 登录过了 withSession 自己清掉 authProblem；没过它记下（照旧出错）
        await withSession(creds, ctx.signal, async (imap) => void (await imap.list()));
        ctx.log(`Gmail 又登录得上了（${maskId(creds.address)}）`);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    },
    sentCount: () => imported().sent.length,
    disconnect: () => {
      authProblem = undefined;
    },
  };
}
