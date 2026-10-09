// 个人助理的名字（43 号票）：名字事件、配置文件、设置接口的 schema。起名的规则和名字占位在 assistant-name.ts（不引用 TypeBox）。
//
// 照工作日历的个人设置（29 号票）存和推：数据目录配置区的 assistant-name.json 是真相，只由运行时写（设置接口）；
// 每次改动是名字频道上的一条 assistant_name 事件，开着的前端据此跟着变；启动时文件和上一条事件不一样就以文件为准补一条。
import { type Static, Type } from "typebox";

/** 名字改动的来源：设置页，以及启动时发现配置文件和上一条事件不一样（停着时手改过、从备份恢复了配置区） */
export const ASSISTANT_NAME_SOURCES = ["settings", "config_file"] as const;
export type AssistantNameSource = (typeof ASSISTANT_NAME_SOURCES)[number];

/** 名字频道上的 assistant_name 事件：名字的最新样子，和这次是从哪来的 */
export const AssistantNameEventPayload = Type.Object({
  name: Type.String({ minLength: 1 }),
  source: Type.Enum(ASSISTANT_NAME_SOURCES),
});
export type AssistantNameEventPayload = Static<typeof AssistantNameEventPayload>;

/** 名字在数据目录配置区里的文件（config/assistant-name.json） */
export const AssistantNameFile = Type.Object({ format: Type.Literal(1), name: Type.String() });
export type AssistantNameFile = Static<typeof AssistantNameFile>;

/** 改名（POST /api/assistant-name）：名字按 checkAssistantName 的规则查，"恢复默认"就是改回默认的名字 */
export const AssistantNameBody = Type.Object({ name: Type.String() });
export type AssistantNameBody = Static<typeof AssistantNameBody>;

/** 改名的结果：存下的名字（去掉了首尾空白），有没有变化（没变化不推事件） */
export const AssistantNameResult = Type.Object({ name: Type.String(), changed: Type.Boolean() });
export type AssistantNameResult = Static<typeof AssistantNameResult>;
