// 225 号票：推理库 rg.db 的落盘、manifest 和"版本对不上不自动迁移"。用临时目录里的真 SQLite 和真 MemoryEngine，
// 没有模型调用（manifest 只是记下模型名）。
import fs from "node:fs";
import path from "node:path";
import { type ChatModel, LlmFactExtractor, SCHEMA_VERSION } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { openReasoningDb, RG_DB_SCHEMA_VERSION } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-10 是周六） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 库里的 manifest（键 → 值）；没有这张表时抛错 */
function manifestOf(file: string): Record<string, string> {
  const db = openDatabase(file);
  try {
    return Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM rg_manifest").map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

/** 临时目录里 db/rg.db 的路径 */
function rgDbFile(): string {
  return path.join(makeTempDir("ergo-rgdb-"), "db", "rg.db");
}

describe("推理库 rg.db", () => {
  it("第一次打开就建好库，manifest 里写清 schema、模型、向量模型名；引擎能正常写证据", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: kernelEmbedderAdapter(new FakeEmbedder()) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.created).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(manifestOf(file)).toMatchObject({
      schema: String(RG_DB_SCHEMA_VERSION),
      engine: "memory-lab",
      model: "deepseek-flash",
      embedder: "fake-embed@1",
    });
    expect(opened.manifest).toMatchObject({ schema: RG_DB_SCHEMA_VERSION, model: "deepseek-flash", embedder: "fake-embed@1" });
    expect(opened.manifest.createdAt).toMatch(/^2026-10-10T03:00:00/);

    // 是真的 MemoryEngine：能写证据
    opened.engine.ingestEvidence({
      sourceLevel: "self",
      mode: "say",
      kind: "utterance",
      text: "周六在家看书",
      context: ["weekend"],
      eventTime: "2026-10-09T20:00:00+08:00",
      observedAt: "2026-10-09T20:00:00+08:00",
      sourceRef: "mat-1",
    });
    expect(opened.engine.store.listEvidence()).toHaveLength(1);
    opened.engine.close();
  });

  it("再打开不重建：created 是 false，created_at 留着、updated_at 跟着更新", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const first = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.engine.close();
    const createdAt = manifestOf(file).created_at;

    clock.advanceTo(at(10, 11, 3, 0));
    const second = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    const manifest = manifestOf(file);
    expect(manifest.created_at).toBe(createdAt);
    expect(manifest.updated_at).toMatch(/^2026-10-11T03:00:00/);
    second.engine.close();
  });

  // 236 号票：插件启动时只确认库、不打开整理（没有模型实例），manifest 里上次整理记下的抽取器要留着
  it("启动时没给抽取器：manifest 里的抽取器沿用上一次整理记下的那个", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const neverCalled: ChatModel = { name: "fake-llm", complete: () => Promise.reject(new Error("确认库时不调模型")) };
    const modelRun = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", extractor: new LlmFactExtractor(neverCalled) });
    if (!modelRun.ok) throw new Error("应该能建库");
    modelRun.engine.close();
    expect(manifestOf(file).extractor).toBe("model:fake-llm");

    const startup = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!startup.ok) throw new Error("应该能打开");
    startup.engine.close();
    expect(manifestOf(file).extractor).toBe("model:fake-llm");
  });

  it("manifest 的 schema 对不上：不打开、不自动迁移，回一条\"要重建\"的原因", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const created = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!created.ok) throw new Error("应该能建库");
    created.engine.close();
    const db = openDatabase(file);
    try {
      db.run("UPDATE rg_manifest SET value = '99' WHERE key = 'schema'");
    } finally {
      db.close();
    }

    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.issue).toEqual({ code: "schema_mismatch", found: "99", expected: RG_DB_SCHEMA_VERSION });
    // 没有顺手把它改成新版本
    expect(manifestOf(file).schema).toBe("99");
  });

  it("没有 manifest 的库（旧版、或者不是推理库）：不打开，回 manifest_missing", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openDatabase(file);
    try {
      db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY)");
    } finally {
      db.close();
    }
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.issue).toEqual({ code: "manifest_missing" });
  });

  it("库的表版本比代码新（比如降级了守护进程）：不打开、不迁移，回 store_schema_mismatch", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const created = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!created.ok) throw new Error("应该能建库");
    created.engine.close();
    const db = openDatabase(file);
    try {
      db.exec("PRAGMA user_version = 99");
    } finally {
      db.close();
    }
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.issue).toEqual({ code: "store_schema_mismatch", found: "99", expected: SCHEMA_VERSION });
  });

  it("文件不是 SQLite：回 open_failed，不让守护进程跟着起不来", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "这不是一个 SQLite 库");
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.issue.code).toBe("open_failed");
  });

  // 233 号票：网页的只读接口随用随开引擎，不写 manifest、库不在也不建
  it("只读地打开：updated_at 不动；库不在时不建，回 manifest_missing", () => {
    const clock = new ManualClock(at(10, 10, 3, 0));
    const file = rgDbFile();
    const created = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!created.ok) throw new Error("应该能建库");
    created.engine.close();
    const before = manifestOf(file);

    // 时间往后拨了，只读打开也不该把 updated_at 写新
    clock.advanceTo(at(10, 11, 9, 0));
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", readOnly: true });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.created).toBe(false);
    expect(manifestOf(file)).toEqual(before);
    // 引擎读得到（只读接口要读结论、证据、问题）
    expect(opened.engine.store.listClaims()).toEqual([]);
    opened.engine.close();

    // 库不在：只读打开不顺手建一个
    const missing = path.join(makeTempDir("ergo-rgdb-"), "db", "rg.db");
    const none = openReasoningDb({ file: missing, clock: () => clockIso(clock), model: "deepseek-flash", readOnly: true });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.issue).toEqual({ code: "manifest_missing" });
    expect(fs.existsSync(missing)).toBe(false);
  });
});
