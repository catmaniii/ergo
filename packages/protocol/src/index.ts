// 二狗共享协议：守护进程和前端共用的帧、频道、事件、消息信封与 part、卡片（规格第 5 节）。
// - constants.ts：名字（频道、事件类型、方法、错误码……），不引用 TypeBox；
// - schema.ts：TypeBox 定义的 schema 和由它生成的类型；
// - message-scope.ts：消息归属（任务、项目、阶段、agent）的取值，不引用 TypeBox（25 号票）；
// - request.ts：守护进程解析、校验收到的请求帧，判断频道名；
// - time.ts：协议里的时间格式（nowIso），守护进程和 Web 共用；
// - validate.ts：按 schema 校验一个值（守护进程校验卡片负载、动作输入、工具参数用）；
// - reminder-schedule.ts：简单提醒的时间规则（schema 和全部按规则种类分支的逻辑），守护进程和 Web 共用；
// - workday-calendar.ts：个人工作日历（节假日数据、额外规则和手动标记 → 某天上班或休息及原因），守护进程和 Web 共用；
// - local-date.ts：本地日期和星期的小工具（YYYY-MM-DD、周几的中文名），时间规则和工作日历共用；
// - inbox.ts：待我处理事项算不算处理过、事项的先后（守护进程、Web 状态层、原型的假连接共用）；
// - http.ts / http-schema.ts：走 HTTP 的部分（媒体上传下载、历史分页；10 号票起还有设备配对）的路径、常量和请求响应体；
// - parts.ts：拼附件 part 的小工具；
// - deleted-event.ts：认彻底删除改写后的事件（"已删除"标记）；
// - pairing.ts：设备配对和外网端口的常量、默认设备名（守护进程和 Web 共用）；
// - project-internal.ts：项目内部的标记怎么判断、怎么标注（64 号票：任务、待我处理事项、定时作业、建议卡共用一个 internal）；
// - tasks.ts / task-schema.ts / plan.ts：任务、计划、看板分组的名字（不引用 TypeBox）、schema、
//   计划的纯函数（授权项列表、卡上生成的文字、停点）（12 号票）；
// - task-transitions.ts："谁能改"表和"现在能对任务做什么"（13 号票起守护进程和 Web 共用）；
// - activity.ts：agent 的活动状态（12 号票；25 号票加了结构化的说明、说明的文字表和临时的进度事件）；
// - timeline.ts：时间线上的记录（偏离、范围变更、越界）的 schema 和种类表（中文名、是否要点、严重度）（25 号票）；
// - watch-categories.ts / watch-category-schema.ts：关注类别设置的名字和纯函数（不引用 TypeBox）、schema（26 号票）。
// - projects.ts / project-schema.ts：项目、立项书、项目页上的动作的名字（不引用 TypeBox）和 schema（15 号票）。
// - usage.ts / usage-schema.ts：token 账本的名字和纯函数（合计、粗估成本，不引用 TypeBox）、看板上的合计和消耗页的 schema（24 号票）。
// - parallel-schema.ts：子 agent 并行的并行确认卡（20 号票）。
// - voice.ts / voice-schema.ts：语音消息的限制、识别状态和纯函数（不引用 TypeBox）、语音对象的 schema（31 号票）；
//   agent 发的语音（语音回复）和参考音色（32 号票）。
// - work-orders.ts / work-order-schema.ts：工单和维护者会话分段的名字（不引用 TypeBox）和 schema（16 号票）。
// - scope-records.ts / scope-record-schema.ts：范围记录（范围变更、越界）的名字（不引用 TypeBox）和 schema（18 号票）。
// - toolkit.ts / toolkit-schema.ts：工具包改动的说法和纯函数（不引用 TypeBox）、skill 库和 MCP 登记、改工具包、"工具包变更"卡的 schema（27 号票）。
// - scheduled-jobs.ts / scheduled-job-schema.ts：定时作业和归档清单的名字、纯函数（不引用 TypeBox）和 schema（19 号票）。
// - calendar.ts / calendar-schema.ts：日历（按月看的每一天：工作日判定、当天的提醒和定时作业）的名字、纯函数（不引用 TypeBox）
//   和 schema（35 号票）。
// - assistant-name.ts / assistant-name-schema.ts：个人助理的名字（起名的规则、守护进程生成的话里的名字占位，不引用 TypeBox）
//   和名字事件、配置文件、设置接口的 schema（43 号票）。
// - workflow.ts / workflow-schema.ts：流程（两种任务之一，照搬 AgentSense 的固定计划）的名字、纯函数（不引用 TypeBox）
//   和 schema：步骤、条件、审查结果、流程计划卡（58 号票）。
// - system-prompts.ts / system-prompt-schema.ts：各 agent 的系统提示（md 文件）里占位符的写法、检查和填值（不引用 TypeBox），
//   设置里"系统提示"页的接口的 schema（71 号票）。
//
// 包的 package.json 声明了 sideEffects: false：Web 只用常量和类型，打包时 schema 和 TypeBox 会被摇掉。
//
// 注意：守护进程和 agent 子进程之间的"agent 宿主协议"不在这里，
// 它属于守护进程的运行时封装层（packages/daemon/src/runtime/host-protocol.ts）。
export * from "./constants.ts";
export * from "./schema.ts";
export * from "./message-scope.ts";
export * from "./request.ts";
export * from "./time.ts";
export * from "./validate.ts";
export * from "./reminder-schedule.ts";
export * from "./workday-calendar.ts";
export * from "./local-date.ts";
export * from "./inbox.ts";
export * from "./http.ts";
export * from "./http-schema.ts";
export * from "./parts.ts";
export * from "./deleted-event.ts";
export * from "./pairing.ts";
export * from "./tasks.ts";
export * from "./project-internal.ts";
export * from "./task-schema.ts";
export * from "./plan.ts";
export * from "./task-transitions.ts";
export * from "./activity.ts";
export * from "./timeline.ts";
export * from "./watch-categories.ts";
export * from "./watch-category-schema.ts";
export * from "./projects.ts";
export * from "./project-schema.ts";
export * from "./usage.ts";
export * from "./usage-schema.ts";
export * from "./parallel-schema.ts";
export * from "./voice.ts";
export * from "./voice-schema.ts";
export * from "./work-orders.ts";
export * from "./work-order-schema.ts";
export * from "./scope-records.ts";
export * from "./scope-record-schema.ts";
export * from "./toolkit.ts";
export * from "./toolkit-schema.ts";
export * from "./scheduled-jobs.ts";
export * from "./scheduled-job-schema.ts";
export * from "./calendar.ts";
export * from "./calendar-schema.ts";
export * from "./assistant-name.ts";
export * from "./assistant-name-schema.ts";
export * from "./workflow.ts";
export * from "./workflow-schema.ts";
export * from "./system-prompts.ts";
export * from "./system-prompt-schema.ts";
