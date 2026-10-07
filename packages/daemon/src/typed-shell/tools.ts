// 带类型的特殊 bash 工具（规格第 9、21 节，28 号票）：维护者干开发类的活时常用的 bash 操作，参数是结构化的，
// 在 Git Bash 里、以工作目录（或建在工作目录里的 worktree）为当前目录执行，结果以结构化的形式交回模型。
// 它们是守护进程代为执行的工具（host-tools.ts），但在守卫的工具注册表里的登记是框架自带的那份（来源 typed_shell：
// 类别标签、"做完告诉我"、"只读或幂等"、要联网，见 guard/tool-registry.ts），守卫不用拆命令就知道它落在哪些类别里；
// 和通用 bash 里的同一操作同名、参数名相同（git push → git_push），时序规则、授权项对两者一视同仁。
//
// 给模型的结果：第一行一句话（聊天里的结果摘要、效果日志的效果摘要都取开头），第二行一个 JSON 对象（结构化的字段），
// 后面可能跟着差异或输出的原文。执行失败（git 出错、测试没通过、退出码非零、超时或被中止）一律按出错交回：不进效果日志。
import { type Static, type TSchema, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, normalizeArgs, TOOL } from "../guard/index.ts";
import { installCommand, type ProjectCommand, projectCommand, type ProjectTask } from "./conventions.ts";
import type { ShellRunResult } from "./runner.ts";

/** 一个会话的工具共用的：工作目录、联网开关、怎么在 Git Bash 里跑 */
export interface TypedShellContext {
  /** agent 的工作目录：仓库路径不填时取它，相对路径相对它解析（和守卫的解析一致） */
  cwd: string;
  /** 工具包的联网开关：关着时推送、建远端仓库、装依赖直接拒绝（守卫先拒绝，这里再挡一道） */
  network: boolean;
  /** 展开 `~` 用的用户主目录（和守卫判定用的同一个） */
  homeDir: string;
  /** 单次调用的超时：默认的（agent 管家的工具调用超时）和跑测试、构建、装依赖声明的更长的 */
  timeouts: { defaultMs: number; longMs: number };
  /** GitHub 命令行（程序和它前面的固定参数）；测试里换成假的 */
  ghCommand: readonly string[];
  /** 在 dir 里经 Git Bash 跑一段脚本（参数经 "$@" 传入） */
  run(dir: string, script: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ShellRunResult>;
}

/** 超时兜底：管家到点会先中止这一轮（工具随之被中止），这里再多给一点余量，管家没中止时自己结束 */
const TIMEOUT_GRACE_MS = 5_000;
/** 差异最多交回这么多字符 */
const DIFF_MAX = 60_000;
/** 输出摘要：最后这么多行、这么多字符 */
const OUTPUT_LINES = 60;
const OUTPUT_CHARS = 6_000;

/** 不以 `-` 开头（不会被当成选项）的名字：远端、分支 */
const NAME = "^[^-\\s][^\\s]*$";
const RepoPath = Type.Optional(Type.String({ description: "仓库所在的目录（工作目录或建在工作目录里的 worktree）；不填是工作目录" }));
const Paths = (what: string) => Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: what }));

/** 这个会话的八个工具 */
export function typedShellTools(ctx: TypedShellContext): HostTool[] {
  return [statusDiffTool(ctx), commitTool(ctx), mergeTool(ctx), pushTool(ctx), createRemoteRepoTool(ctx), projectTool(ctx, "test"), projectTool(ctx, "build"), installTool(ctx)];
}

// ───────────────────────── 定义一个工具 ─────────────────────────

/** 用守卫注册表里那份登记（typed_shell）定义一个代为执行的工具：中文名、只读或幂等都取自登记 */
function typedTool<S extends TSchema>(
  name: string,
  definition: { description: string; parameters: S; timeoutMs?: number; run(args: Static<S>, call: HostToolCall): Promise<HostToolOutput> },
): HostTool {
  const descriptor = findTool(BUILTIN_TOOL_REGISTRY, name);
  if (descriptor?.source !== "typed_shell") throw new Error(`${name} 不是工具注册表里登记的带类型的 bash 工具`);
  const tool = defineHostTool({
    name,
    title: descriptor.title,
    description: definition.description,
    parameters: definition.parameters,
    readOnlyOrIdempotent: descriptor.readOnlyOrIdempotent === true,
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    run: definition.run,
  });
  return { ...tool, descriptor };
}

