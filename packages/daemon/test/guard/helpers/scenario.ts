// 守卫切面的场景文件（`test/guard/scenarios/*.guard.json`）：一串调用逐步判定。
//
// 格式和 AgentSense planguard 兼容：一份文件 = planguard 场景（id、name、tools、rules）+ 一个 runtime 用例（calls）。
// - tools：`tools.<工具>.args.<参数>` 照 planguard 写（pattern、type、list），可以再加二狗工具注册表的字段
//   （title、categories、bottomLines、notifyWhenDone、readOnlyOrIdempotent、network、outbound，参数上的 kind、access），
//   登记成 MCP 工具；
// - rules：planguard 规则，原样交给判定函数的 temporalRules（v1 模板不用写，默认生效；阶段和阶段组上的规则写在
//   context.task.plan 的 stages、stageGroups 里）。场景文件里的规则先要通过规则校验；
// - facts：每一步都带上的环境事实（和那一步自己的 facts 合并）。planguard 场景里的领域事实（通讯录、文档……）放在 facts.extra；
// - calls：每一步 `{ tool, args, commit?, expect }`。commit 照 planguard：这一步算不算执行成功、进效果日志；
//   不写时按判定（直接做、做完告诉我的进，其余不进）。进效果日志的是规范化之后的参数（effectRecordsFor）。
// - context（二狗自己的）：agent、task、settings、now；每一步还可以写 facts、at（时间）、stage（切到哪个阶段）。
//
// expect 里能写：
// - hardRefusal：生效的硬拒绝原因（如 ["fence"]），没有硬拒绝写 null；disposition：六档之一；
// - verdict：planguard 的三值（allow = 没有硬拒绝、直接做或做完告诉我，confirm = 先问，block = 硬拒绝、永不、交给我做）；
// - categories、genericShell、withinGrant、rules（命中的时序规则 id）、explanation（正则）；
// - kinds：planguard 的写法，只比 `rule:<id>`（违反）和 `rule_unknown:<id>`（判断不了）。
//
// 路径用占位符写，跑的时候换成虚构的固定路径：${workDir}、${records}、${scratch}、${dataDir}、${config}、
// ${secrets}、${db}、${projects}、${programDir}、${home}、${outside}。
import fs from "node:fs";
import path from "node:path";
import {
  effectRecordsFor,
  judgementExecutes,
  judgeToolCall,
  registerTools,
  validateTemporalRules,
  BUILTIN_TOOL_REGISTRY,
  type ArgRule,
  type Disposition,
  type EffectRecord,
  type EnvironmentFacts,
  type GuardAgent,
  type GuardJudgement,
  type GuardTask,
  type HardRefusalId,
  type TemporalRule,
  type ToolDescriptor,
  type WatchCategorySettings,
} from "../../../src/guard/index.ts";
import { executingAgent, inChat, P, secretary, task as defaultTask } from "./guard-input.ts";

export interface GuardScenario {
  id: string;
  name: string;
  context?: {
    agent?: Partial<GuardAgent> & { kind: GuardAgent["kind"] };
    task?: (Partial<GuardTask> & { plan?: Partial<GuardTask["plan"]> }) | null;
    settings?: WatchCategorySettings;
    now?: string;
  };
  tools?: Record<string, Partial<Omit<ToolDescriptor, "args" | "name">> & { args?: Record<string, Partial<ArgRule>> }>;
  rules?: TemporalRule[];
  facts?: EnvironmentFacts;
  calls: ScenarioCall[];
}

export interface ScenarioCall {
  tool: string;
  args?: Record<string, unknown>;
  facts?: EnvironmentFacts;
  at?: string;
  stage?: string;
  commit?: boolean;
  expect: {
    hardRefusal?: HardRefusalId[] | null;
    disposition?: Disposition;
    verdict?: "allow" | "confirm" | "block";
    categories?: string[];
    genericShell?: boolean;
    withinGrant?: boolean;
    rules?: string[];
    kinds?: string[];
    explanation?: string;
  };
}

const PLACEHOLDERS: Record<string, string> = {
  workDir: P.workDir,
  records: P.records,
  scratch: P.scratch,
  dataDir: P.dataDir,
  config: P.config,
  secrets: P.secrets,
  db: P.db,
  projects: P.projects,
  programDir: P.programDir,
  home: P.home,
  outside: P.outside,
};

/** 读一个目录下的全部场景文件，占位符换成固定路径 */
export function loadScenarios(dir: string): { file: string; scenario: GuardScenario }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".guard.json"))
    .toSorted()
    .map((file) => ({ file, scenario: substitute(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) as GuardScenario }));
}

function substitute(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (m, name: string) => {
      if (!Object.hasOwn(PLACEHOLDERS, name)) throw new Error(`场景文件里不认识的占位符 ${m}`);
      return PLACEHOLDERS[name]!;
    });
  }
  if (Array.isArray(value)) return value.map(substitute);
  // 键也换：环境事实按路径做键
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k), substitute(v)]));
  return value;
}

