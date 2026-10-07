// 给人看的写法：聊天里的工具调用 part、审批卡、"交给我做"事项都用这里的参数摘要、类别名字和处置。
import { createHash } from "node:crypto";
import type { Disposition as WireDisposition } from "@ergou/protocol";
import { builtinCategory, type Disposition, isBuiltinCategory, TOOL, type ToolRegistry, type WatchCategorySettings } from "../guard/index.ts";
import { oneLine } from "../util/text.ts";

/** 守卫的六档处置 → 前端协议里的写法 */
export const WIRE_DISPOSITION: Readonly<Record<Disposition, WireDisposition>> = Object.freeze({
  log_only: "do",
  notify_after: "do_then_tell",
  plan_listed: "planned_only",
  ask_first: "ask_first",
  hand_over: "hand_to_me",
  never: "never",
});

/** 前端协议里的写法 → 守卫的六档处置（计划、设置页的请求里是协议的写法） */
export const GUARD_DISPOSITION: Readonly<Record<WireDisposition, Disposition>> = Object.freeze(
  Object.fromEntries(Object.entries(WIRE_DISPOSITION).map(([guard, wire]) => [wire, guard])) as Record<WireDisposition, Disposition>,
);

const SUMMARY_MAX = 160;
const RESULT_MAX = 200;

/** 工具结果的摘要（一行、截短） */
export function resultSummary(text: string, max = RESULT_MAX): string {
  return oneLine(text, max);
}

const PATH_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls];
const SEARCH_TOOLS: readonly string[] = [TOOL.grep, TOOL.find];

/** 参数摘要（一行）：bash 是命令原文；文件工具是路径（搜索带上模式）；别的工具按"参数名=值"列出 */
export function summarizeArgs(toolName: string, args: unknown): string {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (toolName === TOOL.bash && typeof a.command === "string") return oneLine(a.command, SUMMARY_MAX);
  if (typeof a.path === "string" && PATH_TOOLS.includes(toolName)) return oneLine(a.path, SUMMARY_MAX);
  if (typeof a.pattern === "string" && SEARCH_TOOLS.includes(toolName)) return oneLine(`${a.pattern}${typeof a.path === "string" ? ` · ${a.path}` : ""}`, SUMMARY_MAX);
  const pairs = Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return oneLine(pairs.join(" "), SUMMARY_MAX);
}

/** 工具的中文名（没登记的用工具名） */
export function toolTitle(tools: ToolRegistry, name: string): string {
  return Object.hasOwn(tools, name) ? tools[name]!.title : name;
}

/** 关注类别显示用的名字：内置类别取它的中文名，自定义类别取设置里的名字 */
export function categoryTitle(id: string, settings: readonly WatchCategorySettings[]): string {
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
