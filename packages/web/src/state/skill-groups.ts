// skill 库按集合显示（72 号票，用户 2026-10-10 要求）：matt-pocock、pstack 这类整套导入的集合不一个一个列，各显示成一项
// （集合名、来源、版本、几个 skill、一句说明），点进去才看到里面每个 skill；单个导入的、框架自带的照旧一个一个列。
// 工具包和秘书的 skill 选择里，集合同样显示成一项：可以整套选，点开也能单选其中几个。工具包、秘书的名单里记的始终是 skill 名，
// 集合只是显示和选择的方式。纯函数，界面（ui/skill-picker.tsx、pages/more/SkillsPage.tsx）只管画。
import { type LibrarySkill, SECRETARY_SKILL_PROMPT_WARN_BYTES, type SecretarySkillsView, type SkillCollectionEntry, t, type ToolkitCatalog } from "./protocol.ts";

/** 一个集合和它在库里的成员（按集合里的顺序） */
export interface SkillGroup {
  readonly collection: SkillCollectionEntry;
  readonly members: readonly LibrarySkill[];
}

export interface SkillGroups {
  /** 集合，按集合名排 */
  readonly collections: readonly SkillGroup[];
  /** 不属于任何集合的：单个导入的、框架自带的（库里的顺序） */
  readonly singles: readonly LibrarySkill[];
}

