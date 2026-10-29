// 运行时核实过的用户原话、立项要求变更、重做时直接改阶段（125 号票）在页面上怎么显示、交出什么（纯函数）。
// - 核实过的原话：守护进程核对过、单独一栏交来的（计划变更卡、立项要求变更卡、阶段的评审输入），每条一行原文，下面写从哪来
//   （时间 · 会话 · 设备，语音转写、经秘书转达另写）；agent 正文里写的"用户已同意"不在这里；
// - 立项要求变更卡：逐条对照新旧（目标、首版前后两句，范围去掉的和加上的）；项目页立项书一节下列这个项目的这几张卡；
// - 重做对话框里改这一阶段的验收标准、交付件：改过的那条记着原来是第几条（守护进程沿用它的验收方式），新加的不记；
//   和原来一样的那一栏不交，都没改就不交 stageEdit。
import type { UiState } from "./ui-state.ts";
import { CHARTER_FIELD_LABEL, type CharterChangeCardPayload, type StageEdit, t, userWordsSource, type VerifiedUserWords } from "./protocol.ts";

/** 一条原话在页面上：原文，和它从哪来 */
export interface UserWordsRow {
  key: string;
  text: string;
  source: string;
}

export function userWordsRows(words: readonly VerifiedUserWords[] | undefined): UserWordsRow[] {
  return (words ?? []).map((w, i) => ({ key: `${w.messageId}:${i}`, text: w.text, source: userWordsSource(w) }));
}

/** 立项要求变更卡上的一处：目标、首版写前后两句；范围写去掉的和加上的 */
export type CharterChangeRow = { key: string; label: string } & ({ kind: "replace"; before: string; after: string } | { kind: "scope"; removed: string[]; added: string[] });

export function charterChangeRows(p: Pick<CharterChangeCardPayload, "changes">): CharterChangeRow[] {
  return p.changes.map((c) =>
    c.field === "scope"
      ? { key: c.field, label: CHARTER_FIELD_LABEL[c.field], kind: "scope", removed: c.removed, added: c.added }
      : { key: c.field, label: CHARTER_FIELD_LABEL[c.field], kind: "replace", before: c.before, after: c.after },
  );
}

/** 这个项目的立项要求变更卡（项目页立项书一节下面列着），先提的在前 */
export function projectCharterChangeCards(state: UiState, projectId: string): string[] {
  return Object.values(state.cards)
    .map((s) => s.card)
    .filter((c) => c.type === "charter_change" && (c.payload as Partial<CharterChangeCardPayload>).projectId === projectId)
    .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((c) => c.id);
}

/** 重做对话框里一条验收标准的草稿：from 是它原来是第几条（0 起；新加的没有） */
export interface AcceptanceDraft {
  text: string;
  from?: number;
}

/** 重做对话框里这一阶段的草稿 */
export interface StageEditDraft {
  acceptance: readonly AcceptanceDraft[];
  deliverables: readonly string[];
}

/** 打开对话框时的草稿：原来的验收标准（各记着自己是第几条）、交付件 */
export function stageEditDraft(criteria: readonly string[], deliverables: readonly string[]): StageEditDraft {
  return { acceptance: criteria.map((text, from) => ({ text, from })), deliverables: [...deliverables] };
}

/** 草稿里还交不出去的原因（验收标准、交付件都得至少留一条）；能交是 undefined */
export function stageEditProblem(draft: StageEditDraft): string | undefined {
  if (!draft.acceptance.some((a) => a.text.trim())) return t("state.userWords.needCriterion");
  if (!draft.deliverables.some((d) => d.trim())) return t("state.userWords.needDeliverable");
  return undefined;
}

/**
 * 草稿和原来比，交出改了的那几栏（空的条目不要，首尾空白去掉）；都没改是 undefined。
 * 验收标准按"第几条、写的什么"比：删了一条、加了一条、改了字、换了先后都算改了
 */
export function stageEditOf(criteria: readonly string[], deliverables: readonly string[], draft: StageEditDraft): StageEdit | undefined {
  const acceptance = draft.acceptance
    .map((a) => ({ criterion: a.text.trim(), ...(a.from === undefined ? {} : { from: a.from }) }))
    .filter((a) => a.criterion.length > 0);
  const delivered = draft.deliverables.map((d) => d.trim()).filter((d) => d.length > 0);
  const sameAcceptance = acceptance.length === criteria.length && acceptance.every((a, i) => a.from === i && a.criterion === criteria[i]);
  const sameDeliverables = delivered.length === deliverables.length && delivered.every((d, i) => d === deliverables[i]);
  const edit: StageEdit = {
    ...(sameAcceptance || acceptance.length === 0 ? {} : { acceptance }),
    ...(sameDeliverables || delivered.length === 0 ? {} : { deliverables: delivered }),
  };
  return edit.acceptance || edit.deliverables ? edit : undefined;
}
