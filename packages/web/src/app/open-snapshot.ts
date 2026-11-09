// 打开页面时先用的本机快照（388）和本机存的事件（452、456）：页面这一半——存在这台设备的 IndexedDB 里（open-snapshot-idb.ts；
// 快照存哪些、会话留多少见 state/open-snapshot.ts）。
// - 打开时读一次（页面脚本一开始就读，和问"被信任吗"同时）：
//   · 网页版本（构建产物的哈希）、协议版本、快照格式三样都对得上：用快照（snapshot），马上画出来，订阅带它的游标（存的事件和快照的
//     游标对不上——比如只存了快照——这次打开就不存事件、把存着的删掉，等下一次冷打开重新存）；
//   · 网页换了一版、快照格式变了，但协议版本没变、存着的事件能用：快照不用，读出存着的事件（events），用新版本的状态层重新折一遍
//     （等于本机自己做一次"从头补"），订阅带事件的游标，守护进程只补增量。会话频道不存事件，游标是 0，守护进程照冷打开补最近一页；
//   · 协议版本变了（事件的样子可能变了）、什么都不能用：当场全删，从头补；
//   读不了、读坏了、1.5 秒还没读出快照（事件另给 5 秒）也当没有，照现在的走（第一次写的时候把存着的事件全删了重来）；
// - 本机存的事件按冷补发同一份规则合并（456，协议包的 replay-compaction.ts）：同一件事被后来的事件整份盖掉的旧记录不留，本机存的
//   保持在"守护进程这时冷补发会发的那些"那么大，不再一直涨。每个频道记着合并到哪儿（ChannelCompaction：最后一条、照留的、每一样的赢家），
//   和快照一起存；新来的事件接着往里加，被盖掉的那几条在同一次写里删掉。读的时候一个频道只认"合并后该留的那几条一条不缺"；
//   452 存的整段事件（格式 1，从 1 起一条不缺）照样能用，读出来先合并，第一次写时把被盖掉的删掉；合并规则换了版本的不用、从头补；
// - 存：要存的那几样变了才存，攒着等闲下来（最后一次变化之后 3 秒，最多攒 30 秒）再写一份，切到后台、关页面时马上写；
//   一次写是一个事务：快照整份换掉（同一个键），连接交来的新事件（note 记下的，序号不大于快照游标的那部分）按频道合并，留下的加上、
//   被盖掉的删掉，要重新同步的频道先删掉。写不进去不抛错，攒着的事件留到下次写（攒太多了就这次打开不再存事件），下次打开照现在的走；
// - 记事件时一个频道要接得上：序号紧挨着上一条的，或者这个频道这次是从头补的（游标 0、重新同步）——守护进程合并过的冷补发中间本来就有洞，
//   补发（catchUp）里的洞都认；别的地方出了洞（不该有）这个频道这次打开不再往下记；
// - 订阅回 resync 的频道：清掉这个频道存着的事件，从头补发的接着记；
// - 清：设备被吊销、回到配对页时快照和事件全删（手机上不留个人数据），之后这个页面上不再存；
// - 多台设备、多个标签页各存各的，不互相同步：同一台设备上的几个标签页（鸿蒙 App 的浏览侧边栏也是一个）谁后写用谁的，
//   每一份快照都是某一刻完整的样子连同它的游标，下次打开从那里补增量，补出来的一样；事件按频道、序号存，几个标签页写同一条是覆盖，
//   一个标签页删掉的可能是另一个还要的：读的时候一个频道该留的缺了就不用这个频道的，从头补它（合并过的，很快）；
// - 开发服务器的页面没有网页版本，不存不用；原型（演示页）不用。
import {
  addToCompaction,
  type ChannelCompaction,
  copyCompaction,
  emptyCompaction,
  type EventFrame,
  isChannelCompaction,
  isEphemeralEventType,
  isOpenSnapshot,
  keepsOpenEvents,
  OPEN_EVENTS_FORMAT,
  OPEN_SNAPSHOT_FORMAT,
  type OpenSnapshot,
  REPLAY_COMPACTION_VERSION,
  survivingSeqs,
  type UiInput,
} from "../state/index.ts";

