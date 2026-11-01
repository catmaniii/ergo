// Gmail：Google 插件的服务里 Gmail 这一块。用户在设置 · 数据源填 Gmail 地址和应用专用密码（要先开两步验证，调研 37），
// 这里经只读的 IMAP（imap.ts，imap.gmail.com:993，TLS）：
// - 存设置（DataSourceSecrets，是一组账号，见 gmail-accounts.ts；密码去掉空格，Google 给的 16 位中间带空格）：先连一遍（登录、列邮箱）测试连接，过了才存；
//   日志里只有打了码的地址（"t***@example.com"），页面上是完整邮箱，密码哪儿都不出；
// - 按需查（gmail-tools.ts）：搜邮件（发件人、收件人、主题、关键词、日期，在全部邮件 / 收件箱 / 已发邮件里）、读一封（正文和附件列表）。
//   每次现连、现登录、用完退出（不常开着连接）；邮箱只用 EXAMINE 只读打开、只取 BODY.PEEK——不发信、不删信、不改已读；
// - 导入我发出的邮件（数据源的 sync，导入默认关）："已发邮件"里新的几封（第一次只看最近 30 天，每次最多 50 封，从旧到新）取下来、
//   去掉回复里引的原文（mime.ts 的 stripQuoted），写成 google_gmail_sent（events.ts），采成"本人写的"素材；
//   每封按关键词写窄敏感类别（gmail-sensitive.ts：明显是财务、健康的标上，判不准的不标）；
//   导到哪按"已发邮件"的 UIDVALIDITY 和 UID 记（同一封 Message-ID 导过的不再导）；
// - 登录没通过（密码失效：改过 Google 账号密码会让应用专用密码全失效）记下来，数据源页上写成出错，下一次登录过了清掉。
// 出错的原因给人看（GmailProblem，走 t()）；IMAP 那边的消息不带密码，内核记下之前还会把密钥换成 ***。
// 可以连几个账号（gmail-accounts.ts 存、转老配置）。每个账号各连各的、各记各的：
// - 状态：每个账号是 items 的一项（完整邮箱、状态、问题），account 列出全部；开着的账号都登录不上才算出错（有一个能用就连着，秘书照常有工具），
//   有一个登录不上就带 needsAuth（要重新填）；账号都关了算没连；
// - 搜：不指定账号查全部开着的（一个查不到不挡别的，写明），指定了只查那一个；邮件编号带账号（<账号 id>.<邮箱>-<UIDVALIDITY>-<UID>），读的时候认得出是谁的；
// - 导入：每个账号自己的进度（事件带 account；转过来之前导的没写，归转过来的那一条，legacyOwnerOf）；一个账号出错不挡别的，这次同步算出错；
// - 断开一个（disconnectAccount）：只删它的密钥，交回哪些记录归它。
// 给模型、日志的是打了码的邮箱（maskId），页面上是完整邮箱；邮箱也算这一格里的值，内核会把出错原因里的完整邮箱换成 ***，所以出错原因里写打码的。
import { isDeletedEventPayload, nowIso, t } from "@ergo/protocol";
import type { DataSourceContext, DataSourceItem, DataSourceRecheckContext, DataSourceStatus, DataSourceSyncContext, DataSourceSyncResult } from "../data-sources/api.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { GOOGLE_CHANNEL, GOOGLE_GMAIL_CURSOR, GOOGLE_GMAIL_SENT, type GoogleGmailCursorPayload, type GoogleGmailSentPayload } from "./events.ts";
import { maskId } from "./feed-fetch.ts";
import { accountIdOf, accountsIn, type GmailAccount, legacyOwnerOf, removeAccount, saveAccount, setAccountEnabled } from "./gmail-accounts.ts";
import { sentMailSensitive } from "./gmail-sensitive.ts";
import { connectImap, type ImapEndpoint, ImapError, type ImapSession } from "./imap.ts";
import { dropQuotedHtml, htmlToText, type MailAddress, type MailAttachment, parseMail, parseMailDate, stripQuoted } from "./mime.ts";

/** Gmail 这个数据源的 id（定了别改：用法开关、密钥区、同步记录按它记） */
export const GOOGLE_GMAIL_SOURCE = "google-gmail";
/** Gmail 的 IMAP（Google 公开的通用设置） */
export const GMAIL_IMAP: ImapEndpoint = { host: "imap.gmail.com", port: 993 };

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

