// 聊天区精简（57 号票，规格第 19 节"会话区照搬 AgentSense"）：对话层里每一条长什么样。纯函数，界面照它画，回放测试也测它。
//
// 照 AgentSense web/src/ui/components.tsx 的 ChatItemView（D:\code\claudecode\user_agent_sense_of_security，bedf5a5，2026-10-09）：
// - 用户气泡：整条可点（.user），不带记号；
// - 思考：默认一行"💭 Agent 的想法（点开看）"，正在想时"💭 Agent 正在想…"（字轻轻明暗），点一下在原地显示全文，
//   旁边"详情 ›"（ThinkingRow）；
// - 回复：按 Markdown 画，按第一个空行切成第一段和后文（AssistantBubble 的 indexOf("\n\n")）；有后文时气泡里给
//   "收起 ▴ / 展开细节 ▾"和"详情 ›"，只有一段的两个都没有。默认整段展开（REPLY_OPEN_BY_DEFAULT）；
// - 卡片：卡片下面"详情 ›"；系统说明、时间线记录：整条可点（.context-note），不带记号；
// - 语音（AgentSense 没有）：照旧，36 号票的同框，详情在长按菜单里。
// 二狗在 AgentSense 之上加的（用户要的汇总行，规格第 19 节）：工具调用组画成一行小字"调用了 N 个工具 ›"，不是气泡；
// 后面跟小签——出了状况的（被拦下、你拒绝了、等你批准、出错、问过你）醒目，命中关注类别、顺利执行的（做完告诉你、授权内、
// 直接做只记录）平和。点整行进组的详情（56 号票），组里连续的同类调用在详情里合成一条（detail-content.ts 的 runsOf）。
import { type CallIssue, CALL_ISSUE_LABEL, type ChatItem, type ChatToolCall } from "./chat-items.ts";
import { DISPOSITION_LABEL } from "./protocol.ts";
import { opReasonOf } from "./timeline.ts";

/**
 * 回复默认整段展开还是只显示第一段。AgentSense bedf5a5（2026-10-09）改成默认整段展开（"Agent 的汇报是你最关心的：
 * 默认整段展开，长了自己收起"，见它的 docs/next-changes.md 第 1 条）；57 号票写的"只显示第一段"是照它之前的版本（99656b5）。
 * 用户 2026-10-10 定：照 AgentSense 整段展开
 */
export const REPLY_OPEN_BY_DEFAULT = true;

/** 思考那一行（AgentSense 的 ThinkingRow） */
export const THINKING_LABEL = "💭 Agent 的想法（点开看）";
export const THINKING_LIVE_LABEL = "💭 Agent 正在想…";

/** 有详情的条目怎么打开：整条可点、旁边的"详情 ›"、整行（行尾 ›）、长按菜单；打不开的没有 */
export type ChatOpen = "whole" | "link" | "row" | "menu";

/** 工具调用那一行小签的颜色档：出了状况的醒目（被拦下一类 / 跟你有关的一类），顺利执行的平和 */
export type ToolLineTagLevel = "stopped" | "you" | "op" | "ok" | "quiet";

/** 工具调用那一行的一个小签："1 次被拦下"、"2 次做完告诉你" */
export interface ToolLineTag {
  /** 出的状况；顺利执行的：做完告诉你（notify）、授权内（granted）、命中了关注类别但直接做只记录（logged） */
  readonly key: CallIssue | "notify" | "granted" | "logged";
  readonly count: number;
  readonly text: string;
  readonly level: ToolLineTagLevel;
}

/** 对话层里一条的样子 */
export type ChatLook =
  | { readonly form: "user"; readonly open: ChatOpen | undefined }
  | { readonly form: "voice"; readonly open: ChatOpen | undefined }
  | { readonly form: "thinking"; readonly label: string; readonly live: boolean; readonly open: ChatOpen | undefined }
  | {
      readonly form: "reply";
      /** 第一段（没有空行就是全文） */
      readonly head: string;
      /** 第一段之后还有内容：给"收起 ▴ / 展开细节 ▾"和"详情 ›" */
      readonly more: boolean;
      readonly open: ChatOpen | undefined;
    }
  | {
      readonly form: "tool_line";
      /** "调用了 N 个工具" */
      readonly text: string;
      /** 小签：出了状况的在前（按 CALL_ISSUES 的先后），然后是做完告诉你、授权内、直接做只记录 */
      readonly tags: readonly ToolLineTag[];
      /** 出了状况，这一行醒目：有被拦下、你拒绝了、出错的是 stopped，只有等你批准、问过你的是 you；顺利的没有 */
      readonly alert: "stopped" | "you" | undefined;
      /** 还有调用在执行 */
      readonly running: boolean;
      readonly open: ChatOpen | undefined;
    }
  | { readonly form: "card"; readonly open: ChatOpen | undefined }
  | { readonly form: "note"; readonly open: ChatOpen | undefined }
  | { readonly form: "divider"; readonly open: undefined }
  | { readonly form: "deleted"; readonly open: undefined };

