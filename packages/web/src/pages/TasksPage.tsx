// 任务页：任务看板 + 任务详情（维护者会话、阶段抽屉、工单列表、计划卡、工具包）。
// 看板（12 号票）：任务和简单提醒来自前端状态层（state/board.ts 按规格的五组排好），没有守护进程时再补上原型的假条目；
// 定时作业仍是假数据（19 号票）。
// 真任务的详情（13 号票）：维护者会话（和秘书聊天共用会话组件，输入框直接给维护者下指令，它干活时作为插话）、
// 阶段抽屉（各阶段状态、验收方式和结果，state/task-detail.ts）、计划卡和控制（暂停、继续、取消、重试、返工、由我验收）。
// token 用量（24 号票）：任务卡、作业卡上的总量，任务详情"消耗"一栏里按 agent 的细分（state/usage.ts，来自看板频道上的合计）。
import { useEffect, useMemo, useState } from "react";
import type { Navigate } from "../app/route.ts";
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
  describeSchedule,
  isRepeating,
  maintainerChannel,
  selectTask,
  taskWaitingForProject,
  type StageView,
  type Task,
  hasOwnMaintainer,
  jobTokenTotal,
  LEDGER_PURPOSE_LABEL,
  PROJECT_NAME_MAX,
  REMINDER_STATUS_LABEL,
  taskUsage,
  taskScopeRecords,
  TASK_END_KIND_LABEL,
  taskStatusText,
  UNFINISHED_TASK_STATES,
  taskAcceptsMessages,
  taskControls,
  taskStages,
  taskToolkit,
  ENDED_TASK_STATES,
  userDecidesWait,
} from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import type { ActivityState, BoardEntry, ReminderSummary, ScheduledJobSummary, Stage, TaskStatus, TaskSummary } from "../model/types.ts";
import { FAKE_RUN_SLOTS, taskDetailOf } from "../prototype/fake-data.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, ListDetail, Section, Segmented, Sheet, TopBar } from "../ui/common.tsx";
import { Conversation } from "../ui/conversation/Conversation.tsx";
import { ScopeRecordList } from "../ui/scope-records.tsx";
import type { ToolCallPart } from "../ui/conversation/parts.tsx";
import { currentStage, type DrawerMode, StageCard, StageChip, StageDrawer, StageSide } from "../ui/conversation/StageDrawer.tsx";
import { StartTaskButton, WithToolDetail } from "./shared.tsx";
import { ToolkitEditor, ToolkitPanel } from "./ToolkitEditor.tsx";

export function TasksPage({ wide, taskId, navigate }: { wide: boolean; taskId?: string; navigate: Navigate }) {
  return (
    <ListDetail
      wide={wide}
      listWidth={340}
      list={<Board selected={taskId} onOpen={(id) => navigate({ tab: "tasks", taskId: id })} />}
      detail={taskId ? <TaskDetail key={taskId} taskId={taskId} wide={wide} onBack={wide ? undefined : () => navigate({ tab: "tasks" })} /> : undefined}
    />
  );
}

// ---------- 看板 ----------

/** 原型假条目的分组：和真数据用同一张表（共享协议包） */
function groupOf(e: BoardEntry): BoardGroup {
  if (e.kind === "task") return BOARD_GROUP_OF_TASK_STATE[e.status];
  if (e.kind === "reminder") return e.status === "fired" ? "ended" : "ops";
  return "ops";
}

/**
 * 真任务在看板卡片上的样子："第 N/M 阶段"的 M 取自计划，N 在开始执行后才有（13 号票），之前写 0；
 * token 总量来自账本（24 号票）；维护者的活动状态连同说明（干活中在做什么、等你批准什么，25 号票）；
 * 它的工单还排着（项目的维护者正忙）时标排队、"等项目 X"（16 号票：这时维护者的活动状态是别的工单的）
 */
function taskSummary(task: Task, activity: AgentActivity, tokens: number, waitingForProject?: string): TaskSummary {
  const note = waitingForProject ? `等项目「${waitingForProject}」` : activityNote(activity);
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.state,
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
    ...(task.stages ? { stage: { current: task.stages.current ?? 0, total: task.stages.total } } : {}),
    // 转为项目的任务以"已完成 · 已转为项目"结束
    ...(task.endKind ? { endNote: TASK_END_KIND_LABEL[task.endKind] } : {}),
  };
}

