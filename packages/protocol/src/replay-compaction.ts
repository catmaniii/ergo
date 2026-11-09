// 冷补发只发最新的（456）：一个频道的落盘事件里，同一件事被后来的事件整份盖掉的旧记录，折出来的界面状态和没有它们时一样，
// 冷补发（页面手里什么都没有、或者要重新同步的频道）和页面本机存的事件都可以不要它们。守护进程（gateway.ts 的订阅）和网页
// （app/open-snapshot.ts 存在 IndexedDB 里的事件）共用这一份规则，规则照网页状态层（packages/web/src/state/ui-state.ts）的归并逐个类型对齐。
// 守护进程存的事件一条不删、不改：这里只决定"发给页面的"和"页面自己存的"。
//
// 怎么合并：每条事件说它"认领"哪几样（CompactionClaim：键 + 名次），同一个键只留赢家——名次最大的，一样大留先到的（卡片按版本：
// 前端同一版本的后到的不认）。一条事件赢下它认领的任何一样就留；照留的（keep）不管输赢都留；赢家是删除、而且删掉的东西只有这个频道
// 管（gone：待办、设备），这一样整个不留。另外每个频道的最后一条总是留（页面的游标照旧是最后一条的序号）。合并只去掉事件、不改事件，
// 留下的照原来的先后。
//
// 规则表（REPLAY_COMPACTION_RULES）给协议里每个落盘事件类型都写了一条：按什么合并，或者明说不合并。不在表里的类型（以后新加的、
// 插件自己的）一律不合并、全留；协议包的测试查表是齐的（新加一个落盘事件类型不在表里就红），逼着加的人想一想它能不能合并。
// 规则一改（某一类从不合并改成合并、键变了），页面本机按旧规则合并过的事件就可能缺了新规则要的，所以改规则要把 REPLAY_COMPACTION_VERSION
// 加一（页面认出来不是这一版的就不用、从头补）。
// 合并的正确性由网页的等价测试锁住（packages/web/test/state/open-snapshot.test.ts："全量冷补发""合并后冷补发""本机合并后重折 + 增量"
// 折出来的一样）。不引用 TypeBox。
import { EVENT_TYPES, isEphemeralEventType } from "./constants.ts";
import { isDeletedEventPayload } from "./deleted-event.ts";

/** 合并规则的版本：规则改了就加一（页面本机存的、按旧规则合并过的事件不再用） */
export const REPLAY_COMPACTION_VERSION = 1;

/** 合并时要看的一条事件（守护进程存的、页面收到的都有这几样） */
export interface CompactableEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

/** 一条事件认领的一样：同一个键只留赢家（rank 大的，一样大留先到的）；gone：赢家是这一样的删除，整个不留 */
export interface CompactionClaim {
  readonly key: string;
  readonly rank: number;
  readonly gone?: true;
}

/** 一条事件怎么合并：照留（不管输赢）、认领哪几样 */
export interface CompactionVerdict {
  readonly keep: boolean;
  readonly claims: readonly CompactionClaim[];
}

/** 一个事件类型的规则：不合并（每条都留），或者按 claims 认领 */
export type CompactionRule = { readonly merge: "none" } | { readonly merge: "claims"; readonly claims: (event: CompactableEvent) => CompactionVerdict };

const NONE: CompactionRule = { merge: "none" };
const KEEP: CompactionVerdict = { keep: true, claims: [] };
/** 前端整个忽略的（彻底删除改写成的"已删除"标记）：不认领、不照留，只在是频道的最后一条时留 */
const DROP: CompactionVerdict = { keep: false, claims: [] };

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
/** 负载里的一个对象（payload.task、payload.card……）：没有就是 undefined */
const part = (event: CompactableEvent, name: string): Record<string, unknown> | undefined => obj(obj(event.payload)?.[name]);

/** 按某个键留最后一条：键取不出来（负载的样子不认识）的照留 */
const latestBy =
  (prefix: string, key: (event: CompactableEvent) => unknown): ((event: CompactableEvent) => CompactionVerdict) =>
  (event) => {
    const k = key(event);
    return str(k) ? { keep: false, claims: [{ key: `${prefix}:${k}`, rank: event.seq }] } : KEEP;
  };
