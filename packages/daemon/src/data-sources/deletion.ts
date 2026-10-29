// 断开数据源时"连已导入的一起删"（295 号票，issue 25 第 4 节：走现有的彻底删除）。和删项目、删任务、移除插件时连数据删走同一张
// "删除参与方"登记表（deletion/participants.ts）：
// - 数据源这一份（registerDataSourceDeletion，owner data-sources）：它导入的记录（数据源登记时写的 records 那几类事件）整条换成
//   "已删除"标记（数据源断开了，这些记录的状态不用留——同移除插件，ADR-0008 的"不改坏状态"说的是还在用的状态）；它的同步记录
//   （data_source_synced，带着导入的文件名）一起换成标记；"已导入"里它的文件提交之后删掉；
// - 素材库那一份（memory/deletion-participants.ts 的 registerMaterialsDeletion，owner materials）：由这些记录采成的素材照彻底删除的
//   口径删（同一事务记一条彻底删除的记忆命令，出处 data_source；素材、索引、原文副本、推理库里的证据跟着删，重建时不回来）。
// 同一个事务里改写、追加断开记录（data_source_disconnected，只写数据源、什么时候、删了几条），派生视图整体重放（appendBatch 的 purge）；
// 同一个幂等键重发只回第一次记下的条数。
import fs from "node:fs";
import path from "node:path";
import type { DataSourcePurgeCounts } from "@ergo/protocol";
import { DATA_SOURCE_DELETION, type DataSourceDeletionSubject, type DeletionParticipants, liveEvents } from "../deletion/participants.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { PurgeContext } from "../events/purge.ts";
import { DATA_SOURCE_DISCONNECTED, DATA_SOURCE_SYNCED, DATA_SOURCES_CHANNEL, type DataSourceDisconnectedPayload, type DataSourceSyncedPayload } from "./events.ts";

/** 一类事件：给了频道是这个频道里的，不给是所有频道里的 */
const eventsOf = (store: EventStore, channel: string | undefined, type: string) => (channel === undefined ? store.ofType(type) : store.read(channel, 0, type));

/** 数据源这一份参与方：它导入的记录、同步记录换成标记，"已导入"里它的文件提交之后删 */
export function registerDataSourceDeletion(participants: Pick<DeletionParticipants, "register">, deps: { imports: string; log: (line: string) => void }): () => void {
  return participants.register(DATA_SOURCE_DELETION, {
    owner: "data-sources",
    join: ({ source, records, counts }, plan) => ({
      claim() {
        const { store } = plan;
        const seen = new Set<number>();
        for (const { channel, type } of records) {
          for (const event of liveEvents(eventsOf(store, channel, type))) {
            if (seen.has(event.globalSeq)) continue;
            seen.add(event.globalSeq);
            plan.marker(event);
            counts.events += 1;
          }
        }
        const files: string[] = [];
        for (const event of liveEvents(store.read(DATA_SOURCES_CHANNEL, 0, DATA_SOURCE_SYNCED))) {
          const synced = event.payload as DataSourceSyncedPayload;
          if (synced.source !== source) continue;
          plan.marker(event);
          counts.events += 1;
          if (synced.file) files.push(path.resolve(deps.imports, synced.file.stored));
        }
        const existing = files.filter((file) => fs.existsSync(file));
        counts.files += existing.length;
        plan.afterCommit(() => {
          for (const file of existing) {
            try {
              fs.rmSync(file, { force: true, maxRetries: 3 });
            } catch (err) {
              deps.log(`断开数据源 ${source} 时删不掉已导入的文件 ${file}：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        });
      },
    }),
  });
}

/** 断开记录的幂等键 */
const recordKey = (idempotencyKey: string) => `data-source-disconnect:${idempotencyKey}`;

/** 这个幂等键已经断开过了：交回当时记下的（没有是 undefined） */
export function disconnectedBefore(store: EventStore, idempotencyKey: string): DataSourceDisconnectedPayload | undefined {
  const done = store.eventByIdempotencyKey(recordKey(idempotencyKey));
  return done ? (done.payload as DataSourceDisconnectedPayload) : undefined;
}

/**
 * 记一次断开：purge 时同一个事务里删掉它导入的（删什么由登记表里的参与方定），交回删了几条。
 * 同一个幂等键重发什么都不再改，只回第一次记下的
 */
export function recordDisconnect(
  deps: { store: EventStore; participants: Pick<DeletionParticipants, "plan">; now: () => string; log: (line: string) => void },
  subject: { source: string; records: DataSourceDeletionSubject["records"]; purge: boolean },
  idempotencyKey: string,
): DataSourceDisconnectedPayload {
  const before = disconnectedBefore(deps.store, idempotencyKey);
  if (before) return before;
  const at = deps.now();
  const record = (counts?: DataSourcePurgeCounts): NewEvent => ({
    channel: DATA_SOURCES_CHANNEL,
    type: DATA_SOURCE_DISCONNECTED,
    payload: { source: subject.source, at, purged: subject.purge, ...(counts ? { counts } : {}) } satisfies DataSourceDisconnectedPayload,
    idempotencyKey: recordKey(idempotencyKey),
  });
  if (!subject.purge) {
    const { event } = deps.store.append(record());
    return event.payload as DataSourceDisconnectedPayload;
  }
  const counts: DataSourcePurgeCounts = { events: 0, materials: 0, files: 0 };
  const context: PurgeContext = { deletedAt: at, materialIds: new Set() };
  const plan = deps.participants.plan(DATA_SOURCE_DELETION, { source: subject.source, records: subject.records, counts }, context);
  // 删除记录排在最前（同移除插件时连数据删），条数在 plan 里已经算好
  const results = deps.store.appendBatch([record(counts), ...plan.events], { purge: plan.purge });
  for (const step of plan.afterCommit) step();
  deps.log(`断开数据源 ${subject.source} 并删了已导入的：记录 ${counts.events} 条、素材 ${counts.materials} 条、文件 ${counts.files} 个`);
  return results[0]!.event.payload as DataSourceDisconnectedPayload;
}
