// 白送的通用操作（268 号票，草稿："每个转运营的项目白送一组通用操作（状态、最近运行、最新交付件、立即跑一次、暂停恢复、改时间、
// 跟维护者说一句），项目只补特有的"）。每个使用中的项目不用写清单就有，list / describe / call 和项目自己的操作一样用；
// 它们也是 ergo 实现方式能绑的"二狗自带动作"（项目清单里写 { "type": "ergo", "action": "run_now", "params": { "job": "daily-report" } }
// 就是把"立即跑一次"绑上参数做成项目自己的一个操作）。
// - status 状态（只读查询）：使用中没有、服务在不在线、各条定时 / 事件触发的任务在跑还是暂停、下一次、最近一次、运营接口清单第几版；
// - recent_runs 最近运行（只读查询）：这个项目的定时 / 事件触发的任务最近几次运行（什么时候、怎么触发的、结局、最后说的话）；
// - latest_deliverables 最新交付件（只读查询）：最近跑完的几次运行在项目工作目录里交出 / 改过的文件（运行开始到结束之间改的）；
// - run_now 立即跑一次（触发一次运行）：走触发底座的立即运行一次（100 号票：同一个排队和名额，不改时间表）；
// - pause_resume 暂停恢复（有副作用的动作）：暂停、恢复这个项目的定时 / 事件触发的任务（不写 job 是全部）；服务的启停是另一回事
//   （switch_project_services）；
// - reschedule 改时间（有副作用的动作）：只改钟点（每天 / 每周几 / 每月几号照旧），走触发底座的改时间表（98 号票）；
// - tell_maintainer 跟维护者说一句（有副作用的动作）：插进项目维护者的会话（和秘书转达 tell_project 同一条路）。
// job 参数：运营方案那一条的 key、任务编号、触发登记编号、任务的名字都认；describe 时按项目现在有的几条列成枚举（值和中文名）。
// 验收的测试调用（test）：只读的照常查，别的只看做不做得了、说"会怎样"，不真做。
// @i18n-ignore-file model：操作的说明、能念的那句、附件交给秘书（工具结果）
import {
  describeSchedule,
  describeTime,
  forModel,
  JOB_RUN_STATE_LABEL,
  JOB_RUN_TRIGGER_LABEL,
  type JobRun,
  PROJECT_STATE_LABEL,
  type Project,
  type ProjectServiceView,
  type ReminderSchedule,
  SCHEDULED_JOB_STATE_LABEL,
  type ScheduledJob,
  serviceLine,
  canRescheduleJob,
  parseClockTime,
  withClockTime,
} from "@ergo/protocol";
import fs from "node:fs";
import path from "node:path";
import { RequestRejected } from "../errors.ts";
import type { NewEvent } from "../events/event-store.ts";
import { ignoredDeliveryDir, ignoredDeliveryFile } from "../tasks/delivery-ignore.ts";
import { oneLine } from "../util/text.ts";
import { ERGO_ACTIONS, type ProjectOp } from "./manifest.ts";

export type BuiltinName = (typeof ERGO_ACTIONS)[number];

/** 白送的通用操作的名字（项目清单里不能再用） */
export const BUILTIN_OP_NAMES: readonly string[] = ERGO_ACTIONS;

export const isBuiltinName = (name: string): name is BuiltinName => (BUILTIN_OP_NAMES as readonly string[]).includes(name);

/** 最近运行、最新交付件默认列几次、最多几次 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** 最新交付件：一次运行最多列几个文件、找的时候最多看多少个目录项 */
const FILES_PER_RUN = 10;
const SCAN_MAX = 5000;

/** 这个项目的触发登记（没取消的） */
export interface BuiltinJobs {
  ofProject(projectId: string): ScheduledJob[];
  runsOf(jobId: string): JobRun[];
}

