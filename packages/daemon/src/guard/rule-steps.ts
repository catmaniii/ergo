// 时序规则看到的"一步"：一次调用（这次要判定的，或效果日志里执行成功过的）规范化之后的样子，
// 再加上几项由参数和环境事实推出来的字段。规则只认工具名和参数，参数名统一：
// - 参数名照工具注册表。带类型的工具和从通用 bash 拆出的伪工具同名、参数名相同（03 号票），
//   所以 `git_push {remote: "origin"}` 和 bash 里的 `git push origin main` 规范化成同一种形式；
// - 路径参数解析成绝对路径（Windows 语义），不填且登记为默认取工作目录的，取工作目录；
// - HTTP 方法转大写；登记了 pattern / type 的参数照 planguard 检查，不符合的换成"未知"；
// - 推送补上当时 HEAD 的提交号（headCommit，从环境事实的 git 状态取，取不到是"未知"）；
// - 没法确定的值（含变量的路径、不符合规则的参数）是"未知"，规则用到它时判断不了，先问用户；
// - 空值（null、undefined）的参数去掉。
//
// 规范化是幂等的：效果日志里存的就是规范化之后的参数（"未知"存成 `{"$unknown": 原值}`），读回来再规范化一遍不变。
import { agentScope, comparable, isWindowsAbsolutePath, isWithin, isWithinAny, resolveAgentPath, type ShellEnv } from "./paths.ts";
import { MISSING, Unknown, canonical, isUnknown } from "./planguard/expr.ts";
import { normalizeValue } from "./planguard/spec.ts";
import { isSecretFile } from "./secret-files.ts";
import { outboundTextOf, secretsIn, textOf } from "./secrets.ts";
import {
  argEntriesOf,
  carriesPayload,
  findTool,
  isReadOnlyRequest,
  pathReplacement,
  TOOL,
  usesNetwork,
  type ArgRule,
  type PathAccess,
  type ToolDescriptor,
  type ToolRegistry,
} from "./tool-registry.ts";
import type { EnvironmentFacts, FileFact, GitFact, GuardAgent, JudgedCall } from "./types.ts";

// ───────────────────────── 参数规范化 ─────────────────────────

/**
 * 把一次调用的参数规范化（不改动传入的对象）。给了环境事实时，推送补上 headCommit（已经有的不动，效果日志里的保持原样）。
 */
export function normalizeArgs(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  tools: ToolRegistry,
  env: ShellEnv,
  facts?: EnvironmentFacts,
): Record<string, unknown> {
  const descriptor = findTool(tools, tool);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const rule = descriptor?.args[name];
    out[name] = rule ? normalizeArg(value, rule, env) : value;
  }
  for (const [name, rule] of Object.entries(descriptor?.args ?? {})) {
    if (rule.kind === "path" && rule.defaultsToCwd && !Object.hasOwn(out, name)) out[name] = normalizePath(".", env);
  }
  if (tool === TOOL.git_push && facts && !Object.hasOwn(out, "headCommit")) {
    const repo = out.repoPath;
    const head = typeof repo === "string" ? gitFactOf(facts, repo)?.[1].head : undefined;
    out.headCommit = head ?? new Unknown("推送的提交");
  }
  return out;
}

/**
 * 一次调用里的路径参数：参数名和规范化后的路径（默认取工作目录的也算）。只要盘符或 UNC 开头的绝对路径
 * （/dev/null 这类伪设备、没法确定的不算）。调用方按它现取文件事实（guard-runtime/facts.ts）、标出真实路径在项目之外的步骤
 */
export function absolutePathArgs(call: Pick<JudgedCall, "tool" | "args">, tools: ToolRegistry, env: ShellEnv): Array<{ arg: string; path: string }> {
  const descriptor = findTool(tools, call.tool);
  if (!descriptor) return [];
  const normalized = normalizeArgs(call.tool, call.args, tools, env);
  const out: Array<{ arg: string; path: string }> = [];
  for (const [arg, rule] of Object.entries(descriptor.args)) {
    if (rule.kind !== "path") continue;
    const value = normalized[arg];
    for (const p of Array.isArray(value) ? value : [value]) if (typeof p === "string" && isWindowsAbsolutePath(p)) out.push({ arg, path: p });
  }
  return out;
}

/**
 * 这些调用会删除或整体重写哪些路径（按 pathReplacement 认；整体重写的不论现在在不在都列上）：规范化后的绝对路径。
 * 运行时据此在放行之前给项目档案留旧版本（15 号票）
 */
