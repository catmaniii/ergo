// 几个页面共用的部件："发起任务"。（会话的详情页在 ui/detail/，56 号票起取代了这里原来的 WithToolDetail）
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import { ASSISTANT_NAME_MARK, selectableProjectNames, TASK_KIND_HINT, TASK_KIND_LABEL, type TaskKind } from "../state/index.ts";
import { AssistantName } from "../ui/assistant-name.tsx";
import { useToast } from "../ui/toast.tsx";
import { Sheet } from "../ui/common.tsx";

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
 * 58 号票：先选种类（照 AgentSense 的 ScenarioPicker：两个页签，副标题说清两种的区别），建卡时定下、之后不能换；
 * 默认是长程任务。第一行当标题。涉及的项目可以多选，选项来自项目列表（15 号票起是真的：没归档的项目；守护进程同样核对，
 * 不在项目列表里的被拒）；选的项目写进任务，秘书写任务书时以它为依据。流程暂时只做不涉及项目的事，选了流程就不给选项目
 */
function StartTaskDialog({ onClose }: { onClose(): void }) {
  const [kind, setKind] = useState<TaskKind>("long_running");
  const [what, setWhat] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const toast = useToast();
  const { ui, startTask } = useStore();
  const projects = selectableProjectNames(ui);
  const toggle = (name: string) => setChosen(chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name]);
  const submit = () => {
    const request = what.trim();
    startTask(request, kind === "workflow" ? [] : chosen, kind);
    toast(`已发起${TASK_KIND_LABEL[kind]}「${request.split("\n")[0]}」（规划中），${ASSISTANT_NAME_MARK}会先和你对齐意图`);
    onClose();
  };
  return (
    <Sheet title="发起任务" onClose={onClose} center>
      <div className="sc-modes" role="tablist">
        {(["long_running", "workflow"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={`sc-mode ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
            <b>
              {TASK_KIND_LABEL[k]}
              {k === "long_running" ? "（默认）" : ""}
            </b>
            <span>{TASK_KIND_HINT[k]}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span>要做什么（第一行当标题）</span>
        <textarea
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder={kind === "workflow" ? "比如：把下载目录里的安装包、截图、文档分到三个文件夹" : "比如：把家里的路由器换成 Wi-Fi 7，先比价，再给我一份计划"}
          autoFocus
        />
      </label>
      {kind === "long_running" ? (
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
      ) : (
        <div className="hint">流程暂时只做不涉及项目的事；涉及项目的请作为长程任务发起。</div>
      )}
      <div className="hint">
        发起后<AssistantName />先和你对齐意图、写任务书；
        {kind === "workflow"
          ? "维护者据此把要做的事排成一串步骤，每一步连同它要满足的条件，经审查修补后放进计划卡。你在计划卡上一次授权之前，它不会动手。"
          : "执行的维护者据此起草分阶段的计划。你在计划卡上确认之前，它不会动手。"}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!what.trim()} onClick={submit}>
          发起{TASK_KIND_LABEL[kind]}
        </button>
      </div>
    </Sheet>
  );
}
