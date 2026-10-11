// 91 号票第 6 块：长程任务的会话按阶段成框（照 AgentSense bedf5a5 的 ui/stageBox.tsx）——
// 聊天里只留你说的、Agent 说的、计划和出错（二狗：你的消息、语音、回复、任务书、计划卡、计划变更卡、自行调整计划的记录、
// 还等你处理的卡、这一轮出错的说明），其余连着的按阶段分组：同一阶段连着的是一组，中间插了照常显示的就断开；自己不带阶段的
// 跟着后面最近的那个阶段，后面没有就跟前面的；都没有的是一条细的（不属于哪个阶段的后台事项）。
// 每个框：第几阶段、标题、出过的情况、完成情况；一句小结；点开是要点。收着时条外的标注一类一条。
// 回放：task-execution（一条直线，验收通过、你从「写报告」重做）、task-plan-change（并行的两个阶段，计划变更、卡住求助）、
// task-rejections（审批你拒绝了几次）、parallel-sequential（不带阶段的说明跟着后面的阶段）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type ChatItem, chatItems, replay, stageBoxEdge, stageBoxes, stageBoxRows, stageBoxSpines, stageChatShown, stageGroups, type UiInput, type UiState, zoomDecor } from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const CONV = "maintainer:tm-1" as const;

/** 回放出一个会话：状态、条目 */
function session(name: string): { state: UiState; items: ChatItem[] } {
  const state = replay(load(name));
  return { state, items: chatItems(state, CONV) };
}

/** 一组里每一条在会话里是第几条 */
const at = (items: readonly ChatItem[], ids: readonly string[]) => ids.map((id) => items.findIndex((it) => it.id === id));

/** 重做记录上写的那句（不是重做记录的给 undefined） */
const reopenSummary = (item: ChatItem) => (item.kind === "record" && item.record.type === "timeline" && item.record.timeline.kind === "reopen" ? item.record.timeline.summary : undefined);

/** 把重做记录改成没写原因的（"你说：「…」"那句去掉） */
function withoutReason(item: ChatItem): ChatItem {
  if (item.kind !== "record" || item.record.type !== "timeline") throw new Error("应当是重做记录");
  const { timeline } = item.record;
  return { ...item, record: { ...item.record, timeline: { ...timeline, summary: timeline.summary.replace(/。你说：「.*」$/, "") } } };
}

describe("哪些照常显示、其余怎么分组（AgentSense stageBox.tsx 的 SHOWN、stageGroups）", () => {
  test("一条直线的任务：任务书、计划卡、回复、写了原因的重做记录（你说：「…」）照常显示；每段后台事项按阶段成组，重做之后的那一轮另起一组", () => {
    const { state, items } = session("task-execution");
    expect(items.map((it) => stageChatShown(state, it))).toEqual([true, true, true, false, false, false, false, false, false, false, false, true, true, false, false, false, false, true]);
    expect(reopenSummary(items[12]!)).toContain("你说：「缺一段方案对比」");
    const groups = stageGroups(state, items, "t-1");
    expect(groups.map((g) => [g.stageId, at(items, g.ids)])).toEqual([
      ["s1", [3, 4, 5, 6]],
      ["s2", [7, 8, 9, 10]],
      ["s2", [13, 14, 15, 16]],
    ]);
    // 组的 id 跟着第一条，往后追加不会变
    expect(groups[0]!.id).toBe(`grp:${items[3]!.id}`);
  });

  test("计划变更卡、自行调整计划的记录照常显示，把后台事项断开；不带阶段的系统说明跟着后面最近的阶段", () => {
    const { state, items } = session("task-plan-change");
    const groups = stageGroups(state, items, "t-1");
    expect(groups.map((g) => [g.stageId, at(items, g.ids)])).toEqual([
      ["s1", [3]],
      ["s2", [6, 7, 8]],
      ["s1", [10]],
      ["s2", [11, 12, 13, 14]],
    ]);
    const parallel = session("parallel-sequential");
    const tail = stageGroups(parallel.state, parallel.items, "t-1").at(-1)!;
    // "用户没同意并行"那条不带阶段：跟着后面的 s2
    expect([tail.stageId, at(parallel.items, tail.ids)]).toEqual(["s2", [9, 10, 11, 12, 13]]);
  });

  test("还等你处理的卡照常显示（你得看得到、点得到），处理过的审批收进阶段框", () => {
    const { state, items } = session("task-rejections");
    const card = items.find((it) => it.kind === "card" && state.cards[it.cardId]?.card.type === "approval")!;
    expect(stageChatShown(state, card)).toBe(false);
    if (card.kind !== "card") throw new Error("应当是卡片");
    const pending: UiState = { ...state, cards: { ...state.cards, [card.cardId]: { ...state.cards[card.cardId]!, card: { ...state.cards[card.cardId]!.card, status: "pending" } } } };
    expect(stageChatShown(pending, card)).toBe(true);
    expect(stageGroups(state, items, "t-1").map((g) => g.stageId)).toEqual(["s1"]);
  });
});

