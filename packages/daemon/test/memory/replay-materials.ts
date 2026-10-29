// 离线回放素材库（224 号票）：把用户数据目录里的 materials.db 复制一份到临时目录，在副本上打开素材库和证据适配器，
// 把素材数、证据数、各来源级别条数、场景分布打成一行摘要，和人眼看到的素材数对得上。
// 不碰真实数据：源库只用只读连接做一次一致快照（VACUUM INTO），打开的、写的都是临时目录里的副本，跑完就删。
// 拿不到真实数据（找不到库）时用这里的假素材跑一遍，照样打印摘要；测试里也这样跑通。
//
//   node packages/daemon/test/memory/replay-materials.ts                 用户数据目录（$ERGO_DATA_DIR，没有就是 ~/.ergo）
//   node packages/daemon/test/memory/replay-materials.ts --data-dir <目录>
//   node packages/daemon/test/memory/replay-materials.ts --db <materials.db 的路径>
//   npm run memory:replay                                                （同上，不带参数）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceLevel } from "@ergo/memory";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { type Materials, openMaterials } from "../../src/materials/index.ts";
import type { Material } from "../../src/materials/types.ts";
import { materialIdsOfRef } from "../../src/memory/data-source-evidence.ts";
import { MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import { clockIso, type Clock, systemClock } from "../../src/scheduler/clock.ts";
import { vacuumIntoSync } from "../../src/storage/sqlite.ts";

/**
 * 素材库的文件名（materials/memory-db.ts 的 MATERIALS_DB_FILE 不对外，素材模块只给读和检索）。
 * 这里只在测试脚本里拼路径：源库是用户数据目录里那个文件，副本是临时目录里的一个普通库文件。
 */
const MATERIALS_DB_NAME = "materials.db";

/** 一行摘要里的数 */
export interface ReplaySummary {
  /** 素材库里的条数（人眼看到的） */
  materials: number;
  /** 读出来的证据条数 */
  evidence: number;
  /** 没读成证据的素材：标了别推断的、没有原文的 */
  skipped: { noInfer: number; emptyText: number };
  /** 各来源级别各几条 */
  bySourceLevel: Record<SourceLevel, number>;
  /** 场景分布：标签 → 几条证据带它 */
  scenes: Record<string, number>;
  /** 一个场景标签都没有的证据 */
  noScene: number;
  /** 这批证据的"现在" */
  now: string;
}

/** 只看素材库的读接口（Materials 里只用 list），假素材库也能传 */
export type MaterialsReader = Pick<Materials, "list">;

/** 读一遍、数一数（回放脚本和测试都用它） */
export function summarizeMaterials(materials: MaterialsReader, clock: Clock): ReplaySummary {
  const all = materials.list();
  const source = new MaterialsEvidenceSource({ materials, clock });
  const drafts = source.read();
  // 303 号票：几条数据源素材合成的一条证据，背后的素材都算读到了
  const read = new Set(drafts.flatMap((d) => materialIdsOfRef(d.sourceRef)));
  const bySourceLevel: Record<SourceLevel, number> = { self: 0, agent: 0, untrusted: 0, system: 0 };
  const scenes: Record<string, number> = {};
  let noScene = 0;
  for (const draft of drafts) {
    bySourceLevel[draft.sourceLevel] += 1;
    if (draft.context.length === 0) noScene += 1;
    for (const tag of draft.context) scenes[tag] = (scenes[tag] ?? 0) + 1;
  }
  return {
    materials: all.length,
    evidence: drafts.length,
    skipped: { noInfer: all.filter((m) => m.noInfer).length, emptyText: all.filter((m) => !m.noInfer && !read.has(m.id)).length },
    bySourceLevel,
    scenes,
    noScene,
    now: source.now,
  };
}

/** 按条数从多到少排、名字相同的按名字排，拼成"weekend 2、social 1" */
function countBy(record: Record<string, number>): string {
  return Object.entries(record)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n}`)
    .join("、");
}

/** 摘要打一行：素材数、证据数、按来源等级、没读的、场景分布 */
export function summaryLine(summary: ReplaySummary): string {
  const skipped = summary.skipped.noInfer + summary.skipped.emptyText;
  return [
    `素材 ${summary.materials} 条`,
    `证据 ${summary.evidence} 条`,
    `来源：${countBy(summary.bySourceLevel)}`,
    `没读 ${skipped}（别推断 ${summary.skipped.noInfer}、没有原文 ${summary.skipped.emptyText}）`,
    `场景：${countBy(summary.scenes) || "（无）"}，空场景 ${summary.noScene}`,
    `now ${summary.now}`,
  ].join(" / ");
}

export interface ReplayOptions {
  /** 用户数据目录里的 materials.db（只读它） */
  source: string;
  clock?: Clock;
  log?: (line: string) => void;
}

/**
 * 把 materials.db 复制到临时目录、在副本上打开素材库、读一遍证据、打摘要；副本用完删掉。
 * 源库只被只读打开一次（VACUUM INTO 做一致快照），真实数据一个字节都不动。
 */
export async function replayMaterialsDb(options: ReplayOptions): Promise<ReplaySummary> {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-replay-"));
  const dbDir = path.join(work, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const copy = path.join(dbDir, MATERIALS_DB_NAME);
  // 副本上的事件日志是空的（素材库靠它补采，这里不需要）：打开它只是为了给素材库一个正常的工作目录
  const store = openEventStore({ file: path.join(dbDir, "ergo.db"), views: [], now: () => clockIso(clock), log });
  let materials: Materials | undefined;
  try {
    vacuumIntoSync(options.source, copy);
    materials = openMaterials({ store, dbDir, materialsDir: path.join(work, "materials"), log });
    materials.start();
    return summarizeMaterials(materials, clock);
  } finally {
    await materials?.stop();
    store.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** 有库就回放副本，找不到库就用假素材（脚本的降级路径） */
export async function replaySource(options: ReplayOptions): Promise<ReplaySummary> {
  if (!fs.existsSync(options.source)) return summarizeMaterials({ list: () => fakeMaterials() }, options.clock ?? systemClock);
  return replayMaterialsDb(options);
}

/** 拿不到真实数据时用的假素材：一条周末的本人发言、一条系统记的任务结局、一条标了别推断的 */
export function fakeMaterials(): Material[] {
  let seq = 0;
  const material = (fields: Pick<Material, "id" | "kind" | "mode" | "source" | "time" | "context" | "segments" | "noInfer">): Material => {
    seq += 1;
    return {
      ...fields,
      conversation: "secretary",
      task: null,
      project: null,
      ref: { event: { globalSeq: seq, channel: "secretary", seq, type: "message" } },
      original: null,
    };
  };
  return [
    material({
      id: "mat-fake-1",
      kind: "user_utterance",
      mode: "say",
      source: "self",
      time: "2026-10-08T09:30:00.000+08:00",
      context: ["secretary"],
      segments: [{ form: "typed", source: "self", notes: [], locator: {}, text: "周六和朋友聚餐", sha256: "fake-1" }],
      noInfer: false,
    }),
    material({
      id: "mat-fake-2",
      kind: "task_outcome",
      mode: "do",
      source: "system",
      time: "2026-10-08T10:00:00.000+08:00",
      context: ["tool:bash"],
      segments: [{ form: "agent_output", source: "agent", notes: [], locator: {}, label: "任务做完了" }],
      noInfer: false,
    }),
    material({
      id: "mat-fake-3",
      kind: "user_utterance",
      mode: "say",
      source: "self",
      time: "2026-10-08T11:00:00.000+08:00",
      context: ["secretary"],
      segments: [{ form: "typed", source: "self", notes: [], locator: {}, text: "这个别记进推断里", sha256: "fake-3" }],
      noInfer: true,
    }),
  ];
}

interface ReplayArgs {
  db?: string;
  dataDir?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ReplayArgs {
  const args: ReplayArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--db" || arg === "--data-dir") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 后面要跟一个路径`);
      if (arg === "--db") args.db = value;
      else args.dataDir = value;
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }
  return args;
}

