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
// 三种做法的界面（60 号票，固定计划、阶段计划的界面）：
// - 看板卡标出种类和进度（会话列表那种进度条）：普通任务没有进度；流程是做完的步数（定时触发的流程按这一次运行）；
//   长程任务是已验收的阶段数；
// - 流程的详情：标题栏上进度条（做完的步骤 / 总步数），点开是计划台账（PlanTimeline.tsx）；会话历史底部"接下来的计划"虚线框
//   （Conversation 的 workflowTaskId）；计划卡点开是计划详情（ui/detail/WorkflowPlanDetail.tsx）。原来状态行下面的步骤清单去掉了
//   （步骤另在虚线框、计划详情里）；
// - 长程任务的详情：阶段标签写"第 N 阶段 · 已验收几个"；点阶段抽屉、阶段栏里的一个阶段，在详情栏打开它的阶段详情
//   （ui/detail/StageDetail.tsx：交付件、验收标准和结果、尝试记录、授权和用量、出过的状况、"从这里重做"）。
// 宽屏布局（88 号票，用户 2026-10-11 提：左边任务列表、中间阶段、右边聊天太窄）：看板和任务详情二选一，宽窄屏一样（state/task-page.ts）——
// 宽屏的看板占满内容区，每组里的卡排成多列网格（.board[data-layout="grid"]）；点卡片、从别处跳进来都整页换成任务详情，
// 标题栏左上角的 ‹（鸿蒙返回键同一层）、浏览器后退回到看板，回来时滚动位置照旧（手机上也是）；‹ 不往历史里压新记录
// （app/history-nav.ts）。长程任务宽屏的阶段栏能整栏藏掉，阶段标签挪到标题栏左边、点它再打开，按设备记住；
// 窄屏的阶段抽屉、阶段标签照旧。
// 任务和待办的管理（90 号票，用户 2026-10-11）：
// - 看板卡长按 / 右键出任务操作菜单（state/task-menu.ts 算"这个任务现在能做什么"，ui/task-menu.tsx 画和做），简单提醒、定时作业卡照
//   它们能做的（改、取消提醒；暂停、恢复、取消）；
// - 看板多选：标题栏"多选"、菜单里"多选"进入，点卡片就是勾选，每组标题右边"全选"，底部操作栏（pages/board-select.tsx）；
//   156 号票起简单提醒卡的菜单是改时间、取消提醒、多选，也能勾上和任务混着选；157 号票多选时有醒目的"退出多选"（ui/select-mode.tsx）；
// - 每组标题点一下收起 / 展开，按设备记住（app/board-fold-setting.ts），默认"已归档"收起；
// - 任务详情顶部并成一行（ui/task-head.tsx）：状态签浮层、关键按钮、"⋯"（计划、工单、工具包、消耗、运行在详情栏打开，下半是任务操作），
//   页签那一排去掉了，会话占满；退回、返工写原因改成点了按钮弹出的对话框。
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { goBackTo, type Navigate, toHash } from "../app/route.ts";
import { pageBoardFold, useBoardFolded } from "../app/page-board-fold.ts";
import { useLocale } from "../app/locale.ts";
import { useStore } from "../app/store.tsx";
import { scheduledJobStatusLabel, TASK_STATUS_LABEL, tokensLabel, tokensText, WAIT_REASON_LABEL, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
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
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  selectTask,
  taskWaitingForProject,
  type Task,
  hasOwnMaintainer,
  jobTokenTotal,
  LAST_RUN_FAILED_LABEL,
  LAST_RUN_PARTIAL_LABEL,
  LEDGER_PURPOSE_LABEL,
  SCHEDULED_JOB_ACTION_LABEL,
  type ReminderSchedule,
  type ScheduledJobAction,
  PROJECT_NAME_MAX,
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
  taskObservedLine,
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
  groupSelection,
  type TaskAction,
  type TaskActOptions,
  type TaskMenuItem,
  type TaskMenuSubject,
  taskKeyItem,
  taskMenu,
  type TaskPanel,
  taskPanels,
  taskStatusNote,
  toggleSelected,
  type UiState,
  taskMenuSubject,
  // 156 号票：简单提醒卡的菜单、和任务混着多选
  type BoardBatchEntry,
  boardGroupOfReminder,
  // 292 号票：会话交给了官方 App 的卡上标出来
  remoteBadgeOf,
  t,
} from "../state/index.ts";
import { nextTimeLabel, timeLabel } from "../util/time.ts";
import type { BoardEntry, ScheduledJobSummary, Stage, TaskSummary } from "../model/types.ts";
import { taskDetailOf } from "../prototype/fake-data.ts";
import { protoAfter, protoSubject } from "../prototype/proto-task-acts.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { RemoteBadge, RuntimeChip } from "../ui/runtimes.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, Section, Sheet, TopBar, useRevealed } from "../ui/common.tsx";
import { useLongPress } from "../ui/long-press.ts";
import { PopupMenu } from "../ui/popup.tsx";
import { AgentSettingsButton } from "../ui/agent-settings.tsx";
import { TaskHead } from "../ui/task-head.tsx";
import { type TaskActsTarget, TaskMenuPopup, useTaskActs } from "../ui/task-menu.tsx";
import { CardCheck, SelectToggle, useSelectingBack } from "../ui/select-mode.tsx";
import { usePlugins } from "../plugins/api.ts";
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
import { realStageSource, stageOf } from "../ui/detail/stage-source.ts";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { T } from "../ui/i18n.tsx";
import { BoardSelectBar } from "./board-select.tsx";
import { StartTaskButton } from "./shared.tsx";
import { ToolkitEditor, ToolkitPanel } from "./ToolkitEditor.tsx";

/**
 * 看板和任务详情二选一（88 号票，宽窄屏一样）：没点任务时整页是看板（宽屏多列网格），点了整页是任务详情，标题栏的 ‹ 回到看板
 * （上一条历史就是看板就后退一步，否则换掉这一条，不压新记录）。
 * jobId：日历里点作业过来，看板上这张作业卡高亮并滚到看得见的地方（35 号票）
 */
