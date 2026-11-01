// Codex 拉起的两个小程序（guard-hook.ts、mcp-relay.ts）连回适配子进程的那一下：一条连接一问一答，一行 JSON 问、一行 JSON 答。
// 只引 node 自带的模块（钩子每次工具调用起一个进程，启动要快）。
// @i18n-ignore-file log
import net from "node:net";

/** 问一句；连不上、对面没答就关了都是拒绝（Promise reject）。signal 给了时中止就断开连接（对面据此知道这次调用被取消了） */
export function askBridge(pipe: string, message: object, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buf = "";
    let done = false;
    const settle = (act: () => void) => {
      if (done) return;
      done = true;
      socket.destroy();
      act();
    };
    signal?.addEventListener("abort", () => settle(() => reject(new Error("aborted"))), { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at >= 0) settle(() => resolve(JSON.parse(buf.slice(0, at)) as unknown));
    });
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("closed"))));
  });
}
