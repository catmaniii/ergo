// 新建时选工作文件夹（305 号票）在界面上：发起任务、新建项目选了能选工作文件夹的运行时（Claude Code）时，运行时那一排下面多一项
// "在哪个文件夹做"（照"运行时"那一排 .seg）：在默认文件夹下新开一个（子文件夹名能改，下面一行写会建在哪）/ 用一个已有的文件夹
// （填路径，下面列最近用过的几个——本机 Claude Code 会话的工作目录，290 号票的会话列表，选到这一项时取一次）。
// 没设默认文件夹时第一项写"二狗开的工作目录"、说明去设置 · Claude Code 里定。说法在状态层（state/work-folder.ts）。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import { type FolderDraft, folderNameShown, newFolderPreview, recentFolders, t, workFolderRuntime } from "../state/index.ts";
import { AssistantName } from "./assistant-name.tsx";
import { T } from "./i18n.tsx";
import { useRuntimes } from "./runtimes.tsx";

/**
 * "在哪个文件夹做"：runtime 不能选工作文件夹的什么都不画。as 是建任务还是项目（任务的子文件夹按标题起，项目的按秘书起的项目名，
 * 这时还不知道）；title 是对话框里写的那段话
 */
export function WorkFolderPicker({ runtime, as, title, draft, onChange }: { runtime: string; as: "task" | "project"; title: string; draft: FolderDraft; onChange(next: FolderDraft): void }) {
  const found = workFolderRuntime(useRuntimes(), runtime);
  if (!found) return null;
  const defaultFolder = found.workFolder?.defaultFolder;
  const name = as === "task" || draft.name.trim() !== "" ? folderNameShown(draft, title) : "";
  return (
    <fieldset className="field work-folder">
      <legend>{t("ui.workFolder.legend")}</legend>
      <div className="seg work-folder-seg" role="radiogroup" aria-label={t("ui.workFolder.legend")}>
        <button type="button" role="radio" aria-checked={draft.mode === "new"} className={`seg-btn${draft.mode === "new" ? " on" : ""}`} onClick={() => onChange({ ...draft, mode: "new" })}>
          {defaultFolder === undefined ? <T k="ui.workFolder.ownDir" params={{ name: <AssistantName /> }} /> : t("ui.workFolder.newSub")}
        </button>
        <button type="button" role="radio" aria-checked={draft.mode === "existing"} className={`seg-btn${draft.mode === "existing" ? " on" : ""}`} onClick={() => onChange({ ...draft, mode: "existing" })}>
          {t("ui.workFolder.existing")}
        </button>
      </div>
      {draft.mode === "new" && defaultFolder !== undefined && (
        <label className="work-folder-row">
          <span>{t("ui.workFolder.nameLabel")}</span>
          <input
            className="input"
            value={draft.name}
            placeholder={as === "task" ? folderNameShown({ ...draft, name: "" }, title) || t("ui.workFolder.namePlaceholder") : t("ui.workFolder.nameByProject")}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>
      )}
      {draft.mode === "new" && (
        <div className="sc-mode-hint work-folder-hint">
          {defaultFolder === undefined ? <T k="ui.workFolder.noDefaultHint" params={{ name: <AssistantName /> }} /> : newFolderPreview(defaultFolder, name, as)}
        </div>
      )}
      {draft.mode === "existing" && <ExistingFolder runtime={runtime} draft={draft} onChange={onChange} />}
    </fieldset>
  );
}

/** 用一个已有的文件夹：路径输入框、最近用过的几个（本机会话的工作目录，取不到就不列） */
function ExistingFolder({ runtime, draft, onChange }: { runtime: string; draft: FolderDraft; onChange(next: FolderDraft): void }) {
  const { http } = useStore();
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    http.runtimeSessions(runtime).then(
      (view) => {
        if (alive) setRecent(recentFolders(view.sessions));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [http, runtime]);
  return (
    <>
      <input className="input work-folder-path" value={draft.path} placeholder={t("ui.workFolder.pathPlaceholder")} aria-label={t("ui.workFolder.pathLabel")} onChange={(e) => onChange({ ...draft, path: e.target.value })} />
      {recent.length > 0 && (
        <div className="work-folder-recent">
          <span className="muted">{t("ui.workFolder.recent")}</span>
          {recent.map((folder) => (
            <button key={folder} type="button" className={`chip work-folder-chip${draft.path.trim() === folder ? " on" : ""}`} onClick={() => onChange({ ...draft, path: folder })}>
              {folder}
            </button>
          ))}
        </div>
      )}
      <div className="sc-mode-hint work-folder-hint">
        <T k="ui.workFolder.existingHint" params={{ name: <AssistantName /> }} />
      </div>
    </>
  );
}
