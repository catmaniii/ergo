// 页面上写的恢复、定时命令：按这台电脑的装法现算。一行命令（和 npm）装的有 ergo 命令，自己 git clone 的在代码目录里跑；
// 写出来的路径要真指得到东西（版本目录里是转好的 .js，仓库里是 .ts）。
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { backupCommands, installLayoutOfDaemon } from "../../src/backup/commands.ts";
import type { InstallLayout } from "../../src/release/layout.ts";

const INSTALLED: InstallLayout = { kind: "installed", root: "C:\\Users\\me\\AppData\\Local\\Programs\\ergo", home: "C:\\Users\\me\\AppData\\Local\\Programs\\ergo\\versions\\0.5.0", appDir: "C:\\Users\\me\\AppData\\Local\\Programs\\ergo\\versions\\0.5.0\\app", node: "C:\\Users\\me\\AppData\\Local\\Programs\\ergo\\versions\\0.5.0\\node\\node.exe" };
const DEV: InstallLayout = { kind: "dev", home: "D:\\apps\\ergo", appDir: "D:\\apps\\ergo", node: "D:\\apps\\node22\\node.exe" };
const NPM: InstallLayout = { kind: "npm", home: "C:\\npm\\ergo-ai", appDir: "C:\\npm\\ergo-ai", node: "C:\\node\\node.exe" };

const commandsOf = (view: ReturnType<typeof backupCommands>) => view.restore.map((s) => s.command);

describe("按装法写命令", () => {
  it("一行命令装的：ergo stop、ergo restore、ergo start；定时调 ergo backup --scheduled；没有 lsm.mjs、npm、版本目录的路径", () => {
    const view = backupCommands({ layout: INSTALLED, dataDir: "C:\\Users\\me\\.ergo", customDataDir: false, date: "2026-10-15", hasSync: true });
    expect(view.install).toBe("ergo");
    expect(view.scheduled).toBe("ergo backup --scheduled");
    expect(commandsOf(view)).toEqual(["ergo stop", "ergo restore --list", "ergo restore 2026-10-15", "ergo restore 2026-10-15 --from sync", "ergo start"]);
    expect(JSON.stringify(view)).not.toMatch(/lsm\.mjs|npm run|versions/);
  });

  it("npm 装的也有 ergo 命令，和一行命令的一样", () => {
    const view = backupCommands({ layout: NPM, dataDir: "C:\\Users\\me\\.ergo", customDataDir: false, date: "2026-10-15", hasSync: false });
    expect(view.install).toBe("ergo");
    expect(commandsOf(view)).toEqual(["ergo stop", "ergo restore --list", "ergo restore 2026-10-15", "ergo start"]);
  });

  it("自己 git clone 的：经代码目录里的服务管家停、起，用同一份 Node 跑 restore.ts；定时在代码目录里 npm run backup -- --scheduled；路径都带引号能直接贴进 PowerShell", () => {
    const view = backupCommands({ layout: DEV, dataDir: "C:\\Users\\me\\.ergo", customDataDir: false, date: "2026-10-15", hasSync: true });
    expect(view.install).toBe("source");
    expect(view.scheduled).toBe("cd 'D:\\apps\\ergo'; npm run backup -- --scheduled");
    expect(commandsOf(view)).toEqual([
      "& 'D:\\apps\\node22\\node.exe' 'D:\\apps\\ergo\\packages\\supervisor\\bin\\lsm.mjs' stop ergo-daemon",
      "& 'D:\\apps\\node22\\node.exe' 'D:\\apps\\ergo\\packages\\daemon\\src\\restore.ts' --list",
      "& 'D:\\apps\\node22\\node.exe' 'D:\\apps\\ergo\\packages\\daemon\\src\\restore.ts' 2026-10-15",
      "& 'D:\\apps\\node22\\node.exe' 'D:\\apps\\ergo\\packages\\daemon\\src\\restore.ts' 2026-10-15 --from sync",
      "& 'D:\\apps\\node22\\node.exe' 'D:\\apps\\ergo\\packages\\supervisor\\bin\\lsm.mjs' start ergo-daemon",
    ]);
  });

  it("数据目录不是默认的：第一步设好环境变量，定时那条也带上；路径里的单引号写对", () => {
    const installed = backupCommands({ layout: INSTALLED, dataDir: "D:\\ergo's data", customDataDir: true, date: "2026-10-15", hasSync: false });
    expect(commandsOf(installed)[0]).toBe("$env:ERGO_DATA_DIR = 'D:\\ergo''s data'");
    expect(commandsOf(installed)[1]).toBe("ergo stop");
    expect(installed.scheduled).toBe("$env:ERGO_DATA_DIR = 'D:\\ergo''s data'; ergo backup --scheduled");
    const dev = backupCommands({ layout: DEV, dataDir: "D:\\data", customDataDir: true, date: "2026-10-15", hasSync: false });
    expect(dev.scheduled).toBe("$env:ERGO_DATA_DIR = 'D:\\data'; cd 'D:\\apps\\ergo'; npm run backup -- --scheduled");
  });

  it("还没有快照：日期写成占位的 YYYY-MM-DD；每一步都有一句说明", () => {
    const view = backupCommands({ layout: INSTALLED, dataDir: "x", customDataDir: false, hasSync: false });
    expect(commandsOf(view)).toContain("ergo restore YYYY-MM-DD");
    for (const step of view.restore) expect(step.note).not.toBe("");
  });

  it("守护进程按自己的位置认装法：仓库里跑（这个测试）是 git clone 那种；只看位置，不信环境变量 ERGO_HOME", () => {
    vi.stubEnv("ERGO_HOME", INSTALLED.home);
    const layout = installLayoutOfDaemon();
    vi.unstubAllEnvs();
    expect(layout.kind).toBe("dev");
    expect(path.isAbsolute(layout.appDir)).toBe(true);
    expect(layout.node).toBe(process.execPath);
  });
});
