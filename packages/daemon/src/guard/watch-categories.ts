// 关注类别注册表（规格第 9 节）：内置九类和它们在对话、任务里的默认处置随框架提供；
// 用户的调整和自定义类别是数据，放在数据目录的配置区（见 watch-category-store.ts），判定时作为输入传进来。
//
// 三条约束由判定函数保证，不靠设置界面自觉：
// - 内置类别只能往严里调：判定取默认和设置里更严的那个；
// - 自定义类别没有默认，按设置里它的处置判（可以改、可以删），但和一同命中的类别一起取最严，放宽不了别的；
// - 两条底线和受保护区域根本不在注册表里，设置碰不到。
import { DISPOSITION_INFO, isDisposition, isStricter, strictest, type Disposition } from "./disposition.ts";

/** 对话或任务 */
export type Scene = "chat" | "task";

export const BUILTIN_CATEGORY_IDS = [
  "spend_money",
  "external_send",
  "delete_or_overwrite",
  "irreversible_commit",
  "account_security",
  "outside_project",
  "memory_out_of_scope",
  "unplanned_work_order",
  "unknown_write",
] as const;
export type BuiltinCategoryId = (typeof BUILTIN_CATEGORY_IDS)[number];

export interface BuiltinWatchCategory {
  id: BuiltinCategoryId;
  title: string;
  /** 默认处置。null 表示这个场景里不适用（表里的"—"），万一命中按"先问我"判 */
  defaults: Readonly<Record<Scene, Disposition | null>>;
}

/** 内置九类及默认处置（规格第 9 节的表） */
export const BUILTIN_WATCH_CATEGORIES: readonly BuiltinWatchCategory[] = Object.freeze([
  { id: "spend_money", title: "花钱", defaults: { chat: "hand_over", task: "hand_over" } },
  {
    id: "external_send",
    title: "以我的名义对外发送或发布",
    defaults: { chat: "ask_first", task: "plan_listed" },
  },
  {
    id: "delete_or_overwrite",
    title: "删除或覆盖（项目档案和工作目录内）",
    defaults: { chat: "ask_first", task: "notify_after" },
  },
  { id: "irreversible_commit", title: "不可逆的提交", defaults: { chat: "ask_first", task: "plan_listed" } },
  {
    id: "account_security",
    title: "账户与安全（凭据、权限、全局装软件）",
    defaults: { chat: "ask_first", task: "ask_first" },
  },
  { id: "outside_project", title: "越出项目目录", defaults: { chat: "ask_first", task: "plan_listed" } },
  { id: "memory_out_of_scope", title: "使用授权范围外的记忆", defaults: { chat: "ask_first", task: "ask_first" } },
  { id: "unplanned_work_order", title: "计划外工单", defaults: { chat: null, task: "ask_first" } },
  { id: "unknown_write", title: "未知的写操作", defaults: { chat: "ask_first", task: "ask_first" } },
] satisfies BuiltinWatchCategory[]);

const BUILTIN_BY_ID: ReadonlyMap<string, BuiltinWatchCategory> = new Map(BUILTIN_WATCH_CATEGORIES.map((c) => [c.id, c]));

export function isBuiltinCategory(id: string): id is BuiltinCategoryId {
  return BUILTIN_BY_ID.has(id);
}

export function builtinCategory(id: BuiltinCategoryId): BuiltinWatchCategory {
  return BUILTIN_BY_ID.get(id)!;
}

/** 两条底线：固定处置，不在注册表里，设置、授权项都动不了 */
export const BOTTOM_LINES = Object.freeze({
  payment_account_auth: { title: "付款转账、创建账户、改密码或两步验证", disposition: "hand_over" },
  secret_in_outbound: { title: "把凭据写进对外内容", disposition: "never" },
} as const satisfies Record<string, { title: string; disposition: Disposition }>);
export type BottomLineId = keyof typeof BOTTOM_LINES;

/** 全局的关注类别设置（数据目录配置区的注册表） */
export interface WatchCategorySettings {
  /** 内置类别的调整：判定取默认和这里更严的那个，所以只会更严 */
  builtin?: Partial<Record<BuiltinCategoryId, Partial<Record<Scene, Disposition>>>>;
  /** 用户自定义的类别 */
  custom?: CustomWatchCategory[];
}

/**
 * 本任务的关注类别设置（计划里，GuardPlan.watchCategories）：确认计划时的快照，只在全局之上增加，只管任务里。
 * 判定时和当前的全局设置一起取最严：全局后来调严照样生效，调松或删除放松不了已确认的任务（26 号票）
 */
