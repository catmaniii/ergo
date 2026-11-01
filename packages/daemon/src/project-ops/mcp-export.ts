// 项目自动转的 MCP（ADR-0045）：使用中、有已登记清单的项目多一个真的 MCP，别的 agent 配进工具包就能用，不用手写转发。
// - 登记是算出来的（registrations）：不写进 mcp.json，不会残留、不用同步。项目不在使用中了就算不出来，MCP 跟着没有；登记了新版工具跟着变。
//   名字按项目编号生成（protocol 的 projectOpsMcpName），定了不变。只转项目自己的操作，白送的通用操作不转；
//   名字不合 MCP 工具名规矩的操作（带点、连着两个下划线……）转不了，只有秘书能用，自检时写明；
// - 守卫映射：query → 只读或幂等；不联网（调的是本机）；标题、说明、参数从清单取。风险标记只记不做：写进说明给模型看，不接守卫；
// - 进程：二狗带的 stdio 转发程序（mcp-bridge-main.ts），经本机端口问这里（handle），到 project_ops 同一段执行逻辑（tool.ts 的 callFromMcp）；
// - 凭证（照服务报事件那一套）：只在本机端口开、外网端口 403（gateway.ts）、Bearer。一个项目一份，只在内存里：转发程序是守护进程的子进程，
//   守护进程停了它们也没了，不用存。经登记的 env 注入（mcp.ts 的 computed），不进 agent 子进程的环境，出现在工具结果、事件、日志里一律擦掉；
// - 自检（onRegistered）：登记了一版之后在后台真的拉一次转发程序做 tools/list，结果写进这个项目负责人的时间线，失败不影响转入使用。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ConversationId, maintainerChannel, type MessageScope, type Project, projectOpsMcpName, type ProjectOpsMcpBody, type ProjectOpsMcpCaller, type ProjectOpsMcpReply, t } from "@ergo/protocol";
import { buildTimelineRecord } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ComputedMcp, McpService } from "../mcp/mcp.ts";
import type { McpToolRegistration } from "../mcp/registration.ts";
import type { OpsManifestRegisteredPayload } from "./events.ts";
import { canExport, type ProjectOp } from "./manifest.ts";
import * as text from "./texts.ts";
import type { OpsMcpCaller, ProjectOps } from "./tool.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** 转发程序的入口（这个文件旁边；打包后是 .js） */
export const OPS_MCP_BRIDGE = fileURLToPath(new URL(`./mcp-bridge-main${ownExt}`, import.meta.url));

/** 转发程序要的两个环境变量（名字和 mcp-bridge-main.ts 里的一样） */
const URL_ENV = "ERGO_OPS_MCP_URL";
const TOKEN_ENV = "ERGO_OPS_MCP_TOKEN";

/** 请求体最多多大（操作的参数；清单写的就是少而简单的参数，这已经很宽了） */
const MAX_BODY_BYTES = 1024 * 1024;
/** 自检最多等多久 */
const SELF_CHECK_TIMEOUT_MS = 20_000;
/** 操作自己有超时（tool.ts），转发这一层多等一会儿，让它先把"等不到"说清楚 */
const BRIDGE_GRACE_MS = 30_000;

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** 一个操作在 MCP 登记里的样子：守卫按这几样判 */
const toolOf = (op: ProjectOp): McpToolRegistration => ({
  title: op.title ?? op.name,
  description: text.opsMcpToolDescription(op),
  inputSchema: op.inputSchema,
  readOnlyOrIdempotent: op.kind === "query",
  network: false,
});

/** 这个项目现在能转的操作（登记着的那一版；项目不在使用中是空的） */
const exportedOf = (project: Project | undefined, latest: ReadonlyMap<string, OpsManifestRegisteredPayload>) => (project?.state === "in_use" ? (latest.get(project.id)?.ops.filter(canExport) ?? []) : []);

/** 认凭证被拒：code 定 HTTP 状态 */
export type OpsMcpAuth = { ok: true; projectId: string } | { ok: false; code: "unauthorized"; message: string };

