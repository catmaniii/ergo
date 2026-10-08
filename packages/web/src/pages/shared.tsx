// 几个页面共用的部件：工具调用详情栏、"发起任务"。
import { type ReactNode, useState } from "react";
import { useStore } from "../app/store.tsx";
import { selectableProjectNames } from "../state/index.ts";
import { useToast } from "../ui/toast.tsx";
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

/**
 * 发起任务（12 号票）：不经秘书判断，守护进程直接建出任务（规划中），出现在看板上；秘书收到通知接着和用户澄清。
 * 第一行当标题。涉及的项目可以多选，选项来自项目列表（15 号票起是真的：没归档的项目；守护进程同样核对，
 * 不在项目列表里的被拒）；选的项目写进任务，秘书写任务书时以它为依据
 */
function StartTaskDialog({ onClose }: { onClose(): void }) {
  const [what, setWhat] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const toast = useToast();
  const { ui, startTask } = useStore();
  const projects = selectableProjectNames(ui);
  const toggle = (name: string) => setChosen(chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name]);
  const submit = () => {
    const request = what.trim();
    startTask(request, chosen);
    toast(`已发起任务「${request.split("\n")[0]}」（规划中），秘书会先和你对齐意图`);
    onClose();
  };
  return (
    <Sheet title="发起任务" onClose={onClose} center>
      <label className="field">
        <span>要做什么（第一行当标题）</span>
        <textarea value={what} onChange={(e) => setWhat(e.target.value)} placeholder="比如：把家里的路由器换成 Wi-Fi 7，先比价，再给我一份计划" autoFocus />
      </label>
      <fieldset className="field">
        <legend>涉及哪些项目（可以多选）</legend>
        <label className="check-row">
          <input type="checkbox" checked={chosen.length === 0} onChange={() => setChosen([])} />
          不涉及项目
        </label>
        {projects.map((name) => (
          <label key={name} className="check-row">
            <input type="checkbox" checked={chosen.includes(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        ))}
      </fieldset>
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
