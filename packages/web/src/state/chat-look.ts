// 聊天区精简：对话层里每一条长什么样。纯函数，界面照它画，回放测试也测它。
//
// 照旧的：
// - 用户气泡：整条可点（.user），不带记号；
// - 回复：按 Markdown 画，按第一个空行切成第一段和后文（AssistantBubble 的 indexOf("\n\n")）；有后文时气泡里给
//   "收起 ▴ / 展开细节 ▾"和"详情 ›"，只有一段的两个都没有。默认整段展开（REPLY_OPEN_BY_DEFAULT）；
// - 语音：同框，详情在长按菜单里；分隔线、已删除、插件没启用的占位。
// 收成一行的（ChatLine，"对话里的过程条目统一成一行"）：思考、工具调用组、调用记忆、agent 之间的来信、卡片、时间线记录、
// 系统说明、分支摘要。一行是：图标、标题、一句话（放不下的省略号截掉，不换行）、句子后面的小签（工具调用的状况、卡片的状态、时间），
// 行尾一个 ›（没有"详情"两个字）；整行点开这一条的详情，打不开详情的不画 ›。每行一样宽（对话气泡最宽的那个宽度），› 在同一条竖线上。
// 每种写什么：
// - 思考：标题"思考"，原文的第一句（thinkingSentence：按句号、问号、叹号、换行切，中英标点都认）；正在想写"正在想…"（字轻轻明暗）；
//   原文是空的写"没留下想法的原文"；
// - 工具调用：标题"工具调用"，挑一步说（pickToolStep）：有出状况的（被拦下、你拒绝了、等你批准、出错、问过你）写出状况的那一步，
//   否则有正在执行的写正在执行的那一步，都做完写最后一步；不止一步时后面"等 N 步"。MCP 工具写得出是哪个 MCP（call-sentence.ts）。
//   小签照旧：出了状况的醒目（被拦下一类 / 跟你有关的一类），命中关注类别、顺利执行的平和；还有调用在执行时圆点一闪一闪；
// - 调用记忆：标题"记忆"，"回忆了 N 条记忆"；界面取到第一条记忆的标题时换成"回忆了 N 条：<标题>"（memory-recall.ts 的 recallLineTitled）；
// - 来信：标题是种类（任务做完、负责人来信、<名字>转达、计划检查；折起来的长通知写"通知"），一句话总结，后面时间；
// - 卡片：标题是卡片种类，卡片纯文本的第一行（开头和标题重复的"种类："去掉），后面状态——处理过的写结果（"已批准"）、
//   关掉的"已关闭"、过期的"已过期"（平和）；简单提醒、服务入口不用你做决定，不写状态。
//   等你拍板的卡（还没处理、要你点按钮的，cards.ts 的 cardWaitsForYou：立项书、计划、验收、各种变更、审批、提问……）不收成一行，
//   整张画、按钮直接看得到（462，"但凡需要我确认、点那个确认按钮的卡片都要默认展开"），处理过了照常收成一行；
//   一行上的"等你确认""等你批准""等你回答"……（CARD_ASK，跟你有关的颜色）留给收成一行的地方用（cardStatus）。
//   打不开详情的卡（还没收到这张卡）照旧整张画（form card）；
//   要在对话里直接看的卡（地图卡片的缩略图，CARD_STAYS_WHOLE）像图片附件一样照旧整张画；
// - 时间线记录：标题是记录种类（偏离、越界、操作记录、重做……），摘要，后面时间；越界这类警示的、没做成的操作醒目；原来的第二行说明在详情里；
// - 系统说明：标题"说明"，第一行；
// - 分支摘要：标题"回退"，摘要的第一句；恢复了哪些文件在详情里。
import type { AgentLetter } from "./agent-letters.ts";
import { CARD_ACTION_LABEL, type CardAsk, cardAskOf, CARD_TYPE_LABEL, cardTypeLabel, cardWaitsForYou } from "./cards.ts";
import { type CallIssue, CALL_ISSUE_LABEL, CALL_ISSUES, type ChatItem, type ChatToolCall } from "./chat-items.ts";
import { firstRecallMaterial } from "./memory-recall.ts";
import { type Card, type CardType, currentWording, DISPOSITION_LABEL, isCardType, isTimelineRecordKind, t, TIMELINE_RECORD_KIND_INFO, tTable, type WorkflowPlanCardPayload } from "./protocol.ts";
import { MARK_KIND_LABEL, opReasonOf } from "./timeline.ts";
import { workflowPlanStateLabel } from "./workflow-view.ts";

