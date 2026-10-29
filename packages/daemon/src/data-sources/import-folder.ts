// 共用的导入文件夹（295 号票，issue 25"一个共用的导入文件夹"）的文件那一层：列出放进来的文件、认文件、挪进"已导入"、在电脑上打开。
// 认哪个数据源、交给谁、记什么由服务（service.ts）定；这里只碰文件。
// - 只看导入文件夹第一层的文件：子文件夹（包括"已导入"）、点开头的、还没下载完的临时文件（.part、.crdownload、.tmp、.download、~$ 开头的）不看；
// - 一个文件先挪进"已导入"再交给数据源导入（改名是一下子的事：同一个文件不会被导两次），导入出错再挪回来；
//   挪不动（被别的程序占着、还在复制）就留着下次再看；
// - 重名的挪进"已导入"时加序号："bills (2).csv"。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DataSourceFileType } from "./api.ts";

/** 认文件时读开头多少字节（内容特征） */
export const IMPORT_HEAD_BYTES = 4096;

/** 导入文件夹第一层的一个文件 */
export interface ImportCandidate {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** 不看的：点开头的、Office 的锁文件、还没下载完、复制到一半的临时文件 */
const SKIPPED = [/^\./, /^~\$/, /\.(part|crdownload|tmp|download|partial)$/i];

/** 导入文件夹第一层的文件（按名字排） */
export function listImportFiles(dir: string): ImportCandidate[] {
  if (!fs.existsSync(dir)) return [];
  const out: ImportCandidate[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || SKIPPED.some((re) => re.test(entry.name))) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(file);
      out.push({ name: entry.name, path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // 刚被挪走、删掉：不管它
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** 文件开头一段（读不了是空的） */
export function readHead(file: string, bytes = IMPORT_HEAD_BYTES): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 数据源认不认这个文件：写了的条件（扩展名、文件名、内容特征）都要对上，一样都没写的不认 */
export function fileTypeMatches(type: DataSourceFileType, name: string, head: Buffer): boolean {
  if (!type.extensions && !type.names && !type.sniff) return false;
  if (type.extensions && !type.extensions.map((e) => e.toLowerCase()).includes(path.extname(name).toLowerCase())) return false;
  if (type.names && !type.names.test(name)) return false;
  if (type.sniff) {
    try {
      if (!type.sniff(head, name)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 在 dir 里给 name 找一个没被占的名字：原名，或者"名字 (2).扩展名"、"名字 (3).扩展名"…… */
export function freeName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** 把文件挪进 dir（重名加序号），交回挪到的完整路径；挪不动（被占着）抛错 */
export function moveInto(file: string, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, freeName(dir, name));
  fs.renameSync(file, target);
  return target;
}

/**
 * 在这台电脑上用系统的文件管理器打开一个文件夹（设置 · 数据源的"在电脑上打开"）：Windows 用资源管理器，macOS 用 open，别的用 xdg-open。
 * 守护进程在用户的桌面会话里跑时才看得到窗口；拉不起来抛错
 */
export function openFolderOnDesktop(dir: string): Promise<void> {
  const [command, args] = process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
