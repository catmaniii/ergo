// 几个页面共用的部件：工具调用详情栏、"发起任务"。
import { type ReactNode, useState } from "react";
import { useStore } from "../app/store.tsx";
import { nowIso } from "../model/labels.ts";
import type { TaskSummary } from "../model/types.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { Sheet, Splitter } from "../ui/common.tsx";
import { ToolCallDetail, type ToolCallPart } from "../ui/conversation/parts.tsx";

/** 主栏 + 工具调用详情：宽屏在右栏（AgentSense 的详情栏），竖屏在底部弹层 */
export function WithToolDetail({ wide, tool, onClose, children }: { wide: boolean; tool?: ToolCallPart; onClose(): void; children: ReactNode }) {
  const [w, setW] = useState(300);
  if (!wide) {
    return (
      <>
        {children}
        {tool && (
          <Sheet title={`工具调用 · ${tool.tool}`} onClose={onClose}>
            <ToolCallDetail part={tool} />
          </Sheet>
        )}
      </>
    );
  }
  return (
    <div className="panes">
      <div className="pane pane-main">{children}</div>
      {tool && (
        <>
          <Splitter onDrag={(dx) => setW((x) => Math.min(520, Math.max(240, x - dx)))} />
          <div className="pane pane-detail" style={{ width: w }}>
            <header className="topbar">
              <div className="title">工具调用 · {tool.tool}</div>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭详情">
                ×
              </button>
            </header>
            <div className="scroll page-pad">
              <ToolCallDetail part={tool} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** "发起任务"按钮：秘书页和任务页都有 */
export function StartTaskButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn primary ${compact ? "small" : ""}`} onClick={() => setOpen(true)}>
        ＋ 发起任务
      </button>
      {open && <StartTaskDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function StartTaskDialog({ onClose }: { onClose(): void }) {
  const [what, setWhat] = useState("");
  const [project, setProject] = useState("");
  const { proto, update, toast } = useProto();
  const { sendMessage } = useStore();
  const projects = proto.projects.filter((p) => p.status !== "archived");
  const submit = () => {
    const title = what.trim();
    const task: TaskSummary = { kind: "task", id: `t-${Date.now()}`, title, status: "planning", activity: "working", activityNote: "和你对齐意图", tokens: 0, projects: project ? [project] : [], updatedAt: nowIso() };
    update((s) => ({ ...s, board: [task, ...s.board] }));
    // 发起任务后由秘书先和用户对齐意图、写任务书：原型里把这句话发进秘书主线
    sendMessage("secretary", [{ type: "text", text: `发起任务：${title}${project ? `（项目「${project}」）` : ""}` }]);
    toast(`已发起任务「${title}」（规划中），秘书会先和你对齐意图`);
    onClose();
  };
  return (
    <Sheet title="发起任务" onClose={onClose} center>
      <label className="field">
        <span>要做什么</span>
        <textarea value={what} onChange={(e) => setWhat(e.target.value)} placeholder="比如：把家里的路由器换成 Wi-Fi 7，先比价再给我方案" autoFocus />
      </label>
      <label className="field">
        <span>涉及哪个项目（可以不选）</span>
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">不涉及项目 / 让秘书判断</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">发起后秘书先和你对齐意图、写任务书；执行的维护者据此起草分阶段的计划。你在计划卡上确认之前，它不会动手。</div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!what.trim()} onClick={submit}>
          发起
        </button>
      </div>
    </Sheet>
  );
}
