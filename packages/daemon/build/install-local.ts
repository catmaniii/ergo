// 从源码装（318 号票）：开发者 git clone → npm ci → npm run build → npm run ergo:install；install.ps1 -FromSource 也走这两步。
//   npm run build            构建网页，把程序摆成 <仓库>/dist/ergo（转好的 JS；第三方包联接到仓库的 node_modules；Node 指向构建用的那个）
//   npm run ergo:install     摆一个完整的版本目录进 <安装目录>\versions\<版本>-src-<时间>（复制运行时要的第三方包和 node.exe），
//                            切过去、放好 bin\ergo.exe / ergo.cmd、加进用户 PATH
//   npm run ergo:install -- --link
//                            开发模式：versions\<版本>-link 联接到 <仓库>/dist/ergo，改了代码重新 npm run build 就生效（重启二狗）
// 开关：--install-dir <目录>、--no-switch（只摆版本目录，ergo update 用）、--no-path、--ref <标签或分支>（记进 ergo.json）、
//       --node-pointer（不复制 node.exe，写 node.path 指向构建用的 Node：-UseSystemNode）
import fs from "node:fs";
import path from "node:path";
import { currentVersionName, installPaths, readInstallState, switchCurrent, writeInstallState } from "../src/release/layout.ts";
import { addToUserPath, userPathStore } from "../src/release/user-path.ts";
import { compileLauncher, LAUNCHER_CMD, probeLauncher } from "./launcher.ts";
import { buildScratch } from "./node-dist.ts";
import { buildWeb, commitOf, INSTALL_SCRIPT } from "./release.ts";
import { stageVersion } from "./stage.ts";

/** 开发模式的程序目录（npm run build 摆的） */
export function devImageDir(repo: string): string {
  return path.join(repo, "dist", "ergo");
}

/** 编 ergo.exe 并试跑；不行回 undefined（只用 ergo.cmd） */
function launcher(scratch: string, log: (line: string) => void): string | undefined {
  const compiled = compileLauncher(path.join(scratch, "ergo.exe"));
  const probed = compiled.ok ? probeLauncher(compiled.exe, process.execPath, scratch) : compiled;
  if (!probed.ok) log(`不带 ergo.exe，只用 ergo.cmd：${probed.reason}`);
  return probed.ok ? probed.exe : undefined;
}

/** npm run build：构建网页、摆开发模式的程序目录 */
export function devBuild(repo: string, options: { skipWeb?: boolean; log?: (line: string) => void } = {}): string {
  const log = options.log ?? (() => {});
  if (!options.skipWeb) buildWeb(repo, log);
  const out = devImageDir(repo);
  const scratch = buildScratch("build");
  try {
    const exe = launcher(scratch, log);
    stageVersion({
      repo,
      out,
      kind: "link",
      node: { pointer: process.execPath, version: process.versions.node },
      nodeModules: "link",
      ...(exe ? { launcherExe: exe } : {}),
      ...(commitOf(repo) ? { commit: commitOf(repo)! } : {}),
      log,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  log(`程序摆好了：${out}`);
  return out;
}

export interface InstallFromRepoOptions {
  repo: string;
  root: string;
  link: boolean;
  switchTo: boolean;
  path: boolean;
  ref?: string;
  nodePointer?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** 时间戳（版本目录名用）：20261027213000 */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** bin\：启动器（版本目录里有 ergo.exe 就一起放） */
export function installBin(root: string, versionDir: string): string {
  const { bin } = installPaths(root);
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(fs.existsSync(path.join(versionDir, "ergo.cmd")) ? path.join(versionDir, "ergo.cmd") : LAUNCHER_CMD, path.join(bin, "ergo.cmd"));
  const exe = path.join(versionDir, "ergo.exe");
  if (fs.existsSync(exe)) {
    fs.copyFileSync(exe, path.join(bin, "ergo.exe"));
    return path.join(bin, "ergo.exe");
  }
  fs.rmSync(path.join(bin, "ergo.exe"), { force: true });
  return path.join(bin, "ergo.cmd");
}

/** npm run ergo:install：回装好的版本目录的名字 */
export function installFromRepo(options: InstallFromRepoOptions): string {
  const log = options.log ?? (() => {});
  const { repo, root } = options;
  const paths = installPaths(root);
  fs.mkdirSync(paths.versions, { recursive: true });
  const version = (JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string }).version;
  let name: string;
  if (options.link) {
    const image = devImageDir(repo);
    if (!fs.existsSync(path.join(image, "ergo.json"))) throw new Error(`还没构建：先 npm run build（没有 ${image}）`);
    name = `${version}-link`;
    const dir = path.join(paths.versions, name);
    try {
      fs.rmdirSync(dir);
    } catch {
      // 原来没有
    }
    fs.symlinkSync(image, dir, "junction");
    log(`开发模式：${dir} → ${image}`);
  } else {
    if (!fs.existsSync(path.join(repo, "packages", "web", "dist", "index.html"))) buildWeb(repo, log);
    name = `${version}-src-${stamp()}`;
    const dir = path.join(paths.versions, name);
    const partial = `${dir}.partial`;
    const scratch = buildScratch("install");
    try {
      const exe = launcher(scratch, log);
      stageVersion({
        repo,
        out: partial,
        kind: "source",
        node: options.nodePointer ? { pointer: process.execPath, version: process.versions.node } : { exe: process.execPath, version: process.versions.node },
        nodeModules: "copy",
        ...(exe ? { launcherExe: exe } : {}),
        ...(commitOf(repo) ? { commit: commitOf(repo)! } : {}),
        ...(options.ref ? { ref: options.ref } : {}),
        log,
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    fs.renameSync(partial, dir);
    log(`版本目录：${dir}`);
  }
  fs.writeFileSync(path.join(paths.versions, ".last-built"), name);
  // ergo update 更新源码装的要用安装脚本
  fs.copyFileSync(INSTALL_SCRIPT, path.join(root, "install.ps1"));
  if (!options.switchTo) return name;
  const before = readInstallState(root);
  const previous = currentVersionName(root);
  switchCurrent(root, name);
  writeInstallState(root, { ...before, ...(previous && previous !== name ? { previous } : {}), installedBy: options.link ? "npm run ergo:install -- --link" : "npm run ergo:install" });
  const ergo = installBin(root, path.join(paths.versions, name));
  log(`在用的版本：${name}；命令：${ergo}`);
  if (options.path) {
    if (addToUserPath(userPathStore(options.env), paths.bin)) log(`把 ${paths.bin} 加进了用户 PATH（新开的终端里就能用 ergo）`);
  } else {
    log(`没改 PATH：要用 ergo 就把 ${paths.bin} 加进 PATH，或者直接运行 ${ergo}`);
  }
  return name;
}