/**
 * 回复默认整段展开还是只显示第一段（原先写的是只显示第一段）。默认整段展开
 * （"Agent 的汇报是你最关心的：默认整段展开，长了自己收起"）
 */
export const REPLY_OPEN_BY_DEFAULT = true;

/** 缩小后组里一段思考那一块（对话层那一层）的字："💭 Agent 的想法（点开看）"，正在想时"💭 Agent 正在想…"（按当前语言现取） */
export function thinkingLabel(live = false): string {
  return live ? t("state.chatLook.thinkingLive") : t("state.chatLook.thinking");
}

/** 有详情的条目怎么打开：整条可点、旁边的"详情 ›"、整行（行尾 ›）、长按菜单；打不开的没有 */
export type ChatOpen = "whole" | "link" | "row" | "menu";

/** 一行小签的颜色档：出了状况的醒目（被拦下一类 / 跟你有关的一类），顺利执行的平和 */
export type ToolLineTagLevel = "stopped" | "you" | "op" | "ok" | "quiet";

/** 一行句子后面的小签："1 次被拦下"、"等你批准"、"已批准" */
export interface ChatLineTag {
  readonly key: string;
  readonly text: string;
  readonly level: ToolLineTagLevel;
}

/** 工具调用那一行的一个小签："1 次被拦下"、"2 次做完告诉你" */
export interface ToolLineTag extends ChatLineTag {
  /** 出的状况；顺利执行的：做完告诉你（notify）、授权内（granted）、命中了关注类别但直接做只记录（logged） */
  readonly key: CallIssue | "notify" | "granted" | "logged";
  readonly count: number;
}

export const CHAT_LINE_KINDS = ["thinking", "tool", "recall", "letter", "card", "record", "note", "branch"] as const;
/** 收成一行的是哪一种：思考、工具调用组、调用记忆、来信、卡片、时间线记录、系统说明、分支摘要 */
export type ChatLineKind = (typeof CHAT_LINE_KINDS)[number];

/** 收成一行的一条（见文件开头） */
export interface ChatLine {
  readonly form: "line";
  readonly kind: ChatLineKind;
  /** 标题：思考、工具调用、记忆、来信的种类、卡片种类、记录种类、说明、回退（守护进程的说法里的名字占位留着，界面照名字画） */
  readonly title: string;
  /** 一句话（名字占位留着）；放不下的界面省略 */
  readonly text: string;
  /** 工具调用不止一步：一共几步（句子后面"等 N 步"）；别的没有 */
  readonly steps: number | undefined;
  /** 句子后面的小签：工具调用的状况、卡片的状态 */
  readonly tags: readonly ChatLineTag[];
  /** 来信、记录：什么时候（带时区的 ISO，界面写成"14:02"）；别的没有 */
  readonly time: string | undefined;
  /** 出了状况，这一行醒目：被拦下一类（stopped）、跟你有关的一类（you：等你批准、问过你、没处理的卡片） */
  readonly alert: "stopped" | "you" | undefined;
  /** 正在进行：工具调用还有在执行的（圆点一闪一闪），思考正在想（字轻轻明暗） */
  readonly live: boolean;
  /** 淡一点：调用记忆没找到、认不出条数 */
  readonly dim: boolean;
  /** 来信一行最前面的图标；别的界面按种类画 */
  readonly icon: string | undefined;
  /** 卡片的种类（卡片那一行）；别的没有 */
  readonly cardType: string | undefined;
  /** 调用记忆用到的第一条记忆的素材 id（界面按它取标题）；别的、一条都没有的没有 */
  readonly recallFirst: string | undefined;
  /** 整行点开（行尾 ›）；打不开详情的没有 */
  readonly open: "row" | undefined;
}

