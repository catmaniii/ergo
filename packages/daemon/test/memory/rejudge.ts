// 记忆"全量重判一次"（333 号票，ADR-0032 的"全量重判一次"一节）：规矩改了以后，把推理库里现有的结论按新规矩全过一遍——
// 规矩迁移、被错撤的复活成猜测、老账本里落空的预测往回打、每组按新规矩重定、标着复核的组由模型重跑追问、往上抽、图谱自检……
// 走的是守护进程同一份作业逻辑（`memory/nightly-job.ts` 的 `runFullRejudge`）：同一个模型、同一套规矩和提示词、同一个写入口，
// 每一笔改动都进留痕；不读新素材（新证据留给下一次每晚整理）。
//
//   npm run memory:rejudge -- [--data-dir <目录>] [--max-model-calls <n>] [--max-yuan <元>]
//   npm run memory:rejudge -- --undo <报告.json> [--data-dir <目录>]      撤回这一次（换回跑之前存的快照）
//
// - 只写 `memory/subtext/rg.db`（338 号票起推理库在会意插件自己的数据目录里，按 `dataDirLayout().rgDb` 算）；跑之前先存一份快照 `tmp/memory-rejudge-<时间>.before.db`，报告写在 `tmp/memory-rejudge-<时间>.json`；
// - 要独占推理库：守护进程要停着（数据目录里有 daemon.pid 就不跑）——经 LSM 停，跑完再经 LSM 起来；
// - 跑的时候一步一行：走到哪一步、用了多久、调了几次模型、花了多少钱；
// - 撤回：`--undo <报告.json>` 把 rg.db 换回快照；跑完以后库里又写过别的就不换（会丢掉后来的），交回原因。
//
// 数据目录：`--data-dir <目录>`，没有就用 $ERGO_DATA_DIR，再没有就是 ~/.ergo。
// 模型 key：只从环境变量 DEEPSEEK_API_KEY 读（不打印、不读别的文件）。
// 最先装上自带的语言（同守护进程 main.ts）：不装的话档案摘要的字段名成了 key（"protocol.personalFiles.field.selfPhone"）
import "../../src/i18n/boot.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type FullRejudgeReport, formatFullRejudgeProgress, undoFullRejudge } from "@ergo/memory";
import type { InboxItem } from "@ergo/protocol";
import { loadConfig } from "../../src/config/config.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { AppendResult } from "../../src/events/event-store.ts";
import type { NewInboxItem } from "../../src/inbox/inbox.ts";
import { createMemoryNightlyJob } from "../../src/memory/nightly-job.ts";
import { backgroundText, type FileForMemory, type PersonalFilesForMemory, withheldValues } from "../../src/personal-files/memory-link.ts";
import { listPeople, notesOf, valuesOf } from "../../src/personal-files/view.ts";
import { openReadonlyDatabase } from "../../src/storage/sqlite.ts";
import { SELF_PERSON_ID } from "@ergo/protocol";
import { clockIso, systemClock } from "../../src/scheduler/clock.ts";

const KEY_ENV = "DEEPSEEK_API_KEY";

