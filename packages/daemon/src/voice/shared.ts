// 用户语音的识别（31 号票，voice.ts）和 agent 的语音回复（32 号票，voice-reply.ts）共用的三件：
// - nextVersion：带版本的语音对象（VoiceRecord、AgentVoiceRecord）的下一个版本和它的事件（负载都是 { voice }）；
// - createSerialQueue：一次一条、按排队先后的后台队列（识别进程、合成服务都一次只做一条）；
// - standingNotice：待我处理里开着的只留一条的说明（"语音识别不可用"、"还没有参考音色"），修好了自动归档。
import { type ConversationId, nowIso, type NoticeType } from "@ergou/protocol";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService, NewInboxItem } from "../inbox/inbox.ts";

/** 带版本的语音对象：频道是它的会话，每次变化版本加 1、时间跟着变 */
interface Versioned {
  conversation: ConversationId;
  updatedAt: string;
  version: number;
}

/** 语音对象的下一个版本（时间、版本号跟着变，drop 里的字段去掉）和它的事件（eventType 的负载是 { voice }） */
export function nextVersion<R extends Versioned>(eventType: string, record: R, change: Partial<R>, drop: ReadonlyArray<keyof R> = []): { record: R; event: NewEvent } {
  const next: R = { ...record, ...change, updatedAt: nowIso(), version: record.version + 1 };
  for (const key of drop) delete next[key];
  return { record: next, event: { channel: record.conversation, type: eventType, payload: { voice: next } } };
}

export interface SerialQueue {
  /** 排进队（已经在队里的不重复），队空着就开始做 */
  enqueue(id: string): void;
  /** 队空了、手头这条也做完了（测试用） */
  whenIdle(): Promise<void>;
  /** 不再接新的、清掉排着的，等手头这条结束 */
  stop(): Promise<void>;
}

/** 一次一条的后台队列：run 抛错只记日志（label 是日志里怎么说这件事，比如"识别语音"） */
export function createSerialQueue(run: (id: string) => Promise<void>, options: { label: string; log: (line: string) => void }): SerialQueue {
  const queue: string[] = [];
  let draining: Promise<void> | undefined;
  let stopped = false;
  const kick = () => {
    if (draining || stopped) return;
    draining = (async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined || stopped) break;
        try {
          await run(id);
        } catch (err) {
          options.log(`${options.label} ${id} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    })().finally(() => {
      draining = undefined;
      if (queue.length > 0) kick();
    });
  };
  return {
    enqueue(id) {
      if (stopped || queue.includes(id)) return;
      queue.push(id);
      kick();
    },
    async whenIdle() {
      for (let running = draining; running; running = draining) await running;
    },
    async stop() {
      stopped = true;
      queue.length = 0;
      await draining?.catch(() => {});
    },
  };
}

export interface StandingNotice {
  /** 放一条（已经有开着的就不再放） */
  raise(item: Omit<Extract<NewInboxItem, { kind: "notice" }>, "kind" | "notice">): void;
  /** 开着的那条收进归档（没有就什么都不做） */
  retire(): void;
}

/** 待我处理里开着的只留一条的某种说明 */
export function standingNotice(options: { store: EventStore; inbox: InboxService; notice: NoticeType }): StandingNotice {
  const { store, inbox, notice } = options;
  const open = () => inbox.list().find((item) => item.kind === "notice" && item.notice === notice && !item.deleted && !item.archived && !inbox.isProcessed(item));
  return {
    raise(item) {
      if (open()) return;
      inbox.add({ ...item, kind: "notice", notice });
    },
    retire() {
      const item = open();
      if (item) store.append(inbox.buildUpdate(item, { archived: true, read: true }).event);
    },
  };
}