class ToolFailure extends Error {}

/** 执行失败：按出错交回模型（不进效果日志） */
function failure(headline: string, data: Record<string, unknown> = {}, body?: { title: string; text: string }): HostToolOutput {
  return { ...output(headline, data, body), isError: true };
}

function output(headline: string, data: Record<string, unknown>, body?: { title: string; text: string }): HostToolOutput {
  const lines = [headline, JSON.stringify(data)];
  if (body && body.text.trim() !== "") lines.push("", `--- ${body.title} ---`, body.text.replace(/\s+$/, ""));
  return { text: lines.join("\n") };
}

/** 跑出错的（没起来、超时、被中止）统一的说法；正常结束的返回 undefined */
function stoppedReason(run: ShellRunResult, timeoutMs: number): string | undefined {
  if (run.stopped === "timeout") return `超过 ${minutes(timeoutMs)}没有结束，已中止`;
  if (run.stopped === "aborted") return "被中止了（这一轮被中止或超时）";
  if (run.error !== undefined) return `没能执行：${run.error}`;
  return undefined;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round((ms / 60_000) * 10) / 10} 分钟` : `${Math.round(ms / 100) / 10} 秒`);

/** 输出摘要：最后几十行 */
function tail(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  let out = lines.slice(-OUTPUT_LINES).join("\n");
  let cut = lines.length > OUTPUT_LINES;
  if (out.length > OUTPUT_CHARS) {
    out = out.slice(-OUTPUT_CHARS);
    cut = true;
  }
  return cut ? `…（只留最后一段）\n${out}` : out;
}

/** 仓库路径：和守卫一样解析（不填取工作目录，相对路径相对工作目录，Git Bash 的 /d/x 写法也认） */
function repoDir(ctx: TypedShellContext, tool: string, repoPath: string | undefined): string {
  const dir = normalizeArgs(tool, repoPath === undefined ? {} : { repoPath }, BUILTIN_TOOL_REGISTRY, { cwd: ctx.cwd, homeDir: ctx.homeDir }).repoPath;
  if (typeof dir !== "string") throw new ToolFailure(`仓库路径 ${JSON.stringify(repoPath)} 没法确定`);
  return dir;
}

/** 路径参数：同样解析成绝对路径 */
function absolutePaths(ctx: TypedShellContext, tool: string, paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const resolved = normalizeArgs(tool, { paths: [...paths] }, BUILTIN_TOOL_REGISTRY, { cwd: ctx.cwd, homeDir: ctx.homeDir }).paths;
  const list = Array.isArray(resolved) ? resolved : [];
  const bad = list.findIndex((p) => typeof p !== "string");
  if (bad >= 0 || list.length !== paths.length) throw new ToolFailure(`路径 ${JSON.stringify(paths[Math.max(bad, 0)])} 没法确定`);
  return list as string[];
}

function needsNetwork(ctx: TypedShellContext, what: string): void {
  if (!ctx.network) throw new ToolFailure(`${what}要联网，但工具包的联网开关关着。要开联网，请提交工具包变更申请`);
}

/** 跑一个工具：参数、仓库路径不对，执行没起来、超时、被中止，都按出错交回 */
function guarded<A>(fn: (args: A, call: HostToolCall) => Promise<HostToolOutput>) {
  return async (args: A, call: HostToolCall): Promise<HostToolOutput> => {
    try {
      return await fn(args, call);
    } catch (err) {
      if (err instanceof ToolFailure) return failure(err.message);
      throw err;
    }
  };
}

/** git 命令：路径不加引号转义（-c core.quotepath=false），不调外部差异程序、不分页 */
const GIT = 'git -c core.quotepath=false -c core.pager=cat';

/** 跑一段脚本；没起来、超时、被中止时抛出（按出错交回） */
async function sh(ctx: TypedShellContext, dir: string, script: string, args: readonly string[], call: HostToolCall, timeoutMs = ctx.timeouts.defaultMs): Promise<ShellRunResult> {
  const run = await ctx.run(dir, script, args, { timeoutMs: timeoutMs + TIMEOUT_GRACE_MS, ...(call.signal ? { signal: call.signal } : {}) });
  const stopped = stoppedReason(run, timeoutMs);
  if (stopped !== undefined) throw new ToolFailure(stopped);
  return run;
}

/** 跑一条 git；退出码非零时抛出（带输出） */
async function git(ctx: TypedShellContext, dir: string, args: readonly string[], call: HostToolCall, what: string): Promise<string> {
  const run = await sh(ctx, dir, `exec ${GIT} "$@"`, args, call);
  if (run.exitCode !== 0) throw new ToolFailure(`${what}失败（退出码 ${run.exitCode}）：${tail(run.output).replace(/\n/g, " ")}`);
  return run.stdout;
}

// ───────────────────────── git 状态和差异 ─────────────────────────

interface FileChange {
  path: string;
  status: string;
  /** 已暂存（加进了索引） */
  staged: boolean;
  /** 改名、复制前的路径 */
  from?: string;
}

const CHANGE_WORDS: Readonly<Record<string, string>> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };

/** git status --porcelain=v1 -z -b 的输出 → 分支和改动的文件 */
function parseStatus(text: string): { branch: string | null; files: FileChange[] } {
  const entries = text.split("\0");
  let branch: string | null = null;
  const files: FileChange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startsWith("## ")) {
      const head = entry.slice(3).replace(/^No commits yet on /, "").replace(/^Initial commit on /, "");
      branch = head.startsWith("HEAD (no branch)") ? null : head.split("...")[0]!.split(" ")[0]!;
      continue;
    }
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const file: FileChange = { path: entry.slice(3), status: "", staged: x !== " " && x !== "?" && x !== "!" };
    if (x === "!") continue;
    if (x === "?") file.status = "untracked";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) file.status = "conflicted";
    else file.status = CHANGE_WORDS[y !== " " ? y : x] ?? "changed";
    if (x === "R" || x === "C") file.from = entries[++i] ?? "";
    files.push(file);
  }
  return { branch, files };
}

const listed = (files: readonly { path: string }[], max = 5) =>
  files.length === 0 ? "" : `：${files.slice(0, max).map((f) => f.path).join("、")}${files.length > max ? "……" : ""}`;

function statusDiffTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({ repoPath: RepoPath, paths: Paths("只看这些路径（不填看整个仓库）") });
  return typedTool(TOOL.git_status_diff, {
    description: "看 git 仓库的状态和差异（只读）：当前分支、改动的文件（含未跟踪的）、和最新提交相比的差异。",
    parameters,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      const dir = repoDir(ctx, TOOL.git_status_diff, args.repoPath);
      const paths = absolutePaths(ctx, TOOL.git_status_diff, args.paths);
      const { branch, files } = parseStatus(await git(ctx, dir, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all", "--", ...paths], call, "看状态"));
      // 有提交时和 HEAD 比（已暂存和没暂存的一起）；还没有提交时是暂存的加上没暂存的
      const diffRun = await sh(
        ctx,
        dir,
        `D="${GIT} diff --no-color --no-ext-diff"; if git rev-parse --verify -q HEAD >/dev/null; then exec $D HEAD -- "$@"; else $D --cached -- "$@" && exec $D -- "$@"; fi`,
        paths,
        call,
      );
      if (diffRun.exitCode !== 0) return failure(`看差异失败（退出码 ${diffRun.exitCode}）`, {}, { title: "输出", text: tail(diffRun.output) });
      const diffTruncated = diffRun.stdout.length > DIFF_MAX || diffRun.truncated;
      const diff = diffRun.stdout.slice(0, DIFF_MAX);
      const where = branch === null ? "（不在任何分支上）" : `分支 ${branch} 上`;
      return output(
        files.length === 0 ? `${where}没有未提交的改动` : `${where}有 ${files.length} 个文件有改动${listed(files)}`,
        { repoPath: dir, branch, files, ...(diffTruncated ? { diffTruncated: true } : {}) },
        { title: diffTruncated ? `差异（只留前 ${DIFF_MAX} 个字符）` : "差异", text: diff },
      );
    }),
  });
}

// ───────────────────────── git 提交 ─────────────────────────

/** 一次提交里的文件 */
interface CommittedFile {
  path: string;
  status: string;
  from?: string;
}

/** git show --name-status 的文件行 → 文件和改动 */
function parseNameStatus(lines: readonly string[]): CommittedFile[] {
  return lines
    .filter((l) => l.includes("\t"))
    .map((l) => {
      const [code = "", a = "", b] = l.split("\t");
      const status = CHANGE_WORDS[code[0] ?? ""] ?? "changed";
      return b === undefined ? { path: a, status } : { path: b, status, from: a };
    });
}

function commitTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    message: Type.String({ minLength: 1, description: "提交说明" }),
    paths: Paths("只提交这些路径（不填提交全部改动，含新文件和删除）"),
  });
  return typedTool(TOOL.git_commit, {
    description: "git 提交：把改动（不填路径就是全部，含新文件和删除）加进索引并提交，返回提交号和提交的文件。",
    parameters,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      const dir = repoDir(ctx, TOOL.git_commit, args.repoPath);
      const paths = absolutePaths(ctx, TOOL.git_commit, args.paths);
      const commitRun = await sh(
        ctx,
        dir,
        `msg=$1; shift; if [ $# -gt 0 ]; then ${GIT} add -A -- "$@" && exec ${GIT} commit -q -m "$msg" -- "$@"; else ${GIT} add -A && exec ${GIT} commit -q -m "$msg"; fi`,
        [args.message, ...paths],
        call,
      );
      if (commitRun.exitCode !== 0) {
        const nothing = /nothing to commit|no changes added|nothing added/i.test(commitRun.output);
        return failure(nothing ? "没有可提交的改动" : `提交失败（退出码 ${commitRun.exitCode}）`, {}, { title: "输出", text: tail(commitRun.output) });
      }
      const shown = await sh(ctx, dir, `printf '%s\\n' "$(git symbolic-ref --short -q HEAD)"; exec ${GIT} show --no-color --name-status --format=%H HEAD`, [], call);
      const [branch = "", commit = "", ...rest] = shown.stdout.replace(/\r\n/g, "\n").split("\n");
      const files = parseNameStatus(rest);
      return output(`已提交 ${commit}（${files.length} 个文件${listed(files)}）`, { commit, branch: branch === "" ? null : branch, files });
    }),
  });
}

