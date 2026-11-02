// 演示页里假项目、假任务的工具包区：skill、MCP 的可选项都是编的，只在页面里改。真项目、真任务的是 pages/ToolkitEditor.tsx 的 ToolkitPanel。
import { useState } from "react";
import { useProto } from "../app/proto-context.ts";
import type { Toolkit } from "../model/types.ts";
import { sendAttachmentHint, SEND_ATTACHMENT_LABEL, sendAttachmentOn, t, tellSecretaryHint, TELL_SECRETARY_LABEL, tellSecretaryOn, withSendAttachment, withTellSecretary } from "../state/index.ts";
import { NamedText } from "../ui/assistant-name.tsx";
import { useToast } from "../ui/toast.tsx";

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
