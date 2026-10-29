// 回话时"调用记忆"（187 号票，用户 2026-10-20 要的）：调用记忆也是一种工具，但不并进"调用了 N 个工具"——在它发生的位置单独出一行
// "回忆了 N 条记忆 ›"（chat-items.ts 的 recall 条目），点开是"这次用到的记忆"（detail-content.ts 的 RecallDetail）。这里是两处共用的：
// - 哪些调用算调用记忆（isRecallCall）：检索素材、读素材执行了的。被拦下、你拒绝了、出错的照旧留在"调用了 N 个工具"里，状况看得见
//   （和顺利执行的内部工具不显示、出了状况的照旧算进组里同一个口径）；
// - 一次调用记忆（recallEntryOf）：工具调用 part 上的结构化部分（ToolCallPart.recall：为什么查、查了什么、找到读到的素材）；
//   187 号票之前的记录没有它，从参数摘要认查了什么、读的哪条，从结果摘要认找到几条（parseLegacyCount），命中从完整返回里按行认
//   （parseLegacyHits，界面打开详情时现取完整返回）；
// - 那一行写什么（recallSummary、recallLine）：N 是去重后的素材条数（同一条在几次检索里出现、又被读了全文只算一条），查了没找到的写
//   "查了记忆，没找到相关的"；旧记录认不出条数的（彻底删除过）写"查了 N 次记忆"；
// - 找到的一条怎么说（recallMaterial）：原文和时间由界面按素材 id 现取（GET /api/materials/<素材 id>，记忆页同一个接口），本人的话给原文
//   （长的截断、可展开），不是本人的话给说明（存的网页的标题、卡片的说明……）；什么时候是具体时间加"3 天前"；在哪是来源会话、任务、项目，
//   出处的消息还在当前分支上的能跳回去（materials.ts 的 materialJump）。取不到（忘掉、彻底删除了）的界面写"这条记忆已删除"。
// 263 号票：问记忆（ask_memory，查推理图谱）也算调用记忆，source 是 ask：查了什么是问题，命中是简报里引用的证据背后的素材；
// 263 号票之前的问记忆记录没有结构化部分，认不出条数（写"查了 N 次记忆"）。
// 266 号票：每条消息自动带上的记忆简报也算调用记忆，source 是 brief：它不是工具调用，结构化的部分挂在秘书这一轮第一条回话的
// MemoryBriefPart 上；会话条目层把它当成一次"调用记忆"（briefCallPart 拼一个工具调用的样子，工具名 MEMORY_BRIEF_CALL），
// 和检索、问记忆一样算进那一行、去重计数；详情里列为什么带它（briefItemLines）。
import { type InboxJump } from "./inbox-jump.ts";
import { materialBlocks, materialJump } from "./materials.ts";
import { formatRelativeTime, type MaterialDetailView, type MemoryRecallHit, type MemoryRecallSource, type MessagePart, PURGED_TEXT, t } from "./protocol.ts";
import { summaryArgs } from "./call-sentence.ts";
import type { UiState } from "./ui-state.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 记忆简报（266 号票）在会话条目层里当成一次调用记忆时的"工具名"：不是真的工具，模型调不到 */
export const MEMORY_BRIEF_CALL = "memory_brief";

/** 调用记忆的工具和它从哪来（工具名以守护进程 memory/tool-names.ts 为准；记忆简报不是工具，见 MEMORY_BRIEF_CALL） */
const RECALL_TOOLS: Readonly<Record<string, MemoryRecallSource>> = { search_materials: "search", read_material: "read", ask_memory: "ask", [MEMORY_BRIEF_CALL]: "brief" };

type MemoryBriefPart = Extract<MessagePart, { type: "memory_brief" }>;

