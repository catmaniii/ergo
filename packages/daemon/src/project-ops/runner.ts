// 跑一个操作（268 号票）：按实现方式分到四处，结果统一成 OpOutcome（能念的那句、附件、做成没有、发到哪了）。秘书的 call、清单验收的测试
// 调用（test：带测试标记，有副作用的不真做）都走这里：
// - http：项目服务的本机调用口（call.ts）；调用口在哪个服务上、能不能调由调用方给（endpointTarget：使用中看 LSM 上的服务，
//   建设中验收看运营方案里的服务），关着、还在上线这类没发出去（blocked）；
// - script：工作目录里的脚本（script.ts）；
// - ergo：二狗自带动作（builtin.ts）：白送的通用操作直接跑，项目清单里绑了参数的先代入（"{{参数名}}"）、按那个动作的参数说明校验；
// - maintainer：转给项目的维护者当工单——建一个项目内部的普通任务（75 号票的 delegate：排队，派一张执行的工单给维护者），
//   任务书写清是秘书代用户调的哪个操作、参数、为什么；测试调用只看这个项目收不收内部任务、不真建。
// @i18n-ignore-file model：结果、跑不了的原因交给秘书（工具结果）
import type { Project } from "@ergo/protocol";
import type { NewEvent } from "../events/event-store.ts";
import { RequestRejected } from "../errors.ts";
import type { JobObject } from "../process/job-object.ts";
import { bindPlaceholders, prepareArgs } from "./args.ts";
import { type BuiltinContext, builtinOp, isBuiltinName, runBuiltin } from "./builtin.ts";
import { callProjectOp, type OpReach, opsUrl } from "./call.ts";
import type { OpsEndpoint, ProjectOp } from "./manifest.ts";
import type { OpsMsg } from "./problems.ts";
import { runScriptOp } from "./script.ts";

/** 发到哪了（调用记录里写） */
export type OpTarget = { impl: "http"; app: string; url: string } | { impl: "script"; file: string } | { impl: "ergo"; action: string } | { impl: "maintainer"; taskId?: string };

/** 调用口在哪：能调的给端口和服务；对不上的、现在调不了的给原因（waiting：服务还没起来，验收时算"等服务上线后再跑"） */
export type EndpointTarget = { kind: "ok"; port: number; app: string } | { kind: "unmatched"; reason: string; msg: OpsMsg } | { kind: "blocked"; reason: string };

/** 一次的结果 */
export interface OpOutcome {
  /** 发出去了（真的调了实现：服务回了、连不上、等不到、脚本跑了、动作做了、建了工单；没发出去的不记录） */
  sent: boolean;
  /** 调到没有；blocked 是没发出去（调用口对不上、服务关着、还在上线……） */
  reach: OpReach | "blocked";
  ok: boolean;
  /** 实现给的能念的那句（没给的由调用方按结果补，fallbackSay） */
  say?: string;
  detail: string;
  status?: number;
  target: OpTarget;
  /** 没发出去的原因（给秘书看） */
  blocked?: string;
  /** 要追加的事件（跟维护者说一句：插进维护者会话的消息） */
  events?: NewEvent[];
}

export interface RunContext {
  project: Project;
  endpointTarget(endpoint: OpsEndpoint): EndpointTarget;
  /** 清单里的调用口（http 用）：通用操作没有 */
  endpoint?: OpsEndpoint;
  workdir: string;
  builtin: BuiltinContext;
  /** 转给维护者当工单（建项目内部的普通任务）；check 只看收不收、不建。收不了的抛 RequestRejected */
  delegate(input: { project: Project; title: string; instructions: string; check?: boolean }): { taskId?: string };
  timeoutMs: number;
  newJob?: () => JobObject | undefined;
}

export interface RunOptions {
  test: boolean;
  /** 幂等键（动作、工单用：同一次工具调用不做两遍） */
  key: string;
  why?: string;
  inputMessageId?: string;
  signal?: AbortSignal;
}

/** 交给维护者的那段话 */
export function maintainerInstructions(op: ProjectOp, args: Record<string, unknown>, why: string | undefined): string {
  const body = op.impl.type === "maintainer" && op.impl.instructions ? String(bindPlaceholders(op.impl.instructions, args)) : `用户要做「${op.title ?? op.name}」：${op.description}`;
  return [
    `秘书代用户调了运营接口「${op.title ?? op.name}」（${op.name}），转给你当工单：`,
    body,
    `参数：${Object.keys(args).length > 0 ? JSON.stringify(args) : "（没有参数）"}`,
    ...(why ? [`为什么：${why}`] : []),
    "做完写回进展；最后用一两句话说清做成了什么（会转告用户）。",
  ].join("\n");
}

