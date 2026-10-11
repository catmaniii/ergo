// 每周的归档清单（规格第 8、13 节，19 号票）：任务模块在调度器上登记的一个内部作业（scheduler/internal-jobs.ts，错过了开机后补一次），
// 把结束（已完成、失败、已取消）超过 archiveAfterDays 天（thresholds.ts，配置 tasks.thresholds.archiveAfterDays）、还没归档的任务
// 汇总成一张归档清单卡（archive_list），放进待我处理（不卡任务）。每一项可选：
// - 归档：任务变为已归档（看板的已归档分组）；
// - 继续改：已完成的走 13 号票的返工（从最后一个阶段重开，也可以指明阶段；"用户对产出的反应"里的"要求返工"照常产生），
//   失败的走重试，任务回到执行中（名额满了回到排队中）；已取消的、转为项目结束的在状态机里回不到执行中，没有这一项；
// - 先留着：任务不变（下周还结束超过这么多天、还没归档的话会再出现）。
// 每一项都选了之后卡片算处理完；新的一周的清单出来时上一张还没处理完的过期。任务的变化走执行控制器（继续改）和任务模块（归档），
// 状态迁移照"谁能改"表校验：建清单之后任务已经变了（在任务详情里返工过、归档过）的那一项做不了，说明原因。说法在 archive-texts.ts。
import { type ArchiveChoice, ArchiveListCardPayload, ArchiveListDecideInput, type ArchiveListItem, availableTaskActions, ENDED_TASK_STATES, nowIso, isProjectInternal, type ReminderSchedule, type Task } from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { listPendingCards } from "../cards/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import { ARCHIVE_LIST_SOURCE, archiveListText, archiveListTitle, archiveRefusal } from "./archive-texts.ts";
import type { TaskExecution } from "./execution.ts";
import type { TaskService } from "./tasks.ts";
import { DAY_MS } from "./thresholds.ts";

/** 归档清单的内部作业：每周一 09:00 */
export const ARCHIVE_LIST_JOB = "archive_list";
export const ARCHIVE_LIST_SCHEDULE: ReminderSchedule = { kind: "weekly", time: "09:00", weekdays: [1] };

export interface ArchiveListOptions {
  store: EventStore;
  tasks: TaskService;
  cards: CardService;
  inbox: InboxService;
  internalJobs: InternalJobs;
  clock: Clock;
  /** 结束超过几天的任务进清单（配置 tasks.thresholds.archiveAfterDays） */
  afterDays: number;
}

export interface ArchiveList {
  /** 登记每周的内部作业（错过了开机后补一次） */
  start(): void;
  /** 现在汇总一次（内部作业到点时做的就是它）：有要归档的任务就出一张归档清单卡，返回卡片 id */
  compile(): string | undefined;
}

/** 这个任务在清单上能选什么：已完成的能返工、失败的能重试才有"继续改" */
function choicesOf(task: Task): ArchiveChoice[] {
  const acts = availableTaskActions(task, "user");
  const canContinue = (task.state === "done" && acts.includes("rework")) || (task.state === "failed" && acts.includes("retry"));
  return canContinue ? ["archive", "continue", "keep"] : ["archive", "keep"];
}

export function createArchiveList(options: ArchiveListOptions): ArchiveList {
  const { store, tasks, cards, inbox, clock } = options;

  const compile = (): string | undefined => {
    const cutoff = clock.now() - options.afterDays * DAY_MS;
    const items: ArchiveListItem[] = tasks
      .list()
      // 项目内部任务不在全局看板上，不进归档清单（64 号票：用户在项目页上归档它们；清单卡的文字秘书看得到）
      .filter((t) => !isProjectInternal(t) && ENDED_TASK_STATES.includes(t.state) && t.state !== "archived" && Date.parse(t.updatedAt) <= cutoff)
      .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((t) => ({ taskId: t.id, title: t.title, state: t.state, ...(t.endKind ? { endKind: t.endKind } : {}), endedAt: t.updatedAt, choices: choicesOf(t) }));
    if (items.length === 0) return undefined;
    const payload: ArchiveListCardPayload = { items, afterDays: options.afterDays, cutoff: nowIso(new Date(cutoff)) };
    // 上一张还没处理完的过期（新的一张里有这周还没归档的）
    const expired = listPendingCards(store.reader, ["archive_list"]).map((c) => cards.buildUpdate(c.id, { status: "expired" }).event);
    const card = cards.buildCreate({ type: "archive_list", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: archiveListTitle(payload), source: ARCHIVE_LIST_SOURCE, urgency: "non_blocking" });
    store.appendBatch([...expired, card.event, item.event]);
    return card.card.id;
  };

  return {
    start() {
      options.internalJobs.register({
        name: ARCHIVE_LIST_JOB,
        schedule: ARCHIVE_LIST_SCHEDULE,
        run: async () => {
          compile();
        },
      });
    },
    compile,
  };
}

