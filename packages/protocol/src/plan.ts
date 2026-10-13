// 计划的纯函数（规格第 8 节，12 号票），守护进程和 Web 共用，不引用 TypeBox：
// - 策略和授权项的列表：阶段的在前（按阶段顺序），阶段组的其次（planPolicies、planGrants；76 号票起计划里没有定时作业了）；
//   一个阶段的策略（它自己的加所属阶段组的，stagePolicies）；
// - 开始执行时各阶段的样子（initialStages，13 号票：守护进程建阶段、Web 在还没开始执行时按计划列出都用它）；
// - 计划卡上由代码从结构化数据生成的文字：授权行（grantText，维护者写的 title 只作备注）、时序规则（temporalRuleText）；
// - 停点（planStops）：授权后执行时还会在哪几处停下来——由你验收的阶段、落在"先问我""交给我做"类别里的授权
//   （这类授权行不算授权、不能勾选）、被勾掉的、被收窄的。随卡上的勾选实时算；维护者填的 stops 只作参考说明。
//   一个阶段的那几处（stageStops，84 号票：阶段详情的"问"）；
// - 从某个阶段重做的范围（stageStarted、downstreamOf、reopenScope，84 号票：守护进程重开、Web 的重做对话框都用它）；
// - 时序规则违反了怎么办的说法（ON_VIOLATION_TEXT，84 号票合成一份）。
// - 第几阶段、编号（stageNumbers、stageCodes、planStageCodes，91 号票：照 AgentSense，第几阶段是最长那条前置链的长度，并行的同号，
//   同一阶段有几个时编 4a、4b）。93 号票起编号存进计划（withStageCodes：守护进程定计划、每次调整时定下，已有的阶段不改号，
//   照 AgentSense 的里程碑编号 M4a）；读的地方（stageCodes、planStageCodes、listStageCodes）照存的，之前存下的计划没有编号，按依赖图现算。
//   计划卡上的停点、授权挂在哪个阶段的说法给了编号就写编号（Web 给）；不给照旧按计划里的顺序。
// - 计划变更卡（14 号票）上每一处改动的说法（planChangeItemText）：和计划卡一样由结构化数据生成，守护进程（交给维护者的话、素材）
//   和 Web（卡片）共用。
import { DISPOSITION_LABEL } from "./constants.ts";
import { ACCEPTANCE_METHOD_LABEL } from "./tasks.ts";
import type { GrantInfo, GrantNarrowing, Plan, PlanCardPayload, PlanChangeItem, PlanChangeOwner, PlanGrant, PlanPolicy, PlanTemporalRule, PlanToolkit, TaskStage } from "./task-schema.ts";
import { canSendAttachment, canTellSecretary, toolkitChangeText, toolkitText } from "./toolkit.ts";

// ───────────────────────── 第几阶段、编号（91 号票） ─────────────────────────

/** 算阶段号要的：阶段 id 和它的前置阶段（算编号时再带上存在计划里的编号） */
export interface StageDeps {
  readonly id: string;
  readonly after: readonly string[];
  /** 存在计划里的编号（93 号票起守护进程定计划时存进来）；之前的计划没有，按依赖图现算 */
  readonly code?: string | undefined;
}

/** 第几阶段（从 1 数）：没有前置的是第 1 阶段，其余是它最长那条前置链的长度 + 1；计划里没有的前置不算，有环也不会卡住 */
export function stageNumbers(stages: readonly StageDeps[]): Map<string, number> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = byId.get(id);
    const d = s && s.after.length ? Math.max(0, ...s.after.filter((x) => byId.has(x)).map((x) => visit(x, seen) + 1)) : 0;
    depth.set(id, d);
    return d;
  };
  for (const s of stages) visit(s.id);
  return new Map([...depth].map(([k, v]) => [k, v + 1]));
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** 一个阶段号里第 i 个（从 0 数）的编号：4a、4b……（26 个以后写 4-27） */
const lettered = (n: number, i: number) => `${n}${LETTERS[i] ?? `-${i + 1}`}`;

/**
 * 编号（AgentSense 的里程碑编号 M4a）：存在计划里的照存的（93 号票）；没存的（之前的计划）按依赖图现算——这一阶段只有一个
 * 就是阶段号（"4"），有几个就按计划里的先后加 a、b、c（"4a""4b"）
 */
