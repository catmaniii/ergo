// 长程任务的阶段详情（60 号票）：照搬 AgentSense 里程碑详情（web/src/ui/milestone.tsx 的 MilestoneDetail）要的、从会话里推出来的那几样，
// 纯函数；交付件、验收标准、执行方式、授权、规则、预算这些计划里写的，界面直接从阶段（任务详情的阶段抽屉用的那份）取。
// 对照的是 AgentSense web/src/（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）：
// - 出过的状况（ui/incidents.tsx 的 incidentsOf / incidentsIn）：分成几类——拦下、拉回、额外确认、敏感数据、要你看一眼，
//   聊天里图标、详情里清单用同一套说法；已经处理好的带 ✓，没处理好、要你看一眼的用感叹号。二狗的数据换成：
//   工具调用（被拦下、按规则退回、按计划引回或改回、问过你、你拒绝了、等你批准、读了密钥文件）、验收结论的进度卡（没通过的是退回重做，
//   紧跟着这一支停下找你的是"没通过，要你决定"）、时间线记录（偏离、越界）、这一轮出错时留的系统说明（AgentSense 把出错归
//   "要你看一眼"；二狗认协议包 isTurnFailedNote 那一条）、你从某个阶段重做的记录（84 号票：时间线的 reopen，算"撤回"一类，
//   AgentSense 的重开记录也归它；二狗不撤回本机的改动，不写 AgentSense 的"本机的改动跟着恢复了"）。AgentSense 的"攻击"
//   （网页里的注入）二狗没有对应的数据，不出现（85 号票）；
// - 尝试记录：每次交上来验收的结论（验收结论的进度卡：过没过、哪几条不满足、备注——维护者宣布完成时写的那一两句，84 号票起
//   记在卡上（acceptance.summary），之前的卡从 complete_stage 的参数里拆；你退回时写的说明记在卡上由你验收的那几条的备注里，
//   AgentSense 的 attempt.note / userNote），和每次返工、从这里重做（看板上的 rework，55 号票的 taskReopens）；
// - 这个阶段用了几次工具调用（授权和用量的"工具调用 N/M"：会话里归属这个阶段的工具调用记录数）；
// - 第几轮（AgentSense 的 rounds：每重开一次加 1）；
// - "回到会话里这一段"：这个阶段的第一条；
// - "从这里重做"的范围在共享协议包里（reopenScope，84 号票：和守护进程同一份）。
// 这些都按这个任务的整段会话算（AgentSense 用整段会话）：任务详情打开时把任务开始以来的历史都取回来（historyNeededSince 说还要不要往前取），
// 往上翻不会让数字变。
import { type ConversationId, isTurnFailedNote, type ProgressCardPayload } from "./protocol.ts";
import type { ChatItem, ChatToolCall } from "./chat-items.ts";
import { describeCall, summaryArgs, toolLabel } from "./call-sentence.ts";
import type { UiState } from "./ui-state.ts";

// ───────────────────────── 出过的状况 ─────────────────────────

