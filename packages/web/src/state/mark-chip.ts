// 缩小后条右侧一条标注写的字（界面在 ui/zoom/marks.tsx 的 MarkChip；连着几块合成一条在 zoom-decor.ts 的 rightMarks）。纯函数。
// 一条标注 = 前面一段（种类或样式、结果、⚠ 关注类别的短名、通用 bash）+ 一句具体的，一行写不下折第二行、最多两行（界面截），
// 完整的在悬停文字和点开后的详情里：
// - 工具调用：样式（授权内、做完告诉我、被拦下、问过）和结果（被拦下的原因、你拒绝了、等你批准、出错；和样式一个说法的不重复写）在前，
//   后面是这次调用说人话的那一句（call-sentence.ts，和对话层工具调用那一行同一份：MCP 工具写"MCP <名>：<工具>"）；
// - 操作记录："操作记录：名字"、样式、⚠类别，后面是执行结果的摘要；
// - 审批："审批"、⚠类别，后面是要批的事（工具的说法；没有模板的写"工具中文名「参数」"），最后接批了没有（钉在末尾，截不掉）；
// - 验收：结论（本来就是一句话）；
// - 秘书转达："<名字>转达"，后面是转达的那句话的开头；
// - 时间线记录（偏离、范围变更、越界、MCP 调用……）：种类，后面是摘要。摘要开头又写了一遍种类的（"种类：…"）去掉；
//   MCP 调用、项目接口以前那句（"<名字>用 MCP「日历」调了 create_event（…）"，旧说法表先把"秘书"换成了名字占位）
//   改写成现在的写法（协议包的 mcpCallSummary、projectOpSummary：守护进程记新记录用的同一句），认不出的照原样，由界面截到两行。
// 关注类别只写短名：末尾括号里的补充说明去掉（"账户与安全（凭据、权限、全局装软件）"写"账户与安全"），完整的在悬停文字里。
import {
  type ApprovalCardPayload,
  currentWording,
  isTimelineRecordKind,
  mcpCallSummary,
  projectOpSummary,
  t,
  TIMELINE_RECORD_KIND_INFO,
} from "./protocol.ts";
import { callSentence, type IdNamer } from "./call-sentence.ts";
import { outcomeLabel } from "./cards.ts";
import { readableId } from "./readable-ids.ts";
import { cutTo } from "./sentence-parts.ts";
import { genericBashLabel, MARK_KIND_LABEL, OP_REASON, type TimelineMark } from "./timeline.ts";
import type { UiState } from "./ui-state.ts";

/** 一条标注写的字：分成前后两段，界面一行放不下时前一段一行、那句话一行（各自截），放得下时接着写 */
export interface MarkChipText {
  /** 前面一段：种类或样式、结果、⚠类别的短名、通用 bash，用" · "隔开（连着几块的这一段一样才合成一条） */
  readonly head: string;
  /** 前面一段里打头的那一项（种类或样式）：手机上那一行放不下时先截它后面的，它留到最后 */
  readonly lead: string;
  /** 后面那一句具体的；没有是空的 */
  readonly said: string;
  /** 连着几块合成一条时接在那句话后面的"等 N 次"（zoom-decor.ts 填） */
  readonly more?: string;
  /** 钉在最后、两行放不下也不截的：审批批了没有 */
  readonly tail?: string;
  /** 悬停看到的完整的：一句话、结果、补充说明 */
  readonly hover: string;
}

/** 标注上那句话最多这么多字（再长的界面也只放得下两行） */
export const MARK_SAID_MAX = 60;

const SEP = " · ";

/** 几段：空的不要，一样的只留第一个（被拦下的样式和结果都叫"被拦下"） */
function uniqueParts(parts: readonly (string | undefined)[]): string[] {
  return [...new Set(parts.filter((p): p is string => !!p))];
}

/** 几段用" · "并起来（uniqueParts） */
function joinParts(parts: readonly (string | undefined)[]): string {
  return uniqueParts(parts).join(SEP);
}

/** 关注类别的短名：末尾括号里的补充说明去掉（中英文括号都认）；去完是空的照原样 */
export function categoryShort(title: string): string {
  // @i18n-ignore-next data：正则里认全角括号
  const short = title.replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim();
  return short || title;
}

