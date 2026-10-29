// ergo uninstall（318 号票）：停二狗、撤服务管家里的登记、撤开机自启、撤 PATH、删安装目录；问要不要删数据（默认不删）。
// 数据（~/.ergo、服务管家的 %LOCALAPPDATA%\ergo\supervisor）只在用的人说要删时才删。
// 安装目录里正跑着这条命令自己（node.exe、ergo.exe），删不了：交给一个等它们退出再删的小脚本（cmd，跑完把自己也删掉）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "@ergo/protocol";
import { installPaths, readVersionInfo, removeCurrent, removeLink } from "../release/layout.ts";
import { removeFromUserPath, userPathStore } from "../release/user-path.ts";
import type { CliContext } from "./context.ts";
import { packageManagerOf } from "./versions.ts";
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
  const q = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$t = Get-ScheduledTask -TaskName 'LocalServiceManager' -ErrorAction SilentlyContinue; if ($t) { ($t.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)\" }) -join ' | ' }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const action = (q.stdout ?? "").trim();
  if (!action) return;
  if (!action.toLowerCase().includes(root.toLowerCase())) {
    ctx.io.out(t("cli.uninstall.autostartElsewhere"));
    return;
  }
  runLsm(ctx, ["uninstall-autostart"], { capture: true });
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
  const up = await managerUp(ctx);
  const others = up ? (svcSnapshot(ctx)?.services ?? []).filter((s) => s.id !== DAEMON_SERVICE_ID).map((s) => s.id) : [];
  ctx.io.out(t("cli.uninstall.plan", { dir: root, bin: paths.bin }));
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
    const answer = options.yes ? "" : (await ctx.io.ask(t("cli.uninstall.askData", { data: ctx.dataDir, svc: ctx.svcDataDir }))).trim().toLowerCase();
    deleteData = answer === "y" || answer === "yes";
  }

  // 1. 停二狗、撤登记、停服务管家（它的程序就在要删的目录里）
  if (up) {
    runLsm(ctx, ["stop", DAEMON_SERVICE_ID], { capture: true });
    ctx.io.out(t("cli.uninstall.daemonStopped"));
  }
  fs.rmSync(svcPaths(ctx).daemonEntry, { force: true });
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
    for (const dir of [ctx.dataDir, ctx.svcDataDir]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      ctx.io.out(t("cli.uninstall.dataDeleted", { dir }));
    }
  } else {
    ctx.io.out(t("cli.uninstall.dataKept", { data: ctx.dataDir, svc: ctx.svcDataDir }));
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