/** 跑一次（参数已经按这个操作的 inputSchema 整理、校验过） */
export async function runOp(ctx: RunContext, op: ProjectOp, args: Record<string, unknown>, opts: RunOptions): Promise<OpOutcome> {
  const impl = op.impl;
  if (impl.type === "http") {
    const target = ctx.endpointTarget(ctx.endpoint ?? { path: "/ops" });
    const app = target.kind === "ok" ? target.app : "";
    if (target.kind !== "ok") return { sent: false, reach: "blocked", ok: false, detail: target.reason, target: { impl: "http", app, url: "" }, blocked: target.reason };
    const url = opsUrl(target.port, (ctx.endpoint ?? { path: "/ops" }).path);
    const r = await callProjectOp({ url, name: op.name, args, test: opts.test, timeoutMs: ctx.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    return {
      sent: true,
      reach: r.reach,
      ok: r.ok,
      ...(r.reply.say === undefined ? {} : { say: r.reply.say }),
      detail: r.reply.detail,
      ...(r.status === undefined ? {} : { status: r.status }),
      target: { impl: "http", app: target.app, url },
    };
  }
  if (impl.type === "script") {
    const r = await runScriptOp({
      workdir: ctx.workdir,
      file: impl.file,
      args: impl.args,
      projectId: ctx.project.id,
      name: op.name,
      arguments: args,
      test: opts.test,
      timeoutMs: ctx.timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(ctx.newJob ? { newJob: ctx.newJob } : {}),
    });
    return { sent: r.reach !== "refused", reach: r.reach, ok: r.ok, ...(r.reply.say === undefined ? {} : { say: r.reply.say }), detail: r.reply.detail, target: { impl: "script", file: impl.file } };
  }
  if (impl.type === "ergo") {
    const target: OpTarget = { impl: "ergo", action: impl.action };
    if (!isBuiltinName(impl.action)) return { sent: false, reach: "blocked", ok: false, detail: `没有二狗自带的动作「${impl.action}」`, target, blocked: `没有二狗自带的动作「${impl.action}」` };
    let params = args;
    if (op.name !== impl.action || Object.keys(impl.params).length > 0) {
      // 项目清单里绑了参数的：先代入，再按那个动作自己的参数说明校验
      const bound = bindPlaceholders(impl.params, args) as Record<string, unknown>;
      const schema = builtinOp(impl.action, ctx.builtin.jobs.ofProject(ctx.project.id), ctx.project).inputSchema;
      const prepared = prepareArgs(schema, bound);
      if (!prepared.ok) return { sent: false, reach: "blocked", ok: false, detail: prepared.problems.join("\n"), target, blocked: `绑定的参数对不上二狗自带动作「${impl.action}」：${prepared.problems.join("；")}` };
      params = prepared.args;
    }
    try {
      const r = runBuiltin(impl.action, params, ctx.builtin, { test: opts.test, key: opts.key, ...(opts.inputMessageId === undefined ? {} : { inputMessageId: opts.inputMessageId }) });
      return { sent: true, reach: "answered", ok: r.ok, say: r.say, detail: r.detail, target, ...(r.events ? { events: r.events } : {}) };
    } catch (err) {
      if (err instanceof RequestRejected) return { sent: true, reach: "answered", ok: false, detail: err.message, target };
      throw err;
    }
  }
  // maintainer：转给维护者当工单
  const title = op.title ?? op.name;
  const instructions = maintainerInstructions(op, args, opts.why);
  try {
    if (opts.test) {
      ctx.delegate({ project: ctx.project, title, instructions, check: true });
      return { sent: true, reach: "answered", ok: true, say: `测试：会把「${title}」转给「${ctx.project.name}」的维护者当工单（没有真转）。`, detail: instructions, target: { impl: "maintainer" } };
    }
    const r = ctx.delegate({ project: ctx.project, title, instructions });
    return {
      sent: true,
      reach: "answered",
      ok: true,
      say: `「${title}」转给「${ctx.project.name}」的维护者当工单了，它做完会在项目里写回。`,
      detail: `项目内部任务 ${r.taskId ?? ""}（派一张执行的工单给维护者）。交给维护者的话：\n${instructions}`,
      target: { impl: "maintainer", ...(r.taskId === undefined ? {} : { taskId: r.taskId }) },
    };
  } catch (err) {
    if (err instanceof RequestRejected) return { sent: false, reach: "blocked", ok: false, detail: err.message, target: { impl: "maintainer" }, blocked: err.message };
    throw err;
  }
}
