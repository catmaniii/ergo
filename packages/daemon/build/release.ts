// 打发布包（318 号票，npm run release）：安装包和源码安装共用这一套（stage.ts），发版用的 zip 就是它在 GitHub Actions 上打出来的。
//   1. 构建网页（vite）；
//   2. 拿到要带的 Node（node-dist.ts：本机的目录 / 官方 zip / 下载并核对 SHASUMS256.txt）；
//   3. 编 ergo.exe（编不了、跑不起来就只带 ergo.cmd）；
//   4. 摆版本目录（stage.ts：转好的 JS、运行时要的第三方包、网页、服务管家、Node、许可证清单）；
//   5. 给了发布钥匙（--sign-key）就给组件清单签名（manifest.json.minisig），把公钥写进程序（release-key.pub）；
//   6. 打成 ergo-<版本>-win-x64.zip，写 SHA256SUMS（给了钥匙再签 SHA256SUMS.minisig）、latest.json；
//   7. 带上填好公钥的 install.ps1、npm 的两个包（ergo-ai：给有 Node 的人 npm i -g；ergo-ai-win32-x64：装着发布包，npmmirror 会同步，国内快）、
//      winget / Scoop 清单草稿（不提交）。
// 真发到 npm、GitHub 之前要问用户（318 号票）；这里只打包，不发。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256File } from "../src/components/downloader.ts";
import { formatSums, type ReleaseIndex } from "../src/release/fetch.ts";
import { formatPublicKey, type MinisignSecretKey, parseSecretKey, sign } from "../src/release/minisign.ts";
import { ZipWriter } from "../src/release/zip.ts";
import { compileLauncher, probeLauncher } from "./launcher.ts";
import { buildScratch, obtainNode, TESTED_NODE_VERSIONS } from "./node-dist.ts";
import { stageVersion } from "./stage.ts";

export const INSTALL_SCRIPT = path.resolve(import.meta.dirname, "..", "installer", "install.ps1");
export const PACKAGING_DIR = path.resolve(import.meta.dirname, "..", "installer", "packaging");
/** npm 上的包名（用户 2026-10-26 暂定 ergo-ai，命令照样叫 ergo） */
export const NPM_PACKAGE = "ergo-ai";
export const NPM_PLATFORM_PACKAGE = "ergo-ai-win32-x64";

export interface ReleaseOptions {
  repo: string;
  /** 输出目录（默认 <仓库>/dist/release） */
  out: string;
  /** 不给是根 package.json 的 version */
  version?: string;
  /** --node：本机的 Node 目录或官方 zip；不给就下载 */
  node?: string;
  nodeVersion?: string;
  nodeDist?: string;
  /** 发布钥匙（minisign 私钥文件的内容）；不给就不签（只能自己 -AllowUnsigned 装） */
  signKey?: { text: string; password?: string };
  /** 网页已经构建好了，不再构建 */
  skipWeb?: boolean;
  /** 不编 ergo.exe（只带 ergo.cmd） */
  noLauncher?: boolean;
  /** 不打 npm 包 */
  noNpm?: boolean;
  log?: (line: string) => void;
}

export interface ReleaseResult {
  version: string;
  zip: string;
  sums: string;
  signature?: string;
  index: ReleaseIndex;
  stage: string;
  launcher: "exe" | "cmd";
  launcherNote?: string;
  npm?: { app: string; platform: string };
}

export function commitOf(repo: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** 构建网页（packages/web 的 vite build） */
export function buildWeb(repo: string, log: (line: string) => void): void {
  log("构建网页（vite build）");
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build"], { cwd: path.join(repo, "packages", "web"), stdio: "inherit", windowsHide: true });
  if (r.status !== 0) throw new Error(`网页构建失败（退出码 ${r.status}）`);
}

/** 把一个目录整个打进 zip（包里的路径相对 dir，用 /） */
export function zipDirectory(dir: string, zipFile: string): number {
  const w = new ZipWriter(zipFile);
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p, childRel);
      else if (entry.isFile()) w.addFile(childRel, p);
    }
  };
  walk(dir, "");
  const count = w.count;
  w.close();
  return count;
}