/** 跑一个通用操作要的 */
export interface BuiltinContext {
  project: Project;
  /** 这个项目还在的服务（133） */
  services: readonly ProjectServiceView[];
  jobs: BuiltinJobs;
  /** 触发底座（立即运行一次、暂停恢复、改时间表）；结果拿不到的抛 RequestRejected，原因原样交回 */
  scheduler: {
    checkRunNow(jobId: string): void;
    runNow(params: { jobId: string }, key: string, by: "secretary"): { runId: string };
    act(params: { jobId: string; action: "pause" | "resume" }, key: string): { state: string };
    reschedule(params: { jobId: string; schedule: ReminderSchedule }, key: string): { schedule: ReminderSchedule; nextAt?: string };
  };
  /** 跟维护者说一句（秘书转达那条路）：要追加的事件；收不了的抛 RequestRejected。check 只看收不收 */
  tellMaintainer(input: { project: Project; message: string; key: string; inputMessageId?: string; check?: boolean }): NewEvent[];
  /** 项目现在的工作目录（最新交付件在这里找） */
  workdir: string;
  /** 运营接口清单登记到第几版、项目自己的操作几个（没登记过是 undefined） */
  manifest?: { version: number; ops: number };
  now: () => Date;
}

/** 一次的结果：能念的那句、附件、要追加的事件（tell_maintainer） */
export interface BuiltinResult {
  ok: boolean;
  say: string;
  detail: string;
  events?: NewEvent[];
}

// ───────────────────────── 定义 ─────────────────────────

const JOB_PARAM = { type: "string", description: "哪一条定时 / 事件触发的任务：运营方案那一条的 key、任务编号或名字" };

const DEFS: Record<BuiltinName, Omit<ProjectOp, "name" | "kindFrom" | "impl">> = {
  status: {
    title: "状态",
    kind: "query",
    description: "项目现在怎么样：使用中没有、服务在不在线、各条定时 / 事件触发的任务在跑还是暂停、下一次什么时候、最近一次跑得怎样、运营接口清单第几版。",
    userSays: ["简报站现在怎么样", "记账本还好吗", "日报还在跑吗"],
    inputSchema: { type: "object", properties: {} },
    returns: "say 一句话说项目现在的样子；附件逐条列服务和定时 / 事件触发的任务。",
    risk: "direct",
  },
  recent_runs: {
    title: "最近运行",
    kind: "query",
    description: "这个项目的定时 / 事件触发的任务最近几次运行：什么时候、怎么触发的、结局、最后说的话。",
    userSays: ["简报站最近跑得怎么样", "日报昨天跑了没有", "最近几次有没有失败"],
    inputSchema: {
      type: "object",
      properties: { job: { ...JOB_PARAM, description: "只看哪一条（不写是这个项目全部）" }, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: "列几次" } },
    },
    returns: "say 说最近一次怎样；附件每次一行。",
    risk: "direct",
  },
  latest_deliverables: {
    title: "最新交付件",
    kind: "query",
    description: "最近跑完的几次运行交出的文件（运行开始到结束之间在项目工作目录里改过的），连同那次最后说的话。",
    userSays: ["简报站最新的日报在哪", "把最新做出来的给我看看", "昨天交了什么"],
    inputSchema: {
      type: "object",
      properties: { job: { ...JOB_PARAM, description: "只看哪一条（不写是这个项目全部）" }, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 3, description: "看最近几次运行" } },
    },
    returns: "say 说最新一次交了几个文件；附件列每次运行的文件（相对工作目录）。",
    risk: "direct",
  },
  run_now: {
    title: "立即跑一次",
    kind: "run",
    description: "让一条定时 / 事件触发的任务现在就跑一次（和到点触发走同一个排队，不改时间表；暂停着的也能跑一次，跑完照旧暂停）。",
    userSays: ["简报站现在跑一次", "日报再跑一遍", "马上抓一次"],
    inputSchema: { type: "object", properties: { job: { ...JOB_PARAM, description: "跑哪一条（这个项目只有一条时可以不写）" } } },
    returns: "say 说排上了；结果跑完后在项目里看。",
    risk: "direct",
  },
  pause_resume: {
    title: "暂停恢复",
    kind: "action",
    description: "暂停或恢复这个项目的定时 / 事件触发的任务（不写 job 是这个项目全部）。项目服务的启动、关闭用 switch_project_services，不是这个。",
    userSays: ["简报站先停一停", "日报恢复吧", "这几天别跑了"],
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume"], enumNames: ["暂停", "恢复"], description: "暂停还是恢复" },
        job: { ...JOB_PARAM, description: "哪一条（不写是这个项目全部）" },
      },
      required: ["action"],
    },
    returns: "say 说哪几条暂停 / 恢复了。",
    risk: "direct",
  },
  reschedule: {
    title: "改时间",
    kind: "action",
    description: "改一条定时任务几点跑：只改钟点，每天 / 每周几 / 每月几号照旧。",
    userSays: ["日报改成每天 7 点", "简报站改到晚上 9 点跑"],
    inputSchema: {
      type: "object",
      properties: { time: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: "几点几分（24 小时制，比如 07:30）" }, job: { ...JOB_PARAM, description: "改哪一条（这个项目只有一条定时任务时可以不写）" } },
      required: ["time"],
    },
    returns: "say 说改成了什么时间、下一次什么时候。",
    risk: "direct",
  },
  tell_maintainer: {
    title: "跟维护者说一句",
    kind: "action",
    description: "给这个项目的维护者捎一句话（插进它的会话，和用户在项目页上直接对它说一样）：补充要求、报个问题、让它改点什么。",
    userSays: ["跟简报站的维护者说加上 GitHub 热门", "告诉记账本那边下个月起分类改一下"],
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 2000, description: "要转达的话：照抄用户的原话，不改写、不替用户加要求" } }, required: ["message"] },
    returns: "say 说转给维护者了。",
    risk: "direct",
  },
};

