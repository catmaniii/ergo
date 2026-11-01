// 从运行时已有的会话接管、交给官方 App 再收回来：见 takeover.ts。
export { createTakeoverService, followEvents, preludeEvents, type TakeoverService, type TakeoverServiceOptions } from "./takeover.ts";
