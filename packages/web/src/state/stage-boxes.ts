// 长程任务的会话按阶段成框（91 号票第 6 块：显示几条、分组、框的标题、
// 状态、框上的要点），纯函数；框怎么画在 ui/conversation/StageBox.tsx，
// 三档缩放里怎么摆在 ui/zoom/ZoomHistory.tsx。
// - 照常显示的：二狗是你的消息和语音、回复（含 agent 的语音）、
//   任务书（一条"任务书："系统说明）、计划卡和计划变更卡、自行调整计划的记录、
//   这一轮出错的说明，加上还等你处理的卡（审批、并行确认……
//   这些确认不是当场弹窗，在聊天里，收进框里你就点不到了）、已删除的那条（原来是谁说的看不出，照常留着）；
// - 其余（思考、工具调用组、进度卡、处理过的卡、系统说明、时间线记录、工单分隔）连着的按阶段分组：同一阶段连着的（含退回后重做）
//   是一组，中间插了照常显示的就断开，从某个阶段重做的地方也断开（旧一轮作废、新一轮照常）；自己不带阶段的跟着后面最近的那个阶段，
//   后面没有就跟前面的；都没有的是一条细的。你从某个阶段重做的那条记录（写了原因的连同"你说：「…」"）收进框里，
//   是新一轮的第一条（93 号票改回：91 号票评审时放在框外）；
// - 一个框：第几阶段（依赖图的阶段号，并行的同号）、标题（现在生效的计划里的）、出过的情况（图标）、完成情况；一句小结（做完了说结果，
//   正在做说在做什么）；要点（验收时查到的、退回过几次、已做几次操作）；收着时缩小后条外的标注一类一条，出过的情况之外还有
//   "外"（对外动作）、"权"（敏感权限）两类（93 号票：守护进程给每次调用记的 mark，放行执行完的才标；之前的记录没有，不标）；
// - 框里每一次交上来验收的结论（93 号票，一道横条）：一行"验收通过：「…」"或"已退回：「…」"，
//   点开是几条要点（逐条标准、系统查到的、你写的说明），箭头进那张卡的详情（verdictStrip）。
// 没有数据所以不画的：选这条路的理由、删掉或共享出去的照片缩略图、撤回点（二狗不撤回）。
import { describeCall, toolLabel } from "./call-sentence.ts";
import { type ChatItem, type ChatToolCall, type ContentKind, zoomBlocks } from "./chat-items.ts";
import { isTurnFailedNote, stageNumbers, t, tTable, type TOOL_CALL_MARKS } from "./protocol.ts";
import { acceptanceOf, type Incident, type IncidentKind, incidentsIn, isDeviation, stageOfItem } from "./stage-detail.ts";
import { graphLook, removedTaskStages } from "./stage-graph.ts";
import { observedLine } from "./stage-observed.ts";
import { effectivePlanOf } from "./task-detail.ts";
import { chatItemNature, type ToolNature } from "./tool-nature.ts";
import { agentActivity, type UiState } from "./ui-state.ts";
import type { ZoomSpine } from "./zoom-decor.ts";

/** 任务书那条系统说明的开头：172 号票之前的消息上没有 taskBrief，按这个认 */
const TASK_BRIEF_PREFIX = "任务书："; // @i18n-ignore data：认守护进程以前写进会话的那条系统说明

/** 对话层里照常显示的一条；其余收进阶段框 */
export function stageChatShown(state: UiState, item: ChatItem): boolean {
  switch (item.kind) {
    case "user":
    case "voice":
    case "reply":
    case "deleted":
    // 插件没启用的占位（193 号票）：照"已删除"留在对话层
    case "unavailable":
      return true;
    case "card": {
      const card = state.cards[item.cardId]?.card;
      if (!card || card.type === "plan" || card.type === "plan_change") return true;
      // 进度卡（进展、验收结论）是阶段里的事；别的卡等你处理时照常显示
      return card.type !== "progress" && card.status === "pending";
    }
    case "system":
      return isTurnFailedNote(item.text) || item.taskBrief === true || item.text.startsWith(TASK_BRIEF_PREFIX);
    case "record":
      // 自行调整计划的记录；重做记录收进框里（93 号票）；
      // 重做之后复验没过（274 号票）要先告诉你，照常显示、不收进框里
      return item.record.type === "timeline" && (item.record.timeline.kind === "plan_revision" || item.record.timeline.kind === "reverify");
    default:
      return false;
  }
}

