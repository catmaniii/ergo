// @i18n-ignore-file model：带类型的 bash 工具的说明、参数说明和结果给模型看（174 号票；工具的名字在守卫的工具注册表里）
// 带类型的特殊 bash 工具（规格第 9、21 节，28 号票）：维护者干开发类的活时常用的 bash 操作，参数是结构化的，
// 在 Git Bash 里、以工作目录（或建在工作目录里的 worktree）为当前目录执行，结果以结构化的形式交回模型。
// 它们是守护进程代为执行的工具（host-tools.ts），但在守卫的工具注册表里的登记是框架自带的那份（来源 typed_shell：
// 类别标签、"做完告诉我"、"只读或幂等"、要联网，见 guard/tool-registry.ts），守卫不用拆命令就知道它落在哪些类别里；
// 和通用 bash 里的同一操作同名、参数名相同（git push → git_push），时序规则、授权项对两者一视同仁。
//
// 给模型的结果：第一行一句话（聊天里的结果摘要、效果日志的效果摘要都取开头），第二行一个 JSON 对象（结构化的字段），
// 后面可能跟着差异或输出的原文。执行失败（git 出错、测试没通过、退出码非零、超时或被中止）一律按出错交回：不进效果日志。
//
// 模型给的值只经 "$@" 进脚本（runner.ts 从 stdin 送进去），不拼进脚本。项目代码本身能执行是固有缺口：提交会跑 git 钩子，
// 跑测试、构建会跑项目的脚本和 Makefile，agent 能用文件工具改它们；这里只负责分类，不额外提供隔离（守卫把写 .git/config、
// .git/hooks/ 判成"越出项目目录"）。
import { type Static, type TSchema, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, normalizeArgs, TOOL } from "../guard/index.ts";
import { installCommand, type ProjectCommand, projectCommand, type ProjectTask, PROJECT_TASKS } from "./conventions.ts";
import type { ShellRunResult } from "./runner.ts";

/** 一个会话的工具共用的：工作目录、联网开关、怎么在 Git Bash 里跑 */
export interface TypedShellContext {
  /** agent 的工作目录：仓库路径不填时取它，相对路径相对它解析（和守卫的解析一致） */
  cwd: string;
  /** 工具包的联网开关：关着时推送、建远端仓库、装依赖直接拒绝（toolsFor 关着时不给它们、守卫也拒绝，这里再挡一道） */
  network: boolean;
  /** 展开 `~` 用的用户主目录（和守卫判定用的同一个） */
  homeDir: string;
  /** 单次调用的超时：默认的（agent 管家的工具调用超时）和跑测试、构建、装依赖声明的更长的 */
  timeouts: { defaultMs: number; longMs: number };
  /** GitHub 命令行（程序和它前面的固定参数）；测试里换成假的 */
  ghCommand: readonly string[];
  /** 在 dir 里经 Git Bash 跑一段固定的脚本；值经 "$@" 传入（不上命令行） */
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

/**
 * 脚本里的 git（函数 g）：路径不加引号转义、不分页，**不跑仓库配置里的 fsmonitor**（`core.fsmonitor` 可以是一条命令，
 * git status 时就会执行；状态和差异是"只读或幂等"，不能被仓库配置变成执行命令）。所有 git 调用都经它
 */
const GIT_PRELUDE = 'g() { git -c core.fsmonitor= -c core.quotepath=false -c core.pager=cat "$@"; }\n';

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
    run: reportFailures(definition.run),
  });
  return { ...tool, descriptor };
}

/** 成功的结果 */
function output(headline: string, data: Record<string, unknown>, body?: { title: string; text: string }): HostToolOutput {
  const lines = [headline, JSON.stringify(data)];
  if (body && body.text.trim() !== "") lines.push("", `--- ${body.title} ---`, body.text.replace(/\s+$/, ""));
  return { text: lines.join("\n") };
}

/** 执行失败：按出错交回模型（不进效果日志），可以带结构化字段和输出的结尾 */
function failed(headline: string, data: Record<string, unknown> = {}, out?: string): HostToolOutput {
  return { ...output(headline, data, out === undefined ? undefined : { title: "输出", text: tail(out) }), isError: true };
}

/** 工具里任何一步失败（参数、仓库路径不对，执行没起来、超时、被中止、git 出错）就抛它，按出错交回 */
class ToolFailure extends Error {
  readonly data: Record<string, unknown>;
  readonly out: string | undefined;
  constructor(headline: string, data: Record<string, unknown> = {}, out?: string) {
    super(headline);
    this.data = data;
    this.out = out;
  }
}

