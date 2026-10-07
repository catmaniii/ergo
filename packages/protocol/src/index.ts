// 二狗共享协议：守护进程和前端共用的帧、频道、事件、消息信封与 part、卡片（规格第 5 节）。
// - constants.ts：名字（频道、事件类型、方法、错误码……），不引用 TypeBox；
// - schema.ts：TypeBox 定义的 schema 和由它生成的类型；
// - request.ts：守护进程解析、校验收到的请求帧，判断频道名；
// - time.ts：协议里的时间格式（nowIso），守护进程和 Web 共用；
// - validate.ts：按 schema 校验一个值（守护进程校验卡片负载、动作输入、工具参数用）；
// - reminder-schedule.ts：简单提醒的时间规则（schema 和全部按规则种类分支的逻辑），守护进程和 Web 共用；
// - inbox.ts：待我处理事项算不算处理过（守护进程、Web 状态层、原型的假连接共用）；
// - http.ts / http-schema.ts：走 HTTP 的部分（媒体上传下载、历史分页；10 号票起还有设备配对）的路径、常量和请求响应体；
// - parts.ts：拼附件 part 的小工具；
// - deleted-event.ts：认彻底删除改写后的事件（"已删除"标记）；
// - pairing.ts：设备配对和外网端口的常量、默认设备名（守护进程和 Web 共用）。
//
// 包的 package.json 声明了 sideEffects: false：Web 只用常量和类型，打包时 schema 和 TypeBox 会被摇掉。
//
// 注意：守护进程和 agent 子进程之间的"agent 宿主协议"不在这里，
// 它属于守护进程的运行时封装层（packages/daemon/src/runtime/host-protocol.ts）。
export * from "./constants.ts";
export * from "./schema.ts";
export * from "./request.ts";
export * from "./time.ts";
export * from "./validate.ts";
export * from "./reminder-schedule.ts";
export * from "./inbox.ts";
export * from "./http.ts";
export * from "./http-schema.ts";
export * from "./parts.ts";
export * from "./deleted-event.ts";
export * from "./pairing.ts";