/** 场景文件里的规则过一遍规则校验（工具按场景登记的算，额外的环境事实按 facts.extra 的键算） */
export function scenarioRuleProblems(scenario: GuardScenario): string[] {
  const tools = registerTools(BUILTIN_TOOL_REGISTRY, ...Object.entries(scenario.tools ?? {}).map(([name, t]) => toDescriptor(name, t)));
  const stages = [...(scenario.context?.task?.plan?.stages ?? []), ...(scenario.context?.task?.plan?.stageGroups ?? [])];
  const rules = [...(scenario.rules ?? []), ...stages.flatMap((s) => s.temporalRules ?? [])];
  return validateTemporalRules(rules, { tools, facts: Object.keys(scenario.facts?.extra ?? {}) }).problems;
}

/** 场景的环境事实和这一步的合并（这一步的优先） */
function mergeFacts(base: EnvironmentFacts, step: EnvironmentFacts): EnvironmentFacts {
  return {
    files: { ...base.files, ...step.files },
    git: { ...base.git, ...step.git },
    scripts: { ...base.scripts, ...step.scripts },
    extra: { ...base.extra, ...step.extra },
  };
}

/** 逐步判定，返回和期望不符的地方（空表示全部符合） */
export function runScenario(scenario: GuardScenario): string[] {
  const problems: string[] = [];
  const ctx = scenario.context ?? {};
  const agent = buildAgent(ctx.agent);
  let task: GuardTask | null =
    ctx.task === null || ctx.task === undefined
      ? null
      : defaultTask({ ...ctx.task, plan: { grants: [], ...ctx.task.plan } });
  const tools = registerTools(BUILTIN_TOOL_REGISTRY, ...Object.entries(scenario.tools ?? {}).map(([name, t]) => toDescriptor(name, t)));
  const startNow = ctx.now ? Date.parse(ctx.now) : undefined;
  const effectLog: EffectRecord[] = [];

  scenario.calls.forEach((step, i) => {
    if (step.stage && task) task = { ...task, currentStageId: step.stage };
    const now = step.at ? Date.parse(step.at) : startNow;
    const input = inChat(agent, { toolName: step.tool, args: step.args ?? {} }, {
      task,
      tools,
      effectLog: [...effectLog],
      settings: ctx.settings ?? {},
      facts: mergeFacts(scenario.facts ?? {}, step.facts ?? {}),
      temporalRules: scenario.rules ?? [],
      ...(now !== undefined ? { now } : {}),
    });
    const j = judgeToolCall(input);
    const where = `第 ${i + 1} 步 ${step.tool}${step.args?.command ? `「${String(step.args.command)}」` : ""}`;
    const e = step.expect;
    const check = (field: string, got: unknown, want: unknown) => {
      if (want !== undefined && JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${where}：${field} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}（${j.explanation}）`);
    };
    check("hardRefusal", j.hardRefusal, e.hardRefusal);
    check("disposition", j.disposition, e.disposition);
    check("verdict", verdictOf(j), e.verdict);
    check("categories", j.categories.toSorted(), e.categories ? e.categories.toSorted() : undefined);
    check("genericShell", j.genericShell, e.genericShell);
    check("withinGrant", j.withinGrant, e.withinGrant);
    check("rules", j.temporalRules.map((r) => r.ruleId).toSorted(), e.rules ? e.rules.toSorted() : undefined);
    check(
      "kinds",
      j.temporalRules.map((r) => `${r.status === "violated" ? "rule" : "rule_unknown"}:${r.ruleId}`).toSorted(),
      e.kinds ? e.kinds.toSorted() : undefined,
    );
    if (e.explanation !== undefined && !new RegExp(e.explanation).test(j.explanation)) {
      problems.push(`${where}：说明里没有 /${e.explanation}/（${j.explanation}）`);
    }
    // 执行成功的调用进效果日志（真实工具调用记它自己，通用 bash 记拆出来的每条伪工具调用；参数是规范化之后的）
    if (step.commit ?? judgementExecutes(j)) effectLog.push(...effectRecordsFor(input, j, { firstSeq: effectLog.length + 1, at: input.now }));
  });
  return problems;
}

/** planguard 的三值 */
export function verdictOf(j: GuardJudgement): "allow" | "confirm" | "block" {
  if (judgementExecutes(j)) return "allow";
  if (j.hardRefusal === null && j.disposition === "ask_first") return "confirm";
  return "block";
}

function buildAgent(spec: (Partial<GuardAgent> & { kind: GuardAgent["kind"] }) | undefined): GuardAgent {
  if (!spec || spec.kind === "maintainer" || spec.kind === "sub_agent") return executingAgent(spec?.kind ?? "maintainer", spec as object);
  return secretary(spec as object);
}

function toDescriptor(name: string, t: NonNullable<GuardScenario["tools"]>[string]): ToolDescriptor {
  const args: Record<string, ArgRule> = {};
  for (const [arg, rule] of Object.entries(t.args ?? {})) args[arg] = { kind: "other", ...rule };
  return {
    title: name,
    source: "mcp",
    categories: [],
    ...t,
    name,
    args,
  };
}