// @i18n-ignore-start fixed：认以前记录里写死的那一句（中文的"秘书"已经由旧说法表换成名字占位）
/** MCP 调用记录以前的写法：做成的、没做成的；中文、英文 */
const OLD_MCP_CALL: readonly { readonly ok: boolean; readonly re: RegExp; readonly server: number; readonly tool: number }[] = [
  { ok: true, re: /^\S+用 MCP「(.+?)」调了 (\S+)（([\s\S]*)）$/u, server: 1, tool: 2 },
  { ok: false, re: /^\S+用 MCP「(.+?)」调 (\S+) 没做成（([\s\S]*)）$/u, server: 1, tool: 2 },
  { ok: true, re: /^The assistant called (\S+) on MCP "(.+?)" \(([\s\S]*)\)$/u, server: 2, tool: 1 },
  { ok: false, re: /^The assistant's call to (\S+) on MCP "(.+?)" didn't work \(([\s\S]*)\)$/u, server: 2, tool: 1 },
];
/** 项目接口记录以前的写法：秘书调的（中文开头是名字占位）、别的 agent 调的；做成的、没做成的 */
const OLD_PROJECT_OP: readonly { readonly ok: boolean; readonly re: RegExp; readonly who?: number; readonly project: number; readonly op: number; readonly result: number }[] = [
  { ok: true, re: /^(.+?)调了项目「(.+?)」的操作 (\S+)（([\s\S]*)）$/u, who: 1, project: 2, op: 3, result: 4 },
  { ok: false, re: /^(.+?)调项目「(.+?)」的操作 (\S+) 没做成（([\s\S]*)）$/u, who: 1, project: 2, op: 3, result: 4 },
  { ok: true, re: /^The assistant called (\S+) on project "(.+?)" \(([\s\S]*)\)$/u, project: 2, op: 1, result: 3 },
  { ok: false, re: /^The assistant's call to (\S+) on project "(.+?)" didn't work \(([\s\S]*)\)$/u, project: 2, op: 1, result: 3 },
  { ok: true, re: /^Called by (.+?): (\S+) on project "(.+?)" \(([\s\S]*)\)$/u, who: 1, project: 3, op: 2, result: 4 },
  { ok: false, re: /^Called by (.+?), didn't work: (\S+) on project "(.+?)" \(([\s\S]*)\)$/u, who: 1, project: 3, op: 2, result: 4 },
];
/** 名字占位（秘书调的，中文旧说法表换过来的）和英文旧话里的秘书：不写是谁调的 */
const SECRETARY_WHO = /^(⟦[^⟦⟧]+⟧|The assistant)$/u;
// @i18n-ignore-end

/** MCP 调用、项目接口以前的那一句改写成现在的；认不出（已经是现在的、或者别的写法）是 undefined */
function rewriteOldCall(kind: string, text: string): string | undefined {
  if (kind === "mcp_call") {
    for (const { ok, re, server, tool } of OLD_MCP_CALL) {
      const m = re.exec(text);
      if (m) return mcpCallSummary({ ok, server: m[server]!, tool: m[tool]!, result: m[3]! });
    }
  } else if (kind === "project_op") {
    for (const { ok, re, who, project, op, result } of OLD_PROJECT_OP) {
      const m = re.exec(text);
      if (!m) continue;
      const by = who === undefined ? undefined : m[who]!;
      return projectOpSummary({ ok, project: m[project]!, op: m[op]!, result: m[result]!, who: by === undefined || SECRETARY_WHO.test(by) ? undefined : by });
    }
  }
  return undefined;
}

/**
 * 时间线记录的摘要放进标注：换成现在的说法（旧说法表）、取第一行，开头又写了一遍种类的（"种类：…"）去掉，
 * MCP 调用、项目接口以前的那一句改写成现在的。不截（标注截、悬停不截）
 */
export function recordGist(kind: string, summary: string): string {
  const line = (currentWording(summary).split("\n")[0] ?? "").trim();
  const label = isTimelineRecordKind(kind) ? TIMELINE_RECORD_KIND_INFO[kind].label : undefined;
  const bare = label === undefined ? line : withoutLabel(line, label);
  return rewriteOldCall(kind, bare) ?? bare;
}

/** 开头又写了一遍种类、接着冒号的（"工具包变更：…"）去掉这一截；后面没话了照原样 */
function withoutLabel(line: string, label: string): string {
  if (!line.startsWith(label)) return line;
  const rest = line.slice(label.length);
  // @i18n-ignore-next data：正则里认全角冒号
  const colon = /^\s*[：:]\s*/u.exec(rest);
  return colon && rest.length > colon[0].length ? rest.slice(colon[0].length) : line;
}

/** 审批要点那张卡：批了没有（还没处理的写"待你处理"）；没收到卡时没有 */
function approvalState(state: UiState | undefined, cardId: string | undefined): string | undefined {
  const card = state && cardId ? state.cards[cardId]?.card : undefined;
  if (!card) return undefined;
  return card.status === "pending" ? t("state.markChip.waiting") : outcomeLabel(card);
}

/** 审批要批的事：工具的说法（有模板的说成人话）；没有模板、没收到卡的写"工具中文名「参数」"（要点的那一句） */
function approvalSaid(state: UiState | undefined, mark: TimelineMark, named: IdNamer | undefined): string {
  const card = state && mark.cardId ? state.cards[mark.cardId]?.card : undefined;
  if (card?.type !== "approval") return mark.title;
  const p = card.payload as ApprovalCardPayload;
  const sentence = callSentence({ tool: p.tool, argsSummary: p.argsSummary }, named);
  return sentence.said ? sentence.text : mark.title;
}

/**
 * 一条要点的标注写什么。state 给了时：工具调用参数里的编号写成"t-3「整理发票」"、审批写出批了没有；
 * 不给（没有状态的地方）编号照原样、不写批没批
 */
export function markChip(state: UiState | undefined, mark: TimelineMark): MarkChipText {
  const style = mark.reason ? OP_REASON[mark.reason].label : undefined;
  const cats = mark.categories.map((c) => `⚠${categoryShort(c)}`);
  const named: IdNamer | undefined = state ? (ref) => readableId(state, ref) : undefined;
  const hover = joinParts([mark.title, mark.outcome, mark.note]);
  const chip = (head: readonly (string | undefined)[], said: string, extra: { tail?: string | undefined; hover?: string } = {}): MarkChipText => {
    const parts = uniqueParts(head);
    return {
      head: parts.join(SEP),
      lead: parts[0] ?? "",
      said: cutTo(said.replace(/\s+/g, " ").trim(), MARK_SAID_MAX),
      ...(extra.tail ? { tail: extra.tail } : {}),
      hover: extra.hover ?? hover,
    };
  };
  switch (mark.kind) {
    case "tool":
      return chip([style, mark.outcome, ...cats, mark.genericBash ? genericBashLabel() : undefined], mark.toolCall ? callSentence(mark.toolCall, named).text : mark.title);
    case "operation":
      return chip([t("state.zoomDecor.operationChip", { label: MARK_KIND_LABEL.operation, short: mark.short }), style, ...cats], mark.outcome ?? "");
    case "approval":
      return chip([MARK_KIND_LABEL.approval, ...cats], approvalSaid(state, mark, named), { tail: approvalState(state, mark.cardId) });
    case "acceptance":
      return chip([mark.title], "");
    case "relay":
      return chip([MARK_KIND_LABEL.relay], mark.title);
    default: {
      // 时间线记录：悬停写现在的说法（以前那句里的"秘书用 MCP"也不出现）
      const gist = recordGist(mark.kind, mark.title);
      return chip([MARK_KIND_LABEL[mark.kind], ...cats], gist, { hover: joinParts([gist, mark.note && currentWording(mark.note)]) });
    }
  }
}

/** 一条标注连成一行字（测试、比较用）：前一段 · 那句话 等 N 次 · 批了没有 */
export function markChipText(chip: MarkChipText): string {
  const said = chip.said && chip.more ? `${chip.said} ${chip.more}` : chip.said;
  return joinParts([chip.head, said, chip.tail]);
}
