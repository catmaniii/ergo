// 设置 · 角色与声音（248 号票；241 号票是"每个 agent 的名字和音色"各配各的，现在并成角色）：
// 用户 2026-10-22 定的：设很多个角色（名字 + 音色绑一起），每个 agent 选一个，选中就同时启用它的名字和音色；
// 这里维护角色表（新建、改名、换音色、试听、删除、谁是默认、谁在用）和每个 agent 用哪个角色。
// 默认角色的名字就是设置顶上那个全局名字、音色就是语音页里选中的参考音色：这一页改默认角色等于改那两样，不会两边打架。
// 删一个还有 agent 在用的角色会被拒（400，说清是谁在用）；删除按钮要点两下。
import { useCallback, useEffect, useState } from "react";
import { toggleVoice, useVoicePlaying } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import {
  agentActivity,
  activityNote,
  type AgentRoleView,
  type AgentRolesView,
  canCreateRoleName,
  canSaveRoleName,
  defaultVoiceOptionLabel,
  followDefaultRoleLabel,
  roleNameProblem,
  roleUsageCount,
  roleUsageText,
  t,
} from "../../state/index.ts";
import { ActivityDot, Section } from "../../ui/common.tsx";
import { NamedText } from "../../ui/assistant-name.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 设置 · 角色与声音：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色。
 * 打开时经状态层取一次（App 里也取过一回）；每次改完接口回的是整份，直接换掉。
 */
export function RolesPage() {
  const { ui, loadAgentRoles } = useStore();
  const view = ui.agentRoles;
  const [failed, setFailed] = useState<string>();
  const load = useCallback(() => {
    loadAgentRoles().then(
      () => setFailed(undefined),
      (err: unknown) => setFailed(t("pages.roles.failed", { reason: errorText(err) })),
    );
  }, [loadAgentRoles]);
  useEffect(load, [load]);

  return (
    <>
      <RoleTableSection view={view} />
      <CreateRoleSection view={view} />
      <AgentAssignmentSection view={view} />
      {failed && <div className="sys-note">{failed}</div>}
      {!view && !failed && <div className="muted">{t("pages.roles.loading")}</div>}
      {view?.voiceUnavailable && <div className="hint">{view.voiceUnavailable}</div>}
    </>
  );
}

/**
 * 角色表：一张规整的表（2026-10-23 用户："做成规整的表格，现在都没对齐，太随意了"）。
 * 列：默认（单选钮，点哪个哪个就是默认角色）｜角色（名字输入框）｜音色（下拉）｜谁在用（个数，悬停看是哪些）｜操作。
 * 默认角色**不写文字标签**（用户："默认角色不要用文字来标注，用文字标注让默认角色的名称栏和其它角色的名称栏对不齐了"）——
 * 单独一列放单选钮，每行的名字框、音色框都在同一竖线上。
 */
function RoleTableSection({ view }: { view: AgentRolesView | undefined }) {
  return (
    <Section title={t("pages.roles.tableTitle")}>
      <div className="muted agent-note">{t("pages.roles.tableHint")}</div>
      <div className="tbl-scroll">
        <table className="tbl role-table">
          <thead>
            <tr>
              <th className="col-default">{t("pages.roles.colDefault")}</th>
              <th className="col-role">{t("pages.roles.colRole")}</th>
              <th className="col-voice">{t("pages.roles.voiceLabel")}</th>
              <th className="col-used">{t("pages.roles.colUsedBy")}</th>
              <th className="col-actions">{t("pages.roles.colActions")}</th>
            </tr>
          </thead>
          <tbody>{view?.roles.map((role) => <RoleRow key={role.id} view={view} role={role} />)}</tbody>
        </table>
      </div>
    </Section>
  );
}

