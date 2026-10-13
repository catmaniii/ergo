// 107 号票：会话里的"等你处理"栏。项目整页、任务整页、秘书会话把还没处理、来源是这个会话的待办事项列在会话和输入框之间，
// 哪些属于这个会话只用 105 号票的 inboxJump 认；已处理、已归档的不进，处理了就从栏里消失。
// 回放主切面录下的事件流（task-over-budget、grant-renewal、task-rejections、archive-list、project-lifecycle、secretary-approval），
// 录不出来的（项目内部任务、多项目任务派到项目的工单）手写。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHANNELS,
  initialUiState,
  type InboxBarEntry,
  inboxBarEntries,
  type InboxItem,
  type InboxOrigin,
  type InboxPlace,
  maintainerChannel,
  type Project,
  replay,
  type Task,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { card, cardInboxItem, frame, inboxItem } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const payloadOf = <T>(input: UiInput, type: string): T | undefined => (input.kind === "frame" && input.frame.type === type ? (input.frame.payload as T) : undefined);

/**
 * 这几份录制在 105 号票之前，待我处理事项上还没有来源（origin）。照守护进程现在的记法补上，其余照录下的原样回放：
 * 任务的事项记任务（taskInboxOrigin），任务里的审批卡另记调用所在的会话（callInboxOrigin：任务维护者的会话）；
 * 项目的事项记项目；秘书对话里的审批卡记秘书会话；系统的（归档清单）不记
 */
function withOrigins(inputs: readonly UiInput[]): UiInput[] {
  const tasks = new Map<string, Task>();
  const projects = new Map<string, Project>();
  const cardTypes = new Map<string, string>();
  for (const input of inputs) {
    const task = payloadOf<{ task: Task }>(input, "task")?.task;
    if (task) tasks.set(task.title, task);
    const project = payloadOf<{ project: Project }>(input, "project")?.project;
    if (project) projects.set(project.name, project);
    const c = payloadOf<{ card: { id: string; type: string } }>(input, "card")?.card;
    if (c) cardTypes.set(c.id, c.type);
  }
  const originOf = (item: InboxItem): InboxOrigin | undefined => {
    const approval = item.kind === "card" && cardTypes.get(item.cardId) === "approval";
    const task = tasks.get(/^任务「(.+)」$/.exec(item.source)?.[1] ?? "");
    if (task) return approval ? { taskId: task.id, conversation: maintainerChannel(task.maintainerId) } : { taskId: task.id };
    const project = projects.get(/^项目「(.+?)」/.exec(item.source)?.[1] ?? "");
    if (project) return { projectId: project.id };
    if (approval && item.source.endsWith("对话")) return { conversation: CHANNELS.secretary };
    return undefined;
  };
  return inputs.map((input) => {
    const item = payloadOf<{ item: InboxItem }>(input, "inbox_item")?.item;
    const origin = item && originOf(item);
    return input.kind === "frame" && origin ? { ...input, frame: { ...input.frame, payload: { item: { ...item, origin } } } } : input;
  });
}

/** 录下的事件流回放到第 index 条（含）为止 */
const stateAt = (inputs: readonly UiInput[], index: number) => replay(inputs.slice(0, index + 1));

/** 某个事项帧在事件流里的下标：第 nth 次出现这种通知（或这张卡的事项） */
function itemAt(inputs: readonly UiInput[], match: (item: InboxItem) => boolean, nth = 0): number {
  const at = inputs.flatMap((input, i) => {
    const item = payloadOf<{ item: InboxItem }>(input, "inbox_item")?.item;
    return item && match(item) ? [i] : [];
  })[nth];
  if (at === undefined) throw new Error("录好的事件流里没有这一项");
  return at;
}

/** 本地动作在事件流里的下标（第 nth 次） */
function actionAt(inputs: readonly UiInput[], kind: UiInput["kind"], nth = 0): number {
  const at = inputs.flatMap((input, i) => (input.kind === kind ? [i] : []))[nth];
  if (at === undefined) throw new Error(`录好的事件流里没有 ${kind}`);
  return at;
}

const isNotice = (notice: string) => (item: InboxItem) => item.kind === "notice" && item.notice === notice;
const isCardItem = (item: InboxItem) => item.kind === "card";

/** 栏里每一项写成 [种类, 定位到哪]，看得清 */
const brief = (entries: readonly InboxBarEntry[]) => entries.map((e) => [e.item.kind === "notice" ? e.item.notice : "card", e.at ?? null]);

