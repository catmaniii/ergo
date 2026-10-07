// 设置里的关注类别和计划卡上本任务的关注类别（26 号票），纯函数：
// - 关注类别频道上最后一条设置事件就是设置页的样子（watchCategorySettings）；内置类别的下拉只给不比默认更松的档（builtinChoices）；
// - 自定义类别的编辑框（CategoryForm：几个文本框）变成名字和确定规则（categoryRuleOf，界面上只有这一处检查），
//   设置页拿它做请求（categoryDraftOf），计划卡拿它给本任务加类别（planCategoryAdditionOf）；写得不对先在界面上说，服务端还会再查；
//   规则里还没登记的工具不拦，提示"登记后生效"（formUnregisteredTools）；
// - 删除或调松一个自定义类别后，还有几个进行中的任务按确认时的设置检查它（heldByTasksNotice）；
// - 计划卡：本任务要提醒的关注类别每个标明来处（planCategoryRows），用户的限制列出原话（核对过的）或维护者转述，
//   和编译出的规则、收窄（userLimitRows）。
// 规则写成一句话（categoryMatchText）、内置类别哪几档不比默认松（dispositionsNotLooserThan）在共享协议包里，守护进程也用。
import {
  type BuiltinWatchCategoryView,
  categoryMatchText,
  type CustomWatchCategoryView,
  type Disposition,
  dispositionsNotLooserThan,
  grantNarrowingText,
  heldByTasksText,
  type PlanCardPayload,
  type PlanCategoryAddition,
  planGrants,
  temporalRuleText,
  type WatchCategoriesState,
  type WatchCategoryDraft,
  type WatchCategoryMatch,
  type WatchCategorySettingsEventPayload,
  type WatchScene,
  type WatchToolChoice,
  unregisteredTools,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 设置页的关注类别；还没收到是 undefined */
export function watchCategorySettings(state: UiState): WatchCategoriesState | undefined {
  return state.watchCategories?.state;
}

/** 最后一次变化（谁改的、改了什么） */
export function watchCategoryLastChange(state: UiState): Pick<WatchCategorySettingsEventPayload, "change" | "by" | "time"> | undefined {
  const last = state.watchCategories;
  return last && { change: last.change, by: last.by, time: last.time };
}

/** 最后一次修改是删除或调松一个自定义类别、而还有进行中的任务按确认时的设置检查它时的提示；没有是 undefined */
export function heldByTasksNotice(state: UiState): string | undefined {
  const n = state.watchCategories?.change.heldByTasks;
  return n === undefined ? undefined : `刚才的修改：${heldByTasksText(n)}`;
}

/** 内置类别某个场景的下拉：不比默认更松的那几档；"—"的场景（计划外工单的对话里）没有 */
export function builtinChoices(category: BuiltinWatchCategoryView, scene: WatchScene): Disposition[] {
  const base = category.defaults[scene];
  return base === null ? [] : dispositionsNotLooserThan(base);
}

/** 自定义类别的编辑框：名字、四种条件（文本框里写）、两套处置 */
export interface CategoryForm {
  title: string;
  /** 工具名，逗号或空白分开 */
  tools: string;
  /** 目录，一行一个（Windows 路径里可能有空格） */
  paths: string;
  /** 收件人，逗号或空白分开 */
  recipients: string;
  /** 金额阈值（大于它才算命中），空着就不写 */
  amountOver: string;
  chat: Disposition;
  task: Disposition;
}

export function emptyCategoryForm(): CategoryForm {
  return { title: "", tools: "", paths: "", recipients: "", amountOver: "", chat: "ask_first", task: "ask_first" };
}

/** 改规则时从现有的类别填好编辑框 */
export function categoryFormOf(c: Pick<CustomWatchCategoryView, "title" | "match" | "chat" | "task">): CategoryForm {
  return {
    title: c.title,
    tools: (c.match.tools ?? []).join(", "),
    paths: (c.match.paths ?? []).join("\n"),
    recipients: (c.match.recipients ?? []).join(", "),
    amountOver: c.match.amountOver === undefined ? "" : String(c.match.amountOver),
    chat: c.chat,
    task: c.task,
  };
}

const splitWords = (text: string) => text.split(/[\s,，、;；]+/).filter(Boolean);
const splitLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** 编辑框里的规则：空的条件不写；写得不对给出问题 */
export function categoryMatchOf(form: Pick<CategoryForm, "tools" | "paths" | "recipients" | "amountOver">): { match: WatchCategoryMatch; problems: string[] } {
  const problems: string[] = [];
  const match: WatchCategoryMatch = {};
  const tools = splitWords(form.tools);
  if (tools.length > 0) match.tools = tools;
  const paths = splitLines(form.paths);
  if (paths.length > 0) match.paths = paths;
  const recipients = splitWords(form.recipients);
  if (recipients.length > 0) match.recipients = recipients;
  const amount = form.amountOver.trim();
  if (amount !== "") {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) problems.push("金额要写数字（大于它才算命中）");
    else match.amountOver = n;
  }
  return { match, problems };
}

