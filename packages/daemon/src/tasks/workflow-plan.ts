// 流程的计划（58 号票，ADR 0019；固定计划，维护者用 propose_plan 交）：
// 维护者用 propose_plan 交出步骤（每步一次工具调用：工具、参数、前置步骤）和这份计划要满足的条件（时序规则）→
// 检查（checkWorkflowDraft：步骤 id、工具、前置步骤、规则校验）→ 审查修补（guard/workflow-review.ts，planguard 的规划时审查）→
// 每一步加敏感标注（marks：按守卫的判定，落进了哪些关注类别、授权后还会不会问）和要满足的条件（conditions：触发它的规则写成人话，
// 连同审查时查出的结果）→ 交给用户授权的流程计划（WorkflowPlan）。
//
// 执行沿用长程任务的执行控制器（排队、名额、暂停、审批挂起、催促都一样）：确认的流程计划推出一份只有一个阶段（WORKFLOW_STAGE_ID）的
// 计划交给它（workflowExecutionPlan）——授权项由步骤推出（守卫的 workflowGrants：步骤里写死的参数全部进对象范围，
// 通用 bash 的步骤限定到命令本身，对象不确定的不发授权，次数按步骤数算），时序规则是计划里写的条件（框架的 v1 模板照常
// 自动加上），工具包按步骤推出（用到 bash 或带类型的 bash 工具才开 bash，用到要联网的才开联网），没有预算、不逐步验收。
// 执行时每次调用和计划逐步比对（计划外、超范围、顺序错、重复）是 59 号票。
// 事件触发的流程（77 号票）：步骤参数里可以写 {{事件.字段名}} 的占位（workflow-events.ts）——规划时不知道值，审查时当作"未知"、
// 不标敏感不发授权；每次运行代入这次事件的值之后，按执行它的维护者现取真实路径、推出授权项（boundRunWorkflow，和规划时同一套办法）。
import {
  type EventFieldDescriptor,
  type Plan,
  type PlanGrant,
  type Task,
  temporalRuleText,
  WORKFLOW_STAGE_ID,
  type WorkflowCondition,
  type WorkflowPlan,
  type WorkflowPlanDraft,
  type WorkflowStepMark,
  type WorkflowStepView,
  t,
} from "@ergo/protocol";
import { categoryTitle } from "../guard-runtime/describe.ts";
import { gatherFileFacts } from "../guard-runtime/facts.ts";
import { WIRE_DISPOSITION } from "../guard-wire/dispositions.ts";
import {
  agentShellEnv,
  absolutePathArgs,
  agentScope,
  BOTTOM_LINES,
  type BottomLineId,
  comparable,
  type EnvironmentFacts,
  type GuardAgent,
  type GuardPlaces,
  type GuardWorkflow,
  isWithin,
  judgeToolCall,
  plainArgs,
  type ReviewedStep,
  reviewWorkflow,
  type ShellEnv,
  stepCalls,
  type StepCondition,
  stepToolAllowed,
  type TemporalRule,
  type ToolRegistry,
  v1RuleTemplates,
  validateTemporalRules,
  type WatchCategorySettings,
  workflowGrants,
  workflowStepTools,
  workflowToolkit,
} from "../guard/index.ts";
import { globalWatchCategories, toGuardPlan } from "./plan.ts";
import { draftEventProblems, maskEventPlaceholders, stepEventValues, unmaskEventPlaceholders } from "./workflow-events.ts";

/**
 * 交来的流程计划对不对（不对的原因，交回维护者）：步骤 id 不重复、工具能写进步骤、前置步骤是计划里的、不成环；
 * 条件（时序规则）过规则校验（和长程任务的计划同一套）；事件的占位（77 号票）只有事件触发的流程能写，名字要是它等的事件带的字段
 * （eventFields：不是事件触发的流程不给）
 */
// @i18n-ignore-start model：交回维护者
export function checkWorkflowDraft(draft: WorkflowPlanDraft, tools: ToolRegistry, eventFields?: readonly EventFieldDescriptor[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of draft.steps) {
    if (ids.has(step.id)) problems.push(`步骤 id ${step.id} 重复`);
    ids.add(step.id);
    if (!stepToolAllowed(tools, step.tool)) problems.push(`步骤 ${step.id}：${step.tool} 不能写进步骤（能写的工具：${workflowStepTools(tools).join("、")}）`);
    if (step.tool === "bash" && typeof step.args?.command !== "string") problems.push(`步骤 ${step.id}：通用 bash 的步骤要写 args.command（要跑的命令）`);
  }
  for (const step of draft.steps) {
    for (const before of step.after ?? []) {
      if (before === step.id) problems.push(`步骤 ${step.id} 的前置步骤不能是它自己`);
      else if (!ids.has(before)) problems.push(`步骤 ${step.id} 的前置步骤 ${before} 不在计划里`);
    }
  }
  const cycle = afterCycle(draft.steps);
  if (cycle) problems.push(`前置步骤成了环：${cycle.join(" → ")}`);
  problems.push(...validateTemporalRules(draft.rules, { tools }).problems.map((p) => `条件：${p}`));
  problems.push(...draftEventProblems(draft, eventFields));
  return problems;
}
// @i18n-ignore-end

