// @i18n-ignore-file model：出错的说明和非文本内容块的写法进工具结果（给模型）和日志
// 和一个 MCP 服务进程说话（27 号票）：拉起、放进 Job 对象、MCP 的 stdio 传输（每行一个 JSON-RPC 2.0 消息）。
// 二狗只用到 MCP 的三件事：initialize（握手）、tools/list（工具的说明和参数）、tools/call（调用一个工具）。
// pi 的 MCP 包只能在 agent 子进程里用（ADR-0004 的边界），而 MCP 服务进程归守护进程管（agent 碰不到凭据），
// 所以这里自己写这一小段客户端，不引用任何 pi 的东西。
//
// 拉起：经闸门进程（process/gated-spawn.ts，和带类型的 bash 工具共用）先放进这个 MCP 自己的 Job 对象再起服务进程，
// 服务进程和它起的进程因此都在 Job 里，守护进程怎么死都跟着结束；闸门把守护进程写来的请求原样转给服务进程（stdin: "forward"）。
import { spawnGated } from "../process/gated-spawn.ts";
import type { JobObject } from "../process/job-object.ts";
import { encodeLine, readJsonLines, readLines } from "../runtime/line-channel.ts";

/** 二狗说的 MCP 协议版本 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** 握手、列工具最多等多久 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** 服务进程报的一个工具 */
export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 一次调用的结果：给模型看的文字、是否出错 */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpConnection {
  /** 闸门进程的 pid（服务进程是它的子进程，都在同一个 Job 里） */
  readonly pid: number;
  /** 这个 MCP 的 Job 对象（只在 Windows 上有） */
  readonly job: JobObject | undefined;
  /** 握手时服务进程报的工具 */
  readonly tools: readonly McpListedTool[];
  callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<McpCallResult>;
  /** 结束服务进程（关掉 Job：它起的进程一起结束） */
  close(): void;
  readonly exited: Promise<void>;
}

export interface ConnectMcpOptions {
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  /** 完整的环境（系统变量白名单加登记的凭据） */
  env: Record<string, string>;
  newJob: () => JobObject | undefined;
  log: (line: string) => void;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 拉起一个 MCP 服务进程、握手、列出工具 */
export async function connectMcp(options: ConnectMcpOptions): Promise<McpConnection> {
  let gated: ReturnType<typeof spawnGated>;
  try {
    gated = spawnGated({ cwd: options.cwd, env: options.env, newJob: options.newJob });
  } catch (err) {
    throw new Error(`拉起 MCP ${options.name} 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const { child, job } = gated;
  const pid = child.pid!;
  child.on("error", (err) => options.log(`MCP ${options.name} 的进程出错：${err.message}`));
  let nextId = 1;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    if (job) job.close();
    else child.kill();
  };
  void exited.then(() => {
    closed = true;
    job?.close();
    for (const [, pending] of waiting) pending.reject(new Error(`MCP ${options.name} 的服务进程退出了`));
    waiting.clear();
  });

  readJsonLines<JsonRpcResponse>(
    child.stdout,
    (message) => {
      if (typeof message.id !== "number") return;
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(`MCP ${options.name}：${message.error.message}（${message.error.code}）`));
      else pending.resolve(message.result);
    },
    { onInvalid: (line) => options.log(`MCP ${options.name} 输出了不是 JSON 的一行：${line.slice(0, 200)}`) },
  );
  readLines(child.stderr, (line) => options.log(`MCP ${options.name}：${line}`));

  const write = (message: object) => {
    if (closed || !child.stdin.writable) throw new Error(`MCP ${options.name} 的服务进程已经退出了`);
    child.stdin.write(encodeLine({ jsonrpc: "2.0", ...message }));
  };

  const request = (method: string, params: object, timeoutMs: number, signal?: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`MCP ${options.name} 的 ${method} 超时了（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      const onAbort = () => {
        waiting.delete(id);
        clearTimeout(timer);
        try {
          write({ method: "notifications/cancelled", params: { requestId: id, reason: "调用被中止了" } });
        } catch {
          // 已经退出了
        }
        reject(new Error("调用被中止了"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      try {
        write({ id, method, params });
      } catch (err) {
        waiting.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  // 放好 Job 之后才告诉闸门要跑什么；之后写给它的都原样转给服务进程
  gated.launch({ file: options.command, args: options.args, cwd: options.cwd, stdin: "forward" });
  let tools: McpListedTool[];
  try {
    await request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ergo", version: "2" } }, HANDSHAKE_TIMEOUT_MS);
    write({ method: "notifications/initialized" });
    const listed = (await request("tools/list", {}, HANDSHAKE_TIMEOUT_MS)) as { tools?: unknown };
    tools = Array.isArray(listed?.tools) ? (listed.tools as McpListedTool[]).filter((t) => typeof t?.name === "string") : [];
  } catch (err) {
    close();
    throw err;
  }

  return {
    pid,
    job,
    tools,
    async callTool(name, args, { timeoutMs, signal }) {
      const result = (await request("tools/call", { name, arguments: args }, timeoutMs, signal)) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
      return { text: contentText(result), isError: result?.isError === true };
    },
    close,
    exited,
  };
}

/** 工具结果里给模型看的文字：文本块原样，别的块写明是什么；没有内容块时用结构化结果 */
function contentText(result: { content?: unknown; structuredContent?: unknown } | undefined): string {
  const blocks = Array.isArray(result?.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const parts = blocks.map((b) => {
    if (b?.type === "text" && typeof b.text === "string") return b.text;
    if (b?.type === "image") return `[图片 ${String(b.mimeType ?? "")}]`;
    if (b?.type === "resource" || b?.type === "resource_link") return `[资源 ${String((b.resource as { uri?: unknown } | undefined)?.uri ?? b.uri ?? "")}]`;
    return `[${String(b?.type ?? "未知内容")}]`;
  });
  if (parts.length === 0 && result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}
