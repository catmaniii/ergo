// ergou-daemon 的入口：由 Local Service Manager 启动（条目见 deploy/lsm/ergou-daemon.example.yaml），二狗自己不启动任何服务。
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/main.ts
// 数据目录由环境变量 ERGOU_DATA_DIR 指定（LSM 条目里设），模型 key 由 LSM 从数据目录的密钥区注入。
// 源码靠 Node 的类型剥离直接运行，没有构建步骤；Web UI 用的是 npm run build:web 的构建产物。
//
// 起来之后在数据目录写 pid 文件（daemon.pid），LSM 的 stop 钩子（src/stop.ts）据此核对要结束的进程。
// 被直接结束时，Job 对象随之关闭，agent 子进程和孙进程一起结束；事件日志在 SQLite（WAL）里，不怕被杀。
// 被杀后的恢复规则在 23 号票。
import os from "node:os";
import { startDaemon } from "./daemon.ts";
import { removePidFile, writePidFile } from "./process/pid-file.ts";

const log = (line: string) => process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);

try {
  const daemon = await startDaemon({ env: process.env, homeDir: os.homedir(), log });
  const pidFile = daemon.layout.pidFile;
  writePidFile(pidFile, daemon.localPort);
  log(`二狗守护进程已启动：${daemon.localUrl}（数据目录 ${daemon.layout.root}，pid ${process.pid}）`);

  // 开发时在终端里 Ctrl+C：正常关端口、停秘书、关库
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在停止`);
    daemon.stop().then(
      () => {
        removePidFile(pidFile);
        process.exit(0);
      },
      (err: unknown) => {
        log(`停止时出错：${String(err)}`);
        process.exit(1);
      },
    );
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => shutdown(signal));
} catch (err) {
  log(`启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
