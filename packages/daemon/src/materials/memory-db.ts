// materials.db（规格第 4、15 节）：素材和索引的单独的库（WAL），经存储薄接口打开。以前叫 memory.db，ADR-0035 改了名
// （老名字和记忆插件的数据目录撞了）；老库由启动时的迁移搬过来（materials/migrate-materials.ts）。
// 只有素材模块拿得到它的连接（这个文件不出 materials/ 目录，素材模块对外不暴露连接）。
// - materials：素材信封；search_text 是本人切段的文字加上引用的说明（文件名、网址、卡片类型和标题），关键词和向量都只索引它；
//   166 号票起还加上采集规则给的外部正文（MaterialDraft.indexText：只有用户主动存的网页给），它不在信封里；
// - material_fts：关键词索引，FTS5 trigram 分词器（中文可用；3 个字以下的查询退回子串扫描）；
// - material_vectors：向量，每条旁边记着模型名；
// - capture_state：采集到事件日志的哪一条（全局序号）；记忆插件没开时只保管原话副本、照做删除，那时处理到哪一条另记一个键（129 号票）；
//   索引文字的版本另记一个键（166 号票：旧库里的素材按原始事件重算一遍索引文字）；
// - material_marks：记忆命令留下的标记（21 号票）：被忘掉（含彻底删除）的素材 id（墓碑：重建、从原文副本补回时都跳过），
//   不参与推断的素材 id。按素材 id 记，和素材本身在不在无关（只在原文副本里的素材补回来时照样带上标记）。
// 303 号票：materials 多一列 origin（数据源素材的出处：哪个数据源、场景、敏感类别，JSON；别的素材是 NULL），
//   场景里的地点、和谁也进索引文字（检索"望京的公司"找得到那天在那儿的素材）。
import path from "node:path";
import { type Database, openDatabase } from "../storage/sqlite.ts";
import type { Material, MaterialKind, OriginalCopy } from "./types.ts";

export const MATERIALS_DB_FILE = "materials.db";

