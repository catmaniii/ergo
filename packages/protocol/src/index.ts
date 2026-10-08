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
// - tasks.ts / task-schema.ts / plan.ts：任务、计划、看板分组的名字（不引用 TypeBox）、schema、
//   计划的纯函数（授权项列表、卡上生成的文字、停点）（12 号票）；
// - task-transitions.ts："谁能改"表和"现在能对任务做什么"（13 号票起守护进程和 Web 共用）；
// - activity.ts：agent 的活动状态（12 号票；25 号票加了结构化的说明、说明的文字表和临时的进度事件）；
// - timeline.ts：时间线上的记录（偏离、范围变更、越界）的 schema 和种类表（中文名、是否要点、严重度）（25 号票）；
// - watch-categories.ts / watch-category-schema.ts：关注类别设置的名字和纯函数（不引用 TypeBox）、schema（26 号票）。
// - projects.ts / project-schema.ts：项目、立项书、项目页上的动作的名字（不引用 TypeBox）和 schema（15 号票）。
// - usage.ts / usage-schema.ts：token 账本的名字和纯函数（合计、粗估成本，不引用 TypeBox）、看板上的合计和消耗页的 schema（24 号票）。
// - parallel-schema.ts：子 agent 并行的并行确认卡（20 号票）。
// - voice.ts / voice-schema.ts：语音消息的限制、识别状态和纯函数（不引用 TypeBox）、语音对象的 schema（31 号票）。
// - work-orders.ts / work-order-schema.ts：工单和维护者会话分段的名字（不引用 TypeBox）和 schema（16 号票）。
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