describe("每个框上写什么（AgentSense StageBox、stageStatus、stageCaption、stageNotes）", () => {
  test("验收通过的：✓ 完成、一句小结是维护者交上来时写的那一两句；你从这里重做之前的那一轮写已作废", () => {
    const { state, items } = session("task-execution");
    const boxes = stageBoxes(state, items, "t-1", { stale: zoomDecor(state, CONV, items).stale });
    expect(boxes.map((b) => [b.no, b.title, b.status.text, b.status.cls, b.stale, b.latest])).toEqual([
      [1, "收集资料", "✓ 完成", "ok", false, true],
      [2, "写报告", "已作废", "off", true, false],
      [2, "写报告", "✓ 完成", "ok", false, true],
    ]);
    expect(boxes.map((b) => b.summary)).toEqual(["资料清单在 sources.md", "重开之前的这一轮，已经作废", "按意见补了对比"]);
    expect(boxes.map((b) => b.caption)).toEqual(["第 1 阶段 收集资料", "第 2 阶段 写报告", "第 2 阶段 写报告"]);
    expect(boxes.map((b) => [b.toolCount, b.kind])).toEqual([
      [1, "tool"],
      [1, "tool"],
      [1, "tool"],
    ]);
    // 屏幕停在框上时，标题栏的阶段标签跟着框里最后一件事
    expect(boxes[0]!.focusId).toBe(items[6]!.id);
    // 写了原因的重做记录照常显示，不在框里：重做那一轮的框上没有撤回的图标
    expect(boxes[2]!.incidents).toEqual([]);
  });

  test("对正在做的阶段点重做、两轮之间没有一句回复：在重做处断开成两个框，旧的一轮已作废，新的一轮照常（进行中）", () => {
    const { state, items } = session("task-execution");
    // 改录像：去掉重做之前那句回复（第 11 条），停在新一轮的第一次调用（第 13 条），维护者还在干活
    expect(items[11]!.kind).toBe("reply");
    expect(reopenSummary(items[12]!)).toBeDefined();
    const stale = zoomDecor(state, CONV, items).stale;
    const run = (reopen: ChatItem) => {
      const cut = [...items.slice(0, 11), reopen, items[13]!];
      return stageBoxes(state, cut, "t-1", { stale, running: true }).map((b) => [b.stageId, at(items, b.ids), b.status.text, b.stale, b.live, b.incidents.map((x) => x.kind)]);
    };
    // 写了原因的重做记录照常显示（你说的话在框外），自然把两轮断开
    expect(run(items[12]!)).toEqual([
      ["s1", [3, 4, 5, 6], "✓ 完成", false, false, []],
      ["s2", [7, 8, 9, 10], "已作废", true, false, []],
      ["s2", [13], "◐ 进行中", false, true, []],
    ]);
    // 没写原因的：重做记录收进新一轮的框、是它的第一条（AgentSense 的重开记录也在框里，算撤回一类）
    expect(run(withoutReason(items[12]!))).toEqual([
      ["s1", [3, 4, 5, 6], "✓ 完成", false, false, []],
      ["s2", [7, 8, 9, 10], "已作废", true, false, []],
      ["s2", [12, 13], "◐ 进行中", false, true, ["undo"]],
    ]);
  });

  test("要点：验收时查到的（每条标准的备注取第一行；都没有备注的写核对了几条都通过）", () => {
    const { state, items } = session("task-execution");
    const [first] = stageBoxes(state, items, "t-1", { stale: new Set() });
    expect(first!.lines).toEqual(["资料清单存在：退出码 0"]);
    const card = items[6]!;
    if (card.kind !== "card") throw new Error("应当是验收结论的进度卡");
    const entry = state.cards[card.cardId]!;
    const payload = entry.card.payload as { acceptance: { results: { note?: string }[] } };
    const bare = { ...payload, acceptance: { ...payload.acceptance, results: payload.acceptance.results.map((r) => ({ ...r, note: undefined })) } };
    const noNotes: UiState = { ...state, cards: { ...state.cards, [card.cardId]: { ...entry, card: { ...entry.card, payload: bare } } } };
    expect(stageBoxes(noNotes, items, "t-1", { stale: new Set() })[0]!.lines).toEqual(["系统核对了 1 条，都通过"]);
  });

  test("最新那一段按阶段现在的状态：卡住求助的写\"等你\"；不是最新的、没交上来的写没做完", () => {
    const { state, items } = session("task-plan-change");
    const boxes = stageBoxes(state, items, "t-1", { stale: new Set() });
    expect(boxes.map((b) => [b.stageId, b.no, b.status.text, b.status.cls])).toEqual([
      ["s1", 1, "没做完", "off"],
      ["s2", 1, "没做完", "off"],
      ["s1", 1, "◐ 等你", "live"],
      ["s2", 1, "✓ 完成", "ok"],
    ]);
    // 偏离（停下找你）算要你看一眼
    expect(boxes[2]!.incidents.map((x) => [x.kind, x.attention])).toEqual([["look", true]]);
    expect(boxes[2]!.notes.map((n) => [n.glyph, n.warn])).toEqual([["look", true]]);
  });

  test("几次审批你都拒绝了：一类合成一条（共 N 次），点开是那几条", () => {
    const { state, items } = session("task-rejections");
    const [box] = stageBoxes(state, items, "t-1", { stale: new Set() });
    const ask = box!.notes.find((n) => n.glyph === "ask")!;
    expect(ask.text).toMatch(/（共 \d+ 次）$/);
    expect(ask.items.length).toBeGreaterThan(1);
    // 任务在跑、维护者没在干活：不算正在做这一段；阶段在做——进行中，小结写正在做什么
    expect([box!.live, box!.status.text, box!.summary]).toEqual([false, "◐ 进行中", "正在：建目录 <临时目录>/ergou-out-Iaxyja/other5"]);
    expect(box!.lines.at(-1)).toBe(`已做 ${box!.toolCount} 次操作`);
  });

  test("维护者正在干活、最后一条在这一段里：这一段是 live（框上的状态一闪一闪）", () => {
    const { state, items } = session("task-rejections");
    const task = state.tasks["t-1"]!;
    const working: UiState = { ...state, activity: { ...state.activity, [task.maintainerId]: { agentId: task.maintainerId, state: "working" } as UiState["activity"][string] } };
    const [box] = stageBoxes(working, items, "t-1", { stale: new Set() });
    expect([box!.live, box!.status.cls]).toEqual([true, "live"]);
  });

  test("不属于哪个阶段的后台事项：一条细的，写一句话", () => {
    const { state, items } = session("task-execution");
    // 去掉阶段归属：都不带阶段
    const loose = items.map((it) => (it.scope.stageId ? { ...it, scope: { ...it.scope, stageId: undefined } } : it)).filter((it) => it.kind !== "card" || state.cards[it.cardId]?.card.type !== "progress");
    const boxes = stageBoxes(state, loose, "t-1", { stale: new Set() });
    expect(boxes.every((b) => b.stageId === undefined && b.no === undefined && b.status.text === "" && b.caption === b.title)).toBe(true);
    // 有工具调用的写最后那一次做了什么，只有系统说明的写"系统核对了一下进度"
    const calls = boxes.filter((b) => b.toolCount > 0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((b) => b.title !== "系统核对了一下进度" && b.title.length > 0)).toBe(true);
    const quiet = stageBoxes(
      state,
      loose.filter((it) => it.kind !== "tool_group"),
      "t-1",
      { stale: new Set() },
    );
    expect(quiet.map((b) => b.title)).toContain("系统核对了一下进度");
  });
});