/** 把工具里抛出的 ToolFailure 变成出错的结果（别的错误照常抛出：记日志，模型只看到"没做成"） */
function reportFailures<A>(fn: (args: A, call: HostToolCall) => Promise<HostToolOutput>) {
  return async (args: A, call: HostToolCall): Promise<HostToolOutput> => {
    try {
      return await fn(args, call);
    } catch (err) {
      if (err instanceof ToolFailure) return failed(err.message, err.data, err.out);
      throw err;
    }
  };
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

/**
 * 跑一段脚本（值经 "$@"）。没起来、超时、被中止时抛出：说法默认是原因本身，stopped 可以换成带上下文的
 * （跑测试那样带上命令和输出）。timeoutMs 不写是工具调用的默认超时，再加一点兜底的余量
 */
async function sh(
  ctx: TypedShellContext,
  dir: string,
  script: string,
  args: readonly string[],
  call: HostToolCall,
  options: { timeoutMs?: number; stopped?: (reason: string, run: ShellRunResult) => ToolFailure } = {},
): Promise<ShellRunResult> {
  const timeoutMs = options.timeoutMs ?? ctx.timeouts.defaultMs;
  const run = await ctx.run(dir, script, args, { timeoutMs: timeoutMs + TIMEOUT_GRACE_MS, ...(call.signal ? { signal: call.signal } : {}) });
  const reason = stoppedReason(run, timeoutMs);
  if (reason !== undefined) throw options.stopped?.(reason, run) ?? new ToolFailure(reason);
  return run;
}

/** 跑一段用到 git 的脚本（脚本里用函数 g） */
const gitScript = (ctx: TypedShellContext, dir: string, script: string, args: readonly string[], call: HostToolCall) => sh(ctx, dir, GIT_PRELUDE + script, args, call);

/** 跑一条 git；退出码非零时抛出（带输出） */
async function git(ctx: TypedShellContext, dir: string, args: readonly string[], call: HostToolCall, what: string): Promise<string> {
  const run = await gitScript(ctx, dir, 'g "$@"', args, call);
  if (run.exitCode !== 0) throw new ToolFailure(`${what}失败（退出码 ${run.exitCode}）`, {}, run.output);
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
    async run(args, call) {
      const dir = repoDir(ctx, TOOL.git_status_diff, args.repoPath);
      const paths = absolutePaths(ctx, TOOL.git_status_diff, args.paths);
      const { branch, files } = parseStatus(await git(ctx, dir, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all", "--", ...paths], call, "看状态"));
      // 有提交时和 HEAD 比（已暂存和没暂存的一起）；还没有提交时是暂存的加上没暂存的
      const diffRun = await gitScript(
        ctx,
        dir,
        'if g rev-parse --verify -q HEAD >/dev/null; then g diff --no-color --no-ext-diff HEAD -- "$@"; else g diff --no-color --no-ext-diff --cached -- "$@" && g diff --no-color --no-ext-diff -- "$@"; fi',
        paths,
        call,
      );
      if (diffRun.exitCode !== 0) return failed(`看差异失败（退出码 ${diffRun.exitCode}）`, {}, diffRun.output);
      const diffTruncated = diffRun.stdout.length > DIFF_MAX || diffRun.truncated;
      const diff = diffRun.stdout.slice(0, DIFF_MAX);
      const where = branch === null ? "（不在任何分支上）" : `分支 ${branch} 上`;
      return output(
        files.length === 0 ? `${where}没有未提交的改动` : `${where}有 ${files.length} 个文件有改动${listed(files)}`,
        { repoPath: dir, branch, files, ...(diffTruncated ? { diffTruncated: true } : {}) },
        { title: diffTruncated ? `差异（只留前 ${DIFF_MAX} 个字符）` : "差异", text: diff },
      );
    },
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
    description: "git 提交：把改动（不填路径就是全部，含新文件和删除）加进索引并提交，返回提交号和提交的文件。提交会跑仓库的 git 钩子。",
    parameters,
    async run(args, call) {
      const dir = repoDir(ctx, TOOL.git_commit, args.repoPath);
      const paths = absolutePaths(ctx, TOOL.git_commit, args.paths);
      const committed = await gitScript(
        ctx,
        dir,
        'msg=$1; shift; if [ $# -gt 0 ]; then g add -A -- "$@" && g commit -q -m "$msg" -- "$@"; else g add -A && g commit -q -m "$msg"; fi',
        [args.message, ...paths],
        call,
      );
      if (committed.exitCode !== 0) {
        const nothing = /nothing to commit|no changes added|nothing added/i.test(committed.output);
        return failed(nothing ? "没有可提交的改动" : `提交失败（退出码 ${committed.exitCode}）`, {}, committed.output);
      }
      const shown = await gitScript(ctx, dir, `printf '%s\\n' "$(g symbolic-ref --short -q HEAD)"; g show --no-color --name-status --format=%H HEAD`, [], call);
      const [branch = "", commit = "", ...rest] = shown.stdout.replace(/\r\n/g, "\n").split("\n");
      const files = parseNameStatus(rest);
      return output(`已提交 ${commit}（${files.length} 个文件${listed(files)}）`, { commit, branch: branch === "" ? null : branch, files });
    },
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
    async run(args, call) {
      const dir = repoDir(ctx, TOOL.git_merge, args.repoPath);
      const [into = "", before = ""] = (await gitScript(ctx, dir, `printf '%s\\n%s\\n' "$(g symbolic-ref --short -q HEAD)" "$(g rev-parse --verify -q HEAD)"`, [], call)).stdout.split("\n");
      if (before === "") return failed("当前分支还没有提交，不能合并");
      const intoName = into === "" ? null : into;
      const merged = await gitScript(ctx, dir, 'g merge --no-edit "$1"', [args.branch], call);
      if (merged.exitCode !== 0) {
        // 有冲突（或合并到一半出错）：列出冲突的文件，中止合并，工作目录回到合并前的状态
        const aborted = await gitScript(ctx, dir, "g diff --name-only --diff-filter=U; if g rev-parse -q --verify MERGE_HEAD >/dev/null; then g merge --abort >&2; fi", [], call);
        const conflicts = aborted.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
        if (conflicts.length === 0) return failed(`合并 ${args.branch} 失败（退出码 ${merged.exitCode}）`, { branch: args.branch }, merged.output);
        return failed(
          `合并 ${args.branch} 有冲突，已中止合并，工作目录回到了合并前的状态（${conflicts.length} 个冲突文件：${conflicts.join("、")}）`,
          { branch: args.branch, into: intoName, conflicts },
          merged.output,
        );
      }
      const [after = "", parents = "", ...changed] = (await gitScript(ctx, dir, 'g rev-parse HEAD; g rev-list --parents -n 1 HEAD; g diff --name-only "$1" HEAD', [before], call)).stdout
        .split("\n")
        .map((l) => l.trim());
      const files = changed.filter((l) => l !== "");
      if (after === before) return output(`${args.branch} 已经合并过了，没有要合并的`, { branch: args.branch, into: intoName, commit: after, files: [] });
      const fastForward = parents.split(" ").length <= 2;
      return output(
        `已把 ${args.branch} 合并进 ${intoName ?? "当前分支"}（${fastForward ? "快进到" : "合并提交"} ${after}，${files.length} 个文件${listed(files.map((path) => ({ path })))}）`,
        { branch: args.branch, into: intoName, commit: after, fastForward, files },
        { title: "输出", text: tail(merged.output) },
      );
    },
  });
}

// ───────────────────────── git 推送 ─────────────────────────

function pushTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    remote: Type.String({ pattern: NAME, description: "已配置的远端名（比如 origin）；不收网址和本机路径" }),
    branch: Type.Optional(Type.String({ pattern: "^[^-+:\\s][^:\\s]*$", description: "要推送的本地分支；不填是当前分支" })),
    force: Type.Optional(Type.Boolean({ description: "force push 一律禁止，不要写 true" })),
  });
  return typedTool(TOOL.git_push, {
    description: "git 推送：把本地分支推送到已配置的远端（用本机已登录的 git 凭据）。推送前要在这个仓库里跑过测试；force push 一律禁止。",
    parameters,
    async run(args, call) {
      if (args.force === true) return failed("force push 一律禁止，没有推送");
      needsNetwork(ctx, "推送");
      const dir = repoDir(ctx, TOOL.git_push, args.repoPath);
      // 已配置的远端和当前分支（NUL 分隔）
      const [remotes = "", current = ""] = (await gitScript(ctx, dir, `printf '%s\\0%s\\0' "$(g remote)" "$(g symbolic-ref --short -q HEAD)"`, [], call)).stdout.split("\0");
      const configured = remotes.split("\n").map((r) => r.trim()).filter((r) => r !== "");
      if (!configured.includes(args.remote)) {
        return failed(`远端 ${args.remote} 没有配置（已配置的：${configured.join("、") || "没有"}）。推送只收已配置的远端名，不收网址和本机路径`, { remote: args.remote, configured });
      }
      const branch = args.branch ?? current.trim();
      if (branch === "") return failed("当前不在任何分支上，推送时请写明分支");
      const pushed = await gitScript(ctx, dir, 'g push "$1" "refs/heads/$2:refs/heads/$2" && g rev-parse "refs/heads/$2"', [args.remote, branch], call);
      if (pushed.exitCode !== 0) return failed(`推送 ${branch} 到 ${args.remote} 失败（退出码 ${pushed.exitCode}）`, { remote: args.remote, branch }, pushed.output);
      const commit = pushed.stdout.trim().split("\n").at(-1) ?? "";
      return output(`已推送 ${branch} 到 ${args.remote}（${commit}）`, { remote: args.remote, branch, commit }, { title: "输出", text: tail(pushed.output) });
    },
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
    async run(args, call) {
      needsNetwork(ctx, "建远端仓库");
      const dir = repoDir(ctx, TOOL.create_remote_repo, args.repoPath);
      const visibility = args.visibility ?? "private";
      const argv = [...ctx.ghCommand, "repo", "create", args.name, `--${visibility}`, "--source=.", "--remote=origin", ...(args.description ? [`--description=${args.description}`] : [])];
      const created = await sh(ctx, dir, 'exec "$@"', argv, call);
      if (created.exitCode !== 0) return failed(`建远端仓库 ${args.name} 失败（退出码 ${created.exitCode}）`, { name: args.name }, created.output);
      const url = created.stdout.match(/https?:\/\/\S+/g)?.at(-1) ?? null;
      return output(`已建远端仓库 ${args.name}（${visibility}${url ? `，${url}` : ""}），加成了远端 origin`, { name: args.name, visibility, url, remote: "origin" }, { title: "输出", text: tail(created.output) });
    },
  });
}

