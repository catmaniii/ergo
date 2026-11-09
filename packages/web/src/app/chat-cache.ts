// 手机本机存的聊天记录（457），页面这一半：存在这台设备的 IndexedDB 里（chat-cache-idb.ts，单独一个库，和本机快照那份不混），
// 存什么、怎么拼一页见 state/chat-cache.ts。
// - 往上翻（store.tsx 的 loadOlder）：本机有盖住 before 之前的那一段就拼一页交回（马上出来，没网也能看）；没有、拼不出、信不过
//   就交回没有，照旧向电脑要，要来的那一页记下（keep）。
// - 记下：连接交给状态层的每一样先给这里看一眼（note）：会话频道上的消息、时间线记录、阶段记号、语音对象（补发的最近一页、实时的）
//   照收到的存；向电脑要来的一页存下，连同它给的那一段。攒着等闲下来（最后一次变化之后 1 秒，最多攒 5 秒）写，切到后台、关页面、
//   要作废时马上写。一次写一个事务。
// - 信不信得过（宁可多向电脑要一次，也不能显示错的历史）：每个会话记一个 through——这个序号之前会话频道上的事件（彻底删除、
//   会话树换了、语音对象新的版本）本机都照着改过了。这次打开要能一条不漏地接上：订阅带着游标 c 的（热打开），c ≤ through 才用；
//   游标 0 的（冷打开、网页换了一版），守护进程从最近一页的开头 S 起补，S ≤ through + 1 才用（中间那截没看到的事件里可能有
//   彻底删除）。信不过的这个会话整个删掉，从这次收到的起重新存。之后这次打开里收到的一条不漏，through 跟着往后。
// - 作废：
//   · 会话树换了（session_branch）：本机各段截到两棵树当前路径开始不一样的序号之前（这次一条不漏收到的那一段照旧算，什么树都对）；
//   · 有消息被彻底删除（messages_purged）、移除插件时连数据删了（plugin_data_purged）、订阅回 resync（数据目录恢复过）：整份作废；
//   · 删任务、删项目时负责人的会话整个删了：这个会话删掉；
//   · 协议版本、存的格式变了：打开时整份删掉；
//   · 设备被吊销、回到配对页：整份删掉（clear），之后这个页面上不再存。
// - 上限（默认 50 MB，按存进去的 JSON 的字节算）：写完超了就按"最久没用过"（往上翻、收到新消息、存下一页都算用过）整个会话删，
//   删到上限的八成。正在用的那个也超了就连它一起删，从头再存。
// - 几个标签页（鸿蒙 App 的浏览侧边栏也是一个）各记各的：每个会话的那一份带一个版本号（rev），写的时候本机存着的不是自己上次写的
//   那一版（别的标签页改过、删过）就不写、这次打开不再存这个会话；读的时候也核对，对不上当没有。
// - 读写都包着：读坏了、存不了（隐私模式、站点数据被清、存满了）就当没有，照现在的走（向电脑要），这个页面不再存。
import {
  cacheEntriesOfPage,
  cacheEntryOf,
  type CachedRead,
  type CachedSpan,
  cachedPage,
  CHAT_CACHE_FORMAT,
  type ChatCacheEntry,
  chatCacheSignalOf,
  type ConversationBranches,
  type EventFrame,
  HISTORY_PAGE_SIZE,
  type HistoryMessage,
  type HistoryPage,
  isConversationChannel,
  isEphemeralEventType,
  isReplayPinType,
  jsonBytes,
  MAX_HISTORY_LIMIT,
  onPathOf,
  pathDivergence,
  sameTree,
  spanAt,
  spanOfPage,
  spansBefore,
  cachedToolVoices,
  absentRefsOf,
  type UiInput,
  voiceIdsToRead,
  withSpan,
} from "../state/index.ts";

