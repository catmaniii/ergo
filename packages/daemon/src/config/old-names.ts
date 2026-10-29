// ergou 换成 ergo 之后（312 号票），守护进程这边认旧名字的公用小件：环境变量、数据目录、数据目录里改了名的文件。
// 规矩同协议包的 old-names.ts：读新旧都认、新的优先，写只写新的；旧名字一律从新名字推出来（oldNameOf）。
// @i18n-ignore-file log：启动日志里的提示
import fs from "node:fs";
import path from "node:path";
import { newNameOf, OLD_SPELLING, oldNameOf } from "@ergo/protocol";

/** 环境变量的值：新名字的（去掉首尾空白，空的当没设），没设时看旧名字的（ERGO_DATA_DIR 没设看 ERGOU_DATA_DIR） */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  for (const key of [name, oldNameOf(name)]) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * 交给子进程的环境变量（项目的服务的 ERGO_BASE_PATH、项目操作脚本的 ERGO_OPS_*、事件触发的流程里 bash 的 ERGO_EVENT_*）：
 * 名字里有 ergo 的每个都另带一份旧名字的、值一样——用户项目里早先写好的脚本、服务读 $ERGOU_… 照样有值
 */
export function withOldEnvNames(vars: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...vars };
  for (const [key, value] of Object.entries(vars)) {
    const old = oldNameOf(key);
    if (old !== key && !(old in out)) out[old] = value;
  }
  return out;
}

/** 环境里还用着旧名字的二狗的变量（ERGOU_ 开头）：启动时提示一次换成哪个 */
export function oldEnvNamesIn(env: Readonly<Record<string, string | undefined>>): Array<{ old: string; name: string }> {
  const prefix = `${OLD_SPELLING.toUpperCase()}_`;
  return Object.keys(env)
    .filter((k) => k.toUpperCase().startsWith(prefix) && env[k] !== undefined && env[k] !== "")
    .map((old) => ({ old, name: `ERGO_${old.slice(prefix.length)}` }));
}

/** 路径存在（链接、目录联接本身在也算） */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文件或目录：新名字的不在、最后一段换成旧名字的在时用旧的（config/ergou.json、db/ergou.db……迁移脚本会改名，这是兜底）。
 * 两个都不在的是新名字（新建时用新的）
 */
export function pathOrOld(p: string): string {
  if (present(p)) return p;
  const old = path.join(path.dirname(p), oldNameOf(path.basename(p)));
  return old !== p && present(old) ? old : p;
}

/** 数据目录怎么定下来的：环境变量（新名字 / 旧名字）、默认的 ~/.ergo，或者 ~/.ergo 不在时用的旧的 ~/.ergou */
export type DataDirSource = "env" | "env_old" | "default" | "default_old";

/** 默认的数据目录名（用户主目录下） */
export const DATA_DIR_NAME = ".ergo";

/** 指定数据目录的环境变量 */
export const DATA_DIR_ENV = "ERGO_DATA_DIR";

/** 数据目录：环境变量 ERGO_DATA_DIR（没设看旧名字）> 主目录下的 .ergo > .ergo 不在而旧名字的目录在时用旧的 */
export function resolveDataDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): { dir: string; from: DataDirSource } {
  const explicit = env[DATA_DIR_ENV]?.trim();
  if (explicit) return { dir: path.resolve(explicit), from: "env" };
  const old = envValue(env, DATA_DIR_ENV);
  if (old) return { dir: path.resolve(old), from: "env_old" };
  const dir = path.resolve(homeDir, DATA_DIR_NAME);
  const chosen = pathOrOld(dir);
  return { dir: chosen, from: chosen === dir ? "default" : "default_old" };
}

/**
 * 守护进程启动时提示一次的话（312 号票，照样能用，只是提醒切换）：数据目录取的是旧的环境变量名、用的是旧的目录，
 * 数据目录里的配置文件、事件库还是旧名字，别的二狗的环境变量还用着旧名字
 */
export function oldNameNotes(
  config: { dataDir: string; dataDirFrom: DataDirSource },
  files: { configFile: string; eventsDb: string },
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const notes: string[] = [];
  if (config.dataDirFrom === "env_old") notes.push(`数据目录取的是旧的环境变量 ${oldNameOf(DATA_DIR_ENV)}（${config.dataDir}）：LSM 条目里换成 ${DATA_DIR_ENV}`);
  if (config.dataDirFrom === "default_old") notes.push(`数据目录用的是旧的 ${config.dataDir}（${DATA_DIR_NAME} 不在）：停机时跑 npm run migrate:ergo 改名`);
  for (const file of [files.configFile, files.eventsDb]) {
    if (path.basename(file) !== newNameOf(path.basename(file))) notes.push(`数据目录里的 ${file} 还是旧名字：停机时跑 npm run migrate:ergo 改名`);
  }
  for (const { old, name } of oldEnvNamesIn(env)) if (old !== oldNameOf(DATA_DIR_ENV) || config.dataDirFrom !== "env_old") notes.push(`环境变量 ${old} 是旧名字（照样认）：换成 ${name}`);
  return notes;
}