export interface TaskWatchSettings {
  /** 内置类别在本任务里的处置：判定取它和全局的更严的那个 */
  builtin?: Partial<Record<BuiltinCategoryId, Disposition>>;
  /**
   * 本任务的自定义类别（带规则）：本任务新加的，和确认时调严过的全局自定义类别（连当时的规则一起快照，id 不变）。
   * 和全局同 id 的类别各按各的规则匹配，一同命中时取最严
   */
  custom?: TaskWatchCategory[];
}

/** 本任务的一个自定义类别：确定规则和本任务里的处置 */
export interface TaskWatchCategory {
  id: string;
  title: string;
  match: CategoryMatch;
  disposition: Disposition;
}

/** 用户用确定规则自定义的类别（规则的写法见 CategoryMatch；26 号票做设置界面） */
export interface CustomWatchCategory {
  id: string;
  title: string;
  match: CategoryMatch;
  chat: Disposition;
  task: Disposition;
}

/**
 * 确定规则：写了的条件都要满足（列表里任一即可）。作用在工具注册表登记的参数种类上：
 * - tools：工具或伪工具名；
 * - paths：路径类参数落在这些目录之内（或就是它）；
 * - recipients：收件人类参数等于其中之一（不分大小写）；
 * - amountOver：金额类参数大于它。
 */
export interface CategoryMatch {
  tools?: string[];
  paths?: string[];
  recipients?: string[];
  amountOver?: number;
}

/** 内置类别在某个场景下的处置：默认和各份设置里取最严；任务里再加上本任务的设置（26 号票） */
export function builtinDisposition(
  id: BuiltinCategoryId,
  scene: Scene,
  settings: readonly WatchCategorySettings[],
  task?: TaskWatchSettings,
): Disposition {
  const fallback = builtinCategory(id).defaults[scene] ?? "ask_first";
  const overrides = settings.map((s) => s.builtin?.[id]?.[scene]).filter(isDisposition);
  const own = scene === "task" ? [task?.builtin?.[id]].filter(isDisposition) : [];
  return strictest(fallback, ...overrides, ...own);
}

/** 对全局设置的一次修改（设置页上的操作，26 号票）。自定义类别的 id 由调用方给（新建时分配一个没用过的） */
export type WatchCategoryEdit =
  | { op: "set_builtin"; categoryId: string; scene: Scene; disposition: Disposition }
  | { op: "create_custom"; category: CustomWatchCategory }
  | { op: "update_custom"; category: CustomWatchCategory }
  | { op: "delete_custom"; categoryId: string };

/** 改好的设置和这次改的类别 id */
export type WatchCategoryEditResult = { ok: true; settings: WatchCategorySettings; categoryId: string } | { ok: false; problems: string[] };

/**
 * 改一份全局设置（不改动传进来的那份）：
 * - 内置类别只能不比默认松（和默认一样就去掉这一项）；"—"的场景（计划外工单在对话里）不适用；两条底线不在注册表里，改不动；
 * - 自定义类别随时可以新建、改规则、改处置（往松往严都行）、删除；
 * 改出来的设置再过一遍 validateWatchCategorySettings，所以存进文件的一定读得回来
 */
export function editWatchCategorySettings(settings: WatchCategorySettings, edit: WatchCategoryEdit): WatchCategoryEditResult {
  const next: WatchCategorySettings = structuredClone(settings);
  const custom = next.custom ?? [];
  switch (edit.op) {
    case "set_builtin": {
      const { categoryId: id, scene, disposition } = edit;
      if (Object.hasOwn(BOTTOM_LINES, id)) return fail(`「${BOTTOM_LINES[id as BottomLineId].title}」是底线，固定为"${DISPOSITION_INFO[BOTTOM_LINES[id as BottomLineId].disposition].label}"，不能改`);
      if (!isBuiltinCategory(id)) return fail(`没有这个内置类别：${id}`);
      const category = builtinCategory(id);
      const fallback = category.defaults[scene];
      if (fallback === null) return fail(`「${category.title}」在${scene === "chat" ? "对话里" : "任务里"}不适用`);
      if (isStricter(fallback, disposition)) {
        return fail(`「${category.title}」只能往严里调："${DISPOSITION_INFO[disposition].label}"比默认的"${DISPOSITION_INFO[fallback].label}"松`);
      }
      const builtin = { ...next.builtin };
      const scenes: Partial<Record<Scene, Disposition>> = { ...builtin[id] };
      if (disposition === fallback) delete scenes[scene];
      else scenes[scene] = disposition;
      if (Object.keys(scenes).length === 0) delete builtin[id];
      else builtin[id] = scenes;
      next.builtin = builtin;
      break;
    }
    case "create_custom":
      next.custom = [...custom, edit.category];
      break;
    case "update_custom": {
      const at = custom.findIndex((c) => c.id === edit.category.id);
      if (at < 0) return fail(`没有这个自定义类别：${edit.category.id}`);
      next.custom = custom.map((c, i) => (i === at ? edit.category : c));
      break;
    }
    case "delete_custom":
      if (!custom.some((c) => c.id === edit.categoryId)) return fail(`没有这个自定义类别：${edit.categoryId}`);
      next.custom = custom.filter((c) => c.id !== edit.categoryId);
      break;
  }
  const problems = validateWatchCategorySettings(next);
  for (const c of next.custom ?? []) if (c.title.trim() === "") problems.push(`自定义类别 ${c.id} 的名字不能是空的`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, settings: next, categoryId: edit.op === "create_custom" || edit.op === "update_custom" ? edit.category.id : edit.categoryId };
}