export function stageCodes(stages: readonly StageDeps[]): Map<string, string> {
  const no = stageNumbers(stages);
  const out = new Map<string, string>();
  for (const s of stages) {
    if (s.code !== undefined) {
      out.set(s.id, s.code);
      continue;
    }
    const n = no.get(s.id)!;
    const same = stages.filter((x) => no.get(x.id) === n);
    const i = same.indexOf(s);
    out.set(s.id, same.length === 1 ? `${n}` : lettered(n, i));
  }
  return out;
}

/** 一份计划的各阶段编号 */
export function planStageCodes(plan: Pick<Plan, "stages">): Map<string, string> {
  return stageCodes(plan.stages.map((s) => ({ id: s.stageId, after: s.dependsOn, code: s.code })));
}

/** 看板上的阶段列表（执行中各阶段的样子）的编号：存着的照存的（93 号票起开始执行时从计划带过来），没存的现算 */
export function listStageCodes(list: readonly Pick<TaskStage, "stageId" | "dependsOn" | "code">[]): Map<string, string> {
  return stageCodes(list.map((s) => ({ id: s.stageId, after: s.dependsOn, code: s.code })));
}

/** 编号里的阶段号："4a" → 4，"3" → 3 */
export const stageCodeNumber = (code: string): number => Number.parseInt(code, 10) || 0;

/**
 * 一共几个阶段号：守护进程写"第 1a/4 阶段"的 4，界面状态行"第 N/M 阶段"的 M（93 号票评审：两边共用这一处）。取存下的编号里最大的
 * 阶段号——编号存在计划里、调整后不变，去掉中间的阶段后按依赖图数层数会写出"第 3/2 阶段"；之前没存编号的按依赖图现算的编号
 */
export function stageLayerCount(list: readonly Pick<TaskStage, "stageId" | "dependsOn" | "code">[]): number {
  return Math.max(0, ...[...listStageCodes(list).values()].map(stageCodeNumber));
}

/** 某一阶段的"第 X/N 阶段"：X 是它的编号，N 是一共几个阶段号（stageLayerCount）；这份列表里没有这个阶段的不给 */
export function stageCodeAt(list: readonly Pick<TaskStage, "stageId" | "dependsOn" | "code">[], stageId: string): { code: string; total: number } | undefined {
  const code = listStageCodes(list).get(stageId);
  return code === undefined ? undefined : { code, total: stageLayerCount(list) };
}

/**
 * 定下各阶段的编号存进计划（93 号票，照 AgentSense 的里程碑编号：check.ts 的 idRuleProblems、prompt.ts 的编号规则——AgentSense
 * 让模型照规则起名、检查不对就退回；二狗的阶段 id 是 s1、s2，编号由守护进程定，维护者不用写）：
 * - 第一版（prev 不给）：这一阶段只有一个就是阶段号，有几个按计划里的先后加 a、b（stageCodes）；
 * - 计划调整（prev 是现在生效的那一份）：已有的阶段（prev 里有同一个阶段 id）沿用原来的号——哪怕前置改了、阶段号变了也不改名；
 *   新加的按它所在的阶段编：这一阶段只有它一个、阶段号没被用过就是阶段号，否则取第一个没被用过的字母（已经有不带字母的"4"时
 *   从 b 起：原来那个算 a）。used 是之前给用户看过的各版里用过的号（被拒、作废的计划变更卡上的也算：去掉的阶段的号不再给新阶段，
 *   聊天里、旧卡上提到的号不会指到别的阶段）。
 * prev 是之前存下、还没有编号的计划时，它的号按依赖图现算（和界面上之前显示的一样）
 */
export function withStageCodes<P extends Pick<Plan, "stages">>(plan: P, prev?: Pick<Plan, "stages">, used: Iterable<string> = []): P {
  const deps = plan.stages.map((s) => ({ id: s.stageId, after: s.dependsOn }));
  if (!prev) {
    const fresh = stageCodes(deps);
    return { ...plan, stages: plan.stages.map((s) => ({ ...s, code: fresh.get(s.stageId)! })) };
  }
  const before = planStageCodes(prev);
  const taken = new Set([...used, ...before.values()]);
  const no = stageNumbers(deps);
  const codes = new Map<string, string>();
  for (const s of plan.stages) {
    const kept = before.get(s.stageId);
    if (kept !== undefined) codes.set(s.stageId, kept);
  }
  for (const s of plan.stages) {
    if (codes.has(s.stageId)) continue;
    const n = no.get(s.stageId)!;
    const alone = plan.stages.filter((x) => no.get(x.stageId) === n).length === 1;
    let code = alone && !taken.has(`${n}`) ? `${n}` : undefined;
    for (let i = taken.has(`${n}`) ? 1 : 0; code === undefined; i++) if (!taken.has(lettered(n, i))) code = lettered(n, i);
    taken.add(code);
    codes.set(s.stageId, code);
  }
  return { ...plan, stages: plan.stages.map((s) => ({ ...s, code: codes.get(s.stageId)! })) };
}

