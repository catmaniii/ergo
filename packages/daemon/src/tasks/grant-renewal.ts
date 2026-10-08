// 授权项的有效期和续期（规格第 9 节"授权项"、第 8 节"长时间不在"，14 号票）：
// - 每项授权（守卫的 id，阶段组的写成"授权项 id@阶段 id"）的授予时间、到期时间记在那一版确认的计划上（StoredPlan.grantTimes）；
//   13 号票确认的计划没记，按确认时刻和各自的有效期（默认 7 天）算（grantTimesOfPlan）；
// - 到期前 renewalLeadMs（默认一天）待我处理里放一条续期事项（不卡任务，动作：续期 / 不续）；同一项授权、同一个到期时间只放一次。
//   挂在调度器上（键 grant-renewal:<任务 id>，按可注入时钟走），守护进程重启后错过的到点马上放；
// - 用户续期：有效期从原来的到期时间（过了就从现在）再延一期（和计划变更后放宽的授权项同一个算法：plan-change.ts 的
//   extendedExpiry），记成 tasks 频道的 grant_renewal_decided（带续期后这一版的全部有效期）；不续的到期后不再生效
//   （守卫判定时看到期时间，判超出授权，执行到那一步再问用户）。
// 任务结束了、计划换了一版之后由执行控制器叫 arm 重新看一眼。
import { ENDED_TASK_STATES, GRANT_RENEWAL_ACTIONS, type InboxItem, nowIso, type Plan, planGrants } from "@ergou/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { oneLine } from "../util/text.ts";
import { type GrantRenewalDecidedPayload, type GrantTimes, TASK_EVENTS, TASKS_CHANNEL } from "./events.ts";
import { extendedExpiry, initialGrantTimes } from "./plan-change.ts";
import { type GrantTime, planGrantIdOf } from "./plan.ts";
import type { TaskService } from "./tasks.ts";
import type { StoredPlan } from "./views.ts";

/** 确认这一版计划的时刻（毫秒）；没记的按现在 */
export const confirmedAtOf = (stored: StoredPlan, now: number): number => (stored.decidedAt ? Date.parse(stored.decidedAt) : now);

/** 确认过的一版计划里每项授权（守卫的 id）的授予时间、到期时间 */
export const grantTimesOfPlan = (stored: StoredPlan, now: number): Record<string, GrantTime> => stored.grantTimes ?? initialGrantTimes(stored.plan, confirmedAtOf(stored, now));

/** 授权项的授予时间、到期时间写成事件里的样子 */
export const isoTimes = (times: Readonly<Record<string, GrantTime>>): GrantTimes =>
  Object.fromEntries(Object.entries(times).map(([id, t]) => [id, { grantedAt: nowIso(new Date(t.grantedAt)), expiresAt: nowIso(new Date(t.expiresAt)) }]));

/** 授权项（守卫的 id）给用户看的一句话："建 s1 目录"、"推送（阶段 s2）" */
const grantTitle = (plan: Plan, guardId: string): string => {
  const id = planGrantIdOf(guardId);
  const stageId = guardId.includes("@") ? guardId.slice(id.length + 1) : undefined;
  const grant = planGrants(plan).find((g) => g.grant.id === id)?.grant;
  return `${grant?.title ?? id}${stageId ? `（阶段 ${stageId}）` : ""}`;
};

const renewalKey = (taskId: string) => `grant-renewal:${taskId}`;

/** 续期事项的 data */
interface RenewalData {
  taskId: string;
  planId: string;
  expiresAt: string;
  grants: { grantId: string; title: string; expiresAt: string }[];
}

export interface GrantRenewalOptions {
  store: EventStore;
  tasks: TaskService;
  inbox: InboxService;
  clock: Clock;
  scheduler: Scheduler;
  /** 到期前多久放续期事项（阈值的 renewalLeadMs） */
  leadMs: number;
}

export interface GrantRenewals {
  /** 接上续期事项上的动作，给每个任务看一眼（错过的到点马上放） */
  start(): void;
  stop(): void;
  /** 这个任务的授权项还有没到期、没放过续期事项的：到期前 leadMs 看一眼；任务结束了就不再看 */
  arm(taskId: string): void;
}

