// 计划的纯函数（规格第 8 节，12 号票），守护进程和 Web 共用，不引用 TypeBox：
// - 策略和授权项的列表：阶段的在前（按阶段顺序），阶段组的在后（planPolicies、planGrants）；
// - 计划卡上由代码从结构化数据生成的文字：授权行（grantText，维护者写的 title 只作备注）、时序规则（temporalRuleText）；
// - 停点（planStops）：授权后执行时还会在哪几处停下来——由你验收的阶段、落在"先问我""交给我做"类别里的授权
//   （这类授权行不算授权、不能勾选）、被勾掉的、被收窄的。随卡上的勾选实时算；维护者填的 stops 只作参考说明。
import { DISPOSITION_LABEL } from "./constants.ts";
import type { GrantInfo, Plan, PlanCardPayload, PlanGrant, PlanPolicy, PlanTemporalRule } from "./task-schema.ts";

// ───────────────────────── 策略和授权项 ─────────────────────────

/** 策略挂在哪儿：一个阶段（第几个），或者一个阶段组（套给组里各阶段） */
export type PolicyOwner = { kind: "stage"; stageId: string; index: number; title: string } | { kind: "group"; groupId: string; title: string };

/** 计划里的全部策略：各阶段的在前（按阶段顺序），各阶段组的在后 */
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

/** "第 2 阶段「写报告」" / "阶段组「成文」的各阶段" */
export function policyOwnerLabel(owner: PolicyOwner): string {
  return owner.kind === "stage" ? `第 ${owner.index + 1} 阶段「${owner.title}」` : `阶段组「${owner.title}」的各阶段`;
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
export function grantText(grant: PlanGrant, info: GrantInfo | undefined): string {
  const tool = info && info.toolTitle !== grant.tool ? `${info.toolTitle}（${grant.tool}）` : grant.tool;
  const categories = info && info.categoryTitles.length > 0 ? ` · ${info.categoryTitles.join("、")}` : "";
  const uses = grant.maxUses === undefined ? "不限次数" : `最多 ${grant.maxUses} 次`;
  return `${tool}${categories}：${grantScopeText(grant.scope)}；${uses}；${grant.validDays ?? DEFAULT_GRANT_VALID_DAYS} 天内有效`;
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
  const scope = [rule.when !== undefined ? "只在满足条件时检查" : "", rule.unless !== undefined ? "有例外" : ""].filter(Boolean).join("，");
  const outcome = rule.on_violation === "block" ? "违反就不做" : rule.on_violation === "pull_back" ? "违反时退回，先补上再做" : "违反时先问你";
  return `${body}${scope ? `（${scope}）` : ""}；${outcome}`;
}

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
 * 不给 choice 时按卡上记下的确认结果（已处理的卡：勾掉的授权项已经不在计划里，从 removedGrants 取）
 */
export function planStops(card: Pick<PlanCardPayload, "plan" | "grantInfo" | "removedGrants" | "narrowedGrants">, choice?: PlanGrantChoice): PlanStop[] {
  const removed = choice?.removed ?? new Set<string>();
  const narrowed = choice?.narrowed ?? new Set(card.narrowedGrants ?? []);
  const stops: PlanStop[] = [];
  card.plan.stages.forEach((s, i) => {
    if (s.acceptance.some((a) => a.method === "user")) stops.push({ kind: "user_acceptance", text: `第 ${i + 1} 阶段「${s.title}」由你验收` });
  });
  for (const { grant, owner } of planGrants(card.plan)) {
    const info = card.grantInfo[grant.id];
    const what = `${policyOwnerLabel(owner)}：${grantText(grant, info)}`;
    if (info && !grantAuthorizes(info)) {
      if (info.disposition === "never") continue;
      stops.push({ kind: "still_asks", text: `${what}（落在「${DISPOSITION_LABEL[info.disposition]}」类别里，${grantNotAuthorizedLabel(info)}）` });
    } else if (removed.has(grant.id)) {
      stops.push({ kind: "unchecked", text: `${what}（勾掉了，执行到那一步再问你）` });
    } else if (narrowed.has(grant.id)) {
      stops.push({ kind: "narrowed", text: `${what}（收窄了，超出的部分执行时问你）` });
    }
  }
  if (!choice) {
    for (const grant of card.removedGrants ?? []) stops.push({ kind: "unchecked", text: `${grantText(grant, card.grantInfo[grant.id])}（勾掉了，执行到那一步再问你）` });
  }
  return stops;
}
