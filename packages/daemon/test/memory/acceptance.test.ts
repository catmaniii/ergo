// 235 号票：上线验收脚本（test/memory/acceptance.ts）。在一个临时数据目录里放好推理库、整理记录和素材库，
// 跑一遍逐条检查（rg.db 和 manifest、最近一次整理记录、现算简报、素材检索、插件停用后作业撤销），应当全过；
// 数据目录里什么都还没有时不抛错，逐条写清楚为什么不过。只读：跑完素材库一个字节没动、manifest 的 updated_at 没动。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { ASK_MEMORY_MAX_CHARS } from "../../src/memory/ask-tool.ts";
import { appendNightlyRecord, type MemoryNightlyRecord, memoryNightlyView } from "../../src/memory/nightly-record.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase, openReadonlyDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { ACCEPTANCE_QUESTION, runAcceptance } from "./acceptance.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** rg.db 的 manifest 里 updated_at（只读看一眼） */
function manifestUpdatedAt(file: string): string | undefined {
  const db = openReadonlyDatabase(file);
  try {
    return db.get<{ value: string }>("SELECT value FROM rg_manifest WHERE key = 'updated_at'")?.value;
  } finally {
    db.close();
  }
}

/** 一个像样的数据目录：能打开的 rg.db（有结论）、一条跑过的整理记录、一个（空的）素材库 */
async function preparedDataDir(): Promise<string> {
  const dir = makeTempDir("ergo-acceptance-");
  const layout = dataDirLayout(dir);
  fs.mkdirSync(layout.db, { recursive: true });
  const clock = new ManualClock(at(11, 9));
  // 整理记录：昨晚跑过了，新出 2 条、改了 1 条、问题箱开着 3 个
  const store = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [memoryNightlyView], now: () => clockIso(clock), log: () => {} });
  const record: MemoryNightlyRecord = {
    night: "2026-10-10",
    at: "2026-10-10T03:00:05+08:00",
    state: "ran",
    trigger: "scheduled",
    ranAt: "2026-10-10T03:00:05+08:00",
    deferrals: 0,
    newClaims: 2,
    changedClaims: 1,
    reviewed: 0,
    needsReview: 0,
    questions: { added: 1, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 3 },
    modelCalls: 120,
    budgetExhausted: false,
    processedEvidence: 4,
    pendingEvidence: 0,
    text: "整理报告",
  };
  appendNightlyRecord(store, record);
  store.close();
  // 推理库：建好、灌一条证据、整理一遍（规则版，不调模型）
  const opened = openReasoningDb({ file: layout.rgDb, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("应该能建库");
  opened.engine.ingestEvidence({
    sourceLevel: "self",
    mode: "say",
    kind: "utterance",
    text: "这周六的聚会我就不去了，最近周末想好好休息。",
    context: ["weekend"],
    eventTime: "2026-10-09T20:00:00+08:00",
    observedAt: "2026-10-09T20:00:00+08:00",
    sourceRef: "mat-acceptance-1",
  });
  await opened.engine.reflect();
  opened.engine.close();
  // 素材库：一个空的库文件就够（检索这条路通不通不看有几条）
  openDatabase(layout.materialsDb).close();
  return dir;
}

describe("记忆上线验收（memory:acceptance）", () => {
  it("准备好的数据目录：rg.db / 整理记录 / 简报 / 素材检索 / 插件停用后作业撤销逐条都过；只读，跑完数据没动", { timeout: 60_000 }, async () => {
    const dir = await preparedDataDir();
    const layout = dataDirLayout(dir);
    const memoryHash = sha256(layout.materialsDb);
    const updatedAt = manifestUpdatedAt(layout.rgDb);
    const lines: string[] = [];
    const report = await runAcceptance({ dataDir: dir, log: (line) => lines.push(line) });

    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    // 逐条：名字是票里列的五样，外加一句只读口径
    expect(report.checks.map((check) => check.name)).toEqual([
      "rg.db 能打开、manifest 和表版本对得上",
      "最近一次整理记录",
      `现算一份简报（memoryBrief，上限 ${ASK_MEMORY_MAX_CHARS} 字）`,
      "素材检索（search_materials 走的同一条路）",
      "插件停用后每晚整理作业撤销（假时钟 + 假插件宿主）",
      "只读",
    ]);
    // 输出里有人看得懂的时间和结果，没有素材原文
    expect(lines.join("\n")).toContain("2026-10-10 03:00 整理了：新出 2 条结论、改了 1 条");
    expect(lines.join("\n")).toContain(ACCEPTANCE_QUESTION);
    expect(lines.join("\n")).not.toContain("聚会");
    expect(report.checks.find((check) => check.name === `现算一份简报（memoryBrief，上限 ${ASK_MEMORY_MAX_CHARS} 字）`)!.detail).toMatch(/现算了一份 \d+ 字/);

    // 只读：素材库一个字节没动（只用了 VACUUM INTO 的副本），manifest 的 updated_at 也没被写新
    expect(sha256(layout.materialsDb)).toBe(memoryHash);
    expect(manifestUpdatedAt(layout.rgDb)).toBe(updatedAt);
    expect(manifestUpdatedAt(layout.rgDb)).toBe("2026-10-11T09:00:00.000+08:00");
  });

  it("数据目录里什么都还没有：不抛错，逐条写清楚为什么不过（插件停用那一项照样在临时目录里验过）", { timeout: 60_000 }, async () => {
    const dir = makeTempDir("ergo-acceptance-empty-");
    const report = await runAcceptance({ dataDir: dir });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((check) => !check.ok);
    expect(failed.map((check) => check.name)).toEqual([
      "rg.db 能打开、manifest 和表版本对得上",
      "最近一次整理记录",
      `现算一份简报（memoryBrief，上限 ${ASK_MEMORY_MAX_CHARS} 字）`,
      "素材检索（search_materials 走的同一条路）",
    ]);
    expect(failed[0]!.detail).toContain("还没有 rg.db");
    expect(failed[1]!.detail).toContain("没有事件日志");
    expect(failed[3]!.detail).toContain("没有素材库");
    // 插件停用这一项和真实数据无关，自己能过
    expect(report.checks.find((check) => check.name.startsWith("插件停用"))!.ok).toBe(true);
  });
});