function afterCycle(steps: WorkflowPlanDraft["steps"]): string[] | undefined {
  const after = new Map(steps.map((s) => [s.id, s.after ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done" || !after.has(id)) return undefined;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const next of after.get(id)!) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return undefined;
}

/** 守卫推出的授权项写成计划里的授权项：一项一个 id（g-<第一个用到它的步骤>，同一步拆出几项的再编号），标题写明步骤 */
function planGrantsOf(steps: ReadonlyArray<{ id: string; title: string }>, drafts: ReturnType<typeof workflowGrants>): PlanGrant[] {
  const used = new Map<string, number>();
  return drafts.map((g) => {
    const first = g.stepIds[0]!;
    const n = (used.get(first) ?? 0) + 1;
    used.set(first, n);
    const titles = g.stepIds.map((id) => t("tasks.workflowPlan.stepRef", { id, title: steps.find((s) => s.id === id)?.title ?? id })).join(t("protocol.common.listSep"));
    return {
      id: n === 1 ? `g-${first}` : `g-${first}-${n}`,
      tool: g.tool,
      title: g.text ? t("tasks.workflowPlan.grantTitle", { steps: titles, text: g.text }) : titles,
      scope: g.scope,
      ...(g.realScope === undefined ? {} : { realScope: g.realScope }),
      maxUses: g.maxUses,
      ...(g.exactArgs ? { exactArgs: true as const } : {}),
      ...(g.command === undefined ? {} : { command: g.command }),
    };
  });
}

/**
 * 确认的流程计划交给执行控制器的样子：只有一个阶段（WORKFLOW_STAGE_ID），授权项由步骤推出，时序规则是计划里写的条件；
 * 定步、不逐步验收（"由维护者自报做完"只是写给人看的，执行控制器在步骤都做完或跳过时直接判这个阶段完成）、没有预算
 */
export function workflowExecutionPlan(plan: WorkflowPlan, grants: readonly PlanGrant[], settings: WatchCategorySettings): Plan {
  return {
    stages: [
      {
        stageId: WORKFLOW_STAGE_ID,
        // 流程只有这一个内部阶段，界面上不显示（显示步骤）；交给执行控制器的结构
        // @i18n-ignore-start data
        title: "按步骤执行",
        deliverables: [plan.goal],
        acceptance: [{ criterion: "每一步都做完或说明跳过（维护者用 report_step 自报；流程不逐步验收）", method: "user" }],
        // @i18n-ignore-end
        mode: "steps",
        steps: plan.steps.map((s) => `${s.id} ${s.title}`),
        dependsOn: [],
        policy: { grants: [...grants], temporalRules: [...plan.rules] },
        budget: { tokens: 0, toolCalls: 0 },
      },
    ],
    stageGroups: [],
    toolkit: { ...plan.toolkit, skills: [...plan.toolkit.skills], mcp: [...plan.toolkit.mcp] },
    projects: [],
    watchCategories: globalWatchCategories(settings).map((c) => ({ id: c.id })),
    assumptions: [],
    stops: { count: 0, where: [] },
    tokenEstimate: 0,
  };
}

/** 一条条件写成人话：触发它的工具换成这一步的工具（"git_push 之前必须已经成功做过 run_tests；违反时退回，先补上再做"） */
export function conditionText(rule: TemporalRule, stepTool: string): string {
  const trigger = typeof rule.trigger === "object" && rule.trigger !== null ? rule.trigger : {};
  return temporalRuleText({ ...rule, trigger: { ...trigger, tool: stepTool } });
}

export interface WorkflowReviewDeps {
  tools: ToolRegistry;
  settings: WatchCategorySettings;
  places: GuardPlaces;
  /** 执行这个流程的维护者：id 和工作目录（真实路径） */
  maintainerId: string;
  cwd: string;
  /** 项目的维护者（64 号票）：围栏里的项目档案（真实路径），和执行时一样；任务自己的维护者没有 */
  projectRecords?: readonly string[];
  /** 项目的维护者（64 号票）：项目的工具包，执行时的能力是它和计划推出的工具包的交集（审查时守卫眼里也取交集）；任务自己的维护者没有 */
  projectToolkit?: { bash: boolean; network: boolean };
  /** 现在（毫秒）：标注时授权项按这一刻授予 */
  now: number;
  /** 审查的计时器（不给就不计时） */
  elapsed?: () => number;
}

/** 审查修补之后、交给用户授权的流程计划，和由它推出的执行用的那份 */
export interface ReviewedWorkflow {
  plan: WorkflowPlan;
  execution: Plan;
}

/**
 * 审查修补：先审查（可能插入步骤、改写步骤、调顺序），修补后的计划才是授权对象；
 * 每一步加敏感标注和要满足的条件。退回、判定不可执行的也一样给出（调用方按 review.status 决定交不交给用户）
 */
export async function reviewWorkflowDraft(original: WorkflowPlanDraft, version: number, deps: WorkflowReviewDeps): Promise<ReviewedWorkflow> {
  const env: ShellEnv = { cwd: deps.cwd, homeDir: deps.places.homeDir };
  // 事件的占位（77 号票）：规划时不知道值，非 bash 的参数里带占位的当作"未知"交给审查（审查完换回原来写的）
  const draft: WorkflowPlanDraft = { ...original, steps: maskEventPlaceholders(original.steps) };
  // 守卫眼里执行它的维护者：工具包按交来的步骤推出（审查时路径围栏、联网开关和执行时一样）
  const draftToolkit = workflowToolkit(
    draft.steps.map((s) => ({ tool: s.tool, args: s.args ?? {} })),
    deps.tools,
    env,
  );
  // 项目的维护者（64 号票）：执行时的能力是计划推出的和项目工具包的交集，围栏里还有项目档案
  const cap = deps.projectToolkit ?? { bash: true, network: true };
  const agent = (toolkit: { bash: boolean; network: boolean }): GuardAgent => ({
    kind: "maintainer",
    agentId: deps.maintainerId,
    cwd: deps.cwd,
    toolkit: { bash: toolkit.bash && cap.bash, network: toolkit.network && cap.network },
    projectRecords: [...(deps.projectRecords ?? [])],
    workingDirs: [deps.cwd],
  });
  const rules = draft.rules as TemporalRule[];
  const reviewed = await reviewWorkflow({
    goal: draft.goal,
    steps: draft.steps,
    rules,
    tools: deps.tools,
    agent: agent(draftToolkit),
    homeDir: deps.places.homeDir,
    ...(deps.elapsed ? { elapsed: deps.elapsed } : {}),
  });
  // 修补后的计划才是授权对象：工具包、授权项按它推出（插进来的步骤也要授权）
  const toolkit = workflowToolkit(reviewed.steps, deps.tools, env);
  const executor = agent(toolkit);
  // 步骤里的路径现取文件事实（真实路径）：授权项按真实路径比，标注和"真实路径在项目之外"按它判；
  // 审查剔除的对象也取（执行时按真实路径认出它们，59 号票）
  const facts = gatherFileFacts(
    reviewed.steps.flatMap((s) => [...stepCalls(s, env), ...(s.excluded ? [{ tool: s.tool, args: s.excluded }] : [])]),
    { tools: deps.tools, agent: executor, homeDir: deps.places.homeDir },
  );
  const grants = planGrantsOf(reviewed.steps, workflowGrants(reviewed.steps, { tools: deps.tools, agent: executor, homeDir: deps.places.homeDir, facts }));
  // 标注只用真实路径和写的不一样的那些（符号链接、目录联接）：别的路径照旧不给事实——文件在不在要到执行到那一步才算数
  // （前面的步骤可能会建出它），规划时不据此去掉"可能覆盖"这类标注
  const linked: EnvironmentFacts = {
    files: Object.fromEntries(Object.entries(facts.files ?? {}).filter(([p, f]) => f.realPath !== undefined && comparable(f.realPath) !== comparable(p))),
  };
  const bare: WorkflowPlan = {
    version,
    goal: draft.goal,
    steps: [],
    rules: [...draft.rules],
    review: {
      ...reviewed.review,
      rules: reviewed.review.rules.map(({ template, ...probe }) => ({ ...probe, source: template ? ("template" as const) : ("plan" as const) })),
    },
    toolkit,
  };
  const execution = workflowExecutionPlan(bare, grants, deps.settings);
  const guardPlan = toGuardPlan(execution, { confirmedAt: deps.now });
  const steps: WorkflowStepView[] = reviewed.steps.map((step) => {
    const outside = outsidePaths(step, { tools: deps.tools, env, agent: executor, facts });
    const realPaths = stepRealPaths(step, { tools: deps.tools, env, facts });
    const args = unmaskEventPlaceholders(step.args);
    // 写了事件占位的步骤：规划时不知道对象，不标敏感（执行时代入了再判、再推授权），卡上标出"代入事件的值"
    const eventValues = stepEventValues({ title: step.title, args });
    return {
      id: step.id,
      title: step.title,
      tool: step.tool,
      args,
      after: step.after,
      ...(step.inserted ? { inserted: true } : {}),
      ...(step.patches ? { patches: step.patches } : {}),
      ...(step.excluded ? { excluded: unmaskEventPlaceholders(step.excluded) } : {}),
      marks: eventValues.length > 0 ? [] : stepMarks(step, { ...deps, agent: executor, guardPlan, facts: linked }),
      ...(eventValues.length > 0 ? { eventValues } : {}),
      conditions: (reviewed.conditions[step.id] ?? []).map((c) => condition(c, [...v1RuleTemplates(deps.tools), ...rules], step.tool)),
      ...(outside.length > 0 ? { outside } : {}),
      ...(Object.keys(realPaths).length > 0 ? { realPaths } : {}),
    };
  });
  const plan: WorkflowPlan = { ...bare, steps };
  return { plan, execution: workflowExecutionPlan(plan, grants, deps.settings) };
}

/** 这一步里真实路径落在执行它的维护者的范围（项目档案、工作目录）之外的路径（规划时现取的真实路径） */
function outsidePaths(
  step: ReviewedStep,
  ctx: { tools: ToolRegistry; env: ShellEnv; agent: GuardAgent; facts: EnvironmentFacts },
): NonNullable<WorkflowStepView["outside"]> {
  const scope = agentScope(ctx.agent);
  const files = new Map(Object.entries(ctx.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const out: NonNullable<WorkflowStepView["outside"]> = [];
  for (const call of stepCalls(step, ctx.env)) {
    for (const { arg, path: p } of absolutePathArgs(call, ctx.tools, ctx.env)) {
      const realPath = files.get(comparable(p))?.realPath;
      if (realPath === undefined || scope.some((dir) => isWithin(realPath, dir))) continue;
      if (!out.some((o) => o.arg === arg && comparable(o.path) === comparable(p))) out.push({ arg, path: p, realPath });
    }
  }
  return out;
}

/** 这一步（连同剔除的对象）里的路径规划时现取的真实路径：通用 bash 的步骤只比命令，不用 */
function stepRealPaths(step: Pick<ReviewedStep, "tool" | "args" | "excluded">, ctx: { tools: ToolRegistry; env: ShellEnv; facts: EnvironmentFacts }): Record<string, string> {
  if (step.tool === "bash") return {};
  const files = new Map(Object.entries(ctx.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const out: Record<string, string> = {};
  for (const args of [step.args, step.excluded ?? {}]) {
    for (const { path: p } of absolutePathArgs({ tool: step.tool, args }, ctx.tools, ctx.env)) {
      const realPath = files.get(comparable(p))?.realPath;
      if (realPath !== undefined) out[p] = realPath;
    }
  }
  return out;
}

/** 规划时判不了的条件的说明 */
const unknownNote = () => t("tasks.workflowPlan.unknownNote");

/** 一条条件给用户看的样子 */
function condition(c: StepCondition, rules: readonly TemporalRule[], stepTool: string): WorkflowCondition {
  const rule = rules.find((r) => r.id === c.ruleId);
  // 规则结构里的触发工具可能是一长串（v1 模板），写成这一步的工具
  const text = rule ? conditionText(rule, stepTool) : c.title;
  return {
    ruleId: c.ruleId,
    title: c.title,
    text,
    source: c.template ? "template" : "plan",
    status: c.status,
    // 违反的写规则给的说明；判不了的是规划时事实不足，推迟到执行时（规则的说明是按违反写的，不照搬）
    ...(c.status === "violated" && c.message ? { note: c.message } : c.status === "unknown" ? { note: unknownNote() } : {}),
  };
}

/**
 * 一步的敏感标注（用守卫的判定，不另写规则文档给步骤分类）：这一步在任务里执行时落进了哪些关注类别、底线，
 * 类别本身的处置，以及计划授权之后执行时还会不会问（授权项覆盖了的"计划里列了才做"不再问）；会被直接拒绝的也标出来
 */
function stepMarks(
  step: ReviewedStep,
  deps: WorkflowReviewDeps & { agent: GuardAgent; guardPlan: ReturnType<typeof toGuardPlan>; facts: EnvironmentFacts },
): WorkflowStepMark[] {
  try {
    const judgement = judgeToolCall({
      call: { toolName: step.tool, args: step.args },
      agent: deps.agent,
      places: deps.places,
      task: { taskId: "workflow-review", currentStageId: WORKFLOW_STAGE_ID, plan: deps.guardPlan },
      effectLog: [],
      settings: deps.settings,
      // 规划时现取的、真实路径和写的不一样的那些路径的事实：真实路径在项目之外的照执行时一样落进"越出项目目录"
      facts: deps.facts,
      tools: deps.tools,
      now: deps.now,
    });
    const marks: WorkflowStepMark[] = [];
    const seen = new Set<string>();
    for (const f of judgement.findings) {
      if (f.kind === "hard_refusal") {
        const key = `refusal:${f.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        marks.push({ category: key, title: t("tasks.workflowPlan.refused", { message: f.message }), disposition: "never", authorized: false });
        continue;
      }
      if (f.kind !== "category" && f.kind !== "bottom_line") continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const title = f.kind === "bottom_line" ? BOTTOM_LINES[f.id as BottomLineId].title : categoryTitle(f.id, [deps.settings]);
      marks.push({ category: f.id, title, disposition: WIRE_DISPOSITION[f.categoryDisposition ?? f.disposition], authorized: f.grantId !== undefined });
    }
    return marks;
  } catch {
    return [];
  }
}

/**
 * 事件触发的流程的一次运行（77 号票）：代入了这次事件的值的步骤（workflow-events.ts 的 runWorkflowSteps），按执行它的维护者现取路径的
 * 真实路径（执行时每次调用和这一步比对，路径按真实路径比），推出这次运行的授权项——和规划时同一套办法（守卫的 workflowGrants：
 * 步骤里写死的参数全部进对象范围、按真实路径比、次数按步骤数），所以一批里几个事件各走一遍的，每个事件的对象各有一项
 */
export function boundRunWorkflow(steps: readonly WorkflowStepView[], deps: { tools: ToolRegistry; agent: GuardAgent; homeDir: string }): { steps: WorkflowStepView[]; grants: PlanGrant[] } {
  const env: ShellEnv = agentShellEnv(deps.agent, deps.homeDir);
  const facts = gatherFileFacts(
    steps.flatMap((s) => [...stepCalls(s, env), ...(s.excluded ? [{ tool: s.tool, args: s.excluded }] : [])]),
    { tools: deps.tools, agent: deps.agent, homeDir: deps.homeDir },
  );
  const grants = planGrantsOf(steps, workflowGrants(steps, { tools: deps.tools, agent: deps.agent, homeDir: deps.homeDir, facts }));
  const bound = steps.map((s): WorkflowStepView => {
    const realPaths = { ...s.realPaths, ...stepRealPaths(s, { tools: deps.tools, env, facts }) };
    return Object.keys(realPaths).length > 0 ? { ...s, realPaths } : s;
  });
  return { steps: bound, grants };
}

/**
 * 授权的流程计划在守卫眼里（59 号票，执行时每次调用和它比对）：哪一版、目标、审查修补后的步骤（连同审查剔除的对象），
 * 以及维护者用 report_step 说明跳过的步骤
 */
export function guardWorkflow(planId: string, plan: WorkflowPlan, task: Pick<Task, "steps">): GuardWorkflow {
  return {
    planId,
    goal: plan.goal,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      tool: s.tool,
      args: s.args,
      after: s.after,
      ...(s.excluded ? { excluded: s.excluded } : {}),
      ...(s.realPaths ? { realPaths: s.realPaths } : {}),
    })),
    skipped: (task.steps?.list ?? []).filter((s) => s.state === "skipped").map((s) => s.stepId),
  };
}

// 交给维护者的计划说明、条件（照旧中文）
// @i18n-ignore-start model
/** 修补后的计划写成几行文字交回维护者（它看不到界面上的卡片） */
export function workflowPlanText(plan: { steps: readonly WorkflowStepView[] }): string {
  return plan.steps.map((s) => `${s.id}. ${s.title}（${s.tool} ${JSON.stringify(plainArgs(s.args))}）${s.after.length > 0 ? `，在 ${s.after.join("、")} 之后` : ""}`).join("\n");
}

/** 每一步要满足的条件写成几行（交给维护者的计划说明、重注入块） */
export function stepConditionLines(step: Pick<WorkflowStepView, "conditions">): string[] {
  return step.conditions.map((c) => `${c.title}：${c.text}`);
}
// @i18n-ignore-end
