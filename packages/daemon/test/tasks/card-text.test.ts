// 卡片的纯文字说法（toText，175 号票）：网页卡片详情的标题、引用卡片那一行、认不得的卡都显示它，和别的卡一样按当时的语言写。
// tasks/ 的几种卡（建议发起任务、提问、计划、流程计划、计划变更、进度、归档清单）：中文下和原来一字不差，英文下没有汉字（用户的内容除外）。
import { activeLocaleFrom, DEFAULT_LANGUAGE, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { archiveListText } from "../../src/tasks/archive-texts.ts";
import { planCardType, questionsCardType, suggestTaskCardType, workflowPlanCardType } from "../../src/tasks/cards.ts";
import { planChangeCardType } from "../../src/tasks/plan-change-card.ts";
import { progressCardText } from "../../src/tasks/progress-card.ts";

const CJK = /[　-〿一-鿿＀-￯]/;
const catalogs = builtinCatalogs().catalogs;
const use = (language: string) => setActiveLocale(activeLocaleFrom(catalogs, language));

afterEach(() => use(DEFAULT_LANGUAGE));

/** 卡片类型的 toText（依赖用不着：toText 只看负载） */
const text = (type: { toText: (p: never) => string }, payload: object) => type.toText(payload as never);
const none = {} as never;

const suggest = { title: "整理照片", why: "相册太乱" };
const internal = { ...suggest, internal: { projectId: "p-1", projectName: "记账本" } };
const questions = { questions: [{ id: "q1", question: "放哪里？" }, { id: "q2", question: "要备份吗？" }] };
const plan = (limits: number) => ({ taskTitle: "整理照片", revision: 2, plan: { stages: [{}, {}, {}], tokenEstimate: 12000, ...(limits ? { userLimits: Array(limits).fill("x") } : {}) } });
const workflow = (extra: object = {}) => ({ taskTitle: "周报", revision: 1, plan: { review: { status: undefined }, steps: [{}, { inserted: true }, {}] }, ...extra });
const change = { taskTitle: "整理照片", why: "要多一个目录", changes: [], grantInfo: {}, affectedStages: [{ stageId: "1a", title: "挑照片" }, { stageId: "2", title: "归档" }] };
const progress = { kind: "note", taskTitle: "整理照片", stageCode: "1a", stageIndex: 1, stageTotal: 3, stageTitle: "挑照片", text: "挑了一半" };
const accepted = { ...progress, kind: "acceptance", acceptance: { passed: false, judgedBy: "user", results: [] } };
const archive = {
  afterDays: 7,
  items: [
    { taskId: "t-1", title: "周报", state: "done" },
    { taskId: "t-2", title: "旧任务", state: "cancelled", decision: "archive" },
  ],
};

describe("tasks/ 的卡片纯文字说法", () => {
  it("中文下和原来一字不差", () => {
    expect(text(suggestTaskCardType(none), suggest)).toBe("建议发起任务：整理照片（相册太乱）");
    expect(text(suggestTaskCardType(none), internal)).toBe("建议发起项目「记账本」内部的任务：整理照片（相册太乱）");
    expect(text(questionsCardType(() => []), questions)).toBe("提问（2 个问题）：放哪里？；要备份吗？");
    expect(text(planCardType(none), plan(0))).toBe("计划：整理照片（第 2 版，3 个阶段，约 12000 token）");
    expect(text(planCardType(none), plan(2))).toBe("计划：整理照片（第 2 版，3 个阶段，约 12000 token）；按你说过的话加了 2 条限制");
    expect(text(workflowPlanCardType(none, () => none), workflow())).toBe("流程的计划：周报（第 1 版，3 步，没审查，审查插入了 1 步）");
    expect(text(workflowPlanCardType(none, () => none), workflow({ refused: "blocked" }))).toBe("流程的计划没交给你授权：周报（第 1 版，没审查）");
    expect(text(planChangeCardType(none), change)).toBe("计划变更：整理照片（要多一个目录）\n停下等确认的阶段：1a「挑照片」、2「归档」");
    expect(progressCardText(progress as never)).toBe("进展：任务「整理照片」第 1a 阶段「挑照片」。挑了一半");
    expect(progressCardText(accepted as never)).toMatch(/^验收没通过（.+）：任务「整理照片」第 1a 阶段「挑照片」。挑了一半$/);
    expect(archiveListText(archive as never)).toMatch(/^归档清单：2 个任务结束超过 7 天：t-1「周报」（.+）；t-2「旧任务」（.+）：.+。每项可选：.+、.+。$/);
  });

  it("英文下是英文（用户的内容照原样）", () => {
    use("en");
    const all = [
      text(suggestTaskCardType(none), { title: "Photos", why: "messy" }),
      text(suggestTaskCardType(none), { title: "Photos", why: "messy", internal: { projectId: "p-1", projectName: "Ledger" } }),
      text(questionsCardType(() => []), { questions: [{ id: "q1", question: "Where?" }] }),
      text(planCardType(none), { ...plan(1), taskTitle: "Photos" }),
      text(workflowPlanCardType(none, () => none), { ...workflow(), taskTitle: "Weekly" }),
      text(workflowPlanCardType(none, () => none), { ...workflow({ refused: "blocked" }), taskTitle: "Weekly" }),
      text(planChangeCardType(none), { ...change, taskTitle: "Photos", why: "one more folder", affectedStages: [{ stageId: "1a", title: "Pick" }] }),
      progressCardText({ ...progress, taskTitle: "Photos", stageTitle: "Pick", text: "half done" } as never),
      progressCardText({ ...accepted, taskTitle: "Photos", stageTitle: "Pick", text: "half done" } as never),
      archiveListText({ ...archive, items: [{ taskId: "t-1", title: "Weekly", state: "done" }] } as never),
    ];
    expect(all.filter((line) => CJK.test(line))).toEqual([]);
    expect(all[3]).toBe("Plan: Photos (version 2, 3 stages, about 12000 tokens); 1 limit added from what you've said");
    expect(all[7]).toBe("Progress: task “Photos”, stage 1a “Pick”. half done");
  });
});
