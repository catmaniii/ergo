// 项目页：项目列表（状态、活动状态小圆点、进行中任务数）+ 简版项目页 + 维护者会话。
import { useState } from "react";
import type { Navigate } from "../app/route.ts";
import { PROJECT_STATUS_LABEL, scheduledJobStatusLabel, WORK_ORDER_STATUS_LABEL } from "../model/labels.ts";
import { timeLabel } from "../util/time.ts";
import type { ScheduledJobSummary, ProjectStatus, ProjectSummary, WorkOrder } from "../model/types.ts";
import { projectDetailOf } from "../prototype/fake-data.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ActivityDot, ListDetail, Section, Sheet, TopBar } from "../ui/common.tsx";
import { Conversation } from "../ui/conversation/Conversation.tsx";
import type { ToolCallPart } from "../ui/conversation/parts.tsx";
import { WithToolDetail } from "./shared.tsx";
import { ToolkitEditor } from "./ToolkitEditor.tsx";

export function ProjectsPage({ wide, projectId, chat, navigate }: { wide: boolean; projectId?: string; chat?: boolean; navigate: Navigate }) {
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
            <ProjectPage key={projectId} projectId={projectId} onBack={back} onChat={() => navigate({ tab: "projects", projectId, chat: true })} />
          )
        ) : undefined
      }
    />
  );
}

const STATUS_ORDER: ProjectStatus[] = ["in_use", "building", "preparing", "retired", "archived"];

