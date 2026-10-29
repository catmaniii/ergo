// 离线把素材库整理一遍（239 号票的前置工具，随手补的运维脚本）：按素材库重建推理库，或者一次性把攒下的素材全做完，
// 不用等 03:00、也不用在页面上点"立即整理一次"。
//
// 走的是守护进程同一份作业逻辑（`memory/nightly-job.ts` 的 `runNow`）：同一个引擎、同一种抽事实（模型版，和评测一致）、
// 同一套增量簿记（素材按 sourceRef 跳过、抽事实按 extraction_log 每条一次、假设/追问走 rg_*）。所以：
// - **可以反复跑**：第二次几乎不调模型；
// - **不受 03:00 那一夜的预算约束**：`--max-model-calls` 给多少用多少（默认 2000，评测里一个人 100 多条素材要 800–1100 次）；
// - 只写 `memory/subtext/rg.db`（338 号票起推理库在会意插件自己的数据目录里，按 `dataDirLayout().rgDb` 算），**不写事件日志、不动素材库**；要留一条整理记录（网页"最近一次整理"那一行）加 `--record`，
//   但它要独占 `ergo.db`：跑之前先把守护进程停掉（经 LSM），跑完再起来。
//
// 向量：这里不算（不加载 bge-m3，省内存也省时间），关键词检索照常可用；守护进程下一次整理会用本机模型把向量补齐。
//
//   npm run memory:build -- --rebuild                                 从头整理一次，预算 2000 次调用
//   npm run memory:build -- --max-model-calls 6000                    保留现有推理库，把没做完的接着做完
//   npm run memory:build -- --rebuild --record --data-dir <目录>       顺手记一条整理记录（守护进程要停着）
//
// 数据目录：`--data-dir <目录>`，没有就用 $ERGO_DATA_DIR，再没有就是 ~/.ergo。
// 模型 key：环境变量 DEEPSEEK_API_KEY；没有就读 <数据目录>/secrets/deepseek-api-key.txt（不打印内容）。
// 最先装上自带的语言（同守护进程 main.ts）：整理作业里给人看的话（收件箱的标题、失败原因）要查得到
import "../../src/i18n/boot.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { type Materials, openMaterials } from "../../src/materials/materials.ts";
import { createMemoryNightlyJob } from "../../src/memory/nightly-job.ts";
import { appendNightlyRecord, memoryNightlyView, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { type Clock, clockIso, systemClock } from "../../src/scheduler/clock.ts";
import { vacuumIntoSync } from "../../src/storage/sqlite.ts";
import type { MemoryConfig } from "../../src/config/config.ts";
import type { NewInboxItem } from "../../src/inbox/inbox.ts";
import type { InboxItem } from "@ergo/protocol";
import type { AppendResult } from "../../src/events/event-store.ts";

const KEY_ENV = "DEEPSEEK_API_KEY";
const MATERIALS_DB_NAME = "materials.db";

interface BuildArgs {
  dataDir?: string;
  maxModelCalls: number;
  rebuild: boolean;
  recordOnly: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): BuildArgs {
  const args: BuildArgs = { maxModelCalls: 2000, rebuild: false, recordOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--rebuild") {
      args.rebuild = true;
      continue;
    }
    if (arg === "--record-only") {
      args.recordOnly = true;
      continue;
    }
    if (arg === "--data-dir" || arg === "--max-model-calls") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 后面要跟一个值`);
      if (arg === "--data-dir") args.dataDir = value;
      else {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--max-model-calls 要是正整数，收到 ${value}`);
        args.maxModelCalls = n;
      }
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }
  return args;
}

const USAGE = [
  "离线把素材库整理一遍（按素材库重建推理库 / 一次性把攒下的素材做完）。",
  "",
  "用法：",
  "  npm run memory:build -- [--rebuild] [--max-model-calls <n>] [--data-dir <目录>]",
  "  npm run memory:build -- --record-only [--data-dir <目录>]",
  "",
  "  --rebuild              先删掉 memory/subtext/rg.db*，从头整理（不删的话把没做完的接着做完）",
  "  --max-model-calls <n>  这一次最多调几次模型（默认 2000；不受每晚 200 的限制）",
  "  --record-only          把上一次整理留下的记录写进事件日志（要独占 ergo.db：先经 LSM 停守护进程）",
  "  --data-dir <目录>      数据目录（默认 $ERGO_DATA_DIR，再默认 ~/.ergo）",
  "",
  "整理只写 memory/subtext/rg.db，素材库和事件日志一个字节不动；整理记录先存到 tmp/memory-build-record.json，",
  "要用 --record-only 写进事件日志（那一步要独占 ergo.db，先停守护进程）。",
].join("\n");

function dataDirOf(args: BuildArgs): string {
  if (args.dataDir !== undefined) return path.resolve(args.dataDir);
  const fromEnv = process.env.ERGO_DATA_DIR;
  return fromEnv !== undefined && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), ".ergo");
}

/** 模型 key：环境变量优先，其次数据目录的密钥区（只读，不打印） */
function readKey(dataDir: string): string | undefined {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  const file = path.join(dataDir, "secrets", "deepseek-api-key.txt");
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : undefined;
}

