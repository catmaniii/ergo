// 目录授权（ADR-0049）的界面部件：设置 · 目录授权的总览（pages/more/FolderGrantsPage.tsx）、各 agent 的 ⚙ 里那一块共用。
// - FolderGrantRows：一行一条：目录（长了断行）、登记了的操作、到期（没写到期的醒目地标"长期有效"；已过期、找不到了标出来）、
//   为什么给、谁什么时候加的，右边一个叉（点了马上删，没有确认框）；
// - FolderGrantForm：加一条：目录（完整路径，能手填，也能点旁边的"选文件夹…"开几处共用的那个选文件夹的框，ui/folder-picker.tsx；
//   框里这个 agent 已经登记了的标"已登记"、授权的文件夹标"所有 agent 可读"；选中了只填进表单，不马上存）、
//   读写删三个勾（删除单独勾，勾了不带写）、到期（长期有效、几天）、为什么给；
// - FolderGrantsBlock：⚙ 里那一块：说明下面一句提醒（463）——所有 agent 都能读的文件夹在设置 · 目录授权最上面，那里的不用在这里
//   再登记读，这里登记的只给这个 agent、可以勾写和删（带链接）；这个 agent 的几条和"加一条"，下面一行指到设置 · 目录授权看全部和使用记录。
// 每次打开现取；加、删、清了用回来的那一份。说法在状态层（state/folder-grants.ts）。
import { useCallback, useEffect, useId, useState } from "react";
import { toHash } from "../app/route-hash.ts";
import { useStore } from "../app/store.tsx";
import {
  FOLDER_GRANT_DURATIONS,
  FOLDER_GRANT_MODE_LABEL,
  FOLDER_GRANT_MODES,
  type FolderGrantDuration,
  folderGrantDurationText,
  folderGrantExpiresAt,
  folderGrantExpiry,
  type FolderGrantMode,
  folderGrantModesText,
  folderGrantPickerMarks,
  folderGrantsOf,
  type FolderGrantsView,
  folderGrantTimeText,
  type FolderGrantView,
  t,
} from "../state/index.ts";
import { Section } from "./common.tsx";
import { FolderPickButton, FolderPickerSheet } from "./folder-picker.tsx";
import { T } from "./i18n.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一条授权的几行：目录、操作、到期、为什么给、谁什么时候加的；onRemove 不给就没有叉（只读） */
export function FolderGrantRows({ grants, busy, onRemove }: { grants: readonly FolderGrantView[]; busy: boolean; onRemove?: ((grant: FolderGrantView) => void) | undefined }) {
  if (grants.length === 0) return <div className="muted af-empty">{t("ui.folderGrants.empty")}</div>;
  return (
    <ul className="af-list fg-list">
      {grants.map((g) => {
        const expiry = folderGrantExpiry(g);
        return (
          <li key={g.id} className={g.state === "active" ? "af-row fg-row" : "af-row fg-row af-missing"}>
            <div className="fg-main">
              <span className="af-path">{g.path}</span>
              <div className="fg-tags">
                <span className="af-tag fg-modes">{folderGrantModesText(g.modes)}</span>
                <span className={expiry.tone === "forever" ? "af-tag af-tag-warn fg-forever" : expiry.tone === "expired" ? "af-tag af-tag-warn" : "af-tag"}>{expiry.text}</span>
                {g.state === "missing" && <span className="af-tag af-tag-warn">{t("ui.folderGrants.missing")}</span>}
              </div>
              {g.note !== "" && <div className="fg-note">{g.note}</div>}
              <div className="muted fg-meta">{t(g.addedBy === "approval" ? "ui.folderGrants.addedOnCard" : "ui.folderGrants.addedByYou", { at: folderGrantTimeText(g.addedAt) })}</div>
            </div>
            {onRemove && (
              <button type="button" className="icon-btn af-remove" aria-label={t("ui.folderGrants.removePath", { path: g.path })} title={t("ui.folderGrants.remove")} disabled={busy} onClick={() => onRemove(g)}>
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 加一条授权：目录、读写删、到期、为什么给；加好了把新的一份交给 onSaved。
 * view 是现在的那一份（选文件夹的框里标"已登记""所有 agent 可读"用）
 */
export function FolderGrantForm({ agentId, view, onSaved, onCancel }: { agentId: string; view: FolderGrantsView | undefined; onSaved(view: FolderGrantsView): void; onCancel(): void }) {
  const { http } = useStore();
  const pathId = useId();
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [modes, setModes] = useState<FolderGrantMode[]>(["read"]);
  const [duration, setDuration] = useState<FolderGrantDuration>("forever");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = (m: FolderGrantMode) => setModes((now) => (now.includes(m) ? now.filter((x) => x !== m) : [...now, m]));
  const save = () => {
    setBusy(true);
    setError(undefined);
    const expiresAt = folderGrantExpiresAt(duration, Date.now());
    http.addFolderGrant({ agentId, path: path.trim(), modes, ...(expiresAt ? { expiresAt } : {}), ...(note.trim() ? { note: note.trim() } : {}) }).then(
      (next) => {
        setBusy(false);
        onSaved(next);
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err));
      },
    );
  };
  return (
    <div className="fg-form">
      <div className="fg-field">
        <label htmlFor={pathId}>{t("ui.folderGrants.path")}</label>
        <div className="fp-path-row">
          <input id={pathId} className="input" type="text" value={path} placeholder={t("ui.folderGrants.pathPlaceholder")} onChange={(e) => setPath(e.target.value)} />
          <FolderPickButton disabled={busy} onClick={() => setPicking(true)} />
        </div>
      </div>
      {picking && (
        <FolderPickerSheet
          title={t("ui.folderGrants.pickTitle")}
          intro={t("ui.folderGrants.pickIntro")}
          marks={folderGrantPickerMarks(view, agentId)}
          onChoose={(chosen) => {
            setPath(chosen);
            setError(undefined);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="fg-field" role="group" aria-label={t("ui.folderGrants.modes")}>
        <span>{t("ui.folderGrants.modes")}</span>
        <div className="fg-modes-pick">
          {FOLDER_GRANT_MODES.map((m) => (
            <label key={m} className="fg-mode">
              <input type="checkbox" checked={modes.includes(m)} onChange={() => toggle(m)} />
              {FOLDER_GRANT_MODE_LABEL[m]}
            </label>
          ))}
        </div>
        <span className="muted">{t("ui.folderGrants.deleteNote")}</span>
      </div>
      <label className="fg-field">
        <span>{t("ui.folderGrants.expiry")}</span>
        <select className="input" value={duration} onChange={(e) => setDuration(e.target.value as FolderGrantDuration)}>
          {FOLDER_GRANT_DURATIONS.map((d) => (
            <option key={d} value={d}>
              {folderGrantDurationText(d)}
            </option>
          ))}
        </select>
      </label>
      <label className="fg-field">
        <span>{t("ui.folderGrants.note")}</span>
        <input className="input" type="text" value={note} maxLength={500} placeholder={t("ui.folderGrants.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="sys-note">{t("ui.folderGrants.warning")}</div>
      {error && <div className="sys-note">{error}</div>}
      <div className="af-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
          {t("ui.folderGrants.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={busy || path.trim() === "" || modes.length === 0} onClick={save}>
          {busy ? t("ui.folderGrants.saving") : t("ui.folderGrants.save")}
        </button>
      </div>
    </div>
  );
}

/** ⚙ 里那一块：这个 agent 的目录授权，能加、能删；readOnly（任务结束了、项目归档了）时只能看 */
export function FolderGrantsBlock({ agentId, readOnly }: { agentId: string; readOnly: boolean }) {
  const { http } = useStore();
  const [view, setView] = useState<FolderGrantsView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    http.folderGrants().then(
      (v) => {
        setView(v);
        setError(undefined);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [http]);
  useEffect(load, [load]);
  const remove = (g: FolderGrantView) => {
    setBusy(true);
    http.removeFolderGrant(g.id).then(
      (v) => {
        setBusy(false);
        setView(v);
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err));
      },
    );
  };
  return (
    <Section title={t("ui.folderGrants.title")}>
      <span className="muted">{t("ui.folderGrants.intro")}</span>
      <div className="fg-cross">
        <T
          k="ui.folderGrants.globalHint"
          params={{
            link: (
              <a className="link fg-cross-link" href={toHash({ tab: "more", page: "folder-grants" })}>
                {t("ui.folderGrants.globalHintLink")}
              </a>
            ),
          }}
        />
      </div>
      {view === undefined ? <div className="muted af-empty">{error ?? t("ui.folderGrants.loading")}</div> : <FolderGrantRows grants={folderGrantsOf(view, agentId)} busy={busy || readOnly} onRemove={readOnly ? undefined : remove} />}
      {view !== undefined && error && <div className="sys-note">{error}</div>}
      {adding ? (
        <FolderGrantForm
          agentId={agentId}
          view={view}
          onCancel={() => setAdding(false)}
          onSaved={(v) => {
            setView(v);
            setAdding(false);
          }}
        />
      ) : (
        <div className="af-actions">
          <button type="button" className="btn" disabled={readOnly || view === undefined} onClick={() => setAdding(true)}>
            {t("ui.folderGrants.add")}
          </button>
          <a className="link" href={toHash({ tab: "more", page: "folder-grants" })}>
            {t("ui.folderGrants.seeAll")}
          </a>
        </div>
      )}
    </Section>
  );
}