const latest = (prefix: string, key: (event: CompactableEvent) => unknown): CompactionRule => ({ merge: "claims", claims: latestBy(prefix, key) });
/** 全局只有一份的（名字、语言、工作日历的设置……）：留最后一条 */
const single = (key: string): CompactionRule => ({ merge: "claims", claims: (event) => ({ keep: false, claims: [{ key, rank: event.seq }] }) });
/** 看板上会让日历变的（提醒、定时作业）：最后一条的序号是日历的 changedAt.board（ui-state.ts 的 withCalendarChange），总要留着 */
const calendar = (event: CompactableEvent): CompactionClaim => ({ key: "calendar", rank: event.seq });

/**
 * 每个落盘事件类型的合并规则（照 ui-state.ts 的 eventHandlers）。键是事件类型；没写的类型不合并。
 * 会话频道上的类型不合并：会话频道冷补发本来就只补最近一页（conversation/history.ts 的 firstReplayAfter），页面也不存它们的事件。
 * 守护进程内部频道上的类型（页面不订阅）不合并：用不着。
 */
export const REPLAY_COMPACTION_RULES: Readonly<Record<string, CompactionRule>> = {
  // ── 会话频道（不归这里管） ──
  [EVENT_TYPES.message]: NONE,
  [EVENT_TYPES.turnStart]: NONE,
  [EVENT_TYPES.turnEnd]: NONE,
  [EVENT_TYPES.modelRetry]: NONE,
  [EVENT_TYPES.quickActionExecuted]: NONE,
  [EVENT_TYPES.timelineRecord]: NONE,
  [EVENT_TYPES.messagesPurged]: NONE,
  [EVENT_TYPES.voice]: NONE,
  [EVENT_TYPES.segment]: NONE,
  [EVENT_TYPES.agentVoice]: NONE,
  [EVENT_TYPES.messageQueue]: NONE,
  [EVENT_TYPES.sessionBranch]: NONE,
  [EVENT_TYPES.stageStart]: NONE,
  [EVENT_TYPES.effectUndoRequested]: NONE,

  // ── 守护进程内部频道（页面不订阅） ──
  [EVENT_TYPES.approvalDecided]: NONE,
  [EVENT_TYPES.memoryCommand]: NONE,
  [EVENT_TYPES.webPageSaved]: NONE,
  [EVENT_TYPES.materialIngested]: NONE,
  [EVENT_TYPES.materialReplies]: NONE,
  [EVENT_TYPES.planDecided]: NONE,
  [EVENT_TYPES.charterDecided]: NONE,
  [EVENT_TYPES.outputReaction]: NONE,
  [EVENT_TYPES.parallelDecided]: NONE,
  [EVENT_TYPES.grantRenewalDecided]: NONE,
  [EVENT_TYPES.toolkitDecided]: NONE,
  [EVENT_TYPES.mcpDecided]: NONE,
  [EVENT_TYPES.skillDecided]: NONE,
  [EVENT_TYPES.mcpCalled]: NONE,
  [EVENT_TYPES.charterChangeDecided]: NONE,
  [EVENT_TYPES.standardChangeDecided]: NONE,
  [EVENT_TYPES.operationsDecided]: NONE,
  [EVENT_TYPES.workOrderDecided]: NONE,

  // ── 卡片频道 ──
  // 卡片：每张留版本最大的那条（前端版本不大于手里的不认，一样大的后到的不认）；"已删除"标记前端忽略，不留。
  // 快速动作卡不合并：它每来一版都把会话里对应的操作记录改一遍（ui-state.ts 的 withOperationsOf，结果说明是"这一版有就换、没有就留着上一版的"），
  // 只留最后一版可能和一版版改下来的不一样
  [EVENT_TYPES.card]: {
    merge: "claims",
    claims: (event) => {
      if (isDeletedEventPayload(event.payload)) return DROP;
      const card = part(event, "card");
      if (!card || !str(card.id) || !num(card.version) || card.type === "quick_action") return KEEP;
      return { keep: false, claims: [{ key: `card:${card.id}`, rank: card.version }] };
    },
  },
  // 前端不归并的三类（回避信号、提问卡的回答：素材的来源）：量很小，不合并
  [EVENT_TYPES.cardDismissed]: NONE,
  [EVENT_TYPES.cardStale]: NONE,
  [EVENT_TYPES.questionsAnswered]: NONE,

  // ── 待我处理频道 ──
  // 每条事项留最后一条；最后一条是删除的整条不留（待办只由这个频道管，删了的前端本来就拿掉）
  [EVENT_TYPES.inboxItem]: {
    merge: "claims",
    claims: (event) => {
      const item = part(event, "item");
      if (!item || !str(item.id)) return KEEP;
      return { keep: false, claims: [{ key: `inbox:${item.id}`, rank: event.seq, ...(item.deleted ? { gone: true as const } : {}) }] };
    },
  },

  // ── 任务看板频道 ──
  // 任务：每个任务留最后一条；返工（change: rework）每条都留（前端按它攒返工记录 taskReopens）；删除的照留（删除连带拿掉任务的计划、
  // 返工记录、它自己的负责人会话：留着这一条，连带的照样发生）
  [EVENT_TYPES.task]: {
    merge: "claims",
    claims: (event) => {
      const task = part(event, "task");
      if (!task || !str(task.id)) return KEEP;
      const keep = obj(event.payload)?.change === "rework" || Boolean(task.deleted);
      return { keep, claims: [{ key: `task:${task.id}`, rank: event.seq }] };
    },
  },
  // 提醒：每条提醒留最后一条；"已删除"标记前端忽略。另外看板上最后一条提醒或定时作业事件总要留（日历的 changedAt.board）
  [EVENT_TYPES.reminder]: {
    merge: "claims",
    claims: (event) => {
      if (isDeletedEventPayload(event.payload)) return { keep: false, claims: [calendar(event)] };
      const reminder = part(event, "reminder");
      if (!reminder || !str(reminder.id)) return KEEP;
      return { keep: false, claims: [{ key: `reminder:${reminder.id}`, rank: event.seq }, calendar(event)] };
    },
  },
  // 定时作业：每个作业留最后一条，另外每次运行（run.runId）留最后说到它的那条（前端 jobRuns 按运行攒着）；日历同提醒
  [EVENT_TYPES.scheduledJob]: {
    merge: "claims",
    claims: (event) => {
      if (isDeletedEventPayload(event.payload)) return { keep: false, claims: [calendar(event)] };
      const job = part(event, "job");
      if (!job || !str(job.id)) return KEEP;
      const run = part(event, "run");
      return {
        keep: false,
        claims: [{ key: `job:${job.id}`, rank: event.seq }, ...(run && str(run.runId) ? [{ key: `run:${run.runId}`, rank: event.seq }] : []), calendar(event)],
      };
    },
  },
  // 用量合计：每个归属（task:<id>、job:<id>，ledgerOwnerKey）留最后一条
  [EVENT_TYPES.tokenTotals]: latest("totals", (event) => {
    const owner = part(event, "owner");
    return owner && str(owner.kind) && str(owner.id) ? `${owner.kind}:${owner.id}` : undefined;
  }),
  // 任务现在生效的计划：每个任务留最后一条；"已删除"标记前端忽略
  [EVENT_TYPES.taskPlan]: {
    merge: "claims",
    claims: (event) => (isDeletedEventPayload(event.payload) ? DROP : latestBy("plan", (e) => obj(e.payload)?.taskId)(event)),
  },
  // 范围记录（看板、项目列表频道上都有）：每条记录留最后一条；"已删除"标记前端忽略
  [EVENT_TYPES.scopeRecord]: {
    merge: "claims",
    claims: (event) => (isDeletedEventPayload(event.payload) ? DROP : latestBy("scope", (e) => part(e, "record")?.id)(event)),
  },

  // ── 活动状态、设备、工作日历、关注类别、名字、语言、已读位置 ──
  [EVENT_TYPES.activity]: latest("activity", (event) => obj(event.payload)?.agentId),
  // 设备：每台留最后一条；最后一条是删除的整台不留（设备只由这个频道管，删了的前端本来就拿掉）
  [EVENT_TYPES.device]: {
    merge: "claims",
    claims: (event) => {
      const device = part(event, "device");
      if (!device || !str(device.id)) return KEEP;
      return { keep: false, claims: [{ key: `device:${device.id}`, rank: event.seq, ...(device.deletedAt !== undefined ? { gone: true as const } : {}) }] };
    },
  },
  [EVENT_TYPES.holidayData]: single("holiday_data"),
  [EVENT_TYPES.workdaySettings]: single("workday_settings"),
  [EVENT_TYPES.watchCategorySettings]: single("watch_category_settings"),
  [EVENT_TYPES.assistantName]: single("assistant_name"),
  [EVENT_TYPES.language]: single("language"),
  // 已读位置：每个会话留位置最靠后的那条（前端只往后挪）
  [EVENT_TYPES.readMark]: {
    merge: "claims",
    claims: (event) => {
      const p = obj(event.payload);
      return p && str(p.conversation) && num(p.seq) ? { keep: false, claims: [{ key: `read:${p.conversation}`, rank: p.seq }] } : KEEP;
    },
  },

  // ── 项目列表频道 ──
  // 项目：每个项目留最后一条；删除的照留（删除连带拿掉项目内部的任务、工单、范围记录和负责人会话，其中任务在看板频道上：
  // 留着这一条，连带的照样发生）
  [EVENT_TYPES.project]: {
    merge: "claims",
    claims: (event) => {
      const project = part(event, "project");
      if (!project || !str(project.id)) return KEEP;
      return { keep: obj(event.payload)?.change === "deleted", claims: [{ key: `project:${project.id}`, rank: event.seq }] };
    },
  },
  [EVENT_TYPES.workOrder]: latest("work_order", (event) => part(event, "workOrder")?.id),

  // ── 插件频道 ──
  // 移除插件时连数据删的记录：按时间删手里的卡片、提醒（跨频道），量很小，不合并
  [EVENT_TYPES.pluginDataPurged]: NONE,
};

