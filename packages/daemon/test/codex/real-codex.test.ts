// 真机核对（默认跳过，ERGO_TEST_REAL_CODEX=1 才跑，Codex 升级后重跑）：真的 codex 程序 + 真的适配子进程、钩子、MCP 中转 + 本机假模型（helpers/fake-responses-model.ts）。
// 不连 OpenAI、不花钱、不碰 ~/.codex，都钉在装配里（helpers/real-codex.ts）。这里的每条断言都是 0.166 上实测到的行为，假 app-server（helpers/fake-codex-app-server.ts）照它写；
// 红了说明 Codex 变了：先看变成什么样，再改适配子进程、假 app-server 和手册的"守卫管到哪"。
// 模型两种说话方式都要测：gpt-5.5 直接调函数；gpt-6.x、gpt-5.6（默认模型 gpt-6.1-sol）只给一个 exec，工具在它的 JS 里调（代码模式）。
// 跑：ERGO_TEST_REAL_CODEX=1 npx vitest run packages/daemon/test/codex/real-codex.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ERGO_MCP_SERVER } from "../../src/codex/child/host-tools.ts";
import type { CodexSessionInfo } from "../../src/codex/sessions-protocol.ts";
import type { GuardVerdict, HostToolSpec, RuntimeHistory } from "../../src/runtime/index.ts";
import { type ModelOutput, type ModelRequest, textOfInputItem } from "../helpers/fake-responses-model.ts";
import { type RealChild, RealCodexLab, startRealChild } from "../helpers/real-codex.ts";

const DIRECT = "gpt-5.5";
const CODE_MODE = "gpt-6.1-sol";
const REPORT: HostToolSpec = { name: "report_progress", description: "汇报进展", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let seq = 0;
const command = (cmd: string, extra: Record<string, unknown> = {}): ModelOutput => ({ kind: "call", name: "exec_command", args: { cmd, ...extra } });
const patch = (body: string): ModelOutput => ({ kind: "custom", name: "apply_patch", input: `*** Begin Patch\n${body}\n*** End Patch\n` });
const say = (text: string): ModelOutput => ({ kind: "text", text });
/** 函数调用，id 给定（要按 id 核对钩子和条目） */
const call = (name: string, args: Record<string, unknown>, id: string, namespace?: string): ModelOutput => ({ kind: "raw", item: { type: "function_call", name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), call_id: id, status: "completed" } });
const search = (query: string): ModelOutput => ({ kind: "raw", item: { type: "tool_search_call", call_id: `search_${++seq}`, execution: "client", status: "completed", arguments: { query, limit: 5 } } });
/** 代码模式的一格 JS */
const cell = (source: string): ModelOutput => ({ kind: "raw", item: { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: `cell_${++seq}`, status: "completed", input: source } });

/** 发给模型的那一轮里，工具的结果（调用 id → 文字） */
function toolOutputs(request: ModelRequest): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const item of request.body.input as Array<{ type?: string; call_id?: string; output?: unknown }>) {
    if (item.type?.endsWith("_output") && item.call_id) outputs.set(item.call_id, textOfInputItem(item));
  }
  return outputs;
}

/** 发给模型的对话（用户和助手说的，不含环境说明） */
function conversation(request: ModelRequest): string[] {
  return (request.body.input as Array<{ role?: string }>)
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => `${String(item.role)}:${textOfInputItem(item)}`)
    .filter((line) => !line.includes("<environment_context>"));
}

/** 这次调用在线路上的顺序：钩子跑了没有、条目来了没有、要审批没有 */
function wireOf(lab: RealCodexLab, id: string): { hook: number; item: number; approval: number; hookStatus: string | undefined } {
  let hook = -1;
  let item = -1;
  let approval = -1;
  let hookStatus: string | undefined;
  lab.wire.forEach((message, at) => {
    const params = message.params ?? {};
    const run = params.run as { id?: string; status?: string } | undefined;
    if (message.method === "hook/started" && run?.id?.endsWith(`:${id}`) && hook < 0) hook = at;
    if (message.method === "hook/completed" && run?.id?.endsWith(`:${id}`)) hookStatus = run.status;
    if (message.method === "item/started" && (params.item as { id?: string } | undefined)?.id === id && item < 0) item = at;
    if (message.method?.endsWith("/requestApproval") && params.itemId === id && approval < 0) approval = at;
  });
  return { hook, item, approval, hookStatus };
}

const noGuardTrouble = (child: RealChild) => {
  const logs = child.logs.join("\n");
  expect(logs).not.toContain("钩子没拦到");
  expect(logs).not.toContain("守卫钩子跑失败了");
};

/** 起一个适配子进程，等它 ready */
async function ready(lab: RealCodexLab, tools: HostToolSpec[] = [REPORT], session: Parameters<typeof startRealChild>[1] = {}): Promise<RealChild> {
  const child = startRealChild(lab, { session: { contributions: { tools, contextBlocks: [], hooks: [] }, ...session.session } });
  child.answerHostTool((request) => ({ text: `二狗执行了 ${request.toolName}：${JSON.stringify(request.args)}`, isError: false }));
  await child.log.next("ready", 90_000);
  return child;
}

/** 开一个 shell，再往里送一条删文件的命令 */
const openShell = (tty: boolean) => [
  { outputs: [call("exec_command", { cmd: "powershell -NoProfile -NoLogo", tty, yield_time_ms: 500 }, "sh_1")] },
  (request: ModelRequest) => {
    const session = /session ID (\d+)/i.exec(String((request.body.input as Array<{ output?: unknown }>).at(-1)?.output ?? ""))?.[1];
    return { outputs: [call("write_stdin", { session_id: Number(session ?? 1), chars: "Remove-Item keep.txt\r\nexit\r\n", yield_time_ms: 2000 }, "sh_2")] };
  },
  { outputs: [say("好了")] },
];