interface RejudgeArgs {
  dataDir?: string;
  maxModelCalls?: number;
  maxYuan: number;
  undo?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): RejudgeArgs {
  const args: RejudgeArgs = { maxYuan: 20, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--data-dir" || arg === "--max-model-calls" || arg === "--max-yuan" || arg === "--undo") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 后面要跟一个值`);
      i += 1;
      if (arg === "--data-dir") args.dataDir = value;
      else if (arg === "--undo") args.undo = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${arg} 要是正数，收到 ${value}`);
        if (arg === "--max-model-calls") {
          if (!Number.isSafeInteger(n)) throw new Error(`--max-model-calls 要是正整数，收到 ${value}`);
          args.maxModelCalls = n;
        } else args.maxYuan = n;
      }
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }
  return args;
}

const USAGE = [
  "记忆全量重判一次：把推理库里现有的结论按新规矩全过一遍（同每晚整理一套规矩、提示词、模型；不读新素材）。",
  "",
  "用法：",
  "  npm run memory:rejudge -- [--data-dir <目录>] [--max-model-calls <n>] [--max-yuan <元>]",
  "  npm run memory:rejudge -- --undo <报告.json> [--data-dir <目录>]",
  "",
  "  --max-model-calls <n>  整理那一步最多调几次模型（默认 1000；对抗复核另算）",
  "  --max-yuan <元>        最多花多少钱（默认 20；发之前按最坏的算，超了就不发）",
  "  --undo <报告.json>     撤回那一次：rg.db 换回跑之前的快照（跑完以后又写过别的就不换）",
  "  --data-dir <目录>      数据目录（默认 $ERGO_DATA_DIR，再默认 ~/.ergo）",
  "",
  "守护进程要停着（经 LSM 停，跑完再起来）。只写 memory/subtext/rg.db；快照和报告在 tmp/ 下。",
].join("\n");

function dataDirOf(args: RejudgeArgs): string {
  if (args.dataDir !== undefined) return path.resolve(args.dataDir);
  const fromEnv = process.env.ERGO_DATA_DIR;
  return fromEnv !== undefined && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), ".ergo");
}

/** 守护进程在跑吗（数据目录里有 daemon.pid 而且不空） */
function daemonRunning(dataDir: string): boolean {
  const pid = path.join(dataDir, "daemon.pid");
  return fs.existsSync(pid) && fs.readFileSync(pid, "utf8").trim().length > 0;
}

/** 文件名里用的时间（本地时间，到秒） */
function stampOf(iso: string): string {
  return iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/**
 * 只读打开事件库里的个人档案，拼成整理要的那一份（摘要、不进提示的值）。守护进程停着跑，这里只读、不写事件库；
 * 事件库不在（比如只复制了推理库的副本）就是 undefined——那样发给模型的请求里没有占位，跑之前会说一句
 */
function personalFilesOf(eventsDb: string, now: () => string): PersonalFilesForMemory | undefined {
  if (!fs.existsSync(eventsDb)) return undefined;
  const reader = openReadonlyDatabase(eventsDb);
  const nameOf = (id: string) => valuesOf(reader, id).find((v) => v.field === "name" && v.until === undefined)?.value;
  const files = (): FileForMemory[] => [
    { id: SELF_PERSON_ID, kind: "self", values: valuesOf(reader, SELF_PERSON_ID), notes: notesOf(reader, SELF_PERSON_ID) },
    ...listPeople(reader).map((id) => {
      const name = nameOf(id);
      return { id, kind: "person" as const, ...(name === undefined ? {} : { name }), values: valuesOf(reader, id), notes: notesOf(reader, id) };
    }),
  ];
  return {
    people: () => files().map((f) => ({ id: f.id, kind: f.kind, ...(f.name === undefined ? {} : { name: f.name }), aliases: [] })),
    background: () => backgroundText(files(), now()),
    withheld: () => withheldValues(files()),
    onFieldReplaced: () => () => undefined,
    replacedValues: () => [],
    addCandidates: () => 0,
    composeCandidates: () => undefined,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dataDir = dataDirOf(args);
  const layout = dataDirLayout(dataDir);
  if (daemonRunning(dataDir)) {
    console.error("全量重判要独占推理库：先经 LSM 停掉守护进程（数据目录里有 daemon.pid），跑完再起来");
    process.exitCode = 1;
    return;
  }

  if (args.undo !== undefined) {
    const report = JSON.parse(fs.readFileSync(args.undo, "utf8")) as Pick<FullRejudgeReport, "backupFile" | "after">;
    if (report.backupFile === null) {
      console.error("那一次没存快照，撤回要用跑之前的备份");
      process.exitCode = 1;
      return;
    }
    const undone = undoFullRejudge({ file: layout.rgDb, backupFile: report.backupFile, after: report.after });
    if (!undone.restored) {
      console.error(`没撤回：${undone.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已撤回：${layout.rgDb} 换回了 ${report.backupFile}`);
    return;
  }

  const key = process.env[KEY_ENV];
  if (key === undefined || key.trim().length === 0) {
    console.error(`没配模型 key：环境变量 ${KEY_ENV}`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(layout.rgDb)) {
    console.error(`找不到推理库 ${layout.rgDb}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: os.homedir() });
  const clock = systemClock;
  const stamp = stampOf(clockIso(clock));
  fs.mkdirSync(layout.tmp, { recursive: true });
  const backupFile = path.join(layout.tmp, `memory-rejudge-${stamp}.before.db`);
  const reportFile = path.join(layout.tmp, `memory-rejudge-${stamp}.json`);
  const inbox = {
    add: (item: NewInboxItem) => item as unknown as InboxItem,
    get: (): InboxItem | undefined => undefined,
  };
  const personalFiles = personalFilesOf(layout.eventsDb, () => clockIso(clock));
  const job = createMemoryNightlyJob({
    file: layout.rgDb,
    // 和守护进程一样：档案摘要当情境、号码类和住址的值在每个发给模型的请求里换成占位（283 号票）
    ...(personalFiles === undefined ? {} : { personalFiles: () => personalFiles }),
    // 不读新素材：全量重判只重判已有的结论
    materials: { list: () => [] },
    clock,
    // 不写事件日志：只动 rg.db
    store: { append: () => ({ event: {} as never, duplicate: false }) as AppendResult },
    inbox,
    config: { ...config.memory, nightlyTimeoutMinutes: 0 },
    env: { [KEY_ENV]: key.trim() },
    log: (line) => console.log(`[${clockIso(clock)}] ${line}`),
  });
  console.log(
    personalFiles === undefined
      ? `注意：找不到事件库 ${layout.eventsDb}，个人档案的号码、住址没法换成占位`
      : `个人档案：${personalFiles.withheld().length} 个号码、住址的值会在发给模型的请求里换成占位`,
  );
  console.log(`开始全量重判：${layout.rgDb}（整理最多 ${args.maxModelCalls ?? 1000} 次模型调用、最多 ¥${args.maxYuan}）`);
  const result = await job.runFullRejudge({
    backupFile,
    maxYuan: args.maxYuan,
    ...(args.maxModelCalls === undefined ? {} : { maxModelCalls: args.maxModelCalls }),
    onProgress: (event) => console.log(formatFullRejudgeProgress(event)),
  });
  if (result.state !== "ran") {
    console.error(`没跑成：${result.state}（${result.reason}）`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(reportFile, JSON.stringify({ ...result.report, meter: { ...result.meter, failures: result.meter.failures.length } }, null, 2), "utf8");
  console.log(`\n${result.report.text}`);
  console.log(`\n报告：${reportFile}\n快照：${backupFile}\n撤回：npm run memory:rejudge -- --undo "${reportFile}" --data-dir "${dataDir}"`);
  if (result.meter.failures.length > 0 || result.meter.capped > 0) console.log(`注意：模型调用失败 ${result.meter.failures.length} 次、到了上限没发 ${result.meter.capped} 次`);
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
