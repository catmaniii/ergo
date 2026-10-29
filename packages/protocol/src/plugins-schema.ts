// 设置 · 插件（211 号票）：POST /api/plugins/<插件名> 的请求体。名字和别的形状在 plugins.ts（不引用 TypeBox）。
// 停用、启用（移除了的就是装回）、移除；移除时 purgeData 为真是"连它的数据一起彻底删除"（默认不删）。
// 带幂等键：连数据删的那一下同一个键重发只删一次、只记一条删除记录（停用、启用本来就是按状况来的，重发不会做两次）。
import { type Static, Type } from "typebox";
import { PLUGIN_ACTIONS } from "./plugins.ts";

export const PluginActionBody = Type.Object(
  {
    action: Type.Enum(PLUGIN_ACTIONS),
    purgeData: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type PluginActionBody = Static<typeof PluginActionBody>;