export function replacedPaths(calls: ReadonlyArray<Pick<JudgedCall, "tool" | "args">>, tools: ToolRegistry, env: ShellEnv): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const descriptor = findTool(tools, call.tool);
    if (!descriptor) continue;
    const normalized = normalizeArgs(call.tool, call.args, tools, env);
    for (const [name, rule] of Object.entries(descriptor.args)) {
      if (pathReplacement(descriptor, rule) === undefined) continue;
      const value = normalized[name];
      for (const p of Array.isArray(value) ? value : [value]) if (typeof p === "string" && resolveAgentPath(p, env).kind === "absolute") out.push(p);
    }
  }
  return out;
}

function normalizeArg(value: unknown, rule: ArgRule, env: ShellEnv): unknown {
  if (isUnknown(value)) return value;
  if (rule.kind === "path") return Array.isArray(value) ? value.map((v) => normalizePath(v, env)) : normalizePath(value, env);
  if (rule.kind === "http_method") return typeof value === "string" ? value.toUpperCase() : new Unknown(value);
  if (rule.type === "boolean") return typeof value === "boolean" ? value : new Unknown(value);
  if (rule.type === "array") return Array.isArray(value) ? value : new Unknown(value);
  if (rule.type !== undefined || rule.pattern !== undefined) return normalizeValue(value, { type: rule.type, pattern: rule.pattern, list: rule.list });
  return value;
}

/** 路径：绝对路径；/dev/null 这类伪设备原样；没法确定的是"未知"（带着原文） */
function normalizePath(value: unknown, env: ShellEnv): unknown {
  if (isUnknown(value)) return value;
  if (typeof value !== "string") return new Unknown(value);
  const resolved = resolveAgentPath(value, env);
  if (resolved.kind === "absolute") return resolved.path;
  if (resolved.kind === "device") return value;
  return new Unknown(resolved.raw);
}

// ───────────────────────── 一步 ─────────────────────────

/** 规则里 `$current`、`$prior` 的字段（规则校验也认这张表） */
export const STEP_FIELDS = [
  "id",
  "tool",
  "args",
  "paths",
  "recipients",
  "content",
  "secrets",
  "sends",
  "outward",
  "origin",
  "text",
  "at",
  "taskId",
  "stageId",
  "agentId",
  "segmentId",
] as const;

/**
 * 一步里的一个路径参数（数组参数每个值一项）：
 * - access：读、写、删，或不知道；
 * - replaced：删除，或整体重写已有的文件（不知道它在不在时为"未知"）；带"删除或覆盖"标签的工具写的路径也算；
 * - area：project（项目档案和工作目录里）、scratch（秘书的草稿区里）、outside（别处）；按这次判定的 agent 算；
 * - exists、backedUp：环境事实里的文件元数据（没给 exists 时为"未知"，没给 backedUp 时为 false）；
 * - committed：已 git 提交——环境事实里有包含它的仓库、它（和它下面）没有未提交的改动；项目档案（工作目录之外的部分）
 *   不在 git 里，一律不算已提交；别处没有对应的 git 事实时为"未知"；
 * - secretFile：是不是 .env 或密钥文件；
 * - ownTemp：是不是任务、项目自己的临时文件（111 号票：判定函数按效果日志、创建时间、交付件认出来的，own-temp.ts）；
 *   v1 模板"删除或覆盖之前必须已备份或已提交"不管它。不是要判定的这次调用（效果日志里的），或者没给认法的，都是 false。
 */
export interface RulePath {
  arg: string;
  path: string | Unknown;
  access: PathAccess;
  replaced: boolean | Unknown;
  area: "project" | "scratch" | "outside" | Unknown;
  exists: boolean | Unknown;
  backedUp: boolean;
  committed: boolean | Unknown;
  secretFile: boolean | Unknown;
  ownTemp: boolean;
}

/** 推字段要用的东西：注册表、解析路径的环境、发起这次判定的 agent、环境事实，和认任务、项目自己的临时文件的函数（111 号票，可选） */
export interface RuleView {
  tools: ToolRegistry;
  env: ShellEnv;
  agent: GuardAgent;
  facts: EnvironmentFacts;
  ownTemp?: (path: string) => boolean;
}

/**
 * 一步的来源：调用本身，加上要原样带进规则的字段（origin、text，或效果日志的时间、任务、阶段、agent、会话段）。
 * unseenInput 不带进规则，只用来推 outward（bash 拆出的调用拿到了守卫看不见的输入；效果日志里也记着）
 */
export interface StepSource {
  id: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  unseenInput?: true;
  [field: string]: unknown;
}

export type RuleStep = { id: string; tool: string; args: Record<string, unknown>; [field: string]: unknown };

