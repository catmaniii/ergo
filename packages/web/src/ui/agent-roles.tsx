// 角色（248 号票）：把 241 号票"名字 + 音色两栏"换成一个"角色"下拉——选一个角色，名字和音色一起换。
// 名字影响界面上的称呼、它自己的系统提示、语音播报的开头；音色影响它说出来的所有话（语音回复、发语音、自动播报、让它念东西）。
// 跟默认 = 用默认角色（默认角色的名字是设置上面的全局名字、音色是语音页里选中的那个参考音色）；"恢复跟默认"就是清掉自己选的。
// 改了从它的下一轮起生效（音色下一次合成就用新的），不用重启、也不用刷新页面：接口回的整份回到状态层，⚙ 面板再取一次自己那份。
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  agentIdentityLine,
  type AgentSettingsView,
  followDefaultRoleLabel,
  t,
} from "../state/index.ts";
import { Section } from "./common.tsx";
import { useToast } from "./toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * ⚙ 面板里的一块：这个 agent 用哪个角色（跟默认 / 各个角色），下面一行小字写"现在：名字 · 音色"。
 * 存好之后要重新取一份面板（"实际生效的系统提示"全文里已经有新名字了）
 */
export function AgentRoleBlock({ view, onSaved }: { view: AgentSettingsView; onSaved(): void }) {
  const { assignAgentRole } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const { identity } = view;
  const disabled = busy || view.readOnly !== undefined;

  const pick = (value: string, done: string) => {
    setBusy(true);
    setFailed(undefined);
    assignAgentRole(view.agentId, value === "" ? null : value)
      .then(
        () => {
          toast(done);
          onSaved();
        },
        (err: unknown) => setFailed(t("ui.agentRoles.failed", { reason: errorText(err) })),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Section title={t("ui.agentRoles.title")}>
      <div className="muted agent-note">{t("ui.agentRoles.note")}</div>
      {view.readOnly && <div className="hint">{view.readOnly}</div>}
      <div className="agent-identity">
        <div className="muted agent-note">{agentIdentityLine(identity)}</div>
        <label className="field">
          <span>{t("ui.agentRoles.roleLabel")}</span>
          <select
            className="input"
            value={identity.ownRoleId ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const roleId = e.currentTarget.value;
              const name = view.roles.find((role) => role.id === roleId)?.name;
              pick(roleId, name === undefined ? t("ui.agentRoles.restored") : t("ui.agentRoles.saved", { name }));
            }}
          >
            <option value="">{followDefaultRoleLabel(identity.defaultName)}</option>
            {view.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        {identity.ownRoleId !== undefined && (
          <div className="auth-actions">
            <button type="button" className="btn ghost small" disabled={disabled} onClick={() => pick("", t("ui.agentRoles.restored"))}>
              {t("ui.agentRoles.restore")}
            </button>
          </div>
        )}
        <div className="hint">{t("ui.agentRoles.hint")}</div>
        {failed && (
          <div className="sys-note" role="alert">
            {failed}
          </div>
        )}
      </div>
    </Section>
  );
}