/** 调的 agent 是谁：称呼、时间线记在哪个会话、带什么归属（项目的负责人、任务的负责人才有） */
export interface OpsMcpAgent {
  who: () => string;
  conversation: ConversationId;
  scope: MessageScope;
}

export interface OpsMcpDeps {
  store: EventStore;
  projects: { get(projectId: string): Project | undefined; list(): Project[] };
  ops: Pick<ProjectOps, "callFromMcp"> & { registry: Pick<ProjectOps["registry"], "latestRegistered"> };
  /** 本机端口上这个接口的地址（网关开好之前是配置里的端口：登记变了连接跟着换） */
  url: () => string;
  /** agent 编号 → 它是谁（项目的负责人、任务的负责人）；别的是 undefined */
  agentOf: (agentId: string) => OpsMcpAgent | undefined;
  /** MCP 模块（建在运营层之后：用到时现取） */
  mcp: () => Pick<McpService, "registrations" | "probe" | "release" | "sweep">;
  /** 登记了新的一版：工具变了，让用着它的会话按新的装配重新拉起（notice 是告诉负责人的话） */
  changed: (project: Project, name: string, notice: string) => void;
  /** 一次操作最多等多久（转发这一层再多等一会儿） */
  callTimeoutMs: number;
  log: (line: string) => void;
}

export interface OpsMcp {
  /** 算出来的登记：使用中、已登记的清单里有能转的操作的项目 */
  registrations(): Record<string, ComputedMcp>;
  /** 这个项目自己的 MCP（负责人的工具包里自动有它）；没有、用户写了同名的是 undefined */
  ownMcp(project: Project): string | undefined;
  /** 请求体最多读多少字节 */
  readonly maxBodyBytes: number;
  /** 认凭证（先认再读请求体） */
  authenticate(credential: string | undefined): OpsMcpAuth;
  /** 转发程序问的：工具清单、调一次 */
  handle(projectId: string, body: ProjectOpsMcpBody, signal: AbortSignal): Promise<ProjectOpsMcpReply>;
  /** 登记了一版：让用着它的会话换装配，后台真的拉一次转发程序自检 */
  onRegistered(payload: OpsManifestRegisteredPayload): void;
  /** 项目变了：不在使用中（停用、归档、删了）的作废凭证、收掉转发程序 */
  onProjectChanged(projectId: string): void;
  stop(): void;
}