/** 你从某个阶段重做的那条记录（时间线的 reopen）：新的一轮从它开始 */
const isReopen = (item: ChatItem) => item.kind === "record" && item.record.type === "timeline" && item.record.timeline.kind === "reopen";

/** 一组：连着的、同一阶段的后台事项 */
export interface StageGroup {
  /** 跟着第一条（grp:<第一条的 id>），往后追加不会变 */
  readonly id: string;
  readonly ids: readonly string[];
  /** 属于哪个阶段；没有就是零散的后台事项 */
  readonly stageId: string | undefined;
}

/**
 * 连续的后台事项按阶段分组：同一阶段连着的是一组，中间插了别的阶段就断开；
 * 自己不带阶段的（思考、不带阶段的说明）跟着后面最近的那个阶段，后面没有就跟前面的。别的任务的条目不算阶段。
 * 二狗多的：你从某个阶段重做的地方也断开（重做记录另起一组、是新一轮的第一条）——对正在做的阶段点重做、中间没有一句回复时，
 * 旧一轮（已作废）和新一轮不并成一个框
 */
export function stageGroups(state: UiState, items: readonly ChatItem[], taskId: string): StageGroup[] {
  const out: { id: string; ids: string[]; stageId: string | undefined }[] = [];
  let run: ChatItem[] = [];
  const flush = () => {
    const keys = run.map((x) => (x.scope.taskId === taskId ? stageOfItem(state, x) : undefined));
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === undefined) keys[i] = keys.slice(i + 1).find((k) => k !== undefined) ?? keys.slice(0, i).findLast((k) => k !== undefined);
    }
    let cur: (typeof out)[number] | undefined;
    run.forEach((x, i) => {
      if (!cur || cur.stageId !== keys[i] || isReopen(x)) {
        cur = { id: `grp:${x.id}`, ids: [], stageId: keys[i] };
        out.push(cur);
      }
      cur.ids.push(x.id);
    });
    run = [];
  };
  for (const it of items) {
    if (stageChatShown(state, it)) flush();
    else run.push(it);
  }
  flush();
  return out;
}

/** 框的完成情况：框左边那道颜色、右上角的字（框里展开的每次操作接着用这道颜色） */
export type StageBoxTone = "ok" | "live" | "bad" | "off";

/** 条外标注上的字：出过的情况那几类，加上"外"（对外动作）、"权"（敏感权限）（93 号票） */
export type NoteGlyph = IncidentKind | ToolCallMark;

/** "外""权"的名字、字（和计划上的小标记同一个字） */
export const GLYPH_META: Readonly<Record<ToolCallMark, { name: string; glyph: string }>> = {
  perm: tTable({ name: "state.stageBoxes.glyph.perm.name", glyph: "state.stageBoxes.glyph.perm.glyph" }),
  out: tTable({ name: "state.stageBoxes.glyph.out.name", glyph: "state.stageBoxes.glyph.out.glyph" }),
};

/**
 * 收着的框在缩小后条外的一条标注：一个图标 + 一句话，一类合成一条，箭头指向框上那个图标（key 是 ic:<类>）；
 * "外""权"框上没有图标，key 不写、箭头指着框的正中
 */
export interface StageNote {
  readonly glyph: NoteGlyph;
  readonly text: string;
  readonly warn: boolean;
  readonly key: string | undefined;
  /** 说的是哪几条（条目、调用的 id）：一条的点了进那一条的详情，好几条的进这个阶段的详情 */
  readonly items: readonly string[];
}

