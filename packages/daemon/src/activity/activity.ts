// 活动状态（规格术语"活动状态"）：agent 此刻在做什么——休眠、干活中（附带在做什么）、等你、排队。和任务状态、项目状态分开，互不改写。
// 这里在活动状态频道上记 activity 事件（落盘：前端重连后照样知道谁在排队、谁在等你），派生视图 agent_activity 留每个 agent
// 最新的状态和说明。一个 agent 的活动状态由两样合起来：
// - agent 管家报来的（agent-manager.ts 的 onActivity：排队、干活中、子进程里有调用在等审批的"等你"、休眠）；
// - 待处理的卡片（card-waits.ts：挂起的审批卡、没回答的提问卡）：管家报的是休眠时，还有属于它的这种卡就是"等你"，说明写原因；
//   卡片处理掉了回到休眠（空闲、闲置退出）。卡片由事件推出，守护进程重启后照样对。
// - 运行时（286 号票，agent 宿主报的 runtimeWait）：维护者有活、用的运行时插件却没启用、拉不起来——管家报的是休眠时就是"等你"，
//   说明写明哪个插件没启用（排在卡片前面：插件不启用，卡片处理了也干不了）；插件启用了交 undefined，回到原来的。
//   290 号票：接管来的会话交还给运行时了、维护者有活也不拉起，同样是"等你"（说明写交还给了谁、收回后接着）。
// 去重只在这里做一次：合起来的状态和说明都没变就不记。
// 守护进程重启时（settle），上次记的一律按"子进程都已不在"重新合一遍：没有待处理卡片的是休眠，有的是等你。
// 干活中此刻在做什么（思考、写回复、调用某个工具，管家的 onProgress）变得很频繁，只作为临时事件 activity_progress
// 推给连着的前端（不落盘、不补发），每个 agent 每 ACTIVITY_PROGRESS_INTERVAL_MS 最多一条（规格第 5 节"进度事件节流"，
// 节流用 util/throttle.ts，和流式增量同一套），攒着的只推最新的那条，和上一条一样的不推；状态变了就丢掉还没推出去的。
// 12 号票有休眠、干活中、排队，25 号票加了等你和说明。
import {
  ACTIVITY_PROGRESS_INTERVAL_MS,
  type ActivityDetail,
  type ActivityEventPayload,
  type ActivityProgressEventPayload,
  type ActivityState,
  CHANNELS,
  EVENT_TYPES,
  type EventFrame,
} from "@ergo/protocol";
import type { DerivedView, EventStore } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { createKeyedThrottle } from "../util/throttle.ts";
import { CARD_WAIT_TYPES, pendingCardWaits } from "./card-waits.ts";

export const activityView: DerivedView = {
  name: "agent_activity",
  create: (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS agent_activity (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL)");
    // 说明（JSON，25 号票）：12 号票建的老库补上这一列
    if (!db.all<{ name: string }>("PRAGMA table_info(agent_activity)").some((c) => c.name === "detail")) db.exec("ALTER TABLE agent_activity ADD COLUMN detail TEXT");
  },
  clear: (db) => db.exec("DELETE FROM agent_activity"),
  apply(db, event) {
    if (event.channel !== CHANNELS.activity || event.type !== EVENT_TYPES.activity) return;
    const p = event.payload as ActivityEventPayload;
    db.run(
      `INSERT INTO agent_activity (agent_id, state, since, detail) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET state = excluded.state, since = excluded.since, detail = excluded.detail`,
      p.agentId,
      p.state,
      p.since,
      p.detail === undefined ? null : JSON.stringify(p.detail),
    );
  },
};

/** 一个 agent 的活动状态和说明 */
interface Activity {
  state: ActivityState;
  detail?: ActivityDetail;
}

interface ActivityRow {
  agent_id: string;
  state: ActivityState;
  since: string;
  detail: string | null;
}

const fromRow = (r: ActivityRow): Activity & { agentId: string; since: string } => ({
  agentId: r.agent_id,
  state: r.state,
  since: r.since,
  ...(r.detail === null ? {} : { detail: JSON.parse(r.detail) as ActivityDetail }),
});

/** 每个 agent 最新的活动状态和说明 */
export function listActivity(db: ReadonlyDatabase): Array<Activity & { agentId: string; since: string }> {
  return db.all<ActivityRow>("SELECT agent_id, state, since, detail FROM agent_activity ORDER BY agent_id").map(fromRow);
}

export interface ActivityLog {
  /** agent 管家报来一个 agent 的活动状态（可能没变：合起来没变就不记） */
  record(agentId: string, state: ActivityState, detail?: ActivityDetail): void;
  /** 干活中此刻在做什么：节流后作为临时事件推送（不在干活中的不推） */
  progress(agentId: string, detail: ActivityDetail): void;
  /**
   * 维护者有活却拉不起来（286 号票：运行时插件没启用，说明是 runtime_off；290 号票：接管来的会话交还了，说明是 handed_back）；
   * 能拉起了交 undefined
   */
  runtimeWait(agentId: string, wait: ActivityDetail | undefined): void;
  /** 守护进程启动时：子进程都已不在，上次记的按休眠和待处理的卡片重新合一遍 */
  settle(): void;
  /** 停掉节流的计时器，不再听卡片的变化 */
  stop(): void;
}

