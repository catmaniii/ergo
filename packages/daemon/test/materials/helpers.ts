// 素材模块（模块层）测试的底座：真的事件存储（ergo.db）、真的素材模块（materials.db、素材区），
// 手动拨的时钟和调度器，假的向量函数。reopen() 模拟守护进程重启（同一个数据目录再打开一次），
// 也能在两次之间删掉 materials.db（重建）、删掉某个会话频道的事件（删项目时删掉维护者会话）。
// 129 号票起素材库只保管，采成素材由记忆插件开：这里照记忆插件做的那样声明它的两种素材来源、开始采集（collect）；
// collect: false 是记忆插件没开（只保管），reopen 时也能换。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type ConversationId, EVENT_TYPES, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { DEFAULT_MATERIALS_CONFIG } from "../../src/config/config.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import type { MaterialSource } from "../../src/materials/capture.ts";
import { memoryCommandSource } from "../../src/materials/commands.ts";
import { type Materials, openMaterials } from "../../src/materials/materials.ts";
import { cardStaleSource } from "../../src/materials/sources.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createScheduler } from "../../src/scheduler/scheduler.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

export const START = new Date("2026-10-08T09:00:00+08:00");

export interface MaterialsSetupOptions {
  embedder?: Embedder;
  sources?: readonly MaterialSource[];
  staleCardDays?: number;
  /** 采不采成素材（记忆插件开没开）；默认采 */
  collect?: boolean;
}

export function materialsSetup(options: MaterialsSetupOptions = {}) {
  const root = makeTempDir("ergo-materials-");
  const dbDir = path.join(root, "db");
  const materialsDir = path.join(root, "materials");
  fs.mkdirSync(dbDir, { recursive: true });
  const clock = new ManualClock(START);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  let embedder = options.embedder ?? new FakeEmbedder();
  let collect = options.collect ?? true;

  const open = () => {
    const store = openEventStore({ file: path.join(dbDir, "ergo.db"), views: [...conversationViews, cardsView, inboxView], now: () => clockIso(clock), log });
    const scheduler = createScheduler({ clock, log });
    const registry = new CardTypeRegistry();
    registry.register(suggestTaskFixture);
    const cards = createCardService({ store, registry, now: () => clockIso(clock) });
    const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => clockIso(clock) });
    const materials = openMaterials({ store, dbDir, materialsDir, log });
    // 记忆插件的数据契约声明的两种（停用也声明），再是测试给的
    for (const source of [memoryCommandSource, cardStaleSource, ...(options.sources ?? [])]) materials.register(source);
    const uncollect = collect ? materials.collect({ embedder, scheduler, clock, inbox, staleCardDays: options.staleCardDays ?? DEFAULT_MATERIALS_CONFIG.staleCardDays }) : undefined;
    materials.start();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await materials.stop();
      scheduler.stop();
      store.close();
    };
    return { store, scheduler, cards, inbox, materials, uncollect, close };
  };

  let current = open();
  onTestFinished(() => current.close());

  return {
    root,
    dbDir,
    materialsDir,
    clock,
    logs,
    get store(): EventStore {
      return current.store;
    },
    get materials(): Materials {
      return current.materials;
    },
    get cards() {
      return current.cards;
    },
    get inbox() {
      return current.inbox;
    },
    get scheduler() {
      return current.scheduler;
    },
    /** 停止采集（记忆插件运行中停用时插件宿主撤的那个）；没在采集时是 undefined */
    get uncollect() {
      return current.uncollect;
    },
    /**
     * 停掉再打开（模拟守护进程重启）：可以换一个向量函数（测换模型）、删掉 materials.db（测重建）、
     * 从事件日志里删掉某个会话频道的全部事件（模拟删项目时删掉维护者会话），派生视图跟着重建；
     * 把某条事件的负载改写掉（模拟 21 号票的彻底删除，改写成"已删除"标记）；在 materials.db 上跑几句 SQL（扮成旧版本的库）
     */
    async reopen(next?: {
      embedder?: Embedder;
      collect?: boolean;
      deleteMaterialsDb?: boolean;
      deleteChannel?: string;
      rewrite?: { globalSeq: number; payload: unknown };
      materialsDbSql?: readonly string[];
    }) {
      await current.close();
      if (next?.embedder) embedder = next.embedder;
      if (next?.collect !== undefined) collect = next.collect;
      if (next?.deleteMaterialsDb) {
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dbDir, `materials.db${suffix}`), { force: true });
      }
      if (next?.materialsDbSql) {
        const db = openDatabase(path.join(dbDir, "materials.db"));
        for (const sql of next.materialsDbSql) db.exec(sql);
        db.close();
      }
      if (next?.deleteChannel !== undefined || next?.rewrite !== undefined) {
        const db = openDatabase(path.join(dbDir, "ergo.db"));
        if (next.deleteChannel !== undefined) db.run("DELETE FROM events WHERE channel = ?", next.deleteChannel);
        if (next.rewrite !== undefined) db.run("UPDATE events SET payload = ? WHERE global_seq = ?", JSON.stringify(next.rewrite.payload), next.rewrite.globalSeq);
        db.close();
      }
      current = open();
      if (next?.deleteChannel !== undefined) current.store.rebuildViews();
    },
  };
}

let messageNo = 0;

/** 往会话里追加一条消息事件（和 conversation/messages.ts 落的形状一样） */
export function postMessage(
  store: EventStore,
  parts: MessagePart[],
  options: { conversation?: ConversationId; speaker?: "user" | "agent" | "system"; time?: string; taskId?: string; projectId?: string } = {},
) {
  const message = {
    id: `m-test-${++messageNo}`,
    conversation: options.conversation ?? CHANNELS.secretary,
    speaker: options.speaker ?? "user",
    time: options.time ?? "2026-10-08T09:30:00.000+08:00",
    parts,
  };
  const payload: MessageEventPayload = {
    message,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  };
  const { event } = store.append({ channel: message.conversation, type: EVENT_TYPES.message, payload });
  return { message, event };
}

export const text = (t: string): MessagePart => ({ type: "text", text: t });
