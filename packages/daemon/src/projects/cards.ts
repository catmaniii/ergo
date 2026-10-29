// 项目用到的三种卡（卡片类型注册表，规格第 5、11 节）：
// - "建议立项"卡（suggest_project）：秘书收口，写名字和一句话目标。"立项"让项目诞生（筹备中，维护者随之产生），
//   同一事务给秘书一条通知；"不用了"关掉（回避信号，长期不处理也是）；
// - 立项书卡（charter）：代码从维护者交出的结构化立项书生成。"确认并开工"（项目转建设中，同时建出首个建设任务）、
//   "只确认，稍后开工"（留在筹备中，标"立项书已确认"）；两种确认都让项目类型、外部工作目录绑定和工具包立即生效；
// - "首版做完了"卡（build_done，112 号票）：建设任务做完时出（项目状态变更时找用户），写明做成了什么。"转入使用"（项目进入使用中）、
//   "继续建设"（附一句这一轮要做什么：项目留在建设中，建出下一轮建设任务）、"放弃并归档"；不选就一直挂着，项目停在建设中。
//   130 号票：带着维护者建设期间交的运营方案的，"转入使用"就是"确认并转入使用"——运营方案里每一条一起生效。
//   259 号票（版本 4）：卡上带着转运营检查清单，没做到的照样能转入使用，确认时缺的记进决定；
// - "转入使用"确认卡（go_live，259 号票）：建设中的项目要转入使用（用户在项目页点的、维护者提的、秘书代办的），卡上写谁发起的、为什么、
//   检查清单、运营方案；"确认转入使用"（带着方案的是"确认并转入使用"）和"首版做完了"卡的"转入使用"走同一道门，"先不转"项目留在建设中。
import {
  BUILD_DONE_CHOICE_LABEL,
  BUILD_DONE_CHOICES,
  BuildDoneCardPayload,
  CARD_TYPE_VERSIONS,
  buildDoneTitle,
  CharterCardPayload,
  checklistMissing,
  GO_LIVE_BY_LABEL,
  GO_LIVE_CHOICE_LABEL,
  GO_LIVE_CHOICES,
  GoLiveCardPayload,
  type GoLiveChecklistItem,
  goLiveTitle,
  OPERATIONS_PUT_IN_USE_LABEL,
  OperationsConfirmInput,
  PROJECT_KIND_LABEL,
  PURGED_TEXT,
  SuggestProjectCardPayload,
  toolkitBashWording,
  t,
} from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import { planSectionText } from "../operations/index.ts";
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
    toText: (p) => t("projects.cards.suggestText", { name: p.name, goal: p.goal }),
  });
}

/** "首版做完了"卡上一个选择的说法：带着运营方案的"转入使用"写成"确认并转入使用"（130 号票） */
const choiceLabel = (p: BuildDoneCardPayload, c: (typeof BUILD_DONE_CHOICES)[number]) => (c === "put_in_use" && p.operations ? OPERATIONS_PUT_IN_USE_LABEL : BUILD_DONE_CHOICE_LABEL[c]);

/**
 * "首版做完了"卡（112 号票）。纯文本降级（秘书列待我处理时看到的就是它，开头 200 字）先写做成了什么：最后的总结、
 * 每个阶段的验收结果、交付件在哪，再写等你选什么（选过的写选了哪个）。
 * 130 号票（版本 2）：带着维护者建设期间交的运营方案的，"转入使用"就是"确认并转入使用"（方案里每一条一起生效；流程审查要你逐项确认的
 * 事项勾完才行）；纯文本降级里方案紧跟在标题后面（秘书列待办时开头 200 字里看得到）。133 号票（版本 3）：方案里的一条可以是服务
 */
