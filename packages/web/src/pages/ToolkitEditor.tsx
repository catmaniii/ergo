// 工具包：skill、MCP、bash 开关、联网开关、给秘书发消息开关（102 号票）、发附件开关（117 号票）。用户自己在项目页或任务详情里扩大或减少能力，不用走计划变更（规格第 21 节）。
// - ToolkitPanel（27 号票）：真项目、真任务的工具包区。skill 只能从 skill 库里选、MCP 只能选配置区里登记了的（GET 工具包目录）；
//   每改一下就发 set_toolkit，守护进程写进工具包（维护者正在干活时等它做完手头这一步就按新工具包重新装配），
//   项目、任务随后在各自的频道推来，这里跟着显示；skill 的选择里整套导入的集合显示成一项，可以整套选，点开也能单选（72 号票，ui/skill-picker.tsx）；
// - ToolkitEditor：原型数据（假项目、假任务）的工具包区，只在页面里改。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import type { Toolkit } from "../model/types.ts";
import { useProto } from "../prototype/proto-store.tsx";
import {
  type PlanToolkit,
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
          {toolkit.mcp.length === 0 && <span className="muted">{t("pages.toolkit.none")}</span>}
          {toolkit.mcp.map((m) => (
            <button key={m} type="button" className="chip chip-data chip-x" onClick={() => set({ ...toolkit, mcp: toolkit.mcp.filter((x) => x !== m) })} aria-label={t("pages.toolkit.removeMcp", { name: m })}>
              {mcpTitle(m) ? t("pages.toolkit.mcpNamed", { title: mcpTitle(m), name: m }) : m} ×
            </button>
          ))}
          {mcpOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...toolkit, mcp: [...toolkit.mcp, e.target.value] })} aria-label={t("pages.toolkit.addMcp")}>
              <option value="">{t("pages.toolkit.addRegisteredMcp")}</option>
              {mcpOptions.map((m) => (
                <option key={m.name} value={m.name}>
                  {t("pages.toolkit.mcpNamed", { title: m.title, name: m.name })}
                </option>
              ))}
            </select>
          )}
        </div>
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

/** 已在二狗里登记的 MCP（原型） */
const REGISTERED_MCPS = ["demo-exif-reader", "demo-mail-readonly", "demo-calendar-readonly", "demo-git-host"];

/** 原型数据（假项目、假任务）的工具包区：只在页面里改 */
export function ToolkitEditor({ initial, readOnly }: { initial: Toolkit; readOnly?: boolean }) {
  const [kit, setKit] = useState(initial);
  const { proto } = useProto();
  const toast = useToast();
  const changed = () => toast(t("pages.toolkit.protoChanged"));
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
          {kit.skills.length === 0 && <span className="muted">{t("pages.toolkit.none")}</span>}
          {kit.skills.map((s) => (
            <button key={s} type="button" className="chip chip-data chip-x" onClick={() => set({ ...kit, skills: kit.skills.filter((x) => x !== s) })} aria-label={t("pages.toolkit.remove", { name: s })}>
              {s} ×
            </button>
          ))}
          {skillOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...kit, skills: [...kit.skills, e.target.value] })} aria-label={t("pages.toolkit.addSkill")}>
              <option value="">{t("pages.toolkit.addFromLibrary")}</option>
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
          {kit.mcps.length === 0 && <span className="muted">{t("pages.toolkit.none")}</span>}
          {kit.mcps.map((s) => (
            <button key={s} type="button" className="chip chip-data chip-x" onClick={() => set({ ...kit, mcps: kit.mcps.filter((x) => x !== s) })} aria-label={t("pages.toolkit.remove", { name: s })}>
              {s} ×
            </button>
          ))}
          {mcpOptions.length > 0 && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && set({ ...kit, mcps: [...kit.mcps, e.target.value] })} aria-label={t("pages.toolkit.addMcp")}>
              <option value="">{t("pages.toolkit.addRegisteredMcp")}</option>
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
        <span className="muted">{t("pages.toolkit.protoBashHint")}</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">{t("pages.toolkit.network")}</div>
        <input type="checkbox" checked={kit.network} onChange={(e) => set({ ...kit, network: e.target.checked })} />
        <span className="muted">{t("pages.toolkit.protoNetworkHint")}</span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k tk-k-wide">
          <NamedText text={TELL_SECRETARY_LABEL} />
        </div>
        <input type="checkbox" checked={tellSecretaryOn(kit)} onChange={(e) => set(withTellSecretary(kit, e.target.checked))} />
        <span className="muted">
          <NamedText text={tellSecretaryHint()} />
        </span>
      </label>
      <label className="tk-row tk-switch">
        <div className="tk-k">{SEND_ATTACHMENT_LABEL}</div>
        <input type="checkbox" checked={sendAttachmentOn(kit)} onChange={(e) => set(withSendAttachment(kit, e.target.checked))} />
        <span className="muted">
          <NamedText text={sendAttachmentHint()} />
        </span>
      </label>
      <div className="hint">{t("pages.toolkit.protoHint")}</div>
    </fieldset>
  );
}
