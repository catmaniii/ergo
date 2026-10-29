// 移除插件时连它的数据一起彻底删除（211 号票，用户 2026-10-20 定的；ADR-0027 的"运行中启用、移除"一段）。
// - 删什么由插件在数据契约里写明（ContractContext.removal.declare，PluginDataRemoval）：它拥有的事件（整条换成"已删除"标记）、
//   要按现有改写函数字段级改写的事件（比如"记住"的命令只换内容）、它拥有的卡片类型（每个版本连同关掉、长期没处理的记录整条换成标记，
//   待我处理里这些卡的事项删掉）、待我处理里属于它的通知、它自己的文件；外加给人看的"删哪些""删不掉的"（设置里的确认框列出）。
// - 走彻底删除的同一个口子（ADR-0008：EventStore.appendBatch 的 purge）：同一个事务里改写、追加待我处理里删掉的事项和一条删除记录
//   （插件频道上的 plugin_data_purged：只写插件名、什么时候、删了几条和它拥有的类型，不带内容），派生视图整体重放，提交后做 WAL 检查点；
//   之后删它自己的文件。
// - 整条换成标记，不像彻底删除素材那样只改带原话的字段：插件都移除了，它的状态不用留（ADR-0008 的"不改坏状态"说的是还在用的状态）。
// - 素材库不动（素材属于内核；记忆插件选 A：只删它自己的，设置里写明"要删请去 记忆 · 素材 的成批删除"），
//   删除类的记忆命令（删除记录）不碰（改写了重建时被删的素材会回来）——这些由插件在声明里自己不写进来。
// - 同一个幂等键重发：删除记录已经在了，只回它记下的条数，什么都不再改。
// - 214 号票（语音）：事件不写频道是所有频道里的这一类（语音事件在各个会话频道上）；只改字段的可以自带改法（agent 的语音对象没有
//   彻底删除的改写函数，只在连数据删时去掉送进 TTS 的原文）；它的媒体（录音、合成出的音频）按媒体库的 id 写明，提交之后删掉。
// - 279 号票起走"删除参与方"登记表（deletion/participants.ts，和删项目、删任务同一张）：插件宿主收着的各插件写明的这份，由
//   registerPluginDataRemoval 作为一个参与方登记（设置 · 插件建的时候登记，plugins/settings.ts）；purgePluginData 只管幂等、
//   算改写单、写删除记录、提交、提交后删文件。删的结果和以前逐条一样。
import fs from "node:fs";
import path from "node:path";
import { type CardEventPayload, CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload, type PluginDataPurgedEventPayload, type PluginPurgeCounts } from "@ergo/protocol";
import { cardIdOf, type DeletionParticipants, liveEvents, PLUGIN_DATA_DELETION } from "../deletion/participants.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { deletedMarker, type PurgeContext } from "../events/purge.ts";
import { purgedInboxItem } from "../inbox/inbox.ts";
import { listInboxItems } from "../inbox/views.ts";
import type { MediaStore } from "../media/media-store.ts";

/** 插件在数据契约里写明的"连数据删"：删哪些（结构）和给人看的说法 */
export interface PluginDataRemoval {
  /** 给人看的：会删哪些（确认框里逐条列出）。取值函数，跟着当前语言 */
  readonly deletes: readonly string[];
  /** 给人看的：删不掉的（确认框里写明） */
  readonly keeps: readonly string[];
  /** 它拥有的事件（频道、类型；不写频道是所有频道里的这一类）：每一条整条换成"已删除"标记 */
  readonly events?: readonly { channel?: string; type: string }[];
  /**
   * 只改它认的字段的事件（不写频道是所有频道里的这一类）：用登记的改写函数（ADR-0008，彻底删除的那一张表）改写，
   * 自带 rewrite 的用它（214 号票：没有彻底删除改写函数的类型）；when 挑出要改的那几条
   */
  readonly rewrite?: readonly { channel?: string; type: string; when(event: StoredEvent): boolean; rewrite?(event: StoredEvent, deletedAt: string): unknown }[];
  /** 它拥有的卡片类型：每个版本、关掉的和长期没处理的记录整条换成标记；待我处理里这些卡的事项删掉 */
  readonly cardTypes?: readonly string[];
  /** 待我处理里属于它的通知（通知的种类，比如 reminder_due）：删掉 */
  readonly notices?: readonly string[];
  /** 它自己的文件或目录（数据目录里的相对路径）：删掉 */
  readonly files?: readonly string[];
  /** 它的媒体（媒体库里的 id，214 号票：语音的录音、合成出的音频），删的时候现算（改写之前）：提交之后删掉，算进文件的个数 */
  media?(store: EventStore): readonly string[];
}