/** 素材库的快照副本（和 memory:replay 一样：源库只用只读连接做一次 VACUUM INTO，原库一个字节不动） */
function snapshotMaterials(source: string, work: string, clock: Clock): { materials: Materials; store: ReturnType<typeof openEventStore> } {
  const copy = path.join(work, "db", MATERIALS_DB_NAME);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  vacuumIntoSync(source, copy);
  const store = openEventStore({ file: path.join(work, "db", "ergo.db"), views: [], now: () => clockIso(clock), log: () => {} });
  const materials = openMaterials({ store, dbDir: path.join(work, "db"), materialsDir: path.join(work, "materials"), log: () => {} });
  materials.start();
  return { materials, store };
}

function summaryOf(record: MemoryNightlyRecord | undefined): string {
  if (record === undefined) return "没有整理记录（作业直接返回了 undefined，按失败算）";
  if (record.state !== "ran") return `没整理成：${record.state}${record.reason === undefined ? "" : `（${record.reason}）`}`;
  return [
    `整理完了（${record.night}，${record.trigger}）`,
    `新出结论 ${record.newClaims} 条、变化 ${record.changedClaims} 条、待复核 ${record.reviewed} 条（还留着 ${record.needsReview} 条）`,
    `问题箱：新出 ${record.questions.added}、判了 ${record.questions.resolved}、不用问 ${record.questions.obsolete}、过期 ${record.questions.expired}、开着 ${record.questions.open}`,
    `模型调用 ${record.modelCalls} 次${record.budgetExhausted ? "（预算用完，没做完的留到下次）" : ""}`,
    `这一夜整理 ${record.processedEvidence} 条证据，还剩 ${record.pendingEvidence} 条没整理`,
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dataDir = dataDirOf(args);
  const layout = dataDirLayout(dataDir);
  const dbFile = layout.rgDb;
  const materialsDb = layout.materialsDb;
  const recordFile = path.join(layout.tmp, "memory-build-record.json");
  const key = readKey(dataDir);
  if (key === undefined && !args.recordOnly) {
    console.error(`没配模型 key：环境变量 ${KEY_ENV} 或 ${path.join(dataDir, "secrets", "deepseek-api-key.txt")} 都没有`);
    process.exitCode = 1;
    return;
  }
  // 只写整理记录：不跑整理，把上一次留下的记录补进事件日志
  if (args.recordOnly) {
    const pid = path.join(dataDir, "daemon.pid");
    if (fs.existsSync(pid) && fs.readFileSync(pid, "utf8").trim().length > 0) {
      console.error("--record-only 要独占事件日志：先经 LSM 停掉守护进程再跑（lsm stop ergo-daemon），跑完再起来");
      process.exitCode = 1;
      return;
    }
    if (!fs.existsSync(recordFile)) {
      console.error(`找不到上一次整理的记录 ${recordFile}：先跑一次整理（npm run memory:build）`);
      process.exitCode = 1;
      return;
    }
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as MemoryNightlyRecord;
    const eventStore = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [memoryNightlyView], now: () => clockIso(systemClock), log: () => {} });
    try {
      appendNightlyRecord(eventStore, record);
    } finally {
      eventStore.close();
    }
    console.log(`已记一条整理记录（${record.night}，${record.trigger}，${record.state}）`);
    return;
  }
  if (!fs.existsSync(materialsDb)) {
    console.error(`找不到素材库 ${materialsDb}`);
    process.exitCode = 1;
    return;
  }
  if (args.rebuild) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${dbFile}${suffix}`;
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    console.log(`已删掉 ${dbFile}（从头整理）`);
  }
  const clock = systemClock;
  const started = Date.now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-memory-build-"));
  let materials: Materials | undefined;
  let store: ReturnType<typeof openEventStore> | undefined;
  const timer = setInterval(() => {
    const minutes = Math.round((Date.now() - started) / 60_000);
    console.log(`… 还在跑（${minutes} 分钟）：${clockIso(clock)}`);
  }, 60_000);
  timer.unref?.();
  try {
    const snapshot = snapshotMaterials(materialsDb, work, clock);
    materials = snapshot.materials;
    store = snapshot.store;
    const config: MemoryConfig = {
      maxModelCalls: args.maxModelCalls,
      extractor: "model",
      sensitiveCategories: [],
      enabled: true,
      // 离线跑没有"到点"这回事；墙钟上限给 0 = 不限（人盯着，随时可以 Ctrl+C）
      nightlyTimeoutMinutes: 0,
      curator: { maxModelCalls: 8 },
    };
    const inbox = {
      add: (item: NewInboxItem) => {
        console.log(`（待我处理里本该加一条：${item.title}）`);
        return item as unknown as InboxItem;
      },
      get: (): InboxItem | undefined => undefined,
    };
    const job = createMemoryNightlyJob({
      file: dbFile,
      materials,
      clock,
      // 不写事件日志：整理只动 rg.db；要留记录用 --record-only 补
      store: { append: () => ({ event: {} as never, duplicate: false }) as AppendResult },
      inbox,
      config,
      env: { [KEY_ENV]: key as string },
      log: (line) => console.log(`[${clockIso(clock)}] ${line}`),
    });
    console.log(`开始整理：${dbFile}（预算 ${args.maxModelCalls} 次模型调用）`);
    const record = await job.runNow();
    console.log(summaryOf(record));
    if (record?.text !== undefined && record.text.length > 0) console.log(`\n整理报告：\n${record.text}`);
    if (record !== undefined) {
      fs.mkdirSync(layout.tmp, { recursive: true });
      fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), "utf8");
      console.log(`整理记录存在 ${recordFile}；要写进事件日志：停守护进程后 npm run memory:build -- --record-only`);
    }
    if (record === undefined || record.state !== "ran") process.exitCode = 1;
  } finally {
    clearInterval(timer);
    await materials?.stop();
    store?.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
