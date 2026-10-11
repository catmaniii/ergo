// 任务页：任务看板 + 任务详情（维护者会话、阶段抽屉、工单列表、计划卡、工具包）。
// 看板（12 号票）：任务、简单提醒和定时作业（19 号票）来自前端状态层（state/board.ts 按规格的五组排好），没有守护进程时
// 再补上原型的假条目。作业卡上可以暂停、恢复（取消在作业卡的"更多"里）。
// 真任务的详情（13 号票）：维护者会话（和秘书聊天共用会话组件，输入框直接给维护者下指令，它干活时作为插话）、
// 阶段抽屉（各阶段状态、验收方式和结果，state/task-detail.ts）、计划卡和控制（暂停、继续、取消、重试、返工、由我验收）。
// token 用量（24 号票）：任务卡、作业卡上的总量，任务详情"消耗"一栏里按 agent 的细分（state/usage.ts，来自看板频道上的合计）。
// 工单（17 号票）：任务详情"工单"一栏列出这个任务的全部工单（发给哪个项目、现在怎样、所属阶段），含建出了还没派出的
// （state/work-orders.ts 的 taskWorkOrders）；回执和项目维护者的提问在任务维护者的会话里。
// 普通任务（75 号票）：看板卡标"普通任务"；详情没有计划、阶段、工具包、工单那些栏，只有会话（54 号票的缩放会话）和工具调用详情；
// 做完了输入框照样能用（接着说它就接着做），项目内部的发的话带上任务编号（项目的维护者的会话里同时有几件事）。
// 定时触发的任务（76 号票）：看板"运营中"一组的任务卡上写时间表、下一次、最近一次运行的结果，能暂停、恢复、取消（落到它的触发上）；
// 详情按运行分段：会话里每次运行开始处一条分隔线（缩小后按运行分块），"运行"一栏列出每一次运行（怎么触发的、合并了几次、结果、原因、
// 流程这次做完几步）。
// 三种做法的界面（60 号票，照 AgentSense 固定计划、里程碑计划的界面）：
// - 看板卡标出种类和进度（AgentSense 会话列表的进度条）：普通任务没有进度；流程是做完的步数（定时触发的流程按这一次运行）；
//   长程任务是已验收的阶段数；
// - 流程的详情：标题栏上进度条（做完的步骤 / 总步数），点开是计划台账（PlanTimeline.tsx）；会话历史底部"接下来的计划"虚线框
//   （Conversation 的 workflowTaskId）；计划卡点开是计划详情（ui/detail/WorkflowPlanDetail.tsx）。原来状态行下面的步骤清单去掉了
//   （AgentSense 没有，步骤在虚线框、计划详情里）；
// - 长程任务的详情：阶段标签写"第 N 阶段 · 已验收几个"；点阶段抽屉、阶段栏里的一个阶段，在详情栏打开它的阶段详情
//   （ui/detail/StageDetail.tsx：交付件、验收标准和结果、尝试记录、授权和用量、出过的状况、"从这里重做"）。
// 宽屏布局（88 号票，用户 2026-10-11 提：左边任务列表、中间阶段、右边聊天太窄）：看板和任务详情二选一，宽窄屏一样（state/task-page.ts）——
// 宽屏的看板占满内容区，每组里的卡排成多列网格（.board[data-layout="grid"]）；点卡片、从别处跳进来都整页换成任务详情，
// 标题栏左上角的 ‹（鸿蒙返回键同一层）、浏览器后退回到看板，回来时滚动位置照旧（手机上也是）；‹ 不往历史里压新记录
// （app/history-nav.ts）。长程任务宽屏的阶段栏能整栏藏掉，阶段标签挪到标题栏左边、点它再打开（照 AgentSense），按设备记住；
// 窄屏的阶段抽屉、阶段标签照旧。
// 任务和待办的管理（90 号票，用户 2026-10-11）：
// - 看板卡长按 / 右键出任务操作菜单（state/task-menu.ts 算"这个任务现在能做什么"，ui/task-menu.tsx 画和做），简单提醒、定时作业卡照
//   它们能做的（改、取消提醒；暂停、恢复、取消）；
// - 看板多选：标题栏"多选"、菜单里"多选"进入，点卡片就是勾选，每组标题右边"全选"，底部操作栏（pages/board-select.tsx）；
// - 每组标题点一下收起 / 展开，按设备记住（app/board-fold-setting.ts），默认"已归档"收起；
// - 任务详情顶部并成一行（ui/task-head.tsx）：状态签浮层、关键按钮、"⋯"（计划、工单、工具包、消耗、运行在详情栏打开，下半是任务操作），
//   页签那一排去掉了，会话占满；退回、返工写原因改成点了按钮弹出的对话框。
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { goBackTo, type Navigate, toHash } from "../app/route.ts";
import { useBackLayer } from "../app/page-back.ts";
import { pageBoardFold, useBoardFolded } from "../app/page-board-fold.ts";
import { useStore } from "../app/store.tsx";
import { scheduledJobStatusLabel, TASK_STATUS_LABEL, tokensLabel, WAIT_REASON_LABEL, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import {
  type AgentActivity,
  activityNote,
  agentActivity,
  BOARD_GROUP_OF_TASK_STATE,
  type BoardGroup,
  type BoardItem,
  boardGroups,
  canReopenStage,
  lastRunText,
  type RunView,
  type ScheduledJobView,
  taskRunViews,
  taskTriggerView,
  describeEventTrigger,
  describeSchedule,
  isRepeating,
  maintainerChannel,
  selectTask,
  taskWaitingForProject,
  type StageView,
  type Task,
  hasOwnMaintainer,
  jobTokenTotal,
  LAST_RUN_FAILED_LABEL,
  LEDGER_PURPOSE_LABEL,
  SCHEDULED_JOB_ACTION_LABEL,
  type ScheduledJobAction,
  PROJECT_NAME_MAX,
  REMINDER_STATUS_LABEL,
  taskUsage,
  taskScopeRecords,
  TASK_END_KIND_LABEL,
  taskStatusText,
  UNFINISHED_TASK_STATES,
  taskAcceptsMessages,
  taskStages,
  taskToolkit,
  ENDED_TASK_STATES,
  taskProjectScope,
  taskKind,
  isPlainTask,
  TASK_KIND_LABEL,
  internalScopeLabel,
  WORKFLOW_STEP_ICON,
  WORKFLOW_STEP_STATE_LABEL,
  taskWorkOrders,
  type TaskWorkOrderView,
  userDecidesWait,
  isTriggered,
  workflowProgress,
  taskBoardProgress,
  chatItems,
  type ConversationId,
  type DetailTarget,
  type GuardPingKind,
  latestGuardPing,
  stageToolCalls,
  taskIncidents,
  workflowCurrentRun,
  boardScrollOnReturn,
  stageChipPlace,
  listedStageGraph,
  stageAtItems,
  taskStageAt,
  taskStageGraph,
  type ChatItem,
  taskHasStages,
  taskPageView,
  // 90 号票：任务操作菜单、看板多选、任务详情顶部一行
  type BatchEntry,
  groupSelection,
  type TaskAction,
  type TaskMenuItem,
  type TaskMenuSubject,
  taskKeyItem,
  taskMenu,
  type TaskPanel,
  taskPanels,
  taskStatusNote,
  toggleSelected,
  type UiState,
} from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import type { BoardEntry, ReminderSummary, ScheduledJobSummary, Stage, TaskSummary } from "../model/types.ts";
import { taskDetailOf } from "../prototype/fake-data.ts";
import { protoAfter, protoSubject } from "../prototype/proto-task-acts.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, Section, Sheet, TopBar, useRevealed } from "../ui/common.tsx";
import { useLongPress } from "../ui/long-press.ts";
import { PopupMenu } from "../ui/popup.tsx";
import { TaskHead } from "../ui/task-head.tsx";
import { type TaskActsTarget, TaskMenuPopup, useTaskActs } from "../ui/task-menu.tsx";
import { Conversation, useConversationPane, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { JobAuthorization } from "../ui/job-authorization.tsx";
import { ScopeRecordList } from "../ui/scope-records.tsx";
import { DetailLayout } from "../ui/detail/DetailLayout.tsx";
import { StageCard, stageProgress, usePing } from "../ui/conversation/StageDrawer.tsx";
import { useStagePanel } from "../ui/conversation/stage-panel.tsx";
import { IncidentCounts } from "../ui/detail/incidents.tsx";
import { useTaskHistory } from "../app/task-history.ts";
import { PlanProgress, PlanTimeline } from "../ui/conversation/PlanTimeline.tsx";
import { TaskProgress } from "../ui/TaskProgress.tsx";
import { type StageDetailSource, stageStartedOf } from "../ui/detail/StageDetail.tsx";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { BoardSelectBar } from "./board-select.tsx";
import { StartTaskButton } from "./shared.tsx";
import { ToolkitEditor, ToolkitPanel } from "./ToolkitEditor.tsx";

/**
 * 看板和任务详情二选一（88 号票，宽窄屏一样）：没点任务时整页是看板（宽屏多列网格），点了整页是任务详情，标题栏的 ‹ 回到看板
 * （上一条历史就是看板就后退一步，否则换掉这一条，不压新记录）。
 * jobId：日历里点作业过来，看板上这张作业卡高亮并滚到看得见的地方（35 号票）
 */
export function TasksPage({ wide, taskId, jobId, navigate }: { wide: boolean; taskId?: string; jobId?: string; navigate: Navigate }) {
  // 离开看板（进了任务详情）时看板滚到哪。看板组件在详情页时拿掉了，回来时照它恢复；记在任务页上，切到别的页再回来从头开始。
  // 分组收起没有（90 号票）按设备记住，不用这里记
  const boardScroll = useRef<number | undefined>(undefined);
  const savedScroll = useCallback(() => boardScroll.current, []);
  const rememberScroll = useCallback((top: number) => {
    boardScroll.current = top;
  }, []);
  const view = taskPageView({ wide, taskId, jobId });
  if (view.kind === "task") return <TaskDetail key={view.taskId} taskId={view.taskId} wide={wide} onBack={() => goBackTo({ tab: "tasks" })} />;
  return <Board layout={view.layout} job={view.job} savedScroll={savedScroll} onScrolled={rememberScroll} onOpen={(id) => navigate({ tab: "tasks", taskId: id })} />;
}

// ---------- 看板 ----------

/** 原型假条目的分组：和真数据用同一张表（共享协议包） */
function groupOf(e: BoardEntry): BoardGroup {
  if (e.kind === "task") return BOARD_GROUP_OF_TASK_STATE[e.status];
  if (e.kind === "reminder") return e.status === "fired" ? "ended" : "ops";
  return "ops";
}

/**
 * 定时、事件触发的任务（76、77 号票）在卡上、详情上的那几样：触发登记的状态、时间表（事件触发的是在等什么事件）、下一次、
 * 最近一次运行和最近一次触发、能做的动作
 */
function triggerSummary(view: ScheduledJobView): NonNullable<TaskSummary["trigger"]> {
  const last = lastRunText(view.lastRun);
  return {
    jobId: view.job.id,
    active: view.job.state === "active",
    statusLine: view.statusText,
    schedule: view.scheduleText,
    ...(view.waitingFor ? { waitingFor: view.waitingFor } : {}),
    ...(view.lastTrigger ? { lastTrigger: view.lastTrigger } : {}),
    ...(view.job.nextAt ? { nextAt: view.job.nextAt } : {}),
    ...(last ? { lastRun: last } : {}),
    actions: view.actions,
  };
}

/** 一个真任务在看板卡片、任务详情状态行上要的东西 */
interface TaskSummarySource {
  readonly task: Task;
  /** 维护者的活动状态 */
  readonly activity: AgentActivity;
  /** 这个任务名下的 token 总量（账本） */
  readonly tokens: number;
  /** 它的工单还排着时，排在哪个项目后面 */
  readonly waitingForProject?: string | undefined;
  /** 定时触发的任务的触发登记（76 号票） */
  readonly trigger?: ScheduledJobView | undefined;
  /** 看板卡上的进度（taskBoardProgress） */
  readonly progress?: TaskSummary["progress"] | undefined;
}

/**
 * 真任务在看板卡片上的样子："第 N/M 阶段"的 M 取自计划，N 在开始执行后才有（13 号票），之前写 0（任务详情的状态行用）；
 * token 总量来自账本（24 号票）；维护者的活动状态连同说明（干活中在做什么、等你批准什么，25 号票）；
 * 它的工单还排着（项目的维护者正忙）时标排队、"等项目 X"（16 号票：这时维护者的活动状态是别的工单的）；
 * 进度条（60 号票）流程是做完的步数、长程任务是已验收的阶段数
 */
function taskSummary({ task, activity, tokens, waitingForProject, trigger, progress }: TaskSummarySource): TaskSummary {
  const note = waitingForProject ? `等项目「${waitingForProject}」` : activityNote(activity);
  const timed = isTriggered(task);
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.state,
    taskKind: taskKind(task),
    activity: waitingForProject ? "queued" : activity.state,
    ...(note === undefined ? {} : { activityNote: note }),
    projects: task.projects,
    updatedAt: task.updatedAt,
    tokens,
    ...(task.waitReason ? { waitReason: task.waitReason } : {}),
    // 等我的原因说明（卡住求助、超预算写的原因，被杀后的"中断：不确定 X 是否已执行"，23 号票）：看板的卡上也看得到
    ...(task.state === "waiting_for_user" && userDecidesWait(task) && task.waitNote ? { waitNote: task.waitNote } : {}),
    // 状态写明原因（等我等什么、系统暂停为什么）：状态层的 taskStatusText
    statusLine: taskStatusText(task),
    // 长程任务是第 N/M 阶段（任务详情的状态行）；流程没有阶段，进度在进度条（progress）
    // 91 号票：按依赖图的阶段号（并行的算一个阶段）
    ...(!timed && taskKind(task) !== "workflow" && task.stages ? { stage: taskStageAt(task)! } : {}),
    // 转为项目的任务以"已完成 · 已转为项目"结束
    ...(task.endKind ? { endNote: TASK_END_KIND_LABEL[task.endKind] } : {}),
    // 定时触发的任务（76 号票）：运营中时状态写触发的（运营中、已暂停及原因）
    ...(trigger ? { trigger: triggerSummary(trigger) } : {}),
    ...(trigger && task.state === "operating" ? { statusLine: trigger.statusText } : {}),
    ...(progress ? { progress } : {}),
  };
}

function entryOf(item: BoardItem, progress: (task: Task) => TaskSummary["progress"]): BoardEntry {
  if (item.kind === "task") {
    const { task, activity, tokens, waitingForProject, trigger } = item;
    return taskSummary({ task, activity, tokens, waitingForProject, trigger, progress: progress(task) });
  }
  if (item.kind === "scheduled_job") {
    const { job, scheduleText, actions, tokens, grants, rules } = item.view;
    return {
      kind: "scheduled_job",
      id: job.id,
      title: job.title,
      status: job.state === "active" ? "active" : "paused",
      schedule: scheduleText,
      ...(job.projectName ? { project: job.projectName } : {}),
      ...(job.lastRun?.endedAt ? { lastRun: { at: job.lastRun.endedAt, ok: !job.lastFailed } } : {}),
      autoPaused: job.pausedBy === "failures",
      tokens,
      statusLine: item.view.statusText,
      ...(job.nextAt ? { nextAt: job.nextAt } : {}),
      actions,
      authorization: { grants, rules },
    };
  }
  const r = item.reminder;
  return {
    kind: "reminder",
    id: r.id,
    title: r.text,
    status: r.status === "fired" ? "fired" : "pending",
    cardId: r.cardId,
    nextAt: r.nextAt ?? r.lastFiredAt ?? r.updatedAt,
    ...(r.schedule ? { schedule: r.schedule } : {}),
    // 事件发生时提醒的（77 号票）：在等什么事件、最近一次是什么事件
    ...(r.event ? { waitingFor: describeEventTrigger(r.event) } : {}),
    ...(r.lastEvent ? { lastEvent: r.lastEvent } : {}),
  };
}

/** 原型的假条目：定时作业名下有了真的用量（19 号票带上作业身份之后）就用真的总量 */
function withJobTokens(e: BoardEntry, tokens: (jobId: string) => number): BoardEntry {
  if (e.kind !== "scheduled_job") return e;
  const real = tokens(e.id);
  return real > 0 ? { ...e, tokens: real } : e;
}

/** 看板的五组：前端状态层里的任务和简单提醒，加上原型还没接真数据的假条目 */
function useBoard() {
  const { ui } = useStore();
  const { proto } = useProto();
  return useMemo(
    () =>
      boardGroups(ui).map((g) => ({
        id: g.group,
        title: g.title,
        sub: g.sub,
        entries: [...g.items.map((it) => entryOf(it, (task) => taskBoardProgress(ui, task))), ...proto.board.filter((e) => groupOf(e) === g.group).map((e) => withJobTokens(e, (id) => jobTokenTotal(ui, id)))],
      })),
    [ui, proto.board],
  );
}

/** 看板卡、任务详情上按菜单规则看的任务：真任务就是看板频道上的 Task（运营中的定时任务带上它的触发能做的），原型的假条目按它的状态拼 */
function subjectOf(ui: UiState, t: TaskSummary): TaskMenuSubject {
  const task = ui.tasks[t.id];
  if (!task) return protoSubject(t);
  return { ...task, ...(t.status === "operating" && t.trigger ? { triggerActions: t.trigger.actions } : {}) };
}

/**
 * 要动手的那个任务（看板卡的菜单、任务详情的状态签和"⋯"共用）：真任务交给守护进程（task_action；定时触发的运营中时落到触发上；
 * 返工、从某阶段重做和阶段详情同一份 StageDetailSource）；原型的假任务在页面上演（prototype/proto-task-acts.ts）
 */
function useTaskTarget(): (t: TaskSummary) => TaskActsTarget {
  const { ui, taskAction, scheduledJobAction } = useStore();
  const { proto, update } = useProto();
  const toast = useToast();
  return (t) => {
    const task = ui.tasks[t.id];
    const trigger = t.trigger ? (a: ScheduledJobAction) => scheduledJobAction(t.trigger!.jobId, a) : undefined;
    if (task) {
      const act = (action: TaskAction, options?: { stageId?: string; note?: string }) => taskAction(t.id, action, options);
      return { title: t.title, act, trigger, stages: realStageSource(ui, task, act) };
    }
    const act = (action: TaskAction) => {
      const running = proto.board.filter((e) => e.kind === "task" && e.status === "running" && e.id !== t.id).length;
      const after = protoAfter(action, running);
      update((s) => ({
        ...s,
        board: s.board.map((e) => (e.kind === "task" && e.id === t.id ? { ...e, status: after.status, waitReason: undefined, ...(after.activity ? { activity: after.activity, activityNote: undefined } : {}) } : e)),
      }));
      toast(after.toast);
    };
    return { title: t.title, act, trigger, stages: protoStageSource(t, act) };
  };
}

/** 真任务的阶段（阶段详情、返工选阶段用）：状态层的阶段换成页面上的样子；能不能从这个阶段重做照 84 号票（开始过的阶段） */
function realStageSource(ui: UiState, task: Task, act: TaskActsTarget["act"], toolCalls: Record<string, number> = {}): StageDetailSource | undefined {
  const stages = taskStages(ui, task.id).map((s) => stageOf(s, toolCalls[s.stageId]));
  if (!taskHasStages(task, stages)) return undefined;
  return {
    taskId: task.id,
    stages,
    canRework: (stageId) => canReopenStage(task, stageId),
    rework: (stageId, text) => act("rework", { stageId, ...(text ? { note: text } : {}) }),
  };
}

/** 原型假任务的阶段：假详情里有就用，没有按"第 N/M 阶段"排出来（只够选阶段用）；没取消没归档的、开始过的阶段能重做 */
function protoStageSource(t: TaskSummary, act: TaskActsTarget["act"]): StageDetailSource | undefined {
  const detail = taskDetailOf(t.id).stages;
  const stages: Stage[] =
    detail.length > 0
      ? detail
      : (protoSubject(t).stages?.list ?? []).map((s, i) => ({
          id: s.stageId,
          title: `第 ${i + 1} 阶段`,
          status: s.state as Stage["status"],
          deliverable: "",
          acceptance: [],
          mode: "open",
          after: i > 0 ? [`s${i}`] : [],
          grants: [],
          rules: [],
          budget: { tokens: 0, toolCalls: 0 },
        }));
  if (stages.length === 0) return undefined;
  const reopenable = !["cancelled", "archived"].includes(t.status);
  return {
    taskId: t.id,
    stages,
    canRework: (stageId) => {
      const s = stages.find((x) => x.id === stageId);
      return reopenable && s !== undefined && stageStartedOf(s);
    },
    rework: () => act("rework"),
  };
}

/**
 * 看板。layout：宽屏 grid（每组里的卡排成多列网格，列数随宽度、卡片有最小宽度，样式在 pages.css 的 .board[data-layout="grid"]；
 * 看板一行一行的风格各自在 style.css 里排），窄屏 list（一列，和 88 号票之前一样）。滚动时报给任务页记下（onScrolled），
 * 从任务详情回来时照记下的（savedScroll）滚回去。
 * 90 号票：每组标题点一下收起 / 展开（按设备记住，默认已归档收起）；卡片长按 / 右键出菜单；多选（标题栏"多选"、菜单里"多选"进入，
 * 点卡片就是勾选，每组标题右边"全选"，底部操作栏）。简单提醒、还没迁移的定时作业卡不参与多选（没有批量的接口），多选时淡掉
 */
function Board({
  layout,
  job,
  savedScroll,
  onScrolled,
  onOpen,
}: {
  layout: "grid" | "list";
  job?: string | undefined;
  savedScroll(): number | undefined;
  onScrolled(top: number): void;
  onOpen(id: string): void;
}) {
  const { ui } = useStore();
  const groups = useBoard();
  const folded = useBoardFolded();
  const grid = layout === "grid";
  const ref = useRef<HTMLDivElement>(null);
  // 挂上时（从任务详情回来）滚回离开时的位置：没点名作业卡时才滚（state/task-page.ts 的 boardScrollOnReturn）。
  // 只在挂上时滚一次：挂着的时候点名了别的作业卡不再滚回去
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const top = boardScrollOnReturn({ job, saved: savedScroll() });
    if (top !== undefined && ref.current) ref.current.scrollTop = top;
  }, [job, savedScroll]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  // 多选时返回键（鸿蒙）先退出多选
  useBackLayer("overlay", selecting, stopSelecting);
  const acts = useTaskActs();
  const targetOf = useTaskTarget();
  // 勾上的只算看得见的：收起的组里的不算（归档了的挪进收起着的"已归档"，就不再算在"已选"里）
  const tasks = groups.filter((g) => !folded.has(g.id)).flatMap((g) => g.entries.filter((e): e is TaskSummary => e.kind === "task"));
  const picked: BatchEntry[] = tasks.filter((t) => selected.has(t.id)).map((t) => ({ id: t.id, title: t.title, subject: subjectOf(ui, t) }));
  const pick = (t: TaskSummary, item: TaskMenuItem) => {
    if (item.kind === "open") return onOpen(t.id);
    if (item.kind === "select") {
      setSelecting(true);
      setSelected(new Set([t.id]));
      return;
    }
    acts.run(targetOf(t), item);
  };
  const card = (t: TaskSummary): CardChoice => ({
    menu: taskMenu(subjectOf(ui, t), "board"),
    onPick: (item) => pick(t, item),
    selecting,
    checked: selected.has(t.id),
    onToggle: () => setSelected((s) => toggleSelected(s, t.id)),
  });
  return (
    <div className="chat-col">
      <TopBar title="任务看板">
        <button type="button" className={`btn small ${selecting ? "primary" : "ghost"} board-select-btn`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          多选
        </button>
        <StartTaskButton compact />
      </TopBar>
      <div ref={ref} className={`scroll board${selecting ? " selecting" : ""}`} data-layout={grid ? "grid" : undefined} onScroll={(e) => onScrolled(e.currentTarget.scrollTop)}>
        {groups.map((g) => {
          const { entries } = g;
          const collapsed = folded.has(g.id);
          const ids = entries.filter((e) => e.kind === "task").map((e) => e.id);
          const all = groupSelection(selected, ids).all;
          return (
            <section key={g.id} className={`bgroup bg-${g.id}${collapsed ? " folded" : ""}`}>
              <div className="bgroup-h">
                <button type="button" className="bgroup-fold" onClick={() => pageBoardFold().toggle(g.id)} aria-expanded={!collapsed}>
                  <b>{g.title}</b>
                  <span className="muted">{g.sub}</span>
                  <span className="bgroup-n">{entries.length}</span>
                  <span className="bgroup-caret" aria-hidden="true">
                    {collapsed ? "▸" : "▾"}
                  </span>
                </button>
                {selecting && !collapsed && ids.length > 0 && (
                  <button type="button" className="link bgroup-all" onClick={() => setSelected((s) => groupSelection(s, ids).next)}>
                    {all ? "取消全选" : "全选"}
                  </button>
                )}
              </div>
              {!collapsed &&
                entries.map((e) =>
                  e.kind === "task" && e.trigger ? (
                    <TimedTaskCard key={e.id} task={e} onOpen={() => onOpen(e.id)} choice={card(e)} />
                  ) : e.kind === "task" ? (
                    <TaskCard key={e.id} task={e} onOpen={() => onOpen(e.id)} choice={card(e)} />
                  ) : e.kind === "reminder" ? (
                    <ReminderCard key={e.id} r={e} selecting={selecting} />
                  ) : (
                    <ScheduledJobCard key={e.id} j={e} on={job === e.id} selecting={selecting} />
                  ),
                )}
              {!collapsed && entries.length === 0 && <div className="muted bgroup-empty">没有</div>}
            </section>
          );
        })}
      </div>
      {selecting && <BoardSelectBar entries={picked} onDone={stopSelecting} />}
      {acts.dialogs}
    </div>
  );
}

/** 看板上一张任务卡的菜单和多选：菜单项、点了一项；多选时勾没勾上、点一下勾上 / 去掉 */
interface CardChoice {
  readonly menu: readonly TaskMenuItem[];
  onPick(item: TaskMenuItem): void;
  readonly selecting: boolean;
  readonly checked: boolean;
  onToggle(): void;
}

/**
 * 任务卡的长按 / 右键菜单（贴着卡片弹出，anchor 是卡片）和多选：多选时点卡片是勾选、不出菜单；平时点卡片打开。
 * 返回挂到卡片上的东西：手势、点击、勾选框、菜单
 */
function useCardChoice(choice: CardChoice, onOpen: () => void, anchor: RefObject<HTMLElement | null>) {
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true), { disabled: choice.selecting });
  return {
    press,
    activate: choice.selecting ? choice.onToggle : onOpen,
    checkbox: choice.selecting && (
      <span className={`bsel${choice.checked ? " on" : ""}`} aria-hidden="true">
        {choice.checked ? "✓" : ""}
      </span>
    ),
    popup: menu && <TaskMenuPopup anchor={anchor} align="start" items={choice.menu} onPick={choice.onPick} onClose={() => setMenu(false)} />,
  };
}

