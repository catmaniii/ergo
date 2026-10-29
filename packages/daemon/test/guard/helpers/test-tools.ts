// 测试里登记的 MCP 工具：每个内置类别一个，外加付款、发邮件这类带底线、带收件人的工具。
import {
  BUILTIN_TOOL_REGISTRY,
  registerTools,
  type BuiltinCategoryId,
  type ToolDescriptor,
  type ToolRegistry,
} from "../../../src/guard/index.ts";

const CATEGORY_IDS: BuiltinCategoryId[] = [
  "spend_money",
  "external_send",
  "delete_or_overwrite",
  "irreversible_commit",
  "account_security",
  "outside_project",
  "memory_out_of_scope",
  "unplanned_work_order",
  "unknown_write",
];

/** 名为 `mcp_<类别>` 的工具，只带这一个类别标签、没有路径参数 */
export function categoryTool(category: BuiltinCategoryId): string {
  return `mcp_${category}`;
}

const categoryTools: ToolDescriptor[] = CATEGORY_IDS.map((category) => ({
  name: categoryTool(category),
  title: `测试工具：${category}`,
  source: "mcp",
  categories: [category],
  args: { target: { kind: "other" } },
}));

export const TEST_TOOLS: ToolRegistry = registerTools(
  BUILTIN_TOOL_REGISTRY,
  ...categoryTools,
  {
    name: "mcp_plain",
    title: "测试工具：没有类别",
    source: "mcp",
    categories: [],
    args: { target: { kind: "other" } },
  },
  {
    name: "mcp_deploy",
    title: "测试工具：部署（时序规则用）",
    source: "mcp",
    categories: [],
    args: { target: { kind: "other" }, version: { kind: "other", pattern: "^v\\d+$" } },
  },
  {
    name: "mcp_notify",
    title: "测试工具：做完告诉我",
    source: "mcp",
    categories: [],
    args: { target: { kind: "other" } },
    notifyWhenDone: true,
  },
  {
    name: "mcp_pay",
    title: "付款",
    source: "mcp",
    categories: ["spend_money"],
    bottomLines: ["payment_account_auth"],
    args: { payee: { kind: "recipient" }, amount: { kind: "amount", type: "number" } },
    network: true,
    outbound: true,
  },
  {
    name: "mcp_change_password",
    title: "改密码",
    source: "mcp",
    categories: ["account_security"],
    bottomLines: ["payment_account_auth"],
    args: { account: { kind: "other" } },
    network: true,
  },
  {
    name: "mcp_send_email",
    title: "发邮件",
    source: "mcp",
    categories: ["external_send"],
    args: { to: { kind: "recipient" }, subject: { kind: "content" }, body: { kind: "content" } },
    network: true,
    outbound: true,
  },
  {
    name: "mcp_web_search",
    title: "网页搜索",
    source: "mcp",
    categories: [],
    args: { query: { kind: "other" } },
    network: true,
  },
);