const task = (taskId: string): InboxPlace => ({ kind: "task", taskId });
const project = (projectId: string): InboxPlace => ({ kind: "project", projectId });
const secretary: InboxPlace = { kind: "secretary" };

describe("任务整页：负责它的 agent 的会话", () => {
  test("超预算（task-over-budget）：计划卡在栏里（看卡片定位到它），确认后消失；转等我时超预算进栏，选了追加预算继续就没了", () => {
    const inputs = withOrigins(load("task-over-budget"));
    const plan = stateAt(inputs, itemAt(inputs, isCardItem));
    const planCard = Object.values(plan.inbox)[0]!;
    expect(brief(inboxBarEntries(plan, task("t-1")))).toEqual([["card", planCard.kind === "card" ? planCard.cardId : ""]]);
    // 卡在会话里点了确认：卡的状态一变，这一项就不在栏里（卡片事项看卡本身的状态）
    expect(inboxBarEntries(stateAt(inputs, actionAt(inputs, "card_action") + 2), task("t-1"))).toEqual([]);

    const waiting = stateAt(inputs, itemAt(inputs, isNotice("over_budget")));
    expect(brief(inboxBarEntries(waiting, task("t-1")))).toEqual([["over_budget", null]]);
    expect(inboxBarEntries(waiting, task("t-1"))[0]!.item).toMatchObject({ kind: "notice", actions: ["追加预算继续"], urgency: "blocking" });
    // 别的会话的栏里没有它
    expect(inboxBarEntries(waiting, task("t-2"))).toEqual([]);
    expect(inboxBarEntries(waiting, secretary)).toEqual([]);

    const resumed = stateAt(inputs, itemAt(inputs, isNotice("over_budget"), 1));
    expect(resumed.inbox[inboxBarEntries(waiting, task("t-1"))[0]!.item.id]).toMatchObject({ handled: "追加预算继续" });
    expect(inboxBarEntries(resumed, task("t-1"))).toEqual([]);
  });

  test("授权到期续期（grant-renewal）：两次续期事项各在栏里一回，续期、不续之后都消失；过期后的审批卡进栏、拒绝后消失", () => {
    const inputs = withOrigins(load("grant-renewal"));
    const renewal = isNotice("grant_renewal");
    const first = stateAt(inputs, itemAt(inputs, renewal, 0));
    expect(brief(inboxBarEntries(first, task("t-1")))).toEqual([["grant_renewal", null]]);
    expect(inboxBarEntries(stateAt(inputs, itemAt(inputs, renewal, 1)), task("t-1"))).toEqual([]);
    expect(brief(inboxBarEntries(stateAt(inputs, itemAt(inputs, renewal, 2)), task("t-1")))).toEqual([["grant_renewal", null]]);
    expect(inboxBarEntries(stateAt(inputs, itemAt(inputs, renewal, 3)), task("t-1"))).toEqual([]);

    const approvalAt = itemAt(inputs, isCardItem, 1);
    const approval = stateAt(inputs, approvalAt);
    const cardId = Object.values(approval.cards).find((c) => c.card.type === "approval")!.card.id;
    expect(brief(inboxBarEntries(approval, task("t-1")))).toEqual([["card", cardId]]);
    expect(inboxBarEntries(replay(inputs), task("t-1"))).toEqual([]);
  });

  test("任务里的审批卡（task-rejections）：记的是任务维护者的会话，在任务的栏里，看卡片定位到卡；五次都拒绝之后栏里没有了", () => {
    const inputs = withOrigins(load("task-rejections"));
    for (let n = 1; n <= 5; n += 1) {
      const at = itemAt(inputs, isCardItem, n);
      const entries = inboxBarEntries(stateAt(inputs, at), task("t-1"));
      const item = payloadOf<{ item: InboxItem }>(inputs[at]!, "inbox_item")!.item;
      expect(brief(entries)).toEqual([["card", item.kind === "card" ? item.cardId : ""]]);
    }
    expect(inboxBarEntries(replay(inputs), task("t-1"))).toEqual([]);
  });

  test("几个任务各有各的（archive-list）：每个任务的栏里只有自己的等你验收、失败后的抉择；系统的归档清单不进任何会话的栏", () => {
    const inputs = withOrigins(load("archive-list"));
    const all = stateAt(inputs, itemAt(inputs, isNotice("stage_acceptance"), 2));
    expect(brief(inboxBarEntries(all, task("t-1")))).toEqual([["stage_acceptance", null]]);
    expect(brief(inboxBarEntries(all, task("t-2")))).toEqual([["stage_acceptance", null]]);
    expect(brief(inboxBarEntries(all, task("t-3")))).toEqual([["failure_choice", null]]);
    expect(brief(inboxBarEntries(all, task("t-4")))).toEqual([["stage_acceptance", null]]);
    expect(inboxBarEntries(all, task("t-4"))[0]!.item.title).toBe("等你验收：搬家清单 第 1 阶段「动手做」");

    const end = replay(inputs);
    // 验收通过、重试过的消失；没处理的（任务取消了，事项照旧在待办的待处理里）还在
    expect(inboxBarEntries(end, task("t-1"))).toEqual([]);
    expect(inboxBarEntries(end, task("t-2"))).toEqual([]);
    expect(inboxBarEntries(end, task("t-3"))).toEqual([]);
    expect(brief(inboxBarEntries(end, task("t-4")))).toEqual([["stage_acceptance", null]]);
    const archiveList = Object.values(end.inbox).find((i) => i.kind === "card" && end.cards[i.cardId]?.card.type === "archive_list")!;
    expect(archiveList).toBeDefined();
    for (const place of [task("t-1"), task("t-2"), task("t-3"), task("t-4"), secretary]) expect(inboxBarEntries(end, place).map((e) => e.item.id)).not.toContain(archiveList.id);
  });

  test("排序和待办的待处理一样：卡着任务的在前，同一档里新的在前", () => {
    const state: UiState = {
      ...initialUiState,
      inbox: Object.fromEntries(
        [
          inboxItem("old", { notice: "grant_renewal", createdAt: "2026-10-07T08:00:00.000+08:00", origin: { taskId: "t-1" } }),
          inboxItem("new", { notice: "grant_renewal", createdAt: "2026-10-07T10:00:00.000+08:00", origin: { taskId: "t-1" } }),
          inboxItem("blocking", { notice: "stage_acceptance", urgency: "blocking", createdAt: "2026-10-07T07:00:00.000+08:00", origin: { taskId: "t-1" } }),
        ].map((i) => [i.id, i]),
      ),
    };
    expect(inboxBarEntries(state, task("t-1")).map((e) => e.item.id)).toEqual(["blocking", "new", "old"]);
  });
});

