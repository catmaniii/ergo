// 从 ergou 迁到 ergo（312 号票）：切换时由主会话在本机跑一次（npm run migrate:ergo，入口 src/migrate-ergo.ts），守护进程停着时做——
// 1. 确认守护进程没在跑（数据目录的 pid 文件、配置里的本机端口），在跑就什么都不动；
// 2. 数据目录改名：主目录下的旧目录（~/.ergou）改成 ~/.ergo（同一个盘上只是改名）；
// 3. 数据目录里改了名的文件：config/ergou.json → ergo.json，db/ergou.db（连同 -wal、-shm、-journal）→ ergo.db，
//    skill 区里集合的清单 ergou-collection.json → ergo-collection.json；
// 4. 在原地建目录联接 ~/.ergou → ~/.ergo：LSM 条目、事件日志里写着的旧路径照样读得到；
// 5. 打印 LSM 那边要做的几步（照 LSM 的命令行），迁移脚本自己不碰 LSM。
// --dry-run 只列要做什么。每一步都能重跑：做过的跳过。新旧两份都在的（冲突）不动、写明，退出码 1。
// 旧名字一律从新名字推出来（协议包的 oldNameOf）；守护进程那边找不到新名字时自己也会用旧的（config/old-names.ts），这个脚本是把名字改正。
// @i18n-ignore-file log：命令行工具的输出，给在本机跑命令的人看
import fs from "node:fs";
import path from "node:path";
import { newNameOf, oldNameOf } from "@ergo/protocol";
import { loadConfig } from "../config/config.ts";
import { dataDirLayout } from "../config/data-dir.ts";
import { DATA_DIR_ENV, DATA_DIR_NAME } from "../config/old-names.ts";
import { COLLECTION_MANIFEST } from "../skills/library.ts";
import { daemonRunning } from "../process/pid-file.ts";
import { renameRetrying } from "../util/atomic-file.ts";

/** 一步：做了（done）、做过了跳过（skipped）、dry-run 里要做（planned）、没做成（failed） */
export interface MigrationStep {
  what: string;
  state: "done" | "skipped" | "planned" | "failed";
  detail?: string;
}

export interface MigrationOptions {
  /** 旧的数据目录（不给是主目录下的旧名字目录）；给的是新名字的目录时，旧的是它旁边旧名字的那个 */
  dataDir?: string;
  homeDir: string;
  dryRun: boolean;
  /** 守护进程在不在跑（在跑回原因）；不给按数据目录的 pid 文件和配置里的本机端口查 */
  running?: (dataDir: string) => Promise<string | undefined>;
}

export interface MigrationResult {
  ok: boolean;
  oldDir: string;
  newDir: string;
  steps: MigrationStep[];
  /** LSM 那边要做的几步（照着做，脚本不碰 LSM） */
  lsmSteps: string[];
}

/** 数据目录里改了名的文件（相对数据目录，新名字） */
const RENAMED_FILES = [path.join("config", "ergo.json"), ...["", "-wal", "-shm", "-journal"].map((suffix) => path.join("db", `ergo.db${suffix}`))];

/** 路径的样子：不在、目录联接 / 链接（指到哪）、真的目录、文件 */
function kindOf(p: string): { kind: "missing" } | { kind: "link"; target: string | undefined } | { kind: "dir" } | { kind: "file" } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { kind: "missing" };
  }
  if (st.isSymbolicLink()) {
    let target: string | undefined;
    try {
      target = fs.realpathSync.native(p);
    } catch {
      target = undefined;
    }
    return { kind: "link", target };
  }
  return st.isDirectory() ? { kind: "dir" } : { kind: "file" };
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 新旧两个数据目录 */
export function migrationDirs(options: Pick<MigrationOptions, "dataDir" | "homeDir">): { oldDir: string; newDir: string } {
  const given = path.resolve(options.dataDir ?? path.join(options.homeDir, oldNameOf(DATA_DIR_NAME)));
  const base = path.basename(given);
  if (newNameOf(base) !== base) return { oldDir: given, newDir: path.join(path.dirname(given), newNameOf(base)) };
  return { oldDir: path.join(path.dirname(given), oldNameOf(base)), newDir: given };
}

/** 默认的查法：数据目录的 pid 文件、配置里的本机端口（配置文件新旧名字都认） */
async function defaultRunning(dataDir: string, homeDir: string): Promise<string | undefined> {
  const config = loadConfig({ env: { [DATA_DIR_ENV]: dataDir }, homeDir });
  return daemonRunning(dataDirLayout(dataDir).pidFile, config.ports.local);
}

