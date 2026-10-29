// 设置 · 浏览与填框里的"授权的文件夹"（138 号票）在状态层的那一半：纯函数。
// 守护进程那台电脑上的一份文件夹，秘书和"浏览"里的二狗共用；设置页一行一个、能叉掉，"添加文件夹"的框里一路点进去选
// （列子文件夹的接口 GET /api/local-folders/browse），已经授权的标"已授权"。
import { type FolderBrowseView, type LocalFolder, t } from "./protocol.ts";

/** 比较用：斜杠统一成反斜杠、去掉末尾的分隔符、不分大小写（守护进程去重也不分大小写） */
export function folderKey(path: string): string {
  const unified = path.trim().replaceAll("/", "\\");
  return (unified.length > 1 ? unified.replace(/\\+$/u, "") : unified).toLowerCase();
}

/** 这个文件夹已经在授权的文件夹里了 */
export function isAuthorizedFolder(folders: readonly LocalFolder[] | undefined, path: string): boolean {
  const key = folderKey(path);
  return folders?.some((f) => folderKey(f.path) === key) ?? false;
}

/** 选文件夹的框里，子文件夹列不全、一个都没有时的一句 */
export function folderListNote(view: Extract<FolderBrowseView, { kind: "folder" }>): string | undefined {
  if (view.total > view.folders.length) return t("state.authorizedFolders.partial", { total: view.total, shown: view.folders.length });
  if (view.total === 0) return t("state.authorizedFolders.empty");
  return undefined;
}
