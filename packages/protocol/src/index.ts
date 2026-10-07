// 二狗共享协议：守护进程和前端共用的帧、频道事件、消息信封与 part、卡片等类型。
// 规格第 5 节定了用 TypeBox 定义 schema，从 04 号票起往这里加；本票只立包。
//
// 注意：守护进程和 agent 子进程之间的"agent 宿主协议"不在这里，
// 它属于守护进程的运行时封装层（packages/daemon/src/runtime/host-protocol.ts）。

/** 前端协议的版本号。守护进程和前端握手时比对，不一致就提示刷新页面（04 号票接上）。 */
export const FRONTEND_PROTOCOL_VERSION = 1;
