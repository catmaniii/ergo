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
// 建设任务做完（13 号票的任务完成回调 taskCompleted，daemon.ts 接上）：112 号票起（用户 2026-10-13 定：项目状态变更时找用户）
// 不再自动进入使用中，给用户一张"首版做完了"卡（build_done，cards.ts）——写明做成了什么（建设任务最后的总结、每个阶段的验收结果、
// 交付件在哪），用户选转入使用（进入使用中）、继续建设（项目留在建设中，按用户写的一句话建出下一轮建设任务、派起草计划的工单）
// 或放弃并归档（照项目页上的放弃）；不选就一直挂在待我处理里，项目停在建设中。项目页上放弃了的，没选的卡作废；
// 放弃之后取消归档回到建设中的，再出一张（建设任务已经做完了，不出卡就永远停在建设中）。
// 130 号票：维护者建设期间交了运营方案的（operations/），卡上带着它（buildDonePayload 取 pendingBuildPlan），主按钮是"确认并转入使用"：
// 转入使用的同一事务里方案里每一条生效（建成项目的内部任务），项目上记下现在生效的运营方案（同一条 in_use 的 project 事件）。
// 之后的任务、服务在不在线都不改项目状态。
// 删除只能从已归档发起：先在待我处理里放一条二次确认，用户选"确认删除"才删（deletion.ts，ADR-0010）。
// 16 号票：
// - 只涉及一个项目的任务由这个项目的维护者执行：projectOf(task) 是"任务属于哪个项目"唯一的一处；
// - 项目还有正在做或排队的工单时不能归档（放弃、归档都被拒，说明先完成或取消哪几个任务）；
// - 重置维护者（resetMaintainer）不改项目状态，不在状态机里；
// - 开发类项目用默认工作目录的，立项书确认时把工作目录初始化成 git 仓库（子 agent 并行要各用一个 git worktree）；
// - 起草计划的工单段里进展文档经 writeProgress 写回（整份重写前留旧版本，同守卫接入的自动留旧版本）。
// 27 号票：项目的工具包可以改（changeToolkit）：用户在项目页直接改、批准维护者提交的"工具包变更"卡、维护者自己增减 skill 或减少能力。
// 每次改是一条 toolkit_changed 的 project 事件，维护者会话的时间线上记一笔；项目维护者模块据此按新工具包重新装配。
// 258 号票（项目规范）：立项时项目记下建档用的规范模板版本（standardVersion），档案里的规格、进展、决策记录照模板生成；立项书确认成
// 开发类时补上架构图、tickets/、ops.json（standard.ts）。项目规范的只读视图（standard）给 GET /api/projects/<id>/standard。
// 261 号票（本项目的规范改写，standard-change.ts）：建档案、补文档时不要的那几份跳过；规范改写确认了（standard_changed）再对一遍档案，
// 恢复照默认的、跟新版规范的补上缺的；只读视图按改写算。
// 262 号票（现有项目补齐规范文档，standard-backfill.ts）：规范上线之前建的项目在"补齐规范文档"卡上选了补齐，项目列表频道上一条 standard_adopted
// （记下现在的规范版本），这里据此按这一版的模板补上缺的几份（已有的不动）。
// 259 号票（issue 19 第 3、8 条）：建设中 → 使用中只有一道门——用户在确认卡上确认（goLive）。用户在项目页点"转入使用"（act 的 go_live）、
// 维护者用 propose_go_live 提、秘书照用户说的代办（requestGoLive），都只出确认卡："首版做完了"卡、"转入使用"卡（go_live）还在等的
// 就用那一张（清单刷新），没有就出一张"转入使用"卡。卡上列建设中 → 使用中的检查清单（standard.ts 的 goLiveChecklist），没做到的
// 照样能确认，确认时按那时的再算一遍、缺的写进卡上的决定和维护者会话里的那句说明。确认了，别的还在等的转入使用确认卡作废。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ACCEPTANCE_VERDICT_LABEL,
  type AcceptanceMethod,
  ASSISTANT_NAME_MARK,
  BUILD_DONE_CHOICE_LABEL,
  type BuildDoneCardPayload,
  type BuildDoneChoice,
  buildDoneTitle,
  type Card,
  type Charter,
  type CharterCardPayload,
  CHARTER_DECISION_LABEL,
  type CharterDecision,
  CHANNELS,
  checklistMissing,
  type ConversationId,
  type ConvertTaskParams,
  type ConvertTaskResult,
  EVENT_TYPES,
  GO_LIVE_BY_LABEL,
  GO_LIVE_CHOICE_LABEL,
  type GoLiveBy,
  type GoLiveCardPayload,
  type GoLiveChecklistItem,
  type GoLiveChoice,
  goLiveTitle,
  type OperationResult,
  type OperationsPlanView,
  type InboxItem,
  inboxItemProjectId,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  type NewProjectParams,
  type NewProjectResult,
  type NoticeInboxItem,
  OPERATIONS_PUT_IN_USE_LABEL,
  type OperationsConfirmInput,
  type PlanToolkit,
  type Project,
  PROJECT_DELETE_CANCEL,
  PROJECT_DELETE_CONFIRM,
  PROJECT_DELETE_LIMITS,
  PROJECT_GOAL_MAX,
  PROJECT_KIND_LABEL,
  PROJECT_NAME_MAX,
  PROJECT_STANDARD_LATEST,
  PROJECT_STATE_LABEL,
  type ProjectStandardView,
  ARCHIVING_ACTIONS,
  archiveBlockedText,
  canResetMaintainer,
  type ProjectActionParams,
  type ProjectActionResult,
  projectActionRefusal,
  projectActions,
  projectActionTarget,
  type ProjectChange,
  type ProjectEventPayload,
  type ProjectState,
  PI_RUNTIME_ID,
  type RuntimeChoice,
  type RuntimeTakeover,
  type WorkFolderChoice,
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
  listStageCodes,
  PROJECT_ACTION_LABEL,
  STAGE_STATE_LABEL,
  taskActRefusal,
  canTellSecretary,
  tellSecretaryField,
  canSendAttachment,
  sendAttachmentField,
  t,
  forModel,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { isWithin } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Operations } from "../operations/index.ts";
