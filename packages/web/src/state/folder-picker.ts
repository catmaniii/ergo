// 选本机文件夹的框在状态层的那一半（463 号票从授权的文件夹里拆出来，四处共用：设置 · 目录授权最上面的授权的文件夹、
// 设置 · 备份的另存文件夹、各 agent 的 ⚙ 里登记目录、新建任务 / 项目"用一个已有的文件夹"）：纯函数。
// 选的是守护进程那台电脑上的文件夹（列子文件夹的接口 GET /api/local-folders/browse）；框里要标出来的文件夹由调用方给，
// 比如授权的文件夹标"已授权"，⚙ 里标"已登记""所有 agent 可读"。
import { type FolderBrowseView, t } from "./protocol.ts";

/** 比较用：斜杠统一成反斜杠、去掉末尾的分隔符、不分大小写（守护进程去重也不分大小写） */
export function folderKey(path: string): string {
  const unified = path.trim().replaceAll("/", "\\");
  return (unified.length > 1 ? unified.replace(/\\+$/u, "") : unified).toLowerCase();
}

/** 框里要标出来的一组文件夹 */
export interface FolderMark {
  /** 这些文件夹（比较时不分大小写、不管末尾的斜杠） */
  paths: readonly string[];
  /** 标签上写的字 */
  label: string;
  /** 选它没有意义（比如已经授权了）：当前文件夹是它时，底部的按钮写这个标签、灰掉 */
  done?: boolean;
}

/** 这个文件夹带哪几个标签（按给的先后） */
export function folderMarksAt(marks: readonly FolderMark[] | undefined, path: string): FolderMark[] {
  const key = folderKey(path);
  return marks?.filter((m) => m.paths.some((p) => folderKey(p) === key)) ?? [];
}

/** 选文件夹的框里，子文件夹列不全、一个都没有时的一句 */
export function folderListNote(view: Extract<FolderBrowseView, { kind: "folder" }>): string | undefined {
  if (view.total > view.folders.length) return t("state.folderPicker.partial", { total: view.total, shown: view.folders.length });
  if (view.total === 0) return t("state.folderPicker.empty");
  return undefined;
}
