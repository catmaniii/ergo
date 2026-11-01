// skill 变更的工具名（358 号票）。单独放一个文件：系统提示要引用它，不必拉进工具的依赖（照 mcp/tool-names.ts 的做法）。

/** 负责人把一个 skill 加进 skill 库、改、删（出一张"skill 变更"卡，用户确认之后由运行时写 skill 区）的工具 */
export const REQUEST_SKILL_CHANGE_TOOL = "request_skill_change";
