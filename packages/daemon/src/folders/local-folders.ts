// 授权的文件夹（134 号票叫"登记的本机文件夹"，138 号票起叫"授权的文件夹"）：守护进程那台电脑上的一份文件夹，秘书在聊天里和
// "浏览"里共用——二狗替网页的上传框找文件（find_files）时，除了素材（用户发过的附件、产出）还搜这几个文件夹（比如照片、文档），
// 秘书替用户找照片、文件也先在这里找。存在数据目录配置区的 local-folders.json（{ "folders": ["D:\\照片", ...] }），
// 每次现读（聊天里授权的、设置页改的，下一次用到就是新的）。
// 改它的有三处：设置页整份换（set，PUT）、设置页加一个拿掉一个（change，PATCH）、秘书的快速动作"授权文件夹"（prepare 先核对、
// 执行时 change）。规则都在这里：加进来的只认存在的、绝对路径的文件夹，最多 LOCAL_FOLDERS_MAX 个，不分大小写去重；
// change 时已经在列表里、现在找不到了的照样留着（设置页标"找不到了"，可能是没插的盘）。文件坏了当没有（记一条日志），下次存的时候整份重写。
// 212 号票：浏览插件拆出去时，授权的文件夹（这里、快速动作 authorize-folders.ts、设置页选文件夹的框 folder-browser.ts）留在内核：
// 秘书在聊天里也用它（唤起时那一块、快速动作），浏览插件的 find_files 经内核的服务 KERNEL.localFolders 取。原来在 page-commands/。
import fs from "node:fs";
import path from "node:path";
import { LOCAL_FOLDERS_MAX, type LocalFoldersView, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { writeJsonAtomic } from "../util/json-file.ts";

/** 加几个、拿掉几个 */
export interface LocalFoldersChange {
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
}

/**
 * 核对好的改动：改完的列表，要的那几个（按给的先后、去重，列表里有的写成列表里的写法），真的加了、拿掉了的，
 * 没变的（要加的本来就有、要拿掉的本来就没有）
 */
export interface PreparedLocalFoldersChange {
  folders: string[];
  requested: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface LocalFolders {
  /** 授权的文件夹（绝对路径，按授权的先后） */
  list(): string[];
  /** 设置页看的：每个还在不在 */
  view(): LocalFoldersView;
  /** 整份换掉；路径不对（不是绝对路径、不存在、不是文件夹）抛 bad_params */
  set(folders: readonly string[]): LocalFoldersView;
  /** 核对一次改动（不写）：要加的不是绝对路径、不存在、不是文件夹，要拿掉的不是绝对路径，加上以后超过上限，抛 bad_params */
  prepare(change: LocalFoldersChange): PreparedLocalFoldersChange;
  /** 核对并写下一次改动 */
  change(change: LocalFoldersChange): PreparedLocalFoldersChange;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const viewOf = (folders: readonly string[]): LocalFoldersView => ({ folders: folders.map((p) => ({ path: p, exists: isDirectory(p) })) });

/** 比较用：不分大小写 */
const keyOf = (dir: string) => dir.toLowerCase();
/** 和 a 是同一个文件夹（不分大小写） */
const same = (a: string) => (b: string) => keyOf(a) === keyOf(b);

/** 规范成完整路径（去掉首尾空白、末尾的分隔符）；不是绝对路径抛 bad_params */
function absolute(raw: string): string {
  const text = raw.trim();
  if (!path.isAbsolute(text)) throw new RequestRejected("bad_params", t("folders.local.notAbsolute", { path: text }));
  return path.resolve(text);
}

/** 要加进来的：规范成完整路径，还得是这台电脑上的文件夹 */
function existingFolder(raw: string): string {
  const dir = absolute(raw);
  if (!isDirectory(dir)) throw new RequestRejected("bad_params", t("folders.local.missing", { path: dir }));
  return dir;
}

export function openLocalFolders(options: { file: string; log: (line: string) => void }): LocalFolders {
  const read = (): string[] => {
    if (!fs.existsSync(options.file)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(options.file, "utf8")) as { folders?: unknown };
      return Array.isArray(value.folders) ? value.folders.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)).slice(0, LOCAL_FOLDERS_MAX) : [];
    } catch (err) {
      options.log(`授权的文件夹（${options.file}）读不出来，当没有授权：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
  const prepare = (change: LocalFoldersChange): PreparedLocalFoldersChange => {
    const current = read();
    const requested: string[] = [];
    const ask = (dir: string) => {
      const known = current.find(same(dir)) ?? dir;
      if (!requested.some(same(known))) requested.push(known);
      return known;
    };
    const removing = (change.remove ?? []).filter((raw) => raw.trim() !== "").map((raw) => ask(absolute(raw)));
    // 同一个写了几遍的只算一个
    const unique = removing.filter((dir, i) => removing.findIndex(same(dir)) === i);
    const removed = current.filter((dir) => unique.some(same(dir)));
    const unchanged = unique.filter((dir) => !removed.some(same(dir)));
    const kept = current.filter((dir) => !removed.includes(dir));
    const added: string[] = [];
    for (const raw of change.add ?? []) {
      if (raw.trim() === "") continue;
      const dir = ask(existingFolder(raw));
      if (kept.some(same(dir))) {
        if (!unchanged.some(same(dir))) unchanged.push(dir);
      } else if (!added.some(same(dir))) {
        added.push(dir);
      }
    }
    const folders = [...kept, ...added];
    if (folders.length > LOCAL_FOLDERS_MAX) throw new RequestRejected("bad_params", t("folders.local.tooManyAdding", { max: LOCAL_FOLDERS_MAX, kept: kept.length, added: added.length }));
    return { folders, requested, added, removed, unchanged };
  };
  return {
    list: read,
    view: () => viewOf(read()),
    set(folders) {
      const kept: string[] = [];
      for (const raw of folders) {
        if (raw.trim() === "") continue;
        const dir = existingFolder(raw);
        if (!kept.some((k) => keyOf(k) === keyOf(dir))) kept.push(dir);
      }
      if (kept.length > LOCAL_FOLDERS_MAX) throw new RequestRejected("bad_params", t("folders.local.tooMany", { max: LOCAL_FOLDERS_MAX }));
      writeJsonAtomic(options.file, { folders: kept });
      return viewOf(kept);
    },
    prepare,
    change(change) {
      const prepared = prepare(change);
      if (prepared.added.length > 0 || prepared.removed.length > 0) writeJsonAtomic(options.file, { folders: prepared.folders });
      return prepared;
    },
  };
}