export function statusText(t: TaskSummary): string {
  if (t.statusLine) return t.statusLine;
  if (t.status === "waiting_for_user" && t.waitReason) return `等我 · ${WAIT_REASON_LABEL[t.waitReason]}`;
  if (t.status === "awaiting_confirm") return "待确认 · 计划等你确认";
  if (t.status === "done" && t.endNote) return `已完成 · ${t.endNote}`;
  return TASK_STATUS_LABEL[t.status];
}

// 看板上的几种卡：标题下面状态所在的那一行挂 bcard-status-row，token、时间表、下一次这些数字挂 bcard-num——
// 经典不认这两个类名，是给视觉风格下样式用的（39 号票的规矩：补 class，不改结构；夜航仪表按它们把状态排到右上角、数字用等宽字）
function TaskCard({ task: t, onOpen, choice }: { task: TaskSummary; onOpen(): void; choice: CardChoice }) {
  const ref = useRef<HTMLButtonElement>(null);
  const c = useCardChoice(choice, onOpen, ref);
  return (
    <button
      ref={ref}
      type="button"
      className={`bcard bcard-task${choice.checked ? " picked on" : ""}`}
      aria-pressed={choice.selecting ? choice.checked : undefined}
      onClick={c.activate}
      {...c.press}
    >
      {c.popup}
      <div className="bcard-row">
        {c.checkbox}
        <span className={`chip kind-chip kind-${t.taskKind ?? "long_running"}`}>{TASK_KIND_LABEL[t.taskKind ?? "long_running"]}</span>
        <span className="bcard-title">{t.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className={`st st-${t.status}`}>{statusText(t)}</span>
        {t.progress && <TaskProgress progress={t.progress} />}
        {t.tokens !== undefined && <span className="bcard-num">{tokensLabel(t.tokens)} token</span>}
      </div>
      {t.waitNote && (
        <div className="bcard-meta">
          <span className="muted">{t.waitNote}</span>
        </div>
      )}
      <div className="bcard-meta">
        <ActivityDot state={t.activity} note={t.activityNote} />
        {t.projects.map((p) => (
          <span key={p} className="chip">
            {p}
          </span>
        ))}
      </div>
    </button>
  );
}

/**
 * 定时触发的任务的卡（76 号票）：种类签、"定时"签、状态（运营中、已暂停及原因；结束了的写任务的状态）、时间表、下一次、token，
 * 最近一次运行的结果（失败的醒目），能暂停、恢复、取消（取消先确认）。点卡片打开任务详情，点按钮不打开。
 * 事件触发的（77 号票）："事件"签，写在等什么事件、最近一次触发是什么事件
 */
function TimedTaskCard({ task: t, onOpen, choice }: { task: TaskSummary; onOpen(): void; choice: CardChoice }) {
  const trigger = t.trigger!;
  const ref = useRef<HTMLDivElement>(null);
  const c = useCardChoice(choice, onOpen, ref);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={`bcard bcard-task bcard-timed${choice.checked ? " picked on" : ""}`}
      aria-pressed={choice.selecting ? choice.checked : undefined}
      onClick={c.activate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        c.activate();
      }}
      {...c.press}
    >
      {c.popup}
      <div className="bcard-row">
        {c.checkbox}
        <span className={`chip kind-chip kind-${t.taskKind ?? "plain"}`}>{TASK_KIND_LABEL[t.taskKind ?? "plain"]}</span>
        <span className={`chip trigger-chip${trigger.waitingFor ? " trigger-event" : ""}`}>{trigger.waitingFor ? "事件" : "定时"}</span>
        <span className="bcard-title">{t.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className={`st ${t.status !== "operating" ? `st-${t.status}` : trigger.active ? "st-ops" : "st-paused"}`}>{statusText(t)}</span>
        {!trigger.waitingFor && <span className="bcard-num">{trigger.schedule}</span>}
        {t.status === "operating" && trigger.nextAt && <span className="bcard-num">下次 {timeLabel(trigger.nextAt)}</span>}
        {t.tokens !== undefined && <span className="bcard-num">{tokensLabel(t.tokens)} token</span>}
      </div>
      {t.progress && (
        <div className="bcard-meta">
          <TaskProgress progress={t.progress} />
        </div>
      )}
      {/* 事件触发的（77 号票）：在等什么事件、最近一次触发 */}
      {trigger.waitingFor && <div className="bcard-waiting">在等：{trigger.waitingFor}</div>}
      {trigger.lastTrigger && (
        <div className="bcard-waiting muted">
          最近一次触发：{trigger.lastTrigger.summary} · {timeLabel(trigger.lastTrigger.at)}
        </div>
      )}
      <div className="bcard-meta">
        {trigger.lastRun ? (
          <span className={trigger.lastRun.ok ? "muted" : "chip chip-no"}>{trigger.lastRun.text}</span>
        ) : (
          <span className="muted">{trigger.waitingFor ? "还没等到事件" : "还没运行过"}</span>
        )}
        {t.projects.map((p) => (
          <span key={p} className="chip">
            {p}
          </span>
        ))}
      </div>
      {t.status === "operating" && trigger.actions.length > 0 && !choice.selecting && (
        <div className="bcard-meta">
          <TriggerActions jobId={trigger.jobId} title={t.title} actions={trigger.actions} />
        </div>
      )}
    </div>
  );
}

