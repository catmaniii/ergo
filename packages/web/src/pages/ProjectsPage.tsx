// 项目页：项目列表（状态、进行中任务数、"新建项目"）+ 简版项目页（状态、项目类型、工作目录、"和维护者交流"、
// 按当前状态给出的动作）+ 维护者会话。15 号票起项目来自前端状态层（项目列表频道，state/projects.ts）；
// 16 号票起工单流水线（state/work-orders.ts）和重置维护者接真数据；18 号票起范围记录（state/scope-records.ts，越界和范围变更分开）；
// 19 号票起定时作业列表接真数据（state/scheduled-jobs.ts）；64 号票起"内部任务"一栏（state/projects.ts 的 projectInternalTasks）；工具包的修改（27）还只有原型的假项目有（原型的假项目整页用假数据）。
import { useEffect, useState } from "react";
import { type Navigate, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { scheduledJobStatusLabel, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import {
  ASSISTANT_NAME_MARK,
  activityNote,
  ARCHIVING_ACTIONS,
  isJobRunWorkOrder,
  maintainerChannel,
  type Project,
  type ProjectAction,
  PROJECT_ACTION_LABEL,
  PROJECT_KIND_LABEL,
  PROJECT_STATE_LABEL,
  type InternalTaskView,
  type ProjectView,
  projectInternalTasks,
  projectPipeline,
  projectScheduledJobs,
  type ScheduledJobView,
  projectScopeRecords,
  projectViews,
  RESET_MAINTAINER_LABEL,
  SCHEDULED_JOB_ACTION_LABEL,
  selectProject,
  WORK_ORDER_LANE_LABEL,
  WORK_ORDER_LANES,
} from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import type { ScheduledJobSummary, WorkOrder } from "../model/types.ts";
import { type ProjectDetail, projectDetailOf } from "../prototype/fake-data.ts";
import { useToast } from "../ui/toast.tsx";
import { AssistantName } from "../ui/assistant-name.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, ListDetail, Section, Sheet, TopBar, useRevealed } from "../ui/common.tsx";
import { Conversation, useConversationPane, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { JobAuthorization } from "../ui/job-authorization.tsx";
import { ScopeRecordList } from "../ui/scope-records.tsx";
import { DetailLayout } from "../ui/detail/DetailLayout.tsx";
import { ToolkitEditor, ToolkitPanel } from "./ToolkitEditor.tsx";

/** jobId：日历里点作业过来，项目页上这个定时作业那一行高亮并滚到看得见的地方（35 号票） */
export function ProjectsPage({ wide, projectId, chat, jobId, navigate }: { wide: boolean; projectId?: string; chat?: boolean; jobId?: string; navigate: Navigate }) {
  const back = wide ? undefined : () => navigate({ tab: "projects" });
  return (
    <ListDetail
      wide={wide}
      list={<ProjectList selected={projectId} onOpen={(id) => navigate({ tab: "projects", projectId: id })} />}
      detail={
        projectId ? (
          chat ? (
            <MaintainerChat key={`${projectId}-chat`} projectId={projectId} wide={wide} onBack={() => navigate({ tab: "projects", projectId })} />
          ) : (
            <ProjectPage key={projectId} projectId={projectId} job={jobId} onBack={back} onChat={() => navigate({ tab: "projects", projectId, chat: true })} />
          )
        ) : undefined
      }
    />
  );
}

function ProjectList({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { ui } = useStore();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const views = projectViews(ui);
  const live = views.filter((v) => v.project.state !== "archived");
  const archived = views.filter((v) => v.project.state === "archived");
  const row = (v: ProjectView) => (
    <ProjectRow key={v.project.id} v={v} on={selected === v.project.id} onOpen={() => onOpen(v.project.id)} />
  );
  return (
    <div className="chat-col">
      <TopBar title="项目">
        <button type="button" className="btn primary small" onClick={() => setCreating(true)}>
          ＋ 新建项目
        </button>
      </TopBar>
      <div className="scroll board">
        {live.map(row)}
        {live.length === 0 && <div className="muted page-pad">还没有项目。</div>}
        <button type="button" className="bgroup-h" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
          <b>已归档</b>
          <span className="bgroup-n">{archived.length}</span>
          <span className="muted">{showArchived ? "收起 ▾" : "展开 ▸"}</span>
        </button>
        {showArchived && archived.map(row)}
        <div className="hint">
          新项目从<AssistantName />的"建议立项"卡（你直接说要立项、点"新建项目"也是<AssistantName />出这张卡）或者任务转为项目时产生。
        </div>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function ProjectRow({ v, on, onOpen }: { v: ProjectView; on: boolean; onOpen(): void }) {
  const p = v.project;
  return (
    <button type="button" className={`bcard${on ? " on" : ""}`} onClick={onOpen}>
      <div className="bcard-row">
        <span className="bcard-title">{p.name}</span>
        <span className={`pst pst-${p.state}`}>{PROJECT_STATE_LABEL[p.state]}</span>
      </div>
      <div className="bcard-meta">
        <ActivityDot state={v.activity.state} note={activityNote(v.activity)} />
        <span>进行中任务 {v.activeTasks}</span>
        {p.state === "preparing" && p.charterConfirmed && <span className="chip chip-ok">立项书已确认</span>}
      </div>
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

function workdirLabel(p: Project): string {
  if (p.workdir.external) return `绑定外部路径 ${p.workdir.path ?? ""}（不随二狗备份，靠项目自己的 git 远端）`;
  return "项目档案里（默认）";
}

function ProjectPage({ projectId, job, onBack, onChat }: { projectId: string; job?: string; onBack?: () => void; onChat(): void }) {
  const { ui, projectAction } = useStore();
  const toast = useToast();
  const view = selectProject(ui, projectId);
  const detail = projectDetailOf(projectId);
  if (!view) return <div className="page-placeholder">没有这个项目（可能已经删除了）</div>;
  const p = view.project;

  const act = (action: ProjectAction) => {
    projectAction(p.id, action);
    // 删除不马上删：二次确认在待我处理里
    if (action === "delete") toast(`删除要在待办里再确认一次：「${p.name}」`);
  };

  return (
    <div className="chat-col">
      <TopBar title={p.name} onBack={onBack} />
      <div className="scroll page-pad">
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
          <div className="auth-actions">
            <button type="button" className="btn primary" onClick={onChat}>
              和维护者交流
            </button>
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
          {view.archiveBlocked && view.actions.some((a) => ARCHIVING_ACTIONS.includes(a)) && <div className="muted">{view.archiveBlocked}</div>}
          {p.state === "archived" && <div className="muted">已归档：维护者会话只读。删除要二次确认，项目档案和维护者会话都会删掉，你在里面说过的话作为素材保留。</div>}
        </div>

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
            <ResetMaintainer view={view} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 项目内部任务（64 号票）：由项目的维护者执行的流程和长程任务（不上全局看板）。没结束的在前；结束了的每个有"归档"
 * （和全局任务一样只有你能归档，全局任务在每周的归档清单上）；归档了的收起来。每个写种类、状态（写明原因）、进度和用量，
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
        {v.progress && ` · ${v.progress}`}
        {v.tokens > 0 && ` · ${v.tokens.toLocaleString()} token`}
      </div>
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

/** 重置维护者（16 号票）：新开一段会话，只凭项目档案重建理解，旧会话保留可查；已归档的项目不能重置 */
function ResetMaintainer({ view }: { view: ProjectView }) {
  const { resetMaintainer } = useStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Section title="维护者">
        <div className="muted">维护者对项目的理解存在项目档案里，不靠会话。理解跑偏了可以重置：新开一段会话，只凭项目档案重建理解，旧会话保留可查。</div>
        <div className="auth-actions">
          <button type="button" className="btn ghost" disabled={!view.canResetMaintainer} onClick={() => setConfirm(true)}>
            {RESET_MAINTAINER_LABEL}
          </button>
        </div>
      </Section>
      {confirm && (
        <Sheet title="重置维护者？" onClose={() => setConfirm(false)} center>
          <div className="modal-body">
            <p>会新开一段会话，维护者只凭项目档案（立项书、规格、术语表、进展）重建理解，不带上一段的摘要。旧会话保留，在维护者会话里照样能看。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setConfirm(false);
                resetMaintainer(view.project.id);
                toast("已重置维护者：新的一段会话从项目档案开始");
              }}
            >
              重置
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** 原型假项目才有的几节：定时作业、工单流水线、工具包的修改、范围记录、重置维护者（各自的票接真数据） */
function ProtoSections({ project: p, detail }: { project: Project; detail: ProjectDetail }) {
  const toast = useToast();
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJobSummary[]>(detail.scheduledJobs);
  const [confirmReset, setConfirmReset] = useState(false);
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

      <Section title="维护者">
        <div className="muted">维护者对项目的理解存在项目档案里，不靠会话。理解跑偏了可以重置：新开一段会话，只凭项目档案重建理解，旧会话保留可查。</div>
        <div className="auth-actions">
          <button type="button" className="btn ghost" disabled={p.state === "archived"} onClick={() => setConfirmReset(true)}>
            重置维护者
          </button>
        </div>
      </Section>
      {confirmReset && (
        <Sheet title="重置维护者？" onClose={() => setConfirmReset(false)} center>
          <div className="modal-body">
            <p>会新开一段会话，维护者只凭项目档案（立项书、规格、术语表、进展）重建理解。旧会话保留，可以查。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmReset(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setConfirmReset(false);
                toast("已重置维护者：新会话从项目档案开始");
              }}
            >
              重置
            </button>
          </div>
        </Sheet>
      )}
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
function MaintainerChat({ projectId, wide, onBack }: { projectId: string; wide: boolean; onBack(): void }) {
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
        </TopBar>
        <Conversation
          conversation={conversation}
          mode="maintainer"
          wide={wide}
          onDetail={detail.open}
          ref={conversationRef}
          readOnly={view.project.state === "archived"}
          readOnlyNote="已归档的项目，维护者会话只读：要接着说话，先在项目页上取消归档"
        />
      </div>
    </DetailLayout>
  );
}
