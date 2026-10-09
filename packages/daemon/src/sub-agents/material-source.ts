// 并行确认卡上的决定（20 号票）产生的素材（规格第 15 节）：用户同意并行或不同意（parallel_decided）记成"审批决定"。
// 同意、不同意都是用户在 agent 先提出的提议上做的选择（本人，注明 agent 先提出）；用户写的话是本人打的字。
// 在 daemon.ts 里、materials.start() 之前登记；彻底删除时只换掉用户写的话（改写函数登记进记忆模块的改写函数表）。
import { EVENT_TYPES, PURGED_TEXT } from "@ergou/protocol";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import { type ParallelDecidedPayload, type ParallelProposedPayload, SUB_AGENT_EVENTS } from "./events.ts";
import { subAgentLine } from "./texts.ts";

/** 决定写成一句话："同意任务「X」派 2 个子 agent 并行：sa-1 做阶段 s1「…」；sa-2 做阶段 s2「…」" */
function decisionText(p: ParallelDecidedPayload): string {
  const each = p.agents.map(subAgentLine).join("；");
  return p.decision === "parallel"
    ? `同意任务「${p.taskTitle}」派 ${p.agents.length} 个子 agent 并行：${each}`
    : `不并行，按顺序做：任务「${p.taskTitle}」的维护者提议派 ${p.agents.length} 个子 agent 并行（${each}）`;
}

export const parallelDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "parallel-decision",
  eventType: EVENT_TYPES.parallelDecided,
  capture(event) {
    const p = event.payload as ParallelDecidedPayload;
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        task: p.taskId,
        context: [`decision:${p.decision}`, "card:parallel"],
        ref: { recordId: p.proposalId, cardId: p.cardId },
        accepted: { text: decisionText(p), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 彻底删除：并行确认卡上的决定只换掉用户写的话，决定本身不变 */
export const parallelDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.parallelDecided,
  rewrite: (event) => {
    const p = event.payload as ParallelDecidedPayload;
    return { ...p, ...purgedField(p, "note") } satisfies ParallelDecidedPayload;
  },
};

/** 一个子 agent 的阶段名、哪一步、工作说明换成删除标记 */
const agentPurged = <A extends { stageTitle: string; instructions: string; step?: string | undefined }>(a: A): A => ({
  ...a,
  stageTitle: PURGED_TEXT,
  instructions: PURGED_TEXT,
  ...(a.step === undefined ? {} : { step: PURGED_TEXT }),
});

/**
 * 删除项目时它的内部任务一起删掉（64 号票，projects/deletion.ts）：sub_agents 频道上并行的提议和决定里的文字换成删除标记——
 * 任务名、为什么并行、各子 agent 做的阶段名、哪一步、工作说明、用户写的话；编号、阶段、目录、决定原样（子 agent 的归属照旧能重放）
 */
export function purgedParallelPayload(type: string, payload: unknown): ParallelProposedPayload | ParallelDecidedPayload | undefined {
  if (type === SUB_AGENT_EVENTS.parallelProposed) {
    const p = payload as ParallelProposedPayload;
    return { ...p, reason: PURGED_TEXT, agents: p.agents.map(agentPurged) };
  }
  if (type === SUB_AGENT_EVENTS.parallelDecided) {
    const p = payload as ParallelDecidedPayload;
    return { ...p, taskTitle: PURGED_TEXT, agents: p.agents.map(agentPurged), ...purgedField(p, "note") };
  }
  return undefined;
}
