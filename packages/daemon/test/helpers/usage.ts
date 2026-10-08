// 构造的用量（24 号票）：范围审视（18 号票，维护者子进程里另开的那次调用）、定时作业（19 号票）、没给归属的 agent 还没有真的来源时，
// 主切面用构造的用量验证账本。
// 测试接缝（照 countAgentSpawns 的做法，不在正式接口里）：包一层 agent 管家的 spawn，记下每个 agent 拉起时给的归属（ledger）；
// inject 照 agent 管家收到子进程 usage 时那样交给账本——归属现取（agent 当时所属的任务、项目），或者直接给一个（作业身份），
// 或者写明没有归属（unattributed）。
import type { TokenCounts } from "@ergou/protocol";
import type { Daemon } from "../../src/daemon.ts";
import type { UsageAttribution } from "../../src/ledger/index.ts";
import type { UsagePurpose } from "../../src/runtime/index.ts";

export interface InjectOptions {
  /** 这次调用的用途（子进程会在 usage 里标）：范围审视、压缩 */
  purpose?: UsagePurpose;
  /** 直接给归属（比如带作业身份的）；不给就用这个 agent 拉起时给的、现取 */
  attribution?: UsageAttribution;
  /** 当作拉起时没给归属的 agent */
  unattributed?: boolean;
  /** 模型在配置里的键，默认 faux */
  model?: string;
}

export type InjectUsage = (agentId: string, tokens: TokenCounts, options?: InjectOptions) => void;

export function usageInjector(daemon: Daemon): InjectUsage {
  const ledgers = new Map<string, () => UsageAttribution>();
  const spawn = daemon.agents.spawn.bind(daemon.agents);
  daemon.agents.spawn = (request) => {
    if (request.ledger) ledgers.set(request.agentId, request.ledger);
    return spawn(request);
  };
  return (agentId, tokens, options = {}) => {
    const attribution = options.unattributed ? undefined : (options.attribution ?? ledgers.get(agentId)?.());
    if (!attribution && !options.unattributed) throw new Error(`agent ${agentId} 还没拉起过，不知道它的用量记在谁名下`);
    daemon.ledger.record({
      agentId,
      sessionId: "constructed",
      model: options.model ?? "faux",
      attribution,
      report: {
        type: "usage",
        messageId: "constructed",
        provider: "faux",
        modelId: "faux-1",
        input: tokens.cacheMiss,
        cacheRead: tokens.cacheHit,
        cacheWrite: 0,
        output: tokens.output,
        totalTokens: tokens.cacheHit + tokens.cacheMiss + tokens.output,
        ...(options.purpose ? { purpose: options.purpose } : {}),
      },
    });
  };
}
