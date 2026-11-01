// 连接地址（364 号票）：POST /api/connection-addresses 的请求体。形状在 connection-addresses.ts（不引用 TypeBox）。
import { type Static, Type } from "typebox";
import { CONNECTION_ADDRESS_MAX_LENGTH } from "./connection-addresses.ts";

export const ConnectionAddressesBody = Type.Object({ manual: Type.Union([Type.String({ maxLength: CONNECTION_ADDRESS_MAX_LENGTH }), Type.Null()]) }, { additionalProperties: false });
export type ConnectionAddressesBody = Static<typeof ConnectionAddressesBody>;
