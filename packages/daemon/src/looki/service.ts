// Looki 插件的服务（296 号票）：数据源的几个函数（plugin.ts）经 ctx.active 现取它。
// - 连接状态：密钥区里有没有 Key；Key 不认了是"出错"（要重新填），限速了、新填的 Key 没通过（还在用原来的）是"连着"加一句原因；
//   账号写打码的邮箱和区域。状态只在内存里（重启后先当连着，下一次同步、按需查碰到了再标）；
// - 填设置、测试连接：选区域（中国区 / 海外，不填沿用存着的）、填 Key（不填沿用存着的）→ 拿 Key 调所选区域的 /me 读账号，
//   过了才把 Key、区域、打码的账号存进密钥区（ctx.secrets）；
// - 同步：拉到昨天为止的每一天（今天的时刻还在变，过完这一天再导入；当天的记忆整理也不读）——第一次拉最近 7 天，以后从上次同步那天往前两天
//   拉起（补上传晚了的），最多往前 14 天；每天 GET /moments?on_date，日记一次 GET /journals（日记回的不对只记日志、不耽误时刻）；按 Looki 的 id 去重（彻底删除改写过的照样算导入过，
//   断开并删以后重连会重新导入）；限速了等（Retry-After，没有就 60 秒）再试，最多两次；
// - 按需查（给秘书的工具，tools.ts 写成给模型看的文字）：按日期（最多 7 天，可加时间段）列出时刻，按关键词搜；只读、现查不存；
//   限速了不等，直接回"过一分钟再查"。
// - 存一份到本地（307 号票，archive.ts）：同步拉到的这几天的时刻、日记交给它排队存照片、日记、vlog（不等它），设置、补存经填设置
//   （values.archive）交给它，连接状态里带它那一块（panel）和断开时要说的一句；断开时它停下（存下的文件不删）。
// Key 只经密钥区读写，不进日志、事件、出错原因（出错原因由 client.ts 写，里面不带 Key；内核记下之前还会再换一遍 ***）。
import { t } from "@ergo/protocol";
import type { DataSourceSecrets, DataSourceStatus, DataSourceSyncContext, DataSourceSyncResult } from "../data-sources/api.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type Clock, clockIso } from "../scheduler/clock.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_REGIONS, type LookiJournalPayload, type LookiMomentPayload, type LookiRegion } from "./api.ts";
import { createLookiArchive, type LookiArchiveOptions } from "./archive.ts";
import { createLookiClient, LOOKI_RATE_LIMIT_WAIT_MS, LookiError } from "./client.ts";
import { addDays, daysBetween, journalRecords, localDay, momentRecord } from "./records.ts";

/** 第一次同步拉最近几天 */
export const FIRST_SYNC_DAYS = 7;
/** 以后每次从上次同步那天往前几天拉起（补上传晚了的） */
export const RECHECK_DAYS = 2;
/** 最多往前拉几天 */
export const MAX_BACK_DAYS = 14;
/** 按需查一次最多几天 */
export const QUERY_MAX_DAYS = 7;
/** 同步时限速了最多再试几次 */
const RATE_LIMIT_RETRIES = 2;

/** 密钥区里那一格的几项 */
const SECRET = { key: "key", region: "region", account: "account" } as const;

export interface LookiServiceOptions {
  store: EventStore;
  clock: Clock;
  /** 两个区域的接口地址 */
  endpoints: Readonly<Record<LookiRegion, string>>;
  /** 限速了等多久（毫秒）；不给按 Retry-After，没有就 60 秒（测试调短） */
  rateLimitWaitMs?: number;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
  /** 存一份到本地（307 号票，archive.ts）：设置文件、索引目录、数据目录、默认位置（测试另给磁盘剩余空间、下载） */
  archive: Pick<LookiArchiveOptions, "settingsFile" | "stateDir" | "dataDir" | "defaultFolder" | "freeSpace" | "download">;
  log(line: string): void;
}

/** 按需查的参数（工具里校验过的） */
export interface LookiQuery {
  /** 日期范围（含两头）；有关键词时可以不给 */
  from?: string;
  to?: string;
  /** 时间段（HH:mm），只在按日期列出时用 */
  after?: string;
  before?: string;
  keyword?: string;
}

/** 按需查的结果 */
export interface LookiQueryResult {
  moments: LookiMomentPayload[];
  /** 只查一整天时顺带那天的日记 */
  journals: LookiJournalPayload[];
}

