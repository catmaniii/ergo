// 工具包：skill、MCP、bash 开关、联网开关、给秘书发消息开关、发附件开关。用户自己在项目页或任务详情里扩大或减少能力，不用走计划变更。
// ToolkitPanel：真项目、真任务的工具包区。skill 只能从 skill 库里选、MCP 只能选登记了的（配置区写的和项目自动转的，GET 工具包目录）；
//   项目自己自动转的 MCP 一直在，只显示、不能去掉；
//   每改一下就发 set_toolkit，守护进程写进工具包（负责人正在干活时等它做完手头这一步就按新工具包重新装配），
//   项目、任务随后在各自的频道推来，这里跟着显示；skill 的选择里整套导入的集合显示成一项，可以整套选，点开也能单选（ui/skill-picker.tsx）；
// 原型数据（假项目、假任务）的工具包区在 prototype/proto-toolkit-editor.tsx。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  type McpServerEntry,
  type PlanToolkit,
  projectOpsMcpName,
  sendAttachmentHint,
  SEND_ATTACHMENT_LABEL,
  sendAttachmentOn,
  t,
  tellSecretaryHint,
  TELL_SECRETARY_LABEL,
  type ToolkitCatalog,
  type ToolkitTarget,
  tellSecretaryOn,
  withSendAttachment,
  withTellSecretary,
} from "../state/index.ts";
import { SkillPicker } from "../ui/skill-picker.tsx";
import { NamedText } from "../ui/assistant-name.tsx";
import { useToast } from "../ui/toast.tsx";

/** 一个 MCP 的说法：项目自动转的写明 */
const mcpLabel = (m: McpServerEntry) => t(m.auto ? "pages.toolkit.mcpAuto" : "pages.toolkit.mcpNamed", { title: m.title, name: m.name });

/** 工具包区 MCP 那一行：这个项目自己自动转的只显示、不能去掉（负责人的工具包里自动有）；别的能加能去，项目自动转的写明 */
export function McpChips({ target, toolkit, catalog, onChange }: { target: ToolkitTarget; toolkit: PlanToolkit; catalog: ToolkitCatalog | undefined; onChange: (next: PlanToolkit) => void }) {
  const ownMcp = target.kind === "project" ? catalog?.mcp.find((m) => m.auto && m.name === projectOpsMcpName(target.projectId)) : undefined;
  const mcpOptions = (catalog?.mcp ?? []).filter((m) => !toolkit.mcp.includes(m.name) && m.name !== ownMcp?.name);
  const listed = toolkit.mcp.filter((m) => m !== ownMcp?.name);
  return (
    <div className="chips">
      {listed.length === 0 && !ownMcp && <span className="muted">{t("pages.toolkit.none")}</span>}
      {ownMcp && <span className="chip chip-data">{t("pages.toolkit.mcpOwn", { name: ownMcp.name })}</span>}
      {listed.map((m) => {
        const entry = catalog?.mcp.find((known) => known.name === m);
        return (
          <button key={m} type="button" className="chip chip-data chip-x" onClick={() => onChange({ ...toolkit, mcp: toolkit.mcp.filter((x) => x !== m) })} aria-label={t("pages.toolkit.removeMcp", { name: m })}>
            {entry ? mcpLabel(entry) : m} ×
          </button>
        );
      })}
      {mcpOptions.length > 0 && (
        <select className="input chip-add" value="" onChange={(e) => e.target.value && onChange({ ...toolkit, mcp: [...toolkit.mcp, e.target.value] })} aria-label={t("pages.toolkit.addMcp")}>
          <option value="">{t("pages.toolkit.addRegisteredMcp")}</option>
          {mcpOptions.map((m) => (
            <option key={m.name} value={m.name}>
              {mcpLabel(m)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

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
      (err: unknown) => live && setProblem(t("pages.toolkit.catalogFailed", { reason: err instanceof Error ? err.message : String(err) })),
    );
    return () => {
      live = false;
    };
  }, [http]);
  const set = (next: PlanToolkit) => {
    setToolkit(target, next);
    toast(t("pages.toolkit.changed"));
  };
  return (
    <fieldset className="toolkit" disabled={readOnly}>
      <div className="tk-row">
        <div className="tk-k">skill</div>
        <SkillPicker catalog={catalog} selected={toolkit.skills} onChange={(skills) => set({ ...toolkit, skills })} />
      </div>
      <div className="tk-row">
        <div className="tk-k">MCP</div>
        <McpChips target={target} toolkit={toolkit} catalog={catalog} onChange={set} />
      </div>
      <label className="tk-row tk-switch">
        <div className="tk-k">bash</div>
        <input type="checkbox" checked={toolkit.bash} onChange={(e) => set({ ...toolkit, bash: e.target.checked })} />
        <span className="muted">{t("pages.toolkit.bashHint")}</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">{t("pages.toolkit.network")}</div>
        <input type="checkbox" checked={toolkit.network} onChange={(e) => set({ ...toolkit, network: e.target.checked })} />
        <span className="muted">{t("pages.toolkit.networkHint")}</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k tk-k-wide">
          <NamedText text={TELL_SECRETARY_LABEL} />
        </div>
        <input type="checkbox" checked={tellSecretaryOn(toolkit)} onChange={(e) => set(withTellSecretary(toolkit, e.target.checked))} />
        <span className="muted">
          <NamedText text={tellSecretaryHint()} />
        </span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">{SEND_ATTACHMENT_LABEL}</div>
        <input type="checkbox" checked={sendAttachmentOn(toolkit)} onChange={(e) => set(withSendAttachment(toolkit, e.target.checked))} />
        <span className="muted">
          <NamedText text={sendAttachmentHint()} />
        </span>
      </label>
      {catalog?.mcpProblem && <div className="hint">{t("pages.toolkit.mcpProblem", { reason: catalog.mcpProblem })}</div>}
      {problem && <div className="hint">{problem}</div>}
      {readOnly && readOnlyNote ? (
        <div className="hint">{readOnlyNote}</div>
      ) : (
        <div className="hint">{t("pages.toolkit.liveHint")}</div>
      )}
    </fieldset>
  );
}
