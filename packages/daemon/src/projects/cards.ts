// 项目用到的三种卡（卡片类型注册表，规格第 5、11 节）：
// - "建议立项"卡（suggest_project）：秘书收口，写名字和一句话目标。"立项"让项目诞生（筹备中，维护者随之产生），
//   同一事务给秘书一条通知；"不用了"关掉（回避信号，长期不处理也是）；
// - 立项书卡（charter）：代码从维护者交出的结构化立项书生成。"确认并开工"（项目转建设中，同时建出首个建设任务）、
//   "只确认，稍后开工"（留在筹备中，标"立项书已确认"）；两种确认都让项目类型、外部工作目录绑定和工具包立即生效；
// - "首版做完了"卡（build_done，112 号票）：建设任务做完时出（项目状态变更时找用户），写明做成了什么。"转入使用"（项目进入使用中）、
//   "继续建设"（附一句这一轮要做什么：项目留在建设中，建出下一轮建设任务）、"放弃并归档"；不选就一直挂着，项目停在建设中。
import { BUILD_DONE_CHOICE_LABEL, BUILD_DONE_CHOICES, BuildDoneCardPayload, buildDoneTitle, CharterCardPayload, PROJECT_KIND_LABEL, SuggestProjectCardPayload, toolkitBashWording } from "@ergou/protocol";
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

/**
 * "首版做完了"卡（112 号票）。纯文本降级（秘书列待我处理时看到的就是它，开头 200 字）先写做成了什么：最后的总结、
 * 每个阶段的验收结果、交付件在哪，再写等你选什么（选过的写选了哪个）
 */
export function buildDoneCardType(projects: ProjectService) {
  return defineCardType({
    type: "build_done",
    version: 1,
    payload: BuildDoneCardPayload,
    actions: {
      put_in_use: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideBuild(payload, "put_in_use", note, idempotencyKey) },
      keep_building: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideBuild(payload, "keep_building", note, idempotencyKey) },
      abandon: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideBuild(payload, "abandon", note, idempotencyKey) },
    },
    toText: (p) =>
      [
        `${buildDoneTitle(p)}（建设任务 ${p.buildTaskId}「${p.buildTaskTitle}」）：${p.summary ?? "维护者没写总结"}`,
        ...p.stages.map((s) => `第 ${s.code} 阶段「${s.title}」${s.result}`),
        `交付件在 ${p.workdir}。${p.decided ? `你选了${BUILD_DONE_CHOICE_LABEL[p.decided.choice]}${p.decided.request ? `：${p.decided.request}` : ""}` : `等你选：${BUILD_DONE_CHOICES.map((c) => BUILD_DONE_CHOICE_LABEL[c]).join("、")}`}`,
      ].join("；"),
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
