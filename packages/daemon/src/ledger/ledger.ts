// token 账本（规格第 2 节的模块"token 账本"、第 16 节，24 号票）：逐次记用量、汇总。
// - 记一条：agent 管家收到子进程的 usage（每次模型调用一条，压缩会话那次也报）交给 record，连同拉起 agent 的模块给的归属。
//   输入分成命中缓存的（cacheRead）和没命中的（input + cacheWrite，ledgerTokens）；任务名下的记上这次调用算哪个阶段；
//   用途（干活、范围审视、压缩）照子进程报的记。记在 ledger 频道（守护进程内部），派生视图 token_ledger。
// - 系统开销按角色判：秘书的用量不论它在处理什么都是系统开销（不在任何名下）；拉起时没给归属的 agent 记成"未归属"，单列，日志里提醒。
// - 记在任务或定时作业名下的，同一事务里在看板频道推一条 token_totals：这个名下的最新合计（总量、按 agent、按阶段），
//   任务卡、作业卡上的总量和任务详情里的细分都来自它。项目名下的（项目维护者不在任务里时）只进账本。
//   合计只从派生视图的 SQL 聚合出（views.ts 的 ownerTotals）。
// - 消耗页：选一个时间范围（含两头的日期）按天、按 agent 汇总，系统开销、未归属单列；成本是粗估（pricing.ts）：
//   配置里写了单价的 = 用量 × 配置的单价（每次现读配置，不分时段）；没写的用框架自带的价格表（94 号票：DeepSeek，
//   每一笔按记账时间落在高峰还是空闲时段算，法定节假日看节假日数据）。
// - 按次计费的联网调用（154 号票）：DeepSeek 的联网搜索、读网页每次成功的一条（web_call 事件，派生视图 web_call_ledger），
//   记在发起调用的 agent 名下（归属同上）；消耗页的 web 一节按种类、按 agent 给次数和粗估成本，不进 token 的合计。
// - 给 14 号票（预算的阈值）：stageTokens(taskId, stageId, { budget: true }) 是某个阶段干活用掉的 token（不算评审、范围审视）；
//   onRecorded(fn) 每记一条叫一次。两边同源：都来自子进程上报的这一条用量。
import {
  addTokens,
  CHANNELS,
  EVENT_TYPES,
  type HolidayYear,
  type LedgerOwner,
  type LedgerPurpose,
  type LedgerRole,
  type TokenCounts,
  tokenTotal,
  type TokenTotalsEventPayload,
  type UsageAgentRow,
  type UsageCategory,
  usageCategory,
  type UsageDay,
  type UsageMemoryBrief,
  type UsageSummary,
  type UsageTally,
  type UsageWeb,
  type UsageWebAgentRow,
  type UsageWebTally,
  type WebCallService,
  ZERO_TOKENS,
} from "@ergo/protocol";
import type { TokenPriceTable } from "../config/config.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { UsageReport } from "../runtime/index.ts";
import {
  type AgentContextUsage,
  type AgentUsage,
  type AgentWebCall,
  CONTEXT_USAGE_EVENT,
  type ContextUsagePayload,
  LEDGER_CHANNEL,
  type LedgerEntry,
  TOKEN_USAGE_EVENT,
  type TokenUsagePayload,
  WEB_CALL_EVENT,
  type WebCallPayload,
} from "./entry.ts";
import { createSummaryPricing, type SummaryPricing } from "./pricing.ts";
import { contextUsageRows, entryAt, lastEntryOf, listEntries, ownerTotals, rangeRows, stageTokenSum, tokensOf, webCallRows } from "./views.ts";

export interface TokenLedgerOptions {
  store: EventStore;
  now: () => string;
  /** 任务现在算哪个阶段（守卫眼里的当前阶段）；还没开始执行、已经结束、全部阶段验收了是 undefined */
  currentStage: (taskId: string) => string | undefined;
  /** 现读配置里的单价（读不出来时抛错，消耗页写明原因） */
  prices: () => TokenPriceTable;
  /** 节假日数据（框架自带的加导入的，工作日历用的那一份）：自带价格表的高峰时段要扣掉国内法定节假日 */
  holidays: () => readonly HolidayYear[];
  /**
   * 触发登记属于哪个定时触发的任务（76 号票：每次运行的输入带着登记的身份，用量记在任务名下，"消耗页按任务记账"）；
   * 还没迁移的定时作业是 undefined，照旧记在作业名下。不给就都记在作业名下
   */
  taskOfJob?: (jobId: string) => string | undefined;
  log: (line: string) => void;
}

