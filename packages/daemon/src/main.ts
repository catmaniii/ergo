// ergou-daemon 的入口：由 Local Service Manager 启动（条目见 deploy/lsm/ergou-daemon.example.yaml），二狗自己不启动任何服务。
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/main.ts
// 数据目录由环境变量 ERGOU_DATA_DIR 指定（LSM 条目里设），模型 key 由 LSM 从数据目录的密钥区注入。
// 源码靠 Node 的类型剥离直接运行，没有构建步骤；Web UI 用的是 npm run build:web 的构建产物。
//
// 起来之后在数据目录写 pid 文件（daemon.pid，startDaemon 写、停完删），LSM 的 stop 钩子（src/stop.ts）据此核对要结束的进程；
// 同一个数据目录已经有实例在跑（pid 文件里的进程还在、或者本机端口有人在听）时不启动，以退出码 1 退出，什么状态都不碰。
// 接入 LSM 的 link 协议（23 号票，lsm/link.ts）：LSM 注入了身份就出站连上它，有任务、有副作用的调用在跑时心跳报"忙"；
// LSM 经协议要求停机（立即，或等不忙了）时优雅停止、删 pid 文件、退出；没注入身份（手动起的）时什么都不连。
// 被直接结束时，Job 对象随之关闭，agent 子进程和孙进程一起结束；事件日志在 SQLite（WAL）里，不怕被杀，
// 重新起来后正在做的事按规则恢复（recovery/）。
import os from "node:os";
import { type Daemon, DaemonAlreadyRunning, startDaemon } from "./daemon.ts";

const log = (line: string) => process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);

let daemon: Daemon | undefined;
let stopping: Promise<void> | undefined;

/** 停守护进程（会删 pid 文件），然后退出进程（留一拍把给 LSM 的 bye 发出去）；停完 resolve */
function stopAndExit(why: string, code: number): Promise<void> {
  stopping ??= (async () => {
    log(`${why}，正在停止`);
    try {
      await daemon?.stop();
    } catch (err) {
      log(`停止时出错：${String(err)}`);
      code = 1;
    }
    setTimeout(() => process.exit(code), 200);
  })();
  return stopping;
}

try {
  daemon = await startDaemon({
    env: process.env,
    homeDir: os.homedir(),
    log,
    onLsmStop: () => stopAndExit("LSM 要求停机", 0),
    // 同一个服务已经有活跃的实例：被重复启动了，退出，别抢端口
    onLsmConflict: (reason) => void stopAndExit(`LSM 说已经有一个 ergou-daemon 在跑（${reason}）`, 1),
  });
  log(`二狗守护进程已启动：${daemon.localUrl}（数据目录 ${daemon.layout.root}，pid ${process.pid}${daemon.lsm.enabled ? "，接入 LSM" : ""}）`);

  // 开发时在终端里 Ctrl+C：正常关端口、停秘书、关库
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void stopAndExit(`收到 ${signal}`, 0));
} catch (err) {
  if (err instanceof DaemonAlreadyRunning) log(err.message);
  else log(`启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
