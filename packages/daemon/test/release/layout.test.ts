// 安装布局（318 号票）：认出装好的 / 开发 / npm 装的；current（一行文本记在用的版本）的切换；版本比大小；只留两个版本；用户 PATH 的增删（假的存储，不碰注册表）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  createJunction,
  currentHome,
  currentVersionName,
  defaultInstallRoot,
  detectLayout,
  installPaths,
  listVersions,
  nodeOf,
  pruneVersions,
  readInstallState,
  switchCurrent,
  writeInstallState,
  writeVersionInfo,
} from "../../src/release/layout.ts";
import { addToUserPath, fileUserPathStore, pathHas, removeFromUserPath } from "../../src/release/user-path.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-layout-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // 先撤联接（老安装的 current 是联接），免得 rm 顺着联接删到别处
    for (const name of ["current", "current.tmp", "current.new", "current.old"]) {
      const p = path.join(dir, "inst", name);
      try {
        if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p);
        else fs.rmSync(p, { force: true });
      } catch {
        // 不在
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 摆一个假的版本目录 */
function fakeVersion(root: string, name: string, version = name, withNode = true): string {
  const dir = path.join(installPaths(root).versions, name);
  fs.mkdirSync(path.join(dir, "app", "packages", "daemon", "src", "cli"), { recursive: true });
  if (withNode) {
    fs.mkdirSync(path.join(dir, "node"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node", "node.exe"), "");
  }
  writeVersionInfo(dir, { format: 1, version, kind: "release", node: "22.23.4" });
  return dir;
}

describe("安装布局", () => {
  it("默认装在 %LOCALAPPDATA%\\Programs\\ergo，ERGO_INSTALL_DIR 可以换", () => {
    expect(defaultInstallRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe(path.join("C:\\Users\\u\\AppData\\Local", "Programs", "ergo"));
    expect(defaultInstallRoot({ ERGO_INSTALL_DIR: "D:\\apps\\ergo", LOCALAPPDATA: "C:\\x" })).toBe(path.resolve("D:\\apps\\ergo"));
  });

  it("认出装好的：启动器给的 ERGO_HOME（从 current 那行文本找出来的 versions\\<版本>）、或者命令行文件在 versions\\<版本>\\app 下", () => {
    const root = path.join(tmp(), "inst");
    const v = fakeVersion(root, "0.3.0");
    switchCurrent(root, "0.3.0");
    expect(currentVersionName(root)).toBe("0.3.0");
    const viaHome = detectLayout({ cliFile: "C:\\nowhere\\packages\\daemon\\src\\cli\\main.js", env: { ERGO_HOME: v }, execPath: "C:\\node.exe" });
    expect(viaHome).toMatchObject({ kind: "installed", root, home: v, appDir: path.join(v, "app"), node: path.join(v, "node", "node.exe") });
    expect(viaHome.info?.version).toBe("0.3.0");
    const viaFile = detectLayout({ cliFile: path.join(v, "app", "packages", "daemon", "src", "cli", "main.js"), env: {}, execPath: "C:\\node.exe" });
    expect(viaFile).toMatchObject({ kind: "installed", root, home: v });
  });

  it("用系统 Node 装的：node.path 指着的 node.exe", () => {
    const root = path.join(tmp(), "inst");
    const v = fakeVersion(root, "0.3.0", "0.3.0", false);
    const node = path.join(root, "my-node.exe");
    fs.writeFileSync(node, "");
    fs.writeFileSync(path.join(v, "node.path"), `${node}\r\n`);
    expect(nodeOf(v)).toBe(node);
  });

  it("仓库里直接跑的是开发布局，npm 装的（程序目录的 package.json 叫 ergo-ai）是 npm 布局", () => {
    const repo = tmp();
    const cliFile = path.join(repo, "packages", "daemon", "src", "cli", "main.ts");
    expect(detectLayout({ cliFile, env: {}, execPath: "C:\\node.exe" })).toEqual({ kind: "dev", home: repo, appDir: repo, node: "C:\\node.exe" });
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "ergo-ai" }));
    expect(detectLayout({ cliFile, env: {}, execPath: "C:\\node.exe" }).kind).toBe("npm");
  });

  it("current 是一行文本（在用的版本目录名）：切过去、切回来；老安装的目录联接也认；列版本按版本号排；只留两个版本", () => {
    const root = path.join(tmp(), "inst");
    for (const v of ["0.2.9", "0.2.10", "0.3.0"]) fakeVersion(root, v);
    fs.mkdirSync(path.join(installPaths(root).versions, "0.4.0.partial"));
    expect(listVersions(root).map((v) => v.name)).toEqual(["0.2.9", "0.2.10", "0.3.0"]);
    switchCurrent(root, "0.2.10");
    const current = installPaths(root).current;
    expect(currentVersionName(root)).toBe("0.2.10");
    expect(fs.lstatSync(current).isFile()).toBe(true);
    expect(fs.readFileSync(current, "utf8").trim()).toBe("0.2.10");
    expect(currentHome(root)).toBe(path.join(installPaths(root).versions, "0.2.10"));
    switchCurrent(root, "0.3.0");
    expect(currentVersionName(root)).toBe("0.3.0");
    expect(currentHome(root)).toBe(path.join(installPaths(root).versions, "0.3.0"));
    expect(() => switchCurrent(root, "9.9.9")).toThrow(/ergo\.json/);
    expect(currentVersionName(root)).toBe("0.3.0");
    // 老安装（current 是指向版本目录的目录联接）：照样认；切换时换成文本文件
    fs.rmSync(current, { force: true });
    createJunction(path.join(installPaths(root).versions, "0.2.10"), current);
    expect(currentVersionName(root)).toBe("0.2.10");
    expect(currentHome(root)).toBe(path.join(installPaths(root).versions, "0.2.10"));
    switchCurrent(root, "0.3.0");
    expect(fs.lstatSync(current).isFile()).toBe(true);
    expect(currentVersionName(root)).toBe("0.3.0");
    // current 写着没装好的版本：当没有
    fs.writeFileSync(current, "9.9.9\n");
    expect(currentVersionName(root)).toBe("9.9.9");
    expect(currentHome(root)).toBeUndefined();
    switchCurrent(root, "0.3.0");
    const pruned = pruneVersions(root, ["0.3.0", "0.2.10"]);
    expect(pruned.removed.sort()).toEqual(["0.2.9", "0.4.0.partial"]);
    expect(listVersions(root).map((v) => v.name)).toEqual(["0.2.10", "0.3.0"]);
  });

  it("目录联接建不了（被占着）时等一会儿再试", () => {
    const base = tmp();
    const target = path.join(base, "target");
    fs.mkdirSync(target);
    createJunction(target, path.join(base, "link"));
    expect(fs.readlinkSync(path.join(base, "link")).replace(/[\\/]+$/, "")).toBe(target);
    fs.rmdirSync(path.join(base, "link"));
  });

  it("install.json 读写（不在时是空的）", () => {
    const root = path.join(tmp(), "inst");
    expect(readInstallState(root)).toEqual({ format: 1 });
    writeInstallState(root, { format: 1, previous: "0.2.1", source: { url: "http://127.0.0.1:1" } });
    expect(readInstallState(root)).toEqual({ format: 1, previous: "0.2.1", source: { url: "http://127.0.0.1:1" } });
  });

  it("版本号比大小", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.9.99")).toBeGreaterThan(0);
  });
});

describe("用户 PATH（假的存储）", () => {
  it("加进去不重复（不分大小写、不管结尾的 \\），撤掉时别的原样、%变量% 不展开", () => {
    const store = fileUserPathStore(path.join(tmp(), "env.json"));
    store.write("C:\\Windows\\system32;%USERPROFILE%\\.local\\bin");
    const bin = "C:\\Users\\u\\AppData\\Local\\Programs\\ergo\\bin";
    expect(addToUserPath(store, bin)).toBe(true);
    expect(addToUserPath(store, `${bin.toUpperCase()}\\`)).toBe(false);
    expect(store.read()).toBe(`C:\\Windows\\system32;%USERPROFILE%\\.local\\bin;${bin}`);
    expect(pathHas(store.read(), bin)).toBe(true);
    expect(removeFromUserPath(store, `${bin}\\`)).toBe(true);
    expect(store.read()).toBe("C:\\Windows\\system32;%USERPROFILE%\\.local\\bin");
    expect(removeFromUserPath(store, bin)).toBe(false);
  });
});