/** 一次写里事件那一半：先删，再加 */
export interface EventWrite {
  /** 先删掉的：all 是存着的全部事件，否则是这几个频道的 */
  readonly clear: "all" | readonly string[];
  /** 再删掉这几条（合并时被后来的盖掉了的） */
  readonly remove: readonly { readonly channel: string; readonly seq: number }[];
  /** 再加上的（按频道、序号存：同一条再存一遍是覆盖） */
  readonly add: readonly EventFrame[];
}

/** 存快照和事件的地方（测试换成假的） */
export interface SnapshotBackend {
  /** 存着的那一份快照 */
  read(): Promise<unknown>;
  /** 存着的全部事件（按频道、序号排好） */
  readEvents(): Promise<unknown>;
  /** 一次写，一个事务（要么都写进去、要么都没写）：先按 events.clear、events.remove 删，再加 events.add，快照整份换掉 */
  write(value: unknown, events: EventWrite): Promise<void>;
  /** 快照和事件全删 */
  remove(): Promise<void>;
}

/** 452 存的格式：各频道从 1 起一条不缺、没合并过的整段 */
const WHOLE_EVENTS_FORMAT = 1;

/**
 * 本机存的事件：格式、合并规则的版本，各频道到哪一条为止（和快照的游标相同）、合并到哪儿（会话频道不存）。
 * 格式 1（452）没有 rules、merged：存的是从 1 起一条不缺的整段
 */
interface StoredEvents {
  readonly format: number;
  readonly rules?: number;
  readonly through: Readonly<Record<string, number>>;
  readonly merged?: Readonly<Record<string, ChannelCompaction>>;
}

/** 存下的一份：快照连同存的时候页面是哪一版、存的事件到哪儿 */
interface StoredSnapshot {
  readonly format: number;
  readonly webVersion: string;
  readonly protocolVersion: number;
  readonly savedAt: string;
  readonly snapshot: OpenSnapshot;
  /** 没有：这一份没存事件 */
  readonly events?: StoredEvents;
}

/** 打开时能先用的：同一版的快照，或者换了一版之后存着的事件（连同订阅要带的游标） */
export type OpenStart =
  | { readonly kind: "snapshot"; readonly snapshot: OpenSnapshot }
  | { readonly kind: "events"; readonly events: readonly EventFrame[]; readonly cursors: Readonly<Record<string, number>> };

export interface PageSnapshots {
  /** 打开时读的那一份（读过就是同一个 Promise，不会拒绝）：能先用的，或者没有 */
  load(): Promise<OpenStart | undefined>;
  /** 连接交给状态层的每一样输入都先给这里看一眼：记下要存的事件（会话频道以外的落盘事件）、要重新同步的频道 */
  note(input: UiInput): void;
  /** 要存的变了：攒着，闲下来再取一份写（take 到写的时候才调，取的是那时最新的） */
  save(take: () => OpenSnapshot): void;
  /** 攒着的马上写（切到后台、关页面时） */
  flush(): void;
  /** 删掉（回到配对页）：之后这个页面上不再存 */
  clear(): Promise<void>;
}

export interface PageSnapshotsOptions {
  /** 页面自己是哪一版（构建产物的哈希） */
  webVersion: string;
  protocolVersion: number;
  backend: SnapshotBackend;
  /** 重新折的时候频道的先后（照订阅的先后：和守护进程从头补发时一样）；不在里面的排在后面 */
  channelOrder?: readonly string[];
  /** 读多久还没读出快照就当没有 */
  loadTimeoutMs?: number;
  /** 换了一版时读存着的事件最多等多久，过了当没有 */
  eventsTimeoutMs?: number;
  /** 最后一次变化之后多久写 */
  idleMs?: number;
  /** 一直在变时最多攒多久 */
  maxWaitMs?: number;
  /** 写不进去时最多攒多少条事件，再多这次打开就不再存事件 */
  maxPendingEvents?: number;
  now?: () => Date;
}

/** 存着的、合并时不要了的几条（按频道） */
type Prune = Map<string, number[]>;

