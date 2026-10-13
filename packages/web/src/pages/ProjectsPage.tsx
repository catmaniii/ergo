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
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pageProjectFold, pageProjectSide, pageProjectSideWidth, useProjectFolded, useProjectSidePref, useProjectSideWidth } from "../app/page-project-wall.ts";
import { goBackTo, type Navigate, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { scheduledJobStatusLabel, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import {
  ASSISTANT_NAME_MARK,
  activityNote,
  ARCHIVING_ACTIONS,
  dragProjectSideWidth,
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
  projectInternalTasks,
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
  wallScrollOnReturn,
  WORK_ORDER_LANE_LABEL,
  WORK_ORDER_LANES,
} from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import type { ScheduledJobSummary, WorkOrder } from "../model/types.ts";
import { type ProjectDetail, projectDetailOf } from "../prototype/fake-data.ts";
import { useToast } from "../ui/toast.tsx";
import { AssistantName } from "../ui/assistant-name.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { AgentSettingsButton } from "../ui/agent-settings.tsx";
import { ActivityDot, Section, Sheet, Splitter, TopBar, useRevealed } from "../ui/common.tsx";
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
      <TopBar title="项目">
        <button type="button" className="btn primary small" onClick={() => setCreating(true)}>
          ＋ 新建项目
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
        {wall.groups.length === 0 && <div className="muted page-pad">还没有项目。</div>}
        <div className="hint">
          新项目从<AssistantName />的"建议立项"卡（你直接说要立项、点"新建项目"也是<AssistantName />出这张卡）或者任务转为项目时产生。
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
        <WallStat n={overview.working} label="维护者在干活" />
        <WallStat n={overview.internalOpen} label="内部任务进行中" />
        <WallStat n={overview.scheduled} label="定时触发" />
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

/** 一张项目卡（一份档案）：上沿页签写种类和状态，正文是名字（大）和一句话目标，底下一行是现在的动静 */
function ProjectFileCard({ card, onOpen }: { card: ProjectCard; onOpen(): void }) {
  const p = card.view.project;
  return (
    <button type="button" className={`pfile pf-${p.state}`} onClick={onOpen}>
      <span className="pfile-tab">
        <span className="pfile-kind">{card.kindLabel}</span>
        <span className="pfile-st">{card.stateLabel}</span>
      </span>
      <span className="pfile-body">
        <span className="pfile-name">{p.name}</span>
        <span className="pfile-goal">{p.goal}</span>
        {p.state === "preparing" && p.charterConfirmed && <span className="chip chip-ok pfile-chip">立项书已确认</span>}
        <span className="pfile-foot">
          <ActivityDot state={card.activity} note={activityNote(card.view.activity)} />
          <span className="pfile-fact">
            内部任务 <b className="pfile-n">{card.internalOpen}</b>
          </span>
          <span className="pfile-fact">
            定时 <b className="pfile-n">{card.scheduled}</b>
          </span>
          <span className="pfile-at">最近 {timeLabel(card.lastAt)}</span>
        </span>
      </span>
    </button>
  );
}

/** 点"新建项目"：不经"是不是项目"的判断，秘书直接出一张建议立项卡 */
function NewProjectDialog({ onClose }: { onClose(): void }) {
  const [what, setWhat] = useState("");
  const { newProject } = useStore();
  const toast = useToast();
  const submit = () => {
    newProject(what.trim());
    toast(`${ASSISTANT_NAME_MARK}会直接给你一张建议立项卡，点“立项”项目就诞生`);
    onClose();
  };
  return (
    <Sheet title="新建项目" onClose={onClose} center>
      <label className="field">
        <span>想立个什么项目（一件长期的事）</span>
        <textarea value={what} onChange={(e) => setWhat(e.target.value)} placeholder="比如：把家里电器的保修单、说明书和维修记录收在一处，保修到期前提醒我" autoFocus />
      </label>
      <div className="hint">
        <AssistantName />
        据此给出建议立项卡（名字、一句话目标）。点"立项"后项目以筹备中诞生，维护者和你做立项问答，最后交出立项书。
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!what.trim()} onClick={submit}>
          交给
          <AssistantName />
        </button>
      </div>
    </Sheet>
  );
}

// ---------- 项目 ----------

function workdirLabel(p: Project): string {
  if (p.workdir.external) return `绑定外部路径 ${p.workdir.path ?? ""}（不随二狗备份，靠项目自己的 git 远端）`;
  return "项目档案里（默认）";
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
        <TopBar title="项目" onBack={onBack} />
        <div className="page-placeholder">没有这个项目（可能已经删除了）</div>
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
            <button type="button" className="stage-chip proj-side-chip" onClick={() => setSide(open ? "closed" : "open")} aria-expanded={open} aria-label={open ? "收起项目档案" : "看项目档案"}>
              项目档案
            </button>
          }
        >
          <span className={`pst pst-${p.state}`}>{PROJECT_STATE_LABEL[p.state]}</span>
          <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
          {/* 项目会话：▤ / 💬 一直显示（照 AgentSense） */}
          <ZoomToggle handle={conversationRef} />
          {/* 项目维护者的 ⚙（114 号票）：单独的提示词（跟着项目走）、清空当前对话（就是重置维护者）、上下文用量 */}
          <AgentSettingsButton agentId={p.maintainerId} wide />
        </TopBar>
        <div className="chat-row">
          {open && (
            <>
              <aside className="md-side proj-side" style={{ width: dragging ?? remembered }} aria-label="项目档案">
                <div className="md-side-head">
                  <span>项目档案</span>
                  <button type="button" className="md-side-close" onClick={() => setSide("closed")} aria-label="收起项目档案" title="收起项目档案（点标题栏的“项目档案”再打开）">
                    ×
                  </button>
                </div>
                <div className="scroll proj-side-body">
                  <ProjectHead view={view} />
                  <ProjectSections view={view} job={job} />
                </div>
              </aside>
              <Splitter
                label="拖动调整项目档案的宽度"
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
              ref={conversationRef}
              revealAt={at}
              readOnly={p.state === "archived"}
              readOnlyNote="已归档的项目，维护者会话只读：要接着说话，先在项目档案里取消归档"
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
        <TopBar title="项目" onBack={onBack} />
        <div className="page-placeholder">没有这个项目（可能已经删除了）</div>
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

/** 项目头：状态、维护者、进行中的任务、一句话目标、类型和工作目录，按当前状态给出的动作；onChat：窄屏的"和维护者交流"（宽屏会话就在旁边） */
function ProjectHead({ view, onChat }: { view: ProjectView; onChat?: (() => void) | undefined }) {
  const { projectAction } = useStore();
  const toast = useToast();
  const p = view.project;
  const act = (action: ProjectAction) => {
    projectAction(p.id, action);
    // 删除不马上删：二次确认在待我处理里
    if (action === "delete") toast(`删除要在待办里再确认一次：「${p.name}」`);
  };
  return (
    <div className="card proj-head">
      <div className="proj-head-row">
        <span className={`pst pst-${p.state}`}>{PROJECT_STATE_LABEL[p.state]}</span>
        <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
        <span className="muted">进行中任务 {view.activeTasks}</span>
        {p.state === "preparing" && p.charterConfirmed && <span className="chip chip-ok">立项书已确认</span>}
      </div>
      <div className="proj-goal">{p.goal}</div>
      <div className="muted">
        {p.kind ? PROJECT_KIND_LABEL[p.kind] : "项目类型等立项书确认"} · 工作目录：{workdirLabel(p)}
      </div>
      {p.fromTaskId && <div className="muted">由任务 {p.fromTaskId} 转来</div>}
      {p.buildTaskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.buildTaskId })}>
          首个建设任务 {p.buildTaskId} ▸
        </a>
      )}
      {(onChat || view.actions.length > 0) && (
        <div className="auth-actions">
          {onChat && (
            <button type="button" className="btn primary" onClick={onChat}>
              和维护者交流
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
      {p.state === "archived" && <div className="muted">已归档：维护者会话只读。删除要二次确认，项目档案和维护者会话都会删掉，你在里面说过的话作为素材保留。</div>}
    </div>
  );
}

/** 项目头下面的各节：立项书，以及内部任务、定时触发的、工单流水线、工具包、范围记录、维护者（原型的假项目用假数据） */
function ProjectSections({ view, job }: { view: ProjectView; job?: string | undefined }) {
  const { ui } = useStore();
  const p = view.project;
  const detail = projectDetailOf(p.id);
  return (
    <>
      {p.charterCardId && (
        <Section title="立项书">
          <CardPanel cardId={p.charterCardId} />
        </Section>
      )}

      {detail ? (
        <ProtoSections project={p} detail={detail} />
      ) : (
        <>
          <Section title="内部任务" extra={<span className="muted">维护者在项目里发起、自己执行，不上全局看板</span>}>
            <ProjectInternalTasks projectId={p.id} />
          </Section>
          <Section title="定时触发的任务">
            <ProjectScheduledJobs projectId={p.id} job={job} />
          </Section>
          <Section title="工单流水线" extra={<span className="muted">一次只做一件，先来先做</span>}>
            <WorkOrderPipeline projectId={p.id} />
          </Section>
          <Section title="工具包">
            {p.toolkit && p.charterConfirmed ? (
              <ToolkitPanel
                target={{ kind: "project", projectId: p.id }}
                toolkit={p.toolkit}
                readOnly={p.state === "archived"}
                readOnlyNote="项目已归档：工具包不能改；取消归档后再改"
              />
            ) : (
              <div className="muted">立项书确认后才有工具包（维护者在立项书里提议，你确认时生效）</div>
            )}
          </Section>
          <Section title="范围记录" extra={<span className="muted">压缩会话和每张工单结束时审视</span>}>
            <ScopeRecordList groups={projectScopeRecords(ui, p.id)} empty="没有。每次压缩会话和每张工单结束时做范围审视，越界和你授权过的范围变更记在这里。" />
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
        没有。在“和维护者交流”里点明“按流程做：……”“发起任务：……”（或输入 /流程、/任务），或者跟<AssistantName />点明要做这个项目的事，就在项目里发起；维护者觉得该做维护时会给你一张建议卡。
      </div>
    );
  }
  return (
    <div>
      {open.map((v) => (
        <InternalTaskRow key={v.task.id} v={v} />
      ))}
      {open.length === 0 && <div className="muted">没有进行中的内部任务</div>}
      {ended.length > 0 && <div className="lane-h">结束了的</div>}
      {ended.map((v) => (
        <InternalTaskRow key={v.task.id} v={v} onArchive={v.archivable ? () => taskAction(v.task.id, "archive") : undefined} />
      ))}
      {archived.length > 0 && (
        <button type="button" className="btn ghost" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
          已归档 {archived.length} 个 {showArchived ? "收起 ▾" : "展开 ▸"}
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
        {v.task.id}「{v.task.title}」
      </a>
      <div className="muted">
        {v.kindLabel} · {v.status}
        {v.tokens > 0 && ` · ${v.tokens.toLocaleString()} token`}
      </div>
      {/* 进度和看板卡同一份（60 号票：流程是做完的步数、长程任务是已验收的阶段数） */}
      {v.progress && (
        <div className="muted">
          <TaskProgress progress={v.progress} />
        </div>
      )}
      {onArchive && (
        <button type="button" className="btn small ghost" onClick={onArchive}>
          归档
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
                  <span>{v.job ? `${v.job.id}「${v.job.title}」` : v.workOrder.title}</span>
                ) : (
                  <a className="link" href={toHash({ tab: "tasks", taskId: v.workOrder.taskId })}>
                    {v.workOrder.taskId}「{v.workOrder.taskTitle}」
                  </a>
                )}
              </div>
              <div className="muted">
                {v.status} · 来自{v.source}
                {v.stage && ` · 任务${v.stage}`}
                {v.run && ` · 这次运行${v.run}`}
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
  if (jobs.length === 0) return <div className="muted">没有定时触发的任务。在“发起任务”里选这个项目、“什么时候做”选“定时”来建。</div>;
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
          {v.job.nextAt && ` · 下次 ${timeLabel(v.job.nextAt)}`}
          {v.lastRun && ` · 最近一次 ${timeLabel(v.lastRun.endedAt ?? v.lastRun.queuedAt)}`}
        </div>
        <JobAuthorization grants={v.grants} rules={v.rules} />
      </div>
      <span className={`st ${v.job.state === "active" ? "st-ops" : "st-paused"}`}>{v.statusText}</span>
      {v.lastFailedText && <span className="chip chip-no">{v.lastFailedText}</span>}
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

/**
 * 维护者那一节：重置维护者（16 号票）并到会话标题栏的 ⚙ 里了（114 号票，"清空当前对话"就是重置维护者，只留一处），这里只说一声去哪找
 */
function MaintainerNote() {
  return (
    <Section title="维护者">
      <div className="muted">
        维护者对项目的理解存在项目档案里，不靠会话。理解跑偏了可以重置（新开一段会话，只凭项目档案重建理解，旧会话保留可查）：点维护者会话标题栏上的 ⚙，选“清空当前对话”。这个项目单独的提示词、上下文用量也在那里。
      </div>
    </Section>
  );
}

/** 原型假项目才有的几节：定时作业、工单流水线、工具包的修改、范围记录（各自的票接真数据）；维护者那一节指向 ⚙ */
function ProtoSections({ project: p, detail }: { project: Project; detail: ProjectDetail }) {
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJobSummary[]>(detail.scheduledJobs);
  return (
    <>
      <Section title="定时触发的任务" extra={<span className="muted">项目自己的服务在不在线：第二阶段</span>}>
        {scheduledJobs.length === 0 && <div className="muted">没有定时触发的任务。在“发起任务”里选这个项目、“什么时候做”选“定时”来建。</div>}
        {scheduledJobs.map((j) => (
          <div key={j.id} className="sjob-row">
            <div>
              <b>{j.title}</b>
              <div className="muted">
                {j.schedule}
                {j.lastRun && ` · 最近一次 ${timeLabel(j.lastRun.at)}`}
              </div>
            </div>
            <span className={`st ${j.status === "active" ? "st-ops" : "st-paused"}`}>{scheduledJobStatusLabel(j)}</span>
            {j.lastRun && !j.lastRun.ok && <span className="chip chip-no">最近一次失败</span>}
            <button
              type="button"
              className="btn ghost small"
              disabled={p.state === "retired" || p.state === "archived"}
              onClick={() => setScheduledJobs((js) => js.map((x) => (x.id === j.id ? { ...x, status: x.status === "active" ? "paused" : "active", autoPaused: false } : x)))}
            >
              {j.status === "active" ? "暂停" : "恢复"}
            </button>
          </div>
        ))}
      </Section>

      <Section title="工单流水线">
        <Pipeline orders={detail.workOrders} />
      </Section>

      <Section title="工具包">
        <ToolkitEditor initial={detail.toolkit} readOnly={p.state === "archived"} />
      </Section>

      <Section title="范围记录">
        {detail.scopeRecords.length === 0 && <div className="muted">没有。每次压缩会话和每张工单结束时做范围审视，结果记在这里。</div>}
        {detail.scopeRecords.map((r) => (
          <div key={r.id} className={`scope-row scope-${r.kind}`}>
            <span className={`chip ${r.kind === "overreach" ? "chip-no" : "chip-ok"}`}>{r.kind === "change" ? "范围变更" : "越界"}</span> {r.text}
            <span className="muted"> · {timeLabel(r.at)}</span>
          </div>
        ))}
      </Section>

      <MaintainerNote />
    </>
  );
}

const LANES: { title: string; match(w: WorkOrder): boolean }[] = [
  { title: "排队中", match: (w) => w.status === "queued" || w.status === "waiting_for_user" },
  { title: "进行中", match: (w) => w.status === "in_progress" || w.status === "clarifying" },
  { title: "已结束", match: (w) => w.status === "done" || w.status === "returned" || w.status === "unable" },
];

function Pipeline({ orders }: { orders: WorkOrder[] }) {
  return (
    <div className="pipeline">
      {LANES.map((lane) => {
        const xs = orders.filter(lane.match);
        return (
          <div key={lane.title} className="lane">
            <div className="lane-h">
              {lane.title} <span className="bgroup-n">{xs.length}</span>
            </div>
            {xs.map((w) => (
              <div key={w.id} className="lane-item">
                <b>{w.id}</b> {w.title}
                <div className="muted">
                  {WORK_ORDER_STATUS_LABEL[w.status]} · 来自{w.from}
                </div>
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
  if (!view || !conversation) return <div className="page-placeholder">没有这个项目（可能已经删除了）</div>;
  return (
    <DetailLayout wide={wide} detail={detail} conversation={conversation}>
      <div className="chat-col">
        <TopBar title={`${view.project.name} · 维护者`} onBack={onBack}>
          <ActivityDot state={view.activity.state} note={activityNote(view.activity)} />
          {/* 项目会话：▤ / 💬 一直显示（照 AgentSense） */}
          <ZoomToggle handle={conversationRef} />
          <AgentSettingsButton agentId={view.project.maintainerId} wide={wide} />
        </TopBar>
        <Conversation
          conversation={conversation}
          mode="maintainer"
          wide={wide}
          onDetail={detail.open}
          ref={conversationRef}
          revealAt={at}
          readOnly={view.project.state === "archived"}
          readOnlyNote="已归档的项目，维护者会话只读：要接着说话，先在项目页上取消归档"
          inbox={{ kind: "project", projectId }}
        />
      </div>
    </DetailLayout>
  );
}
