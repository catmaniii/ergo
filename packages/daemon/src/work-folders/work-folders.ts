// 新建时选工作文件夹（305 号票，用户 2026-10-25 试用后："从网页上创建了一个新的 Claude Code 的任务是成功了，但是我找不到设置默认的
// 新的 Claude Code 的项目文件夹的方法"）。能选工作文件夹的运行时（AgentRuntime.workFolder，现在是 Claude Code；pi 不变）的任务、项目：
// - 设置里定"新建时的默认文件夹"（每个运行时一个，存在配置区 config/work-folders.json，{ format: 1, defaults: { <运行时>: <文件夹> } }，
//   只由运行时写）：新的任务、项目默认在它下面新开一个子文件夹（按标题起名，workFolderName；重名加序号 "名字 (2)"）；
//   没设时照旧（任务用二狗给它开的工作目录，项目在项目档案里）；
// - 新建时也能选"用一个已有的文件夹"：绝对路径、在、是文件夹、不在数据目录或二狗程序目录里（受保护区域和整个数据目录，
//   和本机文件夹变化不许监视的地方同一份），交回真实路径；不行的抛 RequestRejected（bad_params，写明原因）。
// 定下的文件夹就是维护者的工作目录（Task.workdir、Project.workdir 在外面），守卫的项目目录就是它；删任务、项目时不删它。
// 290 号票接管来的会话的工作目录也按这里的规矩核对（在数据目录、程序目录里的不接）。
import fs from "node:fs";
import path from "node:path";
import { t, type WorkFolderChoice, workFolderName } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { isWithin } from "../guard/index.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { realPathOf } from "../util/real-path.ts";

/** 不许用的一块地方：真实路径、给人看的名字（"数据目录""二狗程序目录"） */
export interface WorkFolderForbidden {
  dir: string;
  title: string;
}

export interface WorkFoldersOptions {
  /** 设置文件（数据目录配置区的 work-folders.json） */
  file: string;
  /** 不许用的地方（受保护区域和整个数据目录），现取 */
  forbidden: () => readonly WorkFolderForbidden[];
  /** 这个运行时新建时能不能选工作文件夹（运行时登记表里 workFolder 是 true 的） */
  supports: (runtimeId: string) => boolean;
  log: (line: string) => void;
}

export interface WorkFolders {
  /** 这个运行时设的默认文件夹；没设是 undefined */
  defaultOf(runtimeId: string): string | undefined;
  /** 改默认文件夹（null 是不设）：不能选工作文件夹的运行时抛 not_allowed，路径不对抛 bad_params；存进设置文件 */
  setDefault(runtimeId: string, folder: string | null): void;
  /** 核对一个已有的文件夹：不行抛 RequestRejected（bad_params，写明原因），行的交回真实路径 */
  check(folder: string): string;
  /** 只核对、不建（新建项目时先看一眼，立项时才建）：用已有文件夹的核对路径；新开的要默认文件夹还在 */
  precheck(runtimeId: string | undefined, choice: WorkFolderChoice | undefined): void;
  /**
   * 新建任务、项目时定工作目录：运行时不能选工作文件夹的、没选已有文件夹又没设默认文件夹的是 undefined（照旧）；
   * 已有的核对后交回真实路径；新开的这时在默认文件夹下建出子文件夹（name 没写按 title 起名，重名加序号）
   */
  settle(runtimeId: string | undefined, choice: WorkFolderChoice | undefined, title: string): string | undefined;
}

/** 设置文件的样子 */
interface WorkFoldersFile {
  format: 1;
  defaults: Record<string, string>;
}

/** Windows 的绝对路径（盘符或 UNC 开头） */
const ABSOLUTE = /^([a-z]:[\\/]|\\\\)/i;

/** 重名时最多试到几 */
const DEDUP_MAX = 200;

