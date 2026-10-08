// token 账本的一条（规格第 16 节，24 号票）：每次模型调用一条，记在守护进程内部的 ledger 频道上（token_usage 事件，前端不订阅），
// 派生视图 token_ledger（views.ts）。用量的数从子进程上报的 usage 来（宿主协议），归属由拉起 agent 的模块给（SpawnAgentRequest.ledger）。
import type { LedgerOwner, LedgerPurpose, LedgerRole, TokenCounts } from "@ergou/protocol";
import type { UsageReport } from "../runtime/index.ts";

/** 账本的频道（守护进程内部，不在前端协议里） */
export const LEDGER_CHANNEL = "ledger";

/** 账本频道上的事件：一次模型调用的用量 */
export const TOKEN_USAGE_EVENT = "token_usage";

/**
 * 用量记在谁名下：拉起 agent 的模块给（每次用量上来时现取，归属会变：项目维护者执行任务的工单时记在任务名下，
 * 执行定时作业时记在作业名下，不在任务里时记在项目名下）。
 * - owner 为 null：秘书（角色 secretary）的是系统开销；别的角色没有归属就是"未归属"；秘书的不论给了什么 owner 都按系统开销记；
 * - stageId：记在任务名下时这次调用算哪个阶段。子 agent、评审子 agent 拉起时带上它被派去 / 评审的阶段；不给就取任务的当前阶段
 *   （和守卫眼里的一致），任务结束或全部阶段验收之后的收尾调用不算进任何阶段
 */
export interface UsageAttribution {
  owner: LedgerOwner | null;
  role: LedgerRole;
  stageId?: string;
}

/** agent 管家交给账本的一次用量：哪个 agent、哪个会话、哪个模型、记在谁名下（拉起时没给归属是 undefined）、子进程上报的数 */
export interface AgentUsage {
  agentId: string;
  /** pi 会话的 id（子进程就绪时报的） */
  sessionId: string;
  /** 模型在配置里的键（config/model-key.ts 的 modelConfigKey：「provider/模型 id」，faux 是 faux），单价按它查 */
  model: string;
  attribution: UsageAttribution | undefined;
  report: UsageReport;
}

/** token_usage 事件的负载 */
export interface TokenUsagePayload {
  time: string;
  owner: LedgerOwner | null;
  stageId?: string;
  /** 这次调用做什么的：干活、范围审视、压缩 */
  purpose: LedgerPurpose;
  agentId: string;
  role: LedgerRole;
  sessionId: string;
  /** 模型在配置里的键（modelConfigKey），和配置里 models、tokenPrices 的键一样 */
  model: string;
  tokens: TokenCounts;
}

/** 账本里的一条（读出来的样子）：seq 是事件的全局序号 */
export interface LedgerEntry extends TokenUsagePayload {
  seq: number;
}
