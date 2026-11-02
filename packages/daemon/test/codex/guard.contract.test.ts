// Codex 的工具调用都过二狗守卫（用户第 4 条决定，ADR-0046）：适配子进程、钩子脚本（真的经 cmd /C ergo-guard-hook 拉起）、MCP 中转都是真的，app-server 是假的。
// 三个口子：PreToolUse 钩子（主闸口）、审批请求、item/started 上的事后核对；这里逐个核对"判不放行时真的没执行"，以及拦不住的那几样照实记录、打断。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromGuardArgs, toGuardCall } from "../../src/codex/child/guard.ts";
import { innerCommand, pathsOfPatch } from "../../src/codex/child/translator.ts";
import { CODEX_GUARD_TOOLS } from "../../src/codex/guard-tools.ts";
import type { GuardVerdict, HostToolSpec } from "../../src/runtime/index.ts";
import { startCodexChild } from "../helpers/codex-child.ts";
import type { FakeStep } from "../helpers/fake-codex-app-server.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const PATCH = "*** Begin Patch\n*** Add File: notes/new.md\n+hello\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Delete File: old.txt\n*** Update File: b.ts\n*** Move to: c.ts\n*** End Patch";

/** 跑一轮：一组步骤，守卫按 decide 回，等这一轮结束 */
async function run(steps: FakeStep[], decide: (request: { toolName: string; args: unknown }) => GuardVerdict = () => ({ allow: true })) {
  const child = startCodexChild({ server: { turns: [steps] } });
  child.answerGuard(decide);
  await child.log.next("ready");
  const end = await child.turn("in-1", "干活");
  return { child, end, server: child.server, log: child.log };
}

const deny = (reason = "守卫不放行：不许删"): GuardVerdict => ({ allow: false, reason });