/** 聊天里的一个阶段框 */
export interface StageBoxView extends StageGroup {
  /** 屏幕停在这个框上时，标题栏的阶段标签跟着它（框里最后一件事） */
  readonly focusId: string;
  /** 第几阶段（依赖图的阶段号，被计划去掉的照图上那个已取消的节点）；不属于阶段的没有 */
  readonly no: number | undefined;
  /** 阶段的标题（计划调整过的以现在生效的为准，被去掉的照旧版计划）；不属于阶段的是那一句话 */
  readonly title: string;
  readonly status: { readonly cls: StageBoxTone; readonly text: string };
  /** 一句小结：做完了说结果，正在做说在做什么 */
  readonly summary: string | undefined;
  /** 点开后的要点 */
  readonly lines: readonly string[];
  /** 框里每次交上来验收的结论画成的横条（93 号票）：条目 id → 横条 */
  readonly strips: ReadonlyMap<string, VerdictStrip>;
  readonly incidents: readonly Incident[];
  /** 这一段做了几次操作（算进"调用了 N 个工具"的调用） */
  readonly toolCount: number;
  /** 要点层、全局层里这一块上写的那一行 */
  readonly caption: string;
  readonly notes: readonly StageNote[];
  /** 缩小后这一块的底色（内容类型）、性质 */
  readonly kind: ContentKind;
  readonly nature: ToolNature;
  /** Agent 正在做这一段 */
  readonly live: boolean;
  /** 这是这个阶段最近的一段（状态按阶段现在的算） */
  readonly latest: boolean;
  /** 重开之前的那一轮：已作废 */
  readonly stale: boolean;
}

/** 一次调用做了什么（说人话；没有模板的写工具的中文名） */
const actOf = (call: ChatToolCall | undefined) => call && (describeCall(call.part.tool, call.part.argsSummary) ?? toolLabel(call.part.tool));

/** 不属于哪个阶段的那一条：一句话（没有撤回那一句） */
function miscText(members: readonly ChatItem[], calls: readonly ChatToolCall[]): string {
  if (calls.length) return actOf(calls.at(-1)) ?? t("state.stageBoxes.misc.background");
  return members.every((x) => x.kind === "thinking") ? t("state.stageBoxes.misc.thinking") : t("state.stageBoxes.misc.checked");
}

type Acceptance = NonNullable<ReturnType<typeof acceptanceOf>>;

/** 一次调用真动了的是对外的事还是本机的敏感权限（协议包的 TOOL_CALL_MARKS） */
export type ToolCallMark = (typeof TOOL_CALL_MARKS)[number];

/**
 * 验收通过时摘的结果：每条标准的备注
 * （脚本输出的末尾、评审的理由，各取第一行）；都没有备注的写核对了几条都通过，由你验收的写你验收通过
 */
function resultLines(a: Acceptance): string[] {
  const out = a.acceptance.results.flatMap((r) => {
    const note = r.note?.trim().split("\n")[0]?.trim();
    return note ? [t("state.stageBoxes.result.note", { criterion: r.criterion, note })] : [];
  });
  const n = a.acceptance.results.length;
  if (!out.length) out.push(a.acceptance.judgedBy === "user" ? t("state.stageBoxes.result.byUser") : t("state.stageBoxes.result.allPassed", { count: n, n }));
  return out;
}

/** 条外标注、图例的先后 */
export const STAGE_NOTE_ORDER: readonly NoteGlyph[] = ["attack", "block", "pullback", "ask", "undo", "look", "data", "out", "perm"];

/** 一次真动了的"外""权"：哪一次调用、动作名（合并时按它数）、一句话 */
interface ActNote {
  readonly glyph: ToolCallMark;
  readonly callId: string;
  readonly label: string;
  readonly text: string;
}

/**
 * 这一段里真动了的对外动作、本机的敏感权限：守护进程记了 mark、放行执行完的调用
 * （执行成功、没被纠正），一次一条；动作名是工具的中文名，一句话是这次调用说成人话的那句
 */
export function actNotesOf(calls: readonly ChatToolCall[]): ActNote[] {
  return calls.flatMap((c) => {
    const mark = c.part.mark;
    if (mark === undefined || c.part.outcome !== "done") return [];
    return [{ glyph: mark, callId: c.id, label: toolLabel(c.part.tool), text: actOf(c) ?? toolLabel(c.part.tool) }];
  });
}

