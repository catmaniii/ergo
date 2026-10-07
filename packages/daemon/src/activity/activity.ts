// 活动状态（规格术语"活动状态"）：agent 此刻在做什么——休眠、干活中、等你、排队。和任务状态、项目状态分开。
// agent 管家每次报一个 agent 的活动状态变了（agent-manager.ts 的 onActivity），这里在活动状态频道上记一条 activity 事件
// （落盘：前端重连后照样知道谁在排队）。派生视图 agent_activity 留每个 agent 最新的状态。
// 守护进程重启时，上次没来得及记成休眠的（被杀时正在干活、在排队）一律改记休眠：子进程都已经不在了。
// 12 号票有休眠、干活中、排队；"等你"和看板、项目列表上的活动状态小圆点在 25 号票。
import { type ActivityEventPayload, type ActivityState, CHANNELS, EVENT_TYPES } from "@ergou/protocol";
import type { DerivedView, EventStore } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const activityView: DerivedView = {
  name: "agent_activity",
  create: (db) => db.exec("CREATE TABLE IF NOT EXISTS agent_activity (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL)"),
  clear: (db) => db.exec("DELETE FROM agent_activity"),
  apply(db, event) {
    if (event.channel !== CHANNELS.activity || event.type !== EVENT_TYPES.activity) return;
    const p = event.payload as ActivityEventPayload;
    db.run(
      "INSERT INTO agent_activity (agent_id, state, since) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET state = excluded.state, since = excluded.since",
      p.agentId,
      p.state,
      p.since,
    );
  },
};

/** 每个 agent 最新的活动状态 */
export function listActivity(db: ReadonlyDatabase): ActivityEventPayload[] {
  return db.all<{ agent_id: string; state: ActivityState; since: string }>("SELECT agent_id, state, since FROM agent_activity ORDER BY agent_id").map((r) => ({ agentId: r.agent_id, state: r.state, since: r.since }));
}

export interface ActivityLog {
  /** 记一次活动状态的变化（和最新的一样就不记） */
  record(agentId: string, state: ActivityState): void;
  /** 守护进程启动时：上次没记成休眠的一律改记休眠 */
  settle(): void;
}

export function createActivityLog(options: { store: EventStore; now: () => string }): ActivityLog {
  const { store, now } = options;
  const current = (agentId: string) => store.reader.get<{ state: ActivityState }>("SELECT state FROM agent_activity WHERE agent_id = ?", agentId)?.state;
  const append = (agentId: string, state: ActivityState) => {
    const payload: ActivityEventPayload = { agentId, state, since: now() };
    store.append({ channel: CHANNELS.activity, type: EVENT_TYPES.activity, payload });
  };
  return {
    record(agentId, state) {
      if (current(agentId) !== state) append(agentId, state);
    },
    settle() {
      for (const a of listActivity(store.reader)) if (a.state !== "sleeping") append(a.agentId, "sleeping");
    },
  };
}
