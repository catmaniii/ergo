// 恢复命令：从指定日期的快照恢复数据目录（规格第 18 节）。出事时先在 LSM 里停掉 ergo-daemon，再跑：
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/restore.ts <日期 YYYY-MM-DD> [--from local|sync|<目录>]
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/restore.ts --list
// 恢复完再经 LSM 起 ergo-daemon。恢复命令自己不启停任何服务；守护进程还在运行时拒绝执行。
//
// 和守护进程读同一份配置：数据目录取 ERGO_DATA_DIR（不设是用户主目录下的 .ergo），同步目录取配置里的 backup.syncDir。
// --from：local 只找本机备份区，sync 只找同步目录，给一个目录就在那个目录下找日期目录；不给时先本机、再同步目录。
// 恢复之前数据目录里的内容挪到本机备份区的 pre-restore-<时间> 目录（只留最近 2 份，更早的自动删掉）。
// @i18n-ignore-file log：命令行工具的输出（校验快照的说法走 t()，先装上自带的中文）
import os from "node:os";
import { availableSnapshots, RestoreRefused, restoreSnapshot, type RestoreSource } from "./backup/restore.ts";
import { loadConfig } from "./config/config.ts";
import { dataDirLayout } from "./config/data-dir.ts";
import { installBuiltinLocales } from "./i18n/index.ts";

installBuiltinLocales();

const USAGE = [
  "用法：",
  "  node packages/daemon/src/restore.ts <日期 YYYY-MM-DD> [--from local|sync|<目录>]   从那一天的快照恢复数据目录",
  "  node packages/daemon/src/restore.ts --list                                        列出本机备份区和同步目录里的快照",
  "恢复之前先在 Local Service Manager 里停掉 ergo-daemon，恢复完再起来。",
].join("\n");

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) fail(USAGE, args.length === 0 ? 2 : 0);

const config = loadConfig({ env: process.env, homeDir: os.homedir() });
const layout = dataDirLayout(config.dataDir);

if (args[0] === "--list") {
  console.log(`数据目录：${layout.root}`);
  for (const { label, root, problem, dates } of availableSnapshots(config, layout)) {
    if (root === undefined) console.log(`${label}：${problem}`);
    else console.log(`${label}（${root}）：${dates.length > 0 ? dates.join("、") : "没有快照"}`);
  }
  process.exit(0);
}

const [date, ...rest] = args;
let from: RestoreSource | undefined;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== "--from" || rest[i + 1] === undefined) fail(USAGE, 2);
  const value = rest[++i]!;
  from = value === "local" || value === "sync" ? value : { dir: value };
}

try {
  const result = await restoreSnapshot({ config, layout, date: date!, ...(from === undefined ? {} : { from }) });
  console.log(`已从 ${result.snapshot} 恢复数据目录 ${layout.root}。`);
  console.log(`恢复之前的内容挪到了 ${result.setAside}（pre-restore-* 只留最近 2 份）。`);
  console.log("现在可以在 Local Service Manager 里启动 ergo-daemon。");
  process.exit(0);
} catch (err) {
  if (err instanceof RestoreRefused) fail(`没有恢复：${err.message}`);
  fail(`恢复出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