export const INCIDENT_KINDS = ["attack", "block", "pullback", "ask", "undo", "data", "look"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** 一件出过的状况 */
export interface Incident {
  readonly kind: IncidentKind;
  /** 出在哪一条上（点它进那一条的详情） */
  readonly itemId: string;
  /** 一句话 */
  readonly text: string;
  /** 没处理好、要你看一眼 */
  readonly attention?: boolean;
}

/** 每一类的名字、图标上的字、处理好了怎么说、说明（AgentSense incidents.tsx 的 INCIDENT_META，原样） */
export const INCIDENT_META: Readonly<Record<IncidentKind, { name: string; glyph: string; done: string; hint: string }>> = {
  attack: { name: "攻击", glyph: "防", done: "已挡住", hint: "网页上有人写了指挥 AI 的话，想让它做计划外的事" },
  block: { name: "拦下", glyph: "拦", done: "已拦下", hint: "它想做规则不允许的事" },
  pullback: { name: "拉回", glyph: "拉", done: "已拉回", hint: "跑偏了、交上来的不合格，已经引回计划" },
  ask: { name: "额外确认", glyph: "问", done: "问过你", hint: "执行中额外停下来问过你" },
  // 二狗不撤回本机的改动（84 号票：从这里重做只列出做过的事），不写 AgentSense 的"已撤回""本机的改动跟着恢复了"
  undo: { name: "撤回", glyph: "撤", done: "已重开", hint: "从某个阶段重做过，原来那一段标为已废弃（已经做了的事没有撤回）" },
  data: { name: "敏感数据", glyph: "敏", done: "在授权内", hint: "用到了你的敏感数据" },
  look: { name: "要你看一眼", glyph: "!", done: "要你看一眼", hint: "没处理好，或者值得你看一眼" },
};

/** 验收结论的进度卡：哪个阶段、过没过、哪几条不满足 */
function acceptanceOf(state: UiState, item: ChatItem): (ProgressCardPayload & { acceptance: NonNullable<ProgressCardPayload["acceptance"]> }) | undefined {
  if (item.kind !== "card") return undefined;
  const card = state.cards[item.cardId]?.card;
  if (card?.type !== "progress") return undefined;
  const p = card.payload as ProgressCardPayload;
  return p.kind === "acceptance" && p.acceptance ? (p as ProgressCardPayload & { acceptance: NonNullable<ProgressCardPayload["acceptance"]> }) : undefined;
}

/** 一条属于哪个阶段：验收结论的进度卡看卡上写的，别的看归属（和 55 号票书脊的口径一样） */
function stageOfItem(state: UiState, item: ChatItem): string | undefined {
  return acceptanceOf(state, item)?.stageId ?? item.scope.stageId;
}

/** 这一支停下找你的"偏离"记录（14 号票：和没通过的验收结论同一事务、紧跟在它后面） */
const isDeviation = (item: ChatItem | undefined) => item?.kind === "record" && item.record.type === "timeline" && item.record.timeline.kind === "deviation";

/** 一条上出的状况（一条可能有好几种：工具调用组里每次调用各算各的） */
function incidentsOf(state: UiState, item: ChatItem, next: ChatItem | undefined): Incident[] {
  const at = (kind: IncidentKind, text: string, attention?: boolean): Incident => ({ kind, itemId: item.id, text, ...(attention ? { attention } : {}) });
  switch (item.kind) {
    case "tool_group": {
      const out: Incident[] = [];
      for (const call of item.calls) {
        const { part } = call;
        const what = describeCall(part.tool, part.argsSummary) ?? toolLabel(part.tool);
        const id = call.id;
        const one = (kind: IncidentKind, text: string, attention?: boolean): Incident => ({ kind, itemId: id, text, ...(attention ? { attention } : {}) });
        // 拉回：按规则退回（时序规则）、按计划引回或改回（AgentSense 的 correction）
        if (part.blockedBy === "pull_back" || part.blockedBy === "plan_redirect" || part.plan?.correction === "rewrite") out.push(one("pullback", `想${what}，已拉回计划`));
        else if (call.issue === "blocked") out.push(one("block", `想${what}，已拦下`));
        else if (call.issue === "denied") out.push(one("ask", `问你要不要${what}，你没同意`));
        else if (call.issue === "asked") out.push(one("ask", `问你：${what}，你允许了`));
        // 二狗多的：还在等你批准（AgentSense 的确认是当场弹窗，没有"等着"）
        else if (call.issue === "waiting") out.push(one("ask", `问你：${what}，还在等你批准`, true));
        // 读了密钥文件（67 号票的 🔒）：用到敏感数据
        if (part.readsSecretFile && part.outcome === "done") out.push(one("data", `${what}：用到密钥文件`));
      }
      return out;
    }
    case "card": {
      const acceptance = acceptanceOf(state, item);
      if (!acceptance || acceptance.acceptance.passed) return [];
      // 没通过、紧跟着这一支停下找你：第 3 次还不过，要你决定怎么办（那条记录并进这一件，不再单算）
      if (isDeviation(next)) return [at("look", "这一步没通过，要你决定怎么办", true)];
      const failed = acceptance.acceptance.results.filter((r) => !r.passed).map((r) => r.criterion);
      return [at("pullback", `交上来的被退回重做${failed.length ? `：${failed.join("；")}` : ""}`)];
    }
    case "record": {
      if (item.record.type !== "timeline") return [];
      const { kind, summary } = item.record.timeline;
      if (kind === "deviation" || kind === "out_of_scope") return [at("look", summary, true)];
      // 你从某个阶段重做了（84 号票）：AgentSense 的重开记录算"撤回"一类
      if (kind === "reopen") return [at("undo", summary)];
      return [];
    }
    // 这一轮出错（模型调用失败、超时……）：AgentSense 的 error 条目，归"要你看一眼"
    case "system":
      return isTurnFailedNote(item.text) ? [at("look", item.text, true)] : [];
    default:
      return [];
  }
}

/** 一段条目里出过的状况，按先后（没通过的验收结论后面紧跟的那条偏离记录并进它） */
export function incidentsIn(state: UiState, items: readonly ChatItem[]): Incident[] {
  const out: Incident[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const next = items[i + 1];
    out.push(...incidentsOf(state, item, next));
    if (acceptanceOf(state, item)?.acceptance.passed === false && isDeviation(next)) i++;
  }
  return out;
}

/** 这个任务执行中出过的状况（整段会话里属于它的条目；阶段抽屉下面那一行的个数、出过的状况一页） */
export function taskIncidents(state: UiState, items: readonly ChatItem[], taskId: string): Incident[] {
  return incidentsIn(
    state,
    items.filter((it) => it.scope.taskId === taskId),
  );
}

/** 阶段标签闪一下的那种（AgentSense look.css 的 fx-ping：拉回青、拦下红、你拒绝了用你的蓝） */
export type GuardPingKind = "pullback" | "block" | "denied";

/**
 * 这个任务最近一次被拉回、拦下或你拒绝的调用（AgentSense drawer.tsx 的 StageChip：最后一条带 correction 的工具调用，
 * 刚发生的让阶段标签闪一下，"回到这一阶段"）。key 是这次调用的 id，界面据此判断是不是刚发生的
 */
export function latestGuardPing(items: readonly ChatItem[], taskId: string): { key: string; kind: GuardPingKind } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== "tool_group" || it.scope.taskId !== taskId) continue;
    for (let j = it.calls.length - 1; j >= 0; j--) {
      const call = it.calls[j]!;
      const { part } = call;
      if (part.blockedBy === "pull_back" || part.blockedBy === "plan_redirect" || part.plan?.correction === "rewrite") return { key: call.id, kind: "pullback" };
      if (call.issue === "blocked") return { key: call.id, kind: "block" };
      if (call.issue === "denied") return { key: call.id, kind: "denied" };
    }
  }
  return undefined;
}

