// 从运行时已有的会话接管（290 号票，issue 24 方案 2.3、用户答复第 2 条；调研 31 第 1、3 节，32 第 6.2 节，35 第 4 节）。
// 新建项目 / 任务时多一个入口"从 Claude Code 会话接管"：列本机的会话、标出正被占着的，选中一个建成任务（普通任务）或项目，
// 维护者的运行时是那个运行时、接着选中的会话、工作目录用会话原来的（守卫的工作目录就是它）。运行时自己的那几样（列、核对、分叉、
// 读前情）在运行时的登记表里（插件登记的，runtime/runtimes.ts 的 AgentRuntime）；这里是内核的那一半：
// - 写入锁：任务、项目上记着的接管（Task.takeover、Project.takeover）就是锁——记着、没交还、维护者还用那个运行时、没删掉的，二狗管着它。
//   这期间只有那个维护者的子进程写它（agent 管家一个维护者只起一个子进程）；列会话时标"二狗的任务 / 项目在管"，别的再接管同一个被拒
//   （只能分叉一份）。"交还"后维护者不拉起（运行时闸门当作不能用），用户可以回终端里用；"收回"先核对它没在别处开着，再接着；
// - 占着的会话（终端里开着：CLI 不拦第二个写入者，接了会分叉、丢轮；后台会话在跑；查不到占没占）不直接接，先在那边关掉，或者分叉
//   一份接管（原会话不动）；
// - 前情：读主线最近一段（运行时给，大会话只读尾部），翻成维护者会话里的消息（prelude：给人看、缩放三档照常，不交给 agent、不采成素材），
//   前面一行说明从哪读的、后面一行写明接管了、工作目录在哪；读不出来照样接管，写明没读出来；
// - 建出的：任务是普通任务（第一条输入是用户写的"接着让它做什么"，前情在它之前进会话）；项目不经秘书直接建出（筹备中，不自动开始，
//   用户在项目的会话里说话时维护者才接着做）。
// 292 号票（交给官方 App、再收回来，issue 24 用户答复第 4、6 条；调研 35）：同一套状态（任务、项目上的 RuntimeTakeover）记着会话现在在哪边——
// 二狗接管（没交还）/ 官方 App（交还了、remote.since）/ 空着（交还了）。运行时自己的那几样（开 / 唤醒后台会话、拿链接、停掉、读会话）在登记表的
// remoteControl 里；这里是二狗这一侧：
// - 交给官方 App（act remote）：维护者在做一轮的先打断，记成交还了（运行时闸门让它的子进程停掉、不再拉起），等子进程退干净（到点没退不交）；
//   记下会话此刻最后一条（只读跟随从它后面补记），交给运行时开（第一次）或唤醒（以后，不带参数）后台会话，拿到链接记在 remote 上、会话里写一句；
//   交不出去（还开着、开出副本、没开起来）的回到交之前的样子。二狗自己开的会话（不是接管来的）也能交：按会话目录里现在接着的那个会话
//   （运行时的 currentSession），第一次交时才在任务、项目上记下（own）；
// - 在官方 App 里时：二狗不写这个会话（不拉起、会话里说话被拒、写明先收回），但只读跟随——定时（followMs）、收回时读运行时的会话记录，把那边新增的
//   用户说的、它回的、调用的工具补记进维护者的会话（remote：标"在官方 App 里"，不交给 agent、不采成素材；按那边每条的 id 去重，补记过的不重复记）；
//   读到哪了记在内存里（重启后从交出去那一刻接着，靠去重不重复）；链接一时没拿到的跟随时再拿；
// - 收回到二狗（act reclaim）：先停掉那边的后台会话（停不掉不收回），最后补记一遍，记成空着，再照 290 号票核对没在别处开着、接着同一个会话。
import fs from "node:fs";
import {
  type ConversationId,
  maintainerChannel,
  type MessagePart,
  type MessageScope,
  type Project,
  type ProjectEventPayload,
  type ResumableSessionView,
  type RuntimeSessionsView,
  type RuntimeTakeover,
  runtimeIdOf,
  t,
  type TakeoverAction,
  type TakeOverBody,
  type TakeOverResult,
  type Task,
  type TaskEventPayload,
  takeoverPlaceOf,
  nowIso,
} from "@ergo/protocol";
import type { RuntimeGate } from "../agent-host/runtime-gate.ts";
import { buildMessage } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { isSecretFile, type ToolRegistry } from "../guard/index.ts";
import { resultSummary, summarizeArgs } from "../guard-runtime/describe.ts";
import type { TakeoverProjects } from "../projects/api.ts";
import type { RuntimeFollow, RuntimeHistory, RuntimeHistoryPart, RuntimeRegistry } from "../runtime/index.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { realPathOf } from "../util/real-path.ts";
import { oneLine } from "../util/text.ts";

