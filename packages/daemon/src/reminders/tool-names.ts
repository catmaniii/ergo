// 秘书建、改、取消、归档简单提醒的四个工具的名字（工具定义在 tools.ts；71 号票起系统提示里写成占位符 {{create_reminder}} 这样的；
// 185 号票加了归档）。删除不是工具，是快速动作 delete_reminder（delete-action.ts，总要用户在卡上确认），占位符 {{delete_reminder}}
export const REMINDER_TOOL = { create: "create_reminder", update: "update_reminder", cancel: "cancel_reminder", archive: "archive_reminder" } as const;

/** 删除简单提醒的快速动作（185 号票）：秘书用 propose_quick_action 提出，type 写它 */
export const DELETE_REMINDER_ACTION = "delete_reminder";
