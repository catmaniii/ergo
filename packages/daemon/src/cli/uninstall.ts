// ergo uninstall：停二狗、撤服务管家里的登记、撤开机自启、撤 PATH、删安装目录；问要不要删数据（默认不删）。
// 数据（~/.ergo、服务管家的 %LOCALAPPDATA%\ergo\supervisor）只在用的人说要删时才删。
// 安装目录里正跑着这条命令自己（node.exe、ergo.exe），删不了：交给一个等它们退出再删的小脚本（cmd，跑完把自己也删掉）。
// 配置了多份二狗（468）：默认那份以外的逐份列出来，都停掉、登记都拿掉；各份的文件夹逐份问删不删（默认留，--yes 不问也留）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "@ergo/protocol";
import { installPaths, readVersionInfo, removeCurrent, removeLink } from "../release/layout.ts";
import { removeFromUserPath, userPathStore } from "../release/user-path.ts";
import { readAutostartTask, taskInsideRoot } from "./autostart.ts";
import { type CliContext, contextForInstance } from "./context.ts";
import { defaultInstanceDir } from "./instance-commands.ts";
import { DEFAULT_SERVICE_ID, readMarker, registeredInstances } from "./instances.ts";
import { instanceContexts, packageManagerOf } from "./versions.ts";
import { DAEMON_SERVICE_ID, lsmScript, managerPidFromState, managerUp, runLsm, spawnDetachedHidden, stopManager, svcPaths, svcSnapshot } from "./service.ts";

export interface UninstallOptions {
  yes: boolean;
  /** true 删、false 不删、undefined 问 */
  deleteData?: boolean;
  /** 测试用：删安装目录的小脚本跑完再回（不用等这个进程退出） */
  waitForCleanup?: boolean;
}

/** 服务管家的开机自启任务（计划任务 LocalServiceManager）指着这个安装目录的话撤掉它；指着别处的（用的人自己装的服务管家）不动 */
function removeAutostart(ctx: CliContext, root: string): void {
  const action = readAutostartTask(ctx.env);
  if (!action) return;
  if (!taskInsideRoot(action, root)) {
    ctx.io.out(t("cli.uninstall.autostartElsewhere"));
    return;
  }
  const r = runLsm(ctx, ["uninstall-autostart"], { capture: true });
  if (r.code !== 0) {
    ctx.io.err(t("cli.uninstall.autostartFailed", { detail: `${r.stdout}${r.stderr}`.trim() || "?" }));
    return;
  }
  ctx.io.out(t("cli.uninstall.autostartRemoved"));
}

/** 等 pids 都退出再删 dir 的小脚本（cmd，后台跑、跑完删自己） */
function scheduleRemoval(dir: string, pids: readonly number[], wait: boolean): void {
  const script = path.join(os.tmpdir(), `ergo-uninstall-${process.pid}-${Date.now()}.cmd`);
  const waits = pids.map((pid) => `:w${pid}\r\ntasklist /FI "PID eq ${pid}" /NH 2>nul | find " ${pid} " >nul && (ping -n 2 127.0.0.1 >nul & goto w${pid})`).join("\r\n");
  fs.writeFileSync(
    script,
    ["@echo off", waits, "for /l %%i in (1,1,10) do (", `  if exist "${dir}" rmdir /s /q "${dir}"`, `  if exist "${dir}" ping -n 2 127.0.0.1 >nul`, ")", 'del "%~f0"', ""].join("\r\n"),
  );
  if (wait) {
    spawnSync("cmd.exe", ["/d", "/c", script], { stdio: "ignore", windowsHide: true });
    return;
  }
  // 和这条命令断开（不继承它的输出管道），等它退出后删
  spawnDetachedHidden("cmd.exe", ["/d", "/c", script], os.tmpdir(), process.env);
}