/** 写在文字里的阶段号：给了编号写编号，不给写计划里的第几个（index 从 0 数） */
const stageNoOf = (stageId: string, index: number, codes: ReadonlyMap<string, string> | undefined) => codes?.get(stageId) ?? `${index + 1}`;

// ───────────────────────── 策略和授权项 ─────────────────────────

/** 策略挂在哪儿：一个阶段（第几个），或者一个阶段组（套给组里各阶段） */
export type PolicyOwner = { kind: "stage"; stageId: string; index: number; title: string } | { kind: "group"; groupId: string; title: string };

/** 计划里的全部策略：各阶段的在前（按阶段顺序），各阶段组的其次 */
export function planPolicies(plan: Plan): Array<{ owner: PolicyOwner; policy: PlanPolicy }> {
  return [
    ...plan.stages.map((s, index) => ({ owner: { kind: "stage" as const, stageId: s.stageId, index, title: s.title }, policy: s.policy })),
    ...plan.stageGroups.map((g) => ({ owner: { kind: "group" as const, groupId: g.groupId, title: g.title }, policy: g.policy })),
  ];
}

/** 计划里的全部授权项，连同挂在哪儿 */
export function planGrants(plan: Plan): Array<{ grant: PlanGrant; owner: PolicyOwner }> {
  return planPolicies(plan).flatMap(({ owner, policy }) => policy.grants.map((grant) => ({ grant, owner })));
}

/** 一个阶段的策略：它自己的，加上所属阶段组的（组的套给组里各阶段）；计划里没有这个阶段时为空 */
export function stagePolicies(plan: Plan, stageId: string): PlanPolicy[] {
  const stage = plan.stages.find((s) => s.stageId === stageId);
  if (!stage) return [];
  const group = stage.groupId === undefined ? undefined : plan.stageGroups.find((g) => g.groupId === stage.groupId);
  return [stage.policy, ...(group ? [group.policy] : [])];
}

/** 开始执行时各阶段的样子：都没开始，验收标准照计划 */
export function initialStages(plan: Plan): TaskStage[] {
  return plan.stages.map((s) => ({
    stageId: s.stageId,
    title: s.title,
    state: "pending",
    dependsOn: [...s.dependsOn],
    acceptance: s.acceptance.map((a) => ({ criterion: a.criterion, method: a.method })),
    attempts: 0,
    // 存在计划里的编号带过来（93 号票）：看板上的阶段列表、守护进程写的"第 1a 阶段"都照它
    ...(s.code === undefined ? {} : { code: s.code }),
  }));
}

// ───────────────────────── 从某个阶段重做（84 号票，守护进程和 Web 共用） ─────────────────────────

/** 看板上的这个阶段开始过：不是未开始，或者开始过又放下了（startedAt 还在）。从这里重做只对开始过的阶段（照 AgentSense 的 canReopen） */
export function stageStarted(stage: Pick<TaskStage, "state" | "startedAt">): boolean {
  return stage.state !== "pending" || stage.startedAt !== undefined;
}

/** 这个阶段和它的全部下游（按依赖传递），按计划里的顺序 */
export function downstreamOf(list: readonly Pick<TaskStage, "stageId" | "dependsOn">[], stageId: string): string[] {
  const out = new Set([stageId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of list) {
      if (!out.has(s.stageId) && s.dependsOn.some((d) => out.has(d))) {
        out.add(s.stageId);
        grew = true;
      }
    }
  }
  return list.map((s) => s.stageId).filter((id) => out.has(id));
}

/**
 * 从这个阶段重做会重开哪些（AgentSense reopenPreview 的 scope）：它自己，加上全部下游里开始过的，按计划里的顺序。
 * started 判断一个阶段开始过没有：看板上的阶段用 stageStarted，原型的假阶段用它记着的
 */
export function reopenScope<S extends Pick<TaskStage, "stageId" | "dependsOn">>(list: readonly S[], stageId: string, started: (stage: S) => boolean): string[] {
  return downstreamOf(list, stageId).filter((id) => id === stageId || started(list.find((s) => s.stageId === id)!));
}