/** 对话层里一条的样子 */
export type ChatLook =
  | { readonly form: "user"; readonly open: ChatOpen | undefined }
  | { readonly form: "voice"; readonly open: ChatOpen | undefined }
  | {
      readonly form: "reply";
      /** 第一段（没有空行就是全文） */
      readonly head: string;
      /** 第一段之后还有内容：给"收起 ▴ / 展开细节 ▾"和"详情 ›" */
      readonly more: boolean;
      readonly open: ChatOpen | undefined;
    }
  | ChatLine
  /**
   * 整张画的卡片，按钮在卡上：打不开详情的（还没收到这张卡，open 是 undefined）；要直接看的（地图卡片，CARD_STAYS_WHOLE）、
   * 等你拍板的（还没处理、要你点按钮的，cardWaitsForYou），能开详情的卡下面照旧"详情"（open 是 link）
   */
  | { readonly form: "card"; readonly open: "link" | undefined }
  | { readonly form: "divider"; readonly open: undefined }
  | { readonly form: "deleted"; readonly open: undefined }
  /** 插件没启用、这条内容暂时看不到：一行占位，样子同"已删除"，点不开 */
  | { readonly form: "unavailable"; readonly text: string; readonly open: undefined };

/** 回复按第一个空行切成第一段和后文 */
export function replyCut(text: string): { head: string; rest: string } {
  const cut = text.indexOf("\n\n");
  return cut > 0 ? { head: text.slice(0, cut), rest: text.slice(cut + 2).trim() } : { head: text, rest: "" };
}

// ───────────────────────── 每种写什么 ─────────────────────────

/** 一行的标题（按当前语言现取） */
const TITLE = tTable({
  thinking: "state.chatLook.title.thinking",
  tool: "state.chatLook.title.tool",
  recall: "state.chatLook.title.recall",
  notice: "state.chatLook.title.notice",
  note: "state.chatLook.title.note",
  branch: "state.chatLook.title.branch",
});

/** 思考那一句最多几个字（超出的截掉、写"…"；放不下的界面再省略） */
export const THINKING_SENTENCE_MAX = 120;

/**
 * 思考原文的第一句：去掉 Markdown 记号，取第一个非空行，按句号、问号、叹号切（中英标点都认；英文句号要后面是空白或行尾，
 * "t-3.md""3.5"里的点不算）。句号不留，问号、叹号留着；截到 THINKING_SENTENCE_MAX 字。原文是空的是空串
 */
