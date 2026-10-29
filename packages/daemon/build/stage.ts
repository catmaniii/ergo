// 摆一个版本目录（318 号票）：发布包（npm run release）、源码装（npm run ergo:install）、开发模式（npm run build 的 dist/ergo）都用它，
// 装出来的东西一样。版本目录里有什么（在 out 下）：
//   ergo.json                   版本信息（release / source / link、版本、Node 版本、提交号）
//   node\node.exe、LICENSE      自带的 Node（版本是构建参数，默认跟着 pi 的那条线，ADR-0031）；用系统 Node 的写 node.path
//   ergo.exe、ergo.cmd          启动器
//   app\package.json
//   app\packages\daemon\        src\（转成 .js）、prompts\、templates\、skills\、holidays\、package.json
//   app\packages\protocol\      src\（.js）、locales\、package.json
//   app\packages\memory\        src\（.js）、package.json
//   app\packages\supervisor\    服务管家（本来就是 .js）：bin\、src\、webui\、clients\、examples\、deploy\、公开的文档
//   app\packages\web\dist\      构建好的网页
//   app\node_modules\           运行时要的第三方包（deps.ts），开发模式下是联接到仓库的 node_modules
//   LICENSE、THIRD_PARTY_NOTICES.txt、third-party-licenses.json
// 只按白名单拿：不会带上 .scratch、测试、评测数据（memory-eval）、服务管家的私有数据和设计记录这些。
import fs from "node:fs";
import path from "node:path";
import { type VersionInfo, type VersionKind, writeVersionInfo } from "../src/release/layout.ts";
import { type Closure, copyClosure, runtimeClosure } from "./deps.ts";
import { LAUNCHER_CMD } from "./launcher.ts";
import { collectLicenses, formatNotices, type LicenseItem, licensesJson } from "./licenses.ts";
import { transpileTree } from "./transpile.ts";

/** 服务管家的包里要带的（相对包目录）：目录整个带、文件单个带 */
const SUPERVISOR_DIRS = ["bin", "src", "webui", "clients", "examples", "deploy"];
const SUPERVISOR_FILES = ["package.json", "README.md", "CONTEXT.md", "docs/link-protocol.md", "docs/service-schema.md", "docs/webui.md", "docs/onboarding-skill.md"];
/** 守护进程包里除 src 以外要带的资源目录 */
const DAEMON_ASSET_DIRS = ["prompts", "templates", "skills", "holidays"];
/** 源码目录里不带的（开发用的命令行工具：写死中文的计数、多语言检查） */
const DAEMON_SRC_SKIP = new Set(["i18n/check-cli.ts"]);

export interface StageNode {
  /** 要带进版本目录的 node.exe */
  exe?: string;
  /** 不带 node.exe、写 node.path 指向它（-UseSystemNode、开发模式） */
  pointer?: string;
  /** Node 版本（不带 v） */
  version: string;
  /** Node 的 LICENSE 在哪个目录（官方 zip 解开的那层）；不给就找 exe 所在的目录 */
  licenseDir?: string;
}

export interface StageOptions {
  repo: string;
  /** 版本目录（不在或空的；在的话整个换掉） */
  out: string;
  kind: VersionKind;
  /** 不给是根 package.json 的 version */
  version?: string;
  node: StageNode;
  /** copy：复制运行时要的第三方包；link：联接到仓库的 node_modules（开发模式） */
  nodeModules: "copy" | "link";
  /** 编好的 ergo.exe（不给就只带 ergo.cmd） */
  launcherExe?: string;
  commit?: string;
  ref?: string;
  /** 发布公钥（minisign 公钥文件的内容）：写进 app\packages\daemon\src\release\release-key.pub */
  releaseKey?: string;
  /** 构建好的网页在哪（不给是 <仓库>/packages/web/dist；测试给一个假的） */
  webDist?: string;
  log?: (line: string) => void;
}