/** "第 2 阶段「写报告」" / "阶段组「成文」的各阶段"；给了编号（91 号票：Web 按依赖图）写"第 1b 阶段「写报告」" */
export function policyOwnerLabel(owner: PolicyOwner, codes?: ReadonlyMap<string, string>): string {
  if (owner.kind === "stage") return `第 ${stageNoOf(owner.stageId, owner.index, codes)} 阶段「${owner.title}」`;
  return `阶段组「${owner.title}」的各阶段`;
}

// ───────────────────────── 授权行 ─────────────────────────

/** 不写有效期时的默认（天） */
export const DEFAULT_GRANT_VALID_DAYS = 7;

/** 列进计划也不算授权的处置：执行时照样问、交给你、不做（规格第 9 节："先问我"执行时一定当场问） */
const NOT_AUTHORIZING: readonly GrantInfo["disposition"][] = ["ask_first", "hand_to_me", "never"];

/** 这项授权算不算授权 */
export function grantAuthorizes(info: GrantInfo | undefined): boolean {
  return info === undefined || !NOT_AUTHORIZING.includes(info.disposition);
}

/** 不算授权的那几类在卡上怎么标 */
export function grantNotAuthorizedLabel(info: GrantInfo): string {
  if (info.disposition === "hand_to_me") return "交给你做";
  if (info.disposition === "never") return "永不执行";
  return "执行时仍会问";
}

/** 对象范围写成一句话：remote 是 origin，branch 是 main 或 report；空的是不限对象 */
export function grantScopeText(scope: PlanGrant["scope"]): string {
  const parts = Object.entries(scope).map(([k, v]) => `${k} 是 ${Array.isArray(v) ? v.join(" 或 ") : v}`);
  return parts.length === 0 ? "不限对象" : parts.join("，");
}

/**
 * 授权行的主文，由结构化数据生成：工具（中文名和工具名）、落在哪些关注类别、对象范围、次数、有效期。
 * 比如"推送（git_push）· 以我的名义对外发送或发布：remote 是 origin，branch 是 main；最多 1 次；7 天内有效"
 */
export function grantText(grant: PlanGrant, info: GrantInfo | undefined, owner?: PolicyOwner | "job"): string {
  const tool = info && info.toolTitle !== grant.tool ? `${info.toolTitle}（${grant.tool}）` : grant.tool;
  const categories = info && info.categoryTitles.length > 0 ? ` · ${info.categoryTitles.join("、")}` : "";
  // 定时触发的任务每次运行的授权（19 号票的定时作业，76 号票迁移成定时触发的普通任务）：次数按每次运行算，没有天数（任务在运营就一直有效）
  const job = owner === "job";
  const uses = grant.maxUses === undefined ? "不限次数" : `${job ? "每次运行" : ""}最多 ${grant.maxUses} 次`;
  const command = grant.command === undefined ? "" : `；只限命令「${grant.command}」`;
  // 58 号票：流程的步骤推出的授权项只认写了的参数、路径按真实路径比
  const exact = grant.exactArgs ? "；不能多带别的参数" : "";
  const real = grant.realScope === undefined ? "" : `；路径按真实路径比（${grantScopeText(grant.realScope)}）`;
  return `${tool}${categories}：${grantScopeText(grant.scope)}${command}${exact}${real}；${uses}；${job ? JOB_GRANT_VALIDITY_TEXT : `${grant.validDays ?? DEFAULT_GRANT_VALID_DAYS} 天内有效`}`;
}

/** 定时触发的任务每次运行的授权的有效期怎么写：任务在运营就一直有效（19 号票；76 号票起作业并进定时触发的任务） */
export const JOB_GRANT_VALIDITY_TEXT = "任务在运营就一直有效，暂停、取消即收回";

/**
 * 用户的限制里的一条授权收窄（26 号票），写成一句话："「推送报告」（push-report）：最多 1 次，branch 只留 report"。
 * grant 是计划里的那个授权项（收窄已经落在它上面了）；找不到时只写 id
 */
export function grantNarrowingText(narrowing: GrantNarrowing, grant: PlanGrant | undefined): string {
  const parts = [
    ...(narrowing.maxUses === undefined ? [] : [`最多 ${narrowing.maxUses} 次`]),
    ...Object.entries(narrowing.scope ?? {}).map(([k, v]) => `${k} 只留 ${v.join(" 或 ")}`),
  ];
  const who = grant ? `「${grant.title}」（${grant.id}）` : `授权项 ${narrowing.grantId}`;
  return `${who}：${parts.join("，") || "（没有改动）"}`;
}