/** 每类一个：有就出现，没有不出现；同一类里有一件没处理好，这一类就是"要注意"（AgentSense incidentKinds） */
export function incidentKinds(list: readonly Incident[]): { kind: IncidentKind; n: number; attention: boolean }[] {
  return INCIDENT_KINDS.flatMap((kind) => {
    const xs = list.filter((x) => x.kind === kind);
    return xs.length ? [{ kind, n: xs.length, attention: xs.some((x) => x.attention === true) }] : [];
  });
}

// ───────────────────────── 阶段详情 ─────────────────────────

/**
 * 尝试记录的一条：一次交上来验收的结论（note 是维护者宣布完成时写的那一两句，userNote 是你验收时退回写的说明），
 * 或者一次返工、从这里重做
 */
export type StageAttempt =
  | {
      readonly kind: "attempt";
      readonly at: string;
      readonly passed: boolean;
      readonly failed: readonly string[];
      readonly note: string | undefined;
      readonly userNote?: string;
      readonly itemId: string;
    }
  | { readonly kind: "reopen"; readonly at: string; readonly scope: readonly string[] };

/** 阶段详情里从会话、看板推出来的几样 */
export interface StageDetailFacts {
  /** 第几轮：每返工重开一次加 1（AgentSense 的 rounds） */
  readonly rounds: number;
  /** 这个阶段在会话里的第一条（"回到会话里这一段"）；会话里还没有的没有 */
  readonly firstItemId: string | undefined;
  /** 这一步出过的状况 */
  readonly incidents: readonly Incident[];
  /** 尝试记录，按先后 */
  readonly attempts: readonly StageAttempt[];
  /** 交上来验收过几次 */
  readonly submissions: number;
  /** 重开过几次 */
  readonly reopens: number;
}

/**
 * 这个阶段每次宣布完成（complete_stage）的调用，按先后：它是代为执行的内部工具，顺利执行的不进组的 N——在组里的留在组的 steps 里，
 * 不在组里的挂在代表它的那一条上（internalCalls），两处都找
 */
function completionCalls(items: readonly ChatItem[], taskId: string, stageId: string): ChatToolCall[] {
  const all = items.flatMap((it) => [...(it.kind === "tool_group" ? it.steps.flatMap((st) => (st.kind === "call" ? [st.call] : [])) : []), ...it.internalCalls]);
  return all.filter((c) => c.part.tool === "complete_stage" && c.scope.taskId === taskId && c.scope.stageId === stageId && c.seq !== undefined).toSorted((x, y) => x.seq! - y.seq!);
}

