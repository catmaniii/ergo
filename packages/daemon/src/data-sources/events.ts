// 数据源的记录：守护进程内部的频道 data_sources（不是前端协议的频道，前端订阅不了；数据源页经 HTTP 取）。
// - data_source_synced：一次同步（点了"立即同步"、定期导入到点了）或者导入文件夹里导入了一个文件——什么时候、新进来几条、
//   出错的原因（密钥换成 *** 之后）、导入的文件名和挪到了"已导入"里的哪个文件；还有设备交来的（trigger device，
//   带幂等键）、这次进来的是什么（summary）；
// - data_source_disconnected：断开了（留着已导入的，或者连已导入的一起删：删了几条）。数据源页的"上次同步"从最近一次断开之后算；
//   只断开它下面的一样（Gmail 的一个账号）的带 item，不算整个断开，"上次同步"照旧。
// 数据源导入的记录本身是插件自己的事件（插件的频道和类型，数据源登记时写在 records 里），不在这个频道。
// 记录不多（一次同步一条），数据源页每次现读这个频道归并，不建派生视图。
// 435：每隔几分钟的定期导入什么都没变的那次（新进来 0 条、没出错、上一条记下的也没出错）不进上面这个频道（每 30 分钟一条，
// 数据源页每次现读会越读越慢），记在另一个内部频道 data_sources_quiet（data_source_quiet_sync，负载和同步记录一样），
// 派生视图 data_source_quiet 每个数据源只留最后一次——以前只在内存里记，重启就回到最后记下的那次（Google 日历的"上次同步"
// 停在 11-01、体检报 165 小时没同步成功）。整个断开时那一行删掉；和同步记录谁更晚按全局序号比（同一毫秒的也分得清）。
import { type DataSourcePurgeCounts, type DataSourceSyncTrigger, isDeletedEventPayload } from "@ergo/protocol";
import type { DerivedView, EventStore, StoredEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

/** 守护进程内部的频道：数据源的同步、导入、断开记录 */
export const DATA_SOURCES_CHANNEL = "data_sources";
export const DATA_SOURCE_SYNCED = "data_source_synced";
export const DATA_SOURCE_DISCONNECTED = "data_source_disconnected";
/** 守护进程内部的频道：每隔几分钟的定期导入什么都没变的那几次（435） */
export const DATA_SOURCES_QUIET_CHANNEL = "data_sources_quiet";
export const DATA_SOURCE_QUIET_SYNC = "data_source_quiet_sync";

export interface DataSourceSyncedPayload {
  source: string;
  at: string;
  trigger: DataSourceSyncTrigger;
  /** 新进来几条（出错的没有） */
  added?: number;
  /** 出错的原因（给人看的，密钥换成了 ***） */
  error?: string;
  /** 导入文件夹里的文件（trigger 是 file 的）：用户放进来时的名字、挪进"已导入"后相对导入文件夹的路径（用 / 分隔） */
  file?: { name: string; stored: string };
  /** 这次进来的是什么（数据源写的一句，记下时的语言） */
  summary?: string;
  /** 设备交来的（trigger device）交回设备的（同一个幂等键重发时原样再交回） */
  reply?: unknown;
}

export interface DataSourceDisconnectedPayload {
  source: string;
  at: string;
  purged: boolean;
  /** 连已导入的一起删时删了几条 */
  counts?: DataSourcePurgeCounts;
  /** 只断开了它下面的这一样（插件认的 id，Gmail 账号是地址的哈希）；整个断开的没有 */
  item?: string;
}

/** 这个频道上还在的记录（彻底删除改写成标记的不算），按先后 */
export function dataSourceRecords(store: Pick<EventStore, "read">): Array<{ event: StoredEvent; synced?: DataSourceSyncedPayload; disconnected?: DataSourceDisconnectedPayload }> {
  return store
    .read(DATA_SOURCES_CHANNEL)
    .filter((e) => !isDeletedEventPayload(e.payload))
    .map((event) =>
      event.type === DATA_SOURCE_SYNCED
        ? { event, synced: event.payload as DataSourceSyncedPayload }
        : event.type === DATA_SOURCE_DISCONNECTED
          ? { event, disconnected: event.payload as DataSourceDisconnectedPayload }
          : { event },
    );
}

const QUIET_TABLE = "data_source_quiet";

/** 一个数据源最后一次"什么都没变"的同步，和它在事件日志里的全局序号（和同步记录比谁更晚用） */
export interface QuietSync {
  readonly payload: DataSourceSyncedPayload;
  readonly globalSeq: number;
}

/**
 * 每个数据源最后一次"什么都没变"的同步（435）：data_sources_quiet 频道上的记一行（同一个数据源换掉）；
 * data_sources 频道上整个断开（不带 item）时删掉那一行
 */
export const dataSourceQuietView: DerivedView = {
  name: QUIET_TABLE,
  channels: [DATA_SOURCES_QUIET_CHANNEL, DATA_SOURCES_CHANNEL],
  create(db) {
    const existed = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", QUIET_TABLE) !== undefined;
    db.exec(`CREATE TABLE IF NOT EXISTS ${QUIET_TABLE} (source TEXT PRIMARY KEY, payload TEXT NOT NULL, global_seq INTEGER NOT NULL)`);
    // 新建的表（升级上来、手删过库）：从这两个频道补一遍
    return existed ? undefined : "refill";
  },
  clear: (db) => db.exec(`DELETE FROM ${QUIET_TABLE}`),
  apply(db, event) {
    if (event.channel === DATA_SOURCES_QUIET_CHANNEL && event.type === DATA_SOURCE_QUIET_SYNC) {
      const p = event.payload as DataSourceSyncedPayload;
      db.run(
        `INSERT INTO ${QUIET_TABLE} (source, payload, global_seq) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET payload = excluded.payload, global_seq = excluded.global_seq`,
        p.source,
        JSON.stringify(p),
        event.globalSeq,
      );
      return;
    }
    if (event.channel === DATA_SOURCES_CHANNEL && event.type === DATA_SOURCE_DISCONNECTED) {
      const p = event.payload as DataSourceDisconnectedPayload;
      if (p.item === undefined) db.run(`DELETE FROM ${QUIET_TABLE} WHERE source = ?`, p.source);
    }
  },
};

/** 每个数据源最后一次"什么都没变"的同步（整个断开以后的；没有的不在） */
export function quietSyncs(db: ReadonlyDatabase): Map<string, QuietSync> {
  return new Map(
    db
      .all<{ source: string; payload: string; global_seq: number }>(`SELECT source, payload, global_seq FROM ${QUIET_TABLE}`)
      .map((row) => [row.source, { payload: JSON.parse(row.payload) as DataSourceSyncedPayload, globalSeq: Number(row.global_seq) }]),
  );
}
