// 首次设置向导（319 号票）的请求体，用 TypeBox 定义：POST /api/setup 的 { step, skip }。
// 形状（给前端看的类型、五步的名字）在 setup.ts——那边不引用 TypeBox，网页打包时不会把 schema 带进去。
// 这一份只用来在网关查请求体：step 不是五步之一、多了字段都回 400，不悄悄当成某一步。
import { type Static, Type } from "typebox";
import { SETUP_STEPS } from "./setup.ts";

/** POST /api/setup 的请求体；字段的意思和 setup.ts 的 SetupMarkBody 一样 */
export const SetupMarkBodySchema = Type.Object(
  {
    step: Type.Union(SETUP_STEPS.map((id) => Type.Literal(id))),
    /** 不给或 false 是"看过了/做完了"；true 是"以后再说" */
    skip: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SetupMarkBodySchema = Static<typeof SetupMarkBodySchema>;
