// 守护进程一侧现取的环境事实（规格第 9 节）：守卫的判定函数是纯函数，文件元数据、git 状态、脚本里写了什么，
// 都由这里在判定之前现取，作为 GuardInput.facts 传进去。按一次判定实际要判的调用（judgement.calls，
// 通用 bash 已拆成伪工具调用）取：
// - 每个路径参数：在不在、是不是目录、真实路径（fs.realpathSync.native：展开符号链接、目录联接和 8.3 短名；
//   还不存在的文件按最近的已有上级目录算）。运行时自动留旧版本的地方（15 号票：项目档案，不含工作目录和历史区）
//   算已备份——写的路径和它的真实路径都在那里才算；
// - 维护者和子 agent 项目里的路径：包含它的 git 仓库的未提交改动和 HEAD（v1 模板"删除或覆盖前须已提交"
//   "不重复推送"要用）；只在项目范围之内往上找仓库，项目里不在仓库里的目录写 repository: false。
//   秘书的草稿区不受 v1 模板约束，不取；
// - 要跑的脚本（run_script）：扫描出的联网库或函数（script-scan.ts）；
// - 带通配符的路径：展开成的现有路径（util/wildcards.ts，展不开的是通配符之前那段目录；101 号票评审后定：守卫逐个比受保护区域、密钥区）；
// - 这个 agent 在做任务、项目时（111 号票，FactsContext.ownWork）：认任务、项目自己的临时文件要的——文件的创建时间（stat 的 birthtime），
//   要删除的、在工作目录里的目录里面有什么（递归、不跟进链接，最多 MAX_CONTENTS 项），带通配符要删除的展开成的每个现有路径的文件事实。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  agentShellEnv,
  absolutePathArgs,
  agentScope,
  comparable,
  type DirContents,
  type EnvironmentFacts,
  type FileFact,
  findTool,
  type GitFact,
  type GuardAgent,
  isWithin,
  isWithinAny,
  type JudgedCall,
  pathReplacement,
  type ScriptFact,
  type ShellEnv,
  TOOL,
  type ToolRegistry,
  wildcardPrefix,
} from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";
import { expandWildcards } from "../util/wildcards.ts";
import { scanScript } from "./script-scan.ts";

export interface FactsContext {
  tools: ToolRegistry;
  agent: GuardAgent;
  /** 展开 `~` 用的用户主目录（和守卫判定用的同一个） */
  homeDir: string;
  /** 运行时自动留旧版本的地方（被覆盖或删除前留一份）：算已备份 */
  backedUp?: (path: string) => boolean;
  /** 这个 agent 在做任务、项目（111 号票：判定时给了 GuardOwnWork）：另取创建时间、要删除的目录里面有什么 */
  ownWork?: boolean;
}

/**
 * 只取这些调用里路径的文件事实（在不在、是不是目录、真实路径），不取 git 状态、不扫脚本：
 * 流程规划时（58 号票）推授权项的真实路径、标出真实路径在项目之外的步骤用
 */
export function gatherFileFacts(calls: ReadonlyArray<Pick<JudgedCall, "tool" | "args">>, ctx: FactsContext): EnvironmentFacts {
  const files = fileFactsOf(calls, ctx);
  return Object.keys(files).length > 0 ? { files } : {};
}

/** 这些调用里每个路径参数（守卫的 absolutePathArgs）的文件事实 */
function fileFactsOf(calls: ReadonlyArray<Pick<JudgedCall, "tool" | "args">>, ctx: FactsContext): Record<string, FileFact> {
  const env = agentShellEnv(ctx.agent, ctx.homeDir);
  const files: Record<string, FileFact> = {};
  for (const call of calls) for (const { path: p } of absolutePathArgs(call, ctx.tools, env)) files[p] ??= fileFact(p, ctx.backedUp);
  return files;
}

/** 取这些调用要用的环境事实 */
export function gatherFacts(calls: readonly JudgedCall[], ctx: FactsContext): EnvironmentFacts {
  const env = agentShellEnv(ctx.agent, ctx.homeDir);
  const files = fileFactsOf(calls, ctx);
  const scripts: Record<string, ScriptFact> = {};
  for (const call of calls) {
    if (call.tool !== TOOL.run_script) continue;
    for (const { arg, path: p } of absolutePathArgs(call, ctx.tools, env)) {
      if (arg !== "path" || scripts[p]) continue;
      const fact = scanScript(p, typeof call.args.interpreter === "string" ? call.args.interpreter : "");
      if (fact) scripts[p] = fact;
    }
  }
  const paths = Object.keys(files);
  const facts: EnvironmentFacts = {};
  const wildcards = Object.fromEntries(paths.filter((p) => WILDCARD.test(p)).map((p) => [p, expandWildcards(p)]));
  if (Object.keys(wildcards).length > 0) facts.wildcards = wildcards;
  if (ctx.ownWork) ownWorkFacts(calls, ctx, env, files, wildcards);
  if (Object.keys(files).length > 0) facts.files = files;
  if (Object.keys(scripts).length > 0) facts.scripts = scripts;
  const repos = gitFacts(paths, files, ctx.agent);
  if (Object.keys(repos).length > 0) facts.git = repos;
  return facts;
}