/** 读出来的：能先用的；用上了的话之后怎么记事件（存着的各频道合并到哪儿、要先删的频道、要删的几条，或者这次不存事件） */
interface Loaded {
  readonly start: OpenStart | undefined;
  readonly written?: Readonly<Record<string, ChannelCompaction>>;
  readonly reset?: readonly string[];
  readonly prune?: Prune;
  readonly stopRecording?: true;
}

const LOAD_TIMEOUT_MS = 1500;
const EVENTS_TIMEOUT_MS = 5000;
const IDLE_MS = 3000;
const MAX_WAIT_MS = 30_000;
const MAX_PENDING_EVENTS = 200_000;

export function pageSnapshots(options: PageSnapshotsOptions): PageSnapshots {
  const { webVersion, protocolVersion, backend } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const maxPending = options.maxPendingEvents ?? MAX_PENDING_EVENTS;
  const now = options.now ?? (() => new Date());
  let loading: Promise<OpenStart | undefined> | undefined;
  let cleared = false;
  let pending: (() => OpenSnapshot) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt = 0;
  let writing: Promise<void> | undefined;

  // 事件那一半。读完之前（打开时）记下的先放着，读完定了从哪里接着记再说（没读完就当从头补：全删了重来）
  /** 这次打开存不存事件：快照能用、事件却接不上（只补快照之后的增量，攒不出全的）时不存，下次写把存着的删掉 */
  let recording = true;
  /** 下次写时先把存着的全删了 */
  let wipe = true;
  /** 下次写时先删掉这几个频道存着的（重新同步、读出来有缺的） */
  const reset = new Set<string>();
  /** 下次写时删掉的几条（读出来时发现合并后不该留的：452 的整段、别的标签页留下的） */
  let prune: Prune = new Map();
  /** 存着的（加上正在写的）各频道合并到哪儿 */
  let written: Record<string, ChannelCompaction> = {};
  /** 记下了、还没写的事件：按频道，序号从小到大 */
  const noted = new Map<string, EventFrame[]>();
  let notedCount = 0;
  /** 各频道记到哪一条了（重复、更旧的不再记） */
  const last = new Map<string, number>();
  /** 这次是从头补的频道：补发里有洞是合并掉的，认（补完、断开时不再认） */
  const fromZero = new Set<string>();
  /** 出了不该有的洞的频道：这次打开不再往下记 */
  const stalled = new Set<string>();

  const stopRecording = (): void => {
    recording = false;
    wipe = true;
    noted.clear();
    notedCount = 0;
  };

  /**
   * 读：能先用的，连同之后怎么记事件（读完、没超时才算数：超时了这些都不认，照从头补）。快照读出来时叫 onRecord
   * （之后不再按读快照的时限算，换了一版要读事件的另有时限）
   */
  const read = async (onRecord: () => void): Promise<Loaded> => {
    const stored = (await backend.read()) as Partial<StoredSnapshot> | undefined | null;
    onRecord();
    if (stored === undefined || stored === null) return { start: undefined };
    const sameProtocol = stored.protocolVersion === protocolVersion;
    const events = sameProtocol ? usableEvents(stored.events) : undefined;
    const snapshotOk = sameProtocol && stored.format === OPEN_SNAPSHOT_FORMAT && stored.webVersion === webVersion && isOpenSnapshot(stored.snapshot);
    if (snapshotOk) {
      const snapshot = stored.snapshot!;
      const start: OpenStart = { kind: "snapshot", snapshot };
      // 存的事件和快照是一起写的，游标对得上才接得上（订阅只补快照之后的）；对不上就这次打开不存事件。
      // 整段的（452 的格式，同一版的页面不会存它）要读出来才合并得了，这里不读，也当接不上
      return events?.merged && sameCursors(events.through, snapshot.cursors) ? { start, written: copies(events.merged) } : { start, stopRecording: true };
    }
    if (!events) {
      // 协议换了、读坏了、没存事件的旧快照、合并规则换了：以后也用不上，删掉
      await backend.remove().catch(() => undefined);
      return { start: undefined };
    }
    // 网页换了一版、快照格式变了：读存着的事件
    const raw = await within(backend.readEvents(), options.eventsTimeoutMs ?? EVENTS_TIMEOUT_MS);
    const usable = storedFrames(raw, events, options.channelOrder ?? []);
    return { start: { kind: "events", events: usable.events, cursors: { ...usable.through } }, written: usable.merged, reset: usable.broken, prune: usable.prune };
  };

  const write = (): void => {
    if (cleared || !pending) return;
    if (writing) return; // 正在写：写完接着写攒着的
    const take = pending;
    pending = undefined;
    let snapshot: OpenSnapshot;
    try {
      snapshot = take();
    } catch {
      return;
    }
    // 事件：各频道记下的里面序号不大于快照游标的（快照折到哪儿，事件就存到哪儿），接着合并：留下的加上，被盖掉的删掉
    const clear: "all" | readonly string[] = wipe ? "all" : [...reset];
    const base: Record<string, ChannelCompaction> = wipe ? {} : Object.fromEntries(Object.entries(written).filter(([c]) => !reset.has(c)));
    const merged: Record<string, ChannelCompaction> = { ...base };
    const add: EventFrame[] = [];
    const taken: EventFrame[] = [];
    const remove: { channel: string; seq: number }[] = [];
    const pruned = prune;
    if (recording) {
      if (!wipe) for (const [channel, seqs] of pruned) if (!reset.has(channel)) for (const seq of seqs) remove.push({ channel, seq });
      for (const [channel, list] of noted) {
        const upTo = snapshot.cursors[channel] ?? 0;
        let n = 0;
        while (n < list.length && list[n]!.seq <= upTo) n += 1;
        if (n === 0) continue;
        const fresh = list.splice(0, n);
        notedCount -= n;
        if (list.length === 0) noted.delete(channel);
        taken.push(...fresh);
        const before = base[channel];
        const state = before ? copyCompaction(before) : emptyCompaction();
        for (const frame of fresh) addToCompaction(state, frame);
        const kept = survivingSeqs(state);
        if (before) for (const seq of [...survivingSeqs(before)].toSorted((a, b) => a - b)) if (!kept.has(seq)) remove.push({ channel, seq });
        for (const frame of fresh) if (kept.has(frame.seq)) add.push(frame);
        merged[channel] = state;
      }
    }
    const through = Object.fromEntries(Object.entries(merged).map(([c, s]) => [c, s.last]));
    const stored: StoredSnapshot = {
      format: OPEN_SNAPSHOT_FORMAT,
      webVersion,
      protocolVersion,
      savedAt: now().toISOString(),
      snapshot,
      ...(recording ? { events: { format: OPEN_EVENTS_FORMAT, rules: REPLAY_COMPACTION_VERSION, through, merged } } : {}),
    };
    const wiped = wipe;
    const resetNow = [...reset];
    if (recording) written = merged;
    wipe = false;
    reset.clear();
    prune = new Map();
    writing = backend
      .write(stored, { clear, remove, add })
      .then(
        () => undefined,
        () => {
          // 没写进去：删的下次再删；记下的放回去下次再合并、再写（写进去之前 written 退回存着的那份）
          written = base;
          if (wiped) wipe = true;
          for (const c of resetNow) reset.add(c);
          if (recording) {
            for (const [c, seqs] of pruned) prune.set(c, [...(prune.get(c) ?? []), ...seqs]);
            putBack(taken);
          }
        },
      )
      .then(() => {
        writing = undefined;
        // 写着的时候又变了：接着写
        if (pending && timer === undefined) schedule();
      });
  };

  /** 没写进去的事件放回记下的前面（各频道仍按序号） */
  const putBack = (frames: readonly EventFrame[]): void => {
    const byChannel = new Map<string, EventFrame[]>();
    for (const frame of frames) {
      const list = byChannel.get(frame.channel);
      if (list) list.push(frame);
      else byChannel.set(frame.channel, [frame]);
    }
    for (const [channel, list] of byChannel) {
      const rest = noted.get(channel) ?? [];
      noted.set(channel, [...list, ...rest]);
      notedCount += list.length;
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    const waited = Date.now() - firstPendingAt;
    timer = setTimeout(
      () => {
        timer = undefined;
        write();
      },
      Math.max(0, Math.min(idleMs, maxWaitMs - waited)),
    );
  };

  const note = (input: UiInput): void => {
    if (cleared || !recording) return;
    if (input.kind === "batch") {
      for (const x of input.inputs) note(x);
      return;
    }
    // 补发推完了、连接断了又连：之后再来的帧都该接得上
    if (input.kind === "synced" || input.kind === "connection") {
      fromZero.clear();
      return;
    }
    if (input.kind === "resync") {
      if (!keepsOpenEvents(input.channel)) return;
      // 守护进程那边序号比这里的小（数据目录恢复过）：这个频道存着的、记下的都不要了，接着从头补发的从头记起
      notedCount -= noted.get(input.channel)?.length ?? 0;
      noted.delete(input.channel);
      last.set(input.channel, 0);
      delete written[input.channel];
      prune.delete(input.channel);
      stalled.delete(input.channel);
      reset.add(input.channel);
      return;
    }
    if (input.kind !== "frame") return;
    const { frame } = input;
    if (isEphemeralEventType(frame.type) || !keepsOpenEvents(frame.channel) || stalled.has(frame.channel)) return;
    const at = last.get(frame.channel) ?? written[frame.channel]?.last ?? 0;
    if (frame.seq <= at) return;
    // 从头补的频道：守护进程合并过的补发中间有洞（被盖掉的没发），补发里的都认
    if (input.catchUp === true && (at === 0 || fromZero.has(frame.channel))) fromZero.add(frame.channel);
    else if (frame.seq !== at + 1) {
      // 不该有的洞（漏了一段）：这个频道这次打开不再往下记，存着的停在缺的那一条前面
      stalled.add(frame.channel);
      return;
    }
    last.set(frame.channel, frame.seq);
    const list = noted.get(frame.channel);
    if (list) list.push(frame);
    else noted.set(frame.channel, [frame]);
    notedCount += 1;
    if (notedCount > maxPending) stopRecording();
  };

  return {
    load() {
      loading ??= new Promise<OpenStart | undefined>((resolve) => {
        let done = false;
        const finish = (loaded: Loaded): void => {
          if (done) return;
          done = true;
          clearTimeout(giveUp);
          if (loaded.start === undefined || cleared) {
            // 什么都没用上：从头补，第一次写的时候把存着的事件全删了重来
            wipe = true;
            written = {};
            reset.clear();
            prune = new Map();
          } else if (loaded.stopRecording) stopRecording();
          else {
            wipe = false;
            written = { ...loaded.written };
            for (const c of loaded.reset ?? []) reset.add(c);
            prune = new Map(loaded.prune ?? []);
          }
          resolve(cleared ? undefined : loaded.start);
        };
        const giveUp = setTimeout(() => finish({ start: undefined }), options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
        read(() => clearTimeout(giveUp)).then(finish, () => finish({ start: undefined }));
      });
      return loading;
    },
    note,
    save(take) {
      if (cleared) return;
      if (!pending) firstPendingAt = Date.now();
      pending = take;
      schedule();
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      write();
    },
    async clear() {
      cleared = true;
      pending = undefined;
      noted.clear();
      notedCount = 0;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // 正在写的那一份写完再删，不然删在前、写在后，快照又回来了
      await writing;
      await backend.remove().catch(() => undefined);
    },
  };
}

/**
 * 存的事件那一栏能不能用：格式 1（452 的整段）各频道到哪儿都是自然数；格式 2 还要合并规则是这一版的，每个频道合并到哪儿都在、
 * 最后一条和 through 一样
 */
function usableEvents(value: unknown): StoredEvents | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Partial<StoredEvents>;
  if (typeof v.through !== "object" || v.through === null) return undefined;
  const throughOk = Object.entries(v.through).every(([c, n]) => keepsOpenEvents(c) && Number.isInteger(n) && n >= 0);
  if (!throughOk) return undefined;
  if (v.format === WHOLE_EVENTS_FORMAT) return { format: WHOLE_EVENTS_FORMAT, through: v.through };
  if (v.format !== OPEN_EVENTS_FORMAT || v.rules !== REPLAY_COMPACTION_VERSION || typeof v.merged !== "object" || v.merged === null) return undefined;
  const merged = v.merged;
  const ok = Object.entries(v.through).every(([c, n]) => n === 0 || (isChannelCompaction(merged[c]) && merged[c].last === n));
  return ok ? (v as StoredEvents) : undefined;
}

/** 存的事件和快照的游标对得上：存事件的那几个频道，游标和"到哪一条为止"一样 */
function sameCursors(through: Readonly<Record<string, number>>, cursors: Readonly<Record<string, number>>): boolean {
  const kept = Object.entries(cursors).filter(([c, n]) => keepsOpenEvents(c) && n > 0);
  return kept.length === Object.values(through).filter((n) => n > 0).length && kept.every(([c, n]) => through[c] === n);
}

/** 各频道合并到哪儿：复制一份（接着往里加不动读出来的那份） */
function copies(merged: Readonly<Record<string, ChannelCompaction>>): Record<string, ChannelCompaction> {
  return Object.fromEntries(Object.entries(merged).filter(([, s]) => s.last > 0).map(([c, s]) => [c, copyCompaction(s)]));
}

/**
 * 读出来的事件里能用的：每个频道只认合并后该留的那几条一条不缺的（格式 2：合并到哪儿说了该留哪几条；格式 1：从 1 起到 through 一条不缺，
 * 读出来先合并）。缺了的（比如别的标签页删掉了）这个频道就不用，交给守护进程从头补。该留的以外还存着的（452 的整段里被盖掉的、
 * 别的标签页留下的）下次写时删掉。按 order 排频道（和订阅的先后一样），同一频道按序号
 */
function storedFrames(
  raw: unknown,
  events: StoredEvents,
  order: readonly string[],
): { events: EventFrame[]; through: Record<string, number>; merged: Record<string, ChannelCompaction>; broken: string[]; prune: Prune } {
  const byChannel = new Map<string, EventFrame[]>();
  for (const value of Array.isArray(raw) ? (raw as unknown[]) : []) {
    if (!isFrame(value)) continue;
    const list = byChannel.get(value.channel);
    if (list) list.push(value);
    else byChannel.set(value.channel, [value]);
  }
  const through: Record<string, number> = {};
  const merged: Record<string, ChannelCompaction> = {};
  const kept = new Map<string, EventFrame[]>();
  const prune: Prune = new Map();
  // 存着事件、却不在 through 里的频道（别的标签页写的、写了一半的）：整个删掉
  const broken = [...byChannel.keys()].filter((c) => events.through[c] === undefined || events.through[c] === 0);
  for (const [channel, upTo] of Object.entries(events.through)) {
    if (upTo === 0) continue;
    const list = (byChannel.get(channel) ?? []).toSorted((a, b) => a.seq - b.seq);
    let state: ChannelCompaction;
    if (events.format === WHOLE_EVENTS_FORMAT) {
      const whole = list.filter((f) => f.seq <= upTo);
      if (whole.length !== upTo || !whole.every((f, i) => f.seq === i + 1)) {
        broken.push(channel);
        continue;
      }
      state = emptyCompaction();
      for (const frame of whole) addToCompaction(state, frame);
    } else state = copyCompaction(events.merged![channel]!);
    const want = survivingSeqs(state);
    const have = list.filter((f) => want.has(f.seq));
    if (have.length !== want.size) {
      broken.push(channel);
      continue;
    }
    const extra = list.filter((f) => !want.has(f.seq)).map((f) => f.seq);
    if (extra.length > 0) prune.set(channel, extra);
    through[channel] = upTo;
    merged[channel] = state;
    kept.set(channel, have);
  }
  const rank = (c: string) => {
    const i = order.indexOf(c);
    return i === -1 ? order.length : i;
  };
  const channels = [...kept.keys()].toSorted((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { events: channels.flatMap((c) => kept.get(c)!), through, merged, broken, prune };
}

function isFrame(value: unknown): value is EventFrame {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<EventFrame>;
  return typeof v.channel === "string" && typeof v.type === "string" && Number.isInteger(v.seq) && (v.seq as number) > 0 && "payload" in v;
}

/** 等 promise，超过 ms 就拒绝 */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
