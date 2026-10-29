// 推理库 rg.db 的落盘和 manifest（225 号票，ADR-0027 的记忆插件、接入设计第 4 节）：
// - 插件自己的数据目录里一个 SQLite（`fd.dataDirLayout().rgDb` = <数据目录>/memory/subtext/rg.db，338 号票搬过去的；
//   之前是 db/rg.db），随备份快照带走；
// - 库里的 manifest 表记下 schema 版本、@ergo/memory 的表版本、整理用的模型名、向量模型名、抽取器，建库时间；
// - **版本对不上不自动迁移**：manifest 的 schema 或 @ergo/memory 的表版本（PRAGMA user_version）和代码认的不一样时，
//   不打开引擎、原样返回"要重建推理库"的原因（重建只要素材在，不丢原文）。@ergo/memory 自己遇到更新的库会抛错，也接住。
//
// 打开一次、用完关掉：守护进程启动时打开一次确认能建库（之后随手关掉），每晚整理时再打开、跑完关掉，不在守护进程里
// 长期握着 SQLite 句柄（备份的 VACUUM INTO 和彻底删除不受影响）。
import fs from "node:fs";
import path from "node:path";
import { type ChatModel, type Embedder, type FactExtractor, MemoryEngine, type PredictionJudge, type Reasoner, SCHEMA_VERSION } from "@ergo/memory";
import { openReadonlyDatabase } from "../storage/sqlite.ts";

/** 推理库的 manifest 版本（守护进程这一侧的约定；表结构、整理记录的约定变了就加 1） */
export const RG_DB_SCHEMA_VERSION = 1;
/** 写进 manifest 的引擎名（326 号票包改名成 @ergo/memory 以后照旧写这个：库里已有的值，只是标识，不拿来比对） */
export const RG_DB_ENGINE = "memory-lab";

