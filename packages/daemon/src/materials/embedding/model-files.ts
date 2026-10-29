// 模型文件：在不在模型区。模型文件不随仓库分发、守护进程也不自动下载：用户在设置 · 组件里装（323 号票：下载、断点续传、
// 校验都在 components/），或者运行下载命令（npm run download-model，也走组件的下载器）。
import fs from "node:fs";
import path from "node:path";

export interface ModelFile {
  /** 相对模型目录的路径（用 / 分隔） */
  path: string;
  size: number;
  /** 大文件（git LFS）有 sha256，下载后核对 */
  sha256?: string;
}

/** 模型目录里文件都在、大小都对 */
export function modelFilesPresent(dir: string, files: readonly ModelFile[]): boolean {
  return files.every((file) => {
    try {
      return fs.statSync(path.join(dir, ...file.path.split("/"))).size === file.size;
    } catch {
      return false;
    }
  });
}