/** 一个通用操作的定义（job 参数按这个项目现在有的几条列成枚举） */
export function builtinOp(name: BuiltinName, jobs: readonly ScheduledJob[] = [], project?: Project): ProjectOp {
  const def = DEFS[name];
  const schema = structuredClone(def.inputSchema) as { properties?: Record<string, Record<string, unknown>> };
  const job = schema.properties?.job;
  if (job) {
    const live = jobs.filter((j) => j.state !== "cancelled" && (name !== "reschedule" || canRescheduleJob(j)));
    if (live.length > 0) {
      job.enum = live.map((j) => jobRef(j, project));
      job.enumNames = live.map((j) => j.title);
    } else job.description = `${String(job.description)}。这个项目现在没有${name === "reschedule" ? "定时" : "定时 / 事件触发的"}任务`;
  }
  return { name, ...def, inputSchema: schema as Record<string, unknown>, kindFrom: "kind", impl: { type: "ergo", action: name, params: {} } };
}

/** 全部通用操作（list 用） */
export const builtinOps = (jobs: readonly ScheduledJob[] = [], project?: Project): ProjectOp[] => ERGO_ACTIONS.map((name) => builtinOp(name, jobs, project));

// ───────────────────────── 认任务 ─────────────────────────

/** 运营方案里这一条的 key（job 属于它生效成的那个内部任务） */
function operationKey(job: ScheduledJob, project: Project | undefined): string | undefined {
  const taskId = job.ownerTaskId ?? job.taskId;
  return project?.operations?.items.find((i) => i.taskId === taskId)?.key;
}

/** 枚举里写的值：运营方案那一条的 key，没有的用触发登记编号 */
const jobRef = (job: ScheduledJob, project: Project | undefined) => operationKey(job, project) ?? job.id;

/** 按 job 参数认出是哪一条（key、任务编号、触发登记编号、名字；名字只认一条对得上的） */
function findJob(jobs: readonly ScheduledJob[], ref: string, project: Project): ScheduledJob {
  const wanted = ref.trim();
  const lower = wanted.toLowerCase();
  const exact = jobs.find((j) => operationKey(j, project) === wanted || j.id.toLowerCase() === lower || (j.ownerTaskId ?? j.taskId).toLowerCase() === lower || j.title.trim() === wanted);
  if (exact) return exact;
  const loose = jobs.filter((j) => j.title.includes(wanted) || wanted.includes(j.title));
  if (loose.length === 1) return loose[0]!;
  throw new RequestRejected("not_found", `项目「${project.name}」没有对得上「${wanted}」的定时 / 事件触发的任务。它有：${jobList(jobs, project)}`);
}

const jobList = (jobs: readonly ScheduledJob[], project: Project) => (jobs.length > 0 ? jobs.map((j) => `${jobRef(j, project)}（${j.title}）`).join("、") : "没有");