/** 一条事件怎么合并（不在规则表里的类型、临时事件都照留） */
export function compactionVerdict(event: CompactableEvent): CompactionVerdict {
  const rule = isEphemeralEventType(event.type) ? undefined : REPLAY_COMPACTION_RULES[event.type];
  return rule?.merge === "claims" ? rule.claims(event) : KEEP;
}

/**
 * 一个频道合并到哪儿了（可以接着往后加事件，结果和一次合并整段的一样；能存成 JSON）：最后一条的序号、照留的序号、
 * 每一样的赢家（[名次, 序号]，赢家是删除的再带一个 1）
 */
export interface ChannelCompaction {
  last: number;
  keep: number[];
  winners: Record<string, [number, number] | [number, number, 1]>;
}

export function emptyCompaction(): ChannelCompaction {
  return { last: 0, keep: [], winners: {} };
}

/** 复制一份（接着加不动原来的） */
export function copyCompaction(state: ChannelCompaction): ChannelCompaction {
  return { last: state.last, keep: [...state.keep], winners: { ...state.winners } };
}

/** 接着加一条（序号要比加过的都大；不大的不管）：改的是 state 本身 */
export function addToCompaction(state: ChannelCompaction, event: CompactableEvent): void {
  if (event.seq <= state.last) return;
  state.last = event.seq;
  const verdict = compactionVerdict(event);
  if (verdict.keep) state.keep.push(event.seq);
  for (const claim of verdict.claims) {
    const held = state.winners[claim.key];
    // 名次一样大的留先到的
    if (held !== undefined && held[0] >= claim.rank) continue;
    state.winners[claim.key] = claim.gone ? [claim.rank, event.seq, 1] : [claim.rank, event.seq];
  }
}

