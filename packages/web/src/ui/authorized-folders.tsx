// 设置 · 目录授权里授权的文件夹那一节怎么画（页面在 pages/more/AuthorizedFolders.tsx，状态和动作在 app/authorized-folders.ts）：
// - FolderRows：一行一个文件夹，完整路径（长了断行），找不到了的标出来，右边一个叉。
// "添加文件夹"的框是几处共用的那一个（ui/folder-picker.tsx）。
import { type LocalFolder, t } from "../state/index.ts";

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
