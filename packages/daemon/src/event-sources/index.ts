// 事件来源（77 号票，ADR 0025）：对外的唯一入口，别处只从这里取东西。
// 登记表（来源、事件、字段、过滤条件）在共享协议包 event-sources.ts；这里是守护进程这边——
// - triggers.ts：事件触发的分发（谁在等事件、事件来了交给触发底座或简单提醒、建的时候查事件触发方式对不对）；
// - ergou.ts：二狗内部事件（任务完成、失败、转等我，项目状态变化，一次运行失败）；
// - folder.ts：本机文件夹变化（fs.watch、合成一次、比对底子、开机补发、不许监视的地方）；
// - sources.ts：登记表里各来源的实现按编号列全（daemon.ts 只给一份依赖）；thresholds.ts：阈值（配置 eventSources）；
// - types.ts：来源的实现要守的形状；texts.ts：说法。
// 以后接邮件、webhook：登记表里加一项，这里加一个实现文件、sources.ts 里加一行。
export { createErgouSource } from "./ergou.ts";
export { createFolderSource, type ForbiddenArea } from "./folder.ts";
export { type EventSourceDeps, eventSourceImplementations } from "./sources.ts";
export { DATA_DIR_TITLE } from "./texts.ts";
export { DEFAULT_EVENT_SOURCE_THRESHOLDS, type EventSourceThresholds } from "./thresholds.ts";
export { createEventTriggers, deliverKey, type EventTriggers } from "./triggers.ts";
export type { EventSourceContext, EventSourceImpl, EventSubscription, SourceEvent } from "./types.ts";