/** 用户数据目录（和守护进程一样：$ERGO_DATA_DIR，没有就是 ~/.ergo）里的 materials.db */
function defaultMaterialsDb(): string {
  const fromEnv = process.env.ERGO_DATA_DIR;
  const dataDir = fromEnv !== undefined && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), ".ergo");
  return dataDirLayout(dataDir).materialsDb;
}

const USAGE = [
  "离线回放素材库（224 号票）：复制一份 materials.db 到临时目录，打印素材/证据/来源级别/场景分布的摘要。",
  "",
  "用法：",
  "  node packages/daemon/test/memory/replay-materials.ts                 # 用户数据目录（$ERGO_DATA_DIR 或 ~/.ergo）",
  "  node packages/daemon/test/memory/replay-materials.ts --data-dir <目录>",
  "  node packages/daemon/test/memory/replay-materials.ts --db <materials.db 的路径>",
  "  npm run memory:replay",
  "",
  "真实数据一个字节都不动：源库只读一次做快照，之后读的都是临时目录里的副本。",
  "找不到库时用测试里的假素材跑一遍，照样打印摘要。",
].join("\n");

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const source = args.db ?? (args.dataDir === undefined ? defaultMaterialsDb() : dataDirLayout(args.dataDir).materialsDb);
  if (fs.existsSync(source)) console.log(`回放 ${source}（复制一份到临时目录，只读副本）：`);
  else console.log(`找不到素材库 ${source}：拿不到真实数据，用测试里的假素材跑一遍。`);
  // 副本上的事件日志是空的（只有素材库），素材库启动时会说一句"采集位置比事件日志末尾还靠后"，那是预期的，
  // 所以这里不给日志回调，摘要就一行。
  console.log(summaryLine(await replaySource({ source })));
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (entry !== undefined && entry === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