// ───────────────────────── 时序规则 ─────────────────────────

/** 时序规则的四种形态（规格第 9 节）：B 之前必须做过 A、B 之前不能做过 A、当下必须满足某条件、一律禁止（不写 require） */
export type TemporalRuleForm = "before" | "not_before" | "check" | "forbid";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 工具名或一组工具名；写错了是 undefined */
export function ruleToolList(spec: unknown): string[] | undefined {
  if (typeof spec === "string" && spec !== "") return [spec];
  if (Array.isArray(spec) && spec.length > 0 && spec.every((t) => typeof t === "string" && t !== "")) return spec as string[];
  return undefined;
}

/** 规则的形态；require 写坏了（不止一种、一种也没有、多了别的键）是 undefined */
export function temporalRuleForm(rule: Readonly<Record<string, unknown>>): TemporalRuleForm | undefined {
  const require = rule.require;
  if (require === undefined || require === null) return "forbid";
  if (!isObject(require)) return undefined;
  const keys = Object.keys(require);
  if (keys.length !== 1) return undefined;
  return (["before", "not_before", "check"] as const).find((f) => f === keys[0]);
}

/**
 * 时序规则的说明，按规则结构生成（维护者写的 title 只作备注）：
 * "git_push 之前必须已经成功做过 run_tests；违反时退回，先补上再做"
 */
export function temporalRuleText(rule: PlanTemporalRule): string {
  const trigger = (ruleToolList(isObject(rule.trigger) ? rule.trigger.tool : undefined) ?? []).join("、") || "任何操作";
  const require = isObject(rule.require) ? rule.require : {};
  const toolsOf = (key: string) => (ruleToolList(isObject(require[key]) ? require[key].tool : undefined) ?? []).join("、") || "指定的操作";
  const form = temporalRuleForm(rule);
  const body =
    form === "before"
      ? `${trigger} 之前必须已经成功做过 ${toolsOf("before")}`
      : form === "not_before"
        ? `做过 ${toolsOf("not_before")} 之后不能再做 ${trigger}`
        : form === "check"
          ? `做 ${trigger} 时当下的条件必须满足`
          : form === "forbid"
            ? `${trigger} 一律禁止`
            : `${trigger} 的规则写法不对`;
  // 触发条件（trigger.where）和 when 一样只在满足条件时检查（26 号票：用户的限制常写成"往 main 推"这种带条件的触发）
  const conditional = rule.when !== undefined || (isObject(rule.trigger) && rule.trigger.where !== undefined);
  const scope = [conditional ? "只在满足条件时检查" : "", rule.unless !== undefined ? "有例外" : ""].filter(Boolean).join("，");
  return `${body}${scope ? `（${scope}）` : ""}；${ON_VIOLATION_TEXT[onViolationOf(rule)]}`;
}

/** 违反了怎么办（时序规则的 on_violation，没写的按当场问你）：拦下、按规则退回（先补上再做）、问你 */
export type OnViolation = "block" | "pull_back" | "confirm";

/** 一条规则违反了怎么办（写法不认识的按问你） */
export const onViolationOf = (rule: Readonly<Record<string, unknown>>): OnViolation => (rule.on_violation === "block" ? "block" : rule.on_violation === "pull_back" ? "pull_back" : "confirm");

/**
 * 违反了怎么办的说法：计划卡（交给维护者的授权和边界也是它）、检测项全览、阶段详情共用这一份（84 号票评审后合成一份，
 * 用计划卡一直以来的说法；AgentSense 检测项全览写"违反后直接拦截"、PolicyRows 写级别，二狗多一级退回）
 */
export const ON_VIOLATION_TEXT: Readonly<Record<OnViolation, string>> = { block: "违反就不做", pull_back: "违反时退回，先补上再做", confirm: "违反时先问你" };

// ───────────────────────── 停点 ─────────────────────────

export type PlanStopKind = "user_acceptance" | "still_asks" | "unchecked" | "narrowed";

export interface PlanStop {
  kind: PlanStopKind;
  text: string;
}

/** 卡上当前的勾选：勾掉的、收窄了的授权项 id */
export interface PlanGrantChoice {
  removed: ReadonlySet<string>;
  narrowed: ReadonlySet<string>;
}