export interface StageResult {
  info: VersionInfo;
  closure: Closure;
  licenses: LicenseItem[];
  /** 复制的第三方文件数、字节数（link 时是 0） */
  nodeModules: { files: number; bytes: number };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDir(from: string, to: string, skip?: (rel: string) => boolean): void {
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip?.(childRel)) continue;
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(src, childRel);
      else if (entry.isFile()) {
        const dest = path.join(to, ...childRel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  };
  walk(from, "");
}

/** 包的 package.json 只留运行时要看的几项；入口改成 .js */
function runtimeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const keep = ["name", "version", "private", "type", "description", "license", "engines", "bin", "dependencies", "optionalDependencies", "sideEffects"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (manifest[k] !== undefined) out[k] = manifest[k];
  if (manifest.exports !== undefined) out.exports = JSON.parse(JSON.stringify(manifest.exports).replace(/\.ts"/g, '.js"'));
  return out;
}

/** 摆一个版本目录 */
export function stageVersion(options: StageOptions): StageResult {
  const { repo, out } = options;
  const log = options.log ?? (() => {});
  const rootPkg = readJson<{ version: string; engines?: unknown; description?: string }>(path.join(repo, "package.json"));
  const version = options.version ?? rootPkg.version;
  const webDist = options.webDist ?? path.join(repo, "packages", "web", "dist");
  const webIndex = path.join(webDist, "index.html");
  if (!fs.existsSync(webIndex)) throw new Error(`网页还没构建（没有 ${webIndex}）：先 npm run build:web`);

  fs.rmSync(out, { recursive: true, force: true });
  const app = path.join(out, "app");
  fs.mkdirSync(app, { recursive: true });
  writeJson(path.join(app, "package.json"), {
    name: "ergo",
    version,
    private: true,
    type: "module",
    description: "ergo (二狗): a personal assistant agent system — installed program / 安装好的程序",
    license: "MIT",
    engines: rootPkg.engines,
  });

  // 工作区的三个 TypeScript 包：转成 .js
  const pkgDir = (name: string) => path.join(repo, "packages", name);
  for (const name of ["protocol", "memory", "daemon"]) {
    log(`转译 packages/${name}/src`);
    const stats = transpileTree({
      from: path.join(pkgDir(name), "src"),
      to: path.join(app, "packages", name, "src"),
      rel: `packages/${name}/src`,
      ...(name === "daemon" ? { skip: (rel: string) => DAEMON_SRC_SKIP.has(rel) } : {}),
    });
    log(`  ${stats.transpiled} 个 .ts → .js，共 ${stats.files} 个文件`);
    writeJson(path.join(app, "packages", name, "package.json"), runtimeManifest(readJson(path.join(pkgDir(name), "package.json"))));
  }
  copyDir(path.join(pkgDir("protocol"), "locales"), path.join(app, "packages", "protocol", "locales"));
  for (const dir of DAEMON_ASSET_DIRS) copyDir(path.join(pkgDir("daemon"), dir), path.join(app, "packages", "daemon", dir));
  if (options.releaseKey) fs.writeFileSync(path.join(app, "packages", "daemon", "src", "release", "release-key.pub"), options.releaseKey);

  // 服务管家（本来就是 .js）：白名单
  const sup = pkgDir("supervisor");
  for (const dir of SUPERVISOR_DIRS) copyDir(path.join(sup, dir), path.join(app, "packages", "supervisor", dir));
  for (const file of SUPERVISOR_FILES) {
    const dest = path.join(app, "packages", "supervisor", ...file.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file === "package.json") writeJson(dest, runtimeManifest(readJson(path.join(sup, file))));
    else fs.copyFileSync(path.join(sup, ...file.split("/")), dest);
  }

  // 网页：构建产物
  copyDir(webDist, path.join(app, "packages", "web", "dist"));

  // 第三方包
  const closure = runtimeClosure(repo);
  let nodeModules = { files: 0, bytes: 0 };
  if (options.nodeModules === "copy") {
    log(`复制运行时的第三方包（${closure.keys.length} 个）`);
    nodeModules = copyClosure(repo, closure, app);
    log(`  ${nodeModules.files} 个文件，${(nodeModules.bytes / 1e6).toFixed(0)} MB`);
  } else {
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(app, "node_modules"), "junction");
    // 工作区目录下自己的 node_modules（lock 里 packages/<包>/node_modules/… 的那些）也联过去
    for (const name of ["protocol", "memory", "daemon", "supervisor"]) {
      const nested = path.join(pkgDir(name), "node_modules");
      if (fs.existsSync(nested)) fs.symlinkSync(nested, path.join(app, "packages", name, "node_modules"), "junction");
    }
  }

  // Node
  if (options.node.exe) {
    fs.mkdirSync(path.join(out, "node"), { recursive: true });
    fs.copyFileSync(options.node.exe, path.join(out, "node", "node.exe"));
    const licenseDir = options.node.licenseDir ?? path.dirname(options.node.exe);
    if (fs.existsSync(path.join(licenseDir, "LICENSE"))) fs.copyFileSync(path.join(licenseDir, "LICENSE"), path.join(out, "node", "LICENSE"));
  } else if (options.node.pointer) {
    fs.writeFileSync(path.join(out, "node.path"), options.node.pointer);
  }

  // 启动器
  // 批处理一律 CRLF（cmd.exe 读只有 LF 的批处理时，跳转、括号块偶尔会认错行）
  fs.writeFileSync(path.join(out, "ergo.cmd"), fs.readFileSync(LAUNCHER_CMD, "utf8").replace(/\r?\n/g, "\r\n"));
  if (options.launcherExe) fs.copyFileSync(options.launcherExe, path.join(out, "ergo.exe"));

  // 版本信息
  const info: VersionInfo = {
    format: 1,
    version,
    kind: options.kind,
    ...(options.node.exe ? { node: options.node.version } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
    builtAt: new Date().toISOString(),
    ...(options.ref ? { ref: options.ref } : {}),
  };
  writeVersionInfo(out, info);

  // 许可证
  if (fs.existsSync(path.join(repo, "LICENSE"))) fs.copyFileSync(path.join(repo, "LICENSE"), path.join(out, "LICENSE"));
  const licenses = collectLicenses(repo, closure.keys, options.node.exe ? { version: options.node.version, dir: options.node.licenseDir ?? path.dirname(options.node.exe) } : undefined);
  fs.writeFileSync(path.join(out, "THIRD_PARTY_NOTICES.txt"), formatNotices(licenses, { name: "ergo", version }));
  fs.writeFileSync(path.join(out, "third-party-licenses.json"), licensesJson(licenses));
  return { info, closure, licenses, nodeModules };
}