describe("钩子（主闸口）", () => {
  it("-c 给的钩子第一次没信任：按 hooks/list 报的 key、hash 重起一次；记下来，下次不用重起", async () => {
    const child = startCodexChild();
    await child.log.next("ready");
    expect(child.server.spawns).toHaveLength(2);
    expect(child.server.spawns[0]!.args.join(" ")).not.toContain("hooks.state");
    expect(child.server.spawns[1]!.args.join(" ")).toContain('hooks.state={"C:\\\\<session-flags>\\\\config.toml:pre_tool_use:0:0"={trusted_hash="sha256:');
    expect(child.server.connection.hook?.trusted).toBe(true);
    await child.shutdown(0);

    const again = startCodexChild({ session: { runtimeDir: child.assembly.runtimeDir! } });
    await again.log.next("ready");
    expect(again.server.spawns).toHaveLength(1);
    expect(again.server.spawns[0]!.args.join(" ")).toContain("hooks.state");
  });

  it("钩子生效不了（一直不信任、hooks 特性被关）：start_failed，绝不在没有守卫时跑", async () => {
    const never = startCodexChild({ server: { neverTrust: true } });
    expect(await never.log.next("error")).toMatchObject({ code: "start_failed", fatal: true, message: expect.stringContaining("守卫钩子") });
    const off = startCodexChild({ server: { hooksOff: true } });
    expect(await off.log.next("error")).toMatchObject({ code: "start_failed", fatal: true, message: expect.stringContaining("守卫钩子") });
  });

  it("forwardToolCalls 是 false（不接守卫的会话）：不配钩子", async () => {
    const child = startCodexChild({ session: { forwardToolCalls: false } });
    await child.log.next("ready");
    expect(child.server.spawns).toHaveLength(1);
    expect(child.server.spawns[0]!.args.join(" ")).not.toContain("hooks.PreToolUse");
  });

  it("命令被拦下：开始在前、判定请求在后，映射成守卫的 bash（原样的在 native 里）；没执行；模型收到说明；调用结束记出错", async () => {
    const { log, server } = await run([{ kind: "command", command: "rm -rf /", id: "c-1" }, { kind: "reply", text: "被拦了" }], () => deny());
    expect(log.reports.map((r) => r.type).filter((t) => t === "tool_call_start" || t === "guard_request" || t === "tool_call_end")).toEqual(["tool_call_start", "guard_request", "tool_call_end"]);
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolCallId: "c-1", toolName: "bash", args: { command: "rm -rf /" }, native: { toolName: "Bash", args: { command: "rm -rf /" } } });
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "c-1", toolName: "bash", isError: true, resultText: "守卫不放行：不许删" });
    expect(server.executed).toEqual([]);
    expect(server.toolResults.get("c-1")).toBe("守卫不放行：不许删");
    // 钩子就拦下了，没走到审批
    expect(server.hookRuns).toHaveLength(1);
  });

  it("拦下之后 Codex 还报条目（declined）：不重复报开始、结束", async () => {
    const { log, server } = await run([{ kind: "command", command: "rm x", id: "c-1", itemAfterDeny: true }, { kind: "reply", text: "好" }], () => deny());
    expect(log.ofType("tool_call_start")).toHaveLength(1);
    expect(log.ofType("tool_call_end")).toHaveLength(1);
    expect(log.ofType("guard_request")).toHaveLength(1);
    expect(server.executed).toEqual([]);
  });

  it("放行：钩子不写判定（真的 Codex 不认空的 allow），审批不再问守卫（同一次调用只判一次）、回 accept；执行了，结果进记录", async () => {
    const { log, server } = await run([{ kind: "command", command: "npm test", id: "c-1", output: "8 passed" }, { kind: "reply", text: "好" }]);
    expect(log.ofType("guard_request")).toHaveLength(1);
    expect(server.executed).toEqual([{ tool: "Bash", input: { command: "npm test" } }]);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "c-1", toolName: "bash", isError: false, resultText: "8 passed" });
    expect(server.hookRuns[0]!.output).toEqual({});
    // 回复定稿在工具调用开始之前（带上这次调用）
    const order = log.reports.map((r) => r.type);
    expect(order.indexOf("tool_call_start")).toBeLessThan(order.indexOf("tool_call_end"));
  });

  it("按计划改了参数：allow 带 updatedInput，执行的是改过的；resultPrefix 加在结果前面", async () => {
    const { log, server } = await run([{ kind: "command", command: "git push", id: "c-1", output: "ok" }, { kind: "reply", text: "好" }], () => ({ allow: true, args: { command: "git push --dry-run" }, resultPrefix: "按计划改了参数" }));
    expect(server.executed).toEqual([{ tool: "Bash", input: { command: "git push --dry-run" } }]);
    expect(log.ofType("tool_call_end")[0]!.resultText).toBe("按计划改了参数\nok");
    expect(server.hookRuns[0]!.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "git push --dry-run" }, additionalContext: "按计划改了参数" } });
  });

  it("改过的参数换不回这个工具（改不成 apply_patch 的写法）：拦下、写明；没执行", async () => {
    const { log, server } = await run([{ kind: "patch", patch: PATCH, id: "p-1" }, { kind: "reply", text: "好" }], () => ({ allow: true, args: { path: "somewhere" } }));
    expect(server.executed).toEqual([]);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ isError: true, resultText: expect.stringContaining("执行不了") });
  });

  it("补丁：解析出改哪些文件交给守卫（新增、修改、删除、移动）；不放行没执行", async () => {
    const { log, server } = await run([{ kind: "patch", patch: PATCH, id: "p-1" }, { kind: "reply", text: "好" }], () => deny("不许改"));
    expect(log.ofType("guard_request")[0]).toMatchObject({
      toolName: "apply_patch",
      args: { adds: ["notes/new.md", "c.ts"], updates: ["src/a.ts"], deletes: ["old.txt", "b.ts"], patch: PATCH },
      native: { toolName: "apply_patch" },
    });
    expect(server.executed).toEqual([]);
  });

  it("补丁放行：审批回 accept，执行了；结束写改了哪些文件", async () => {
    const { log, server } = await run([{ kind: "patch", patch: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch", id: "p-1" }, { kind: "reply", text: "好" }]);
    expect(server.executed).toHaveLength(1);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolName: "apply_patch", isError: false, resultText: "a.md" });
  });

  it("用户自己配的 MCP：照原名过守卫；不放行没执行；放行时 Codex 给它要的审批回 accept", async () => {
    const denied = await run([{ kind: "user_mcp", server: "gh", tool: "merge_pr", args: { pr: 1 }, id: "m-1" }, { kind: "reply", text: "好" }], () => deny());
    expect(denied.log.ofType("guard_request")[0]).toMatchObject({ toolName: "mcp__gh__merge_pr", args: { pr: 1 } });
    expect(denied.server.executed).toEqual([]);
    const allowed = await run([{ kind: "user_mcp", server: "gh", tool: "merge_pr", args: { pr: 1 }, id: "m-1", elicit: true }, { kind: "reply", text: "好" }]);
    expect(allowed.server.executed).toEqual([{ tool: "mcp__gh__merge_pr", input: { pr: 1 } }]);
    expect(allowed.log.ofType("guard_request")).toHaveLength(1);
    expect(allowed.log.ofType("tool_call_end")[0]).toMatchObject({ toolName: "mcp__gh__merge_pr", isError: false });
  });

  it("钩子连不上适配子进程：不放行（钩子不给判定 Codex 会接着执行）", async () => {
    const script = fileURLToPath(new URL("../../src/codex/child/guard-hook.ts", import.meta.url));
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script], { env: { ...process.env, ERGO_CODEX_PIPE: path.join("\\\\.\\pipe", "ergo-codex-gone"), ERGO_CODEX_TOKEN: "x" } });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        text += chunk;
      });
      child.on("close", () => resolve(text));
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_use_id: "c-1", tool_input: { command: "x" } }));
    });
    expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("连不上") } });
  });

  it("打断：等着的判定按不放行收尾（回合已中止），那次调用没执行；之后才到的判定回 bad_command", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "command", command: "rm x", id: "c-1" }]] } });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "干活" });
    const request = await child.log.next("guard_request");
    child.send({ type: "abort" });
    const end = await child.log.next("turn_end");
    expect(end.outcome).toBe("aborted");
    expect(child.server.executed).toEqual([]);
    expect(child.log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "c-1", isError: true });
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    expect(await child.log.next("error")).toMatchObject({ code: "bad_command" });
  });
});

