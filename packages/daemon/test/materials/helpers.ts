// 素材模块（模块层）测试的底座：真的事件存储（ergou.db）、真的素材模块（memory.db、素材区），
// 手动拨的时钟和调度器，假的向量函数。reopen() 模拟守护进程重启（同一个数据目录再打开一次）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type ConversationId, EVENT_TYPES, type MessageEventPayload, type MessagePart } from "@ergou/protocol";
import { onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import { type Materials, type MaterialSource, openMaterials } from "../../src/materials/materials.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createScheduler } from "../../src/scheduler/scheduler.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

export const START = new Date("2026-10-08T09:00:00+08:00");

export interface MaterialsSetupOptions {
  embedder?: Embedder;
  sources?: readonly MaterialSource[];
  staleCardDays?: number;
}

export function materialsSetup(options: MaterialsSetupOptions = {}) {
  const root = makeTempDir("ergou-materials-");
  const dbDir = path.join(root, "db");
  const materialsDir = path.join(root, "materials");
  fs.mkdirSync(dbDir, { recursive: true });
  const clock = new ManualClock(START);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  let embedder = options.embedder ?? new FakeEmbedder();

  const open = () => {
    const store = openEventStore({ file: path.join(dbDir, "ergou.db"), views: [...conversationViews, cardsView, inboxView], now: () => clockIso(clock), log });
    const scheduler = createScheduler({ clock, log });
    const registry = new CardTypeRegistry();
    registry.register(suggestTaskFixture);
    const cards = createCardService({ store, registry, now: () => clockIso(clock) });
    const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => clockIso(clock) });
    const materials = openMaterials({
      store,
      dbDir,
      materialsDir,
      embedder,
      scheduler,
      clock,
      inbox,
      log,
      ...(options.staleCardDays === undefined ? {} : { staleCardDays: options.staleCardDays }),
    });
    for (const source of options.sources ?? []) materials.register(source);
    materials.start();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await materials.stop();
      scheduler.stop();
      store.close();
    };
    return { store, scheduler, cards, inbox, materials, close };
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
    /** 停掉再打开（模拟守护进程重启）；可以换一个向量函数（测换模型） */
    async reopen(next?: { embedder?: Embedder; deleteMemoryDb?: boolean }) {
      await current.close();
      if (next?.embedder) embedder = next.embedder;
      if (next?.deleteMemoryDb) {
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dbDir, `memory.db${suffix}`), { force: true });
      }
      current = open();
    },
  };
}

let messageNo = 0;

/** 往会话里追加一条消息事件（和 conversation/messages.ts 落的形状一样） */
export function postMessage(store: EventStore, parts: MessagePart[], options: { conversation?: ConversationId; speaker?: "user" | "agent" | "system"; time?: string } = {}) {
  const message = {
    id: `m-test-${++messageNo}`,
    conversation: options.conversation ?? CHANNELS.secretary,
    speaker: options.speaker ?? "user",
    time: options.time ?? "2026-10-08T09:30:00.000+08:00",
    parts,
  };
  const payload: MessageEventPayload = { message };
  const { event } = store.append({ channel: message.conversation, type: EVENT_TYPES.message, payload });
  return { message, event };
}

export const text = (t: string): MessagePart => ({ type: "text", text: t });