import type { OpsGoLive } from "../project-ops/api.ts";
import { briefText, type TaskService } from "../tasks/tasks.ts";
import { realPathOf } from "../util/real-path.ts";
import { oneLine } from "../util/text.ts";
import { listPendingCards } from "../cards/views.ts";
import type { DeletionParticipants } from "../deletion/participants.ts";
import { deleteProject, type MaintainerSuspension } from "./deletion.ts";
import { CHARTER_EVENTS, CHARTERS_CHANNEL, type CharterDecidedPayload, type CharterSubmittedPayload } from "./events.ts";
import { createProjectDirectory } from "./directory.ts";
import { charterForWorkdir, ensureProjectRecords, preservePaths, type ProjectRecordsPaths, projectWorkdir, writeConfirmedCharter } from "./records.ts";
import { type ChecklistPlan, goLiveChecklist, projectStandardView } from "./standard.ts";
import { buildTaskNote, charterBuildText, kickoffNote, nextBuildNote, nextBuildText } from "./texts.ts";
import { SUBMIT_CHARTER_TOOL, SUGGEST_PROJECT_TOOL } from "./tool-names.ts";
import { countProjects, getProjectRow, latestCharter, listProjects, projectNamed, projectOfMaintainer, standardOverrides } from "./views.ts";

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
  /**
   * 项目规范现在的样子（258 号票，只读接口 GET /api/projects/<id>/standard）：模板版本、每份文档在不在和最近修改时间、
   * 当前状态的检查清单、本项目的规范改写。没有这个项目（删掉了的也是）是 undefined
   */
  standard(projectId: string): ProjectStandardView | undefined;
  /** "建议立项"卡上点了"立项" */
  kickoffFromCard(payload: SuggestProjectCardPayload, idempotencyKey: string): CardActionEffect<SuggestProjectCardPayload>;
  /** 点"新建项目"：给秘书一条通知，它直接收口出建议立项卡（289 号票：选了运行时的，通知里写明，秘书照写在卡上） */
  newProject(params: NewProjectParams, idempotencyKey: string): NewProjectResult;
  /**
   * 项目的维护者用的运行时、给它选的值改了（289 号票：⚙ 里换运行时换完了、改了选的值）：记一条 runtime_set（项目状态不变）。
   * pi 不写，选的值是空的不写；本来就是这样的不另记。没有的、删掉的项目抛 RequestRejected
   */
  setRuntime(projectId: string, runtime: string | undefined, runtimeOptions: RuntimeChoice | undefined): Project;
  /**
   * 从运行时已有的会话接管成项目（290 号票，接管服务 takeover/ 叫）：不经秘书、直接建出（筹备中，origin takeover），维护者用这个运行时、
   * 接着那个会话，工作目录是会话原来的（外部路径，删项目时不删）；名字和已有的重了加序号。extra 给出和项目一起追加的事件（前情消息）。
   * 不通知秘书、不自动开始：用户在项目的会话里说话时维护者才接着做。同一个幂等键重发拿到第一次建出的；运行时不能用的抛 RequestRejected
   */
  takeOver(input: { name: string; goal: string; runtime: string; workdir: string; takeover: RuntimeTakeover }, idempotencyKey: string, extra: (project: Project) => NewEvent[]): Project;
  /**
   * 交还、收回（290 号票）：改项目上记着的接管（记一条 takeover_set，项目状态不变）。没有的、不是接管来的抛 RequestRejected；
   * 292 号票：二狗自己开的会话（takeover.own）第一次交给官方 App 时没有也能记
   */
  setTakeover(projectId: string, takeover: RuntimeTakeover): Project;
  /** 任务转为项目 */
  convertTask(params: ConvertTaskParams, idempotencyKey: string): ConvertTaskResult;
  /** 维护者交出立项书（submit_charter 工具）：立项书卡放进待我处理；不让交时抛 RequestRejected，原因交回维护者 */
  /** fixedWorkdir：工作目录在立项之前就定在外面了（311 号票），立项书照它写成绑定了这个路径（交的绑不绑、哪条路径不算） */
  submitCharter(projectId: string, maintainerId: string, submission: CharterSubmission): { cardId: string; revision: number; toolkit: PlanToolkit; fixedWorkdir?: string };
  /** 立项书卡上的"确认并开工"（start）/"只确认，稍后开工"（later） */
  confirmCharter(payload: CharterCardPayload, decision: CharterDecision, note: string | undefined, idempotencyKey: string): CardActionEffect<CharterCardPayload>;
  /**
   * "首版做完了"卡（112 号票）上的选择：转入使用、继续建设（note 是用户写的那句这一轮要做什么，必填）、放弃并归档。
   * 项目已经不在建设中、又开工过了的，这张卡不再生效（conflict）
   */
  decideBuild(
    payload: BuildDoneCardPayload,
    choice: BuildDoneChoice,
    note: string | undefined,
    idempotencyKey: string,
    /** 卡上带着运营方案时（130 号票）：流程审查要你逐项确认的事项勾了哪些，和这张卡的编号 */
    operations?: { input: OperationsConfirmInput; cardId: string },
  ): CardActionEffect<BuildDoneCardPayload>;
  /** 项目页上的动作（259 号票：转入使用 go_live 只出确认卡，结果里是那张卡） */
  act(params: ProjectActionParams, idempotencyKey: string): ProjectActionResult;
  /**
   * 建设中 → 使用中的检查清单（259 号票）：项目现在的样子；plan 不给就用维护者建设期间交的那份运营方案。没有这个项目的是空的
   */
  goLiveChecklist(projectId: string, plan?: ChecklistPlan): GoLiveChecklistItem[];
  /**
   * 要转入使用（259 号票）：用户在项目页点的（act 的 go_live）、维护者提的、秘书代办的，都只出确认卡——"首版做完了"卡、"转入使用"卡
   * 还在等的就用那一张（卡上的清单刷新），没有就出一张"转入使用"卡（进待我处理，维护者会话里也有一张）。不是建设中的抛 RequestRejected
   */
  requestGoLive(projectId: string, request: GoLiveRequest): GoLiveRequested;
  /**
   * 还在等的转入使用确认卡上的检查清单照现在的刷新（268 号票：运营接口清单在后台验完了）：建设中、有卡在等、清单变了才更新卡；
   * 没有就什么都不做
   */
  refreshGoLiveChecklist(projectId: string): void;
  /** "转入使用"卡上的确认转入使用、先不转（卡片动作）；项目已经不在建设中的，这张卡不再生效（conflict） */
  decideGoLive(
    payload: GoLiveCardPayload,
    choice: GoLiveChoice,
    note: string | undefined,
    idempotencyKey: string,
    confirm?: { input: OperationsConfirmInput; cardId: string },
  ): CardActionEffect<GoLiveCardPayload>;
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
   * 一个任务做完了（13 号票的任务完成回调，daemon.ts 接上；转为项目结束的不算）：是哪个建设中项目现在的建设任务，
   * 就给用户一张"首版做完了"卡（112 号票；同一个建设任务只出一张）
   */
  taskCompleted(task: Task): void;
  /** 开始：建好各项目的档案，接上立项书确认、删除的二次确认；停着的时候建设任务做完了的补上"首版做完了"卡 */
  start(): void;
  stop(): Promise<void>;
}

/** 项目模块要的派单器的几样（16 号票；WorkOrders 就是它） */
export interface ProjectWorkOrders {
  dispatchPlan(task: Task, instructions: string, key: string): NewEvent[] | undefined;
  reset(project: Project, key: string): { segmentId: string };
  scopeOf(maintainerId: string): MessageScope | undefined;
  openOf(projectId: string): WorkOrder[];
}

/**
 * 新建项目时定工作文件夹（305 号票，work-folders/ 的 precheck、settle）：能选工作文件夹的运行时（Claude Code）才定——用已有的、
 * 或在默认文件夹下新开；不能选的、没设默认又没选已有的照旧（undefined）。路径不对抛 RequestRejected
 */
export interface ProjectWorkFolder {
  precheck(runtime: string | undefined, choice: WorkFolderChoice | undefined): void;
  settle(runtime: string | undefined, choice: WorkFolderChoice | undefined, title: string): string | undefined;
}

export interface ProjectServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: TaskService;
  /** 删除项目时改写属于它的事件："删除参与方"登记表（279 号票：拥有属于项目的事件的模块各自登记，deletion.ts） */
  deletion: Pick<DeletionParticipants, "plan">;
  /** 删除项目时先停维护者（项目维护者模块，建在项目模块之后，删除时现取；127 号票起直接给它，不再一样样转手） */
  maintainers: () => MaintainerSuspension;
  /**
   * 派单器（16 号票，建在项目模块之后，用到时现取；127 号票起直接给它，不再一样样转手）：首个建设任务派一张起草计划的工单给项目的维护者
   * （dispatchPlan）；重置维护者（reset）；维护者会话里的消息属于当前这一段（scopeOf：项目，做工单时还有任务）；项目还没结束的工单
   * （openOf：有就不能归档）
   */
  workOrders?: () => ProjectWorkOrders;
  /**
   * 运营方案（130 号票，运营方案模块建在项目模块之后，用到时现取）："首版做完了"卡上带的维护者建设期间交的那一份（pendingBuildPlan）、
   * 卡上确认并转入使用时方案里每一条生效（putInUse）。不给就没有运营方案（卡照 112 号票）
   */
  operations?: () => Pick<Operations, "pendingBuildPlan" | "putInUse">;
  /**
   * 运营接口清单的验收和登记（268 号票，建在项目模块之后，用到时现取）：转运营检查清单里 ops 那一项照 112 号票的自动验收
   * （checklistItem：没验过的在后台开验，验完了经 refreshGoLiveChecklist 刷新还在等的卡）；转入使用时登记验收全过的那份（goLiveEvents，
   * 和转入使用同一事务）。不给就只查最基本的几样、不登记。280 号票起是运营层交的（经它的入口 project-ops/api.ts）
   */
  projectOps?: () => Pick<OpsGoLive, "checklistItem" | "goLiveEvents">;
  /** 点"新建项目"时选的运行时现在能不能用（289 号票）：不能用的原因，能用是 undefined；不给就不查 */
  runtimeRefusal?: (runtime: string) => string | undefined;
  /** 新建时定工作文件夹（305 号票，work-folders/）：点"新建项目"时先核对，点"立项"时定下；不给就都照旧（工作目录在项目档案里） */
  workFolder?: ProjectWorkFolder;
  now: () => string;
  /** 数据目录的项目区（真实路径） */
  projectsDir: string;
  /** 数据目录和程序目录（真实路径）：外部工作目录不能在它们里面，也不能包含它们 */
  dataDir: string;
  programDir: string;
  log: (line: string) => void;
}