/** 跑一遍迁移（dryRun 时只列要做什么） */
export async function migrateToErgo(options: MigrationOptions): Promise<MigrationResult> {
  const { oldDir, newDir } = migrationDirs(options);
  const steps: MigrationStep[] = [];
  const result = (ok: boolean): MigrationResult => ({ ok, oldDir, newDir, steps, lsmSteps: lsmSteps(newDir) });
  const act = (what: string, run: () => void): boolean => {
    if (options.dryRun) {
      steps.push({ what, state: "planned" });
      return true;
    }
    try {
      run();
      steps.push({ what, state: "done" });
      return true;
    } catch (err) {
      steps.push({ what, state: "failed", detail: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  const sameDir = samePath(oldDir, newDir);
  const old = sameDir ? ({ kind: "missing" } as const) : kindOf(oldDir);
  const fresh = kindOf(newDir);
  const oldIsJunction = old.kind === "link" && old.target !== undefined && samePath(old.target, fs.existsSync(newDir) ? fs.realpathSync.native(newDir) : newDir);

  // 现在的数据在哪（检查守护进程、改文件名都在它里面）
  const live = old.kind === "dir" ? oldDir : fresh.kind === "dir" ? newDir : undefined;
  if (live === undefined) {
    steps.push({ what: `找数据目录`, state: "failed", detail: `${oldDir}、${newDir} 都不是目录（${old.kind}、${fresh.kind}）` });
    return result(false);
  }
  if (old.kind === "link" && !oldIsJunction) {
    steps.push({ what: `看 ${oldDir}`, state: "failed", detail: `它是链接，指到的不是 ${newDir}（${old.target ?? "指到的地方没了"}）：先看清楚再手动处理` });
    return result(false);
  }
  if (old.kind === "dir" && fresh.kind !== "missing") {
    steps.push({ what: `把 ${oldDir} 改名成 ${newDir}`, state: "failed", detail: `${newDir} 已经有了（${fresh.kind}）：两份都在，没动。看清楚哪份是在用的、挪开另一份再跑` });
    return result(false);
  }

  // 1. 守护进程得停着
  const running = await (options.running ?? ((dir) => defaultRunning(dir, options.homeDir)))(live);
  if (running) {
    steps.push({ what: "确认守护进程没在跑", state: "failed", detail: `${running}：先在 LSM 里停掉 ergo 的守护进程（旧名字的那个），再跑` });
    return result(false);
  }
  steps.push({ what: "确认守护进程没在跑", state: "done" });

  // 2. 数据目录改名
  if (old.kind === "dir") {
    if (!act(`把 ${oldDir} 改名成 ${newDir}`, () => renameRetrying(oldDir, newDir))) return result(false);
  } else if (!sameDir) {
    steps.push({ what: `把 ${oldDir} 改名成 ${newDir}`, state: "skipped", detail: "已经改过了" });
  }
  // 改完（dry-run 里还没改）数据在哪
  const dataDir = options.dryRun ? live : newDir;

  // 3. 数据目录里改了名的文件
  let ok = true;
  const renames = [...RENAMED_FILES.map((rel) => path.join(dataDir, rel)), ...collectionManifests(path.join(dataDir, "skills"))];
  for (const target of renames) {
    const source = path.join(path.dirname(target), oldNameOf(path.basename(target)));
    const shown = path.relative(dataDir, source);
    const what = `${shown} 改名成 ${path.basename(target)}`;
    const from = kindOf(source).kind;
    const to = kindOf(target).kind;
    if (from === "missing") {
      if (to !== "missing") steps.push({ what, state: "skipped", detail: "已经改过了" });
      continue;
    }
    if (to !== "missing") {
      steps.push({ what, state: "failed", detail: `新名字的 ${path.relative(dataDir, target)} 已经有了：两份都在，没动` });
      ok = false;
      continue;
    }
    if (!act(what, () => renameRetrying(source, target))) ok = false;
  }

  // 4. 原地建目录联接 旧 → 新
  if (!sameDir) {
    const what = `在 ${oldDir} 建目录联接，指到 ${newDir}`;
    if (oldIsJunction) steps.push({ what, state: "skipped", detail: "已经建好了" });
    else if (!act(what, () => fs.symlinkSync(newDir, oldDir, "junction"))) ok = false;
  }
  return result(ok);
}

/** skill 区里集合的清单（新名字）：每个集合目录一个 */
function collectionManifests(skillsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(skillsDir, e.name, COLLECTION_MANIFEST));
}

/** LSM 那边要做的几步（照 LSM 的命令行：lsm = 在 LSM 目录下 node bin\lsm.mjs） */
export function lsmSteps(newDir: string): string[] {
  const old = oldNameOf;
  return [
    `停掉旧的三个服务（守护进程在跑迁移之前就该停了）：lsm stop ${old("ergo-daemon")}；lsm stop ${old("ergo-tunnel")}；lsm stop ${old("ergo-asr")}（登记了的话）`,
    `记下现在的开机自启和 tailnet 入口，后面照着开：lsm autostart；lsm tailnet`,
    `撤销旧守护进程名下的服务（项目的服务，先停再拿掉登记）：lsm owned ${old("ergo-daemon")} 列出来，逐个 lsm owned remove ${old("ergo-daemon")}--<名字>`,
    `关掉旧的 tailnet 入口（开过的话）：lsm tailnet ${old("ergo-daemon")} off`,
    `换登记文件：LSM 的 registry/services/ 里 ${old("ergo-daemon")}.yaml、${old("ergo-tunnel")}.yaml、${old("ergo-asr")}.yaml 挪出去留底，照二狗仓库 deploy/lsm/ergo-*.example.yaml 写成 ergo-daemon.yaml、ergo-tunnel.yaml、ergo-asr.yaml——id 换成新的；${DATA_DIR_ENV} 和密钥路径换成 ${newDir}；exposure.via 换成 ergo-tunnel；profiles 换成 [ergo]；别的（端口、VPS、私钥、Node 路径）照旧的抄。然后 lsm reload`,
    `照第 2 步记下的打开：lsm autostart ergo-daemon on（ergo-tunnel、ergo-asr 原来开着的同样）；lsm tailnet ergo-daemon on <原来的名字>（名字照旧，手机上的地址就不用改）`,
    `启动：lsm start ergo-tunnel；lsm start ergo-asr（登记了的话）；lsm start ergo-daemon；lsm status 等到 RUNNING`,
    `守护进程接上 LSM 后，把在用项目的服务重新登记到 ergo-daemon 名下并拉起来（开机自启照服务自己的设置）：lsm owned ergo-daemon、lsm autostart 核对一遍`,
  ];
}