export interface TokenLedger {
  /** 记一次模型调用的用量（agent 管家的 onUsage 接到这里） */
  record(usage: AgentUsage): void;
  /**
   * 记一次按次计费的联网调用（154 号票：联网工具在 DeepSeek 的搜索、读网页成了时叫）：归属和 token 用量同一套算法；
   * 不进 token 的合计、看板，不叫 onRecorded
   */
  recordWebCall(call: AgentWebCall): void;
  /**
   * 记一次插件追加在 agent 输入后面的上下文（266 号票：每条消息的记忆简报）估了多少 token：已经算在那个 agent 这一轮的输入里，
   * 另记一笔给用量页单列；model 取它最近一次干活用的模型（算钱用）。不进 token 的合计、看板，不叫 onRecorded
   */
  recordContextUsage(usage: AgentContextUsage): void;
  /** 账本里的条目，按记账的先后；给了 owner 只要它名下的（null 是不在任何名下的：系统开销和未归属） */
  entries(owner?: LedgerOwner | null): LedgerEntry[];
  /**
   * 某个 agent 最近一次这几种用途的调用（114 号票：⚙ 里的上下文用量是最近一次干活的调用，上次压缩是最近一次压缩的那次）；
   * 只看全局序号大于 afterSeq 的（这段会话里的：清空、重置维护者之后）；没有是 undefined
   */
  lastOf(agentId: string, purposes: readonly LedgerPurpose[], afterSeq?: number): LedgerEntry | undefined;
  /** 某个名下的合计（总量、按 agent、按阶段），和看板上 token_totals 的负载一样；还没有用量是 undefined */
  totals(owner: LedgerOwner): TokenTotalsEventPayload | undefined;
  /** 某个任务的某个阶段用掉了多少 token（命中 + 未命中 + 输出）；budget 为真只算干活的部分（不算评审、范围审视），预算比较用它 */
  stageTokens(taskId: string, stageId: string, options?: { budget?: boolean }): number;
  /** 消耗页：from 到 to（YYYY-MM-DD，含两头）按天、按 agent 的汇总，系统开销、未归属单列，粗估成本 */
  summary(range: { from: string; to: string }): UsageSummary;
  /** 每记一条叫一次（事件已经落盘）；返回取消登记的函数 */
  onRecorded(listener: (entry: LedgerEntry) => void): () => void;
}

/** 子进程报的三块输入换成账本的两块：命中 = cacheRead，未命中 = input + cacheWrite（pi 里三块互不重叠） */
export function ledgerTokens(report: Pick<UsageReport, "input" | "cacheRead" | "cacheWrite" | "output">): TokenCounts {
  return { cacheHit: report.cacheRead, cacheMiss: report.input + report.cacheWrite, output: report.output };
}