type RuleForm = Pick<CategoryForm, "title" | "tools" | "paths" | "recipients" | "amountOver">;

/** 编辑框里的名字和规则：界面上唯一的检查（名字不空、至少一条规则、金额是数字）；服务端还会再查（路径要写完整） */
export function categoryRuleOf(form: RuleForm): { title: string; match: WatchCategoryMatch; problems: string[] } {
  const title = form.title.trim();
  const { match, problems } = categoryMatchOf(form);
  const all = [...(title === "" ? ["写个名字"] : []), ...(Object.keys(match).length === 0 && problems.length === 0 ? ["规则至少写一条：匹配工具、路径、收件人或金额"] : []), ...problems];
  return { title, match, problems: all };
}

/** 编辑框 → 新建或修改自定义类别的请求内容 */
export function categoryDraftOf(form: CategoryForm): { draft: WatchCategoryDraft } | { problems: string[] } {
  const { title, match, problems } = categoryRuleOf(form);
  return problems.length > 0 ? { problems } : { draft: { title, match, chat: form.chat, task: form.task } };
}

/** 编辑框 → 计划卡上给本任务加的类别（处置一档，命中时和别的类别取最严） */
export function planCategoryAdditionOf(form: RuleForm, disposition: Disposition): { addition: PlanCategoryAddition } | { problems: string[] } {
  const { title, match, problems } = categoryRuleOf(form);
  return problems.length > 0 ? { problems } : { addition: { title, match, disposition } };
}

/** 编辑框里写着、但现在没有登记的工具（可以先写，登记了才会命中） */
export function formUnregisteredTools(form: Pick<CategoryForm, "tools">, tools: readonly WatchToolChoice[]): string[] {
  return unregisteredTools({ tools: splitWords(form.tools) }, tools);
}

// ───────────────────────── 计划卡 ─────────────────────────

/**
 * 本任务要提醒的一个关注类别在卡上的来处：
 * - global：全局设置里的（删不掉，处置跟着全局走）；global_tightened：全局的，维护者在本任务里调严了；
 * - maintainer_added：维护者为本任务加的；user_added：你确认时在卡上加的
 */
export type PlanCategoryOrigin = "global" | "global_tightened" | "maintainer_added" | "user_added";

export interface PlanCategoryRow {
  id: string;
  title: string;
  origin: PlanCategoryOrigin;
  /** 本任务里的处置（全局的没调过时不写：按全局设置） */
  disposition?: Disposition;
  /** 本任务加的类别的规则（一句话） */
  rule?: string;
}

export function planCategoryRows(card: Pick<PlanCardPayload, "plan" | "globalCategories" | "addedCategories">): PlanCategoryRow[] {
  const global = new Set(card.globalCategories);
  const userAdded = new Set(card.addedCategories ?? []);
  return card.plan.watchCategories.map((c) => {
    const origin: PlanCategoryOrigin = global.has(c.id) ? (c.disposition === undefined ? "global" : "global_tightened") : userAdded.has(c.id) ? "user_added" : "maintainer_added";
    return {
      id: c.id,
      title: c.title ?? c.id,
      origin,
      ...(c.disposition === undefined ? {} : { disposition: c.disposition }),
      ...(c.match && !global.has(c.id) ? { rule: categoryMatchText(c.match) } : {}),
    };
  });
}

/** 用户说过的一条限制在卡上的样子：原话（或维护者转述），编译出的规则和授权收窄（文字由结构化数据生成） */
export interface UserLimitRow {
  id: string;
  quote: string;
  /** true：原话核对得上（任务书的约束、用户的消息里原样有），显示成"你说"；false 显示成"维护者转述" */
  verified: boolean;
  rules: string[];
  narrowings: string[];
}

export function userLimitRows(card: Pick<PlanCardPayload, "plan" | "verifiedQuotes">): UserLimitRow[] {
  const { plan } = card;
  const verified = new Set(card.verifiedQuotes ?? []);
  const grants = new Map(planGrants(plan).map(({ grant }) => [grant.id, grant]));
  return (plan.userLimits ?? []).map((l) => ({
    id: l.id,
    quote: l.quote,
    verified: verified.has(l.id),
    rules: l.temporalRules.map(temporalRuleText),
    narrowings: l.grantNarrowings.map((n) => grantNarrowingText(n, grants.get(n.grantId))),
  }));
}
