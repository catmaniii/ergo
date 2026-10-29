// 91 号票第 6 块：长程任务的会话按阶段成框——
// 聊天里只留你说的、Agent 说的、计划和出错（二狗：你的消息、语音、回复、任务书、计划卡、计划变更卡、自行调整计划的记录、
// 还等你处理的卡、这一轮出错的说明），其余连着的按阶段分组：同一阶段连着的是一组，中间插了照常显示的就断开；自己不带阶段的
// 跟着后面最近的那个阶段，后面没有就跟前面的；都没有的是一条细的（不属于哪个阶段的后台事项）。
// 每个框：第几阶段、标题、出过的情况、完成情况；一句小结；点开是要点。收着时条外的标注一类一条。
// 回放：task-execution（一条直线，验收通过、你从「写报告」重做）、task-plan-change（并行的两个阶段，计划变更、卡住求助）、
// task-rejections（审批你拒绝了几次）、parallel-sequential（不带阶段的说明跟着后面的阶段）。
// 93 号票：重做记录（写了原因的也算）收进框里；框里的验收结论画成横条（verdictStrip）；收着的框条外多了"外""权"两类。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  actNotesOf,
  type ChatItem,
  chatItems,
  replay,
  stageBoxEdge,
  stageBoxes,
  stageBoxRows,
  stageBoxSpines,
  stageChatShown,
  stageGroups,
  stageNotes,
  type UiInput,
  type UiState,
  verdictStrip,
  zoomDecor,
} from "../../src/state/index.ts";

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