/** 库里的 manifest（manifest 表里一行一项，这里拼成对象） */
export interface ReasoningManifest {
  /** 守护进程这一侧的版本（RG_DB_SCHEMA_VERSION） */
  schema: number;
  /** @ergo/memory 的表版本（PRAGMA user_version） */
  store: number;
  engine: string;
  /** 整理用的模型名（DeepSeek 的模型 id） */
  model: string;
  /** 向量模型名；没有向量函数是 null */
  embedder: string | null;
  /** 抽事实的实现（rule:4.1、model:<名>……） */
  extractor: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 库不能用的原因（给人看的说法在 nightly-job.ts 的 reasoningIssueText）：
 * manifest 没有、manifest 版本对不上、@ergo/memory 的表版本对不上、打开出错
 */
export type ReasoningDbIssue =
  | { code: "manifest_missing" }
  | { code: "schema_mismatch"; found: string; expected: number }
  | { code: "store_schema_mismatch"; found: string; expected: number }
  | { code: "open_failed"; detail: string };

export interface ReasoningDbOptions {
  /** rg.db 的路径（338 号票起是 <数据目录>/memory/subtext/rg.db；以前在 db 区） */
  file: string;
  /** 引擎的时钟（整理时的"现在"） */
  clock: () => string;
  /** manifest 里记下的整理模型名 */
  model: string;
  /** 向量函数；不给就不算向量 */
  embedder?: Embedder;
  /** 抽事实的实现；不给用 @ergo/memory 默认的规则版 */
  extractor?: FactExtractor;
  /** 推理实现；不给用 @ergo/memory 默认的规则版（每晚整理会自己给 LlmReasoner） */
  reasoner?: Reasoner;
  /** 263 号票：对抗复核的模型（227 的独立复核员）；不给就不复核。每晚整理给的是和推理同一个模型 */
  reviewer?: ChatModel;
  /** 263 号票：判到期预测的模型（226）；不给就只记账本、到期的留 open。每晚整理给的是 LlmPredictionJudge（同一个模型） */
  predictionJudge?: PredictionJudge;
  /**
   * 只读地打开（233 号票，网页看结论、证据、问题箱）：不写 manifest（updated_at 不动），库文件不在时也不顺手建出来。
   * 打开引擎的时候 @ergo/memory 自己会开一个写事务（建表语句、表版本），WAL 下和每晚整理按 busy_timeout 排队；
   * 除此之外这个接口不写任何东西。
   */
  readOnly?: boolean;
  /**
   * 267 号票：推理图谱的唯一写入口开成只读——秘书（ask_memory、每轮简报）、记忆页这几份引擎什么都写不进去（写一律被写入口拒）。
   * readOnly 的一定也是只读的写入口；不是 readOnly 的也可以单独要（秘书那一份要写 manifest，但不写推理图谱）
   */
  reader?: boolean;
  /** 267 号票：敏感类别里没打开推断的那几类的场景标签（按 memory.sensitiveCategories 算；写入口不让在这些上面推断） */
  sensitiveTags?: readonly string[];
}

export type ReasoningDbResult =
  | { ok: true; engine: MemoryEngine; manifest: ReasoningManifest; created: boolean }
  | { ok: false; issue: ReasoningDbIssue };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 打开库（不认识、版本对不上时不打开，把原因交回去） */
export function openReasoningDb(options: ReasoningDbOptions): ReasoningDbResult {
  const exists = fs.existsSync(options.file) && fs.statSync(options.file).size > 0;
  // 只读地看一眼：库不在就什么都不做（不建库），交给调用方回"还没建"
  if (options.readOnly === true) {
    if (!exists) return { ok: false, issue: { code: "manifest_missing" } };
  } else {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
  }
  let previous: ReasoningManifest | undefined;
  if (exists) {
    const check = readManifest(options.file);
    if (!check.ok) return check;
    if (check.manifest.schema !== RG_DB_SCHEMA_VERSION) {
      return { ok: false, issue: { code: "schema_mismatch", found: String(check.manifest.schema), expected: RG_DB_SCHEMA_VERSION } };
    }
    // 表版本以库里的 PRAGMA user_version 为准（@ergo/memory 自己会在打开时把旧库升上来；这里连旧库都不让开）
    const found = check.userVersion;
    if (found !== SCHEMA_VERSION || check.manifest.store !== SCHEMA_VERSION) {
      return { ok: false, issue: { code: "store_schema_mismatch", found: String(found), expected: SCHEMA_VERSION } };
    }
    previous = check.manifest;
  }

  let engine: MemoryEngine;
  try {
    engine = MemoryEngine.open({
      file: options.file,
      clock: options.clock,
      ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
      ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
      ...(options.reasoner === undefined ? {} : { reasoner: options.reasoner }),
      ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      ...(options.predictionJudge === undefined ? {} : { predictionJudge: options.predictionJudge }),
      writeGate: { readOnly: options.readOnly === true || options.reader === true, ...(options.sensitiveTags === undefined ? {} : { sensitiveTags: options.sensitiveTags }) },
    });
  } catch (err) {
    return { ok: false, issue: { code: "open_failed", detail: messageOf(err) } };
  }

  const now = options.clock();
  const manifest: ReasoningManifest = {
    schema: RG_DB_SCHEMA_VERSION,
    store: SCHEMA_VERSION,
    engine: RG_DB_ENGINE,
    model: options.model,
    embedder: options.embedder?.model ?? null,
    // 236 号票：启动时只确认库、手上还没有抽取器实例，沿用上一次整理记下的那个（每晚整理会写成这一次实际用的）
    extractor: options.extractor?.id || previous?.extractor || engine.extractor.id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  // 只读地打开不写 manifest：翻网页不该改动整理的记录
  if (options.readOnly !== true) writeManifest(engine, manifest);
  return { ok: true, engine, manifest, created: !exists };
}

/** 读 manifest 和表版本（只读打开，读完就关） */
function readManifest(file: string): { ok: true; manifest: ReasoningManifest; userVersion: number } | { ok: false; issue: ReasoningDbIssue } {
  let db;
  try {
    db = openReadonlyDatabase(file);
  } catch (err) {
    return { ok: false, issue: { code: "open_failed", detail: messageOf(err) } };
  }
  try {
    const userVersion = Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM rg_manifest");
    if (rows.length === 0) return { ok: false, issue: { code: "manifest_missing" } };
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const manifest = manifestFrom(values);
    if (manifest === undefined) return { ok: false, issue: { code: "manifest_missing" } };
    return { ok: true, manifest, userVersion };
  } catch (err) {
    const detail = messageOf(err);
    // 没有 manifest 表：旧版、或者根本不是推理库
    if (/no such table|no such column/i.test(detail)) return { ok: false, issue: { code: "manifest_missing" } };
    return { ok: false, issue: { code: "open_failed", detail } };
  } finally {
    db.close();
  }
}

/** manifest 表的键值 → 对象；缺了认不出来的项算没有 manifest */
function manifestFrom(values: Readonly<Record<string, string>>): ReasoningManifest | undefined {
  const schema = Number(values.schema);
  const store = Number(values.store);
  if (!Number.isInteger(schema) || !Number.isInteger(store)) return undefined;
  return {
    schema,
    store,
    engine: values.engine ?? "",
    model: values.model ?? "",
    embedder: values.embedder === undefined || values.embedder === "" ? null : values.embedder,
    extractor: values.extractor ?? "",
    createdAt: values.created_at ?? "",
    updatedAt: values.updated_at ?? "",
  };
}

/** 写 manifest（建表，一项一行；再打开时更新 updated_at） */
function writeManifest(engine: MemoryEngine, manifest: ReasoningManifest): void {
  const db = engine.store.db;
  db.exec("CREATE TABLE IF NOT EXISTS rg_manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const rows: Array<[string, string]> = [
    ["schema", String(manifest.schema)],
    ["store", String(manifest.store)],
    ["engine", manifest.engine],
    ["model", manifest.model],
    ["embedder", manifest.embedder ?? ""],
    ["extractor", manifest.extractor],
    ["created_at", manifest.createdAt],
    ["updated_at", manifest.updatedAt],
  ];
  for (const [key, value] of rows) {
    db.run("INSERT INTO rg_manifest (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
}
