// 计划卡上的勾选（纯函数，12 号票）：勾掉、收窄授权项、改过的假设栏、加的关注类别（26 号票）变成"确认"的输入（PlanConfirmInput）。
// 只能勾掉或收窄：次数改少、数组形式的对象范围里去掉一些值；落在"先问我"类别里的授权行不算授权、不能勾选（界面上就不给勾）。
// 授权项的列表、授权行和时序规则的文字、停点都在共享协议包的 plan.ts（planGrants、grantText、temporalRuleText、planStops）。
import { describeSchedule, type GrantNarrowing, type Plan, type PlanCategoryAddition, type PlanConfirmInput, planGrants } from "./protocol.ts";

/** 计划卡上的一个定时作业：名字、时间表的中文写法（"按我的工作日 09:00"）、每次做什么、属于哪个项目 */
export interface ScheduledJobLine {
  title: string;
  schedule: string;
  each: string;
  project?: string;
}

/** 计划里的定时作业在计划卡上怎么显示 */
export function scheduledJobLines(plan: Plan): ScheduledJobLine[] {
  return plan.scheduledJobs.map((j) => ({ title: j.title, schedule: describeSchedule(j.schedule), each: j.each, ...(j.project === undefined ? {} : { project: j.project }) }));
}

/** 卡上对一项授权的收窄：次数（不写是不改）、对象范围里留下的值（只列动过的参数） */
export interface GrantNarrowingDraft {
  maxUses?: number;
  scope: Record<string, string[]>;
}

/** 卡上当前的勾选：勾掉的授权项、各项的收窄、改过的假设栏（没改过是 undefined） */
export interface PlanCardChoice {
  removed: ReadonlySet<string>;
  drafts: Readonly<Record<string, GrantNarrowingDraft>>;
  assumptions?: readonly string[];
  /** 在卡上给这个任务加的关注类别（只能加，已有的删不掉） */
  added?: readonly PlanCategoryAddition[];
}

/** 实际收窄了的授权项 id（和原来一样的次数、留下全部值的范围不算；勾掉的不算） */
export function narrowedGrantIds(plan: Plan, choice: PlanCardChoice): Set<string> {
  return new Set(narrowings(plan, choice).map((n) => n.grantId));
}

function narrowings(plan: Plan, choice: PlanCardChoice): GrantNarrowing[] {
  const out: GrantNarrowing[] = [];
  for (const { grant } of planGrants(plan)) {
    const draft = choice.drafts[grant.id];
    if (choice.removed.has(grant.id) || !draft) continue;
    const maxUses = draft.maxUses !== undefined && draft.maxUses !== grant.maxUses ? draft.maxUses : undefined;
    const scope = Object.fromEntries(
      Object.entries(draft.scope).filter(([key, kept]) => {
        const values = grant.scope[key];
        return Array.isArray(values) && kept.length > 0 && kept.length < values.length;
      }),
    );
    if (maxUses === undefined && Object.keys(scope).length === 0) continue;
    out.push({ grantId: grant.id, ...(maxUses === undefined ? {} : { maxUses }), ...(Object.keys(scope).length === 0 ? {} : { scope }) });
  }
  return out;
}

/** 改过的假设栏（去掉空的条目）；和计划里一样就算没改 */
function editedAssumptions(plan: Plan, choice: PlanCardChoice): string[] | undefined {
  if (choice.assumptions === undefined) return undefined;
  const after = choice.assumptions.map((a) => a.trim()).filter(Boolean);
  return JSON.stringify(after) === JSON.stringify(plan.assumptions) ? undefined : after;
}

/** 卡上的勾选、收窄和假设栏变成"确认"的输入；什么都没动就是原样确认（空对象） */
export function planConfirmInput(plan: Plan, choice: PlanCardChoice): PlanConfirmInput {
  const removeGrants = planGrants(plan)
    .map(({ grant }) => grant.id)
    .filter((id) => choice.removed.has(id));
  const narrowGrants = narrowings(plan, choice);
  const assumptions = editedAssumptions(plan, choice);
  const added = choice.added ?? [];
  return {
    ...(removeGrants.length === 0 ? {} : { removeGrants }),
    ...(narrowGrants.length === 0 ? {} : { narrowGrants }),
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(added.length === 0 ? {} : { addWatchCategories: [...added] }),
  };
}