// ───────────────────────── git 合并 ─────────────────────────

function mergeTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    branch: Type.String({ pattern: NAME, description: "要合并进来的分支（比如子 agent 在 worktree 里的分支）" }),
  });
  return typedTool(TOOL.git_merge, {
    description: "git 合并：把指定分支合并进当前分支。有冲突时自动中止合并、工作目录回到合并前的状态，结果里列出冲突的文件。",
    parameters,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      const dir = repoDir(ctx, TOOL.git_merge, args.repoPath);
      const [into = "", before = ""] = (await sh(ctx, dir, `printf '%s\\n%s\\n' "$(git symbolic-ref --short -q HEAD)" "$(git rev-parse --verify -q HEAD)"`, [], call)).stdout.split("\n");
      if (before === "") return failure("当前分支还没有提交，不能合并");
      const merged = await sh(ctx, dir, `exec ${GIT} merge --no-edit "$1"`, [args.branch], call);
      if (merged.exitCode !== 0) {
        // 有冲突（或合并到一半出错）：列出冲突的文件，中止合并，工作目录回到合并前的状态
        const aborted = await sh(
          ctx,
          dir,
          `${GIT} diff --name-only --diff-filter=U; if git rev-parse -q --verify MERGE_HEAD >/dev/null; then ${GIT} merge --abort >&2; fi`,
          [],
          call,
        );
        const conflicts = aborted.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
        if (conflicts.length > 0) {
          return failure(
            `合并 ${args.branch} 有冲突，已中止合并，工作目录回到了合并前的状态（${conflicts.length} 个冲突文件：${conflicts.join("、")}）`,
            { branch: args.branch, into: into === "" ? null : into, conflicts },
            { title: "输出", text: tail(merged.output) },
          );
        }
        return failure(`合并 ${args.branch} 失败（退出码 ${merged.exitCode}）`, { branch: args.branch }, { title: "输出", text: tail(merged.output) });
      }
      const [after = "", parents = "", ...changed] = (
        await sh(ctx, dir, `git rev-parse HEAD; git rev-list --parents -n 1 HEAD; exec ${GIT} diff --name-only "$1" HEAD`, [before], call)
      ).stdout
        .split("\n")
        .map((l) => l.trim());
      const files = changed.filter((l) => l !== "");
      if (after === before) return output(`${args.branch} 已经合并过了，没有要合并的`, { branch: args.branch, into, commit: after, files: [] });
      const fastForward = parents.split(" ").length <= 2;
      return output(
        `已把 ${args.branch} 合并进 ${into === "" ? "当前分支" : into}（${fastForward ? "快进到" : "合并提交"} ${after}，${files.length} 个文件${listed(files.map((path) => ({ path })))}）`,
        { branch: args.branch, into: into === "" ? null : into, commit: after, fastForward, files },
        { title: "输出", text: tail(merged.output) },
      );
    }),
  });
}

