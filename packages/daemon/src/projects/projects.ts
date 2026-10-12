// 项目（规格第 11 节，15 号票）：立项、立项书、项目状态机、项目档案、删除。
// 每次变化是项目列表频道上的一条 project 事件（同一事务里还有它引起的别的事件）；状态迁移按共享协议包的
// PROJECT_ACTION_RULES（projectActions 校验能不能做、projectActionTarget 给出到哪个状态），项目页上的入口也按它给出。
//
// 立项有三个入口，项目都以"筹备中"诞生、维护者随之产生：
// - 秘书收口的"建议立项"卡上点"立项"（秘书自己建议的、用户在消息里明说的、用户点"新建项目"后秘书出的，都是这张卡）：
//   新的维护者 pm-<n>，它的会话里放一条说明；用户进"和维护者交流"说话时才唤起它（maintainers.ts）；
// - 任务转为项目（用户定项目名）：不新建维护者，原任务的维护者接着做立项问答（同一事务给它一条通知），
//   原任务以"已完成 · 已转为项目"结束；
// - 点"新建项目"本身不建项目：给秘书一条通知，它不经"是不是项目"的判断，直接出建议立项卡。
// 立项问答之后维护者交出立项书（submitCharter）→ 立项书卡放进待我处理 → 用户"确认并开工"（项目转建设中，建出首个建设任务）
// 或"只确认，稍后开工"（留在筹备中，标"立项书已确认"）；不管哪个，项目类型、外部工作目录绑定、工具包在确认时就生效。
// 立项书确认之后不能再交：项目类型、外部路径绑定以后要改，归后续的票。
// 首个建设任务完成（13 号票的任务完成回调 taskCompleted，daemon.ts 接上）时项目自动进入使用中（唯一一处项目状态随任务变）；之后的任务、服务在不在线都不改项目状态。
// 删除只能从已归档发起：先在待我处理里放一条二次确认，用户选"确认删除"才删（deletion.ts，ADR-0010）。
// 16 号票：
// - 只涉及一个项目的任务由这个项目的维护者执行：projectOf(task) 是"任务属于哪个项目"唯一的一处；
// - 项目还有正在做或排队的工单时不能归档（放弃、归档都被拒，说明先完成或取消哪几个任务）；
// - 重置维护者（resetMaintainer）不改项目状态，不在状态机里；
// - 开发类项目用默认工作目录的，立项书确认时把工作目录初始化成 git 仓库（子 agent 并行要各用一个 git worktree）；
// - 起草计划的工单段里进展文档经 writeProgress 写回（整份重写前留旧版本，同守卫接入的自动留旧版本）。
// 27 号票：项目的工具包可以改（changeToolkit）：用户在项目页直接改、批准维护者提交的"工具包变更"卡、维护者自己增减 skill 或减少能力。
// 每次改是一条 toolkit_changed 的 project 事件，维护者会话的时间线上记一笔；项目维护者模块据此按新工具包重新装配。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_NAME_MARK,
  type Charter,
  type CharterCardPayload,
  CHARTER_DECISION_LABEL,
  type CharterDecision,
  CHANNELS,
  type ConversationId,
  type ConvertTaskParams,
  type ConvertTaskResult,
  EVENT_TYPES,
  inboxItemProjectId,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  type NewProjectParams,
  type NewProjectResult,
  type NoticeInboxItem,
  type PlanToolkit,
  type Project,
  PROJECT_DELETE_CANCEL,
  PROJECT_DELETE_CONFIRM,
  PROJECT_DELETE_LIMITS,
  PROJECT_GOAL_MAX,
  PROJECT_KIND_LABEL,
  PROJECT_NAME_MAX,
  PROJECT_STATE_LABEL,
  ARCHIVING_ACTIONS,
  archiveBlockedText,
  canResetMaintainer,
  hasOwnMaintainer,
  type ProjectActionParams,
  type ProjectActionResult,
  projectActionRefusal,
  projectActions,
  projectActionTarget,
  type ProjectChange,
  type ProjectEventPayload,
  type ProjectState,
  type SuggestProjectCardPayload,
  type ResetMaintainerResult,
  type Task,
  type TaskActor,
  toolkitBashWording,
  toolkitChangeText,
  sameToolkit,
  projectToolkit,
  type WorkOrder,
  availableTaskActions,
  isInternalTo,
  isPlainTask,
  taskActRefusal,
  canTellSecretary,
  tellSecretaryField,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { RequestRejected, UnknownProjects } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { isWithin } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Material } from "../materials/index.ts";
