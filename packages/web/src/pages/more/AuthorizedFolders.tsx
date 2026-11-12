// 设置 · 目录授权最上面那一节"授权的文件夹"（原来叫"找文件的本机文件夹"，是一个多行文本框；后来单独一页 #/more/authorized-folders，
// 448 号票并进目录授权那一页 FolderGrantsPage.tsx，浏览插件停用时也在）：守护进程那台电脑上的一份文件夹，所有 agent 读里面的文件都不用问（只放开读，守卫的判定在 daemon 的 guard/judge.ts），
// 秘书和"浏览"里的二狗找照片、找文件也先在这里找；在秘书的聊天里授权的也是这一份，这里跟着有。页面写清后果：读到的内容会发给模型服务，不要授权放密钥的文件夹。
// - 每个文件夹一行：完整路径（长了断行），现在找不到的标"找不到了"，右边一个叉，点了马上拿掉、存好（没有确认框，拿错了再加回来）；
// - 列表下面"添加文件夹"：开选文件夹的框（几处共用的那一个，ui/folder-picker.tsx；选的是二狗那台电脑上的）——"授权这个文件夹"、
//   贴完整路径按"授权"都是马上加进来、存好、框关掉，失败的框不关、写原因；已经授权的标"已授权"；
// - 说明下面一句提醒（463）：这里只放开读、对所有 agent；要让某个项目、任务的负责人写、删别的目录，到它的 ⚙ 里单独授权，
//   带一个跳到同页"各个 agent 的目录授权"的链接；
// - 没有"保存"按钮：每次加、拿掉都马上存，失败的在这一节里写原因；页面重新显示时（切回来、窗口重新拿到焦点）重新取一次列表。
// 状态和动作在 app/authorized-folders.ts；一行一行怎么画在 ui/authorized-folders.tsx（test/ui/authorized-folders.test.ts 渲染出来查）。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AuthorizedFolders } from "../../app/authorized-folders.ts";
import { useStore } from "../../app/store.tsx";
import { LOCAL_FOLDERS_MAX, t } from "../../state/index.ts";
import { AssistantName } from "../../ui/assistant-name.tsx";
import { FolderRows } from "../../ui/authorized-folders.tsx";
import { Section } from "../../ui/common.tsx";
import { FolderPickerSheet } from "../../ui/folder-picker.tsx";
import { T } from "../../ui/i18n.tsx";

/** onPerAgent：提醒里的链接，跳到同页"各个 agent 的目录授权" */
export function AuthorizedFoldersSection({ onPerAgent }: { onPerAgent(): void }) {
  const { http } = useStore();
  const store = useMemo(() => new AuthorizedFolders(http), [http]);
  const state = useSyncExternalStore(store.subscribe, store.state, store.state);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    void store.refresh();
    // 切回来、窗口重新拿到焦点：再取一次（聊天里刚授权的回来就能看到）
    const again = () => {
      if (document.visibilityState === "visible") void store.refresh();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [store]);

  const full = (state.folders?.length ?? 0) >= LOCAL_FOLDERS_MAX;
  return (
    <Section title={t("pages.authorizedFolders.title")}>
      <span className="muted">
        <T k="pages.authorizedFolders.intro" params={{ name: <AssistantName />, max: LOCAL_FOLDERS_MAX }} />
      </span>
      <div className="fg-cross">
        <T
          k="pages.authorizedFolders.perAgentHint"
          params={{
            link: (
              <button type="button" className="link fg-cross-link" onClick={onPerAgent}>
                {t("pages.authorizedFolders.perAgentLink")}
              </button>
            ),
          }}
        />
      </div>
      <div className="sys-note">{t("pages.authorizedFolders.warning")}</div>
      <span className="muted">
        <T k="pages.authorizedFolders.exceptions" params={{ name: <AssistantName /> }} />
      </span>
      <FolderRows folders={state.folders} saving={state.saving} onRemove={(path) => void store.remove(path)} />
      {state.error && <div className="sys-note">{state.error}</div>}
      <div className="af-actions">
        <button type="button" className="btn" disabled={state.folders === undefined || full} onClick={() => setPicking(true)}>
          {t("pages.authorizedFolders.add")}
        </button>
        {full && <span className="muted">{t("pages.authorizedFolders.full", { max: LOCAL_FOLDERS_MAX })}</span>}
      </div>
      {picking && (
        <FolderPickerSheet
          title={t("pages.authorizedFolders.add")}
          labels={{ here: t("ui.authorizedFolders.authorizeHere"), busy: t("ui.authorizedFolders.authorizing"), paste: t("ui.authorizedFolders.authorize") }}
          marks={[{ paths: state.folders?.map((f) => f.path) ?? [], label: t("ui.authorizedFolders.authorized"), done: true }]}
          onChoose={(path) => store.add(path)}
          onClose={() => setPicking(false)}
        />
      )}
    </Section>
  );
}