function fail(problem: string): WatchCategoryEditResult {
  return { ok: false, problems: [problem] };
}

/** 校验一份关注类别设置的形状；返回问题列表（空表示没问题） */
export function validateWatchCategorySettings(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["关注类别设置必须是一个对象"];
  for (const key of Object.keys(value)) {
    if (key !== "builtin" && key !== "custom") problems.push(`不认识的字段 ${key}`);
  }
  if (value.builtin !== undefined) {
    if (!isRecord(value.builtin)) problems.push("builtin 必须是一个对象");
    else {
      for (const [id, scenes] of Object.entries(value.builtin)) {
        if (!isBuiltinCategory(id)) {
          problems.push(`builtin.${id}：没有这个内置类别`);
          continue;
        }
        if (!isRecord(scenes)) {
          problems.push(`builtin.${id} 必须是一个对象`);
          continue;
        }
        for (const [scene, disposition] of Object.entries(scenes)) {
          if (scene !== "chat" && scene !== "task") {
            problems.push(`builtin.${id}.${scene}：场景只有 chat 和 task`);
            continue;
          }
          if (!isDisposition(disposition)) {
            problems.push(`builtin.${id}.${scene}：${JSON.stringify(disposition)} 不是一档处置`);
            continue;
          }
          const fallback = builtinCategory(id).defaults[scene];
          if (fallback !== null && strictest(fallback, disposition) !== disposition) {
            problems.push(`builtin.${id}.${scene}：内置类别只能往严里调，${disposition} 比默认的 ${fallback} 松`);
          }
        }
      }
    }
  }
  if (value.custom !== undefined) {
    if (!Array.isArray(value.custom)) problems.push("custom 必须是一个数组");
    else {
      const seen = new Set<string>();
      value.custom.forEach((entry, i) => problems.push(...validateCustomCategory(entry, `custom[${i}]`, seen)));
    }
  }
  return problems;
}

function validateCustomCategory(entry: unknown, where: string, seen: Set<string>): string[] {
  if (!isRecord(entry)) return [`${where} 必须是一个对象`];
  const problems: string[] = [];
  const id = entry.id;
  if (typeof id !== "string" || id.trim() === "") problems.push(`${where}.id 必须是非空字符串`);
  else {
    if (isBuiltinCategory(id)) problems.push(`${where}.id：${id} 和内置类别重名`);
    if (seen.has(id)) problems.push(`${where}.id：${id} 重复`);
    seen.add(id);
  }
  if (typeof entry.title !== "string") problems.push(`${where}.title 必须是字符串`);
  for (const scene of ["chat", "task"] as const) {
    if (!isDisposition(entry[scene])) problems.push(`${where}.${scene} 必须是一档处置`);
  }
  const match = entry.match;
  if (!isRecord(match)) problems.push(`${where}.match 必须是一个对象`);
  else {
    let conditions = 0;
    for (const [key, v] of Object.entries(match)) {
      if (key === "tools" || key === "paths" || key === "recipients") {
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) {
          problems.push(`${where}.match.${key} 必须是非空的字符串数组`);
        } else conditions++;
      } else if (key === "amountOver") {
        if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${where}.match.amountOver 必须是数字`);
        else conditions++;
      } else problems.push(`${where}.match：不认识的条件 ${key}`);
    }
    if (conditions === 0) problems.push(`${where}.match 至少要有一个条件`);
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