function RoleRow({ view, role }: { view: AgentRolesView; role: AgentRoleView }) {
  const { ui, updateAgentRole, deleteAgentRole, setDefaultAgentRole, http } = useStore();
  const toast = useToast();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string>();
  const name = draft ?? role.name;
  const problem = roleNameProblem(name);
  const playing = useVoicePlaying(`agent-role-voice:${role.id}`);
  const voices = view.voices ?? [];

  const act = (run: () => Promise<AgentRolesView>, done: string) => {
    setBusy(true);
    setFailed(undefined);
    run().then(
      () => {
        setDraft(undefined);
        setConfirming(false);
        toast(done);
      },
      (err: unknown) => setFailed(t("pages.roles.failed", { reason: errorText(err) })),
    ).finally(() => setBusy(false));
  };

  const saveName = () => act(() => updateAgentRole(role.id, { name: name.trim() }), t("pages.roles.nameSaved", { name: name.trim() }));

  const saveVoice = (value: string) => {
    // 默认角色的音色就是全局选中的那个：选它等于在语音页里选一个
    const picked = voices.find((voice) => voice.id === value);
    act(
      () => updateAgentRole(role.id, { voiceId: value === "" ? null : value }),
      picked ? t("pages.roles.voiceSaved", { name: role.name, voice: picked.name }) : t("pages.roles.voiceRestored", { name: role.name }),
    );
  };

  return (
    <tr className="role-row">
      {/* 默认角色用单选钮标（不写文字标签，免得把名字那一列挤歪）；点它 = 把这个角色设成默认 */}
      <td className="col-default">
        <input
          type="radio"
          name="role-default"
          checked={role.isDefault}
          disabled={busy || role.isDefault}
          aria-label={role.isDefault ? t("pages.roles.isDefault") : t("pages.roles.makeDefaultAria", { name: role.name })}
          onChange={() => act(() => setDefaultAgentRole(role.id), t("pages.roles.defaultChanged", { name: role.name }))}
        />
      </td>
      <td>
        <input
          className="input"
          value={name}
          disabled={busy}
          aria-label={`${role.name} · ${t("pages.roles.nameLabel")}`}
          aria-invalid={problem !== undefined}
          placeholder={t("pages.roles.namePlaceholder")}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setFailed(undefined);
          }}
        />
        {problem && (
          <div className="field-error" role="alert">
            {problem}
          </div>
        )}
        {failed && (
          <div className="sys-note" role="alert">
            {failed}
          </div>
        )}
      </td>
      <td>
        {voices.length === 0 ? (
          <span className="muted agent-note">{view.voiceUnavailable ?? t("pages.roles.voiceNone")}</span>
        ) : (
          <select className="input" value={role.voiceId ?? ""} disabled={busy} aria-label={`${role.name} · ${t("pages.roles.voiceLabel")}`} onChange={(e) => saveVoice(e.currentTarget.value)}>
            {/* 默认角色的音色就是全局选中的那个：没有"跟默认"这一项 */}
            {!role.isDefault && <option value="">{defaultVoiceOptionLabel(view)}</option>}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        )}
      </td>
      {/* 谁在用只写个数，是哪些 agent 悬停看（roleUsageText） */}
      <td className="muted" title={roleUsageText(ui, role)}>
        {roleUsageCount(role)}
      </td>
      <td>
        <div className="role-actions-cell">
          {/* "保存名字"只在名字改过之后才出现 */}
          {canSaveRoleName(role.name, name) && (
            <button type="button" className="btn primary small" disabled={busy} onClick={() => void saveName()}>
              {t("pages.roles.saveName")}
            </button>
          )}
          {role.voiceId !== undefined && (
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => {
                // 原型里没有这段录音（地址是 undefined）：点了没声，不报错
                const url = http.referenceVoiceAudioUrl(role.voiceId!);
                if (url !== undefined) toggleVoice(`agent-role-voice:${role.id}`, url);
              }}
            >
              {playing ? t("pages.roles.stop") : t("pages.roles.listen")}
            </button>
          )}
          {!role.isDefault &&
            (confirming ? (
              <button type="button" className="btn ghost small danger" disabled={busy} onClick={() => act(() => deleteAgentRole(role.id), t("pages.roles.deleted", { name: role.name }))}>
                {t("pages.roles.confirmDelete")}
              </button>
            ) : (
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(true)}>
                {t("pages.roles.delete")}
              </button>
            ))}
        </div>
      </td>
    </tr>
  );
}