export function createWorkFolders(options: WorkFoldersOptions): WorkFolders {
  const { file, log } = options;
  const defaults = new Map<string, string>(Object.entries(readFile(file, log)));

  const save = () => {
    if (defaults.size === 0) fs.rmSync(file, { force: true });
    else writeJsonAtomic(file, { format: 1, defaults: Object.fromEntries(defaults) } satisfies WorkFoldersFile);
  };

  const check = (folder: string): string => {
    const written = folder.trim();
    if (!ABSOLUTE.test(written) && !path.isAbsolute(written)) throw new RequestRejected("bad_params", t("workFolders.notAbsolute", { path: written }));
    const real = realPathOf(written);
    let stat: fs.Stats | undefined;
    try {
      stat = real === undefined ? undefined : fs.statSync(real);
    } catch {
      stat = undefined;
    }
    if (real === undefined || stat === undefined) throw new RequestRejected("bad_params", t("workFolders.missing", { path: written }));
    if (!stat.isDirectory()) throw new RequestRejected("bad_params", t("workFolders.notFolder", { path: written }));
    const inside = options.forbidden().find((area) => isWithin(real, area.dir));
    if (inside) throw new RequestRejected("bad_params", t("workFolders.forbidden", { path: written, area: inside.title }));
    return real;
  };

  /** 默认文件夹（还在、还能用的真实路径）；设了却不在了的抛错 */
  const usableDefault = (runtimeId: string): string | undefined => {
    const folder = defaults.get(runtimeId);
    if (folder === undefined) return undefined;
    try {
      return check(folder);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RequestRejected("bad_params", t("workFolders.defaultUnusable", { reason }));
    }
  };

  return {
    defaultOf: (runtimeId) => defaults.get(runtimeId),
    setDefault(runtimeId, folder) {
      if (!options.supports(runtimeId)) throw new RequestRejected("not_allowed", t("workFolders.notSupported", { runtime: runtimeId }));
      if (folder === null || folder.trim() === "") {
        if (!defaults.delete(runtimeId)) return;
      } else {
        const real = check(folder);
        if (defaults.get(runtimeId) === real) return;
        defaults.set(runtimeId, real);
      }
      save();
      log(`新建时的默认文件夹：${runtimeId} → ${defaults.get(runtimeId) ?? "不设"}`);
    },
    check,
    precheck(runtimeId, choice) {
      if (runtimeId === undefined || !options.supports(runtimeId)) return;
      if (choice?.kind === "existing") check(choice.path);
      else usableDefault(runtimeId);
    },
    settle(runtimeId, choice, title) {
      if (runtimeId === undefined || !options.supports(runtimeId)) return undefined;
      if (choice?.kind === "existing") return check(choice.path);
      const parent = usableDefault(runtimeId);
      if (parent === undefined) return undefined;
      return makeSubfolder(parent, choice?.name ?? title);
    },
  };
}

/** 在默认文件夹下新开一个子文件夹：起名、重名加序号、建出来 */
function makeSubfolder(parent: string, wanted: string): string {
  const base = workFolderName(wanted) || t("workFolders.untitled");
  for (let n = 1; n <= DEDUP_MAX; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const target = path.join(parent, name);
    try {
      fs.mkdirSync(target);
      return realPathOf(target) ?? target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new RequestRejected("bad_params", t("workFolders.createFailed", { folder: parent, name, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  throw new RequestRejected("bad_params", t("workFolders.createFailed", { folder: parent, name: base, error: t("workFolders.tooMany") }));
}

/** 设置文件里的默认文件夹；没有文件、读坏了、内容不对都当没设（记日志，不覆盖文件） */
function readFile(file: string, log: (line: string) => void): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`新建时的默认文件夹的设置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先当都没设`);
    return {};
  }
  const defaults = (parsed as Partial<WorkFoldersFile> | null)?.defaults;
  if ((parsed as Partial<WorkFoldersFile> | null)?.format !== 1 || typeof defaults !== "object" || defaults === null) {
    log(`新建时的默认文件夹的设置文件不对：${file}；先当都没设（不覆盖它）`);
    return {};
  }
  return Object.fromEntries(Object.entries(defaults).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
