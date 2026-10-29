// 手机插件自己存储里的原始数据（300 号票）：照片的时间地点、位置的原始坐标点，按本地日期一天一个文件
// （<数据目录>/phone/photos/<YYYY-MM-DD>.json、phone/locations/<YYYY-MM-DD>.json，内容 { format: 1, items: [...] }，按时间先后）。
// - 不进事件、不进素材：进素材的是整理好的一天一条摘要（events.ts 的 phone_photos_day / phone_location_day）；
// - 数据源页按天列出（几条、整理过没有），能按天清掉；断开并连已导入的一起删、移除插件连数据删时整个删掉；
// - 一条按编号只收一次（照片是 App 给的编号的哈希，位置点是时间）；每条记着整理过没有（s），整理之后又交来的那天的另整理成补的一份；
// - 按天清掉时记下清到哪一刻（phone/<种类>/cleared.json，{ format: 1, days: { 日期: 毫秒 } }）：那天这一刻以前的再交来不再收——
//   手机每次都把最近几天拍的照片读一遍交过来，不记的话清掉的马上又回来、整理过的那天还多出一份"补记"（304 号票在模拟器上碰到的）；
//   清掉以后才有的（今天接着拍的、接着记的）照收。整个删掉（断开并删）时这份也删，重新连上从头收；
// - 写文件先写临时文件再改名（写到一半崩了不留半个文件）；每天几条、整理过没有记在内存里（第一次用时把文件读一遍），页面打开时不再读文件。
// 跟数据目录一起进备份快照（个人数据，同别的）。
// 308 号票：照片、位置点可以多一个系统转出来的地名（addr：街道或地标、区县、城市），App 转得了才有。
import fs from "node:fs";
import path from "node:path";
import type { PhoneAddress } from "@ergo/protocol";
import type { DataSourceRawDay } from "../data-sources/api.ts";

/** 一条原始数据：编号、时间（协议时间）、整理过没有 */
export interface RawItem {
  id: string;
  at: string;
  /** 整理成摘要了（1）；没有是还没整理 */
  s?: 1;
}

/** 一张照片的时间地点：编号是 App 给的编号的哈希（不存相册里的地址、文件名） */
export interface RawPhoto extends RawItem {
  lat?: number;
  lon?: number;
  /** 拍摄地点的系统地名（308 号票，手机转得了才有） */
  addr?: PhoneAddress;
}

/** 一个位置点：编号是时间（毫秒） */
export interface RawPoint extends RawItem {
  lat: number;
  lon: number;
  /** 精度（米） */
  acc?: number;
  /** 系统地名（308 号票，手机转得了才有） */
  addr?: PhoneAddress;
}

export interface RawStore<T extends RawItem> {
  /** 收下几条（按本地日期分到各天，同一个编号只收一次；收过的这次带来了原来没有的地名时补上）：交回新收了几条、落在哪几天 */
  add(items: readonly T[], dateOf: (item: T) => string): { added: number; dates: string[] };
  /** 有哪几天（新的在前） */
  days(): DataSourceRawDay[];
  /** 这一天的全部（按时间先后；308 号票按位置点聚常去的地方用） */
  itemsOf(date: string): T[];
  /** before（本地日期）之前、还有没整理的那几天，连同没整理的那些（旧的在前） */
  pending(before: string): Array<{ date: string; items: T[] }>;
  /** 这一天这几条整理过了 */
  markSummarized(date: string, ids: readonly string[]): void;
  /** 清掉这几天的，交回清掉了几条；记下清到 at（毫秒）这一刻，那天这一刻以前的再交来不收 */
  clear(dates: readonly string[], at: number): number;
  /** 整个删掉 */
  clearAll(): void;
}

