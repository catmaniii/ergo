// 不起二狗校验运营接口清单（ops.json）和运营方案（npm run check:ops，check-file-cli.ts）：写服务的人、外面的 agent 交给负责人之前先过一遍。
// 只调现成的校验，不另写一份规矩：
// - 清单：manifest.ts 的 parseOpsManifest（读得通）、acceptance.ts 的 formatProblems（写全了）和 runAcceptance（照 test 调一次、要有 say、只读的真不写）。
//   给了服务地址才调 http 的操作（带测试标记），没给的记成没测；脚本的操作照跑（在工作目录里、带测试标记）；ergo、maintainer 的操作要在二狗里才跑得了，只查格式；
// - 方案：协议包的 OperationItemDraft（字段），内核手段的 check（定时、事件、公网入口要的字段）、eventTriggerProblems（事件来源）、
//   spec.ts 的 serviceProblems / servicePlanProblems（服务）。
// 查不到的（要二狗的现状才知道）：端口和别的项目的服务撞没撞、能力超没超项目的工具包、流程的步骤、文件夹事件的路径、调用口写的服务在不在方案里。
// @i18n-ignore-file log：命令行工具的输出
import { checkHttpBody, type EventTrigger, eventTriggerProblems, nowIso, OPERATION_SERVICE_MEANS, OperationItemDraft, type Project } from "@ergo/protocol";
import { isLoopbackHost } from "../apps/registry.ts";
import { DEFAULT_PORTS } from "../config/config.ts";
import { createServiceEventDesk } from "../event-sources/index.ts";
import { builtinOperationMeans, type BuiltinMeansDeps, type OperationMeans } from "../projects/api.ts";
import { servicePlanProblems, serviceProblems, type ServiceSpecContext } from "../project-services/spec.ts";
import { realPathOf } from "../util/real-path.ts";
import { formatProblems, runAcceptance } from "./acceptance.ts";
import { type BuiltinContext, BUILTIN_OP_NAMES } from "./builtin.ts";
import { type OpsManifestRead, parseOpsManifest } from "./manifest.ts";
import { problemText } from "./problems.ts";
import type { RunContext } from "./runner.ts";

export interface CheckFileOptions {
  /** 项目的工作目录：方案里的 cwd 相对它，脚本的路径相对它，只读查询前后比它 */
  workdir: string;
  /** 服务的本机地址（http://127.0.0.1:<端口>）：给了才真的调 http 的操作 */
  url?: string;
  /** 项目编号：只影响应用名的写法 */
  projectId?: string;
}

export interface CheckFileReport {
  kind: "ops" | "plan";
  /** 没过的原因；空的是过了 */
  problems: string[];
  warnings: string[];
  /** 过了的、没测的，一行一样 */
  notes: string[];
}

/** 单次调用最多等多久（毫秒） */
const CALL_TIMEOUT_MS = 15_000;
const DEFAULT_PROJECT_ID = "p-1";

/** 服务地址里的端口：只认本机；不对抛错（用法不对） */
export function portOfUrl(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--url 不是地址：${url}`);
  }
  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.port === "") throw new Error(`--url 要写本机地址和端口，比如 http://127.0.0.1:18731：${url}`);
  return Number(parsed.port);
}

/** 这一份是方案还是清单：数组、带 items 的是方案，别的按清单读（清单写坏了由 parseOpsManifest 说清楚） */
function planItems(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) return (parsed as { items: unknown[] }).items;
  return undefined;
}

