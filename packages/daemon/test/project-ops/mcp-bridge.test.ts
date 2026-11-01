// 项目自动转的 MCP 的 stdio 转发程序（ADR-0045）：单独拉起真进程，对面是本机的假接口，不起守护进程。
// 说的是标准 MCP（每行一个 JSON-RPC）；只转工具名、参数、调用者，验收用的测试标记不转；连不上、被拒不崩；调用被中止时断开请求；stdin 关了就退出。
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import readline from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { OPS_MCP_BRIDGE } from "../../src/project-ops/index.ts";

interface Seen {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** 假接口：记下收到的；answer 决定回什么（不回就一直挂着，看中止） */
async function fakeDaemon(answer: (body: Record<string, unknown>, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const gone: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push({ authorization: req.headers.authorization, body });
      res.once("close", () => {
        if (!res.writableFinished) gone.push(String(body.name));
      });
      answer(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/project-ops-mcp`, seen, gone };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** 拉起转发程序；request 发一条等它回 */
function startBridge(env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, [OPS_MCP_BRIDGE], { env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  onTestFinished(() => void child.kill());
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    waiting.get(message.id as number)?.(message);
  });
  let next = 1;
  const send = (message: object) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  return { child, send, request, nextId: () => next };
}

describe("项目自动转的 MCP 的转发程序", () => {
  it("说标准 MCP：initialize、ping、tools/list、tools/call；带凭证问本机接口；只转工具名、参数、调用者，测试标记转不过去", async () => {
    const tools = [{ name: "add_expense", title: "记一笔", description: "记一笔账", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }];
    const daemon = await fakeDaemon((body, res) => json(res, 200, body.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "记好了" }], isError: false, structuredContent: { say: "记好了" } }));
    const bridge = startBridge({ ERGO_OPS_MCP_URL: daemon.url, ERGO_OPS_MCP_TOKEN: "fake-bridge-credential" });

    expect((await bridge.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ergo-project-ops" } });
    bridge.send({ method: "notifications/initialized" });
    expect((await bridge.request("ping")).result).toEqual({});
    expect((await bridge.request("tools/list")).result).toEqual({ tools });
    expect((await bridge.request("tools/call", { name: "add_expense", arguments: { amount: 32 }, _meta: { "ergo/caller": { agentId: "tm-1", toolCallId: "c-1" }, "ergo/test": true } })).result).toEqual({ content: [{ type: "text", text: "记好了" }], isError: false, structuredContent: { say: "记好了" } });

    expect(daemon.seen.map((s) => s.authorization)).toEqual(["Bearer fake-bridge-credential", "Bearer fake-bridge-credential"]);
    expect(daemon.seen.map((s) => s.body)).toEqual([{ method: "tools/list" }, { method: "tools/call", name: "add_expense", arguments: { amount: 32 }, caller: { agentId: "tm-1", toolCallId: "c-1" } }]);
    expect((await bridge.request("resources/list")).error).toMatchObject({ code: -32601 });
  });

  it("被拒、连不上：tools/list 回 JSON-RPC 的错，tools/call 回 isError 的结果，进程不退；没给环境变量说清楚", async () => {
    const daemon = await fakeDaemon((_body, res) => json(res, 401, { code: "unauthorized", message: "凭证不对" }));
    const refused = startBridge({ ERGO_OPS_MCP_URL: daemon.url, ERGO_OPS_MCP_TOKEN: "fake-bridge-credential" });
    expect((await refused.request("tools/list")).error).toMatchObject({ code: -32603, message: expect.stringContaining("401：凭证不对") });
    expect((await refused.request("tools/call", { name: "x" })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("401：凭证不对") }] });

    const offline = startBridge({ ERGO_OPS_MCP_URL: "http://127.0.0.1:1/api/project-ops-mcp", ERGO_OPS_MCP_TOKEN: "fake-bridge-credential" });
    expect((await offline.request("tools/call", { name: "x" })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("连不上二狗") }] });
    expect((await offline.request("ping")).result).toEqual({});

    const bare = startBridge({});
    expect((await bare.request("tools/list")).error).toMatchObject({ message: expect.stringContaining("ERGO_OPS_MCP_TOKEN") });
  });

  it("调用被中止：断开这次请求（守护进程那边跟着中止）；stdin 关了就退出", async () => {
    const daemon = await fakeDaemon(() => {});
    const bridge = startBridge({ ERGO_OPS_MCP_URL: daemon.url, ERGO_OPS_MCP_TOKEN: "fake-bridge-credential" });
    const id = bridge.nextId();
    const result = bridge.request("tools/call", { name: "slow" });
    await expect.poll(() => daemon.seen.length).toBe(1);
    bridge.send({ method: "notifications/cancelled", params: { requestId: id } });
    expect((await result).result).toMatchObject({ isError: true, content: [{ text: "调用被中止了" }] });
    await expect.poll(() => daemon.gone).toEqual(["slow"]);

    const exited = new Promise<number | null>((resolve) => bridge.child.once("exit", resolve));
    bridge.child.stdin!.end();
    expect(await exited).toBe(0);
  });
});
