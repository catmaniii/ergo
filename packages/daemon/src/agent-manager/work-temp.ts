// 维护者、子 agent 的 bash 的临时目录（177 号票）：工作目录里的 `.ergo-tmp`，守卫按项目里的判，不用为临时文件写到项目外。
// - bash 起的进程里 TMPDIR、TEMP、TMP 都指到它（mktemp、Node 的 os.tmpdir()、Python 的 tempfile 都按它）。不放进 bash 进程本身的
//   环境变量，而是在每条命令前面 export（agent 子进程里换掉的 bash 工具的 commandPrefix）：Git Bash（MSYS）的挂载表在同一个用户的
//   所有 Git Bash 进程之间共用，`/tmp` 跟着第一个起来的那个进程的 TMP / TEMP——bash 进程本身带着项目的临时目录起来，用户自己开的
//   Git Bash 和别的项目的 `/tmp` 都会跟着指到这个项目里。所以 `/tmp` 照旧是系统的临时目录（守卫按 bashTmpMount 判，在项目外）；
// - 目录里放一个只写着 `*` 的 .gitignore：git 不收里面的东西（不改项目自己的 .gitignore，工作目录之后才 git init 的也一样）；
// - 每次拉起 agent 时建好，顺手删掉 7 天没动过的文件和空目录（和临时区一样按修改时间，backup/tmp-cleanup.ts）；
// - 312 号票：目录以前叫 .ergou-tmp，建的时候新的还没有、旧的在就把旧的改名过来（里面的东西照留）。
import fs from "node:fs";
import path from "node:path";
import { oldNameOf } from "@ergo/protocol";
import { cleanTmpDir } from "../backup/tmp-cleanup.ts";
import { WORK_TEMP_DIR } from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";

// 目录名定在守卫里（guard/own-temp.ts）：守卫把它里面的东西一律算临时文件
export { WORK_TEMP_DIR };

// @i18n-ignore-next data：写进 .gitignore 的内容
const GITIGNORE = "# 二狗给 agent 的 bash 用的临时目录（TMPDIR）：git 不收里面的东西，7 天没动过的文件自动删掉\n*\n";

/** 一个工作目录的临时目录 */
export function workTempDir(cwd: string): string {
  return path.join(cwd, WORK_TEMP_DIR);
}

/** bash 里指到临时目录的环境变量（守卫拆命令时按同样的值展开） */
export function workTempVars(dir: string): Record<string, string> {
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/** 建好临时目录、写上 .gitignore，再在后台删掉 7 天没动过的东西（删不掉的记日志，不影响拉起） */
export function ensureWorkTempDir(dir: string, now: number, log: (line: string) => void): void {
  const old = path.join(path.dirname(dir), oldNameOf(path.basename(dir)));
  if (old !== dir && !fs.existsSync(dir) && fs.existsSync(old)) {
    try {
      fs.renameSync(old, dir);
    } catch (err) {
      log(`旧的临时目录 ${old} 改名成 ${path.basename(dir)} 没成（${err instanceof Error ? err.message : String(err)}），新建一个`); // @i18n-ignore log：日志
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  // 每次都重写：修改时间是新的，清理时不会把它当成 7 天没动过的删掉
  fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE);
  cleanTmpDir(dir, now, log, { keepTopDirs: false }).catch((err: unknown) => log(`清理临时目录 ${dir} 出错：${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Git Bash 里 `/tmp` 挂到的 Windows 目录：MSYS 按 Windows 的 GetTempPath（依次看 TMP、TEMP、USERPROFILE、Windows 目录）定。
 * 二狗起的 bash 进程本身的环境就是守护进程的这几个变量（process/child-env.ts 的白名单），按它们算；真实路径（展开 8.3 短名）
 */
export function bashTmpMount(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const pick = (name: string) => Object.entries(env).find(([k, v]) => k.toUpperCase() === name && v !== undefined && v !== "")?.[1];
  const dir = pick("TMP") ?? pick("TEMP") ?? pick("USERPROFILE") ?? pick("SYSTEMROOT");
  return dir === undefined ? undefined : (realPathOf(dir) ?? path.resolve(dir));
}