import type { PurgeRewriters } from "../memory/rewriters.ts";
import { briefText, type TaskService } from "../tasks/tasks.ts";
import { realPathOf } from "../util/real-path.ts";
import { oneLine } from "../util/text.ts";
import { deleteProject, type MaintainerSuspension } from "./deletion.ts";
import { CHARTER_EVENTS, CHARTERS_CHANNEL, type CharterDecidedPayload, type CharterSubmittedPayload } from "./events.ts";
import { ensureProjectRecords, preservePaths, projectRecordsPaths, type ProjectRecordsPaths, projectWorkdir, writeConfirmedCharter } from "./records.ts";
import { SUBMIT_CHARTER_TOOL, SUGGEST_PROJECT_TOOL } from "./tool-names.ts";
import { countProjects, getProjectRow, latestCharter, listProjects, projectNamed, projectOfMaintainer } from "./views.ts";

/** 维护者交出的立项书：工具包里没写的按默认补上（开发类带 bash） */
export interface CharterSubmission {
  charter: Charter;
  toolkit?: Partial<PlanToolkit>;
}

export interface ProjectService {
  get(projectId: string): Project | undefined;
  /** 没删掉的项目 */
  list(): Project[];
  /** 某个维护者的项目（删掉的也认：deleted 为 true） */
  ofMaintainer(maintainerId: string): { project: Project; deleted: boolean } | undefined;
  /** 某个维护者维护的、没删掉的项目 */
  maintainedBy(maintainerId: string): Project | undefined;
  /** 任务属于哪个项目（16 号票）：由这个项目的维护者执行的任务（只涉及一个项目的）；任务自己的维护者执行的、项目删掉了的没有 */
  projectOf(task: Task): Project | undefined;
  /** 写回进展（起草计划的工单段，16 号票）：整份换成这些内容，旧版本先留进历史区 */
  writeProgress(projectId: string, text: string): void;
  /** 重置维护者（项目页上，16 号票）：项目状态不变，维护者新开一段会话，只凭项目档案重建理解；已归档的不能 */
  resetMaintainer(projectId: string, idempotencyKey: string): ResetMaintainerResult;
  /** 项目档案各文件的位置 */
  records(projectId: string): ProjectRecordsPaths;
  /** 项目现在的工作目录（默认在项目档案里；绑定了外部路径就是它） */
  workdir(project: Project): string;
  /** "建议立项"卡上点了"立项" */
  kickoffFromCard(payload: SuggestProjectCardPayload, idempotencyKey: string): CardActionEffect<SuggestProjectCardPayload>;
  /** 点"新建项目"：给秘书一条通知，它直接收口出建议立项卡 */
  newProject(params: NewProjectParams, idempotencyKey: string): NewProjectResult;
  /** 任务转为项目 */
  convertTask(params: ConvertTaskParams, idempotencyKey: string): ConvertTaskResult;
  /** 维护者交出立项书（submit_charter 工具）：立项书卡放进待我处理；不让交时抛 RequestRejected，原因交回维护者 */
  submitCharter(projectId: string, maintainerId: string, submission: CharterSubmission): { cardId: string; revision: number; toolkit: PlanToolkit };
  /** 立项书卡上的"确认并开工"（start）/"只确认，稍后开工"（later） */
  confirmCharter(payload: CharterCardPayload, decision: CharterDecision, note: string | undefined, idempotencyKey: string): CardActionEffect<CharterCardPayload>;
  /** 项目页上的动作 */
  act(params: ProjectActionParams, idempotencyKey: string): ProjectActionResult;
  /**
   * 改项目的工具包（27 号票）：整个换成 toolkit（名字的合法性由调用方查过）。立项书确认之前没有工具包、已归档的项目，不能改。
   * 和项目事件同一事务追加维护者会话时间线上的一笔和 events；没有改动时什么都不追加
   */
  changeToolkit(projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged;
  /** 同 changeToolkit，但不追加：给出要追加的事件（卡片动作和卡片更新同一事务追加） */
  buildToolkitChange(projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged & { events: NewEvent[] };
  /** 往维护者会话发消息：项目维护者的会话给出所属的项目；已归档的只读、删掉的没有了（抛出原因）；不是项目的返回 undefined */
  conversationScope(conversation: ConversationId, taskId?: string): MessageScope | undefined;
  /** 发起任务时说的项目要在项目列表里（不在的抛 UnknownProjects）、没有归档：返回它们的编号 */
  checkTaskProjects(names: readonly string[]): string[];
  /**
   * 项目内部任务（64 号票）在这个项目里能不能发起：项目要在项目列表里、立项书已确认、没归档；能的话给出名字和维护者，
   * 不能的抛 RequestRejected 说明原因（还在立项的："项目「X」还在立项，确认立项书后再发起"）。
   * firstBuild：项目的首个建设任务，它在确认立项书的那一刻建出，不要立项书已确认（项目还没建过首个建设任务的才算）
   */
  internalHost(projectId: string, opts?: { firstBuild?: boolean }): { id: string; name: string; maintainerId: string };
  /** 项目名按现在的项目列表认成编号（没有的不算）：计划里写的涉及的项目用 */
  projectIdsOf(names: readonly string[]): string[];
  /**
   * 一个任务做完了（13 号票的任务完成回调，daemon.ts 接上；转为项目结束的不算）：是哪个建设中项目的首个建设任务，
   * 项目就进入使用中
   */
  taskCompleted(task: Task): void;
  /** 开始：建好各项目的档案，接上立项书确认、删除的二次确认；停着的时候首个建设任务做完了的补上 */
  start(): void;
  stop(): Promise<void>;
}

export interface ProjectServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: TaskService;
  /** 删除项目时改写属于它的事件（彻底删除的改写函数表） */
  rewriters: PurgeRewriters;
  /** 删除项目时先停维护者（项目维护者模块，daemon.ts 里接上） */
  maintainers: MaintainerSuspension;
  /** 删除项目时随项目彻底删除的素材：这个项目的内部任务由系统记下的记录（66 号票，daemon.ts 里接上素材库） */
  internalRecords?: (projectId: string) => readonly Material[];
  /**
   * 派单器（16 号票，daemon.ts 里接上）：首个建设任务派一张起草计划的工单给项目的维护者；重置维护者；
   * 维护者会话里的消息属于当前这一段（项目，做工单时还有任务）；项目还没结束的工单（有就不能归档）
   */
  workOrders?: {
    dispatchPlan(task: Task, instructions: string, key: string): NewEvent[] | undefined;
    reset(project: Project, key: string): { segmentId: string };
    scopeOf(maintainerId: string): MessageScope | undefined;
    openOf(projectId: string): WorkOrder[];
  };
  now: () => string;
  /** 数据目录的项目区（真实路径） */
  projectsDir: string;
  /** 数据目录和程序目录（真实路径）：外部工作目录不能在它们里面，也不能包含它们 */
  dataDir: string;
  programDir: string;
  log: (line: string) => void;
}

/** 工具包怎么改的（27 号票）：谁改的、为什么（时间线上的那一笔）、同一事务追加的别的事件 */
export interface ToolkitChange {
  by: TaskActor;
  /** 时间线上那一笔的说法开头："你在项目页改了工具包"、"维护者加了 skill" */
  why: string;
  idempotencyKey?: string;
  events?: NewEvent[];
}

/** 改完工具包：改之后的项目、改之前和之后的工具包、有没有改动 */
export interface ToolkitChanged {
  project: Project;
  before: PlanToolkit;
  after: PlanToolkit;
  changed: boolean;
}

/** 秘书收到的通知：用户点"新建项目"了，直接出建议立项卡 */
function newProjectNotice(text: string): string {
  return `用户点「新建项目」要立项：${text}\n不用判断这是不是项目：直接用 ${SUGGEST_PROJECT_TOOL} 出一张建议立项卡（名字、一句话目标），用户点“立项”后项目就诞生，维护者接着和用户做立项问答。`;
}

const projectEvent = (project: Project, change: ProjectChange, from: ProjectState | null, by: TaskActor): NewEvent => {
  const payload: ProjectEventPayload = { project, change, from, by };
  return { channel: CHANNELS.projects, type: EVENT_TYPES.project, payload };
};

/** 维护者会话里的一条说明（给用户看，不交给维护者处理） */
const maintainerNote = (project: Project, text: string, key: string): NewEvent =>
  buildMessage({ conversation: maintainerChannel(project.maintainerId), speaker: "system", parts: [{ type: "text", text }] }, { projectId: project.id, idempotencyKey: key }).event;

/** Windows 的绝对路径（盘符或 UNC 开头） */
const isWindowsAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\");

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const { store, cards, inbox, tasks, now, log } = options;
  const unsubscribes: Array<() => void> = [];
  const deleting = new Set<string>();
  const pending = new Set<Promise<void>>();