/** 安装脚本：把公钥填进 $ReleasePublicKey = '' 那一行（发布出去的那份） */
export function installScriptWithKey(publicKeyText: string | undefined): string {
  const script = fs.readFileSync(INSTALL_SCRIPT, "utf8");
  if (!publicKeyText) return script;
  const line = publicKeyText.trim().split(/\r?\n/).pop()!.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(line)) throw new Error("公钥不是 base64");
  const next = script.replace(/^\$ReleasePublicKey = ''\r?$/m, () => `$ReleasePublicKey = '${line}'`);
  if (next === script) throw new Error("install.ps1 里没找到 $ReleasePublicKey = '' 那一行");
  return next;
}

/** npm 上给有 Node 的人的那个包（ergo-ai）：程序（不带 node_modules，依赖交给 npm 装）+ bin/ergo.mjs，没有 postinstall */
function npmAppPackage(stageApp: string, out: string, version: string, repo: string): void {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(stageApp, "packages"), path.join(out, "packages"), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("node_modules"),
  });
  fs.mkdirSync(path.join(out, "bin"), { recursive: true });
  fs.writeFileSync(path.join(out, "bin", "ergo.mjs"), '#!/usr/bin/env node\n// ergo 命令（npm i -g ergo-ai 装的）\nimport "../packages/daemon/src/cli/main.js";\n');
  // 依赖：运行时要的第三方包里直接被我们的包用到的那些（版本照 lock）
  const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
  const deps: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const ws of ["daemon", "protocol", "memory", "supervisor"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, "packages", ws, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith("@ergo/")) continue;
      const key = lock.packages[`packages/${ws}/node_modules/${name}`] ? `packages/${ws}/node_modules/${name}` : `node_modules/${name}`;
      const v = lock.packages[key]?.version;
      if (!v) continue;
      if (deps[name] && deps[name] !== v) conflicts.push(`${name}（${deps[name]} / ${v}）`);
      deps[name] ??= v;
    }
  }
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { engines?: unknown; overrides?: unknown };
  fs.writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify(
      {
        name: NPM_PACKAGE,
        version,
        description: "ergo (二狗): a personal assistant agent system for Windows — install and run it with the ergo command",
        license: "MIT",
        type: "module",
        bin: { ergo: "bin/ergo.mjs" },
        os: ["win32"],
        cpu: ["x64"],
        engines: rootPkg.engines,
        files: ["bin", "packages"],
        dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
        ...(rootPkg.overrides ? { overrides: rootPkg.overrides } : {}),
        ...(conflicts.length > 0 ? { ergoDependencyConflicts: conflicts } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

/** npm 上装着发布包的平台包（ergo-ai-win32-x64）：npmmirror 会同步它，国内的安装脚本从那里下 */
function npmPlatformPackage(out: string, index: ReleaseIndex, files: string[]): void {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(out, path.basename(f)));
  fs.writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify(
      {
        name: NPM_PLATFORM_PACKAGE,
        version: index.version,
        description: "ergo release package for Windows x64 (used by the installer; not meant to be required)",
        license: "MIT",
        os: ["win32"],
        cpu: ["x64"],
        files: files.map((f) => path.basename(f)),
        ergo: index,
      },
      null,
      2,
    )}\n`,
  );
}

/** winget / Scoop 清单草稿：模板里的 {{version}}、{{sha256}}、{{url}} 换成这一版的（不提交，318 号票） */
function renderPackaging(out: string, values: Record<string, string>): void {
  if (!fs.existsSync(PACKAGING_DIR)) return;
  for (const name of fs.readdirSync(PACKAGING_DIR)) {
    if (!name.endsWith(".tmpl")) continue;
    const text = fs.readFileSync(path.join(PACKAGING_DIR, name), "utf8").replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, name.slice(0, -".tmpl".length)), text);
  }
}

export async function buildRelease(options: ReleaseOptions): Promise<ReleaseResult> {
  const log = options.log ?? (() => {});
  const repo = options.repo;
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
  const version = options.version ?? rootPkg.version;
  const base = `ergo-${version}-win-x64`;
  const out = options.out;
  fs.mkdirSync(out, { recursive: true });
  const scratch = buildScratch("release");
  try {
    if (!options.skipWeb) buildWeb(repo, log);
    const node = await obtainNode({ ...(options.node ? { from: options.node } : {}), ...(options.nodeVersion ? { version: options.nodeVersion } : {}), ...(options.nodeDist ? { dist: options.nodeDist } : {}), scratch, log });
    log(`带的 Node：${node.version}（${node.exe}）`);

    let launcherExe: string | undefined;
    let launcherNote: string | undefined;
    if (!options.noLauncher) {
      const compiled = compileLauncher(path.join(scratch, "ergo.exe"));
      const probed = compiled.ok ? probeLauncher(compiled.exe, node.exe, scratch) : compiled;
      if (probed.ok) launcherExe = probed.exe;
      else launcherNote = probed.reason;
      log(launcherExe ? "ergo.exe 编好了、跑得起来" : `不带 ergo.exe，只用 ergo.cmd：${launcherNote}`);
    }

    let secret: MinisignSecretKey | undefined;
    if (options.signKey) secret = parseSecretKey(options.signKey.text, options.signKey.password);
    const publicKeyText = secret ? formatPublicKey(secret) : undefined;

    const stage = path.join(out, "stage", base);
    const staged = stageVersion({
      repo,
      out: stage,
      kind: "release",
      version,
      node: { exe: node.exe, version: node.version, licenseDir: node.licenseDir },
      nodeModules: "copy",
      ...(launcherExe ? { launcherExe } : {}),
      ...(commitOf(repo) ? { commit: commitOf(repo)! } : {}),
      ...(publicKeyText ? { releaseKey: publicKeyText } : {}),
      log,
    });
    log(`版本目录摆好了：${stage}（第三方包 ${staged.closure.keys.length} 个，许可证 ${staged.licenses.length} 条）`);

    // 组件清单的签名（守护进程读清单时验）
    if (secret) {
      const manifest = path.join(stage, "app", "packages", "daemon", "src", "components", "manifest.json");
      fs.writeFileSync(`${manifest}.minisig`, sign(fs.readFileSync(manifest), secret, { fileName: "manifest.json", trustedComment: `ergo ${version} components manifest` }));
    }

    const zip = path.join(out, `${base}.zip`);
    log(`打包 ${zip}`);
    const count = zipDirectory(stage, zip);
    const zipSha = await sha256File(zip);
    const zipSize = fs.statSync(zip).size;
    log(`  ${count} 个文件，${(zipSize / 1e6).toFixed(0)} MB，sha256 ${zipSha}`);
    const sumsFile = path.join(out, "SHA256SUMS");
    fs.writeFileSync(sumsFile, formatSums([[path.basename(zip), zipSha]]));
    let signature: string | undefined;
    if (secret) {
      signature = path.join(out, "SHA256SUMS.minisig");
      fs.writeFileSync(signature, sign(fs.readFileSync(sumsFile), secret, { fileName: "SHA256SUMS", trustedComment: `ergo ${version} SHA256SUMS` }));
    }
    const index: ReleaseIndex = {
      format: 1,
      version,
      node: node.version,
      nodeTested: [...TESTED_NODE_VERSIONS],
      files: { zip: path.basename(zip), sums: "SHA256SUMS", signature: "SHA256SUMS.minisig" },
      zipSize,
      publishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(out, "latest.json"), `${JSON.stringify(index, null, 2)}\n`);
    fs.writeFileSync(path.join(out, "install.ps1"), installScriptWithKey(publicKeyText));
    if (publicKeyText) fs.writeFileSync(path.join(out, "ergo-release.pub"), publicKeyText);

    let npm: ReleaseResult["npm"];
    if (!options.noNpm) {
      const app = path.join(out, "npm", NPM_PACKAGE);
      const platform = path.join(out, "npm", NPM_PLATFORM_PACKAGE);
      npmAppPackage(path.join(stage, "app"), app, version, repo);
      npmPlatformPackage(platform, index, [zip, sumsFile, ...(signature ? [signature] : []), path.join(out, "latest.json")]);
      npm = { app, platform };
    }
    renderPackaging(path.join(out, "packaging"), { version, sha256: zipSha, url: `https://github.com/catmaniii/ergo/releases/download/v${version}/${path.basename(zip)}` });
    return { version, zip, sums: sumsFile, ...(signature ? { signature } : {}), index, stage, launcher: launcherExe ? "exe" : "cmd", ...(launcherNote ? { launcherNote } : {}), ...(npm ? { npm } : {}) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
