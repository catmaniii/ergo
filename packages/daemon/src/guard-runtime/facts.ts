// 守护进程一侧现取的环境事实（规格第 9 节）：守卫的判定函数是纯函数，文件元数据、git 状态、脚本里写了什么，
// 都由这里在判定之前现取，作为 GuardInput.facts 传进去。按一次判定实际要判的调用（judgement.calls，
// 通用 bash 已拆成伪工具调用）取：
// - 每个路径参数：在不在、是不是目录、真实路径（fs.realpathSync.native：展开符号链接、目录联接和 8.3 短名；
//   还不存在的文件按最近的已有上级目录算）。项目区里的文件由运行时自动留旧版本（15 号票），算已备份；
// - 维护者和子 agent 项目里的路径：包含它的 git 仓库的未提交改动和 HEAD（v1 模板"删除或覆盖前须已提交"
//   "不重复推送"要用）；只在项目范围之内往上找仓库，项目里不在仓库里的目录写 repository: false。
//   秘书的草稿区不受 v1 模板约束，不取；
// - 要跑的脚本（run_script）：扫描出的联网库或函数（script-scan.ts）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  agentScope,
  comparable,
  type EnvironmentFacts,
  type FileFact,
  type GitFact,
  type GuardAgent,
  isWindowsAbsolutePath,
  isWithin,
  type JudgedCall,
  normalizeArgs,
  type ScriptFact,
  TOOL,
  type ToolRegistry,
} from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";
import { scanScript } from "./script-scan.ts";

export interface FactsContext {
  tools: ToolRegistry;
  agent: GuardAgent;
  /** 展开 `~` 用的用户主目录（和守卫判定用的同一个） */
  homeDir: string;
  /** 数据目录的项目区：里面的文件被覆盖或删除前运行时会自动留旧版本，算已备份 */
  projectsDir: string;
}

/** 取这些调用要用的环境事实 */
export function gatherFacts(calls: readonly JudgedCall[], ctx: FactsContext): EnvironmentFacts {
  const env = { cwd: ctx.agent.cwd, homeDir: ctx.homeDir };
  const files: Record<string, FileFact> = {};
  const scripts: Record<string, ScriptFact> = {};
  const paths: string[] = [];
  for (const call of calls) {
    const descriptor = ctx.tools[call.tool];
    if (!descriptor) continue;
    const normalized = normalizeArgs(call.tool, call.args, ctx.tools, env);
    for (const [name, rule] of Object.entries(descriptor.args)) {
      if (rule.kind !== "path") continue;
      const value = normalized[name];
      for (const p of Array.isArray(value) ? value : [value]) {
        // 盘符或 UNC 开头的绝对路径才现取（/dev/null 这类伪设备、没法确定的路径不算）
        if (typeof p !== "string" || !isWindowsAbsolutePath(p)) continue;
        paths.push(p);
        files[p] ??= fileFact(p, ctx.projectsDir);
        if (call.tool === TOOL.run_script && name === "path" && !scripts[p]) {
          const fact = scanScript(p, typeof call.args.interpreter === "string" ? call.args.interpreter : "");
          if (fact) scripts[p] = fact;
        }
      }
    }
  }
  const facts: EnvironmentFacts = {};
  if (Object.keys(files).length > 0) facts.files = files;
  if (Object.keys(scripts).length > 0) facts.scripts = scripts;
  const repos = gitFacts(paths, files, ctx.agent);
  if (Object.keys(repos).length > 0) facts.git = repos;
  return facts;
}

function fileFact(p: string, projectsDir: string): FileFact {
  const stat = statOf(p);
  const fact: FileFact = stat ? { exists: true, isDirectory: stat.isDirectory() } : { exists: false };
  const real = realPathOf(p);
  if (real !== undefined) fact.realPath = real;
  if (isWithin(p, projectsDir) || (real !== undefined && isWithin(real, projectsDir))) fact.backedUp = true;
  return fact;
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