/** 一个账号给外面看的样子（不带密码）：id、完整邮箱（只给页面）、打了码的邮箱（给模型、日志）、开没开 */
export interface GmailAccountInfo {
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly enabled: boolean;
}

/** 搜什么 */
export interface GmailQuery {
  /** 只查这个账号（账号 id、邮箱地址、打了码的邮箱，或者地址的一部分）；不写查全部开着的 */
  account?: string;
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

/** 一个账号搜到的 */
export interface GmailAccountFound {
  readonly account: GmailAccountInfo;
  /** 实际在哪找的（没有"全部邮件"的只找了收件箱） */
  box: GmailBox;
  /** 要找全部邮件、但没有那个文件夹，只找了收件箱 */
  fellBack: boolean;
  /** 一共搜到几封 */
  total: number;
  /** 列出的（新的在前） */
  messages: GmailListed[];
  problem?: undefined;
}

/** 一个账号没查成（别的账号照常） */
export interface GmailAccountFailed {
  readonly account: GmailAccountInfo;
  readonly problem: GmailProblem;
}

/** 搜的结果：每个账号一项，按加的先后；全都没查成的抛 GmailProblem，到不了这里 */
export interface GmailSearchResult {
  accounts: Array<GmailAccountFound | GmailAccountFailed>;
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
  /** 用户自己发的（发件人是连着的某个 Gmail 地址） */
  mine: boolean;
  /** 哪个账号的 */
  account: GmailAccountInfo;
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
  /** 有没有开着的账号 */
  configured(ctx: DataSourceContext): boolean;
  /** 配着的几个账号（不带密码） */
  accounts(ctx: DataSourceContext): GmailAccountInfo[];
  /** 连接状态：开着的账号都登录没通过才算出错；每个账号一项，带完整邮箱（只给页面） */
  status(ctx: DataSourceContext): DataSourceStatus;
  /**
   * 填设置：
   * - address、password：加一个账号，或者换已有那个的密码（地址一样，不分大小写）；先测试连接，过了才存，没过的什么都不动。
   *   只有一个账号时可以只填密码；已有的账号可以只填地址（用存着的密码再测一次）；
   * - account、enabled（on / off）：开关一个账号；
   * - 什么都不填：用存着的把开着的账号再测一次
   */
  configure(values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus>;
  /** 搜邮件：不指定账号查全部开着的 */
  search(ctx: DataSourceContext, query: GmailQuery, signal?: AbortSignal): Promise<GmailSearchResult>;
  /** 读一封（编号是 search 给的，带账号；老样子没带账号的编号只有一个账号开着时才认，或者写明 account） */
  read(ctx: DataSourceContext, id: string, signal?: AbortSignal, account?: string): Promise<GmailMessage>;
  /** 导入我发出的邮件：每个开着的账号新的几封，一个出错不挡别的 */
  syncSent(ctx: DataSourceSyncContext): Promise<DataSourceSyncResult>;
  /** 出错后再试（内核每小时叫）：登录没通过的账号用存着的地址、密码再登录一次（不碰邮件），过了就清掉 */
  recheck(ctx: DataSourceRecheckContext): Promise<void>;
  /** 导入的有几封（有正文的那些，全部账号） */
  sentCount(): number;
  /** 断开时的清理：记着的登录没通过清掉（密钥区那一格、导入的由内核删） */
  disconnect(): void;
  /** 断开一个账号：只删它的密钥、清掉它记着的状态，交回哪些记录归它；没有这个账号抛 GmailProblem */
  disconnectAccount(id: string, ctx: DataSourceContext): { owns(event: StoredEvent): boolean };
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

/** 邮件编号：哪个账号、在哪个邮箱、UIDVALIDITY、UID（几个账号的 UID 会撞，要带账号） */
const idOf = (account: string, box: GmailBox, uidValidity: number, uid: number) => `${account}.${box}-${uidValidity}-${uid}`;
/** 账号那一段可以没有：这之前搜到的老编号（只有一个账号开着时才认） */
export const GMAIL_ID = /^(?:(a[0-9a-f]{10})\.)?(all|inbox|sent)-(\d+)-(\d+)$/;

/** 给外面看的样子：不带密码 */
const infoOf = (account: GmailAccount): GmailAccountInfo => ({ id: account.id, address: account.address, label: maskId(account.address), enabled: account.enabled });
/** 几个账号时，出错原因前面写是谁的（打了码的：内核会把这一格里的完整邮箱换成 ***） */
const whose = (account: GmailAccount | GmailAccountInfo, reason: string) => t("google.gmail.accountFailed", { account: maskId(account.address), reason });
/** 几个账号的出错原因连成一句；只有一个账号时只写原因 */
const joined = (failures: ReadonlyArray<{ account: GmailAccount | GmailAccountInfo; reason: string }>, many: boolean) => failures.map(({ account, reason }) => (many ? whose(account, reason) : reason)).join(t("google.gmail.failedSep"));

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

/** 填设置没过 */
const failed = (problem: string): DataSourceStatus => ({ connection: "error", problem });

/** 按用户（或者模型）写的认一个账号：账号 id、完整地址、打了码的邮箱，都不是的看是不是地址的一部分；认不出、认出几个都写明有哪几个（打了码的和编号） */
function pick(accounts: readonly GmailAccount[], text: string): GmailAccount {
  const wanted = text.trim().toLowerCase();
  const exact = accounts.filter((a) => a.id === wanted || a.address.toLowerCase() === wanted || maskId(a.address).toLowerCase() === wanted);
  const found = exact.length > 0 ? exact : accounts.filter((a) => wanted !== "" && a.address.toLowerCase().includes(wanted));
  if (found.length === 1) return found[0]!;
  const names = accounts.map((a) => t("google.gmail.accountWithId", { account: maskId(a.address), id: a.id })).join(t("google.calendar.listSep"));
  throw new GmailProblem(t(found.length === 0 ? "google.gmail.error.noSuchAccount" : "google.gmail.error.ambiguousAccount", { accounts: names }));
}

/** 这次查哪几个账号：指定了的那一个（关着的写明），不指定是全部开着的 */
function targets(ctx: DataSourceContext, selector: string | undefined): GmailAccount[] {
  const accounts = accountsIn(ctx.secrets);
  if (accounts.length === 0) throw new GmailProblem(t("google.gmail.error.notConfigured"));
  if (selector === undefined || selector.trim() === "") {
    const on = accounts.filter((a) => a.enabled);
    if (on.length === 0) throw new GmailProblem(t("google.gmail.allOff"));
    return on;
  }
  const account = pick(accounts, selector);
  if (!account.enabled) throw new GmailProblem(t("google.gmail.error.accountOff", { account: maskId(account.address) }));
  return [account];
}

/** 记录是谁的：写了账号的是那个账号，没写的（转过来之前导的）归 legacy */
const ownerOf = (payload: { account?: string }, legacy: string | undefined) => payload.account ?? legacy;

export function createGmail(options: GmailOptions): GmailService {
  const { store, log } = options;
  const endpoint = options.endpoint ?? GMAIL_IMAP;
  const timeoutMs = options.timeoutMs ?? 30_000;
  /** 哪个账号上次登录没通过、原因（重启就没了；下次登录过了清掉） */
  const authProblems = new Map<string, string>();

  /** 现连、现登录，做完退出；出错换成给人看的原因（登录没通过的记下来） */
  const withSession = async <T>(creds: { address: string; password: string }, signal: AbortSignal | undefined, fn: (imap: ImapSession) => Promise<T>): Promise<T> => {
    const id = accountIdOf(creds.address);
    let imap: ImapSession | undefined;
    try {
      imap = await connectImap({ ...endpoint, timeoutMs, ...(signal ? { signal } : {}) });
      await imap.login(creds.address, creds.password);
      authProblems.delete(id);
      return await fn(imap);
    } catch (err) {
      const problem = problemOf(err, timeoutMs);
      if (problem instanceof GmailProblem && problem.auth) {
        authProblems.set(id, problem.message);
        log(`Gmail 登录没通过（${maskId(creds.address)}）`);
      }
      throw problem;
    } finally {
      await imap?.logout();
    }
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

  const status = (ctx: DataSourceContext): DataSourceStatus => {
    const accounts = accountsIn(ctx.secrets);
    if (accounts.length === 0) return { connection: "not_connected" };
    const legacy = legacyOwnerOf(ctx.secrets);
    const { sent } = imported();
    const items: DataSourceItem[] = accounts.map((a) => {
      const count = sent.filter((p) => ownerOf(p, legacy) === a.id).length;
      const problem = a.enabled ? authProblems.get(a.id) : undefined;
      const state = t(!a.enabled ? "google.gmail.state.off" : problem === undefined ? "google.gmail.state.on" : "google.gmail.state.auth");
      return {
        id: a.id,
        title: a.address,
        detail: t("google.gmail.itemDetail", { state, count, n: count }),
        ...(problem === undefined ? {} : { problem }),
        count,
        ...(a.enabled ? {} : { off: true as const }),
        removable: true as const,
      };
    });
    const account = accounts.map((a) => a.address).join(t("google.calendar.listSep"));
    // 整个断开（页面下面那个按钮）的确认框写明是全部：只想断开一个，点那个账号的
    const disconnectNote = accounts.length > 1 ? { disconnectNote: t("google.gmail.disconnectAllNote", { n: accounts.length }) } : {};
    const on = accounts.filter((a) => a.enabled);
    if (on.length === 0) return { connection: "not_connected", account, items, note: t("google.gmail.allOff"), ...disconnectNote };
    const broken = on.filter((a) => authProblems.has(a.id));
    if (broken.length === on.length) {
      const problem = broken.length === 1 ? authProblems.get(broken[0]!.id)! : t("google.gmail.allFailed", { n: broken.length });
      return { connection: "error", problem, account, items, needsAuth: true, ...disconnectNote };
    }
    return { connection: "connected", account, items, ...(broken.length > 0 ? { needsAuth: true } : {}), ...disconnectNote };
  };

  /** 测试连接：登录、找得到邮箱（不碰任何邮件） */
  const probe = (creds: { address: string; password: string }, signal?: AbortSignal) => withSession(creds, signal, async (imap) => void (await imap.list()));

  const configure = async (values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus> => {
    const saved = accountsIn(ctx.secrets);
    // 开关一个账号（不连网）
    if (values.account !== undefined) {
      const target = saved.find((a) => a.id === values.account);
      if (!target) return failed(t("google.gmail.error.accountGone"));
      // 还没转过来的那一条（迁移没成）：先存成正式的一条，开关才有地方放
      saveAccount(ctx.secrets, target);
      setAccountEnabled(ctx.secrets, target.id, values.enabled !== "off");
      if (values.enabled === "off") authProblems.delete(target.id);
      ctx.log(`Gmail 账号${values.enabled === "off" ? "关了" : "开了"}（${maskId(target.address)}）`);
      return status(ctx);
    }
    const typedAddress = (values.address ?? "").trim();
    const typed = (values.password ?? "").replace(/\s+/g, "");
    // 什么都不填：用存着的把开着的账号再测一次（登录没通过的 withSession 记下、页面上那个账号下面写着；别的原因这里说）
    if (typedAddress === "" && typed === "") {
      if (saved.length === 0) return failed(t("google.gmail.address.empty"));
      const on = saved.filter((a) => a.enabled);
      const failures: Array<{ account: GmailAccount; reason: string }> = [];
      await Promise.all(
        on.map(async (account) => {
          try {
            await probe(account);
          } catch (err) {
            if (!(err instanceof GmailProblem && err.auth)) failures.push({ account, reason: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
      return failures.length > 0 ? failed(joined(failures, on.length > 1)) : status(ctx);
    }
    // 只填了密码：只有一个账号时是换它的（几个账号时不知道换谁的，要写地址）
    const address = typedAddress || (saved.length === 1 ? saved[0]!.address : "");
    if (address === "") return failed(t("google.gmail.address.empty"));
    if (!EMAIL.test(address)) return failed(t("google.gmail.address.bad"));
    const id = accountIdOf(address);
    const existing = saved.find((a) => a.id === id);
    const password = typed || existing?.password || "";
    if (password === "") return failed(t("google.gmail.password.empty"));
    const before = authProblems.get(id);
    try {
      await probe({ address, password });
    } catch (err) {
      // 填的这一份没过：存着的那份照旧（原因由内核写在出错那一行）；别的账号不动
      if (before === undefined) authProblems.delete(id);
      else authProblems.set(id, before);
      return failed(err instanceof Error ? err.message : String(err));
    }
    saveAccount(ctx.secrets, { address, password });
    authProblems.delete(id);
    ctx.log(`连上了 Gmail（${maskId(address)}）`);
    return status(ctx);
  };

  /** 在一个账号里搜 */
  const searchOne = (account: GmailAccount, query: GmailQuery, signal: AbortSignal | undefined): Promise<GmailAccountFound> =>
    withSession(account, signal, async (imap) => {
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
          return { id: idOf(account.id, where.box, box.uidValidity, f.uid), ...(date ? { date } : {}), from: p.from, to: p.to, subject: p.subject, ...(f.size === undefined ? {} : { size: f.size }) };
        })
        .toSorted((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
      return { account: infoOf(account), box: where.box, fellBack: where.fellBack, total: uids.length, messages };
    });

  const search = async (ctx: DataSourceContext, query: GmailQuery, signal?: AbortSignal): Promise<GmailSearchResult> => {
    const chosen = targets(ctx, query.account);
    const settled = await Promise.all(
      chosen.map(async (account): Promise<GmailAccountFound | GmailAccountFailed> => {
        try {
          return await searchOne(account, query, signal);
        } catch (err) {
          // 中止的（ImapError aborted）原样往外；别的是这个账号的事，不挡别的账号
          if (!(err instanceof GmailProblem)) throw err;
          return { account: infoOf(account), problem: err };
        }
      }),
    );
    const failures = settled.filter((one): one is GmailAccountFailed => one.problem !== undefined);
    // 全都没查成：抛出去（只有一个账号时就是它的原因）
    if (failures.length === settled.length) {
      if (failures.length === 1) throw failures[0]!.problem;
      throw new GmailProblem(
        joined(
          failures.map((f) => ({ account: f.account, reason: f.problem.message })),
          true,
        ),
        failures.every((f) => f.problem.auth),
      );
    }
    return { accounts: settled };
  };

  const read = async (ctx: DataSourceContext, id: string, signal?: AbortSignal, selector?: string): Promise<GmailMessage> => {
    const m = GMAIL_ID.exec(id.trim());
    if (!m) throw new GmailProblem(t("google.gmail.error.badId"));
    const [, accountId, which, validity, uidText] = m as unknown as [string, string | undefined, GmailBox, string, string];
    const accounts = accountsIn(ctx.secrets);
    if (accounts.length === 0) throw new GmailProblem(t("google.gmail.error.notConfigured"));
    let account: GmailAccount;
    if (accountId !== undefined) {
      // 编号里写着是谁的
      const found = accounts.find((a) => a.id === accountId);
      if (!found) throw new GmailProblem(t("google.gmail.error.accountGone"));
      if (!found.enabled) throw new GmailProblem(t("google.gmail.error.accountOff", { account: maskId(found.address) }));
      account = found;
    } else {
      // 老样子的编号：写明了账号的，或者只有一个账号开着的才认得
      const chosen = targets(ctx, selector);
      if (chosen.length !== 1) throw new GmailProblem(t("google.gmail.error.idNoAccount"));
      account = chosen[0]!;
    }
    return await withSession(account, signal, async (imap) => {
      const where = await mailboxOf(imap, which);
      const box = await imap.examine(where.name);
      if (box.uidValidity !== Number(validity)) throw new GmailProblem(t("google.gmail.error.stale"));
      const uid = Number(uidText);
      const [f] = await imap.fetch([uid], { size: true, internalDate: true, body: { maxBytes: READ_MAX_BYTES } });
      if (!f?.body || f.body.length === 0) throw new GmailProblem(t("google.gmail.error.notFound"));
      const parsed = parseMail(f.body);
      const date = parsed.date ?? internalDate(f.internalDate);
      const size = f.size ?? f.body.length;
      const own = new Set(accounts.map((a) => a.address.toLowerCase()));
      return {
        id: idOf(account.id, which, box.uidValidity, uid),
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
        mine: which === "sent" || parsed.from.some((a) => own.has(a.address.toLowerCase())),
        account: infoOf(account),
      };
    });
  };

  /** 导入一个账号发出的邮件：交回写了几封、还有几封没导 */
  const syncOne = (account: GmailAccount, legacy: string | undefined, ctx: DataSourceSyncContext): Promise<{ added: number; rest: number }> =>
    withSession(account, ctx.signal, async (imap) => {
      const where = await mailboxOf(imap, "sent");
      const box = await imap.examine(where.name);
      const { sent, cursors } = imported();
      const mine = (list: ReadonlyArray<{ account?: string; uidValidity: number; uid: number }>) => list.filter((p) => ownerOf(p, legacy) === account.id && p.uidValidity === box.uidValidity).map((p) => p.uid);
      const lastUid = Math.max(0, ...mine(sent), ...mine(cursors));
      // 同一封导过的不再导：这个账号导的，加上没写账号、谁也不归的（老版本断开过又连上：分不清是谁的，宁可不重复）
      const knownMessageIds = new Set(sent.filter((p) => p.account === undefined || p.account === account.id).flatMap((p) => (p.messageId ? [p.messageId] : [])));
      const since = isoDate(new Date(options.clock.now() - SENT_FIRST_DAYS * 86_400_000));
      const uids = lastUid > 0 ? await imap.search({ uidFrom: lastUid + 1 }) : await imap.search({ since });
      const batch = uids.slice(0, SENT_MAX_PER_SYNC);
      const fetched = await imap.fetch(batch, { internalDate: true, body: { maxBytes: SENT_MAX_BYTES } });
      const at = nowIso(new Date(options.clock.now()));
      const label = maskId(account.address);
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
            id: `${account.id}-${box.uidValidity}-${f.uid}`,
            account: account.id,
            accountLabel: label,
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
      if (maxSeen > maxWritten && maxSeen > lastUid) events.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_CURSOR, payload: { account: account.id, uidValidity: box.uidValidity, uid: maxSeen, at } satisfies GoogleGmailCursorPayload });
      if (events.length > 0) store.appendBatch(events);
      return { added: events.filter((e) => e.type === GOOGLE_GMAIL_SENT).length, rest: uids.length - batch.length };
    });

  const syncSent = async (ctx: DataSourceSyncContext): Promise<DataSourceSyncResult> => {
    const chosen = targets(ctx, undefined);
    const legacy = legacyOwnerOf(ctx.secrets);
    let added = 0;
    let rest = 0;
    const failures: Array<{ account: GmailAccount; reason: string }> = [];
    // 一个一个来（同一时间不开太多连接）；一个账号出错不挡别的，导到的照样写，这次同步算出错（和几个日历一样）
    for (const account of chosen) {
      if (ctx.signal.aborted) break;
      try {
        const one = await syncOne(account, legacy, ctx);
        added += one.added;
        rest += one.rest;
      } catch (err) {
        if (ctx.signal.aborted || !(err instanceof GmailProblem)) throw err;
        failures.push({ account, reason: err.message });
      }
    }
    if (failures.length > 0) throw new GmailProblem(joined(failures, chosen.length > 1));
    const summary = t("google.gmail.sync.summary", { count: added, n: added });
    if (rest > 0) ctx.log(`已发邮件还有 ${rest} 封没导，下次接着`);
    return { added, summary: rest > 0 ? t("google.gmail.sync.more", { summary, count: rest, n: rest }) : summary };
  };

  return {
    configured: (ctx) => accountsIn(ctx.secrets).some((a) => a.enabled),
    accounts: (ctx) => accountsIn(ctx.secrets).map(infoOf),
    status,
    configure,
    search,
    read,
    syncSent,
    async recheck(ctx) {
      for (const account of accountsIn(ctx.secrets)) {
        if (!account.enabled || !authProblems.has(account.id)) continue;
        try {
          // 登录过了 withSession 自己清掉；没过它记下（照旧出错）
          await probe(account, ctx.signal);
          ctx.log(`Gmail 又登录得上了（${maskId(account.address)}）`);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
        }
      }
    },
    sentCount: () => imported().sent.length,
    disconnect: () => {
      authProblems.clear();
    },
    disconnectAccount(id, ctx) {
      const account = accountsIn(ctx.secrets).find((a) => a.id === id);
      if (!account) throw new GmailProblem(t("google.gmail.error.accountGone"));
      // 先记下老记录归谁（断开转过来的那一条时，归属跟着删）
      const legacy = legacyOwnerOf(ctx.secrets);
      removeAccount(ctx.secrets, id);
      authProblems.delete(id);
      ctx.log(`断开了 Gmail 账号（${maskId(account.address)}）`);
      return { owns: (event) => ownerOf(event.payload as { account?: string }, legacy) === id };
    },
  };
}
