// 本机文件夹变化（77 号票，来源编号 folder）：用 Node 自带的 fs.watch 监视指定文件夹（含子文件夹时 recursive），
// 新增、修改、删除文件推给等它的订阅，可以按文件名模式过滤（*.pdf）。
// - 合成一次：fs.watch 报一次变化只记下是哪个文件，等这个文件安静 settleMs（配置 eventSources.folderSettleMs）再去看它
//   （一直在变的最多等 settleMs 的 10 倍）；看的时候和比对底子比：底子里没有、现在有是新增，大小或修改时间变了是修改，底子里有、现在没了是删除，
//   新建又马上删掉的什么也不算。所以一个文件连着写几次只算一次。整个文件夹被挪进来、删掉的，按里面的每个文件算。
// - 链接不算、不跟进：符号链接、目录联接（junction）本身不当文件，也不顺着它扫进别的目录（扫描和单看一处都用 lstat）；
//   看的那一处的真实路径不在监视的文件夹里的（中间隔着链接）也不算。
// - 比对底子：每个订阅一个文件（数据目录 event-sources/folders/<订阅>.json：写的文件夹、它的真实路径、含不含子文件夹、每个文件的大小和修改时间、
//   一共看出过几处变化），每看出一处变化先推出去、再存底子。每处变化按看出的先后编号，去重键就是这个编号：推出去了、底子没存上就停了机的，
//   开机比出同一处变化、编号也一样，只收一次；同一个文件删了又放进来（哪怕修改时间一样）是新的编号，照样算一次。
//   守护进程重启后接着监视：先拿底子和现在的文件夹比一遍，停机期间的变化补发，再开始 fs.watch。第一次监视（没有底子）只记下现在的样子，不补发。
// - 看不到了（文件夹不在、fs.watch 出错、现在成了不许监视的地方）：不和底子比（不会把所有文件报成删除），关掉 fs.watch，
//   每隔 retryMs（配置 eventSources.folderRetryMs）再看一次；回来了重新查一遍能不能监视、和底子比一遍（看不到的那段时间真的变了的照样补上），
//   再开始 fs.watch。开机时文件夹暂时不在、监视出错、文件夹删了又建，都这样接着监视。
// - 不许监视（check，回来时也查）：只能是本机盘上的文件夹（D:\…；UNC、\\?\ 这类网络位置、设备路径不行，真实路径也要是）；
//   不能在不许监视的地方里面（数据目录、受保护区域：守卫的那一份 protectedAreasOf 加上整个数据目录，daemon.ts 给），含子文件夹时里面也不能有。
//   比较时按真实路径（展开链接、短名，不分大小写、尾斜杠），再按目录的身份（卷序列号 + 文件号，一层层往上比）——换个写法、经目录联接、
//   subst 盘都绕不过去。推出去之前每个文件再按真实路径查一遍。
// - 计时器用注入的时钟（测试用手动拨的），fs.watch 是真的。
import fs from "node:fs";
import path from "node:path";
import { type EventTrigger, FOLDER_EVENT_SOURCE, type FolderEvent, fileNameMatches, filterValue, nowIso } from "@ergo/protocol";
import { comparable, isWithin } from "../guard/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { realPathOf } from "../util/real-path.ts";
import { errorText, FOLDER_CHANGE_LABEL, FOLDER_LOST_REASON, folderLog, folderRefusal, folderSummary } from "./texts.ts";
import type { EventSourceContext, EventSourceImpl, EventSubscription, SourceEvent } from "./types.ts";

/** 不能监视的一个地方（真实路径）和它的说法 */
export interface ForbiddenArea {
  dir: string;
  title: string;
}

export interface FolderSourceOptions {
  ctx: EventSourceContext;
  clock: Clock;
  /** 比对底子放在哪（数据目录 event-sources/folders） */
  stateDir: string;
  /** 不能监视的地方：受保护区域加上整个数据目录（真实路径；先列具体的，最后是整个数据目录） */
  forbidden: () => readonly ForbiddenArea[];
  /** 一个文件安静多久才算一次变化（毫秒） */
  settleMs: number;
  /** 文件夹看不到时隔多久再看一次（毫秒） */
  retryMs: number;
}

/** 底子里一个文件：修改时间、大小 */
interface Entry {
  m: number;
  s: number;
}

/** 底子文件的样子 */
interface Baseline {
  /** 写的文件夹 */
  folder: string;
  /** 存底子时它的真实路径 */
  root?: string;
  recursive: boolean;
  files: Record<string, [number, number]>;
  /** 一共看出过几处变化（每处变化的编号接着往下排） */
  seq: number;
}

/** 一处变化 */
interface Change {
  kind: FolderEvent;
  rel: string;
  entry?: Entry;
  /** 删除、修改的：原来的样子 */
  before?: Entry;
}