/** bash 的通配符：* ? [...]（路径里有它的才展开） */
const WILDCARD = /[*?[]/;

function fileFact(p: string, backedUp: ((path: string) => boolean) | undefined): FileFact {
  const stat = statOf(p);
  const fact: FileFact = stat ? { exists: true, isDirectory: stat.isDirectory() } : { exists: false };
  const real = realPathOf(p);
  if (real !== undefined) fact.realPath = real;
  if (backedUp?.(p) && (real === undefined || backedUp(real))) fact.backedUp = true;
  return fact;
}

// ───────────────────────── 任务、项目自己的临时文件（111 号票） ─────────────────────────

/** 要删除的目录里面最多列多少项：再多就算列不全（不算任务、项目自己的临时文件，照旧要备份或提交） */
const MAX_CONTENTS = 2000;

/**
 * 认任务、项目自己的临时文件要的事实（只在这个 agent 在做任务、项目时取）：每个在的文件补上创建时间；要删除的（路径参数是删除，带通配符的按展开成的）、
 * 在工作目录里的目录，补上里面有什么；带通配符要删除的，展开成的每个现有路径也取一份文件事实
 */
function ownWorkFacts(calls: readonly JudgedCall[], ctx: FactsContext, env: ShellEnv, files: Record<string, FileFact>, wildcards: Record<string, string[]>): void {
  const roots = ctx.agent.kind === "secretary" ? [] : ctx.agent.workingDirs;
  const deleted = new Set<string>();
  for (const call of calls) {
    const descriptor = findTool(ctx.tools, call.tool);
    for (const { arg, path: p } of absolutePathArgs(call, ctx.tools, env)) {
      const rule = descriptor?.args[arg];
      if (!descriptor || !rule || pathReplacement(descriptor, rule) !== "delete") continue;
      const prefix = wildcardPrefix(p);
      const expanded = prefix === undefined ? [p] : (wildcards[p] ?? []).filter((m) => comparable(m) !== comparable(prefix));
      for (const target of expanded) deleted.add(target);
    }
  }
  for (const p of deleted) files[p] ??= fileFact(p, ctx.backedUp);
  for (const [p, fact] of Object.entries(files)) {
    if (!fact.exists) continue;
    const born = birthtimeOf(p);
    if (born !== undefined) fact.createdAt = born;
    if (fact.isDirectory && deleted.has(p) && isWithinAny(p, roots)) fact.contents = contentsOf(p);
  }
}

/** 创建时间（毫秒）；读不到、文件系统不给（0）的是 undefined */
function birthtimeOf(p: string): number | undefined {
  const born = statOf(p)?.birthtimeMs;
  return born !== undefined && born > 0 ? born : undefined;
}

/** 目录里面有什么：递归，不跟进链接（符号链接、目录联接——碰到就算列不全），最多 MAX_CONTENTS 项 */
function contentsOf(dir: string): DirContents {
  const entries: Array<{ path: string; createdAt?: number }> = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return { entries, complete: false };
    }
    for (const entry of dirents) {
      if (entry.isSymbolicLink() || entries.length >= MAX_CONTENTS) return { entries, complete: false };
      const p = path.join(current, entry.name);
      const born = birthtimeOf(p);
      entries.push(born === undefined ? { path: p } : { path: p, createdAt: born });
      if (entry.isDirectory()) pending.push(p);
    }
  }
  return { entries, complete: true };
}

function statOf(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

// ───────────────────────── git ─────────────────────────

const GIT_TIMEOUT_MS = 10_000;

function gitFacts(paths: readonly string[], files: Record<string, FileFact>, agent: GuardAgent): Record<string, GitFact> {
  if (agent.kind === "secretary") return {};
  const scope = agentScope(agent);
  const out: Record<string, GitFact> = {};
  const probed = new Set<string>();
  for (const p of paths) {
    const root = scope.find((dir) => isWithin(p, dir));
    if (!root) continue;
    const dir = files[p]?.isDirectory ? p : path.dirname(p);
    const repo = findRepo(dir, root);
    const key = repo ?? dir;
    if (probed.has(comparable(key))) continue;
    probed.add(comparable(key));
    if (!repo) {
      out[key] = { uncommittedPaths: [], repository: false };
      continue;
    }
    const fact = repoFact(repo);
    if (fact) out[repo] = fact;
  }
  return out;
}

/** 从 dir 往上找包含 .git 的目录，不出项目范围的这个根目录 */
function findRepo(dir: string, root: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (comparable(current) === comparable(root)) return undefined;
    const parent = path.dirname(current);
    if (parent === current || !isWithin(parent, root)) return undefined;
    current = parent;
  }
}

function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      // 只读地看状态，不去拿 index 的锁
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch {
    return undefined;
  }
}

function repoFact(repo: string): GitFact | undefined {
  const status = git(repo, ["status", "--porcelain=v1", "-z"]);
  if (status === undefined) return undefined;
  const uncommittedPaths: string[] = [];
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    uncommittedPaths.push(path.join(repo, entry.slice(3).replace(/\/$/, "")));
    // 改名和复制后面还跟着原来的路径
    if (code.includes("R") || code.includes("C")) {
      const from = entries[++i];
      if (from) uncommittedPaths.push(path.join(repo, from));
    }
  }
  const head = git(repo, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  return { uncommittedPaths, ...(head ? { head } : {}) };
}
