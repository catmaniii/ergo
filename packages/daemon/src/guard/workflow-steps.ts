// 流程的步骤在守卫眼里（58 号票，ADR 0019）：步骤里能写哪些工具、一步拆成守卫判定的哪几次调用（通用 bash 按命令拆成伪工具）、
// 按步骤推出的工具包和授权项。纯函数。
//
// 授权项（计划里列了这一步就算授权，"一次性授权"）从严推：
// - 步骤里写死的参数全部进对象范围：路径解析成绝对路径（按"在这个目录之内"匹配），别的按 content-digest.ts 的 scopeValueText 的写法；
// - 非 bash 的步骤只认步骤里写了的参数（Grant.exactArgs）：调用多带了步骤里没有的参数（比如建远端仓库多带了 visibility）就超出；
// - 通用 bash 的步骤按拆出来的伪工具各一项，再限定到这条命令本身（Grant.command：只放行从这条命令拆出来的调用）；
// - 路径按真实路径比（Grant.realScope）：规划时解析的真实路径（展开符号链接、目录联接，调用方现取的环境事实）记进授权项，
//   执行时调用里的路径的真实路径也要落在里面；规划时取不到真实路径的不发授权；
// - 对象不确定的不发授权（执行时照常按处置问用户）：参数里有没法确定的值（`$unknown`）、路径没法解析、
//   拆不开的命令（opaque_shell）、命令拿到了守卫看不见的输入（变量、命令替换、管道喂来的标准输入），
//   会联网的却说不清发给谁（收件人、网址、发送的目标没法确定），推送没写明远端和分支；
// - 次数按步骤数算：同一个工具、同样的对象范围、同一条命令在几步里出现就是几次（一步里出现几次也只算一次）。
import { scopeValueText } from "./content-digest.ts";
import { commandKey } from "./grants.ts";
import { isPlainObject, isUnknown } from "./planguard/expr.ts";
import { agentShellEnv, comparable, resolveAgentPath, type ShellEnv } from "./paths.ts";
import { ruleStep, type RuleView } from "./rule-steps.ts";
import { splitShellCommand } from "./shell/split.ts";
import { findTool, TOOL, type ToolRegistry, usesNetwork } from "./tool-registry.ts";
import type { EnvironmentFacts, GuardAgent } from "./types.ts";

/** planguard 的"未知"在 JSON 里的样子：{"$unknown": 原话} */
export function isUnknownArg(value: unknown): boolean {
  return isUnknown(value) || (isPlainObject(value) && Object.keys(value).length === 1 && "$unknown" in value);
}

/**
 * 去掉审查标成未知的参数：审查把判不了的参数写成 {"$unknown": 原话}，
 * 这个形状只有规则引擎认得，拿去给人看、给维护者照着做都是噪音
 */