/** 不写 job 时：只有一条就是它，没有、好几条的说清 */
function onlyJob(jobs: readonly ScheduledJob[], project: Project, what: string): ScheduledJob {
  if (jobs.length === 1) return jobs[0]!;
  if (jobs.length === 0) throw new RequestRejected("not_found", `项目「${project.name}」没有${what}的任务。`);
  throw new RequestRejected("bad_params", `项目「${project.name}」有好几条${what}的任务，job 写是哪一条：${jobList(jobs, project)}`);
}

// ───────────────────────── 写法 ─────────────────────────

const when = (iso: string | undefined, ctx: BuiltinContext) => (iso ? describeTime(new Date(iso), ctx.now()) : "");

/** 一条任务现在的样子 */
function jobLine(job: ScheduledJob, ctx: BuiltinContext): string {
  const trigger = job.schedule ? describeSchedule(job.schedule, ctx.now()) : "事件触发";
  const next = job.nextAt && job.state === "active" ? `，下一次 ${when(job.nextAt, ctx)}` : "";
  const last = job.lastRun ? `；最近一次 ${when(job.lastRun.startedAt ?? job.lastRun.queuedAt, ctx)} ${JOB_RUN_TRIGGER_LABEL[job.lastRun.trigger]}，${JOB_RUN_STATE_LABEL[job.lastRun.state]}` : "；还没跑过";
  return `- 「${job.title}」（${jobRef(job, ctx.project)}）：${SCHEDULED_JOB_STATE_LABEL[job.state]}，${trigger}${next}${last}`;
}

/** 一次运行一行 */
function runLine(job: ScheduledJob, run: JobRun, ctx: BuiltinContext): string {
  const at = when(run.startedAt ?? run.queuedAt, ctx);
  const tail = run.summary ? `：${oneLine(run.summary, 200)}` : run.reason ? `：${oneLine(run.reason, 200)}` : "";
  return `- 「${job.title}」${at} ${JOB_RUN_TRIGGER_LABEL[run.trigger]} · ${JOB_RUN_STATE_LABEL[run.state]}${tail}`;
}

/** 服务的一句话：都在线 / 关着 / 有的不在线 */
function servicesSay(services: readonly ProjectServiceView[]): string {
  if (services.length === 0) return "";
  if (services.some((s) => s.paused)) return "服务关着";
  if (services.every((s) => s.status === "online")) return "服务在线";
  return "服务有的不在线";
}

/** 运行开始到结束之间在工作目录里改过的文件（相对路径；不看隐藏的，311 号票起缓存、依赖、编译产物照 tasks/delivery-ignore.ts 也不看） */
function filesChanged(root: string, from: number, to: number): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ > SCAN_MAX) return;
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ignoredDeliveryDir(e.name)) walk(full);
      } else if (e.isFile() && !ignoredDeliveryFile(e.name)) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m >= from && m <= to) found.push(path.relative(root, full).replace(/\\/g, "/"));
        } catch {
          // 刚被删掉的不管
        }
      }
    }
  };
  walk(root);
  return found.toSorted();
}

// ───────────────────────── 执行 ─────────────────────────

const liveJobs = (ctx: BuiltinContext) => ctx.jobs.ofProject(ctx.project.id).filter((j) => j.state !== "cancelled");

const limitOf = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, 1), MAX_LIMIT) : fallback);

/** 跑一个通用操作（参数已经按定义校验过、补过默认值）；做不了的抛 RequestRejected。test 是验收的测试调用：只读的照常，别的不真做 */
export function runBuiltin(name: BuiltinName, params: Record<string, unknown>, ctx: BuiltinContext, opts: { test: boolean; key: string; inputMessageId?: string }): BuiltinResult {
  return forModel(() => runIn(name, params, ctx, opts));
}

