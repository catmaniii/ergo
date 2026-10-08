// 秘书（规格第 7 节）：守护进程启动时拉起秘书的子进程，跑一条长期主线会话（重启后接着同一个会话）；
// 子进程意外退出就重新拉起。输入队列、回复、被打断的输入、重新拉起都由 conversation/agent-session.ts 的 AgentSession 做
// （和维护者共用），这里只配置秘书的差异：常驻、工具、草稿区、守卫看到的秘书，以及 /healthz 用的健康状态。
//
// 处理到一半被打断（子进程崩溃、守护进程重启）的那条输入不再自动重送：标成"中断"出队，
// 会话里追加一条系统说明请用户需要时重发。从会话文件最后一个完整回合续上的恢复规则在 23 号票。
//
// 交给模型的是用户消息的投影（conversation/model-projection.ts，带版本号的纯函数）：附件按规则内联或只给名字，
// 支持视觉的模型另外收到图片。
//
// 工具：秘书的工具都由守护进程代为执行（agent-manager/host-tools.ts）：读取附件、把草稿区里的文件作为附件发出（09），
// 以及拉起它的模块交进来的（06 的建、改、取消简单提醒，12 的任务发起，21 的素材检索、提议快速动作）。工具产生的卡片以一条
// 只有卡片引用的消息出现在聊天里（消息里只放引用，卡片本身在卡片频道）。工具调用时带上秘书正在处理的那条输入。
//
// 彻底删除（21 号票）：会话频道上来了 messages_purged，秘书会话文件里对应的原话也要改写（改写哪些由记忆模块从删除事件生成，
// sessionRewriteFor）；等手头这一条处理完停掉子进程、改写、再拉起，守护进程启动时把以前的再对一遍，都由 AgentSession 做。
//
// 草稿区（07 号票）：临时区里秘书专用的一格，也是秘书的工作目录。秘书有 pi 的文件工具（读、写、改、列目录）和 bash
// （Git Bash，能用本机已有的 Node 和 Python），不能联网（bash 起的进程设无效代理；首次使用要下载外部程序的 grep、find
// 按通用的装配规则不给，见 agent-manager.ts 的 assembledPiTools）。每次工具调用（包括守护进程代为执行的）
// 都先经守卫判定（guard-runtime/）：草稿区里的写、改、删直接做只记录；草稿区外、联网、受保护区域按守卫判。
// 运行时给秘书的通知（"某某已获批准，可以重试"、"交给我做"的事用户已完成）是会话里的系统消息，和用户消息一样排队交给秘书。
//
// 看板感知（22 号票）：秘书掌握任务靠看板，不靠对话记忆。看板自上次以来有变化时，交给秘书的用户消息后面跟一条"看板变化"
// 上下文消息（board/board-watch.ts），系统提示不动；重启、子进程意外退出后从事件日志对一遍"上次看到的样子"。
// 主线靠自动压缩控制长度，压缩时用秘书专用的压缩指令（system-prompt.ts 的 SECRETARY_COMPACTION_INSTRUCTIONS）；
// 压缩后还是同一条主线会话，看板变化照常追加。
import { CHANNELS, type MessagesPurgedEventPayload } from "@ergou/protocol";
import { type AgentManager, assembledPiTools } from "../agent-manager/agent-manager.ts";
import { createBoardWatch } from "../board/board-watch.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { AgentSession, type AgentSessionStatus } from "../conversation/agent-session.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import type { EventStore } from "../events/event-store.ts";
import { type GuardAgent, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import { readAttachmentTool, sendAttachmentTool } from "../media/attachment-tools.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { SECRETARY_COMPACTION_INSTRUCTIONS, SECRETARY_SYSTEM_PROMPT } from "./system-prompt.ts";

export const SECRETARY_AGENT_ID = "secretary";

/** 秘书只有一条长期主线会话：整条会话是一段（效果日志、时序规则按它划范围） */
export const SECRETARY_SEGMENT_ID = "secretary-main";

/**
 * 秘书的 pi 内置工具：文件工具和 bash。秘书不能联网，装配时按通用规则去掉首次使用要下载外部程序的 grep、find
 * （assembledPiTools），实际拿到的是读、写、改、列目录和 bash
 */
export const SECRETARY_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find, TOOL.bash];

/** 审批卡、"交给我做"事项上秘书对话的来源 */
export const SECRETARY_SOURCE = "秘书对话";

/** 秘书此刻的状态：拉起中、闲着、在处理一条输入、意外退出后等着重新拉起、已停止（常驻，没有"休眠"） */
export type SecretaryStatus = Exclude<AgentSessionStatus, "asleep">;

export interface SecretaryHealth {
  /** 秘书在运行（闲着或在干活），或者不在运行还没超过阈值 */
  ok: boolean;
  status: SecretaryStatus;
  /** 不健康的原因 */
  reason?: string;
}

export interface Secretary {
  readonly status: SecretaryStatus;
  /** 当前子进程的 pid（还没拉起或已退出时没有） */
  readonly pid: number | undefined;
  health(): SecretaryHealth;
  stop(): Promise<void>;
}