/**
 * 授权后执行时还会在哪几处停下来（"授权后还会在 N 处停下来"）：
 * - 由你验收的阶段（规格：只有标明"由你验收"的阶段才停下来等你）；
 * - 落在"先问我""交给我做"类别里的授权项（列进计划也照样问、交给你）；
 * - 被勾掉的（执行到那一步再问你）、被收窄的（超出收窄范围的部分执行时问你）。
 * 不给 choice 时按卡上记下的确认结果（已处理的卡：勾掉的授权项已经不在计划里，从 removedGrants 取）。
 * codes：给了就按编号写第几阶段（91 号票，Web 给 planStageCodes）
 */
export function planStops(card: Pick<PlanCardPayload, "plan" | "grantInfo" | "removedGrants" | "narrowedGrants">, choice?: PlanGrantChoice, codes?: ReadonlyMap<string, string>): PlanStop[] {
  const removed = choice?.removed ?? new Set<string>();
  const narrowed = choice?.narrowed ?? new Set(card.narrowedGrants ?? []);
  const stops: PlanStop[] = card.plan.stages.flatMap((s, i) => userAcceptanceStop(s, i, codes));
  for (const { grant, owner } of planGrants(card.plan)) {
    const stop = grantStop(grant, owner, card.grantInfo[grant.id], removed, narrowed, codes);
    if (stop) stops.push(stop);
  }
  if (!choice) {
    for (const grant of card.removedGrants ?? []) stops.push({ kind: "unchecked", text: `${grantText(grant, card.grantInfo[grant.id])}（勾掉了，执行到那一步再问你）` });
  }
  return stops;
}

/** 由你验收的阶段停下来等你（第 index+1 阶段；给了编号写编号） */
const userAcceptanceStop = (s: Plan["stages"][number], index: number, codes: ReadonlyMap<string, string> | undefined): PlanStop[] =>
  s.acceptance.some((a) => a.method === "user") ? [{ kind: "user_acceptance", text: `第 ${stageNoOf(s.stageId, index, codes)} 阶段「${s.title}」由你验收` }] : [];

/** 一项授权执行时还会不会停下来：落在"先问我""交给我做"类别里的（"永不"的不算）、勾掉的、收窄的；不会停的是 undefined */
function grantStop(
  grant: PlanGrant,
  owner: PolicyOwner,
  info: GrantInfo | undefined,
  removed: ReadonlySet<string>,
  narrowed: ReadonlySet<string>,
  codes: ReadonlyMap<string, string> | undefined,
): PlanStop | undefined {
  const what = `${policyOwnerLabel(owner, codes)}：${grantText(grant, info, owner)}`;
  if (info && !grantAuthorizes(info)) {
    if (info.disposition === "never") return undefined;
    return { kind: "still_asks", text: `${what}（落在「${DISPOSITION_LABEL[info.disposition]}」类别里，${grantNotAuthorizedLabel(info)}）` };
  }
  if (removed.has(grant.id)) return { kind: "unchecked", text: `${what}（勾掉了，执行到那一步再问你）` };
  if (narrowed.has(grant.id)) return { kind: "narrowed", text: `${what}（收窄了，超出的部分执行时问你）` };
  return undefined;
}

/**
 * 一个阶段执行时会在哪几处停下来（84 号票：阶段详情"要你留意的"里的"问"，照 AgentSense planMarks 的 ask 取计划的停点）：
 * planStops 里落在这个阶段上的——它由你验收、它和所属阶段组的授权项里还会问的、收窄了的（勾掉的已经不在确认的计划里，
 * 说不清是哪个阶段的，不列）。codes：给了就按编号写第几阶段（91 号票）
 */
export function stageStops(
  card: Pick<PlanCardPayload, "plan" | "grantInfo"> & { narrowedGrants?: readonly string[] | undefined },
  stageId: string,
  codes?: ReadonlyMap<string, string>,
): PlanStop[] {
  const index = card.plan.stages.findIndex((s) => s.stageId === stageId);
  const stage = card.plan.stages[index];
  if (!stage) return [];
  const narrowed = new Set(card.narrowedGrants ?? []);
  const mine = (owner: PolicyOwner) => (owner.kind === "stage" ? owner.stageId === stageId : owner.groupId === stage.groupId);
  return [
    ...userAcceptanceStop(stage, index, codes),
    ...planGrants(card.plan).flatMap(({ grant, owner }) => (mine(owner) ? (grantStop(grant, owner, card.grantInfo[grant.id], new Set(), narrowed, codes) ?? []) : [])),
  ];
}

// ───────────────────────── 计划变更（14 号票） ─────────────────────────

const ownerText = (o: PlanChangeOwner) => (o.kind === "stage" ? `阶段 ${o.id}「${o.title}」` : `阶段组「${o.title}」的各阶段`);
const budgetText = (b: { tokens: number; toolCalls: number }) => `${b.tokens} token、${b.toolCalls} 次工具调用`;

