// ergo-daemon 的 stop 钩子（LSM 条目里的 hooks.stop）：结束本机端口上的守护进程。
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/stop.ts
// 和守护进程读同一份配置：数据目录取 ERGO_DATA_DIR（LSM 给钩子注入同样的环境），端口取配置里的 ports.local。
//
// 不误杀：只有"监听这个端口的进程就是 pid 文件里那个进程（pid 相同、启动时间对得上）"时才结束它；
// 否则什么也不做，说明原因，以非零退出码结束（LSM 会把原因显示出来）。
// 守护进程按"随时可能被杀"设计：事件日志在 SQLite（WAL）里，输入队列在事件日志里，进程一结束 Job 对象就把
// agent 子进程和孙进程一起清掉（重新起来后按被杀恢复，见 recovery/），所以停止就是结束这个进程。
// LSM 的接入层连着时，停机走 link 协议（lsm/link.ts），用不到这个钩子。
// 只在 Windows 上用（LSM 只在 Windows 上）。
// @i18n-ignore-file log：命令行工具的输出（LSM 显示给看日志的人）
import { execFileSync } from "node:child_process";
import os from "node:os";
import { loadConfig } from "./config/config.ts";
import { dataDirLayout } from "./config/data-dir.ts";
import { matchesRunningProcess, readPidFile, removePidFile } from "./process/pid-file.ts";
import { listeningPids, portOccupied } from "./process/port-owner.ts";
import { stopVerdict } from "./process/stop-check.ts";

const config = loadConfig({ env: process.env, homeDir: os.homedir() });
const { pidFile } = dataDirLayout(config.dataDir);
const port = config.ports.local;

// 有没有人在听以真绑、真连为准；netstat 靠不住，它这一眼没有不等于没人在听，只用来查是谁
const occupied = await portOccupied(port);
const verdict = stopVerdict({
  port,
  pidFile,
  occupied,
  listeners: await listeningPids(port, { known: occupied, anyAddress: true }),
  record: readPidFile(pidFile),
  matches: (record) => matchesRunningProcess(record, record.pid),
});
if (verdict.action === "stopped") {
  console.log(verdict.message);
  process.exit(0);
}
if (verdict.action === "refuse") {
  console.error(`没有结束任何进程：${verdict.reason}`);
  process.exit(1);
}

execFileSync("taskkill", ["/PID", String(verdict.pid), "/T", "/F"], { stdio: "inherit", windowsHide: true });
// 等端口真的放出来
for (let i = 0; i < 50 && (await portOccupied(port)); i++) await new Promise((r) => setTimeout(r, 100));
if (await portOccupied(port)) {
  console.error(`端口 ${port} 还有人在听`);
  process.exit(1);
}
removePidFile(pidFile, verdict.pid);
console.log(`守护进程已停止（PID ${verdict.pid}，端口 ${port}）`);