/** 本机盘上的路径（D:\…）；UNC（\\server\share）、\\?\、\\.\ 这类网络位置、设备路径不是 */
const LOCAL_DRIVE = /^[a-z]:[\\/]/i;

/** 底子里的相对路径用 / 隔开（存盘、比对都用它），给人和 agent 看的换回本机的写法 */
const toKey = (rel: string) => rel.split(path.sep).join("/");
const toNative = (key: string) => key.split("/").join(path.sep);

/** 链接看不看：lstat（不跟进链接）；不在的是 undefined */
function lstatOf(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

/** 跟进链接看（取不到的是 undefined） */
function statOf(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/** 是不是一个文件夹（取不到的不是） */
const isFolder = (p: string) => statOf(p)?.isDirectory() === true;

/** 一处文件的样子：修改时间、大小 */
const entryOf = (st: fs.Stats): Entry => ({ m: Math.floor(st.mtimeMs), s: st.size });

/** 看一眼一个文件夹（含子文件夹的一层层往下）：相对路径 → 修改时间、大小。链接（符号链接、目录联接）不算、不跟进 */
function scanFolder(root: string, recursive: boolean, under = ""): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      const key = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (recursive) walk(abs, key);
        continue;
      }
      const st = lstatOf(abs);
      if (st?.isFile()) out.set(key, entryOf(st));
    }
  };
  walk(under ? path.join(root, toNative(under)) : root, under);
  return out;
}

/** 两次的样子比一比：新增、修改、删除 */
function diff(before: ReadonlyMap<string, Entry>, after: ReadonlyMap<string, Entry>): Change[] {
  const changes: Change[] = [];
  for (const [rel, entry] of after) {
    const was = before.get(rel);
    if (!was) changes.push({ kind: "added", rel, entry });
    else if (was.m !== entry.m || was.s !== entry.s) changes.push({ kind: "changed", rel, entry, before: was });
  }
  for (const [rel, was] of before) if (!after.has(rel)) changes.push({ kind: "removed", rel, before: was });
  return changes;
}