/** 一个会话存着的那一份的说明（条目另存） */
export interface ChatCacheMeta {
  readonly conversation: string;
  /** 这一版（写一次换一个）：几个标签页之间核对 */
  readonly rev: string;
  /** 这个序号之前会话频道上的事件本机都照着改过了 */
  readonly through: number;
  /** 各段是按哪棵会话树说的（没回退过的没有） */
  readonly tree?: ConversationBranches;
  readonly spans: readonly CachedSpan[];
  /** 知道本来就没有的语音（v:、a:、c: 开头，见 state/chat-cache.ts 的 absentRefsOf） */
  readonly absent: readonly string[];
  /** 发语音的调用建出的 agent 语音：调用 id → 语音 id */
  readonly toolVoices: Readonly<Record<string, string>>;
  /** 最近一次用（往上翻、收到新消息、存下一页）的时刻（毫秒） */
  readonly usedAt: number;
  /** 存了多少字节、多少条消息（后端写的时候算） */
  readonly bytes: number;
  readonly count: number;
}

/** 整份的说明：格式、协议版本、处理过的最后一条"移除插件时连数据删"在插件频道上的序号 */
export interface ChatCacheGlobal {
  readonly format: number;
  readonly protocolVersion: number;
  readonly pluginPurgeSeq: number;
}

/** 存进去的一条，带着它的字节数 */
export type ChatCachePut = ChatCacheEntry & { readonly bytes: number };

/** 一次写里一个会话的那一份 */
export interface ConversationWrite {
  readonly conversation: string;
  /** 本机存着的得是这一版（没有是 null）才写；force 不管（整个删掉重来、整个删掉） */
  readonly expect: string | null;
  readonly force?: boolean;
  /** 先把存着的条目全删掉 */
  readonly wipe?: boolean;
  /** 再写这些（消息、记录、阶段记号已有的不动；语音对象版本新的才盖） */
  readonly puts: readonly ChatCachePut[];
  /** 最后写说明（bytes、count 由后端按实际算）；null 是连说明一起删掉 */
  readonly meta: Omit<ChatCacheMeta, "bytes" | "count"> | null;
}

/** 一个会话写得怎样：版本对不上的没写（ok 为 false） */
export interface ConversationWriteResult {
  readonly conversation: string;
  readonly ok: boolean;
  readonly bytes: number;
  readonly count: number;
}

/** 拼一页要读的 */
export interface PageQuery {
  readonly conversation: string;
  /** 存着的说明得是这一版，否则当没有 */
  readonly rev: string;
  readonly lo: number;
  readonly before: number;
  readonly limit: number;
  /** 当前分支上的 */
  readonly keep: (seq: number) => boolean;
  /** 读完消息之后要读哪些语音对象 */
  readonly voiceIds: (messages: readonly HistoryMessage[]) => { voices: readonly string[]; agentVoices: readonly string[] };
}

/** 存本机聊天记录的地方（测试换成假的） */
export interface ChatCacheBackend {
  /** 存着的全部说明；用不了（没有 IndexedDB、打不开）是 undefined */
  load(): Promise<{ readonly global?: unknown; readonly metas: readonly unknown[] } | undefined>;
  /** 一次写，一个事务（要么都写进去、要么都没写；版本对不上的会话跳过）；没写成拒绝 */
  write(writes: readonly ConversationWrite[], global?: ChatCacheGlobal): Promise<readonly ConversationWriteResult[]>;
  /** 一个事务里读：说明的版本对上了才读；对不上、读不了是 undefined */
  readPage(query: PageQuery): Promise<CachedRead | undefined>;
  /** 全删 */
  clear(): Promise<void>;
}

/** Debug 工具集"连接"里那一行：存了几个会话、多少条消息、多少字节、上限；存不了是 off */
export type ChatCacheStats =
  | { readonly state: "off" }
  | { readonly state: "on"; readonly conversations: number; readonly messages: number; readonly bytes: number; readonly maxBytes: number };