/** 一项预算（token、工具调用次数）有没有加：哪一项比原来多就算 */
export const budgetRaised = (before: { tokens: number; toolCalls: number }, after: { tokens: number; toolCalls: number }) =>
  after.tokens > before.tokens || after.toolCalls > before.toolCalls;

/**
 * 比较工具包时看的几样：bash、联网，计划里的还有 skill、MCP（守护进程装配会话时的工具包只有前两样，没有的当空），
 * 给秘书发消息（102 号票）、发附件（117 号票），这两样不写是开着
 */
export type ComparableToolkit = Pick<PlanToolkit, "bash" | "network"> & Partial<Pick<PlanToolkit, "skills" | "mcp" | "tellSecretary" | "sendAttachment">>;

/** 两个名字的集合一样不一样（不看先后；没有的当空） */
const sameSet = (x: readonly string[] = [], y: readonly string[] = []) => x.length === y.length && x.every((v) => y.includes(v)) && y.every((v) => x.includes(v));

/** 两个工具包一样不一样（不看 skill、MCP 的先后）：计划变更前后、维护者会话要不要换装配都用它 */
export function sameToolkit(a: ComparableToolkit, b: ComparableToolkit): boolean {
  return (
    a.bash === b.bash &&
    a.network === b.network &&
    canTellSecretary(a) === canTellSecretary(b) &&
    canSendAttachment(a) === canSendAttachment(b) &&
    sameSet(a.skills, b.skills) &&
    sameSet(a.mcp, b.mcp)
  );
}

type ChangeOf<K extends PlanChangeItem["kind"]> = Extract<PlanChangeItem, { kind: K }>;

/** 一种改动：卡上的说法；说的是计划里的哪一项授权（授权项的改动）；扩大时落在哪些阶段上（不落在具体阶段上的不写） */
interface PlanChangeKindInfo<K extends PlanChangeItem["kind"]> {
  text(item: ChangeOf<K>, grantInfo: Readonly<Record<string, GrantInfo>>): string;
  grant?(item: ChangeOf<K>): PlanGrant;
  stages?(item: ChangeOf<K>, plan: Plan): string[];
}

/** 改动挂的阶段：一个阶段，或者阶段组里的各阶段 */
const ownerStages = (owner: PlanChangeOwner, plan: Plan) => (owner.kind === "stage" ? [owner.id] : plan.stages.filter((s) => s.groupId === owner.id).map((s) => s.stageId));

/** 加上、去掉的几条（验收标准、交付件）落在哪些阶段上 */
const touchedStages = (item: { added: readonly { stageId: string }[]; removed: readonly { stageId: string }[] }) => [...item.added, ...item.removed].map((x) => x.stageId);

/** 加上、去掉的几条写成一句话（加上的可以多写一点，比如验收方式） */
function addedRemovedText<T extends { stageId: string }>(head: string, item: { added: readonly T[]; removed: readonly T[] }, text: (x: T) => string, addedText: (x: T) => string = text): string {
  return [head, ...item.added.map((x) => `加上 阶段 ${x.stageId}：${addedText(x)}`), ...item.removed.map((x) => `去掉 阶段 ${x.stageId}：${text(x)}`)].join(" ");
}

/**
 * 计划变更里的每种改动（14 号票）：说法（卡上、交给维护者的话、素材都用它，planChangeItemText）、对应计划里的哪一项授权、
 * 扩大时停下哪些阶段（守护进程的 affectedStages）。新加一种改动只改这张表
 */
