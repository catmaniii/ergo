// 一个 agent 一个样子（368 号票，用户 2026-11-01："不管点哪里进去，同一个 agent 的对话框看起来应该都一样"）：负责人的对话框只有这一套——
// 同样的标题栏（ui/task-head.tsx）、顶部的阶段条（ui/conversation/stage-panel.tsx）、消息、输入框，差异都在档案里（宽屏在会话左边，手机从右边滑进来）。
// - AgentDialog：对话框本身；项目的对话框（ProjectsPage.tsx 的 ProjectConversation）、跨项目和不属于项目的任务（TaskConversation）、原型的假任务（TasksPage.tsx）都用它；
// - useTaskScene：一个任务在对话框上要的全部（标题栏的状态和操作、阶段条、"⋯"的几样、任务操作的对话框）。任务详情原来的那一套（13、60、75、76、90、91 号票）挪过来，
//   没有任务（项目还没开始做事）时什么都不画、不占地方；
// - TaskBrief：档案里这个任务的一块（状态、用量、计划 工单 工具包 消耗 运行的入口、任务操作）；
// - 任务详情"⋯"里的几样（计划、工单、工具包、消耗、运行）画在这里（TaskPanelBody），在详情栏打开，手机整页滑入。
// 输入框说的话和原来任务页一样（Conversation 的 taskId，守护进程的 sayingScopeOf、userMessageScope 认）：有任务在做时属于这一段；
// 项目内部的普通任务做完了、从链接定位过来接着说的带上任务编号；别的不带（项目负责人的话属于项目）。
import { type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pageProjectSide, pageProjectSideWidth, useProjectSidePref, useProjectSideWidth } from "../app/page-project-wall.ts";
import { useLocale } from "../app/locale.ts";
import { toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { tokensLabel, tokensText } from "../model/labels.ts";
import {
  type AgentActivity,
  activityJump,
  agentActivity,
  canReopenStage,
  type ChatItem,
  chatItems,
  type ConversationId,
  type DetailTarget,
  dragProjectSideWidth,
  ENDED_TASK_STATES,
  type GuardPingKind,
  hasOwnMaintainer,
  internalScopeLabel,
  isPlainTask,
  isTriggered,
  latestGuardPing,
  LEDGER_PURPOSE_LABEL,
  maintainerChannel,
  PROJECT_NAME_MAX,
  projectSideLayout,
  type RunView,
  stageAtItems,
  stageToolCalls,
  t,
  type Task,
  type TaskAction,
  type TaskActOptions,
  taskAcceptsMessages,
  taskBoardProgress,
  taskHasStages,
  taskIncidents,
  taskKeyItem,
  taskKind,
  TASK_KIND_LABEL,
  taskMenu,
  taskMenuSubject,
  type TaskMenuItem,
  type TaskPanel,
  taskPanels,
  taskProjectScope,
  taskRunViews,
  taskScopeRecords,
  taskStageGraph,
  taskStages,
  taskStatusNote,
  taskStatusText,
  taskToolkit,
  taskTriggerView,
  taskUsage,
  taskWaitingForProject,
  taskWorkOrders,
  type TaskWorkOrderView,
  UNFINISHED_TASK_STATES,
  WORKFLOW_STEP_ICON,
  WORKFLOW_STEP_STATE_LABEL,
  workflowCurrentRun,
  workflowProgress,
} from "../state/index.ts";
import type { TaskSummary } from "../model/types.ts";
import { nextTimeLabel, timeLabel } from "../util/time.ts";
import { useTaskHistory } from "../app/task-history.ts";
import { AgentSettingsButton } from "../ui/agent-settings.tsx";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, Section, Sheet, Splitter } from "../ui/common.tsx";
import { type ConversationHandle, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { PlanProgress, PlanTimeline } from "../ui/conversation/PlanTimeline.tsx";
import { StageCard, stageProgress, usePing } from "../ui/conversation/StageDrawer.tsx";
import { type StagePanel, useStagePanel } from "../ui/conversation/stage-panel.tsx";
import { BackgroundAgentsEntry } from "../ui/detail/BackgroundAgents.tsx";
import { type DetailController, DetailLayout, FrameWidth } from "../ui/detail/DetailLayout.tsx";
import { IncidentCounts } from "../ui/detail/incidents.tsx";
import { type StageDetailSource } from "../ui/detail/StageDetail.tsx";
import { stageOf } from "../ui/detail/stage-source.ts";
import { T } from "../ui/i18n.tsx";
import { RemoteBadge } from "../ui/runtimes.tsx";
import { ScopeRecordList } from "../ui/scope-records.tsx";
import { type TaskHeadProps, TaskHead } from "../ui/task-head.tsx";
import { type TaskActsTarget, TaskMenuItems, useTaskActs } from "../ui/task-menu.tsx";
import { useToast } from "../ui/toast.tsx";
import { Conversation, useConversationPane } from "../ui/conversation/Conversation.tsx";
import { statusText, taskSummary } from "./task-summary.ts";
import { ToolkitPanel } from "./ToolkitEditor.tsx";

// ───────────────────────── 对话框 ─────────────────────────

/** 档案：写什么、里面是什么 */
export interface AgentArchive {
  /** "项目档案""任务档案" */
  readonly label: string;
  readonly body: ReactNode;
  /** 这一次开着（日历里点作业过来的，好看到那一行），不写进设置 */
  readonly forced?: boolean | undefined;
}

/** 从任务、项目来的标题栏那几样 */
export type AgentHead = Omit<TaskHeadProps, "wide" | "title" | "onBack" | "lead" | "onTitle" | "behind" | "zoom" | "gear" | "moreHead">;

/**
 * 对话框：标题栏、档案（宽屏在左边，手机从右边滑进来）、阶段条、会话。children 是会话组件（各自摊上这个 agent 的那些属性）；
 * 没有会话的原型假任务 children 是一句说明
 */
export function AgentDialog({
  wide,
  title,
  onBack,
  conversation,
  conversationRef,
  detail,
  maintainerId,
  head,
  archive,
  bar,
  onChatPointerDown,
  stages,
  panel,
  dialogs,
  zoomOnlyZoomedOut = false,
  children,
}: {
  wide: boolean;
  title: string;
  onBack?: (() => void) | undefined;
  conversation: ConversationId | undefined;
  conversationRef: RefObject<ConversationHandle | null>;
  detail: DetailController;
  /** 负责它的负责人：⚙ 和背后的 agent 都是它的；没有会话的原型假任务没有 */
  maintainerId: string | undefined;
  head: AgentHead;
  archive?: AgentArchive | undefined;
  /** 阶段条（useStagePanel 的 bar、TaskBar） */
  bar?: ReactNode;
  onChatPointerDown?: (() => void) | undefined;
  stages?: StageDetailSource | undefined;
  panel?: ((panel: TaskPanel) => ReactNode) | undefined;
  /** 任务操作的对话框、计划台账 */
  dialogs?: ReactNode;
  /** 标题栏的 ▤ 只在缩小后出现（任务的负责人会话，用户 2026-10-09 定；项目的、流程的一直显示） */
  zoomOnlyZoomedOut?: boolean;
  children: ReactNode;
}) {
  const frameWidth = useContext(FrameWidth);
  const pref = useProjectSidePref();
  const remembered = useProjectSideWidth();
  /** 拖着的时候的宽度（松手才记到这台设备上） */
  const [dragging, setDragging] = useState<number>();
  /** 这一次开着的：你自己开合之后按你的 */
  const [forced, setForced] = useState(archive?.forced === true);
  const layout = projectSideLayout({ pref, job: forced ? "job" : undefined });
  const open = layout === "side" && archive !== undefined && wide;
  const setSide = (next: "open" | "closed") => {
    setForced(false);
    pageProjectSide().set(next);
  };
  const showArchive = archive ? () => detail.show({ type: "archive", title: archive.label }) : undefined;
  return (
    <DetailLayout wide={wide} detail={detail} conversation={conversation} stages={stages} panel={panel} archive={archive?.body}>
      <div className="chat-col" data-agent-dialog={maintainerId ?? ""}>
        <TaskHead
          {...head}
          wide={wide}
          title={title}
          onBack={onBack}
          onTitle={wide ? undefined : showArchive}
          lead={
            wide &&
            archive && (
              <button type="button" className="stage-chip proj-side-chip" onClick={() => setSide(open ? "closed" : "open")} aria-expanded={open} aria-label={open ? t("pages.projects.side.hide") : t("pages.projects.side.show")}>
                {archive.label}
              </button>
            )
          }
          moreHead={!wide && archive && showArchive ? { label: archive.label, onPick: showArchive } : undefined}
          behind={maintainerId !== undefined && <BackgroundAgentsEntry maintainerId={maintainerId} wide={wide} onOpen={() => detail.show({ type: "agents", maintainerId })} />}
          zoom={conversation && <ZoomToggle handle={conversationRef} onlyZoomedOut={zoomOnlyZoomedOut} />}
          gear={maintainerId !== undefined && <AgentSettingsButton agentId={maintainerId} wide={wide} />}
        />
        <div className="chat-row">
          {open && (
            <>
              <aside className="md-side proj-side" style={{ width: dragging ?? remembered }} aria-label={archive.label}>
                <div className="md-side-head">
                  <span>{archive.label}</span>
                  <button type="button" className="md-side-close" onClick={() => setSide("closed")} aria-label={t("pages.projects.side.hide")} title={t("pages.projects.side.hideTitle")}>
                    ×
                  </button>
                </div>
                <div className="scroll proj-side-body">{archive.body}</div>
              </aside>
              <Splitter
                label={t("pages.projects.side.resize")}
                onDrag={(dx) => setDragging((w) => dragProjectSideWidth(w ?? remembered, dx, frameWidth))}
                onDragEnd={() => {
                  if (dragging !== undefined) pageProjectSideWidth().set(dragging);
                  setDragging(undefined);
                }}
              />
            </>
          )}
          <div className="chat-row-main">
            {bar}
            <div className="chat-row-conv" onPointerDownCapture={onChatPointerDown}>
              {children}
            </div>
          </div>
        </div>
        {dialogs}
      </div>
    </DetailLayout>
  );
}

// ───────────────────────── 一个任务在对话框上要的 ─────────────────────────

/** 阶段条下面出过的状况、阶段标签闪一下（60 号票）：按这个任务的整段会话算 */
export function useStageIncidents(
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

export interface TaskScene {
  readonly task: Task;
  readonly summary: TaskSummary;
  /** 这个任务结束了 */
  readonly ended: boolean;
  /** 流程、普通任务、定时触发的 */
  readonly workflow: boolean;
  readonly plain: boolean;
  readonly timed: boolean;
  /** 状态签要的：写什么、什么颜色 */
  readonly status: { text: string; tone: string };
  /** 标题栏的那几样（不含活动状态：项目的对话框写负责人的） */
  readonly head: Omit<AgentHead, "activity" | "badge" | "menuTitle">;
  /** 负责人的活动状态、说明，从任务上看（它的工单还排着时是排队） */
  readonly activity: AgentHead["activity"];
  readonly panels: ReadonlyArray<{ panel: TaskPanel; label: string }>;
  /** 档案里点计划、工单…… */
  onBriefPanel(panel: TaskPanel): void;
  onPick(item: TaskMenuItem): void;
  readonly stages: StageDetailSource | undefined;
  panel(panel: TaskPanel): ReactNode;
  /** 对话框的阶段条：长程任务是阶段条，流程是进度，别的一行 */
  readonly bar: ReactNode;
  /** 任务操作的对话框、计划台账 */
  readonly dialogs: ReactNode;
}

/**
 * 一个任务在对话框上要的全部；没有任务（项目还没开始做事）时 scene 是 undefined，stagePanel 什么都不画（Hook 照常跑，换任务不用重新挂会话）。
 * - focused：地址点名定位到这个任务的（从任务链接、待办跳过来）：做完了的也当成正看着它（历史取回来、会话定位过去）；
 * - caption：阶段条第一行上写的任务名（项目的对话框：同一个负责人做好几件事，写清是哪件）；
 * - doneText：任务结束了那一行怎么说（不给就写状态）。
 */
export function useTaskScene({
  task,
  conversation,
  conversationRef,
  detail,
  focused,
  caption,
  doneText,
  focusHref,
  onDeleted,
}: {
  task: Task | undefined;
  conversation: ConversationId;
  conversationRef: RefObject<ConversationHandle | null>;
  detail: DetailController;
  focused: boolean;
  caption?: string | undefined;
  doneText?: string | undefined;
  /** 没有阶段条可展开的（普通任务、还没计划的）：点那一行定位到它（项目的对话框给） */
  focusHref?: string | undefined;
  onDeleted?: (() => void) | undefined;
}): { scene: TaskScene | undefined; stagePanel: StagePanel; items: readonly ChatItem[] } {
  const { ui, taskAction, scheduledJobAction, rescheduleJob, runJobNow, setVoiceAnnounce } = useStore();
  const taskId = task?.id ?? "";
  const plain = task !== undefined && isPlainTask(task);
  const ended = task !== undefined && ENDED_TASK_STATES.includes(task.state);
  // 这个任务开始以来的会话历史都取回来（60 号票）：进度、偏差、阶段详情、出过的状况按整段会话算，数字不随往上翻变；定时触发的流程只要这一次运行那一段。
  // 普通任务没有这些，除非要定位到它；项目的对话框里没人点名的、早就做完的不取（打开项目不用把它的历史全取回来）
  const wanted = task !== undefined && (focused || (!plain && (!ended || caption === undefined)));
  useTaskHistory(conversation, wanted ? (plain ? task.createdAt : (workflowCurrentRun(ui, task.id)?.queuedAt ?? task.createdAt)) : undefined);
  // 阶段、用量、运行里有按当前语言拼的字：换了语言重算（171 号票；locale 是词典的版本号，只用来让 useMemo 重算）
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- locale 只用来在换语言时重算（下同）
  const views = useMemo(() => taskStages(ui, taskId), [ui, taskId, locale]);
  const stages = useMemo(
    () => {
      const calls = stageToolCalls(ui, conversation, taskId);
      return views.map((s) => stageOf(s, calls[s.stageId]));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- locale 只用来在换语言时重算
    [ui, views, taskId, conversation, locale],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const usage = useMemo(() => taskUsage(ui, taskId), [ui, taskId, locale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const orders = useMemo(() => taskWorkOrders(ui, taskId), [ui, taskId, locale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const runs = useMemo(() => taskRunViews(ui, taskId), [ui, taskId, locale]);
  const { counts, ping, items } = useStageIncidents(conversation, taskId, detail.show);
  // 计划（91 号票）：依赖图（等你确认的计划也画），阶段标签跟着聊天滚动变，点一个阶段在详情栏看阶段详情
  const hasStages = task !== undefined && taskHasStages(task, stages);
  const graph = useMemo(() => (task ? taskStageGraph(ui, task.id, items) : undefined), [ui, task, items]);
  const stepAt = useMemo(() => stageAtItems(ui, items, taskId), [ui, items, taskId]);
  const done = !task || !ended ? undefined : { text: doneText ?? taskStatusText(task), ok: task.state === "done" };
  // 项目的对话框（caption 给了）：会话里还有别的任务、项目自己的条目，只把这个任务在阶段里的成框
  const stagePanel = useStagePanel({ taskId, graph, progress: stageProgress(stages), show: detail.show, counts, ping, stepAt, lastItemId: items.at(-1)?.id, done, caption: done ? undefined : caption, chatStages: { shared: caption !== undefined } });
  const [ledger, setLedger] = useState(false);
  const acts = useTaskActs();
  // 地址点名定位到这个任务（没带 at 的）：会话滚到它开始的那一条，只定位一次。要等历史取回来（第一条会往前变）
  const firstItem = focused ? items.find((it) => it.scope.taskId === taskId)?.id : undefined;
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focused) revealed.current = undefined;
    if (firstItem === undefined || revealed.current === taskId) return;
    const timer = setTimeout(() => {
      revealed.current = taskId;
      conversationRef.current?.reveal(firstItem);
    }, 400);
    return () => clearTimeout(timer);
  }, [focused, firstItem, taskId, conversationRef]);

  if (!task) return { scene: undefined, stagePanel, items };

  const activity: AgentActivity = agentActivity(ui, task.maintainerId);
  // 定时触发的任务（76 号票）：它的触发登记和每一次运行
  const trigger = taskTriggerView(ui, task.id);
  const timed = isTriggered(task);
  // 流程（60 号票）：做完的步骤 / 总步数，点开是计划台账
  const progress = workflowProgress(ui, task.id);
  const summary = taskSummary({ task, activity, tokens: usage.total, cacheHit: usage.cacheHit, waitingForProject: taskWaitingForProject(ui, task.id), trigger, progress: taskBoardProgress(ui, task) });
  // 流程（58 号票）只有一个内部的执行阶段，不显示阶段，显示步骤
  const workflow = taskKind(task) === "workflow";
  const act = (action: TaskAction, options?: TaskActOptions) => taskAction(task.id, action, options);
  // 阶段详情（60 号票）：点阶段条里的一个阶段打开；"从这里重做"就是返工这个阶段（连同下游），84 号票起开始过的阶段就能（建好了阶段、没取消没归档的长程任务都行）
  const stageSource: StageDetailSource | undefined = hasStages
    ? {
        taskId: task.id,
        stages,
        canRework: (stageId) => canReopenStage(task, stageId),
        rework: (stageId, text, edit) => act("rework", { stageId, ...(text ? { note: text } : {}), ...(edit ? { stageEdit: edit } : {}) }),
      }
    : undefined;
  // 任务操作（90 号票）：状态签浮层、"⋯"的下半、宽屏标题栏的关键按钮是同一份；定时触发的任务运营中时落到它的触发上
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
    // 删了（186 号票）：删掉的任务没有详情了
    deleted: onDeleted,
  };
  const panelBody = (p: TaskPanel): ReactNode => <TaskPanelBody panel={p} task={task} orders={orders} usage={usage} runs={runs} stages={hasStages ? stages : undefined} workflow={workflow} evented={summary.trigger?.waitingFor !== undefined} />;
  const status = { text: statusText(summary), tone: task.state === "operating" && summary.trigger ? (summary.trigger.active ? "st-ops" : "st-paused") : `st-${task.state}` };
  const panels = taskPanels({ plain, timed, orders: orders.length, runs: runs.length });
  const onPanel = (p: TaskPanel) => detail.show({ type: "panel", taskId: task.id, panel: p });
  // 从档案里点的（手机上档案自己就是详情页的一层）：钻进去，‹ 回档案
  const onBriefPanel = (p: TaskPanel) => detail.go({ type: "panel", taskId: task.id, panel: p });
  const onPick = (item: TaskMenuItem) => acts.run(target, item);
  // 阶段条：长程任务建好了阶段的是阶段条；流程是进度（点开是计划台账）；别的只在要写清是哪个任务时有一行（任务自己的对话框标题就是它，不占地方）
  const bar =
    stagePanel.bar ??
    (workflow && progress ? (
      <div className="stage-bar-line" data-stage-bar={ended ? "done" : "live"}>
        <PlanProgress progress={progress} onOpen={() => setLedger(true)} />
        {caption !== undefined && <span className="stage-bar-task">{caption}</span>}
      </div>
    ) : caption !== undefined ? (
      <div className={`stage-bar-line${ended ? " stage-bar-done" : ""}`} data-stage-bar={ended ? "done" : "live"}>
        <a className={`st ${status.tone} stage-bar-st`} href={focusHref}>
          {done ? `${done.ok ? "✓ " : ""}${done.text}` : status.text}
        </a>
        {!done && <span className="stage-bar-task">{caption}</span>}
      </div>
    ) : null);
  return {
    stagePanel,
    items,
    scene: {
      task,
      summary,
      ended,
      workflow,
      plain,
      timed,
      status,
      panels,
      onBriefPanel,
      onPick,
      stages: stageSource,
      panel: panelBody,
      bar,
      activity: { state: summary.activity, note: summary.activityNote, jump: activityJump(ui, task.maintainerId) },
      head: {
        status,
        note: taskStatusNote(task),
        meta: <TaskMeta task={task} summary={summary} timed={timed} />,
        tokens: usage.total,
        cacheHitTokens: usage.cacheHit,
        items: taskMenu(subject, "detail"),
        keyItem: taskKeyItem(subject),
        panels,
        onPanel,
        onPick,
      },
      dialogs: (
        <>
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
          {acts.dialogs}
        </>
      ),
    },
  };
}

/** 状态签浮层里、档案里的几个小签：种类、涉及的项目、第几阶段、定时 */
function TaskMeta({ task, summary, timed }: { task: Task; summary: TaskSummary; timed: boolean }) {
  return (
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
      {/* 项目内部任务（64 号票）：点了进项目 */}
      {task.internal && (
        <a className="chip" href={toHash({ tab: "projects", projectId: task.internal.projectId })}>
          {internalScopeLabel(task.internal.projectName)}
        </a>
      )}
      {summary.stage && <span className="muted">{t("pages.tasks.stageProgress", { current: summary.stage.current, total: summary.stage.total })}</span>}
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
  );
}

/** 档案里这个任务的一块：状态、用量、几个入口（计划、工单、工具包、消耗、运行）、任务操作。368 号票：不用跳页就都找得到 */
export function TaskBrief({ scene, title }: { scene: TaskScene; title?: string | undefined }) {
  const { task, status, summary, panels, onBriefPanel, onPick, head } = scene;
  const items = head.items.filter((item) => item.kind !== "delete_note");
  return (
    <div className="card task-brief" data-task-brief={task.id}>
      {title && <div className="muted task-brief-label">{title}</div>}
      <div className="task-brief-title">{task.title}</div>
      <div className="task-brief-line">
        <span className={`st ${status.tone}`}>{status.text}</span>
        <ActivityDot state={scene.activity.state} note={scene.activity.note} jump={scene.activity.jump} />
      </div>
      <div className="th-pop-meta">
        <TaskMeta task={task} summary={summary} timed={scene.timed} />
        <span className="muted">{tokensText(head.tokens, head.cacheHitTokens)}</span>
      </div>
      {head.note && <div className="muted">{head.note}</div>}
      {task.summary && task.summary !== task.title && <div className="muted">{task.summary}</div>}
      {panels.length > 0 && (
        <div className="task-brief-panels">
          {panels.map((p) => (
            <button key={p.panel} type="button" className="btn ghost small" onClick={() => onBriefPanel(p.panel)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="th-pop-acts task-brief-acts">
          <TaskMenuItems items={items} onPick={onPick} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 任务自己的对话框（跨项目的、不属于项目的） ─────────────────────────

/**
 * 跨项目的任务、不属于项目的任务有自己的负责人，有自己的页面（13 号票的任务详情），368 号票起和项目的对话框是同一个组件：
 * 负责人会话（直接下指令；它在干活时你的话作为插话，在它下一步之前插入）、阶段条、档案。
 * 项目负责人做的任务不走这里（TasksPage 换成项目的对话框）
 */
export function TaskConversation({ task, wide, at, onBack }: { task: Task; wide: boolean; at?: string | undefined; onBack?: (() => void) | undefined }) {
  const { watchChannels } = useStore();
  const conversation = maintainerChannel(task.maintainerId);
  // 打开详情时订阅它的负责人会话（订阅过的一直保留）
  useEffect(() => watchChannels([conversation]), [watchChannels, conversation]);
  const [conversationRef, detail] = useConversationPane(wide, conversation);
  const { scene, stagePanel } = useTaskScene({ task, conversation, conversationRef, detail, focused: false, onDeleted: onBack });
  if (!scene) return null;
  const { plain, timed, workflow } = scene;
  return (
    <AgentDialog
      wide={wide}
      title={task.title}
      onBack={onBack}
      conversation={conversation}
      conversationRef={conversationRef}
      detail={detail}
      maintainerId={task.maintainerId}
      head={{ ...scene.head, activity: scene.activity }}
      archive={{ label: t("pages.agent.taskArchive"), body: <TaskBrief scene={scene} /> }}
      bar={scene.bar}
      onChatPointerDown={stagePanel.onChatPointerDown}
      stages={scene.stages}
      panel={scene.panel}
      dialogs={scene.dialogs}
      // 任务会话：对话层不显示 ▤，缩小后才出现（固定计划的会话一直显示）
      zoomOnlyZoomedOut={!workflow}
    >
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
        composerPlaceholder={composerPlaceholderOf(task, plain, timed)}
      />
    </AgentDialog>
  );
}

/** 输入框的占位（任务页原来写的那几句） */
export function composerPlaceholderOf(task: Task, plain: boolean, timed: boolean): string | undefined {
  if (timed && task.state === "operating") return t("pages.tasks.composer.timed");
  if (!plain) return undefined;
  return task.state === "done" ? t("pages.tasks.composer.continue") : t("pages.tasks.composer.plain");
}

// ───────────────────────── "⋯"里的几样 ─────────────────────────

function TaskPanelBody({ panel, task, orders, usage, runs, stages, workflow, evented }: { panel: TaskPanel; task: Task; orders: TaskWorkOrderView[]; usage: ReturnType<typeof taskUsage>; runs: RunView[]; stages: Parameters<typeof StageCard>[0]["stages"] | undefined; workflow: boolean; evented: boolean }) {
  const { ui } = useStore();
  switch (panel) {
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
          {stages && (
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
      return <TaskRuns runs={runs} workflow={workflow} evented={evented} />;
  }
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
            {r.steps && <span className="muted">{t("pages.tasks.runs.steps", { done: r.steps.done, total: r.steps.total })}</span>}
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

/** 任务详情的"消耗"一栏：按 agent 细分（负责人、评审子 agent、并行子 agent 各一行，范围审视单独一行），合计就是任务卡上的总量 */
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
        <div className="hint">{t("pages.tasks.usage.hint", { scopeReview: LEDGER_PURPOSE_LABEL.scope_review, compaction: LEDGER_PURPOSE_LABEL.compaction })}</div>
      </Section>
    </div>
  );
}

/**
 * 转为项目（15 号票）：未结束、由自己的负责人执行的任务（不是某个项目的任务）可以转为项目。项目名由用户定
 * （预填任务标题，可以改；和已有的项目重名时守护进程拒绝，原因在底部提示）。项目以筹备中诞生，
 * 不新建负责人，原任务的负责人接着做立项问答；原任务以"已完成 · 已转为项目"结束
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