describe("哪些照常显示、其余怎么分组", () => {
  test("一条直线的任务：任务书、计划卡、回复照常显示；每段后台事项按阶段成组，重做记录（写了原因的连同你说的话，93 号票）收进重做之后那一轮的框、是它的第一条", () => {
    const { state, items } = session("task-execution");
    expect(items.map((it) => stageChatShown(state, it))).toEqual([true, true, true, false, false, false, false, false, false, false, false, true, false, false, false, false, false, true]);
    expect(reopenSummary(items[12]!)).toContain("你说：「缺一段方案对比」");
    const groups = stageGroups(state, items, "t-1");
    expect(groups.map((g) => [g.stageId, at(items, g.ids)])).toEqual([
      ["s1", [3, 4, 5, 6]],
      ["s2", [7, 8, 9, 10]],
      ["s2", [12, 13, 14, 15, 16]],
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

  test("任务书按消息上的 taskBrief 认，不认文字（172 号票：英文下写的也照常显示；之前的消息没有 taskBrief，按开头的中文认）", () => {
    const { state, items } = session("task-execution");
    const brief = items[0]!;
    if (brief.kind !== "system") throw new Error("应当是任务书");
    expect(stageChatShown(state, brief)).toBe(true);
    // 274 号票重录过：录下的任务书带着 taskBrief；去掉它、换成英文的，就认不出了
    const { taskBrief: _brief, ...plain } = brief;
    const other = { ...plain, text: "Brief for task t-1" };
    expect(stageChatShown(state, other)).toBe(false);
    expect(stageChatShown(state, { ...other, taskBrief: true })).toBe(true);
  });

  test("重做之后复验没过的记录照常显示（274 号票：要先告诉你），重做记录照旧收进框里", () => {
    const { state, items } = session("task-execution");
    const reopen = items.find((it) => reopenSummary(it) !== undefined);
    if (reopen?.kind !== "record" || reopen.record.type !== "timeline") throw new Error("应当有一条重做记录");
    expect(stageChatShown(state, reopen)).toBe(false);
    const reverify = { ...reopen, record: { ...reopen.record, timeline: { ...reopen.record.timeline, kind: "reverify", summary: "阶段 s1「收集资料」按各自的验收标准再核一遍没过，不会自动重做" } } };
    expect(stageChatShown(state, reverify)).toBe(true);
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

describe("每个框上写什么", () => {
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
    // 重做记录收在重做那一轮的框里：框上有撤回的图标
    expect(boxes[2]!.incidents.map((x) => x.kind)).toEqual(["undo"]);
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
    // 写了原因的重做记录（93 号票）收进新一轮的框、是它的第一条，算撤回一类
    expect(run(items[12]!)).toEqual([
      ["s1", [3, 4, 5, 6], "✓ 完成", false, false, []],
      ["s2", [7, 8, 9, 10], "已作废", true, false, []],
      ["s2", [12, 13], "◐ 进行中", false, true, ["undo"]],
    ]);
    // 没写原因的一样
    expect(run(withoutReason(items[12]!))).toEqual([
      ["s1", [3, 4, 5, 6], "✓ 完成", false, false, []],
      ["s2", [7, 8, 9, 10], "已作废", true, false, []],
      ["s2", [12, 13], "◐ 进行中", false, true, ["undo"]],
    ]);
  });

  test("要点：系统查到的结果（274 号票，宣布完成时效果日志汇总的个数），验收时查到的（每条标准的备注取第一行；都没有备注的写核对了几条都通过）", () => {
    const { state, items } = session("task-execution");
    const [first] = stageBoxes(state, items, "t-1", { stale: new Set() });
    expect(first!.lines).toEqual(["系统查到：没有对外发送；新建 1 个文件", "资料清单存在：退出码 0"]);
    const card = items[6]!;
    if (card.kind !== "card") throw new Error("应当是验收结论的进度卡");
    const entry = state.cards[card.cardId]!;
    const payload = entry.card.payload as { acceptance: { results: { note?: string }[] } };
    const bare = { ...payload, acceptance: { ...payload.acceptance, results: payload.acceptance.results.map((r) => ({ ...r, note: undefined })) } };
    const noNotes: UiState = { ...state, cards: { ...state.cards, [card.cardId]: { ...entry, card: { ...entry.card, payload: bare } } } };
    expect(stageBoxes(noNotes, items, "t-1", { stale: new Set() })[0]!.lines).toEqual(["系统查到：没有对外发送；新建 1 个文件", "系统核对了 1 条，都通过"]);
    // 重开之前那一轮的框不写（系统查到的是这个阶段最新一轮的）：s2 重开前那一框已作废，没有这一行
    const boxes = stageBoxes(state, items, "t-1", { stale: new Set(items.slice(7, 10).map((it) => it.id)) });
    expect(boxes[1]!.lines.some((l) => l.startsWith("系统查到"))).toBe(false);
    expect(boxes[2]!.lines[0]).toBe("系统查到：没有对外发送；修改 1 个文件");
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
    expect([box!.live, box!.status.text]).toEqual([false, "◐ 进行中"]);
    // 临时目录的名字每次录像都不一样
    expect(box!.summary).toMatch(/^正在：建目录 <临时目录>\/ergo-out-\w+\/other5$/);
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

describe("缩放里的阶段框", () => {
  test("框里每一行：工具调用组拆成每次调用、每段思考（每次操作一行），别的是自己", () => {
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

  test("书脊上写阶段的编号（并行的 1a、1b）", () => {
    const { state, items } = session("task-plan-change");
    const labels = new Map(zoomDecor(state, CONV, items).spines.map((sp) => [sp.stageId, sp.label]));
    // 93 号票：编号存在计划里，维护者自行调整了先后也不变
    expect(Object.fromEntries(labels)).toEqual({ s1: "1a", s2: "1b" });
  });

  test("书脊：每一段的上下沿落在它所在的框上；收着的框里同一阶段的几段并成一段（颜色按最后一段）", () => {
    const { state, items } = session("task-execution");
    const groups = stageGroups(state, items, "t-1");
    const groupOf = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g] as const)));
    const { spines } = zoomDecor(state, CONV, items);
    const shown = stageBoxSpines(spines, groupOf, new Set());
    // 重做那一轮从重做记录开始：93 号票起它也收在框里（新一轮的第一条），上沿落在那个框上
    expect(spines.map((sp) => at(items, [sp.firstId])[0])).toEqual([3, 7, 12]);
    expect(shown.map((sp) => sp.firstId)).toEqual(spines.map((sp) => `sbox:${groupOf.get(sp.firstId)!.id}`));
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

describe("框里交上来验收的结论画成横条（93 号票）", () => {
  test("验收通过：一行\"验收通过：「…」\"，右边写核对了几条，点开逐条标准和系统查到的", () => {
    const { state, items } = session("task-execution");
    const [first] = stageBoxes(state, items, "t-1", { stale: new Set() });
    expect([...first!.strips.keys()]).toEqual([items[6]!.id]);
    expect(first!.strips.get(items[6]!.id)).toEqual({
      tone: "ok",
      icon: "✓",
      title: "验收通过：「收集资料」",
      tail: "核对 1 条",
      points: [{ text: "✓ 资料清单存在" }, { k: "系统查到", text: "退出码 0", sys: true }],
    });
  });

  test("你验收的写\"你验收的\"，你写的说明单独一条；退回的写要求、维护者交的、结果；几次都没通过的交给你决定", () => {
    const base = {
      taskId: "t-1",
      taskTitle: "X",
      stageId: "s2",
      stageTitle: "写报告",
      stageIndex: 2,
      stageTotal: 2,
      kind: "acceptance" as const,
      text: "",
    };
    const byUser = verdictStrip({ ...base, acceptance: { passed: true, judgedBy: "user", results: [{ criterion: "你认可", method: "user", passed: true, note: "可以\n多余的一行" }] } }, false);
    expect(byUser).toMatchObject({ tone: "ok", tail: "你验收的", points: [{ text: "👤 你认可" }, { text: "👤 你写的说明：「可以」" }] });
    const returned = {
      ...base,
      acceptance: {
        passed: false,
        judgedBy: "script" as const,
        summary: "报告写好了",
        results: [
          { criterion: "报告文件存在", method: "script" as const, passed: true },
          { criterion: "有方案对比", method: "script" as const, passed: false, note: "缺对比\n第二行" },
        ],
      },
    };
    expect(verdictStrip(returned, false)).toEqual({
      tone: "reject",
      icon: "✕",
      title: "已退回：「写报告」",
      tail: "和实际对不上",
      points: [
        { k: "要求", text: "有方案对比" },
        { k: "维护者交的", text: "报告写好了" },
        { k: "系统查到", text: "缺对比", sys: true },
        { k: "结果", text: "不算完成，退回让维护者重做。" },
      ],
    });
    expect(verdictStrip(returned, true)).toMatchObject({ tone: "failed", title: "几次都没通过：「写报告」", tail: "交给你决定" });
  });

  // 311 号票（294 号票端到端小测第 7 条）：验收脚本根本没跑起来（闸门进程起不来、命令找不到）时不写"和实际对不上"
  test("没过的都是验收没跑起来的：右边写“验收没跑起来”，系统查到的写起不来的原因；有一条是跑了没过的照旧写“和实际对不上”", () => {
    const base = { taskId: "t-1", taskTitle: "X", stageId: "s1", stageTitle: "实现 todo.py", stageIndex: 1, stageTotal: 2, kind: "acceptance" as const, text: "" };
    const notRun = { criterion: "add / list / done 全流程可用", method: "script" as const, passed: false, notRun: true, note: "脚本没跑起来：闸门进程起不来" };
    const strip = verdictStrip({ ...base, acceptance: { passed: false, judgedBy: "script", summary: "todo.py 写好了", results: [notRun] } }, false);
    expect(strip).toEqual({
      tone: "reject",
      icon: "✕",
      title: "已退回：「实现 todo.py」",
      tail: "验收没跑起来",
      points: [
        { k: "要求", text: "add / list / done 全流程可用" },
        { k: "维护者交的", text: "todo.py 写好了" },
        { k: "系统查到", text: "脚本没跑起来：闸门进程起不来", sys: true },
        { k: "结果", text: "验收没跑起来，不算完成，退回让维护者重做。" },
      ],
    });
    const mixed = verdictStrip({ ...base, acceptance: { passed: false, judgedBy: "script", results: [notRun, { criterion: "有 README", method: "script", passed: false, note: "退出码 1" }] } }, false);
    expect(mixed.tail).toBe("和实际对不上");
    // 几次都没通过的照旧交给你决定
    expect(verdictStrip({ ...base, acceptance: { passed: false, judgedBy: "script", results: [notRun] } }, true).tail).toBe("交给你决定");
  });

  test("几次审批你都拒绝了的那段：框里的验收结论按退回、通过各画一条", () => {
    const { state, items } = session("task-rejections");
    const boxes = stageBoxes(state, items, "t-1", { stale: new Set() });
    for (const b of boxes) for (const id of b.strips.keys()) expect(b.ids).toContain(id);
  });
});

/** 会话里的工具调用组：每次调用都记上 mark（守护进程 93 号票起记的；录像里的调用没有命中关注类别，补上） */
function withMarks(items: readonly ChatItem[], mark: "out" | "perm"): ChatItem[] {
  return items.map((it) => (it.kind === "tool_group" ? { ...it, calls: it.calls.map((c) => ({ ...c, part: { ...c.part, mark } })) } : it));
}

describe("收着的框条外的\"外\"\"权\"（93 号票）", () => {

  test("放行执行完、记了 mark 的调用：一次的写那一句，几次的按工具的中文名数；排在出过的情况后面，箭头不指框上的图标", () => {
    const { state, items } = session("task-execution");
    const marked = withMarks(items, "perm");
    const boxes = stageBoxes(state, marked, "t-1", { stale: new Set() });
    const notes = boxes[0]!.notes.filter((n) => n.glyph === "perm");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.key).toBeUndefined();
    expect(notes[0]!.items).toHaveLength(1);
    // 几次合成一条（"订票 2 次、写日历 7 次"）
    const calls = marked.flatMap((it) => (it.kind === "tool_group" ? it.calls : []));
    const twice = [...calls, ...calls].map((c, k) => ({ ...c, id: `${c.id}#${k}` }));
    const merged = stageNotes([], actNotesOf(twice)).find((n) => n.glyph === "perm")!;
    expect(merged.text).toMatch(/ \d+ 次/);
    expect(merged.items).toHaveLength(twice.length);
    // 先后：出过的情况在前，外、权在后
    const order = stageNotes([{ kind: "pullback", itemId: "x", text: "拉回" }], [
      { glyph: "perm", callId: "a", label: "写文件", text: "写 a.md" },
      { glyph: "out", callId: "b", label: "git 推送", text: "推送" },
    ]).map((n) => n.glyph);
    expect(order).toEqual(["pullback", "out", "perm"]);
  });

  test("没放行、出错的不标；之前的记录（没有 mark）不标", () => {
    const { state, items } = session("task-execution");
    const failed = items.map((it) => (it.kind === "tool_group" ? { ...it, calls: it.calls.map((c) => ({ ...c, part: { ...c.part, mark: "out" as const, outcome: "blocked" as const } })) } : it));
    expect(stageBoxes(state, failed, "t-1", { stale: new Set() }).flatMap((b) => b.notes).some((n) => n.glyph === "out")).toBe(false);
    expect(stageBoxes(state, items, "t-1", { stale: new Set() }).flatMap((b) => b.notes).some((n) => n.glyph === "out" || n.glyph === "perm")).toBe(false);
  });
});