/** 宣布完成时维护者写的那一两句（complete_stage 的 summary，从工具调用记录的参数摘要里拆出来） */
function completionNote(call: ChatToolCall | undefined): string | undefined {
  const note = call && summaryArgs(call.part.argsSummary, ["stageId", "summary"]).summary;
  return note ? note : undefined;
}

export function stageDetailFacts(state: UiState, items: readonly ChatItem[], taskId: string, stageId: string): StageDetailFacts {
  const mine = items.filter((it) => it.scope.taskId === taskId && stageOfItem(state, it) === stageId);
  const reopens = (state.taskReopens[taskId] ?? []).filter((r) => r.stageIds.includes(stageId));
  // 每次验收结论的备注：它和上一次验收结论之间最近一次宣布完成写的那句（同一个阶段里，按序号）
  const completions = completionCalls(items, taskId, stageId);
  let since = -Infinity;
  const submitted: StageAttempt[] = mine.flatMap((it) => {
    const a = acceptanceOf(state, it);
    if (!a) return [];
    const card = it.kind === "card" ? state.cards[it.cardId]?.card : undefined;
    const seq = it.seq ?? Infinity;
    // 84 号票起卡上记着这次交上来时写的那句；之前的卡从宣布完成的调用参数里拆
    const note = a.acceptance.summary ?? completionNote(completions.findLast((c) => c.seq! > since && c.seq! < seq));
    since = seq;
    const userNote = a.acceptance.results.find((r) => r.method === "user" && r.note)?.note;
    return [
      {
        kind: "attempt" as const,
        at: it.time ?? card?.createdAt ?? "",
        passed: a.acceptance.passed,
        failed: a.acceptance.results.filter((r) => !r.passed).map((r) => r.criterion),
        note,
        ...(userNote ? { userNote } : {}),
        itemId: it.id,
      },
    ];
  });
  const reopened: StageAttempt[] = reopens.map((r) => ({ kind: "reopen" as const, at: r.time, scope: r.stageIds }));
  return {
    rounds: 1 + reopens.length,
    firstItemId: mine[0]?.id,
    // 这一段里的状况：落在这个阶段的条目（停下找你的那条偏离记录也带着这个阶段，incidentsIn 把它并进前面那张没通过的验收结论）
    incidents: incidentsIn(state, mine),
    attempts: [...submitted, ...reopened].toSorted((x, y) => Date.parse(x.at) - Date.parse(y.at)),
    submissions: submitted.length,
    reopens: reopens.length,
  };
}

/**
 * 一个任务每个阶段用了几次工具调用（授权和用量里的"工具调用 N/M"）：会话里归属这个任务、这个阶段的工具调用记录数。
 * 守护进程按阶段记的预算账（task_budget）没有推给前端；这里数的是同一批调用记录，和 token 用量（账本里的总数）一样算总数，
 * 不按"再给一份预算"重新起算
 */
export function stageToolCalls(state: UiState, conversation: ConversationId, taskId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of state.conversations[conversation]?.messages ?? []) {
    if (!("message" in entry) || entry.scope.taskId !== taskId || entry.scope.stageId === undefined) continue;
    const calls = entry.message.parts.filter((p) => p.type === "tool_call").length;
    if (calls > 0) out[entry.scope.stageId] = (out[entry.scope.stageId] ?? 0) + calls;
  }
  return out;
}

/**
 * 任务详情要的历史还缺不缺：手里最早的一条消息还不比 since（任务开始的时间）早、而且更早还有，就要接着往前取。
 * 进度、偏差个数、计划外动作、阶段详情的尝试记录和出过的状况都按整段会话算（AgentSense 用整段会话），
 * 取齐了数字才不随往上翻变（app/task-history.ts 照它一页页往前取）
 */
export function historyNeededSince(state: UiState, conversation: ConversationId, since: string): boolean {
  const conv = state.conversations[conversation];
  if (!conv || conv.olderExhausted) return false;
  const first = conv.messages[0];
  if (first === undefined || first.seq <= 1) return false;
  const oldest = conv.messages.find((m): m is Extract<typeof m, { message: unknown }> => "message" in m);
  // 最早那一条被彻底删除了（没有时间）：再往前取一页
  return oldest === undefined || Date.parse(oldest.message.time) >= Date.parse(since);
}