/** 记忆简报的结构化部分拼成一次调用记忆的样子（会话条目层照调用记忆归组、计数）；callId 是它在会话里的位置 */
export function briefCallPart(part: MemoryBriefPart, callId: string): ToolCallPart {
  return { type: "tool_call", callId, tool: MEMORY_BRIEF_CALL, argsSummary: "", categoryTitles: [], withinGrant: true, genericBash: false, outcome: "done", nature: "look", recall: part.recall };
}

/** 记忆简报里的一条为什么带（详情里列）：为什么、直接说到的经哪几条路找到的、说到的结论（界面按编号现取说法） */
export interface BriefItemLine {
  readonly key: string;
  readonly reason: string;
  /** 直接说到这件事的：经哪几条路找到的；别的没有 */
  readonly how: string | undefined;
  readonly claimIds: readonly string[];
}

type BriefItem = MemoryBriefPart["items"][number];
const REASON_KEY: Readonly<Record<BriefItem["reason"], string>> = {
  direct: "state.memoryRecall.reason.direct",
  area: "state.memoryRecall.reason.area",
  hard: "state.memoryRecall.reason.hard",
  undecided: "state.memoryRecall.reason.undecided",
  strategy: "state.memoryRecall.reason.strategy",
};
const ROUTE_KEY: Readonly<Record<BriefItem["routes"][number], string>> = {
  upward: "state.memoryRecall.route.upward",
  index: "state.memoryRecall.route.index",
  domain: "state.memoryRecall.route.domain",
};

/** 记忆简报里每条为什么带 */
export function briefItemLines(part: MemoryBriefPart): BriefItemLine[] {
  return part.items.map((item) => ({
    key: item.key,
    reason: t(REASON_KEY[item.reason]),
    how: item.reason === "direct" && item.routes.length > 0 ? item.routes.map((r) => t(ROUTE_KEY[r])).join(t("state.memoryRecall.routeSep")) : undefined,
    claimIds: [...item.claimIds],
  }));
}

/** 执行了的：执行完的、还在执行的 */
const EXECUTED: ReadonlySet<ToolCallPart["outcome"]> = new Set(["done", "running"]);

/** 是不是记忆工具（检索素材、读素材），不管执行没执行 */
export function isRecallTool(tool: string): boolean {
  return Object.hasOwn(RECALL_TOOLS, tool);
}

/** 这次调用算调用记忆：记忆工具、执行了的。被拦下、你拒绝了、出错的照旧在"调用了 N 个工具"里 */
export function isRecallCall(part: ToolCallPart): boolean {
  return isRecallTool(part.tool) && EXECUTED.has(part.outcome);
}

/** 一条命中（结构化部分里的，或者旧记录里认出来的：只有素材 id 和怎么找出来的） */
export type RecallHit = Pick<MemoryRecallHit, "materialId" | "keyword" | "semantic"> & Partial<Pick<MemoryRecallHit, "kind" | "time" | "conversation">>;

/** 一次调用记忆（结构化的照用；旧记录从摘要里认） */
export interface RecallEntry {
  readonly source: MemoryRecallSource;
  /** 为什么查；旧记录、读全文没有 */
  readonly why: string | undefined;
  /** 查了什么；读全文没有 */
  readonly query: string | undefined;
  /** 找到读到的素材；旧记录的检索不知道（undefined：界面打开详情时从完整返回里认） */
  readonly hits: readonly RecallHit[] | undefined;
  /** 旧记录的检索：结果摘要里写的找到几条；认不出（彻底删除过）的没有 */
  readonly legacyCount: number | undefined;
}

