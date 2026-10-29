// 运营接口清单的验收和登记（268 号票，草稿："清单是建设任务的必交交付件，按 112 号票的自动验收，用户点'转入使用'时登记；
// 清单改了重新验收登记，带版本号"）：
// - 验收（check）：档案里 ops.json 现在的内容（按内容的指纹 hash 认）跑一遍 acceptance.ts。同一份内容验过（全过、没过）就不再自动验
//   （ops_manifest_checked 记着）；"等服务上线后再跑"的只记在内存里，下次用到再验。同一份同时只验一遍（后来的等前面那一遍）。
//   force（维护者的 check_ops、转入使用的请求）不管验没验过都重验。
// - 登记（ops_manifest_registered）：使用中的项目，清单全过了才登记，版本号从 1 起每登记一次加一，登记的是读出来的那一份——秘书用的
//   是登记着的版本，档案里改了不影响，直到改过的那份验收全过、登记成下一版。转入使用时（goLiveEvents，和转入使用同一事务）登记
//   验收全过的那份；验收还在等服务上线的，服务起来以后秘书第一次用到时验、过了登记。
// - 使用中的项目秘书用到时（usable）：档案里的和登记着的一样就用登记着的；不一样（或者还没登记过）先验，全过登记新的一版再用；
//   没过的照旧用登记着的那一版（没有就只有通用操作），没过的原因告诉维护者一次（notifyMaintainer）。
// - 建设中的项目转运营检查清单里那一项（checklistView，同步）：没交、模板原样、读不通、格式不对的马上说；格式对的看这份内容验过没有，
//   没验过的在后台开验、清单上写"正在验收"，验完了 onChecked（刷新还在等的转入使用确认卡）。
import { isDeletedEventPayload, type Project } from "@ergo/protocol";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { OPERATIONS_CHANNEL } from "../projects/api.ts";
import { formatProblems, type OpsCheckResult, runAcceptance } from "./acceptance.ts";
import { type OpsCheckBy, type OpsManifestCheckedPayload, type OpsManifestRegisteredPayload, PROJECT_OPS_EVENTS } from "./events.ts";
import { manifestHash, type OpsManifestRead, parseOpsManifest, readOpsText } from "./manifest.ts";
import { type OpsMsg } from "./problems.ts";
import type { RunContext } from "./runner.ts";

/** 档案里的清单现在的样子 */
export type OpsFileState =
  | { kind: "missing" }
  | { kind: "unreadable"; problem: OpsMsg }
  | { kind: "present"; text: string; hash: string; read: Exclude<OpsManifestRead, { kind: "missing" }> };

/** 一次验收的结论，连同验的是哪一份、什么时候 */
export interface OpsCheck extends OpsCheckResult {
  hash: string;
  at: string;
}

/** 秘书用到时：登记着的那一版，以及档案里的为什么没用上（没交、读不了、新改的验收没过 / 在等服务） */
export interface OpsUsable {
  registered?: OpsManifestRegisteredPayload;
  file: "same" | "missing" | "unreadable" | "pending";
  /** 档案里新改的那份（file 是 pending 时）：验收的结论 */
  pending?: OpsCheck;
  problem?: OpsMsg;
}

/** 转运营检查清单里那一项现在的样子 */
export type OpsChecklistView =
  | { state: "missing" }
  | { state: "template" }
  | { state: "failed"; problems: OpsMsg[] }
  | { state: "checking"; count: number }
  | { state: "waiting"; count: number; waiting: number }
  | { state: "passed"; count: number };

export interface OpsRegistryDeps {
  store: EventStore;
  /** 项目档案里 ops.json 的位置 */
  opsFile(projectId: string): string;
  /** 验收要的：跑测试的上下文（使用中看 LSM 上的服务，别的看运营方案里的服务）、"只读的真不写"比哪几个目录 */
  context(project: Project): { run: RunContext; watchDirs: string[]; base: string };
  /** 档案里那份是不是规范模板原样 */
  isTemplate(text: string): boolean;
  /** 白送的通用操作的名字（项目清单里不能再用） */
  reserved: readonly string[];
  /** 使用中的项目自动验的没过：告诉维护者（同一份内容只说一次：没过的记下了，不再自动验） */
  notifyMaintainer?(project: Project, check: OpsCheck): void;
  /** 一次验收做完了（建设中的项目：刷新还在等的转入使用确认卡上的清单） */
  onChecked?(project: Project): void;
  now: () => string;
  log: (line: string) => void;
}