/** 定时触发的任务的暂停、恢复、取消（看板卡、任务详情共用；取消先确认：任务一起取消） */
function TriggerActions({ jobId, title, actions }: { jobId: string; title: string; actions: readonly ScheduledJobAction[] }) {
  const { scheduledJobAction } = useStore();
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (actions.length === 0) return null;
  return (
    // 在看板卡上：点按钮不打开详情
    <span className="trigger-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {actions
        .filter((a) => a !== "cancel")
        .map((a) => (
          <button key={a} type="button" className="btn ghost small" onClick={() => scheduledJobAction(jobId, a)}>
            {SCHEDULED_JOB_ACTION_LABEL[a]}
          </button>
        ))}
      {actions.includes("cancel") && (
        <button type="button" className="btn ghost small" onClick={() => setConfirmCancel(true)}>
          {SCHEDULED_JOB_ACTION_LABEL.cancel}
        </button>
      )}
      {confirmCancel && (
        <Sheet title="取消这个定时的任务？" onClose={() => setConfirmCancel(false)} center>
          <div className="modal-body">
            <p>取消后「{title}」不再运行，任务一起取消（在看板的最近结束里）；会话和每次运行的记录保留。想先停一停可以用"暂停"。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>
              先不取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirmCancel(false);
                scheduledJobAction(jobId, "cancel");
              }}
            >
              {SCHEDULED_JOB_ACTION_LABEL.cancel}
            </button>
          </div>
        </Sheet>
      )}
    </span>
  );
}