/** 一次调用记忆：结构化的部分（187 号票起），没有的从参数摘要、结果摘要认 */
export function recallEntryOf(part: ToolCallPart): RecallEntry {
  const source = RECALL_TOOLS[part.tool] ?? "search";
  if (part.recall) return { source: part.recall.source, why: part.recall.why, query: part.recall.query, hits: part.recall.hits, legacyCount: undefined };
  if (source === "read") {
    const id = summaryArgs(part.argsSummary, ["materialId"]).materialId;
    return { source, why: undefined, query: undefined, hits: id ? [{ materialId: id }] : [], legacyCount: undefined };
  }
  // 263 号票之前的问记忆：只认得出问了什么，找到几条认不出（简报不是一行一条）
  if (source === "ask") return { source, why: undefined, query: summaryArgs(part.argsSummary, ["question"]).question || undefined, hits: undefined, legacyCount: undefined };
  const args = summaryArgs(part.argsSummary, ["query", "why", "limit"]);
  return { source, why: args.why || undefined, query: args.query || undefined, hits: undefined, legacyCount: parseLegacyCount(part.resultSummary) };
}

/** 旧记录的检索结果摘要里找到几条（守护进程给模型的那句，search-tool.ts）；认不出的（彻底删除过、截掉了）是 undefined */
export function parseLegacyCount(summary: string | undefined): number | undefined {
  if (summary === undefined || summary === PURGED_TEXT) return undefined;
  // @i18n-ignore-next data：认守护进程给模型的检索结果（旧记录）
  const found = /^找到 (\d+) 条素材/.exec(summary);
  if (found) return Number(found[1]);
  // @i18n-ignore-next data：认守护进程给模型的检索结果（旧记录）
  return summary.startsWith("没有找到和「") ? 0 : undefined;
}

/**
 * 旧记录的检索完整返回里一行一条（守护进程给模型的那几行，search-tool.ts）："- mat-… · 时间 · 种类 · …（关键词+语义 0.71）：摘录"。
 * 认出素材 id 和怎么找出来的；别的（时间没带时区、种类是给模型的中文名）不要，界面按素材 id 现取
 */
export function parseLegacyHits(result: string): RecallHit[] {
  // @i18n-ignore-next data：认守护进程给模型的检索结果（旧记录）
  const line = /^- (mat-[^\s·]+) · [^（\n]*（(关键词)?\+?(?:语义 ([0-9.]+))?）：/gm;
  return [...result.matchAll(line)].map((m) => ({
    materialId: m[1]!,
    ...(m[2] ? { keyword: true as const } : {}),
    ...(m[3] ? { semantic: Number(m[3]) } : {}),
  }));
}

/** 一行调用记忆用到了几条记忆 */
export interface RecallSummary {
  /** 用到的记忆有几条：去重后的素材条数；旧记录的检索按结果摘要里的找到几条加上（去不了重） */
  readonly count: number;
  /** 条数算得出：有旧记录的检索认不出找到几条（彻底删除过）时是 false */
  readonly known: boolean;
  /** 几次调用 */
  readonly calls: number;
}

export function recallSummary(parts: readonly ToolCallPart[]): RecallSummary {
  const ids = new Set<string>();
  let extra = 0;
  let known = true;
  for (const part of parts) {
    const entry = recallEntryOf(part);
    if (entry.hits) for (const h of entry.hits) ids.add(h.materialId);
    else if (entry.legacyCount !== undefined) extra += entry.legacyCount;
    else known = false;
  }
  return { count: ids.size + extra, known, calls: parts.length };
}

/** 那一行写什么："回忆了 N 条记忆"；查了没找到"查了记忆，没找到相关的"；旧记录认不出条数"查了 N 次记忆" */
export function recallLine(summary: RecallSummary): string {
  if (summary.count > 0) return t("state.memoryRecall.line", { count: summary.count });
  return summary.known ? t("state.memoryRecall.none") : t("state.memoryRecall.lineCalls", { count: summary.calls });
}

/** 怎么找出来的："关键词命中"、"语义相近（0.71）"、"关键词命中，语义也相近（0.66）"；读全文的（都没有）是 undefined */
export function recallHowLabel(hit: Pick<RecallHit, "keyword" | "semantic">): string | undefined {
  const score = hit.semantic === undefined ? undefined : hit.semantic.toFixed(2);
  if (hit.keyword && score !== undefined) return t("state.memoryRecall.how.both", { score });
  if (hit.keyword) return t("state.memoryRecall.how.keyword");
  if (score !== undefined) return t("state.memoryRecall.how.semantic", { score });
  return undefined;
}

