// 设置 · 浏览与填框里的"授权的文件夹"（138 号票；134 号票时叫"找文件的本机文件夹"，是一个多行文本框）：
// 守护进程那台电脑上的一份文件夹，秘书和"浏览"里的二狗找照片、找文件共用；在秘书的聊天里授权的也是这一份，这里跟着有。
// - 每个文件夹一行：完整路径（长了断行），现在找不到的标"找不到了"，右边一个叉，点了马上拿掉、存好（没有确认框，拿错了再加回来）；
// - 列表下面"添加文件夹"：开一个选文件夹的框（选的是二狗那台电脑上的）——最上面一排常用位置和各个盘，下面是当前文件夹里的子文件夹
//   （点了进去，有"上一级"），底部写着当前路径、"授权这个文件夹"；也能贴一个完整路径按"授权"；已经授权的标"已授权"；
// - 没有"保存"按钮：每次加、拿掉都马上存，失败的在这一节里写原因；页面重新显示时（切回来、窗口重新拿到焦点）重新取一次列表。
// 状态和动作在 app/authorized-folders.ts；一行一行、选文件夹的框里面怎么画在 ui/authorized-folders.tsx（test/ui/authorized-folders.test.ts 渲染出来查）。
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AuthorizedFolders } from "../../app/authorized-folders.ts";
import { useStore } from "../../app/store.tsx";
import { LOCAL_FOLDERS_MAX, t } from "../../state/index.ts";
import { AssistantName } from "../../ui/assistant-name.tsx";
import { FolderPickerBody, FolderRows } from "../../ui/authorized-folders.tsx";
import { Section, Sheet } from "../../ui/common.tsx";
import { T } from "../../ui/i18n.tsx";

export function AuthorizedFoldersSection() {
  const { http } = useStore();
  const store = useMemo(() => new AuthorizedFolders(http), [http]);
  const state = useSyncExternalStore(store.subscribe, store.state);

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
      <FolderRows folders={state.folders} saving={state.saving} onRemove={(path) => void store.remove(path)} />
      {state.error && <div className="sys-note">{state.error}</div>}
      <div className="af-actions">
        <button type="button" className="btn" disabled={state.folders === undefined || full} onClick={() => void store.openPicker()}>
          {t("pages.authorizedFolders.add")}
        </button>
        {full && <span className="muted">{t("pages.authorizedFolders.full", { max: LOCAL_FOLDERS_MAX })}</span>}
      </div>
      {state.picker && (
        <Sheet title={t("pages.authorizedFolders.add")} onClose={() => store.closePicker()} center>
          <FolderPickerBody
            picker={state.picker}
            folders={state.folders}
            onBrowse={(path) => void store.browse(path)}
            onUp={() => void store.up()}
            onAuthorize={(path) => void store.authorize(path)}
            onDraft={(text) => store.setDraft(text)}
            onAuthorizeDraft={() => void store.authorizeDraft()}
          />
        </Sheet>
      )}
    </Section>
  );
}
