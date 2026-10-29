// 发布包里带哪些依赖（318 号票）：从守护进程、协议包、记忆、服务管家这几个运行时的包出发，照 package-lock.json 按 Node 的解析规则
// 找出要用到的第三方包（依赖、可选依赖、非可选的对等依赖），从已经装好的 node_modules 里复制过去——不在用户机器上跑 npm、不联网。
// 不带的：
//   - Claude Code 的 Agent SDK（@anthropic-ai/claude-agent-sdk*，Anthropic 自己的许可，不随二狗分发；用的人经组件装，315、323 号票）；
//   - 别的平台的原生库（只留 Windows x64：onnxruntime-node 的 darwin / linux / win32-arm64，pi-tui 的 darwin / linux / win32-arm64）；
//   - 运行时用不到的：类型声明（.d.ts）、source map、说明文档（许可证文件留着）。
// 网页（packages/web）构建成单个 index.html，它的依赖不进 node_modules，只进许可证清单（licenses.ts）。
import fs from "node:fs";
import path from "node:path";

export interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface Lockfile {
  packages: Record<string, LockPackage>;
}

/** 发布包里不带的包（连同只经它们才用到的） */
export const EXCLUDED_PACKAGES: readonly RegExp[] = [/^@anthropic-ai\/claude-agent-sdk(-.*)?$/];

/** 运行时的工作区包（它们的依赖要带上） */
export const RUNTIME_WORKSPACES = ["packages/daemon", "packages/protocol", "packages/memory", "packages/supervisor"] as const;

/** lock 里一个包的键（node_modules/a/node_modules/@s/b）→ 包名（@s/b） */
export function packageNameOf(key: string): string {
  const i = key.lastIndexOf("node_modules/");
  return key.slice(i + "node_modules/".length);
}

/** 从 from（lock 的键或工作区目录）按 Node 的规则找 name：先找自己下面的 node_modules，再一层层往上 */
export function resolveIn(lock: Lockfile, from: string, name: string): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return undefined;
    const i = base.lastIndexOf("/node_modules/");
    if (i >= 0) base = base.slice(0, i);
    else if (base.startsWith("node_modules/")) base = "";
    else base = path.posix.dirname(base) === "." ? "" : path.posix.dirname(base);
  }
}

export interface Closure {
  /** 要带的包（lock 的键），排好序 */
  keys: string[];
  /** 没带的可选包（lock 里有、磁盘上没装：别的平台的） */
  skippedOptional: string[];
  /** 按 EXCLUDED_PACKAGES 不带的 */
  excluded: string[];
}

/**
 * 从 roots（工作区目录）出发的依赖闭包。present(key) 回这个包在磁盘上装着没有（没装的可选包跳过；没装的必需包抛错）
 */
export function dependencyClosure(lock: Lockfile, roots: readonly string[], present: (key: string) => boolean, rootManifest: (root: string) => LockPackage): Closure {
  const keys = new Set<string>();
  const skippedOptional = new Set<string>();
  const excluded = new Set<string>();
  const queue: Array<{ from: string; manifest: LockPackage }> = roots.map((root) => ({ from: root, manifest: rootManifest(root) }));
  while (queue.length > 0) {
    const { from, manifest } = queue.shift()!;
    const wants: Array<[string, boolean]> = [
      ...Object.keys(manifest.dependencies ?? {}).map((n): [string, boolean] => [n, false]),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((n): [string, boolean] => [n, true]),
      ...Object.keys(manifest.peerDependencies ?? {}).map((n): [string, boolean] => [n, manifest.peerDependenciesMeta?.[n]?.optional === true]),
    ];
    for (const [name, optional] of wants) {
      if (name.startsWith("@ergo/")) continue;
      if (EXCLUDED_PACKAGES.some((re) => re.test(name))) {
        excluded.add(name);
        continue;
      }
      const key = resolveIn(lock, from, name);
      if (!key || !present(key)) {
        if (optional) {
          skippedOptional.add(key ?? name);
          continue;
        }
        throw new Error(`${from} 要的 ${name} 没装（package-lock.json 里${key ? "有、磁盘上没有" : "也没有"}）——先 npm ci`);
      }
      const entry = lock.packages[key]!;
      if (entry.link) continue;
      if (keys.has(key)) continue;
      keys.add(key);
      queue.push({ from: key, manifest: entry });
    }
  }
  return { keys: [...keys].sort(), skippedOptional: [...skippedOptional].sort(), excluded: [...excluded].sort() };
}

/** 读仓库的 lock、工作区 package.json，算发布包要带的依赖 */
export function runtimeClosure(repo: string, roots: readonly string[] = RUNTIME_WORKSPACES): Closure {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")) as Lockfile;
  return dependencyClosure(
    lock,
    roots,
    (key) => fs.existsSync(path.join(repo, key, "package.json")),
    (root) => JSON.parse(fs.readFileSync(path.join(repo, root, "package.json"), "utf8")) as LockPackage,
  );
}

/** 别的平台的原生库：包名 → 包里要去掉的目录前缀（相对包目录，用 /） */
const FOREIGN_NATIVE_DIRS: Readonly<Record<string, readonly string[]>> = {
  "onnxruntime-node": ["bin/napi-v6/darwin/", "bin/napi-v6/linux/", "bin/napi-v6/win32/arm64/"],
  "@earendil-works/pi-tui": ["native/darwin/", "native/linux/", "native/win32/prebuilds/win32-arm64/"],
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice|authors)([.-].*)?$/i;

/** 复制一个包时这个文件要不要（rel 相对包目录，用 /） */
export function keepPackageFile(packageName: string, rel: string): boolean {
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
  const base = path.posix.basename(rel);
  if (LICENSE_FILE.test(base)) return true;
  if ((FOREIGN_NATIVE_DIRS[packageName] ?? []).some((prefix) => rel.startsWith(prefix))) return false;
  if (/\.d\.[cm]?ts$/.test(base) || base.endsWith(".map") || base.endsWith(".tsbuildinfo")) return false;
  if (/\.(md|markdown)$/i.test(base)) return false;
  return true;
}

/** 把闭包里的包从 <仓库>/node_modules 复制到 <目标>/node_modules（目录结构照 lock 的键）。回文件数、字节数 */
export function copyClosure(repo: string, closure: Closure, targetApp: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const key of closure.keys) {
    const name = packageNameOf(key);
    const from = path.join(repo, key);
    const to = path.join(targetApp, key);
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (!keepPackageFile(name, childRel)) continue;
        const src = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(src, childRel);
        else if (entry.isFile()) {
          const dest = path.join(to, ...childRel.split("/"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          files++;
          bytes += fs.statSync(dest).size;
        }
      }
    };
    walk(from, "");
  }
  return { files, bytes };
}