export interface LookiService {
  status(secrets: DataSourceSecrets): DataSourceStatus;
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  sync(ctx: DataSourceSyncContext): Promise<DataSourceSyncResult>;
  /** 出错后再试（306 号票，内核每小时叫）：Key 不认的，拿存着的 Key 调一次 /me，认了就清掉出错 */
  recheck(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  query(query: LookiQuery, secrets: DataSourceSecrets, signal?: AbortSignal): Promise<LookiQueryResult>;
  /** 断开：忘掉内存里的状态，正在存到本地的、补存的停下（存下的文件不删） */
  reset(): Promise<void>;
  /** 今天（本机的日期，YYYY-MM-DD） */
  today(): string;
  /** 存到本地的位置（建好的；307 号票，数据源页"在电脑上打开"）：建不了抛错，原因给人看 */
  localFolder(): string;
  /** 停用插件时：正在存的停下、等它停 */
  stop(): Promise<void>;
  /** 正在存到本地的做完（测试用） */
  whenIdle(): Promise<void>;
}

/** 内存里的问题：Key 不认了（出错）、限速了（到点之前）、新填的 Key 没通过（还在用原来的） */
type Problem = { kind: "key"; text: string } | { kind: "rate_limit"; text: string; until: number } | { kind: "configure"; text: string };

const isRegion = (v: string | undefined): v is LookiRegion => v !== undefined && (LOOKI_REGIONS as readonly string[]).includes(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 存着的区域（没有是中国区） */
function regionOf(secrets: DataSourceSecrets): LookiRegion {
  const saved = secrets.get(SECRET.region);
  return isRegion(saved) ? saved : "cn";
}

/** 账号那一行：打码的账号和区域（d***@example.com（中国区）），没存账号只写区域 */
function accountOf(secrets: DataSourceSecrets): string {
  const region = t(`looki.region.${regionOf(secrets)}`);
  const account = secrets.get(SECRET.account);
  return account === undefined ? region : t("looki.account", { account, region });
}

/** 账号打码：邮箱留第一个字和域名（d***@example.com），没有邮箱留名字的第一个字 */
export function maskedAccount(me: unknown): string | undefined {
  if (!isRecord(me)) return undefined;
  const email = typeof me.email === "string" ? me.email.trim() : "";
  const at = email.indexOf("@");
  if (at > 0) return `${email[0]}***${email.slice(at)}`;
  const name = typeof me.name === "string" ? me.name.trim() : "";
  return name.length > 0 ? `${[...name][0]}**` : undefined;
}

/** 等一会儿（中止了就不等了） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLookiService(options: LookiServiceOptions): LookiService {
  const { store, clock, log } = options;
  let problem: Problem | undefined;

  const currentProblem = (): Problem | undefined => {
    if (problem?.kind === "rate_limit" && Date.now() >= problem.until) problem = undefined;
    return problem;
  };
  const clientOf = (secrets: DataSourceSecrets, signal?: AbortSignal) => {
    const key = secrets.get(SECRET.key);
    if (key === undefined) throw new LookiError("no_key", t("looki.error.noKey"));
    return createLookiClient({ base: options.endpoints[regionOf(secrets)], key, ...(signal ? { signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  };
  /** 碰到的错记成状态：Key 不认了、限速了 */
  const note = (err: unknown) => {
    if (!(err instanceof LookiError)) return;
    if (err.failure === "key") problem = { kind: "key", text: t("looki.problem.key") };
    if (err.failure === "rate_limit") problem = { kind: "rate_limit", text: t("looki.problem.rateLimit"), until: Date.now() + (err.retryAfterMs ?? LOOKI_RATE_LIMIT_WAIT_MS) };
  };

  // 存一份到本地（307 号票）：同步完把这几天交给它排队存；用同一套 Key、同一个地址
  const archive = createLookiArchive({
    ...options.archive,
    now: () => clockIso(clock),
    today: () => localDay(clock.now()),
    client: (secrets, signal) => clientOf(secrets, signal),
    noteApiError: note,
    ...(options.rateLimitWaitMs === undefined ? {} : { rateLimitWaitMs: options.rateLimitWaitMs }),
    log,
  });

  /** 同步时调一次：限速了等一会儿再试（最多 RATE_LIMIT_RETRIES 次），等的时候状态写"限速了，等一会儿接着来" */
  const patiently = async <T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LookiError && err.failure === "rate_limit" && attempt < RATE_LIMIT_RETRIES) {
          const wait = options.rateLimitWaitMs ?? err.retryAfterMs ?? LOOKI_RATE_LIMIT_WAIT_MS;
          problem = { kind: "rate_limit", text: t("looki.problem.rateLimitWaiting"), until: Date.now() + wait };
          log(`Looki 限速了，等 ${Math.ceil(wait / 1000)} 秒再试`);
          await sleep(wait, signal);
          continue;
        }
        note(err);
        throw err;
      }
    }
  };

  /**
   * 日记拉不成不耽误时刻：官方文档没写清 /journals 的参数和分组，回的不对（别的 4xx、格式不对）时只记日志、当没有日记；
   * Key 不认、限速、连不上、那边出错照样抛
   */
  const journalsOrNone = async (fn: () => Promise<unknown[]>): Promise<unknown[]> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LookiError && err.failure === "response") {
        log(`Looki 的日记没拉成（当没有日记）：${err.message}`);
        return [];
      }
      throw err;
    }
  };

  /** 已经导入过的（还没删掉的记录；彻底删除改写过的也算） */
  const imported = () => {
    const moments = new Set<string>();
    const journals = new Set<string>();
    for (const event of store.read(LOOKI_CHANNEL)) {
      const p = event.payload as Partial<LookiMomentPayload & LookiJournalPayload>;
      if (event.type === LOOKI_MOMENT && typeof p.momentId === "string") moments.add(p.momentId);
      if (event.type === LOOKI_JOURNAL && typeof p.journalId === "string") journals.add(p.journalId);
    }
    return { moments, journals };
  };

  const status = (secrets: DataSourceSecrets): DataSourceStatus => {
    // 存一份到本地那一块（没连也画：位置、几类可以先设好）；断开时说一句存下的文件不删
    const keepNote = archive.disconnectNote();
    const local = { panel: archive.view(), ...(keepNote === undefined ? {} : { disconnectNote: keepNote }) };
    if (!secrets.has(SECRET.key)) return { connection: "not_connected", ...local };
    const account = accountOf(secrets);
    const p = currentProblem();
    if (p?.kind === "key") return { connection: "error", problem: p.text, account, ...local };
    return { connection: "connected", ...(p ? { problem: p.text } : {}), account, ...local };
  };

  return {
    status,

    async recheck(secrets, signal) {
      if (!secrets.has(SECRET.key) || currentProblem()?.kind !== "key") return;
      try {
        await clientOf(secrets, signal).me();
        problem = undefined;
        log("Looki 又认存着的 Key 了（出错后每小时再试一次时）");
      } catch (err) {
        if (signal.aborted) throw err;
        note(err);
      }
    },

    async configure(values, secrets) {
      // 存一份到本地那一块的设置、补存（307 号票）：不碰 Key、不测连接；做不成的原因在那一块里写
      if (values.archive !== undefined) {
        archive.configure(values, secrets);
        return status(secrets);
      }
      const asked = values.region?.trim();
      if (asked !== undefined && asked !== "" && !isRegion(asked)) return { connection: "error", problem: t("looki.configure.badRegion") };
      const region: LookiRegion = isRegion(asked) ? asked : regionOf(secrets);
      const typed = values.key?.trim() ?? "";
      const saved = secrets.get(SECRET.key);
      const key = typed !== "" ? typed : (saved ?? "");
      if (key === "") return { connection: "error", problem: t("looki.configure.noKey") };
      if (/\s/.test(key)) return { connection: "error", problem: t("looki.configure.badKey") };
      const base = options.endpoints[region];
      const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
      try {
        // 拿 Key 调所选区域的 /me 一步判断（Key 只发给写死的这两个地址之一）
        const me = await createLookiClient({ base, key, ...timeout }).me();
        secrets.set(SECRET.key, key);
        secrets.set(SECRET.region, region);
        const account = maskedAccount(me);
        if (account === undefined) secrets.delete(SECRET.account);
        else secrets.set(SECRET.account, account);
        problem = undefined;
        log(`连上了 Looki（${region}）`);
        return status(secrets);
      } catch (err) {
        const reason = err instanceof LookiError ? (err.failure === "key" ? t("looki.configure.keyRefused") : err.message) : err instanceof Error ? err.message : String(err);
        log(`测试连接没过（${region}）：${err instanceof LookiError ? err.failure : "error"}`);
        if (saved === undefined) return { connection: "error", problem: reason };
        // 原来连着：沿用的就是存着的 Key 又不认了，是 Key 失效（出错，要重新填）；新填的没通过，还在用原来的（连着，写一句原因）
        const sameKey = typed === "" || typed === saved;
        if (sameKey && err instanceof LookiError && err.failure === "key") problem = { kind: "key", text: t("looki.problem.key") };
        else problem = { kind: "configure", text: sameKey ? reason : t("looki.configure.keptOld", { reason }) };
        return status(secrets);
      }
    },

    async sync(ctx) {
      const client = clientOf(ctx.secrets, ctx.signal);
      const today = localDay(clock.now());
      const yesterday = addDays(today, -1);
      const earliest = addDays(yesterday, -(MAX_BACK_DAYS - 1));
      const start = ctx.lastSyncAt === undefined ? addDays(yesterday, -(FIRST_SYNC_DAYS - 1)) : addDays(ctx.lastSyncAt.slice(0, 10), -RECHECK_DAYS);
      const first = start < earliest ? earliest : start;
      const days = daysBetween(first, yesterday);
      const known = imported();
      let added = 0;
      /** 读不出来的（没有 id、没有开始时间、一个字都没有）：只记个数，真机核对回包格式用 */
      let unreadable = 0;
      const write = (events: NewEvent[]) => {
        if (events.length === 0) return;
        store.appendBatch(events);
        added += events.length;
      };
      /** 这几天的时刻、日记（不管导入过没有：存一份到本地按自己的索引去重） */
      const pulled: Array<{ date: string; moments: LookiMomentPayload[] }> = [];
      const pulledJournals: LookiJournalPayload[] = [];
      for (const day of days) {
        const list = await patiently(() => client.moments(day), ctx.signal);
        const events: NewEvent[] = [];
        const moments: LookiMomentPayload[] = [];
        for (const raw of list) {
          const record = momentRecord(raw);
          if (!record) {
            unreadable += 1;
            continue;
          }
          moments.push(record);
          if (known.moments.has(record.momentId)) continue;
          known.moments.add(record.momentId);
          events.push({ channel: LOOKI_CHANNEL, type: LOOKI_MOMENT, payload: record });
        }
        pulled.push({ date: day, moments });
        write(events);
      }
      if (days.length > 0) {
        const groups = await journalsOrNone(() => patiently(() => client.journals(yesterday, days.length), ctx.signal));
        const events: NewEvent[] = [];
        const records = journalRecords(groups);
        if (records.length === 0 && groups.length > 0) unreadable += groups.length;
        for (const record of records) {
          if (record.date < first || record.date > yesterday) continue;
          pulledJournals.push(record);
          if (known.journals.has(record.journalId)) continue;
          known.journals.add(record.journalId);
          events.push({ channel: LOOKI_CHANNEL, type: LOOKI_JOURNAL, payload: record });
        }
        write(events);
        // 存一份到本地：排上队、不等它（照片、vlog 可能要下很久；同步这边导入完就交回）
        archive.afterSync({ secrets: ctx.secrets, days: pulled, journals: pulledJournals, from: first, to: yesterday });
      }
      // 走通了：Key 认、没在限速
      problem = undefined;
      log(`同步了 ${days.length} 天（${days[0] ?? "-"} 到 ${days.at(-1) ?? "-"}），新进来 ${added} 条${unreadable > 0 ? `，读不出来的 ${unreadable} 条` : ""}`);
      return { added };
    },

    async query(query, secrets, signal) {
      const p = currentProblem();
      if (p?.kind === "rate_limit") throw new LookiError("rate_limit", p.text, Math.max(0, p.until - Date.now()));
      const client = clientOf(secrets, signal);
      try {
        if (query.keyword !== undefined) {
          const list = await client.search(query.keyword, { ...(query.from ? { start: query.from } : {}), ...(query.to ? { end: query.to } : {}) });
          // Key 又认了
          if (problem?.kind === "key") problem = undefined;
          return { moments: list.flatMap((raw) => momentRecord(raw) ?? []), journals: [] };
        }
        const from = query.from ?? localDay(clock.now());
        const to = query.to ?? from;
        const moments: LookiMomentPayload[] = [];
        for (const day of daysBetween(from, to).slice(0, QUERY_MAX_DAYS)) moments.push(...(await client.moments(day)).flatMap((raw) => momentRecord(raw) ?? []));
        // 只查一整天：顺带那天的日记
        const journals = from === to && query.after === undefined && query.before === undefined ? journalRecords(await journalsOrNone(() => client.journals(from, 1))).filter((j) => j.date === from) : [];
        if (problem?.kind === "key") problem = undefined;
        return { moments, journals };
      } catch (err) {
        note(err);
        throw err;
      }
    },

    async reset() {
      problem = undefined;
      await archive.cancel();
    },

    today: () => localDay(clock.now()),

    localFolder: () => archive.folder(),

    stop: () => archive.cancel(),

    whenIdle: () => archive.whenIdle(),
  };
}
