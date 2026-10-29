// 运行时核实过的用户原话、立项要求变更、重做时直接改这一阶段（125 号票）：页面上怎么显示、交出什么。
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_NAME_MARK,
  type CharterChangeCardPayload,
  charterChangeRows,
  projectCharterChangeCards,
  replay,
  stageEditDraft,
  stageEditOf,
  stageEditProblem,
  type Task,
  type TaskEventPayload,
  taskStages,
  userWordsRows,
  type VerifiedUserWords,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

const words: VerifiedUserWords = {
  messageId: "m-1",
  text: "测完直接切过去吧",
  conversation: "maintainer:pm-blog",
  where: "项目「个人博客」的维护者会话",
  time: "2026-10-06T22:58:10.000+08:00",
  device: "设备「我的手机」",
};

const charter = { goal: "账单进一个本子，按月出报表", scope: ["导入账单", "按月出报表"], firstVersion: "出一份月报", kind: "dev" as const, bindExternal: false };
const change = (projectId: string, revision: number): CharterChangeCardPayload => ({
  projectId,
  projectName: "记账本",
  revision,
  why: "报表改成每周",
  changes: [
    { field: "goal", before: charter.goal, after: "账单进一个本子，每周出报表" },
    { field: "scope", removed: ["按月出报表"], added: ["每周出报表"] },
  ],
  before: charter,
  after: { ...charter, goal: "账单进一个本子，每周出报表", scope: ["导入账单", "每周出报表"] },
});

describe("运行时核实过的用户原话", () => {
  test("每条一行原文，下面写从哪来（时间 · 会话 · 设备；经秘书转达另写）；没有就是空的", () => {
    expect(userWordsRows(undefined)).toEqual([]);
    const where = `和${ASSISTANT_NAME_MARK}的对话`;
    expect(userWordsRows([words, { ...words, messageId: "m-2", text: "好", where, device: "本机", relayedBy: "secretary", relayMessageId: "m-3" }])).toEqual([
      { key: "m-1:0", text: "测完直接切过去吧", source: "10-06 22:58 · 项目「个人博客」的维护者会话 · 设备「我的手机」" },
      // 提到秘书的是名字占位，界面上按现在的名字显示
      { key: "m-2:1", text: "好", source: `10-06 22:58 · ${where} · 本机 · 经${ASSISTANT_NAME_MARK}转达` },
    ]);
  });

  test("阶段上带着最近一次宣布完成时评审输入里的原话；没引用的不带", () => {
    const T = "2026-10-07T09:00:00.000+08:00";
    const task = (userWords?: VerifiedUserWords[]): Task => ({
      id: "t-1",
      title: "周报",
      summary: "周报",
      state: "running",
      origin: "button",
      maintainerId: "tm-1",
      projects: [],
      createdAt: T,
      updatedAt: T,
      stages: {
        total: 2,
        list: [
          { stageId: "s1", title: "周报样张", state: "accepted", dependsOn: [], acceptance: [{ criterion: "用户认可", method: "review" }], attempts: 1, ...(userWords ? { userWords } : {}) },
          { stageId: "s2", title: "定时推送", state: "pending", dependsOn: ["s1"], acceptance: [{ criterion: "跑一次", method: "script" }], attempts: 0 },
        ],
      },
    });
    const state = replay([frame("board", 1, "task", { task: task([words]), change: "stage_accepted", from: "running", by: "system" } satisfies TaskEventPayload)]);
    const [s1, s2] = taskStages(state, "t-1");
    expect(s1!.userWords).toEqual([words]);
    expect(s2!.userWords).toBeUndefined();
  });
});

describe("立项要求变更卡", () => {
  test("逐条对照：目标写改前改后，范围写去掉的和加上的", () => {
    expect(charterChangeRows(change("p-1", 1))).toEqual([
      { key: "goal", label: "目标", kind: "replace", before: "账单进一个本子，按月出报表", after: "账单进一个本子，每周出报表" },
      { key: "scope", label: "范围", kind: "scope", removed: ["按月出报表"], added: ["每周出报表"] },
    ]);
  });

  test("项目页立项书一节下列这个项目的几张（先提的在前），别的项目的、别的卡不列", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c-2", 1, { type: "charter_change", payload: change("p-1", 2), createdAt: "2026-10-08T09:00:00.000+08:00" }) }),
      frame("cards", 2, "card", { card: card("c-1", 1, { type: "charter_change", payload: change("p-1", 1), createdAt: "2026-10-07T09:00:00.000+08:00" }) }),
      frame("cards", 3, "card", { card: card("c-3", 1, { type: "charter_change", payload: change("p-2", 1) }) }),
      frame("cards", 4, "card", { card: card("c-4", 1, { type: "charter", payload: { projectId: "p-1" } }) }),
    ]);
    expect(projectCharterChangeCards(state, "p-1")).toEqual(["c-1", "c-2"]);
    expect(projectCharterChangeCards(state, "p-3")).toEqual([]);
  });
});

describe("从这里重做时直接改这一阶段", () => {
  const criteria = ["周报覆盖完整一周", "来源都能点开"];
  const deliverables = ["周报 weekly.md"];
  const draft = stageEditDraft(criteria, deliverables);

  test("打开时的草稿就是原来的（各记着自己是第几条）；没改不交", () => {
    expect(draft).toEqual({ acceptance: [{ text: "周报覆盖完整一周", from: 0 }, { text: "来源都能点开", from: 1 }], deliverables: ["周报 weekly.md"] });
    expect(stageEditOf(criteria, deliverables, draft)).toBeUndefined();
    // 只多了首尾空白、空的新条目：也算没改
    expect(stageEditOf(criteria, deliverables, { acceptance: [{ text: " 周报覆盖完整一周 ", from: 0 }, { text: "来源都能点开", from: 1 }, { text: "  " }], deliverables: ["周报 weekly.md", ""] })).toBeUndefined();
  });

  test("改了一条：交整栏验收标准，改过的记着原来是第几条，新加的不记；交付件没改不交", () => {
    const edited = { ...draft, acceptance: [{ text: "周报覆盖到今天就行", from: 0 }, { text: "来源都能点开", from: 1 }, { text: "附上一句总评" }] };
    expect(stageEditOf(criteria, deliverables, edited)).toEqual({
      acceptance: [{ criterion: "周报覆盖到今天就行", from: 0 }, { criterion: "来源都能点开", from: 1 }, { criterion: "附上一句总评" }],
    });
  });

  test("去掉一条也算改了；只改交付件就只交交付件", () => {
    expect(stageEditOf(criteria, deliverables, { ...draft, acceptance: [{ text: "来源都能点开", from: 1 }] })).toEqual({ acceptance: [{ criterion: "来源都能点开", from: 1 }] });
    expect(stageEditOf(criteria, deliverables, { ...draft, deliverables: ["周报 weekly.md", "说明 notes.md"] })).toEqual({ deliverables: ["周报 weekly.md", "说明 notes.md"] });
  });

  test("验收标准、交付件都得至少留一条", () => {
    expect(stageEditProblem(draft)).toBeUndefined();
    expect(stageEditProblem({ ...draft, acceptance: [{ text: " ", from: 0 }] })).toBe("验收标准至少留一条");
    expect(stageEditProblem({ ...draft, deliverables: [""] })).toBe("交付件至少留一条");
  });
});