export const PLAN_CHANGE_KINDS: { readonly [K in PlanChangeItem["kind"]]: PlanChangeKindInfo<K> } = {
  grant_added: {
    text: (item, info) => `新增授权（${ownerText(item.owner)}）：${grantText(item.grant, info[item.grant.id])}`,
    grant: (item) => item.grant,
    stages: (item, plan) => ownerStages(item.owner, plan),
  },
  grant_widened: {
    text: (item, info) => `放宽授权（${ownerText(item.owner)}）：原来 ${grantText(item.before, info[item.before.id])}，改成 ${grantText(item.after, info[item.after.id])}`,
    grant: (item) => item.after,
    stages: (item, plan) => ownerStages(item.owner, plan),
  },
  grant_narrowed: {
    text: (item, info) => `收窄授权（${ownerText(item.owner)}）：改成 ${grantText(item.after, info[item.after.id])}`,
    grant: (item) => item.after,
  },
  grant_moved: {
    text: (item, info) => `授权换了阶段（从${ownerText(item.from)}挪到${ownerText(item.to)}）：${grantText(item.grant, info[item.grant.id])}`,
    grant: (item) => item.grant,
    stages: (item, plan) => ownerStages(item.to, plan),
  },
  grant_removed: {
    text: (item, info) => `去掉授权（${ownerText(item.owner)}）：${grantText(item.grant, info[item.grant.id])}`,
    grant: (item) => item.grant,
  },
  // 卡上"工具包变更"一栏：加上、去掉哪些能力（27 号票），括号里是原来的样子
  toolkit: { text: (item) => `工具包变更：${toolkitChangeText(item.before, item.after)}（原来 ${toolkitText(item.before)}）` },
  projects: {
    text: (item) =>
      `涉及的项目：原来 ${item.before.map((p) => p.project).join("、") || "不涉及项目"}，改成 ${item.after.map((p) => `${p.project}（${p.changes.join("；")}）`).join("、") || "不涉及项目"}`,
  },
  goal: { text: (item) => `改目标：原来「${item.before}」，改成「${item.after}」` },
  criteria: { text: (item) => `改任务的验收标准：原来「${item.before.join("；")}」，改成「${item.after.join("；")}」` },
  acceptance: {
    text: (item) =>
      addedRemovedText(
        "改验收：",
        item,
        (x) => x.criterion.criterion,
        (x) => `${x.criterion.criterion}（${ACCEPTANCE_METHOD_LABEL[x.criterion.method]}）`,
      ),
    stages: touchedStages,
  },
  deliverables: { text: (item) => addedRemovedText("改交付件：", item, (x) => x.text), stages: touchedStages },
  budget: {
    text: (item) => `预算：原来一共 ${budgetText(item.before)}，改成 ${budgetText(item.after)}`,
    stages: (item) => item.stages.filter((s) => s.before && s.after && budgetRaised(s.before, s.after)).map((s) => s.stageId),
  },
  rules: {
    text: (item) =>
      [`时序规则（${ownerText(item.owner)}）：`, ...item.added.map((r) => `加上「${r.title ?? r.id}」：${temporalRuleText(r)}`), ...item.removed.map((r) => `去掉「${r.title ?? r.id}」`)].join(" "),
    stages: (item, plan) => ownerStages(item.owner, plan),
  },
  stage_added: { text: (item) => `加了阶段 ${item.stageId}「${item.title}」` },
  stage_removed: { text: (item) => `去掉了阶段 ${item.stageId}「${item.title}」` },
  stage_order: { text: (item) => `阶段顺序：原来 ${item.before.join(" → ")}，改成 ${item.after.join(" → ")}` },
  stage_changed: {
    text: (item) => `阶段 ${item.stageId}「${item.title}」改了${item.fields.join("、")}${item.group ? `（阶段组：${item.group.before ?? "无"} → ${item.group.after ?? "无"}）` : ""}`,
    stages: (item) => [item.stageId],
  },
  stage_grants: { text: (item) => `阶段 ${item.stageIds.join("、")} 多了阶段组的授权`, stages: (item) => item.stageIds },
};

/** 表里这种改动的那一行（按改动的种类取，类型跟着这一处改动） */
const kindOf = <K extends PlanChangeItem["kind"]>(item: ChangeOf<K>): PlanChangeKindInfo<K> => PLAN_CHANGE_KINDS[item.kind as K] as unknown as PlanChangeKindInfo<K>;

/**
 * 计划变更里一处改动的说法（卡上、交给维护者的话、素材都用它）：
 * "新增授权（阶段 s2「写报告」）：git 推送（git_push） · 以我的名义对外发送或发布：remote 是 origin；最多 1 次；7 天内有效"
 */
export function planChangeItemText(item: PlanChangeItem, grantInfo: Readonly<Record<string, GrantInfo>> = {}): string {
  return kindOf(item).text(item, grantInfo);
}

/** 授权项的改动说的是计划里的哪一项授权（别的改动没有） */
export function planChangeGrant(item: PlanChangeItem): PlanGrant | undefined {
  return kindOf(item).grant?.(item);
}

/** 这一处改动落在哪些阶段上（按变更后的计划）；不落在具体阶段上的（工具包、项目、目标……）是空的 */
export function planChangeStages(item: PlanChangeItem, plan: Plan): string[] {
  return kindOf(item).stages?.(item, plan) ?? [];
}
