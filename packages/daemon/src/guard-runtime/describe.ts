// 给人看的写法：聊天里的工具调用 part、审批卡、"交给我做"事项都用这里的参数摘要、类别名字和处置。
import { createHash } from "node:crypto";
import type { Disposition as WireDisposition } from "@ergou/protocol";
import { builtinCategory, type Disposition, isBuiltinCategory, type ToolRegistry, type WatchCategorySettings } from "../guard/index.ts";

/** 守卫的六档处置 → 前端协议里的写法 */
export const WIRE_DISPOSITION: Readonly<Record<Disposition, WireDisposition>> = Object.freeze({
  log_only: "do",
  notify_after: "do_then_tell",
  plan_listed: "planned_only",
  ask_first: "ask_first",
  hand_over: "hand_to_me",
  never: "never",
});

const SUMMARY_MAX = 160;
const RESULT_MAX = 200;

/** 压成一行、截短 */
export function oneLine(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 工具结果的摘要（一行、截短） */
export function resultSummary(text: string): string {
  return oneLine(text, RESULT_MAX);
}

/** 参数摘要（一行）：bash 是命令原文；文件工具是路径（搜索带上模式）；别的工具按"参数名=值"列出 */
export function summarizeArgs(toolName: string, args: unknown): string {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (toolName === "bash" && typeof a.command === "string") return oneLine(a.command);
  if (typeof a.path === "string" && ["read", "write", "edit", "ls"].includes(toolName)) return oneLine(a.path);
  if (typeof a.pattern === "string" && ["grep", "find"].includes(toolName)) return oneLine(`${a.pattern}${typeof a.path === "string" ? ` · ${a.path}` : ""}`);
  const pairs = Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return oneLine(pairs.join(" "));
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
 * 调用指纹：同一个 agent（同一个任务）在同一个工作目录里、工具和参数一模一样的调用。
 * 事后批准的审批按它匹配一次性授权（不用规范化后的参数：拆出来的伪工具会丢掉命令里的选项，宽了）。
 */
export function callFingerprint(input: { agentId: string; taskId: string | null; cwd: string; tool: string; args: unknown }): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
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
