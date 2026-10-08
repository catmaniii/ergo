// MCP（规格第 3、9、20 节，27 号票）：登记在配置区（registration.ts），写进项目或任务的工具包才授权给维护者。
// - 服务进程由守护进程按需拉起（第一次有会话装配到它、第一次调用它时），放进它自己的 Job 对象，凭据按登记注入（client.ts）。
//   它们不是服务：不对外监听端口，不在 LSM 登记；守护进程停止、被杀时一起结束。登记改了（命令、参数、环境）下次用到时按新的重起；
// - 会话里的 MCP 工具是守护进程代为执行的工具（hostToolsFor）：工具包列了这个 MCP 才有，联网开关关着时没有要联网的那些；
//   名字是 mcp__<MCP 名>__<工具名>，在守卫的工具注册表里按登记的类别、底线、参数规则、"只读或幂等"判（来源 mcp）。
//   agent 的调用先过守卫，再由守护进程转给服务进程（call）；agent 子进程和它的孙进程碰不到凭据；
// - 注入的凭据值不出守护进程：服务进程的 stderr 进日志、工具结果交给 agent 和写进事件日志、它报的工具说明给模型看之前都擦掉（redactorOf）；
// - 授权给秘书快速动作的工具（quickActionTools）：参数按登记固定，见 quick-action.ts。
import path from "node:path";
import { type McpServerEntry, mcpToolName } from "@ergou/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { redactSecretValues, type ToolDescriptor } from "../guard/index.ts";
import type { JobObject } from "../process/job-object.ts";
import { buildChildEnv } from "../process/child-env.ts";
import type { JsonValue } from "../runtime/index.ts";
import { connectMcp, type McpCallResult, type McpConnection, type McpListedTool } from "./client.ts";
import { guardFieldsOf, type McpRegistrationRead, type McpServerRegistration, type McpToolRegistration, readMcpRegistrations, serverEnv } from "./registration.ts";

export interface McpServiceOptions {
  /** 配置区的 mcp.json */
  file: string;
  /** 守护进程自己的环境：系统变量白名单从这里挑，登记的凭据（fromEnv）从这里取 */
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** 服务进程默认的工作目录（登记里没写 cwd 时） */
  cwd: string;
  /** 给每个 MCP 建一个 Job 对象（不是 Windows 时返回 undefined） */
  newJob: () => JobObject | undefined;
  /** 单次调用的超时（毫秒），同工具调用的默认超时 */
  callTimeoutMs: number;
  log: (line: string) => void;
}

/** 授权给秘书快速动作的一个 MCP 工具 */
export interface McpQuickActionTool {
  server: string;
  tool: string;
  /** 快速动作的说法（登记写的） */
  title: string;
  /** 固定的参数（登记写的） */
  args: Record<string, unknown>;
  /** 工具的登记（类别、底线、参数规则……） */
  registration: McpToolRegistration;
  serverTitle: string;
}

export interface McpService {
  /** 现读的登记 */
  registrations(): McpRegistrationRead;
  /** 给界面看的登记（工具包区、skill 库页） */
  catalog(): { servers: McpServerEntry[]; problem?: string };
  /** 登记了这个 MCP */
  has(server: string): boolean;
  /** 全部登记的 MCP 工具在守卫工具注册表里的登记（设置页自定义类别能匹配的工具也有它们） */
  descriptors(): ToolDescriptor[];
  /** 会话里的 MCP 工具（守护进程代为执行）：工具包列了的 MCP、联网关着时去掉要联网的；顺带在后台把服务进程拉起来（拿到参数说明） */
  hostToolsFor(toolkit: { mcp: readonly string[]; network: boolean }): HostTool[];
  /** 调用一个登记了的工具（守卫已经放行；快速动作在用户确认之后） */
  call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  /** 授权给秘书快速动作的工具 */
  quickActionTools(): McpQuickActionTool[];
  /** 现在活着的服务进程（闸门进程的 pid，服务进程是它的子进程） */
  live(): Array<{ server: string; pid: number }>;
  /** 结束全部服务进程 */
  stop(): Promise<void>;
}