/**
 * 收着的一个阶段：一类合成一条，指向阶段框上那个图标。"外""权"一类也合成一条：一次的写那一句，
 * 几次的按动作名数（"git 推送 2 次、写文件"），框上没有它们的图标，不指
 */
export function stageNotes(incidents: readonly Incident[], acts: readonly ActNote[] = []): StageNote[] {
  return STAGE_NOTE_ORDER.flatMap((glyph): StageNote[] => {
    if (glyph === "out" || glyph === "perm") {
      const xs = acts.filter((x) => x.glyph === glyph);
      if (!xs.length) return [];
      const items = [...new Set(xs.map((x) => x.callId))];
      if (xs.length === 1) return [{ glyph, text: xs[0]!.text, warn: false, key: undefined, items }];
      const n = new Map<string, number>();
      for (const x of xs) n.set(x.label, (n.get(x.label) ?? 0) + 1);
      return [{ glyph, text: [...n].map(([l, k]) => (k > 1 ? t("state.stageBoxes.note.actCount", { label: l, n: k }) : l)).join(t("state.stageBoxes.note.sep")), warn: false, key: undefined, items }];
    }
    const xs = incidents.filter((x) => x.kind === glyph);
    if (!xs.length) return [];
    const warn = xs.some((x) => x.attention === true);
    const items = [...new Set(xs.map((x) => x.itemId))];
    const text = xs.length === 1 ? xs[0]!.text : t("state.stageBoxes.note.times", { text: xs[0]!.text, n: xs.length });
    return [{ glyph, text, warn, key: `ic:${glyph}`, items }];
  });
}

// ───────────────────────── 框里交上来验收的结论（93 号票） ─────────────────────────

/** 横条点开后的一条要点：k 是前面那个小标题（"要求""系统查到"……），没有就是一整行；sys 是系统直接查到的 */
export interface StripPoint {
  readonly k?: string | undefined;
  readonly text: string;
  readonly sys?: boolean | undefined;
}

/** 框里的一次验收结论：一行（图标、标题、右边的小签），点开是几条要点，箭头进那张卡的详情 */
export interface VerdictStrip {
  /** ok：验收通过；reject：退回；failed：几次都没通过、交给你决定 */
  readonly tone: "ok" | "reject" | "failed";
  readonly icon: "✓" | "✕";
  readonly title: string;
  readonly tail: string;
  readonly points: readonly StripPoint[];
}

/** 一条标准的备注：取第一行（脚本的输出末尾、评审的理由、你写的原因） */
const firstLine = (note: string | undefined) => note?.trim().split("\n")[0]?.trim() || undefined;

/**
 * 一次验收结论画成的横条（通过的标题"验收通过：「…」"、右边写核对了几条或"你验收的"，点开逐条标准、
 * 系统查到的、你写的说明；退回的"已退回：「…」"、右边"和实际对不上"，点开是要求、Agent 交的、系统查到的、结果；几次都没通过的
 * "几次都没通过：「…」"、右边"交给你决定"）。二狗的结论是进度卡：逐条标准带方式（由你验收的标 👤），系统查到的是脚本、评审的备注，
 * 你写的说明是你验收那几条的备注，维护者交上来时写的那一两句算"Agent 交的"（二狗写"维护者交的"）。
 * 311 号票：没过的几条都是验收没跑起来的（notRun：脚本起不来、命令找不到）时，右边写"验收没跑起来"、结果写明，不说"和实际对不上"
 * （系统查到的照旧是起不来的原因）；有一条是跑了没过的照旧。
 * final：这是最后一次、紧跟着停下找你（stageBoxes 认出来的）
 */