/** 交还之后等维护者的子进程退出最多多久 */
const RELEASE_WAIT_MS = 15_000;
/** 交给官方 App 时等维护者的子进程退出最多多久（在做的那一轮先打断，打断最多等 15 秒才按被打断收尾） */
const REMOTE_RELEASE_WAIT_MS = 30_000;
/** 在官方 App 里时多久读一次那边的会话（只读跟随） */
const FOLLOW_MS = 60_000;

export interface TakeoverServiceOptions {
  /** 同一个幂等键重发：拿到第一次建出的（不再分叉、不再读前情）；292 号票：交出去、收回的说明和只读跟随补记的消息追加进维护者的会话 */
  store: Pick<EventStore, "eventByIdempotencyKey" | "appendBatch">;
  runtimes: Pick<RuntimeRegistry, "sessions" | "sessionBusy" | "forkSession" | "sessionHistory" | "get" | "remoteControl" | "currentSession" | "unavailable">;
  tasks: Pick<TaskService, "list" | "ofMaintainer" | "startTakenOver" | "setTakeover">;
  /** 项目服务建在任务之后：现取 */
  projects: () => TakeoverProjects;
  /** 运行时闸门：维护者在不在做一轮、交还收回后各自看一眼；292 号票：正在交给官方 App 时让它停下、不拉起 */
  gate: Pick<RuntimeGate, "busy" | "recheck" | "runtimeOf" | "handing">;
  /** 这个维护者的子进程还在不在（交还后等它退出） */
  live(maintainerId: string): boolean;
  /** 参数摘要按它写（守卫的工具登记表） */
  tools: ToolRegistry;
  /**
   * 会话原来的工作目录能不能用（305 号票，work-folders/ 的 check）：不在、不是文件夹、在数据目录或二狗程序目录里的抛 RequestRejected，
   * 能用的交回真实路径。不给只看在不在、是不是文件夹
   */
  checkFolder?: (folder: string) => string;
  /** 停下维护者手头这一轮（292 号票：交给官方 App 前先打断）；没在做是 false */
  stopTurn?(maintainerId: string): boolean;
  /** 维护者的会话目录（292 号票：运行时在里面记着现在接着的是哪个会话） */
  sessionDir?(maintainerId: string): string;
  now: () => string;
  log: (line: string) => void;
  /** 测试调短：交还后等子进程退出的轮询间隔 */
  pollMs?: number;
  /** 测试调短：在官方 App 里时多久读一次那边的会话（292 号票） */
  followMs?: number;
}

export interface TakeoverService {
  /** 这个运行时在本机能接管的会话：运行时列的（正被别处占着的写明），二狗自己在管的标上是谁 */
  sessions(runtimeId: string): Promise<RuntimeSessionsView>;
  /** 从选中的会话接管成任务或项目（见文件开头） */
  takeOver(runtimeId: string, body: TakeOverBody): Promise<TakeOverResult>;
  /**
   * 交还（维护者在做一轮时拒绝；等子进程退出才交回）、收回（核对过没在别处开着；在官方 App 里的先停掉那边）、交给官方 App（292 号票，见文件开头）
   */
  act(maintainerId: string, action: TakeoverAction): Promise<void>;
  /** 维护者的会话交还了 / 在官方 App 里：用户在它的会话里说话时拒收的说明；二狗管着的、不是接管来的是 undefined */
  sendRefusal(maintainerId: string): string | undefined;
  /** 只读跟随（292 号票）：读一遍在官方 App 里的会话（给了维护者只读它的），把新的补记进维护者的会话 */
  follow(maintainerId?: string): Promise<void>;
  /** 开始定时只读跟随（292 号票）；返回停下的函数 */
  startFollowing(): () => void;
}

/** 一个接管来的任务或项目 */
interface Holder {
  kind: "task" | "project";
  id: string;
  title: string;
  maintainerId: string;
  takeover: RuntimeTakeover;
}

