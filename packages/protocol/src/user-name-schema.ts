// 我的名字（249 号票）：用户自己的名字，配置文件、设置接口的 schema。起名的规矩在 user-name.ts（不引用 TypeBox）。
//
// 照个人助理的名字（assistant-name-schema.ts）存，但**不走事件**：GET /api/user-name 现取，PUT 现写。
// 数据目录配置区的 user-name.json 是真相，只由运行时写（设置接口）；没有这个文件就是没设（行为同现在）。
import { type Static, Type } from "typebox";

/** 名字在数据目录配置区里的文件（config/user-name.json）；没有这个文件 = 没设 */
export const UserNameFile = Type.Object({ format: Type.Literal(1), name: Type.String() });
export type UserNameFile = Static<typeof UserNameFile>;

/** GET /api/user-name：现在的名字；没设（文件不在、读坏了只当没设）时没有 name */
export const UserNameView = Type.Object({ name: Type.Optional(Type.String()) });
export type UserNameView = Static<typeof UserNameView>;

/** 改名字（PUT /api/user-name）：名字按 checkUserName 的规则查；null 或者空串 = 清除 */
export const UserNameBody = Type.Object({ name: Type.Union([Type.String(), Type.Null()]) });
export type UserNameBody = Static<typeof UserNameBody>;

/** 改名字的结果：存下的名字（清除了就没有 name），有没有变化（没变化不写文件） */
export const UserNameResult = Type.Object({ name: Type.Optional(Type.String()), changed: Type.Boolean() });
export type UserNameResult = Static<typeof UserNameResult>;