// ───────────────────────── git 推送 ─────────────────────────

function pushTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    remote: Type.String({ pattern: NAME, description: "远端名（比如 origin）" }),
    branch: Type.Optional(Type.String({ pattern: "^[^-+:\\s][^:\\s]*$", description: "要推送的本地分支；不填是当前分支" })),
    force: Type.Optional(Type.Boolean({ description: "force push 一律禁止，不要写 true" })),
  });
  return typedTool(TOOL.git_push, {
    description: "git 推送：把本地分支推送到远端（用本机已登录的 git 凭据）。推送前要在这个仓库里跑过测试；force push 一律禁止。",
    parameters,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      if (args.force === true) return failure("force push 一律禁止，没有推送");
      needsNetwork(ctx, "推送");
      const dir = repoDir(ctx, TOOL.git_push, args.repoPath);
      const branch = args.branch ?? (await git(ctx, dir, ["symbolic-ref", "--short", "-q", "HEAD"], call, "取当前分支")).trim();
      if (branch === "") return failure("当前不在任何分支上，推送时请写明分支");
      const pushed = await sh(ctx, dir, `${GIT} push "$1" "refs/heads/$2:refs/heads/$2" && exec git rev-parse "refs/heads/$2"`, [args.remote, branch], call);
      if (pushed.exitCode !== 0) return failure(`推送 ${branch} 到 ${args.remote} 失败（退出码 ${pushed.exitCode}）`, { remote: args.remote, branch }, { title: "输出", text: tail(pushed.output) });
      const commit = pushed.stdout.trim().split("\n").at(-1) ?? "";
      return output(`已推送 ${branch} 到 ${args.remote}（${commit}）`, { remote: args.remote, branch, commit }, { title: "输出", text: tail(pushed.output) });
    }),
  });
}