export interface ActivityLogOptions {
  store: EventStore;
  /** 活动状态事件的时间（协议时间） */
  now: () => string;
  /** 推一条临时事件给连着的前端 */
  publish?: (frame: EventFrame) => void;
  /** 同一个 agent 两条进度之间的最短间隔，默认 ACTIVITY_PROGRESS_INTERVAL_MS */
  progressIntervalMs?: number;
  /** 节流用的钟（毫秒；测试换成假的） */
  nowMs?: () => number;
}

const same = (a: Activity | ActivityDetail | undefined, b: Activity | ActivityDetail | undefined) => JSON.stringify(a) === JSON.stringify(b);

export function createActivityLog(options: ActivityLogOptions): ActivityLog {
  const { store, now } = options;
  /** 管家报来的（没报过的是休眠：子进程不在） */
  const reported = new Map<string, Activity>();
  /** 每个 agent 在等你的待处理卡片 */
  let cardWaits = pendingCardWaits(store.reader);
  /** 有活却拉不起来的 agent（286 号票）：等你的说明（运行时插件没启用、290 号票的交还了） */
  const runtimeWaits = new Map<string, ActivityDetail>();
  /** 每个 agent 最后记下的（这次启动没记过的从视图读） */
  const latest = new Map<string, Activity>();
  /** 进度：攒着还没推的最新一条、上一条推出去的（状态变了就清掉） */
  const pendingProgress = new Map<string, ActivityDetail>();
  const sentProgress = new Map<string, ActivityDetail>();

  const lastRecorded = (agentId: string): Activity | undefined => {
    const known = latest.get(agentId);
    if (known) return known;
    const row = store.reader.get<ActivityRow>("SELECT agent_id, state, since, detail FROM agent_activity WHERE agent_id = ?", agentId);
    if (!row) return undefined;
    const { state, detail } = fromRow(row);
    return { state, ...(detail === undefined ? {} : { detail }) };
  };

  /**
   * 合起来的活动状态：管家报的是休眠、运行时插件没启用时是"等你"（说明写明哪个插件，286 号票）；还有在等你的卡片时是"等你"
   * （说明取最近一张的）
   */
  const effective = (agentId: string): Activity => {
    const base = reported.get(agentId) ?? { state: "sleeping" };
    if (base.state !== "sleeping") return base;
    const wait = runtimeWaits.get(agentId);
    if (wait !== undefined) return { state: "waiting_for_user", detail: wait };
    const waiting = cardWaits.get(agentId)?.at(-1);
    return waiting ? { state: "waiting_for_user", detail: waiting } : base;
  };

  const throttle = createKeyedThrottle<string>({
    intervalMs: options.progressIntervalMs ?? ACTIVITY_PROGRESS_INTERVAL_MS,
    ...(options.nowMs ? { now: options.nowMs } : {}),
    flush(agentId) {
      const detail = pendingProgress.get(agentId);
      pendingProgress.delete(agentId);
      if (!detail || same(detail, sentProgress.get(agentId)) || latest.get(agentId)?.state !== "working") return false;
      sentProgress.set(agentId, detail);
      const payload: ActivityProgressEventPayload = { agentId, detail };
      options.publish?.({ channel: CHANNELS.activity, seq: store.lastSeq(CHANNELS.activity), type: EVENT_TYPES.activityProgress, payload });
      return true;
    },
  });

  /** 合起来变了就记一条；之前攒着的进度作废 */
  const sync = (agentId: string) => {
    const next = effective(agentId);
    const recorded = lastRecorded(agentId);
    if (same(next, recorded)) {
      latest.set(agentId, next);
      return;
    }
    throttle.cancel(agentId);
    pendingProgress.delete(agentId);
    sentProgress.delete(agentId);
    const payload: ActivityEventPayload = { agentId, state: next.state, since: now(), ...(next.detail === undefined ? {} : { detail: next.detail }) };
    latest.set(agentId, next);
    store.append({ channel: CHANNELS.activity, type: EVENT_TYPES.activity, payload });
  };

  // 会让 agent 等用户的卡片变了（出卡、处理、过期）：重新算，等的卡有变化的 agent 各合一遍
  const unsubscribe = store.onAppend((event) => {
    if (event.channel !== CHANNELS.cards || event.type !== EVENT_TYPES.card) return;
    const { card } = event.payload as { card: { type: string } };
    if (!CARD_WAIT_TYPES.includes(card.type)) return;
    const before = cardWaits;
    cardWaits = pendingCardWaits(store.reader);
    for (const agentId of new Set([...before.keys(), ...cardWaits.keys()])) if (!same(before.get(agentId)?.at(-1), cardWaits.get(agentId)?.at(-1))) sync(agentId);
  });

  return {
    record(agentId, state, detail) {
      reported.set(agentId, { state, ...(detail === undefined ? {} : { detail }) });
      sync(agentId);
    },
    progress(agentId, detail) {
      if (latest.get(agentId)?.state !== "working") return;
      pendingProgress.set(agentId, detail);
      throttle.schedule(agentId);
    },
    runtimeWait(agentId, wait) {
      if (JSON.stringify(runtimeWaits.get(agentId)) === JSON.stringify(wait)) return;
      if (wait === undefined) runtimeWaits.delete(agentId);
      else runtimeWaits.set(agentId, { ...wait });
      sync(agentId);
    },
    settle() {
      for (const agentId of new Set([...listActivity(store.reader).map((a) => a.agentId), ...cardWaits.keys()])) sync(agentId);
    },
    stop() {
      unsubscribe();
      throttle.close();
    },
  };
}