/**
 * 库的版本（PRAGMA user_version）：以后的票改表时据此迁移。
 * 2：加 material_marks（21 号票）。表都是 IF NOT EXISTS 建的，版本 1 的库打开时自动补上
 * 3：materials 加 origin 列（303 号票）。旧库打开时补上这一列（ALTER TABLE，已有的素材是 NULL）
 */
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  time TEXT NOT NULL,
  conversation TEXT,
  task TEXT,
  project TEXT,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  context TEXT NOT NULL,
  segments TEXT NOT NULL,
  original TEXT,
  search_text TEXT NOT NULL,
  origin TEXT
);
CREATE INDEX IF NOT EXISTS materials_by_order ON materials (event_seq, position);
CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(material_id UNINDEXED, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS material_vectors (
  material_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS material_vectors_by_model ON material_vectors (model);
CREATE TABLE IF NOT EXISTS capture_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS material_marks (
  material_id TEXT PRIMARY KEY,
  forgotten INTEGER NOT NULL DEFAULT 0,
  no_infer INTEGER NOT NULL DEFAULT 0
);
`;

export function openMaterialsDb(dbDir: string): Database {
  const db = openDatabase(path.join(dbDir, MATERIALS_DB_FILE));
  db.transaction(() => {
    db.exec(SCHEMA);
    // 303：旧库的 materials 没有 origin 列（CREATE TABLE IF NOT EXISTS 不补列）
    if (!db.all<{ name: string }>("PRAGMA table_info(materials)").some((c) => c.name === "origin")) db.exec("ALTER TABLE materials ADD COLUMN origin TEXT");
    const version = Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    else if (version > SCHEMA_VERSION) throw new Error(`materials.db 的版本 ${version} 比这个守护进程认识的 ${SCHEMA_VERSION} 新`); // @i18n-ignore log：编程错误
  });
  return db;
}

interface MaterialRow {
  id: string;
  kind: MaterialKind;
  mode: Material["mode"];
  time: string;
  conversation: string | null;
  task: string | null;
  project: string | null;
  source: Material["source"];
  ref: string;
  context: string;
  segments: string;
  original: string | null;
  origin: string | null;
  no_infer: number | null;
}

/** 读素材时取的列（m 是 materials 表）；带上标记 */
const SELECT_MATERIAL = `SELECT m.id, m.kind, m.mode, m.time, m.conversation, m.task, m.project, m.source, m.ref, m.context, m.segments, m.original, m.origin,
  (SELECT k.no_infer FROM material_marks k WHERE k.material_id = m.id) AS no_infer`;

function toMaterial(row: MaterialRow): Material {
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    time: row.time,
    conversation: row.conversation,
    task: row.task,
    project: row.project,
    source: row.source,
    ref: JSON.parse(row.ref) as Material["ref"],
    context: JSON.parse(row.context) as string[],
    segments: JSON.parse(row.segments) as Material["segments"],
    original: row.original === null ? null : (JSON.parse(row.original) as Material["original"]),
    ...(row.origin === null ? {} : { origin: JSON.parse(row.origin) as NonNullable<Material["origin"]> }),
    noInfer: row.no_infer === 1,
  };
}

/**
 * 进索引的文字：本人切段的原文，加上引用的说明（附件文件名、网址、卡片类型和标题）。
 * 外部内容和 agent 产出的正文不进——例外是采集规则给的外部正文 indexText（166 号票：用户主动存的网页的正文），接在最后。
 * 303 号票：数据源素材场景里的地点、和谁也进（各一行，接在切段后面、外部正文前面）。
 * 关键词索引和向量都只看它（向量只算开头，vectors.ts）
 */
export function searchTextOf(material: Pick<Material, "segments" | "origin">, indexText?: string): string {
  const scene = material.origin?.scene;
  return [...material.segments.map((s) => (s.source === "self" ? s.text : s.label)), scene?.place, scene?.people?.join(" "), indexText]
    .filter((t): t is string => t !== undefined && t.length > 0)
    .join("\n");
}

export function hasMaterial(db: Database, id: string): boolean {
  return db.get("SELECT 1 AS found FROM materials WHERE id = ?", id) !== undefined;
}

/** 写一条素材（同一个 id 已经在、或者被忘掉过就不写）；indexText 是采集规则给的外部正文（只进索引）；在调用方的事务里 */
export function insertMaterial(db: Database, material: Omit<Material, "noInfer">, position: number, indexText?: string): boolean {
  if (isForgotten(db, material.id)) return false;
  const searchText = searchTextOf(material, indexText);
  const { changes } = db.run(
    `INSERT OR IGNORE INTO materials (id, event_seq, position, kind, mode, time, conversation, task, project, source, ref, context, segments, original, search_text, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    material.id,
    material.ref.event.globalSeq,
    position,
    material.kind,
    material.mode,
    material.time,
    material.conversation,
    material.task,
    material.project,
    material.source,
    JSON.stringify(material.ref),
    JSON.stringify(material.context),
    JSON.stringify(material.segments),
    material.original === null ? null : JSON.stringify(material.original),
    searchText,
    material.origin === undefined ? null : JSON.stringify(material.origin),
  );
  if (changes === 0) return false;
  if (searchText.length > 0) db.run("INSERT INTO material_fts (material_id, body) VALUES (?, ?)", material.id, searchText);
  return true;
}

/** 换掉一条素材的索引文字（166 号票：旧库按原始事件重算）：关键词索引跟着换，向量删掉等补算；在调用方的事务里。返回换没换 */
export function replaceSearchText(db: Database, id: string, searchText: string): boolean {
  const row = db.get<{ search_text: string }>("SELECT search_text FROM materials WHERE id = ?", id);
  if (!row || row.search_text === searchText) return false;
  db.run("UPDATE materials SET search_text = ? WHERE id = ?", searchText, id);
  db.run("DELETE FROM material_fts WHERE material_id = ?", id);
  if (searchText.length > 0) db.run("INSERT INTO material_fts (material_id, body) VALUES (?, ?)", id, searchText);
  db.run("DELETE FROM material_vectors WHERE material_id = ?", id);
  return true;
}

export function getMaterial(db: Database, id: string): Material | undefined {
  const row = db.get<MaterialRow>(`${SELECT_MATERIAL} FROM materials m WHERE m.id = ?`, id);
  return row && toMaterial(row);
}

export interface MaterialFilter {
  kind?: MaterialKind;
  conversation?: string;
  /** 从这条消息采来的（素材信封的 ref.messageId；264 号票：顺口问的回答回写成证据时找那句话的素材） */
  messageId?: string;
  /** 最多多少条（默认全部） */
  limit?: number;
}

/** 素材，按原始事件的先后 */
export function listMaterials(db: Database, filter: MaterialFilter = {}): Material[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.kind !== undefined) {
    where.push("m.kind = ?");
    params.push(filter.kind);
  }
  if (filter.conversation !== undefined) {
    where.push("m.conversation = ?");
    params.push(filter.conversation);
  }
  if (filter.messageId !== undefined) {
    where.push("json_extract(m.ref, '$.messageId') = ?");
    params.push(filter.messageId);
  }
  const sql = `${SELECT_MATERIAL} FROM materials m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.event_seq, m.position LIMIT ?`;
  return db.all<MaterialRow>(sql, ...params, filter.limit ?? -1).map(toMaterial);
}

/** trigram 分词器查不了的短词：3 个字以下（按 Unicode 字符数） */
const TRIGRAM_MIN_CHARS = 3;

/**
 * 关键词检索。查询按空白拆成几个词，每个词都要出现（AND）。
 * 3 个字以上的词走 FTS5 trigram 索引，按相关度排；有 3 个字以下的词时，这些词在候选里做子串过滤；
 * 全是短词时整个退回子串扫描（新的在前）。
 */
