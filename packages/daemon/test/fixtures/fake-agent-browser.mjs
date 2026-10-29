// 假的 agent-browser（178 号票）：照真的那样分 CLI 和守护进程。测试把 node.exe 拷成 agent-browser-*.exe 来跑它，
// 进程快照里的可执行文件名就和真的一样是 agent-browser 开头的。
// - CLI：起一个脱离的守护进程（同一个可执行文件），等它在 $AGENT_BROWSER_SOCKET_DIR/<会话>.pid 写下自己的 pid 再退出——
//   和真的一样，CLI 一退，守护进程的父进程就不在了；
// - 守护进程：写 pid 文件，起一个"Chrome"（真的 node，挂在守护进程下面），一直挂着；
//   另把自己和"Chrome"的 pid、看到的 AGENT_BROWSER_IDLE_TIMEOUT_MS 写进测试给的目录，好让测试看它们还在不在。
//
// 用法：<假 agent-browser.exe> fake-agent-browser.mjs <记录目录> <标记> <真 node 的路径>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [recordDir, tag, realNode, mode] = process.argv.slice(2);
if (!recordDir || !tag || !realNode) throw new Error("用法：fake-agent-browser.mjs <记录目录> <标记> <真 node 的路径>");
const self = process.argv[1];
const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
if (!socketDir) throw new Error("没有 AGENT_BROWSER_SOCKET_DIR");
const pidFile = path.join(socketDir, `${process.env.AGENT_BROWSER_SESSION || "default"}.pid`);

if (mode === "--chrome") {
  fs.writeFileSync(path.join(recordDir, `chrome-${tag}.pid`), String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "--daemon") {
  fs.mkdirSync(socketDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, `idle-${tag}.txt`), process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "");
  fs.writeFileSync(path.join(recordDir, `daemon-${tag}.pid`), String(process.pid));
  spawn(realNode, [self, recordDir, tag, realNode, "--chrome"], { stdio: "ignore" });
  // "Chrome"写下 pid 之后才写 pid 文件：CLI 等到 pid 文件就退出，那时守护进程和"Chrome"都已经在了
  const chromeFile = path.join(recordDir, `chrome-${tag}.pid`);
  const timer = setInterval(() => {
    if (fs.existsSync(chromeFile) && fs.readFileSync(chromeFile, "utf8") !== "") {
      clearInterval(timer);
      fs.writeFileSync(pidFile, String(process.pid));
      setInterval(() => {}, 60_000);
    }
  }, 20);
} else {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    // 没有
  }
  spawn(process.execPath, [self, recordDir, tag, realNode, "--daemon"], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + 20_000;
  const timer = setInterval(() => {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "") {
      clearInterval(timer);
      process.stdout.write(`✓ ${tag} 开好了\n`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      process.stderr.write("守护进程没起来\n");
      process.exit(1);
    }
  }, 20);
}