// ───────────────────────── 跑测试、启动构建、装依赖 ─────────────────────────

/** 跑项目约定的命令：以退出码判成败，结果带退出码和输出摘要；超时、被中止同样按出错交回 */
async function runProjectCommand(ctx: TypedShellContext, dir: string, cmd: ProjectCommand, call: HostToolCall, words: { doing: string; ok: string; bad: string }): Promise<HostToolOutput> {
  const run = await sh(ctx, dir, 'exec "$@"', cmd.argv, call, {
    timeoutMs: ctx.timeouts.longMs,
    stopped: (reason, stoppedRun) => new ToolFailure(`${words.doing}${reason}（${cmd.label}）`, { command: cmd.label, exitCode: null }, stoppedRun.output),
  });
  const passed = run.exitCode === 0;
  const data = { command: cmd.label, exitCode: run.exitCode, passed };
  const headline = `${passed ? words.ok : words.bad}（${cmd.label}，退出码 ${run.exitCode}）`;
  return passed ? output(headline, data, { title: "输出", text: tail(run.output) }) : failed(headline, data, run.output);
}

function projectTool(ctx: TypedShellContext, task: ProjectTask): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    args: Type.Optional(Type.Array(Type.String(), { description: "附加参数：只有 npm 脚本收，原样交给项目自己的测试或构建工具（不经 shell 解释）" })),
  });
  const spec = PROJECT_TASKS[task];
  return typedTool(spec.tool, {
    description: spec.description,
    parameters,
    timeoutMs: ctx.timeouts.longMs,
    async run(args, call) {
      const dir = repoDir(ctx, spec.tool, args.repoPath);
      const resolved = projectCommand(dir, task, args.args ?? []);
      if ("error" in resolved) return failed(resolved.error);
      return runProjectCommand(ctx, dir, resolved, call, spec);
    },
  });
}

function installTool(ctx: TypedShellContext): HostTool {
  const parameters = Type.Object({
    repoPath: RepoPath,
    packages: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: "要加的包：注册表里的包名，可以带版本号或版本范围（不收选项、本机路径、git 网址）；不填是按项目里已有的清单装齐" }),
    ),
    dev: Type.Optional(Type.Boolean({ description: "加成开发依赖" })),
  });
  return typedTool(TOOL.install_deps, {
    description: "在工作目录里装依赖：按项目约定（package.json 按锁文件认 npm / pnpm / yarn / bun，Cargo.toml、go.mod）装进这个目录，不能全局安装。要联网。",
    parameters,
    timeoutMs: ctx.timeouts.longMs,
    async run(args, call) {
      needsNetwork(ctx, "装依赖");
      const dir = repoDir(ctx, TOOL.install_deps, args.repoPath);
      const resolved = installCommand(dir, args.packages ?? [], args.dev === true);
      if ("error" in resolved) return failed(resolved.error);
      return runProjectCommand(ctx, dir, resolved, call, { doing: "装依赖", ok: "依赖装好了", bad: "装依赖失败" });
    },
  });
}