interface DayFile<T> {
  format: 1;
  items: T[];
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const CLEARED_FILE = "cleared.json";

interface ClearedFile {
  format: 1;
  /** 日期 → 清到哪一刻（毫秒） */
  days: Record<string, number>;
}

export function openRawStore<T extends RawItem>(dir: string, log: (line: string) => void): RawStore<T> {
  /** 每天几条、整理过没有（第一次用时读一遍） */
  let index: Map<string, { count: number; summarized: boolean }> | undefined;
  const fileOf = (date: string) => path.join(dir, `${date}.json`);
  /** 各天清到哪一刻（第一次用时读一遍） */
  let cleared: Map<string, number> | undefined;
  const clearedFile = path.join(dir, CLEARED_FILE);
  const ensureCleared = () => {
    if (cleared) return cleared;
    cleared = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(clearedFile, "utf8")) as Partial<ClearedFile>;
      for (const [date, at] of Object.entries(parsed.days ?? {})) if (typeof at === "number" && Number.isFinite(at)) cleared.set(date, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`手机：${clearedFile} 读不了，当作没清过：${err instanceof Error ? err.message : String(err)}`);
    }
    return cleared;
  };
  const writeCleared = (days: Map<string, number>) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${clearedFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: 1, days: Object.fromEntries([...days].toSorted(([a], [b]) => a.localeCompare(b))) } satisfies ClearedFile));
    fs.renameSync(tmp, clearedFile);
  };

  const read = (date: string): T[] => {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileOf(date), "utf8")) as Partial<DayFile<T>>;
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`手机：原始数据 ${fileOf(date)} 读不了，当作没有：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
  const summaryOf = (items: readonly T[]) => ({ count: items.length, summarized: items.every((i) => i.s === 1) });
  const ensureIndex = () => {
    if (index) return index;
    index = new Map();
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const date = DATE_FILE.exec(name)?.[1];
      if (date === undefined) continue;
      const items = read(date);
      if (items.length > 0) index.set(date, summaryOf(items));
    }
    return index;
  };
  const write = (date: string, items: T[]) => {
    const idx = ensureIndex();
    if (items.length === 0) {
      fs.rmSync(fileOf(date), { force: true });
      idx.delete(date);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const sorted = items.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const tmp = `${fileOf(date)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: 1, items: sorted } satisfies DayFile<T>));
    fs.renameSync(tmp, fileOf(date));
    idx.set(date, summaryOf(sorted));
  };

  return {
    add(items, dateOf) {
      const byDate = new Map<string, T[]>();
      for (const item of items) byDate.set(dateOf(item), [...(byDate.get(dateOf(item)) ?? []), item]);
      let added = 0;
      const dates: string[] = [];
      for (const [date, incoming] of byDate) {
        const existing = read(date);
        const byId = new Map(existing.map((i) => [i.id, i]));
        const clearedAt = ensureCleared().get(date);
        // 308 号票：收过的这次带来了系统地名、原来没有的（上次手机没转成），补上地名（不算新收的，整理过的摘要不重写）
        let patched = false;
        const fresh = incoming.filter((i) => {
          const known = byId.get(i.id);
          if (known) {
            const addr = (i as { addr?: unknown }).addr;
            if (addr !== undefined && (known as { addr?: unknown }).addr === undefined) {
              Object.assign(known, { addr });
              patched = true;
            }
            return false;
          }
          // 那天清掉过：清的那一刻以前的不再收
          if (clearedAt !== undefined && Date.parse(i.at) <= clearedAt) return false;
          byId.set(i.id, i);
          return true;
        });
        if (fresh.length === 0) {
          if (patched) write(date, existing);
          continue;
        }
        // 新收的都是没整理的
        write(date, [...existing, ...fresh.map(({ s: _s, ...rest }) => rest as T)]);
        added += fresh.length;
        dates.push(date);
      }
      return { added, dates: dates.toSorted() };
    },
    days() {
      return [...ensureIndex()].map(([date, d]) => ({ date, ...d })).toSorted((a, b) => b.date.localeCompare(a.date));
    },
    itemsOf: (date) => read(date),
    pending(before) {
      return [...ensureIndex()]
        .filter(([date, d]) => date < before && !d.summarized)
        .map(([date]) => date)
        .toSorted()
        .map((date) => ({ date, items: read(date).filter((i) => i.s !== 1) }))
        .filter((d) => d.items.length > 0);
    },
    markSummarized(date, ids) {
      const done = new Set(ids);
      write(
        date,
        read(date).map((i) => (done.has(i.id) ? { ...i, s: 1 as const } : i)),
      );
    },
    clear(dates, at) {
      let count = 0;
      const days = ensureCleared();
      for (const date of new Set(dates)) {
        days.set(date, Math.max(days.get(date) ?? 0, at));
        const items = read(date);
        if (items.length === 0 && !fs.existsSync(fileOf(date))) continue;
        count += items.length;
        write(date, []);
      }
      writeCleared(days);
      return count;
    },
    clearAll() {
      fs.rmSync(dir, { recursive: true, force: true });
      index = new Map();
      cleared = new Map();
    },
  };
}