export interface ChatCache {
  /** 连上之前：这次订阅带的游标、打开时先用的本机快照里各会话的会话树（热打开时本机存的从快照的游标接着） */
  begin(cursors: Readonly<Record<string, number>>, trees?: (conversation: string) => ConversationBranches | undefined): void;
  /** 连接交给状态层的每一样都先给这里看一眼 */
  note(input: UiInput): void;
  /** 往上翻：本机拼得出 before 之前的一页就交回；拼不出、信不过、读不了是 undefined（向电脑要）。tree 是界面上现在的会话树 */
  page(conversation: string, before: number, limit: number | undefined, tree: ConversationBranches | undefined): Promise<HistoryPage | undefined>;
  /** 向电脑要之前取一个记号：要的路上作废过就不存要来的 */
  ticket(conversation: string): number;
  /** 向电脑要来的一页：记下 */
  keep(conversation: string, before: number, page: HistoryPage, ticket: number): void;
  /** 攒着的马上写（切到后台、关页面时） */
  flush(): void;
  /** 全删（回到配对页）：之后这个页面上不再存 */
  clear(): Promise<void>;
  stats(): ChatCacheStats;
}

export interface ChatCacheOptions {
  readonly backend: ChatCacheBackend;
  readonly protocolVersion: number;
  /** 最多存多少字节 */
  readonly maxBytes?: number;
  /** 读说明最多等多久，过了这个页面不用 */
  readonly loadTimeoutMs?: number;
  /** 最后一次变化之后多久写、一直在变时最多攒多久 */
  readonly idleMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
}

/** 默认最多存 50 MB */
export const CHAT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
/** 超了删到上限的几成 */
const EVICT_TO = 0.8;
const LOAD_TIMEOUT_MS = 3000;
const IDLE_MS = 1000;
const MAX_WAIT_MS = 5000;
/** 知道本来就没有的语音最多记多少（多了丢掉旧的，大不了多向电脑要一次） */
const ABSENT_KEPT = 500;

/** 这次打开里一个会话频道收到的：订阅带的游标、一条不漏地收到了哪一段、信不信得过定了没有 */
interface Session {
  readonly c0: number;
  /** 收到的最后一条 */
  last: number;
  /** 一条不漏收到的这一段从哪条起（还没收到是 undefined：热打开时就是 c0 + 1） */
  runStart: number | undefined;
  /** 补发的那一页开始了（热打开一开始就是） */
  settled: boolean;
  decided: boolean;
  /** 信得过、正在照收到的存 */
  capturing: boolean;
  /** 定下来之前收到的，按先后 */
  buffer: EventFrame[];
  /** 热打开时快照里的会话树（从头存时用） */
  readonly tree0: ConversationBranches | undefined;
}

/** 一个会话在这个页面里 */
interface Conv {
  readonly id: string;
  /** 现在的样子（还没写进去的改动也在里面）；没有存着的是 undefined */
  meta: Omit<ChatCacheMeta, "rev"> | undefined;
  /** 本机存着的那一版（没有是 null） */
  rev: string | null;
  /**
   * 本机存着的那一份是什么样（上次写成的）：拼一页只按它来——还没写进去的不算，写的时候作废过（gen 变了）的不用，
   * 条目和说明是同一个事务写进去的，对得上
   */
  persisted: Persisted | undefined;
  /** 作废一次加一（要的路上作废过的不存；写成之前作废过的，存着的那份不用） */
  gen: number;
  /** 还没写的条目：键 → 条目（同一个语音对象留版本新的） */
  puts: Map<string, ChatCachePut>;
  /** 写之前先把存着的条目全删掉 */
  wipe: boolean;
  /** 整个删掉（连说明） */
  drop: boolean;
  dirty: boolean;
  /** 这次打开不再存（别的标签页改过、接不上） */
  off: boolean;
  session: Session | undefined;
}

type Meta = Omit<ChatCacheMeta, "rev">;

/** 写成了的那一份里拼一页要的 */
interface Persisted {
  readonly rev: string;
  /** 写的时候这个会话作废过几次 */
  readonly gen: number;
  readonly tree: ConversationBranches | undefined;
  readonly spans: readonly CachedSpan[];
  readonly absent: readonly string[];
  readonly toolVoices: Readonly<Record<string, string>>;
}

