// 列子文件夹（138 号票）：设置 · 浏览与填框里"添加文件夹"的框，在守护进程那台电脑上一路点进去选文件夹（GET /api/local-folders/browse）。
// - 不给路径：常用位置（图片、下载、桌面、文档、用户目录，存在的才列）和各个盘（Windows 上 C:\、D:\……，别的系统是 /）；
// - 给路径：它的子文件夹（只列文件夹，隐藏的、系统的不列——和 find_files 走文件夹时同一条规则 isSkippedFolder；
//   符号链接、目录联接也不列，find_files 同样不跟进），按名字排，最多 limit 个（多了截断，total 写一共几个），和上一级（盘的根没有）；
// - 读不了的（不是完整路径、不存在、不是文件夹、没有权限）回原因和上一级。
// 取用户目录、列盘的函数能注入：测试给临时目录，不碰真实的主目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOLDER_BROWSE_MAX, type FolderBrowseView, type FolderEntry, t } from "@ergo/protocol";

/**
 * 隐藏的、系统的文件夹：设置里选文件夹的框不列，浏览插件的 find_files 走文件夹时也不进（138 号票，同一条规则；212 号票从 find-files.ts 挪到这里：授权的文件夹是内核的）。点开头的（.git 这类）、$ 开头的
 * （$Recycle.Bin、$WinREAgent 这类系统的），和这几个（Windows 上本来就藏着的 AppData、ProgramData 等；不分大小写）
 */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "system volume information", "config.msi", "msocache", "appdata", "programdata"]);

export function isSkippedFolder(name: string): boolean {
  return name.startsWith(".") || name.startsWith("$") || SKIPPED_DIRS.has(name.toLowerCase());
}

export interface FolderBrowserOptions {
  /** 用户目录（默认 os.homedir()） */
  homeDir?: () => string;
  /** 各个盘的根（默认：Windows 上存在的 A:\ 到 Z:\，别的系统是 /） */
  drives?: () => Promise<string[]>;
  /** 一次最多列几个（默认 FOLDER_BROWSE_MAX） */
  limit?: number;
}

export interface FolderBrowser {
  browse(folder?: string): Promise<FolderBrowseView>;
}

/** 常用位置：用户目录下的这几个，再是用户目录本身 */
const PLACES: ReadonlyArray<{ name: () => string; dir: string }> = [
  { name: () => t("folders.place.pictures"), dir: "Pictures" },
  { name: () => t("folders.place.downloads"), dir: "Downloads" },
  { name: () => t("folders.place.desktop"), dir: "Desktop" },
  { name: () => t("folders.place.documents"), dir: "Documents" },
];

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** 这台电脑上的盘：Windows 上存在的 A:\ 到 Z:\（一起查），别的系统只有 / */
export async function localDrives(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const letters = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
  const present = await Promise.all(letters.map(isDirectory));
  return letters.filter((_, i) => present[i]);
}

/** 上一级；盘的根没有 */
function parentOf(dir: string): string | undefined {
  const parent = path.dirname(dir);
  return parent === dir ? undefined : parent;
}

/** 读不了的原因 */
function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return t("folders.browse.missing");
  if (code === "ENOTDIR") return t("folders.browse.notFolder");
  if (code === "EACCES" || code === "EPERM") return t("folders.browse.noPermission");
  return t("folders.browse.unreadable", { reason: code ?? (err instanceof Error ? err.message : String(err)) });
}

const byName = (a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });

export function createFolderBrowser(options: FolderBrowserOptions = {}): FolderBrowser {
  const homeDir = options.homeDir ?? (() => os.homedir());
  const drives = options.drives ?? localDrives;
  const limit = options.limit ?? FOLDER_BROWSE_MAX;

  const roots = async (): Promise<FolderBrowseView> => {
    const home = homeDir();
    const candidates = [...PLACES.map((p) => ({ name: p.name(), path: path.join(home, p.dir) })), { name: t("folders.place.home"), path: home }];
    const present = await Promise.all(candidates.map((c) => isDirectory(c.path)));
    const drivePaths = await drives();
    return {
      kind: "roots",
      places: candidates.filter((_, i) => present[i]),
      drives: drivePaths.map((root) => ({ name: root.replace(/[\\/]+$/u, "") || root, path: root })),
    };
  };

  return {
    async browse(folder) {
      if (folder === undefined || folder.trim() === "") return roots();
      const text = folder.trim();
      if (!path.isAbsolute(text)) return { kind: "unreadable", path: text, reason: t("folders.browse.notAbsolute") };
      const dir = path.resolve(text);
      const parent = parentOf(dir);
      const unreadable = (err: unknown): FolderBrowseView => ({ kind: "unreadable", path: dir, ...(parent === undefined ? {} : { parent }), reason: reasonOf(err) });
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        return unreadable(err);
      }
      const folders = entries
        .filter((e) => e.isDirectory() && !isSkippedFolder(e.name))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .toSorted(byName);
      return { kind: "folder", path: dir, ...(parent === undefined ? {} : { parent }), folders: folders.slice(0, limit), total: folders.length };
    },
  };
}