export function verdictStrip(a: Acceptance, final: boolean): VerdictStrip {
  const { results, passed, judgedBy } = a.acceptance;
  const name = t("state.stageBoxes.quoted", { title: a.stageTitle });
  const sep = t("state.stageBoxes.strip.sep");
  const sysNotes = results.flatMap((r) => (r.method !== "user" ? (firstLine(r.note) ?? []) : []));
  const userNote = results.map((r) => (r.method === "user" ? firstLine(r.note) : undefined)).find((x) => x !== undefined);
  if (passed) {
    return {
      tone: "ok",
      icon: "✓",
      title: t("state.stageBoxes.strip.accepted", { name }),
      tail: judgedBy === "user" ? t("state.stageBoxes.strip.byUser") : t("state.stageBoxes.strip.checked", { n: results.length }),
      points: [
        ...results.map((r) => ({ text: `${r.method === "user" ? "👤" : "✓"} ${r.criterion}` })),
        ...(sysNotes.length ? [{ k: t("state.stageBoxes.strip.found"), text: sysNotes.join(sep), sys: true }] : []),
        ...(userNote ? [{ text: t("state.stageBoxes.strip.userNote", { note: userNote }) }] : []),
      ],
    };
  }
  const bad = results.filter((r) => !r.passed);
  const summary = a.acceptance.summary?.trim();
  const found = bad.flatMap((r) => (r.method !== "user" ? (firstLine(r.note) ?? []) : []));
  const notRun = bad.length > 0 && bad.every((r) => r.notRun === true);
  return {
    tone: final ? "failed" : "reject",
    icon: "✕",
    title: final ? t("state.stageBoxes.strip.failedFinal", { name }) : t("state.stageBoxes.strip.sentBack", { name }),
    tail: final ? t("state.stageBoxes.strip.yourCall") : notRun ? t("state.stageBoxes.strip.notRun") : t("state.stageBoxes.strip.mismatch"),
    points: [
      { k: t("state.stageBoxes.strip.required"), text: bad.map((r) => r.criterion).join(sep) || "—" },
      ...(summary ? [{ k: t("state.stageBoxes.strip.fromMaintainer"), text: summary }] : []),
      ...(judgedBy === "user"
        ? userNote
          ? [{ k: t("state.stageBoxes.strip.yourNote"), text: t("state.stageBoxes.quoted", { title: userNote }) }]
          : []
        : [{ k: t("state.stageBoxes.strip.found"), text: found.length ? found.join(sep) : t("state.stageBoxes.strip.notMet"), sys: true }]),
      { k: t("state.stageBoxes.strip.result"), text: final ? t("state.stageBoxes.strip.resultFinal") : notRun ? t("state.stageBoxes.strip.resultNotRun") : t("state.stageBoxes.strip.resultSentBack") },
    ],
  };
}

const NATURE_RANK: Readonly<Record<ToolNature, number>> = { look: 0, act: 1, modify: 2 };

/** 算框要的一个阶段：id、标题、前置、现在的状态（真任务从看板上的阶段列表来，原型从假阶段给） */
export interface StageBoxStage {
  readonly id: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly state: string;
  readonly waitReason?: string | undefined;
}

/**
 * 这个任务的会话里每个阶段框（stale：重开之前那几轮的条目，状态层 zoomDecor 的 stale）。
 * live：维护者正在干活、会话最后一条落在这一组里（在跑、是最后一组、最后一条在组里）。
 * list、running 不给就按看板上的这个任务（原型的假任务给假阶段、假的活动状态）
 */
