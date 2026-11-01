// 设置里一个运行时的"新建时的默认文件夹"那一页（Claude Code、Codex 插件的网页那一半都画它）：新的任务、项目默认在它下面
// 新开一个子文件夹（按标题起名、重名加序号）；没设时照旧用二狗给任务开的工作目录（项目的在项目档案里）。
// 填路径、保存（守护进程核对：不存在、是文件、在数据目录或二狗程序目录里的拒绝，原因照它说的显示）、不设了；下面列最近用过的几个文件夹
// （本机这个运行时的会话的工作目录，会话列表）点一下填进去。存好后运行时清单跟着换（发起对话框里马上用新的）。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import { recentFolders, t } from "../state/index.ts";
import { AssistantName } from "./assistant-name.tsx";
import { Section } from "./common.tsx";
import { T } from "./i18n.tsx";
import { setRuntimesCache, useRuntimes } from "./runtimes.tsx";
import { useToast } from "./toast.tsx";

export function RuntimeFolderPage({ runtime: runtimeId }: { runtime: string }) {
  const { http } = useStore();
  const toast = useToast();
  const runtime = useRuntimes(true)?.find((r) => r.id === runtimeId);
  const title = runtime?.title ?? runtimeId;
  const current = runtime?.workFolder?.defaultFolder;
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const value = draft ?? current ?? "";

  useEffect(() => {
    let alive = true;
    http.runtimeSessions(runtimeId).then(
      (view) => {
        if (alive) setRecent(recentFolders(view.sessions));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [http, runtimeId]);

  const save = (folder: string | null) => {
    setBusy(true);
    setError(undefined);
    http
      .setRuntimeFolder(runtimeId, folder)
      .then(
        (view) => {
          setRuntimesCache(view.runtimes);
          setDraft(undefined);
          toast(folder === null ? t("ui.runtimeFolder.cleared") : t("ui.runtimeFolder.saved", { runtime: title }));
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="runtime-folder-page">
      <Section title={t("ui.runtimeFolder.folderTitle")}>
        <div className="hint cc-folder-intro">
          <T k="ui.runtimeFolder.intro" params={{ runtime: title }} />
        </div>
        <div className="cc-folder-now">
          {current === undefined ? (
            <span className="muted">
              <T k="ui.runtimeFolder.notSet" params={{ name: <AssistantName /> }} />
            </span>
          ) : (
            <>
              <span className="muted">{t("ui.runtimeFolder.now")}</span>
              <code className="cc-folder-path">{current}</code>
            </>
          )}
        </div>
        <label className="field">
          <span>{t("ui.runtimeFolder.inputLabel")}</span>
          <input className="input cc-folder-input" value={value} placeholder={t("ui.runtimeFolder.placeholder")} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
        </label>
        {recent.length > 0 && (
          <div className="work-folder-recent">
            <span className="muted">{t("ui.workFolder.recent")}</span>
            {recent.map((folder) => (
              <button key={folder} type="button" className={`chip work-folder-chip${value.trim() === folder ? " on" : ""}`} onClick={() => setDraft(folder)}>
                {folder}
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className="prompt-broken" role="alert">
            {error}
          </div>
        )}
        <div className="cc-folder-actions">
          <button type="button" className="btn small primary" disabled={busy || value.trim() === "" || value.trim() === current} onClick={() => save(value.trim())}>
            {t("ui.runtimeFolder.save")}
          </button>
          {current !== undefined && (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => save(null)}>
              {t("ui.runtimeFolder.clear")}
            </button>
          )}
        </div>
        <div className="hint">
          <T k="ui.runtimeFolder.rules" params={{ name: <AssistantName /> }} />
        </div>
      </Section>
    </div>
  );
}
