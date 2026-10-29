// 设置 · 浏览与填框里"授权的文件夹"那一节怎么画（138 号票；页面在 pages/more/AuthorizedFolders.tsx，状态和动作在 app/authorized-folders.ts）：
// - FolderRows：一行一个文件夹，完整路径（长了断行），找不到了的标出来，右边一个叉；
// - FolderPickerBody：选文件夹的框里面——最上面一排常用位置和各个盘，下面当前文件夹里的子文件夹（点了进去）和"上一级"，
//   底部当前路径和"授权这个文件夹"，再下面贴完整路径按"授权"；已经授权的标"已授权"。
import type { FolderPickerState } from "../app/authorized-folders.ts";
import { folderListNote, isAuthorizedFolder, type LocalFolder, t } from "../state/index.ts";

/** 授权的文件夹，一行一个：路径、找不到了的标出来、右边一个叉 */
export function FolderRows({ folders, saving, onRemove }: { folders: readonly LocalFolder[] | undefined; saving: boolean; onRemove(path: string): void }) {
  if (folders === undefined) return <div className="muted af-empty">{t("ui.authorizedFolders.loading")}</div>;
  if (folders.length === 0) return <div className="muted af-empty">{t("ui.authorizedFolders.empty")}</div>;
  return (
    <ul className="af-list">
      {folders.map((f) => (
        <li key={f.path} className={f.exists ? "af-row" : "af-row af-missing"}>
          <span className="af-path">{f.path}</span>
          {!f.exists && <span className="af-tag af-tag-warn">{t("ui.authorizedFolders.missing")}</span>}
          <button type="button" className="icon-btn af-remove" aria-label={t("ui.authorizedFolders.removePath", { path: f.path })} title={t("ui.authorizedFolders.remove")} disabled={saving} onClick={() => onRemove(f.path)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface FolderPickerBodyProps {
  picker: FolderPickerState;
  folders: readonly LocalFolder[] | undefined;
  onBrowse(path: string): void;
  onUp(): void;
  onAuthorize(path: string): void;
  onDraft(text: string): void;
  onAuthorizeDraft(): void;
}

/** 选文件夹的框里面：常用位置和各个盘、子文件夹、当前路径和"授权这个文件夹"、贴完整路径 */
export function FolderPickerBody({ picker, folders, onBrowse, onUp, onAuthorize, onDraft, onAuthorizeDraft }: FolderPickerBodyProps) {
  const { roots, current, loading, busy } = picker;
  const authorized = (path: string) => isAuthorizedFolder(folders, path);
  const here = current?.kind === "folder" ? current.path : undefined;
  const note = current?.kind === "folder" ? folderListNote(current) : undefined;
  return (
    <div className="af-picker">
      <div className="af-places" role="group" aria-label={t("ui.authorizedFolders.places")}>
        {roots === undefined && <span className="muted">{loading ? t("ui.authorizedFolders.listing") : t("ui.authorizedFolders.placesFailed")}</span>}
        {roots?.places.map((p) => (
          <button key={p.path} type="button" className={current?.path === p.path ? "af-place on" : "af-place"} title={p.path} onClick={() => onBrowse(p.path)}>
            {p.name}
            {authorized(p.path) && <span className="af-tag">{t("ui.authorizedFolders.authorized")}</span>}
          </button>
        ))}
        {roots?.drives.map((d) => (
          <button key={d.path} type="button" className={current?.path === d.path ? "af-place af-drive on" : "af-place af-drive"} onClick={() => onBrowse(d.path)}>
            {d.name}
          </button>
        ))}
      </div>
      <div className="af-nav">
        <button type="button" className="btn af-up" disabled={current === undefined || loading} onClick={onUp}>
          {t("ui.authorizedFolders.up")}
        </button>
        {loading && <span className="muted">{t("ui.authorizedFolders.listing")}</span>}
      </div>
      {current === undefined && <div className="muted af-empty">{t("ui.authorizedFolders.start")}</div>}
      {current?.kind === "unreadable" && <div className="sys-note">{t("ui.authorizedFolders.unreadable", { path: current.path, reason: current.reason })}</div>}
      {current?.kind === "folder" && current.folders.length > 0 && (
        <ul className="af-entries">
          {current.folders.map((f) => (
            <li key={f.path}>
              <button type="button" className="af-entry" onClick={() => onBrowse(f.path)}>
                <span className="af-entry-name">{f.name}</span>
                {authorized(f.path) && <span className="af-tag">{t("ui.authorizedFolders.authorized")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <div className="hint">{note}</div>}
      {here !== undefined && (
        <div className="af-here">
          <span className="af-path">
            <span className="muted">{t("ui.authorizedFolders.current")}</span>
            {here}
          </span>
          <button type="button" className="btn primary" disabled={busy || authorized(here)} onClick={() => onAuthorize(here)}>
            {authorized(here) ? t("ui.authorizedFolders.authorized") : busy ? t("ui.authorizedFolders.authorizing") : t("ui.authorizedFolders.authorizeHere")}
          </button>
        </div>
      )}
      <div className="af-paste">
        <input
          className="input"
          value={picker.draft}
          spellCheck={false}
          placeholder={t("ui.authorizedFolders.pastePlaceholder")}
          aria-label={t("ui.authorizedFolders.pathLabel")}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onAuthorizeDraft();
          }}
        />
        <button type="button" className="btn" disabled={busy || picker.draft.trim() === ""} onClick={onAuthorizeDraft}>
          {t("ui.authorizedFolders.authorize")}
        </button>
      </div>
      {picker.error && <div className="sys-note">{picker.error}</div>}
    </div>
  );
}
