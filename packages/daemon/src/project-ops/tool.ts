// 秘书的 project_ops（260 号票；268 号票照用户 2026-10-13 的设计草稿补齐）：所有使用中的项目统一一个工具，各项目的操作不注册成单独的工具
// （模型的工具列表不变），用到才读：
// - list：使用中的项目和各自的操作（通用操作开头列一次；项目自己的操作是登记着的那一版清单里的，标种类、风险标记）；档案里的清单
//   没交、读不了、新改的验收没过 / 在等服务的照实写；
// - describe：一个操作的完整说明、用户可能怎么说、参数（逐个写明类型、必填还是默认值、枚举的值和中文名，另附 JSON Schema）、返回、
//   实现方式、风险标记、用法说明、怎么调；
// - call：先按清单整理、校验参数（args.ts：中文名换成值、补默认值、按 JSON Schema 校验），不对的不发、连同这个操作的说明退回；
//   再按实现方式跑（runner.ts：http / script / ergo / maintainer），结果里一句能念的 say（实现没给的二狗按结果补，记下 sayFilled）和附件。
//   **使用中的项目调操作不用确认**（用户 2026-10-24）：不出卡；风险标记照读照显示、不接守卫（用户 2026-10-25 定只记不做）；
//   平台自己的守卫照旧判这一次 project_ops 调用（和别的工具一视同仁）。
// 调不了的回原因、什么都不发、不记录：项目找不到 / 有歧义、项目不是使用中的、操作不存在（项目清单没登记过的只有通用操作）、参数不对、
// 调用口对不上服务、服务关着（257）、还在上线、上线失败、要你手动、维护者收不了工单。
// 发出去了的记一条时间线（秘书会话，project_op）和 project_op_called（operations 频道，带清单的版本号），参数里像密钥的擦掉。
// createProjectOps 把清单的验收和登记（registry.ts）、秘书的工具、维护者的 check_ops（check-tool.ts）、转运营检查清单那一项装在一起。
import { CHANNELS, type OperationsPlanView, type Project, type ProjectServiceView, type StandardChecklistItem, STANDARD_CHECKLIST_ITEM_LABEL, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { maskSecretArgValues } from "../guard/index.ts";
import type { JobObject } from "../process/job-object.ts";
import type { ProjectServices } from "../project-services/project-services.ts";
import { OPERATIONS_CHANNEL, type ProjectRecordsPaths } from "../projects/api.ts";
import { findByIdOrName } from "../util/find-by-ref.ts";
import { oneLine } from "../util/text.ts";
import { prepareArgs } from "./args.ts";
import { type BuiltinContext, type BuiltinJobs, BUILTIN_OP_NAMES, builtinOp, builtinOps, isBuiltinName } from "./builtin.ts";
import { checkOpsTool } from "./check-tool.ts";
import { PROJECT_OPS_EVENTS, type ProjectOpCalledPayload } from "./events.ts";
import type { OpsEndpoint, ProjectOp } from "./manifest.ts";
import { type OpsMsg, problem } from "./problems.ts";
import { fallbackSay } from "./reply.ts";
import { createOpsRegistry, type OpsChecklistView, type OpsRegistry } from "./registry.ts";
import { type EndpointTarget, type OpOutcome, type RunContext, runOp } from "./runner.ts";
import * as text from "./texts.ts";
import { PROJECT_OPS_TOOL } from "./tool-names.ts";

/** 一次调用最多等多久（毫秒）：项目的操作一般是秒级的；等不到的说清，不替它重试 */
export const PROJECT_OPS_CALL_TIMEOUT_MS = 60_000;
/** 验收时一条测试最多等多久 */
export const PROJECT_OPS_CHECK_TIMEOUT_MS = 30_000;

/** 结果写进事件、时间线的那一份最多多少字 */
const RECORDED_RESULT_CHARS = 600;

export interface ProjectOpsDeps {
  store: EventStore;
  /** 项目（删掉的不在里面）、项目档案的位置、项目现在的工作目录 */
  projects: { list(): Project[]; records(projectId: string): Pick<ProjectRecordsPaths, "root" | "ops">; workdir(project: Project): string };
  /** 项目的服务（133）：调用口在哪个端口、现在什么样（关着、上线了没有） */
  services: Pick<ProjectServices, "view">;
  /** 建设中的项目要随转入使用生效的那份运营方案（验收时 http 的调用口看它里面的服务） */
  pendingPlan?: (projectId: string) => OperationsPlanView | undefined;
  /** 这个项目的定时 / 事件触发的任务和运行记录（通用操作用） */
  jobs: BuiltinJobs;
  /** 触发底座（立即运行一次、暂停恢复、改时间表）：用到时现取 */
  scheduler: () => BuiltinContext["scheduler"];
  /** 跟维护者说一句（秘书转达那条路） */
  tellMaintainer: BuiltinContext["tellMaintainer"];
  /** 转给维护者当工单（建项目内部的普通任务）；check 只看收不收 */
  delegate: RunContext["delegate"];
  /** 档案里的 ops.json 是不是规范模板原样 */
  isTemplate: (text: string) => boolean;
  /** 使用中的项目自动验收没过：给维护者的会话放一条通知（会唤起它） */
  notifyMaintainer?: (project: Project, text: string, key: string) => void;
  /** 一次验收做完了（建设中的项目：刷新还在等的转入使用确认卡） */
  onChecked?: (project: Project) => void;
  now: () => string;
  log: (line: string) => void;
  /** 一次调用最多等多久（测试改短） */
  timeoutMs?: number;
  /** 验收时一条测试最多等多久（测试改短） */
  checkTimeoutMs?: number;
  /** 脚本的 Job 对象（Windows） */
  newJob?: () => JobObject | undefined;
}

export interface ProjectOps {
  registry: OpsRegistry;
  /** 秘书的 project_ops */
  tool(): HostTool;
  /** 项目维护者的 check_ops（绑定在它维护的项目上） */
  checkTool(scope: { projectId: string; maintainerId: string }): HostTool;
  /** 转运营检查清单里 ops 那一项（standard.ts 用；没验过的在后台开验） */
  checklistItem(project: Project): StandardChecklistItem;
  /** 转入使用时登记（和转入使用同一事务）：档案里那份验收全过了才有 */
  goLiveEvents(project: Project): NewEvent[];
  /** 转入使用的请求之前：档案里那份重验一遍（维护者、秘书提转入使用时等它，卡上直接是结论） */
  prepareGoLive(projectId: string): Promise<void>;
}

/** 还算在项目上的服务（上线中、上线了、上线失败、要你手动；撤下的、撤下中的、撤下失败的不算） */
const present = (v: ProjectServiceView) => v.rollout === "pending" || v.rollout === "live" || v.rollout === "failed" || v.rollout === "manual";

/** 调用口在哪个服务上：清单写了 service 的按它找，没写的用唯一的那个；对不上的回原因 */
export function endpointService<T extends { name: string }>(services: readonly T[], endpoint: OpsEndpoint): T | OpsMsg {
  if (endpoint.service !== undefined) return services.find((v) => v.name === endpoint.service) ?? problem("endpointUnknownService", { service: endpoint.service, names: services.map((v) => v.name).join(t("protocol.common.listSep")) || "-" });
  if (services.length === 1) return services[0]!;
  return services.length === 0 ? problem("endpointNoService") : problem("endpointAmbiguous", { names: services.map((v) => v.name).join(t("protocol.common.listSep")) });
}

const isMsg = (value: unknown): value is OpsMsg => typeof value === "object" && value !== null && "code" in value;

/** 服务现在调不了的原因（关着、还没上线、上线失败、要你手动）；能调的是 undefined */
function blocked(project: Project, v: ProjectServiceView): string | undefined {
  if (v.paused || v.power === "stopping") return text.serviceBlocked.closed(project);
  if (v.rollout === "pending") return text.serviceBlocked.pending(project);
  if (v.rollout === "failed") return text.serviceBlocked.failed(project, v.reason);
  if (v.rollout === "manual") return text.serviceBlocked.manual(project, v.reason);
  return undefined;
}

class Refusal extends Error {}

const Params = Type.Object(
  {
    action: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")], { description: text.PROJECT_OPS_PARAMS.action }),
    project: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: text.PROJECT_OPS_PARAMS.project })),
    op: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: text.PROJECT_OPS_PARAMS.op })),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: text.PROJECT_OPS_PARAMS.args })),
    why: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: text.PROJECT_OPS_PARAMS.why })),
  },
  { additionalProperties: false },
);

