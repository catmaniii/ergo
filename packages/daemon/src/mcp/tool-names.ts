// MCP 登记变更、带参调用的工具名（239、240 号票）。单独放一个文件：系统提示要引用它，不必拉进工具的依赖（照工具包 tool-names.ts 的做法）。

/** 维护者把一条 MCP 登记加、改、删（出一张"MCP 登记变更"卡，用户确认之后由运行时写配置区）的工具 */
export const REQUEST_MCP_CHANGE_TOOL = "request_mcp_change";

/**
 * 秘书带参调一个登记过的 MCP 工具（240 号票）：MCP 和工具都要登记过，参数由模型给，调到的结果直接交回秘书。
 * 名字和快速动作那条路的类型一样（quick-action.ts 的 MCP_QUICK_ACTION = "mcp_call"）：那是另一个命名空间——快速动作的伪工具
 * 叫 quick_action:mcp_call，参数按登记固定；这里是一个真的工具调用，参数自由传。用户 2026-10-21 定"工具就叫 mcp_call"，
 * 快速动作那边没改名（改了会让已有的关注类别设置 match.tools、时间线里的旧说法对不上）。
 */
export const MCP_CALL_TOOL = "mcp_call";