const persistedOf = (meta: Meta, rev: string, gen: number): Persisted => ({ rev, gen, tree: meta.tree, spans: meta.spans, absent: meta.absent, toolVoices: meta.toolVoices });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** 读出来的说明像样才用 */
function metaOf(raw: unknown): ChatCacheMeta | undefined {
  if (!isRecord(raw)) return undefined;
  const { conversation, rev, through, spans, absent, toolVoices, usedAt, bytes, count } = raw;
  if (typeof conversation !== "string" || !isConversationChannel(conversation) || typeof rev !== "string" || typeof through !== "number") return undefined;
  if (!Array.isArray(spans) || !spans.every((s) => isRecord(s) && typeof s.lo === "number" && typeof s.hi === "number" && typeof s.more === "boolean")) return undefined;
  if (!Array.isArray(absent) || !isRecord(toolVoices) || typeof usedAt !== "number" || typeof bytes !== "number" || typeof count !== "number") return undefined;
  return raw as unknown as ChatCacheMeta;
}

function globalOf(raw: unknown): ChatCacheGlobal | undefined {
  if (!isRecord(raw) || typeof raw.format !== "number" || typeof raw.protocolVersion !== "number" || typeof raw.pluginPurgeSeq !== "number") return undefined;
  return raw as unknown as ChatCacheGlobal;
}

const putKey = (e: ChatCacheEntry) => `${e.kind}:${String(e.key)}`;

/** 一个会话频道这次打开的开头：订阅带的游标（热打开的一开始就算补发开始了） */
const newSession = (c0: number, tree0: ConversationBranches | undefined): Session => ({ c0, last: c0, runStart: undefined, settled: c0 > 0, decided: false, capturing: false, buffer: [], tree0 });

