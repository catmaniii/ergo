// 并行确认卡（卡片类型注册表，规格第 5、8 节，20 号票）：维护者用"提议并行"工具提议派子 agent 同时做几个阶段（或几步），
// 卡上写明任务、为什么并行、派几个子 agent、各做什么、在哪个目录里做。
// - "同意并行"（parallel）：没开始的阶段随卡片更新一起开始，运行时拉起子 agent（每个一个子进程）；
// - "不并行，按顺序做"（sequential）：维护者收到通知（附用户写的话），照常一件一件做。
// 两个动作都追加 parallel_decided（"审批决定"素材的来源）。不卡任务：用户处理之前维护者照常按顺序做。
import { ParallelCardPayload } from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import type { SubAgents } from "./sub-agents.ts";
import { parallelCardText } from "./texts.ts";

export function parallelCardType(subAgents: Pick<SubAgents, "decide">) {
  return defineCardType({
    type: "parallel",
    version: 1,
    payload: ParallelCardPayload,
    actions: {
      parallel: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => subAgents.decide({ id: card.id, payload }, "parallel", note, idempotencyKey) },
      sequential: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => subAgents.decide({ id: card.id, payload }, "sequential", note, idempotencyKey) },
    },
    toText: parallelCardText,
  });
}