// ───────────────────────── 建远端仓库 ─────────────────────────

function createRemoteRepoTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    name: Type.String({ pattern: "^[A-Za-z0-9_.][A-Za-z0-9_.-]*(/[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$", description: "仓库名（或 所有者/仓库名）" }),
    visibility: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("public"), Type.Literal("internal")], { description: "可见性，不填是 private" })),
    description: Type.Optional(Type.String({ description: "仓库的一句话说明" })),
  });
  return typedTool(TOOL.create_remote_repo, {
    description: "建远端仓库：用本机已登录的 GitHub 命令行在 GitHub 上建一个仓库，并把它加成这个本地仓库的远端 origin（不推送）。",
    parameters,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      needsNetwork(ctx, "建远端仓库");
      const dir = repoDir(ctx, TOOL.create_remote_repo, args.repoPath);
      const visibility = args.visibility ?? "private";
      const argv = [...ctx.ghCommand, "repo", "create", args.name, `--${visibility}`, "--source=.", "--remote=origin", ...(args.description ? [`--description=${args.description}`] : [])];
      const created = await sh(ctx, dir, 'exec "$@"', argv, call);
      if (created.exitCode !== 0) return failure(`建远端仓库 ${args.name} 失败（退出码 ${created.exitCode}）`, { name: args.name }, { title: "输出", text: tail(created.output) });
      const url = created.stdout.match(/https?:\/\/\S+/g)?.at(-1) ?? null;
      return output(`已建远端仓库 ${args.name}（${visibility}${url ? `，${url}` : ""}），加成了远端 origin`, { name: args.name, visibility, url, remote: "origin" }, { title: "输出", text: tail(created.output) });
    }),
  });
}

