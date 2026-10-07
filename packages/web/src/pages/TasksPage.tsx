// 任务页：任务看板 + 任务详情（维护者会话、阶段抽屉、工单列表、计划卡、工具包）。
import { useState } from "react";
import type { Navigate } from "../app/route.ts";
import { repeatLabel, scheduledJobStatusLabel, TASK_STATUS_LABEL, tokensLabel, WAIT_REASON_LABEL, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import { timeLabel } from "../util/time.ts";
import type { ActivityState, BoardEntry, ReminderSummary, ScheduledJobSummary, TaskStatus, TaskSummary } from "../model/types.ts";
import { FAKE_RUN_SLOTS, taskDetailOf } from "../prototype/fake-data.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, ListDetail, Section, Segmented, TopBar } from "../ui/common.tsx";
import { Conversation } from "../ui/conversation/Conversation.tsx";
import type { ToolCallPart } from "../ui/conversation/parts.tsx";
import { currentStage, type DrawerMode, StageCard, StageChip, StageDrawer, StageSide } from "../ui/conversation/StageDrawer.tsx";
import { StartTaskButton, WithToolDetail } from "./shared.tsx";
import { ToolkitEditor } from "./ToolkitEditor.tsx";

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

type GroupId = "waiting" | "active" | "ops" | "ended" | "archived";

const GROUPS: { id: GroupId; title: string; sub: string }[] = [
  { id: "waiting", title: "等我", sub: "等我、待确认" },
  { id: "active", title: "进行中", sub: "规划中、排队中、执行中、已暂停" },
  { id: "ops", title: "运营中", sub: "简单提醒、定时作业" },
  { id: "ended", title: "最近结束", sub: "已完成、失败、已取消" },
  { id: "archived", title: "已归档", sub: "" },
];

const TASK_GROUP: Record<TaskStatus, GroupId> = {
  waiting_for_user: "waiting",
  awaiting_confirm: "waiting",
  planning: "active",
  queued: "active",
  running: "active",
  paused: "active",
  done: "ended",
  failed: "ended",
  cancelled: "ended",
  archived: "archived",
};

function groupOf(e: BoardEntry): GroupId {
  if (e.kind === "task") return TASK_GROUP[e.status];
  if (e.kind === "reminder") return e.status === "fired" ? "ended" : "ops";
  return "ops";
}

function Board({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { proto } = useProto();
  const [showArchived, setShowArchived] = useState(false);
  return (
    <div className="chat-col">
      <TopBar title="任务看板">
        <StartTaskButton compact />
      </TopBar>
      <div className="scroll board">
        {GROUPS.map((g) => {
          const entries = proto.board.filter((e) => groupOf(e) === g.id);
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
        <span>{tokensLabel(t.tokens)} token</span>
      </div>
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
        <span className="st st-ops">{r.status === "fired" ? "简单提醒 · 已触发" : "运营中 · 待触发"}</span>
        <span>{r.status === "fired" ? timeLabel(r.nextAt) : `下次 ${timeLabel(r.nextAt)}`}</span>
        <span>{repeatLabel(r.repeat)}</span>
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
        {j.project && <span className="chip">{j.project}</span>}
        {j.lastRun && !j.lastRun.ok && <span className="chip chip-no">最近一次失败</span>}
      </div>
    </div>
  );
}

// ---------- 任务详情 ----------

type DetailTab = "chat" | "plan" | "orders" | "toolkit" | "usage";

function TaskDetail({ taskId, wide, onBack }: { taskId: string; wide: boolean; onBack?: () => void }) {
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
          <span className="muted">{tokensLabel(task.tokens)} token</span>
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
            <Section title={`token 合计 ${tokensLabel(task.tokens)}`}>
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