  const records = (projectId: string) => projectRecordsPaths(options.projectsDir, projectId);

  const mustGet = (projectId: string): Project => {
    const row = getProjectRow(store.reader, projectId);
    if (!row) throw new RequestRejected("not_found", `没有编号为 ${projectId} 的项目`);
    if (row.deleted) throw new RequestRejected("not_found", `项目 ${projectId}「${row.project.name}」已经删除了`);
    return row.project;
  };

  /** 新项目（还没追加）：编号接着已有的（删掉的也算），名字不能和没删掉的项目重 */
  const newProject = (input: { name: string; goal: string; origin: Project["origin"]; maintainerId?: string; fromTaskId?: string }): Project => {
    const name = oneLine(input.name, PROJECT_NAME_MAX);
    if (!name) throw new RequestRejected("bad_params", "项目名是空的");
    if (projectNamed(store.reader, name)) throw new RequestRejected("conflict", `已经有叫「${name}」的项目了：换个名字`);
    const n = countProjects(store.reader) + 1;
    const time = now();
    return {
      id: `p-${n}`,
      name,
      goal: oneLine(input.goal, PROJECT_GOAL_MAX),
      state: "preparing",
      origin: input.origin,
      maintainerId: input.maintainerId ?? `pm-${n}`,
      ...(input.fromTaskId === undefined ? {} : { fromTaskId: input.fromTaskId }),
      workdir: { external: false },
      charterConfirmed: false,
      createdAt: time,
      updatedAt: time,
    };
  };

