// MCP 登记变更的审批决定（239 号票）产生的素材（规格第 15 节）：用户在"MCP 登记变更"卡上批准或拒绝（mcp_decided），
// 记成"审批决定"（本人的选择）；用户在卡上写的话是本人打的字。整条链照工具包变更的 toolkit/material-source.ts。
// 在 daemon.ts 里、materials.start() 之前登记；彻底删除时只换掉用户写的话（改写函数登记进记忆模块的改写函数表）。
import { EVENT_TYPES, type McpDecidedPayload } from "@ergo/protocol";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import * as text from "./texts.ts";

export const mcpDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "mcp-decision",
  eventType: EVENT_TYPES.mcpDecided,
  capture(event) {
    const p = event.payload as McpDecidedPayload;
    const owner = p.submitter.kind === "project" ? { project: p.submitter.projectId } : { task: p.submitter.taskId };
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        ...owner,
        context: [`decision:${p.decision}`, "card:mcp_change"],
        ref: { recordId: `${p.submitter.kind === "project" ? p.submitter.projectId : p.submitter.taskId}@${p.time}`, ...(p.cardId ? { cardId: p.cardId } : {}) },
        accepted: { text: text.decisionText(p), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 彻底删除：MCP 登记的决定只换掉用户写的话，决定本身不变 */
export const mcpDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.mcpDecided,
  rewrite: (event) => {
    const p = event.payload as McpDecidedPayload;
    return { ...p, ...purgedField(p, "note") } satisfies McpDecidedPayload;
  },
};
