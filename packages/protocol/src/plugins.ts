// 插件的状况（193 号票，ADR-0027 的网页插槽）：守护进程把插件清单里每个插件现在怎样告诉网页，网页按它装、停自己的网页插件
// （packages/web/src/plugins/）——停用的插件，它的页面、入口、设置分节都不出现，对话和看板里它的条目显示成占位。
// 插件频道（CHANNELS.plugins）上的临时事件 plugin_status：订阅时补推一条，运行中停用、启用、移除（211 号票）、换了语言再推一条。
// 211 号票：设置 · 插件——列出清单里的插件（GET /api/plugins，PluginsView），运行中停用、启用、移除（POST /api/plugins/<插件名>，
// 请求体见 plugins-schema.ts），移除时可以连它的数据一起彻底删除（插件频道上留一条落盘的删除记录 plugin_data_purged）。
// 不引用 TypeBox。

/**
 * 一个插件现在的状况：running 在运行；disabled 停用了（配置 plugins.disabled 里的，或者运行中停用的，连同跟着一起停的）；
 * removed 移除了（211 号票：配置 plugins.removed 里的，设置里收进"已移除"那一组，能装回）；
 * skipped 启用着却没装上（缺依赖、循环依赖、装配或启动出错，它要的插件停用了）
 */
export const PLUGIN_STATES = ["running", "disabled", "skipped", "removed"] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

/** 清单里的一个插件 */
export interface PluginStatusView {
  /** 插件名（配置 plugins.disabled 里写的就是它）：网页插件按它对上 */
  name: string;
  /** 给人看的名字（"提醒"、"记忆"），守护进程按当前语言写 */
  title: string;
  state: PluginState;
  /** 没装上的原因（skipped 才有；写给开发者看的，守护进程的启动日志里同一句） */
  reason?: string;
}

/** 插件频道上的临时事件 plugin_status 的负载：清单里的全部插件，按清单的先后 */
export interface PluginStatusEventPayload {
  plugins: PluginStatusView[];
}

/** 设置 · 插件里的一个插件（211 号票）：给人看的字都按守护进程当前的语言写好 */
export interface PluginInfo {
  name: string;
  title: string;
  /** 一句话说它是做什么的 */
  summary: string;
  state: PluginState;
  /** 没装上的原因（给人看的说法；skipped 才有） */
  problem?: string;
  /**
   * 没装上是因为它要的外部组件没装（315 号票：Claude Code 的 Agent SDK 不随二狗分发）：problem 写着没装什么、怎么装，
   * 网页上状况写"没装"；装好之前启用不了（cannotEnable 也是这一句）
   */
  missing?: true;
  /** 它带来了什么（守护进程这一半）：给二狗的工具、卡片、定时作业（给人看的名字）。网页上的页面、栏目由网页插件自己写 */
  brings: PluginBrings;
  /** 它要的插件（插件名，按清单的先后） */
  needs: string[];
  /** 要它的插件（插件名，按清单的先后） */
  neededBy: string[];
  /** 停用（或移除）它时一起停用的：现在在运行、要用它的插件（插件名，依赖方先停） */
  stopsWith: string[];
  /** 启用（或装回）它时一起启用的：它要的、现在没开的插件（插件名，先装的在前） */
  startsWith: string[];
  /** 它在启用不了时（要的东西没有谁提供、循环依赖）：给人看的原因；能启用是 undefined */
  cannotEnable?: string;
  /** 移除时"连它的数据一起彻底删除"删哪些、删不掉哪些（给人看的）；插件没写明的没有这个勾选 */
  removal?: { deletes: string[]; keeps: string[] };
}

/** 它带来了什么（守护进程这一半） */
export interface PluginBrings {
  tools: string[];
  cards: string[];
  jobs: string[];
}

/** GET /api/plugins：清单里的全部插件，按清单的先后 */
export interface PluginsView {
  plugins: PluginInfo[];
}

/** 对一个插件做的事：停用、启用（移除了的就是"装回"）、移除 */
export const PLUGIN_ACTIONS = ["disable", "enable", "remove"] as const;
export type PluginAction = (typeof PLUGIN_ACTIONS)[number];

/** 连数据一起彻底删除时删了几条 */
export interface PluginPurgeCounts {
  /** 它拥有的事件（整条换成"已删除"标记，或者只改它认的字段） */
  events: number;
  /** 卡片（张数，每张的每个版本都换了） */
  cards: number;
  /** 待我处理里删掉的事项 */
  inboxItems: number;
  /** 它自己的文件或目录 */
  files: number;
}

/** POST /api/plugins/<插件名> 的结果：这次状况变了的插件（按先后），连数据删了的条数，之后的清单 */
export interface PluginActionResult {
  changed: string[];
  purged?: PluginPurgeCounts;
  plugins: PluginInfo[];
}

/**
 * 插件频道上的落盘事件 plugin_data_purged（211 号票）：移除插件时连它的数据一起彻底删除的记录。只写插件名、什么时候、删了几条，
 * 外加它拥有的事件类型和卡片类型（结构，不带内容）：开着的网页据此拿掉手里那时之前的这些卡片和提醒
 */
export interface PluginDataPurgedEventPayload {
  plugin: string;
  /** 什么时候删的（协议时间，带时区偏移） */
  at: string;
  eventTypes: string[];
  cardTypes: string[];
  counts: PluginPurgeCounts;
}