export function plainArgs(args: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args ?? {})) {
    if (isUnknownArg(value)) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((v) => !isUnknownArg(v));
      if (kept.length > 0) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/**
 * 步骤里能写的工具：pi 的读写、搜索和通用 bash，带类型的 bash 工具，以及联网搜索、读网页（70 号票）。
 * 伪工具只在拆 bash 时出现，不能写进步骤
 */
export function stepToolAllowed(tools: ToolRegistry, name: string): boolean {
  const tool = findTool(tools, name);
  return tool !== undefined && (tool.source === "builtin" || tool.source === "typed_shell" || tool.source === "web");
}

/** 步骤里能写的工具的清单（按注册表的先后）：检查交来的计划、给维护者的系统提示都用它 */
export function workflowStepTools(tools: ToolRegistry): string[] {
  return Object.values(tools)
    .filter((t) => stepToolAllowed(tools, t.name))
    .map((t) => t.name);
}

/** 一步（工具和参数） */
export interface StepCall {
  tool: string;
  args: Readonly<Record<string, unknown>>;
}

/**
 * 一步拆成守卫眼里的几次调用：通用 bash 按命令拆成伪工具（text 是那一段命令原文；unseenInput 是这条命令拿到了守卫看不见的输入：
 * 管道喂来的标准输入、没法静态确定的词……），别的就是它自己
 */
export function stepCalls(step: StepCall, env: ShellEnv): { tool: string; args: Record<string, unknown>; text?: string; unseenInput?: true }[] {
  if (step.tool !== TOOL.bash) return [{ tool: step.tool, args: { ...step.args } }];
  const command = typeof step.args.command === "string" ? step.args.command : "";
  return splitShellCommand(command, env).map((c) => ({ tool: c.tool, args: c.args, text: c.text, ...(c.unseenInput ? { unseenInput: true as const } : {}) }));
}

/** 工具包按步骤推出：用到 bash 或带类型的 bash 工具才开 bash，用到要联网的（含 bash 里拆出来的联网命令）才开联网；没有 skill、MCP */
export function workflowToolkit(steps: readonly StepCall[], tools: ToolRegistry, env: ShellEnv): { skills: string[]; mcp: string[]; bash: boolean; network: boolean } {
  const bash = steps.some((s) => s.tool === TOOL.bash || findTool(tools, s.tool)?.source === "typed_shell");
  const network = steps.some((s) =>
    stepCalls(s, env).some((c) => {
      const tool = findTool(tools, c.tool);
      return tool !== undefined && usesNetwork(tool);
    }),
  );
  return { skills: [], mcp: [], bash, network };
}

/** 由步骤推出的一项授权（计划里的 id、标题由调用方给） */
export interface WorkflowGrantDraft {
  /** 用到它的步骤 */
  stepIds: string[];
  tool: string;
  scope: Record<string, string | string[]>;
  /** 路径类参数的真实路径（规划时解析）：执行时调用里的路径的真实路径也要落在里面 */
  realScope?: Record<string, string | string[]>;
  /** 次数：用到它的步骤数 */
  maxUses: number;
  /** 非 bash 的步骤：只认步骤里写了的参数 */
  exactArgs?: true;
  /** 通用 bash 的步骤：只放行从这条命令拆出来的调用 */
  command?: string;
  /** 通用 bash 的步骤：拆出来的那一段命令原文 */
  text?: string;
}

/** 推授权项要的：注册表、执行它的维护者（工作目录、围栏）、用户主目录，规划时现取的环境事实（路径的真实路径） */
export interface WorkflowGrantInput {
  tools: ToolRegistry;
  agent: GuardAgent;
  homeDir: string;
  /** 步骤里的路径现取的事实（调用方取：guard-runtime 的 gatherFileFacts）；没有某个路径的真实路径时，用到它的步骤不发授权 */
  facts?: EnvironmentFacts;
}

type Scope = Record<string, string | string[]>;

/** 一个参数值（单个或数组）写进对象范围 */
const scopeEntry = (raw: unknown, values: readonly string[]): string | string[] => (Array.isArray(raw) ? [...values] : values[0]!);

/**
 * 一次调用的对象范围（写死的参数全部进去）和路径的真实路径；对象不确定时是 undefined：有没法确定的值、路径没法解析、
 * 取不到真实路径；只认写了的参数（exact）时，伪设备路径（NUL、/dev/null）也算不确定
 */
function scopeOf(call: { tool: string; args: Readonly<Record<string, unknown>> }, input: WorkflowGrantInput, env: ShellEnv, exact: boolean): { scope: Scope; realScope: Scope } | undefined {
  const descriptor = findTool(input.tools, call.tool);
  const files = new Map(Object.entries(input.facts?.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const scope: Scope = {};
  const realScope: Scope = {};
  for (const [name, raw] of Object.entries(call.args)) {
    if (raw === undefined || raw === null) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) continue;
    if (values.some(isUnknownArg)) return undefined;
    if (descriptor?.args[name]?.kind === "path") {
      const paths: string[] = [];
      const reals: string[] = [];
      for (const v of values) {
        if (typeof v !== "string") return undefined;
        const resolved = resolveAgentPath(v, env);
        if (resolved.kind === "device" && !exact) continue;
        if (resolved.kind !== "absolute") return undefined;
        const real = files.get(comparable(resolved.path))?.realPath;
        if (real === undefined) return undefined;
        paths.push(resolved.path);
        reals.push(real);
      }
      if (paths.length > 0) {
        scope[name] = scopeEntry(raw, paths);
        realScope[name] = scopeEntry(raw, reals);
      }
      continue;
    }
    scope[name] = scopeEntry(raw, values.map(scopeValueText));
  }
  return { scope, realScope };
}

/** 这次调用的对象确不确定（不确定的不发授权，执行时照常按处置问用户） */
function objectsDefinite(view: RuleView, call: { tool: string; args: Readonly<Record<string, unknown>>; unseenInput?: true }): boolean {
  if (call.tool === TOOL.opaque_shell || call.unseenInput) return false;
  const descriptor = findTool(view.tools, call.tool);
  if (!descriptor) return false;
  const step = ruleStep(view, { id: "grant", tool: call.tool, args: call.args });
  const paths = step.paths as Array<{ path: unknown; area: unknown }>;
  if (paths.some((p) => isUnknown(p.path) || isUnknown(p.area))) return false;
  if (usesNetwork(descriptor)) {
    const recipients = step.recipients as unknown[];
    if (recipients.length === 0 || recipients.some(isUnknown)) return false;
    // 推送没写明远端和分支：推到哪儿要看当时的跟踪关系
    if (call.tool === TOOL.git_push && (typeof call.args.remote !== "string" || typeof call.args.branch !== "string")) return false;
  }
  return true;
}

/** 按步骤推出授权项（见文件开头）；同一个工具、同样的对象范围、同一条命令合成一项，次数是用到它的步骤数 */
export function workflowGrants(steps: readonly (StepCall & { id: string })[], input: WorkflowGrantInput): WorkflowGrantDraft[] {
  const env: ShellEnv = agentShellEnv(input.agent, input.homeDir);
  const view: RuleView = { tools: input.tools, env, agent: input.agent, facts: {} };
  const out: WorkflowGrantDraft[] = [];
  const keys = new Map<string, WorkflowGrantDraft>();
  for (const step of steps) {
    const command = step.tool === TOOL.bash && typeof step.args.command === "string" ? step.args.command : undefined;
    const exact = command === undefined;
    for (const call of stepCalls(step, env)) {
      if (!objectsDefinite(view, call)) continue;
      const scoped = scopeOf(call, input, env, exact);
      if (!scoped) continue;
      const { scope, realScope } = scoped;
      const key = JSON.stringify([call.tool, scope, realScope, command === undefined ? null : commandKey(command)]);
      const same = keys.get(key);
      if (same) {
        // 次数按步骤数：同一步里出现几次也只算一次
        if (!same.stepIds.includes(step.id)) {
          same.stepIds.push(step.id);
          same.maxUses += 1;
        }
        continue;
      }
      const draft: WorkflowGrantDraft = {
        stepIds: [step.id],
        tool: call.tool,
        scope,
        ...(Object.keys(realScope).length > 0 ? { realScope } : {}),
        maxUses: 1,
        ...(exact ? { exactArgs: true as const } : {}),
        ...(command === undefined ? {} : { command }),
        ...(call.text === undefined ? {} : { text: call.text }),
      };
      keys.set(key, draft);
      out.push(draft);
    }
  }
  return out;
}