/** at：任务的会话里要定位的那一条（105 号票，从待办跳过来） */
export function TasksPage({ wide, taskId, jobId, at, navigate }: { wide: boolean; taskId?: string; jobId?: string; at?: string | undefined; navigate: Navigate }) {
  // 离开看板（进了任务详情）时看板滚到哪。看板组件在详情页时拿掉了，回来时照它恢复；记在任务页上，切到别的页再回来从头开始。
  // 分组收起没有（90 号票）按设备记住，不用这里记
  const boardScroll = useRef<number | undefined>(undefined);
  const savedScroll = useCallback(() => boardScroll.current, []);
  const rememberScroll = useCallback((top: number) => {
    boardScroll.current = top;
  }, []);
  const view = taskPageView({ wide, taskId, jobId });
  if (view.kind === "task") return <TaskDetail key={view.taskId} taskId={view.taskId} wide={wide} at={at} onBack={() => goBackTo({ tab: "tasks" })} />;
  return <Board layout={view.layout} job={view.job} savedScroll={savedScroll} onScrolled={rememberScroll} onOpen={(id) => navigate({ tab: "tasks", taskId: id })} />;
}

// ---------- 看板 ----------

/** 原型假条目的分组：和真数据用同一张表（共享协议包） */
function groupOf(e: BoardEntry): BoardGroup {
  if (e.kind === "task") return BOARD_GROUP_OF_TASK_STATE[e.status];
  // 185 号票：已取消的也在最近结束，归档了的在已归档（分组只看协议包那一份）
  if (e.kind === "reminder") return boardGroupOfReminder(e) ?? "ended";
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
    ...(view.reschedule ? { reschedule: view.reschedule } : {}),
    ...(view.runNow ? { runNow: true } : {}),
  };
}

/** 一个真任务在看板卡片、任务详情状态行上要的东西 */
interface TaskSummarySource {
  readonly task: Task;
  /** 维护者的活动状态 */
  readonly activity: AgentActivity;
  /** 这个任务名下的 token 总量（账本） */
  readonly tokens: number;
  /** 其中缓存命中的（311 号票） */
  readonly cacheHit?: number | undefined;
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
function taskSummary({ task, activity, tokens, cacheHit, waitingForProject, trigger, progress }: TaskSummarySource): TaskSummary {
  const note = waitingForProject ? t("pages.tasks.waitingForProject", { project: waitingForProject }) : activityNote(activity);
  const timed = isTriggered(task);
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.state,
    taskKind: taskKind(task),
    ...(task.runtime === undefined ? {} : { runtime: task.runtime }),
    ...(task.workdir === undefined ? {} : { workdir: task.workdir }),
    ...(remoteBadgeOf(task.takeover) ? { remote: remoteBadgeOf(task.takeover)! } : {}),
    activity: waitingForProject ? "queued" : activity.state,
    ...(note === undefined ? {} : { activityNote: note }),
    projects: task.projects,
    updatedAt: task.updatedAt,
    tokens,
    // 311 号票：其中缓存命中的单写（"124 万 token（其中缓存命中 104 万）"）
    ...(cacheHit ? { cacheHitTokens: cacheHit } : {}),
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
    // 274 号票：最近一次交上来的阶段系统查到的结果
    ...observedOf(task),
  };
}

/** 看板卡上"系统查到的结果"那一行（274 号票）：长程任务、有阶段交上来过的才有 */
function observedOf(task: Task): { observed?: TaskSummary["observed"] } {
  const observed = taskKind(task) === "long_running" ? taskObservedLine(task) : undefined;
  return observed ? { observed } : {};
}