export async function cmdUninstall(ctx: CliContext, options: UninstallOptions): Promise<number> {
  const { layout } = ctx;
  const manager = packageManagerOf(layout.home);
  if (manager) {
    ctx.io.out(t(`cli.uninstall.${manager}`));
    return 0;
  }
  if (layout.kind === "npm") {
    ctx.io.out(t("cli.uninstall.npm"));
    return 0;
  }
  if (layout.kind !== "installed" || !layout.root) {
    ctx.io.out(t("cli.uninstall.dev"));
    return 0;
  }
  const root = layout.root;
  const paths = installPaths(root);
  // 安装目录得真像个安装目录才删（versions\ 里有带 ergo.json 的版本）
  if (!fs.existsSync(paths.versions) || !readVersionInfo(layout.home)) {
    ctx.io.err(t("cli.uninstall.notInstallDir", { dir: root }));
    return 1;
  }
  // 默认那份（数据目录是 ~/.ergo 或者服务管家里 ergo-daemon 登记的）和别的各份：这条命令在哪一份的文件夹里跑都一样
  const main = ctx.serviceId === DEFAULT_SERVICE_ID ? ctx : contextForInstance(ctx, { dir: defaultInstanceDir(ctx) });
  const instances = instanceContexts(main).slice(1);
  const instanceIds = new Set([DAEMON_SERVICE_ID, ...instances.map((c) => c.serviceId)]);
  const up = await managerUp(ctx);
  const others = up ? (svcSnapshot(ctx)?.services ?? []).filter((s) => !instanceIds.has(s.id) && ![...instanceIds].some((id) => s.id.startsWith(`${id}--`))).map((s) => s.id) : [];
  ctx.io.out(t("cli.uninstall.plan", { dir: root, bin: paths.bin }));
  if (instances.length > 0) {
    ctx.io.out(t("cli.uninstall.instances", { count: instances.length, n: instances.length }));
    for (const c of instances) ctx.io.out(t("cli.uninstall.instanceLine", { name: c.instanceName ?? c.serviceId, dir: c.dataDir }));
  }
  if (others.length > 0) ctx.io.out(t("cli.uninstall.otherServices", { services: others.join(", ") }));
  if (!options.yes) {
    const answer = (await ctx.io.ask(t("cli.uninstall.confirm"))).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      ctx.io.out(t("cli.uninstall.cancelled"));
      return 1;
    }
  }
  let deleteData = options.deleteData;
  if (deleteData === undefined) {
    const answer = options.yes ? "" : (await ctx.io.ask(t("cli.uninstall.askData", { data: main.dataDir, svc: ctx.svcDataDir }))).trim().toLowerCase();
    deleteData = answer === "y" || answer === "yes";
  }
  // 别的各份的文件夹：逐份问（默认留；--yes、--delete-data 都不替它们答）
  const deleteInstance = new Set<string>();
  if (!options.yes) {
    for (const c of instances) {
      const answer = (await ctx.io.ask(t("cli.uninstall.askInstanceData", { name: c.instanceName ?? c.serviceId, dir: c.dataDir }))).trim().toLowerCase();
      if (answer === "y" || answer === "yes") deleteInstance.add(c.serviceId);
    }
  }

  // 1. 停二狗（各份）、撤登记、停服务管家（它的程序就在要删的目录里）
  // 登记了的各份都拿掉（文件夹没了、标记对不上的也拿掉：上面没列它们，是因为不问它们的数据）
  const registered = registeredInstances(ctx.svcDataDir).filter((i) => i.id !== DAEMON_SERVICE_ID);
  if (up) {
    for (const i of registered) runLsm(ctx, ["stop", i.id], { capture: true });
    runLsm(main, ["stop", DAEMON_SERVICE_ID], { capture: true });
    ctx.io.out(t("cli.uninstall.daemonStopped"));
  }
  for (const i of registered) fs.rmSync(i.file, { force: true });
  fs.rmSync(svcPaths(main).daemonEntry, { force: true });
  if (up) {
    const stopped = await stopManager(ctx);
    if (!stopped) runLsm(ctx, ["reload"], { capture: true });
    ctx.io.out(stopped ? t("cli.uninstall.managerStopped") : t("cli.uninstall.managerStillUp", { pid: managerPidFromState(ctx) ?? "?" }));
  }
  // 2. 开机自启
  if (fs.existsSync(lsmScript(ctx))) removeAutostart(ctx, root);
  // 3. PATH
  if (removeFromUserPath(userPathStore(ctx.env), paths.bin)) ctx.io.out(t("cli.uninstall.pathRemoved", { bin: paths.bin }));
  // 4. 数据
  if (deleteData) {
    for (const dir of [main.dataDir, ctx.svcDataDir]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      ctx.io.out(t("cli.uninstall.dataDeleted", { dir }));
    }
  } else {
    ctx.io.out(t("cli.uninstall.dataKept", { data: main.dataDir, svc: ctx.svcDataDir }));
  }
  for (const c of instances) {
    // 只删真是这一份的文件夹（标记文件还在、登记 id 对得上）
    let mine = false;
    try {
      mine = readMarker(c.dataDir)?.serviceId === c.serviceId;
    } catch {
      mine = false;
    }
    if (deleteInstance.has(c.serviceId) && mine) {
      fs.rmSync(c.dataDir, { recursive: true, force: true, maxRetries: 3 });
      ctx.io.out(t("cli.uninstall.dataDeleted", { dir: c.dataDir }));
    } else {
      ctx.io.out(t("cli.uninstall.instanceKept", { name: c.instanceName ?? c.serviceId, dir: c.dataDir }));
    }
  }
  // 5. 安装目录：先撤 current 和联接（不碰它们指着的目录），剩下的等这条命令退出后删
  removeCurrent(root);
  try {
    for (const name of fs.readdirSync(paths.versions)) removeLink(path.join(paths.versions, name));
  } catch {
    // versions 没了
  }
  const pids = [process.pid, ...(ctx.env.ERGO_LAUNCHER && process.ppid ? [process.ppid] : [])];
  scheduleRemoval(root, options.waitForCleanup ? [] : pids, options.waitForCleanup ?? false);
  ctx.io.out(t("cli.uninstall.done", { dir: root }));
  return 0;
}
