// 时序规则看到的"一步"：一次调用（这次要判定的，或效果日志里执行成功过的）规范化之后的样子，
// 再加上几项由参数和环境事实推出来的字段。规则只认工具名和参数，参数名统一：
// - 参数名照工具注册表。带类型的工具和从通用 bash 拆出的伪工具同名、参数名相同（03 号票），
//   所以 `git_push {remote: "origin"}` 和 bash 里的 `git push origin main` 规范化成同一种形式；
// - 路径参数解析成绝对路径（Windows 语义），不填且登记为默认取工作目录的，取工作目录；
// - HTTP 方法转大写；登记了 pattern / type 的参数照 planguard 检查，不符合的换成"未知"；
// - 没法确定的值（含变量的路径、不符合规则的参数）是"未知"，规则用到它时判断不了，先问用户；
// - 空值（null、undefined）的参数去掉。
//
// 规范化是幂等的：效果日志里存的就是规范化之后的参数（"未知"存成 `{"$unknown": 原值}`），读回来再规范化一遍不变。
import { findSecretShapes } from "./secrets.ts";
import { isWithin, isWithinAny, comparable, resolveAgentPath, type ShellEnv } from "./paths.ts";
import { MISSING, Unknown, isUnknown, toJson } from "./planguard/expr.ts";
import { normalizeValue } from "./planguard/spec.ts";
import { findTool, TOOL, type ArgKind, type ArgRule, type PathAccess, type ToolDescriptor, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, EnvironmentFacts, FileFact, GitFact, GuardAgent, GuardInput, GuardJudgement, JudgedCall } from "./types.ts";

// ───────────────────────── 参数规范化 ─────────────────────────

