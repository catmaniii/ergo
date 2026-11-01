// 适配子进程这一头的本机通道：Codex 拉起的钩子（guard-hook.ts）和 MCP 中转（mcp-relay.ts）都连回这里。Windows 上是命名管道，不占端口。
// 一条连接一问一答（bridge-client.ts）；对面断开就中止那次调用（MCP 的取消、Codex 退出）。带一个随机 token，只认自己拉起的。
// @i18n-ignore-file log
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface BridgeHandlers {
  /** 钩子来的一次 PreToolUse：交回写给 Codex 的 JSON */
  hook(payload: Record<string, unknown>): Promise<unknown>;
  /** MCP 的 tools/list */
  list(): unknown;
  /** MCP 的 tools/call：交回 MCP 的结果；signal 是这次调用被取消了 */
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  log(line: string): void;
}

export interface Bridge {
  pipe: string;
  token: string;
  close(): Promise<void>;
}

function pipeName(id: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\ergo-codex-${id}` : path.join(os.tmpdir(), `ergo-codex-${id}.sock`);
}

/** 开通道（等它能连了才交回） */
export function openBridge(handlers: BridgeHandlers): Promise<Bridge> {
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(16).toString("hex");
  const pipe = pipeName(id);
  const sockets = new Set<net.Socket>();

  const serve = async (line: string, signal: AbortSignal): Promise<unknown> => {
    const message = JSON.parse(line) as { token?: string; kind?: string; payload?: Record<string, unknown>; name?: unknown; args?: unknown };
    if (message.token !== token) throw new Error("token 不对");
    switch (message.kind) {
      case "hook":
        return handlers.hook(message.payload ?? {});
      case "list":
        return handlers.list();
      case "call":
        return handlers.call(typeof message.name === "string" ? message.name : "", message.args, signal);
      default:
        throw new Error(`不认识的请求：${String(message.kind)}`);
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at < 0) return;
      const line = buf.slice(0, at);
      buf = "";
      serve(line, controller.signal).then(
        (reply) => socket.end(`${JSON.stringify(reply ?? null)}\n`),
        (err: unknown) => {
          handlers.log(`本机通道上一次请求出错：${err instanceof Error ? err.message : String(err)}`);
          socket.destroy();
        },
      );
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      controller.abort();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => {
      server.off("error", reject);
      resolve({
        pipe,
        token,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