describe("审批请求（第二道）", () => {
  it("钩子没拦到（没覆盖到）的命令：审批时过守卫；不放行回 decline，没执行", async () => {
    const { log, server } = await run([{ kind: "command", command: "rm x", id: "c-1", hook: false }, { kind: "reply", text: "好" }], () => deny());
    expect(log.ofType("guard_request")).toHaveLength(1);
    expect(server.executed).toEqual([]);
    expect(server.toolResults.get("c-1")).toBe("declined");
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "c-1", isError: true });
  });

  it("钩子没拦到的命令放行：执行；审批改不了参数，判定要改参数的回 decline", async () => {
    const allowed = await run([{ kind: "command", command: "npm test", id: "c-1", hook: false }, { kind: "reply", text: "好" }]);
    expect(allowed.server.executed).toHaveLength(1);
    const changed = await run([{ kind: "command", command: "git push", id: "c-1", hook: false }, { kind: "reply", text: "好" }], () => ({ allow: true, args: { command: "git push --dry-run" } }));
    expect(changed.server.executed).toEqual([]);
  });

  it("钩子没拦到的补丁：审批时按条目里的文件过守卫；不放行没写", async () => {
    const { log, server } = await run([{ kind: "patch", patch: PATCH, id: "p-1", hook: false }, { kind: "reply", text: "好" }], () => deny());
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolName: "apply_patch", args: { adds: ["notes/new.md"], updates: ["src/a.ts", "b.ts"], deletes: ["old.txt"] } });
    expect(server.executed).toEqual([]);
  });

  it("往终端里送字符：实测不过钩子、不走审批，只有事后通知：照样记一次、过守卫（拦不住，这是启动时关掉 TTY 的原因）；空字符是轮询输出，不算", async () => {
    const { log, child } = await run([{ kind: "write_stdin", id: "s-1", input: "rm x\n" }, { kind: "write_stdin", id: "s-1", input: "" }, { kind: "reply", text: "好" }]);
    expect(log.ofType("guard_request")).toHaveLength(1);
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolName: "write_stdin", args: { input: "rm x\n", processId: "1234" } });
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolName: "write_stdin", isError: false });
    expect(child.logs.join("\n")).toContain("钩子没拦到");
  });

  it("往终端里送字符（协议里还有的审批，0.166 实测没发过）：映射成 write_stdin 过守卫；不放行没送", async () => {
    const { log, server } = await run([{ kind: "write_stdin", id: "s-1", input: "y\n", approval: true }, { kind: "reply", text: "好" }], () => deny());
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolName: "write_stdin", args: { input: "y\n" } });
    expect(server.executed).toEqual([]);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolName: "write_stdin", isError: true });
  });

  it("命令要联网：映射成 web_fetch 过守卫", async () => {
    const { log, server } = await run([{ kind: "command", command: "curl x", id: "c-1", hook: false, network: "example.com" }, { kind: "reply", text: "好" }], (request) => (request.toolName === "web_fetch" ? deny() : { allow: true }));
    expect(log.ofType("guard_request").map((r) => r.toolName)).toContain("web_fetch");
    expect(log.ofType("guard_request").find((r) => r.toolName === "web_fetch")!.args).toEqual({ url: "https://example.com" });
    expect(server.executed).toEqual([]);
  });

  it("要更多权限：过守卫；放行交回要的，不放行交回空的", async () => {
    const denied = await run([{ kind: "permissions", id: "x-1" }, { kind: "reply", text: "好" }], () => deny());
    expect(denied.log.ofType("guard_request")[0]).toMatchObject({ toolName: "request_permissions" });
    expect(denied.server.toolResults.get("x-1")).toBe(JSON.stringify({ permissions: {}, scope: "turn" }));
    const allowed = await run([{ kind: "permissions", id: "x-1" }, { kind: "reply", text: "好" }]);
    expect(allowed.server.toolResults.get("x-1")).toBe(JSON.stringify({ permissions: { network: { enabled: true } }, scope: "turn" }));
  });
});