/**
 * 简单提醒卡：长按 / 右键菜单里"改…"（弹出提醒卡，在卡上改时间）、"取消提醒"（落在提醒卡上，90 号票）；原型的假提醒没有卡，没有菜单。
 * 多选时淡掉（不参与多选）
 */
function ReminderCard({ r, selecting }: { r: ReminderSummary; selecting: boolean }) {
  const { cardAction } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const canAct = r.cardId !== undefined && r.status === "pending";
  const press = useLongPress(() => setMenu(true), { disabled: selecting || !canAct });
  return (
    <div ref={ref} className="bcard bcard-static" {...press}>
      {menu && r.cardId && (
        <PopupMenu anchor={ref} align="start" className="row-menu task-menu" onClose={() => setMenu(false)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setEditing(true);
            }}
          >
            改…
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => {
              setMenu(false);
              if (r.cardId) cardAction(r.cardId, "cancel_reminder");
            }}
          >
            取消提醒
          </button>
        </PopupMenu>
      )}
      {editing && r.cardId && (
        <Sheet title="改提醒" onClose={() => setEditing(false)} center>
          <CardPanel cardId={r.cardId} />
        </Sheet>
      )}
      <div className="bcard-row">
        <span className="bcard-title">⏰ {r.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className="st st-ops">{r.status === "fired" ? `简单提醒 · ${REMINDER_STATUS_LABEL.fired}` : `运营中 · ${REMINDER_STATUS_LABEL.pending}`}</span>
        {r.schedule ? <span className="bcard-num">{isRepeating(r.schedule) ? describeSchedule(r.schedule) : "一次性"}</span> : <span>事件发生时</span>}
        {r.schedule ? <span className="bcard-num">{r.status === "fired" ? timeLabel(r.nextAt) : `下次 ${timeLabel(r.nextAt)}`}</span> : null}
      </div>
      {/* 事件发生时提醒的（77 号票）：在等什么事件、最近一次 */}
      {r.waitingFor && <div className="bcard-waiting">在等：{r.waitingFor}</div>}
      {r.lastEvent && (
        <div className="bcard-waiting muted">
          最近一次：{r.lastEvent} · {timeLabel(r.nextAt)}
        </div>
      )}
    </div>
  );
}