export function createTokenLedger(options: TokenLedgerOptions): TokenLedger {
  const { store, now, log } = options;
  const listeners = new Set<(entry: LedgerEntry) => void>();
  const warnedUnattributed = new Set<string>();

  /** 这次用量（或联网调用）的归属：秘书的一律系统开销；没给归属的是未归属；任务名下的定下阶段 */
  const placement = ({ agentId, attribution }: Pick<AgentUsage, "agentId" | "attribution">): Pick<TokenUsagePayload, "owner" | "role" | "stageId"> => {
    if (!attribution) {
      if (!warnedUnattributed.has(agentId)) log(`agent ${agentId} 拉起时没给用量的归属，它的用量记成"未归属"（拉起它的模块要给 SpawnAgentRequest.ledger）`);
      warnedUnattributed.add(agentId);
      return { owner: null, role: "unattributed" };
    }
    if (attribution.role === "secretary") return { owner: null, role: "secretary" };
    const { role } = attribution;
    const ownerTask = attribution.owner?.kind === "scheduled_job" ? options.taskOfJob?.(attribution.owner.id) : undefined;
    const owner = ownerTask === undefined ? attribution.owner : { kind: "task" as const, id: ownerTask };
    const stageId = owner?.kind === "task" ? (attribution.stageId ?? options.currentStage(owner.id)) : undefined;
    return { owner, role, ...(stageId === undefined ? {} : { stageId }) };
  };

  return {
    record(usage) {
      const { agentId, sessionId, model, report } = usage;
      const payload: TokenUsagePayload = {
        time: now(),
        ...placement(usage),
        purpose: report.purpose ?? "work",
        agentId,
        sessionId,
        model,
        tokens: ledgerTokens(report),
      };
      const events: NewEvent[] = [{ channel: LEDGER_CHANNEL, type: TOKEN_USAGE_EVENT, payload }];
      // 任务、定时作业名下的：看板上推这个名下的最新合计（和这一条同一事务；把这一条并进去聚合）
      const { owner } = payload;
      if (owner && owner.kind !== "project") events.push({ channel: CHANNELS.board, type: EVENT_TYPES.tokenTotals, payload: ownerTotals(store.reader, owner, payload) });
      const [result] = store.appendBatch(events);
      const entry = entryAt(store.reader, result!.event.globalSeq)!;
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (err) {
          log(`账本的订阅者出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    },
    recordWebCall(call) {
      const payload: WebCallPayload = { time: now(), ...placement(call), agentId: call.agentId, service: call.service, kind: call.kind };
      store.append({ channel: LEDGER_CHANNEL, type: WEB_CALL_EVENT, payload });
    },
    recordContextUsage(usage) {
      const model = lastEntryOf(store.reader, usage.agentId, ["work"])?.model ?? "";
      const payload: ContextUsagePayload = { time: now(), ...usage, model };
      store.append({ channel: LEDGER_CHANNEL, type: CONTEXT_USAGE_EVENT, payload });
    },
    entries: (owner) => listEntries(store.reader, owner),
    lastOf: (agentId, purposes, afterSeq) => lastEntryOf(store.reader, agentId, purposes, afterSeq),
    totals: (owner) => ownerTotals(store.reader, owner),
    stageTokens: (taskId, stageId, opts = {}) => stageTokenSum(store.reader, taskId, stageId, opts.budget === true),
    summary({ from, to }) {
      const pricing = createSummaryPricing(options.prices, options.holidays());
      const days = new Map<string, { tally: Record<"total" | UsageCategory, UsageTally>; agents: Map<string, UsageAgentRow> }>();
      const agents = new Map<string, UsageAgentRow>();
      const all = emptyTallies();
      for (const r of rangeRows(store.reader, from, to)) {
        const tokens = tokensOf(r);
        const part: UsageTally = { tokens, calls: Number(r.calls), cost: pricing.cost(r.model, r.time, tokens) };
        const category = usageCategory(r.role, Number(r.owned) === 1);
        const day = days.get(r.day) ?? { tally: emptyTallies(), agents: new Map() };
        days.set(r.day, day);
        addTo(day.tally, category, part);
        addAgent(day.agents, r.agent_id, r.role, category, part);
        addAgent(agents, r.agent_id, r.role, category, part);
        addTo(all, category, part);
      }
      const dayList: UsageDay[] = [...days.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, total: d.tally.total, system: d.tally.system, unattributed: d.tally.unattributed, agents: sortAgents(d.agents.values()) }));
      return {
        from,
        to,
        days: dayList,
        agents: sortAgents(agents.values()),
        total: all.total,
        system: all.system,
        unattributed: all.unattributed,
        pricing: pricing.result(),
        web: webSummary(webCallRows(store.reader, from, to), pricing),
        memoryBrief: memoryBriefSummary(contextUsageRows(store.reader, from, to, "memory_brief"), pricing),
      };
    },
    onRecorded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 联网调用的一段合计、一个 agent 的花费和次数（排序用） */
const zeroWeb = (): UsageWebTally => ({ calls: 0, cost: 0 });
const webCostOf = (a: UsageWebAgentRow) => a.search.cost + a.fetch.cost;
const webCallsOf = (a: UsageWebAgentRow) => a.search.calls + a.fetch.calls;

/**
 * 消耗页的 web 一节（154 号票）：范围里按种类、按 agent 的联网调用次数和粗估成本（次数 × 每次的单价）；
 * 单价用不了（配置里的货币不是人民币）时不算钱、标出来
 */
function webSummary(rows: ReturnType<typeof webCallRows>, pricing: SummaryPricing): UsageWeb {
  const total = { search: zeroWeb(), fetch: zeroWeb() };
  const agents = new Map<string, UsageWebAgentRow>();
  const services = new Set<WebCallService>();
  let unpriced = false;
  for (const r of rows) {
    const calls = Number(r.calls);
    const price = pricing.webCallPrice(r.service, r.kind);
    if (price === undefined) unpriced = true;
    else services.add(r.service);
    const part: UsageWebTally = { calls, cost: calls * (price ?? 0) };
    const category = usageCategory(r.role, Number(r.owned) === 1);
    const key = `${r.agent_id}\u0000${category}`;
    const row = agents.get(key) ?? { agentId: r.agent_id, role: r.role, category, search: zeroWeb(), fetch: zeroWeb() };
    row[r.kind] = { calls: row[r.kind].calls + part.calls, cost: row[r.kind].cost + part.cost };
    agents.set(key, row);
    total[r.kind] = { calls: total[r.kind].calls + part.calls, cost: total[r.kind].cost + part.cost };
  }
  const [service] = [...services];
  const price = service === undefined ? undefined : pricing.webPriceNote(service);
  return {
    ...total,
    agents: [...agents.values()].toSorted((a, b) => webCostOf(b) - webCostOf(a) || webCallsOf(b) - webCallsOf(a) || a.agentId.localeCompare(b.agentId)),
    ...(price ? { price } : {}),
    unpriced,
  };
}

/**
 * 用量页的"记忆简报"一项（266 号票）：带了几次、估的 token、粗估的钱——按带进去那一次没命中缓存算（之后留在会话里每次照样读、命中缓存，
 * 不另算）；模型是秘书记账时最近一次干活用的，还不知道（空串）的不算钱
 */
function memoryBriefSummary(rows: ReturnType<typeof contextUsageRows>, pricing: SummaryPricing): UsageMemoryBrief {
  let count = 0;
  let tokens = 0;
  let cost = 0;
  for (const r of rows) {
    count += Number(r.count);
    tokens += Number(r.tokens);
    if (r.model !== "") cost += pricing.cost(r.model, r.time, { cacheHit: 0, cacheMiss: Number(r.tokens), output: 0 });
  }
  return { count, tokens, cost };
}

/** 用量多的在前 */
const sortAgents = (rows: Iterable<UsageAgentRow>) => [...rows].toSorted((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.agentId.localeCompare(b.agentId));

const emptyTally = (): UsageTally => ({ tokens: { ...ZERO_TOKENS }, calls: 0, cost: 0 });

const emptyTallies = (): Record<"total" | UsageCategory, UsageTally> => ({ total: emptyTally(), owned: emptyTally(), system: emptyTally(), unattributed: emptyTally() });

const addTally = (a: UsageTally, b: UsageTally): UsageTally => ({ tokens: addTokens(a.tokens, b.tokens), calls: a.calls + b.calls, cost: a.cost + b.cost });

/** 一份用量加进合计和它那一类 */
function addTo(tallies: Record<"total" | UsageCategory, UsageTally>, category: UsageCategory, part: UsageTally): void {
  tallies.total = addTally(tallies.total, part);
  tallies[category] = addTally(tallies[category], part);
}

function addAgent(rows: Map<string, UsageAgentRow>, agentId: string, role: LedgerRole, category: UsageCategory, part: UsageTally): void {
  const key = `${agentId}\u0000${category}`;
  const prev = rows.get(key);
  rows.set(key, prev ? { ...prev, ...addTally(prev, part) } : { agentId, role, category, ...part });
}
