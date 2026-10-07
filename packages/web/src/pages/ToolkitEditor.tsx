// 工具包：skill、MCP、bash 开关、联网开关。用户自己在项目页或任务详情里扩大能力，不用走计划变更（规格第 21 节）。
import { useState } from "react";
import type { Toolkit } from "../model/types.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";

/** 已在二狗里登记的 MCP（原型） */
const REGISTERED_MCPS = ["demo-exif-reader", "demo-mail-readonly", "demo-calendar-readonly", "demo-git-host"];

export function ToolkitEditor({ initial, readOnly }: { initial: Toolkit; readOnly?: boolean }) {
  const [kit, setKit] = useState(initial);
  const { proto } = useProto();
  const toast = useToast();
  const changed = () => toast("工具包已改：等它做完手头这一步，按新工具包重启子进程");
  const set = (k: Toolkit) => {
    setKit(k);
    changed();
  };
  const skillOptions = proto.skills.map((s) => s.name).filter((n) => !kit.skills.includes(n));
  const mcpOptions = REGISTERED_MCPS.filter((m) => !kit.mcps.includes(m));
  return (
    <fieldset className="toolkit" disabled={readOnly}>
      <div className="tk-row">
        <div className="tk-k">skill</div>
        <div className="chips">
          {kit.skills.length === 0 && <span className="muted">无</span>}
          {kit.skills.map((s) => (
            <button key={s} type="button" className="chip chip-data chip-x" onClick={() => set({ ...kit, skills: kit.skills.filter((x) => x !== s) })} aria-label={`去掉 ${s}`}>
              {s} ×
            </button>
          ))}
          {skillOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...kit, skills: [...kit.skills, e.target.value] })} aria-label="加一个 skill">
              <option value="">＋ 从 skill 库加</option>
              {skillOptions.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="tk-row">
        <div className="tk-k">MCP</div>
        <div className="chips">
          {kit.mcps.length === 0 && <span className="muted">无</span>}
          {kit.mcps.map((s) => (
            <button key={s} type="button" className="chip chip-data chip-x" onClick={() => set({ ...kit, mcps: kit.mcps.filter((x) => x !== s) })} aria-label={`去掉 ${s}`}>
              {s} ×
            </button>
          ))}
          {mcpOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...kit, mcps: [...kit.mcps, e.target.value] })} aria-label="加一个 MCP">
              <option value="">＋ 加已登记的 MCP</option>
              {mcpOptions.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <label className="tk-row tk-switch">
        <div className="tk-k">bash</div>
        <input type="checkbox" checked={kit.bash} onChange={(e) => set({ ...kit, bash: e.target.checked })} />
        <span className="muted">只开放 Git Bash；通用 bash 照常受守卫检查</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">联网</div>
        <input type="checkbox" checked={kit.network} onChange={(e) => set({ ...kit, network: e.target.checked })} />
        <span className="muted">关掉时联网的工具和命令直接拒绝（尽力而为，不是硬隔离）</span>
      </label>
      <div className="hint">你在这里改，立即生效，不用走计划变更；维护者自己要加能力时，会提交一张"工具包变更"卡。</div>
    </fieldset>
  );
}
