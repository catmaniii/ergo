// skill 变更的审批决定产生的素材：用户在"skill 变更"卡上批准（含覆盖、改名）或拒绝（skill_decided），
// 记成"审批决定"（本人的选择）；用户在卡上写的话是本人打的字。整条链照 MCP 登记变更的 mcp/material-source.ts。
// 在 daemon.ts 里、materials.start() 之前登记；彻底删除时只换掉用户写的话（改写函数登记进记忆模块的改写函数表）。
import { EVENT_TYPES, type SkillDecidedPayload } from "@ergo/protocol";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import * as text from "./change-texts.ts";

export const skillDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "skill-decision",
  eventType: EVENT_TYPES.skillDecided,
  capture(event) {
    const p = event.payload as SkillDecidedPayload;
    // 秘书提交的不归任何项目、任务
    const owner = p.submitter.kind === "project" ? { project: p.submitter.projectId } : p.submitter.kind === "task" ? { task: p.submitter.taskId } : {};
    const who = p.submitter.kind === "project" ? p.submitter.projectId : p.submitter.kind === "task" ? p.submitter.taskId : p.submitter.kind;
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        ...owner,
        context: [`decision:${p.decision}`, "card:skill_change"],
        ref: { recordId: `${who}@${p.time}`, ...(p.cardId ? { cardId: p.cardId } : {}) },
        accepted: { text: text.decisionText(p), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 彻底删除：skill 变更的决定只换掉用户写的话，决定本身不变 */
export const skillDecisionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.skillDecided,
  rewrite: (event) => {
    const p = event.payload as SkillDecidedPayload;
    return { ...p, ...purgedField(p, "note") } satisfies SkillDecidedPayload;
  },
};