function entryOf(item: BoardItem): BoardEntry {
  if (item.kind === "task") return taskSummary(item.task, item.activity, item.tokens, item.waitingForProject);
  const r = item.reminder;
  return { kind: "reminder", id: r.id, title: r.text, status: r.status === "fired" ? "fired" : "pending", nextAt: r.nextAt ?? r.lastFiredAt ?? r.updatedAt, schedule: r.schedule };
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
        entries: [...g.items.map(entryOf), ...proto.board.filter((e) => groupOf(e) === g.group).map((e) => withJobTokens(e, (id) => jobTokenTotal(ui, id)))],
      })),
    [ui, proto.board],
  );
}

function Board({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const groups = useBoard();
  const [showArchived, setShowArchived] = useState(false);
  return (
    <div className="chat-col">
      <TopBar title="任务看板">
        <StartTaskButton compact />
      </TopBar>
      <div className="scroll board">
        {groups.map((g) => {
          const { entries } = g;
          const collapsed = g.id === "archived" && !showArchived;
          return (
            <section key={g.id} className={`bgroup bg-${g.id}`}>
              <button type="button" className="bgroup-h" onClick={g.id === "archived" ? () => setShowArchived(!showArchived) : undefined} aria-expanded={g.id === "archived" ? !collapsed : undefined}>
                <b>{g.title}</b>
                <span className="muted">{g.sub}</span>
                <span className="bgroup-n">{entries.length}</span>
                {g.id === "archived" && <span className="muted">{collapsed ? "展开 ▸" : "收起 ▾"}</span>}
              </button>
              {!collapsed &&
                entries.map((e) =>
                  e.kind === "task" ? (
                    <TaskCard key={e.id} task={e} on={selected === e.id} onOpen={() => onOpen(e.id)} />
                  ) : e.kind === "reminder" ? (
                    <ReminderCard key={e.id} r={e} />
                  ) : (
                    <ScheduledJobCard key={e.id} j={e} />
                  ),
                )}
              {!collapsed && entries.length === 0 && <div className="muted bgroup-empty">没有</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function statusText(t: TaskSummary): string {
  if (t.statusLine) return t.statusLine;
  if (t.status === "waiting_for_user" && t.waitReason) return `等我 · ${WAIT_REASON_LABEL[t.waitReason]}`;
  if (t.status === "awaiting_confirm") return "待确认 · 计划等你确认";
  if (t.status === "done" && t.endNote) return `已完成 · ${t.endNote}`;
  return TASK_STATUS_LABEL[t.status];
}

function TaskCard({ task: t, on, onOpen }: { task: TaskSummary; on: boolean; onOpen(): void }) {
  return (
    <button type="button" className={`bcard${on ? " on" : ""}`} onClick={onOpen}>
      <div className="bcard-row">
        <span className="bcard-title">{t.title}</span>
      </div>
      <div className="bcard-meta">
        <span className={`st st-${t.status}`}>{statusText(t)}</span>
        {t.stage && (
          <span>
            第 {t.stage.current}/{t.stage.total} 阶段
          </span>
        )}
        {t.tokens !== undefined && <span>{tokensLabel(t.tokens)} token</span>}
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

function ReminderCard({ r }: { r: ReminderSummary }) {
  return (
    <div className="bcard bcard-static">
      <div className="bcard-row">
        <span className="bcard-title">⏰ {r.title}</span>
      </div>
      <div className="bcard-meta">
        <span className="st st-ops">{r.status === "fired" ? `简单提醒 · ${REMINDER_STATUS_LABEL.fired}` : `运营中 · ${REMINDER_STATUS_LABEL.pending}`}</span>
        <span>{isRepeating(r.schedule) ? describeSchedule(r.schedule) : "一次性"}</span>
        <span>{r.status === "fired" ? timeLabel(r.nextAt) : `下次 ${timeLabel(r.nextAt)}`}</span>
      </div>
    </div>
  );
}

function ScheduledJobCard({ j }: { j: ScheduledJobSummary }) {
  return (
    <div className="bcard bcard-static">
      <div className="bcard-row">
        <span className="bcard-title">🔁 {j.title}</span>
      </div>
      <div className="bcard-meta">
        <span className={`st ${j.status === "active" ? "st-ops" : "st-paused"}`}>
          定时作业 · {scheduledJobStatusLabel(j)}
        </span>
        <span>{j.schedule}</span>
        {j.tokens !== undefined && <span>{tokensLabel(j.tokens)} token</span>}
        {j.project && <span className="chip">{j.project}</span>}
        {j.lastRun && !j.lastRun.ok && <span className="chip chip-no">最近一次失败</span>}
      </div>
    </div>
  );
}

// ---------- 任务详情 ----------

type DetailTab = "chat" | "plan" | "orders" | "toolkit" | "usage";

function TaskDetail({ taskId, wide, onBack }: { taskId: string; wide: boolean; onBack?: () => void }) {
  const { ui } = useStore();
  const task = selectTask(ui, taskId);
  if (task) return <RealTaskDetail task={task} activity={agentActivity(ui, task.maintainerId)} wide={wide} onBack={onBack} />;
  return <ProtoTaskDetail taskId={taskId} wide={wide} onBack={onBack} />;
}

/** 状态层里的阶段换成阶段抽屉组件用的样子（验收结果写成通过 / 没通过，原因附在后面） */
function stageOf(s: StageView): Stage {
  return {
    id: s.stageId,
    title: s.title,
    status: s.state,
    deliverable: s.deliverables.join("；"),
    acceptance: s.acceptance.map((a) => ({ text: a.criterion, method: a.method, ...(a.result ? { result: a.result.passed ? "pass" : "fail" } : {}), ...(a.result?.note ? { note: a.result.note } : {}) })),
    mode: s.mode,
    after: s.dependsOn,
    grants: s.grants,
    rules: s.rules,
    budget: { tokens: s.budget?.tokens ?? 0, toolCalls: s.budget?.toolCalls ?? 0, ...(s.budget ? { usedTokens: s.budget.usedTokens } : {}) },
    ...(s.attempts > 0 ? { attempts: s.attempts } : {}),
    ...(s.waitReason ? { waitReason: s.waitReason } : {}),
    ...(s.waitNote ? { waitNote: s.waitNote } : {}),
  };
}

type RealTab = "chat" | "plan" | "toolkit" | "usage";

/**
 * 真任务的详情（13 号票）：维护者会话（直接下指令；它在干活时你的话作为插话，在它下一步之前插入）、阶段抽屉、计划卡，
 * 状态行上写明等我的原因、失败的原因，控制按钮按任务状态给
 */
function RealTaskDetail({ task, activity, wide, onBack }: { task: Task; activity: AgentActivity; wide: boolean; onBack?: () => void }) {
  const { ui, taskAction, watchChannels } = useStore();
  const conversation = maintainerChannel(task.maintainerId);
  // 打开详情时订阅它的维护者会话（订阅过的一直保留）
  useEffect(() => watchChannels([conversation]), [watchChannels, conversation]);
  const stages = useMemo(() => taskStages(ui, task.id).map(stageOf), [ui, task.id]);
  const [tab, setTab] = useState<RealTab>("chat");
  const [drawer, setDrawer] = useState<DrawerMode>("closed");
  const [picked, setPicked] = useState<string>();
  const [note, setNote] = useState("");
  const [tool, setTool] = useState<ToolCallPart>();
  const usage = useMemo(() => taskUsage(ui, task.id), [ui, task.id]);
  const summary = taskSummary(task, activity, usage.total, taskWaitingForProject(ui, task.id));
  const selected = picked ?? currentStage(stages)?.id;
  const controls = taskControls(task);
  const wantsNote = controls.some((c) => c.action === "return_stage" || c.action === "rework");
  const hasStages = stages.length > 0;
  const act = (c: (typeof controls)[number]) => {
    taskAction(task.id, c.action, { ...(c.stageId === undefined ? {} : { stageId: c.stageId }), ...(note.trim() && (c.action === "return_stage" || c.action === "rework") ? { note } : {}) });
    setNote("");
  };

  return (
    <WithToolDetail wide={wide} tool={tool} onClose={() => setTool(undefined)}>
      <div className="chat-col">
        <TopBar title={task.title} onBack={onBack}>
          {hasStages && (
            <StageChip
              stages={stages}
              selected={selected}
              open={wide ? true : drawer !== "closed"}
              onTap={() => {
                setTab("chat");
                if (!wide) setDrawer(drawer === "closed" ? "half" : "closed");
              }}
            />
          )}
        </TopBar>
        {!wide && tab === "chat" && hasStages && <StageDrawer stages={stages} mode={drawer} onMode={setDrawer} selected={selected} onSelect={setPicked} />}
        <div className="td-status">
          <span className={`st st-${task.state}`}>{statusText(summary)}</span>
          <ActivityDot state={summary.activity} note={summary.activityNote} />
          {summary.stage && (
            <span className="muted">
              第 {summary.stage.current}/{summary.stage.total} 阶段
            </span>
          )}
          <span className="muted">{tokensLabel(usage.total)} token</span>
          <span className="td-actions">
            {controls.map((c) => (
              <button key={`${c.action}:${c.stageId ?? ""}`} type="button" className={`btn small ${c.action === "accept_stage" || c.action === "retry" ? "primary" : "ghost"}`} onClick={() => act(c)}>
                {c.label}
              </button>
            ))}
          </span>
        </div>
        {task.waitNote && (
          <div className="td-note">
            {/* 中断不确定的说明自己就写着"中断：不确定……"（23 号票），别的前面写上等什么 */}
            {task.waitReason === "interrupted" ? task.waitNote : `${task.waitReason ? WAIT_REASON_LABEL[task.waitReason] : "卡住了"}：${task.waitNote}`}
          </div>
        )}
        {task.failReason && <div className="td-note">失败的原因：{task.failReason}</div>}
        {wantsNote && (
          <input className="td-note-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="退回、返工的原因（可不写，写了交给维护者）" aria-label="退回、返工的原因" />
        )}
        <Segmented<RealTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "chat", label: "会话" },
            { value: "plan", label: "计划" },
            { value: "toolkit", label: "工具包" },
            { value: "usage", label: "消耗" },
          ]}
        />
        {tab === "chat" && (
          <div className="chat-row">
            {wide && hasStages && <StageSide stages={stages} selected={selected} onSelect={setPicked} />}
            <div className="chat-row-main" onPointerDownCapture={!wide && drawer === "full" ? () => setDrawer("half") : undefined}>
              <Conversation
                conversation={conversation}
                mode="maintainer"
                onToolDetail={setTool}
                readOnly={!taskAcceptsMessages(task)}
                readOnlyNote={task.state === "done" ? "任务已完成，不再收消息；要返工用上面的“返工”" : "任务已结束，会话只读"}
              />
            </div>
          </div>
        )}
        {tab === "plan" && (
          <div className="scroll page-pad">
            <div className="muted">{task.summary}</div>
            <ConvertToProject task={task} />
            {task.planCardId ? <CardPanel cardId={task.planCardId} /> : <div className="page-placeholder">还没有计划：秘书正在和你对齐意图，之后执行的维护者起草计划。</div>}
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
        )}
        {tab === "toolkit" && <TaskToolkit task={task} />}
        {tab === "usage" && <TaskUsage usage={usage} />}
      </div>
    </WithToolDetail>
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
    <div className="scroll page-pad">
      {toolkit ? (
        <>
          <ToolkitPanel target={{ kind: "task", taskId: task.id }} toolkit={toolkit} readOnly={ended} readOnlyNote="任务已结束：工具包不能改" />
          {task.projects.length > 0 && <div className="muted">涉及项目的任务：执行时能用的是这里和项目工具包的交集，项目工具包里没有的这里加了也没有。</div>}
        </>
      ) : (
        <div className="page-placeholder">还没有工具包：计划确认之后才有（维护者在计划里提议，你确认时生效）。</div>
      )}
    </div>
  );
}

/** 任务详情的"消耗"一栏：按 agent 细分（维护者、评审子 agent、并行子 agent 各一行，范围审视单独一行），合计就是任务卡上的总量 */
function TaskUsage({ usage }: { usage: ReturnType<typeof taskUsage> }) {
  return (
    <div className="scroll page-pad">
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
                    {r.label}
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

function ProtoTaskDetail({ taskId, wide, onBack }: { taskId: string; wide: boolean; onBack?: () => void }) {
  const { proto, update } = useProto();
  const toast = useToast();
  const task = proto.board.find((e): e is TaskSummary => e.kind === "task" && e.id === taskId);
  const detail = taskDetailOf(taskId);
  const [tab, setTab] = useState<DetailTab>("chat");
  const [drawer, setDrawer] = useState<DrawerMode>("closed");
  const [stage, setStage] = useState<string | undefined>(() => currentStage(detail.stages)?.id);
  const [tool, setTool] = useState<ToolCallPart>();
  if (!task) return <div className="page-placeholder">没有这个任务</div>;

  const setStatus = (status: TaskStatus, msg: string, activity?: ActivityState) => {
    const patch: Partial<TaskSummary> = { status, waitReason: undefined, ...(activity ? { activity, activityNote: undefined } : {}) };
    update((s) => ({ ...s, board: s.board.map((e) => (e.kind === "task" && e.id === taskId ? { ...e, ...patch } : e)) }));
    toast(msg);
  };
  // 恢复执行（继续、返工）：全局执行名额没满就直接回到执行中，满了才回排队中（规格第 8 节）
  const resume = (what: string) => {
    const running = proto.board.filter((e) => e.kind === "task" && e.status === "running" && e.id !== taskId).length;
    if (running < FAKE_RUN_SLOTS) setStatus("running", `${what}：执行名额没满，直接回到执行中`, "working");
    else setStatus("queued", `${what}：执行名额满了（${running}/${FAKE_RUN_SLOTS}），先排队`, "queued");
  };
  const hasStages = detail.stages.length > 0;

  const conversation = detail.maintainer ? (
    <div className="chat-row">
      {wide && hasStages && <StageSide stages={detail.stages} selected={stage} onSelect={setStage} />}
      <div className="chat-row-main" onPointerDownCapture={!wide && drawer === "full" ? () => setDrawer("half") : undefined}>
        <Conversation conversation={detail.maintainer} mode="maintainer" onToolDetail={setTool} readOnly={task.status === "archived"} readOnlyNote="已归档的任务，会话只读" />
      </div>
    </div>
  ) : (
    <div className="page-placeholder">原型没有给这个任务准备会话假数据。看「家庭照片整理与去重」「每周汇总银行账单」「博客迁移到 Astro」这三个。</div>
  );

  return (
    <WithToolDetail wide={wide} tool={tool} onClose={() => setTool(undefined)}>
      <div className="chat-col">
        <TopBar title={task.title} onBack={onBack}>
          {hasStages && (
            <StageChip
              stages={detail.stages}
              selected={stage}
              open={wide ? true : drawer !== "closed"}
              onTap={() => {
                if (wide) return setTab("chat");
                setTab("chat");
                setDrawer(drawer === "closed" ? "half" : "closed");
              }}
            />
          )}
        </TopBar>
        {!wide && tab === "chat" && hasStages && <StageDrawer stages={detail.stages} mode={drawer} onMode={setDrawer} selected={stage} onSelect={setStage} />}
        <div className="td-status">
          <span className={`st st-${task.status}`}>{statusText(task)}</span>
          <ActivityDot state={task.activity} note={task.activityNote} />
          <span className="muted">{tokensLabel(task.tokens ?? 0)} token</span>
          {detail.executedBy && <span className="muted">由{detail.executedBy}执行</span>}
          <span className="td-actions">
            {(task.status === "running" || task.status === "queued" || task.status === "planning") && (
              <button type="button" className="btn ghost small" onClick={() => setStatus("paused", "已暂停", "sleeping")}>
                暂停
              </button>
            )}
            {task.status === "paused" && (
              <button type="button" className="btn ghost small" onClick={() => resume("已继续")}>
                继续
              </button>
            )}
            {task.status === "waiting_for_user" && task.waitReason === "acceptance" && (
              <>
                <button type="button" className="btn primary small" onClick={() => setStatus("done", "验收通过，任务完成")}>
                  验收通过
                </button>
                <button type="button" className="btn ghost small" onClick={() => resume("已返工，重开出问题的阶段和它的下游")}>
                  返工
                </button>
              </>
            )}
            {task.status === "done" && (
              <button type="button" className="btn ghost small" onClick={() => resume("已返工")}>
                返工
              </button>
            )}
            {(task.status === "done" || task.status === "failed" || task.status === "cancelled") && (
              <button type="button" className="btn ghost small" onClick={() => setStatus("archived", "已归档")}>
                归档
              </button>
            )}
            {!["done", "failed", "cancelled", "archived"].includes(task.status) && (
              <button type="button" className="btn ghost small" onClick={() => setStatus("cancelled", "已取消")}>
                取消任务
              </button>
            )}
          </span>
        </div>
        <Segmented<DetailTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "chat", label: "会话" },
            { value: "plan", label: "计划" },
            { value: "orders", label: `工单 ${detail.workOrders.length || ""}` },
            { value: "toolkit", label: "工具包" },
            { value: "usage", label: "消耗" },
          ]}
        />
        {tab === "chat" && conversation}
        {tab === "plan" && (
          <div className="scroll page-pad">
            {detail.planCardId ? <CardPanel cardId={detail.planCardId} /> : <div className="page-placeholder">还没有计划：秘书正在和你对齐意图，之后执行的维护者起草计划。</div>}
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
        )}
        {tab === "orders" && (
          <div className="scroll page-pad">
            <div className="muted">本任务派出的所有工单。工单不在看板上单独占卡。</div>
            {detail.workOrders.length === 0 && <div className="page-placeholder">还没有派出工单</div>}
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
        )}
        {tab === "toolkit" && (
          <div className="scroll page-pad">
            <ToolkitEditor initial={detail.toolkit} readOnly={task.status === "archived"} />
          </div>
        )}
        {tab === "usage" && (
          <div className="scroll page-pad">
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
        )}
      </div>
    </WithToolDetail>
  );
}