/** 校验一份文件的内容。JSON 都读不通的抛错（用法不对），写得不对的进 problems */
export async function checkOpsFile(text: string, options: CheckFileOptions): Promise<CheckFileReport> {
  const source = text.replace(/^﻿/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`不是 JSON：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const items = planItems(parsed);
  return items ? checkPlan(items, options) : checkManifest(source, options);
}

/** 内核手段的 check 用不到 deps（只有生效、撤销时才用） */
const CHECK_ONLY_DEPS = {} as BuiltinMeansDeps;

function checkPlan(items: readonly unknown[], options: CheckFileOptions): CheckFileReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const drafts: Array<{ at: string; draft: OperationItemDraft }> = [];
  if (items.length === 0) problems.push("方案是空的：至少写一条");
  items.forEach((item, i) => {
    const checked = checkHttpBody(OperationItemDraft, item);
    if (checked.ok) drafts.push({ at: `第 ${i + 1} 条「${checked.value.key}」`, draft: checked.value });
    else problems.push(`第 ${i + 1} 条：${checked.message}`);
  });
  const seen = new Set<string>();
  for (const { at, draft } of drafts) {
    if (seen.has(draft.key)) problems.push(`${at}：key 重复了`);
    seen.add(draft.key);
  }

  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const workdir = realPathOf(options.workdir) ?? options.workdir;
  const specContext: ServiceSpecContext = {
    projectId,
    workdir,
    records: workdir,
    takenPorts: () =>
      new Map([
        [DEFAULT_PORTS.local, "二狗的本机端口"],
        [DEFAULT_PORTS.external, "二狗的外网端口"],
      ]),
  };
  // 事件来源：字段和项目的服务那个来源自己的（事件名）查；文件夹在不在要现场看，这里不查
  const serviceSource = createServiceEventDesk().attach({ emit: () => {}, deliver: () => ({ outcome: "inactive" }), log: () => {} });
  const checkEventTrigger = (trigger: EventTrigger): string[] => {
    const shape = eventTriggerProblems(trigger);
    if (shape.length > 0) return shape;
    return trigger.source === serviceSource.id ? serviceSource.check(trigger) : [];
  };
  const checkContext = { project: { id: projectId, name: projectId } as Project, now: nowIso(), checkEventTrigger, names: {} };
  const { triggered, manual } = builtinOperationMeans(CHECK_ONLY_DEPS);
  const builtin = new Map<string, OperationMeans>([...triggered, ...manual].map((m) => [m.id, m]));

  const acrossItems = servicePlanProblems(drafts.map((d) => d.draft));
  problems.push(...acrossItems);
  for (const { at, draft } of drafts) {
    const before = problems.length;
    if (draft.means === OPERATION_SERVICE_MEANS) {
      problems.push(...serviceProblems(draft, specContext).map((p) => `${at}：${p}`));
    } else {
      const means = builtin.get(draft.means);
      if (!means) problems.push(`${at}：没有 ${draft.means} 这种手段（有：${[...builtin.keys(), OPERATION_SERVICE_MEANS].join("、")}）`);
      else problems.push(...means.check(draft, checkContext).map((p) => `${at}：${p}`));
      if (draft.service) problems.push(`${at}：只有 means 是 ${OPERATION_SERVICE_MEANS} 的才写 service`);
    }
    if (problems.length === before && acrossItems.length === 0) notes.push(`${at}：过`);
  }
  return { kind: "plan", problems, warnings: [], notes };
}

async function checkManifest(text: string, options: CheckFileOptions): Promise<CheckFileReport> {
  const read = parseOpsManifest(text, BUILTIN_OP_NAMES);
  if (read.kind !== "ok") {
    const problem = read.kind === "broken" ? problemText(read.problem) : "没有清单";
    return { kind: "ops", problems: [problem], warnings: [], notes: [] };
  }
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const project = { id: projectId, name: projectId } as Project;
  const port = options.url === undefined ? undefined : portOfUrl(options.url);
  const run: RunContext = {
    project,
    endpointTarget: () => (port === undefined ? { kind: "blocked", reason: "没给 --url" } : { kind: "ok", port, app: `${projectId}-check` }),
    workdir: options.workdir,
    // ergo、maintainer 的操作不在这里跑（下面过滤掉）：formatProblems 只问 maintainer 收不收
    builtin: {} as BuiltinContext,
    delegate: () => ({}),
    timeoutMs: CALL_TIMEOUT_MS,
  };
  const format = formatProblems({ project, read, run });
  const warnings = format.warnings.map(problemText);
  if (format.problems.length > 0) return { kind: "ops", problems: format.problems.map(problemText), warnings, notes: [] };

  const runnable: Extract<OpsManifestRead, { kind: "ok" }> = { ...read, ops: read.ops.filter((op) => op.impl.type === "http" || op.impl.type === "script") };
  const result = await runAcceptance({ project, read: runnable, run, watchDirs: [options.workdir], base: options.workdir, key: "check-ops" });
  const problems = result.problems.map(problemText);
  const notes = read.ops.filter((op) => !runnable.ops.includes(op)).map((op) => `${op.name}：没测（${op.impl.type} 的操作要在二狗里才跑得了，格式过了）`);
  for (const op of result.ops) {
    if (op.result === "passed") notes.push(`${op.name}：过（${op.say ?? ""}）`);
    if (op.result === "waiting") {
      // 给了地址还连不上就是没过；没给地址的只是没测
      if (port !== undefined) problems.push(`${op.name}：连不上 ${options.url ?? ""}`);
      else notes.push(`${op.name}：没测（带 --url 才调 http 的操作，格式过了）`);
    }
  }
  return { kind: "ops", problems, warnings, notes };
}
