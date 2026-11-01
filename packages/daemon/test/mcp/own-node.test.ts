// 登记的 MCP 的 command 写 node（377 号票）：一行命令装的电脑 PATH 上可能根本没有 node，要换成二狗自己那份，和项目服务同一条规矩：
// - PATH 上没有 node：command 写 node 的照样起得来、调得通；
// - 写的是绝对路径：原样用，不换（给一份不存在的"二狗那份"，它照样起得来）。
// 都是真的闸门进程和假 MCP 服务（fixtures/fake-mcp-server.mjs），环境里的 PATH 指一个空目录。
// 别的程序、带路径的 node、不给 nodePath 的原样不动（ownNodeProgram）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createMcpService } from "../../src/mcp/mcp.ts";
import { ownNodeProgram } from "../../src/process/own-node.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FAKE_MCP_SERVER } from "../helpers/toolkit.ts";

/** 守护进程的环境，只是 PATH 换成一个空目录：上面找不到 node */
function envWithoutNode(): Record<string, string | undefined> {
  const kept = Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH");
  return { ...Object.fromEntries(kept), PATH: makeTempDir("ergo-empty-path-") };
}

function setup(command: string, nodePath: string) {
  const file = path.join(makeTempDir("ergo-mcp-node-"), "mcp.json");
  const tools = { status: { title: "看状态", readOnlyOrIdempotent: true, network: false } };
  fs.writeFileSync(file, JSON.stringify({ servers: { demo: { command, args: [FAKE_MCP_SERVER], tools } } }));
  const mcp = createMcpService({ file, parentEnv: envWithoutNode(), nodePath, cwd: makeTempDir("ergo-mcp-node-cwd-"), newJob: () => undefined, callTimeoutMs: 10_000, log: () => {} });
  onTestFinished(() => mcp.stop());
  return mcp;
}

describe("MCP 的 command 写 node", () => {
  it.each(["node", "node.exe"])("PATH 上没有 node 时 command 写 %s 用二狗自己那份：起得来、调得通", async (command) => {
    const mcp = setup(command, process.execPath);
    const probed = await mcp.probe("demo", 15_000);
    expect(probed.problem).toBeUndefined();
    expect(probed.tools).toContain("status");
    expect(await mcp.call("demo", "status", {})).toEqual({ text: "一切正常（假 MCP 的状态）", isError: false });
  }, 30_000);

  it("写的是绝对路径：原样用，不换成二狗那份", async () => {
    const mcp = setup(process.execPath, path.join(makeTempDir("ergo-no-own-node-"), "node.exe"));
    expect((await mcp.probe("demo", 15_000)).problem).toBeUndefined();
  }, 30_000);

  it("只有程序写的就是 node 才换（不加引号：不经 shell），别的原样；不给 nodePath 原样", () => {
    const own = String.raw`C:\Program Files\ergo\node.exe`;
    for (const written of ["node", "node.exe", "NODE", "Node.EXE", " node "]) expect(ownNodeProgram(written, own)).toBe(own);
    for (const kept of [String.raw`D:\tools\node.exe`, "/usr/bin/node", "./node", "nodemon", "node-red", "npx", "npm", "python", "uvx", "node server.js", "   "]) expect(ownNodeProgram(kept, own)).toBe(kept);
    expect(ownNodeProgram("node", undefined)).toBe("node");
  });
});
