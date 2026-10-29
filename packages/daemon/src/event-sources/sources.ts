// 登记表里各来源在守护进程里的实现（77 号票）：按来源编号一处列全，分发（triggers.ts）拿推事件的口子把它们建出来。
// 以后接邮件、webhook：协议包登记表 EVENT_SOURCES 里加一项，这里加一行它的实现（新文件里写），daemon.ts 不用动。
// 登记表里有、这里没有实现的来源，建任务、建提醒时被拒（"事件来源 X 还没接上"）。
import { ERGO_EVENT_SOURCE, EVENT_SOURCES, FOLDER_EVENT_SOURCE } from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { createErgoSource } from "./ergo.ts";
import { createFolderSource, type ForbiddenArea } from "./folder.ts";
import type { EventSourceThresholds } from "./thresholds.ts";
import type { EventSourceContext, EventSourceImpl } from "./types.ts";

/** 各来源的实现要的东西（一份给全部，各取所需） */
export interface EventSourceDeps {
  store: EventStore;
  clock: Clock;
  /** 来源自己的状态放哪（数据目录 event-sources/；文件夹的比对底子在 folders/ 下） */
  stateDir: string;
  /** 不能监视的地方（真实路径；先列具体的，最后是整个数据目录） */
  forbidden: () => readonly ForbiddenArea[];
  thresholds: EventSourceThresholds;
}

type Implementation = (deps: EventSourceDeps, ctx: EventSourceContext) => EventSourceImpl;

/** 来源编号 → 它的实现 */
const IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  [ERGO_EVENT_SOURCE]: (deps, ctx) => createErgoSource({ store: deps.store, ctx }),
  [FOLDER_EVENT_SOURCE]: (deps, ctx) =>
    createFolderSource({ ctx, clock: deps.clock, stateDir: deps.stateDir, forbidden: deps.forbidden, settleMs: deps.thresholds.folderSettleMs, retryMs: deps.thresholds.folderRetryMs }),
};

/** 登记表里每个有实现的来源建一份（交给 createEventTriggers 的 sources） */
export function eventSourceImplementations(deps: EventSourceDeps): (ctx: EventSourceContext) => EventSourceImpl[] {
  return (ctx) => EVENT_SOURCES.flatMap((s) => {
    const make = IMPLEMENTATIONS[s.id];
    return make ? [make(deps, ctx)] : [];
  });
}