  /** 项目改了以后的样子 */
  const patched = (project: Project, patch: Partial<Project>): Project => ({ ...project, ...patch, updatedAt: now() });

  /**
   * 首个建设任务（规划中，这个项目的内部任务，由项目的维护者执行，64 号票）；要做到什么程度看项目档案里的立项书。
   * 它在确认立项书的那一刻建出（这时项目列表里还没记下确认）：项目内部任务要立项书已确认，只有它例外（origin 是 project_build）。
   * 16 号票：同一事务派一张起草计划的工单给项目的维护者（维护者正忙时排队）
   */
  const buildTask = (project: Project, key: string): { task: Task; events: NewEvent[] } => {
    const built = tasks.buildInternal(
      {
        projectId: project.id,
        title: `建设「${project.name}」首版`,
        summary: `项目「${project.name}」的首个建设任务：首版要做到什么程度见项目档案里的立项书`,
        kind: "long_running",
        origin: "project_build",
      },
      "user",
    );
    const brief = {
      goal: `把项目「${project.name}」的首版做出来：做到什么程度、范围、不做什么，见项目档案里的立项书（${records(project.id).charter}）`,
      acceptanceCriteria: ["立项书里“首版”写的都做到"],
      constraints: [],
      projects: [project.name],
      memoryScope: "",
    };
    const dispatched = options.workOrders?.dispatchPlan(built.task, briefText(built.task, brief, 1, tasks.globalWatchCategories()), `${key}#build`) ?? [];
    return { task: built.task, events: [...built.events, ...dispatched] };
  };

