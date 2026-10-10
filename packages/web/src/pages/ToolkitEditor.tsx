// 工具包：skill、MCP、bash 开关、联网开关。用户自己在项目页或任务详情里扩大或减少能力，不用走计划变更（规格第 21 节）。
// - ToolkitPanel（27 号票）：真项目、真任务的工具包区。skill 只能从 skill 库里选、MCP 只能选配置区里登记了的（GET 工具包目录）；
//   每改一下就发 set_toolkit，守护进程写进工具包（维护者正在干活时等它做完手头这一步就按新工具包重新装配），
//   项目、任务随后在各自的频道推来，这里跟着显示；skill 的选择里整套导入的集合显示成一项，可以整套选，点开也能单选（72 号票，ui/skill-picker.tsx）；
// - ToolkitEditor：原型数据（假项目、假任务）的工具包区，只在页面里改。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import type { Toolkit } from "../model/types.ts";
import { useProto } from "../prototype/proto-store.tsx";
import type { PlanToolkit, ToolkitCatalog, ToolkitTarget } from "../state/index.ts";
import { SkillPicker } from "../ui/skill-picker.tsx";
import { useToast } from "../ui/toast.tsx";

/** 真项目、真任务的工具包区：现在的工具包，改动即发给守护进程 */
export function ToolkitPanel({ target, toolkit, readOnly, readOnlyNote }: { target: ToolkitTarget; toolkit: PlanToolkit; readOnly?: boolean; readOnlyNote?: string }) {
  const { http, setToolkit } = useStore();
  const toast = useToast();
  const [catalog, setCatalog] = useState<ToolkitCatalog>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let live = true;
    http.toolkitCatalog().then(
      (c) => live && setCatalog(c),
      (err: unknown) => live && setProblem(`取 skill 库和 MCP 登记失败：${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      live = false;
    };
  }, [http]);
  const set = (next: PlanToolkit) => {
    setToolkit(target, next);
    toast("工具包改了：维护者正在干活的话，等它做完手头这一步，按新工具包接着干");
  };
  const mcpOptions = (catalog?.mcp ?? []).filter((m) => !toolkit.mcp.includes(m.name));
  const mcpTitle = (name: string) => catalog?.mcp.find((m) => m.name === name)?.title;
  return (
    <fieldset className="toolkit" disabled={readOnly}>
      <div className="tk-row">
        <div className="tk-k">skill</div>
        <SkillPicker catalog={catalog} selected={toolkit.skills} onChange={(skills) => set({ ...toolkit, skills })} />
      </div>
      <div className="tk-row">
        <div className="tk-k">MCP</div>
        <div className="chips">
          {toolkit.mcp.length === 0 && <span className="muted">无</span>}
          {toolkit.mcp.map((m) => (
            <button key={m} type="button" className="chip chip-data chip-x" onClick={() => set({ ...toolkit, mcp: toolkit.mcp.filter((x) => x !== m) })} aria-label={`去掉 MCP ${m}`}>
              {mcpTitle(m) ? `${mcpTitle(m)}（${m}）` : m} ×
            </button>
          ))}
          {mcpOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...toolkit, mcp: [...toolkit.mcp, e.target.value] })} aria-label="加一个 MCP">
              <option value="">＋ 加已登记的 MCP</option>
              {mcpOptions.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.title}（{m.name}）
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <label className="tk-row tk-switch">
        <div className="tk-k">bash</div>
        <input type="checkbox" checked={toolkit.bash} onChange={(e) => set({ ...toolkit, bash: e.target.checked })} />
        <span className="muted">只开放 Git Bash；通用 bash 和带类型的 bash 工具照常受守卫检查</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">联网</div>
        <input type="checkbox" checked={toolkit.network} onChange={(e) => set({ ...toolkit, network: e.target.checked })} />
        <span className="muted">关掉时联网的工具和命令直接拒绝（尽力而为，不是硬隔离）；开着时只读的 GET 不打扰你，别的请求算"以我的名义对外发送"</span>
      </label>
      {catalog?.mcpProblem && <div className="hint">MCP 登记读不了：{catalog.mcpProblem}</div>}
      {problem && <div className="hint">{problem}</div>}
      {readOnly && readOnlyNote ? (
        <div className="hint">{readOnlyNote}</div>
      ) : (
        <div className="hint">你在这里改，立即生效，不用走计划变更；维护者自己可以增减 skill，要开 bash、加 MCP、开联网会先找你批准。</div>
      )}
    </fieldset>
  );
}

/** 已在二狗里登记的 MCP（原型） */
const REGISTERED_MCPS = ["demo-exif-reader", "demo-mail-readonly", "demo-calendar-readonly", "demo-git-host"];

/** 原型数据（假项目、假任务）的工具包区：只在页面里改 */
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