function runIn(name: BuiltinName, params: Record<string, unknown>, ctx: BuiltinContext, opts: { test: boolean; key: string; inputMessageId?: string }): BuiltinResult {
  const { project } = ctx;
  const jobs = liveJobs(ctx);
  const pick = (what: string, pool = jobs) => (typeof params.job === "string" && params.job.trim() !== "" ? findJob(pool, params.job, project) : onlyJob(pool, project, what));
  switch (name) {
    case "status": {
      const active = jobs.filter((j) => j.state === "active");
      const next = active.filter((j) => j.nextAt).toSorted((a, b) => Date.parse(a.nextAt!) - Date.parse(b.nextAt!))[0];
      const parts = [
        `「${project.name}」${PROJECT_STATE_LABEL[project.state]}`,
        servicesSay(ctx.services),
        jobs.length === 0 ? "" : `${active.length}/${jobs.length} 条定时 / 事件触发的任务在跑${next ? `，下一次是 ${when(next.nextAt, ctx)} 的「${next.title}」` : ""}`,
      ].filter(Boolean);
      const detail = [
        `项目 ${project.id}「${project.name}」：${PROJECT_STATE_LABEL[project.state]}`,
        ...(ctx.services.length > 0 ? ctx.services.map((s) => serviceLine(s)) : ["没有在 LSM 上的服务"]),
        jobs.length > 0 ? "定时 / 事件触发的任务：" : "没有定时 / 事件触发的任务",
        ...jobs.map((j) => jobLine(j, ctx)),
        ctx.manifest ? `运营接口清单：第 ${ctx.manifest.version} 版（项目自己的操作 ${ctx.manifest.ops} 个）` : "运营接口清单：还没有登记过的版本（只有通用操作）",
      ];
      return { ok: true, say: `${parts.join("；")}。`, detail: detail.join("\n") };
    }
    case "recent_runs": {
      const pool = typeof params.job === "string" && params.job.trim() !== "" ? [findJob(jobs, params.job, project)] : jobs;
      const runs = pool
        .flatMap((job) => ctx.jobs.runsOf(job.id).map((run) => ({ job, run })))
        .toSorted((a, b) => Date.parse(b.run.queuedAt) - Date.parse(a.run.queuedAt))
        .slice(0, limitOf(params.limit, DEFAULT_LIMIT));
      if (runs.length === 0) return { ok: true, say: `「${project.name}」还没有运行过。`, detail: pool.length === 0 ? "这个项目没有定时 / 事件触发的任务" : "还没有运行记录" };
      const latest = runs[0]!;
      return {
        ok: true,
        say: `最近一次是「${latest.job.title}」${when(latest.run.startedAt ?? latest.run.queuedAt, ctx)} ${JOB_RUN_TRIGGER_LABEL[latest.run.trigger]}的，${JOB_RUN_STATE_LABEL[latest.run.state]}。`,
        detail: runs.map(({ job, run }) => runLine(job, run, ctx)).join("\n"),
      };
    }
    case "latest_deliverables": {
      const pool = typeof params.job === "string" && params.job.trim() !== "" ? [findJob(jobs, params.job, project)] : jobs;
      const finished = pool
        .flatMap((job) => ctx.jobs.runsOf(job.id).map((run) => ({ job, run })))
        .filter(({ run }) => (run.state === "done" || run.state === "partial") && run.startedAt && run.endedAt)
        .toSorted((a, b) => Date.parse(b.run.endedAt!) - Date.parse(a.run.endedAt!))
        .slice(0, limitOf(params.limit, 3));
      if (finished.length === 0) return { ok: true, say: `「${project.name}」还没有跑完过的运行，没有交付件。`, detail: "没有跑完的运行" };
      const each = finished.map(({ job, run }) => ({ job, run, files: filesChanged(ctx.workdir, Date.parse(run.startedAt!) - 1000, Date.parse(run.endedAt!) + 1000) }));
      const first = each[0]!;
      const detail = [
        `交付件在项目的工作目录 ${ctx.workdir} 里（路径相对它）：`,
        ...each.map(({ job, run, files }) =>
          [
            `- 「${job.title}」${when(run.endedAt, ctx)} 跑完${run.summary ? `：${oneLine(run.summary, 200)}` : ""}`,
            files.length > 0 ? `  文件：${files.slice(0, FILES_PER_RUN).join("、")}${files.length > FILES_PER_RUN ? ` 等 ${files.length} 个` : ""}` : "  这次没有改过文件",
          ].join("\n"),
        ),
      ];
      return {
        ok: true,
        say: first.files.length > 0 ? `最新一次「${first.job.title}」${when(first.run.endedAt, ctx)} 交了 ${first.files.length} 个文件：${first.files.slice(0, 2).join("、")}${first.files.length > 2 ? " 等" : ""}。` : `最新一次「${first.job.title}」${when(first.run.endedAt, ctx)} 跑完了，没有改过文件。`,
        detail: detail.join("\n"),
      };
    }
    case "run_now": {
      const job = pick("定时 / 事件触发");
      if (opts.test) {
        ctx.scheduler.checkRunNow(job.id);
        return { ok: true, say: `测试：会让「${job.title}」立即跑一次（没有真跑）。`, detail: jobLine(job, ctx) };
      }
      const r = ctx.scheduler.runNow({ jobId: job.id }, opts.key, "secretary");
      return { ok: true, say: `「${job.title}」排上了，马上跑一次${job.state === "active" ? "" : "（跑完照旧暂停）"}。`, detail: `运行 ${r.runId}；不改时间表。` };
    }
    case "pause_resume": {
      const action = params.action === "resume" ? "resume" : "pause";
      const word = action === "pause" ? "暂停" : "恢复";
      const pool = typeof params.job === "string" && params.job.trim() !== "" ? [findJob(jobs, params.job, project)] : jobs;
      if (pool.length === 0) throw new RequestRejected("not_found", `项目「${project.name}」没有定时 / 事件触发的任务，没有可${word}的。`);
      const todo = pool.filter((j) => (action === "pause" ? j.state === "active" : j.state === "paused"));
      const already = pool.filter((j) => !todo.includes(j));
      if (todo.length === 0) return { ok: true, say: `${pool.length === 1 ? `「${pool[0]!.title}」` : `「${project.name}」的任务`}本来就${action === "pause" ? "暂停着" : "在跑"}。`, detail: pool.map((j) => jobLine(j, ctx)).join("\n") };
      if (opts.test) return { ok: true, say: `测试：会${word}${todo.map((j) => `「${j.title}」`).join("、")}（没有真${word}）。`, detail: todo.map((j) => jobLine(j, ctx)).join("\n") };
      todo.forEach((j, i) => ctx.scheduler.act({ jobId: j.id, action }, `${opts.key}#${i}`));
      return {
        ok: true,
        say: `${todo.length === 1 ? `「${todo[0]!.title}」` : `${todo.length} 条任务`}${word}了${already.length > 0 ? `（${already.map((j) => `「${j.title}」`).join("、")}本来就${action === "pause" ? "暂停着" : "在跑"}）` : ""}。`,
        detail: todo.map((j) => `- 「${j.title}」（${jobRef(j, project)}）：${word}了`).join("\n"),
      };
    }
    case "reschedule": {
      const time = typeof params.time === "string" ? parseClockTime(params.time) : undefined;
      if (!time) throw new RequestRejected("bad_params", "time 要写几点几分（24 小时制，比如 07:30）");
      const job = pick("定时", jobs.filter(canRescheduleJob));
      if (!job.schedule) throw new RequestRejected("not_allowed", `「${job.title}」是事件触发的，没有时间可改。`);
      const schedule = withClockTime(job.schedule, time);
      if (opts.test) return { ok: true, say: `测试：会把「${job.title}」改成${describeSchedule(schedule, ctx.now())}（没有真改）。`, detail: jobLine(job, ctx) };
      const r = ctx.scheduler.reschedule({ jobId: job.id, schedule }, opts.key);
      return {
        ok: true,
        say: `「${job.title}」改成${describeSchedule(r.schedule, ctx.now())} 了${r.nextAt ? `，下一次 ${when(r.nextAt, ctx)}` : ""}。`,
        detail: `原来是${describeSchedule(job.schedule, ctx.now())}；只改了钟点。`,
      };
    }
    case "tell_maintainer": {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) throw new RequestRejected("bad_params", "message 要写转达的话");
      if (opts.test) {
        ctx.tellMaintainer({ project, message, key: opts.key, check: true });
        return { ok: true, say: `测试：会把这句话转给「${project.name}」的维护者（没有真转）。`, detail: message };
      }
      const events = ctx.tellMaintainer({ project, message, key: opts.key, ...(opts.inputMessageId === undefined ? {} : { inputMessageId: opts.inputMessageId }) });
      return { ok: true, say: `转给「${project.name}」的维护者了。`, detail: message, events };
    }
  }
}