function ProjectList({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { proto } = useProto();
  const [showArchived, setShowArchived] = useState(false);
  const sorted = proto.projects.toSorted((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const live = sorted.filter((p) => p.status !== "archived");
  const archived = sorted.filter((p) => p.status === "archived");
  return (
    <div className="chat-col">
      <TopBar title="项目" />
      <div className="scroll board">
        {live.map((p) => (
          <ProjectRow key={p.id} p={p} on={selected === p.id} onOpen={() => onOpen(p.id)} />
        ))}
        <button type="button" className="bgroup-h" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
          <b>已归档</b>
          <span className="bgroup-n">{archived.length}</span>
          <span className="muted">{showArchived ? "收起 ▾" : "展开 ▸"}</span>
        </button>
        {showArchived && archived.map((p) => <ProjectRow key={p.id} p={p} on={selected === p.id} onOpen={() => onOpen(p.id)} />)}
        <div className="hint">新项目从秘书的"建议立项"卡、你直接说要立项，或者任务转为项目时产生。</div>
      </div>
    </div>
  );
}

function ProjectRow({ p, on, onOpen }: { p: ProjectSummary; on: boolean; onOpen(): void }) {
  return (
    <button type="button" className={`bcard${on ? " on" : ""}`} onClick={onOpen}>
      <div className="bcard-row">
        <span className="bcard-title">{p.name}</span>
        <span className={`pst pst-${p.status}`}>{PROJECT_STATUS_LABEL[p.status]}</span>
      </div>
      <div className="bcard-meta">
        <ActivityDot state={p.activity} note={p.activityNote} />
        <span>进行中任务 {p.activeTasks}</span>
        {p.status === "preparing" && p.charterConfirmed && <span className="chip chip-ok">立项书已确认</span>}
      </div>
    </button>
  );
}

function ProjectPage({ projectId, onBack, onChat }: { projectId: string; onBack?: () => void; onChat(): void }) {
  const { proto, update } = useProto();
  const toast = useToast();
  const p = proto.projects.find((x) => x.id === projectId);
  const detail = projectDetailOf(projectId);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJobSummary[]>(detail.scheduledJobs);
  const [confirm, setConfirm] = useState<"reset" | "delete" | undefined>();
  if (!p) return <div className="page-placeholder">没有这个项目</div>;

  const setStatus = (status: ProjectStatus, msg: string) => {
    const archivedFrom = status === "archived" ? p.status : undefined;
    update((s) => ({ ...s, projects: s.projects.map((x) => (x.id === projectId ? { ...x, status, archivedFrom } : x)) }));
    // 停用只暂停定时作业，重新启用时恢复
    if (status === "retired") setScheduledJobs((js) => js.map((j) => ({ ...j, status: "paused" })));
    if (status === "in_use" && p.status === "retired") setScheduledJobs(detail.scheduledJobs);
    toast(msg);
  };

  return (
    <div className="chat-col">
      <TopBar title={p.name} onBack={onBack} />
      <div className="scroll page-pad">
        <div className="card proj-head">
          <div className="proj-head-row">
            <span className={`pst pst-${p.status}`}>{PROJECT_STATUS_LABEL[p.status]}</span>
            <ActivityDot state={p.activity} note={p.activityNote} />
            <span className="muted">进行中任务 {p.activeTasks}</span>
          </div>
          <div className="proj-goal">{p.goal}</div>
          <div className="muted">
            {detail.kind === "dev" ? "开发类" : "其他"} · 工作目录：{detail.workdir}
          </div>
          <div className="auth-actions">
            <button type="button" className="btn primary" onClick={onChat}>
              和维护者交流
            </button>
            {p.status === "in_use" && (
              <button type="button" className="btn ghost" onClick={() => setStatus("retired", "已停用：定时作业已暂停")}>
                停用
              </button>
            )}
            {p.status === "retired" && (
              <button type="button" className="btn ghost" onClick={() => setStatus("in_use", "已重新启用：定时作业已恢复")}>
                重新启用
              </button>
            )}
            {(p.status === "preparing" || p.status === "building") && (
              <button type="button" className="btn ghost" onClick={() => setStatus("archived", "已放弃，项目归档")}>
                放弃（归档）
              </button>
            )}
            {(p.status === "in_use" || p.status === "retired") && (
              <button type="button" className="btn ghost" onClick={() => setStatus("archived", "已归档：维护者会话只读，发来的工单直接退回")}>
                归档
              </button>
            )}
            {p.status === "archived" && (
              <>
                <button type="button" className="btn ghost" onClick={() => setStatus(p.archivedFrom ?? "in_use", "已取消归档，回到原来的状态")}>
                  取消归档
                </button>
                <button type="button" className="btn danger" onClick={() => setConfirm("delete")}>
                  删除
                </button>
              </>
            )}
          </div>
        </div>

        {detail.charterCardId && (
          <Section title="立项书">
            <CardPanel cardId={detail.charterCardId} />
          </Section>
        )}

        <Section title="定时作业" extra={<span className="muted">项目自己的服务在不在线：第二阶段</span>}>
          {scheduledJobs.length === 0 && <div className="muted">没有定时作业。定时作业通过对这个项目发起的任务建立。</div>}
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
                disabled={p.status === "retired" || p.status === "archived"}
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
          <ToolkitEditor initial={detail.toolkit} readOnly={p.status === "archived"} />
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
            <button type="button" className="btn ghost" disabled={p.status === "archived"} onClick={() => setConfirm("reset")}>
              重置维护者
            </button>
          </div>
        </Section>
      </div>
      {confirm === "reset" && (
        <Sheet title="重置维护者？" onClose={() => setConfirm(undefined)} center>
          <div className="modal-body">
            <p>会新开一段会话，维护者只凭项目档案（立项书、规格、术语表、进展）重建理解。旧会话保留，可以查。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setConfirm(undefined);
                toast("已重置维护者：新会话从项目档案开始");
              }}
            >
              重置
            </button>
          </div>
        </Sheet>
      )}
      {confirm === "delete" && (
        <Sheet title={`删除项目「${p.name}」？`} onClose={() => setConfirm(undefined)} center>
          <div className="modal-body">
            <p>项目档案和维护者会话都会删掉，不可恢复。你说过的话另存的原文副本不受影响。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirm(undefined);
                update((s) => ({ ...s, projects: s.projects.filter((x) => x.id !== projectId) }));
                toast(`已删除项目「${p.name}」`);
                onBack?.();
              }}
            >
              确认删除
            </button>
          </div>
        </Sheet>
      )}
    </div>
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

function MaintainerChat({ projectId, wide, onBack }: { projectId: string; wide: boolean; onBack(): void }) {
  const { proto } = useProto();
  const p = proto.projects.find((x) => x.id === projectId);
  const detail = projectDetailOf(projectId);
  const [tool, setTool] = useState<ToolCallPart>();
  return (
    <WithToolDetail wide={wide} tool={tool} onClose={() => setTool(undefined)}>
      <div className="chat-col">
        <TopBar title={`${p?.name ?? ""} · 维护者`} onBack={onBack}>
          {p && <ActivityDot state={p.activity} note={p.activityNote} />}
        </TopBar>
        {detail.maintainer ? (
          <Conversation conversation={detail.maintainer} mode="maintainer" onToolDetail={setTool} readOnly={p?.status === "archived"} readOnlyNote="已归档的项目，维护者会话只读" />
        ) : (
          <div className="page-placeholder">原型没有给这个项目准备会话假数据。看「记账本」「个人博客」「家电档案」。</div>
        )}
      </div>
    </WithToolDetail>
  );
}
