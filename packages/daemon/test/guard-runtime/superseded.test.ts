// 作废的那一轮（84 号票：从某个阶段重做之前停稳维护者，到点还没停下的那一轮）之后的调用：真的守护进程里的守卫接入，
// 接一个假的子进程（判定请求、调用结束由测试发），守卫看到的会话报出作废的原因（AgentSession.stopTurn 设的，见
// test/agent-session-stop.test.ts）——这次调用不放行、结果交回原因，记录写"这一轮已作废"，不进效果日志（不算进新一轮）；
// 那一轮结束、不再作废之后，同样的调用照常判定。
import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart, TOOL_CALL_BLOCK_LABEL } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { AgentLink } from "../../src/agent-manager/agent-manager.ts";
import { BUILTIN_TOOL_REGISTRY } from "../../src/guard/index.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { AgentReport, HostCommand } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 假的子进程：守卫的回复记下来，报告由测试发 */
function fakeLink(agentId: string) {
  const listeners = new Set<(report: AgentReport) => void>();
  const sent: HostCommand[] = [];
  const link: AgentLink = {
    agentId,
    send: (command) => void sent.push(command),
    onReport: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: new Promise(() => {}),
  };
  const report = (r: Record<string, unknown>) => {
    for (const listener of listeners) listener(r as AgentReport);
  };
  return { link, sent, report };
}

describe("作废的那一轮之后的调用（84 号票）", () => {
  it("守卫不放行、结果交回原因，记录写“这一轮已作废”，不进效果日志；那一轮结束、不再作废之后照常判定", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = fs.realpathSync.native(makeTempDir("ergo-cwd-"));
    const conversation = maintainerChannel("tm-9");
    const reason = "用户从某个阶段重做了，这一轮已经作废：不要再调用工具，停下等新的交代。";
    let superseded: string | undefined = reason;
    const { link, sent, report } = fakeLink("tm-9");
    daemon.guards.attach(link, {
      agent: { kind: "maintainer", agentId: "tm-9", cwd, toolkit: { bash: false, network: false }, projectRecords: [], workingDirs: [cwd] },
      tools: BUILTIN_TOOL_REGISTRY,
      conversation,
      source: "测试",
      superseded: () => superseded,
    });
    const replyTo = (requestId: string) => sent.find((c) => c.type === "guard_reply" && c.requestId === requestId) as Extract<HostCommand, { type: "guard_reply" }> | undefined;
    const records = () =>
      daemon.store
        .read(conversation)
        .filter((e) => e.type === EVENT_TYPES.message)
        .flatMap((e) => (e.payload as MessageEventPayload).message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));

    // 作废的那一轮又发起一次写文件：不放行，交回原因
    report({ type: "guard_request", requestId: "g-1", toolCallId: "c-1", toolName: "write", args: { path: "late.md", content: "迟到的" } });
    expect(replyTo("g-1")?.verdict).toEqual({ allow: false, reason });
    report({ type: "tool_call_end", toolCallId: "c-1", toolName: "write", isError: true, resultText: reason });
    await waitUntil(() => records().some((p) => p.callId === "c-1" && p.outcome !== "running"), { timeoutMs: 5_000, describe: () => "等这次调用的记录" });
    expect(records().find((p) => p.callId === "c-1")).toMatchObject({ outcome: "blocked", blockedBy: "superseded" });
    expect(TOOL_CALL_BLOCK_LABEL.superseded).toBe("这一轮已作废");
    expect(fs.existsSync(path.join(cwd, "late.md"))).toBe(false);

    // 那一轮结束了（会话不再报作废）：同样的调用照常判定、放行，执行成功的进效果日志——作废那次的不在里面
    superseded = undefined;
    report({ type: "guard_request", requestId: "g-2", toolCallId: "c-2", toolName: "write", args: { path: "next.md", content: "新一轮的" } });
    expect(replyTo("g-2")?.verdict).toMatchObject({ allow: true });
    report({ type: "tool_call_end", toolCallId: "c-2", toolName: "write", isError: false, resultText: "写好了" });
    await waitUntil(() => listEffects(daemon.store.reader, { taskId: null, agentId: "tm-9", segmentId: undefined }).length > 0, { timeoutMs: 5_000, describe: () => "等效果日志" });
    expect(listEffects(daemon.store.reader, { taskId: null, agentId: "tm-9", segmentId: undefined }).map((e) => [e.tool, e.args])).toEqual([["write", expect.objectContaining({ path: expect.stringContaining("next.md") })]]);
  });
});