/** 一个目录的身份：卷序列号 + 文件号（大小写、短名、链接、subst 都不影响）。取不到、文件系统不给文件号（FAT 这类给 0）的是 undefined */
function identityOf(p: string): string | undefined {
  try {
    const st = fs.statSync(p, { bigint: true });
    return st.ino === 0n ? undefined : `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** 从一个目录起一层层往上的身份（含它自己） */
function lineageOf(dir: string): Set<string> {
  const out = new Set<string>();
  let current = dir;
  for (;;) {
    const id = identityOf(current);
    if (id) out.add(id);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/**
 * 这个文件夹（真实路径）能不能监视：不能的说法。不在本机盘上的不行；在不许监视的地方里面的（按真实路径或目录的身份），说最具体的那一块；
 * 含子文件夹时里面有的，倒过来说最大的那一块
 */
function forbiddenProblem(areas: readonly ForbiddenArea[], real: string, recursive: boolean, written: string): string | undefined {
  if (!LOCAL_DRIVE.test(real)) return folderRefusal.notLocal(written);
  const ups = lineageOf(real);
  const inside = areas.find((a) => {
    const id = identityOf(a.dir);
    return isWithin(real, a.dir) || (id !== undefined && ups.has(id));
  });
  if (inside) return folderRefusal.inside(written, inside.title);
  if (!recursive) return undefined;
  const mine = identityOf(real);
  const contained = areas.toReversed().find((a) => isWithin(a.dir, real) || (mine !== undefined && lineageOf(a.dir).has(mine)));
  return contained ? folderRefusal.contains(written, contained.title) : undefined;
}

/** 一个订阅的监视：底子、fs.watch、等安静的计时器、看不到时的重试 */
interface FolderWatch {
  /** 订阅的条件（换了就重来） */
  spec: string;
  sub: EventSubscription;
  /** 还在等安静的变化有几处 */
  pending(): number;
  stop(): void;
}

export function createFolderSource(options: FolderSourceOptions): EventSourceImpl {
  const { ctx, clock, settleMs, retryMs } = options;
  const watches = new Map<string, FolderWatch>();
  const stateFile = (subId: string) => path.join(options.stateDir, "folders", `${subId}.json`);

  const check = (trigger: EventTrigger): string[] => {
    const written = filterValue(trigger, "path");
    if (typeof written !== "string") return [];
    if (!path.isAbsolute(written)) return [folderRefusal.notAbsolute(written)];
    if (!LOCAL_DRIVE.test(written)) return [folderRefusal.notLocal(written)];
    const st = statOf(written);
    if (!st) return [folderRefusal.missing(written)];
    if (!st.isDirectory()) return [folderRefusal.notDirectory(written)];
    const real = realPathOf(written);
    if (!real) return [folderRefusal.missing(written)];
    const problem = forbiddenProblem(options.forbidden(), real, filterValue(trigger, "recursive") === true, written);
    return problem ? [problem] : [];
  };

  /** 开始监视一个订阅：有底子的先比一遍补发停机期间的变化，再 fs.watch；看不到时隔一会儿再看 */
  const watch = (sub: EventSubscription, spec: string): FolderWatch => {
    const folder = filterValue(sub.trigger, "path") as string;
    const recursive = filterValue(sub.trigger, "recursive") === true;
    const file = stateFile(sub.id);
    const self: FolderWatch = { spec, sub, pending: () => pending.size, stop: () => stop() };
    /** 文件夹现在的真实路径（每次开始监视时现取） */
    let root = "";
    let files = new Map<string, Entry>();
    let seq = 0;
    /** 有没有底子（没有的第一次只记下现在的样子） */
    let hasBaseline = false;
    let watcher: fs.FSWatcher | undefined;
    let stopped = false;
    /** 看不到了（不在、出错）：等着重试 */
    let lost = false;
    let retry: (() => void) | undefined;
    /** 等安静的：相对路径（"*" 是整个文件夹重新看一遍）→ 取消、第一次变化的时刻 */
    const pending = new Map<string, { cancel: () => void; first: number }>();

    const save = () => {
      const data: Baseline = { folder, root, recursive, files: Object.fromEntries([...files].map(([k, e]) => [k, [e.m, e.s]])), seq };
      try {
        // 先写临时文件再改名（被占着时重试，265 号票）
        writeFileAtomic(file, JSON.stringify(data));
      } catch (err) {
        ctx.log(folderLog.saveError(folder, errorText(err)));
      }
    };
    /** 读底子：写的文件夹（或存底子时的真实路径）、含不含子文件夹都对得上才算 */
    const load = () => {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
        const sameFolder = comparable(data.folder) === comparable(folder) || (data.root !== undefined && comparable(data.root) === comparable(realPathOf(folder) ?? folder));
        if (!sameFolder || data.recursive !== recursive) return;
        files = new Map(Object.entries(data.files).map(([k, [m, s]]) => [k, { m, s }]));
        seq = data.seq ?? 0;
        hasBaseline = true;
      } catch {
        // 没有底子、底子坏了：当第一次监视
      }
    };

    /** 一处变化推给订阅（选了这种事件、文件名对得上、不在不许监视的地方）；n 是这处变化的编号（去重键）。事件、模式都按订阅此刻的 */
    const emit = (c: Change, n: number) => {
      const current = self.sub;
      if (!current.trigger.events.includes(c.kind)) return;
      const name = path.posix.basename(c.rel);
      const pattern = filterValue(current.trigger, "pattern");
      if (!fileNameMatches(name, typeof pattern === "string" ? pattern : undefined)) return;
      const abs = path.join(folder, toNative(c.rel));
      const real = realPathOf(abs) ?? abs;
      if (options.forbidden().some((a) => isWithin(real, a.dir))) return;
      const rel = toNative(c.rel);
      const change = FOLDER_CHANGE_LABEL[c.kind];
      const event: SourceEvent = {
        source: FOLDER_EVENT_SOURCE,
        event: c.kind,
        at: nowIso(new Date(clock.now())),
        summary: folderSummary(c.kind, rel, folder),
        data: {
          path: abs,
          name,
          relativePath: rel,
          folder,
          change,
          ...(c.entry ? { size: c.entry.s, modifiedAt: nowIso(new Date(c.entry.m)) } : {}),
        },
        key: `folder:${n}:${c.kind}:${c.rel}`,
      };
      try {
        ctx.emit(current, event);
      } catch (err) {
        ctx.log(folderLog.emitError(folder, rel, errorText(err)));
      }
    };

    /** 看出的几处变化：编上号推出去，再存底子（推出去了、底子没存上就停机的，开机比出同样编号的变化，只收一次） */
    const publish = (changes: readonly Change[]) => {
      if (changes.length === 0) return;
      for (const c of changes) emit(c, ++seq);
      save();
    };

    const closeWatcher = () => {
      watcher?.close();
      watcher = undefined;
      for (const p of pending.values()) p.cancel();
      pending.clear();
    };

    /** 看不到了：不和底子比（不报删除），关掉 fs.watch，隔一会儿再看 */
    const lose = (reason: string) => {
      if (stopped) return;
      closeWatcher();
      if (!lost) ctx.log(folderLog.lost(folder, reason));
      lost = true;
      retry?.();
      retry = clock.setTimer(clock.now() + retryMs, () => {
        retry = undefined;
        begin();
      });
    };

    /** 看一处：这个文件（或目录）现在什么样，和底子比。文件夹本身不在了的算看不到，不报删除 */
    const look = (key: string) => {
      if (stopped || lost) return;
      if (!isFolder(root)) return lose(FOLDER_LOST_REASON.missing);
      let changes: Change[];
      if (key === "*") {
        const now = scanFolder(root, recursive);
        changes = diff(files, now);
        files = now;
      } else {
        const abs = path.join(root, toNative(key));
        const st = lstatOf(abs);
        // 中间隔着链接（真实路径不在监视的文件夹里）的、链接本身，都不算
        const inside = st !== undefined && !st.isSymbolicLink() && isWithin(realPathOf(abs) ?? abs, root);
        // 这个位置原来的（文件本身，或者目录下面的）
        const before = new Map([...files].filter(([k]) => k === key || k.startsWith(`${key}/`)));
        const after = inside && st.isFile() ? new Map([[key, entryOf(st)]]) : inside && st.isDirectory() && recursive ? scanFolder(root, true, key) : new Map<string, Entry>();
        changes = diff(before, after);
        for (const k of before.keys()) files.delete(k);
        for (const [k, e] of after) files.set(k, e);
      }
      publish(changes);
    };

    /** fs.watch 报了一次：等这个文件安静了再看（一直在变的最多等 10 倍） */
    const touched = (key: string) => {
      if (stopped || lost) return;
      const now = clock.now();
      const was = pending.get(key);
      was?.cancel();
      const first = was?.first ?? now;
      const at = Math.min(now + settleMs, first + settleMs * 10);
      const cancel = clock.setTimer(at, () => {
        pending.delete(key);
        try {
          look(key);
        } catch (err) {
          ctx.log(folderLog.error(folder, errorText(err)));
        }
      });
      pending.set(key, { cancel, first });
    };

    const startWatch = () => {
      try {
        watcher = fs.watch(root, { recursive, persistent: false }, (_type, filename) => {
          if (!filename) return touched("*");
          const key = toKey(path.normalize(filename.toString()));
          // 不含子文件夹的：只认文件夹下面直接的文件（子文件夹整个变了也只看它这一项）
          touched(recursive ? key : (key.split("/")[0] ?? key));
        });
        // 出错（文件夹被删掉、盘拔掉……）：关掉，隔一会儿再看
        watcher.on("error", (err) => lose(FOLDER_LOST_REASON.watchError(err.message)));
      } catch (err) {
        lose(FOLDER_LOST_REASON.watchError(err instanceof Error ? err.message : String(err)));
      }
    };

    /** 开始（或看不到之后重新开始）监视：现取真实路径、查能不能监视，和底子比一遍（第一次的只记下现在的样子），再 fs.watch */
    const begin = () => {
      if (stopped) return;
      const real = realPathOf(folder);
      if (!real || !isFolder(real)) return lose(FOLDER_LOST_REASON.missing);
      const problem = forbiddenProblem(options.forbidden(), real, recursive, folder);
      if (problem) return lose(problem);
      root = real;
      if (lost) ctx.log(folderLog.back(folder));
      lost = false;
      const now = scanFolder(root, recursive);
      if (hasBaseline) {
        const changes = diff(files, now);
        files = now;
        if (changes.length > 0) ctx.log(folderLog.caughtUp(folder, changes.length));
        publish(changes);
      } else {
        files = now;
        hasBaseline = true;
        save();
      }
      startWatch();
    };

    const stop = () => {
      stopped = true;
      retry?.();
      retry = undefined;
      closeWatcher();
    };

    load();
    begin();
    return self;
  };

  return {
    id: FOLDER_EVENT_SOURCE,
    check,
    sync(subs) {
      const keep = new Set<string>();
      for (const sub of subs) {
        const spec = JSON.stringify([filterValue(sub.trigger, "path"), filterValue(sub.trigger, "recursive") === true]);
        keep.add(sub.id);
        const existing = watches.get(sub.id);
        if (existing && existing.spec === spec) {
          existing.sub = sub;
          continue;
        }
        existing?.stop();
        try {
          watches.set(sub.id, watch(sub, spec));
        } catch (err) {
          ctx.log(folderLog.error(String(filterValue(sub.trigger, "path")), errorText(err)));
        }
      }
      // 不要了的（任务取消了、提醒取消了）：停掉，比对底子也删掉
      for (const [id, w] of watches) {
        if (keep.has(id)) continue;
        w.stop();
        watches.delete(id);
        fs.rmSync(stateFile(id), { force: true });
      }
    },
    pending: () => [...watches.values()].reduce((n, w) => n + w.pending(), 0),
    stop() {
      for (const w of watches.values()) w.stop();
      watches.clear();
    },
  };
}
