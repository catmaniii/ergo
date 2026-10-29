// 给人看的写法：聊天里的工具调用 part、审批卡、"交给我做"事项都用这里的参数摘要、类别名字和处置。
import { createHash } from "node:crypto";
import { builtinCategory, findTool, isBuiltinCategory, maskSecretArgValues, TOOL, type ToolRegistry } from "../guard/index.ts";
import { oneLine } from "../util/text.ts";

const SUMMARY_MAX = 160;
const RESULT_MAX = 200;

/** 工具结果的摘要（一行、截短） */
export function resultSummary(text: string, max = RESULT_MAX): string {
  return oneLine(text, max);
}

const PATH_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls];
const SEARCH_TOOLS: readonly string[] = [TOOL.grep, TOOL.find];

/**
 * 参数摘要（一行）：bash 是命令原文；文件工具是路径（搜索带上模式）；联网搜索是查询词，读网页是网址；别的工具按"参数名=值"列出。
 * tools 是这次调用所在的工具注册表：工具自己声明了参数要打码（登记里的 maskArgs）的，先擦掉密钥类的值
 */
export function summarizeArgs(tools: ToolRegistry, toolName: string, args: unknown): string {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (toolName === TOOL.bash && typeof a.command === "string") return oneLine(a.command, SUMMARY_MAX);
  if (toolName === TOOL.web_search && typeof a.query === "string") return oneLine(a.query, SUMMARY_MAX);
  if (toolName === TOOL.web_fetch && typeof a.url === "string") return oneLine(a.url, SUMMARY_MAX);
  if (typeof a.path === "string" && PATH_TOOLS.includes(toolName)) return oneLine(a.path, SUMMARY_MAX);
  if (typeof a.pattern === "string" && SEARCH_TOOLS.includes(toolName)) return oneLine(`${a.pattern}${typeof a.path === "string" ? ` · ${a.path}` : ""}`, SUMMARY_MAX);
  // 参数里套着别的接口的参数的工具（240 号票秘书带参调 MCP 的 mcp_call、260 号票的 project_ops）：名字看着是密钥的、像密钥的形态都擦掉再列
  // （时间线、事件日志里另有一套）。280 号票起看工具自己的登记（maskArgs），不再按工具名认
  return oneLine(pairsText(findTool(tools, toolName)?.maskArgs === true ? (maskSecretArgValues(a) as Record<string, unknown>) : a), SUMMARY_MAX);
}

/** "参数名=值"挨着排成一行 */
function pairsText(a: Readonly<Record<string, unknown>>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/** 工具的中文名（没登记的用工具名） */
export function toolTitle(tools: ToolRegistry, name: string): string {
  return Object.hasOwn(tools, name) ? tools[name]!.title : name;
}

/** 有自定义类别的设置：全局的（WatchCategorySettings）、本任务的（TaskWatchSettings） */
export interface CategoryTitles {
  custom?: readonly { id: string; title: string }[];
}

/** 关注类别显示用的名字：内置类别取它的中文名，自定义类别取设置里的名字（全局的在前，本任务的在后） */
export function categoryTitle(id: string, settings: readonly CategoryTitles[]): string {
  if (isBuiltinCategory(id)) return builtinCategory(id).title;
  for (const s of settings) {
    const custom = s.custom?.find((c) => c.id === id);
    if (custom) return custom.title;
  }
  return id;
}

/**
 * 调用指纹：同一个 agent、同一个任务的同一个阶段（没有阶段时为空）、在同一个工作目录里、工具和参数一模一样的调用。
 * 事后批准的审批按它匹配一次性授权，授权只在所属阶段有效（不用规范化后的参数：拆出来的伪工具会丢掉命令里的选项，宽了）。
 */
export function callFingerprint(input: { agentId: string; taskId: string | null; stageId: string | null; cwd: string; tool: string; args: unknown }): string {
  return createHash("sha256")
    .update(canonicalJson({ ...input, stageId: input.stageId ?? "" }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
