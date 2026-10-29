// 秘书带参调用 MCP（240 号票）给人和模型看的话，都在这里组织（编排在 call.ts，只给结构化的数据）：
// 工具名、说明和参数说明，交给秘书的结果和出错说明（MCP 没登记、工具没登记、服务进程没起来），时间线上的一句话和明细。
// 给用户看的（工具名、时间线、结果）走 t()；给秘书的（工具说明、工具结果）照旧中文。
// 用户 2026-10-21 定：不搞"读 / 写 / 底线"分级、也不出审批卡——MCP call 让秘书能调 MCP 的所有功能，参数原样发过去。
import { type McpCallOutcome, type McpCallResultView, t } from "@ergo/protocol";
import { oneLine } from "../util/text.ts";

/** 几个名字之间（和别处同一个说法） */
const listOf = (names: readonly string[]) => names.join(t("toolkit.listSep"));

// ───────────────────────── 工具（给秘书） ─────────────────────────

export const mcpCallTitle = () => t("mcp.call.toolTitle");
// @i18n-ignore-start model：工具说明和参数说明（给秘书）
export const MCP_CALL_DESCRIPTION = [
  "带参调用一个登记过的 MCP 工具：tool 写 <MCP 名>/<工具名>，args 写它要的参数（照登记里那个工具的参数说明写，原样发过去）。",
  "用户要动一个登记过的 MCP 的状态（改个名字、设筛选、开始放映……）时就用它，不要用浏览器点页面绕过去，也不要在 bash 里直接调它的服务进程。",
  "只读的、会改东西的都一样调；MCP 和工具都要登记过。平台自己的守卫照旧（和别的工具一视同仁），它拦下的调用照工具结果里的说明告诉用户。",
  "MCP 没登记、工具没登记、服务进程没起来时，结果里会写清楚现在登记了哪些、该看哪里。",
].join("");
export const MCP_CALL_PARAMS = {
  tool: "要调的工具：<MCP 名>/<工具名>，比如 album-wall/person.rename。只写 MCP 名时回它登记了哪些工具",
  args: "工具的参数（对象，照登记里那个工具的参数说明写，原样发过去；没有参数就不写）",
  why: "为什么调这个（时间线上看得到，一句就够）",
} as const;
// @i18n-ignore-end

// ───────────────────────── 交给秘书的结果（给秘书） ─────────────────────────

// @i18n-ignore-start model：工具结果
/** 这个 MCP 没登记 */
export function notRegisteredServerText(server: string, registered: readonly string[]): string {
  if (registered.length === 0) {
    return `没有登记 MCP ${server}：一个 MCP 都还没登记（配置区的 mcp.json 里没有）。要接一个 MCP，让维护者用 request_mcp_change 提一条登记、用户在卡上确认之后才有。`;
  }
  return `没有登记 MCP ${server}。现在登记着的几个 MCP 有：${listOf([...new Set(registered.map((name) => name.split("/")[0]!))])}；它们的工具：${listOf(registered)}。要接新的 MCP 让维护者用 request_mcp_change 提登记。`;
}

/** 这个 MCP 有这个工具吗：没有时列出它登记了哪些（写成 <MCP 名>/<工具名>，能直接抄） */
export function toolNotRegisteredText(server: string, serverTitle: string, available: readonly string[]): string {
  return available.length === 0
    ? `MCP「${serverTitle}」（${server}）没有登记任何工具：看看配置区 mcp.json 里这个 MCP 的 tools，或者让维护者用 request_mcp_change 补上。`
    : `MCP「${serverTitle}」（${server}）没有登记这个工具。它登记了：${listOf(available.map((tool) => `${server}/${tool}`))}。tool 照 <MCP 名>/<工具名> 写。`;
}

/** 登记文件读不了 */
export const registrationProblemText = (problem: string) =>
  `配置区的 MCP 登记读不了：${problem}。修好之前一个 MCP 都调不了；让维护者用 request_mcp_change 改，或者让用户去改配置区。`;

/** 服务进程起不来、端口对不上时补的一句 */
export const notStartedHint = () => "看起来是这个 MCP 的服务进程没起来：看看登记的 command、args、cwd 对不对，它要的端口有没有被别的程序占着（端口可能和登记里写的不一致）。";
// @i18n-ignore-end

// ───────────────────────── 时间线（给用户） ─────────────────────────

/** 参数写成一段（时间线明细、事件日志里都用脱敏后的这一份） */
export const argsText = (args: Readonly<Record<string, unknown>>) => (Object.keys(args).length === 0 ? t("mcp.call.noArgs") : JSON.stringify(args));

/** 服务进程的结果写成一句（时间线、一句话摘要都用它） */
export const resultText = (result: McpCallResultView) => result.text.trim() || t("mcp.call.resultEmpty");

/** 时间线上的一句话：调到了 / 没调成，带着结果 */
export function timelineSummary(outcome: McpCallOutcome, serverTitle: string, tool: string, result: McpCallResultView): string {
  const params = { server: serverTitle, tool, result: oneLine(resultText(result), 60) };
  return t(outcome === "done" ? "mcp.call.timeline.done" : "mcp.call.timeline.failed", params);
}

/** 时间线上的明细：参数、为什么、结果（没调成的写成"没做成：…"） */
export function timelineDetail(input: { args: Readonly<Record<string, unknown>>; why?: string; result: McpCallResultView }): string {
  return [
    t("mcp.call.timeline.detail.args", { args: argsText(input.args) }),
    ...(input.why === undefined ? [] : [t("mcp.call.timeline.detail.why", { why: input.why })]),
    t(input.result.ok ? "mcp.call.timeline.detail.result" : "mcp.call.timeline.detail.resultFailed", { result: resultText(input.result) }),
  ].join("\n");
}
