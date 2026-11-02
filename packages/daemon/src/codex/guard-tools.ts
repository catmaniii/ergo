// Codex 自带、二狗没装配的工具在守卫工具登记表里的登记（AgentRuntime.guardTools，来源 runtime）。
// 用 Codex 的负责人的会话：守卫的登记表加上这些、工具包标上 runtimeTools，这些不按工具白名单硬拒绝、照这里的登记判；
// 没登记的（用户自己配的 MCP、Codex 以后加的工具）照"未登记的写操作"判。
// 能对上二狗工具的不在这里：命令（Bash）→ bash，看图（imageView）→ read，联网搜索（webSearch，启动时关掉了，万一还来了）→ web_search（child/translator.ts）。
// 改文件（apply_patch）二狗没有一个工具对得上：一次补丁能改好几个文件，登记成带路径列表的工具，路径围栏、受保护区域、删除或覆盖照路径参数判。
// 工具名照 0.166 的协议（ThreadItem、CollabAgentTool）和它的工具说明。
import { t } from "@ergo/protocol";
import type { ArgRule, ToolDescriptor } from "../guard/index.ts";

const other: ArgRule = { kind: "other" };
const content: ArgRule = { kind: "content" };

type Untitled = Omit<ToolDescriptor, "title" | "source">;

/** 只看的会话内工具 */
const look = (name: string, args: ToolDescriptor["args"]): Untitled => ({ name, categories: [], args, readOnlyOrIdempotent: true, nature: "look" });

const CODEX_TOOLS: Untitled[] = [
  {
    name: "apply_patch",
    categories: [],
    args: {
      adds: { kind: "path", access: "write", replaces: true, list: true },
      updates: { kind: "path", access: "write", list: true },
      deletes: { kind: "path", access: "delete", list: true },
      patch: { kind: "other", bulk: true },
    },
  },
  // 往开着的终端里送输入：送的是什么只有它自己知道，当成改东西的
  { name: "write_stdin", categories: [], args: { input: content, processId: other }, nature: "modify" },
  look("update_plan", { plan: other, explanation: other }),
  look("tool_search", { query: other }),
  look("list_mcp_resources", { server: other }),
  look("list_mcp_resource_templates", { server: other }),
  look("read_mcp_resource", { server: other, uri: other }),
  look("sleep", { durationMs: other }),
  look("curr_time", {}),
  // 会话内的目标：只记在 Codex 自己的状态里，碰不到外面
  look("get_goal", {}),
  look("create_goal", { objective: other, token_budget: other }),
  look("update_goal", { status: other }),
  // Codex 问用户：同步的只有 Plan 模式能用（别的模式 Codex 自己回不可用）；异步的立刻返回，问题变成一条消息
  look("request_user_input", { questions: other }),
  look("request_user_input_async", { questions: other }),
  { name: "image_generation", categories: [], args: { revisedPrompt: content } },
  // 派子代理（它里面的每次调用另外过守卫、另外记录）
  { name: "spawnAgent", categories: [], args: { prompt: content, model: other, reasoningEffort: other, receiverThreadIds: other, task_name: other, fork_turns: other } },
  { name: "sendInput", categories: [], args: { prompt: content, receiverThreadIds: other } },
  { name: "sendMessage", categories: [], args: { prompt: content, receiverThreadIds: other } },
  { name: "followupTask", categories: [], args: { prompt: content, receiverThreadIds: other } },
  { name: "resumeAgent", categories: [], args: { prompt: content, receiverThreadIds: other } },
  look("wait", { receiverThreadIds: other }),
  look("listAgents", {}),
  { name: "closeAgent", categories: [], args: { receiverThreadIds: other }, nature: "modify" },
  { name: "interruptAgent", categories: [], args: { receiverThreadIds: other }, nature: "modify" },
  // 要更大的权限（网络、写别的目录）：放行就给这一轮
  { name: "request_permissions", categories: [], args: { reason: content, permissions: other }, nature: "modify" },
];

/** 登记：名字（给人看的，审批卡、工具调用记录里用）按当前语言现取（key 是 codex.tools.<工具名>） */
export const CODEX_GUARD_TOOLS: readonly ToolDescriptor[] = CODEX_TOOLS.map(
  (tool) => Object.defineProperty({ ...tool, source: "runtime" }, "title", { enumerable: true, get: () => t(`codex.tools.${tool.name}`) }) as ToolDescriptor,
);