describe("事后核对（第三道：拦不住，只能记录、打断）", () => {
  it("联网搜索（Codex 在服务端做）：结束时知道搜了什么，照样过守卫、记录；放行不打断", async () => {
    const { log, server } = await run([{ kind: "web_search", query: "二狗", id: "w-1" }, { kind: "reply", text: "搜到了" }]);
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolCallId: "w-1", toolName: "web_search", args: { query: "二狗" } });
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "w-1", toolName: "web_search", isError: false });
    expect(server.callsOf("turn/interrupt")).toEqual([]);
  });

  it("联网搜索判了不放行：已经搜了，打断这一轮、写日志", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "web_search", query: "x", id: "w-1" }, { kind: "hang" }]] } });
    child.answerGuard(() => deny("这一步不让联网"));
    await child.log.next("ready");
    const end = await child.turn("in-1", "干活");
    expect(end.outcome).toBe("aborted");
    expect(child.server.callsOf("turn/interrupt")).toHaveLength(1);
    expect(child.logs.join("\n")).toContain("拦不住");
  });

  it("钩子没拦到、Codex 判成只读不问的命令：事后记录；不放行就打断", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "command", command: "type secret.txt", id: "c-1", hook: false, approval: false }, { kind: "hang" }]] } });
    child.answerGuard(() => deny());
    await child.log.next("ready");
    const end = await child.turn("in-1", "干活");
    expect(end.outcome).toBe("aborted");
    expect(child.log.ofType("guard_request")[0]).toMatchObject({ toolCallId: "c-1", toolName: "bash" });
    // 已经执行了：这是拦不住的那一类，照实记
    expect(child.server.executed).toHaveLength(1);
  });

  it("看图：实测过钩子，映射成 read 判路径，只有一条记录；判不放行就没看，模型收到原因", async () => {
    const { log, child } = await run([{ kind: "image_view", path: "D:\\a.png", id: "i-1" }, { kind: "reply", text: "好" }]);
    expect(log.ofType("guard_request")).toHaveLength(1);
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolName: "read", args: { path: "D:\\a.png" }, native: { toolName: "view_image", args: { path: "D:\\a.png" } } });
    expect(log.ofType("tool_call_start")).toHaveLength(1);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "i-1", toolName: "read", isError: false });
    expect(child.logs.join("\n")).not.toContain("钩子没拦到");

    const denied = await run([{ kind: "image_view", path: "D:\\secret.png", id: "i-2" }, { kind: "reply", text: "好" }], () => deny("不许看"));
    expect(denied.server.toolResults.get("i-2")).toBe("不许看");
    expect(denied.log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "i-2", isError: true, resultText: "不许看" });
  });

  it("派子代理：实测过钩子，判不放行就不派；放行了挂在派它的那次下面，子代理里的命令照常过钩子", async () => {
    const { log, server } = await run([{ kind: "collab", id: "c-1", steps: [{ kind: "command", command: "rm x", id: "sub-1" }] }, { kind: "reply", text: "好" }], (request) => (request.toolName === "bash" ? deny() : { allow: true }));
    expect(log.ofType("guard_request").map((r) => r.toolName)).toEqual(["spawnAgent", "bash"]);
    expect(log.ofType("guard_request")[0]).toMatchObject({ args: { prompt: "看看", task_name: "worker" }, native: { toolName: "collaborationspawn_agent" } });
    expect(server.executed).toEqual([]);
    expect(log.ofType("tool_call_end").find((e) => e.toolCallId === "sub-1")).toMatchObject({ parentToolCallId: "c-1", isError: true });
    expect(log.ofType("tool_call_end").find((e) => e.toolCallId === "c-1")).toMatchObject({ toolName: "spawnAgent", isError: false, resultText: "/root/worker" });

    const denied = await run([{ kind: "collab", id: "c-2", steps: [{ kind: "command", command: "echo 不该跑", id: "sub-2" }] }, { kind: "reply", text: "好" }], () => deny("不许派"));
    expect(denied.server.toolResults.get("c-2")).toBe("不许派");
    expect(denied.server.executed).toEqual([]);
  });

  it("钩子报的工具名把命名空间拼在前面（实测）：sleep、子代理工具换成登记表里的名字；MCP 不动", () => {
    expect(toGuardCall("a", "clocksleep", { duration_ms: 100 })).toMatchObject({ toolName: "sleep", args: { durationMs: 100 }, native: { toolName: "clocksleep" } });
    expect(toGuardCall("b", "clockcurr_time", {})).toMatchObject({ toolName: "curr_time" });
    expect(toGuardCall("c", "collaborationlist_agents", {})).toMatchObject({ toolName: "listAgents" });
    expect(toGuardCall("d", "collaborationwait_agent", { timeout_ms: 1 })).toMatchObject({ toolName: "wait", args: { timeout_ms: 1 } });
    expect(toGuardCall("e", "multi_agent_v1spawn_agent", { message: "看看" })).toMatchObject({ toolName: "spawnAgent", args: { prompt: "看看" } });
    expect(toGuardCall("f", "view_image", { path: "x.png" })).toMatchObject({ toolName: "read", args: { path: "x.png" } });
    expect(toGuardCall("g", "mcp__clockwork__sleep", { a: 1 })).toMatchObject({ toolName: "mcp__clockwork__sleep", args: { a: 1 } });
    expect(toGuardCall("h", "create_goal", { objective: "x" })).toMatchObject({ toolName: "create_goal", args: { objective: "x" } });
  });

  it("Codex 自带的、钩子看得到的工具都登记了（不会被当成未登记的写操作去问用户）", () => {
    const names = new Set(CODEX_GUARD_TOOLS.map((tool) => tool.name));
    for (const hookName of ["clocksleep", "clockcurr_time", "get_goal", "create_goal", "update_goal", "request_user_input", "request_user_input_async", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "collaborationspawn_agent", "collaborationfollowup_task", "collaborationsend_message", "collaborationwait_agent", "collaborationinterrupt_agent", "collaborationlist_agents"]) {
      expect(names).toContain(toGuardCall("x", hookName, {}).toolName);
    }
  });

  it("过了钩子、没有条目的调用（goal 这一类，实测）：下一次用量通知时按没出错收尾，不留到轮次结束记成出错；真的执行了", async () => {
    const { log, server } = await run([{ kind: "itemless", name: "get_goal", id: "g-1" }, { kind: "reply", text: "看过了" }, { kind: "reply", text: "好" }]);
    expect(server.executed).toEqual([{ tool: "get_goal", input: {} }]);
    expect(log.ofType("tool_call_end")).toEqual([{ type: "tool_call_end", toolCallId: "g-1", toolName: "get_goal", isError: false, resultText: "" }]);
    const reports = log.reports.map((r) => r.type);
    expect(reports.indexOf("tool_call_end")).toBeLessThan(reports.lastIndexOf("usage"));
  });

  it("没有条目、这一轮又没有用量通知的：轮次结束时也按没出错收尾；打断的还是写没等到结果", async () => {
    const { log } = await run([{ kind: "itemless", name: "update_goal", args: { status: "complete" }, id: "g-2" }]);
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "g-2", isError: false, resultText: "" });
  });

  it("钩子跑失败（实测 Codex 接着往下走）：日志写明原因；审批接住，判定用模型写的那句，不是外壳包好的；不放行回 decline，原因记在结果上", async () => {
    const child = startCodexChild({ server: { hookFails: true, turns: [[{ kind: "command", command: "Remove-Item keep.txt", id: "c-1" }, { kind: "reply", text: "好" }]] } });
    child.answerGuard(() => deny("不许删"));
    await child.log.next("ready");
    await child.turn("in-1", "干活");
    expect(child.logs.join("\n")).toContain("守卫钩子跑失败了：hook exited with code 1");
    expect(child.log.ofType("guard_request")).toHaveLength(1);
    expect(child.log.ofType("guard_request")[0]).toMatchObject({ toolName: "bash", args: { command: "Remove-Item keep.txt" } });
    expect(child.server.executed).toEqual([]);
    expect(child.log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "c-1", isError: true, resultText: expect.stringContaining("不许删") });
  });

  describe("模型写了 workdir（钩子看不到，条目和审批的 cwd 才是真的目录）：补判一次", () => {
    const OTHER = "E:\\elsewhere\\sub";
    const denyCwd = (request: { toolCallId: string }): GuardVerdict => (request.toolCallId.endsWith("#cwd") ? deny("不许在外面删") : { allow: true });
    const start = (steps: FakeStep[], session: Parameters<typeof startCodexChild>[0] = {}) => startCodexChild({ ...session, server: { turns: [steps] } });
    /** 等过事后打断的那一小会儿（guard.ts 的 AUDIT_INTERRUPT_DELAY_MS） */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    it("判不放行：审批回 decline，没执行；补判自己一条记录，原因也写在这条命令的记录上", async () => {
      const child = start([{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]);
      child.answerGuard(denyCwd);
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.server.executed).toEqual([]);
      expect(child.log.ofType("guard_request").map((r) => [r.toolCallId, r.args])).toEqual([
        ["c-1", { command: "Remove-Item keep.txt" }],
        ["c-1#cwd", { command: 'cd "E:/elsewhere/sub" && Remove-Item keep.txt' }],
      ]);
      expect(child.log.ofType("guard_request")[1]).toMatchObject({ native: { toolName: "Bash", args: { command: "Remove-Item keep.txt", workdir: OTHER } } });
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "c-1#cwd")).toMatchObject({ isError: true, resultText: "不许在外面删" });
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "c-1")).toMatchObject({ isError: true, resultText: expect.stringContaining("不许在外面删") });
      // 审批接住了，不用事后打断
      await settle();
      expect(child.logs.join("\n")).not.toContain("打断这一轮");
      expect(child.server.callsOf("turn/interrupt")).toHaveLength(0);
    });

    it("放行：执行了；每条开始、结束各报一次", async () => {
      const child = start([{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]);
      child.answerGuard();
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.server.executed).toHaveLength(1);
      expect(child.log.ofType("tool_call_start").map((s) => s.toolCallId)).toEqual(["c-1", "c-1#cwd"]);
      expect(child.log.ofType("tool_call_end").map((e) => [e.toolCallId, e.isError])).toEqual([["c-1#cwd", false], ["c-1", false]]);
    });

    it("审批要等补判回来才答复：判定没回之前没有执行，也不打断", async () => {
      const child = start([{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]);
      await child.log.next("ready");
      child.send({ type: "user_input", inputId: "in-1", text: "干活" });
      const first = await child.log.next("guard_request");
      child.send({ type: "guard_reply", requestId: first.requestId, verdict: { allow: true } });
      const second = await child.log.next("guard_request");
      expect(second.toolCallId).toBe("c-1#cwd");
      await settle();
      expect(child.server.executed).toEqual([]);
      expect(child.server.callsOf("turn/interrupt")).toHaveLength(0);
      child.send({ type: "guard_reply", requestId: second.requestId, verdict: { allow: true } });
      expect((await child.log.next("turn_end")).outcome).toBe("completed");
      expect(child.server.executed).toHaveLength(1);
    });

    it("判了要改参数：审批改不了，回 decline，写明", async () => {
      const child = start([{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]);
      child.answerGuard((request) => (request.toolCallId.endsWith("#cwd") ? { allow: true, args: { command: "dir" } } : { allow: true }));
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.server.executed).toEqual([]);
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "c-1")).toMatchObject({ isError: true, resultText: expect.stringContaining("审批改不了") });
    });

    it("没有审批的（execpolicy 放行）：已经跑了，判了不放行打断这一轮，写日志；放行不打断", async () => {
      const child = start([{ kind: "command", command: "type secret.txt", id: "c-1", approval: false, workdir: OTHER }, { kind: "hang" }]);
      child.answerGuard(denyCwd);
      await child.log.next("ready");
      expect((await child.turn("in-1", "干活")).outcome).toBe("aborted");
      expect(child.server.executed).toHaveLength(1);
      expect(child.server.callsOf("turn/interrupt")).toHaveLength(1);
      expect(child.logs.join("\n")).toContain("事后核对判了不放行");

      const fine = start([{ kind: "command", command: "type a.txt", id: "c-1", approval: false, workdir: OTHER }, { kind: "reply", text: "好" }]);
      fine.answerGuard();
      await fine.log.next("ready");
      expect((await fine.turn("in-1", "干活")).outcome).toBe("completed");
      expect(fine.log.ofType("guard_request").map((r) => r.toolCallId)).toEqual(["c-1", "c-1#cwd"]);
      expect(fine.server.callsOf("turn/interrupt")).toHaveLength(0);
    });

    it("和工作目录相同：不多一条记录；盘符大小写、斜杠方向、末尾分隔符、短文件名都不算不同", async () => {
      // 系统临时目录常是短文件名（CATMAN~1）：负责人的工作目录照它写，真实路径算同一个
      const cwd = makeTempDir("ergo-codex-same-");
      const same = [cwd, cwd.replaceAll("\\", "/"), `${cwd}\\`, cwd.toUpperCase(), cwd.toLowerCase(), fs.realpathSync.native(cwd)];
      const steps: FakeStep[] = [...same.map((workdir, index): FakeStep => ({ kind: "command", command: `echo ${index}`, id: `c-${index}`, workdir })), { kind: "reply", text: "好" }];
      const child = startCodexChild({ server: { turns: [steps] }, session: { cwd } });
      child.answerGuard();
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.server.executed).toHaveLength(same.length);
      expect(child.log.ofType("guard_request")).toHaveLength(same.length);
      expect(child.log.ofType("guard_request").filter((r) => r.toolCallId.endsWith("#cwd"))).toEqual([]);
    });

    it("钩子跑失败：两次判定都在审批这里等，判的是模型写的那句", async () => {
      const child = startCodexChild({ server: { hookFails: true, turns: [[{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]] } });
      child.answerGuard(denyCwd);
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.server.executed).toEqual([]);
      expect(child.log.ofType("guard_request").map((r) => r.args)).toEqual([{ command: "Remove-Item keep.txt" }, { command: 'cd "E:/elsewhere/sub" && Remove-Item keep.txt' }]);
    });

    it("钩子按计划改过参数：补判的是改过的那句（实际跑的）", async () => {
      const child = start([{ kind: "command", command: "Remove-Item keep.txt", id: "c-1", workdir: OTHER }, { kind: "reply", text: "好" }]);
      child.answerGuard((request) => (request.toolCallId === "c-1" ? { allow: true, args: { command: "Remove-Item plan.txt" } } : { allow: true }));
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.log.ofType("guard_request")[1]).toMatchObject({ toolCallId: "c-1#cwd", args: { command: 'cd "E:/elsewhere/sub" && Remove-Item plan.txt' } });
    });

    it("不接守卫的会话：不补判", async () => {
      const child = start([{ kind: "command", command: "dir", id: "c-1", approval: false, hook: false, workdir: OTHER }, { kind: "reply", text: "好" }], { session: { forwardToolCalls: false } });
      await child.log.next("ready");
      await child.turn("in-1", "干活");
      expect(child.log.ofType("guard_request")).toEqual([]);
    });
  });

  it("模型写的反斜杠路径：守卫看到正斜杠（按 Git Bash 拆时反斜杠是转义），执行的、native 里的还是原样", async () => {
    const { log, server } = await run([{ kind: "command", command: "Remove-Item .\\sub\\a.txt", id: "c-1" }, { kind: "reply", text: "好" }]);
    expect(log.ofType("guard_request")[0]).toMatchObject({ args: { command: "Remove-Item ./sub/a.txt" }, native: { args: { command: "Remove-Item .\\sub\\a.txt" } } });
    expect(server.executed).toEqual([{ tool: "Bash", input: { command: "Remove-Item .\\sub\\a.txt" } }]);
  });

  it("几条连着写的命令（commandActions 不止一条）不拆，照外壳包好的判", () => {
    const wrapped = `"powershell.exe" -Command 'a; b'`;
    expect(innerCommand({ command: wrapped, commandActions: [{ type: "unknown", command: "a" }, { type: "unknown", command: "b" }] })).toBe(wrapped);
    expect(innerCommand({ command: wrapped, commandActions: [{ type: "read", command: "Get-Content a.txt", name: "a.txt", path: "a.txt" }] })).toBe("Get-Content a.txt");
    expect(innerCommand({ command: wrapped })).toBe(wrapped);
  });
});

