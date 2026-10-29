// 彻底删除改写后的事件（schema.ts 的 DeletedEventPayload）怎么认：守护进程（素材采集，以后的历史分页、重连补发）和 Web 共用这一份判断。
// 不引用 TypeBox。
import type { DeletedEventPayload } from "./schema.ts";

/** 这条事件的负载是不是"已删除"标记 */
export function isDeletedEventPayload(payload: unknown): payload is DeletedEventPayload {
  return typeof payload === "object" && payload !== null && (payload as { deleted?: unknown }).deleted === true;
}