/** 把一次调用的参数规范化（不改动传入的对象） */
export function normalizeArgs(tool: string, args: Readonly<Record<string, unknown>>, tools: ToolRegistry, env: ShellEnv): Record<string, unknown> {
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

// ───────────────────────── 效果日志 ─────────────────────────

/**
 * 一次判定放行、执行成功之后，要追加进效果日志的记录（规格第 9 节的字段）。
 * 真实工具调用记它自己；通用 bash 记拆出来的每条伪工具调用。参数是规范化之后、能直接存成 JSON 的形式。
 * 被拦下或执行失败的调用不追加——由调用方（07 号票的运行时）保证只在执行成功后调用这个函数。
 */
export function effectRecordsFor(
  input: Pick<GuardInput, "agent" | "task" | "tools" | "places">,
  judgement: Pick<GuardJudgement, "calls">,
  options: { firstSeq: number; at: number; summary?: (call: JudgedCall) => string },
): EffectRecord[] {
  const env: ShellEnv = { cwd: input.agent.cwd, homeDir: input.places.homeDir };
  return judgement.calls.map((call, i) => ({
    seq: options.firstSeq + i,
    taskId: input.task?.taskId ?? null,
    stageId: input.task?.currentStageId ?? null,
    agentId: input.agent.agentId,
    tool: call.tool,
    args: toJson(normalizeArgs(call.tool, call.args, input.tools, env)) as Record<string, unknown>,
    summary: options.summary?.(call) ?? call.text ?? findTool(input.tools, call.tool)?.title ?? call.tool,
    at: options.at,
  }));
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
  "origin",
  "text",
  "at",
  "taskId",
  "stageId",
  "agentId",
] as const;

/**
 * 一步里的一个路径参数（数组参数每个值一项）：
 * - access：读、写、删，或不知道；
 * - replaced：删除，或整体重写已有的文件（不知道它在不在时为"未知"）；带"删除或覆盖"标签的工具写的路径也算；
 * - area：project（项目档案和工作目录里）、scratch（秘书的草稿区里）、outside（别处）；按这次判定的 agent 算；
 * - exists、backedUp：环境事实里的文件元数据（没给 exists 时为"未知"，没给 backedUp 时为 false）；
 * - committed：已 git 提交——环境事实里有包含它的仓库、它（和它下面）没有未提交的改动；没有对应的 git 事实时为"未知"；
 * - secretFile：是不是 .env 或密钥文件。
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
}

/** 推字段要用的东西：注册表、解析路径的环境、发起这次判定的 agent、环境事实 */
export interface RuleView {
  tools: ToolRegistry;
  env: ShellEnv;
  agent: GuardAgent;
  facts: EnvironmentFacts;
}

/** 一步的来源：调用本身，加上要原样带进规则的字段（origin、text，或效果日志的时间、任务、阶段、agent） */
export interface StepSource {
  id: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  [field: string]: unknown;
}

export type RuleStep = { id: string; tool: string; args: Record<string, unknown>; [field: string]: unknown };

/** 把一次调用变成规则看到的一步：规范化参数，推出 paths、recipients、content、secrets、sends */
export function ruleStep(view: RuleView, source: StepSource): RuleStep {
  const { id, tool, args, ...extra } = source;
  const normalized = normalizeArgs(tool, args, view.tools, view.env);
  const descriptor = findTool(view.tools, tool);
  const text = typeof extra.text === "string" ? extra.text : undefined;
  return {
    ...withoutUndefined(extra),
    id,
    tool,
    args: normalized,
    paths: descriptor ? rulePaths(view, descriptor, normalized) : [],
    recipients: descriptor ? argValues(descriptor, normalized, ["recipient", "url"]).map(normalizeRecipient) : [],
    content: descriptor ? argValues(descriptor, normalized, ["content"]).map(textOf).join("\n") : "",
    secrets: descriptor?.outbound ? findSecretShapes(outboundTextOf(descriptor, normalized, text)).map((s) => s.title) : [],
    sends: descriptor ? sends(view, descriptor, normalized) : false,
  };
}

function rulePaths(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): RulePath[] {
  const out: RulePath[] = [];
  const replacesAll = tool.categories.includes("delete_or_overwrite");
  for (const [arg, rule] of Object.entries(tool.args)) {
    if (rule.kind !== "path" || !Object.hasOwn(args, arg)) continue;
    const value = args[arg];
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === "string" && resolveAgentPath(v, view.env).kind === "device") continue;
      const access = rule.access ?? "unknown";
      const path = typeof v === "string" ? v : isUnknown(v) ? v : new Unknown(v);
      const exists = typeof path === "string" ? (fileFact(view.facts, path)?.exists ?? new Unknown("文件在不在")) : new Unknown("文件在不在");
      let replaced: boolean | Unknown = false;
      if (access === "delete" || (replacesAll && access !== "read")) replaced = true;
      else if (access === "write" && rule.replaces) replaced = exists;
      out.push({
        arg,
        path,
        access,
        replaced,
        area: areaOf(view, path),
        exists,
        backedUp: typeof path === "string" && fileFact(view.facts, path)?.backedUp === true,
        committed: committedOf(view.facts, path),
        secretFile: secretFileOf(view.facts, path),
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
  const agent = view.agent;
  if (agent.kind === "secretary") return targets.every((t) => isWithin(t, agent.scratchDir)) ? "scratch" : "outside";
  const scope = [...agent.projectRecords, ...agent.workingDirs];
  return targets.every((t) => isWithinAny(t, scope)) ? "project" : "outside";
}

/** 已 git 提交：找包含它的最深的仓库；它和它下面（或它所在的未跟踪目录）没有未提交的改动 */
function committedOf(facts: EnvironmentFacts, path: string | Unknown): boolean | Unknown {
  if (isUnknown(path)) return path;
  let best: [string, GitFact] | undefined;
  for (const entry of Object.entries(facts.git ?? {})) {
    if (isWithin(path, entry[0]) && (!best || comparable(entry[0]).length > comparable(best[0]).length)) best = entry;
  }
  if (!best) return new Unknown("git 状态");
  const fact = best[1];
  if (fact.repository === false) return false;
  return !fact.uncommittedPaths.some((u) => isWithin(u, path) || isWithin(path, u));
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

/** 联网发东西：联网的工具、会把内容发出去的工具、"以我的名义对外发送"的工具，以及环境事实里报了用到联网库的脚本 */
function sends(view: RuleView, tool: ToolDescriptor, args: Record<string, unknown>): boolean {
  if (tool.network || tool.outbound || tool.categories.includes("external_send")) return true;
  if (tool.name !== TOOL.run_script || typeof args.path !== "string") return false;
  const want = comparable(args.path);
  return Object.entries(view.facts.scripts ?? {}).some(([key, fact]) => comparable(key) === want && fact.networkUsage.length > 0);
}

// ───────────────────────── 密钥文件 ─────────────────────────

/** .env 和它的变体（.env.local、.env.production……；.env.example / .sample / .template 这类示例文件除外） */
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$)[^.]+)*$/i;
/** 密钥、证书、凭据文件 */
const KEY_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk)|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

/** 是不是 .env 或密钥文件（按文件名；`.ssh` 目录下的一律算） */
export function isSecretFile(path: string): boolean {
  if (path === "") return false;
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((p) => p.toLowerCase() === ".ssh")) return true;
  return ENV_FILE.test(name) || KEY_FILE.test(name);
}

// ───────────────────────── 小工具 ─────────────────────────

/** 某几种参数的全部值（数组展开） */
function argValues(tool: ToolDescriptor, args: Record<string, unknown>, kinds: readonly ArgKind[]): unknown[] {
  const out: unknown[] = [];
  for (const [name, rule] of Object.entries(tool.args)) {
    if (!kinds.includes(rule.kind) || !Object.hasOwn(args, name)) continue;
    const v = args[name];
    if (Array.isArray(v)) out.push(...v);
    else if (v !== undefined && v !== null) out.push(v);
  }
  return out;
}

/** 要发出去的内容：对外内容、收件人、网址类参数；从 bash 拆出的再加上那段命令原文（和底线"凭据写进对外内容"同一个口径） */
export function outboundTextOf(tool: ToolDescriptor, args: Readonly<Record<string, unknown>>, text: string | undefined): string {
  const parts = argValues(tool, args as Record<string, unknown>, ["content", "recipient", "url"]).map(textOf);
  if (text) parts.push(text);
  return parts.join("\n");
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (isUnknown(v)) return v.desc === null || v.desc === undefined ? "" : textOf(v.desc);
  return JSON.stringify(v) ?? "";
}

function normalizeRecipient(v: unknown): unknown {
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

function withoutUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== MISSING));
}