export function keywordSearch(db: Database, query: string, limit: number): Material[] {
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const long = terms.filter((t) => Array.from(t).length >= TRIGRAM_MIN_CHARS);
  const short = terms.filter((t) => Array.from(t).length < TRIGRAM_MIN_CHARS);
  const shortFilter = short.map(() => "instr(lower(m.search_text), lower(?)) > 0");
  if (long.length > 0) {
    const match = long.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
    const sql = `${SELECT_MATERIAL}
      FROM material_fts f JOIN materials m ON m.id = f.material_id
      WHERE material_fts MATCH ? ${shortFilter.map((c) => `AND ${c}`).join(" ")}
      ORDER BY f.rank, m.event_seq DESC LIMIT ?`;
    return db.all<MaterialRow>(sql, match, ...short, limit).map(toMaterial);
  }
  const sql = `${SELECT_MATERIAL}
    FROM materials m WHERE ${shortFilter.join(" AND ")}
    ORDER BY m.event_seq DESC, m.position DESC LIMIT ?`;
  return db.all<MaterialRow>(sql, ...short, limit).map(toMaterial);
}

const CURSOR_KEY = "captured_global_seq";
/** 只保管（记忆插件没开）时处理到事件日志的哪一条（129 号票）：采集位置停在停用那一刻，再启用时从那里补采 */
const KEPT_KEY = "kept_global_seq";

const readState = (db: Database, key: string) => Number(db.get<{ value: number }>("SELECT value FROM capture_state WHERE key = ?", key)?.value ?? 0);
const writeState = (db: Database, key: string, globalSeq: number) =>
  db.run("INSERT INTO capture_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, globalSeq);

/** 已经采集到事件日志的哪一条（全局序号；没采过是 0） */
export function readCursor(db: Database): number {
  return readState(db, CURSOR_KEY);
}

export function writeCursor(db: Database, globalSeq: number): void {
  writeState(db, CURSOR_KEY, globalSeq);
}

/** 只保管时（不采成素材，只留原话副本、照做删除）处理到事件日志的哪一条（没有过是 0） */
export function readKeptCursor(db: Database): number {
  return readState(db, KEPT_KEY);
}

export function writeKeptCursor(db: Database, globalSeq: number): void {
  writeState(db, KEPT_KEY, globalSeq);
}

/** 索引文字的版本（166 号票）：库里记的比这个旧时，按原始事件重算一遍已有素材的索引文字。没记过是 0 */
const SEARCH_TEXT_VERSION_KEY = "search_text_version";

export function readSearchTextVersion(db: Database): number {
  return readState(db, SEARCH_TEXT_VERSION_KEY);
}

export function writeSearchTextVersion(db: Database, version: number): void {
  writeState(db, SEARCH_TEXT_VERSION_KEY, version);
}

/** 这条素材被忘掉过（墓碑）：重建、从原文副本补回时都不再写进来 */
export function isForgotten(db: Database, id: string): boolean {
  return db.get("SELECT 1 AS found FROM material_marks WHERE material_id = ? AND forgotten = 1", id) !== undefined;
}

/** 这条素材标着"不参与推断"（按素材 id 记，素材本身不在库里时也查得到） */
export function isNoInfer(db: Database, id: string): boolean {
  return db.get("SELECT 1 AS found FROM material_marks WHERE material_id = ? AND no_infer = 1", id) !== undefined;
}

/** 被忘掉过的素材 id */
export function forgottenIds(db: Database): Set<string> {
  return new Set(db.all<{ material_id: string }>("SELECT material_id FROM material_marks WHERE forgotten = 1").map((r) => r.material_id));
}

/**
 * 忘掉一批素材（忘掉、彻底删除）：删掉素材和它的关键词、向量索引，留下墓碑；在调用方的事务里。
 * 返回删掉之前它们的原文副本（调用方提交后再删文件）
 */
export function forgetMaterials(db: Database, ids: readonly string[]): OriginalCopy[] {
  const originals: OriginalCopy[] = [];
  for (const id of ids) {
    const row = db.get<{ original: string | null }>("SELECT original FROM materials WHERE id = ?", id);
    if (row?.original) originals.push(JSON.parse(row.original) as OriginalCopy);
    db.run("DELETE FROM materials WHERE id = ?", id);
    db.run("DELETE FROM material_fts WHERE material_id = ?", id);
    db.run("DELETE FROM material_vectors WHERE material_id = ?", id);
    db.run("INSERT INTO material_marks (material_id, forgotten) VALUES (?, 1) ON CONFLICT (material_id) DO UPDATE SET forgotten = 1", id);
  }
  return originals;
}

/** 还有没有素材引用这个媒体（附件的切段里记着媒体 id）：彻底删除后决定能不能删媒体文件 */
export function referencesMedia(db: Database, mediaId: string): boolean {
  return db.get("SELECT 1 AS found FROM materials WHERE instr(segments, ?) > 0 LIMIT 1", mediaId) !== undefined;
}

/** 标记一批素材不参与推断（别推断）；在调用方的事务里 */
export function markNoInfer(db: Database, ids: readonly string[]): void {
  for (const id of ids) {
    db.run("INSERT INTO material_marks (material_id, no_infer) VALUES (?, 1) ON CONFLICT (material_id) DO UPDATE SET no_infer = 1", id);
  }
}