// ───────────────────────── 找到的那一条 ─────────────────────────

/** 原话、说明在详情里先显示多少字，多的点"展开"看 */
export const RECALL_QUOTE_MAX = 120;

export interface RecallMaterial {
  /** 本人的原话（全文）；不是本人的话是说明：存的网页的标题、卡片的说明、附件的文件名…… */
  readonly text: string;
  /** 先显示的那一段：长的截到 RECALL_QUOTE_MAX 字、末尾"…" */
  readonly head: string;
  /** 截掉了，能展开 */
  readonly more: boolean;
  /** 是本人的原话 */
  readonly own: boolean;
  /** 素材的种类（守护进程给的名字："用户发言""审批决定""用户对产出的反应"……） */
  readonly kind: string;
  /** 什么时候："2026-10-17 09:12" */
  readonly at: string;
  /** 相对说法："3 天前""昨天" */
  readonly ago: string;
  /** 在哪：来源会话（界面写名字）；不来自会话的没有 */
  readonly conversation: string | undefined;
  readonly taskId: string | undefined;
  readonly projectId: string | undefined;
  /** "看原话"跳到哪：出处的消息还在当前分支上才有 */
  readonly jump: InboxJump | undefined;
}

/** "2026-10-17T09:12:00.000+08:00" → "2026-10-17 09:12"（素材自己的本地时间） */
function minuteOf(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** 不是本人的话时的说明：每一段的说法（存的网页写标题，附件写文件名，引用块写原文，卡片写说明），几段连起来 */
function descriptionOf(view: MaterialDetailView): string {
  return materialBlocks(view)
    .map((b) => {
      if (b.kind === "page") return b.pageTitle;
      if (b.kind === "part") return "name" in b.part && typeof b.part.name === "string" ? b.part.name : b.title;
      return b.text;
    })
    .filter((s) => s.trim() !== "")
    .join(t("state.memoryRecall.descSep"));
}

/** 找到的一条怎么说（view：按素材 id 现取的；now：现在，毫秒） */
export function recallMaterial(state: UiState, view: MaterialDetailView, now: number): RecallMaterial {
  const own = view.segments
    .filter((s) => s.source === "self" && s.text !== undefined && s.text.trim() !== "")
    .map((s) => s.text!.trim())
    .join("\n");
  const text = own || descriptionOf(view);
  const more = text.length > RECALL_QUOTE_MAX;
  return {
    text,
    head: more ? `${text.slice(0, RECALL_QUOTE_MAX)}…` : text,
    more,
    own: own !== "",
    kind: view.kind,
    at: minuteOf(view.time),
    ago: recallAgo(view.time, now),
    conversation: view.conversation,
    taskId: view.taskId,
    projectId: view.projectId,
    jump: materialJump(state, view),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对说法（按当前语言）："刚刚"、"5 分钟前"、"3 小时前"、"昨天"、"3 天前"、"上个月"、"2 年前"；时间认不出的是空的 */
export function recallAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const ms = Math.max(0, now - then);
  if (ms < MINUTE) return t("state.memoryRecall.justNow");
  const auto = { numeric: "auto" } as const;
  if (ms < HOUR) return formatRelativeTime(-Math.floor(ms / MINUTE), "minute", auto);
  if (ms < DAY) return formatRelativeTime(-Math.floor(ms / HOUR), "hour", auto);
  const days = Math.floor(ms / DAY);
  if (days < 30) return formatRelativeTime(-days, "day", auto);
  if (days < 365) return formatRelativeTime(-Math.floor(days / 30), "month", auto);
  return formatRelativeTime(-Math.floor(days / 365), "year", auto);
}
