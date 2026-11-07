// 模型调用近况（410）：agent 管家收到子进程报的回合结束（turn_end）时记一条，只放内存里的一个环形记录（满了丢最老的）。
// 体检的"模型近况"读它判服务商最近好不好用——不另发请求、不翻事件日志（服务商出错只落在会话频道的 turn_end 里，
// events 表的 type 没有索引）。守护进程重启就清空：重启之后还没调用过就是"最近没调用过"。
// 只记 pi 跑的 agent（用的是设置 · 模型里配的模型）；Claude Code、Codex 用它们自己的模型，不算进来。
// 结局四种：做完了（completed、按 yield 停下的都算 ok）、出错（error，服务商的出错原文截一段）、超时（单次模型调用超过时限，
// 管家中止了这一轮）、用户停（aborted）。单次工具调用超时中止的那一轮不记：说明不了模型好不好。

/** 一轮的结局 */
export type TurnVerdict = "ok" | "error" | "timeout" | "stopped";

/** 一轮的记录 */
export interface TurnRecord {
  /** 结束的时刻（毫秒时间戳） */
  at: number;
  agentId: string;
  /** 记账用的模型键（「provider/模型 id」，faux 是 faux） */
  model: string;
  outcome: TurnVerdict;
  /** 出错、超时时的原文（截到 TURN_ERROR_MAX 个字） */
  error?: string;
}

/** 环形记录最多留几条（体检只看最近 5 轮和最近 15 分钟，留宽一点） */
export const TURN_LOG_CAPACITY = 200;

/** 出错原文最多留多少字 */
export const TURN_ERROR_MAX = 300;

export interface TurnLog {
  record(entry: TurnRecord): void;
  /** 按先后（最老的在前） */
  recent(): readonly TurnRecord[];
}

export function createTurnLog(capacity = TURN_LOG_CAPACITY): TurnLog {
  const entries: TurnRecord[] = [];
  return {
    record(entry) {
      const error = entry.error === undefined ? undefined : entry.error.replace(/\s+/g, " ").trim().slice(0, TURN_ERROR_MAX);
      entries.push({ at: entry.at, agentId: entry.agentId, model: entry.model, outcome: entry.outcome, ...(error ? { error } : {}) });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    recent: () => [...entries],
  };
}
