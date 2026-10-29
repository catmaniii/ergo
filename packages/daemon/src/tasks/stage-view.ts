// 长程任务的阶段详情要的、守护进程这边才有的几样（84 号票，阶段详情和"从这里重做"的预览）：
// - 授权已用几次：和守卫计次同一个口径（guard/grants.ts 的 grantUses：效果日志里本任务、这个阶段、
//   授予之后、同一工具、对象范围之内的）；阶段组的授权项守卫按阶段各算一份（toGuardPlan 的 "<id>@<阶段>"），这里换回计划里的 id；
// - 从这里重做会重开哪些阶段（stages.ts 的 reopenScope）；
// - 这几个阶段这一轮已经做了的事：效果日志里执行成功的、不是只看的，同一件只列一次，
//   分"本机""对外"。不按能撤回、能补救、收不回分（这里不撤回，真撤回在 85 号票），只按在哪儿生效分：
//   往外送（守卫的 sendsOut，和计划卡授权说法的 outward 同一个口径）是对外，别的动了东西的是本机。"这一轮"是这个阶段上次重开之后
//   判定的调用（效果日志的 reworkNo 不小于阶段的 reopenNo：只算当前这一轮）：重做之前判定、结束得晚的不算。
//   认不出的工具（守护进程代为执行的二狗自己的工具）不列。
// 274 号票加的：一个阶段这一轮系统查到的结果（本该是每轮结束系统直接查世界写出的结果、验收时系统查到的证据；
// 二狗查不了世界，票面定了用效果日志代替）——发了什么（消息、请求、对外动作）、改了哪些文件（新建 / 修改 / 删除）、本机做的别的事
// （里面改的文件效果日志记不到），维护者宣布完成时写的那一两句里提到的文件对不对得上（stageObserved、claimedFiles、claimChecks），
// 和存进任务的个数（observedCounts：看板卡、阶段框上那一行，只记个数和工具名）。
// 纯函数，执行控制器（execution.ts 的 stageView、rework、宣布完成）调用。
import type { StageEffect, StageFileChange, StageObserved, StageObservedCounts, StageSendKind, Task, TaskStage, TaskStageView } from "@ergo/protocol";
import { nowIso } from "@ergo/protocol";
import {
  comparable,
  type EffectRecord,
  findTool,
  grantUses,
  type GuardTask,
  isReadOnlyRequest,
  READ_ONLY_COMMANDS,
  sendsOut,
  type ShellEnv,
  TOOL,
  type ToolDescriptor,
  type ToolRegistry,
} from "../guard/index.ts";
import { summarizeArgs } from "../guard-runtime/describe.ts";
import { ignoredDeliveryPath } from "./delivery-ignore.ts";
import { findStage, reopenScope, stageStarted } from "./stages.ts";

/** 一件事在哪儿生效：只看（不列）、本机、对外 */
export type EffectReach = "look" | StageEffect["reach"];

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * 效果日志里的一条在哪儿生效（没登记的工具是 undefined）：
 * - 对外：往外送（sendsOut：会联网，带了请求数据，或者不是只往下拉的——推送、发消息、建远端仓库、非 GET 的请求……）；
 * - 只看：工具登记成只看的、只读的请求、通用 bash 里只看的命令，而且没有写或删的路径；
 * - 本机：别的（写文件、建目录、提交、装依赖、跑脚本……）
 */
export function effectReach(record: Pick<EffectRecord, "tool" | "args">, tools: ToolRegistry): EffectReach | undefined {
  const tool = findTool(tools, record.tool);
  if (!tool) return undefined;
  const args = record.args;
  if (sendsOut(tool, args)) return "external";
  if (record.tool === TOOL.shell_command) return typeof args.program === "string" && READ_ONLY_COMMANDS.includes(args.program) ? "look" : "local";
  const writes = Object.entries(tool.args).some(([name, rule]) => rule.kind === "path" && rule.access !== "read" && hasValue(args[name]));
  if (writes || tool.nature === "modify") return "local";
  return tool.nature === "look" || isReadOnlyRequest(tool, args) ? "look" : "local";
}

/** 一条效果记录是不是这个阶段这一轮的：本任务、这个阶段、判定时的重做次数不小于阶段上次重开时的（重做之前判定、结束得晚的不算） */
const inRound = (task: Task, stage: Pick<TaskStage, "stageId" | "reopenNo">, e: EffectRecord) => e.taskId === task.id && e.stageId === stage.stageId && (e.reworkNo ?? 0) >= (stage.reopenNo ?? 0);

