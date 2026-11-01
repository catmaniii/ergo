// 服务管家的开机自启：PUT /api/autostart 的请求体。形状在 autostart.ts（不引用 TypeBox）。
import { type Static, Type } from "typebox";

export const AutostartBody = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export type AutostartBody = Static<typeof AutostartBody>;