/** 归档清单卡（archive_list）：动作 decide 对其中一项做选择；每一项都选了卡片算处理完 */
export function archiveListCardType(deps: { tasks: TaskService; execution: () => Pick<TaskExecution, "prepareAct" | "prepareReworkAct"> }) {
  const { tasks } = deps;
  return defineCardType({
    type: "archive_list",
    version: 1,
    payload: ArchiveListCardPayload,
    actions: {
      decide: {
        input: ArchiveListDecideInput,
        run: ({ payload, input, now, idempotencyKey }) => {
          const item = payload.items.find((i) => i.taskId === input.taskId);
          if (!item) throw new RequestRejected("bad_params", archiveRefusal.notOnList(input.taskId));
          if (item.decision) throw new RequestRejected("conflict", archiveRefusal.decided(item));
          if (!item.choices.includes(input.choice)) throw new RequestRejected("not_allowed", archiveRefusal.notAllowed(item, input.choice));
          const task = tasks.get(item.taskId);
          if (!task) throw new RequestRejected("not_found", archiveRefusal.noTask(item.taskId));
          const events: NewEvent[] = [];
          let afterCommit: (() => void) | undefined;
          const items = payload.items.map((i) => (i.taskId === item.taskId ? { ...i, decision: input.choice, decidedAt: now } : i));
          const done = items.every((i) => i.decision !== undefined);
          const decided = (): CardActionEffect<ArchiveListCardPayload> => ({ status: done ? "handled" : "pending", payload: { ...payload, items }, events, ...(afterCommit ? { afterCommit } : {}) });
          if (input.choice === "archive") {
            if (!ENDED_TASK_STATES.includes(task.state) || task.state === "archived") throw new RequestRejected("not_allowed", archiveRefusal.notArchivable(task));
            events.push(tasks.buildChange(task, { ...task, state: "archived" }, { by: "user", change: "archived" }).event);
          } else if (input.choice === "continue") {
            // 已完成的返工（从指明的阶段重开，不指明是最后一个阶段）、失败的重试：走执行控制器，和任务详情里的同一套
            const lastStage = task.stages?.list?.at(-1)?.stageId;
            const stageId = input.stageId ?? lastStage;
            const note = input.note ? { note: input.note } : {};
            if (task.state === "failed") {
              const prepared = deps.execution().prepareAct({ taskId: task.id, action: "retry", ...note }, `${idempotencyKey}#task`);
              events.push(...prepared.events);
              afterCommit = prepared.afterCommit;
            } else {
              // 返工和"从这里重做"同一条路（84 号票）：先停稳维护者手头这一轮再重置，和卡片更新同一事务落盘，落盘后（或没落盘）放开
              const params = { taskId: task.id, action: "rework" as const, ...(stageId === undefined ? {} : { stageId }), ...note };
              return deps
                .execution()
                .prepareReworkAct(params, `${idempotencyKey}#task`)
                .then((prepared) => {
                  events.push(...prepared.events);
                  afterCommit = () => {
                    try {
                      prepared.afterCommit();
                    } finally {
                      prepared.release();
                    }
                  };
                  return { ...decided(), abandon: prepared.release };
                });
            }
          }
          return decided();
        },
      },
    },
    toText: archiveListText,
  });
}
