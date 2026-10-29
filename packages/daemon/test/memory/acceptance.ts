// 记忆上线验收（235 号票，接入设计第 9 节）：逐条打印"这台机器上的记忆能不能用"，只读，不改数据。
//
//   npm run memory:acceptance                       # 用户数据目录（$ERGO_DATA_DIR，没有就是 ~/.ergo）
//   npm run memory:acceptance -- --data-dir <目录>   # 换一个数据目录
//
// 逐条检查（有哪条不过就逐条写清楚，最后退出码 1）：
// 1. rg.db 能不能打开、manifest 和表版本对不对得上（`openReasoningDb({ readOnly: true })`：不写 manifest、库不在也不建）；
// 2. 最近一次整理记录（哪一夜、跑了没有、新增/变化几条、失败原因）：从 `ergo.db` 的 `memory_nightly` 视图读，只读连接；
// 3. 现算一份 `memoryBrief` 不报错、长度在限内（和 ask_memory 同一份上限 4000 字）；
// 4. 素材检索（`search_materials` 走的同一份代码）跑得通：把 `materials.db` 用 `VACUUM INTO` 快照到临时目录，在副本上开素材库再查，
//    原库一个字节不动；验收不加载向量模型，所以走的是关键词那一路（和"向量模型不在"时同一条路）；
// 5. 插件停用后每晚整理作业撤销：假时钟 + 假插件宿主（test/memory/plugin-host.ts）在临时目录里把真的记忆插件装起来，到点跑一夜、
//    停用、再拨到下一夜，确认不再跑；不碰真实守护进程、不碰用户数据目录。
//
// 只读的口径：`materials.db` 只用快照副本；`ergo.db` 只读连接；`rg.db` 用 `openReasoningDb({ readOnly: true })`（引擎打开时 @ergo/memory
// 会开一次建表/表版本的写事务，WAL 下和正在跑的整理排队，除此之外不写；manifest 的 updated_at 不动）。验收不打印任何素材原文。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type MemoryBrief, DEEPSEEK_DEFAULT_MODEL, type MemoryEngine } from "@ergo/memory";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { installBuiltinLocales } from "../../src/i18n/index.ts";
import { openMaterials } from "../../src/materials/index.ts";
import { ASK_MEMORY_LIMITS, ASK_MEMORY_MAX_CHARS } from "../../src/memory/ask-tool.ts";
import { reasoningIssueText } from "../../src/memory/nightly-job.ts";
import { latestNightlyRecord, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { searchMaterialsTool } from "../../src/memory/search-tool.ts";
import { clockIso, systemClock } from "../../src/scheduler/clock.ts";
import { openReadonlyDatabase, vacuumIntoSync } from "../../src/storage/sqlite.ts";
import { createMemoryPluginHost, nightlyRecords } from "./plugin-host.ts";

/** 验收现算简报时问的那一句（和各处演示用的一致，不涉及用户的具体内容） */
export const ACCEPTANCE_QUESTION = "我最看重什么？";
/** 素材检索用的关键词（只用来确认这条路通，打印结果条数、不打印内容） */
export const ACCEPTANCE_QUERY = "我";

export interface AcceptanceCheck {
  /** 检查什么（一行） */
  name: string;
  ok: boolean;
  /** 结果、原因（给人看的一行） */
  detail: string;
}

export interface AcceptanceReport {
  dataDir: string;
  checks: AcceptanceCheck[];
  /** 全部通过 */
  ok: boolean;
}

export interface AcceptanceOptions {
  /** 用户数据目录（`$ERGO_DATA_DIR` 或 `~/.ergo`） */
  dataDir: string;
  /** 问的那一句（默认 ACCEPTANCE_QUESTION） */
  question?: string;
  /** 逐条打一行（脚本用它打印） */
  log?: (line: string) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const exists = (file: string) => fs.existsSync(file) && fs.statSync(file).size > 0;

/** 一天里的几点几分（整理记录上的时间） */
const hhmm = (iso: string | undefined) => (iso === undefined ? "" : iso.slice(11, 16));

/** 最近一次整理记录（ergo.db 的 memory_nightly 视图，只读连接；视图还没建时当没有） */
function readLatestNightly(file: string): { record?: MemoryNightlyRecord; why?: string } {
  if (!exists(file)) return { why: "没有事件日志（守护进程还没在这个数据目录里跑过）" };
  let db;
  try {
    db = openReadonlyDatabase(file);
  } catch (err) {
    return { why: `事件日志打不开：${messageOf(err)}` };
  }
  try {
    return { record: latestNightlyRecord(db) };
  } catch (err) {
    // 没有 memory_nightly 这张表：记忆插件没整理过
    if (/no such table/i.test(messageOf(err))) return { why: "还没有整理记录（每晚整理一次都没跑过）" };
    return { why: `整理记录读不出来：${messageOf(err)}` };
  } finally {
    db.close();
  }
}

/** 一条整理记录的说明：时间、新增/变化、为什么没跑成 */
export function nightlyCheckDetail(record: MemoryNightlyRecord): string {
  const when = `${record.night} ${hhmm(record.at)}`;
  if (record.state === "ran") {
    return `${when} 整理了：新出 ${record.newClaims} 条结论、改了 ${record.changedClaims} 条、待复核 ${record.needsReview} 条、问题箱开着 ${record.questions.open} 个（${record.modelCalls} 次模型调用${record.budgetExhausted ? "，预算用完，剩下的下一次接着做" : ""}）`;
  }
  return `${when} ${record.state}${record.reason === undefined ? "" : `：${record.reason}`}`;
}

/** 素材检索那一条（materials.db 的快照副本上跑 search_materials 的同一份代码） */
async function searchCheck(layout: ReturnType<typeof dataDirLayout>): Promise<AcceptanceCheck> {
  const name = "素材检索（search_materials 走的同一条路）";
  const source = layout.materialsDb;
  if (!exists(source)) return { name, ok: false, detail: "没有素材库（db/materials.db）" };
  // 数据目录里的原库只用只读连接做一次一致快照（VACUUM INTO），之后查的是临时目录里的副本
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-acceptance-"));
  const store = openEventStore({ file: path.join(work, "ergo.db"), views: [], now: () => clockIso(systemClock), log: () => {} });
  let materials: ReturnType<typeof openMaterials> | undefined;
  try {
    vacuumIntoSync(source, path.join(work, "materials.db"));
    materials = openMaterials({ store, dbDir: work, materialsDir: path.join(work, "materials"), log: () => {} });
    materials.start();
    const output = await searchMaterialsTool(materials).run({ query: ACCEPTANCE_QUERY, why: "验收：确认素材检索这条路通" }, { toolCallId: "memory-acceptance" });
    if (output.isError === true) return { name, ok: false, detail: output.text };
    const hits = output.recall?.hits.length ?? 0;
    return {
      name,
      ok: true,
      detail: `跑通了（关键词；验收不加载向量模型）：找到 ${hits} 条${hits === 0 ? "（也可以换 --data-dir 指别的数据目录）" : ""}，结果里的内容不打印`,
    };
  } catch (err) {
    return { name, ok: false, detail: `跑不通：${messageOf(err)}` };
  } finally {
    await materials?.stop();
    store.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** 插件停用后作业撤销（假时钟 + 假插件宿主，临时目录里跑真的记忆插件；不碰真实守护进程和用户数据） */
async function pluginDisableCheck(): Promise<AcceptanceCheck> {
  const name = "插件停用后每晚整理作业撤销（假时钟 + 假插件宿主）";
  let host: Awaited<ReturnType<typeof createMemoryPluginHost>> | undefined;
  try {
    // 不给模型：到点照旧跑，记一条"没配 key"就跳过——只看作业排没排、撤没撤，不联网
    host = await createMemoryPluginHost({ at: new Date(2026, 9, 10, 9, 0) });
    if (host.internalJobs.state("memory-nightly") === undefined) return { name, ok: false, detail: "插件开着却没排上每晚整理" };
    if (!exists(host.layout.rgDb)) return { name, ok: false, detail: "插件开着却没建 rg.db" };
    host.clock.advanceTo(new Date(2026, 9, 11, 3, 0));
    await host.internalJobs.whenIdle();
    const ran = nightlyRecords(host.store).length;
    if (ran === 0) return { name, ok: false, detail: "到点没跑" };
    if (!(await host.host.disable("memory")).includes("memory")) return { name, ok: false, detail: "停用插件没生效" };
    host.clock.advanceTo(new Date(2026, 9, 12, 3, 0));
    await host.internalJobs.whenIdle();
    const after = nightlyRecords(host.store).length;
    if (after !== ran) return { name, ok: false, detail: `停用后下一夜又跑了（${ran} → ${after}）` };
    return { name, ok: true, detail: "停用后作业撤销：下一夜不再整理，rg.db 留着（临时目录里试的，不碰真实数据）" };
  } catch (err) {
    return { name, ok: false, detail: `跑不起来：${messageOf(err)}` };
  } finally {
    await host?.close();
  }
}

/** 逐条检查，交回报告（脚本和测试都用它） */
export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceReport> {
  installBuiltinLocales();
  const log = options.log ?? (() => {});
  const dataDir = path.resolve(options.dataDir);
  const layout = dataDirLayout(dataDir);
  const checks: AcceptanceCheck[] = [];
  const push = (check: AcceptanceCheck) => {
    checks.push(check);
    log(`${check.ok ? "✓" : "✗"} ${check.name}：${check.detail}`);
  };
  log(`记忆上线验收（只读；数据目录 ${dataDir}）`);

  // 1、3 都要引擎：只读打开一次，最后关掉
  let engine: MemoryEngine | undefined;
  const rgName = "rg.db 能打开、manifest 和表版本对得上";
  if (!exists(layout.rgDb)) {
    push({ name: rgName, ok: false, detail: "还没有 rg.db（每晚整理第一次跑过之后才有；先配好 DeepSeek 的 key，或者点一次「立即整理一次」）" });
  } else {
    const opened = openReasoningDb({ file: layout.rgDb, clock: () => clockIso(systemClock), model: DEEPSEEK_DEFAULT_MODEL, readOnly: true });
    if (opened.ok) {
      engine = opened.engine;
      const m = opened.manifest;
      push({
        name: rgName,
        ok: true,
        detail: `schema ${m.schema}、表版本 ${m.store}、引擎 ${m.engine}、模型 ${m.model}、向量模型 ${m.embedder ?? "（没有）"}、抽取器 ${m.extractor}、建库 ${m.createdAt}`,
      });
    } else {
      push({ name: rgName, ok: false, detail: `${reasoningIssueText(opened.issue)}（不自动迁移；删掉 rg.db 会按素材库重建，见文档里的回滚步骤）` });
    }
  }

  // 2. 最近一次整理记录
  const latest = readLatestNightly(path.join(layout.db, "ergo.db"));
  if (latest.record === undefined) {
    push({ name: "最近一次整理记录", ok: false, detail: latest.why ?? "没有整理记录" });
  } else {
    push({ name: "最近一次整理记录", ok: latest.record.state === "ran", detail: nightlyCheckDetail(latest.record) });
  }

  // 3. 现算一份简报（和 ask_memory 同一份上限）
  const briefName = `现算一份简报（memoryBrief，上限 ${ASK_MEMORY_MAX_CHARS} 字）`;
  if (engine === undefined) {
    push({ name: briefName, ok: false, detail: "推理库没打开，算不了" });
  } else {
    try {
      const question = options.question ?? ACCEPTANCE_QUESTION;
      const brief: MemoryBrief = await engine.memoryBrief(question, { group: "hybrid_kg_rg", at: engine.store.now(), limits: ASK_MEMORY_LIMITS });
      const length = brief.text.length;
      push({ name: briefName, ok: length <= ASK_MEMORY_MAX_CHARS, detail: `问「${question}」现算了一份 ${length} 字（没报错，内容不打印）` });
    } catch (err) {
      push({ name: briefName, ok: false, detail: `算不出来：${messageOf(err)}` });
    }
  }
  engine?.close();

  // 4. 素材检索
  push(await searchCheck(layout));

  // 5. 插件停用后作业撤销
  push(await pluginDisableCheck());

  // 6. 只读的口径：写清楚这一趟是怎么读的（不是检查，是让人放心）
  push({
    name: "只读",
    ok: true,
    detail: "materials.db 只用 VACUUM INTO 的快照副本、ergo.db 只读连接、rg.db 用 openReasoningDb({ readOnly: true })（不写 manifest）；不打印素材原文",
  });

  return { dataDir, checks, ok: checks.every((check) => check.ok) };
}

interface AcceptanceArgs {
  dataDir?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): AcceptanceArgs {
  const args: AcceptanceArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--data-dir") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--data-dir 后面要跟一个路径");
      args.dataDir = value;
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }
  return args;
}

/** 用户数据目录（和守护进程一样：$ERGO_DATA_DIR，没有就是 ~/.ergo） */
function defaultDataDir(): string {
  const fromEnv = process.env.ERGO_DATA_DIR;
  return fromEnv !== undefined && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), ".ergo");
}

const USAGE = [
  "记忆上线验收（235 号票）：逐条检查这台机器上的记忆能不能用，只读、不改数据。",
  "",
  "用法：",
  "  node packages/daemon/test/memory/acceptance.ts                 # 用户数据目录（$ERGO_DATA_DIR 或 ~/.ergo）",
  "  node packages/daemon/test/memory/acceptance.ts --data-dir <目录>",
  "  npm run memory:acceptance",
  "",
  "查：rg.db 和 manifest / 最近一次整理记录 / 现算一份简报 / 素材检索 / 插件停用后作业撤销（临时目录里的假宿主）。",
  "有哪条不过就逐条写清楚，退出码 1。不打印素材原文。",
].join("\n");

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const report = await runAcceptance({ dataDir: args.dataDir ?? defaultDataDir(), log: (line) => console.log(line) });
  console.log(report.ok ? "全部通过。" : `有 ${report.checks.filter((check) => !check.ok).length} 项没通过（逐条看上面）。`);
  if (!report.ok) process.exitCode = 1;
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
