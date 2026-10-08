// 立项产生的素材（规格第 15 节），在 daemon.ts 里、materials.start() 之前登记：
// - 用户对产出的反应：立项书卡上的确认（charter_decided 事件）。立项书是维护者交出的产出，用户"确认并开工"或
//   "只确认，稍后开工"是在 agent 先提出的东西上做的选择（本人，注明 agent 先提出）；确认时附的说明是用户自己的话（本人）。
// 另外两种由别处采集：用户在维护者会话里的发言（会话频道上的消息事件，带所属的项目），"建议立项"卡被关掉或长期没处理
// （卡片模块通用的回避信号）。
// 彻底删除（21 号票）、删除项目（deletion.ts）时：立项书的事件把用户写的说明和立项书正文（目标、范围、首版、外部路径）
// 换成删除标记，决定、版本、项目类型、绑不绑外部路径、工具包、首个建设任务原样保留。
import { type Charter, CHARTER_DECISION_LABEL, EVENT_TYPES, PROJECT_KIND_LABEL, PURGED_TEXT, toolkitBashWording } from "@ergou/protocol";
import { purgedField, type PurgeRewriter } from "../events/purge.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import { CHARTER_EVENTS, type CharterDecidedPayload, type CharterSubmittedPayload } from "./events.ts";

export const charterDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "charter-decision",
  eventType: EVENT_TYPES.charterDecided,
  capture(event) {
    const p = event.payload as CharterDecidedPayload;
    const workdir = p.charter.bindExternal ? `工作目录绑定 ${p.charter.externalPath ?? ""}` : "工作目录在项目档案里";
    const accepted = `${CHARTER_DECISION_LABEL[p.decision]}：项目「${p.projectName}」的立项书（第 ${p.revision} 版，${PROJECT_KIND_LABEL[p.charter.kind]}，${workdir}，${toolkitBashWording(p.toolkit.bash)}）`;
    return [
      userDecisionDraft({
        kind: "output_reaction",
        time: p.time,
        project: p.projectId,
        context: ["card:charter", `decision:${p.decision === "start" ? "confirm_start" : "confirm_later"}`, `kind:${p.charter.kind}`, ...(p.charter.bindExternal ? ["workdir:external"] : [])],
        ref: { recordId: `${p.projectId}-charter-${p.revision}`, cardId: p.cardId },
        accepted: { text: accepted, field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/** 立项书正文换成删除标记：结构（范围的条数）、项目类型、绑不绑外部路径不变 */
export function purgedCharter(charter: Charter): Charter {
  return {
    ...charter,
    goal: PURGED_TEXT,
    scope: charter.scope.map(() => PURGED_TEXT),
    firstVersion: PURGED_TEXT,
    ...(charter.externalPath === undefined ? {} : { externalPath: PURGED_TEXT }),
  };
}

export const charterPurges: readonly PurgeRewriter[] = [
  {
    eventType: EVENT_TYPES.charterDecided,
    rewrite(event) {
      const p = event.payload as CharterDecidedPayload;
      return { ...p, charter: purgedCharter(p.charter), ...purgedField(p, "note") } satisfies CharterDecidedPayload;
    },
  },
  {
    eventType: CHARTER_EVENTS.submitted,
    rewrite(event) {
      const p = event.payload as CharterSubmittedPayload;
      return { ...p, charter: purgedCharter(p.charter) } satisfies CharterSubmittedPayload;
    },
  },
];