describe("项目整页：维护者的会话", () => {
  test("立项书（project-lifecycle）：在项目的栏里、看卡片定位到它，确认立项后消失；别的项目、秘书会话的栏里没有", () => {
    const inputs = withOrigins(load("project-lifecycle"));
    const charter = stateAt(inputs, itemAt(inputs, isCardItem));
    const cardId = Object.values(charter.cards).find((c) => c.card.type === "charter")!.card.id;
    expect(brief(inboxBarEntries(charter, project("p-1")))).toEqual([["card", cardId]]);
    expect(inboxBarEntries(charter, project("p-2"))).toEqual([]);
    expect(inboxBarEntries(charter, secretary)).toEqual([]);
    expect(inboxBarEntries(stateAt(inputs, actionAt(inputs, "card_action", 1) + 5), project("p-1"))).toEqual([]);
  });

  test("删除项目的确认（project-lifecycle）：项目已归档、会话只读，照样在栏里；确认删除之后消失", () => {
    const inputs = withOrigins(load("project-lifecycle"));
    const asked = stateAt(inputs, itemAt(inputs, isNotice("project_delete")));
    expect(asked.projects["p-2"]?.state).toBe("archived");
    expect(brief(inboxBarEntries(asked, project("p-2")))).toEqual([["project_delete", null]]);
    expect(inboxBarEntries(asked, project("p-2"))[0]!.item).toMatchObject({ kind: "notice", actions: ["确认删除", "不删了"] });
    expect(inboxBarEntries(asked, project("p-1"))).toEqual([]);
    expect(inboxBarEntries(stateAt(inputs, itemAt(inputs, isNotice("project_delete"), 1)), project("p-2"))).toEqual([]);
  });

  // 项目内部任务的维护者就是项目的维护者，卡出在项目的维护者会话里；多项目任务派到项目的工单也由项目维护者做（17 号票）
  const world: UiState = {
    ...initialUiState,
    tasks: {
      "t-in": { id: "t-in", maintainerId: "pm-1", internal: { projectId: "p-1", projectName: "记账本" } } as Task,
      "t-multi": { id: "t-multi", maintainerId: "tm-multi" } as Task,
    },
    projects: { "p-1": { id: "p-1", maintainerId: "pm-1" } as Project, "p-2": { id: "p-2", maintainerId: "pm-2" } as Project },
    cards: { "c-appr": { card: card("c-appr", 1, { type: "approval" }) } },
  };
  const internal = { internal: { projectId: "p-1", projectName: "记账本" } };
  const inbox = (...items: InboxItem[]): UiState => ({ ...world, inbox: Object.fromEntries(items.map((i) => [i.id, i])) });

  test("项目内部任务的事项（去处是那个内部任务的整页）：内部任务的栏里有，项目的维护者会话也是它的会话，项目的栏里也有", () => {
    const state = inbox(inboxItem("i-acc", { notice: "stage_acceptance", origin: { taskId: "t-in", projectId: "p-1", stageId: "2" }, ...internal }));
    expect(brief(inboxBarEntries(state, task("t-in")))).toEqual([["stage_acceptance", null]]);
    expect(brief(inboxBarEntries(state, project("p-1")))).toEqual([["stage_acceptance", null]]);
    expect(inboxBarEntries(state, project("p-2"))).toEqual([]);
  });

  test("多项目任务派到项目的工单里的审批卡：卡在项目维护者的会话里，进项目的栏，不进多项目任务的栏", () => {
    const state = inbox(cardInboxItem("i-appr", "c-appr", { origin: { taskId: "t-multi", projectId: "p-1", conversation: "maintainer:pm-1", toolCallId: "call-3" } }));
    expect(brief(inboxBarEntries(state, project("p-1")))).toEqual([["card", "c-appr"]]);
    expect(inboxBarEntries(state, task("t-multi"))).toEqual([]);
  });
});

