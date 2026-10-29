// 设置里的"系统提示"（71 号票）：列表怎么分组、每份用的是默认还是改过的怎么说、正在改的内容对不对、能用的占位符怎么列。
// 纯函数，界面（pages/more/PromptsPage.tsx）只管画。占位符的检查和守护进程用同一个函数（协议包的 parsePromptTemplate），
// 所以写错了保存之前就地提示，说法和守护进程拒收时一样；守护进程那边照样再查一遍。
import {
  normalizePromptSource,
  parsePromptTemplate,
  promptIssuesText,
  type PromptTemplateSpec,
  type SystemPromptDetail,
  type SystemPromptGroup,
  type SystemPromptList,
  type SystemPromptState,
  type SystemPromptSummary,
  t,
  tTable,
} from "./protocol.ts";

/** 列表里的几节 */
export const SYSTEM_PROMPT_GROUP_TITLE: Readonly<Record<SystemPromptGroup, string>> = tTable({
  prefix: "state.systemPrompts.group.prefix",
  role: "state.systemPrompts.group.role",
  fragment: "state.systemPrompts.group.fragment",
});

/** 每一节标题旁的一句 */
const GROUP_NOTE: Readonly<Record<SystemPromptGroup, string>> = tTable({
  prefix: "state.systemPrompts.groupNote.prefix",
  role: "state.systemPrompts.groupNote.role",
  fragment: "state.systemPrompts.groupNote.fragment",
});

/** 用的是默认的、改过的、改过的有错（这时用默认的） */
export const SYSTEM_PROMPT_STATE_LABEL: Readonly<Record<SystemPromptState, string>> = tTable({
  default: "state.systemPrompts.state.default",
  custom: "state.systemPrompts.state.custom",
  broken: "state.systemPrompts.state.broken",
});

export interface SystemPromptSection {
  readonly group: SystemPromptGroup;
  readonly title: string;
  readonly note: string;
  readonly prompts: readonly SystemPromptSummary[];
}

/** 列表分成前缀、各角色、共用片段三节（守护进程给的顺序不动），没有的节不列 */
export function systemPromptSections(list: SystemPromptList): SystemPromptSection[] {
  return (["prefix", "role", "fragment"] as const)
    .map((group) => ({ group, title: SYSTEM_PROMPT_GROUP_TITLE[group], note: GROUP_NOTE[group], prompts: list.prompts.filter((p) => p.group === group) }))
    .filter((s) => s.prompts.length > 0);
}

/** 列表里一份的副标题：说明，共用片段再写插在哪几份里（名字里可能有名字占位，界面经 NamedText 显示） */
export function systemPromptSubtitle(p: SystemPromptSummary): string {
  return p.usedIn.length > 0 ? t("state.systemPrompts.usedIn", { description: p.description, list: p.usedIn.join(t("state.systemPrompts.listSep")) }) : p.description;
}

/** 检查用的：这份提示能用的占位符 */
export function systemPromptSpec(detail: Pick<SystemPromptDetail, "placeholders">): PromptTemplateSpec {
  const of = (kind: string, common = false) => detail.placeholders.filter((p) => p.kind === kind && (p.common ?? false) === common).map((p) => p.name);
  const onlyWhen = detail.placeholders.flatMap((p) => (p.onlyWhen === undefined ? [] : [[p.name, p.onlyWhen] as const]));
  return { values: of("value"), common: of("value", true), flags: of("flag"), partials: of("partial"), onlyWhen: Object.fromEntries(onlyWhen) };
}

export interface SystemPromptDraftCheck {
  /** 存不存得进去：不对时 problem 写明第几行错在哪 */
  readonly ok: boolean;
  readonly problem: string | undefined;
  /** 和现在用的不一样（有东西可存） */
  readonly changed: boolean;
  /** 和默认的一样（存了就等于恢复默认） */
  readonly isDefault: boolean;
}

/** 正在改的内容：对不对、改没改、是不是和默认的一样（换行、末尾空行按守护进程存的样子比） */
export function checkSystemPromptDraft(detail: SystemPromptDetail, draft: string): SystemPromptDraftCheck {
  const source = normalizePromptSource(draft);
  const changed = source !== normalizePromptSource(detail.content);
  const isDefault = source === normalizePromptSource(detail.defaultContent);
  if (!detail.allowEmpty && source.trim() === "") return { ok: false, problem: t("state.systemPrompts.empty"), changed, isDefault };
  const parsed = parsePromptTemplate(source, systemPromptSpec(detail));
  return parsed.ok ? { ok: true, problem: undefined, changed, isDefault } : { ok: false, problem: promptIssuesText(parsed.issues), changed, isDefault };
}

export interface PlaceholderGroup {
  readonly title: string;
  readonly items: ReadonlyArray<{ readonly code: string; readonly description: string }>;
}

/** 能用的占位符，按种类列：这份自己的值、条件、能插的片段、每份都能用的工具名和标记；没有的种类不列 */
export function placeholderGroups(detail: Pick<SystemPromptDetail, "placeholders">): PlaceholderGroup[] {
  const ps = detail.placeholders;
  return [
    {
      title: t("state.systemPrompts.placeholders.values"),
      items: ps
        .filter((p) => p.kind === "value" && !p.common)
        .map((p) => ({ code: `{{${p.name}}}`, description: p.onlyWhen === undefined ? p.description : t("state.systemPrompts.placeholders.onlyWhen", { description: p.description, flag: p.onlyWhen }) })),
    },
    {
      title: t("state.systemPrompts.placeholders.flags"),
      items: ps.filter((p) => p.kind === "flag").map((p) => ({ code: `{{#${p.name}}}…{{/${p.name}}}`, description: t("state.systemPrompts.placeholders.flagNote", { description: p.description, flag: p.name }) })),
    },
    { title: t("state.systemPrompts.placeholders.partials"), items: ps.filter((p) => p.kind === "partial").map((p) => ({ code: `{{> ${p.name}}}`, description: p.description })) },
    { title: t("state.systemPrompts.placeholders.common"), items: ps.filter((p) => p.kind === "value" && p.common).map((p) => ({ code: `{{${p.name}}}`, description: p.description })) },
  ].filter((g) => g.items.length > 0);
}