function newRev(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 一样东西最多等多久，过了当没有 */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export function chatHistoryCache(options: ChatCacheOptions): ChatCache {
  const { backend, protocolVersion } = options;
  const maxBytes = options.maxBytes ?? CHAT_CACHE_MAX_BYTES;
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const now = options.now ?? (() => Date.now());

  /** 读完了没有、这个页面还存不存（存不了、清掉了的不再存也不用） */
  let ready = false;
  let broken = false;
  let cleared = false;
  let global: ChatCacheGlobal = { format: CHAT_CACHE_FORMAT, protocolVersion, pluginPurgeSeq: 0 };
  let globalDirty = false;
  const convs = new Map<string, Conv>();
  /** 读完之前交来的，读完了按先后过一遍 */
  const early: UiInput[] = [];
  let begun: { cursors: Readonly<Record<string, number>>; trees: (conversation: string) => ConversationBranches | undefined } | undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt = 0;
  let writing: Promise<void> | undefined;
  let again = false;

  const usable = () => ready && !broken && !cleared;

  const conv = (id: string): Conv => {
    let c = convs.get(id);
    if (!c) {
      c = { id, meta: undefined, rev: null, persisted: undefined, gen: 0, puts: new Map(), wipe: false, drop: false, dirty: false, off: false, session: undefined };
      convs.set(id, c);
    }
    return c;
  };

  const freshMeta = (conversation: string, through: number, tree: ConversationBranches | undefined): Meta => ({
    conversation,
    through,
    ...(tree === undefined ? {} : { tree }),
    spans: [],
    absent: [],
    toolVoices: {},
    usedAt: now(),
    bytes: 0,
    count: 0,
  });

  // ───────── 读 ─────────

  const loaded: Promise<void> = (async () => {
    const stored = await within(backend.load(), options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
    if (stored === undefined) {
      broken = true;
      return;
    }
    const g = globalOf(stored.global);
    if (g === undefined || g.format !== CHAT_CACHE_FORMAT || g.protocolVersion !== protocolVersion) {
      // 协议、格式变了（或者头一回）：整份删掉重来
      if (stored.metas.length > 0 || stored.global !== undefined) {
        try {
          await backend.clear();
        } catch {
          broken = true;
          return;
        }
      }
      globalDirty = true;
    } else {
      global = g;
      for (const raw of stored.metas) {
        const meta = metaOf(raw);
        if (!meta) continue;
        const c = conv(meta.conversation);
        const { rev, ...rest } = meta;
        c.meta = rest;
        c.rev = rev;
        c.persisted = persistedOf(rest, rev, c.gen);
      }
    }
  })().then(
    () => {
      if (broken || cleared) return;
      ready = true;
      if (begun) startSessions(begun);
      for (const input of early.splice(0)) process(input);
    },
    () => {
      broken = true;
    },
  );

  // ───────── 记 ─────────

  const startSessions = (b: NonNullable<typeof begun>): void => {
    for (const [channel, cursor] of Object.entries(b.cursors)) {
      if (!isConversationChannel(channel) || cursor <= 0) continue;
      const c = conv(channel);
      c.session = newSession(cursor, b.trees(channel));
      decide(c);
    }
  };

  const process = (input: UiInput): void => {
    if (input.kind === "batch") {
      for (const inner of input.inputs) process(inner);
      return;
    }
    if (input.kind === "resync") return onResync(input.channel);
    if (input.kind === "frame") onFrame(input.frame);
  };

  /** 订阅回 resync（守护进程那边数据目录恢复过）：整份作废，这个频道从头补发的从头记 */
  const onResync = (channel: string): void => {
    wipeAll();
    global = { ...global, pluginPurgeSeq: 0 };
    globalDirty = true;
    if (isConversationChannel(channel)) {
      // 这个频道的序号重新来过：存着的（连同刚定下的 through）都不算，补发的那一页重新定
      const c = conv(channel);
      if (c.meta || c.rev !== null) c.drop = true;
      c.meta = undefined;
      c.wipe = false;
      c.session = newSession(0, undefined);
    }
    schedule(0);
  };

  const onFrame = (frame: EventFrame): void => {
    if (isEphemeralEventType(frame.type)) return;
    const signal = chatCacheSignalOf(frame);
    if (signal?.kind === "plugin_purged" && frame.seq > global.pluginPurgeSeq) {
      wipeAll();
      global = { ...global, pluginPurgeSeq: frame.seq };
      globalDirty = true;
      schedule(0);
    }
    // 删任务、删项目时负责人的会话整个删了：存着的删掉，这次打开也不再存它（之后它上面只剩"已删除"标记）
    if (signal?.kind === "conversation_deleted") {
      const deleted = convs.get(signal.conversation);
      if (deleted) stopConversation(deleted);
    }
    if (!isConversationChannel(frame.channel)) return;
    const c = conv(frame.channel);
    const s = (c.session ??= newSession(begun?.cursors[frame.channel] ?? 0, begun?.trees(frame.channel)));
    if (frame.seq <= s.last) return;
    if (frame.seq === s.last + 1) {
      s.last = frame.seq;
      s.runStart ??= frame.seq;
    } else {
      // 断了一截：定下来之前是补发的那一页前面先补的几条（会话树、语音对象）；定下来之后不该有，这次打开不再存这个会话
      if (s.decided) return stopConversation(c);
      s.runStart = frame.seq;
      s.last = frame.seq;
    }
    if (!s.decided) {
      s.buffer.push(frame);
      if (!s.settled && !isReplayPinType(frame.type)) {
        s.settled = true;
        decide(c);
      }
      return;
    }
    if (s.capturing) apply(c, frame);
  };

  /** 信不信得过本机存着的：这次一条不漏收到的那一段能接上 through 才信；信不过的整个删掉，从这次收到的起重新存 */
  const decide = (c: Conv): void => {
    const s = c.session!;
    s.decided = true;
    if (c.off) {
      s.buffer = [];
      return;
    }
    const from = s.runStart ?? s.c0 + 1;
    if (!c.meta || from > c.meta.through + 1) {
      if (c.meta || c.rev !== null) {
        c.wipe = true;
        c.puts.clear();
        c.gen += 1;
      }
      // 从头存：这一段之前最新的会话树（热打开是快照里的；冷打开是补发那一页前面先补的那条）
      const pinned = s.buffer.filter((f) => f.seq < from && chatCacheSignalOf(f)?.kind === "tree").at(-1);
      const signal = pinned && chatCacheSignalOf(pinned);
      const tree = signal?.kind === "tree" ? signal.tree : s.c0 > 0 ? s.tree0 : undefined;
      c.meta = freshMeta(c.id, from - 1, tree);
      c.dirty = true;
    }
    s.capturing = true;
    const buffered = s.buffer;
    s.buffer = [];
    for (const frame of buffered) apply(c, frame, buffered);
    schedule();
  };

  /** 信得过、定下来之后收到的一条：作废的照着改，要存的记下 */
  const apply = (c: Conv, frame: EventFrame, replaying?: readonly EventFrame[]): void => {
    const meta = c.meta;
    if (!meta || c.off) return;
    const fresh = frame.seq > meta.through;
    const signal = chatCacheSignalOf(frame);
    if (signal?.kind === "purged") {
      if (fresh) wipeAll(replaying ? { conv: c, seq: frame.seq } : undefined);
      return schedule(0);
    }
    if (signal?.kind === "tree") {
      if (!fresh) return;
      const d = pathDivergence(meta.tree, signal.tree);
      c.meta = { ...meta, spans: Number.isFinite(d) ? spansBefore(meta.spans, d) : meta.spans, tree: signal.tree };
      if (Number.isFinite(d)) c.gen += 1;
      c.dirty = true;
      return schedule();
    }
    const entry = cacheEntryOf(frame);
    if (!entry) return;
    put(c, entry);
    if (entry.kind === "a" && entry.value.mode === "tool" && entry.value.toolCallId !== undefined) {
      c.meta = { ...c.meta!, toolVoices: { ...c.meta!.toolVoices, ...cachedToolVoices([entry.value]) } };
    }
    if (entry.kind === "m") c.meta = { ...c.meta!, usedAt: now() };
    c.dirty = true;
    schedule();
  };

  const put = (c: Conv, entry: ChatCacheEntry): void => {
    const key = putKey(entry);
    const old = c.puts.get(key);
    if (old && "version" in old && "version" in entry && old.version >= entry.version) return;
    if (old && !("version" in entry)) return;
    c.puts.set(key, { ...entry, bytes: jsonBytes(entry.value) } as ChatCachePut);
  };

  /** 整份作废：正在存的会话从现在起（at：定下来时过攒着的那几条，从那一条起）重新存，别的整个删掉 */
  const wipeAll = (at?: { conv: Conv; seq: number }): void => {
    for (const c of convs.values()) resetConv(c, at?.conv === c ? at.seq : undefined);
    schedule(0);
  };

  /** 一个会话作废：正在存的从 pos（不给是收到的最后一条）之后重新存，没在存的整个删掉 */
  const resetConv = (c: Conv, pos?: number): void => {
    c.gen += 1;
    c.puts.clear();
    const s = c.session;
    if (s?.capturing && !c.off) {
      const at = pos ?? s.last;
      c.meta = freshMeta(c.id, at, c.meta?.tree);
      s.runStart = at + 1;
      c.wipe = true;
      c.dirty = true;
      return;
    }
    if (c.meta || c.rev !== null) c.drop = true;
    c.meta = undefined;
  };

  /** 这次打开不再存这个会话（别的标签页改过、接不上）：存着的整个删掉，免得留着信不过的 */
  const stopConversation = (c: Conv): void => {
    c.off = true;
    c.gen += 1;
    c.puts.clear();
    if (c.session) c.session.capturing = false;
    if (c.meta || c.rev !== null) c.drop = true;
    c.meta = undefined;
    schedule(0);
  };

  // ───────── 写 ─────────

  const schedule = (delay = idleMs): void => {
    if (!usable()) return;
    const t = now();
    if (timer === undefined) firstPendingAt = t;
    else clearTimeout(timer);
    const wait = Math.max(0, Math.min(delay, firstPendingAt + maxWaitMs - t));
    timer = setTimeout(() => {
      timer = undefined;
      void write();
    }, wait);
  };

  /** 这次打开一条不漏收到的那一段（正在存的会话） */
  const liveSpan = (c: Conv): CachedSpan | undefined => {
    const s = c.session;
    if (!s?.capturing || s.runStart === undefined || s.runStart > s.last) return undefined;
    return { lo: s.runStart, hi: s.last, more: false };
  };

  const write = async (): Promise<void> => {
    if (writing) {
      again = true;
      return writing;
    }
    if (!usable()) return;
    const writes: ConversationWrite[] = [];
    const written = new Map<string, Persisted | undefined>();
    for (const c of convs.values()) {
      if (!c.meta) {
        // 整个删掉（作废了、没在存）
        if (c.drop) {
          writes.push({ conversation: c.id, expect: null, force: true, wipe: true, puts: [], meta: null });
          written.set(c.id, undefined);
          // 删掉之后本机就没有了：之后再存这个会话是从没有起（写不成这个页面整个不再存）
          c.rev = null;
          c.persisted = undefined;
        }
        c.drop = false;
        c.wipe = false;
        c.dirty = false;
        c.puts.clear();
        continue;
      }
      if (c.off || !(c.dirty || c.wipe || c.drop || c.puts.size > 0)) continue;
      const live = liveSpan(c);
      const s = c.session;
      if (s?.capturing) c.meta = { ...c.meta, through: Math.max(c.meta.through, s.last), spans: live ? withSpan(c.meta.spans, live) : c.meta.spans };
      const rev = newRev();
      const wipe = c.wipe || c.drop;
      const { bytes: _bytes, count: _count, ...meta } = c.meta;
      writes.push({ conversation: c.id, expect: c.rev, ...(wipe ? { force: true, wipe: true } : {}), puts: [...c.puts.values()], meta: { ...meta, rev } });
      written.set(c.id, persistedOf(c.meta, rev, c.gen));
      c.puts = new Map();
      c.wipe = false;
      c.drop = false;
      c.dirty = false;
    }
    const writeGlobal = globalDirty ? global : undefined;
    globalDirty = false;
    if (writes.length === 0 && !writeGlobal) return;
    writing = (async () => {
      try {
        const results = await backend.write(writes, writeGlobal);
        for (const result of results) {
          const c = convs.get(result.conversation);
          if (!c) continue;
          if (!result.ok) {
            // 别的标签页改过、删过：这次打开不再存它（存着的是那个标签页的，它自己负责）
            c.off = true;
            c.gen += 1;
            c.puts.clear();
            c.meta = undefined;
            c.persisted = undefined;
            if (c.session) c.session.capturing = false;
            continue;
          }
          const persisted = written.get(result.conversation);
          c.persisted = persisted;
          c.rev = persisted?.rev ?? null;
          if (persisted && c.meta) c.meta = { ...c.meta, bytes: result.bytes, count: result.count };
        }
        evictOverLimit();
      } catch {
        // 没写进去（存满了、被清了）：这个页面不再存，下次打开照存着的走（一次写是一个事务，存着的还是一致的）
        broken = true;
      }
    })();
    try {
      await writing;
    } finally {
      writing = undefined;
      if (again && usable()) {
        again = false;
        schedule(0);
      }
    }
  };

  /** 超了上限：按最久没用过的整个会话删，删到上限的八成 */
  const evictOverLimit = (): void => {
    const stored = [...convs.values()].filter((c) => c.meta && !c.off && c.rev !== null);
    let total = stored.reduce((n, c) => n + c.meta!.bytes, 0);
    if (total <= maxBytes) return;
    for (const c of stored.toSorted((a, b) => a.meta!.usedAt - b.meta!.usedAt)) {
      if (total <= maxBytes * EVICT_TO) break;
      total -= c.meta!.bytes;
      resetConv(c);
    }
    schedule(0);
  };

  /** 等攒着的都写进去（拼一页之前：刚收到的、刚存下的要读得到，作废的要先删掉） */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3 && usable(); i++) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        await write();
      } else if (writing) await writing;
      else return;
    }
  };

  // ───────── 对外 ─────────

  return {
    begin(cursors, trees) {
      begun = { cursors: { ...cursors }, trees: trees ?? (() => undefined) };
      if (usable()) startSessions(begun);
    },

    note(input) {
      if (broken || cleared) return;
      try {
        if (!ready) early.push(input);
        else process(input);
      } catch {
        broken = true;
      }
    },

    async page(conversation, before, limit, tree) {
      try {
        await loaded;
        const n = Math.min(limit ?? HISTORY_PAGE_SIZE, MAX_HISTORY_LIMIT);
        const c = convs.get(conversation);
        if (!usable() || !c || c.off || !c.session?.capturing) return undefined;
        // 攒着的先写进去（刚收到的、刚存下的那一页才读得到）；写不进去也照存着的那份拼
        await settle();
        // 只按写成了的那一份拼：写成之后作废过的（回退、彻底删除……还没写进去）不用，会话树和界面上的对不上不用
        const p = c.persisted;
        if (!usable() || c.off || !p || p.gen !== c.gen || !sameTree(p.tree, tree)) return undefined;
        const span = spanAt(p.spans, before - 1);
        if (!span) return undefined;
        const onPath = onPathOf(p.tree);
        const read = await backend.readPage({ conversation, rev: p.rev, lo: span.lo, before, limit: n, keep: onPath, voiceIds: (messages) => voiceIdsToRead(messages, p.toolVoices) });
        // 读的路上作废了的不用
        if (read === undefined || c.gen !== p.gen || !usable()) return undefined;
        const page = cachedPage({ conversation, span, limit: n, onPath, toolVoices: p.toolVoices, absent: new Set(p.absent) }, read);
        if (page && c.meta) {
          c.meta = { ...c.meta, usedAt: now() };
          c.dirty = true;
          schedule();
        }
        return page;
      } catch {
        return undefined;
      }
    },

    ticket(conversation) {
      return conv(conversation).gen;
    },

    keep(conversation, before, page, ticket) {
      try {
        if (!usable()) return;
        const c = convs.get(conversation);
        if (!c || c.off || !c.session?.capturing || !c.meta || c.gen !== ticket) return;
        const span = spanOfPage(before, page);
        for (const entry of cacheEntriesOfPage(page)) put(c, entry);
        const absent = absentRefsOf(page);
        c.meta = {
          ...c.meta,
          spans: span ? withSpan(c.meta.spans, span) : c.meta.spans,
          absent: absent.length > 0 ? [...new Set([...c.meta.absent, ...absent])].slice(-ABSENT_KEPT) : c.meta.absent,
          toolVoices: { ...c.meta.toolVoices, ...cachedToolVoices(page.agentVoices ?? []) },
          usedAt: now(),
        };
        c.dirty = true;
        schedule();
      } catch {
        broken = true;
      }
    },

    flush() {
      if (timer !== undefined) schedule(0);
    },

    async clear() {
      cleared = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      early.length = 0;
      try {
        await writing;
      } catch {
        // 写没写成都要删
      }
      convs.clear();
      try {
        await backend.clear();
      } catch {
        // 删不了（没有 IndexedDB）：本来也没存
      }
    },

    stats() {
      // 还没读完的（刚打开）照"还没存"说，存不了、清掉了的才说存不了
      if (broken || cleared) return { state: "off" };
      const stored = [...convs.values()].filter((c) => c.meta && c.rev !== null && !c.off);
      return {
        state: "on",
        conversations: stored.filter((c) => c.meta!.count > 0).length,
        messages: stored.reduce((n, c) => n + c.meta!.count, 0),
        bytes: stored.reduce((n, c) => n + c.meta!.bytes, 0),
        maxBytes,
      };
    },
  };
}
