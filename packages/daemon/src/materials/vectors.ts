// 向量索引（规格第 15 节）：素材入库后在后台异步补算向量，不卡写入和对话。
// - 只算有本人文字的素材（search_text）；每条向量旁边记下模型名。换了模型（名字变了），旧模型的向量不再参与检索、整批重算；
// - 模型文件不在时什么也不算：素材入库和关键词索引照常；守护进程提示用户运行下载命令（日志和待我处理），
//   之后每隔一段时间看一次，模型文件就位就把缺的向量补上（不用重启）；
// - 相似度检索第一阶段用暴力扫描：查询向量和当前模型的全部向量逐个算余弦（存的都是归一化的向量，就是点积）。
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Database } from "../storage/sqlite.ts";
import { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
import { getMaterial } from "./memory-db.ts";
import type { Material } from "./types.ts";

export interface MaterialHit {
  material: Material;
  /** 余弦相似度（-1 到 1，越大越像） */
  score: number;
}

export interface VectorStatus {
  model: string;
  /** 模型文件在不在 */
  available: boolean;
  /** 已经有当前模型向量的素材数 */
  indexed: number;
  /** 还缺向量的素材数 */
  pending: number;
  state: "idle" | "running" | "waiting_for_model" | "error";
}

export interface VectorIndex {
  start(): void;
  /** 有新素材了：后台补算（不等它算完） */
  kick(): void;
  settled(): Promise<void>;
  status(): VectorStatus;
  search(query: string, limit: number): Promise<MaterialHit[]>;
  stop(): Promise<void>;
}

export interface VectorIndexOptions {
  db: Database;
  /** 事件存储：往待我处理里放、改提示要经它追加 */
  store: EventStore;
  embedder: Embedder;
  scheduler: Scheduler;
  clock: Clock;
  inbox: InboxService;
  log: (line: string) => void;
  /** 一次算几条 */
  batchSize?: number;
}

/** 模型文件不在时，隔多久再看一次 */
export const MODEL_RECHECK_MS = 5 * 60_000;
/** 算向量出错后，隔多久重试 */
const RETRY_MS = 60_000;
const RECHECK_KEY = "materials:embedding-model-check";
const RETRY_KEY = "materials:embedding-retry";
/** 模型文件不在的提示（待我处理里只放一条） */
export const MODEL_MISSING_ITEM_ID = "i-embedding-model-missing";

export function createVectorIndex(options: VectorIndexOptions): VectorIndex {
  const { db, store, embedder, scheduler, clock, inbox, log } = options;
  const batchSize = options.batchSize ?? 16;
  let state: VectorStatus["state"] = "idle";
  let running: Promise<void> | undefined;
  let stopped = false;

  const pendingRows = (limit: number) =>
    db.all<{ id: string; search_text: string }>(
      `SELECT m.id, m.search_text FROM materials m
       LEFT JOIN material_vectors v ON v.material_id = m.id AND v.model = ?
       WHERE v.material_id IS NULL AND m.search_text != ''
       ORDER BY m.event_seq, m.position LIMIT ?`,
      embedder.model,
      limit,
    );

  const countPending = () =>
    Number(
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM materials m
         LEFT JOIN material_vectors v ON v.material_id = m.id AND v.model = ?
         WHERE v.material_id IS NULL AND m.search_text != ''`,
        embedder.model,
      )?.n ?? 0,
    );

  /** 模型文件不在：日志里提示，待我处理里放一条（只放一次），定时再看 */
  const waitForModel = () => {
    state = "waiting_for_model";
    if (!scheduler.pending().some((p) => p.key === RECHECK_KEY)) scheduler.schedule(RECHECK_KEY, clock.now() + MODEL_RECHECK_MS, recheck);
  };

  const announceMissing = () => {
    const hint = embedder.unavailableHint();
    log(`向量模型不在，素材照常入库、关键词检索照常可用，语义检索要等模型就位：${hint}`);
    // 待我处理里只放一次（用户处理过、删掉了也不再放；日志每次启动都写）
    if (inbox.get(MODEL_MISSING_ITEM_ID)) return;
    inbox.add({
      id: MODEL_MISSING_ITEM_ID,
      kind: "notice",
      notice: "embedding_model_missing",
      title: "语义检索用的向量模型还没下载",
      body: `素材照常入库，按关键词也能检索；按语义检索要等模型文件就位。${hint}`,
      source: "系统",
      urgency: "non_blocking",
      actions: ["知道了"],
    });
  };

  /** 模型就位了：那条提示还开着就归档 */
  const retireMissingNotice = () => {
    const item = inbox.get(MODEL_MISSING_ITEM_ID);
    if (!item || item.deleted || item.archived || inbox.isProcessed(item)) return;
    store.append(inbox.buildUpdate(item, { archived: true, read: true }).event);
  };

  const recheck = () => {
    if (stopped) return;
    if (embedder.available()) {
      log(`向量模型 ${embedder.model} 已就位，开始补算向量`);
      retireMissingNotice();
      kick();
    } else {
      waitForModel();
    }
  };

  const write = (rows: ReadonlyArray<{ id: string }>, vectors: readonly Float32Array[]) => {
    db.transaction(() => {
      rows.forEach((row, i) => {
        const vector = normalized(vectors[i]!);
        // 素材在算的过程中被删了（21 号票的"忘掉"）就不写
        db.run(
          `INSERT OR REPLACE INTO material_vectors (material_id, model, dims, vector)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM materials WHERE id = ?)`,
          row.id,
          embedder.model,
          vector.length,
          toBlob(vector),
          row.id,
        );
      });
    });
  };

  const run = async () => {
    state = "running";
    try {
      for (;;) {
        if (stopped) return;
        if (!embedder.available()) {
          waitForModel();
          return;
        }
        const rows = pendingRows(batchSize);
        if (rows.length === 0) break;
        const vectors = await embedder.embed(rows.map((r) => r.search_text));
        if (stopped) return;
        if (vectors.length !== rows.length) throw new Error(`向量函数给回 ${vectors.length} 条，要的是 ${rows.length} 条`);
        write(rows, vectors);
      }
      state = "idle";
    } catch (err) {
      // 停止时关掉了向量函数，正在算的那批会出错：不算错
      if (stopped) return;
      state = "error";
      log(`算向量出错，${RETRY_MS / 1000} 秒后重试：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      scheduler.schedule(RETRY_KEY, clock.now() + RETRY_MS, () => kick());
    }
  };

  /** 正在算的时候又来了新素材：这一轮结束后再跑一轮（这一轮可能已经查过"还缺哪些"了） */
  let again = false;
  const kick = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = run().finally(() => {
      running = undefined;
      if (again) {
        again = false;
        kick();
      }
    });
  };

  return {
    start() {
      if (!embedder.available()) {
        announceMissing();
        waitForModel();
        return;
      }
      kick();
    },
    kick,
    async settled() {
      // 一轮结束时可能接着又开了一轮（期间来了新素材）：等到真的没有在算的
      for (let current = running; current; current = running) await current;
    },
    status: () => ({
      model: embedder.model,
      available: embedder.available(),
      indexed: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material_vectors WHERE model = ?", embedder.model)?.n ?? 0),
      pending: countPending(),
      state,
    }),
    async search(query, limit) {
      if (!embedder.available()) throw new EmbeddingUnavailable(`向量模型不在，没法按语义检索：${embedder.unavailableHint()}`);
      const [raw] = await embedder.embed([query]);
      const q = normalized(raw!);
      const scored: Array<{ id: string; score: number }> = [];
      for (const row of db.all<{ material_id: string; vector: Uint8Array }>("SELECT material_id, vector FROM material_vectors WHERE model = ?", embedder.model)) {
        scored.push({ id: row.material_id, score: dot(q, fromBlob(row.vector)) });
      }
      scored.sort((a, b) => b.score - a.score);
      const hits: MaterialHit[] = [];
      for (const { id, score } of scored) {
        if (hits.length >= limit) break;
        const material = getMaterial(db, id);
        if (material) hits.push({ material, score });
      }
      return hits;
    },
    async stop() {
      stopped = true;
      scheduler.cancel(RECHECK_KEY);
      scheduler.cancel(RETRY_KEY);
      // 先关向量函数（结束工作线程）：正在算的那批随之结束，不用等它算完
      await embedder.close();
      await running;
    },
  };
}

function normalized(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // 拷一份：SQLite 给的字节不一定按 4 字节对齐
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