export function createProjectOps(deps: ProjectOpsDeps): ProjectOps {
  const timeoutMs = deps.timeoutMs ?? PROJECT_OPS_CALL_TIMEOUT_MS;
  const inUse = () => deps.projects.list().filter((p) => p.state === "in_use");
  const servicesOf = (projectId: string) => deps.services.view().filter((v) => v.projectId === projectId && present(v));
  const nowDate = () => new Date(deps.now());

  /** 调用口：使用中的看 LSM 上的服务（关着、还没上线的调不了）；别的看要随转入使用生效的运营方案里的服务（验收时用） */
  const endpointTarget = (project: Project) => (endpoint: OpsEndpoint): EndpointTarget => {
    if (project.state === "in_use") {
      const found = endpointService(servicesOf(project.id), endpoint);
      if (isMsg(found)) return { kind: "unmatched", reason: text.endpointUnmatched(project, found), msg: found };
      const why = blocked(project, found);
      return why ? { kind: "blocked", reason: why } : { kind: "ok", port: found.port, app: found.app };
    }
    const planned = (deps.pendingPlan?.(project.id)?.items ?? project.operations?.items ?? []).flatMap((i) => (i.service ? [i.service] : []));
    const found = endpointService(planned, endpoint);
    if (isMsg(found)) return { kind: "unmatched", reason: text.endpointUnmatched(project, found), msg: found };
    return { kind: "ok", port: found.port, app: found.app };
  };

  const builtinContext = (project: Project, manifest?: { version: number; ops: number }): BuiltinContext => ({
    project,
    services: servicesOf(project.id),
    jobs: deps.jobs,
    get scheduler() {
      return deps.scheduler();
    },
    tellMaintainer: deps.tellMaintainer,
    workdir: deps.projects.workdir(project),
    ...(manifest ? { manifest } : {}),
    now: nowDate,
  });

  const runContext = (project: Project, opts: { timeoutMs: number; endpoint?: OpsEndpoint; manifest?: { version: number; ops: number } }): RunContext => ({
    project,
    endpointTarget: endpointTarget(project),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    workdir: deps.projects.workdir(project),
    builtin: builtinContext(project, opts.manifest),
    delegate: deps.delegate,
    timeoutMs: opts.timeoutMs,
    ...(deps.newJob ? { newJob: deps.newJob } : {}),
  });

  const registry = createOpsRegistry({
    store: deps.store,
    opsFile: (projectId) => deps.projects.records(projectId).ops,
    context: (project) => {
      const records = deps.projects.records(project.id);
      const workdir = deps.projects.workdir(project);
      return { run: runContext(project, { timeoutMs: deps.checkTimeoutMs ?? PROJECT_OPS_CHECK_TIMEOUT_MS }), watchDirs: [records.root, workdir], base: records.root };
    },
    isTemplate: deps.isTemplate,
    reserved: BUILTIN_OP_NAMES,
    notifyMaintainer: (project, check) => deps.notifyMaintainer?.(project, text.notifyText(project, check, registry.registered(project.id)?.version), `ops-check-failed:${project.id}:${check.hash}`),
    ...(deps.onChecked ? { onChecked: deps.onChecked } : {}),
    now: deps.now,
    log: deps.log,
  });

  /** 按编号或名字找项目（所有没删的里找：不是使用中的也说清是什么状态） */
  const find = (ref: string): Project => {
    try {
      return findByIdOrName(deps.projects.list(), ref, { nameOf: (p) => p.name, what: "项目", hint: text.inUseHint(inUse()) }); // @i18n-ignore model：找不到的说明交给秘书
    } catch (err) {
      if (err instanceof RequestRejected) throw new Refusal(err.message);
      throw err;
    }
  };

  const mustInUse = (ref: string): Project => {
    const project = find(ref);
    if (project.state !== "in_use") throw new Refusal(text.notInUse(project));
    return project;
  };

  /** 这个项目现在能用的：登记着的那一版清单（和档案里的为什么没用上） */
  const usableOf = async (project: Project) => {
    const usable = await registry.usable(project);
    const reg = usable.registered;
    const note =
      usable.file === "missing"
        ? reg
          ? undefined
          : text.manifestText.missing(project)
        : usable.file === "unreadable"
          ? text.manifestText.unreadable(project, usable.problem!)
          : usable.file === "pending"
            ? text.pendingText(project, usable.pending, reg?.version)
            : undefined;
    return { reg, note };
  };

  /** 调用口在哪个服务上（清单里有 http 的操作才有） */
  const serviceOf = (project: Project, ops: readonly ProjectOp[], endpoint: OpsEndpoint | undefined): ProjectServiceView | OpsMsg | undefined =>
    endpoint && ops.some((o) => o.impl.type === "http") ? endpointService(servicesOf(project.id), endpoint) : undefined;

  /** 认操作：通用操作、登记着的那一版里的；没有的列出有哪些 */
  const opOf = async (project: Project, name: string): Promise<{ op: ProjectOp; builtin: boolean; version?: number; endpoint?: OpsEndpoint; count: number; note?: string }> => {
    const wanted = name.trim();
    const jobs = deps.jobs.ofProject(project.id);
    const { reg, note } = await usableOf(project);
    if (isBuiltinName(wanted)) return { op: builtinOp(wanted, jobs, project), builtin: true, ...(reg ? { version: reg.version } : {}), count: reg?.ops.length ?? 0 };
    const op = reg?.ops.find((o) => o.name === wanted);
    if (!op) throw new Refusal([text.opMissing(project, wanted, reg?.ops ?? []), ...(note ? [note] : [])].join("\n"));
    return { op, builtin: false, version: reg!.version, endpoint: reg!.endpoint, count: reg!.ops.length };
  };

  const list = async (ref: string | undefined): Promise<string> => {
    const projects = ref === undefined ? inUse() : [mustInUse(ref)];
    const listed: text.ListedProject[] = [];
    for (const project of projects) {
      const { reg, note } = await usableOf(project);
      const service = reg ? serviceOf(project, reg.ops, reg.endpoint) : undefined;
      listed.push({ project, ...(reg ? { version: reg.version } : {}), ops: reg?.ops ?? [], ...(service ? { service } : {}), ...(note ? { note } : {}) });
    }
    return text.listText(listed, builtinOps());
  };

  const describeOf = (project: Project, found: Awaited<ReturnType<typeof opOf>>) => {
    const service = found.builtin ? undefined : serviceOf(project, [found.op], found.endpoint);
    return text.describeText(project, found.op, { builtin: found.builtin, ...(found.version !== undefined ? { version: found.version } : {}), ...(service ? { service } : {}) });
  };

  const describe = async (ref: string, name: string): Promise<string> => {
    const project = mustInUse(ref);
    return describeOf(project, await opOf(project, name));
  };

  /** 发出去了的记下来：时间线（秘书会话）+ project_op_called（operations 频道），跟维护者说一句的消息同一批 */
  const record = (input: { project: Project; found: Awaited<ReturnType<typeof opOf>>; args: Record<string, unknown>; why?: string; outcome: OpOutcome; say: string; sayFilled: boolean }) => {
    const { project, found, outcome } = input;
    const shown = maskSecretArgValues(input.args) as Record<string, unknown>;
    const result = oneLine(outcome.detail, RECORDED_RESULT_CHARS);
    const target = outcome.target;
    const version = found.builtin ? null : (found.version ?? null);
    const payload: ProjectOpCalledPayload = {
      projectId: project.id,
      projectName: project.name,
      op: found.op.name,
      version,
      builtin: found.builtin,
      kind: found.op.kind,
      readOnly: found.op.kind === "query",
      ...(found.op.risk ? { risk: found.op.risk } : {}),
      impl: found.op.impl.type,
      args: shown,
      ...(input.why === undefined ? {} : { why: input.why }),
      ...(target.impl === "http" ? { app: target.app, url: target.url } : target.impl === "script" ? { script: target.file } : target.impl === "ergo" ? { action: target.action } : target.taskId ? { taskId: target.taskId } : {}),
      outcome: outcome.ok ? "done" : "failed",
      say: input.say,
      sayFilled: input.sayFilled,
      result: { ok: outcome.ok, text: result },
      by: "secretary",
      time: deps.now(),
    };
    const timeline = buildTimelineRecord(
      CHANNELS.secretary,
      {
        kind: "project_op",
        summary: text.timelineSummary(outcome.ok, project.name, found.op.name, input.say),
        detail: text.timelineDetail({ version, args: shown, ...(input.why === undefined ? {} : { why: input.why }), ok: outcome.ok, say: input.say, sayFilled: input.sayFilled, result }),
      },
      // 秘书会话里的记录不带项目归属（同 mcp_call）：是哪个项目写在话里、事件里
      {},
    );
    const events: NewEvent[] = [{ channel: OPERATIONS_CHANNEL, type: PROJECT_OPS_EVENTS.called, payload }, timeline.event, ...(outcome.events ?? [])];
    deps.store.appendBatch(events);
  };

  const call = async (ref: string, name: string, given: Record<string, unknown>, why: string | undefined, invocation: { toolCallId: string; inputMessageId?: string; signal?: AbortSignal }): Promise<{ text: string; isError: boolean }> => {
    const project = mustInUse(ref);
    const found = await opOf(project, name);
    const { op } = found;
    const prepared = prepareArgs(op.inputSchema, given);
    if (!prepared.ok) return { text: text.argsRejected(project, op, prepared.problems, describeOf(project, found)), isError: true };
    const ctx = runContext(project, { timeoutMs, ...(found.endpoint ? { endpoint: found.endpoint } : {}), ...(found.version !== undefined ? { manifest: { version: found.version, ops: found.count } } : {}) });
    const outcome = await runOp(ctx, op, prepared.args, {
      test: false,
      key: `project-op:${invocation.toolCallId}`,
      ...(why === undefined ? {} : { why }),
      ...(invocation.inputMessageId === undefined ? {} : { inputMessageId: invocation.inputMessageId }),
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    if (!outcome.sent) throw new Refusal(outcome.blocked ?? outcome.detail);
    const sayFilled = outcome.say === undefined;
    const say = outcome.say ?? fallbackSay(op, { ok: outcome.ok, detail: outcome.detail });
    record({ project, found, args: prepared.args, ...(why === undefined ? {} : { why }), outcome, say, sayFilled });
    deps.log(`秘书调项目 ${project.id} 的操作 ${op.name}${found.builtin ? "（通用）" : `（第 ${found.version} 版）`}：${outcome.ok ? "做成了" : `没做成（${oneLine(outcome.detail, 80)}）`}`);
    const version = found.builtin ? "通用操作" : `运营接口清单第 ${found.version} 版`; // @i18n-ignore model
    if (outcome.ok) return { text: text.callText.done(project, op, version, say, sayFilled, outcome.detail), isError: false };
    const service = outcome.target.impl === "http" ? servicesOf(project.id).find((v) => v.app === (outcome.target as { app: string }).app) : undefined;
    if (outcome.reach === "refused") return { text: text.callText.refused(project, op, outcome.target.impl === "http" ? `调用口连不上（本机 ${outcome.target.url.replace(/^http:\/\//, "")} 没有响应）` : outcome.detail, service), isError: true }; // @i18n-ignore model
    if (outcome.reach === "timeout") return { text: text.callText.timeout(project, op, outcome.detail, service), isError: true };
    if (outcome.reach === "aborted") return { text: text.callText.aborted(project, op), isError: true };
    return { text: text.callText.failed(project, op, outcome.status, say, sayFilled, outcome.detail, describeOf(project, found)), isError: true };
  };

  const checklistItem = (project: Project): StandardChecklistItem => {
    const view: OpsChecklistView = registry.checklistView(project);
    const { done, detail } = text.checklistDetail(view);
    return { id: "ops", label: STANDARD_CHECKLIST_ITEM_LABEL.ops, done, detail };
  };

  return {
    registry,
    tool: () =>
      defineHostTool({
        name: PROJECT_OPS_TOOL,
        title: text.toolTitle(),
        description: text.PROJECT_OPS_DESCRIPTION,
        parameters: Params,
        // call 可能改东西（看的是哪个操作，这里不分）：被杀之后不重做
        readOnlyOrIdempotent: false,
        // args 里套着项目接口的参数：给人看的参数摘要先擦掉像密钥的值（280 号票：工具自己声明，守卫运行时不再按名字认）
        maskArgs: true,
        run: async (given, invocation) => {
          try {
            if (given.action === "list") return { text: await list(given.project) };
            if (given.project === undefined) return { text: text.needParam(given.action, "project"), isError: true };
            if (given.op === undefined) return { text: text.needParam(given.action, "op"), isError: true };
            if (given.action === "describe") return { text: await describe(given.project, given.op) };
            return await call(given.project, given.op, given.args ?? {}, given.why, invocation);
          } catch (err) {
            if (err instanceof Refusal) return { text: err.message, isError: true };
            throw err;
          }
        },
      }),
    checkTool: (scope) => checkOpsTool({ registry, projects: deps.projects, scope }),
    checklistItem,
    goLiveEvents: (project) => registry.goLiveEvents(project),
    async prepareGoLive(projectId) {
      const project = deps.projects.list().find((p) => p.id === projectId);
      if (!project) return;
      try {
        await registry.check(project, { by: "go_live", force: true });
      } catch (err) {
        deps.log(`验收项目 ${projectId} 的运营接口清单出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    },
  };
}