/** 要转入使用（259 号票）：谁发起的、为什么（维护者、秘书写的；用户自己点的没有）、幂等键 */
export interface GoLiveRequest {
  by: GoLiveBy;
  why?: string;
  key: string;
}

/** 要转入使用之后：要用户确认的那张卡（新出的"转入使用"卡，或者还在等的那张）、它现在的检查清单 */
export interface GoLiveRequested {
  cardId: string;
  cardType: "go_live" | "build_done";
  created: boolean;
  checklist: GoLiveChecklistItem[];
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

/** 秘书收到的通知：用户点"新建项目"了，直接出建议立项卡（289 号票：选了运行时的写明，卡上照写；305 号票：选了文件夹的也写明） */
function newProjectNotice(text: string, runtime: string | undefined, folder: WorkFolderChoice | undefined): string {
  // @i18n-ignore-next model
  const choose = runtime === undefined ? "" : `用户选了维护者用的运行时 ${runtime}：出卡时 runtime 写 ${runtime}。`;
  const where =
    runtime === undefined || folder === undefined
      ? ""
      : folder.kind === "existing"
        ? `用户选了在已有的文件夹里做：出卡时 folder 原样写 ${JSON.stringify(folder.path)}。` // @i18n-ignore model
        : folder.name === undefined
          ? ""
          : `用户要在默认文件夹下新开一个叫 ${JSON.stringify(folder.name)} 的子文件夹：出卡时 folderName 原样写它。`; // @i18n-ignore model
  // @i18n-ignore-next model
  return `用户点「新建项目」要立项：${text}\n不用判断这是不是项目：直接用 ${SUGGEST_PROJECT_TOOL} 出一张建议立项卡（名字、一句话目标），用户点“立项”后项目就诞生，维护者接着和用户做立项问答。${choose}${where}`;
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

  // 只读的那几样（按编号、按维护者、按任务、按名字找，项目档案在哪）在项目列表的只读视图里（278 号票：任务模块建在项目系统之前也能用）
  const directory = createProjectDirectory({ store, projectsDir: options.projectsDir });
  const { records, maintainedBy } = directory;

  const mustGet = (projectId: string): Project => {
    const row = getProjectRow(store.reader, projectId);
    if (!row) throw new RequestRejected("not_found", t("projects.errors.noProject", { id: projectId }));
    if (row.deleted) throw new RequestRejected("not_found", t("projects.errors.deleted", { id: projectId, name: row.project.name }));
    return row.project;
  };

  /** 新项目（还没追加）：编号接着已有的（删掉的也算），名字不能和没删掉的项目重 */
  const newProject = (input: {
    name: string;
    goal: string;
    origin: Project["origin"];
    maintainerId?: string;
    fromTaskId?: string;
    runtime?: string;
    /** 工作目录在外面（外部路径；删项目时不删，立项书确认时不改）：290 号票接管来的是会话原来的，305 号票是新建时选的文件夹 */
    workdir?: string;
    /** 接管来的（290 号票）：接管的会话 */
    takeover?: RuntimeTakeover;
  }): Project => {
    const name = oneLine(input.name, PROJECT_NAME_MAX);
    if (!name) throw new RequestRejected("bad_params", t("projects.errors.emptyName"));
    if (projectNamed(store.reader, name)) throw new RequestRejected("conflict", t("projects.errors.nameTaken", { name }));
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
      // 289 号票：建议立项卡上写的运行时（pi 不写）
      ...(input.runtime === undefined || input.runtime === PI_RUNTIME_ID ? {} : { runtime: input.runtime }),
      // 290 号票：接管来的工作目录是会话原来的；305 号票：新建时选的文件夹（外部路径：删项目时不删，立项书确认时不改）
      workdir: input.workdir !== undefined ? { external: true, path: input.workdir } : { external: false },
      ...(input.takeover ? { takeover: { ...input.takeover } } : {}),
      charterConfirmed: false,
      // 258 号票：建档用的规范模板版本（之后不变；模板升级只提示，261 号票）
      standardVersion: PROJECT_STANDARD_LATEST,
      createdAt: time,
      updatedAt: time,
    };
  };

  /** 项目改了以后的样子 */
  const patched = (project: Project, patch: Partial<Project>): Project => ({ ...project, ...patch, updatedAt: now() });

