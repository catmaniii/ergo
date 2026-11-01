// 项目的服务报事件（ADR-0043）：POST /api/service-events 的请求体。形状、说法在 project-services.ts（不引用 TypeBox）。
// 事件名由服务自己定，要和运营方案里写的一字不差；数据是任意 JSON，大小上限在守护进程（event-sources/thresholds.ts）。
import { type Static, Type } from "typebox";
import { SERVICE_EVENT_NAME_MAX } from "./event-sources.ts";

export const ServiceEventBody = Type.Object({ event: Type.String({ minLength: 1, maxLength: SERVICE_EVENT_NAME_MAX }), data: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export type ServiceEventBody = Static<typeof ServiceEventBody>;