export interface PluginDataRemovalDeps {
  /** 插件宿主收着的各插件写明的"连数据删"（host.removalOf） */
  removalOf(plugin: string): PluginDataRemoval | undefined;
  /** 数据目录（插件自己的文件按它找） */
  dataDir: string;
  /** 媒体库（插件写明的媒体按它删，214 号票）；不给就不删媒体 */
  media?: Pick<MediaStore, "info" | "remove">;
  log: (line: string) => void;
}

export interface PluginDataPurgeDeps {
  store: EventStore;
  /** "删除参与方"登记表：删什么由登记的参与方定（插件写明的这份由设置 · 插件建的时候用 registerPluginDataRemoval 登记） */
  participants: Pick<DeletionParticipants, "register" | "plan">;
  /** 数据目录（插件自己的文件按它找；登记插件写明的这份时用） */
  dataDir: string;
  /** 媒体库（插件写明的媒体按它删，214 号票）；不给就不删媒体 */
  media?: Pick<MediaStore, "info" | "remove">;
  now: () => string;
  log: (line: string) => void;
}

/** 一类事件：给了频道是这个频道里的，不给是所有频道里的 */
const eventsOf = (store: EventStore, channel: string | undefined, type: string) => (channel === undefined ? store.ofType(type) : store.read(channel, 0, type));

/** 删除记录的幂等键 */
const recordKey = (idempotencyKey: string) => `plugin-data-purge:${idempotencyKey}`;

/**
 * 插件宿主收着的"连数据删"作为登记表里的一个参与方（见文件开头）：插件写明的事件、卡片、待我处理里的通知、文件和媒体，
 * 报上各删了几条。没写明的插件不参与
 */