function entryOf(item: BoardItem, progress: (task: Task) => TaskSummary["progress"]): BoardEntry {
  if (item.kind === "task") {
    const { task, activity, tokens, cacheHitTokens, waitingForProject, trigger, project } = item;
    const summary = taskSummary({ task, activity, tokens, cacheHit: cacheHitTokens, waitingForProject, trigger, progress: progress(task) });
    // 运营方案建的内部任务（141 号票）：卡上标属于哪个项目（点了进项目）
    return project ? { ...summary, internalProject: project } : summary;
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
      ...(job.lastRun?.endedAt ? { lastRun: { at: job.lastRun.endedAt, ok: item.view.lastFailedText === undefined, ...(item.view.lastPartialText ? { partial: true } : {}) } } : {}),
      autoPaused: job.pausedBy === "failures",
      tokens,
      statusLine: item.view.statusText,
      ...(job.nextAt ? { nextAt: job.nextAt } : {}),
      actions,
      authorization: { grants, rules },
    };
  }
  if (item.kind === "memory_curator") {
    // 242 号票：记忆管理员每天的整理。点进去落在记忆页的管理员那一层（卡上有 route，插件那张卡按它导航）
    return {
      kind: "memory_curator",
      id: "memory-curator",
      title: t("pages.tasks.memoryCurator.title"),
      schedule: t("pages.tasks.memoryCurator.schedule"),
      route: item.route,
    };
  }
  const r = item.reminder;
  return {
    kind: "reminder",
    id: r.id,
    title: r.text,
    // 删了的不上看板（boardGroupOfReminder），走不到这里
    status: r.status === "deleted" ? "cancelled" : r.status,
    // 185 号票：归档了的在"已归档"
    ...(r.archived ? { archived: true } : {}),
    cardId: r.cardId,
    // 已取消的一次性提醒写原来定的那一刻
    nextAt: r.nextAt ?? r.lastFiredAt ?? (r.schedule?.kind === "once" ? r.schedule.at : r.updatedAt),
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
  // 组名、卡上的说明按当前语言现取：换了语言重算（171 号票；locale 是词典的版本号，只用来让 useMemo 重算）
  const locale = useLocale();
  return useMemo(
    () =>
      boardGroups(ui).map((g) => ({
        id: g.group,
        title: g.title,
        sub: g.sub,
        entries: [...g.items.map((it) => entryOf(it, (task) => taskBoardProgress(ui, task))), ...proto.board.filter((e) => groupOf(e) === g.group).map((e) => withJobTokens(e, (id) => jobTokenTotal(ui, id)))],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- locale 只用来在换语言时重算
    [ui, proto.board, locale],
  );
}

/**
 * 看板卡、任务详情上按菜单规则看的任务：真任务就是看板频道上的 Task（状态层的 taskMenuSubject：运营中的定时任务带上它的触发能做的、
 * 跑完自动播报开没开，141 号票起项目在用时运营方案里的一条只能暂停、恢复），原型的假条目按它的状态拼
 */
function subjectOf(ui: UiState, ts: TaskSummary): TaskMenuSubject {
  const task = ui.tasks[ts.id];
  return task ? taskMenuSubject(ui, task) : protoSubject(ts);
}

/**
 * 要动手的那个任务（看板卡的菜单、任务详情的状态签和"⋯"共用）：真任务交给守护进程（task_action；定时触发的运营中时落到触发上；
 * 返工、从某阶段重做和阶段详情同一份 StageDetailSource）；原型的假任务在页面上演（prototype/proto-task-acts.ts）
 */
function useTaskTarget(): (ts: TaskSummary) => TaskActsTarget {
  const { ui, taskAction, scheduledJobAction, rescheduleJob, runJobNow, setVoiceAnnounce } = useStore();
  const { proto, update } = useProto();
  const toast = useToast();
  return (ts) => {
    const task = ui.tasks[ts.id];
    const trigger = ts.trigger ? (a: ScheduledJobAction) => scheduledJobAction(ts.trigger!.jobId, a) : undefined;
    // 改时间（98 号票）：换它的触发登记的时间表
    const reschedule = ts.trigger ? (s: ReminderSchedule) => rescheduleJob(ts.trigger!.jobId, s) : undefined;
    if (task) {
      const act = (action: TaskAction, options?: TaskActOptions) => taskAction(ts.id, action, options);
      // 立即运行一次、跑完自动播报（100 号票）
      const runNow = ts.trigger ? () => runJobNow(ts.trigger!.jobId) : undefined;
      return { title: ts.title, act, trigger, reschedule, runNow, announce: (on: boolean) => setVoiceAnnounce(ts.id, on), stages: realStageSource(ui, task, act) };
    }
    const act = (action: TaskAction) => {
      // 删除（186 号票）：假任务从看板上拿掉
      if (action === "delete") {
        update((s) => ({ ...s, board: s.board.filter((e) => !(e.kind === "task" && e.id === ts.id)) }));
        return;
      }
      const running = proto.board.filter((e) => e.kind === "task" && e.status === "running" && e.id !== ts.id).length;
      const after = protoAfter(action, running);
      update((s) => ({
        ...s,
        board: s.board.map((e) => (e.kind === "task" && e.id === ts.id ? { ...e, status: after.status, waitReason: undefined, ...(after.activity ? { activity: after.activity, activityNote: undefined } : {}) } : e)),
      }));
      toast(after.toast);
    };
    return { title: ts.title, act, trigger, reschedule, stages: protoStageSource(ts, act) };
  };
}

/** 原型假任务的阶段：假详情里有就用，没有按"第 N/M 阶段"排出来（只够选阶段用）；没取消没归档的、开始过的阶段能重做 */
function protoStageSource(ts: TaskSummary, act: TaskActsTarget["act"]): StageDetailSource | undefined {
  const detail = taskDetailOf(ts.id).stages;
  const stages: Stage[] =
    detail.length > 0
      ? detail
      : (protoSubject(ts).stages?.list ?? []).map((s, i) => ({
          id: s.stageId,
          title: t("pages.tasks.stageN", { n: i + 1 }),
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
  const reopenable = !["cancelled", "archived"].includes(ts.status);
  return {
    taskId: ts.id,
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
 * 点卡片就是勾选，每组标题右边"全选"，底部操作栏）。还没迁移的定时作业卡不参与多选（没有批量的接口），多选时淡掉。
 * 156 号票：简单提醒卡也有菜单（改时间、取消提醒、多选），也能勾上，和任务混着选时批量动作只给两者都能做的（state/board-batch.ts）。
 * 157 号票：多选时标题栏的"多选"换成"退出多选"，操作栏右边"✕ 退出多选"，Esc 和返回键一样先退出多选（ui/select-mode.tsx）
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
  // 多选时返回键（鸿蒙）、Esc 先退出多选（157 号票）
  useSelectingBack(selecting, stopSelecting);
  const acts = useTaskActs();
  const targetOf = useTaskTarget();
  // 简单提醒卡（193 号票起由提醒插件画：看板条目的插槽）；提醒插件停用时没有，那几条显示占位、勾不上
  const plugins = usePlugins();
  const pluggedIn = (e: BoardEntry) => plugins.get("boardEntries", e.kind) !== undefined;
  const pickable = (e: BoardEntry) => e.kind === "task" || (e.kind === "reminder" && pluggedIn(e));
  // 勾上的只算看得见的：收起的组里的不算（归档了的挪进收起着的"已归档"，就不再算在"已选"里）；156 号票起提醒也算
  const shown = groups.filter((g) => !folded.has(g.id)).flatMap((g) => g.entries);
  const picked: BoardBatchEntry[] = shown.flatMap((e): BoardBatchEntry[] => {
    if (!selected.has(e.id) || !pickable(e)) return [];
    if (e.kind === "task") return [{ kind: "task", id: e.id, title: e.title, subject: subjectOf(ui, e) }];
    if (e.kind === "reminder") return [{ kind: "reminder", id: e.id, title: e.title, reminder: e, cardId: e.cardId }];
    return [];
  });
  const startSelecting = (id: string) => {
    setSelecting(true);
    setSelected(new Set([id]));
  };
  const pick = (ts: TaskSummary, item: TaskMenuItem) => {
    if (item.kind === "open") return onOpen(ts.id);
    if (item.kind === "select") return startSelecting(ts.id);
    acts.run(targetOf(ts), item);
  };
  const choiceOf = (id: string) => ({ selecting, checked: selected.has(id), onToggle: () => setSelected((s) => toggleSelected(s, id)) });
  const card = (ts: TaskSummary): CardChoice => ({
    menu: taskMenu(subjectOf(ui, ts), "board"),
    onPick: (item) => pick(ts, item),
    ...choiceOf(ts.id),
  });
  // 网页插件的看板条目（193 号票）：插件的 Scope 包在这一栏的内容外面一次（菜单点了以后的对话框画在最后），每张卡是插件的 Entry
  const boardSlots = plugins.list("boardEntries");
  const plugged = (e: BoardEntry) => {
    const slot = plugins.get("boardEntries", e.kind);
    return slot && <slot.Entry key={e.id} entry={e} {...choiceOf(e.id)} onSelect={() => startSelecting(e.id)} />;
  };
  const body = (
    <>
      <TopBar title={t("pages.tasks.board")}>
        <SelectToggle selecting={selecting} onStart={() => setSelecting(true)} onStop={stopSelecting} className="board-select-btn" />
        <StartTaskButton compact />
      </TopBar>
      <div ref={ref} className={`scroll board${selecting ? " selecting" : ""}`} data-layout={grid ? "grid" : undefined} onScroll={(e) => onScrolled(e.currentTarget.scrollTop)}>
        {groups.map((g) => {
          const { entries } = g;
          const collapsed = folded.has(g.id);
          const ids = entries.filter(pickable).map((e) => e.id);
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
                    {all ? t("pages.tasks.selectNone") : t("pages.tasks.selectAll")}
                  </button>
                )}
              </div>
              {!collapsed &&
                withPlaceholders(entries, (e) => (pluggedIn(e) ? undefined : plugins.unavailable("boardEntries", e.kind))).map((row) =>
                  row.kind === "unavailable" ? (
                    <div key={`unavailable:${row.first}`} className="muted bgroup-empty bgroup-unavailable">
                      {row.count === 1 ? t("ui.plugins.unavailable", { plugin: row.plugin }) : t("ui.plugins.unavailableCount", { plugin: row.plugin, count: row.count })}
                    </div>
                  ) : row.entry.kind === "task" && row.entry.trigger ? (
                    <TimedTaskCard key={row.entry.id} task={row.entry} onOpen={() => onOpen(row.entry.id)} choice={card(row.entry)} />
                  ) : row.entry.kind === "task" ? (
                    <TaskCard key={row.entry.id} task={row.entry} onOpen={() => onOpen(row.entry.id)} choice={card(row.entry)} />
                  ) : row.entry.kind === "scheduled_job" ? (
                    <ScheduledJobCard key={row.entry.id} j={row.entry} on={job === row.entry.id} selecting={selecting} />
                  ) : (
                    plugged(row.entry)
                  ),
                )}
              {!collapsed && entries.length === 0 && <div className="muted bgroup-empty">{t("pages.tasks.none")}</div>}
            </section>
          );
        })}
      </div>
      {selecting && <BoardSelectBar entries={picked} onDone={stopSelecting} />}
      {acts.dialogs}
    </>
  );
  return <div className="chat-col">{boardSlots.reduceRight<ReactNode>((children, slot) => (slot.Scope ? <slot.Scope>{children}</slot.Scope> : children), body)}</div>;
}

/** 一组里的一行：一张卡，或者连着几条属于没启用的插件的合成的一行占位（193 号票） */
type BoardRow = { kind: "entry"; entry: BoardEntry } | { kind: "unavailable"; plugin: string; count: number; first: string };

/** 属于没启用的插件的条目（unavailable 交回插件的名字）：同一个插件连着的几条合成一行占位，别的照原样 */
function withPlaceholders(entries: readonly BoardEntry[], unavailable: (e: BoardEntry) => string | undefined): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const entry of entries) {
    const plugin = unavailable(entry);
    const last = rows.at(-1);
    if (plugin === undefined) rows.push({ kind: "entry", entry });
    else if (last?.kind === "unavailable" && last.plugin === plugin) last.count += 1;
    else rows.push({ kind: "unavailable", plugin, count: 1, first: entry.id });
  }
  return rows;
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
    checkbox: choice.selecting && <CardCheck checked={choice.checked} />,
    popup: menu && <TaskMenuPopup anchor={anchor} align="start" items={choice.menu} onPick={choice.onPick} onClose={() => setMenu(false)} />,
  };
}

/** 会话交给了官方 App、任务因此停着（292 号票）：状态那一行已经写明，卡上不再另标 */
const remoteInStatus = (ts: TaskSummary) => ts.remote !== undefined && ts.status === "waiting_for_user" && ts.waitReason === "runtime_off";

export function statusText(ts: TaskSummary): string {
  // 292 号票：会话交给了官方 App 而停着的，写"在官方 App 里"（不写"运行时没启用"）
  if (remoteInStatus(ts)) return t("pages.tasks.status.waiting", { reason: ts.remote!.label });
  if (ts.statusLine) return ts.statusLine;
  if (ts.status === "waiting_for_user" && ts.waitReason) return t("pages.tasks.status.waiting", { reason: WAIT_REASON_LABEL[ts.waitReason] });
  if (ts.status === "awaiting_confirm") return t("pages.tasks.status.awaitingConfirm");
  if (ts.status === "done" && ts.endNote) return t("pages.tasks.status.done", { note: ts.endNote });
  return TASK_STATUS_LABEL[ts.status];
}

// 看板上的几种卡：标题下面状态所在的那一行挂 bcard-status-row，token、时间表、下一次这些数字挂 bcard-num——
// 经典不认这两个类名，是给视觉风格下样式用的（39 号票的规矩：补 class，不改结构；夜航仪表按它们把状态排到右上角、数字用等宽字）
function TaskCard({ task: ts, onOpen, choice }: { task: TaskSummary; onOpen(): void; choice: CardChoice }) {
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
        <span className={`chip kind-chip kind-${ts.taskKind ?? "long_running"}`}>{TASK_KIND_LABEL[ts.taskKind ?? "long_running"]}</span>
        <RuntimeChip runtime={ts.runtime} />
        <span className="bcard-title">{ts.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className={`st st-${ts.status}`}>{statusText(ts)}</span>
        {/* 292 号票：会话交给了官方 App（停着等收回的状态里已经写明） */}
        {ts.remote && !remoteInStatus(ts) && <RemoteBadge badge={ts.remote} />}
        {ts.progress && <TaskProgress progress={ts.progress} />}
        {ts.tokens !== undefined && <span className="bcard-num">{tokensText(ts.tokens, ts.cacheHitTokens)}</span>}
      </div>
      {ts.waitNote && (
        <div className="bcard-meta">
          <span className="muted">{ts.waitNote}</span>
        </div>
      )}
      {/* 274 号票：系统查到的结果（绿字一行；和自报对不上的另标） */}
      {ts.observed && (
        <div className="bcard-meta bcard-observed" title={t("pages.tasks.observedTitle")}>
          <span className="bcard-outcome" title={ts.observed.text}>
            {ts.observed.text}
          </span>
          {ts.observed.mismatches > 0 && <span className="bcard-outcome-bad">{t("pages.tasks.observedMismatch", { n: ts.observed.mismatches, count: ts.observed.mismatches })}</span>}
        </div>
      )}
      {/* 305 号票：在哪个文件夹做（新建时选的、接管来的） */}
      {ts.workdir && <WorkdirLine path={ts.workdir} />}
      <div className="bcard-meta">
        <ActivityDot state={ts.activity} note={ts.activityNote} />
        <ProjectChips task={ts} />
      </div>
    </button>
  );
}

/** 卡上一行：维护者在哪个文件夹做（305 号票），路径长的从前面省略 */
function WorkdirLine({ path }: { path: string }) {
  return (
    <div className="bcard-meta bcard-workdir" title={path}>
      <span className="workdir-text">{t("pages.tasks.workdir", { path })}</span>
    </div>
  );
}

/**
 * 定时触发的任务的卡（76 号票）：种类签、"定时"签、状态（运营中、已暂停及原因；结束了的写任务的状态）、时间表、下一次、token，
 * 最近一次运行的结果（失败的醒目），能暂停、恢复、取消（取消先确认）。点卡片打开任务详情，点按钮不打开。
 * 事件触发的（77 号票）："事件"签，写在等什么事件、最近一次触发是什么事件
 */
function TimedTaskCard({ task: ts, onOpen, choice }: { task: TaskSummary; onOpen(): void; choice: CardChoice }) {
  const trigger = ts.trigger!;
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
        <span className={`chip kind-chip kind-${ts.taskKind ?? "plain"}`}>{TASK_KIND_LABEL[ts.taskKind ?? "plain"]}</span>
        <span className={`chip trigger-chip${trigger.waitingFor ? " trigger-event" : ""}`}>{trigger.waitingFor ? t("pages.tasks.chip.event") : t("pages.tasks.chip.timed")}</span>
        <RuntimeChip runtime={ts.runtime} />
        <span className="bcard-title">{ts.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        {ts.remote && !remoteInStatus(ts) && <RemoteBadge badge={ts.remote} />}
        <span className={`st ${ts.status !== "operating" ? `st-${ts.status}` : trigger.active ? "st-ops" : "st-paused"}`}>{statusText(ts)}</span>
        {!trigger.waitingFor && <span className="bcard-num">{trigger.schedule}</span>}
        {ts.status === "operating" && trigger.nextAt && <span className="bcard-num">{t("pages.tasks.next", { time: nextTimeLabel(trigger.nextAt) })}</span>}
        {ts.tokens !== undefined && <span className="bcard-num">{tokensText(ts.tokens, ts.cacheHitTokens)}</span>}
      </div>
      {ts.progress && (
        <div className="bcard-meta">
          <TaskProgress progress={ts.progress} />
        </div>
      )}
      {/* 事件触发的（77 号票）：在等什么事件、最近一次触发 */}
      {trigger.waitingFor && <div className="bcard-waiting">{t("pages.tasks.waitingFor", { what: trigger.waitingFor })}</div>}
      {ts.workdir && <WorkdirLine path={ts.workdir} />}
      {trigger.lastTrigger && (
        <div className="bcard-waiting muted">
          {t("pages.tasks.lastTrigger", { summary: trigger.lastTrigger.summary, time: timeLabel(trigger.lastTrigger.at) })}
        </div>
      )}
      <div className="bcard-meta">
        {trigger.lastRun ? (
          <span className={trigger.lastRun.partial ? "chip chip-op" : trigger.lastRun.ok ? "muted" : "chip chip-no"}>{trigger.lastRun.text}</span>
        ) : (
          <span className="muted">{trigger.waitingFor ? t("pages.tasks.noEventYet") : t("pages.tasks.notRunYet")}</span>
        )}
        <ProjectChips task={ts} />
      </div>
      {ts.status === "operating" && trigger.actions.length > 0 && !choice.selecting && (
        <div className="bcard-meta">
          <TriggerActions jobId={trigger.jobId} title={ts.title} actions={trigger.actions} />
        </div>
      )}
    </div>
  );
}

/**
 * 卡上涉及的项目：运营方案建的内部任务（141 号票）是一个项目小标签，点了进项目（卡片本身点了打开任务，标签上的点击不往上传）；
 * 别的写涉及的项目名
 */
function ProjectChips({ task: ts }: { task: TaskSummary }) {
  const project = ts.internalProject;
  if (!project) {
    return ts.projects.map((p) => (
      <span key={p} className="chip">
        {p}
      </span>
    ));
  }
  const go = (e: { stopPropagation(): void; preventDefault(): void }) => {
    e.stopPropagation();
    e.preventDefault();
    window.location.hash = toHash({ tab: "projects", projectId: project.id });
  };
  return (
    <span
      role="link"
      tabIndex={0}
      className="chip project-chip"
      title={t("pages.tasks.openProject", { name: project.name })}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") go(e);
      }}
    >
      {project.name}
    </span>
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
        <Sheet title={t("pages.tasks.cancelTimed.title")} onClose={() => setConfirmCancel(false)} center>
          <div className="modal-body">
            <p>{t("pages.tasks.cancelTimed.body", { title })}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>
              {t("pages.tasks.keep")}
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
        <span className={`st ${j.status === "active" ? "st-ops" : "st-paused"}`}>{t("pages.tasks.job.status", { status: j.statusLine ?? scheduledJobStatusLabel(j) })}</span>
        <span className="bcard-num">{j.schedule}</span>
        {j.nextAt && <span className="bcard-num">{t("pages.tasks.next", { time: nextTimeLabel(j.nextAt) })}</span>}
        {j.tokens !== undefined && <span className="bcard-num">{tokensText(j.tokens)}</span>}
        {j.project && <span className="chip">{j.project}</span>}
        {j.lastRun?.partial ? <span className="chip chip-op">{LAST_RUN_PARTIAL_LABEL}</span> : j.lastRun && !j.lastRun.ok && <span className="chip chip-no">{LAST_RUN_FAILED_LABEL}</span>}
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
        <Sheet title={t("pages.tasks.cancelJob.title")} onClose={() => setConfirmCancel(false)} center>
          <div className="modal-body">
            <p>{t("pages.tasks.cancelJob.body", { title: j.title })}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>
              {t("pages.tasks.keep")}
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

function TaskDetail({ taskId, wide, at, onBack }: { taskId: string; wide: boolean; at?: string | undefined; onBack?: () => void }) {
  const { ui } = useStore();
  const task = selectTask(ui, taskId);
  if (task) return <RealTaskDetail task={task} activity={agentActivity(ui, task.maintainerId)} wide={wide} at={at} onBack={onBack} />;
  return <ProtoTaskDetail taskId={taskId} wide={wide} at={at} onBack={onBack} />;
}


/**
 * 阶段抽屉全开、宽屏阶段栏下面那一行：这个任务执行中出过的状况，每类几次，点一个在详情栏看是哪几次；
 * 阶段标签刚被拉回、拦下、你拒绝时闪一下。按这个任务的整段会话算
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
function RealTaskDetail({ task, activity, wide, at, onBack }: { task: Task; activity: AgentActivity; wide: boolean; at?: string | undefined; onBack?: () => void }) {
  const { ui, taskAction, scheduledJobAction, rescheduleJob, runJobNow, setVoiceAnnounce, watchChannels } = useStore();
  const conversation = maintainerChannel(task.maintainerId);
  // 打开详情时订阅它的维护者会话（订阅过的一直保留）
  useEffect(() => watchChannels([conversation]), [watchChannels, conversation]);
  // 这个任务开始以来的会话历史都取回来（60 号票）：进度、偏差、阶段详情、出过的状况按整段会话算，数字不随往上翻变；
  // 定时触发的流程只要这一次运行那一段
  useTaskHistory(conversation, isPlainTask(task) ? undefined : (workflowCurrentRun(ui, task.id)?.queuedAt ?? task.createdAt));
  // 阶段、用量、运行里有按当前语言拼的字：换了语言重算（171 号票；locale 是词典的版本号，只用来让 useMemo 重算）
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- locale 只用来在换语言时重算（下同）
  const views = useMemo(() => taskStages(ui, task.id), [ui, task.id, locale]);
  const stages = useMemo(
    () => {
      const calls = stageToolCalls(ui, conversation, task.id);
      return views.map((s) => stageOf(s, calls[s.stageId]));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- locale 只用来在换语言时重算
    [ui, views, task.id, conversation, locale],
  );
  const [conversationRef, detail] = useConversationPane(wide, conversation);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const usage = useMemo(() => taskUsage(ui, task.id), [ui, task.id, locale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const orders = useMemo(() => taskWorkOrders(ui, task.id), [ui, task.id, locale]);
  // 定时触发的任务（76 号票）：它的触发登记和每一次运行
  const trigger = taskTriggerView(ui, task.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const runs = useMemo(() => taskRunViews(ui, task.id), [ui, task.id, locale]);
  const timed = isTriggered(task);
  // 流程（60 号票）：标题栏的进度条（做完的步骤 / 总步数，定时触发的按这一次运行），点开是计划台账
  const progress = workflowProgress(ui, task.id);
  const [ledger, setLedger] = useState(false);
  const summary = taskSummary({ task, activity, tokens: usage.total, cacheHit: usage.cacheHit, waitingForProject: taskWaitingForProject(ui, task.id), trigger, progress: taskBoardProgress(ui, task) });
  // 流程（58 号票）只有一个内部的执行阶段，不显示阶段，显示步骤
  const workflow = taskKind(task) === "workflow";
  const hasStages = taskHasStages(task, stages);
  // 普通任务（75 号票）：只有会话和工具调用详情，没有计划、工具包、工单、消耗那些
  const plain = isPlainTask(task);
  const act = (action: TaskAction, options?: TaskActOptions) => taskAction(task.id, action, options);
  // 阶段详情（60 号票）：点阶段抽屉、阶段栏里的一个阶段打开；"从这里重做"就是返工这个阶段（连同下游），
  // 84 号票起开始过的阶段就能（建好了阶段、没取消没归档的长程任务都行）
  const stageSource: StageDetailSource | undefined = hasStages
    ? {
        taskId: task.id,
        stages,
        canRework: (stageId) => canReopenStage(task, stageId),
        rework: (stageId, text, edit) => act("rework", { stageId, ...(text ? { note: text } : {}), ...(edit ? { stageEdit: edit } : {}) }),
      }
    : undefined;
  // 阶段抽屉、阶段栏下面那一行出过的状况，阶段标签刚被拉回时闪一下（60 号票）
  const { counts, ping, items } = useStageIncidents(conversation, task.id, detail.show);
  // 计划栏（91 号票）：依赖图（等你确认的计划也画），阶段标签跟着聊天滚动变，点卡片在详情栏看阶段详情，
  // 宽屏分界线能拖；窄屏是阶段抽屉。阶段标签（88 号票）宽屏在标题栏左边、正在阶段栏上方，窄屏在右边
  const graph = useMemo(() => taskStageGraph(ui, task.id, items), [ui, task.id, items]);
  const stepAt = useMemo(() => stageAtItems(ui, items, task.id), [ui, items, task.id]);
  const stagePanel = useStagePanel({ wide, taskId: task.id, graph, progress: stageProgress(stages), show: detail.show, counts, ping, stepAt, lastItemId: items.at(-1)?.id });
  const chipPlace = stageChipPlace(wide);
  // 任务操作（90 号票）：状态签浮层、"⋯"的下半、宽屏标题栏的关键按钮是同一份；定时触发的任务运营中时落到它的触发上
  const acts = useTaskActs();
  const subject = taskMenuSubject(ui, task);
  const target: TaskActsTarget = {
    title: task.title,
    act,
    trigger: trigger ? (a) => scheduledJobAction(trigger.job.id, a) : undefined,
    // 改时间（98 号票）
    reschedule: trigger ? (s) => rescheduleJob(trigger.job.id, s) : undefined,
    // 立即运行一次、跑完自动播报（100 号票）
    runNow: trigger ? () => runJobNow(trigger.job.id) : undefined,
    announce: (on) => setVoiceAnnounce(task.id, on),
    stages: stageSource,
    // 删了（186 号票）：回到看板，删掉的任务没有详情了
    deleted: onBack,
  };
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
                  <T k="pages.tasks.noPlan" params={{ name: <AssistantName /> }} />
                </span>
              </div>
            )}
            {hasStages && (
              <Section title={t("pages.tasks.stages")}>
                {stages.map((s) => (
                  <div key={s.id} className="card">
                    <StageCard stages={stages} id={s.id} />
                  </div>
                ))}
              </Section>
            )}
            <Section title={t("pages.tasks.scope")}>
              <ScopeRecordList groups={taskScopeRecords(ui, task.id)} empty={t("pages.tasks.scopeEmpty")} />
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
          // 流程：做完的步骤 / 总步数，点开是计划台账（固定计划会话的标题栏）
          progress={workflow && progress && <PlanProgress progress={progress} onOpen={() => setLedger(true)} />}
          // 任务会话：对话层不显示 ▤，缩小后才出现（固定计划的会话一直显示）
          zoom={<ZoomToggle handle={conversationRef} onlyZoomedOut={!workflow} />}
          // 负责它的维护者的 ⚙（114 号票）
          gear={<AgentSettingsButton agentId={task.maintainerId} wide={wide} />}
          // 定时触发的任务运营中时，状态跟着它的触发：运营中用运营中的颜色，暂停着的灰
          status={{ text: statusText(summary), tone: task.state === "operating" && summary.trigger ? (summary.trigger.active ? "st-ops" : "st-paused") : `st-${task.state}` }}
          activity={{ state: summary.activity, note: summary.activityNote }}
          note={taskStatusNote(task)}
          meta={
            <>
              {/* 任务的种类（58 号票）：建卡时定下，不能换 */}
              <span className={`chip kind-chip kind-${taskKind(task)}`}>{TASK_KIND_LABEL[taskKind(task)]}</span>
              {/* 292 号票：会话交给了官方 App——拿到了链接的点开就是官方 App 里接着它的地方 */}
              {summary.remote &&
                (summary.remote.url ? (
                  <a className="chip remote-badge" href={summary.remote.url} target="_blank" rel="noreferrer" title={summary.remote.url}>
                    {summary.remote.label}
                  </a>
                ) : (
                  <RemoteBadge badge={summary.remote} />
                ))}
              {/* 项目内部任务（64 号票）：不在全局看板上，从项目页的"内部任务"一栏点进来 */}
              {task.internal && (
                <a className="chip" href={toHash({ tab: "projects", projectId: task.internal.projectId })}>
                  {internalScopeLabel(task.internal.projectName)}
                </a>
              )}
              {summary.stage && (
                <span className="muted">{t("pages.tasks.stageProgress", { current: summary.stage.current, total: summary.stage.total })}</span>
              )}
              {/* 定时触发（76 号票）：时间表、下一次；事件触发（77 号票）：在等什么事件 */}
              {timed && summary.trigger && (
                <>
                  <span className={`chip trigger-chip${summary.trigger.waitingFor ? " trigger-event" : ""}`}>
                    {summary.trigger.waitingFor ? t("pages.tasks.chip.eventWith", { what: summary.trigger.waitingFor }) : t("pages.tasks.chip.timedWith", { schedule: summary.trigger.schedule })}
                  </span>
                  {task.state === "operating" && summary.trigger.nextAt && <span className="muted">{t("pages.tasks.next", { time: nextTimeLabel(summary.trigger.nextAt) })}</span>}
                </>
              )}
            </>
          }
          tokens={usage.total}
          cacheHitTokens={usage.cacheHit}
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
            onOpen={(picked) => {
              if ("itemId" in picked) detail.open(picked.itemId);
              else detail.show({ type: "plan", cardId: picked.cardId });
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
              showDetail={detail.show}
              {...stagePanel.chat}
              ref={conversationRef}
              revealAt={at}
              // 等你处理（107 号票）：这个任务的等你验收、卡住求助、超预算、审批卡……
              inbox={{ kind: "task", taskId: task.id }}
              // 流程（60 号票）：历史底部"接下来的计划"虚线框
              workflowTaskId={workflow ? task.id : undefined}
              readOnly={!taskAcceptsMessages(task)}
              readOnlyNote={task.state === "done" && !plain ? t("pages.tasks.readOnlyDone") : t("pages.tasks.readOnlyEnded")}
              // 项目内部的普通任务：发的话带上任务编号，做完了在这里接着说，守护进程认得出说的是这件事
              taskId={plain && task.internal ? task.id : undefined}
              composerPlaceholder={timed && task.state === "operating" ? t("pages.tasks.composer.timed") : plain ? (task.state === "done" ? t("pages.tasks.composer.continue") : t("pages.tasks.composer.plain")) : undefined}
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
          <ToolkitPanel target={{ kind: "task", taskId: task.id }} toolkit={toolkit} readOnly={ended} readOnlyNote={t("pages.tasks.toolkitEnded")} />
          {taskProjectScope(task) === "multi" ? (
            <div className="muted">
              <T k="pages.tasks.toolkitMulti" params={{ name: <AssistantName /> }} />
            </div>
          ) : (
            task.projects.length > 0 && <div className="muted">{t("pages.tasks.toolkitProject")}</div>
          )}
        </>
      ) : (
        <div className="page-placeholder">{t("pages.tasks.noToolkit")}</div>
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
        {t("pages.tasks.runs.intro")}
        {workflow ? t("pages.tasks.runs.workflow") : ""}
      </div>
      {runs.length === 0 && <div className="page-placeholder">{evented ? t("pages.tasks.runs.noneEvent") : t("pages.tasks.runs.noneTimed")}</div>}
      {runs.map((r) => (
        <div key={r.runId} className={`run-row run-${r.state}`}>
          <div className="run-head">
            <b>{t("pages.tasks.runs.no", { n: r.no })}</b>
            <span className={`st run-st-${r.state}`}>{r.stateText}</span>
            {r.steps && (
              <span className="muted">{t("pages.tasks.runs.steps", { done: r.steps.done, total: r.steps.total })}</span>
            )}
            {r.startedAt && <span className="muted">{timeLabel(r.startedAt)}</span>}
          </div>
          {r.events.length > 0 ? (
            // 事件触发的（77 号票）：这一批事件，每个连同事件里的值（交给 agent 的就是这些）
            <div className="run-events">
              <div className="muted">{r.events.length > 1 ? t("pages.tasks.runs.batch", { count: r.events.length }) : t("pages.tasks.runs.event")}</div>
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
                      <span className="muted">{t("pages.tasks.paren", { text: WORKFLOW_STEP_STATE_LABEL[s.state] })}</span>
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
      <div className="muted">{t("pages.tasks.orders.intro")}</div>
      {orders.map((v) => (
        <div key={v.workOrder.id} className="wo-row">
          <span className="wo-title">
            <T k="pages.tasks.orders.ref" params={{ id: <b>{v.workOrder.id}</b>, title: v.workOrder.title }} />
          </span>
          <span className="chip">{v.project}</span>
          {v.unplanned && <span className="chip chip-op">{t("pages.tasks.orders.unplanned")}</span>}
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
      <Section title={t("pages.tasks.usage.total", { tokens: tokensLabel(usage.total) })}>
        {usage.rows.length === 0 ? (
          <div className="muted">{t("pages.tasks.usage.none")}</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>agent</th>
                <th className="num">{t("pages.usage.cacheHit")}</th>
                <th className="num">{t("pages.usage.cacheMiss")}</th>
                <th className="num">{t("pages.usage.output")}</th>
                <th className="num">{t("pages.usage.total")}</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {/* 角色名里秘书写名字占位（LEDGER_ROLE_LABEL），按现在的名字显示 */}
                    <NamedText text={r.label} />
                    <span className="muted"> · {t("pages.usage.calls", { count: r.calls })}</span>
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
          {t("pages.tasks.usage.hint", { scopeReview: LEDGER_PURPOSE_LABEL.scope_review, compaction: LEDGER_PURPOSE_LABEL.compaction })}
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
          {t("pages.tasks.convert.button")}
        </button>
      </div>
      {confirming && (
        <Sheet title={t("pages.tasks.convert.title", { title: task.title })} onClose={() => setConfirming(false)} center>
          <div className="modal-body">
            <p>{t("pages.tasks.convert.body")}</p>
          </div>
          <label className="field">
            <span>{t("pages.tasks.convert.name")}</span>
            <input value={name} maxLength={PROJECT_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              {t("pages.tasks.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!name.trim()}
              onClick={() => {
                setConfirming(false);
                convertTaskToProject(task.id, name.trim());
                toast(t("pages.tasks.convert.done", { title: task.title, name: name.trim() }));
              }}
            >
              {t("pages.tasks.convert.button")}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** 原型里有假会话的几个任务（原型的演示数据，和看板上的名字一样） */
const PROTO_CHAT_TASKS = "「家庭照片整理与去重」「个税年度汇算材料」「每周汇总银行账单」「博客迁移到 Astro」"; // @i18n-ignore data：原型演示数据里的任务名

/**
 * 原型的假任务详情（看板上还没接真数据的那些）：顶部和真任务一样并成一行（90 号票），菜单项按假任务的状态算，做了在页面上演
 * （prototype/proto-task-acts.ts）
 */
function ProtoTaskDetail({ taskId, wide, at, onBack }: { taskId: string; wide: boolean; at?: string | undefined; onBack?: () => void }) {
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
  if (!task) return <div className="page-placeholder">{t("pages.tasks.missing")}</div>;

  // 阶段详情（60 号票）：原型的假任务照真任务的规矩——建好了阶段、没取消没归档的，开始过的阶段能从这里重做（84 号票）
  const target = { ...targetOf(task), deleted: onBack };
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
              <div className="muted">{t("pages.tasks.proto.noPlanCard")}</div>
            ) : (
              <div className="page-placeholder">
                <span>
                  <T k="pages.tasks.noPlan" params={{ name: <AssistantName /> }} />
                </span>
              </div>
            )}
            {hasStages && (
              <Section title={t("pages.tasks.stages")}>
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
            <div className="muted">{t("pages.tasks.proto.orders")}</div>
            {detail.workOrders.map((w) => (
              <div key={w.id} className="wo-row">
                <span className="wo-title">
                  <T k="pages.tasks.orders.ref" params={{ id: <b>{w.id}</b>, title: w.title }} />
                </span>
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
            <Section title={t("pages.tasks.usage.total", { tokens: tokensLabel(task.tokens ?? 0) })}>
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
            <Section title={t("pages.tasks.scope")}>
              {detail.scopeRecords.length === 0 && <div className="muted">{t("pages.tasks.none")}</div>}
              {detail.scopeRecords.map((r) => (
                <div key={r.id} className={`scope-row scope-${r.kind}`}>
                  <span className="chip">{r.kind === "change" ? t("pages.projects.scopeChange") : t("pages.projects.overreach")}</span> {r.text}
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
          showDetail={pane.show}
          {...stagePanel.chat}
          ref={conversationRef}
          revealAt={at}
          inbox={{ kind: "task", taskId }}
          readOnly={task.status === "archived"}
          readOnlyNote={t("pages.tasks.readOnlyArchived")}
        />
      </div>
    </div>
  ) : (
    <div className="page-placeholder">{t("pages.tasks.proto.noChat", { tasks: PROTO_CHAT_TASKS })}</div>
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
          // 任务会话：对话层不显示 ▤，缩小后才出现
          zoom={detail.maintainer && <ZoomToggle handle={conversationRef} onlyZoomedOut />}
          gear={detail.maintainer && <AgentSettingsButton agentId={detail.maintainer.slice(MAINTAINER_CHANNEL_PREFIX.length)} wide={wide} />}
          status={{ text: statusText(task), tone: `st-${task.status}` }}
          activity={{ state: task.activity, note: task.activityNote }}
          note={taskStatusNote({ state: task.status, waitReason: task.waitReason, waitNote: task.waitNote })}
          meta={
            <>
              <span className={`chip kind-chip kind-${task.taskKind ?? "long_running"}`}>{TASK_KIND_LABEL[task.taskKind ?? "long_running"]}</span>
              {task.stage && (
                <span className="muted">{t("pages.tasks.stageProgress", { current: task.stage.current, total: task.stage.total })}</span>
              )}
              {detail.executedBy && <span className="muted">{t("pages.tasks.executedBy", { who: detail.executedBy })}</span>}
            </>
          }
          tokens={task.tokens ?? 0}
          cacheHitTokens={task.cacheHitTokens}
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
