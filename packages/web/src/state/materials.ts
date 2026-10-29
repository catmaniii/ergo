// 看素材（158 号票，用户 2026-10-18 要的"删除素材的地方能看每条素材的内容"；167 号票起在记忆 · 素材，浏览、搜、筛的推导在 material-browse.ts）：
// - 列表的一行（materialRow）：种类和时间、会话（界面按 conversationName 写名字，159 号票）、摘录、标记的小签；
// - 详情里的每一段（materialBlocks）：本人的话全文；引用块写原文（守护进程从出处的消息里补上的，去掉行首的 >）；附件、语音按消息里的
//   part 照会话里的样子画（图片、文件卡片、语音条加识别出的文字）；只记了引用的（网页、卡片、出处不在了的附件和引用块）写引用的说明；
// - 来源（materialFacts）：种类 · 说或做 · 来源等级一行，时间、会话、任务、项目、出处的消息现在怎样、卡片、记录、原文副本、原始事件、情境各一行；
// - 跳到出处的那条消息（materialJump）：出处的消息还在当前分支上才跳得过去，去哪个页面和待办的"去看看 ›"同一个认法（inbox-jump.ts）；
// - 详情里的三种删法（materialDeleteChoices）：口径同设置里按范围删（MEMORY_DELETE_MODE_INFO），已经标过不参与推断的"别推断"灰着。
// - 你存的网页（165 号票，"浏览"的 ⋮ 菜单里存进素材的）：网页那一段画成标题、网址和存下的正文（守护进程从原始事件里补上的，外部数据），
//   截断了写明；情境标签 saved_web_page 写成"你存的网页"。
import { conversationAtJump, type InboxJump } from "./inbox-jump.ts";
import {
  type MaterialDetailView,
  type MaterialListItem,
  type MaterialMarks,
  type MaterialSegmentForm,
  type MaterialSegmentView,
  type MaterialSourceLevel,
  MEMORY_COMMAND_LABEL,
  MEMORY_DELETE_MODES,
  type MemoryDeleteMode,
  type MessagePart,
  SAVED_WEB_PAGE_CONTEXT,
  t,
  tTable,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 来源等级的说法 */
export const MATERIAL_SOURCE_LABEL: Readonly<Record<MaterialSourceLevel, string>> = tTable({
  self: "state.materials.source.self",
  agent: "state.materials.source.agent",
  external_untrusted: "state.materials.source.externalUntrusted",
  system: "state.materials.source.system",
});

/** 切段形态的说法（agent 的产出在素材里只有卡片这一种引用） */
const FORM_LABEL: Readonly<Record<MaterialSegmentForm, string>> = tTable({
  typed: "state.materials.form.typed",
  text: "state.materials.form.text",
  quote: "state.materials.form.quote",
  attachment: "state.materials.form.attachment",
  web_page: "state.materials.form.webPage",
  voice: "state.materials.form.voice",
  choice: "state.materials.form.choice",
  agent_output: "state.materials.form.agentOutput",
});

const MODE_LABEL = tTable({ say: "state.materials.mode.say", do: "state.materials.mode.do" });

/** 情境标签里有说法的（别的照原样写） */
const CONTEXT_LABEL: Readonly<Record<string, string>> = tTable({ [SAVED_WEB_PAGE_CONTEXT]: "state.materials.context.savedWebPage" });

/** "2026-10-06T22:40:00.000+08:00" → "10-06 22:40"（year 时带年份） */
function minuteOf(iso: string, year = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${year ? `${m[1]}-` : ""}${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 标记的小签：不参与推断、在废弃分支里、项目「X」的内部记录 */
export function materialMarkChips(marks: MaterialMarks): string[] {
  return [
    ...(marks.noInfer ? [t("state.materials.chip.noInfer")] : []),
    ...(marks.abandoned ? [t("state.materials.chip.abandoned")] : []),
    ...(marks.internal ? [t("state.materials.chip.internal", { project: marks.internal.projectName })] : []),
    // 284 号票：了解你访谈里说的
    ...(marks.interview ? [t("state.materials.chip.interview")] : []),
  ];
}

export interface MaterialRow {
  readonly id: string;
  /** 种类和时间："用户发言 · 10-06 22:40" */
  readonly title: string;
  /** 来源会话（界面写名字）；不来自会话的没有 */
  readonly conversation: string | undefined;
  readonly excerpt: string;
  readonly chips: readonly string[];
}

/** 列表里的一行 */
export function materialRow(item: MaterialListItem): MaterialRow {
  return { id: item.id, title: `${item.kind} · ${minuteOf(item.time)}`, conversation: item.conversation, excerpt: item.excerpt || t("state.materials.noText"), chips: materialMarkChips(item.marks) };
}

/** 详情里的一段怎么画 */
export type MaterialBlock =
  /** 本人的话（打的字、文字、你的选择、没有录音的语音转写）：全文 */
  | { readonly kind: "text"; readonly title: string; readonly text: string }
  /** 引用块：原文 */
  | { readonly kind: "quote"; readonly title: string; readonly text: string }
  /** 附件（图片、文件、视频）：照会话里画 */
  | { readonly kind: "part"; readonly title: string; readonly part: MessagePart }
  /** 语音：语音条（照会话里画）加识别出的文字 */
  | { readonly kind: "voice"; readonly title: string; readonly part: Extract<MessagePart, { type: "voice" }>; readonly text: string }
  /** 只记了引用的：网页、卡片、出处不在了的附件和引用块 */
  | { readonly kind: "ref"; readonly title: string; readonly text: string; readonly url?: string }
  /** 你存的网页（165 号票）：标题、网址（能点）、存下的正文（外部数据）；截断了 note 写明 */
  | { readonly kind: "page"; readonly title: string; readonly pageTitle: string; readonly url: string; readonly text: string; readonly note?: string };

/** 一段的标题："本人 · 打的字"、"本人 · 你的选择（agent 先提出）"、"外部、不可信 · 引用块" */
function blockTitle(s: MaterialSegmentView): string {
  // 语音转写本身就写着"转写"，不再重复注明
  const params = { source: MATERIAL_SOURCE_LABEL[s.source], form: FORM_LABEL[s.form] };
  return t(s.notes.includes("agent_proposed") ? "state.materials.blockTitleProposed" : "state.materials.blockTitle", params);
}

/** 引用块的原文去掉行首的 >（Markdown 引用的记号，最多三个空格加 > 和一个空格） */
const unquote = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^ {0,3}> ?/, ""))
    .join("\n");

function blockOf(s: MaterialSegmentView): MaterialBlock {
  const title = blockTitle(s);
  switch (s.form) {
    case "quote":
      // 303 号票：数据源里别人写给你的，引用块只留插件整理的摘要（说明），没有出处的消息
      if (s.quoted !== undefined) return { kind: "quote", title, text: unquote(s.quoted) };
      return { kind: "ref", title, text: s.label ?? t("state.materials.quoteRefGone", { hash: (s.sha256 ?? "").slice(0, 8) }) };
    case "attachment":
      return s.part ? { kind: "part", title, part: s.part } : { kind: "ref", title, text: t("state.materials.attachmentRefGone", { name: s.label ?? s.media?.name ?? t("state.materials.attachment") }) };
    case "voice":
      return s.part?.type === "voice" ? { kind: "voice", title, part: s.part, text: s.text ?? "" } : { kind: "text", title, text: s.text ?? "" };
    case "web_page":
      if (s.saved && s.url) {
        const note = s.saved.truncated ? t("state.materials.savedTruncated", { saved: s.saved.text.length, total: s.saved.total }) : undefined;
        return { kind: "page", title, pageTitle: s.saved.title.trim() || s.url, url: s.url, text: s.saved.text, ...(note ? { note } : {}) };
      }
      return { kind: "ref", title, text: s.label ?? s.url ?? "", ...(s.url ? { url: s.url } : {}) };
    case "agent_output":
      return { kind: "ref", title, text: s.label ?? t("state.materials.refOnly") };
    case "typed":
    case "text":
    case "choice":
      return { kind: "text", title, text: s.text ?? "" };
  }
}

/** 详情里的每一段，按素材里的先后 */
export function materialBlocks(view: MaterialDetailView): MaterialBlock[] {
  return view.segments.map(blockOf);
}

export interface MaterialFact {
  readonly label: string;
  readonly value: string;
  /** 值是会话 id（界面写名字） */
  readonly conversation?: true;
  /** 等宽字（原始事件） */
  readonly mono?: true;
}

const MESSAGE_STATE_TEXT = tTable({
  shown: "state.materials.message.shown",
  abandoned: "state.materials.message.abandoned",
  gone: "state.materials.message.gone",
});

/** 来源：头一行"种类 · 说或做 · 来源等级"，下面一行一项 */
export function materialFacts(view: MaterialDetailView): { head: string; rows: MaterialFact[] } {
  const rows: MaterialFact[] = [{ label: t("state.materials.fact.time"), value: minuteOf(view.time, true) }];
  if (view.conversation !== undefined) rows.push({ label: t("state.materials.fact.conversation"), value: view.conversation, conversation: true });
  if (view.taskId !== undefined) rows.push({ label: t("state.materials.fact.task"), value: view.taskId });
  if (view.projectId !== undefined) rows.push({ label: t("state.materials.fact.project"), value: view.projectId });
  if (view.message) rows.push({ label: t("state.materials.fact.message"), value: `${view.message.id} · ${MESSAGE_STATE_TEXT[view.message.state]}` });
  if (view.cardId !== undefined) rows.push({ label: t("state.materials.fact.card"), value: view.cardId });
  if (view.recordId !== undefined) rows.push({ label: t("state.materials.fact.record"), value: view.recordId });
  rows.push({ label: t("state.materials.fact.original"), value: view.original ?? t("state.materials.noOriginal") });
  rows.push({ label: t("state.materials.fact.event"), value: t("state.materials.eventValue", { channel: view.event.channel, seq: view.event.seq, type: view.event.type }), mono: true });
  if (view.context.length > 0) rows.push({ label: t("state.materials.fact.context"), value: view.context.map((c) => CONTEXT_LABEL[c] ?? c).join(t("state.materials.listSep")) });
  const sourceLabel = view.source === "agent" ? "agent" : MATERIAL_SOURCE_LABEL[view.source];
  return { head: `${view.kind} · ${MODE_LABEL[view.mode]} · ${sourceLabel}`, rows };
}

/** 跳到出处的那条消息去哪；出处的消息不在当前分支上（在废弃分支里、不在了）、认不出会话的跳不过去 */
export function materialJump(state: UiState, view: MaterialDetailView): InboxJump | undefined {
  if (view.message?.state !== "shown" || view.conversation === undefined) return undefined;
  return conversationAtJump(state, view.conversation, { taskId: view.taskId, projectId: view.projectId }, view.message.id);
}

export interface MaterialDeleteChoice {
  readonly mode: MemoryDeleteMode;
  readonly label: string;
  /** 点不了的原因 */
  readonly disabled?: string;
}

/** 详情里的三种删法（同设置里按范围删的口径） */
export function materialDeleteChoices(view: MaterialDetailView): MaterialDeleteChoice[] {
  return MEMORY_DELETE_MODES.map((mode) => ({
    mode,
    label: MEMORY_COMMAND_LABEL[mode],
    ...(mode === "no_infer" && view.marks.noInfer ? { disabled: t("state.materials.alreadyNoInfer") } : {}),
  }));
}
