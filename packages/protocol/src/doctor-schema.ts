// 体检后台盯着（416）：POST /api/doctor/unmute 的请求体（体检页上"恢复提醒"）。形状在 doctor.ts（不引用 TypeBox）。
import { type Static, Type } from "typebox";

/** 块、项的名字最长多少字（插件名、检查项 id 都很短） */
const KEY_MAX = 200;

export const DoctorUnmuteBody = Type.Object({ group: Type.String({ minLength: 1, maxLength: KEY_MAX }), id: Type.String({ minLength: 1, maxLength: KEY_MAX }) }, { additionalProperties: false });
export type DoctorUnmuteBody = Static<typeof DoctorUnmuteBody>;