export interface SecretaryOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  model: ModelSpec;
  /** provider id → API key，经 stdin 交给子进程（不进子进程的环境变量） */
  credentials: Record<string, string>;
  /** 媒体库：用户消息里的附件在这里（发给模型前按投影读内容） */
  media: MediaStore;
  /** 秘书的模型支不支持图片输入（从配置读）：不支持时图片只投影成一行占位文字 */
  vision: boolean;
  /** 秘书的草稿区（它的工作目录）：send_attachment 只能发这里面的文件 */
  scratchDir: string;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成） */
  sessionRewriteFor: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 时区：发给模型的每条消息前面的本地时间标记按它换算（配置里的 timeZone） */
  timeZone: string;
  /** 秘书不在运行（拉起中、重新拉起中）超过这么久就算不健康，默认 30 秒 */
  downThresholdMs?: number;
  /** 拉起它的模块交进来的工具（守护进程代为执行；06 的简单提醒、12 的任务发起、21 的素材检索和快速动作） */
  tools?: readonly HostTool[];
  /** 守卫：秘书的每次工具调用都先经它判定 */
  guards: GuardRuntime;
  log: (line: string) => void;
}

const CONVERSATION = CHANNELS.secretary;
const DEFAULT_DOWN_THRESHOLD_MS = 30_000;

export function startSecretary(options: SecretaryOptions): Secretary {
  const { store } = options;
  const downThresholdMs = options.downThresholdMs ?? DEFAULT_DOWN_THRESHOLD_MS;
  /** 从什么时候起不在运行（闲着或干活时为 undefined） */
  let downSince: number | undefined = Date.now();
  /** 秘书的工具（守护进程代为执行）：读取附件、把草稿区里的文件作为附件发出，加上交进来的（06 的提醒、12 的任务……） */
  const hostTools: HostTool[] = [
    readAttachmentTool({ store, media: options.media, conversation: CONVERSATION }),
    sendAttachmentTool({ store, media: options.media, conversation: CONVERSATION, scratchDir: options.scratchDir }),
    ...(options.tools ?? []),
  ];
  // 守卫看到的秘书：工作目录和围栏都是草稿区；联网一律按关着判
  const guardAgent: GuardAgent = {
    kind: "secretary",
    agentId: SECRETARY_AGENT_ID,
    cwd: options.scratchDir,
    toolkit: { bash: true, network: false, tools: [...assembledPiTools(SECRETARY_PI_TOOLS, false), ...hostTools.map((t) => t.spec.name)] },
    scratchDir: options.scratchDir,
  };
  // 看板变化：交给秘书的用户消息后面跟一条（运行时的通知不带，变化攒到下一条用户消息）
  const board = createBoardWatch({ store, conversation: CONVERSATION });
  const session = new AgentSession({
    agents: options.agents,
    store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: SECRETARY_AGENT_ID,
    conversation: CONVERSATION,
    label: "秘书",
    // 秘书的用量没有归属：系统开销
    ledgerRole: "secretary",
    // 常驻：一开始就拉起，不闲置退出，占一个预留的名额（agent 管家）
    resident: true,
    spawn: () => ({
      model: options.model,
      // pi 的内置工具：文件工具和 bash，工作目录是草稿区（联网关着，装配时去掉 grep、find）
      tools: [...SECRETARY_PI_TOOLS],
      cwd: options.scratchDir,
      systemPrompt: SECRETARY_SYSTEM_PROMPT,
      continueSession: true,
      credentials: options.credentials,
      network: false,
      compactionInstructions: SECRETARY_COMPACTION_INSTRUCTIONS,
    }),
    hostTools: () => hostTools,
    guard: () => ({ agent: guardAgent, source: SECRETARY_SOURCE, segmentId: SECRETARY_SEGMENT_ID }),
    vision: () => options.vision,
    interruptedNote: (quoted) => `上一条消息${quoted ? `「${quoted}」` : ""}处理时中断了，秘书没有接着处理；需要的话请重发。`,
    sessionRewriteFor: options.sessionRewriteFor,
    inputContext: (message) => (message.speaker === "user" ? board.changesForInput() : undefined),
    onStatus(status) {
      if (status === "idle" || status === "busy") downSince = undefined;
      else downSince ??= Date.now();
      // 重新拉起（意外退出后、改写会话文件时）：处理到一半被打断的那条没交到秘书手里，看板变化从事件日志重新对一遍
      if (status === "restarting") board.resync();
    },
  });
  session.start();
  // start() 把上次被打断的输入标成了中断：再对"上次看到的样子"
  board.resync();

  const status = (): SecretaryStatus => (session.status === "asleep" ? "starting" : session.status);
  return {
    get status() {
      return status();
    },
    get pid() {
      return session.pid;
    },
    health() {
      const now = status();
      if (downSince === undefined || now === "stopped") return { ok: now !== "stopped", status: now };
      const downMs = Date.now() - downSince;
      if (downMs <= downThresholdMs) return { ok: true, status: now };
      return { ok: false, status: now, reason: `秘书子进程已经 ${Math.round(downMs / 1000)} 秒没在运行（${now === "restarting" ? "意外退出后等着重新拉起" : "拉起中"}）` };
    },
    stop: () => session.stop(),
  };
}