export function buildDoneCardType(projects: ProjectService) {
  return defineCardType({
    type: "build_done",
    version: CARD_TYPE_VERSIONS.build_done,
    payload: BuildDoneCardPayload,
    actions: {
      put_in_use: {
        input: OperationsConfirmInput,
        run: ({ card, payload, note, input, idempotencyKey }) => projects.decideBuild(payload, "put_in_use", note, idempotencyKey, { input, cardId: card.id }),
      },
      keep_building: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideBuild(payload, "keep_building", note, idempotencyKey) },
      abandon: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideBuild(payload, "abandon", note, idempotencyKey) },
    },
    toText: (p) =>
      [
        t(p.operations ? "projects.cards.buildDoneHead" : "projects.cards.buildDoneHeadSummary", {
          title: buildDoneTitle(p),
          id: p.buildTaskId,
          task: p.buildTaskTitle,
          summary: p.summary ?? t("projects.cards.noSummary"),
        }),
        ...(p.operations ? [planSectionText(p.operations.items), t("projects.cards.summary", { summary: p.summary ?? t("projects.cards.noSummary") })] : []),
        ...p.stages.map((s) => t("projects.cards.stage", { code: s.code, title: s.title, result: s.result })),
        // 259 号票：转运营检查清单（旧卡没有），排在做成了什么后面
        ...(p.checklist ? [checklistText(p.checklist)] : []),
        t("projects.cards.deliverables", { workdir: p.workdir }) +
          (p.decided
            ? t(p.decided.request ? "projects.cards.choseWithRequest" : "projects.cards.chose", { choice: choiceLabel(p, p.decided.choice), request: p.decided.request ?? "" })
            : t("projects.cards.waiting", { choices: BUILD_DONE_CHOICES.map((c) => choiceLabel(p, c)).join(t("pages.common.listSep")) })),
      ].join(t("projects.cards.sep")),
  });
}

/** 检查清单写成一句（卡的纯文本降级）：都做到了，或者还缺哪几项、差什么 */
export function checklistText(items: readonly GoLiveChecklistItem[]): string {
  const missing = checklistMissing(items);
  if (missing.length === 0) return t("projects.cards.checklistDone", { count: items.length });
  const lines = missing.map((i) => (i.detail ? t("projects.goLive.missingItem", { label: i.label, detail: i.detail }) : i.label));
  return t("projects.cards.checklistMissing", { count: missing.length, items: lines.join(t("pages.common.listSep")) });
}

/** "转入使用"卡上一个选择的说法：带着运营方案的确认写成"确认并转入使用" */
const goLiveChoiceLabel = (p: GoLiveCardPayload, c: (typeof GO_LIVE_CHOICES)[number]) => (c === "put_in_use" && p.operations ? OPERATIONS_PUT_IN_USE_LABEL : GO_LIVE_CHOICE_LABEL[c]);

/**
 * "转入使用"确认卡（259 号票）。纯文本降级（秘书列待我处理时看到开头 200 字）先写谁发起的、检查清单缺什么，再写为什么、运营方案、等你选什么。
 * 确认转入使用和"首版做完了"卡的"转入使用"同名（put_in_use），带同样的输入（流程审查要你逐项确认的事项勾了哪些）
 */
export function goLiveCardType(projects: ProjectService) {
  return defineCardType({
    type: "go_live",
    version: CARD_TYPE_VERSIONS.go_live,
    payload: GoLiveCardPayload,
    actions: {
      put_in_use: {
        input: OperationsConfirmInput,
        run: ({ card, payload, note, input, idempotencyKey }) => projects.decideGoLive(payload, "put_in_use", note, idempotencyKey, { input, cardId: card.id }),
      },
      dismiss: { input: undefined, run: ({ payload, note, idempotencyKey }) => projects.decideGoLive(payload, "dismiss", note, idempotencyKey) },
    },
    toText: (p) =>
      [
        t("projects.cards.goLiveHead", { title: goLiveTitle(p), by: GO_LIVE_BY_LABEL[p.by] }),
        checklistText(p.checklist),
        ...(p.why ? [t("projects.cards.goLiveWhy", { why: p.why })] : []),
        ...(p.operations ? [planSectionText(p.operations.items)] : []),
        p.decided
          ? p.decided.missing && p.decided.missing.length > 0
            ? t("projects.cards.choseMissing", { choice: goLiveChoiceLabel(p, p.decided.choice), count: p.decided.missing.length })
            : t("projects.cards.chose", { choice: goLiveChoiceLabel(p, p.decided.choice) })
          : t("projects.cards.waiting", { choices: GO_LIVE_CHOICES.map((c) => goLiveChoiceLabel(p, c)).join(t("pages.common.listSep")) }),
      ].join(t("projects.cards.sep")),
    // 彻底删除时：维护者、秘书写的为什么换成删除标记（谁发起的、清单、决定不变）
    purge: (p) => (p.why ? { ...p, why: PURGED_TEXT } : p),
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
      t(p.charter.bindExternal ? "projects.cards.charterTextBound" : "projects.cards.charterText", {
        name: p.projectName,
        revision: p.revision,
        kind: PROJECT_KIND_LABEL[p.charter.kind],
        path: p.charter.externalPath ?? "",
        bash: toolkitBashWording(p.toolkit.bash),
      }),
    // 彻底删除、删除项目时：立项书正文换成删除标记，项目类型、绑不绑外部路径、工具包、确认结果不变
    purge: (p) => ({ ...p, charter: purgedCharter(p.charter) }),
  });
}