export function createOpsMcp(deps: OpsMcpDeps): OpsMcp {
  const tokens = new Map<string, { token: string; digest: Buffer }>();
  let stopped = false;

  const tokenOf = (projectId: string) => {
    const known = tokens.get(projectId);
    if (known) return known.token;
    const token = randomBytes(32).toString("base64url");
    tokens.set(projectId, { token, digest: digest(token) });
    return token;
  };

  const registrations = () => {
    const latest = deps.ops.registry.latestRegistered();
    const out: Record<string, ComputedMcp> = {};
    for (const project of deps.projects.list()) {
      const ops = exportedOf(project, latest);
      if (ops.length === 0) continue;
      out[projectOpsMcpName(project.id)] = {
        registration: {
          title: project.name,
          command: "node",
          args: [OPS_MCP_BRIDGE],
          timeoutMs: deps.callTimeoutMs + BRIDGE_GRACE_MS,
          env: { [URL_ENV]: deps.url(), [TOKEN_ENV]: { fromEnv: TOKEN_ENV } },
          tools: Object.fromEntries(ops.map((op) => [op.name, toolOf(op)])),
        },
        env: { [TOKEN_ENV]: tokenOf(project.id) },
        origin: { projectId: project.id, projectName: project.name },
      };
    }
    return out;
  };

  const callerOf = (caller: ProjectOpsMcpCaller | undefined): OpsMcpCaller => {
    const agent = caller?.agentId === undefined ? undefined : deps.agentOf(caller.agentId);
    return {
      who: agent?.who ?? (() => t("projectOps.caller.unknown")),
      ...(caller?.agentId === undefined ? {} : { agentId: caller.agentId }),
      ...(agent ? { conversation: agent.conversation, scope: agent.scope } : {}),
    };
  };

  const selfCheck = async (payload: OpsManifestRegisteredPayload) => {
    const project = deps.projects.get(payload.projectId);
    if (stopped || project?.state !== "in_use") return;
    const name = projectOpsMcpName(project.id);
    const mcp = deps.mcp();
    // 一个能转的都没有、用户写了同名的：没有这个自动的 MCP，不用拉
    if (!mcp.registrations().auto?.[name]) return;
    const skipped = payload.ops.filter((op) => !canExport(op)).map((op) => op.name);
    const probed = await mcp.probe(name, SELF_CHECK_TIMEOUT_MS);
    if (stopped) return;
    deps.store.append(
      buildTimelineRecord(
        maintainerChannel(project.maintainerId),
        { kind: "mcp", summary: text.opsMcpCheckSummary(name, payload.version, probed), detail: text.opsMcpCheckDetail(probed.tools, skipped) },
        { projectId: project.id },
        { idempotencyKey: `ops-mcp-check:${project.id}:${payload.hash}` },
      ).event,
    );
    deps.log(`项目 ${project.id} 自动转的 MCP ${name}（第 ${payload.version} 版）自检：${probed.ok ? `报了 ${probed.tools.length} 个工具` : `没过（${probed.problem ?? ""}）`}`);
    // 自检只为看它起得来：收掉，第一次调用时再拉起（使用中的项目可能很多，别每个白占一个进程）
    mcp.release(name);
  };

  return {
    registrations,
    ownMcp(project) {
      const name = projectOpsMcpName(project.id);
      return deps.mcp().registrations().auto?.[name] ? name : undefined;
    },
    maxBodyBytes: MAX_BODY_BYTES,
    authenticate(credential) {
      if (credential === undefined) return { ok: false, code: "unauthorized", message: t("projectOps.mcp.noCredential") };
      const wanted = digest(credential);
      for (const [projectId, known] of tokens) {
        if (timingSafeEqual(known.digest, wanted) && deps.projects.get(projectId)?.state === "in_use") return { ok: true, projectId };
      }
      return { ok: false, code: "unauthorized", message: t("projectOps.mcp.badCredential") };
    },
    async handle(projectId, body, signal) {
      const project = deps.projects.get(projectId);
      if (body.method === "tools/list") return { tools: exportedOf(project, deps.ops.registry.latestRegistered()).map((op) => ({ name: op.name, title: op.title ?? op.name, description: text.opsMcpToolDescription(op), inputSchema: op.inputSchema, annotations: { readOnlyHint: op.kind === "query" } })) };
      const token = tokens.get(projectId)?.token;
      const result = await deps.ops.callFromMcp(projectId, body.name, body.arguments ?? {}, {
        caller: callerOf(body.caller),
        ...(body.caller?.toolCallId === undefined ? {} : { toolCallId: body.caller.toolCallId }),
        ...(body.caller?.inputMessageId === undefined ? {} : { inputMessageId: body.caller.inputMessageId }),
        signal,
        secrets: token === undefined ? [] : [token],
      });
      return { content: [{ type: "text", text: result.text }], isError: result.isError, ...(result.say === undefined ? {} : { structuredContent: { say: result.say } }) };
    },
    onRegistered(payload) {
      const project = deps.projects.get(payload.projectId);
      if (stopped || project?.state !== "in_use") return;
      const name = projectOpsMcpName(project.id);
      deps.changed(project, name, text.opsMcpChangedNotice(name, payload.version));
      void selfCheck(payload).catch((err: unknown) => deps.log(`项目 ${payload.projectId} 自动转的 MCP 自检出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    },
    onProjectChanged(projectId) {
      if (deps.projects.get(projectId)?.state === "in_use") return;
      tokens.delete(projectId);
      deps.mcp().sweep();
    },
    stop() {
      stopped = true;
    },
  };
}
