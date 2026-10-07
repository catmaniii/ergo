// 跑测试、启动构建、装依赖不接受任意命令（28 号票）：执行的是工作目录里已有的项目约定，模型只能传附加参数、包名。
// 认得的约定（按先后找第一个）：
// - package.json 里的脚本（test、build）：`npm run <脚本> -- <附加参数>`，附加参数在 `--` 之后，只交给脚本；
// - Makefile 的目标（test、build）：`make <目标>`，附加参数只能是 `变量=值`（`-C` 这类会换目录的选项不收）；
// - Cargo.toml：`cargo test -- <附加参数>`（交给测试程序）；`cargo build` 不收附加参数；
// - go.mod：`go test ./... -args <附加参数>`（交给测试程序）；`go build ./...` 不收附加参数。
// 装依赖只装进这个目录：package.json 按锁文件认包管理器（npm、pnpm、yarn、bun），Cargo.toml 用 cargo，go.mod 用 go；
// 包名不能以 `-` 开头（不收任何选项：全局安装、换安装位置都做不到）。
import fs from "node:fs";
import path from "node:path";

export type ProjectTask = "test" | "build";

/** 要跑的命令：argv 和给人看的写法 */
export interface ProjectCommand {
  argv: string[];
  label: string;
}

export type Resolved = ProjectCommand | { error: string };

const label = (argv: readonly string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
const command = (argv: string[]): ProjectCommand => ({ argv, label: label(argv) });

const TASK_WORD: Readonly<Record<ProjectTask, string>> = { test: "测试", build: "构建" };

/** 跑测试、构建：按工作目录里已有的约定 */
export function projectCommand(dir: string, task: ProjectTask, extra: readonly string[]): Resolved {
  const scripts = packageScripts(dir);
  if (scripts && typeof scripts[task] === "string") return command(["npm", "run", task, ...(extra.length > 0 ? ["--", ...extra] : [])]);
  if (makefileHasTarget(dir, task)) {
    const bad = extra.find((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    if (bad !== undefined) return { error: `Makefile 的${TASK_WORD[task]}目标只收"变量=值"形式的附加参数，不收 ${JSON.stringify(bad)}` };
    return command(["make", task, ...extra]);
  }
  if (exists(dir, "Cargo.toml")) {
    if (task === "build") return extra.length > 0 ? { error: "cargo build 不收附加参数" } : command(["cargo", "build"]);
    return command(["cargo", "test", ...(extra.length > 0 ? ["--", ...extra] : [])]);
  }
  if (exists(dir, "go.mod")) {
    if (task === "build") return extra.length > 0 ? { error: "go build 不收附加参数" } : command(["go", "build", "./..."]);
    return command(["go", "test", "./...", ...(extra.length > 0 ? ["-args", ...extra] : [])]);
  }
  return {
    error: `${dir} 里没有认得的${TASK_WORD[task]}约定（package.json 的 ${task} 脚本、Makefile 的 ${task} 目标、Cargo.toml、go.mod）。只能跑项目里已有的约定；需要的话先在项目里加上`,
  };
}

/** 在工作目录里装依赖 */
export function installCommand(dir: string, packages: readonly string[], dev: boolean): Resolved {
  const bad = packages.find((p) => p.trim() === "" || p.startsWith("-"));
  if (bad !== undefined) {
    return { error: `装依赖只收包名，不收选项（${JSON.stringify(bad)}）：只装进工作目录，不能全局安装，也不能换安装位置` };
  }
  if (packageScripts(dir) !== undefined) {
    const pm = packageManager(dir);
    if (pm === "npm") return command(["npm", "install", "--no-audit", "--no-fund", ...(dev ? ["--save-dev"] : []), ...packages]);
    return command(packages.length > 0 ? [pm, "add", ...(dev ? ["-D"] : []), ...packages] : [pm, "install"]);
  }
  if (exists(dir, "Cargo.toml")) {
    if (packages.length === 0) return command(["cargo", "fetch"]);
    return command(["cargo", "add", ...(dev ? ["--dev"] : []), ...packages]);
  }
  if (exists(dir, "go.mod")) return command(packages.length > 0 ? ["go", "get", ...packages] : ["go", "mod", "download"]);
  return { error: `${dir} 里没有认得的依赖约定（package.json、Cargo.toml、go.mod）` };
}

/** package.json 的 scripts（没有 package.json 时 undefined，有但没写 scripts 时是空对象） */
function packageScripts(dir: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const pkg = JSON.parse(text) as { scripts?: unknown };
    return typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm";
  if (exists(dir, "yarn.lock")) return "yarn";
  if (exists(dir, "bun.lockb") || exists(dir, "bun.lock")) return "bun";
  return "npm";
}

function makefileHasTarget(dir: string, target: string): boolean {
  for (const name of ["GNUmakefile", "makefile", "Makefile"]) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      return new RegExp(`^${target}\\s*:(?!=)`, "m").test(text);
    } catch {
      // 没有这个文件
    }
  }
  return false;
}

function exists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}
