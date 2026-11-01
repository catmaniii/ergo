// Codex 的工具调用都过二狗守卫（用户第 4 条决定，ADR-0046）：适配子进程、钩子脚本（真的经 cmd /C ergo-guard-hook 拉起）、MCP 中转都是真的，app-server 是假的。
// 三个口子：PreToolUse 钩子（主闸口）、审批请求、item/started 上的事后核对；这里逐个核对"判不放行时真的没执行"，以及拦不住的那几样照实记录、打断。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromGuardArgs, toGuardCall } from "../../src/codex/child/guard.ts";
import { pathsOfPatch } from "../../src/codex/child/translator.ts";
import type { GuardVerdict, HostToolSpec } from "../../src/runtime/index.ts";
import { startCodexChild } from "../helpers/codex-child.ts";
import type { FakeStep } from "../helpers/fake-codex-app-server.ts";

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

  it("往终端里送输入：映射成 write_stdin 过守卫；不放行没送", async () => {
    const { log, server } = await run([{ kind: "write_stdin", id: "s-1", input: "y\n" }, { kind: "reply", text: "好" }], () => deny());
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

  it("看图（Codex 自己做）：映射成 read 记录", async () => {
    const { log } = await run([{ kind: "image_view", path: "D:\\a.png", id: "i-1" }, { kind: "reply", text: "好" }]);
    expect(log.ofType("guard_request")[0]).toMatchObject({ toolName: "read", args: { path: "D:\\a.png" }, native: { toolName: "view_image" } });
    expect(log.ofType("tool_call_end")[0]).toMatchObject({ toolCallId: "i-1", toolName: "read", isError: false });
  });

  it("派子代理：事后过守卫、记录；子代理里的命令照常过钩子", async () => {
    const { log, server } = await run([{ kind: "collab", id: "c-1", steps: [{ kind: "command", command: "rm x", id: "sub-1" }] }, { kind: "reply", text: "好" }], (request) => (request.toolName === "bash" ? deny() : { allow: true }));
    expect(log.ofType("guard_request").map((r) => r.toolName)).toEqual(["spawnAgent", "bash"]);
    expect(server.executed).toEqual([]);
    expect(log.ofType("tool_call_end").find((e) => e.toolCallId === "sub-1")).toMatchObject({ parentToolCallId: "c-1", isError: true });
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