describe("缩放里的阶段框（AgentSense ZoomHistory 的 edge、shownSpines）", () => {
  test("框里每一行：工具调用组拆成每次调用、每段思考（AgentSense 每次操作一行），别的是自己", () => {
    const { state, items } = session("timeline-zoom");
    const [s1] = stageGroups(state, items, "t-1");
    const members = s1!.ids.map((id) => items.find((it) => it.id === id)!);
    const rows = stageBoxRows(members);
    const group = members.find((m) => m.kind === "tool_group")!;
    expect(rows).not.toContain(group.id);
    expect(rows.length).toBeGreaterThan(members.length);
    expect(rows[0]).toBe(members[0]!.id);
  });

  test("书脊、底色带的上下沿：收着的框里的事落在框上；展开了，第一条的上沿还是框顶，别的落在各自那一条", () => {
    const { state, items } = session("task-execution");
    const groups = stageGroups(state, items, "t-1");
    const groupOf = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g] as const)));
    const g = groups[0]!;
    expect(stageBoxEdge(groupOf, new Set(), g.ids[2]!, "bottom")).toBe(`sbox:${g.id}`);
    expect(stageBoxEdge(groupOf, new Set([g.id]), g.ids[0]!, "top")).toBe(`sbox:${g.id}`);
    expect(stageBoxEdge(groupOf, new Set([g.id]), g.ids[2]!, "bottom")).toBe(g.ids[2]);
    // 照常显示的不在框里
    expect(stageBoxEdge(groupOf, new Set(), items[2]!.id, "top")).toBe(items[2]!.id);
  });

  test("书脊上写阶段的编号（并行的 1a、1b，AgentSense 写里程碑编号 M4a）", () => {
    const { state, items } = session("task-plan-change");
    const labels = new Map(zoomDecor(state, CONV, items).spines.map((sp) => [sp.stageId, sp.label]));
    expect(Object.fromEntries(labels)).toEqual({ s1: "1b", s2: "1a" });
  });

  test("书脊：每一段的上下沿落在它所在的框上；收着的框里同一阶段的几段并成一段（颜色按最后一段）", () => {
    const { state, items } = session("task-execution");
    const groups = stageGroups(state, items, "t-1");
    const groupOf = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g] as const)));
    const { spines } = zoomDecor(state, CONV, items);
    const shown = stageBoxSpines(spines, groupOf, new Set());
    // 重做那一轮从写了原因的重做记录开始：它照常显示、不在框里，上沿落在它那一行
    expect(spines.map((sp) => at(items, [sp.firstId])[0])).toEqual([3, 7, 12]);
    expect(shown.map((sp) => sp.firstId)).toEqual([...spines.slice(0, 2).map((sp) => `sbox:${groupOf.get(sp.firstId)!.id}`), items[12]!.id]);
    expect(shown.map((sp) => sp.lastId)).toEqual(spines.map((sp) => `sbox:${groupOf.get(sp.lastId)!.id}`));
    // 两段落在同一个收着的框里：并成一段
    const one = new Map(items.map((it) => [it.id, groups[0]!] as const));
    const merged = stageBoxSpines(
      spines.filter((sp) => sp.stageId === "s2"),
      one,
      new Set(),
    );
    expect(merged.length).toBe(1);
    expect(merged[0]!.state).toBe(spines.filter((sp) => sp.stageId === "s2").at(-1)!.state);
  });
});
