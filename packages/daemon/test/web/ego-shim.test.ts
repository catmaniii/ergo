// 466 返修（"甲"）：agent 的 PATH 上那个薄的 ego-browser（web/ego-shim.ts）。
// - 写哪几个文件、内容没变不重写；不是 Windows 不写（照旧放 ego 的目录）；
// - runEgoShim：要连 ego lite 的命令先确保它开着（假的 ensure 依赖），开不成就说明原因、不往下跑；只看帮助、版本的直接往下；
//   参数、标准输入、退出码原样交给"真的 ego-browser"（这里用本机的 node.exe 充当，不碰真的 ego lite）；
// - Windows 上真跑两个脚本：Git Bash 跑 sh 的那个、cmd 跑 .cmd 的那个（有环境变量、没环境变量用写在里面的），参数原样到 node.exe。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EgoOpenDeps, EgoOpenResult } from "../../src/web/ego-open.ts";
import { EGO_SHIM_ENTRY, egoShimFiles, prepareEgoShim, readEgoShimTarget, runEgoShim } from "../../src/web/ego-shim.ts";
import { gitBash } from "../helpers/git-bash.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NODE = process.execPath;
/** 全是 ASCII（.cmd 按控制台的代码页读，只写 ASCII） */
const ascii = (text: string) => [...text].every((ch) => ch.charCodeAt(0) < 0x80);

/** 写一个 shim 目录，"真的 ego-browser"是 target（默认本机的 node.exe） */
function shimDir(target = NODE): string {
  const dir = makeTempDir("ergo-ego-shim-");
  const shim = prepareEgoShim({ dir, egoBrowser: target, platform: "win32", log: () => {} });
  expect(shim?.dir).toBe(dir);
  return dir;
}

/** 假的 ensure 依赖：回一个定好的结果（经 ensureEgoOpen 的判断走到它） */
function openDeps(result: EgoOpenResult["kind"] | "no-app", calls: string[]): () => EgoOpenDeps {
  return () => ({
    running: () => result === "open",
    bootstrapListening: () => false,
    shellRunning: () => true,
    appPath: result === "no-app" ? undefined : "C:\\fake\\ego.exe",
    launch: async (app) => void calls.push(app),
    claim: () => () => {},
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 0,
  });
}

