// 向量索引（规格第 15 节）：素材入库后在后台异步补算向量，不卡写入和对话。
// - 只算有要索引的文字（search_text）的素材；每条向量旁边记下模型名。换了模型（名字变了），旧模型的向量不再参与检索、整批重算；
// - 守护进程启动时不马上补算（重建、换模型后要算的可能很多，加载模型也要几秒）：等启动过去一会儿（默认 30 秒）再开始，
//   免得和秘书的拉起抢 CPU；新来的素材照常马上算。工作线程到第一次要算时才拉起；
// - 模型文件不在时什么也不算：素材入库和关键词索引照常；守护进程提示用户运行下载命令（日志和待我处理），
//   之后每隔一段时间看一次，模型文件就位就把缺的向量补上（不用重启）；
// - 相似度检索第一阶段用暴力扫描：查询向量和当前模型的全部向量逐个算余弦（存的都是归一化的向量，就是点积）；
// - 166 号票（存的网页正文最多 2 万字也进索引）：要索引的文字只算开头 EMBED_MAX_CHARS 字（关键词索引照样是全文）；
//   一次交给模型的一批按最长的那条补齐，所以凑批时"条数 × 最长的字数"不超过 EMBED_MAX_CHARS：长的单独一批，免得一批短的跟着补齐到几千字。
import { COMPONENTS_INSTALL_ACTION, t } from "@ergo/protocol";
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
  /** 闲着（没有在算；启动后还没开始补算时也是）、在算、等模型文件、出错了等重试；off：素材库没在采集素材（记忆插件没开，129 号票），没有向量索引 */
  state: "idle" | "running" | "waiting_for_model" | "error" | "off";
}

export interface VectorIndex {
  /** 启动：模型在就约好过一会儿开始补算，不在就提示用户 */
  start(): void;
  /** 有新素材了：后台补算（不等它算完） */
  kick(): void;
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
}

/** 一次算几条 */
const BATCH_SIZE = 16;
/** 要索引的文字只算开头多少字（166 号票）；一次交给模型的一批"条数 × 最长的字数"也不超过它 */
export const EMBED_MAX_CHARS = 2000;
/** 守护进程启动后过多久开始补算缺的向量 */
export const BACKFILL_DELAY_MS = 30_000;
/** 模型文件不在时，隔多久再看一次 */
export const MODEL_RECHECK_MS = 5 * 60_000;
/** 算向量出错后，隔多久重试 */
const RETRY_MS = 60_000;
const BACKFILL_KEY = "materials:embedding-backfill";
const RECHECK_KEY = "materials:embedding-model-check";
const RETRY_KEY = "materials:embedding-retry";
/** 模型文件不在的提示（待我处理里只放一条） */
export const MODEL_MISSING_ITEM_ID = "i-embedding-model-missing";

/** 还缺当前模型向量、又有要索引的文字的素材（参数：模型名） */
const MISSING_VECTORS = `FROM materials m
  LEFT JOIN material_vectors v ON v.material_id = m.id AND v.model = ?
  WHERE v.material_id IS NULL AND m.search_text != ''`;

export function createVectorIndex(options: VectorIndexOptions): VectorIndex {
  const { db, store, embedder, scheduler, clock, inbox, log } = options;
  let state: VectorStatus["state"] = "idle";
  let running: Promise<void> | undefined;
  /** 正在算的时候又来了新素材：这一轮结束后再跑一轮（这一轮可能已经查过"还缺哪些"了） */
  let again = false;
  let stopped = false;

  /** 模型文件不在：定时再看 */
  const waitForModel = () => {
    state = "waiting_for_model";
    if (!scheduler.pending().some((p) => p.key === RECHECK_KEY)) scheduler.schedule(RECHECK_KEY, clock.now() + MODEL_RECHECK_MS, recheck);
  };

  /** 日志里提示（每次启动），待我处理里放一条（只放一次：用户处理过、删掉了也不再放） */
  const announceMissing = () => {
    const hint = embedder.unavailableHint();
    log(`向量模型不在，素材照常入库、关键词检索照常可用，语义检索要等模型就位：${hint}`);
    if (inbox.get(MODEL_MISSING_ITEM_ID)) return;
    inbox.add({
      id: MODEL_MISSING_ITEM_ID,
      kind: "notice",
      notice: "embedding_model_missing",
      title: t("materials.modelMissing.title"),
      body: t("materials.modelMissing.body", { hint }),
      source: t("materials.modelMissing.source"),
      urgency: "non_blocking",
      // 323 号票："去装组件"由前端带到设置 · 组件（不算处理），装好后这条自动归档
      actions: [COMPONENTS_INSTALL_ACTION, "知道了"], // @i18n-ignore fixed：事项的动作按字认
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
        const rows = db.all<{ id: string; search_text: string }>(`SELECT m.id, m.search_text ${MISSING_VECTORS} ORDER BY m.event_seq, m.position LIMIT ?`, embedder.model, BATCH_SIZE);
        if (rows.length === 0) break;
        for (const group of paddedGroups(rows.map((r) => r.search_text.slice(0, EMBED_MAX_CHARS)))) {
          const vectors = await embedder.embed(group.texts);
          if (stopped) return;
          if (vectors.length !== group.texts.length) throw new Error(`向量函数给回 ${vectors.length} 条，要的是 ${group.texts.length} 条`); // @i18n-ignore log：编程错误
          write(rows.slice(group.from, group.from + group.texts.length), vectors);
        }
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
      scheduler.schedule(BACKFILL_KEY, clock.now() + BACKFILL_DELAY_MS, kick);
    },
    kick,
    status: () => ({
      model: embedder.model,
      available: embedder.available(),
      indexed: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material_vectors WHERE model = ?", embedder.model)?.n ?? 0),
      pending: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n ${MISSING_VECTORS}`, embedder.model)?.n ?? 0),
      state,
    }),
    async search(query, limit) {
      if (!embedder.available()) throw new EmbeddingUnavailable(`向量模型不在，没法按语义检索：${embedder.unavailableHint()}`); // @i18n-ignore log：调用方只认错误的类型
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
      for (const key of [BACKFILL_KEY, RECHECK_KEY, RETRY_KEY]) scheduler.cancel(key);
      // 先关向量函数（结束工作线程）：正在算的那批随之结束，不用等它算完
      await embedder.close();
      await running;
    },
  };
}

/** 按先后凑批：一批"条数 × 最长的字数"不超过 EMBED_MAX_CHARS（一条本身就超过的单独一批）；from 是这一批第一条的下标 */
function paddedGroups(texts: readonly string[]): Array<{ from: number; texts: string[] }> {
  const groups: Array<{ from: number; texts: string[]; longest: number }> = [];
  texts.forEach((text, i) => {
    const last = groups.at(-1);
    const longest = Math.max(last?.longest ?? 0, text.length);
    if (last && (last.texts.length + 1) * longest <= EMBED_MAX_CHARS) {
      last.texts.push(text);
      last.longest = longest;
    } else groups.push({ from: i, texts: [text], longest: text.length });
  });
  return groups.map(({ from, texts: list }) => ({ from, texts: list }));
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
