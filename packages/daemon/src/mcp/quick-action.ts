// 快速动作"调用 MCP 工具"（规格第 14 节，27 号票）：秘书只能选配置区里登记、标明授权给秘书快速动作（quickAction）的 MCP 工具，
// 参数按登记固定（秘书不能改）。按 21 号票的确认规则：
// - "点明"：用户这一轮的原话里原样有这个快速动作的说法（登记里写的 title），才算点明，直接执行；
// - 推断出来的：动作作为伪工具调用 quick_action:mcp_call 交给守卫的类别匹配，关注照这个 MCP 工具的登记（类别、底线、参数规则）。
// 执行由守护进程转给 MCP 服务进程（mcp.ts 的 call），不拉起任何 agent；聊天里留"已执行"卡，操作记录（quick_action_executed）进事件日志。
// 秘书的工具是固定的，不走工具包：这里只看登记里的授权，不看哪个工具包列了这个 MCP。
import { mcpToolName, t, Type } from "@ergo/protocol";
import { defineQuickAction, foundIn, type NormalizedQuickAction, type QuickActionExecutor, type QuickActionWatch } from "../quick-actions/index.ts";
import type { JsonValue } from "../runtime/index.ts";
import type { McpService } from "./mcp.ts";
import { guardFieldsOf } from "./registration.ts";

export const MCP_QUICK_ACTION = "mcp_call";

const Params = Type.Object(
  {
    tool: Type.String({ minLength: 3, description: "要调用的 MCP 工具：<MCP 名>/<工具名>，只能是授权给秘书快速动作的（见用法里的列表）。参数按登记固定，不用写" }), // @i18n-ignore model：参数说明
  },
  { additionalProperties: false },
);

/** 规范化后的参数 */
interface McpCallParams {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export function mcpQuickAction(mcp: McpService): QuickActionExecutor {
  const authorized = () => mcp.quickActionTools();
  const find = (params: { server: string; tool: string }) => authorized().find((tool) => tool.server === params.server && tool.tool === params.tool);
  // @i18n-ignore-start model：给秘书的用法和出错说明
  const listText = () =>
    authorized()
      .map((tool) => `${tool.server}/${tool.tool}（${tool.title}）`)
      .join("、") || "（还没有：要在配置区的 mcp.json 里给工具写 quickAction）";

  return defineQuickAction({
    type: MCP_QUICK_ACTION,
    get title() {
      return t("mcp.quickAction.title");
    },
    usage: `用户要你做的事正好是一个授权给秘书快速动作的 MCP 工具（参数按登记固定）时用，比如查一下某个只读的状态。现在能用的：${listText()}`,
    // @i18n-ignore-end
    params: Params,
    // 每个工具的关注照它的登记（watchFor）；这里是没找到时的兜底
    watch: { categories: ["unknown_write"] },
    watchFor(action: NormalizedQuickAction): QuickActionWatch {
      const params = action.params as unknown as McpCallParams;
      const found = find(params);
      if (!found) return { categories: ["unknown_write"] };
      // 和会话里的 MCP 工具在工具注册表里的登记同一份（registration.ts 的 guardFieldsOf）。参数规则对着规范化后的参数：
      // 登记的参数名展开到了顶层（见 normalize），自定义类别按收件人、金额这些匹配得到
      const { categories, bottomLines, notifyWhenDone, args, outbound } = guardFieldsOf(found.registration);
      return { categories, args, ...(bottomLines ? { bottomLines } : {}), ...(notifyWhenDone ? { notifyWhenDone } : {}), ...(outbound ? { outbound } : {}) };
    },
    confirm: "by_category",
    normalize({ tool }) {
      const at = tool.indexOf("/");
      const params = at > 0 ? { server: tool.slice(0, at), tool: tool.slice(at + 1) } : { server: "", tool };
      const found = find(params);
      if (!found) throw new Error(`没有授权给秘书快速动作的 MCP 工具 ${tool}。能用的：${listText()}`); // @i18n-ignore model：交给秘书的出错说明
      const normalized = { ...found.args, server: found.server, tool: found.tool, args: found.args } as unknown as JsonValue;
      return {
        params: normalized,
        title: found.title,
        target: t("mcp.quickAction.target", { server: found.serverTitle, tool: found.registration.title, name: mcpToolName(found.server, found.tool) }),
        content: JSON.stringify(found.args),
      };
    },
    // 点明：用户这一轮的原话里原样有这个快速动作的说法
    explicit: (action, turn) => foundIn(turn, action.title),
    // 要等服务进程回话：异步执行（快速动作的执行器二选一，见 quick-actions/registry.ts）
    async perform(params) {
      const p = params as McpCallParams;
      const result = await mcp.call(p.server, p.tool, p.args);
      return { summary: result.text.trim() || (result.isError ? t("mcp.quickAction.errorNoText") : t("mcp.quickAction.empty")), ok: !result.isError };
    },
  });
}