  /** 待我处理里还没处理的"删除项目"二次确认 */
  const pendingDeleteItems = (projectId: string): NoticeInboxItem[] =>
    inbox
      .list()
      .filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === "project_delete" && item.handled === undefined && !item.archived)
      .filter((item) => inboxItemProjectId(item) === projectId);

  /** 确认删除之后（deletion.ts）：同一个项目同时只删一次 */
  const confirmDeletion = (projectId: string) => {
    if (deleting.has(projectId)) return;
    deleting.add(projectId);
    const job = deleteProject(
      {
        store,
        cards,
        rewriters: options.rewriters,
        maintainers: options.maintainers,
        records,
        deletedEvent: (project) => projectEvent(patched(project, {}), "deleted", "archived", "user"),
        ...(options.internalRecords ? { internalRecords: options.internalRecords } : {}),
        now,
        log,
      },
      projectId,
    )
      .catch((err: unknown) => log(`删除项目 ${projectId} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
      .finally(() => {
        deleting.delete(projectId);
        pending.delete(job);
      });
    pending.add(job);
  };

  /** 首个建设任务完成：项目自动从建设中进入使用中（不出卡、不等用户判定） */
  const taskCompleted = (task: Task) => {
    if (task.state !== "done" || task.endKind !== undefined) return;
    for (const project of listProjects(store.reader)) {
      if (project.buildTaskId !== task.id || project.state !== "building") continue;
      store.append(projectEvent(patched(project, { state: "in_use" }), "in_use", "building", "system"));
    }
  };

  /** 立项书确认后写进项目档案（立项书、绑定关系），建好工作目录（开发类的默认工作目录初始化成 git 仓库） */
  const onCharterDecided = (p: CharterDecidedPayload) => {
    const project = getProjectRow(store.reader, p.projectId)?.project;
    if (!project) return;
    try {
      writeConfirmedCharter(records(project.id), project, p.charter, p.toolkit, { decision: p.decision, at: p.time, workdir: projectWorkdir(records(project.id), project) });
    } catch (err) {
      log(`把项目 ${project.id} 的立项书写进项目档案时出错：${err instanceof Error ? err.message : String(err)}`);
    }
    prepareWorkdir(project);
  };

  /**
   * 工作目录建好；开发类的、用二狗给的默认工作目录的，初始化成 git 仓库（子 agent 并行时各用一个 git worktree）。
   * 用户绑定的外部目录不动：不是 git 仓库的，并行时拒绝并说明怎么办
   */
  const prepareWorkdir = (project: Project) => {
    const dir = projectWorkdir(records(project.id), project);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (project.kind !== "dev" || project.workdir.external || fs.existsSync(path.join(dir, ".git"))) return;
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", windowsHide: true });
    } catch (err) {
      log(`建项目 ${project.id} 的工作目录（开发类初始化 git 仓库）出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 某个维护者维护的、没删掉的项目 */
  const maintainedBy = (maintainerId: string): Project | undefined => {
    const found = projectOfMaintainer(store.reader, maintainerId);
    return found && !found.deleted ? found.project : undefined;
  };

  const ensureRecords = (project: Project) => {
    try {
      ensureProjectRecords(records(project.id), project);
    } catch (err) {
      log(`建项目 ${project.id} 的档案出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 外部工作目录：绝对路径。按真实路径（展开符号链接、目录联接和 8.3 短名）比，两个方向都拒：它在二狗的数据目录、
   * 程序目录里，或者数据目录、程序目录在它里面（围栏会盖住它们）
   */
  const checkedExternalPath = (raw: string | undefined): string => {
    const value = raw?.trim() ?? "";
    if (!value) throw new RequestRejected("bad_params", "绑定外部工作目录要写路径（externalPath，绝对路径）");
    if (!isWindowsAbsolute(value)) throw new RequestRejected("bad_params", `外部工作目录要写绝对路径（比如 D:\\code\\ledger），不是「${value}」`);
    const resolved = path.resolve(value);
    const candidates = [resolved, realPathOf(resolved) ?? resolved];
    for (const [what, dir] of [
      ["数据目录", options.dataDir],
      ["程序目录", options.programDir],
    ] as const) {
      const dirs = [dir, realPathOf(dir) ?? dir];
      const clash = candidates.some((c) => dirs.some((d) => isWithin(c, d) || isWithin(d, c)));
      if (clash) throw new RequestRejected("bad_params", `外部工作目录不能在二狗的${what}里，也不能包含它：${resolved}`);
    }
    return resolved;
  };

  const buildToolkitChange = (projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged & { events: NewEvent[] } => {
    const project = mustGet(projectId);
    if (!project.charterConfirmed) throw new RequestRejected("not_allowed", `项目「${project.name}」的立项书还没确认：确认立项书之后才有工具包`);
    if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${project.name}」已归档，不能改工具包：先在项目页上取消归档`);
    const before = projectToolkit(project);
    const after: PlanToolkit = { skills: [...new Set(toolkit.skills)], mcp: [...new Set(toolkit.mcp)], bash: toolkit.bash, network: toolkit.network, ...tellSecretaryField(canTellSecretary(toolkit)) };
    if (sameToolkit(before, after)) return { project, before, after: before, changed: false, events: [] };
    const next = patched(project, { toolkit: after });
    const record = buildTimelineRecord(maintainerChannel(project.maintainerId), { kind: "toolkit", summary: `${change.why}：${toolkitChangeText(before, after)}` }, { projectId: project.id });
    const events: NewEvent[] = [
      ...(change.events ?? []),
      { ...projectEvent(next, "toolkit_changed", project.state, change.by), ...(change.idempotencyKey === undefined ? {} : { idempotencyKey: change.idempotencyKey }) },
      record.event,
    ];
    return { project: next, before, after, changed: true, events };
  };

  /** 项目名认成没删掉的项目 */
  const named = (names: readonly string[]) => names.map((name) => ({ name, project: projectNamed(store.reader, name) }));

  return {
    get: (projectId) => {
      const row = getProjectRow(store.reader, projectId);
      return row && !row.deleted ? row.project : undefined;
    },
    list: () => listProjects(store.reader),
    ofMaintainer: (maintainerId) => projectOfMaintainer(store.reader, maintainerId),
    records,
    workdir: (project) => projectWorkdir(records(project.id), project),

    kickoffFromCard(payload, idempotencyKey) {
      const project = newProject({ name: payload.name, goal: payload.goal, origin: "suggestion" });
      const note = maintainerNote(
        project,
        `项目「${project.name}」立项了（筹备中）：${project.goal}\n维护者 ${project.maintainerId} 会和你做立项问答：把规格、术语表、决策记录写进项目档案，最后交出立项书。在这里说话就能叫醒它。`,
        `${idempotencyKey}#note`,
      );
      const notice = buildAgentNotice(
        CHANNELS.secretary,
        `用户在建议立项卡上点了「立项」：项目 ${project.id}「${project.name}」已诞生（筹备中），维护者 ${project.maintainerId} 会在它的会话里和用户做立项问答（项目页上的“和维护者交流”）。立项问答不归你，不用转述。`,
        `${idempotencyKey}#notice`,
      );
      return {
        status: "handled",
        payload: { ...payload, projectId: project.id },
        events: [projectEvent(project, "created", null, "user"), note, notice.event],
      };
    },

    newProject(params, idempotencyKey) {
      const text = params.request.trim();
      if (!text) throw new RequestRejected("bad_params", "想立个什么项目是空的");
      const { event } = store.append(buildAgentNotice(CHANNELS.secretary, newProjectNotice(text), idempotencyKey).event);
      const message = (event.payload as Partial<MessageEventPayload>).message;
      if (event.type !== EVENT_TYPES.message || !message) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
      return { messageId: message.id };
    },

    convertTask(params, idempotencyKey) {
      // 同一个幂等键重发：拿到第一次转出的项目
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) {
        const converted = listProjects(store.reader).find((p) => p.fromTaskId === params.taskId);
        if (converted) return { projectId: converted.id };
      }
      const task = tasks.get(params.taskId);
      if (!task) throw new RequestRejected("not_found", `没有编号为 ${params.taskId} 的任务`);
      if (projectOfMaintainer(store.reader, task.maintainerId)) throw new RequestRejected("not_allowed", `任务 ${task.id} 的维护者已经是一个项目的维护者了，不能再转为项目`);
      const ended = tasks.buildConvertToProject(task.id);
      const goal = tasks.brief(task.id)?.brief.goal ?? task.summary;
      const project = newProject({ name: params.name, goal, origin: "task", maintainerId: task.maintainerId, fromTaskId: task.id });
      const notice = buildAgentNotice(
        maintainerChannel(project.maintainerId),
        [
          `任务 ${task.id}「${task.title}」已由用户转为项目 ${project.id}「${project.name}」（筹备中），原任务以“已完成 · 已转为项目”结束。`,
          `你现在是这个项目的维护者：接着和用户做立项问答（一次问一两个问题），把规格、术语表、决策记录写进项目档案（${records(project.id).root}），`,
          `问清范围、目标、首版要做到什么程度、项目类型（开发类还是其他）、要不要把工作目录绑定到一个外部路径之后，用 ${SUBMIT_CHARTER_TOOL} 交出立项书和你提议的工具包。`,
        ].join("\n"),
        `${idempotencyKey}#notice`,
        { projectId: project.id },
      );
      store.appendBatch([{ ...ended.event, idempotencyKey }, projectEvent(project, "created", null, "user"), notice.event]);
      return { projectId: project.id };
    },

    submitCharter(projectId, maintainerId, submission) {
      const project = mustGet(projectId);
      if (project.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `项目 ${projectId} 不是你维护的，只有它的维护者能交立项书`);
      if (project.state !== "preparing") throw new RequestRejected("not_allowed", `项目「${project.name}」现在是${PROJECT_STATE_LABEL[project.state]}，只有筹备中的项目能交立项书`);
      if (project.charterConfirmed) throw new RequestRejected("not_allowed", `项目「${project.name}」的立项书已经确认了，不能再交`);
      const { charter } = submission;
      if (charter.bindExternal && charter.kind !== "dev") throw new RequestRejected("bad_params", "只有开发类项目能把工作目录绑定到外部路径");
      const normalized: Charter = charter.bindExternal
        ? { ...charter, externalPath: checkedExternalPath(charter.externalPath) }
        : { goal: charter.goal, scope: charter.scope, firstVersion: charter.firstVersion, kind: charter.kind, bindExternal: false };
      // 开发类项目提议的工具包默认带 bash（规格第 9、21 节）
      const toolkit: PlanToolkit = {
        skills: [...(submission.toolkit?.skills ?? [])],
        mcp: [...(submission.toolkit?.mcp ?? [])],
        bash: submission.toolkit?.bash ?? charter.kind === "dev",
        network: submission.toolkit?.network ?? false,
      };
      const previous = latestCharter(store.reader, projectId);
      const revision = (previous?.revision ?? 0) + 1;
      const card = cards.buildCreate({
        type: "charter",
        urgency: "non_blocking",
        payload: { projectId, projectName: project.name, revision, charter: normalized, toolkit } satisfies CharterCardPayload,
      });
      const events: NewEvent[] = [];
      // 上一版还没确认的立项书卡过期：用户确认的总是最新的一版
      const old = previous && cards.get(previous.cardId);
      if (old?.status === "pending") events.push(cards.buildUpdate(old.id, { status: "expired" }).event);
      const submitted: CharterSubmittedPayload = { projectId, revision, charter: normalized, toolkit, cardId: card.card.id, maintainerId, time: now() };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`立项书等你确认：${project.name}`, 60), source: `项目「${project.name}」`, origin: { projectId }, urgency: "non_blocking" });
      events.push(
        { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.submitted, payload: submitted },
        card.event,
        projectEvent(patched(project, { charterCardId: card.card.id }), "charter_submitted", project.state, "maintainer"),
        item.event,
      );
      store.appendBatch(events);
      inbox.alert(item.item);
      return { cardId: card.card.id, revision, toolkit };
    },

    confirmCharter(payload, decision, note, idempotencyKey) {
      const project = mustGet(payload.projectId);
      const latest = latestCharter(store.reader, project.id);
      if (!latest || latest.revision !== payload.revision) throw new RequestRejected("conflict", "这版立项书已经被新的一版取代了：看最新的那张立项书卡");
      if (project.charterConfirmed || project.state !== "preparing") {
        throw new RequestRejected("conflict", `项目「${project.name}」现在是${PROJECT_STATE_LABEL[project.state]}${project.charterConfirmed ? "，立项书已经确认过了" : ""}`);
      }
      const { charter, toolkit } = latest;
      const start = decision === "start";
      // 项目类型、外部工作目录绑定、工具包在确认时就生效
      const workdir = charter.bindExternal && charter.externalPath ? { external: true, path: charter.externalPath } : { external: false };
      let next = patched(project, { kind: charter.kind, workdir, toolkit, charterConfirmed: true });
      const events: NewEvent[] = [];
      let buildTaskId: string | undefined;
      if (start) {
        const built = buildTask(next, idempotencyKey);
        buildTaskId = built.task.id;
        next = { ...next, state: "building", buildTaskId };
        events.push(...built.events);
      }
      const decided: CharterDecidedPayload = {
        projectId: project.id,
        projectName: project.name,
        revision: latest.revision,
        cardId: latest.cardId,
        decision,
        charter,
        toolkit,
        ...(buildTaskId === undefined ? {} : { buildTaskId }),
        ...(note?.trim() ? { note: note.trim() } : {}),
        by: "user",
        time: now(),
      };
      const where = workdir.external ? `外部路径 ${workdir.path}` : "项目档案里的 workdir";
      const text = `立项书已确认（${CHARTER_DECISION_LABEL[decision]}）：${PROJECT_KIND_LABEL[charter.kind]}项目，工作目录是${where}，${toolkitBashWording(toolkit.bash)}。${buildTaskId ? `首个建设任务 ${buildTaskId} 已建出（规划中）。` : ""}`;
      events.push(
        { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.decided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` },
        projectEvent(next, start ? "building_started" : "charter_confirmed", project.state, "user"),
        maintainerNote(next, text, `${idempotencyKey}#note`),
      );
      return {
        status: "handled",
        payload: { ...payload, confirmed: { start, ...(buildTaskId === undefined ? {} : { buildTaskId }) } },
        note: start ? `首个建设任务 ${buildTaskId}` : "稍后开工",
        events,
      };
    },

    act(params, idempotencyKey) {
      const project = mustGet(params.projectId);
      // 同一个幂等键重发：不再做一次
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) return { projectId: project.id, state: project.state, ...confirmItem(done.payload) };
      const buildState = project.buildTaskId === undefined ? undefined : tasks.get(project.buildTaskId)?.state;
      if (!projectActions(project, buildState).includes(params.action)) throw new RequestRejected("not_allowed", projectActionRefusal(project, params.action));
      // 还有正在做或排队的工单：不能归档（16 号票评审后用户定），说明先完成或取消哪几个任务
      const open = ARCHIVING_ACTIONS.includes(params.action) ? (options.workOrders?.openOf(project.id) ?? []) : [];
      if (open.length > 0) throw new RequestRejected("not_allowed", archiveBlockedText(open));
      const target = projectActionTarget(project, params.action);
      if (!target) {
        // 删除：不马上删，在待我处理里放一条二次确认（同一个项目已有没处理的就用它）
        const existing = pendingDeleteItems(project.id)[0];
        if (existing) return { projectId: project.id, state: project.state, confirmItemId: existing.id };
        const item = inbox.buildAdd({
          kind: "notice",
          notice: "project_delete",
          title: oneLine(`删除项目「${project.name}」？`, 60),
          // 删不掉的如实写上（66 号票）
          body: `项目档案、维护者会话、立项书和项目内部任务（连同记忆里由它们自动记下的记录）都会删掉，${ASSISTANT_NAME_MARK}和跨项目任务读过的这个项目的内容一起抹掉，不可恢复；你本人在维护者会话里说过的话作为素材保留（原文副本不受影响）。${project.workdir.external ? `外部工作目录 ${project.workdir.path} 不动。` : ""}${PROJECT_DELETE_LIMITS}`,
          source: `项目「${project.name}」`,
          origin: { projectId: project.id },
          urgency: "non_blocking",
          actions: [PROJECT_DELETE_CONFIRM, PROJECT_DELETE_CANCEL],
          data: { projectId: project.id },
        });
        store.append({ ...item.event, idempotencyKey });
        return { projectId: project.id, state: project.state, confirmItemId: item.item.id };
      }
      const { archivedFrom: _from, ...rest } = project;
      let next = patched({ ...rest, ...(target.archivedFrom === undefined ? {} : { archivedFrom: target.archivedFrom }) }, { state: target.state });
      const events: NewEvent[] = [];
      if (params.action === "start_build") {
        // 开工：建出首个建设任务（失败或取消了再开工的，新任务接替它）
        const built = buildTask(project, idempotencyKey);
        next = { ...next, buildTaskId: built.task.id };
        events.push(...built.events);
      }
      events.push({ ...projectEvent(next, target.change, project.state, "user"), idempotencyKey });
      // 取消归档：还没处理的删除确认收进归档（不再是"待处理"）
      if (params.action === "unarchive") for (const item of pendingDeleteItems(project.id)) events.push(inbox.buildUpdate(item, { archived: true }).event);
      store.appendBatch(events);
      return { projectId: project.id, state: next.state };
    },

    maintainedBy,

    buildToolkitChange,

    changeToolkit(projectId, toolkit, change) {
      const { events, ...result } = buildToolkitChange(projectId, toolkit, change);
      if (events.length > 0) store.appendBatch(events);
      return result;
    },

    projectOf(task) {
      return hasOwnMaintainer(task) ? undefined : maintainedBy(task.maintainerId);
    },

    writeProgress(projectId, text) {
      const paths = records(projectId);
      if (fs.existsSync(paths.progress)) preservePaths(paths, [paths.progress], now());
      fs.writeFileSync(paths.progress, text.endsWith("\n") ? text : `${text}\n`);
    },

    resetMaintainer(projectId, idempotencyKey) {
      const project = mustGet(projectId);
      if (!canResetMaintainer(project)) throw new RequestRejected("not_allowed", `项目「${project.name}」已归档：维护者会话只读，不能重置。要重置先在项目页上取消归档`);
      if (!options.workOrders) throw new RequestRejected("not_implemented", "这个版本还不能重置维护者");
      return { projectId: project.id, ...options.workOrders.reset(project, idempotencyKey) };
    },

    conversationScope(conversation, taskId) {
      if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
      const found = projectOfMaintainer(store.reader, conversation.slice(MAINTAINER_CHANNEL_PREFIX.length));
      if (!found) return undefined;
      const { project, deleted } = found;
      if (deleted) throw new RequestRejected("not_found", `项目「${project.name}」已经删除了，维护者会话也删掉了`);
      if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${project.name}」已归档：维护者会话只读。要接着和维护者说话，先在项目页上取消归档`);
      // 在这个项目内部的普通任务的详情里说的（75 号票）：消息属于这个任务（做完了接着说，它接着做），不看现在在哪一段
      const task = taskId === undefined ? undefined : options.tasks.get(taskId);
      if (task && isPlainTask(task) && isInternalTo(task, project.id)) {
        if (!availableTaskActions(task, "user").includes("message")) throw new RequestRejected("not_allowed", taskActRefusal(task, "message"));
        return { projectId: project.id, taskId: task.id };
      }
      // 消息属于当前这一段（16 号票）：做工单时还带上所属的任务
      return options.workOrders?.scopeOf(project.maintainerId) ?? { projectId: project.id };
    },

    checkTaskProjects(names) {
      return named(names).map(({ name, project }) => {
        if (!project) {
          const all = listProjects(store.reader).map((p) => p.name);
          throw new UnknownProjects(`项目列表里没有「${name}」${all.length > 0 ? `（现有：${all.join("、")}）` : "（现在还没有项目）"}`);
        }
        if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${name}」已归档，不能给它发起任务：先在项目页上取消归档`);
        return project.id;
      });
    },

    internalHost(projectId, opts = {}) {
      const row = getProjectRow(store.reader, projectId);
      if (!row || row.deleted) throw new RequestRejected("not_found", `没有这个项目：${projectId}`);
      const { project } = row;
      if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${project.name}」已归档，不能在里面发起任务：先在项目页上取消归档`);
      // 立项书确认之前不能在项目里发起任务（规格第 11 节）；只有首个建设任务例外：它在确认立项书的那一刻建出（还没建过的才算）
      const firstBuild = opts.firstBuild === true && project.buildTaskId === undefined;
      if (!project.charterConfirmed && !firstBuild) throw new RequestRejected("not_allowed", `项目「${project.name}」还在立项，确认立项书后再发起`);
      return { id: project.id, name: project.name, maintainerId: project.maintainerId };
    },

    projectIdsOf: (names) => named(names).flatMap(({ project }) => (project ? [project.id] : [])),

    taskCompleted,

    start() {
      for (const project of listProjects(store.reader)) ensureRecords(project);
      unsubscribes.push(
        store.onAppend((event) => {
          if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
            const { project, change } = event.payload as ProjectEventPayload;
            if (change === "created") ensureRecords(project);
          } else if (event.channel === CHARTERS_CHANNEL && event.type === CHARTER_EVENTS.decided) {
            onCharterDecided(event.payload as CharterDecidedPayload);
          }
        }),
        inbox.onNoticeHandled("project_delete", PROJECT_DELETE_CONFIRM, (item) => {
          const projectId = inboxItemProjectId(item);
          if (projectId !== undefined) confirmDeletion(projectId);
        }),
      );
      // 停着的时候首个建设任务完成了（追加了任务事件、还没来得及改项目）：补上
      for (const project of listProjects(store.reader)) {
        if (project.state !== "building" || project.buildTaskId === undefined) continue;
        const task = tasks.get(project.buildTaskId);
        if (task) taskCompleted(task);
      }
    },

    async stop() {
      for (const off of unsubscribes.splice(0)) off();
      await Promise.all(pending);
    },
  };
}

/** 删除的那次请求放进待我处理的二次确认（同一个幂等键重发时从事件里取） */
function confirmItem(payload: unknown): { confirmItemId?: string } {
  const item = (payload as { item?: { id?: string; kind?: string } }).item;
  return item?.kind === "notice" && typeof item.id === "string" ? { confirmItemId: item.id } : {};
}