/**
 * 把一次调用变成规则看到的一步：规范化参数，推出
 * - paths：路径参数，见 RulePath；
 * - recipients：收件人——收件人类和网址类参数（去掉首尾空白、转小写）；对外发送却没有这两类参数的（推送、gh 评论……），
 *   用发送的目标对象（推送是仓库、远端和分支；别的是工具、工作目录和非内容参数）；
 * - content：对外内容类参数拼在一起（有"未知"时整个是"未知"；推送是 headCommit）；
 * - secrets：会联网的工具，要发出去的内容（secrets.ts 的 outboundTextOf）里的密钥：密钥形态的名字，
 *   出现了之前读过的密钥值（环境事实 secretValues）时再加一项"之前读过的密钥文件里的值"（不带值本身）；
 * - sends：会不会联网，不管方向（tool-registry.ts 的 usesNetwork）；跑脚本看环境事实里的扫描结果，没扫过的是"未知"；
 * - outward：会不会往外送，见 outward。
 * 效果日志里的调用（recorded）参数已经规范化过，不再按现在的环境事实补 headCommit（那时推送的不一定是现在的 HEAD）。
 */
export function ruleStep(view: RuleView, source: StepSource, recorded = false): RuleStep {
  const { id, tool, args, unseenInput, ...extra } = source;
  const normalized = normalizeArgs(tool, args, view.tools, view.env, recorded ? undefined : view.facts);
  const descriptor = findTool(view.tools, tool);
  const text = typeof extra.text === "string" ? extra.text : undefined;
  return {
    ...withoutUndefined(extra),
    id,
    tool,
    args: normalized,
    paths: descriptor ? rulePaths(view, descriptor, normalized) : [],
    recipients: descriptor ? recipientsOf(view, descriptor, normalized) : [],
    content: descriptor ? contentOf(descriptor, normalized) : "",
    secrets: descriptor ? secretsIn(outboundTextOf(descriptor, normalized, text), view.facts.secretValues) : [],
    sends: descriptor ? sends(view, descriptor, normalized) : false,
    outward: descriptor ? outward(view, descriptor, normalized, unseenInput) : false,
  };
}

function rulePaths(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): RulePath[] {
  const out: RulePath[] = [];
  for (const [arg, rule] of Object.entries(tool.args)) {
    if (rule.kind !== "path" || !Object.hasOwn(args, arg)) continue;
    const value = args[arg];
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === "string" && resolveAgentPath(v, view.env).kind === "device") continue;
      const access = rule.access ?? "unknown";
      const path = typeof v === "string" ? v : isUnknown(v) ? v : new Unknown(v);
      const fact = typeof path === "string" ? fileFact(view.facts, path) : undefined;
      const exists = fact?.exists ?? new Unknown("文件在不在");
      const replacement = pathReplacement(tool, rule);
      const replaced: boolean | Unknown = replacement === "overwrite" ? exists : replacement !== undefined;
      out.push({
        arg,
        path,
        access,
        replaced,
        area: areaOf(view, path),
        exists,
        backedUp: fact?.backedUp === true,
        committed: committedOf(view, path),
        secretFile: secretFileOf(view.facts, path),
        ownTemp: typeof path === "string" && view.ownTemp?.(path) === true,
      });
    }
  }
  return out;
}

/** 在哪一区：真实路径（符号链接）在别处的，算别处 */
function areaOf(view: RuleView, path: string | Unknown): RulePath["area"] {
  if (isUnknown(path)) return new Unknown("路径没法确定");
  const real = fileFact(view.facts, path)?.realPath;
  const targets = real ? [path, real] : [path];
  const inside = targets.every((t) => isWithinAny(t, agentScope(view.agent)));
  if (!inside) return "outside";
  return view.agent.kind === "secretary" ? "scratch" : "project";
}

/** 已 git 提交：找包含它的最深的仓库，它和它下面（或它所在的未跟踪目录）没有未提交的改动 */
function committedOf(view: RuleView, path: string | Unknown): boolean | Unknown {
  if (isUnknown(path)) return path;
  const found = gitFactOf(view.facts, path);
  if (!found) {
    // 项目档案（工作目录之外的部分）不在 git 里：覆盖和删除前看 backedUp（运行时会自动留旧版本，15 号票）
    const agent = view.agent;
    if (agent.kind !== "secretary" && isWithinAny(path, agent.projectRecords) && !isWithinAny(path, agent.workingDirs)) return false;
    return new Unknown("git 状态");
  }
  const fact = found[1];
  if (fact.repository === false) return false;
  return !fact.uncommittedPaths.some((u) => isWithin(u, path) || isWithin(path, u));
}

