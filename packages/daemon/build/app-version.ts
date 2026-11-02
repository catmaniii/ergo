// 手机 App 自己一个版本号（frontend/app-version.json，ADR-0047）：电脑版升级不等于要升 App，App 代码没变就不用重新编译、不用用户重装。
// npm run release -- --build-mobile 先看这里：
//   - stale：从上次改版本号到现在，App 的代码变了、版本号没升（downloads/ 里的版本还是它）。报错退出，写明要升 App 版本；
//   - unchanged：没变。不编译，发布附件直接用 downloads/ 里现成的两个包；
//   - bumped：版本号和 downloads/README.md 写的不一样，就是升了。编译，并提示更新 downloads/。
// 打包结束再打印一行给发布说明用：这次用户要不要升 App，只看 MIN_APP_VERSION 比上一个发布高了没有。
// 这里只查 git、读文件，不碰工具链；测试用临时 git 仓库。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareAppVersions } from "@ergo/protocol";

export const APP_VERSION_FILE = "frontend/app-version.json";
const DOWNLOADS_README = "downloads/README.md";
const MIN_VERSION_SOURCE = "packages/protocol/src/app-version.ts";

/** 进 App 的代码在这两处：原生工程在 frontend/ 下面，内置浏览器的页面脚本打包进 App */
const APP_CODE_PATHS = ["frontend", "packages/web/src/page-bridge"];

/** 在 frontend/ 下面、但不进 App 的：顶层的文件（版本文件自己、说明、测试的配置）、测试、模拟器联调、说明 */
const NOT_IN_APP = [/^frontend\/[^/]+$/, /^frontend\/test\//, /^frontend\/android\/e2e\//, /\.md$/];

export type MobilePlan =
  /** 升了版本：要编译；packaged 是 downloads/ 里现在的版本 */
  | { kind: "bumped"; version: string; packaged: string | undefined }
  /** 没变：用 downloads/ 里现成的 */
  | { kind: "unchanged"; version: string }
  /** App 代码变了、版本号没升：不能发 */
  | { kind: "stale"; version: string; since: string; changed: string[] };

function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new Error(`--build-mobile 要查 git（App 代码从上次改版本号到现在变没变）：git ${args.join(" ")} 没成。${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** frontend/app-version.json 写的版本号 */
export function readAppVersion(repo: string): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, APP_VERSION_FILE), "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version === "") throw new Error(`${APP_VERSION_FILE} 里没有 version`);
  return version;
}

/** downloads/ 里的包是哪一版（downloads/README.md 写的）；没写是 undefined */
export function packagedAppVersion(repo: string): string | undefined {
  const file = path.join(repo, DOWNLOADS_README);
  if (!fs.existsSync(file)) return undefined;
  return /^版本 \/ Version:\s*(\S+)/m.exec(fs.readFileSync(file, "utf8"))?.[1];
}

const lines = (text: string) => text.split("\n").filter(Boolean);

/** 从 base 到现在（连同没提交的）变了的 App 代码 */
function appCodeChanged(repo: string, base: string): string[] {
  const tracked = lines(git(repo, "diff", "--name-only", base, "--", ...APP_CODE_PATHS));
  const untracked = lines(git(repo, "ls-files", "--others", "--exclude-standard", "--", ...APP_CODE_PATHS));
  return [...tracked, ...untracked].filter((file) => !NOT_IN_APP.some((pattern) => pattern.test(file)));
}

/** 这次打包该怎么办 */
export function mobilePlan(repo: string): MobilePlan {
  const version = readAppVersion(repo);
  const packaged = packagedAppVersion(repo);
  if (packaged !== version) return { kind: "bumped", version, packaged };
  // 版本文件还没提交过（刚建）：只看没提交的
  const since = git(repo, "log", "-1", "--format=%H", "--", APP_VERSION_FILE) || "HEAD";
  const changed = appCodeChanged(repo, since);
  return changed.length > 0 ? { kind: "stale", version, since: since.slice(0, 8), changed } : { kind: "unchanged", version };
}

/** App 代码变了、版本号没升时报的错 */
export function staleMessage(plan: Extract<MobilePlan, { kind: "stale" }>): string {
  const shown = plan.changed.slice(0, 10).join("、");
  const more = plan.changed.length > 10 ? ` 等 ${plan.changed.length} 个` : "";
  return `手机 App 的代码从上次改 ${APP_VERSION_FILE}（${plan.since}）到现在变了，版本号还是 ${plan.version}：要升 App 版本，再打包。步骤见 docs/architecture/development.md 的"发布手机安装包"。变了的文件：${shown}${more}`;
}

function minVersionIn(source: string): string | undefined {
  return /MIN_APP_VERSION = "([^"]+)"/.exec(source)?.[1];
}

/** 上一个发布（比这次早的最新的 v* 标签）的最低版本；没有上一个发布、那时还没有这个常量、不是 git 仓库的是 undefined：包都打好了，不为这一行失败 */
function previousMinAppVersion(repo: string, release: string): string | undefined {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const previous = lines(run("tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname")).find((tag) => tag !== `v${release}`);
    return previous === undefined ? undefined : minVersionIn(run("show", `${previous}:${MIN_VERSION_SOURCE}`));
  } catch {
    return undefined;
  }
}

/** 打包结束打印的一行（给发布说明用）：这次用户要不要升 App。上一个发布还没有最低版本时算没变 */
export function appUpgradeLine(repo: string, release: string): string {
  const min = minVersionIn(fs.readFileSync(path.join(repo, MIN_VERSION_SOURCE), "utf8"));
  if (min === undefined) throw new Error(`${MIN_VERSION_SOURCE} 里找不到 MIN_APP_VERSION`);
  const previous = previousMinAppVersion(repo, release);
  return previous !== undefined && compareAppVersions(min, previous) > 0 ? `手机 App：需要升级到 ${min}` : "手机 App：不用升级";
}
