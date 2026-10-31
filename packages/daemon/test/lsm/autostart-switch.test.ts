// 向导里的开机自启开关（347 号票）：显示现在开没开、能开能关，走 install-autostart / uninstall-autostart 同一条路（先过 cli/autostart.ts 那一关）。
// 这里永远用假任务（ERGO_AUTOSTART_TASK_FILE），绝不碰真的计划任务：开着和关着的动作都是写那个 JSON 文件。
// - 装好的：能开能关；任务指着这个安装的算开着，指着别处的（用的人自己装的服务管家）只显示、不让动；
// - 源码跑的：只显示（开发机上的任务不归它管）；
// - 注册失败：回 400 和原因，状态不变；没设假任务的测试进程里被那一关挡下，不起 lsm。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFakeTask, TASK_COMMAND_REFUSED, runTaskCommand } from "../../src/cli/autostart.ts";
import { RequestRejected } from "../../src/errors.ts";
import { createAutostartSwitch } from "../../src/lsm/autostart-switch.ts";
import type { InstallLayout } from "../../src/release/layout.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function rig(kind: InstallLayout["kind"] = "installed") {
  const dir = makeTempDir("ergo-autostart-");
  const root = path.join(dir, "ergo");
  const home = path.join(root, "versions", "0.4.0");
  const appDir = path.join(home, "app");
  fs.mkdirSync(path.join(appDir, "packages", "supervisor", "bin"), { recursive: true });
  const svcDataDir = path.join(dir, "svc");
  const taskFile = path.join(dir, "task.json");
  const layout: InstallLayout = kind === "installed" ? { kind, root, home, appDir, node: path.join(home, "node", "node.exe") } : { kind, home: appDir, appDir, node: process.execPath };
  const lines: string[] = [];
  const service = createAutostartSwitch({ env: { ERGO_AUTOSTART_TASK_FILE: taskFile, LSM_DATA_DIR: svcDataDir, ERGO_SVC_PORT: "17420" }, layout, svcDataDir, log: (line) => lines.push(line) });
  return { dir, root, home, taskFile, svcDataDir, service, lines };
}

const writeTask = (file: string, action: string) => fs.writeFileSync(file, JSON.stringify({ action }));

describe("开机自启开关", () => {
  it("装好的、还没有任务：写关着；打开注册任务（带服务管家的数据目录）；再关撤掉", async () => {
    const t = rig();
    expect(await t.service.view()).toEqual({ state: "off", managerUrl: "http://127.0.0.1:17420" });

    expect(await t.service.set(true)).toMatchObject({ state: "on" });
    const task = readFakeTask(t.taskFile);
    expect(task.calls).toEqual(["install-autostart"]);
    expect(task.action).toContain(t.svcDataDir);
    expect(task.action).toContain(path.join(t.home, "app", "packages", "supervisor", "bin", "lsm.mjs"));

    // 已经开着：再开一次什么都不做
    expect(await t.service.set(true)).toMatchObject({ state: "on" });
    expect(readFakeTask(t.taskFile).calls).toEqual(["install-autostart"]);

    expect(await t.service.set(false)).toMatchObject({ state: "off" });
    expect(readFakeTask(t.taskFile).calls).toEqual(["install-autostart", "uninstall-autostart"]);
    expect(t.lines.join("\n")).toContain("uninstall-autostart");
  });

  it("任务指着这个安装里的旧版本：算开着，能关", async () => {
    const t = rig();
    writeTask(t.taskFile, `conhost.exe --headless "${path.join(t.root, "versions", "0.3.0", "node", "node.exe")}" "${path.join(t.root, "versions", "0.3.0", "app", "packages", "supervisor", "bin", "lsm.mjs")}" serve --lifeline`);
    const view = await t.service.view();
    expect(view.state).toBe("on");
    expect(view.cannotChange).toBeUndefined();
    expect(await t.service.set(false)).toMatchObject({ state: "off" });
  });

  it("任务指着别处（用的人自己装的服务管家）：只显示，开关都不动它", async () => {
    const t = rig();
    const action = 'conhost.exe --headless "D:\\tools\\node.exe" "D:\\my\\supervisor\\bin\\lsm.mjs" serve --lifeline';
    writeTask(t.taskFile, action);
    const view = await t.service.view();
    expect(view.state).toBe("elsewhere");
    expect(view.cannotChange).toContain("别处");
    await expect(t.service.set(false)).rejects.toBeInstanceOf(RequestRejected);
    await expect(t.service.set(true)).rejects.toBeInstanceOf(RequestRejected);
    expect(readFakeTask(t.taskFile)).toEqual({ action });
  });

  it("源码跑的：只显示，不能从这里开关（开发机上的任务不归它管）", async () => {
    const t = rig("dev");
    const off = await t.service.view();
    expect(off.state).toBe("off");
    expect(off.cannotChange).toContain("ergo svc");
    await expect(t.service.set(true)).rejects.toBeInstanceOf(RequestRejected);
    expect(readFakeTask(t.taskFile).calls).toBeUndefined();
  });

  it("注册失败：回原因，还是关着", async () => {
    const t = rig();
    fs.writeFileSync(t.taskFile, JSON.stringify({ failInstall: true }));
    await expect(t.service.set(true)).rejects.toThrow(/fake task refused/);
    expect((await t.service.view()).state).toBe("off");
  });

  it("测试进程里没设假任务：动任务的命令被那一关挡下，不起 lsm", async () => {
    const r = await runTaskCommand({}, "uninstall-autostart", { node: "not-a-real-node.exe", script: "nope.mjs", dataDir: "nope" });
    expect(r.code).toBe(TASK_COMMAND_REFUSED);
  });
});