/** 把 skill 库分成集合和单个的（老版本守护进程的目录里没有 collections 时全是单个的） */
export function groupSkills(catalog: Pick<ToolkitCatalog, "skills"> & { collections?: ToolkitCatalog["collections"] | undefined }): SkillGroups {
  const collections = (catalog.collections ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  const known = new Set(collections.map((c) => c.name));
  return {
    collections: collections.map((collection) => ({
      collection,
      members: collection.skills.flatMap((name) => catalog.skills.find((s) => s.name === name) ?? []),
    })),
    singles: catalog.skills.filter((s) => s.collection === undefined || !known.has(s.collection)),
  };
}

/** 一个集合选上了几个：全选、选了一部分、一个没选 */
export interface CollectionPick {
  readonly state: "all" | "some" | "none";
  readonly count: number;
  readonly total: number;
}

export function collectionPick(group: SkillGroup, selected: readonly string[]): CollectionPick {
  const total = group.members.length;
  const count = group.members.filter((m) => selected.includes(m.name)).length;
  return { state: count === 0 ? "none" : count === total ? "all" : "some", count, total };
}

/** 整套选上：没选的成员接在后面 */
export function selectCollection(selected: readonly string[], group: SkillGroup): string[] {
  return [...selected, ...group.members.map((m) => m.name).filter((n) => !selected.includes(n))];
}

/** 整套去掉 */
export function unselectCollection(selected: readonly string[], group: SkillGroup): string[] {
  const names = new Set(group.members.map((m) => m.name));
  return selected.filter((n) => !names.has(n));
}

/** 选上或去掉一个 skill */
export function toggleSkill(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}

/** 选中名单里的一项：集合（选上了至少一个成员的，显示成一项）或单个 skill */
export type SelectionChip =
  | { readonly kind: "collection"; readonly name: string; readonly label: string; readonly pick: CollectionPick }
  | { readonly kind: "skill"; readonly name: string; readonly label: string };

/** 集合那一项上的字：整套选的"pstack（全部 51 个）"，选了一部分的"pstack（3/51）" */
export function collectionChipLabel(name: string, pick: CollectionPick): string {
  return pick.state === "all" ? t("state.skillGroups.chipAll", { name, count: pick.total }) : t("state.skillGroups.chipSome", { name, picked: pick.count, total: pick.total });
}

/** 选中名单怎么显示：集合在前（按集合名），单个的按名单里的顺序；库里已经没有的 skill 照样列出（可以去掉） */
export function selectionChips(selected: readonly string[], groups: SkillGroups): SelectionChip[] {
  const inCollections = new Set(groups.collections.flatMap((g) => g.members.map((m) => m.name)));
  const collectionChips = groups.collections.flatMap((g): SelectionChip[] => {
    const pick = collectionPick(g, selected);
    return pick.state === "none" ? [] : [{ kind: "collection", name: g.collection.name, label: collectionChipLabel(g.collection.name, pick), pick }];
  });
  const singles = selected.filter((n) => !inCollections.has(n)).map((name): SelectionChip => ({ kind: "skill", name, label: name }));
  return [...collectionChips, ...singles];
}

/** "＋ 从 skill 库加"里的一项：整套加一个集合、点开一个集合挑几个、加一个单个的 skill */
export interface AddOption {
  readonly value: string;
  readonly label: string;
}

const ADD_COLLECTION = "collection:";
const PICK_COLLECTION = "pick:";
const ADD_SKILL = "skill:";

/** 加 skill 的候选：没整套选上的集合（整套加、挑几个），没选的单个 skill */
export function addOptions(selected: readonly string[], groups: SkillGroups): AddOption[] {
  const collectionOptions = groups.collections.flatMap((g): AddOption[] => {
    const pick = collectionPick(g, selected);
    if (pick.state === "all" || pick.total === 0) return [];
    const whole: AddOption = { value: `${ADD_COLLECTION}${g.collection.name}`, label: t("state.skillGroups.addWhole", { name: g.collection.name, count: pick.total }) };
    // 已经选了一部分的，挑几个就是点开那一项，不再另给
    return pick.state === "none" ? [whole, { value: `${PICK_COLLECTION}${g.collection.name}`, label: t("state.skillGroups.pickSome", { name: g.collection.name }) }] : [whole];
  });
  const singles = groups.singles.filter((s) => !selected.includes(s.name)).map((s): AddOption => ({ value: `${ADD_SKILL}${s.name}`, label: s.name }));
  return [...collectionOptions, ...singles];
}

/** 选了"＋ 从 skill 库加"里的一项之后：新的名单，以及要点开哪个集合（挑几个时） */
export function applyAddOption(selected: readonly string[], value: string, groups: SkillGroups): { selected: string[]; open?: string } {
  if (value.startsWith(ADD_SKILL)) {
    const name = value.slice(ADD_SKILL.length);
    return { selected: selected.includes(name) ? [...selected] : [...selected, name] };
  }
  const name = value.startsWith(ADD_COLLECTION) ? value.slice(ADD_COLLECTION.length) : value.startsWith(PICK_COLLECTION) ? value.slice(PICK_COLLECTION.length) : undefined;
  const group = groups.collections.find((g) => g.collection.name === name);
  if (!group) return { selected: [...selected] };
  if (value.startsWith(PICK_COLLECTION)) return { selected: [...selected], open: group.collection.name };
  return { selected: selectCollection(selected, group) };
}

/** skill 库页上集合那一行的第二行：来源、版本、几个 skill */
export function collectionMeta(collection: SkillCollectionEntry): string {
  return t("state.skillGroups.meta", { count: collection.skills.length, version: collection.version, source: collection.source });
}

/** 秘书用的 skill 那一栏的说明：默认的、库里还没有的（只有默认的两个可以先于导入留在名单里） */
export function secretarySkillsNote(view: { skills: readonly string[]; isDefault: boolean }, library: readonly LibrarySkill[]): string {
  const missing = view.skills.filter((n) => !library.some((s) => s.name === n));
  const base = view.isDefault ? t("state.skillGroups.defaultList") : "";
  const absent = missing.length > 0 ? t("state.skillGroups.notImported", { count: missing.length, names: missing.join(t("state.skillGroups.listSep")) }) : "";
  return [base, absent].filter(Boolean).join(t("state.skillGroups.clauseSep"));
}

/**
 * 秘书的系统提示里 skill 说明有多长（主会话 2026-10-10 定）：整套选 pstack 这类集合时很长，每轮都带上，
 * 超过 SECRETARY_SKILL_PROMPT_WARN_BYTES（8 KB）提醒一句
 */
export function secretaryPromptSizeText(view: Pick<SecretarySkillsView, "promptChars" | "promptBytes">): { text: string; warn: string | undefined } {
  const kb = (view.promptBytes / 1024).toFixed(1);
  const text = view.promptBytes === 0 ? t("state.skillGroups.promptNone") : t("state.skillGroups.promptSize", { chars: view.promptChars, kb });
  const warn = view.promptBytes > SECRETARY_SKILL_PROMPT_WARN_BYTES ? t("state.skillGroups.promptWarn", { limit: SECRETARY_SKILL_PROMPT_WARN_BYTES / 1024 }) : undefined;
  return { text, warn };
}