  /**
   * 首个建设任务（规划中，这个项目的内部任务，由项目的维护者执行，64 号票）；要做到什么程度看项目档案里的立项书。
   * 它在确认立项书的那一刻建出（这时项目列表里还没记下确认）：项目内部任务要立项书已确认，只有它例外（origin 是 project_build）。
   * 16 号票：同一事务派一张起草计划的工单给项目的维护者（维护者正忙时排队）。
   * 112 号票：用户在"首版做完了"卡上选继续建设时建出下一轮（next：第几轮、用户写的那句话、上一轮做完的那张卡），任务书照那句话写
   */
  const buildTask = (project: Project, key: string, next?: { round: number; request: string; previous: BuildDoneCardPayload }): { task: Task; events: NewEvent[] } => {
    const built = tasks.buildInternal(
      {
        projectId: project.id,
        title: next ? t("projects.build.titleRound", { name: project.name, round: next.round }) : t("projects.build.titleFirst", { name: project.name }),
        summary: next ? oneLine(next.request, 200) : t("projects.build.summaryFirst", { name: project.name }),
        kind: "long_running",
        origin: "project_build",
      },
      "user",
    );
    const brief = next
      ? {
          goal: t("projects.build.goalRound", {
            name: project.name,
            round: next.round,
            request: next.request,
            previousId: next.previous.buildTaskId,
            previousTitle: next.previous.buildTaskTitle,
            charter: records(project.id).charter,
          }),
          acceptanceCriteria: [t("projects.build.acceptanceRound", { request: next.request })],
          constraints: [],
          projects: [project.name],
          memoryScope: "",
        }
      : {
          goal: t("projects.build.goalFirst", { name: project.name, charter: records(project.id).charter }),
          acceptanceCriteria: [t("projects.build.acceptanceFirst")],
          constraints: [],
          projects: [project.name],
          memoryScope: "",
        };
    const dispatched = options.workOrders?.().dispatchPlan(built.task, briefText(built.task, brief, 1, tasks.globalWatchCategories()), `${key}#build`) ?? [];
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
        participants: options.deletion,
        maintainers: options.maintainers(),
        records,
        // 运营方案（130 号票）里维护者写的文字不跟着留在删除的那一条里
        deletedEvent: ({ operations: _operations, ...project }) => projectEvent(patched(project, {}), "deleted", "archived", "user"),
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

  /** 还在等的某几种卡（这个项目的） */
  const pendingCardsOf = (projectId: string, types: Array<"build_done" | "go_live">) => listPendingCards(store.reader, types).filter((c) => (c.payload as { projectId?: string }).projectId === projectId);

  /** 还没选的"首版做完了"卡（112 号票） */
  const pendingBuildDone = (projectId: string) => pendingCardsOf(projectId, ["build_done"]);

  /** 还在等的转入使用确认卡（259 号票）："首版做完了"卡、"转入使用"卡 */
  const pendingGoLive = (projectId: string) => pendingCardsOf(projectId, ["build_done", "go_live"]);

  /** 要随转入使用生效的那份运营方案：维护者建设期间交的、还没确认的（130 号票） */
  const goLivePlan = (projectId: string): OperationsPlanView | undefined => options.operations?.().pendingBuildPlan(projectId);

  /** 建设中 → 使用中的检查清单（259 号票，standard.ts）：按本项目的规范改写（261 号票：不要的那份对应的项不列） */
  const checklistOf = (project: Project, plan: ChecklistPlan | undefined): GoLiveChecklistItem[] =>
    goLiveChecklist({ project, paths: records(project.id), stateSince: stateSince(project), plan, overrides: standardOverrides(store.reader, project.id), ops: opsItemOf(project) });

  /** 运营接口清单那一项（268 号票：接上了验收的用它） */
  const opsItemOf = (project: Project) => (options.projectOps ? () => options.projectOps!().checklistItem(project) : undefined);

  /** 第几轮建设：1 是首版，之后每次在"首版做完了"卡上选继续建设加 1 */
  const buildRound = (projectId: string) =>
    1 +
    store
      .read(CHANNELS.projects, 0, EVENT_TYPES.project)
      .map((e) => e.payload as ProjectEventPayload)
      .filter((p) => p.change === "build_continued" && p.project.id === projectId).length;

  /**
   * "首版做完了"卡的负载（112 号票）：建设任务最后的总结（最后验收通过的那个阶段宣布完成时写的那句）、每个阶段一行验收结果
   * （"验收通过：脚本检查 1 条、评审判定 2 条"）和交付件（照现在生效的计划）、交付件在哪（项目的工作目录）
   */
  const buildDonePayload = (project: Project, task: Task): BuildDoneCardPayload => {
    const list = task.stages?.list ?? [];
    const codes = listStageCodes(list);
    const confirmedPlan = tasks.confirmedPlan(task.id)?.plan;
    const plan = goLivePlan(project.id);
    const judgedAt = (stage: (typeof list)[number]) => Math.max(0, ...stage.acceptance.map((a) => (a.result ? Date.parse(a.result.at) : 0)));
    const last = list.filter((s) => s.summary).toSorted((a, b) => judgedAt(b) - judgedAt(a))[0];
    const result = (stage: (typeof list)[number]) => {
      if (stage.state !== "accepted") return STAGE_STATE_LABEL[stage.state];
      const counts = new Map<AcceptanceMethod, number>();
      for (const a of stage.acceptance) if (a.result?.passed) counts.set(a.method, (counts.get(a.method) ?? 0) + 1);
      const parts = [...counts].map(([method, n]) => t("projects.build.verdictCount", { verdict: ACCEPTANCE_VERDICT_LABEL[method], count: n }));
      return parts.length > 0 ? t("projects.build.passedWith", { parts: parts.join(t("pages.common.listSep")) }) : t("projects.build.passed");
    };
    return {
      projectId: project.id,
      projectName: project.name,
      buildTaskId: task.id,
      buildTaskTitle: task.title,
      round: buildRound(project.id),
      ...(last?.summary ? { summary: last.summary } : {}),
      stages: list.map((s) => ({
        code: codes.get(s.stageId) ?? s.stageId,
        title: s.title,
        result: result(s),
        deliverables: [...(confirmedPlan?.stages.find((p) => p.stageId === s.stageId)?.deliverables ?? [])],
      })),
      workdir: projectWorkdir(records(project.id), project),
      // 维护者建设期间交的运营方案（130 号票）：卡上多一节"转入使用后会开起来的"
      ...withOperations(plan),
      // 转运营检查清单（259 号票）：没做到的照样能转入使用，卡上写明差什么
      checklist: checklistOf(project, plan),
      checkedAt: now(),
    };
  };

  /**
   * 出一张"首版做完了"卡的事件（112 号票）：卡片（带幂等键 key）、待我处理里的一项（来源是项目，不卡任务；不是项目内部的事项，
   * 秘书列待办时看得到卡上写的）、维护者会话里的一张（"去项目 ›"定位得到）。提交之后要 inbox.alert 那一项
   */
  const buildDoneEvents = (project: Project, task: Task, key: string): { events: NewEvent[]; item: InboxItem } => {
    const payload = buildDonePayload(project, task);
    const card = cards.buildCreate({ type: "build_done", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(buildDoneTitle(payload), 60), source: t("projects.source.project", { name: project.name }), origin: { projectId: project.id }, urgency: "non_blocking" });
    const shown = buildMessage({ conversation: maintainerChannel(project.maintainerId), speaker: "system", parts: [{ type: "card_ref", cardId: card.card.id }] }, { projectId: project.id }).event;
    // 259 号票：还在等的"转入使用"卡由这张接替（它的"转入使用"是同一道确认，还多了继续建设、放弃）
    const superseded = pendingCardsOf(project.id, ["go_live"]).map((c) => cards.buildUpdate(c.id, { status: "expired", expiredNote: t("projects.goLive.supersededByBuildDone") }).event);
    return { events: [...superseded, { ...card.event, idempotencyKey: key }, item.event, shown], item: item.item };
  };

  /** 项目现在的建设任务做完了（不是转为项目）：可以出"首版做完了"卡 */
  const builtTaskOf = (project: Project): Task | undefined => {
    const task = project.buildTaskId === undefined ? undefined : tasks.get(project.buildTaskId);
    return task?.state === "done" && task.endKind === undefined ? task : undefined;
  };

  /**
   * 建设任务做完（首个建设任务，或者继续建设的下一轮）：给用户一张"首版做完了"卡（112 号票，用户 2026-10-13 定：项目状态变更时
   * 找用户，不再自动进入使用中）。同一个建设任务只出一张（卡片事件的幂等键，重启时补的也不重复）；放弃之后取消归档回到建设中的，
   * 取消归档时另出一张（act）
   */
  const taskCompleted = (task: Task) => {
    if (task.state !== "done" || task.endKind !== undefined) return;
    for (const project of listProjects(store.reader)) {
      if (project.buildTaskId !== task.id || project.state !== "building") continue;
      const key = `build-done:${task.id}`;
      if (store.eventByIdempotencyKey(key)) continue;
      const { events, item } = buildDoneEvents(project, task, key);
      store.appendBatch(events);
      inbox.alert(item);
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
    // 258 号票：项目类型定了，补上这一类的规范文档（开发类的架构图、tickets/、ops.json；已有的不动）
    ensureRecords(project);
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

  const ensureRecords = (project: Project) => {
    try {
      // 261 号票：本项目的规范改写里不要的那几份不补
      const dropped = standardOverrides(store.reader, project.id).flatMap((o) => (o.kind === "drop" ? [o.doc] : []));
      ensureProjectRecords(records(project.id), project, { dropped });
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
    if (!value) throw new RequestRejected("bad_params", t("projects.errors.externalPathMissing"));
    if (!isWindowsAbsolute(value)) throw new RequestRejected("bad_params", t("projects.errors.externalPathNotAbsolute", { value }));
    const resolved = path.resolve(value);
    const candidates = [resolved, realPathOf(resolved) ?? resolved];
    for (const [what, dir] of [
      ["projects.errors.dataDir", options.dataDir],
      ["projects.errors.programDir", options.programDir],
    ] as const) {
      const dirs = [dir, realPathOf(dir) ?? dir];
      const clash = candidates.some((c) => dirs.some((d) => isWithin(c, d) || isWithin(d, c)));
      if (clash) throw new RequestRejected("bad_params", t("projects.errors.externalPathClash", { what: t(what), path: resolved }));
    }
    return resolved;
  };

  const buildToolkitChange = (projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged & { events: NewEvent[] } => {
    const project = mustGet(projectId);
    if (!project.charterConfirmed) throw new RequestRejected("not_allowed", t("projects.errors.toolkitBeforeCharter", { name: project.name }));
    if (project.state === "archived") throw new RequestRejected("not_allowed", t("projects.errors.toolkitArchived", { name: project.name }));
    const before = projectToolkit(project);
    const after: PlanToolkit = {
      skills: [...new Set(toolkit.skills)],
      mcp: [...new Set(toolkit.mcp)],
      bash: toolkit.bash,
      network: toolkit.network,
      ...tellSecretaryField(canTellSecretary(toolkit)),
      ...sendAttachmentField(canSendAttachment(toolkit)),
    };
    if (sameToolkit(before, after)) return { project, before, after: before, changed: false, events: [] };
    const next = patched(project, { toolkit: after });
    const record = buildTimelineRecord(maintainerChannel(project.maintainerId), { kind: "toolkit", summary: t("projects.toolkitChanged", { why: change.why, change: toolkitChangeText(before, after) }) }, { projectId: project.id });
    const events: NewEvent[] = [
      ...(change.events ?? []),
      { ...projectEvent(next, "toolkit_changed", project.state, change.by), ...(change.idempotencyKey === undefined ? {} : { idempotencyKey: change.idempotencyKey }) },
      record.event,
    ];
    return { project: next, before, after, changed: true, events };
  };

  /**
   * 进入现在这个状态的时间（258 号票：检查清单的"进展已写回"要在它之后改过）：最后一次改了状态的那条项目事件上的时间，
   * 没改过就是建出的时间。项目编号不回收，按编号认
   */
  const stateSince = (project: Project): string => {
    let since = project.createdAt;
    for (const event of store.read(CHANNELS.projects, 0, EVENT_TYPES.project)) {
      const p = event.payload as ProjectEventPayload;
      if (p.project.id !== project.id) continue;
      if (p.from === null) since = p.project.createdAt;
      else if (p.from !== p.project.state) since = p.project.updatedAt;
    }
    return since;
  };

  /**
   * 转入使用（259 号票）：建设中 → 使用中唯一的一道门，只从确认卡上的确认走到这里（"首版做完了"卡、"转入使用"卡）。
   * 项目进入使用中；卡上带着运营方案的，方案里每一条一起生效（130 号票）；确认时按那时的再算一遍检查清单，缺的写进维护者会话里的
   * 那句说明（也交回给卡记进决定）；别的还在等的转入使用确认卡作废
   */
  const goLive = (
    project: Project,
    how: { via: "build_done" | "go_live"; cardId: string; plan: OperationsPlanView | undefined; input: OperationsConfirmInput | undefined; key: string; chose: string },
  ): { events: NewEvent[]; results?: OperationResult[]; missing: GoLiveChecklistItem[] } => {
    const missing = checklistMissing(checklistOf(project, how.plan));
    const ops = how.plan && options.operations ? options.operations().putInUse(project, how.plan, how.input, how.key, how.cardId, how.via) : undefined;
    const next = patched(project, { state: "in_use", ...(ops ? { operations: ops.operations } : {}) });
    const others = pendingGoLive(project.id)
      .filter((c) => c.id !== how.cardId)
      .map((c) => cards.buildUpdate(c.id, { status: "expired", expiredNote: t("projects.goLive.otherConfirmed") }).event);
    const missingText = missing.length > 0 ? t("projects.goLive.missingNote", { items: missingItemsText(missing) }) : "";
    return {
      events: [
        projectEvent(next, "in_use", project.state, "user"),
        maintainerNote(next, t("projects.build.inUseNote", { chose: how.chose, name: project.name }) + (ops?.note ?? "") + missingText, `${how.key}#note`),
        ...(ops?.events ?? []),
        // 268 号票：运营接口清单验收全过的，转入使用时登记成第 1 版（还在等服务上线的，服务起来后秘书第一次用到时验、过了登记）
        ...(options.projectOps?.().goLiveEvents(project) ?? []),
        ...others,
      ],
      ...(ops ? { results: ops.results } : {}),
      missing,
    };
  };

  /** 还在等的那张卡上的清单（"转入使用"卡还有运营方案）照现在的刷新；没变的不动（不白涨卡的版本） */
  const refreshCard = (existing: Card, plan: OperationsPlanView | undefined, checklist: GoLiveChecklistItem[], time: string) => {
    const payload = existing.payload as BuildDoneCardPayload | GoLiveCardPayload;
    const operations = existing.type === "go_live" ? withOperations(plan) : {};
    const changed = JSON.stringify(payload.checklist) !== JSON.stringify(checklist) || (existing.type === "go_live" && JSON.stringify(payload.operations) !== JSON.stringify(plan));
    if (!changed) return;
    const { operations: _old, ...rest } = payload;
    const refreshed = existing.type === "go_live" ? { ...rest, ...operations, checklist, checkedAt: time } : { ...payload, checklist, checkedAt: time };
    store.append(cards.buildUpdate(existing.id, { payload: refreshed }).event);
  };

  const requestGoLive = (projectId: string, request: GoLiveRequest): GoLiveRequested => {
    const project = mustGet(projectId);
    if (project.state !== "building") throw new RequestRejected("not_allowed", t("projects.goLive.notBuilding", { name: project.name, state: PROJECT_STATE_LABEL[project.state] }));
    const plan = goLivePlan(project.id);
    const checklist = checklistOf(project, plan);
    const time = now();
    const existing = pendingGoLive(project.id)[0];
    if (existing) {
      // 已经有一张在等：用它，卡上的清单（"转入使用"卡还有运营方案）照现在的刷新；没变的不动（不白涨卡的版本）
      refreshCard(existing, plan, checklist, time);
      return { cardId: existing.id, cardType: existing.type === "go_live" ? "go_live" : "build_done", created: false, checklist };
    }
    const why = request.why?.trim();
    const payload: GoLiveCardPayload = {
      projectId: project.id,
      projectName: project.name,
      by: request.by,
      ...(why ? { why: why.slice(0, 2000) } : {}),
      checklist,
      checkedAt: time,
      ...withOperations(plan),
    };
    const card = cards.buildCreate({ type: "go_live", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: oneLine(goLiveTitle(payload), 60),
      source: t("projects.source.project", { name: project.name }),
      origin: { projectId: project.id },
      urgency: "non_blocking",
    });
    // 维护者会话里也有一张、一句说明（维护者自己提的：它的工具产生的卡本来就在它的会话里）
    const inMaintainerChat =
      request.by === "maintainer"
        ? []
        : [
            maintainerNote(project, t("projects.goLive.requestedNote", { by: GO_LIVE_BY_LABEL[request.by], name: project.name }), `${request.key}#note`),
            buildMessage({ conversation: maintainerChannel(project.maintainerId), speaker: "system", parts: [{ type: "card_ref", cardId: card.card.id }] }, { projectId: project.id }).event,
          ];
    store.appendBatch([{ ...card.event, idempotencyKey: request.key }, item.event, ...inMaintainerChat]);
    inbox.alert(item.item);
    return { cardId: card.card.id, cardType: "go_live", created: true, checklist };
  };

  return {
    get: directory.get,
    list: directory.list,
    ofMaintainer: directory.ofMaintainer,
    records,
    workdir: (project) => projectWorkdir(records(project.id), project),
    standard(projectId) {
      const row = getProjectRow(store.reader, projectId);
      if (!row || row.deleted) return undefined;
      // 建设中的清单看要随转入使用生效的那份运营方案（259 号票：服务、/apps/ 两项）；只读视图按本项目的规范改写算（261 号票）
      const plan = row.project.state === "building" ? goLivePlan(projectId) : undefined;
      return projectStandardView({ project: row.project, paths: records(projectId), stateSince: stateSince(row.project), plan, overrides: standardOverrides(store.reader, projectId), ops: opsItemOf(row.project) });
    },

    kickoffFromCard(payload, idempotencyKey) {
      // 305 号票：在哪个文件夹做（能选工作文件夹的运行时才定；新开的这时建出）。名字重了先拒，免得白开一个子文件夹
      const name = oneLine(payload.name, PROJECT_NAME_MAX);
      if (name && projectNamed(store.reader, name)) throw new RequestRejected("conflict", t("projects.errors.nameTaken", { name }));
      const workdir = options.workFolder?.settle(payload.runtime, payload.folder, payload.name);
      const project = newProject({
        name: payload.name,
        goal: payload.goal,
        origin: "suggestion",
        ...(payload.runtime === undefined ? {} : { runtime: payload.runtime }),
        ...(workdir === undefined ? {} : { workdir }),
      });
      const note = maintainerNote(project, kickoffNote(project), `${idempotencyKey}#note`);
      const notice = buildAgentNotice(
        CHANNELS.secretary,
        // @i18n-ignore-next model：交给秘书的通知
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
      if (!text) throw new RequestRejected("bad_params", t("projects.errors.emptyRequest"));
      // 选的运行时（289 号票）：现在能用的才行（pi 不写）
      const runtime = params.runtime === undefined || params.runtime === PI_RUNTIME_ID ? undefined : params.runtime;
      const refused = runtime === undefined ? undefined : options.runtimeRefusal?.(runtime);
      if (refused !== undefined) throw new RequestRejected("bad_params", refused);
      // 305 号票：选了已有文件夹的这时就核对路径（不对的当场告诉用户，不等到立项）
      options.workFolder?.precheck(runtime, params.folder);
      const { event } = store.append(buildAgentNotice(CHANNELS.secretary, newProjectNotice(text, runtime, params.folder), idempotencyKey).event);
      const message = (event.payload as Partial<MessageEventPayload>).message;
      if (event.type !== EVENT_TYPES.message || !message) throw new RequestRejected("bad_params", t("conversation.messages.keyReused"));
      return { messageId: message.id };
    },

    setRuntime(projectId, runtime, runtimeOptions) {
      const project = mustGet(projectId);
      const nextRuntime = runtime === undefined || runtime === PI_RUNTIME_ID ? undefined : runtime;
      const nextOptions = runtimeOptions && (runtimeOptions.model !== undefined || Object.keys(runtimeOptions.settings ?? {}).length > 0) ? runtimeOptions : undefined;
      if (project.runtime === nextRuntime && JSON.stringify(project.runtimeOptions) === JSON.stringify(nextOptions)) return project;
      const { runtime: _runtime, runtimeOptions: _options, takeover, ...rest } = project;
      // 接管来的（290 号票）换了别的运行时：不再记着接管的会话（写入锁跟着放开），工作目录照旧
      const keepTakeover = takeover !== undefined && takeover.runtime === (nextRuntime ?? PI_RUNTIME_ID);
      const next: Project = {
        ...rest,
        ...(nextRuntime === undefined ? {} : { runtime: nextRuntime }),
        ...(nextOptions === undefined ? {} : { runtimeOptions: nextOptions }),
        ...(keepTakeover ? { takeover } : {}),
        updatedAt: now(),
      };
      store.append(projectEvent(next, "runtime_set", project.state, "user"));
      return next;
    },

    takeOver(input, idempotencyKey, extra) {
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) return (done.payload as ProjectEventPayload).project;
      const refused = options.runtimeRefusal?.(input.runtime);
      if (refused !== undefined) throw new RequestRejected("bad_params", refused);
      // 名字和没删掉的项目重了：加序号（会话标题常常一样）
      const base = oneLine(input.name, PROJECT_NAME_MAX - 4) || t("projects.takeover.defaultName");
      let name = base;
      for (let i = 2; projectNamed(store.reader, name); i++) name = `${base} (${i})`;
      const project = newProject({ name, goal: input.goal, origin: "takeover", runtime: input.runtime, workdir: input.workdir, takeover: input.takeover });
      store.appendBatch([{ ...projectEvent(project, "created", null, "user"), idempotencyKey }, ...extra(project)]);
      return project;
    },

    setTakeover(projectId, takeover) {
      const project = mustGet(projectId);
      // @i18n-ignore-next log：调用方写错了才有
      if (!project.takeover && takeover.own !== true) throw new RequestRejected("not_allowed", `${projectId} 不是从已有的会话接管来的`);
      const next = patched(project, { takeover: { ...takeover } });
      store.append(projectEvent(next, "takeover_set", project.state, "user"));
      return next;
    },

    convertTask(params, idempotencyKey) {
      // 同一个幂等键重发：拿到第一次转出的项目
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) {
        const converted = listProjects(store.reader).find((p) => p.fromTaskId === params.taskId);
        if (converted) return { projectId: converted.id };
      }
      const task = tasks.get(params.taskId);
      if (!task) throw new RequestRejected("not_found", t("projects.errors.noTask", { id: params.taskId }));
      if (projectOfMaintainer(store.reader, task.maintainerId)) throw new RequestRejected("not_allowed", t("projects.errors.alreadyMaintainer", { id: task.id }));
      const ended = tasks.buildConvertToProject(task.id);
      const goal = tasks.brief(task.id)?.brief.goal ?? task.summary;
      const project = newProject({ name: params.name, goal, origin: "task", maintainerId: task.maintainerId, fromTaskId: task.id });
      const notice = buildAgentNotice(
        maintainerChannel(project.maintainerId),
        // @i18n-ignore-start model：交给维护者的通知
        [
          `任务 ${task.id}「${task.title}」已由用户转为项目 ${project.id}「${project.name}」（筹备中），原任务以“已完成 · 已转为项目”结束。`,
          `你现在是这个项目的维护者：接着和用户做立项问答（一次问一两个问题），把规格、术语表、决策记录写进项目档案（${records(project.id).root}），`,
          `问清范围、目标、首版要做到什么程度、项目类型（开发类还是其他）、要不要把工作目录绑定到一个外部路径之后，用 ${SUBMIT_CHARTER_TOOL} 交出立项书和你提议的工具包。`,
        ].join("\n"),
        // @i18n-ignore-end
        `${idempotencyKey}#notice`,
        { projectId: project.id },
      );
      store.appendBatch([{ ...ended.event, idempotencyKey }, projectEvent(project, "created", null, "user"), notice.event]);
      return { projectId: project.id };
    },

    submitCharter(projectId, maintainerId, submission) {
      const project = mustGet(projectId);
      // @i18n-ignore-start model：交立项书的工具交回维护者的原因
      if (project.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `项目 ${projectId} 不是你维护的，只有它的维护者能交立项书`);
      if (project.state !== "preparing") throw new RequestRejected("not_allowed", `项目「${project.name}」现在是${forModel(() => PROJECT_STATE_LABEL[project.state])}，只有筹备中的项目能交立项书`);
      if (project.charterConfirmed) throw new RequestRejected("not_allowed", `项目「${project.name}」的立项书已经确认了，不能再交`);
      const { charter } = submission;
      // 311 号票：工作目录在立项之前就定在外面了（305 号票新建时选的文件夹、290 号票接管来的会话原来的；确认时不改它）——立项书照它写成
      // 绑定了那个外部路径（charterForWorkdir），交的绑不绑、哪条路径不算；不限开发类（文件夹是用户新建时定的，不是维护者提议绑定）
      const fixedWorkdir = project.workdir.external ? project.workdir.path : undefined;
      if (fixedWorkdir === undefined && charter.bindExternal && charter.kind !== "dev") throw new RequestRejected("bad_params", "只有开发类项目能把工作目录绑定到外部路径");
      // @i18n-ignore-end
      const unbound: Charter = {
        goal: charter.goal,
        scope: charter.scope,
        firstVersion: charter.firstVersion,
        kind: charter.kind,
        bindExternal: false,
        // 运营方式（130 号票，选填，不算授权）
        ...(charter.operations === undefined ? {} : { operations: charter.operations }),
      };
      const normalized: Charter =
        fixedWorkdir !== undefined
          ? charterForWorkdir(unbound, project.workdir)
          : charter.bindExternal
            ? { ...charter, externalPath: checkedExternalPath(charter.externalPath) }
            : unbound;
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
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(t("projects.charter.inboxTitle", { name: project.name }), 60), source: t("projects.source.project", { name: project.name }), origin: { projectId }, urgency: "non_blocking" });
      events.push(
        { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.submitted, payload: submitted },
        card.event,
        projectEvent(patched(project, { charterCardId: card.card.id }), "charter_submitted", project.state, "maintainer"),
        item.event,
      );
      store.appendBatch(events);
      inbox.alert(item.item);
      return { cardId: card.card.id, revision, toolkit, ...(fixedWorkdir === undefined ? {} : { fixedWorkdir }) };
    },

    confirmCharter(payload, decision, note, idempotencyKey) {
      const project = mustGet(payload.projectId);
      const latest = latestCharter(store.reader, project.id);
      if (!latest || latest.revision !== payload.revision) throw new RequestRejected("conflict", t("projects.charter.superseded"));
      if (project.charterConfirmed || project.state !== "preparing") {
        throw new RequestRejected("conflict", t(project.charterConfirmed ? "projects.charter.alreadyConfirmed" : "projects.charter.notPreparing", { name: project.name, state: PROJECT_STATE_LABEL[project.state] }));
      }
      const { charter, toolkit } = latest;
      const start = decision === "start";
      // 项目类型、外部工作目录绑定、工具包在确认时就生效
      // 290 号票接管来的（会话原来的）、305 号票新建时选了文件夹的：工作目录建的时候就在外面，确认时不改
      const workdir = project.workdir.external ? project.workdir : charter.bindExternal && charter.externalPath ? { external: true, path: charter.externalPath } : { external: false };
      let next = patched(project, { kind: charter.kind, workdir, toolkit, charterConfirmed: true });
      const events: NewEvent[] = [];
      let buildTaskId: string | undefined;
      let buildTitled: Task | undefined;
      if (start) {
        const built = buildTask(next, idempotencyKey);
        buildTaskId = built.task.id;
        buildTitled = built.task;
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
      const where = workdir.external ? t("projects.charter.workdirExternal", { path: workdir.path }) : t("projects.charter.workdirInRecords");
      const text =
        t("projects.charter.confirmedNote", { decision: CHARTER_DECISION_LABEL[decision], kind: PROJECT_KIND_LABEL[charter.kind], where, bash: toolkitBashWording(toolkit.bash) }) +
        (buildTitled ? charterBuildText(buildTitled) : "");
      events.push(
        { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.decided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` },
        projectEvent(next, start ? "building_started" : "charter_confirmed", project.state, "user"),
        maintainerNote(next, text, `${idempotencyKey}#note`),
      );
      return {
        status: "handled",
        payload: { ...payload, confirmed: { start, ...(buildTaskId === undefined ? {} : { buildTaskId }) } },
        note: buildTitled ? buildTaskNote(buildTitled) : t("projects.charter.later"),
        events,
      };
    },

    decideBuild(payload, choice, note, idempotencyKey, confirm) {
      const project = mustGet(payload.projectId);
      if (project.state !== "building" || project.buildTaskId !== payload.buildTaskId) {
        throw new RequestRejected("conflict", t(project.state === "building" ? "projects.build.cardStaleRestarted" : "projects.build.cardStale", { name: project.name, state: PROJECT_STATE_LABEL[project.state] }));
      }
      const title = buildDoneTitle(payload);
      const chose = t("projects.build.chose", { title, choice: choice === "put_in_use" && payload.operations ? OPERATIONS_PUT_IN_USE_LABEL : BUILD_DONE_CHOICE_LABEL[choice] });
      if (choice === "put_in_use") {
        // 卡上带着运营方案（130 号票）：确认并转入使用，一次做完——项目进入使用中、方案里每一条生效、项目上记下现在生效的运营方案。
        // 259 号票：和"转入使用"卡走同一道门（goLive），确认时清单里还缺的记进决定
        const done = goLive(project, { via: "build_done", cardId: confirm?.cardId ?? "", plan: payload.operations, input: confirm?.input, key: idempotencyKey, chose });
        return {
          status: "handled",
          payload: { ...payload, decided: { choice, ...(done.results ? { operations: done.results } : {}), ...(done.missing.length > 0 ? { missing: done.missing } : {}) } },
          events: done.events,
        };
      }
      if (choice === "abandon") {
        // 照项目页上的放弃：还有正在做或排队的工单时不能（16 号票评审后用户定）
        const open = options.workOrders?.().openOf(project.id) ?? [];
        if (open.length > 0) throw new RequestRejected("not_allowed", archiveBlockedText(open));
        const target = projectActionTarget(project, "abandon")!;
        const next = patched({ ...project, ...(target.archivedFrom === undefined ? {} : { archivedFrom: target.archivedFrom }) }, { state: target.state });
        // 还在等的"转入使用"卡作废（259 号票）
        const expired = pendingCardsOf(project.id, ["go_live"]).map((c) => cards.buildUpdate(c.id, { status: "expired", expiredNote: t("projects.build.cardExpired", { action: PROJECT_ACTION_LABEL.abandon }) }).event);
        return {
          status: "handled",
          payload: { ...payload, decided: { choice } },
          events: [projectEvent(next, target.change, project.state, "user"), maintainerNote(next, t("projects.build.abandonedNote", { chose, name: project.name }), `${idempotencyKey}#note`), ...expired],
        };
      }
      const request = note?.trim();
      if (!request) throw new RequestRejected("bad_params", t("projects.build.requestMissing"));
      const built = buildTask(project, idempotencyKey, { round: payload.round + 1, request, previous: payload });
      const next = patched(project, { buildTaskId: built.task.id });
      return {
        status: "handled",
        payload: { ...payload, decided: { choice, request, nextTaskId: built.task.id } },
        note: nextBuildNote(built.task),
        events: [
          ...built.events,
          projectEvent(next, "build_continued", project.state, "user"),
          maintainerNote(next, t("projects.build.keepBuildingNote", { chose, request }) + nextBuildText(built.task), `${idempotencyKey}#note`),
        ],
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
      const open = ARCHIVING_ACTIONS.includes(params.action) ? (options.workOrders?.().openOf(project.id) ?? []) : [];
      if (open.length > 0) throw new RequestRejected("not_allowed", archiveBlockedText(open));
      // 转入使用（259 号票）：不马上转，出确认卡（还在等的就用那一张），用户在卡上确认才转
      if (params.action === "go_live") {
        const requested = requestGoLive(project.id, { by: "user", key: idempotencyKey });
        return { projectId: project.id, state: project.state, confirmCardId: requested.cardId };
      }
      const target = projectActionTarget(project, params.action);
      if (!target) {
        // 删除：不马上删，在待我处理里放一条二次确认（同一个项目已有没处理的就用它）
        const existing = pendingDeleteItems(project.id)[0];
        if (existing) return { projectId: project.id, state: project.state, confirmItemId: existing.id };
        const item = inbox.buildAdd({
          kind: "notice",
          notice: "project_delete",
          title: oneLine(t("projects.delete.title", { name: project.name }), 60),
          // 删不掉的如实写上（66 号票）
          body:
            t("projects.delete.body", { name: ASSISTANT_NAME_MARK }) +
            (project.workdir.external ? t("projects.delete.externalKept", { path: project.workdir.path ?? "" }) : "") +
            PROJECT_DELETE_LIMITS,
          source: t("projects.source.project", { name: project.name }),
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
      // 放弃了：还没选的"首版做完了"卡、还没确认的"转入使用"卡（259 号票）作废（112 号票）
      if (target.state === "archived") {
        for (const card of pendingGoLive(project.id)) events.push(cards.buildUpdate(card.id, { status: "expired", expiredNote: t("projects.build.cardExpired", { action: PROJECT_ACTION_LABEL[params.action] }) }).event);
      }
      // 取消归档：还没处理的删除确认收进归档（不再是"待处理"）
      if (params.action === "unarchive") for (const item of pendingDeleteItems(project.id)) events.push(inbox.buildUpdate(item, { archived: true }).event);
      // 取消归档回到建设中、建设任务已经做完了（放弃时那张"首版做完了"卡作废了，或者就是在卡上选的放弃）：再出一张，
      // 不然项目永远停在建设中（再开工只认失败、取消了的建设任务）。这次取消归档的幂等键带进卡片的幂等键：同一次重发不重复
      const built = params.action === "unarchive" && next.state === "building" && pendingBuildDone(project.id).length === 0 ? builtTaskOf(next) : undefined;
      const again = built ? buildDoneEvents(next, built, `build-done:${built.id}:${idempotencyKey}`) : undefined;
      if (again) events.push(...again.events);
      store.appendBatch(events);
      if (again) inbox.alert(again.item);
      return { projectId: project.id, state: next.state };
    },

    goLiveChecklist(projectId, plan) {
      const project = getProjectRow(store.reader, projectId)?.project;
      return project ? checklistOf(project, plan ?? goLivePlan(projectId)) : [];
    },

    requestGoLive,

    refreshGoLiveChecklist(projectId) {
      const project = getProjectRow(store.reader, projectId)?.project;
      if (!project || project.state !== "building") return;
      const existing = pendingGoLive(project.id)[0];
      if (!existing) return;
      const plan = goLivePlan(project.id);
      refreshCard(existing, plan, checklistOf(project, plan), now());
    },

    decideGoLive(payload, choice, note, idempotencyKey, confirm) {
      const project = mustGet(payload.projectId);
      if (project.state !== "building") throw new RequestRejected("conflict", t("projects.goLive.cardStale", { name: project.name, state: PROJECT_STATE_LABEL[project.state] }));
      const chose = t("projects.build.chose", { title: goLiveTitle(payload), choice: choice === "put_in_use" && payload.operations ? OPERATIONS_PUT_IN_USE_LABEL : GO_LIVE_CHOICE_LABEL[choice] });
      if (choice === "dismiss") {
        // 先不转：项目留在建设中；维护者提的告诉它一声（唤起它：用户没同意，接着建设或者补齐清单）
        const comment = note?.trim();
        return {
          status: "handled",
          payload: { ...payload, decided: { choice } },
          ...(comment ? { note: comment } : {}),
          events: [
            maintainerNote(project, t("projects.goLive.dismissedNote", { chose, name: project.name }), `${idempotencyKey}#note`),
            ...(payload.by === "maintainer" ? [buildAgentNotice(maintainerChannel(project.maintainerId), goLiveDismissedNotice(project, comment), `${idempotencyKey}#notice`, { projectId: project.id }).event] : []),
          ],
        };
      }
      const done = goLive(project, { via: "go_live", cardId: confirm?.cardId ?? "", plan: payload.operations, input: confirm?.input, key: idempotencyKey, chose });
      return {
        status: "handled",
        payload: { ...payload, decided: { choice, ...(done.results ? { operations: done.results } : {}), ...(done.missing.length > 0 ? { missing: done.missing } : {}) } },
        events: done.events,
      };
    },

    maintainedBy,

    buildToolkitChange,

    changeToolkit(projectId, toolkit, change) {
      const { events, ...result } = buildToolkitChange(projectId, toolkit, change);
      if (events.length > 0) store.appendBatch(events);
      return result;
    },

    projectOf: directory.projectOf,

    writeProgress(projectId, text) {
      const paths = records(projectId);
      if (fs.existsSync(paths.progress)) preservePaths(paths, [paths.progress], now());
      fs.writeFileSync(paths.progress, text.endsWith("\n") ? text : `${text}\n`);
    },

    resetMaintainer(projectId, idempotencyKey) {
      const project = mustGet(projectId);
      if (!canResetMaintainer(project)) throw new RequestRejected("not_allowed", t("projects.errors.resetArchived", { name: project.name }));
      if (!options.workOrders) throw new RequestRejected("not_implemented", t("projects.errors.resetUnsupported"));
      return { projectId: project.id, ...options.workOrders().reset(project, idempotencyKey) };
    },

    conversationScope(conversation, taskId) {
      if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
      const found = projectOfMaintainer(store.reader, conversation.slice(MAINTAINER_CHANNEL_PREFIX.length));
      if (!found) return undefined;
      const { project, deleted } = found;
      if (deleted) throw new RequestRejected("not_found", t("projects.errors.chatDeleted", { name: project.name }));
      if (project.state === "archived") throw new RequestRejected("not_allowed", t("projects.errors.chatArchived", { name: project.name }));
      // 在这个项目内部的普通任务的详情里说的（75 号票）：消息属于这个任务（做完了接着说，它接着做），不看现在在哪一段
      const task = taskId === undefined ? undefined : options.tasks.get(taskId);
      if (task && isPlainTask(task) && isInternalTo(task, project.id)) {
        if (!availableTaskActions(task, "user").includes("message")) throw new RequestRejected("not_allowed", taskActRefusal(task, "message"));
        return { projectId: project.id, taskId: task.id };
      }
      // 消息属于当前这一段（16 号票）：做工单时还带上所属的任务
      return options.workOrders?.().scopeOf(project.maintainerId) ?? { projectId: project.id };
    },

    checkTaskProjects: directory.checkTaskProjects,

    internalHost: directory.internalHost,

    projectIdsOf: directory.projectIdsOf,

    taskCompleted,

    start() {
      for (const project of listProjects(store.reader)) ensureRecords(project);
      unsubscribes.push(
        store.onAppend((event) => {
          if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
            const { project, change } = event.payload as ProjectEventPayload;
            // 261 号票：规范改写确认了（恢复照默认的、跟新版规范的）：按改过的规范补缺的文档（已有的不动）；
            // 262 号票：规范上线之前建的项目选了补齐（standard_adopted，记下了版本）：按这一版的模板补上缺的几份
            if (change === "created" || change === "standard_changed" || change === "standard_adopted") ensureRecords(project);
          } else if (event.channel === CHARTERS_CHANNEL && event.type === CHARTER_EVENTS.decided) {
            onCharterDecided(event.payload as CharterDecidedPayload);
          }
        }),
        inbox.onNoticeHandled("project_delete", PROJECT_DELETE_CONFIRM, (item) => {
          const projectId = inboxItemProjectId(item);
          if (projectId !== undefined) confirmDeletion(projectId);
        }),
      );
      // 停着的时候建设任务做完了（追加了任务事件、还没来得及出卡）：补上"首版做完了"卡（出过的不重复）
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

/** 卡上带的运营方案（130 号票）：没有就不写 */
const withOperations = (plan: BuildDoneCardPayload["operations"]): Pick<BuildDoneCardPayload, "operations"> => (plan ? { operations: plan } : {});

/** 清单里缺的几项写成一句："运营接口清单验收通过（ops.json）（缺 ops.json）、进展已写回（……）"（259 号票） */
function missingItemsText(items: readonly GoLiveChecklistItem[]): string {
  return items.map((i) => (i.detail ? t("projects.goLive.missingItem", { label: i.label, detail: i.detail }) : i.label)).join(t("pages.common.listSep"));
}

/** 维护者提的转入使用，用户选了先不转：告诉维护者（交给它处理） */
function goLiveDismissedNotice(project: Project, comment: string | undefined): string {
  // @i18n-ignore-next model：交给维护者的通知
  return `用户在“转入使用”确认卡上选了先不转${comment ? `，说：“${comment}”` : ""}：项目「${project.name}」留在建设中。接着建设、把检查清单缺的补齐，等用户说可以了再提。`;
}

/**
 * 同一个幂等键重发时从那次追加的事件里取结果：删除是待我处理里的二次确认，转入使用（259 号票）是出的那张"转入使用"卡
 */
function confirmItem(payload: unknown): { confirmItemId?: string; confirmCardId?: string } {
  const card = (payload as { card?: { id?: string; type?: string } }).card;
  if (card?.type === "go_live" && typeof card.id === "string") return { confirmCardId: card.id };
  const item = (payload as { item?: { id?: string; kind?: string } }).item;
  return item?.kind === "notice" && typeof item.id === "string" ? { confirmItemId: item.id } : {};
}
