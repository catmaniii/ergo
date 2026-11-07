// 设置 · 服务（428）：POST /api/managed-services/<id> 的请求体。形状在 managed-services.ts（不引用 TypeBox）。
// 只有一个操作名：启动、停止、强制停止、重启、取消等空闲再停、开机自启开 / 关。
import { type Static, Type } from "typebox";
import { MANAGED_SERVICE_ACTIONS } from "./managed-services.ts";

export const ManagedServiceActionBody = Type.Object({ action: Type.Enum(MANAGED_SERVICE_ACTIONS) }, { additionalProperties: false });
export type ManagedServiceActionBody = Static<typeof ManagedServiceActionBody>;
