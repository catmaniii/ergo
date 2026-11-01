// 项目自动转的 MCP（ADR-0045）：二狗带的 stdio 转发程序问守护进程的本机接口 POST /api/project-ops-mcp 的请求体和回话。
// 转发程序只转话：tools/list、tools/call 原样发过来，守护进程回的就是 MCP 的结果。只在本机端口开，带 Bearer 凭证。
import { type Static, Type } from "typebox";

/** tools/call 的 _meta 里放调用者的键：守护进程调自动转的 MCP 时写，转发程序照带，模型碰不到 */
export const PROJECT_OPS_MCP_CALLER_META = "ergo/caller";

/** 这次调用是谁发的：哪个 agent、哪次工具调用（同一次调用不做两遍）、它正在处理哪条消息 */
export const ProjectOpsMcpCaller = Type.Object(
  {
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    inputMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ProjectOpsMcpCaller = Static<typeof ProjectOpsMcpCaller>;

export const ProjectOpsMcpBody = Type.Union([
  Type.Object({ method: Type.Literal("tools/list") }, { additionalProperties: false }),
  Type.Object(
    {
      method: Type.Literal("tools/call"),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      caller: Type.Optional(ProjectOpsMcpCaller),
    },
    { additionalProperties: false },
  ),
]);
export type ProjectOpsMcpBody = Static<typeof ProjectOpsMcpBody>;

/** tools/list 回的一个工具（MCP 的 Tool，title 是操作的中文标题） */
export interface ProjectOpsMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
}

/** tools/call 回的（MCP 的 CallToolResult）：text 是交给模型的整段，say 是能念的那句 */
export interface ProjectOpsMcpResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent?: { say: string };
}

export type ProjectOpsMcpReply = { tools: ProjectOpsMcpTool[] } | ProjectOpsMcpResult;