/** 回复按第一个空行切成第一段和后文（照 AgentSense 的 AssistantBubble） */
export function replyCut(text: string): { head: string; rest: string } {
  const cut = text.indexOf("\n\n");
  return cut > 0 ? { head: text.slice(0, cut), rest: text.slice(cut + 2).trim() } : { head: text, rest: "" };
}

/** 出的状况在那一行上算哪一档：等你批准、问过你跟你有关；被拦下、你拒绝了、出错是被拦下一类（和组的详情里的小签同一个分法） */
const ISSUE_LEVEL: Readonly<Record<CallIssue, ToolLineTagLevel>> = { blocked: "stopped", denied: "stopped", error: "stopped", waiting: "you", asked: "you" };

/** 顺利执行、有要说的那几种（命中关注类别的处置）：小签上的说法和颜色 */
const CALM_TAGS = {
  notify: { label: "做完告诉你", level: "op" },
  granted: { label: "授权内", level: "ok" },
  logged: { label: DISPOSITION_LABEL.do, level: "quiet" },
} as const satisfies Record<string, { label: string; level: ToolLineTagLevel }>;

/** 一次顺利执行的调用在那一行上算哪种：做完告诉你、授权内、命中了关注类别但直接做只记录；都不是的不标 */
function calmKind(call: ChatToolCall): keyof typeof CALM_TAGS | undefined {
  const reason = opReasonOf(call.part);
  if (reason === "notify") return "notify";
  if (reason === "granted") return "granted";
  return call.part.categoryTitles.length > 0 ? "logged" : undefined;
}

/** 工具调用组的那一行：调用了几个工具、小签、醒不醒目、还有没有在执行的 */
function toolLine(item: Extract<ChatItem, { kind: "tool_group" }>): Extract<ChatLook, { form: "tool_line" }> {
  const tags: ToolLineTag[] = item.issues.map(({ issue, count }) => ({ key: issue, count, text: `${count} 次${CALL_ISSUE_LABEL[issue]}`, level: ISSUE_LEVEL[issue] }));
  const calm = new Map<keyof typeof CALM_TAGS, number>();
  for (const call of item.calls) {
    if (call.issue !== undefined) continue;
    const kind = calmKind(call);
    if (kind) calm.set(kind, (calm.get(kind) ?? 0) + 1);
  }
  for (const kind of Object.keys(CALM_TAGS) as (keyof typeof CALM_TAGS)[]) {
    const count = calm.get(kind);
    if (count) tags.push({ key: kind, count, text: `${count} 次${CALM_TAGS[kind].label}`, level: CALM_TAGS[kind].level });
  }
  const levels = new Set(item.issues.map((i) => ISSUE_LEVEL[i.issue]));
  return {
    form: "tool_line",
    text: `调用了 ${item.calls.length} 个工具`,
    tags,
    alert: levels.has("stopped") ? "stopped" : levels.has("you") ? "you" : undefined,
    running: item.calls.some((c) => c.part.outcome === "running"),
    open: item.detail ? "row" : undefined,
  };
}

/** 对话层里这一条长什么样 */
export function chatLook(item: ChatItem): ChatLook {
  const detail = item.detail !== undefined;
  switch (item.kind) {
    case "user":
      return { form: "user", open: detail ? "whole" : undefined };
    case "voice":
      return { form: "voice", open: detail ? "menu" : undefined };
    case "thinking":
      return { form: "thinking", label: item.streaming ? THINKING_LIVE_LABEL : THINKING_LABEL, live: item.streaming, open: detail ? "link" : undefined };
    case "reply": {
      // 漏了中间增量的回复不拼残缺的文字（只占一个"正在回复"的位置）
      const { head, rest } = replyCut(item.broken ? "" : item.text);
      const more = rest.length > 0;
      return { form: "reply", head, more, open: detail && more ? "link" : undefined };
    }
    case "tool_group":
      return toolLine(item);
    case "card":
      return { form: "card", open: detail ? "link" : undefined };
    case "system":
    case "record":
      return { form: "note", open: detail ? "whole" : undefined };
    case "divider":
      return { form: "divider", open: undefined };
    case "deleted":
      return { form: "deleted", open: undefined };
  }
}
