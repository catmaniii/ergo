// 孙进程（由 agent 的 bash 工具拉起）：写下自己的 pid 并一直挂着（这次工具调用就一直没结束）；
// 同时经一个马上退出的中间进程，留下一个 detached 的"孤儿"曾孙进程。
//
// 这两个进程正是需要二狗 Job 的情形：孙进程由 bash（不是 Node）拉起，会悄悄脱离 Node 给子进程建的
// Job；孤儿的父进程已经没了，按进程树结束（taskkill /T、pi 中止工具时的清理）也找不到它。
// 二狗的 Job 不允许脱离，守护进程一死它们都得跟着死（Job 允许脱离时这条测试会失败，实测过）。
//
// 用法：node grandchild.mjs <pid 目录> [--orphan-parent | --orphan]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [pidDir, mode] = process.argv.slice(2);
if (!pidDir) throw new Error("缺少 pid 目录参数");
const self = process.argv[1];

if (mode === "--orphan") {
  fs.writeFileSync(path.join(pidDir, "orphan.pid"), String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "--orphan-parent") {
  spawn(process.execPath, [self, pidDir, "--orphan"], { detached: true, stdio: "ignore" }).unref();
  // 等曾孙进程写下 pid 就退出，它成了孤儿（先等它写好：回收孤儿的周期配得很短时，免得它还没写下 pid 就被回收了）
  const file = path.join(pidDir, "orphan.pid");
  const deadline = Date.now() + 60_000;
  setInterval(() => {
    if ((fs.existsSync(file) && fs.readFileSync(file, "utf8") !== "") || Date.now() > deadline) process.exit(0);
  }, 20);
} else {
  spawn(process.execPath, [self, pidDir, "--orphan-parent"], { stdio: "ignore" });
  fs.writeFileSync(path.join(pidDir, "grandchild.pid"), String(process.pid));
  setInterval(() => {}, 60_000);
}