/** 服务进程还没起来过、登记里也没写参数说明时给模型的参数说明：只要求是个对象 */
const LOOSE_SCHEMA: JsonValue = { type: "object" };

/** 一个登记的 MCP 工具在守卫工具注册表里的登记 */
const descriptorOf = (server: string, serverReg: McpServerRegistration, tool: string, reg: McpToolRegistration): ToolDescriptor => ({
  name: mcpToolName(server, tool),
  title: `${serverReg.title ?? server}：${reg.title}`,
  source: "mcp",
  ...guardFieldsOf(reg),
});

/** 登记里的全部工具（MCP 名、MCP 的登记、工具名、工具的登记） */
const allTools = (read: McpRegistrationRead) =>
  Object.entries(read.servers).flatMap(([server, serverReg]) => Object.entries(serverReg.tools).map(([tool, reg]) => ({ server, serverReg, tool, reg })));

export function createMcpService(options: McpServiceOptions): McpService {
  /** 每个 MCP 的连接：按哪份登记起的（登记改了下次用到时重起） */
  const connections = new Map<string, { key: string; connection: Promise<McpConnection>; settled?: McpConnection }>();
  /** 服务进程报过的工具（参数说明、说明）：重起之后照样留着，下次报了再换 */
  const listed = new Map<string, readonly McpListedTool[]>();
  let stopped = false;

  const registrations = () => readMcpRegistrations(options.file);

  /** 擦掉按这份登记注入的凭据值（30 号票的 redactSecretValues：原样、URL 编码、base64 的写法都擦） */
  const redactorOf = (registration: McpServerRegistration) => {
    const { secrets } = serverEnv(registration, options.parentEnv);
    return (text: string) => redactSecretValues(text, secrets);
  };

  /** 这个 MCP 的服务进程（没有、退出了、登记改了就按现在的登记拉起） */
  const ensure = (server: string, registration: McpServerRegistration): Promise<McpConnection> => {
    if (stopped) return Promise.reject(new Error("守护进程正在停止"));
    const key = JSON.stringify(registration);
    const existing = connections.get(server);
    if (existing && existing.key === key) return existing.connection;
    if (existing) {
      void existing.connection.then((c) => c.close()).catch(() => {});
      connections.delete(server);
    }
    const { env, missing } = serverEnv(registration, options.parentEnv);
    if (missing.length > 0) options.log(`MCP ${server} 登记要的凭据守护进程的环境里没有：${missing.join("、")}（照样拉起，服务进程可能用不了）`);
    // 服务进程说的话（stderr、不是 JSON 的输出、起不来的原因）进守护进程日志之前擦掉注入的凭据
    const redact = redactorOf(registration);
    const log = (line: string) => options.log(redact(line));
    const connection = connectMcp({
      name: server,
      command: registration.command,
      args: registration.args ?? [],
      cwd: registration.cwd ?? options.cwd,
      // 系统变量白名单 + 登记给的（含按登记注入的凭据）；不继承守护进程的其他环境
      env: buildChildEnv(options.parentEnv, env),
      newJob: options.newJob,
      log,
    });
    const entry: { key: string; connection: Promise<McpConnection>; settled?: McpConnection } = { key, connection };
    connections.set(server, entry);
    connection.then(
      (c) => {
        entry.settled = c;
        // 它报的说明、参数说明要给模型看：同样擦掉注入的凭据
        listed.set(server, JSON.parse(redact(JSON.stringify(c.tools))) as McpListedTool[]);
        log(`拉起了 MCP ${server} 的服务进程（pid ${c.pid}），它报了 ${c.tools.length} 个工具`);
        void c.exited.then(() => {
          if (connections.get(server) === entry) connections.delete(server);
        });
        if (stopped) c.close();
      },
      (err: unknown) => {
        if (connections.get(server) === entry) connections.delete(server);
        log(`MCP ${server} 的服务进程起不来：${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return connection;
  };

  const call = async (server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> => {
    const registration = registrations().servers[server];
    if (!registration?.tools[tool]) return { text: `没有登记 MCP 工具 ${server}/${tool}`, isError: true };
    // 结果交给 agent、写进事件日志（工具调用记录、操作记录、卡片）之前擦掉注入的凭据：服务进程可能把它原样报回来
    const redact = redactorOf(registration);
    const failed = (text: string): McpCallResult => ({ text: redact(text), isError: true });
    let connection: McpConnection;
    try {
      connection = await ensure(server, registration);
    } catch (err) {
      return failed(`MCP ${server} 用不了：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const result = await connection.callTool(tool, args, { timeoutMs: options.callTimeoutMs, ...(signal ? { signal } : {}) });
      return { text: redact(result.text), isError: result.isError };
    } catch (err) {
      return failed(`调用 MCP 工具 ${server}/${tool} 没做成：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    registrations,
    catalog() {
      const read = registrations();
      return {
        servers: Object.entries(read.servers).map(([name, s]) => ({
          name,
          title: s.title ?? name,
          tools: Object.entries(s.tools).map(([tool, reg]) => ({
            name: tool,
            title: reg.title,
            network: reg.network !== false,
            readOnlyOrIdempotent: reg.readOnlyOrIdempotent === true,
            ...(reg.quickAction ? { quickAction: reg.quickAction.title } : {}),
          })),
        })),
        ...(read.problem === undefined ? {} : { problem: read.problem }),
      };
    },
    has: (server) => Object.hasOwn(registrations().servers, server),
    descriptors: () => allTools(registrations()).map(({ server, serverReg, tool, reg }) => descriptorOf(server, serverReg, tool, reg)),
    hostToolsFor(toolkit) {
      const read = registrations();
      const out: HostTool[] = [];
      for (const server of toolkit.mcp) {
        const serverReg = read.servers[server];
        if (!serverReg) {
          options.log(`工具包里的 MCP ${server} 没有登记（可能被删了），这次装配不带它`);
          continue;
        }
        const reported = listed.get(server);
        // 还没拿到服务进程报的参数说明：在后台拉起它（下次装配就有了）
        if (!reported) void ensure(server, serverReg).catch(() => {});
        for (const [tool, reg] of Object.entries(serverReg.tools)) {
          if (reg.network !== false && !toolkit.network) continue;
          const fromServer = reported?.find((t) => t.name === tool);
          const descriptor = descriptorOf(server, serverReg, tool, reg);
          out.push({
            descriptor,
            spec: {
              name: descriptor.name,
              description: reg.description ?? fromServer?.description ?? reg.title,
              parameters: (reg.inputSchema ?? fromServer?.inputSchema ?? LOOSE_SCHEMA) as JsonValue,
            },
            run: async (args, hostCall) => {
              const params = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
              const result = await call(server, tool, params, hostCall.signal);
              return { text: result.text, isError: result.isError };
            },
          });
        }
      }
      return out;
    },
    call,
    quickActionTools: () =>
      allTools(registrations()).flatMap(({ server, serverReg, tool, reg }) =>
        reg.quickAction ? [{ server, tool, title: reg.quickAction.title, args: reg.quickAction.args, registration: reg, serverTitle: serverReg.title ?? server }] : [],
      ),
    live: () => [...connections.entries()].flatMap(([server, c]) => (c.settled ? [{ server, pid: c.settled.pid }] : [])),
    async stop() {
      stopped = true;
      const all = [...connections.values()];
      connections.clear();
      await Promise.all(
        all.map(async (entry) => {
          try {
            const c = await entry.connection;
            c.close();
            await c.exited;
          } catch {
            // 没起来的不用收
          }
        }),
      );
    },
  };
}

/** 服务进程没写工作目录时用的：临时区下的 mcp/ */
export function defaultMcpCwd(tmpDir: string): string {
  return path.join(tmpDir, "mcp");
}