export function createGrantRenewals(options: GrantRenewalOptions): GrantRenewals {
  const { store, tasks, inbox, clock, scheduler, leadMs } = options;
  const unsubscribes: Array<() => void> = [];

  /** 还在执行的任务现在生效的计划（结束了的没有） */
  const livePlan = (taskId: string) => {
    const task = tasks.get(taskId);
    const stored = task && !ENDED_TASK_STATES.includes(task.state) ? tasks.confirmedPlan(taskId) : undefined;
    return task && stored ? { task, stored } : undefined;
  };

  /** 这个任务放过续期事项的授权项（守卫的 id 和当时的到期时间） */
  const noticed = (taskId: string): Set<string> =>
    new Set(
      inbox
        .list()
        .flatMap((i) => (i.kind === "notice" && i.notice === "grant_renewal" ? [i.data as Partial<RenewalData> | undefined] : []))
        .filter((data) => data?.taskId === taskId)
        .flatMap((data) => (data?.grants ?? []).map((g) => `${g.grantId}|${Date.parse(g.expiresAt)}`)),
    );

  /** 还没到期、还没放过续期事项的授权项 */
  const upcoming = (taskId: string, stored: StoredPlan): Array<[string, GrantTime]> => {
    const at = clock.now();
    const seen = noticed(taskId);
    return Object.entries(grantTimesOfPlan(stored, at)).filter(([id, t]) => t.expiresAt > at && !seen.has(`${id}|${t.expiresAt}`));
  };

  const arm = (taskId: string) => {
    const live = livePlan(taskId);
    const due = live ? upcoming(taskId, live.stored) : [];
    if (due.length === 0) return scheduler.cancel(renewalKey(taskId));
    scheduler.schedule(renewalKey(taskId), Math.min(...due.map(([, t]) => t.expiresAt - leadMs)), () => remind(taskId));
  };

  /** 到点了：leadMs 之内到期、还没放过事项的授权项放一条续期事项（不卡任务） */
  const remind = (taskId: string) => {
    const live = livePlan(taskId);
    if (!live) return;
    const { task, stored } = live;
    const at = clock.now();
    const due = upcoming(taskId, stored).filter(([, t]) => t.expiresAt - leadMs <= at);
    if (due.length > 0) {
      const lines = due.map(([id, t]) => `- ${grantTitle(stored.plan, id)}：${new Date(t.expiresAt).toLocaleString("zh-CN", { hour12: false })} 到期`);
      const data: RenewalData = {
        taskId,
        planId: stored.planId,
        expiresAt: nowIso(new Date(Math.min(...due.map(([, t]) => t.expiresAt)))),
        grants: due.map(([grantId, t]) => ({ grantId, title: grantTitle(stored.plan, grantId), expiresAt: nowIso(new Date(t.expiresAt)) })),
      };
      const item = inbox.add({
        kind: "notice",
        notice: "grant_renewal",
        title: oneLine(`授权快到期：${task.title}`, 60),
        body: [`任务「${task.title}」有 ${due.length} 项授权快到期了：`, ...lines, "续期后有效期再延一期；不续的话到期后执行到那一步会再问你。"].join("\n"),
        source: `任务「${task.title}」`,
        urgency: "non_blocking",
        actions: [GRANT_RENEWAL_ACTIONS.renew, GRANT_RENEWAL_ACTIONS.skip],
        data: { ...data },
      });
      inbox.alert(item);
    }
    arm(taskId);
  };

  /** 用户在续期事项上选了续期或不续 */
  const decide = (item: InboxItem, renew: boolean) => {
    const data = (item.kind === "notice" ? item.data : undefined) as Partial<RenewalData> | undefined;
    const live = typeof data?.taskId === "string" ? livePlan(data.taskId) : undefined;
    if (!live) return;
    const { task, stored } = live;
    const at = clock.now();
    const times = grantTimesOfPlan(stored, at);
    const grants = (data?.grants ?? []).flatMap((g) => {
      const t = times[g.grantId];
      if (!t) return [];
      return [{ grantId: g.grantId, title: g.title, before: nowIso(new Date(t.expiresAt)), ...(renew ? { after: nowIso(new Date(extendedExpiry(stored.plan, g.grantId, Math.max(at, t.expiresAt)))) } : {}) }];
    });
    if (grants.length === 0) return;
    // 续期后这一版计划里全部授权项的有效期（13 号票确认的计划没单独记过，按确认时刻算出来一起记下）
    const after = renew ? { ...times, ...Object.fromEntries(grants.map((g) => [g.grantId, { ...times[g.grantId]!, expiresAt: Date.parse(g.after!) }])) } : undefined;
    const payload: GrantRenewalDecidedPayload = {
      taskId: task.id,
      taskTitle: task.title,
      planId: stored.planId,
      itemId: item.id,
      decision: renew ? "renewed" : "declined",
      grants,
      ...(after ? { grantTimes: isoTimes(after) } : {}),
      by: "user",
      time: nowIso(new Date(at)),
    };
    store.append({ channel: TASKS_CHANNEL, type: TASK_EVENTS.grantRenewalDecided, payload });
    arm(task.id);
  };

  return {
    start() {
      unsubscribes.push(
        inbox.onNoticeHandled("grant_renewal", GRANT_RENEWAL_ACTIONS.renew, (item) => decide(item, true)),
        inbox.onNoticeHandled("grant_renewal", GRANT_RENEWAL_ACTIONS.skip, (item) => decide(item, false)),
      );
      for (const task of tasks.list()) arm(task.id);
    },
    stop() {
      for (const off of unsubscribes.splice(0)) off();
      for (const task of tasks.list()) scheduler.cancel(renewalKey(task.id));
    },
    arm,
  };
}