export function registerPluginDataRemoval(participants: Pick<DeletionParticipants, "register">, deps: PluginDataRemovalDeps): () => void {
  return participants.register(PLUGIN_DATA_DELETION, {
    owner: "plugins",
    join: ({ plugin, counts }, plan) => {
      const spec = deps.removalOf(plugin);
      if (!spec) return undefined;
      return {
        claim() {
          const { store, context } = plan;
          const purge = new Map<number, unknown>();
          let events = 0;

          // 它拥有的事件：整条换成"已删除"标记
          for (const { channel, type } of spec.events ?? []) {
            for (const event of liveEvents(eventsOf(store, channel, type))) {
              purge.set(event.globalSeq, deletedMarker(event, context.deletedAt));
              events += 1;
            }
          }
          // 只改它认的字段的（"记住"的命令只换内容……）
          for (const { channel, type, when, rewrite } of spec.rewrite ?? []) {
            for (const event of liveEvents(eventsOf(store, channel, type))) {
              if (purge.has(event.globalSeq) || !when(event)) continue;
              purge.set(event.globalSeq, rewrite ? rewrite(event, context.deletedAt) : plan.rewriteOf(event));
              events += 1;
            }
          }

          // 卡片：这几种类型的每张卡，每个版本连同关掉、长期没处理的记录
          const types = new Set(spec.cardTypes ?? []);
          const cardIds = new Set<string>();
          if (types.size > 0) {
            for (const event of liveEvents(store.read(CHANNELS.cards, 0, EVENT_TYPES.card))) {
              const { card } = event.payload as CardEventPayload;
              if (types.has(card.type)) cardIds.add(card.id);
            }
            for (const event of liveEvents(store.read(CHANNELS.cards))) {
              const cardId = cardIdOf(event);
              if (cardId !== undefined && cardIds.has(cardId)) purge.set(event.globalSeq, deletedMarker(event, context.deletedAt));
            }
          }

          // 待我处理：这些卡的事项、属于它的通知——每一版的标题、正文换成删除标记，再追加一版删掉的
          const notices = new Set(spec.notices ?? []);
          const mine = (item: InboxItem) => (item.kind === "card" ? cardIds.has(item.cardId) : item.kind === "notice" && item.notice !== undefined && notices.has(item.notice));
          const itemIds = new Set<string>();
          for (const event of liveEvents(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
            const { item } = event.payload as InboxItemEventPayload;
            if (!mine(item)) continue;
            itemIds.add(item.id);
            purge.set(event.globalSeq, { item: purgedInboxItem(item) } satisfies InboxItemEventPayload);
          }
          const appended: NewEvent[] = listInboxItems(store.reader)
            .filter((item) => itemIds.has(item.id))
            .map((item) => ({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...purgedInboxItem(item), deleted: true, version: item.version + 1 } } satisfies InboxItemEventPayload }));

          // 它自己的文件、媒体：先数出来（删除记录里写几个），提交之后再删
          const files = (spec.files ?? []).map((rel) => path.resolve(deps.dataDir, rel)).filter((file) => fs.existsSync(file));
          const media = deps.media ? [...new Set(spec.media?.(store) ?? [])].filter((id) => deps.media!.info(id) !== undefined) : [];

          for (const [globalSeq, payload] of [...purge.entries()].toSorted(([a], [b]) => a - b)) plan.replace({ globalSeq }, payload);
          plan.append("inbox", ...appended);
          counts.events += events;
          counts.cards += cardIds.size;
          counts.inboxItems += itemIds.size;
          counts.files += files.length + media.length;
          plan.afterCommit(() => {
            for (const file of files) {
              try {
                fs.rmSync(file, { recursive: true, force: true, maxRetries: 3 });
              } catch (err) {
                deps.log(`彻底删除插件 ${plugin} 的数据时删不掉 ${file}：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            for (const mediaId of media) {
              try {
                deps.media!.remove(mediaId);
              } catch (err) {
                deps.log(`彻底删除插件 ${plugin} 的数据时删不掉媒体 ${mediaId}：${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });
        },
      };
    },
  });
}

/**
 * 把一个插件的数据彻底删掉（插件已经停了），返回删了几条。删什么由登记表里的参与方定；spec 是它在数据契约里写明的那份
 * （删除记录里记它拥有的事件类型、卡片类型）。同一个幂等键重发只回第一次记下的条数
 */
export function purgePluginData(deps: PluginDataPurgeDeps, plugin: string, spec: PluginDataRemoval, idempotencyKey: string): PluginPurgeCounts {
  const { store } = deps;
  const done = store.eventByIdempotencyKey(recordKey(idempotencyKey));
  if (done) return (done.payload as PluginDataPurgedEventPayload).counts;
  const context: PurgeContext = { deletedAt: deps.now(), materialIds: new Set() };
  const counts: PluginPurgeCounts = { events: 0, cards: 0, inboxItems: 0, files: 0 };
  const plan = deps.participants.plan(PLUGIN_DATA_DELETION, { plugin, counts }, context);
  const record: PluginDataPurgedEventPayload = { plugin, at: context.deletedAt, eventTypes: (spec.events ?? []).map((e) => e.type), cardTypes: [...new Set(spec.cardTypes ?? [])], counts };
  store.appendBatch([{ channel: CHANNELS.plugins, type: EVENT_TYPES.pluginDataPurged, payload: record, idempotencyKey: recordKey(idempotencyKey) }, ...plan.events], { purge: plan.purge });
  for (const step of plan.afterCommit) step();
  deps.log(`彻底删除了插件 ${plugin} 的数据：事件 ${counts.events} 条、卡片 ${counts.cards} 张、待我处理 ${counts.inboxItems} 条、文件 ${counts.files} 个`);
  return counts;
}