/** 合并后留下的序号：照留的、每一样的赢家（删除的不算）、最后一条 */
export function survivingSeqs(state: ChannelCompaction): Set<number> {
  const kept = new Set(state.keep);
  for (const winner of Object.values(state.winners)) if (winner[2] !== 1) kept.add(winner[1]);
  if (state.last > 0) kept.add(state.last);
  return kept;
}

/** 一个频道的事件合并起来（按序号从早到晚给，留下的照原来的先后；最后一条总在） */
export function compactChannel<E extends CompactableEvent>(events: readonly E[]): E[] {
  const state = emptyCompaction();
  for (const event of events) addToCompaction(state, event);
  const kept = survivingSeqs(state);
  return events.filter((event) => kept.has(event.seq));
}

/** 读回来的（IndexedDB 里存的）像不像一份 ChannelCompaction */
export function isChannelCompaction(value: unknown): value is ChannelCompaction {
  const v = obj(value);
  if (!v || !Number.isInteger(v.last) || (v.last as number) < 0 || !Array.isArray(v.keep) || !v.keep.every((n) => Number.isInteger(n))) return false;
  const winners = obj(v.winners);
  if (!winners || Array.isArray(winners)) return false;
  return Object.values(winners).every((w) => Array.isArray(w) && (w.length === 2 || (w.length === 3 && w[2] === 1)) && num(w[0]) && Number.isInteger(w[1]));
}
