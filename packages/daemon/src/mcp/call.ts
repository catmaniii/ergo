// 秘书带参调 MCP（240 号票）：秘书的工具 mcp_call——调一个登记过的 MCP 工具，参数由模型给。
// 要补的口子：一个相册应用的 MCP 登记好了，秘书只能调参数写死在登记里的快速动作（mcp/quick-action.ts），
// person.rename{id,name}、filter.set{personId} 这类带参的调不了，只能改用浏览器点页面，或者发一张卡转给项目维护者。
// 用户 2026-10-21 定："不要加那么多限制，让秘书能调 MCP 的所有功能"。
//
// 所以这里就是一条直路：**登记过就调**。不分读 / 写、不看出没标"只读或幂等"、不看类别和底线、不出审批卡；参数原样发过去，
// 服务进程报的错原样带回来。平台自己的守卫照旧判这一次工具调用（和别的工具一视同仁：那是运行时对所有调用的规则，
// 不是给 MCP 加的），被拦下时照工具结果里的说明告诉用户。
//
// 只把三种"根本调不到"的情况说清：MCP 没登记（列出现在登记了哪些）、工具没登记（列出这个 MCP 登记了哪些工具）、
// 服务进程没起来 / 端口对不上（补一句能操作的）。
// 记录：时间线上一条 mcp_call（谁调的、哪个 MCP、哪个工具、脱敏后的参数、结果）+ mcp_called 事件（守护进程内部的 mcp 频道）。
// 事件日志里不写密钥类参数的原值：按登记注入的凭据值换成"来自环境变量 X"，名字看着是密钥的换成星号（mcp/redact.ts）。
import { CHANNELS, EVENT_TYPES, type McpCallOutcome, type McpCalledPayload, type McpCallResultView, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { buildTimelineRecord } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import * as text from "./call-texts.ts";
import { MCP_CHANNEL } from "./change.ts";
import type { McpService } from "./mcp.ts";
import { redactMcpCallArgs } from "./redact.ts";
import type { McpRegistrationRead } from "./registration.ts";
import { MCP_CALL_TOOL } from "./tool-names.ts";

export { MCP_CALL_TOOL } from "./tool-names.ts";

/** 秘书会话（时间线记在它上面） */
const CONVERSATION = CHANNELS.secretary;

/** 结果写成时间线、事件里的那一份（压成一行、截短：别把整段大输出写进事件日志） */
function resultViewOf(result: { text: string; isError: boolean }, now: () => string): McpCallResultView {
  const oneLine = result.text.replace(/\s+/g, " ").trim();
  return { ok: !result.isError, text: oneLine.length > 600 ? `${oneLine.slice(0, 600)}…` : oneLine, time: now() };
}

/** 把 "<MCP 名>/<工具名>" 拆开；没有斜杠时 tool 是空的（按"没登记工具"回，顺带列出这个 MCP 有的工具） */
function splitTarget(value: string): { server: string; tool: string } {
  const at = value.indexOf("/");
  return at > 0 ? { server: value.slice(0, at), tool: value.slice(at + 1) } : { server: value, tool: "" };
}

/** 现在登记了的工具（"MCP 名/工具名"）：没登记时列给秘书，才操作得下去 */
function registeredTools(read: McpRegistrationRead): string[] {
  return Object.entries(read.servers).flatMap(([server, serverReg]) => Object.keys(serverReg.tools).map((tool) => `${server}/${tool}`));
}

export interface McpCallServiceOptions {
  store: EventStore;
  /** 现读登记、按登记调、看服务进程起没起来、拿按登记注入的凭据 */
  mcp: Pick<McpService, "registrations" | "call" | "live" | "injectedSecrets">;
  now: () => string;
  log: (line: string) => void;
}

export interface McpCallService {
  /** 秘书带参调 MCP 的工具 */
  tool(): HostTool;
}

export function createMcpCallService(options: McpCallServiceOptions): McpCallService {
  const { store, mcp } = options;

  /** 一次调用的结局记下来：时间线（秘书会话）+ mcp_called（守护进程内部的 mcp 频道） */
  const record = (described: { server: string; serverTitle: string; tool: string; toolTitle: string; args: Readonly<Record<string, unknown>>; why?: string }, outcome: McpCallOutcome, result: McpCallResultView): NewEvent[] => {
    const payload: McpCalledPayload = {
      outcome,
      server: described.server,
      serverTitle: described.serverTitle,
      tool: described.tool,
      toolTitle: described.toolTitle,
      args: { ...described.args },
      ...(described.why === undefined ? {} : { why: described.why }),
      result,
      time: options.now(),
    };
    const timeline = buildTimelineRecord(
      CONVERSATION,
      {
        kind: "mcp_call",
        summary: text.timelineSummary(outcome, described.serverTitle, described.tool, result),
        detail: text.timelineDetail({ args: described.args, ...(described.why === undefined ? {} : { why: described.why }), result }),
      },
      {},
    );
    return [{ channel: MCP_CHANNEL, type: EVENT_TYPES.mcpCalled, payload }, timeline.event];
  };

  const tool = (): HostTool =>
    defineHostTool({
      name: MCP_CALL_TOOL,
      title: text.mcpCallTitle(),
      description: text.MCP_CALL_DESCRIPTION,
      parameters: Type.Object(
        {
          tool: Type.String({ minLength: 1, maxLength: 200, description: text.MCP_CALL_PARAMS.tool }),
          args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: text.MCP_CALL_PARAMS.args })),
          why: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: text.MCP_CALL_PARAMS.why })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      // args 里套着目标工具的参数：给人看的参数摘要先擦掉像密钥的值（280 号票：工具自己声明，守卫运行时不再按名字认）
      maskArgs: true,
      run: async (given) => {
        const target = splitTarget(given.tool.trim());
        // 参数原样发过去：不改写、不补默认值、不替服务端做校验
        const args = given.args ?? {};
        const read = mcp.registrations();
        if (read.problem !== undefined) return { text: text.registrationProblemText(read.problem), isError: true };
        const serverReg = read.servers[target.server];
        if (!serverReg) return { text: text.notRegisteredServerText(target.server, registeredTools(read)), isError: true };
        const registration = serverReg.tools[target.tool];
        if (!registration) return { text: text.toolNotRegisteredText(target.server, serverReg.title ?? target.server, Object.keys(serverReg.tools)), isError: true };

        const result = await mcp.call(target.server, target.tool, args);
        const view = resultViewOf(result, options.now);
        const { args: shown } = redactMcpCallArgs(args, mcp.injectedSecrets(target.server));
        store.appendBatch(
          record({ server: target.server, serverTitle: serverReg.title ?? target.server, tool: target.tool, toolTitle: registration.title, args: shown, ...(given.why === undefined ? {} : { why: given.why }) }, view.ok ? "done" : "failed", view),
        );
        options.log(`秘书调 MCP ${target.server}/${target.tool}：${view.ok ? "做成了" : "没做成"}`);
        const body = result.text.trim() === "" ? t("mcp.call.resultEmpty") : result.text;
        // 没起来、连不上时补一句能操作的（端口可能和登记里写的不一致）
        const started = mcp.live().some((entry) => entry.server === target.server);
        return { text: result.isError && !started ? `${body}\n${text.notStartedHint()}` : body, isError: result.isError };
      },
    });

  return { tool };
}