export interface OpsRegistry {
  fileState(project: Project): OpsFileState;
  /** 登记着的最新一版（没登记过是 undefined） */
  registered(projectId: string): OpsManifestRegisteredPayload | undefined;
  /** 这份内容最近一次验收（内存里的、记下的） */
  lastCheck(projectId: string, hash: string): OpsCheck | undefined;
  /** 验收档案里现在那份（见文件开头）；没交、读不了的是 undefined */
  check(project: Project, opts: { by: OpsCheckBy; force?: boolean }): Promise<OpsCheck | undefined>;
  /** 使用中的项目秘书用到时该用哪一版（见文件开头） */
  usable(project: Project): Promise<OpsUsable>;
  /** 转入使用时登记（和转入使用同一事务）：档案里那份验收全过了才有 */
  goLiveEvents(project: Project): NewEvent[];
  /** 转运营检查清单里那一项（同步；没验过的在后台开验） */
  checklistView(project: Project): OpsChecklistView;
}

/** 内存里按项目和内容认一次验收 */
const keyOf = (projectId: string, hash: string) => `${projectId}:${hash}`;

export function createOpsRegistry(deps: OpsRegistryDeps): OpsRegistry {
  const memory = new Map<string, OpsCheck>();
  const running = new Map<string, Promise<OpsCheck>>();

  const fileState = (project: Project): OpsFileState => {
    const read = readOpsText(deps.opsFile(project.id));
    if (read.kind === "missing") return { kind: "missing" };
    if (read.kind === "broken") return { kind: "unreadable", problem: read.problem };
    return { kind: "present", text: read.text, hash: manifestHash(read.text), read: parseOpsManifest(read.text, deps.reserved) };
  };

  const eventsOf = <T extends { projectId: string }>(type: string, projectId: string): T[] =>
    deps.store
      .read(OPERATIONS_CHANNEL, 0, type)
      .map((e) => e.payload)
      .filter((p): p is T => !isDeletedEventPayload(p) && (p as T).projectId === projectId);

  const registered = (projectId: string) => eventsOf<OpsManifestRegisteredPayload>(PROJECT_OPS_EVENTS.registered, projectId).at(-1);

  const lastCheck = (projectId: string, hash: string): OpsCheck | undefined => {
    const inMemory = memory.get(keyOf(projectId, hash));
    if (inMemory) return inMemory;
    const stored = eventsOf<OpsManifestCheckedPayload>(PROJECT_OPS_EVENTS.checked, projectId)
      .filter((p) => p.hash === hash)
      .at(-1);
    return stored ? { outcome: stored.outcome, problems: stored.problems, warnings: stored.warnings, ops: stored.ops, hash, at: stored.time } : undefined;
  };

  /** 登记一版（读得通的那份） */
  const registerEvent = (project: Project, state: Extract<OpsFileState, { kind: "present" }>): NewEvent | undefined => {
    if (state.read.kind !== "ok") return undefined;
    const prev = registered(project.id);
    if (prev?.hash === state.hash) return undefined;
    const payload: OpsManifestRegisteredPayload = {
      projectId: project.id,
      projectName: project.name,
      version: (prev?.version ?? 0) + 1,
      hash: state.hash,
      endpoint: state.read.endpoint,
      ops: state.read.ops,
      via: prev ? "changed" : "go_live",
      time: deps.now(),
    };
    return { channel: OPERATIONS_CHANNEL, type: PROJECT_OPS_EVENTS.registered, payload, idempotencyKey: `ops-registered:${project.id}:${state.hash}` };
  };

  /** 记下一次验收的结论（全过、没过的；等服务上线的只在内存里） */
  const checkedEvent = (project: Project, check: OpsCheck, by: OpsCheckBy): NewEvent => {
    const payload: OpsManifestCheckedPayload = {
      projectId: project.id,
      projectName: project.name,
      hash: check.hash,
      outcome: check.outcome === "passed" ? "passed" : "failed",
      problems: check.problems,
      warnings: check.warnings,
      ops: check.ops,
      by,
      time: check.at,
    };
    return { channel: OPERATIONS_CHANNEL, type: PROJECT_OPS_EVENTS.checked, payload };
  };

  /** 不用跑测试就有结论的（一个操作都没有）：当场记下 */
  const recordCheck = (project: Project, hash: string, result: OpsCheckResult, by: OpsCheckBy): OpsCheck => {
    const check: OpsCheck = { ...result, hash, at: deps.now() };
    memory.set(keyOf(project.id, hash), check);
    deps.store.append(checkedEvent(project, check, by));
    return check;
  };

  /** 验一遍（同一份同时只验一遍） */
  const runCheck = (project: Project, state: Extract<OpsFileState, { kind: "present" }>, by: OpsCheckBy): Promise<OpsCheck> => {
    const key = keyOf(project.id, state.hash);
    const inFlight = running.get(key);
    if (inFlight) return inFlight;
    const job = (async (): Promise<OpsCheck> => {
      let result: OpsCheckResult;
      if (state.read.kind === "broken") result = { outcome: "failed", problems: [state.read.problem], warnings: [], ops: [] };
      else {
        const ctx = deps.context(project);
        result = await runAcceptance({ project, read: state.read, run: ctx.run, watchDirs: ctx.watchDirs, base: ctx.base, key: `ops-check:${project.id}:${state.hash}` });
      }
      const check: OpsCheck = { ...result, hash: state.hash, at: deps.now() };
      memory.set(key, check);
      const events: NewEvent[] = check.outcome === "waiting" ? [] : [checkedEvent(project, check, by)];
      // 使用中的项目：全过了登记成新的一版（项目这会儿可能已经不在使用中了：按现在的看）
      const now = project.state === "in_use" ? project : undefined;
      if (now && check.outcome === "passed") {
        const reg = registerEvent(now, state);
        if (reg) events.push(reg);
      }
      if (events.length > 0) deps.store.appendBatch(events);
      deps.log(`项目 ${project.id} 的运营接口清单验收：${check.outcome}${check.problems.length > 0 ? `（${check.problems.length} 处问题）` : ""}`);
      if (project.state === "in_use" && check.outcome === "failed" && by !== "maintainer") deps.notifyMaintainer?.(project, check);
      deps.onChecked?.(project);
      return check;
    })().finally(() => running.delete(key));
    running.set(key, job);
    return job;
  };

  const check: OpsRegistry["check"] = async (project, opts) => {
    const state = fileState(project);
    if (state.kind !== "present") return undefined;
    if (!opts.force) {
      const done = lastCheck(project.id, state.hash);
      if (done && done.outcome !== "waiting") return done;
    }
    return runCheck(project, state, opts.by);
  };

  return {
    fileState,
    registered,
    lastCheck,
    check,
    async usable(project) {
      const reg = registered(project.id);
      const state = fileState(project);
      const base = reg ? { registered: reg } : {};
      if (state.kind === "missing") return { ...base, file: "missing" };
      if (state.kind === "unreadable") return { ...base, file: "unreadable", problem: state.problem };
      if (reg?.hash === state.hash) return { ...base, file: "same" };
      let done = lastCheck(project.id, state.hash);
      if (!done || done.outcome === "waiting") done = await runCheck(project, state, "secretary");
      // 建设中验过、转入使用那一刻还没验完的：这会儿是使用中了，全过的补登记
      if (done.outcome === "passed" && project.state === "in_use") {
        const reg = registerEvent(project, state);
        if (reg) deps.store.append(reg);
      }
      const now = registered(project.id);
      if (now?.hash === state.hash) return { registered: now, file: "same" };
      return { ...(now ? { registered: now } : {}), file: "pending", pending: done };
    },
    goLiveEvents(project) {
      const state = fileState(project);
      if (state.kind !== "present") return [];
      const done = lastCheck(project.id, state.hash);
      if (done?.outcome !== "passed") return [];
      const reg = registerEvent(project, state);
      return reg ? [reg] : [];
    },
    checklistView(project) {
      const state = fileState(project);
      if (state.kind === "missing") return { state: "missing" };
      if (state.kind === "unreadable") return { state: "failed", problems: [state.problem] };
      if (deps.isTemplate(state.text)) return { state: "template" };
      if (state.read.kind === "broken") return { state: "failed", problems: [state.read.problem] };
      const count = state.read.ops.length;
      const format = formatProblems({ project, read: state.read, run: deps.context(project).run });
      if (format.problems.length > 0) return { state: "failed", problems: format.problems };
      let done = lastCheck(project.id, state.hash);
      // 一个操作都没有（项目只用通用操作）：没有测试要跑，格式对就是全过，当场记下
      if (!done && count === 0) done = recordCheck(project, state.hash, { outcome: "passed", problems: [], warnings: format.warnings, ops: [] }, "go_live");
      if (!done) {
        if (!running.has(keyOf(project.id, state.hash))) void runCheck(project, state, "go_live").catch((err: unknown) => deps.log(`验收项目 ${project.id} 的运营接口清单出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
        return { state: "checking", count };
      }
      if (done.outcome === "failed") return { state: "failed", problems: done.problems };
      if (done.outcome === "waiting") return { state: "waiting", count, waiting: done.ops.filter((o) => o.result === "waiting").length };
      return { state: "passed", count };
    },
  };
}