describe("shim 目录里的文件", () => {
  it("sh（Git Bash）、.cmd（PowerShell、cmd）、target.json；sh 里路径换成正斜杠、单引号包好；.cmd 先认环境变量，路径全是 ASCII 才写兜底", () => {
    const files = egoShimFiles({ dir: "C:\\d\\ego-browser", egoBrowser: "C:\\e\\ego-browser.exe", node: "C:\\n\\node.exe", entry: "C:\\s\\it's-main.ts" });
    expect(Object.keys(files).toSorted()).toEqual(["ego-browser", "ego-browser.cmd", "target.json"]);
    expect(files["ego-browser"]).toContain(`exec 'C:/n/node.exe' 'C:/s/it'\\''s-main.ts' 'C:/d/ego-browser' "$@"`);
    expect(files["ego-browser"]!.startsWith("#!/bin/sh\n")).toBe(true);
    const cmd = files["ego-browser.cmd"]!;
    expect(ascii(cmd)).toBe(true);
    expect(cmd).toContain("\r\n");
    expect(cmd).toContain(`if not defined ERGO_EGO_SHIM_NODE set "ERGO_EGO_SHIM_NODE=C:\\n\\node.exe"`);
    expect(cmd).toContain(`"%ERGO_EGO_SHIM_NODE%" "%ERGO_EGO_SHIM_ENTRY%" "%~dp0." %*`);
    expect(JSON.parse(files["target.json"]!)).toEqual({ format: 1, egoBrowser: "C:\\e\\ego-browser.exe" });
    // 路径里有中文：.cmd 只认环境变量（按控制台代码页读，写进去会读错）
    const chinese = egoShimFiles({ dir: "C:\\d", egoBrowser: "C:\\e\\ego-browser.exe", node: "C:\\用户\\node.exe", entry: "C:\\s\\main.ts" })["ego-browser.cmd"]!;
    expect(ascii(chinese)).toBe(true);
    expect(chinese).not.toContain("set \"ERGO_EGO_SHIM_NODE=");
    expect(chinese).toContain("ERGO_EGO_SHIM_NODE is not set");
  });

  it("写好了回目录和环境变量；内容没变不重写；ego-browser 换了位置就改写 target.json；不是 Windows 不写", () => {
    const dir = makeTempDir("ergo-ego-shim-");
    const first = prepareEgoShim({ dir, egoBrowser: "C:\\e\\ego-browser.exe", platform: "win32", log: () => {} });
    expect(first).toEqual({ dir, env: { ERGO_EGO_SHIM_NODE: NODE, ERGO_EGO_SHIM_ENTRY: EGO_SHIM_ENTRY } });
    const stamp = (name: string) => fs.statSync(path.join(dir, name)).mtimeMs;
    const before = stamp("ego-browser.cmd");
    fs.utimesSync(path.join(dir, "ego-browser.cmd"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    prepareEgoShim({ dir, egoBrowser: "C:\\e\\ego-browser.exe", platform: "win32", log: () => {} });
    expect(stamp("ego-browser.cmd")).toBeLessThan(before);
    prepareEgoShim({ dir, egoBrowser: "C:\\f\\ego-browser.exe", platform: "win32", log: () => {} });
    expect(readEgoShimTarget(dir)?.egoBrowser).toBe("C:\\f\\ego-browser.exe");
    expect(stamp("ego-browser.cmd")).toBeLessThan(before);
    const other = makeTempDir("ergo-ego-shim-");
    expect(prepareEgoShim({ dir: other, egoBrowser: "/u/.local/bin/ego-browser", platform: "darwin", log: () => {} })).toBeUndefined();
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("写不了（目录的位置被一个文件占着）：记日志、回 undefined（调用方照旧放 ego 的目录）", () => {
    const parent = makeTempDir("ergo-ego-shim-");
    const blocked = path.join(parent, "ego-browser");
    fs.writeFileSync(blocked, "x");
    const log: string[] = [];
    expect(prepareEgoShim({ dir: blocked, egoBrowser: "C:\\e\\ego-browser.exe", platform: "win32", log: (l) => log.push(l) })).toBeUndefined();
    expect(log[0]).toContain("写不了 ego-browser 的 shim");
  });
});

describe("shim 做的事（runEgoShim）", () => {
  it("要连 ego lite 的命令：开着直接往下；参数原样、退出码原样带回", async () => {
    const dir = shimDir();
    const calls: string[] = [];
    const said: string[] = [];
    const code = await runEgoShim({ dir, args: ["-e", "process.exit(3)"], platform: "win32", openDeps: openDeps("open", calls), say: (l) => said.push(l) });
    expect(code).toBe(3);
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });

  it("没开着：替用户打开、告诉 agent 一声，再往下", async () => {
    const dir = shimDir();
    const calls: string[] = [];
    const said: string[] = [];
    // timeoutMs 0、launch 之后主进程"在"：按 settled 算开好了
    const deps = (): EgoOpenDeps => {
      let launched = false;
      return { ...openDeps("opened", calls)(), running: () => launched, launch: async (app) => void (calls.push(app), (launched = true)) };
    };
    const code = await runEgoShim({ dir, args: ["-e", "process.exit(0)"], platform: "win32", openDeps: deps, say: (l) => said.push(l) });
    expect(code).toBe(0);
    expect(calls).toEqual(["C:\\fake\\ego.exe"]);
    expect(said).toEqual(["ego lite 没开着，二狗已经替用户打开了（和用户自己打开的一样，二狗重启也不会关掉它）；还没确认它准备好接命令，要是这条失败了，等几秒再跑一次。"]);
  });

  it("开不成：说明原因、请用户自己打开，回 1，不往下跑（真的 ego-browser 不会被起来）", async () => {
    const dir = shimDir();
    const marker = path.join(dir, "ran.txt");
    const said: string[] = [];
    const code = await runEgoShim({ dir, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`], platform: "win32", openDeps: openDeps("no-app", []), say: (l) => said.push(l) });
    expect(code).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
    expect(said).toEqual(["ego lite 没开着，二狗也没找到它的主程序 ego.exe，替用户打开不了。请用户自己打开电脑上的 ego lite，好了回你一句，再跑一次这条命令。"]);
  });

  it("只看帮助、版本的：不管 ego lite 开没开，直接往下", async () => {
    const dir = shimDir();
    let asked = false;
    const code = await runEgoShim({
      dir,
      args: ["--version"],
      platform: "win32",
      openDeps: () => {
        asked = true;
        throw new Error("不该问");
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe(false);
  });

  it("真的 ego-browser 不在了（卸载、升级中）、target.json 没有：说一句、回 127，不乱找别的", async () => {
    const dir = shimDir(path.join(makeTempDir("ergo-ego-gone-"), "ego-browser.exe"));
    const said: string[] = [];
    expect(await runEgoShim({ dir, args: ["nodejs"], platform: "win32", openDeps: openDeps("open", []), say: (l) => said.push(l) })).toBe(127);
    expect(said[0]).toMatch(/^找不到 ego-browser（.+ego-browser\.exe 不在了）：ego lite 可能刚卸载或者正在升级/);
    const empty = makeTempDir("ergo-ego-shim-");
    expect(await runEgoShim({ dir: empty, args: ["nodejs"], platform: "win32", say: (l) => said.push(l) })).toBe(127);
    expect(said[1]).toMatch(/^找不到 ego-browser：/);
  });
});

describe.runIf(process.platform === "win32")("Windows 上真跑两个脚本（真的 ego-browser 由 node.exe 充当，只跑 --version、-v，不碰 ego lite）", () => {
  it("Git Bash：PATH 最前面是 shim 目录时 ego-browser 找到的是 sh 的那个，参数原样到 node.exe", () => {
    const bash = gitBash;
    if (!bash) return;
    const dir = shimDir();
    const out = execFileSync(bash, ["-c", 'command -v ego-browser; ego-browser --version'], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const [where, version] = out.trim().split(/\r?\n/);
    expect(where).toMatch(/\/ego-browser$/);
    expect(version).toBe(process.version);
  });

  it("cmd：.cmd 认环境变量；没有环境变量时用写在里面的路径（路径全是 ASCII 时）；退出码原样", () => {
    const dir = shimDir();
    const shim = prepareEgoShim({ dir, egoBrowser: NODE, platform: "win32", log: () => {} })!;
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "ego-browser", "-v"], { encoding: "utf8", windowsHide: true, env: { ...env, PATH: `${dir}${path.delimiter}${env.PATH ?? ""}` } });
    const withEnv = run({ ...process.env, ...shim.env });
    expect(withEnv.stdout.trim()).toBe(process.version);
    expect(withEnv.status).toBe(0);
    const fallback = ascii(NODE) && ascii(EGO_SHIM_ENTRY);
    const bare = run(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ERGO_EGO_"))));
    const seen = { status: bare.status, out: bare.stdout.trim(), unset: bare.stderr.includes("ERGO_EGO_SHIM_NODE is not set") };
    expect(seen).toEqual(fallback ? { status: 0, out: process.version, unset: false } : { status: 1, out: "", unset: true });
    // 真的 ego-browser 不在了：shim 的退出码 127 经 .cmd 原样回来
    const gone = shimDir(path.join(makeTempDir("ergo-ego-gone-"), "ego-browser.exe"));
    const missing = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "ego-browser", "--version"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...shim.env, PATH: `${gone}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("[二狗] 找不到 ego-browser");
  });
});
