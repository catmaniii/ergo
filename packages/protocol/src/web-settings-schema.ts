// 设置里 agent 的联网搜索、读网页（154 号票起，162 号票改成队列，182 号票起四种方式）：设置文件和设置接口的 schema。名字和纯函数在
// web-settings.ts（不引用 TypeBox）。
// 数据目录配置区的 web-settings.json 是真相，只由运行时写（设置接口）；没有这个文件时按默认（DeepSeek → 浏览器 → agent-browser →
// 鸿蒙 App 的内置浏览器，都启用）。162 号票起文件是 format 2（队列）；154 号票的 format 1（默认的搜索方式、读网页用不用 DeepSeek）
// 照样认，读成队列（migrateWebSettingsV1），存一次就写成 format 2。设置接口是整份替换（幂等），不带幂等键；多出来的字段一律拒绝。
// 四种各一项、至少留一个启用的另外查（webSettingsProblem）。
// 182 号票：文件里的队列读得宽一些——方式不限于认得的、项数不限于四项（162 号票存的是三项），读完由 normalizeWebQueue 整理（认不得的跳过、
// 缺的加在最后）；请求体照旧严格（四种各一项）。
import { type Static, Type } from "typebox";
import { WEB_METHODS } from "./web-settings.ts";

/** 队列里的一项 */
const WebMethodEntry = Type.Object({ method: Type.Enum(WEB_METHODS), enabled: Type.Boolean() }, { additionalProperties: false });
const WebQueue = Type.Array(WebMethodEntry, { minItems: WEB_METHODS.length, maxItems: WEB_METHODS.length });

/** 设置的内容（POST /api/web-settings 的请求体，整份存） */
export const WebSettingsBody = Type.Object({ queue: WebQueue }, { additionalProperties: false });
export type WebSettingsBody = Static<typeof WebSettingsBody>;

/** 文件里的一项（方式不限于认得的：读完整理时跳过） */
const WebFileEntry = Type.Object({ method: Type.String({ minLength: 1, maxLength: 64 }), enabled: Type.Boolean() }, { additionalProperties: false });

/** 设置在数据目录配置区里的文件（config/web-settings.json）：多一个格式版本；队列读完按 normalizeWebQueue 整理 */
export const WebSettingsFile = Type.Object({ format: Type.Literal(2), queue: Type.Array(WebFileEntry, { minItems: 1, maxItems: 32 }) }, { additionalProperties: false });
export type WebSettingsFile = Static<typeof WebSettingsFile>;

/** 154 号票的设置文件（format 1）：读到时按 migrateWebSettingsV1 换成队列 */
export const WebSettingsFileV1 = Type.Object(
  { format: Type.Literal(1), search: Type.Enum(["deepseek", "browser"] as const), deepseekFetch: Type.Boolean() },
  { additionalProperties: false },
);
export type WebSettingsFileV1 = Static<typeof WebSettingsFileV1>;