/** 作业卡（19 号票）：状态（运营中、已暂停及原因）、时间表、下一次、属于哪个项目、"最近一次失败"；真作业可以暂停、恢复、取消 */
function ScheduledJobCard({ j, on, selecting }: { j: ScheduledJobSummary; on: boolean; selecting: boolean }) {
  const { scheduledJobAction } = useStore();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [menu, setMenu] = useState(false);
  const ref = useRevealed<HTMLDivElement>(on);
  const actions = j.actions ?? [];
  // 长按 / 右键菜单（90 号票）：和卡上的按钮一样的暂停、恢复、取消（取消先确认）
  const press = useLongPress(() => setMenu(true), { disabled: selecting || actions.length === 0 });
  return (
    <div ref={ref} className={`bcard bcard-static${on ? " on" : ""}`} {...press}>
      {menu && (
        <PopupMenu anchor={ref} align="start" className="row-menu task-menu" onClose={() => setMenu(false)}>
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              role="menuitem"
              className={a === "cancel" ? "danger-text" : undefined}
              onClick={() => {
                setMenu(false);
                if (a === "cancel") setConfirmCancel(true);
                else scheduledJobAction(j.id, a);
              }}
            >
              {SCHEDULED_JOB_ACTION_LABEL[a]}
            </button>
          ))}
        </PopupMenu>
      )}
      <div className="bcard-row">
        <span className="bcard-title">🔁 {j.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className={`st ${j.status === "active" ? "st-ops" : "st-paused"}`}>定时作业 · {j.statusLine ?? scheduledJobStatusLabel(j)}</span>
        <span className="bcard-num">{j.schedule}</span>
        {j.nextAt && <span className="bcard-num">下次 {timeLabel(j.nextAt)}</span>}
        {j.tokens !== undefined && <span className="bcard-num">{tokensLabel(j.tokens)} token</span>}
        {j.project && <span className="chip">{j.project}</span>}
        {j.lastRun && !j.lastRun.ok && <span className="chip chip-no">{LAST_RUN_FAILED_LABEL}</span>}
      </div>
      {j.authorization && <JobAuthorization grants={j.authorization.grants} rules={j.authorization.rules} />}
      {actions.length > 0 && !selecting && (
        <div className="bcard-meta">
          {actions
            .filter((a) => a !== "cancel")
            .map((a) => (
              <button key={a} type="button" className="btn ghost small" onClick={() => scheduledJobAction(j.id, a)}>
                {SCHEDULED_JOB_ACTION_LABEL[a]}
              </button>
            ))}
          {actions.includes("cancel") && (
            <button type="button" className="btn ghost small" onClick={() => setConfirmCancel(true)}>
              {SCHEDULED_JOB_ACTION_LABEL.cancel}
            </button>
          )}
        </div>
      )}
      {confirmCancel && (
        <Sheet title="取消这个定时作业？" onClose={() => setConfirmCancel(false)} center>
          <div className="modal-body">
            <p>取消后「{j.title}」不再运行，也不再出现在看板上；运行记录保留。想先停一停可以用"暂停"。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>
              先不取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirmCancel(false);
                scheduledJobAction(j.id, "cancel");
              }}
            >
              {SCHEDULED_JOB_ACTION_LABEL.cancel}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ---------- 任务详情 ----------

function TaskDetail({ taskId, wide, onBack }: { taskId: string; wide: boolean; onBack?: () => void }) {
  const { ui } = useStore();
  const task = selectTask(ui, taskId);
  if (task) return <RealTaskDetail task={task} activity={agentActivity(ui, task.maintainerId)} wide={wide} onBack={onBack} />;
  return <ProtoTaskDetail taskId={taskId} wide={wide} onBack={onBack} />;
}

/**
 * 状态层里的阶段换成阶段抽屉组件用的样子（验收结果写成通过 / 没通过，原因附在后面）；toolCalls 是这个阶段用了几次工具调用
 * （stageToolCalls，60 号票：授权和用量里的"工具调用 N/M"）
 */
function stageOf(s: StageView, toolCalls: number | undefined): Stage {
  return {
    id: s.stageId,
    title: s.title,
    status: s.state,
    deliverable: s.deliverables.join("；"),
    acceptance: s.acceptance.map((a) => ({ text: a.criterion, method: a.method, ...(a.result ? { result: a.result.passed ? "pass" : "fail" } : {}), ...(a.result?.note ? { note: a.result.note } : {}) })),
    mode: s.mode,
    ...(s.steps.length > 0 ? { steps: s.steps } : {}),
    after: s.dependsOn,
    ...(s.code === undefined ? {} : { code: s.code }),
    grants: s.grants,
    rules: s.rules,
    budget: {
      tokens: s.budget?.tokens ?? 0,
      toolCalls: s.budget?.toolCalls ?? 0,
      ...(s.budget ? { usedTokens: s.budget.usedTokens, usedToolCalls: toolCalls ?? 0 } : {}),
    },
    ...(s.attempts > 0 ? { attempts: s.attempts } : {}),
    ...(s.waitReason ? { waitReason: s.waitReason } : {}),
    ...(s.waitNote ? { waitNote: s.waitNote } : {}),
    // 84 号票：阶段详情的执行方式理由和初步思路、"从这里重做"、要你留意的、点进规则详情
    ...(s.modeReason ? { modeReason: s.modeReason } : {}),
    ...(s.roughIdea ? { roughIdea: s.roughIdea } : {}),
    started: s.started,
    marks: s.marks,
    ruleDocs: s.ruleDocs,
  };
}

/**
 * 阶段抽屉全开、宽屏阶段栏下面那一行：这个任务执行中出过的状况，每类几次，点一个在详情栏看是哪几次（AgentSense drawer.tsx 的 Counts）；
 * 阶段标签刚被拉回、拦下、你拒绝时闪一下（AgentSense 的 fx-ping）。按这个任务的整段会话算
 */
function useStageIncidents(
  conversation: ConversationId | undefined,
  taskId: string,
  show: (target: DetailTarget) => void,
): { counts: ReactNode; ping: GuardPingKind | undefined; items: readonly ChatItem[] } {
  const { ui } = useStore();
  const items = useMemo(() => (conversation ? chatItems(ui, conversation) : []), [ui, conversation]);
  const incidents = useMemo(() => taskIncidents(ui, items, taskId), [ui, items, taskId]);
  const ping = usePing(latestGuardPing(items, taskId));
  return { counts: <IncidentCounts list={incidents} onPick={(kind) => show({ type: "incidents", taskId, kind })} />, ping, items };
}

/**
 * 真任务的详情（13 号票）：维护者会话（直接下指令；它在干活时你的话作为插话，在它下一步之前插入）、阶段抽屉、计划卡。
 * 90 号票：顶部并成一行（ui/task-head.tsx）——状态签点开是原因说明、用量和这个状态能做的按钮，宽屏标题栏上一个关键按钮，
 * "⋯"里是计划、工单、工具包、消耗、运行（在详情栏打开）和任务操作；会话占满
 */
function RealTaskDetail({ task, activity, wide, onBack }: { task: Task; activity: AgentActivity; wide: boolean; onBack?: () => void }) {
  const { ui, taskAction, scheduledJobAction, watchChannels } = useStore();
  const conversation = maintainerChannel(task.maintainerId);
  // 打开详情时订阅它的维护者会话（订阅过的一直保留）
  useEffect(() => watchChannels([conversation]), [watchChannels, conversation]);
  // 这个任务开始以来的会话历史都取回来（60 号票）：进度、偏差、阶段详情、出过的状况按整段会话算，数字不随往上翻变；
  // 定时触发的流程只要这一次运行那一段
  useTaskHistory(conversation, isPlainTask(task) ? undefined : (workflowCurrentRun(ui, task.id)?.queuedAt ?? task.createdAt));
  const views = useMemo(() => taskStages(ui, task.id), [ui, task.id]);
  const stages = useMemo(() => {
    const calls = stageToolCalls(ui, conversation, task.id);
    return views.map((s) => stageOf(s, calls[s.stageId]));
  }, [ui, views, task.id, conversation]);
  const [conversationRef, detail] = useConversationPane(wide, conversation);
  const usage = useMemo(() => taskUsage(ui, task.id), [ui, task.id]);
  const orders = useMemo(() => taskWorkOrders(ui, task.id), [ui, task.id]);
  // 定时触发的任务（76 号票）：它的触发登记和每一次运行
  const trigger = taskTriggerView(ui, task.id);
  const runs = useMemo(() => taskRunViews(ui, task.id), [ui, task.id]);
  const timed = isTriggered(task);
  // 流程（60 号票）：标题栏的进度条（做完的步骤 / 总步数，定时触发的按这一次运行），点开是计划台账
  const progress = workflowProgress(ui, task.id);
  const [ledger, setLedger] = useState(false);
  const summary = taskSummary({ task, activity, tokens: usage.total, waitingForProject: taskWaitingForProject(ui, task.id), trigger, progress: taskBoardProgress(ui, task) });
  // 流程（58 号票）只有一个内部的执行阶段，不显示阶段，显示步骤
  const workflow = taskKind(task) === "workflow";
  const hasStages = taskHasStages(task, stages);
  // 普通任务（75 号票）：只有会话和工具调用详情，没有计划、工具包、工单、消耗那些
  const plain = isPlainTask(task);
  const act = (action: TaskAction, options?: { stageId?: string; note?: string }) => taskAction(task.id, action, options);
  // 阶段详情（60 号票）：点阶段抽屉、阶段栏里的一个阶段打开；"从这里重做"就是返工这个阶段（连同下游），
  // 84 号票起照 AgentSense 开始过的阶段就能（建好了阶段、没取消没归档的长程任务都行）
  const stageSource: StageDetailSource | undefined = hasStages
    ? { taskId: task.id, stages, canRework: (stageId) => canReopenStage(task, stageId), rework: (stageId, text) => act("rework", { stageId, ...(text ? { note: text } : {}) }) }
    : undefined;
  // 阶段抽屉、阶段栏下面那一行出过的状况，阶段标签刚被拉回时闪一下（60 号票，照 AgentSense）
  const { counts, ping, items } = useStageIncidents(conversation, task.id, detail.show);
  // 计划栏（91 号票，照 AgentSense 的长程任务）：依赖图（等你确认的计划也画），阶段标签跟着聊天滚动变，点卡片在详情栏看阶段详情，
  // 宽屏分界线能拖；窄屏是阶段抽屉。阶段标签（88 号票）宽屏在标题栏左边、正在阶段栏上方，窄屏在右边
  const graph = useMemo(() => taskStageGraph(ui, task.id, items), [ui, task.id, items]);
  const stepAt = useMemo(() => stageAtItems(ui, items, task.id), [ui, items, task.id]);
  const stagePanel = useStagePanel({ wide, taskId: task.id, graph, progress: stageProgress(stages), show: detail.show, counts, ping, stepAt, lastItemId: items.at(-1)?.id });
  const chipPlace = stageChipPlace(wide);
  // 任务操作（90 号票）：状态签浮层、"⋯"的下半、宽屏标题栏的关键按钮是同一份；定时触发的任务运营中时落到它的触发上
  const acts = useTaskActs();
  const subject: TaskMenuSubject = { ...task, ...(task.state === "operating" && trigger ? { triggerActions: trigger.actions } : {}) };
  const target: TaskActsTarget = { title: task.title, act, trigger: trigger ? (a) => scheduledJobAction(trigger.job.id, a) : undefined, stages: stageSource };
  const panel = (p: TaskPanel): ReactNode => {
    switch (p) {
      case "plan":
        return (
          <div className="td-panel">
            <div className="muted">{task.summary}</div>
            <ConvertToProject task={task} />
            {task.planCardId ? (
              <CardPanel cardId={task.planCardId} />
            ) : (
              <div className="page-placeholder">
                <span>
                  还没有计划：<AssistantName />正在和你对齐意图，之后执行的维护者起草计划。
                </span>
              </div>
            )}
            {hasStages && (
              <Section title="阶段">
                {stages.map((s) => (
                  <div key={s.id} className="card">
                    <StageCard stages={stages} id={s.id} />
                  </div>
                ))}
              </Section>
            )}
            <Section title="范围记录">
              <ScopeRecordList groups={taskScopeRecords(ui, task.id)} empty="没有。维护者压缩会话（项目的任务：每张工单结束）时做范围审视，越界和你授权过的范围变更记在这里。" />
            </Section>
          </div>
        );
      case "orders":
        return <TaskWorkOrders orders={orders} />;
      case "toolkit":
        return <TaskToolkit task={task} />;
      case "usage":
        return <TaskUsage usage={usage} />;
      case "runs":
        return <TaskRuns runs={runs} workflow={workflow} evented={summary.trigger?.waitingFor !== undefined} />;
    }
  };

  return (
    <DetailLayout wide={wide} detail={detail} conversation={conversation} stages={stageSource} panel={panel}>
      <div className="chat-col">
        <TaskHead
          wide={wide}
          title={task.title}
          onBack={onBack}
          chip={stagePanel.chip}
          chipPlace={chipPlace}
          // 流程：做完的步骤 / 总步数，点开是计划台账（照 AgentSense 固定计划会话的标题栏）
          progress={workflow && progress && <PlanProgress progress={progress} onOpen={() => setLedger(true)} />}
          // 任务会话：对话层不显示 ▤，缩小后才出现（照 AgentSense 的里程碑会话；固定计划的会话一直显示）
          zoom={<ZoomToggle handle={conversationRef} onlyZoomedOut={!workflow} />}
          // 定时触发的任务运营中时，状态跟着它的触发：运营中用运营中的颜色，暂停着的灰
          status={{ text: statusText(summary), tone: task.state === "operating" && summary.trigger ? (summary.trigger.active ? "st-ops" : "st-paused") : `st-${task.state}` }}
          activity={{ state: summary.activity, note: summary.activityNote }}
          note={taskStatusNote(task)}
          meta={
            <>
              {/* 任务的种类（58 号票）：建卡时定下，不能换 */}
              <span className={`chip kind-chip kind-${taskKind(task)}`}>{TASK_KIND_LABEL[taskKind(task)]}</span>
              {/* 项目内部任务（64 号票）：不在全局看板上，从项目页的"内部任务"一栏点进来 */}
              {task.internal && (
                <a className="chip" href={toHash({ tab: "projects", projectId: task.internal.projectId })}>
                  {internalScopeLabel(task.internal.projectName)}
                </a>
              )}
              {summary.stage && (
                <span className="muted">
                  第 {summary.stage.current}/{summary.stage.total} 阶段
                </span>
              )}
              {/* 定时触发（76 号票）：时间表、下一次；事件触发（77 号票）：在等什么事件 */}
              {timed && summary.trigger && (
                <>
                  <span className={`chip trigger-chip${summary.trigger.waitingFor ? " trigger-event" : ""}`}>
                    {summary.trigger.waitingFor ? `事件 · ${summary.trigger.waitingFor}` : `定时 · ${summary.trigger.schedule}`}
                  </span>
                  {task.state === "operating" && summary.trigger.nextAt && <span className="muted">下次 {timeLabel(summary.trigger.nextAt)}</span>}
                </>
              )}
            </>
          }
          tokens={usage.total}
          items={taskMenu(subject, "detail")}
          keyItem={taskKeyItem(subject)}
          panels={taskPanels({ plain, timed, orders: orders.length, runs: runs.length })}
          onPanel={(p) => detail.show({ type: "panel", taskId: task.id, panel: p })}
          onPick={(item) => acts.run(target, item)}
        />
        {ledger && (
          <PlanTimeline
            taskId={task.id}
            conversation={conversation}
            onClose={() => setLedger(false)}
            onOpen={(t) => {
              if ("itemId" in t) detail.open(t.itemId);
              else detail.show({ type: "plan", cardId: t.cardId });
            }}
          />
        )}
        {stagePanel.drawer}
        <div className="chat-row">
          {stagePanel.side}
          <div className="chat-row-main" onPointerDownCapture={stagePanel.onChatPointerDown}>
            <Conversation
              conversation={conversation}
              mode="maintainer"
              wide={wide}
              onDetail={detail.open}
              {...stagePanel.chat}
              ref={conversationRef}
              // 流程（60 号票）：历史底部"接下来的计划"虚线框
              workflowTaskId={workflow ? task.id : undefined}
              readOnly={!taskAcceptsMessages(task)}
              readOnlyNote={task.state === "done" && !plain ? "任务已完成，不再收消息；要返工点右上角“⋯”里的“返工…”" : "任务已结束，会话只读"}
              // 项目内部的普通任务：发的话带上任务编号，做完了在这里接着说，守护进程认得出说的是这件事
              taskId={plain && task.internal ? task.id : undefined}
              composerPlaceholder={timed && task.state === "operating" ? "改每次要做的事、补充要求：之后的运行照新的做…" : plain ? (task.state === "done" ? "接着说，它就接着做…" : "给它补充、改要求…") : undefined}
            />
          </div>
        </div>
        {acts.dialogs}
      </div>
    </DetailLayout>
  );
}

/**
 * 任务详情的"工具包"一栏（27 号票）：任务的授权里的工具包，直接改（不出计划变更卡）；执行时用的是它和项目工具包的交集。
 * 计划确认之前还没有；任务结束了只读
 */
function TaskToolkit({ task }: { task: Task }) {
  const { ui } = useStore();
  const toolkit = taskToolkit(ui, task.id);
  const ended = ENDED_TASK_STATES.includes(task.state);
  return (
    <div className="td-panel">
      {toolkit ? (
        <>
          <ToolkitPanel target={{ kind: "task", taskId: task.id }} toolkit={toolkit} readOnly={ended} readOnlyNote="任务已结束：工具包不能改" />
          {taskProjectScope(task) === "multi" ? (
            <div className="muted">涉及多个项目的任务：这里是各项目的维护者做工单时的授权（和各自项目工具包的交集）；任务自己的维护者工具包固定，只能读项目档案、派工单、汇总回执，不随这里变。</div>
          ) : (
            task.projects.length > 0 && <div className="muted">涉及项目的任务：执行时能用的是这里和项目工具包的交集，项目工具包里没有的这里加了也没有。</div>
          )}
        </>
      ) : (
        <div className="page-placeholder">还没有工具包：计划确认之后才有（维护者在计划里提议，你确认时生效）。</div>
      )}
    </div>
  );
}

/**
 * 定时触发的任务详情的"运行"一栏（76 号票）：每一次运行，新的在前——第几次、怎么触发的（排队合并成一批的逐条列出）、结果、
 * 失败、中断、没运行的原因；流程这次运行各步的状态。事件触发的（77 号票）写明是哪一批事件触发的，每个事件连同事件里的值
 */
function TaskRuns({ runs, workflow, evented }: { runs: RunView[]; workflow: boolean; evented: boolean }) {
  return (
    <div className="td-panel">
      <div className="muted">
        每被触发一次是一次运行；各次运行接着同一段会话，会话里每次运行开始处有一条分隔线（缩小后按运行分块）。上一次还没跑完时又来的触发合成一批，交给下一次运行。
        {workflow ? "每次运行都照授权的计划逐步做、逐步核对。" : ""}
      </div>
      {runs.length === 0 && <div className="page-placeholder">{evented ? "还没运行过：等的事件来了才运行。" : "还没运行过：到点才运行。"}</div>}
      {runs.map((r) => (
        <div key={r.runId} className={`run-row run-${r.state}`}>
          <div className="run-head">
            <b>第 {r.no} 次运行</b>
            <span className={`st run-st-${r.state}`}>{r.stateText}</span>
            {r.steps && (
              <span className="muted">
                做完 {r.steps.done}/{r.steps.total} 步
              </span>
            )}
            {r.startedAt && <span className="muted">{timeLabel(r.startedAt)}</span>}
          </div>
          {r.events.length > 0 ? (
            // 事件触发的（77 号票）：这一批事件，每个连同事件里的值（交给 agent 的就是这些）
            <div className="run-events">
              <div className="muted">{r.events.length > 1 ? `这一批 ${r.events.length} 个事件触发：` : "触发它的事件："}</div>
              {r.events.map((e, i) => (
                <div key={`${e.at}${i}`} className="run-event">
                  <div>
                    {r.events.length > 1 && <span className="step-id">{i + 1}</span>}
                    {e.summary}
                    <span className="muted"> · {timeLabel(e.at)}</span>
                  </div>
                  {e.values.length > 0 && (
                    <dl className="run-event-values">
                      {e.values.map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">{r.trigger}</div>
          )}
          {r.events.length === 0 && r.triggers.length > 1 && (
            <ul className="plain-list run-triggers">
              {r.triggers.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          {r.reason && <div className="run-reason">{r.reason}</div>}
          {r.summary && <div className="run-summary">{r.summary}</div>}
          {r.stepList && (
            <ol className="plan-steps td-steps">
              {r.stepList.map((s) => (
                <li key={s.stepId} className={`step step-${s.state}`}>
                  <span className="step-icon">{WORKFLOW_STEP_ICON[s.state]}</span>
                  <div className="step-body">
                    <div className="step-title">
                      <span className="step-id">{s.stepId}</span>
                      {s.title}
                      <span className="muted">（{WORKFLOW_STEP_STATE_LABEL[s.state]}）</span>
                    </div>
                    {s.gist && <div className="step-gist">{s.gist}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

/** 任务详情的"工单"一栏（17 号票）：这个任务的全部工单，按所属阶段；回执和提问在会话里 */
function TaskWorkOrders({ orders }: { orders: TaskWorkOrderView[] }) {
  return (
    <div className="td-panel">
      <div className="muted">本任务的所有工单（含建出了还没派出的）。工单不在看板上单独占卡；回执和项目维护者的提问在会话里。</div>
      {orders.map((v) => (
        <div key={v.workOrder.id} className="wo-row">
          <b>{v.workOrder.id}</b>
          <span className="wo-title">{v.workOrder.title}</span>
          <span className="chip">{v.project}</span>
          {v.unplanned && <span className="chip chip-op">计划外</span>}
          <span className={`st wo-${v.workOrder.outcome ?? v.workOrder.state}`}>{v.status}</span>
          {v.stage && <span className="muted">{v.stage}</span>}
          {v.workOrder.reason && <span className="muted">{v.workOrder.reason}</span>}
        </div>
      ))}
    </div>
  );
}

/** 任务详情的"消耗"一栏：按 agent 细分（维护者、评审子 agent、并行子 agent 各一行，范围审视单独一行），合计就是任务卡上的总量 */
function TaskUsage({ usage }: { usage: ReturnType<typeof taskUsage> }) {
  return (
    <div className="td-panel">
      <Section title={`token 合计 ${tokensLabel(usage.total)}`}>
        {usage.rows.length === 0 ? (
          <div className="muted">还没有模型调用</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>agent</th>
                <th className="num">缓存命中</th>
                <th className="num">未命中</th>
                <th className="num">输出</th>
                <th className="num">合计</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {/* 角色名里秘书写名字占位（LEDGER_ROLE_LABEL），按现在的名字显示 */}
                    <NamedText text={r.label} />
                    <span className="muted"> · {r.calls} 次调用</span>
                  </td>
                  <td className="num">{tokensLabel(r.tokens.cacheHit)}</td>
                  <td className="num">{tokensLabel(r.tokens.cacheMiss)}</td>
                  <td className="num">{tokensLabel(r.tokens.output)}</td>
                  <td className="num">{tokensLabel(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint">
          每次模型调用都记一笔；{LEDGER_PURPOSE_LABEL.scope_review}、{LEDGER_PURPOSE_LABEL.compaction}会话的用量记在当时的维护者名下，各单独一行，算在合计里。成本的粗估在“更多 · 消耗”。
        </div>
      </Section>
    </div>
  );
}

/**
 * 转为项目（15 号票）：未结束、由自己的维护者执行的任务（不是某个项目的任务）可以转为项目。项目名由用户定
 * （预填任务标题，可以改；和已有的项目重名时守护进程拒绝，原因在底部提示）。项目以筹备中诞生，
 * 不新建维护者，原任务的维护者接着做立项问答；原任务以"已完成 · 已转为项目"结束
 */
function ConvertToProject({ task }: { task: Task }) {
  const { convertTaskToProject } = useStore();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(task.title);
  if (!UNFINISHED_TASK_STATES.includes(task.state) || !hasOwnMaintainer(task)) return null;
  return (
    <>
      <div className="auth-actions">
        <button type="button" className="btn ghost small" onClick={() => setConfirming(true)}>
          转为项目
        </button>
      </div>
      {confirming && (
        <Sheet title={`把「${task.title}」转为项目？`} onClose={() => setConfirming(false)} center>
          <div className="modal-body">
            <p>项目以筹备中诞生，这个任务的维护者接着和你做立项问答（同一个会话），最后交出立项书。任务以“已完成 · 已转为项目”结束。</p>
          </div>
          <label className="field">
            <span>项目名（不能和已有的项目重名）</span>
            <input value={name} maxLength={PROJECT_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!name.trim()}
              onClick={() => {
                setConfirming(false);
                convertTaskToProject(task.id, name.trim());
                toast(`「${task.title}」转为项目「${name.trim()}」：在项目列表里`);
              }}
            >
              转为项目
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * 原型的假任务详情（看板上还没接真数据的那些）：顶部和真任务一样并成一行（90 号票），菜单项按假任务的状态算，做了在页面上演
 * （prototype/proto-task-acts.ts）
 */
function ProtoTaskDetail({ taskId, wide, onBack }: { taskId: string; wide: boolean; onBack?: () => void }) {
  const { proto } = useProto();
  const task = proto.board.find((e): e is TaskSummary => e.kind === "task" && e.id === taskId);
  const detail = taskDetailOf(taskId);
  // 会话里每一条的详情（56 号票）
  const [conversationRef, pane] = useConversationPane(wide, detail.maintainer);
  const hasStages = detail.stages.length > 0;
  // 阶段抽屉、阶段栏下面那一行出过的状况，阶段标签刚被拉回时闪一下（60 号票）
  const { counts, ping, items } = useStageIncidents(detail.maintainer, taskId, pane.show);
  // 计划栏（91 号票）：照假阶段画依赖图，出过的状况从假会话里数
  const { ui } = useStore();
  const graph = useMemo(() => listedStageGraph(ui, items, taskId, detail.stages, detail.planCardId), [ui, items, taskId, detail.stages, detail.planCardId]);
  const stepAt = useMemo(() => stageAtItems(ui, items, taskId), [ui, items, taskId]);
  // 会话按阶段成框：原型照假阶段、假的活动状态
  const chatList = useMemo(() => detail.stages.map((s) => ({ id: s.id, title: s.title, after: s.after, state: s.status, waitReason: s.waitReason })), [detail.stages]);
  const stagePanel = useStagePanel({
    wide,
    taskId,
    graph,
    progress: stageProgress(detail.stages),
    show: pane.show,
    counts,
    ping,
    stepAt,
    lastItemId: items.at(-1)?.id,
    chatStages: { list: chatList, running: task?.activity === "working" },
  });
  const targetOf = useTaskTarget();
  const acts = useTaskActs();
  if (!task) return <div className="page-placeholder">没有这个任务</div>;

  // 阶段详情（60 号票）：原型的假任务照真任务的规矩——建好了阶段、没取消没归档的，开始过的阶段能从这里重做（84 号票，照 AgentSense）
  const target = targetOf(task);
  const stageSource = hasStages ? target.stages : undefined;
  // 阶段标签（88 号票）：宽屏在标题栏左边、点它开合阶段栏；窄屏照旧在右边、点它开合抽屉
  const chipPlace = stageChipPlace(wide);
  const subject = protoSubject(task);
  const panel = (p: TaskPanel): ReactNode => {
    switch (p) {
      case "plan":
        return (
          <div className="td-panel">
            {detail.planCardId ? (
              <CardPanel cardId={detail.planCardId} />
            ) : hasStages ? (
              <div className="muted">原型没有给这个任务准备计划卡的假数据，下面是它的阶段。</div>
            ) : (
              <div className="page-placeholder">
                <span>
                  还没有计划：<AssistantName />正在和你对齐意图，之后执行的维护者起草计划。
                </span>
              </div>
            )}
            {hasStages && (
              <Section title="阶段">
                {detail.stages.map((s) => (
                  <div key={s.id} className="card">
                    <StageCard stages={detail.stages} id={s.id} />
                  </div>
                ))}
              </Section>
            )}
          </div>
        );
      case "orders":
        return (
          <div className="td-panel">
            <div className="muted">本任务派出的所有工单。工单不在看板上单独占卡。</div>
            {detail.workOrders.map((w) => (
              <div key={w.id} className="wo-row">
                <b>{w.id}</b>
                <span className="wo-title">{w.title}</span>
                <span className="chip">{w.project}</span>
                <span className={`st wo-${w.status}`}>{WORK_ORDER_STATUS_LABEL[w.status]}</span>
                <span className="muted">{timeLabel(w.updatedAt)}</span>
              </div>
            ))}
          </div>
        );
      case "toolkit":
        return (
          <div className="td-panel">
            <ToolkitEditor initial={detail.toolkit} readOnly={task.status === "archived"} />
          </div>
        );
      case "usage":
        return (
          <div className="td-panel">
            <Section title={`token 合计 ${tokensLabel(task.tokens ?? 0)}`}>
              <table className="tbl">
                <tbody>
                  {detail.tokensByAgent.map((a) => (
                    <tr key={a.agent}>
                      <td>{a.agent}</td>
                      <td className="num">{tokensLabel(a.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="范围记录">
              {detail.scopeRecords.length === 0 && <div className="muted">没有</div>}
              {detail.scopeRecords.map((r) => (
                <div key={r.id} className={`scope-row scope-${r.kind}`}>
                  <span className="chip">{r.kind === "change" ? "范围变更" : "越界"}</span> {r.text}
                  <span className="muted"> · {timeLabel(r.at)}</span>
                </div>
              ))}
            </Section>
          </div>
        );
      case "runs":
        return null;
    }
  };

  const conversation = detail.maintainer ? (
    <div className="chat-row">
      {stagePanel.side}
      <div className="chat-row-main" onPointerDownCapture={stagePanel.onChatPointerDown}>
        <Conversation
          conversation={detail.maintainer}
          mode="maintainer"
          wide={wide}
          onDetail={pane.open}
          {...stagePanel.chat}
          ref={conversationRef}
          readOnly={task.status === "archived"}
          readOnlyNote="已归档的任务，会话只读"
        />
      </div>
    </div>
  ) : (
    <div className="page-placeholder">原型没有给这个任务准备会话假数据。看「家庭照片整理与去重」「个税年度汇算材料」「每周汇总银行账单」「博客迁移到 Astro」这几个。</div>
  );

  return (
    <DetailLayout wide={wide} detail={pane} conversation={detail.maintainer} stages={stageSource} panel={panel}>
      <div className="chat-col">
        <TaskHead
          wide={wide}
          title={task.title}
          onBack={onBack}
          chip={stagePanel.chip}
          chipPlace={chipPlace}
          // 任务会话：对话层不显示 ▤，缩小后才出现（照 AgentSense 的里程碑会话）
          zoom={detail.maintainer && <ZoomToggle handle={conversationRef} onlyZoomedOut />}
          status={{ text: statusText(task), tone: `st-${task.status}` }}
          activity={{ state: task.activity, note: task.activityNote }}
          note={taskStatusNote({ state: task.status, waitReason: task.waitReason, waitNote: task.waitNote })}
          meta={
            <>
              <span className={`chip kind-chip kind-${task.taskKind ?? "long_running"}`}>{TASK_KIND_LABEL[task.taskKind ?? "long_running"]}</span>
              {task.stage && (
                <span className="muted">
                  第 {task.stage.current}/{task.stage.total} 阶段
                </span>
              )}
              {detail.executedBy && <span className="muted">由{detail.executedBy}执行</span>}
            </>
          }
          tokens={task.tokens ?? 0}
          items={taskMenu(subject, "detail")}
          keyItem={taskKeyItem(subject)}
          panels={taskPanels({ plain: false, timed: false, orders: detail.workOrders.length, runs: 0 })}
          onPanel={(p) => pane.show({ type: "panel", taskId, panel: p })}
          onPick={(item) => acts.run(target, item)}
        />
        {stagePanel.drawer}
        {conversation}
        {acts.dialogs}
      </div>
    </DetailLayout>
  );
}
