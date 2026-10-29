// 项目页：项目一览（状态、维护者在干什么、内部任务和定时触发的有几个、"新建项目"）+ 项目（项目头：状态、项目类型、工作目录、
// 按当前状态给出的动作；立项书、内部任务、定时触发的、工单流水线、工具包、范围记录、维护者）+ 维护者会话。15 号票起项目来自前端状态层
// （项目列表频道，state/projects.ts）；16 号票起工单流水线（state/work-orders.ts）和重置维护者接真数据；18 号票起范围记录
// （state/scope-records.ts，越界和范围变更分开）；19 号票起定时作业列表接真数据（state/scheduled-jobs.ts）；64 号票起"内部任务"一栏
// （state/projects.ts 的 projectInternalTasks）；工具包的修改（27）还只有原型的假项目有（原型的假项目整页用假数据）。
// 104 号票（用户 2026-10-12，照 88 号票的任务页；布局的纯函数在 state/project-page.ts）：
// - 项目一览和项目二选一，不再左边列表右边项目（ListDetail）：没点项目时整页是项目一览，宽屏排成多列的"档案墙"（.pwall[data-layout="grid"]），
//   按项目状态分组、每组标题点一下收起（按设备记住，默认已归档收起），顶上一条概览；每张卡像一份档案（上沿页签写种类和状态，正文是名字和
//   一句话目标，底下一行是维护者在干什么、内部任务、定时触发的、最近一次动静），和任务看板的紧凑小卡看得出不一样；
// - 宽屏点卡片、从别处跳进来（#/projects/<项目>，…/chat、…/jobs/<作业> 也是）整页是这个项目：和维护者的会话占主区，项目的详情在会话左边的
//   档案栏里（照长程任务的阶段栏：栏顶 × 整栏藏掉，标题栏左边的"项目档案"再打开，分界线能拖，开合和宽度按设备记住）；
//   标题栏左上角的 ‹（鸿蒙返回键同一层）、浏览器后退回到一览，回来时滚回原来的位置（手机上也是）；‹ 不往历史里压新记录（app/history-nav.ts）；
// - 窄屏照旧：一览 → 项目页 → 维护者会话，一览的卡片用新的样子。
// 133 号票：项目做成了服务的（运营手段"服务"上线了），项目卡、项目页页头、运营方案那一节上有"打开「X」"入口和在不在线
// （ui/service-entry.tsx，数据是 state/project-services.ts），点了在内置浏览器里打开。
// 140 号票：项目卡和项目头用同一个"运营概况"（ui/operations-summary.tsx：服务入口带首页缩略图、定时任务几条几点、展开看每条）；
// 项目头下面先是"现在"一节（pages/ProjectNow.tsx：按项目状态说最要紧的事，使用中的就是放大的运营概况），再往下是原来的各节；
// 维护者会话页左栏的项目头用窄版。
// 258 号票：立项书下面一块"规范"（pages/ProjectStandard.tsx）：用的哪一版规范、必须有的几份文档写了、只有模板还是缺。
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pageProjectFold, pageProjectSide, pageProjectSideWidth, useProjectFolded, useProjectSidePref, useProjectSideWidth } from "../app/page-project-wall.ts";
import { goBackTo, type Navigate, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { scheduledJobStatusLabel, tokensText, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import {
  ASSISTANT_NAME_MARK,
  activityNote,
  ARCHIVING_ACTIONS,
  dragProjectSideWidth,
  PI_RUNTIME_ID,
  projectRuntime,
  isJobRunWorkOrder,
  maintainerChannel,
  type Project,
  type ProjectAction,
  type ProjectCard,
  type ProjectOverview,
  PROJECT_ACTION_LABEL,
  PROJECT_KIND_LABEL,
  PROJECT_STATE_LABEL,
  type InternalTaskView,
  type ProjectView,
  projectCharterChangeCards,
  projectInternalTasks,
  type OperationRow,
  projectOperationRows,
  projectOperationsChangeCards,
  projectPageView,
  projectPipeline,
  projectScheduledJobs,
  projectSideLayout,
  projectWall,
  type ScheduledJobView,
  projectScopeRecords,
  SCHEDULED_JOB_ACTION_LABEL,
  selectProject,
  type StageSidePref,
  t,
  taskLabel,
  tTable,
  wallScrollOnReturn,
  WORK_ORDER_LANE_LABEL,
  WORK_ORDER_LANES,
  EMPTY_FOLDER_DRAFT,
  type FolderDraft,
  folderChoiceOf,
  folderDraftReady,
  type WorkFolderChoice,
  workFolderRuntime,
  remoteBadgeOf,
  runtimeShown,
} from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import type { ScheduledJobSummary, WorkOrder } from "../model/types.ts";
import { type ProjectDetail, projectDetailOf } from "../prototype/fake-data.ts";
import { useToast } from "../ui/toast.tsx";
import { RemoteBadge, RuntimeChip, RuntimePicker, useRuntimes } from "../ui/runtimes.tsx";
import { TakeoverLink, TakeoverSheet } from "../ui/takeover.tsx";
import { WorkFolderPicker } from "../ui/work-folder.tsx";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { AgentSettingsButton } from "../ui/agent-settings.tsx";
import { ActivityDot, Section, Sheet, Splitter, TopBar, useRevealed } from "../ui/common.tsx";
import { T } from "../ui/i18n.tsx";
import { ServiceEntry } from "../ui/service-entry.tsx";
import { OperationsSummary } from "../ui/operations-summary.tsx";
import { charterAnchor, ProjectNowSection } from "./ProjectNow.tsx";
import { ProjectStandardSection } from "./ProjectStandard.tsx";
import { Conversation, useConversationPane, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { JobAuthorization } from "../ui/job-authorization.tsx";
import { ScopeRecordList } from "../ui/scope-records.tsx";
import { DetailLayout, FrameWidth } from "../ui/detail/DetailLayout.tsx";
import { ToolkitEditor, ToolkitPanel } from "./ToolkitEditor.tsx";
import { TaskProgress } from "../ui/TaskProgress.tsx";

/**
 * 项目一览和项目二选一（104 号票，宽窄屏一样）：没点项目时整页是项目一览（宽屏多列档案墙），点了宽屏整页是这个项目（会话 + 档案栏），
 * 窄屏是项目页、维护者会话各一页。标题栏的 ‹ 回到一览（上一条历史就是一览就后退一步，否则换掉这一条，不压新记录）。
 * jobId：日历里点作业过来，项目详情里这个定时作业那一行高亮并滚到看得见的地方（35 号票）
 */
/** at：维护者的会话里要定位的那一条（105 号票，从待办跳过来） */
export function ProjectsPage({ wide, projectId, chat, jobId, at, navigate }: { wide: boolean; projectId?: string; chat?: boolean; jobId?: string; at?: string | undefined; navigate: Navigate }) {
  // 离开一览（进了项目）时一览滚到哪：一览在项目页时拿掉了，回来时照它恢复；记在项目页上，切到别的页再回来从头开始。
  // 分组收起按设备记住，不用这里记
  const wallScroll = useRef<number | undefined>(undefined);
  const savedScroll = useCallback(() => wallScroll.current, []);
  const rememberScroll = useCallback((top: number) => {
    wallScroll.current = top;
  }, []);
  const view = projectPageView({ wide, projectId, chat, jobId });
  if (view.kind === "wall") return <ProjectWall layout={view.layout} savedScroll={savedScroll} onScrolled={rememberScroll} onOpen={(id) => navigate({ tab: "projects", projectId: id })} />;
  switch (view.pane) {
    case "full":
      return <ProjectFull key={view.projectId} projectId={view.projectId} job={view.job} at={at} onBack={backToWall} />;
    case "chat":
      return <MaintainerChat key={`${view.projectId}-chat`} projectId={view.projectId} wide={wide} at={at} onBack={() => goBackTo({ tab: "projects", projectId: view.projectId })} />;
    case "page":
      return <ProjectPage key={view.projectId} projectId={view.projectId} job={view.job} onBack={backToWall} onChat={() => navigate({ tab: "projects", projectId: view.projectId, chat: true })} />;
  }
}

/** 标题栏的 ‹：回到项目一览（不压新记录） */
const backToWall = () => goBackTo({ tab: "projects" });

// ---------- 项目一览 ----------

/**
 * 项目一览（104 号票）。layout：宽屏 grid（每组里的卡排成多列，卡片最小宽比任务看板的大，样式在 pages.css 的 .pwall[data-layout="grid"]），
 * 窄屏 list（一列）。滚动时报给项目页记下（onScrolled），从项目回来时照记下的（savedScroll）滚回去。
 * 每组标题点一下收起 / 展开（按设备记住，默认已归档收起，照 90 号票的看板分组）
 */
function ProjectWall({ layout, savedScroll, onScrolled, onOpen }: { layout: "grid" | "list"; savedScroll(): number | undefined; onScrolled(top: number): void; onOpen(id: string): void }) {
  const { ui } = useStore();
  const [creating, setCreating] = useState(false);
  const folded = useProjectFolded();
  const wall = projectWall(ui);
  const ref = useRef<HTMLDivElement>(null);
  // 挂上时（从项目回来）滚回离开时的位置，只滚一次
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const top = wallScrollOnReturn(savedScroll());
    if (top !== undefined && ref.current) ref.current.scrollTop = top;
  }, [savedScroll]);
  return (
    <div className="chat-col">
      <TopBar title={t("pages.projects.title")}>
        <button type="button" className="btn primary small" onClick={() => setCreating(true)}>
          {t("pages.projects.newButton")}
        </button>
      </TopBar>
      <div ref={ref} className="scroll pwall" data-layout={layout === "grid" ? "grid" : undefined} onScroll={(e) => onScrolled(e.currentTarget.scrollTop)}>
        <WallOverview overview={wall.overview} />
        {wall.groups.map((g) => {
          const collapsed = folded.has(g.id);
          return (
            <section key={g.id} className={`pgroup pg-${g.id}${collapsed ? " folded" : ""}`}>
              <button type="button" className="pgroup-h" onClick={() => pageProjectFold().toggle(g.id)} aria-expanded={!collapsed}>
                <b>{g.title}</b>
                <span className="bgroup-n">{g.cards.length}</span>
                <span className="pgroup-rule" aria-hidden="true" />
                <span className="bgroup-caret" aria-hidden="true">
                  {collapsed ? "▸" : "▾"}
                </span>
              </button>
              {!collapsed && (
                <div className="pgroup-cards">
                  {g.cards.map((c) => (
                    <ProjectFileCard key={c.view.project.id} card={c} onOpen={() => onOpen(c.view.project.id)} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {wall.groups.length === 0 && <div className="muted page-pad">{t("pages.projects.empty")}</div>}
        <div className="hint">
          <T k="pages.projects.wallHint" params={{ name: <AssistantName /> }} />
        </div>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** 一览顶上的概览：各状态几个，维护者在干活的、进行中的内部任务、定时触发的 */
function WallOverview({ overview }: { overview: ProjectOverview }) {
  return (
    <div className="pwall-sum">
      <div className="pwall-sum-row">
        {overview.states.map((s) => (
          <WallStat key={s.state} n={s.n} label={s.label} className={`ps-${s.state}`} />
        ))}
      </div>
      <div className="pwall-sum-row">
        <WallStat n={overview.working} label={t("pages.projects.overview.working")} />
        <WallStat n={overview.internalOpen} label={t("pages.projects.overview.internalOpen")} />
        <WallStat n={overview.scheduled} label={t("pages.projects.overview.scheduled")} />
      </div>
    </div>
  );
}

/** 概览里的一项：数字大、字小 */
function WallStat({ n, label, className }: { n: number; label: string; className?: string | undefined }) {
  return (
    <span className={className ? `pwall-stat ${className}` : "pwall-stat"}>
      <b>{n}</b>
      {label}
    </span>
  );
}

/**
 * 一张项目卡（一份档案）：上沿页签写种类和状态，正文是名字（大）和一句话目标，底下一行是现在的动静。
 * 133 号票：整张卡是一个铺满的按钮（打开项目），项目的服务的入口压在它上面（按钮里不能套按钮）。
 * 140 号票：入口换成运营概况（缩略图小、定时任务默认收起）：缩略图、入口、展开钮、展开后的一行行压在铺满的按钮上面自己能点，
 * 别处（那一行字）点下去还是打开项目
 */
function ProjectFileCard({ card, onOpen }: { card: ProjectCard; onOpen(): void }) {
  const { ui } = useStore();
  const p = card.view.project;
  return (
    <div className={`pfile pf-${p.state}`}>
      <button type="button" className="pfile-hit" onClick={onOpen} aria-label={t("pages.projects.open", { name: p.name })} />
      <span className="pfile-tab">
        <span className="pfile-kind">{card.kindLabel}</span>
        <span className="pfile-st">{card.stateLabel}</span>
      </span>
      <span className="pfile-body">
        <span className="pfile-name">{p.name}</span>
        <span className="pfile-goal">{p.goal}</span>
        {p.state === "preparing" && p.charterConfirmed && <span className="chip chip-ok pfile-chip">{t("pages.projects.charterConfirmed")}</span>}
        {/* 维护者用的运行时（289 号票）：插件登记的才标 */}
        <RuntimeChip runtime={projectRuntime(p, ui.tasks)} className="pfile-chip" />
        {/* 292 号票：会话交给了官方 App */}
        {remoteBadgeOf(p.takeover) && <RemoteBadge badge={remoteBadgeOf(p.takeover)!} className="pfile-chip" />}
        {/* 305 号票：用插件的运行时、工作目录在外面的写出在哪个文件夹做 */}
        {p.workdir.external && p.workdir.path && runtimeShown(projectRuntime(p, ui.tasks)) && (
          <span className="pfile-workdir" title={p.workdir.path}>
            {t("pages.projects.card.workdir", { path: p.workdir.path })}
          </span>
        )}
        <span className="pfile-ops">
          <OperationsSummary projectId={p.id} size="card" />
        </span>
        <span className="pfile-foot">
          <ActivityDot state={card.activity} note={activityNote(card.view.activity)} />
          <span className="pfile-fact">
            <T k="pages.projects.card.internal" params={{ n: <b className="pfile-n">{card.internalOpen}</b> }} />
          </span>
          <span className="pfile-fact">
            <T k="pages.projects.card.scheduled" params={{ n: <b className="pfile-n">{card.scheduled}</b> }} />
          </span>
          <span className="pfile-at">{t("pages.projects.card.lastAt", { time: timeLabel(card.lastAt) })}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * 点"新建项目"：不经"是不是项目"的判断，秘书直接出一张建议立项卡（289 号票：能选维护者用的运行时，写在卡上）。
 * 290 号票：选了能接管的运行时可以"从已有的会话接管"——不经秘书，直接建出项目
 */
function NewProjectDialog({ onClose }: { onClose(): void }) {
  const [what, setWhat] = useState("");
  const [runtime, setRuntime] = useState<string>(PI_RUNTIME_ID);
  /** 从已有的会话接管（290 号票）：换成接管的对话框 */
  const [taking, setTaking] = useState(false);
  /** 在哪个文件夹做（305 号票）：选了能选工作文件夹的运行时（Claude Code）才有 */
  const [folder, setFolder] = useState<FolderDraft>(EMPTY_FOLDER_DRAFT);
  const [folderError, setFolderError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const { newProject, http } = useStore();
  const toast = useToast();
  const folderShown = workFolderRuntime(useRuntimes(), runtime) !== undefined;
  const send = (chosen: WorkFolderChoice | undefined) => {
    newProject(what.trim(), runtime === PI_RUNTIME_ID ? undefined : runtime, chosen);
    toast(t("pages.projects.newToast", { name: ASSISTANT_NAME_MARK }));
    onClose();
  };
  const submit = () => {
    // 用已有文件夹的（305 号票）：先核对路径，不对的留在对话框里写明原因
    if (folderShown && folder.mode === "existing") {
      setChecking(true);
      setFolderError(undefined);
      http
        .checkRuntimeFolder(runtime, folder.path.trim())
        .then(
          () => send(folderChoiceOf(folder)),
          (err: unknown) => setFolderError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setChecking(false));
      return;
    }
    send(folderShown ? folderChoiceOf(folder) : undefined);
  };
  // 从已有的会话接管（290 号票）：不经秘书直接建出，写的话带过去当一句话目标
  if (taking) return <TakeoverSheet runtime={runtime} as="project" initial={what} onBack={() => setTaking(false)} onClose={onClose} />;
  return (
    <Sheet title={t("pages.projects.new.title")} onClose={onClose} center>
      <label className="field">
        <span>{t("pages.projects.new.what")}</span>
        <textarea value={what} onChange={(e) => setWhat(e.target.value)} placeholder={t("pages.projects.new.placeholder")} autoFocus />
      </label>
      <RuntimePicker value={runtime} onChange={setRuntime} />
      {/* 从已有的会话接管（290 号票）：选的运行时能接管才有 */}
      <TakeoverLink runtime={runtime} onOpen={() => setTaking(true)} />
      {/* 在哪个文件夹做（305 号票）：选的运行时能选工作文件夹才有 */}
      {folderShown && (
        <WorkFolderPicker
          runtime={runtime}
          as="project"
          title={what}
          draft={folder}
          onChange={(next) => {
            setFolder(next);
            setFolderError(undefined);
          }}
        />
      )}
      {folderShown && folderError && (
        <div className="prompt-broken" role="alert">
          {folderError}
        </div>
      )}
      <div className="hint">
        <T k="pages.projects.new.hint" params={{ name: <AssistantName /> }} />
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.projects.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!what.trim() || (folderShown && !folderDraftReady(folder)) || checking} onClick={submit}>
          <T k="pages.projects.new.submit" params={{ name: <AssistantName /> }} />
        </button>
      </div>
    </Sheet>
  );
}

// ---------- 项目 ----------

function workdirLabel(p: Project): string {
  if (p.workdir.external) return t("pages.projects.workdir.external", { path: p.workdir.path ?? "" });
  return t("pages.projects.workdir.records");
}

/**
 * 宽屏的整页项目（104 号票）：和维护者的会话占主区，项目的详情在会话左边的档案栏里。档案栏照长程任务的阶段栏（88、91 号票）：
 * 栏顶 × 整栏藏掉，标题栏左边（‹ 之后、标题之前，正在档案栏上方）的"项目档案"点一下开合；分界线能拖（默认 380，最窄 280，
 * 最宽外框的 60%）；开合和宽度按设备记住（和阶段栏分开记）。日历里点作业过来的这一次把档案栏打开、那一行高亮，不写进设置。
 * 已归档的项目会话只读
 */
function ProjectFull({ projectId, job, at, onBack }: { projectId: string; job?: string | undefined; at?: string | undefined; onBack(): void }) {
  const { ui, watchChannels } = useStore();
  const view = selectProject(ui, projectId);
  const conversation = view && maintainerChannel(view.project.maintainerId);
  const [conversationRef, detail] = useConversationPane(true, conversation);
  useEffect(() => {
    if (conversation) watchChannels([conversation]);
  }, [conversation, watchChannels]);
  const frameWidth = useContext(FrameWidth);
  const pref = useProjectSidePref();
  const remembered = useProjectSideWidth();
  /** 拖着的时候的宽度（松手才记到这台设备上） */
  const [dragging, setDragging] = useState<number>();
  /** 日历里点名的作业：这一次开着档案栏；你自己开合之后按你的 */
  const [jobOpen, setJobOpen] = useState(job);
  const layout = projectSideLayout({ pref, job: jobOpen });
  const setSide = (next: StageSidePref) => {
    setJobOpen(undefined);
    pageProjectSide().set(next);
  };
  if (!view || !conversation) {
    return (
      <div className="chat-col">
        <TopBar title={t("pages.projects.title")} onBack={onBack} />
        <div className="page-placeholder">{t("pages.projects.missing")}</div>
      </div>
    );
  }
  const p = view.project;
  const open = layout === "side";
  return (
    <DetailLayout wide detail={detail} conversation={conversation}>
      <div className="chat-col">
        <TopBar
          title={p.name}
          onBack={onBack}
          lead={
            <button type="button" className="stage-chip proj-side-chip" onClick={() => setSide(open ? "closed" : "open")} aria-expanded={open} aria-label={open ? t("pages.projects.side.hide") : t("pages.projects.side.show")}>
              {t("pages.projects.side.title")}
            </button>
          }
        >
          <span className={`pst pst-${p.state}`}>{PROJECT_STATE_LABEL[p.state]}</span>
          <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
          {/* 项目会话：▤ / 💬 一直显示 */}
          <ZoomToggle handle={conversationRef} />
          {/* 项目维护者的 ⚙（114 号票）：单独的提示词（跟着项目走）、清空当前对话（就是重置维护者）、上下文用量 */}
          <AgentSettingsButton agentId={p.maintainerId} wide />
        </TopBar>
        <div className="chat-row">
          {open && (
            <>
              <aside className="md-side proj-side" style={{ width: dragging ?? remembered }} aria-label={t("pages.projects.side.title")}>
                <div className="md-side-head">
                  <span>{t("pages.projects.side.title")}</span>
                  <button type="button" className="md-side-close" onClick={() => setSide("closed")} aria-label={t("pages.projects.side.hide")} title={t("pages.projects.side.hideTitle")}>
                    ×
                  </button>
                </div>
                <div className="scroll proj-side-body">
                  <ProjectHead view={view} narrow />
                  <ProjectSections view={view} job={job} />
                </div>
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
            <Conversation
              conversation={conversation}
              mode="maintainer"
              wide
              onDetail={detail.open}
              showDetail={detail.show}
              ref={conversationRef}
              revealAt={at}
              readOnly={p.state === "archived"}
              readOnlyNote={t("pages.projects.readOnlyInRecords")}
              // 等你处理（107 号票）：这个项目的、它内部任务的；归档了照样能点（删除项目的确认）
              inbox={{ kind: "project", projectId }}
            />
          </div>
        </div>
      </div>
    </DetailLayout>
  );
}

/** 窄屏的项目页：项目头（带"和维护者交流"）和下面各节，一列往下排 */
function ProjectPage({ projectId, job, onBack, onChat }: { projectId: string; job?: string | undefined; onBack(): void; onChat(): void }) {
  const { ui } = useStore();
  const view = selectProject(ui, projectId);
  if (!view) {
    return (
      <div className="chat-col">
        <TopBar title={t("pages.projects.title")} onBack={onBack} />
        <div className="page-placeholder">{t("pages.projects.missing")}</div>
      </div>
    );
  }
  return (
    <div className="chat-col">
      <TopBar title={view.project.name} onBack={onBack} />
      <div className="scroll page-pad">
        <ProjectHead view={view} onChat={onChat} />
        <ProjectSections view={view} job={job} />
      </div>
    </div>
  );
}

/**
 * 项目头：状态、维护者、进行中的任务、一句话目标、类型和工作目录，按当前状态给出的动作；onChat：窄屏的"和维护者交流"（宽屏会话就在旁边）。
 * 140 号票：下面紧跟"现在"一节（服务入口、定时任务在它的运营概况里）；narrow：维护者会话页左栏，用窄版
 */
function ProjectHead({ view, onChat, narrow = false }: { view: ProjectView; onChat?: (() => void) | undefined; narrow?: boolean }) {
  const { projectAction, ui } = useStore();
  const toast = useToast();
  const p = view.project;
  const act = (action: ProjectAction) => {
    projectAction(p.id, action);
    // 删除不马上删：二次确认在待我处理里
    if (action === "delete") toast(t("pages.projects.deleteToast", { name: p.name }));
    // 转入使用不马上转（259 号票）：确认卡出在"现在"里和待办里
    if (action === "go_live") toast(t("pages.projects.goLiveToast"));
  };
  return (
    <>
      <div className="card proj-head">
        <div className="proj-head-row">
          <span className={`pst pst-${p.state}`}>{PROJECT_STATE_LABEL[p.state]}</span>
          <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
          <span className="muted">{t("pages.projects.activeTasks", { count: view.activeTasks })}</span>
          {p.state === "preparing" && p.charterConfirmed && <span className="chip chip-ok">{t("pages.projects.charterConfirmed")}</span>}
        </div>
        <div className="proj-goal">{p.goal}</div>
        <div className="muted">
          {t("pages.projects.kindAndWorkdir", { kind: p.kind ? PROJECT_KIND_LABEL[p.kind] : t("pages.projects.kindPending"), dir: workdirLabel(p) })}
        </div>
        {p.fromTaskId && <div className="muted">{t("pages.projects.fromTask", { task: taskLabel(ui, p.fromTaskId) })}</div>}
        {p.buildTaskId && (
          <a className="link" href={toHash({ tab: "tasks", taskId: p.buildTaskId })}>
            {t("pages.projects.buildTask", { task: taskLabel(ui, p.buildTaskId) })}
          </a>
        )}
        {(onChat || view.actions.length > 0) && (
          <div className="auth-actions">
            {onChat && (
              <button type="button" className="btn primary" onClick={onChat}>
                {t("pages.projects.chat")}
              </button>
            )}
            {view.actions.map((action) => (
              <button
                key={action}
                type="button"
                className={`btn ${action === "delete" ? "danger" : "ghost"}`}
                disabled={view.archiveBlocked !== undefined && ARCHIVING_ACTIONS.includes(action)}
                onClick={() => act(action)}
              >
                {PROJECT_ACTION_LABEL[action]}
              </button>
            ))}
          </div>
        )}
        {view.archiveBlocked && view.actions.some((a) => ARCHIVING_ACTIONS.includes(a)) && <div className="muted">{view.archiveBlocked}</div>}
        {p.state === "archived" && <div className="muted">{t("pages.projects.archivedNote")}</div>}
      </div>
      <ProjectNowSection view={view} narrow={narrow} onChat={onChat} />
    </>
  );
}

/** 项目头下面的各节：立项书、规范（258 号票），以及内部任务、定时触发的、工单流水线、工具包、范围记录、维护者（原型的假项目用假数据） */
function ProjectSections({ view, job }: { view: ProjectView; job?: string | undefined }) {
  const { ui } = useStore();
  const p = view.project;
  const detail = projectDetailOf(p.id);
  return (
    <>
      {p.charterCardId && (
        <Section title={t("pages.projects.charter")} id={charterAnchor(p.id)}>
          <CardPanel cardId={p.charterCardId} />
          {/* 125 号票：立项书确认之后的立项要求变更（确认了的已经改进立项书，末尾有变更记录） */}
          {projectCharterChangeCards(ui, p.id).map((id) => (
            <CardPanel key={id} cardId={id} />
          ))}
        </Section>
      )}
      <ProjectStandardSection project={p} />
      <ProjectOperations project={p} />

      {detail ? (
        <ProtoSections project={p} detail={detail} />
      ) : (
        <>
          <Section title={t("pages.projects.internal")} extra={<span className="muted">{t("pages.projects.internalHint")}</span>}>
            <ProjectInternalTasks projectId={p.id} />
          </Section>
          <Section title={t("pages.projects.scheduled")}>
            <ProjectScheduledJobs projectId={p.id} job={job} />
          </Section>
          <Section title={t("pages.projects.pipeline")} extra={<span className="muted">{t("pages.projects.pipelineHint")}</span>}>
            <WorkOrderPipeline projectId={p.id} />
          </Section>
          <Section title={t("pages.projects.toolkit")}>
            {p.toolkit && p.charterConfirmed ? (
              <ToolkitPanel
                target={{ kind: "project", projectId: p.id }}
                toolkit={p.toolkit}
                readOnly={p.state === "archived"}
                readOnlyNote={t("pages.projects.toolkitReadOnly")}
              />
            ) : (
              <div className="muted">{t("pages.projects.toolkitPending")}</div>
            )}
          </Section>
          <Section title={t("pages.projects.scope")} extra={<span className="muted">{t("pages.projects.scopeHint")}</span>}>
            <ScopeRecordList groups={projectScopeRecords(ui, p.id)} empty={t("pages.projects.scopeEmpty")} />
          </Section>
          <MaintainerNote />
        </>
      )}
    </>
  );
}

/**
 * 项目内部任务（64 号票）：由项目的维护者执行的流程和长程任务（不上全局看板）。没结束的在前；结束了的每个有"归档"
 * （和全局任务一样只有你能归档）；归档了的收起来。每个写种类、状态（写明原因）、进度和用量，
 * 点进去是任务详情（执行过程在项目的维护者会话里）
 */
function ProjectInternalTasks({ projectId }: { projectId: string }) {
  const { ui, taskAction } = useStore();
  const [showArchived, setShowArchived] = useState(false);
  const { open, ended, archived } = projectInternalTasks(ui, projectId);
  if (open.length === 0 && ended.length === 0 && archived.length === 0) {
    return (
      <div className="muted">
        <T k="pages.projects.internalEmpty" params={{ name: <AssistantName /> }} />
      </div>
    );
  }
  return (
    <div>
      {open.map((v) => (
        <InternalTaskRow key={v.task.id} v={v} />
      ))}
      {open.length === 0 && <div className="muted">{t("pages.projects.internalNoneOpen")}</div>}
      {ended.length > 0 && <div className="lane-h">{t("pages.projects.internalEnded")}</div>}
      {ended.map((v) => (
        <InternalTaskRow key={v.task.id} v={v} onArchive={v.archivable ? () => taskAction(v.task.id, "archive") : undefined} />
      ))}
      {archived.length > 0 && (
        <button type="button" className="btn ghost" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
          {showArchived ? t("pages.projects.archivedShown", { count: archived.length }) : t("pages.projects.archivedHidden", { count: archived.length })}
        </button>
      )}
      {showArchived &&
        archived.map((v) => (
          <InternalTaskRow key={v.task.id} v={v} />
        ))}
    </div>
  );
}

/** 内部任务的一行：编号和标题（点进任务详情），种类、状态、进度和用量；结束了的有"归档" */
function InternalTaskRow({ v, onArchive }: { v: InternalTaskView; onArchive?: (() => void) | undefined }) {
  return (
    <div className="lane-item">
      <a className="link" href={toHash({ tab: "tasks", taskId: v.task.id })}>
        {t("pages.projects.ref", { id: v.task.id, title: v.task.title })}
      </a>
      <div className="muted">
        {v.kindLabel} · {v.status}
        {/* 311 号票：和任务卡一样写"124 万 token（其中缓存命中 104 万）" */}
        {v.tokens > 0 && ` · ${tokensText(v.tokens, v.cacheHitTokens)}`}
      </div>
      {/* 进度和看板卡同一份（60 号票：流程是做完的步数、长程任务是已验收的阶段数） */}
      {v.progress && (
        <div className="muted">
          <TaskProgress progress={v.progress} />
        </div>
      )}
      {onArchive && (
        <button type="button" className="btn small ghost" onClick={onArchive}>
          {t("pages.projects.archive")}
        </button>
      )}
    </div>
  );
}

/** 工单流水线（16 号票）：排队中、进行中、已结束三栏，每张工单显示来源、所属任务和这个任务现在到哪了 */
function WorkOrderPipeline({ projectId }: { projectId: string }) {
  const { ui } = useStore();
  const lanes = projectPipeline(ui, projectId);
  return (
    <div className="pipeline">
      {WORK_ORDER_LANES.map((lane) => (
        <div key={lane} className="lane">
          <div className="lane-h">
            {WORK_ORDER_LANE_LABEL[lane]} <span className="bgroup-n">{lanes[lane].length}</span>
          </div>
          {lanes[lane].map((v) => (
            <div key={v.workOrder.id} className="lane-item">
              <b>{v.workOrder.id}</b> {v.kind}
              <div>
                {isJobRunWorkOrder(v.workOrder) ? (
                  <span>{v.job ? t("pages.projects.ref", { id: v.job.id, title: v.job.title }) : v.workOrder.title}</span>
                ) : (
                  <a className="link" href={toHash({ tab: "tasks", taskId: v.workOrder.taskId })}>
                    {t("pages.projects.ref", { id: v.workOrder.taskId, title: v.workOrder.taskTitle })}
                  </a>
                )}
              </div>
              <div className="muted">
                {t("pages.projects.statusFrom", { status: v.status, source: v.source })}
                {v.stage && t("pages.projects.taskStage", { stage: v.stage })}
                {v.run && t("pages.projects.thisRun", { run: v.run })}
              </div>
              {v.workOrder.reason && <div className="muted">{v.workOrder.reason}</div>}
            </div>
          ))}
          {lanes[lane].length === 0 && <div className="muted">—</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * 项目里定时触发的任务（76 号票；19 号票的定时作业）：每个的时间表、状态（运营中、已暂停及原因）、最近一次失败、下一次，以及暂停、恢复、取消；
 * 点名字去它的任务详情（按运行分段）。在"发起任务"里选这个项目、"什么时候做：定时"建；项目停用时跟着暂停（停用期间恢复会被拒）
 */
function ProjectScheduledJobs({ projectId, job }: { projectId: string; job?: string }) {
  const { ui } = useStore();
  const jobs = projectScheduledJobs(ui, projectId);
  if (jobs.length === 0) return <div className="muted">{t("pages.projects.noScheduled")}</div>;
  return (
    <>
      {jobs.map((v) => (
        <ProjectJobRow key={v.job.id} v={v} on={job === v.job.id} />
      ))}
    </>
  );
}

/** 项目页上的一个定时作业；on：日历里点它过来的，高亮并滚到看得见的地方 */
function ProjectJobRow({ v, on }: { v: ScheduledJobView; on: boolean }) {
  const { scheduledJobAction } = useStore();
  const ref = useRevealed<HTMLDivElement>(on);
  return (
    <div ref={ref} className={`sjob-row${on ? " on" : ""}`}>
      <div>
        {v.job.ownerTaskId ? (
          <a className="link" href={toHash({ tab: "tasks", taskId: v.job.ownerTaskId })}>
            <b>{v.job.title}</b>
          </a>
        ) : (
          <b>{v.job.title}</b>
        )}
        <div className="muted">
          {v.scheduleText}
          {v.job.nextAt && t("pages.projects.jobNext", { time: timeLabel(v.job.nextAt) })}
          {v.lastRun && t("pages.projects.jobLast", { time: timeLabel(v.lastRun.endedAt ?? v.lastRun.queuedAt) })}
        </div>
        <JobAuthorization grants={v.grants} rules={v.rules} />
      </div>
      <span className={`st ${v.job.state === "active" ? "st-ops" : "st-paused"}`}>{v.statusText}</span>
      {v.lastFailedText && <span className="chip chip-no">{v.lastFailedText}</span>}
      {v.lastPartialText && <span className="chip chip-op">{v.lastPartialText}</span>}
      {v.actions
        .filter((a) => a !== "cancel")
        .map((a) => (
          <button key={a} type="button" className="btn ghost small" onClick={() => scheduledJobAction(v.job.id, a)}>
            {SCHEDULED_JOB_ACTION_LABEL[a]}
          </button>
        ))}
    </div>
  );
}

/** 运营方案的一条在项目页上的状态色：在跑的绿、暂停的灰、没生效的红、要你手动的提醒色、结束了的灰 */
const OPERATION_STATUS_CLASS: Record<OperationRow["status"], string> = { running: "st-ops", paused: "st-paused", failed: "st-failed", manual: "st-manual", ended: "st-paused" };

/**
 * 运营方案（130 号票）：现在生效的运营方案里每一条——叫什么、什么时候、怎么做、要的能力、状态（在跑、暂停及原因、没生效及原因、
 * 要你手动的写明步骤、已结束），点名字去它的任务详情；"运营方案变更"卡列在下面。没有运营方案、也没有变更卡的项目不显示这一节
 */
function ProjectOperations({ project: p }: { project: Project }) {
  const { ui } = useStore();
  const rows = projectOperationRows(ui, p);
  const changeCards = projectOperationsChangeCards(ui, p.id);
  if (!p.operations && changeCards.length === 0) return null;
  return (
    <Section title={t("pages.projects.operations")} extra={p.operations ? <span className="muted">{t("pages.projects.operationsRevision", { revision: p.operations.revision, time: timeLabel(p.operations.confirmedAt) })}</span> : undefined}>
      {rows.length === 0 && <div className="muted">{t("pages.projects.operationsEmpty")}</div>}
      {rows.map((r) => (
        <div key={r.item.key} className="ops-row">
          <div>
            {r.taskId ? (
              <a className="link" href={toHash({ tab: "tasks", taskId: r.taskId })}>
                <b>{r.item.name}</b>
              </a>
            ) : (
              <b>{r.item.name}</b>
            )}
            <div className="muted">
              {r.item.triggerText} · <NamedText text={r.howText} />
            </div>
            {r.nextAt && <div className="muted">{t("pages.projects.operationNext", { time: timeLabel(r.nextAt) })}</div>}
            {r.detail && <div className={r.status === "failed" ? "ops-row-failed" : "ops-manual-note"}>{r.detail}</div>}
            {/* 133 号票：服务那一条的入口（还算在项目上的才有：撤下了的不给） */}
            {r.service && r.service.rollout !== "withdrawn" && (
              <div className="svc-entries">
                <ServiceEntry view={r.service} compact />
              </div>
            )}
          </div>
          <span className={`st ${OPERATION_STATUS_CLASS[r.status]}`}>{r.statusText}</span>
        </div>
      ))}
      {changeCards.map((id) => (
        <CardPanel key={id} cardId={id} />
      ))}
    </Section>
  );
}

/**
 * 维护者那一节：重置维护者（16 号票）并到会话标题栏的 ⚙ 里了（114 号票，"清空当前对话"就是重置维护者，只留一处），这里只说一声去哪找
 */
function MaintainerNote() {
  return (
    <Section title={t("pages.projects.maintainer")}>
      <div className="muted">{t("pages.projects.maintainerNote")}</div>
    </Section>
  );
}

/** 原型假项目才有的几节：定时作业、工单流水线、工具包的修改、范围记录（各自的票接真数据）；维护者那一节指向 ⚙ */
function ProtoSections({ project: p, detail }: { project: Project; detail: ProjectDetail }) {
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJobSummary[]>(detail.scheduledJobs);
  return (
    <>
      <Section title={t("pages.projects.scheduled")} extra={<span className="muted">{t("pages.projects.serviceHint")}</span>}>
        {scheduledJobs.length === 0 && <div className="muted">{t("pages.projects.noScheduled")}</div>}
        {scheduledJobs.map((j) => (
          <div key={j.id} className="sjob-row">
            <div>
              <b>{j.title}</b>
              <div className="muted">
                {j.schedule}
                {j.lastRun && t("pages.projects.jobLast", { time: timeLabel(j.lastRun.at) })}
              </div>
            </div>
            <span className={`st ${j.status === "active" ? "st-ops" : "st-paused"}`}>{scheduledJobStatusLabel(j)}</span>
            {j.lastRun?.partial ? <span className="chip chip-op">{t("pages.projects.lastPartial")}</span> : j.lastRun && !j.lastRun.ok && <span className="chip chip-no">{t("pages.projects.lastFailed")}</span>}
            <button
              type="button"
              className="btn ghost small"
              disabled={p.state === "retired" || p.state === "archived"}
              onClick={() => setScheduledJobs((js) => js.map((x) => (x.id === j.id ? { ...x, status: x.status === "active" ? "paused" : "active", autoPaused: false } : x)))}
            >
              {j.status === "active" ? t("pages.projects.pause") : t("pages.projects.resume")}
            </button>
          </div>
        ))}
      </Section>

      <Section title={t("pages.projects.pipeline")}>
        <Pipeline orders={detail.workOrders} />
      </Section>

      <Section title={t("pages.projects.toolkit")}>
        <ToolkitEditor initial={detail.toolkit} readOnly={p.state === "archived"} />
      </Section>

      <Section title={t("pages.projects.scope")}>
        {detail.scopeRecords.length === 0 && <div className="muted">{t("pages.projects.scopeEmptyProto")}</div>}
        {detail.scopeRecords.map((r) => (
          <div key={r.id} className={`scope-row scope-${r.kind}`}>
            <span className={`chip ${r.kind === "overreach" ? "chip-no" : "chip-ok"}`}>{r.kind === "change" ? t("pages.projects.scopeChange") : t("pages.projects.overreach")}</span> {r.text}
            <span className="muted"> · {timeLabel(r.at)}</span>
          </div>
        ))}
      </Section>

      <MaintainerNote />
    </>
  );
}

/** 原型假项目的工单三栏的名字（按当前语言现取） */
const LANE_TITLE = tTable({ queued: "pages.projects.lane.queued", active: "pages.projects.lane.active", ended: "pages.projects.lane.ended" });

const LANES: { id: keyof typeof LANE_TITLE; match(w: WorkOrder): boolean }[] = [
  { id: "queued", match: (w) => w.status === "queued" || w.status === "waiting_for_user" },
  { id: "active", match: (w) => w.status === "in_progress" || w.status === "clarifying" },
  { id: "ended", match: (w) => w.status === "done" || w.status === "returned" || w.status === "unable" },
];

function Pipeline({ orders }: { orders: WorkOrder[] }) {
  return (
    <div className="pipeline">
      {LANES.map((lane) => {
        const xs = orders.filter(lane.match);
        return (
          <div key={lane.id} className="lane">
            <div className="lane-h">
              {LANE_TITLE[lane.id]} <span className="bgroup-n">{xs.length}</span>
            </div>
            {xs.map((w) => (
              <div key={w.id} className="lane-item">
                <T k="pages.projects.ref" params={{ id: <b>{w.id}</b>, title: w.title }} />
                <div className="muted">{t("pages.projects.statusFrom", { status: WORK_ORDER_STATUS_LABEL[w.status], source: w.from })}</div>
              </div>
            ))}
            {xs.length === 0 && <div className="muted">—</div>}
          </div>
        );
      })}
    </div>
  );
}

/** 和维护者交流：共用的会话组件；已归档的项目只读。打开时才订阅这个维护者的会话频道 */
function MaintainerChat({ projectId, wide, at, onBack }: { projectId: string; wide: boolean; at?: string | undefined; onBack(): void }) {
  const { ui, watchChannels } = useStore();
  const view = selectProject(ui, projectId);
  const conversation = view && maintainerChannel(view.project.maintainerId);
  const [conversationRef, detail] = useConversationPane(wide, conversation);
  useEffect(() => {
    if (conversation) watchChannels([conversation]);
  }, [conversation, watchChannels]);
  if (!view || !conversation) return <div className="page-placeholder">{t("pages.projects.missing")}</div>;
  return (
    <DetailLayout wide={wide} detail={detail} conversation={conversation}>
      <div className="chat-col">
        <TopBar title={t("pages.projects.chatTitle", { name: view.project.name })} onBack={onBack}>
          <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
          {/* 项目会话：▤ / 💬 一直显示 */}
          <ZoomToggle handle={conversationRef} />
          <AgentSettingsButton agentId={view.project.maintainerId} wide={wide} />
        </TopBar>
        <Conversation
          conversation={conversation}
          mode="maintainer"
          wide={wide}
          onDetail={detail.open}
          showDetail={detail.show}
          ref={conversationRef}
          revealAt={at}
          readOnly={view.project.state === "archived"}
          readOnlyNote={t("pages.projects.readOnlyOnPage")}
          inbox={{ kind: "project", projectId }}
        />
      </div>
    </DetailLayout>
  );
}