/** 包含这个路径的最深的仓库 */
function gitFactOf(facts: EnvironmentFacts, path: string): [string, GitFact] | undefined {
  let best: [string, GitFact] | undefined;
  for (const entry of Object.entries(facts.git ?? {})) {
    if (isWithin(path, entry[0]) && (!best || comparable(entry[0]).length > comparable(best[0]).length)) best = entry;
  }
  return best;
}

/** 密钥文件：路径或真实路径的文件名像；没法确定的路径，原文里看得出是密钥文件就算，否则"未知" */
function secretFileOf(facts: EnvironmentFacts, path: string | Unknown): boolean | Unknown {
  if (isUnknown(path)) return isSecretFile(textOf(path)) ? true : path;
  return isSecretFile(path) || isSecretFile(fileFact(facts, path)?.realPath ?? "");
}

function fileFact(facts: EnvironmentFacts, path: string): FileFact | undefined {
  const want = comparable(path);
  for (const [key, fact] of Object.entries(facts.files ?? {})) if (comparable(key) === want) return fact;
  return undefined;
}

/** 收件人：收件人类和网址类参数；对外发送却没有这两类参数的，用目标对象 */
function recipientsOf(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): unknown[] {
  const explicit = argEntriesOf(tool, args, ["recipient", "url"]).map(([, v]) => (typeof v === "string" ? v.trim().toLowerCase() : v));
  if (explicit.length > 0 || !usesNetwork(tool)) return explicit;
  return [sendTarget(view, tool, args)];
}

/** 发送的目标对象：推送是仓库、远端和分支；别的是工具、工作目录和非内容参数（gh 的 issue / PR 号在命令里，由内容区分） */
function sendTarget(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): string | Unknown {
  const target =
    tool.name === TOOL.git_push
      ? { tool: tool.name, repoPath: args.repoPath, remote: args.remote ?? "（默认远端）", branch: args.branch ?? "（当前分支）" }
      : {
          tool: tool.name,
          cwd: view.env.cwd,
          ...Object.fromEntries(Object.entries(args).filter(([name]) => tool.args[name]?.kind !== "content")),
        };
  if (Object.values(target).some(isUnknown)) return new Unknown("发送的目标");
  return canonical(target).toLowerCase();
}

/** 对外内容：对外内容类参数拼在一起；有"未知"时整个是"未知" */
function contentOf(tool: ToolDescriptor, args: Record<string, unknown>): string | Unknown {
  const values = argEntriesOf(tool, args, ["content"]).map(([, v]) => v);
  if (values.some(isUnknown)) return new Unknown("发送的内容");
  return values.map(textOf).join("\n");
}

/** 会不会联网（不管方向）：会联网的工具一律算；跑脚本看扫描结果（报了联网库的算，没扫过的不知道） */
function sends(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): boolean | Unknown {
  if (usesNetwork(tool)) return true;
  if (tool.name !== TOOL.run_script) return false;
  const path = args.path;
  if (typeof path !== "string") return new Unknown("脚本有没有联网");
  const want = comparable(path);
  const fact = Object.entries(view.facts.scripts ?? {}).find(([key]) => comparable(key) === want)?.[1];
  return fact ? fact.networkUsage.length > 0 : new Unknown("脚本有没有联网");
}

/**
 * 会不会往外送（v1 模板"读过密钥之后不许往外送"用，规格第 9 节）：
 * - 不会联网的：同 sends（跑脚本看扫描结果——用到联网库的看不出方向，算往外送；没扫过的"未知"；别的为 false）；
 * - 拿到了守卫看不见的输入的（bash 里管道喂来的标准输入、`$(cat .env)` 这类没法静态确定的词、xargs 补上的参数……）：
 *   守卫看不全它发了什么，true；
 * - 带了请求数据的（payload 参数有值：`curl -G -d …`、`gh api -X GET -f …`）：true；
 * - 只往下拉的：注册表标了 pullOnly 的（下载、装依赖、git pull / fetch / clone、只读的联网命令），以及只读的请求
 *   （tool-registry.ts 的 isReadOnlyRequest）：false；
 * - 其余会联网的（推送、建远端仓库、发布、发消息发邮件、连远端主机、下载并运行软件包，没标 pullOnly 的 MCP 工具……）：true。
 */
function outward(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>, unseenInput: true | undefined): boolean | Unknown {
  if (!usesNetwork(tool)) return sends(view, tool, args);
  if (unseenInput || carriesPayload(tool, args)) return true;
  return !(tool.pullOnly || isReadOnlyRequest(tool, args));
}

function withoutUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== MISSING));
}
