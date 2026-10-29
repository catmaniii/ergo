// 数据源的记录（295 号票）：守护进程内部的频道 data_sources（不是前端协议的频道，前端订阅不了；数据源页经 HTTP 取）。
// - data_source_synced：一次同步（点了"立即同步"、定期导入到点了）或者导入文件夹里导入了一个文件——什么时候、新进来几条、
//   出错的原因（密钥换成 *** 之后）、导入的文件名和挪到了"已导入"里的哪个文件；299 号票起还有设备交来的（trigger device，
//   带幂等键）、这次进来的是什么（summary）；
// - data_source_disconnected：断开了（留着已导入的，或者连已导入的一起删：删了几条）。数据源页的"上次同步"从最近一次断开之后算。
// 数据源导入的记录本身是插件自己的事件（插件的频道和类型，数据源登记时写在 records 里），不在这个频道。
// 记录不多（一次同步一条），数据源页每次现读这个频道归并，不建派生视图。
import { type DataSourcePurgeCounts, type DataSourceSyncTrigger, isDeletedEventPayload } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";

/** 守护进程内部的频道：数据源的同步、导入、断开记录 */
export const DATA_SOURCES_CHANNEL = "data_sources";
export const DATA_SOURCE_SYNCED = "data_source_synced";
export const DATA_SOURCE_DISCONNECTED = "data_source_disconnected";

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
  /** 这次进来的是什么（数据源写的一句，记下时的语言；299 号票） */
  summary?: string;
  /** 设备交来的（trigger device）交回设备的（同一个幂等键重发时原样再交回；299 号票） */
  reply?: unknown;
}

export interface DataSourceDisconnectedPayload {
  source: string;
  at: string;
  purged: boolean;
  /** 连已导入的一起删时删了几条 */
  counts?: DataSourcePurgeCounts;
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
