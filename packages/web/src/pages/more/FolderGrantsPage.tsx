// 设置 · 目录授权（#/more/folder-grants，数据与设备组，排在数据源后面；ADR-0049）：读写哪些目录不用问，一页看全、改全。
// 448 号票起原来单独一页的"授权的文件夹"并进来，旧地址 #/more/authorized-folders 认作这一页（app/route-hash.ts）。
// - 最上面一节是授权的文件夹（所有 agent 共用、只读，ADR-0041）：能加能拿掉，选文件夹的框，见 AuthorizedFolders.tsx；
//   那一节里一句提醒带链接，点了滚到下面"各个 agent 的"（463）；
// - 下面"各个 agent 的"：说明、怎么加、登记了也不放的，整页能一次清掉全部已过期的；接着每个 agent 一组（个人助理在前，
//   再是各个项目、任务的负责人；项目、任务删掉了的写明"已经没有这个 agent 了"，照样能删）：一行一条（ui/folder-grants.tsx），
//   能逐条删，每组能整组清掉（先确认）；加在各 agent 的 ⚙ 里（个人助理、项目、任务各自的），或者对话里审批卡上点"以后都允许"；
// - 最后是最近的使用记录：谁、什么时候、读写删了哪个登记目录的哪个路径，文件工具能拿到的写上字节数；
//   bash 里的只记看得到的路径参数，不是程序实际读写了哪些文件，如实写明。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  expiredFolderGrants,
  FOLDER_GRANT_MODE_LABEL,
  FOLDER_GRANT_USES_DEFAULT,
  type FolderGrantGroup,
  folderGrantGroups,
  type FolderGrantsClearBody,
  type FolderGrantsView,
  folderGrantTimeText,
  type FolderGrantUseView,
  type FolderGrantView,
  t,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Section, Sheet } from "../../ui/common.tsx";
import { FolderGrantRows } from "../../ui/folder-grants.tsx";
import { AuthorizedFoldersSection } from "./AuthorizedFolders.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "各个 agent 的目录授权"那一节（授权的文件夹那一节里的提醒点了滚到这里） */
const PER_AGENT_SECTION = "folder-grants-per-agent";

/** 一组的标题：认得的写它的名字，删掉了的写明 */
function GroupTitle({ group }: { group: FolderGrantGroup }) {
  return group.agentLabel === undefined ? <>{t("pages.folderGrants.gone", { agentId: group.agentId })}</> : <NamedText text={group.agentLabel} />;
}

export function FolderGrantsPage() {
  const { http } = useStore();
  const [view, setView] = useState<FolderGrantsView>();
  const [uses, setUses] = useState<FolderGrantUseView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** 等确认的整组清掉 */
  const [confirm, setConfirm] = useState<FolderGrantGroup>();

  const load = useCallback(() => {
    http.folderGrants().then(
      (v) => {
        setView(v);
        setError(undefined);
      },
      (err: unknown) => setError(errorText(err)),
    );
    http.folderGrantUses(FOLDER_GRANT_USES_DEFAULT).then(
      (v) => setUses(v.uses),
      () => setUses([]),
    );
  }, [http]);
  useEffect(() => {
    load();
    // 切回来、窗口重新拿到焦点：再取一次（审批卡上刚登记的、⚙ 里刚加的回来就能看到）
    const again = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [load]);

  const run = (p: Promise<FolderGrantsView>) => {
    setBusy(true);
    p.then(
      (v) => {
        setBusy(false);
        setView(v);
        setError(undefined);
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err));
      },
    );
  };
  const remove = (g: FolderGrantView) => run(http.removeFolderGrant(g.id));
  const clear = (body: FolderGrantsClearBody) => run(http.clearFolderGrants(body));
  const expired = expiredFolderGrants(view);
  const groups = view ? folderGrantGroups(view) : [];

  return (
    <>
      <AuthorizedFoldersSection onPerAgent={() => document.getElementById(PER_AGENT_SECTION)?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      <Section id={PER_AGENT_SECTION} title={t("pages.folderGrants.perAgent")}>
        <span className="muted">{t("pages.folderGrants.intro")}</span>
        <span className="muted">{t("pages.folderGrants.howToAdd")}</span>
        <div className="sys-note">{t("pages.folderGrants.never")}</div>
        {error && <div className="sys-note">{error}</div>}
        {view !== undefined && groups.length === 0 ? (
          <div className="muted af-empty">{t("pages.folderGrants.none")}</div>
        ) : (
          <div className="af-actions">
            <button type="button" className="btn" disabled={busy || expired === 0} onClick={() => clear({ expired: true })}>
              {t("pages.folderGrants.clearExpired", { count: expired })}
            </button>
          </div>
        )}
      </Section>
      {groups.map((group) => (
        <Section
          key={group.agentId}
          title={<GroupTitle group={group} />}
          extra={
            <button type="button" className="btn ghost fg-clear-group" disabled={busy} onClick={() => setConfirm(group)}>
              {t("pages.folderGrants.clearAgent")}
            </button>
          }
        >
          <FolderGrantRows grants={group.grants} busy={busy} onRemove={remove} />
        </Section>
      ))}
      <Section title={t("pages.folderGrants.uses")}>
        <span className="muted">{t("pages.folderGrants.usesIntro")}</span>
        {uses === undefined ? (
          <div className="muted af-empty">{t("pages.folderGrants.loading")}</div>
        ) : uses.length === 0 ? (
          <div className="muted af-empty">{t("pages.folderGrants.noUses")}</div>
        ) : (
          <ul className="af-list fg-uses">
            {uses.map((u, i) => (
              <li key={`${u.at}-${i}`} className="af-row fg-use">
                <div className="fg-main">
                  <span className="af-path">{u.path}</span>
                  <div className="muted fg-meta">
                    {folderGrantTimeText(u.at)} · {u.agentLabel === undefined ? u.agentId : <NamedText text={u.agentLabel} />} · {FOLDER_GRANT_MODE_LABEL[u.mode]}
                    {u.bytes !== undefined ? ` · ${t("pages.folderGrants.bytes", { count: u.bytes })}` : ""}
                    {u.viaShell ? ` · ${t("pages.folderGrants.viaShell")}` : ""}
                    {u.failed ? ` · ${t("pages.folderGrants.failed")}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {confirm && (
        <Sheet title={t("pages.folderGrants.clearAgentTitle")} onClose={() => !busy && setConfirm(undefined)} center>
          <div className="fg-confirm">
            <div>
              <GroupTitle group={confirm} />
            </div>
            <div className="muted">{t("pages.folderGrants.clearAgentBody", { count: confirm.grants.length })}</div>
            <div className="af-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(undefined)}>
                {t("pages.folderGrants.cancel")}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => {
                  clear({ agentId: confirm.agentId });
                  setConfirm(undefined);
                }}
              >
                {t("pages.folderGrants.clearAgentConfirm")}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