/** 这几个阶段这一轮已经做了的事（按先后，同一件只列一次） */
export function stageEffects(task: Task, stageIds: readonly string[], effects: readonly EffectRecord[], tools: ToolRegistry): StageEffect[] {
  const list = task.stages?.list ?? [];
  const since = new Map(stageIds.map((id) => [id, findStage(list, id)?.reopenNo ?? 0]));
  const seen = new Set<string>();
  const out: StageEffect[] = [];
  for (const e of effects) {
    if (e.taskId !== task.id || e.stageId === null || !since.has(e.stageId) || (e.reworkNo ?? 0) < since.get(e.stageId)!) continue;
    const reach = effectReach(e, tools);
    if (reach === undefined || reach === "look") continue;
    const argsSummary = summarizeArgs(tools, e.tool, e.args);
    const key = `${e.tool}\u0000${argsSummary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = findTool(tools, e.tool)?.title;
    out.push({ stageId: e.stageId, tool: e.tool, ...(title === undefined ? {} : { toolTitle: title }), argsSummary, reach, at: nowIso(new Date(e.at)) });
  }
  return out;
}

// ───────────────────────── 系统查到的结果（274 号票） ─────────────────────────

/** 一件对外发送的是什么：给了收件人的是消息，给了网址（或 HTTP 方法）的是请求，别的（推送、发布、建远端仓库……）是对外动作 */
function sendKindOf(tool: ToolDescriptor, args: Readonly<Record<string, unknown>>): StageSendKind {
  const given = Object.entries(tool.args)
    .filter(([name]) => hasValue(args[name]))
    .map(([, rule]) => rule.kind);
  if (given.includes("recipient")) return "message";
  return given.includes("url") || given.includes("http_method") ? "request" : "action";
}

/** 提交只是把改动记进仓库，不改文件的内容：它的路径参数不算"改了哪些文件"（算本机做的别的事） */
const NOT_FILE_CHANGES: ReadonlySet<string> = new Set([TOOL.git_commit]);

/**
 * 一条效果记录改了哪些文件：工具登记里写、删的路径参数（不知道读还是写的按写算）；在哪儿做的（不填就取工作目录的仓库路径、搜索目录）
 * 不算；守卫没法确定的值（{"$unknown": …}）不算
 */
function changedPaths(tool: ToolDescriptor, record: EffectRecord): Array<{ path: string; deletes: boolean }> {
  if (NOT_FILE_CHANGES.has(record.tool)) return [];
  return Object.entries(tool.args).flatMap(([name, rule]) => {
    if (rule.kind !== "path" || rule.access === "read" || rule.defaultsToCwd === true) return [];
    const value = record.args[name];
    return (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === "string" && v !== "" ? [{ path: v, deletes: rule.access === "delete" }] : []));
  });
}

/** 一个文件写了之后算什么：判定前不存在的（效果日志的 created）这一轮之前没动过是新建；新建后又改还是新建；删了又写、改已有的是修改 */
function afterWrite(was: StageFileChange | undefined, created: boolean): StageFileChange {
  if (was === "created") return "created";
  return created && was === undefined ? "created" : "modified";
}

/**
 * 这个阶段这一轮系统查到的结果（claims 是空的，要核自报的用 claimChecks 补上）：
 * - sent：往外送的（和"从这里重做"列的对外的同一个口径，守卫的 sendsOut），同一件只列一次；
 * - files：写、删过的文件，按第一次动它的先后，按最后的样子算（afterWrite；删除就是删除）；
 * - other：本机做的、看不出改了哪些文件的（跑脚本、跑测试、提交、装依赖……），按工具数，按第一次出现的先后。
 * 认不出的工具（二狗自己的工具）、只看的不算
 */
export function stageObserved(task: Task, stageId: string, effects: readonly EffectRecord[], tools: ToolRegistry): StageObserved {
  const stage = task.stages?.list?.find((s) => s.stageId === stageId);
  const sent: StageObserved["sent"] = [];
  const seenSent = new Set<string>();
  const files = new Map<string, { path: string; change: StageFileChange }>();
  const other = new Map<string, StageObserved["other"][number]>();
  if (!stage) return { sent, files: [], other: [], claims: [] };
  for (const e of effects) {
    if (!inRound(task, stage, e)) continue;
    const tool = findTool(tools, e.tool);
    const reach = effectReach(e, tools);
    if (!tool || reach === undefined || reach === "look") continue;
    const title = tool.title ? { toolTitle: tool.title } : {};
    if (reach === "external") {
      const argsSummary = summarizeArgs(tools, e.tool, e.args);
      const key = `${e.tool}\u0000${argsSummary}`;
      if (seenSent.has(key)) continue;
      seenSent.add(key);
      sent.push({ tool: e.tool, ...title, argsSummary, kind: sendKindOf(tool, e.args), at: nowIso(new Date(e.at)) });
      continue;
    }
    const changed = changedPaths(tool, e);
    if (changed.length === 0) {
      other.set(e.tool, { tool: e.tool, ...title, n: (other.get(e.tool)?.n ?? 0) + 1 });
      continue;
    }
    const created = new Set((e.created ?? []).map(comparable));
    for (const c of changed) {
      const key = comparable(c.path);
      const was = files.get(key);
      files.set(key, { path: was?.path ?? c.path, change: c.deletes ? "deleted" : afterWrite(was?.change, created.has(key)) });
    }
  }
  return { sent, files: [...files.values()], other: [...other.values()], claims: [] };
}

/** 认得的文件扩展名（自报里不带路径的词，带了这些扩展名才算文件名；Node.js 这类技术名另外排除） */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    "md markdown txt rst json jsonl yaml yml toml ini cfg conf env csv tsv xml html htm css scss less js mjs cjs ts tsx jsx vue svelte py ipynb rb go rs java kt swift",
    "c h cc cpp hpp cs php pl lua r sh bash zsh ps1 bat cmd sql db sqlite log pdf doc docx xls xlsx ppt pptx odt ods odp rtf epub png jpg jpeg gif svg webp bmp ico",
    "mp3 wav m4a ogg flac mp4 mov mkv webm avi zip tar gz tgz 7z rar lock patch diff",
  ]
    .join(" ")
    .split(" "),
);
/** 带 .js 的技术名（不是文件） */
const TECH_NAMES = /^(node|next|nuxt|vue|react|express|three|d3|chart|moment|angular|ember|backbone|deno)\.js$/i;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/[^\s，。；、！？）)」』”>]+|www\.[^\s，。；、！？）)」』”>]+/gi; // @i18n-ignore data：认中文标点的正则
const EMAIL_LIKE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** 引号、书名号、反引号里的一段 */
const QUOTED = /[「『“"`‘]([^「」『』“”"`‘’\n]{1,200})[」』”"`’]/g; // @i18n-ignore data：认中文引号的正则
/** 不带引号的一个词：ASCII 的字、点和路径分隔符，前面可以有盘符 */
const BARE = /(?:(?<!\w)[A-Za-z]:)?[\w.@~+\\/-]+/g;

/** 像不像一个文件或目录：带了路径分隔符（不只是分隔符），或者以认得的扩展名结尾；版本号、技术名不算 */
function pathish(token: string): boolean {
  if (!/[A-Za-z0-9一-鿿]/.test(token) || /^v?\d+(\.\d+)+$/.test(token) || TECH_NAMES.test(token)) return false; // @i18n-ignore data：认汉字的正则
  if (/[\\/]/.test(token)) return true;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(token)?.[1];
  return ext !== undefined && FILE_EXTENSIONS.has(ext.toLowerCase());
}

/** 比对用的写法：正斜杠、小写、去掉开头的 ./ */
const normalPath = (p: string) =>
  p
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .toLowerCase();

/** 盖掉一段（换成同样长的空格，后面的位置不变） */
const blank = (m: string) => " ".repeat(m.length);

/**
 * 维护者宣布完成时写的那一两句里提到的文件和目录（按出现的先后，同一个只算一次）：引号、书名号、反引号里的（可以有中文、空格），
 * 和不带引号的路径、文件名（带路径分隔符，或者以认得的扩展名结尾）。网址、邮箱、版本号、Node.js 这类技术名不算；句末的点去掉
 */
export function claimedFiles(summary: string | undefined): string[] {
  if (!summary) return [];
  const text = summary.replace(URL_LIKE, blank).replace(EMAIL_LIKE, blank);
  const found: Array<{ at: number; token: string }> = [];
  for (const m of text.matchAll(QUOTED)) {
    const token = m[1]!.trim();
    if (pathish(token)) found.push({ at: m.index, token });
  }
  const unquoted = text.replace(QUOTED, (m: string, inner: string) => (pathish(inner.trim()) ? blank(m) : m));
  for (const m of unquoted.matchAll(BARE)) {
    const token = m[0].replace(/\.+$/, "");
    if (pathish(token)) found.push({ at: m.index, token });
  }
  const seen = new Set<string>();
  return found
    .toSorted((a, b) => a.at - b.at)
    .flatMap(({ token }) => {
      const key = normalPath(token);
      if (seen.has(key)) return [];
      seen.add(key);
      return [token];
    });
}

/** 自报里提到的一个文件（或目录）和这一轮改过的一个文件是不是同一个：绝对路径照全路径比（目录看在不在它里面），相对的按结尾比 */
function sameFile(claim: string, file: string): boolean {
  const c = normalPath(claim).replace(/\/+$/, "");
  const f = normalPath(file);
  if (!c) return false;
  if (/^([a-z]:)?\//.test(c)) return f === c || f.startsWith(`${c}/`);
  return f === c || f.endsWith(`/${c}`) || f.includes(`/${c}/`) || f.startsWith(`${c}/`);
}

/**
 * 自报里提到的文件对不对得上（"维护者交的"和"系统查到"摆在一起，再把对不上的标出来）：这一轮新建或改过的是 found；
 * 只查到删了它的是 deleted；都没有是 untouched（脚本、命令里面改的文件效果日志记不到，界面上照实说"没查到"）
 */
export function claimChecks(summary: string | undefined, files: StageObserved["files"]): StageObserved["claims"] {
  return claimedFiles(summary).map((text) => {
    const hits = files.filter((f) => sameFile(text, f.path));
    return { text, result: hits.some((f) => f.change !== "deleted") ? "found" : hits.length > 0 ? "deleted" : "untouched" };
  });
}

/**
 * 存进任务的个数（看板卡、阶段框上那一行）：对外的按工具数（同一件只算一次），文件按怎么了数，和自报对不上的几处；at 是宣布完成的时刻。
 * 311 号票：文件的个数不算缓存、依赖、编译产物（delivery-ignore.ts：__pycache__、*.pyc、node_modules……；阶段详情里逐条的照列）
 */
export function observedCounts(observed: StageObserved, at: string): StageObservedCounts {
  const sent = new Map<string, { tool: string; title?: string; n: number }>();
  for (const s of observed.sent) sent.set(s.tool, { tool: s.tool, ...(s.toolTitle ? { title: s.toolTitle } : {}), n: (sent.get(s.tool)?.n ?? 0) + 1 });
  const count = (change: StageFileChange) => observed.files.filter((f) => f.change === change && !ignoredDeliveryPath(f.path)).length;
  return {
    at,
    sent: [...sent.values()],
    created: count("created"),
    modified: count("modified"),
    deleted: count("deleted"),
    mismatches: observed.claims.filter((c) => c.result !== "found").length,
  };
}

/** 守卫眼里的授权项 id 换回计划里的：阶段组的授权项按阶段各一份，写成 "<id>@<阶段>" */
const planGrantId = (grantId: string, stageId: string) => (grantId.endsWith(`@${stageId}`) ? grantId.slice(0, -`@${stageId}`.length) : grantId);

/** 阶段详情从守护进程现取的：授权已用几次、从这里重做的范围、这一段已经做了的事 */
export function taskStageView(input: {
  task: Task;
  stageId: string;
  /** 守卫看到的任务（确认的计划、授权的授予时间）；还没开始执行的是 null */
  guardTask: GuardTask | null;
  effects: readonly EffectRecord[];
  tools: ToolRegistry;
  env: ShellEnv;
}): TaskStageView | undefined {
  const { task, stageId, guardTask } = input;
  const list = task.stages?.list ?? [];
  if (!findStage(list, stageId)) return undefined;
  const grants = guardTask ? guardTask.plan.grants.filter((g) => g.stageId === stageId) : [];
  const ctx = guardTask ? { task: guardTask, effectLog: input.effects, tools: input.tools, env: input.env } : undefined;
  const scope = reopenScope(list, stageId, stageStarted);
  const stage = findStage(list, stageId)!;
  const observed = stageStarted(stage) ? stageObserved(task, stageId, input.effects, input.tools) : undefined;
  return {
    taskId: task.id,
    stageId,
    grantUses: ctx ? grants.map((g) => ({ grantId: planGrantId(g.grantId, stageId), used: grantUses(g, ctx) })) : [],
    reopenScope: scope,
    effects: stageEffects(task, scope, input.effects, input.tools),
    ...(observed ? { observed: { ...observed, claims: claimChecks(stage.summary, observed.files) } } : {}),
  };
}