export function stageBoxes(
  state: UiState,
  items: readonly ChatItem[],
  taskId: string,
  o: { stale: ReadonlySet<string>; list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined },
): StageBoxView[] {
  const task = state.tasks[taskId];
  const groups = stageGroups(state, items, taskId);
  const byId = new Map(items.map((it) => [it.id, it]));
  const list: readonly StageBoxStage[] = o.list ?? (task?.stages?.list ?? []).map((s) => ({ id: s.stageId, title: s.title, after: s.dependsOn, state: s.state, waitReason: s.waitReason }));
  // 被计划变更、自行调整去掉的阶段：标题、阶段号照依赖图上的节点（从确认过的旧版计划取，阶段号和现在的一起排）；原型的假任务图上不画去掉的
  const removed = o.list ? [] : removedTaskStages(state, taskId, new Set(list.map((s) => s.id)));
  const all = [...list.map((s) => ({ id: s.id, after: s.after })), ...removed.map((r) => ({ id: r.id, after: r.after }))];
  const ids = new Set(all.map((s) => s.id));
  const no = stageNumbers(all.map((s) => ({ id: s.id, after: s.after.filter((x) => ids.has(x)) })));
  const plan = task ? effectivePlanOf(state, task)?.plan : undefined;
  const running = o.running ?? (task !== undefined && agentActivity(state, task.maintainerId).state === "working");
  const lastItem = items.at(-1)?.id;
  return groups.map((g, gi): StageBoxView => {
    const members = g.ids.map((id) => byId.get(id)!);
    const calls = members.flatMap((m) => (m.kind === "tool_group" ? m.calls : []));
    const incidents = incidentsIn(state, members);
    const live = running && gi === groups.length - 1 && lastItem === g.ids.at(-1);
    const latest = g.stageId !== undefined && groups.findLast((x) => x.stageId === g.stageId) === g;
    const stale = o.stale.has(g.ids[0]!);
    const natures = members.flatMap((m) => chatItemNature(m) ?? []);
    const nature = natures.reduce<ToolNature>((a, b) => (NATURE_RANK[b] > NATURE_RANK[a] ? b : a), "look");
    const kind: ContentKind = g.stageId !== undefined || calls.length ? "tool" : members.some((m) => m.content === "context") ? "context" : "thinking";
    const base = { ...g, focusId: g.ids.at(-1)!, incidents, toolCount: calls.length, notes: stageNotes(incidents, actNotesOf(calls)), kind, nature, live, latest, stale };
    if (g.stageId === undefined) {
      const text = miscText(members, calls);
      return { ...base, no: undefined, title: text, status: { cls: "off", text: "" }, summary: undefined, lines: [], strips: new Map(), caption: text };
    }
    const stageId = g.stageId;
    const stage = list.find((s) => s.id === stageId);
    const planStage = plan?.stages.find((s) => s.stageId === stageId);
    const title = stage?.title ?? planStage?.title ?? removed.find((r) => r.id === stageId)?.title ?? stageId;
    // 每次交上来的验收结论：最后那次没通过、紧跟着停下找你的是"几次都没通过，交给你决定"，别的没通过是退回（retry）
    const verdicts = members.flatMap((m, i) => {
      const a = acceptanceOf(state, m);
      return a ? [{ id: m.id, a, final: !a.acceptance.passed && isDeviation(members[i + 1]) }] : [];
    });
    const accepted = verdicts.find((v) => v.a.acceptance.passed)?.a;
    const failed = verdicts.at(-1)?.final === true;
    const retries = verdicts.filter((v) => !v.a.acceptance.passed && !v.final).length;
    const now = latest ? stage : undefined;
    const status: StageBoxView["status"] = stale
      ? { cls: "off", text: t("state.stageBoxes.status.stale") }
      : accepted
        ? { cls: "ok", text: t("state.stageBoxes.status.done") }
        : failed
          ? { cls: "bad", text: t("state.stageBoxes.status.failed") }
          : live || now?.state === "running"
            ? { cls: "live", text: t("state.stageBoxes.status.running") }
            : now && (now.state === "accepting" || now.state === "waiting")
              ? { cls: "live", text: lookText(now.state, now.waitReason) }
              : now?.state === "accepted"
                ? { cls: "ok", text: t("state.stageBoxes.status.done") }
                : { cls: "off", text: t("state.stageBoxes.status.unfinished") };
    // 一句小结：做完了说结果，正在做说在做什么（定步的写第几步）
    const steps = planStage?.mode === "steps" ? (planStage.steps?.length ?? 0) : 0;
    const done = calls.filter((c) => c.part.outcome === "done").length;
    const act = actOf(calls.at(-1)) ?? t("state.stageBoxes.starting");
    const doing = steps ? t("state.stageBoxes.doingStep", { n: Math.min(done + (live ? 1 : 0), steps) || 1, total: steps, act }) : t("state.stageBoxes.doing", { act });
    // 274 号票：做完的阶段框里先写系统查到的结果（宣布完成时效果日志汇总的个数，
    // 只在这个阶段最新的那一框里写——重开之前那几框是上一轮的）
    const observed = accepted && latest && !stale ? task?.stages?.list?.find((s) => s.stageId === stageId)?.observed : undefined;
    const results = accepted ? [...(observed ? [t("state.stageBoxes.line.observed", { line: observedLine(observed) })] : []), ...resultLines(accepted)] : [];
    const summary = stale
      ? t("state.stageBoxes.summary.stale")
      : accepted
        ? (accepted.acceptance.summary ?? resultLines(accepted)[0])
        : failed
          ? t("state.stageBoxes.summary.failed")
          : status.cls === "live"
            ? doing
            : undefined;
    const lines = [...results, ...(retries ? [t("state.stageBoxes.line.retries", { count: retries, n: retries })] : [])];
    if (!accepted && status.cls === "live") lines.push(t("state.stageBoxes.line.actions", { count: calls.length, n: calls.length }));
    const n = no.get(stageId);
    const strips = new Map(verdicts.map((v) => [v.id, verdictStrip(v.a, v.final)]));
    return { ...base, no: n, title, status, summary, lines, strips, caption: n !== undefined ? t("state.stageBoxes.caption", { n, title }) : title };
  });
}