describe("二狗的工具（stdio MCP 中转）", () => {
  const tools: HostToolSpec[] = [
    { name: "submit_plan", description: "提交计划", parameters: { type: "object", properties: { plan: { type: "string" } } } },
    { name: "mcp__gh__list_prs", description: "列 PR", parameters: { type: "object" } },
  ];

  it("全部交给 Codex；调用先过守卫（工具名是二狗的），放行才发 host_tool_call，结果照 MCP 交回；报回的名字是二狗的", async () => {
    const child = startCodexChild({ session: { contributions: { tools, contextBlocks: [], hooks: [] } }, server: { turns: [[{ kind: "echo" }, { kind: "tool", name: "submit_plan", args: { plan: "先修" }, id: "h-1" }, { kind: "tool", name: "mcp__gh__list_prs", args: {}, id: "h-2" }, { kind: "reply", text: "交了" }]] } });
    child.answerGuard();
    child.answerHostTool((call) => ({ text: `${call.toolName} 做好了`, isError: false }));
    await child.log.next("ready");
    expect((await child.turn("in-1", "干活")).outcome).toBe("completed");

    const finals = child.log.ofType("message_final");
    const echo = JSON.parse((finals[0]!.message.parts[0] as { text: string }).text) as { mcpTools: string[] };
    expect(echo.mcpTools).toEqual(["mcp__ergo__submit_plan", "mcp__ergo__gh__list_prs"]);

    expect(child.log.ofType("guard_request").map((r) => [r.toolCallId, r.toolName, r.args])).toEqual([
      ["h-1", "submit_plan", { plan: "先修" }],
      ["h-2", "mcp__gh__list_prs", {}],
    ]);
    expect(child.log.ofType("host_tool_call").map((c) => [c.toolCallId, c.toolName])).toEqual([
      ["h-1", "submit_plan"],
      ["h-2", "mcp__gh__list_prs"],
    ]);
    expect(child.log.ofType("tool_call_end").map((e) => [e.toolCallId, e.toolName, e.isError, e.resultText])).toEqual([
      ["h-1", "submit_plan", false, "submit_plan 做好了"],
      ["h-2", "mcp__gh__list_prs", false, "mcp__gh__list_prs 做好了"],
    ]);
    expect(child.server.toolResults.get("h-1")).toBe("submit_plan 做好了");
  });

  it("不放行：不发 host_tool_call，说明交给模型，调用记出错", async () => {
    const child = startCodexChild({ session: { contributions: { tools, contextBlocks: [], hooks: [] } }, server: { turns: [[{ kind: "tool", name: "submit_plan", args: { plan: "x" }, id: "h-1" }, { kind: "reply", text: "好" }]] } });
    child.answerGuard(() => deny("计划不对"));
    await child.log.next("ready");
    await child.turn("in-1", "干活");
    expect(child.log.ofType("host_tool_call")).toEqual([]);
    expect(child.server.toolResults.get("h-1")).toBe("计划不对");
    expect(child.log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "h-1", toolName: "submit_plan", isError: true });
  });

  it("按计划改了参数：发 host_tool_call 用改过的；resultPrefix 加在结果前面；收下的插话随 host_tool_call 报", async () => {
    const child = startCodexChild({ session: { contributions: { tools, contextBlocks: [], hooks: [] } }, server: { turns: [[{ kind: "tool", name: "submit_plan", args: { plan: "x" }, id: "h-1" }, { kind: "reply", text: "好" }]] } });
    child.answerGuard(() => ({ allow: true, args: { plan: "改过的" }, resultPrefix: "改了" }));
    child.answerHostTool(() => ({ text: "好了", isError: false }));
    await child.log.next("ready");
    await child.turn("in-1", "干活");
    expect(child.log.ofType("host_tool_call")[0]).toMatchObject({ args: { plan: "改过的" } });
    expect(child.server.toolResults.get("h-1")).toBe("改了\n好了");
  });

  it("打断时在等的按回合已中止，之后才到的结果扔掉不报错", async () => {
    const child = startCodexChild({ session: { contributions: { tools, contextBlocks: [], hooks: [] } }, server: { turns: [[{ kind: "tool", name: "submit_plan", args: { plan: "x" }, id: "h-1" }]] } });
    child.answerGuard();
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "干活" });
    const call = await child.log.next("host_tool_call");
    child.send({ type: "abort" });
    await child.log.next("turn_end");
    child.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "太晚了", isError: false } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.log.ofType("error")).toEqual([]);
    expect(child.server.toolResults.get("h-1") ?? "回合已中止").toBe("回合已中止");
  });
});