// ───────────────────────── 跑测试、启动构建 ─────────────────────────

const PROJECT_WORDS: Readonly<Record<ProjectTask, { ok: string; bad: string; what: string }>> = {
  test: { ok: "测试通过", bad: "测试没通过", what: "跑测试" },
  build: { ok: "构建成功", bad: "构建失败", what: "构建" },
};

function projectTool(ctx: TypedShellContext, task: ProjectTask): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    args: Type.Optional(Type.Array(Type.String(), { description: "附加参数（原样交给测试或构建脚本，不经 shell 解释）" })),
  });
  const words = PROJECT_WORDS[task];
  return typedTool(task === "test" ? TOOL.run_tests : TOOL.start_build, {
    description:
      task === "test"
        ? "跑测试：按工作目录里已有的项目约定跑（package.json 的 test 脚本、Makefile 的 test 目标、cargo test、go test），只能传附加参数。返回退出码和输出摘要；退出码非零算没通过。"
        : "启动构建：按工作目录里已有的项目约定构建（package.json 的 build 脚本、Makefile 的 build 目标、cargo build、go build），只能传附加参数。返回退出码和输出摘要。",
    parameters,
    timeoutMs: ctx.timeouts.longMs,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      const dir = repoDir(ctx, task === "test" ? TOOL.run_tests : TOOL.start_build, args.repoPath);
      const resolved = projectCommand(dir, task, args.args ?? []);
      if ("error" in resolved) return failure(resolved.error);
      return runProjectCommand(ctx, dir, resolved, call, words);
    }),
  });
}

async function runProjectCommand(ctx: TypedShellContext, dir: string, cmd: ProjectCommand, call: HostToolCall, words: { ok: string; bad: string; what: string }): Promise<HostToolOutput> {
  const run = await ctx.run(dir, 'exec "$@"', cmd.argv, { timeoutMs: ctx.timeouts.longMs + TIMEOUT_GRACE_MS, ...(call.signal ? { signal: call.signal } : {}) });
  const stopped = stoppedReason(run, ctx.timeouts.longMs);
  if (stopped !== undefined) return failure(`${words.what}${stopped}（${cmd.label}）`, { command: cmd.label, exitCode: null }, { title: "输出", text: tail(run.output) });
  const passed = run.exitCode === 0;
  const data = { command: cmd.label, exitCode: run.exitCode, passed };
  const headline = `${passed ? words.ok : words.bad}（${cmd.label}，退出码 ${run.exitCode}）`;
  return passed ? output(headline, data, { title: "输出", text: tail(run.output) }) : failure(headline, data, { title: "输出", text: tail(run.output) });
}

// ───────────────────────── 在工作目录里装依赖 ─────────────────────────

function installTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    packages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "要加的包（只写包名，不写选项）；不填是按项目里已有的清单装齐" })),
    dev: Type.Optional(Type.Boolean({ description: "加成开发依赖" })),
  });
  return typedTool(TOOL.install_deps, {
    description: "在工作目录里装依赖：按项目约定（package.json 按锁文件认 npm / pnpm / yarn / bun，Cargo.toml、go.mod）装进这个目录，不能全局安装。要联网。",
    parameters,
    timeoutMs: ctx.timeouts.longMs,
    run: guarded(async (args: Static<typeof parameters>, call) => {
      needsNetwork(ctx, "装依赖");
      const dir = repoDir(ctx, TOOL.install_deps, args.repoPath);
      const resolved = installCommand(dir, args.packages ?? [], args.dev === true);
      if ("error" in resolved) return failure(resolved.error);
      return runProjectCommand(ctx, dir, resolved, call, { ok: "依赖装好了", bad: "装依赖失败", what: "装依赖" });
    }),
  });
}