/** 验收中、等你的那几种怎么写（和依赖图上的一样：◑ 验收中、◑ 待验收、◐ 等你） */
function lookText(state: "accepting" | "waiting", waitReason: string | undefined): string {
  const look = graphLook(state, waitReason);
  return `${look.icon} ${look.text}`;
}

// ───────────────────────── 缩放里的阶段框 ─────────────────────────

/** 阶段框那一块在书脊、底色带上下沿里的写法：sbox:<组的 id>（条目、组里的块写自己的 id） */
export const STAGE_BOX_EDGE = "sbox:";

/**
 * 框里每一行（展开的阶段框里每次操作一行）：工具调用组拆成组里每次调用、每段思考（57 号票缩小后的那几块，
 * 在框里三档都这么画，组那一行不画）；组里没有算进 N 的调用（都是顺利执行的内部工具）的照旧是那一行；别的是自己
 */
export function stageBoxRows(members: readonly ChatItem[]): string[] {
  return members.flatMap((m) => {
    const blocks = zoomBlocks(m);
    return blocks.length ? blocks.map((b) => b.id) : [m.id];
  });
}

/**
 * 书脊、底色带的上下沿落在哪一块上：收着的框里的事落在框上；一个框里的事，上沿从框顶开始（展开了也是）；
 * 展开了的别的落在各自那一条
 */
export function stageBoxEdge(groupOf: ReadonlyMap<string, StageGroup>, open: ReadonlySet<string>, id: string, at: "top" | "bottom"): string {
  const g = groupOf.get(id);
  if (!g) return id;
  return !open.has(g.id) || (at === "top" && g.ids[0] === id) ? `${STAGE_BOX_EDGE}${g.id}` : id;
}

/** 画出来的书脊：收着的框里同一阶段重做的那一轮并进同一段（颜色按最后一轮），展开了才分开画 */
export function stageBoxSpines(spines: readonly ZoomSpine[], groupOf: ReadonlyMap<string, StageGroup>, open: ReadonlySet<string>): ZoomSpine[] {
  const out: ZoomSpine[] = [];
  const firstIn = new Map<string, number>();
  for (const sp of spines) {
    const g = groupOf.get(sp.firstId);
    let top = sp.firstId;
    if (g) {
      const at = firstIn.get(g.id);
      if (at === undefined) {
        firstIn.set(g.id, out.length);
        top = `${STAGE_BOX_EDGE}${g.id}`;
      } else if (!open.has(g.id) && out[at]!.stageId === sp.stageId) {
        out[at] = { ...out[at]!, state: sp.state, lastId: stageBoxEdge(groupOf, open, sp.lastId, "bottom") };
        continue;
      }
    }
    out.push({ ...sp, firstId: top, lastId: stageBoxEdge(groupOf, open, sp.lastId, "bottom") });
  }
  return out;
}
