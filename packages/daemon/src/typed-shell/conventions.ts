// 跑测试、启动构建、装依赖不接受任意命令（28 号票）：执行的是工作目录里已有的项目约定，模型只能传 npm 脚本的附加参数、包名。
// 认得的约定（按先后找第一个）：
// - package.json 里的脚本（test、build）：`npm run <脚本> -- <附加参数>`，附加参数在 `--` 之后，只交给项目自己的测试、构建工具；
// - Makefile 的目标（test、build）：`make <目标>`；
// - Cargo.toml：`cargo test` / `cargo build`；
// - go.mod：`go test ./...` / `go build ./...`。
// make、cargo、go 只跑约定的目标，**一律不收附加参数**：make 的"变量=值"会展开进配方，cargo 的 `--config` 能设 runner，
// go test 的 `-exec` 能跑任意程序——附加参数一放开就等于能执行任意命令。
// 装依赖只装进这个目录：package.json 按锁文件认包管理器（npm、pnpm、yarn、bun），Cargo.toml 用 cargo，go.mod 用 go；
// 只收注册表里的包名（可以带版本号或版本范围）：不收选项（全局安装、换安装位置）、本机路径、file:、link:、git 网址、绝对路径、..。
//
// 项目代码本身能执行的是固有缺口，不在这里挡：跑测试、构建会执行项目里的脚本和 Makefile（agent 能用文件工具改它们），
// 带类型的工具只负责分类（守卫按类别判），不额外提供隔离。
import fs from "node:fs";
import path from "node:path";
import { TOOL } from "../guard/index.ts";

export type ProjectTask = "test" | "build";

/** 跑测试、启动构建两个工具：工具名、给人看的说法、给模型的说明 */
export const PROJECT_TASKS: Readonly<Record<ProjectTask, { tool: string; word: string; doing: string; ok: string; bad: string; description: string }>> = Object.freeze({
  test: {
    tool: TOOL.run_tests,
    word: "测试",
    doing: "跑测试",
    ok: "测试通过",
    bad: "测试没通过",
    description:
      "跑测试：按工作目录里已有的项目约定跑（package.json 的 test 脚本、Makefile 的 test 目标、cargo test、go test）。只有 npm 脚本收附加参数（交给项目自己的测试工具）。返回退出码和输出摘要；退出码非零算没通过。",
  },
  build: {
    tool: TOOL.start_build,
    word: "构建",
    doing: "构建",
    ok: "构建成功",
    bad: "构建失败",
    description:
      "启动构建：按工作目录里已有的项目约定构建（package.json 的 build 脚本、Makefile 的 build 目标、cargo build、go build）。只有 npm 脚本收附加参数。返回退出码和输出摘要。",
  },
});

/** 要跑的命令：argv 和给人看的写法 */
export interface ProjectCommand {
  argv: string[];
  label: string;
}

export type Resolved = ProjectCommand | { error: string };

const label = (argv: readonly string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
const command = (argv: string[]): ProjectCommand => ({ argv, label: label(argv) });

/** 跑测试、构建：按工作目录里已有的约定 */
export function projectCommand(dir: string, task: ProjectTask, extra: readonly string[]): Resolved {
  const { word } = PROJECT_TASKS[task];
  const scripts = packageScripts(dir);
  if (scripts && typeof scripts[task] === "string") return command(["npm", "run", task, ...(extra.length > 0 ? ["--", ...extra] : [])]);
  const fixed = (what: string, argv: string[]): Resolved =>
    extra.length > 0 ? { error: `${what}只跑约定的${word}，不收附加参数（附加参数能让它执行任意命令）。需要别的参数就写进项目的约定里` } : command(argv);
  if (makefileHasTarget(dir, task)) return fixed(`Makefile 的 ${task} 目标`, ["make", task]);
  if (exists(dir, "Cargo.toml")) return fixed(`cargo ${task}`, ["cargo", task]);
  if (exists(dir, "go.mod")) return fixed(`go ${task}`, ["go", task, "./..."]);
  return {
    error: `${dir} 里没有认得的${word}约定（package.json 的 ${task} 脚本、Makefile 的 ${task} 目标、Cargo.toml、go.mod）。只能跑项目里已有的约定；需要的话先在项目里加上`,
  };
}

/** 版本号、版本范围、标签（latest、^1.2.0、>=1 <2、1.x、*）：不含 `:`、`/`、`\`、`@` */
const VERSION = "[0-9A-Za-z.^~<>=|*+ -]+";
/** npm 的包名（可带 @scope/）加可选的版本；file:、link:、git 网址、路径都带 `:` 或 `/` 或以 `.` 开头，过不了 */
const NPM_PACKAGE = new RegExp(`^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:@${VERSION})?$`);
/** crates.io 的包名加可选的版本 */
const CARGO_PACKAGE = new RegExp(`^[A-Za-z0-9_-]+(?:@${VERSION})?$`);
/** Go 的模块路径（第一段是带点的域名）加可选的版本 */
const GO_PACKAGE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[A-Za-z0-9._~-]+)*(?:@[A-Za-z0-9._+-]+)?$/;

/** 在工作目录里装依赖 */
export function installCommand(dir: string, packages: readonly string[], dev: boolean): Resolved {
  const kind = packageScripts(dir) !== undefined ? "npm" : exists(dir, "Cargo.toml") ? "cargo" : exists(dir, "go.mod") ? "go" : undefined;
  if (kind === undefined) return { error: `${dir} 里没有认得的依赖约定（package.json、Cargo.toml、go.mod）` };
  const pattern = kind === "npm" ? NPM_PACKAGE : kind === "cargo" ? CARGO_PACKAGE : GO_PACKAGE;
  const bad = packages.find((p) => !pattern.test(p) || p.includes(".."));
  if (bad !== undefined) {
    return {
      error: `装依赖只收注册表里的包名（可以带版本号或版本范围），不收 ${JSON.stringify(bad)}：不收选项、本机路径、file:、link:、git 网址、绝对路径和 ..（只装进工作目录，不能全局安装，也不能换安装位置）`,
    };
  }
  if (kind === "cargo") return command(packages.length > 0 ? ["cargo", "add", ...(dev ? ["--dev"] : []), ...packages] : ["cargo", "fetch"]);
  if (kind === "go") return command(packages.length > 0 ? ["go", "get", ...packages] : ["go", "mod", "download"]);
  const pm = packageManager(dir);
  if (pm === "npm") return command(["npm", "install", "--no-audit", "--no-fund", ...(dev ? ["--save-dev"] : []), ...packages]);
  return command(packages.length > 0 ? [pm, "add", ...(dev ? ["-D"] : []), ...packages] : [pm, "install"]);
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