describe.skipIf(process.env.ERGO_TEST_REAL_CODEX !== "1")("真的 codex + 假模型（0.166 实测）", () => {
  it("第一轮：回复进二狗、任务完成、用量对；钩子第一次信任后记下来；二狗的系统提示、上下文块、这条输入的上下文都到了模型；所有请求都没出本机", async () => {
    const lab = await RealCodexLab.open(DIRECT);
    const child = startRealChild(lab, { session: { contributions: { tools: [REPORT], contextBlocks: [{ id: "block", text: "上下文块BLOCKMARK" }], hooks: [] } } });
    await child.log.next("ready", 90_000);
    expect(fs.existsSync(path.join(lab.root, "runtime", "hook-trust.json"))).toBe(true);
    expect((await child.log.next("runtime_catalog", 30_000)).models?.map((m) => m.id)).toContain(DIRECT);

    lab.model.queue({ outputs: [say("你好")], usage: { input: 300, cached: 100, output: 40 } });
    child.send({ type: "user_input", inputId: "in-1", text: "回一句你好", context: "这条的上下文CTXMARK" });
    expect((await child.log.next("turn_end", 60_000)).outcome).toBe("completed");

    expect(child.log.ofType("stream_delta").map((d) => d.delta).join("")).toBe("你好");
    expect(child.log.ofType("message_final").at(-1)).toMatchObject({ message: { role: "assistant", parts: [{ type: "text", text: "你好" }], stopReason: "done" } });
    expect(child.log.ofType("usage")).toMatchObject([{ input: 200, cacheRead: 100, output: 40, totalTokens: 340, modelId: DIRECT }]);

    const all = JSON.stringify(lab.model.last.body.input);
    expect(all).toContain("MARKER_ERGO_APPEND");
    expect(all).toContain("BLOCKMARK");
    expect(all).toContain("CTXMARK");
    expect(conversation(lab.model.last).at(-1)).toBe("user:回一句你好");
    // 只连过假模型：别的出口也钉在它身上，收到的只有它自己的路径
    expect(lab.model.requests.every((r) => r.path.startsWith("/"))).toBe(true);
    expect(fs.existsSync(path.join(lab.home, "sessions"))).toBe(true);
  }, 180_000);

  describe("命令、改文件、MCP 都先到钩子：一次调用一条记录，tool_use_id 和条目 id 一致", () => {
    it("直接调函数的模型", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [say("先看目录"), call("exec_command", { cmd: "echo hello > made.txt" }, "cmd_1")] },
        { outputs: [{ kind: "custom", name: "apply_patch", input: "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n", callId: "patch_1" }] },
        { outputs: [search("report_progress 进展")] },
        { outputs: [call("report_progress", { note: "写好了" }, "mcp_1", `mcp__${ERGO_MCP_SERVER}`)] },
        { outputs: [say("好了")] },
      );
      expect((await child.turn("in-1", "做点事")).outcome).toBe("completed");

      expect(fs.readFileSync(lab.file("a.txt"), "utf8").trim()).toBe("hello");
      expect(fs.existsSync(lab.file("made.txt"))).toBe(true);
      noGuardTrouble(child);

      const requests = child.log.ofType("guard_request");
      expect(requests.map((r) => [r.toolCallId, r.toolName])).toEqual([
        ["cmd_1", "bash"],
        ["patch_1", "apply_patch"],
        ["mcp_1", "report_progress"],
      ]);
      // 判定用的是模型写的那句，不是外壳包好的
      expect(requests[0]).toMatchObject({ args: { command: "echo hello > made.txt" }, native: { toolName: "Bash", args: { command: "echo hello > made.txt" } } });
      expect(requests[1]).toMatchObject({ args: { adds: ["a.txt"], updates: [], deletes: [] } });
      expect(requests[2]).toMatchObject({ args: { note: "写好了" }, native: { toolName: "mcp__ergo__report_progress" } });
      expect(child.log.ofType("tool_call_start").map((s) => s.toolCallId)).toEqual(["cmd_1", "patch_1", "mcp_1"]);
      expect(child.log.ofType("tool_call_end").map((e) => [e.toolCallId, e.isError])).toEqual([
        ["cmd_1", false],
        ["patch_1", false],
        ["mcp_1", false],
      ]);
      expect(child.log.ofType("host_tool_call")).toMatchObject([{ toolCallId: "mcp_1", toolName: "report_progress", args: { note: "写好了" } }]);

      for (const id of ["cmd_1", "patch_1"]) {
        const order = wireOf(lab, id);
        expect(order.hook).toBeGreaterThanOrEqual(0);
        expect(order.hook).toBeLessThan(order.item);
        expect(order.item).toBeLessThan(order.approval);
      }
      // 二狗的工具过钩子（不判，放行）再由中转判；Codex 不再为它们要审批
      expect(wireOf(lab, "mcp_1")).toMatchObject({ hookStatus: "completed", approval: -1 });
      expect(toolOutputs(lab.model.last).get("mcp_1")).toContain("二狗执行了 report_progress");
    }, 180_000);

    it("代码模式（默认模型）：exec 外层不过钩子，里面嵌套的每次调用都过，调用 id 是 exec-<uuid>，和条目一致", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [cell('const r = await tools.exec_command({cmd: "echo nested > nested.txt"}); text(JSON.stringify(r));')] },
        { outputs: [cell('const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: nested2.txt\\n+x\\n*** End Patch\\n"); text(JSON.stringify(r));')] },
        { outputs: [cell(`const names = ALL_TOOLS.map((t) => t.name); text(JSON.stringify(names)); text(JSON.stringify(await tools.mcp__${ERGO_MCP_SERVER}__report_progress({note: "嵌套调"})));`)] },
        { outputs: [say("好了")] },
      );
      expect((await child.turn("in-1", "做点事")).outcome).toBe("completed");

      expect(fs.existsSync(lab.file("nested.txt"))).toBe(true);
      expect(fs.existsSync(lab.file("nested2.txt"))).toBe(true);
      noGuardTrouble(child);
      const requests = child.log.ofType("guard_request");
      expect(requests.map((r) => r.toolName)).toEqual(["bash", "apply_patch", "report_progress"]);
      for (const request of requests) expect(request.toolCallId).toMatch(/^exec-/);
      for (const id of [requests[0]!.toolCallId, requests[1]!.toolCallId]) {
        const order = wireOf(lab, id);
        expect(order.hook).toBeGreaterThanOrEqual(0);
        expect(order.hook).toBeLessThan(order.item);
        expect(order.item).toBeLessThan(order.approval);
      }
      expect(child.log.ofType("tool_call_start")).toHaveLength(3);
      // 工具清单在 exec 的说明里（additional_tools），MCP 工具不用搜，tools 上直接能调
      const outputs = [...toolOutputs(lab.model.last).values()].join("\n");
      expect(outputs).toContain("mcp__ergo__report_progress");
      expect(outputs).toContain("二狗执行了 report_progress");
    }, 180_000);
  });

  describe("判不放行：没执行，模型收到原因", () => {
    const reason = "二狗不让动它DENYMARK";

    it("直接调函数：命令、补丁、看图、二狗的工具", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      fs.writeFileSync(lab.file("keep2.txt"), "keep2");
      fs.writeFileSync(lab.file("pic.png"), Buffer.from(PNG, "base64"));
      const child = await ready(lab);
      child.answerGuard(() => ({ allow: false, reason }));
      lab.model.queue(
        { outputs: [call("exec_command", { cmd: "Remove-Item keep.txt" }, "del_1")] },
        { outputs: [{ kind: "custom", name: "apply_patch", input: "*** Begin Patch\n*** Delete File: keep2.txt\n*** End Patch\n", callId: "del_2" }] },
        { outputs: [call("view_image", { path: lab.file("pic.png") }, "see_1")] },
        { outputs: [search("report_progress 进展")] },
        { outputs: [call("report_progress", { note: "不该到" }, "mcp_1", `mcp__${ERGO_MCP_SERVER}`)] },
        { outputs: [say("没动成")] },
      );
      expect((await child.turn("in-1", "删掉它们")).outcome).toBe("completed");

      expect(fs.existsSync(lab.file("keep.txt"))).toBe(true);
      expect(fs.existsSync(lab.file("keep2.txt"))).toBe(true);
      expect(child.log.ofType("host_tool_call")).toEqual([]);
      const outputs = toolOutputs(lab.model.last);
      for (const id of ["del_1", "del_2", "see_1", "mcp_1"]) expect(outputs.get(id)).toContain(reason);
      expect(outputs.get("del_1")).toContain("blocked by PreToolUse hook");
      expect(outputs.get("see_1")).not.toContain("input_image");
      expect(child.log.ofType("tool_call_end").map((e) => [e.toolCallId, e.isError])).toEqual([
        ["del_1", true],
        ["del_2", true],
        ["see_1", true],
        ["mcp_1", true],
      ]);
      // 钩子拦下的没有条目、不要审批
      for (const id of ["del_1", "del_2", "see_1"]) expect(wireOf(lab, id)).toMatchObject({ hookStatus: "blocked", item: -1, approval: -1 });
      expect(child.log.ofType("guard_request").map((r) => r.toolName)).toEqual(["bash", "apply_patch", "read", "report_progress"]);
    }, 180_000);

    it("代码模式：exec 里嵌套的调用抛错，原因在错误里；文件还在", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      const child = await ready(lab);
      child.answerGuard(() => ({ allow: false, reason }));
      lab.model.queue({ outputs: [cell('try { text("结果:" + JSON.stringify(await tools.exec_command({cmd: "Remove-Item keep.txt"}))); } catch (e) { text("抛错:" + String(e)); }')] }, { outputs: [say("没动成")] });
      expect((await child.turn("in-1", "删掉它")).outcome).toBe("completed");
      expect(fs.existsSync(lab.file("keep.txt"))).toBe(true);
      expect([...toolOutputs(lab.model.last).values()].join("\n")).toContain(`抛错:Command blocked by PreToolUse hook: ${reason}`);
    }, 180_000);
  });

  it("判放行且改参数：按改过的执行，原来的没跑（命令、补丁）", async () => {
    const lab = await RealCodexLab.open(DIRECT);
    const child = await ready(lab);
    child.answerGuard((request) => {
      if (request.toolName === "bash") return { allow: true, args: { command: "echo rewritten > rewritten.txt" } };
      if (request.toolName === "apply_patch") return { allow: true, args: { patch: "*** Begin Patch\n*** Add File: patched-new.txt\n+new\n*** End Patch\n" } };
      return { allow: true };
    });
    lab.model.queue(
      { outputs: [command("echo original > original.txt")] },
      { outputs: [patch("*** Add File: patched-old.txt\n+old")] },
      { outputs: [say("好了")] },
    );
    expect((await child.turn("in-1", "写文件")).outcome).toBe("completed");
    expect(fs.readdirSync(lab.work).toSorted()).toEqual(["patched-new.txt", "rewritten.txt"]);
    noGuardTrouble(child);
  }, 180_000);

  it("只读的命令也都过钩子，Windows 上 untrusted 也都要审批（没有'判成只读不问'这回事）", async () => {
    const lab = await RealCodexLab.open(DIRECT);
    fs.writeFileSync(lab.file("a.txt"), "hello");
    const child = await ready(lab);
    const commands = ["dir", "git status", "Get-ChildItem", "Get-Content a.txt", "ls", "echo hi"];
    lab.model.queue(...commands.map((cmd, at) => ({ outputs: [call("exec_command", { cmd }, `ro_${at}`)] })), { outputs: [say("好了")] });
    expect((await child.turn("in-1", "看看")).outcome).toBe("completed");
    noGuardTrouble(child);
    expect(child.log.ofType("guard_request").map((r) => (r.args as { command: string }).command)).toEqual(commands);
    commands.forEach((_, at) => {
      const order = wireOf(lab, `ro_${at}`);
      expect(order.hook).toBeGreaterThanOrEqual(0);
      expect(order.hook).toBeLessThan(order.item);
      expect(order.approval).toBeGreaterThan(order.item);
    });
    // 输出进了记录（条目完成时的 aggregatedOutput）
    expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "ro_3")).toMatchObject({ isError: false, resultText: expect.stringContaining("hello") });
  }, 180_000);

  describe("模型写了 workdir：钩子看不到，条目和审批里才有真的目录，补判一次（调用 id 是 <id>#cwd）", () => {
    /** 工作目录外面的一个文件夹，里面有个文件 */
    const elsewhere = (lab: RealCodexLab): string => {
      const other = path.join(lab.root, "other");
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "keep.txt"), "别删我KEEPMARK");
      return other;
    };
    const denyCwd = (reason: string) => (request: { toolCallId: string }): GuardVerdict => (request.toolCallId.endsWith("#cwd") ? { allow: false, reason } : { allow: true });
    const cwdChecks = (child: RealChild) => child.log.ofType("guard_request").filter((r) => r.toolCallId.endsWith("#cwd"));
    const forGuard = (dir: string) => dir.replaceAll("\\", "/");

    it("判不放行：审批等补判的结果回 decline，那个文件夹里的文件还在；两条记录，原因写在记录上", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const other = elsewhere(lab);
      const child = await ready(lab);
      child.answerGuard(denyCwd("不许在外面删REASON"));
      lab.model.queue({ outputs: [call("exec_command", { cmd: "Remove-Item keep.txt", workdir: other }, "wd_1")] }, { outputs: [say("没删成")] });
      expect((await child.turn("in-1", "删")).outcome).toBe("completed");

      expect(fs.existsSync(path.join(other, "keep.txt"))).toBe(true);
      noGuardTrouble(child);
      // 钩子先看到模型写的那句（没有目录），条目和审批才有真的目录
      const wire = wireOf(lab, "wd_1");
      expect(wire.hook).toBeLessThan(wire.item);
      expect(wire.item).toBeLessThan(wire.approval);
      expect(lab.methods("item/commandExecution/requestApproval")[0]!.params?.cwd).toBe(other);
      const requests = child.log.ofType("guard_request");
      expect(requests.map((r) => r.toolCallId)).toEqual(["wd_1", "wd_1#cwd"]);
      expect(requests[0]).toMatchObject({ toolName: "bash", args: { command: "Remove-Item keep.txt" } });
      expect(requests[1]).toMatchObject({ toolName: "bash", args: { command: `cd "${forGuard(other)}" && Remove-Item keep.txt` }, native: { args: { command: "Remove-Item keep.txt", workdir: other } } });
      const ends = child.log.ofType("tool_call_end");
      expect(ends.find((e) => e.toolCallId === "wd_1#cwd")).toMatchObject({ isError: true, resultText: "不许在外面删REASON" });
      expect(ends.find((e) => e.toolCallId === "wd_1")).toMatchObject({ isError: true, resultText: expect.stringContaining("不许在外面删REASON") });
      // decline 说不了原因，模型收到的是它自己的话
      expect(toolOutputs(lab.model.last).get("wd_1")).toContain("rejected");
    }, 180_000);

    it("放行：真的在那个文件夹执行；补判那条没出错", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const other = elsewhere(lab);
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("exec_command", { cmd: "Remove-Item keep.txt; echo x > w.txt", workdir: other }, "wd_2")] }, { outputs: [say("好了")] });
      expect((await child.turn("in-1", "删")).outcome).toBe("completed");

      expect(fs.existsSync(path.join(other, "keep.txt"))).toBe(false);
      expect(fs.existsSync(path.join(other, "w.txt"))).toBe(true);
      expect(fs.existsSync(lab.file("w.txt"))).toBe(false);
      noGuardTrouble(child);
      // 几条连着写的：补判用钩子看到的那句，不是外壳包好的
      expect(cwdChecks(child).map((r) => r.args)).toEqual([{ command: `cd "${forGuard(other)}" && Remove-Item keep.txt; echo x > w.txt` }]);
      const ends = child.log.ofType("tool_call_end");
      expect(ends.find((e) => e.toolCallId === "wd_2#cwd")).toMatchObject({ isError: false });
      expect(ends.find((e) => e.toolCallId === "wd_2")).toMatchObject({ isError: false });
    }, 180_000);

    it("和工作目录相同（盘符大小写、斜杠、末尾分隔符不同也算）：不多一条记录", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      const dirs = [lab.work, forGuard(lab.work), `${lab.work}\\`, lab.work.charAt(0).toLowerCase() + lab.work.slice(1), lab.work.toUpperCase()];
      lab.model.queue(...dirs.map((workdir, index) => ({ outputs: [call("exec_command", { cmd: `echo x > same${index}.txt`, workdir }, `wd_same_${index}`)] })), { outputs: [say("好了")] });
      expect((await child.turn("in-1", "写")).outcome).toBe("completed");

      dirs.forEach((_, index) => expect(fs.existsSync(lab.file(`same${index}.txt`))).toBe(true));
      expect(cwdChecks(child)).toEqual([]);
      expect(child.log.ofType("guard_request")).toHaveLength(dirs.length);
      noGuardTrouble(child);
    }, 180_000);

    it("相对路径的 workdir：条目和审批里是解析好的绝对路径，一样补判；工作目录里面的放行时也记一条", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.mkdirSync(lab.file("sub"));
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("exec_command", { cmd: "echo x > w.txt", workdir: "sub" }, "wd_rel")] }, { outputs: [say("好了")] });
      expect((await child.turn("in-1", "写")).outcome).toBe("completed");

      expect(fs.existsSync(path.join(lab.file("sub"), "w.txt"))).toBe(true);
      expect(lab.methods("item/commandExecution/requestApproval")[0]!.params?.cwd).toBe(lab.file("sub"));
      expect(cwdChecks(child).map((r) => r.args)).toEqual([{ command: `cd "${forGuard(lab.file("sub"))}" && echo x > w.txt` }]);
    }, 180_000);

    it("只读命令（dir、Get-Content、git status）也要审批，一样拦得下：读不到内容", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const other = elsewhere(lab);
      const child = await ready(lab);
      child.answerGuard(denyCwd("不许读外面的"));
      lab.model.queue(
        { outputs: [call("exec_command", { cmd: "Get-Content keep.txt", workdir: other }, "wd_gc")] },
        { outputs: [call("exec_command", { cmd: "type keep.txt", workdir: other }, "wd_type")] },
        { outputs: [call("exec_command", { cmd: "dir", workdir: other }, "wd_dir")] },
        { outputs: [call("exec_command", { cmd: "git status", workdir: other }, "wd_git")] },
        { outputs: [say("没读到")] },
      );
      expect((await child.turn("in-1", "读")).outcome).toBe("completed");

      for (const id of ["wd_gc", "wd_type", "wd_dir", "wd_git"]) {
        expect(wireOf(lab, id).approval).toBeGreaterThan(wireOf(lab, id).item);
        const output = toolOutputs(lab.model.last).get(id);
        expect(output).toContain("rejected");
        expect(output).not.toContain("KEEPMARK");
      }
    }, 180_000);

    it("用户自己的 execpolicy 放行的命令没有审批：已经跑了，判了不放行只能打断这一轮（照实写进手册）", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.mkdirSync(path.join(lab.home, "rules"), { recursive: true });
      fs.writeFileSync(path.join(lab.home, "rules", "default.rules"), 'prefix_rule(pattern=["cmd", "/c", "type"], decision="allow")\n');
      const other = elsewhere(lab);
      const child = await ready(lab);
      child.answerGuard(denyCwd("不许读外面的"));
      lab.model.queue({ outputs: [call("exec_command", { cmd: "cmd /c type keep.txt", workdir: other }, "wd_rule")] }, { outputs: [say("读完了")], hold: true });
      child.send({ type: "user_input", inputId: "in-1", text: "读" });
      const end = await child.log.next("turn_end", 60_000);
      lab.model.release();

      expect(end.outcome).toBe("aborted");
      expect(wireOf(lab, "wd_rule").approval).toBe(-1);
      expect(child.logs.join("\n")).toContain("事后核对判了不放行");
      expect(cwdChecks(child)).toHaveLength(1);
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "wd_rule#cwd")).toMatchObject({ isError: true, resultText: "不许读外面的" });
    }, 180_000);

    it("代码模式（默认模型）里嵌套调用写 workdir：一样补判，不放行没执行", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const other = elsewhere(lab);
      const child = await ready(lab);
      child.answerGuard(denyCwd("不许REASON"));
      lab.model.queue({ outputs: [cell(`try { text("结果:" + JSON.stringify(await tools.exec_command({cmd: "Remove-Item keep.txt", workdir: ${JSON.stringify(other)}}))); } catch (e) { text("抛错:" + String(e)); }`)] }, { outputs: [say("没动成")] });
      expect((await child.turn("in-1", "删")).outcome).toBe("completed");

      expect(fs.existsSync(path.join(other, "keep.txt"))).toBe(true);
      noGuardTrouble(child);
      expect(cwdChecks(child).map((r) => r.args)).toEqual([{ command: `cd "${forGuard(other)}" && Remove-Item keep.txt` }]);
    }, 180_000);

    it("子代理里写 workdir：补判那条也挂在派它的那次下面，不放行没执行", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const other = elsewhere(lab);
      const child = await ready(lab);
      child.answerGuard(denyCwd("子代理也不行"));
      let sub = 0;
      lab.model.route = (request) => {
        const meta = (request.body.client_metadata as Record<string, string> | undefined)?.["x-codex-turn-metadata"];
        const agent = meta ? (JSON.parse(meta) as { agent_name?: string }).agent_name : undefined;
        if (agent === undefined || agent === "/root") return undefined;
        sub += 1;
        if (sub === 1) return { outputs: [cell(`try { await tools.exec_command({cmd: "Remove-Item keep.txt", workdir: ${JSON.stringify(other)}}); } catch (e) { text(String(e)); }`)] };
        return { outputs: [say("子代理做完了")] };
      };
      lab.model.queue({ outputs: [call("spawn_agent", { task_name: "worker", message: "删" }, "t_spawn", "collaboration")] }, { outputs: [call("wait_agent", { timeout_ms: 30000 }, "t_wait", "collaboration")] }, { outputs: [say("好了")] });
      expect((await child.turn("in-1", "派一个")).outcome).toBe("completed");

      expect(fs.existsSync(path.join(other, "keep.txt"))).toBe(true);
      noGuardTrouble(child);
      const [check] = cwdChecks(child);
      expect(check).toBeDefined();
      expect(child.log.ofType("tool_call_start").find((s) => s.toolCallId === check!.toolCallId)).toMatchObject({ parentToolCallId: "t_spawn" });
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === check!.toolCallId)).toMatchObject({ isError: true, parentToolCallId: "t_spawn" });
    }, 180_000);

    it("模型写的 PowerShell 路径：守卫看到的是正斜杠，模型写的原样在 native，真的执行的还是原样", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.mkdirSync(lab.file("sub"));
      fs.writeFileSync(lab.file("sub\\a.txt"), "a");
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("exec_command", { cmd: "Remove-Item .\\sub\\a.txt" }, "wd_ps")] }, { outputs: [say("好了")] });
      expect((await child.turn("in-1", "删")).outcome).toBe("completed");

      expect(fs.existsSync(lab.file("sub\\a.txt"))).toBe(false);
      expect(child.log.ofType("guard_request")[0]).toMatchObject({ args: { command: "Remove-Item ./sub/a.txt" }, native: { args: { command: "Remove-Item .\\sub\\a.txt" } } });
    }, 180_000);
  });

  describe("Codex 自带的别的工具（票里按'大概率不过钩子'写的，实测）", () => {
    it("看图、goal、MCP 资源：都过钩子；名字映射到登记表；没有条目的按没出错收尾", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.writeFileSync(lab.file("pic.png"), Buffer.from(PNG, "base64"));
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [call("view_image", { path: lab.file("pic.png") }, "t_view")] },
        { outputs: [call("get_goal", {}, "t_goal")] },
        { outputs: [call("create_goal", { objective: "目标" }, "t_new_goal")] },
        { outputs: [call("list_mcp_resources", {}, "t_res")] },
        { outputs: [call("list_mcp_resource_templates", {}, "t_tpl")] },
        { outputs: [call("request_user_input", { questions: [{ id: "q", header: "选", question: "选哪个", options: [{ label: "甲", description: "" }, { label: "乙", description: "" }] }] }, "t_ask")] },
        { outputs: [say("好了")] },
      );
      expect((await child.turn("in-1", "试试")).outcome).toBe("completed");
      noGuardTrouble(child);
      const ids = ["t_view", "t_goal", "t_new_goal", "t_res", "t_tpl", "t_ask"];
      for (const id of ids) expect(wireOf(lab, id).hook).toBeGreaterThanOrEqual(0);
      const names = Object.fromEntries(child.log.ofType("guard_request").map((r) => [r.toolCallId, r.toolName]));
      expect(names).toEqual({ t_view: "read", t_goal: "get_goal", t_new_goal: "create_goal", t_res: "list_mcp_resources", t_tpl: "list_mcp_resource_templates", t_ask: "request_user_input" });
      // 没有条目的：get_goal、create_goal、request_user_input
      for (const id of ["t_goal", "t_new_goal", "t_ask"]) expect(wireOf(lab, id).item).toBe(-1);
      for (const end of child.log.ofType("tool_call_end")) expect(end.isError).toBe(false);
      expect(child.log.ofType("tool_call_end").map((e) => e.toolCallId).toSorted()).toEqual(ids.toSorted());
      // 同步提问只有 Plan 模式能用（二狗不用 Plan 模式）：Codex 自己回不可用，不发 item/tool/requestUserInput
      expect(lab.methods("item/tool/requestUserInput")).toEqual([]);
      expect(toolOutputs(lab.model.last).get("t_ask")).toContain("unavailable in Default mode");
    }, 180_000);

    it("不过钩子、也没有条目：tool_search（只读工具说明，二狗记不到）；update_plan 这版已经没有了", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [{ kind: "raw", item: { type: "tool_search_call", call_id: "ts_1", execution: "client", status: "completed", arguments: { query: "report_progress", limit: 5 } } }] },
        { outputs: [call("update_plan", { plan: [{ step: "一步", status: "pending" }] }, "t_plan")] },
        { outputs: [say("好了")] },
      );
      expect((await child.turn("in-1", "试试")).outcome).toBe("completed");
      expect(wireOf(lab, "ts_1")).toMatchObject({ hook: -1, item: -1 });
      expect(child.log.ofType("guard_request")).toEqual([]);
      expect(toolOutputs(lab.model.last).get("t_plan")).toContain("unsupported call: update_plan");
      const tools = (lab.model.turns[0]!.body.tools as Array<{ name?: string; type?: string }>).map((t) => t.name ?? t.type);
      expect(tools).not.toContain("update_plan");
    }, 180_000);

    it("二狗的工具是延迟加载的：直接调函数的模型不搜就调回 unsupported call（系统提示里写明先搜）", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("mcp__ergo__report_progress", { note: "没搜" }, "t_direct")] }, { outputs: [say("好了")] });
      await child.turn("in-1", "试试");
      expect(toolOutputs(lab.model.last).get("t_direct")).toContain("unsupported call");
      expect(child.log.ofType("host_tool_call")).toEqual([]);
      expect(JSON.stringify(lab.model.last.body.input)).toContain("tool_search");
      const tools = lab.model.last.body.tools as Array<{ type?: string; description?: string; name?: string }>;
      expect(tools.map((t) => t.name)).not.toContain("mcp__ergo__report_progress");
      expect(tools.find((t) => t.type === "tool_search")?.description).toContain("ergo");
    }, 180_000);

    it("sleep、看子代理、看时间（代码模式的模型才有）：过钩子，钩子报的名字把命名空间拼在前面，换成登记表里的；exec 外层和 wait 不过钩子", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [call("sleep", { duration_ms: 100 }, "t_sleep", "clock")] },
        { outputs: [call("list_agents", {}, "t_agents", "collaboration")] },
        { outputs: [cell("text(JSON.stringify(await tools.clock__curr_time({})));")] },
        { outputs: [call("request_user_input_async", { questions: [{ title: "问一句", options: ["a", "b"] }] }, "t_async", "functions")] },
        { outputs: [cell('// @exec: {"yield_time_ms": 100}\nawait new Promise((r) => setTimeout(r, 1500)); text("done");')] },
        (request) => {
          const running = /cell ID (\d+)/.exec(JSON.stringify((request.body.input as unknown[]).at(-1)))?.[1];
          return { outputs: [call("wait", { cell_id: running ?? "1", yield_time_ms: 3000 }, "t_wait", "functions")] };
        },
        { outputs: [say("好了")] },
      );
      expect((await child.turn("in-1", "试试")).outcome).toBe("completed");
      noGuardTrouble(child);
      const requests = child.log.ofType("guard_request");
      expect(requests.map((r) => r.toolName)).toEqual(["sleep", "listAgents", "curr_time", "request_user_input_async"]);
      expect(requests[0]).toMatchObject({ args: { durationMs: 100 }, native: { toolName: "clocksleep" } });
      expect(wireOf(lab, "t_wait")).toMatchObject({ hook: -1, item: -1 });
      for (const end of child.log.ofType("tool_call_end")) expect(end.isError).toBe(false);
      // 异步提问：问题变成一条消息，立刻返回
      expect(toolOutputs(lab.model.last).get("t_async")).toContain("accepted");
      expect(child.log.ofType("message_final").flatMap((m) => m.message.parts).filter((p) => p.type === "text").map((p) => p.text).join("\n")).toContain("问一句");
    }, 180_000);

    it("派子代理：spawn_agent 过钩子，子线程里的命令也过钩子、审批也送到二狗、挂在派它的那次下面；子代理的用量也记", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const child = await ready(lab);
      child.answerGuard((request) => (String((request.args as { command?: string }).command).includes("forbidden") ? { allow: false, reason: "子代理也不行" } : { allow: true }));
      let sub = 0;
      lab.model.route = (request) => {
        const meta = (request.body.client_metadata as Record<string, string> | undefined)?.["x-codex-turn-metadata"];
        const agent = meta ? (JSON.parse(meta) as { agent_name?: string }).agent_name : undefined;
        if (agent === undefined || agent === "/root") return undefined;
        sub += 1;
        if (sub === 1) return { outputs: [cell('text(JSON.stringify(await tools.exec_command({cmd: "echo sub > sub.txt"})));')], usage: { input: 70, output: 7 } };
        if (sub === 2) return { outputs: [cell('try { await tools.exec_command({cmd: "echo forbidden > no.txt"}); } catch (e) { text(String(e)); }')], usage: { input: 70, output: 7 } };
        return { outputs: [say("子代理做完了")], usage: { input: 70, output: 7 } };
      };
      lab.model.queue(
        { outputs: [call("spawn_agent", { task_name: "worker", message: "写 sub.txt" }, "t_spawn", "collaboration")], usage: { input: 10, output: 1 } },
        { outputs: [call("wait_agent", { timeout_ms: 30000 }, "t_wait", "collaboration")], usage: { input: 10, output: 1 } },
        { outputs: [say("好了")], usage: { input: 10, output: 1 } },
      );
      expect((await child.turn("in-1", "派一个")).outcome).toBe("completed");

      expect(fs.existsSync(lab.file("sub.txt"))).toBe(true);
      expect(fs.existsSync(lab.file("no.txt"))).toBe(false);
      noGuardTrouble(child);
      const requests = child.log.ofType("guard_request");
      expect(requests.filter((r) => r.toolName === "spawnAgent")).toMatchObject([{ toolCallId: "t_spawn", args: { prompt: "写 sub.txt", task_name: "worker" } }]);
      expect(requests.filter((r) => r.toolName === "wait")).toMatchObject([{ toolCallId: "t_wait" }]);
      const subCalls = child.log.ofType("tool_call_start").filter((s) => s.toolName === "bash");
      expect(subCalls.map((s) => s.parentToolCallId)).toEqual(["t_spawn", "t_spawn"]);
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "t_spawn")).toMatchObject({ toolName: "spawnAgent", isError: false, resultText: "/root/worker" });
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === subCalls[0]!.toolCallId)).toMatchObject({ isError: false, parentToolCallId: "t_spawn" });
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === subCalls[1]!.toolCallId)).toMatchObject({ isError: true, parentToolCallId: "t_spawn" });
      const totals = child.log.ofType("usage").map((u) => u.totalTokens);
      expect(totals.filter((n) => n === 77)).toHaveLength(3);
      expect(totals.filter((n) => n === 11)).toHaveLength(3);
      expect(child.log.ofType("message_final").flatMap((m) => m.message.parts).filter((p) => p.type === "text").map((p) => p.text)).not.toContain("子代理做完了");
    }, 180_000);
  });

  describe("往开着的终端里送字符（write_stdin）：不过钩子也不走审批，所以启动时关了 TTY", () => {
    it("不关 TTY 时绕得过守卫（这就是要关的原因）：钩子只看到开 shell，送进去的命令把文件删了，事后才知道、拦不住", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      lab.allowTty = true;
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      const child = await ready(lab);
      lab.model.queue(...openShell(true));
      await child.turn("in-1", "开个 shell");
      expect(fs.existsSync(lab.file("keep.txt"))).toBe(false);
      expect(wireOf(lab, "sh_2")).toMatchObject({ hook: -1, approval: -1 });
      // 只有这个事后通知：记一次、事后核对
      expect(lab.methods("item/commandExecution/terminalInteraction").some((m) => String(m.params?.stdin).includes("Remove-Item"))).toBe(true);
      expect(child.log.ofType("guard_request").find((r) => r.toolName === "write_stdin")).toMatchObject({ args: { input: expect.stringContaining("Remove-Item") } });
      expect(child.logs.join("\n")).toContain("钩子没拦到");
    }, 180_000);

    it("正式的配置（关了 TTY）：要 tty 的被 Codex 回错，送不进去，文件还在", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      const child = await ready(lab);
      lab.model.queue(...openShell(true));
      await child.turn("in-1", "开个 shell");
      expect(fs.existsSync(lab.file("keep.txt"))).toBe(true);
      const outputs = toolOutputs(lab.model.last);
      expect(outputs.get("sh_1")).toContain("TTY execution is disabled");
      expect(outputs.get("sh_2")).toContain("write_stdin failed");
      // 被 Codex 自己拒掉的调用没有条目：不记成出错
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "sh_1")).toMatchObject({ isError: false });
    }, 180_000);

    it("正式的配置：管道模式的长命令 stdin 是关着的，送不进去", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue(
        { outputs: [call("exec_command", { cmd: "Start-Sleep 14; echo done", yield_time_ms: 500 }, "long_1")] },
        (request) => {
          const session = /session ID (\d+)/i.exec(String((request.body.input as Array<{ output?: unknown }>).at(-1)?.output ?? ""))?.[1];
          return { outputs: [call("write_stdin", { session_id: Number(session ?? 1), chars: "echo injected\r\n", yield_time_ms: 500 }, "long_2")] };
        },
        { outputs: [say("好了")] },
      );
      await child.turn("in-1", "跑个长的");
      expect(toolOutputs(lab.model.last).get("long_2")).toMatch(/stdin is closed|Unknown process id/);
      expect(lab.methods("item/commandExecution/terminalInteraction").filter((m) => String(m.params?.stdin).includes("injected"))).toEqual([]);
    }, 180_000);

    it("代码模式同样关掉了", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      const child = await ready(lab);
      lab.model.queue({ outputs: [cell('const r = await tools.exec_command({cmd: "powershell -NoProfile -NoLogo", tty: true, yield_time_ms: 500}); text(JSON.stringify(r));')] }, { outputs: [say("好了")] });
      await child.turn("in-1", "开个 shell");
      expect(fs.existsSync(lab.file("keep.txt"))).toBe(true);
      expect([...toolOutputs(lab.model.last).values()].join("\n")).toContain("TTY execution is disabled");
    }, 180_000);
  });

  describe("联网搜索关掉了", () => {
    it("工具清单里没有；模型硬吐一个：Codex 还是报条目（不过钩子），记录、事后核对", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue({ outputs: [{ kind: "web_search", query: "今天的天气" }, say("搜完了")] });
      expect((await child.turn("in-1", "搜一下")).outcome).toBe("completed");
      const tools = (lab.model.turns[0]!.body.tools as Array<{ name?: string; type?: string }>).map((t) => t.name ?? t.type);
      expect(tools).not.toContain("web_search");
      expect(child.log.ofType("guard_request")).toMatchObject([{ toolName: "web_search", args: { query: "今天的天气" }, native: { toolName: "webSearch" } }]);
      expect(child.logs.join("\n")).toContain("钩子没拦到）：webSearch");
    }, 180_000);

    it("代码模式的工具清单里也没有", async () => {
      const lab = await RealCodexLab.open(CODE_MODE);
      const child = await ready(lab);
      lab.model.queue({ outputs: [cell("text(JSON.stringify(ALL_TOOLS.map((t) => t.name)));")] }, { outputs: [say("好了")] });
      await child.turn("in-1", "看看");
      expect([...toolOutputs(lab.model.last).values()].join("\n")).not.toContain("web_search");
      expect(JSON.stringify(lab.model.turns[0]!.body.tools ?? [])).not.toContain("web_search");
    }, 180_000);

    it("事后核对判不放行：一直在回的这一轮被打断（已经发生的拦不住）", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      child.answerGuard((request) => (request.toolName === "web_search" ? { allow: false, reason: "不许搜" } : { allow: true }));
      lab.model.queue({ outputs: [{ kind: "web_search", query: "今天的天气" }, say("搜完了")], hold: true });
      expect((await child.turn("in-1", "搜一下")).outcome).toBe("aborted");
      expect(child.logs.join("\n")).toContain("事后核对判了不放行");
      lab.model.release();
    }, 180_000);
  });

  it("用户自己的 execpolicy：放行的不要审批，禁止的不执行；钩子都管得到（第 7 条不是缺口）", async () => {
    const lab = await RealCodexLab.open(DIRECT);
    fs.mkdirSync(path.join(lab.home, "rules"), { recursive: true });
    fs.writeFileSync(path.join(lab.home, "rules", "default.rules"), 'prefix_rule(pattern=["cmd", "/c", "echo"], decision="allow")\nprefix_rule(pattern=["cmd", "/c", "type"], decision="forbidden")\n');
    const child = await ready(lab);
    lab.model.queue({ outputs: [call("exec_command", { cmd: "cmd /c echo allowed" }, "rule_1")] }, { outputs: [call("exec_command", { cmd: "cmd /c type nothing" }, "rule_2")] }, { outputs: [say("好了")] });
    await child.turn("in-1", "试试");
    expect(wireOf(lab, "rule_1")).toMatchObject({ approval: -1 });
    expect(wireOf(lab, "rule_1").hook).toBeGreaterThanOrEqual(0);
    expect(wireOf(lab, "rule_2")).toMatchObject({ item: -1, approval: -1 });
    expect(child.log.ofType("guard_request").map((r) => r.toolCallId)).toEqual(["rule_1", "rule_2"]);
    expect(toolOutputs(lab.model.last).get("rule_2")).toContain("policy forbids");
  }, 180_000);

  it("用户自己配的 MCP：过钩子；Codex 要的审批走 elicitation，放行；一条记录", async () => {
    const lab = await RealCodexLab.open(DIRECT);
    const server = path.join(lab.root, "user-mcp.cjs");
    fs.writeFileSync(
      server,
      [
        'let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'const post = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
        'process.stdin.on("data", (c) => { buf += c; let at; while ((at = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, at); buf = buf.slice(at + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id === undefined) continue;',
        '  if (m.method === "initialize") post({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "userx", version: "1" } } });',
        '  else if (m.method === "tools/list") post({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "lookup", description: "查", inputSchema: { type: "object", properties: {} } }] } });',
        '  else if (m.method === "tools/call") post({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "用户的 MCP 执行了" }] } });',
        '  else post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });',
        "} });",
        'process.stdin.on("end", () => process.exit(0));',
      ].join("\n"),
    );
    fs.appendFileSync(path.join(lab.home, "config.toml"), `\n[mcp_servers.userx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\n`);
    const child = await ready(lab);
    lab.model.queue({ outputs: [search("lookup 查")] }, { outputs: [call("lookup", {}, "um_1", "mcp__userx")] }, { outputs: [say("好了")] });
    expect((await child.turn("in-1", "查")).outcome).toBe("completed");
    noGuardTrouble(child);
    expect(child.log.ofType("guard_request")).toMatchObject([{ toolCallId: "um_1", toolName: "mcp__userx__lookup" }]);
    expect(lab.methods("mcpServer/elicitation/request")).toHaveLength(1);
    expect(child.log.ofType("tool_call_end")).toMatchObject([{ toolCallId: "um_1", isError: false, resultText: "用户的 MCP 执行了" }]);
  }, 180_000);

  describe("钩子出问题", () => {
    it("跑失败：Codex 接着往下走（fail open），审批接住：判定用模型写的那句；放行的执行，不放行的没执行；decline 的原因到不了模型，记录上有", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      lab.envOverride = { ERGO_CODEX_HOOK: path.join(lab.root, "没有这个文件.js") };
      fs.writeFileSync(lab.file("keep.txt"), "keep");
      const child = await ready(lab);
      child.answerGuard((request) => (String((request.args as { command?: string }).command).includes("Remove-Item") ? { allow: false, reason: "不许删REASON" } : { allow: true }));
      lab.model.queue({ outputs: [call("exec_command", { cmd: "echo ok > ok.txt" }, "hf_1")] }, { outputs: [call("exec_command", { cmd: "Remove-Item keep.txt" }, "hf_2")] }, { outputs: [say("好了")] });
      expect((await child.turn("in-1", "试试")).outcome).toBe("completed");
      expect(fs.existsSync(lab.file("ok.txt"))).toBe(true);
      expect(fs.existsSync(lab.file("keep.txt"))).toBe(true);
      const logs = child.logs.join("\n");
      expect(logs).toContain("守卫钩子跑失败了：hook exited with code 1");
      expect(child.log.ofType("guard_request").map((r) => (r.args as { command: string }).command)).toEqual(["echo ok > ok.txt", "Remove-Item keep.txt"]);
      expect(wireOf(lab, "hf_2").hookStatus).toBe("failed");
      const output = toolOutputs(lab.model.last).get("hf_2");
      expect(output).toContain("rejected by user");
      expect(output).not.toContain("REASON");
      expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "hf_2")).toMatchObject({ isError: true, resultText: expect.stringContaining("不许删REASON") });
    }, 180_000);

    it("跑失败又被 execpolicy 放行：没有审批可接，已经跑了才知道（缺口：只能事后记录）", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      lab.envOverride = { ERGO_CODEX_HOOK: path.join(lab.root, "没有这个文件.js") };
      fs.mkdirSync(path.join(lab.home, "rules"), { recursive: true });
      fs.writeFileSync(path.join(lab.home, "rules", "default.rules"), 'prefix_rule(pattern=["cmd", "/c", "echo"], decision="allow")\n');
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("exec_command", { cmd: "cmd /c echo ran" }, "hf_3")] }, { outputs: [say("好了")] });
      await child.turn("in-1", "试试");
      expect(child.logs.join("\n")).toContain("钩子没拦到");
      expect(wireOf(lab, "hf_3")).toMatchObject({ approval: -1, hookStatus: "failed" });
      expect(toolOutputs(lab.model.last).get("hf_3")).toContain("ran");
      expect(child.log.ofType("guard_request")).toMatchObject([{ toolCallId: "hf_3", toolName: "bash" }]);
    }, 180_000);

    it("连不上适配子进程：不放行（fail closed），模型收到原因", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      lab.envOverride = { ERGO_CODEX_PIPE: "\\\\.\\pipe\\ergo-codex-no-such-pipe" };
      const child = await ready(lab);
      lab.model.queue({ outputs: [call("exec_command", { cmd: "echo ok > ok.txt" }, "hp_1")] }, { outputs: [say("好了")] });
      await child.turn("in-1", "试试");
      expect(fs.existsSync(lab.file("ok.txt"))).toBe(false);
      expect(toolOutputs(lab.model.last).get("hp_1")).toContain("连不上二狗的守卫");
    }, 180_000);
  });

  describe("接管", () => {
    it("写入锁：别的进程开着（空闲、跑着）时 thread/resume 被拒，状态字段看不出来；分叉不受影响；一次性分叉落了盘；关掉就放开", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const terminal = await lab.terminal();
      const id = await terminal.start();
      expect(await lab.oneShot<{ sessions: CodexSessionInfo[] }>({ op: "list", limit: 10 })).toMatchObject({ sessions: [] }); // 还没落盘
      lab.model.queue({ outputs: [say("记住了，暗号蓝鲸")] }, { outputs: [say("第二轮回复")] });
      await terminal.say(id, "记住暗号蓝鲸");
      await terminal.say(id, "第二轮问题");

      // 列得到，标题、目录都对；开着也报没加载：status 没用，要靠写入锁
      const listed = await lab.oneShot<{ sessions: CodexSessionInfo[] }>({ op: "list", limit: 10 });
      expect(listed.sessions).toMatchObject([{ sessionId: id, title: "记住暗号蓝鲸", cwd: lab.work, loaded: false }]);
      const history = await lab.oneShot<{ history: RuntimeHistory }>({ op: "history", sessionId: id, turns: 40, messages: 60 });
      expect(history.history.items.map((item) => item.kind)).toEqual(["user", "agent", "user", "agent"]);
      expect(history.history.items[0]).toEqual({ kind: "user", text: "记住暗号蓝鲸" });

      // 开着·空闲
      expect(await lab.oneShot({ op: "state", sessionId: id })).toMatchObject({ state: { loaded: true } });
      // 开着·一轮正跑着
      lab.model.queue({ outputs: [say("慢慢想")], hold: true });
      const running = terminal.say(id, "正跑着的一轮");
      for (let i = 0; i < 100 && lab.model.turns.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await lab.oneShot({ op: "state", sessionId: id })).toMatchObject({ state: { loaded: true } });
      const probe = await lab.rpc();
      await expect(probe.rpc.request("thread/resume", { threadId: id, excludeTurns: true })).rejects.toThrow("already has an active writer");
      expect((await probe.rpc.request<{ thread: { status: { type: string } } }>("thread/read", { threadId: id })).thread.status.type).toBe("notLoaded");
      expect(await probe.rpc.request("thread/loaded/list", {})).toMatchObject({ data: [] });
      await probe.close();

      // 适配子进程直接接它：写明先去关掉或者分叉
      const refused = startRealChild(lab, { session: { resumeRuntimeSession: id, continueSession: false } });
      expect(await refused.log.next("error", 60_000)).toMatchObject({ code: "start_failed", message: expect.stringContaining("先在那边关掉，或者分叉一份接管") });
      await refused.shutdown(0);

      // 开着也能分叉；分叉的不列（二狗开的）、原会话不动；一次性进程退了之后 resume 得上（落盘了）
      const fork = await lab.oneShot<{ sessionId: string }>({ op: "fork", sessionId: id, cwd: lab.work });
      expect(fork.sessionId).not.toBe(id);
      lab.model.release();
      await running;
      expect((await lab.oneShot<{ sessions: CodexSessionInfo[] }>({ op: "list", limit: 10 })).sessions.map((s) => s.sessionId)).toEqual([id]);

      const forked = startRealChild(lab, { session: { resumeRuntimeSession: fork.sessionId, continueSession: false, sessionDir: path.join(lab.root, "fork-sessions"), runtimeDir: path.join(lab.root, "fork-runtime") } });
      expect((await forked.log.next("ready", 90_000)).sessionId).toBe(fork.sessionId);
      lab.model.queue({ outputs: [say("暗号是蓝鲸")] });
      expect((await forked.turn("in-1", "暗号是什么")).outcome).toBe("completed");
      const seen = conversation(lab.model.last);
      expect(seen).toContain("user:记住暗号蓝鲸");
      expect(seen.at(-1)).toBe("user:暗号是什么");
      await forked.shutdown(0);

      // 关掉终端：锁放开；探一次不改会话记录
      await terminal.close();
      const rollout = fs.readdirSync(path.join(lab.home, "sessions"), { recursive: true, withFileTypes: true }).find((f) => f.isFile() && f.name.includes(id))!;
      const file = path.join(rollout.parentPath, rollout.name);
      const before = fs.statSync(file);
      expect(await lab.oneShot({ op: "state", sessionId: id })).toMatchObject({ state: { loaded: false } });
      const after = fs.statSync(file);
      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);

      // 关了之后直接接：前情在上下文里，还是原来的 id
      const direct = startRealChild(lab, { session: { resumeRuntimeSession: id, continueSession: false, sessionDir: path.join(lab.root, "direct-sessions"), runtimeDir: path.join(lab.root, "direct-runtime") } });
      expect((await direct.log.next("ready", 90_000)).sessionId).toBe(id);
      lab.model.queue({ outputs: [say("还是蓝鲸")] });
      expect((await direct.turn("in-1", "再问一次")).outcome).toBe("completed");
      expect(conversation(lab.model.last)).toContain("user:第二轮问题");

      // 二狗开着时终端接不了；二狗的子进程退了（交还）就能接
      const outside = await lab.rpc();
      await expect(outside.rpc.request("thread/resume", { threadId: id, excludeTurns: true })).rejects.toThrow("already has an active writer");
      await direct.shutdown(0);
      await expect(outside.rpc.request("thread/resume", { threadId: id, excludeTurns: true })).resolves.toMatchObject({ thread: { id } });
    }, 280_000);

    it("真的 codex exec（命令行）也算写入者；它开的会话 thread/list 默认不列（来源不是交互的）", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const { spawn } = await import("node:child_process");
      const { findCodexEntry } = await import("../../src/codex/install.ts");
      const entry = findCodexEntry(process.env)!;
      lab.model.queue({ outputs: [say("慢慢想")], hold: true });
      const exec = spawn(entry.command, [...entry.args, "exec", "--skip-git-repo-check", "--json", "说点什么"], { env: lab.env, cwd: lab.work, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      exec.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      for (let i = 0; i < 300 && lab.model.turns.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const thread = /"thread_id":"([^"]+)"/.exec(out)?.[1];
      expect(thread).toBeTruthy();
      const probe = await lab.rpc();
      await expect(probe.rpc.request("thread/resume", { threadId: thread, excludeTurns: true })).rejects.toThrow("already has an active writer");
      expect(await probe.rpc.request("thread/list", { limit: 10 })).toMatchObject({ data: [] });
      await probe.close();
      lab.model.release();
      await new Promise((resolve) => exec.once("close", resolve));
    }, 180_000);

    it("撤回（beforeTurnId）：发给模型的上下文真的切掉了；切回废弃分支接着说，上下文是原来的；撤回到开头是新的空会话", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue({ outputs: [say("一号回复")] }, { outputs: [say("二号回复")] }, { outputs: [say("三号回复")] });
      await child.turn("in-1", "第一句");
      await child.turn("in-2", "第二句");
      await child.turn("in-3", "第三句");
      const original = child.log.ofType("ready")[0]!.sessionId;

      child.send({ type: "navigate_session", requestId: "nav-1", target: { beforeInput: "in-2" }, marker: { change: "rewind", entry: "m", at: "2026-11-02T00:00:00.000Z" } } as never);
      const rewound = await child.log.next("session_navigated", 60_000);
      expect(rewound).toMatchObject({ ok: true, from: original });
      lab.model.queue({ outputs: [say("撤回后回复")] });
      await child.turn("in-4", "撤回后问");
      expect(conversation(lab.model.last)).toEqual(["user:第一句", "assistant:一号回复", "user:撤回后问"]);

      child.send({ type: "navigate_session", requestId: "nav-2", target: { entry: original }, marker: { change: "switch", entry: "m", at: "2026-11-02T00:00:00.000Z" } } as never);
      expect(await child.log.next("session_navigated", 60_000)).toMatchObject({ ok: true, at: original });
      lab.model.queue({ outputs: [say("切回后回复")] });
      await child.turn("in-5", "切回后问");
      expect(conversation(lab.model.last)).toEqual(["user:第一句", "assistant:一号回复", "user:第二句", "assistant:二号回复", "user:第三句", "assistant:三号回复", "user:切回后问"]);

      child.send({ type: "navigate_session", requestId: "nav-3", target: { beforeInput: "in-1" }, marker: { change: "rewind", entry: "m", at: "2026-11-02T00:00:00.000Z" } } as never);
      expect(await child.log.next("session_navigated", 60_000)).toMatchObject({ ok: true });
      lab.model.queue({ outputs: [say("开头后回复")] });
      await child.turn("in-6", "重新开始");
      expect(conversation(lab.model.last)).toEqual(["user:重新开始"]);
    }, 180_000);
  });

  describe("轮次里的别的操作", () => {
    it("交接摘要在临时分叉上写：什么工具都不让用，不留下会话；压缩走同一个模型接口；插话进这一轮；打断收尾", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue({ outputs: [say("一号回复")] });
      await child.turn("in-1", "第一句");

      lab.model.queue({ outputs: [call("exec_command", { cmd: "echo sealed > sealed.txt" }, "seal_1")] }, { outputs: [say("这是交接摘要")] });
      child.send({ type: "write_handoff", requestId: "h-1", instructions: "写摘要", timeoutMs: 60_000 });
      expect(await child.log.next("handoff_written", 90_000)).toEqual({ type: "handoff_written", requestId: "h-1", text: "这是交接摘要" });
      expect(fs.existsSync(lab.file("sealed.txt"))).toBe(false);
      expect(toolOutputs(lab.model.last).get("seal_1")).toContain("只写交接摘要");
      expect((await lab.oneShot<{ sessions: CodexSessionInfo[] }>({ op: "list", limit: 10 })).sessions).toEqual([]);

      const before = lab.model.requests.length;
      lab.model.queue({ outputs: [say("压缩摘要内容")] });
      child.send({ type: "compact", reason: "manual" } as never);
      expect(await child.log.next("compacted", 60_000)).toMatchObject({ reason: "manual", outcome: "done" });
      expect(lab.model.requests.slice(before).map((r) => r.path)).toEqual(["/v1/responses"]);
      lab.model.queue({ outputs: [say("压缩后回复")] });
      await child.turn("in-2", "压缩后问");

      lab.model.queue({ outputs: [say("在想")], hold: true }, { outputs: [say("收到插话")] });
      const count = lab.model.turns.length;
      child.send({ type: "user_input", inputId: "in-3", text: "慢慢做" });
      for (let i = 0; i < 200 && lab.model.turns.length === count; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      child.send({ type: "interject", inputId: "in-3b", text: "插一句" });
      for (let i = 0; i < 40 && lab.methods("turn/steer").length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 500));
      lab.model.release();
      expect(await child.log.next("turn_end", 60_000)).toMatchObject({ outcome: "completed", interjected: ["in-3b"] });
      expect(conversation(lab.model.last)).toContain("user:插一句");

      lab.model.queue({ outputs: [say("没说完的话")], hold: true });
      const count2 = lab.model.turns.length;
      child.send({ type: "user_input", inputId: "in-4", text: "这轮要被打断" });
      for (let i = 0; i < 200 && lab.model.turns.length === count2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.send({ type: "abort" });
      expect((await child.log.next("turn_end", 60_000)).outcome).toBe("aborted");
      lab.model.release();
    }, 180_000);

    it("模型服务报错：额度用完（429 usage_limit_reached）、登录过期（401）写明；没登录（要 OpenAI 登录的 provider）不发模型请求就按出错收尾", async () => {
      const lab = await RealCodexLab.open(DIRECT);
      const child = await ready(lab);
      lab.model.queue({ fail: { status: 429, message: "usage limit", type: "usage_limit_reached" } });
      const limited = await child.turn("in-1", "第一句");
      expect(limited).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("额度用完") });
      lab.model.queue({ fail: { status: 401, message: "bad token" } });
      const expired = await child.turn("in-2", "第二句");
      expect(expired).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("codex login") });
      await child.shutdown(0);

      const noLogin = await RealCodexLab.open(DIRECT);
      noLogin.providerAuth = true;
      const blocked = startRealChild(noLogin);
      await blocked.log.next("ready", 90_000);
      expect(await blocked.turn("in-1", "第一句", 60_000)).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("codex login") });
      expect(noLogin.model.turns).toEqual([]);
    }, 180_000);
  });
});