describe("秘书会话", () => {
  test("秘书对话里的审批卡（secretary-approval）：在秘书的栏里、看卡片定位到它，批准后消失；任务、项目的栏里没有", () => {
    const inputs = withOrigins(load("secretary-approval"));
    const asked = stateAt(inputs, itemAt(inputs, isCardItem));
    const cardId = Object.values(asked.cards)[0]!.card.id;
    expect(brief(inboxBarEntries(asked, secretary))).toEqual([["card", cardId]]);
    expect(inboxBarEntries(asked, task("t-1"))).toEqual([]);
    expect(inboxBarEntries(asked, project("p-1"))).toEqual([]);
    expect(inboxBarEntries(replay(inputs), secretary)).toEqual([]);
  });

  test("秘书对话里的中断不确定：定位到那次调用", () => {
    const state: UiState = { ...initialUiState, inbox: { "i-int": inboxItem("i-int", { notice: "interrupted", origin: { conversation: "secretary", toolCallId: "call-9" } }) } };
    expect(brief(inboxBarEntries(state, secretary))).toEqual([["interrupted", "call-9"]]);
  });
});

describe("不进栏的", () => {
  test("已归档的（还没处理）不进", () => {
    const inputs = withOrigins(load("task-over-budget"));
    const at = itemAt(inputs, isNotice("over_budget"));
    const item = payloadOf<{ item: InboxItem }>(inputs[at]!, "inbox_item")!.item;
    const archived = replay([...inputs.slice(0, at + 1), { kind: "frame", frame: frame(CHANNELS.inbox, 999, "inbox_item", { item: { ...item, version: item.version + 1, archived: true } }) }]);
    expect(archived.inbox[item.id]).toMatchObject({ archived: true });
    expect(inboxBarEntries(archived, task("t-1"))).toEqual([]);
  });

  test("没记来源的旧事项（105 号票之前建的）、系统的事项不进任何会话的栏", () => {
    const old = replay(load("archive-list").slice(0, itemAt(load("archive-list"), isNotice("stage_acceptance"), 2) + 1));
    expect(Object.values(old.inbox).length).toBeGreaterThan(0);
    for (const place of [task("t-1"), task("t-4"), project("p-1"), secretary]) expect(inboxBarEntries(old, place)).toEqual([]);
    const system: UiState = { ...initialUiState, inbox: { "i-backup": inboxItem("i-backup", { notice: "backup_failed" }), "i-rem": inboxItem("i-rem", { notice: "reminder_due" }) } };
    expect(inboxBarEntries(system, secretary)).toEqual([]);
  });
});
