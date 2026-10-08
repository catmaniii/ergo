// 立项用到的两种卡（卡片类型注册表，规格第 5、11 节）：
// - "建议立项"卡（suggest_project）：秘书收口，写名字和一句话目标。"立项"让项目诞生（筹备中，维护者随之产生），
//   同一事务给秘书一条通知；"不用了"关掉（回避信号，长期不处理也是）；
// - 立项书卡（charter）：代码从维护者交出的结构化立项书生成。"确认并开工"（项目转建设中，同时建出首个建设任务）、
//   "只确认，稍后开工"（留在筹备中，标"立项书已确认"）；两种确认都让项目类型、外部工作目录绑定和工具包立即生效。
import { CharterCardPayload, PROJECT_KIND_LABEL, SuggestProjectCardPayload, toolkitBashWording } from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";
import { purgedCharter } from "./material-sources.ts";
import type { ProjectService } from "./projects.ts";

/** "建议立项"卡 */
export function suggestProjectCardType(projects: ProjectService) {
  return defineCardType({
    type: "suggest_project",
    version: 1,
    payload: SuggestProjectCardPayload,
    actions: {
      kickoff: { input: undefined, run: ({ payload, idempotencyKey }) => projects.kickoffFromCard(payload, idempotencyKey) },
      dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) => `建议立项：${p.name}（${p.goal}）`,
  });
}

/** 立项书卡 */
export function charterCardType(projects: ProjectService) {
  return defineCardType({
    type: "charter",
    version: 1,
    payload: CharterCardPayload,
    actions: {
      confirm_start: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.confirmCharter(payload, "start", note, idempotencyKey) },
      confirm_later: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.confirmCharter(payload, "later", note, idempotencyKey) },
    },
    toText: (p) =>
      `立项书：${p.projectName}（第 ${p.revision} 版，${PROJECT_KIND_LABEL[p.charter.kind]}，工作目录${p.charter.bindExternal ? `绑定 ${p.charter.externalPath ?? ""}` : "在项目档案里"}，${toolkitBashWording(p.toolkit.bash)}）`,
    // 彻底删除、删除项目时：立项书正文换成删除标记，项目类型、绑不绑外部路径、工具包、确认结果不变
    purge: (p) => ({ ...p, charter: purgedCharter(p.charter) }),
  });
}
