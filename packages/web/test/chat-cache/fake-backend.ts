// 手机本机存的聊天记录（457）测试用的假后端：照 app/chat-cache-idb.ts 的样子存在内存里——每个会话一份说明、条目一条一个键；
// 一次写要么全成、要么全不成；版本号（rev）对不上的会话不写；消息、记录、阶段记号已有的不动，语音对象版本新的才盖。
// 真的 IndexedDB 在 test/chat-cache-page.test.ts 里（真 Chrome）。
import type { ChatCacheBackend, ChatCacheGlobal, ConversationWrite, ConversationWriteResult, PageQuery } from "../../src/app/chat-cache.ts";
import type { AgentVoiceRecord, CachedRead, HistoryMessage, HistoryRecord, HistoryStageStart, VoiceRecord } from "../../src/state/index.ts";

interface Stored {
  v: unknown;
  b: number;
  ver?: number;
}

const key = (conversation: string, kind: string, k: number | string) => `${conversation}\u0000${kind}\u0000${typeof k === "number" ? `n${String(k).padStart(12, "0")}` : `s${k}`}`;

export class FakeChatBackend implements ChatCacheBackend {
  global: unknown = undefined;
  metas = new Map<string, Record<string, unknown>>();
  entries = new Map<string, Stored>();
  /** 打不开（没有 IndexedDB、隐私模式） */
  unavailable = false;
  failWrite = false;
  writes = 0;
  reads = 0;
  clears = 0;

  load(): Promise<{ global?: unknown; metas: unknown[] } | undefined> {
    if (this.unavailable) return Promise.resolve(undefined);
    return Promise.resolve(structuredClone({ global: this.global, metas: [...this.metas.values()] }));
  }

  write(writes: readonly ConversationWrite[], global?: ChatCacheGlobal): Promise<readonly ConversationWriteResult[]> {
    if (this.failWrite || this.unavailable) return Promise.reject(new Error("存满了"));
    this.writes += 1;
    const results: ConversationWriteResult[] = [];
    if (global) this.global = structuredClone(global);
    for (const w of writes) {
      const old = this.metas.get(w.conversation) as { rev?: string; bytes?: number; count?: number } | undefined;
      if (!w.force && (old?.rev ?? null) !== w.expect) {
        results.push({ conversation: w.conversation, ok: false, bytes: 0, count: 0 });
        continue;
      }
      if (w.wipe) for (const k of this.entries.keys()) if (k.startsWith(`${w.conversation}\u0000`)) this.entries.delete(k);
      if (w.meta === null) {
        this.metas.delete(w.conversation);
        results.push({ conversation: w.conversation, ok: true, bytes: 0, count: 0 });
        continue;
      }
      let bytes = w.wipe ? 0 : (old?.bytes ?? 0);
      let count = w.wipe ? 0 : (old?.count ?? 0);
      for (const e of w.puts) {
        const k = key(w.conversation, e.kind, e.key);
        const prev = this.entries.get(k);
        if (prev && !("version" in e && e.version > (prev.ver ?? 0))) continue;
        this.entries.set(k, { v: structuredClone(e.value), b: e.bytes, ...("version" in e ? { ver: e.version } : {}) });
        bytes += e.bytes - (prev?.b ?? 0);
        if (!prev && e.kind === "m") count += 1;
      }
      this.metas.set(w.conversation, structuredClone({ ...w.meta, bytes, count }));
      results.push({ conversation: w.conversation, ok: true, bytes, count });
    }
    return Promise.resolve().then(() => results);
  }

  readPage(query: PageQuery): Promise<CachedRead | undefined> {
    this.reads += 1;
    if (this.unavailable) return Promise.resolve(undefined);
    const meta = this.metas.get(query.conversation) as { rev?: string } | undefined;
    if (meta?.rev !== query.rev) return Promise.resolve(undefined);
    const seqs = (kind: string) =>
      [...this.entries.entries()]
        .filter(([k]) => k.startsWith(`${query.conversation}\u0000${kind}\u0000n`))
        .map(([, s]) => structuredClone(s.v) as { seq: number })
        .filter((v) => v.seq >= query.lo && v.seq < query.before)
        .toSorted((a, b) => a.seq - b.seq);
    const newest: HistoryMessage[] = [];
    for (const m of (seqs("m") as HistoryMessage[]).toReversed()) {
      if (query.keep(m.seq)) newest.push(m);
      if (newest.length > query.limit) break;
    }
    const ids = query.voiceIds(newest.slice(0, query.limit));
    const voices = new Map<string, VoiceRecord>();
    for (const id of ids.voices) {
      const s = this.entries.get(key(query.conversation, "v", id));
      if (s) voices.set(id, structuredClone(s.v) as VoiceRecord);
    }
    const agentVoices = new Map<string, AgentVoiceRecord>();
    for (const id of ids.agentVoices) {
      const s = this.entries.get(key(query.conversation, "a", id));
      if (s) agentVoices.set(id, structuredClone(s.v) as AgentVoiceRecord);
    }
    return Promise.resolve({ newest, records: seqs("r") as HistoryRecord[], stageStarts: seqs("s") as HistoryStageStart[], voices, agentVoices });
  }

  clear(): Promise<void> {
    this.clears += 1;
    this.global = undefined;
    this.metas.clear();
    this.entries.clear();
    return Promise.resolve();
  }

  /** 存着的某个会话的消息序号 */
  messageSeqs(conversation: string): number[] {
    return [...this.entries.entries()].filter(([k]) => k.startsWith(`${conversation}\u0000m\u0000`)).map(([, s]) => (s.v as { seq: number }).seq).toSorted((a, b) => a - b);
  }
}