describe("映射（纯函数）", () => {
  it("Codex 的工具 → 守卫的工具", () => {
    expect(toGuardCall("1", "Bash", { command: "ls" })).toMatchObject({ toolName: "bash", args: { command: "ls" } });
    expect(toGuardCall("1", "mcp__s__t", { a: 1 })).toMatchObject({ toolName: "mcp__s__t", args: { a: 1 } });
    // 看不出改哪些文件的不写路径，名字换掉，照未登记的写操作判
    expect(toGuardCall("1", "apply_patch", { command: "乱七八糟" })).toMatchObject({ toolName: "apply_patch_unparsed", args: { patch: "乱七八糟" } });
    expect(pathsOfPatch("*** Begin Patch\n*** End Patch")).toBeUndefined();
  });

  it("守卫改过的参数换回去；换不回去是 undefined", () => {
    const bash = toGuardCall("1", "Bash", { command: "ls", timeout: 5 });
    expect(fromGuardArgs(bash, { command: "dir" })).toEqual({ command: "dir", timeout: 5 });
    expect(fromGuardArgs(bash, { other: 1 })).toBeUndefined();
    const patch = toGuardCall("1", "apply_patch", { command: "*** Add File: a\n" });
    expect(fromGuardArgs(patch, { patch: "新的" })).toEqual({ command: "新的" });
    expect(fromGuardArgs(patch, { adds: ["b"] })).toBeUndefined();
    const mcp = toGuardCall("1", "mcp__s__t", { a: 1 });
    expect(fromGuardArgs(mcp, { a: 2 })).toEqual({ a: 2 });
  });
});
