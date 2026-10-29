// 新建时选工作文件夹（305 号票）在网页这一侧（纯函数）：发起任务、新建项目选了能选工作文件夹的运行时（Claude Code，运行时清单里带
// workFolder 的）时多一项"在哪个文件夹做"：
// - 在默认文件夹下新开一个（默认）：子文件夹名按标题起（workFolderName，和守护进程同一个），能改；没设默认文件夹时这一项写明照旧用
//   二狗给任务开的工作目录（去设置 · Claude Code 里定）；
// - 用一个已有的文件夹：填路径，下面列最近用过的几个（本机 Claude Code 会话的工作目录，290 号票的会话列表），点一下填进去。
// 路径对不对由守护进程核对（不存在、是文件、在数据目录或二狗程序目录里的拒绝，原因照它说的显示）。
// 卡上、建议立项卡上、⚙ 里写出定下的文件夹。
import { type AgentRuntimeView, type ResumableSessionView, t, type WorkFolderChoice, workFolderName } from "./protocol.ts";

/** 选的是哪一种：在默认文件夹下新开、用已有的 */
export type FolderMode = "new" | "existing";

/** 对话框里"在哪个文件夹做"那一项的草稿：name 是用户改过的子文件夹名（没改是空的，按标题起），path 是填的已有文件夹 */
export interface FolderDraft {
  mode: FolderMode;
  name: string;
  path: string;
}

export const EMPTY_FOLDER_DRAFT: FolderDraft = { mode: "new", name: "", path: "" };

/** 能选工作文件夹的运行时（现在能用、清单里带 workFolder 的）；pi、没取到清单的是 undefined */
export function workFolderRuntime(runtimes: readonly AgentRuntimeView[] | undefined, runtime: string): AgentRuntimeView | undefined {
  const found = runtimes?.find((r) => r.id === runtime);
  return found?.available && found.workFolder ? found : undefined;
}

/** 新开的子文件夹叫什么：用户改过的照用户的（守护进程还会再换掉不合法的字符），没改的按标题起 */
export function folderNameShown(draft: FolderDraft, title: string): string {
  return draft.name.trim() !== "" ? workFolderName(draft.name) : workFolderName(title);
}

/** 交给守护进程的：新开的、用户改了名字的才带名字（没改的守护进程按标题起，和这里看到的一样）；已有的带路径 */
export function folderChoiceOf(draft: FolderDraft): WorkFolderChoice {
  if (draft.mode === "existing") return { kind: "existing", path: draft.path.trim() };
  return draft.name.trim() === "" ? { kind: "new" } : { kind: "new", name: draft.name.trim() };
}

/** 能不能交：用已有文件夹的要填了路径 */
export function folderDraftReady(draft: FolderDraft): boolean {
  return draft.mode === "new" || draft.path.trim() !== "";
}

/** 文件夹下面再接一段（Windows 的写法；默认文件夹末尾带不带 \ 都行） */
export function joinFolder(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, "")}\\${name}`;
}

/**
 * "新开一个"那一项下面那一行：会建在哪（名字还没有的：任务按标题、项目按秘书起的项目名）；没设默认文件夹时说照旧用二狗开的工作目录
 */
export function newFolderPreview(defaultFolder: string | undefined, name: string, as: "task" | "project" = "task"): string {
  if (defaultFolder === undefined) return t("state.workFolder.noDefault");
  if (name !== "") return t("state.workFolder.preview", { path: joinFolder(defaultFolder, name) });
  return as === "task" ? t("state.workFolder.previewByTitle", { folder: defaultFolder }) : t("state.workFolder.previewByProject", { folder: defaultFolder });
}

/** 最近用过的文件夹：本机会话的工作目录，最近活动的在前，不分大小写去重，最多 max 个 */
export function recentFolders(sessions: readonly ResumableSessionView[], max = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of sessions.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const key = session.cwd.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(session.cwd);
    if (out.length >= max) break;
  }
  return out;
}

/** 建议立项卡上写的"在哪个文件夹做"（点"立项"时才定下）：已有的写路径；新开的写会建在哪（名字没起的按项目名） */
export function folderChoiceLine(choice: WorkFolderChoice | undefined, defaultFolder: string | undefined, projectName: string): string {
  if (choice?.kind === "existing") return t("state.workFolder.lineExisting", { path: choice.path });
  if (defaultFolder === undefined) return t("state.workFolder.lineNoDefault");
  const name = workFolderName(choice?.name ?? projectName);
  return t("state.workFolder.lineNew", { path: joinFolder(defaultFolder, name) });
}