/** 新建角色：起个名字、选个音色（不选就跟当前默认音色） */
function CreateRoleSection({ view }: { view: AgentRolesView | undefined }) {
  const { createAgentRole } = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const problem = roleNameProblem(name);
  const voices = view?.voices ?? [];

  const create = () => {
    setBusy(true);
    setFailed(undefined);
    createAgentRole({ name: name.trim(), voiceId: voiceId === "" ? null : voiceId }).then(
      () => {
        toast(t("pages.roles.created", { name: name.trim() }));
        setName("");
        setVoiceId("");
        setOpen(false);
      },
      (err: unknown) => setFailed(t("pages.roles.failed", { reason: errorText(err) })),
    ).finally(() => setBusy(false));
  };

  return (
    <Section
      title={t("pages.roles.createTitle")}
      extra={
        !open && (
          <button type="button" className="btn primary small" onClick={() => setOpen(true)}>
            {t("pages.roles.create")}
          </button>
        )
      }
    >
      <div className="muted agent-note">{t("pages.roles.createHint")}</div>
      {open && (
        <>
          <div className="agent-role-line">
            <label className="inline-field">
              <span>{t("pages.roles.nameLabel")}</span>
              <input
                className="input"
                value={name}
                disabled={busy}
                aria-label={t("pages.roles.nameLabel")}
                aria-invalid={problem !== undefined}
                placeholder={t("pages.roles.namePlaceholder")}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                  setFailed(undefined);
                }}
              />
            </label>
            <label className="inline-field">
              <span>{t("pages.roles.voiceLabel")}</span>
              {voices.length === 0 ? (
                <span className="muted agent-note">{view?.voiceUnavailable ?? t("pages.roles.voiceNone")}</span>
              ) : (
                <select className="input" value={voiceId} disabled={busy} aria-label={t("pages.roles.voiceLabel")} onChange={(e) => setVoiceId(e.currentTarget.value)}>
                  <option value="">{defaultVoiceOptionLabel(view)}</option>
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          {problem && (
            <pre className="field-error" role="alert">
              {problem}
            </pre>
          )}
          <div className="auth-actions">
            <button type="button" className="btn primary small" disabled={busy || !canCreateRoleName(name)} onClick={() => void create()}>
              {t("pages.roles.create")}
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setFailed(undefined);
              }}
            >
              {t("pages.roles.cancel")}
            </button>
          </div>
          {failed && (
            <div className="sys-note" role="alert">
              {failed}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * 每个 agent 用哪个角色：也是一张规整的表（2026-10-23 用户："有哪些 agent、分别用的哪个音色、agent 当前状态也搞成另一个表格"，
 * 随后又说"显示角色就行了，不用显示角色名称和音色"）。列：agent（叫法，秘书那段是名字标签）｜角色（下拉：跟随默认 / 各个角色）｜当前状态（活动状态那个小圆点）。
 */
function AgentAssignmentSection({ view }: { view: AgentRolesView | undefined }) {
  return (
    <Section title={t("pages.roles.agentsTitle")}>
      <div className="muted agent-note">{t("pages.roles.agentsHint")}</div>
      {view && view.agents.length === 0 && <div className="page-placeholder">{t("pages.roles.agentsEmpty")}</div>}
      {view && view.agents.length > 0 && (
        <div className="tbl-scroll">
          <table className="tbl agent-role-table">
            <thead>
              <tr>
                <th className="col-agent">{t("pages.roles.colAgent")}</th>
                <th className="col-role">{t("pages.roles.colRole")}</th>
                <th className="col-status">{t("pages.roles.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {view.agents.map((entry) => (
                <AgentAssignmentRow key={entry.agentId} view={view} agentId={entry.agentId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AgentAssignmentRow({ view, agentId }: { view: AgentRolesView; agentId: string }) {
  const { ui, assignAgentRole } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const entry = view.agents.find((item) => item.agentId === agentId);
  if (entry === undefined) return null;
  const { identity } = entry;
  const others = view.roles.filter((role) => !role.isDefault);
  const activity = agentActivity(ui, agentId);

  const pick = (value: string) => {
    setBusy(true);
    setFailed(undefined);
    assignAgentRole(agentId, value === "" ? null : value).then(
      () => toast(value === "" ? t("pages.roles.agentRestored") : t("pages.roles.agentSaved", { role: view.roles.find((role) => role.id === value)?.name ?? value })),
      (err: unknown) => setFailed(t("pages.roles.failed", { reason: errorText(err) })),
    ).finally(() => setBusy(false));
  };

  return (
    <tr>
      <td>
        <b>
          <NamedText text={entry.label} />
        </b>
        {entry.readOnly && <div className="hint">{entry.readOnly}</div>}
        {failed && (
          <div className="sys-note" role="alert">
            {failed}
          </div>
        )}
      </td>
      <td>
        <select className="input" value={identity.ownRoleId ?? ""} disabled={busy || entry.readOnly !== undefined} aria-label={t("pages.roles.colRole")} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="">{followDefaultRoleLabel(identity.defaultName)}</option>
          {others.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <ActivityDot state={activity.state} note={activityNote(activity)} />
      </td>
    </tr>
  );
}