/** 二狗自己在管的写明是哪个任务 / 项目 */
const heldText = (h: Holder) => t(h.kind === "task" ? "takeover.heldByTask" : "takeover.heldByProject", { id: h.id, title: h.title });
/** 交给官方 App 了的写明是哪个任务 / 项目交的（292 号票） */
const remoteText = (h: Holder) => t(h.kind === "task" ? "takeover.remote.heldByTask" : "takeover.remote.heldByProject", { id: h.id, title: h.title });

/** 一个任务或项目的维护者（292 号票：二狗自己开的会话交给官方 App 时，任务、项目上还没有接管记录） */
interface Owner {
  kind: "task" | "project";
  id: string;
  title: string;
  maintainerId: string;
  runtime: string;
  takeover: RuntimeTakeover | undefined;
  /** 维护者的工作目录（任务：选的文件夹；项目：项目的工作目录）；任务没选的是 undefined */
  workdir: string | undefined;
}

export function createTakeoverService(options: TakeoverServiceOptions): TakeoverService {
  const { runtimes, tasks, gate, now, log } = options;
  const runtimeTitle = (id: string) => runtimes.get(id)?.title ?? id;

  /** 接管来的任务、项目（没删掉、还用那个运行时的） */
  const holders = (): Holder[] => {
    const out: Holder[] = [];
    for (const task of tasks.list()) {
      if (task.takeover && task.deleted !== true && runtimeIdOf(task.runtime) === task.takeover.runtime) {
        out.push({ kind: "task", id: task.id, title: task.title, maintainerId: task.maintainerId, takeover: task.takeover });
      }
    }
    for (const project of options.projects().list()) {
      if (project.takeover && runtimeIdOf(project.runtime) === project.takeover.runtime) {
        out.push({ kind: "project", id: project.id, title: project.name, maintainerId: project.maintainerId, takeover: project.takeover });
      }
    }
    return out;
  };

  /** 二狗在管的（写入锁）：没交还的 */
  const lockHolder = (runtimeId: string, sessionId: string) => holders().find((h) => h.takeover.runtime === runtimeId && h.takeover.sessionId === sessionId && h.takeover.returnedAt === undefined);

  const holderOfMaintainer = (maintainerId: string): Holder | undefined => {
    const project = options.projects().maintainedBy(maintainerId);
    if (project) {
      return project.takeover && runtimeIdOf(project.runtime) === project.takeover.runtime
        ? { kind: "project", id: project.id, title: project.name, maintainerId, takeover: project.takeover }
        : undefined;
    }
    const task = tasks.ofMaintainer(maintainerId);
    return task && task.deleted !== true && task.takeover && runtimeIdOf(task.runtime) === task.takeover.runtime
      ? { kind: "task", id: task.id, title: task.title, maintainerId, takeover: task.takeover }
      : undefined;
  };

  /** 维护者是哪个任务、项目的（292 号票：没有接管记录的也认） */
  const ownerOf = (maintainerId: string): Owner | undefined => {
    const project = options.projects().maintainedBy(maintainerId);
    if (project) return { kind: "project", id: project.id, title: project.name, maintainerId, runtime: runtimeIdOf(project.runtime), takeover: project.takeover, workdir: options.projects().workdir(project) };
    const task = tasks.ofMaintainer(maintainerId);
    if (!task || task.deleted === true) return undefined;
    return { kind: "task", id: task.id, title: task.title, maintainerId, runtime: runtimeIdOf(task.runtime), takeover: task.takeover, workdir: task.workdir };
  };

  const markHeld = (runtimeId: string, list: readonly ResumableSessionView[]): ResumableSessionView[] => {
    const mine = holders().filter((h) => h.takeover.runtime === runtimeId);
    const held = mine.filter((h) => h.takeover.returnedAt === undefined);
    // 交给官方 App 了的（292 号票）：交出去的是哪个会话（中途换过 id 的按 remote.sessionId）
    const remote = mine.filter((h) => takeoverPlaceOf(h.takeover) === "remote");
    return list.map((s) => {
      const h = held.find((x) => x.takeover.sessionId === s.id);
      // 二狗自己的进程在运行时那边也显示成"开着"：二狗在管的以这里为准
      if (h) return { ...s, busy: heldText(h), heldBy: { kind: h.kind, id: h.id, title: h.title, maintainerId: h.maintainerId } };
      const r = remote.find((x) => (x.takeover.remote?.sessionId ?? x.takeover.sessionId) === s.id);
      return r ? { ...s, busy: remoteText(r) } : s;
    });
  };

  /** 等维护者的子进程退出：退了是 true，到点还没退是 false */
  const waitReleased = async (maintainerId: string, waitMs = RELEASE_WAIT_MS): Promise<boolean> => {
    const deadline = Date.now() + waitMs;
    while (options.live(maintainerId)) {
      if (Date.now() > deadline) {
        log(`交还 ${maintainerId} 的会话：${waitMs / 1000} 秒了它的子进程还没退出`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
    }
    return true;
  };

  /** 改任务、项目上记着的接管（交还、收回、交给官方 App），闸门跟着看一眼 */
  const writeOf = (owner: { kind: "task" | "project"; id: string }) => (takeover: RuntimeTakeover) => {
    if (owner.kind === "task") tasks.setTakeover(owner.id, takeover);
    else options.projects().setTakeover(owner.id, takeover);
    gate.recheck();
  };

  /** 往维护者的会话里写一句系统说明（292 号票：交给官方 App、收回到二狗） */
  const note = (owner: { kind: "task" | "project"; id: string; maintainerId: string }, text: string) => {
    const scope: MessageScope = owner.kind === "task" ? { taskId: owner.id } : { projectId: owner.id };
    options.store.appendBatch([buildMessage({ conversation: maintainerChannel(owner.maintainerId), speaker: "system", parts: [{ type: "text", text }] }, scope).event]);
  };

  /** 维护者的工作目录（后台会话在那里开、读会话时给运行时）：接管来的任务、项目就是会话原来的工作目录 */
  const holderCwd = (holder: Holder): string => ownerOf(holder.maintainerId)?.workdir ?? "";

  /** 只读跟随读到哪了（292 号票）：维护者 → 下次从哪一条之后接着读；没有的从交出去那一刻（remote.from）接着 */
  const cursors = new Map<string, string>();
  let following: Promise<void> | undefined;

  /** 读一遍一个在官方 App 里的会话，补记新的（final：后台会话已经停了） */
  const followOne = async (holder: Holder, final: boolean): Promise<void> => {
    const remote = holder.takeover.remote;
    if (!remote || (remote.since === undefined && !final)) return;
    const title = runtimeTitle(holder.takeover.runtime);
    const control = runtimes.remoteControl(holder.takeover.runtime);
    const after = cursors.get(holder.maintainerId) ?? remote.from;
    const got = await control.follow({ sessionId: remote.sessionId, cwd: holderCwd(holder), ...(after === undefined ? {} : { after }), final });
    const events = followEvents({ holder, runtimeTitle: title, sessionId: remote.sessionId, follow: got, after, tools: options.tools });
    if (events.length > 0) {
      options.store.appendBatch(events);
      log(`${holder.id} 在官方 App 里的 ${title} 会话 ${remote.sessionId}：补记了 ${got.items.length} 条${got.reset ? `（${got.reset}）` : ""}`);
    }
    if (got.cursor !== undefined) cursors.set(holder.maintainerId, got.cursor);
    // 链接一时没拿到的：跟随时再拿
    if (remote.url === undefined && remote.since !== undefined) {
      const url = await control.link({ sessionId: remote.sessionId, job: remote.job });
      const latest = holderOfMaintainer(holder.maintainerId);
      const latestRemote = latest?.takeover.remote;
      if (url !== undefined && latest && latestRemote?.since !== undefined && latestRemote.url === undefined) writeOf(latest)({ ...latest.takeover, remote: { ...latestRemote, url } });
    }
  };

  /** 读一遍（给了维护者只读它的）：同时只跑一遍，后来的等前一遍跑完再跑 */
  const followAll = (maintainerId?: string): Promise<void> => {
    const run = async () => {
      // 运行时插件停用着的不读（启用后接着读，靠去重不重复记）
      const targets = holders().filter((h) => takeoverPlaceOf(h.takeover) === "remote" && runtimes.unavailable(h.takeover.runtime) === undefined && (maintainerId === undefined || h.maintainerId === maintainerId));
      for (const holder of targets) {
        try {
          await followOne(holder, false);
        } catch (err) {
          log(`只读跟随 ${holder.id} 的会话出错：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    const next = (following ?? Promise.resolve()).then(run);
    const tracked = next.finally(() => {
      if (following === tracked) following = undefined;
    });
    following = tracked;
    return next;
  };

  /** 正在交给官方 App 的（同一个维护者又点了一次：等同一次交完） */
  const handing = new Map<string, Promise<void>>();

  /**
   * 交给官方 App（292 号票，见文件开头）：在官方 App 里的再交一次是重新打开（后台会话不在跑了的唤醒它、链接换成新拿到的）
   */
  const handOver = (maintainerId: string): Promise<void> => {
    const running = handing.get(maintainerId);
    if (running) return running;
    const done = handOverOnce(maintainerId).finally(() => handing.delete(maintainerId));
    handing.set(maintainerId, done);
    return done;
  };

  const handOverOnce = async (maintainerId: string): Promise<void> => {
    const owner = ownerOf(maintainerId);
    if (!owner) throw new RequestRejected("not_allowed", t("takeover.notTakenOver"));
    const before = owner.takeover && owner.takeover.runtime === owner.runtime ? owner.takeover : undefined;
    const title = runtimeTitle(owner.runtime);
    const control = runtimes.remoteControl(owner.runtime);
    // 现在接着的会话：会话目录里运行时记着的（中途 /clear 换过 id 的是新的）；接管来的还没拉起过的按接管的那个
    const current = options.sessionDir ? runtimes.currentSession(owner.runtime, options.sessionDir(maintainerId)) : undefined;
    const sessionId = before?.remote?.since !== undefined ? before.remote.sessionId : (current?.sessionId ?? (before && before.own !== true ? before.sessionId : undefined));
    if (sessionId === undefined) throw new RequestRejected("not_allowed", t("takeover.remote.notStarted", { runtime: title }));
    const cwd = owner.workdir ?? current?.cwd ?? "";
    const base: RuntimeTakeover = before ?? { runtime: owner.runtime, sessionId, title: owner.title, at: now(), own: true };
    const write = writeOf(owner);
    const place = before ? takeoverPlaceOf(before) : "ergo";
    const prior = base.remote?.sessionId === sessionId ? base.remote : undefined;
    // 二狗接管着的：先让闸门当它正在交（不拉起、手头那一轮先打断），等子进程退干净；交不出去时放开、照旧接着
    if (place === "ergo") gate.handing(maintainerId, true);
    try {
      if (place === "ergo") {
        if (gate.busy(maintainerId)) options.stopTurn?.(maintainerId);
        if (!(await waitReleased(maintainerId, REMOTE_RELEASE_WAIT_MS))) throw new RequestRejected("conflict", t("takeover.remote.stillRunning", { runtime: title }));
      }
      // 只读跟随从此刻会话的最后一条之后补记（已经在官方 App 里的接着原来的）
      const from = prior?.since !== undefined ? prior.from : (await control.follow({ sessionId, cwd, final: true, tail: true })).cursor;
      const opened = await control.open({ sessionId, cwd, name: owner.title, ...(prior ? { job: prior.job } : {}) });
      const remote = { job: opened.job, sessionId, ...(opened.url === undefined ? (prior?.url === undefined ? {} : { url: prior.url }) : { url: opened.url }), since: prior?.since ?? now(), ...(from === undefined ? {} : { from }) };
      write({ ...base, returnedAt: base.returnedAt ?? now(), remote });
      if (prior?.since === undefined) note(owner, remote.url ? t("takeover.remote.handed", { runtime: title, url: remote.url }) : t("takeover.remote.handedNoLink", { runtime: title }));
      log(`${owner.id} 把 ${title} 会话 ${sessionId} 交给了官方 App（后台会话 ${opened.job}${remote.url ? `，${remote.url}` : "，还没拿到链接"}）`);
    } finally {
      // 交成了的闸门看记下的（在官方 App 里）；交不出去的放开，二狗接着管（本来就交还了的照旧空着）
      if (place === "ergo") gate.handing(maintainerId, false);
    }
  };

  return {
    async sessions(runtimeId) {
      return { sessions: markHeld(runtimeId, await runtimes.sessions(runtimeId)) };
    },

    async takeOver(runtimeId, body) {
      const done = options.store.eventByIdempotencyKey(body.idempotencyKey);
      if (done) return resultOf(done.payload as Partial<TaskEventPayload & ProjectEventPayload>);
      const title = runtimeTitle(runtimeId);
      const listed = markHeld(runtimeId, await runtimes.sessions(runtimeId));
      const session = listed.find((s) => s.id === body.sessionId);
      if (!session) throw new RequestRejected("not_found", t("takeover.noSession", { runtime: title }));
      // 被占着的（二狗自己在管的、别处开着的、查不到的）不直接接：先在那边关掉，或者分叉一份
      if (session.busy !== undefined && body.fork !== true) throw new RequestRejected("conflict", t("takeover.busy", { busy: session.busy }));
      const cwd = options.checkFolder ? options.checkFolder(session.cwd) : realPathOf(session.cwd);
      if (cwd === undefined || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new RequestRejected("bad_params", t("takeover.noWorkdir", { cwd: session.cwd }));
      const sessionId = body.fork === true ? await runtimes.forkSession(runtimeId, session.id, cwd) : session.id;
      let history: RuntimeHistory | undefined;
      let historyError: string | undefined;
      try {
        history = await runtimes.sessionHistory(runtimeId, sessionId, cwd);
      } catch (err) {
        historyError = err instanceof Error ? err.message : String(err);
        log(`接管 ${title} 会话 ${sessionId}：前情没读出来：${historyError}`);
      }
      const takeover: RuntimeTakeover = { runtime: runtimeId, sessionId, title: session.title, ...(body.fork === true ? { forkedFrom: session.id } : {}), at: now() };
      const prelude = (conversation: ConversationId, scope: MessageScope) =>
        preludeEvents({ conversation, scope, runtimeTitle: title, session, cwd, takeover, history, historyError, tools: options.tools, key: body.idempotencyKey });
      const count = history?.items.length ?? 0;
      if (body.as === "task") {
        const task = tasks.startTakenOver({ title: session.title, request: body.request, runtime: runtimeId, workdir: cwd, takeover }, body.idempotencyKey, (created: Task) =>
          prelude(maintainerChannel(created.maintainerId), { taskId: created.id }),
        );
        log(`从 ${title} 会话 ${session.id}${body.fork === true ? `（分叉成 ${sessionId}）` : ""}接管成任务 ${task.id}：工作目录 ${cwd}，前情 ${count} 条`);
        return { taskId: task.id, maintainerId: task.maintainerId, sessionId: task.takeover?.sessionId ?? sessionId, prelude: count };
      }
      const goal = body.request.trim() || session.title;
      const project = options.projects().takeOver({ name: session.title, goal, runtime: runtimeId, workdir: cwd, takeover }, body.idempotencyKey, (created: Project) =>
        prelude(maintainerChannel(created.maintainerId), { projectId: created.id }),
      );
      log(`从 ${title} 会话 ${session.id}${body.fork === true ? `（分叉成 ${sessionId}）` : ""}接管成项目 ${project.id}：工作目录 ${cwd}，前情 ${count} 条`);
      return { projectId: project.id, maintainerId: project.maintainerId, sessionId: project.takeover?.sessionId ?? sessionId, prelude: count };
    },

    async act(maintainerId, action) {
      if (action === "remote") return handOver(maintainerId);
      const holder = holderOfMaintainer(maintainerId);
      if (!holder) throw new RequestRejected("not_allowed", t("takeover.notTakenOver"));
      const title = runtimeTitle(holder.takeover.runtime);
      const write = writeOf(holder);
      if (action === "return") {
        if (holder.takeover.returnedAt !== undefined) return;
        // 二狗自己开的会话（292 号票）不是接管来的，没有"交还"
        if (holder.takeover.own === true) throw new RequestRejected("not_allowed", t("takeover.notTakenOver"));
        // 在做一轮的不交还：交还了它还在写，用户回终端里一用就交错（会话记录没有锁）
        if (gate.busy(maintainerId)) throw new RequestRejected("conflict", t("takeover.busyTurn", { runtime: title }));
        write({ ...holder.takeover, returnedAt: now() });
        // 维护者的子进程退干净了才算交还（闸门让它停掉）
        await waitReleased(maintainerId);
        log(`${holder.id} 把 ${title} 会话 ${holder.takeover.sessionId} 交还了`);
        return;
      }
      if (holder.takeover.returnedAt === undefined) return;
      let current = holder.takeover;
      // 在官方 App 里的（292 号票）：先停掉那边的后台会话（停不掉不收回），最后补记一遍，记成空着
      const remote = current.remote;
      if (remote?.since !== undefined) {
        await runtimes.remoteControl(current.runtime).stop({ sessionId: remote.sessionId, job: remote.job });
        try {
          await followOne(holder, true);
        } catch (err) {
          log(`收回前最后补记一遍 ${holder.id} 的会话出错：${err instanceof Error ? err.message : String(err)}`);
        }
        cursors.delete(maintainerId);
        const { since: _since, from: _from, ...kept } = remote;
        current = { ...current, remote: kept };
        write(current);
        log(`${holder.id} 停掉了官方 App 那边的 ${title} 后台会话 ${remote.job}`);
      }
      // 收回：先核对它没在别处开着（交还期间用户可能在终端里开着）；别的任务、项目又接管了同一个的也不行
      const other = lockHolder(current.runtime, current.sessionId);
      if (other && other.maintainerId !== maintainerId) throw new RequestRejected("conflict", t("takeover.busy", { busy: heldText(other) }));
      const checked = current.remote?.sessionId ?? current.sessionId;
      let busy: string | undefined;
      try {
        busy = await runtimes.sessionBusy(current.runtime, checked);
      } catch (err) {
        throw new RequestRejected("conflict", t("takeover.checkFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
      if (busy !== undefined) throw new RequestRejected("conflict", t("takeover.reclaimBusy", { busy }));
      const { returnedAt: _returned, ...rest } = current;
      write(rest);
      if (remote?.since !== undefined) note(holder, t("takeover.remote.reclaimed", { runtime: title }));
      log(`${holder.id} 收回了 ${title} 会话 ${checked}`);
    },

    sendRefusal(maintainerId) {
      const holder = holderOfMaintainer(maintainerId);
      if (holder?.takeover.returnedAt === undefined) return undefined;
      const runtime = runtimeTitle(holder.takeover.runtime);
      return takeoverPlaceOf(holder.takeover) === "remote" ? t("takeover.remote.send", { runtime }) : t("takeover.returnedSend", { runtime });
    },

    follow: (maintainerId) => followAll(maintainerId),

    startFollowing() {
      const timer = setInterval(() => void followAll(), options.followMs ?? FOLLOW_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/** 同一个幂等键重发时：第一次建出的任务、项目上记着的 */
function resultOf(payload: Partial<TaskEventPayload & ProjectEventPayload>): TakeOverResult {
  const owner = payload.task ?? payload.project;
  if (!owner?.takeover) throw new RequestRejected("bad_params", t("conversation.messages.keyReused"));
  return {
    ...(payload.task ? { taskId: payload.task.id } : { projectId: payload.project!.id }),
    maintainerId: owner.maintainerId,
    sessionId: owner.takeover.sessionId,
    prelude: 0,
  };
}

/** 前情和接管说明的事件（见文件开头）：都带着归属；幂等键按这次接管的键派生（重发不重复） */
export function preludeEvents(input: {
  conversation: ConversationId;
  scope: MessageScope;
  runtimeTitle: string;
  session: ResumableSessionView;
  cwd: string;
  takeover: RuntimeTakeover;
  history: RuntimeHistory | undefined;
  historyError: string | undefined;
  tools: ToolRegistry;
  key: string;
}): NewEvent[] {
  const { conversation, scope, runtimeTitle, session, history } = input;
  const events: NewEvent[] = [];
  let seq = 0;
  const push = (speaker: "user" | "agent" | "system", parts: MessagePart[], prelude: boolean) => {
    events.push(buildMessage({ conversation, speaker, parts, ...(prelude ? { prelude: true as const } : {}) }, { ...scope, idempotencyKey: `${input.key}#prelude-${seq++}` }).event);
  };
  const items = history?.items ?? [];
  if (input.historyError !== undefined) push("system", [{ type: "text", text: t("takeover.prelude.failed", { runtime: runtimeTitle, error: oneLine(input.historyError, 300) }) }], true);
  else if (items.length === 0) push("system", [{ type: "text", text: t("takeover.prelude.empty", { runtime: runtimeTitle, title: session.title }) }], true);
  else {
    const head = history?.truncated
      ? t("takeover.prelude.headTruncated", { runtime: runtimeTitle, title: session.title, count: items.length })
      : t("takeover.prelude.head", { runtime: runtimeTitle, title: session.title, count: items.length });
    push("system", [{ type: "text", text: head }], true);
  }
  for (const item of items) {
    if (item.kind === "user") push("user", [{ type: "text", text: item.text }], true);
    else if (item.kind === "compacted") push("system", [{ type: "text", text: t("takeover.prelude.compacted", { runtime: runtimeTitle }) }], true);
    else {
      const parts = item.parts.map((part) => preludePart(part, input));
      if (parts.length > 0) push("agent", parts, true);
    }
  }
  const where = session.branch ? t("takeover.note.whereBranch", { cwd: input.cwd, branch: session.branch }) : t("takeover.note.where", { cwd: input.cwd });
  const text = input.takeover.forkedFrom
    ? t("takeover.note.forked", { runtime: runtimeTitle, title: session.title, where })
    : t("takeover.note.taken", { runtime: runtimeTitle, title: session.title, where });
  push("system", [{ type: "text", text }], false);
  return events;
}

/** 前情里的一块：文字、思考照搬；工具调用画成二狗的工具调用（没过二狗的守卫：不写处置），读密钥文件的不留结果。只读跟随补记的（292 号票）同样画，调用 id 换个前缀 */
function preludePart(part: RuntimeHistoryPart, input: { conversation: ConversationId; tools: ToolRegistry; key: string; prefix?: string }): MessagePart {
  if (part.type !== "tool") return { type: part.type, text: part.text };
  const secret = part.tool === "read" && typeof part.args.path === "string" && isSecretFile(part.args.path);
  const call: Extract<MessagePart, { type: "tool_call" }> = {
    type: "tool_call",
    callId: `${input.prefix ?? "prelude"}-${input.conversation.split(":").at(-1)}-${part.id}`,
    tool: part.tool,
    argsSummary: summarizeArgs(input.tools, part.tool, part.args),
    categoryTitles: [],
    withinGrant: false,
    genericBash: part.tool === "bash",
    outcome: part.failed ? "error" : "done",
    ...(part.result !== undefined && !secret ? { resultSummary: resultSummary(part.result) } : {}),
    ...(secret ? { readsSecretFile: true } : {}),
  };
  return call;
}

/**
 * 只读跟随补记的消息（292 号票）：在官方 App 里发生的（remote），一条一条照前情的画法（工具调用没过二狗的守卫：不写处置，读密钥文件的不留结果），
 * 时间用那边记的；幂等键按会话和那边那一条的 id（补记过的不重复记）。那边压缩过、对不上的各写一句说明（同一处只写一次）
 */
export function followEvents(input: { holder: { kind: "task" | "project"; id: string; maintainerId: string }; runtimeTitle: string; sessionId: string; follow: RuntimeFollow; after: string | undefined; tools: ToolRegistry }): NewEvent[] {
  const { holder, runtimeTitle, sessionId, follow } = input;
  const conversation = maintainerChannel(holder.maintainerId);
  const scope: MessageScope = holder.kind === "task" ? { taskId: holder.id } : { projectId: holder.id };
  const events: NewEvent[] = [];
  const push = (speaker: "user" | "agent" | "system", parts: MessagePart[], key: string, at: string | undefined) => {
    const built = buildMessage({ conversation, speaker, parts, remote: true }, { ...scope, idempotencyKey: `remote:${sessionId}:${key}` });
    if (at !== undefined) {
      const time = Date.parse(at);
      if (Number.isFinite(time)) built.message.time = nowIso(new Date(time));
    }
    events.push(built.event);
  };
  if (follow.reset === "lost") push("system", [{ type: "text", text: t("takeover.remote.lost", { runtime: runtimeTitle }) }], `lost:${input.after ?? ""}`, undefined);
  for (const item of follow.items) {
    if (item.kind === "user") push("user", [{ type: "text", text: item.text }], item.key, item.at);
    else if (item.kind === "compacted") push("system", [{ type: "text", text: t("takeover.remote.compacted", { runtime: runtimeTitle }) }], item.key, item.at);
    else {
      const parts = item.parts.map((part) => preludePart(part, { conversation, tools: input.tools, key: item.key, prefix: "remote" }));
      if (parts.length > 0) push("agent", parts, item.key, item.at);
    }
  }
  return events;
}