export function thinkingSentence(text: string): string {
  const first = text
    .replace(/[#*`>|]+/g, " ")
    .replace(/(^|\s)[-_]+(?=\s|$)/gm, "$1 ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (first === undefined) return "";
  // @i18n-ignore-next data：认思考原文里的句末标点（中英都认）
  const end = /[。！？!?]|\.(?=\s|$)/.exec(first);
  // @i18n-ignore-next data：句号（中英）不留
  const sentence = end ? first.slice(0, end.index + (/[。.]/.test(end[0]) ? 0 : 1)).trim() || first : first;
  return sentence.length > THINKING_SENTENCE_MAX ? `${sentence.slice(0, THINKING_SENTENCE_MAX)}…` : sentence;
}

/** 思考那一行：正在想写"正在想…"，否则原文第一句，原文空的写一句说明 */
export function thinkingLine(text: string, live: boolean, open: ChatLine["open"] = undefined): ChatLine {
  const said = live ? t("state.chatLook.thinkingNow") : thinkingSentence(text) || t("state.chatLook.thinkingEmpty");
  return line({ kind: "thinking", title: TITLE.thinking, text: said, live, open });
}

/**
 * 工具调用那一句挑哪一步：有出状况的写出状况的那一步（按状况的固定先后 CALL_ISSUES 挑最前的那种，和小签的先后一样；同一种取最后一次），
 * 否则有正在执行的写正在执行的那一步（取最后一次），都做完写最后一步。calls 至少一个
 */
export function pickToolStep(calls: readonly ChatToolCall[]): ChatToolCall {
  for (const issue of CALL_ISSUES) {
    const hit = calls.findLast((c) => c.issue === issue);
    if (hit) return hit;
  }
  return calls.findLast((c) => c.part.outcome === "running") ?? calls.at(-1)!;
}

/** 出的状况在那一行上算哪一档：等你批准、问过你跟你有关；被拦下、你拒绝了、出错是被拦下一类（和组的详情里的小签同一个分法） */
const ISSUE_LEVEL: Readonly<Record<CallIssue, ToolLineTagLevel>> = { blocked: "stopped", denied: "stopped", error: "stopped", waiting: "you", asked: "you" };

/** 顺利执行、有要说的那几种（命中关注类别的处置）：小签上的说法（按当前语言现取）和颜色 */
const CALM_TAGS = {
  notify: { label: () => t("state.chatLook.calm.notify"), level: "op" },
  granted: { label: () => t("state.chatLook.calm.granted"), level: "ok" },
  logged: { label: () => DISPOSITION_LABEL.do, level: "quiet" },
} as const satisfies Record<string, { label: () => string; level: ToolLineTagLevel }>;

/** 一次顺利执行的调用在那一行上算哪种：做完告诉你、授权内、命中了关注类别但直接做只记录；都不是的不标 */
function calmKind(call: ChatToolCall): keyof typeof CALM_TAGS | undefined {
  const reason = opReasonOf(call.part);
  if (reason === "notify") return "notify";
  if (reason === "granted") return "granted";
  return call.part.categoryTitles.length > 0 ? "logged" : undefined;
}

/** 工具调用那一行的小签：出了状况的在前（按 CALL_ISSUES 的先后），然后是做完告诉你、授权内、直接做只记录 */
function toolTags(item: Extract<ChatItem, { kind: "tool_group" }>): ToolLineTag[] {
  const tags: ToolLineTag[] = item.issues.map(({ issue, count }) => ({ key: issue, count, text: t("state.chatLook.tagCount", { count, label: CALL_ISSUE_LABEL[issue] }), level: ISSUE_LEVEL[issue] }));
  const calm = new Map<keyof typeof CALM_TAGS, number>();
  for (const call of item.calls) {
    if (call.issue !== undefined) continue;
    const kind = calmKind(call);
    if (kind) calm.set(kind, (calm.get(kind) ?? 0) + 1);
  }
  for (const kind of Object.keys(CALM_TAGS) as (keyof typeof CALM_TAGS)[]) {
    const count = calm.get(kind);
    if (count) tags.push({ key: kind, count, text: t("state.chatLook.tagCount", { count, label: CALM_TAGS[kind].label() }), level: CALM_TAGS[kind].level });
  }
  return tags;
}

/** 工具调用组那一行：挑出的那一步、一共几步、小签、醒不醒目、还有没有在执行的 */
function toolLine(item: Extract<ChatItem, { kind: "tool_group" }>): ChatLine {
  const levels = new Set(item.issues.map((i) => ISSUE_LEVEL[i.issue]));
  return line({
    kind: "tool",
    title: TITLE.tool,
    text: pickToolStep(item.calls).sentence.text,
    steps: item.calls.length > 1 ? item.calls.length : undefined,
    tags: toolTags(item),
    alert: levels.has("stopped") ? "stopped" : levels.has("you") ? "you" : undefined,
    live: item.calls.some((c) => c.part.outcome === "running"),
    open: item.detail ? "row" : undefined,
  });
}

/**
 * 对话里照旧整张画、不收成一行的卡：卡本身就是要看的内容（地图卡片的缩略地图，出来就是已处理、没有要你点的），
 * 像图片、文件附件一样留在对话里；收成一行就看不到图了
 */
export const CARD_STAYS_WHOLE: ReadonlySet<string> = new Set<CardType>(["map"]);

const CARD_ASK_TEXT: Readonly<Record<CardAsk, string>> = tTable({
  confirm: "state.chatLook.cardAsk.confirm",
  approve: "state.chatLook.cardAsk.approve",
  answer: "state.chatLook.cardAsk.answer",
  decide: "state.chatLook.cardAsk.decide",
  check: "state.chatLook.cardAsk.check",
  pick: "state.chatLook.cardAsk.pick",
  review: "state.chatLook.cardAsk.review",
});

/** 卡片纯文本开头的"<种类>："、"<种类>（…）："（守护进程的写法；种类可能是简称，"计划："之于"计划确认"） */
const CARD_TEXT_HEAD = /^([^：:（(]{1,24}?)\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*/; // @i18n-ignore data：认守护进程写的卡片纯文本开头（中文的全角冒号、括号）

/**
 * 卡片那一句：纯文本的第一行（守护进程写的，换成现在的说法）。开头是"<种类>："或"<种类>（…）："的去掉（标题已经写了种类；
 * 开头那个词是种类说法的开头也算，"计划：…"之于"计划确认"）；流程计划卡写"计划 v2 · 4 步"
 */
export function cardSentence(card: Card): string {
  if (card.type === "workflow_plan") {
    const p = card.payload as WorkflowPlanCardPayload;
    return t("state.chatLook.workflowPlan", { revision: p.revision, count: p.plan.steps.length });
  }
  const first = currentWording(card.text)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (first === undefined) return "";
  const label = isCardType(card.type) ? CARD_TYPE_LABEL[card.type] : undefined;
  const head = CARD_TEXT_HEAD.exec(first);
  const word = head?.[1]?.trim();
  if (label === undefined || head === null || !word || !label.startsWith(word)) return first;
  return first.slice(head[0].length) || first;
}

/** 卡片那一行的状态：没处理的等你做什么（跟你有关），处理过的写结果、关掉的、过期的（平和）；不用你做决定的卡不写 */
export function cardStatus(card: Card): ChatLineTag | undefined {
  const ask = cardAskOf(card.type);
  if (ask === null) return undefined;
  if (card.type === "workflow_plan") return { key: card.status, text: workflowPlanStateLabel(card), level: card.status === "pending" ? "you" : "quiet" };
  switch (card.status) {
    case "pending":
      return { key: "pending", text: CARD_ASK_TEXT[ask], level: "you" };
    case "handled":
      return { key: "handled", text: card.outcome ? CARD_ACTION_LABEL[card.outcome.action] : t("state.detailContent.card.handled"), level: "quiet" };
    case "dismissed":
      return { key: "dismissed", text: t("model.cards.dismissed"), level: "quiet" };
    case "expired":
      return { key: "expired", text: t("model.cards.expired"), level: "quiet" };
  }
}

/** 卡片那一行（收到了这张卡的） */
function cardLine(item: Extract<ChatItem, { kind: "card" }>, card: Card): ChatLine {
  const status = cardStatus(card);
  return line({
    kind: "card",
    title: cardTypeLabel(card.type),
    text: cardSentence(card),
    tags: status ? [status] : [],
    alert: status?.key === "pending" ? "you" : undefined,
    cardType: card.type,
    open: item.detail ? "row" : undefined,
  });
}

/** 时间线记录那一行：种类、摘要、时间；越界这类警示的、没做成的操作醒目 */
function recordLine(item: Extract<ChatItem, { kind: "record" }>): ChatLine {
  const { record } = item;
  const open = item.detail ? ("row" as const) : undefined;
  if (record.type === "operation") {
    const op = record.operation;
    const text = t("state.chatLook.operation", { title: currentWording(op.title), summary: currentWording(op.result.summary) });
    return line({ kind: "record", title: MARK_KIND_LABEL.operation, text, time: item.time, alert: op.result.ok ? undefined : "stopped", open });
  }
  const { kind, summary } = record.timeline;
  const info = isTimelineRecordKind(kind) ? TIMELINE_RECORD_KIND_INFO[kind] : undefined;
  return line({ kind: "record", title: info?.label ?? t("state.detailContent.record"), text: currentWording(summary), time: item.time, alert: info?.severity === "alert" ? "stopped" : undefined, open });
}

/** 来信那一行：种类（折起来的长通知写"通知"）、一句话总结、时间 */
function letterLine(letter: AgentLetter, time: string | undefined, open: ChatLine["open"]): ChatLine {
  return line({ kind: "letter", title: letter.kind === "notice" ? TITLE.notice : letter.label, text: letter.summary, time, icon: letter.icon, open });
}

/** 第一个非空行（守护进程写的话：不去 Markdown 记号） */
function firstLineOf(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

/** 一行的默认值 */
function line(o: Pick<ChatLine, "kind" | "title" | "text"> & Partial<Omit<ChatLine, "form" | "kind" | "title" | "text">>): ChatLine {
  return {
    form: "line",
    steps: undefined,
    tags: [],
    time: undefined,
    alert: undefined,
    live: false,
    dim: false,
    icon: undefined,
    cardType: undefined,
    recallFirst: undefined,
    open: undefined,
    ...o,
  };
}

/** 对话层里这一条长什么样 */
export function chatLook(item: ChatItem): ChatLook {
  const detail = item.detail !== undefined;
  const row = detail ? ("row" as const) : undefined;
  // agent 之间的来信（秘书转达的用户消息、运行时的系统通知）：一行
  if ((item.kind === "user" || item.kind === "system") && item.letter) return letterLine(item.letter, item.time, row);
  switch (item.kind) {
    case "user":
      return { form: "user", open: detail ? "whole" : undefined };
    case "voice":
      return { form: "voice", open: detail ? "menu" : undefined };
    case "thinking":
      return thinkingLine(item.text, item.streaming, row);
    case "reply": {
      // 漏了中间增量的回复不拼残缺的文字（只占一个"正在回复"的位置）
      const { head, rest } = replyCut(item.broken ? "" : item.text);
      const more = rest.length > 0;
      return { form: "reply", head, more, open: detail && more ? "link" : undefined };
    }
    case "tool_group":
      return toolLine(item);
    case "recall":
      return line({ kind: "recall", title: TITLE.recall, text: item.keyLine, dim: item.recall.count === 0, recallFirst: firstRecallMaterial(item.calls.map((c) => c.part)), open: row });
    case "card":
      // 要直接看的（地图卡片）、等你拍板的（还没处理、要你点按钮的）整张画，按钮在卡上；处理过了照常收成一行
      if (item.card && (CARD_STAYS_WHOLE.has(item.card.type) || cardWaitsForYou(item.card))) return { form: "card", open: detail ? "link" : undefined };
      return item.card && detail ? cardLine(item, item.card) : { form: "card", open: undefined };
    case "system":
      // 分支摘要：标题"回退"，摘要的第一句
      if (item.branch) return line({ kind: "branch", title: TITLE.branch, text: thinkingSentence(currentWording(item.branch.summary)), open: row });
      // 系统说明：标题"说明"，第一行（只有附件的系统消息是空的，界面只画附件）
      return line({ kind: "note", title: TITLE.note, text: firstLineOf(currentWording(item.text)), open: row });
    case "record":
      return recordLine(item);
    case "divider":
      return { form: "divider", open: undefined };
    case "deleted":
      return { form: "deleted", open: undefined };
    case "unavailable":
      return { form: "unavailable", text: item.keyLine, open: undefined };
  }
}
