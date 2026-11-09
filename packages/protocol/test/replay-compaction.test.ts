// 冷补发只发最新的（456）：一个频道的事件里，同一件事被后来的事件整份盖掉的旧记录不发、本机不存。规则表齐全（协议里每个落盘事件类型
// 都声明了按什么合并或者不合并）、每个类型的规则、不认识的全留、最后一条总在、接着往后加和一次合并整段的一样。
// 合并后折出来的界面状态和全量的一样，在网页的等价测试里锁（packages/web/test/state/open-snapshot.test.ts）。
import { describe, expect, it } from "vitest";
import {
  addToCompaction,
  type CompactableEvent,
  compactChannel,
  copyCompaction,
  EPHEMERAL_EVENT_TYPES,
  EVENT_TYPES,
  emptyCompaction,
  isChannelCompaction,
  isEphemeralEventType,
  REPLAY_COMPACTION_RULES,
  survivingSeqs,
} from "../src/index.ts";

const ev = (seq: number, type: string, payload: unknown): CompactableEvent => ({ seq, type, payload });
const seqs = (events: readonly CompactableEvent[]) => compactChannel(events).map((e) => e.seq);
const deleted = { deleted: true, deletedAt: "2026-11-09T09:00:00.000+08:00" };

const task = (seq: number, id: string, change = "updated", extra: Record<string, unknown> = {}) => ev(seq, EVENT_TYPES.task, { task: { id, ...extra }, change });
const card = (seq: number, id: string, version: number, type = "suggest_task") => ev(seq, EVENT_TYPES.card, { card: { id, version, type } });
const totals = (seq: number, id: string) => ev(seq, EVENT_TYPES.tokenTotals, { owner: { kind: "task", id }, calls: seq });
const activity = (seq: number, agentId: string) => ev(seq, EVENT_TYPES.activity, { agentId, state: "working" });
const wo = (seq: number, id: string) => ev(seq, EVENT_TYPES.workOrder, { workOrder: { id } });
const project = (seq: number, id: string, change: string) => ev(seq, EVENT_TYPES.project, { project: { id }, change });
const item = (seq: number, id: string, del = false) => ev(seq, EVENT_TYPES.inboxItem, { item: { id, deleted: del } });
const device = (seq: number, id: string, gone = false) =>
  ev(seq, EVENT_TYPES.device, { device: { id, ...(gone ? { deletedAt: "2026-11-09T09:00:00.000+08:00" } : {}) }, change: gone ? "deleted" : "used" });
const mark = (seq: number, conversation: string, at: number) => ev(seq, EVENT_TYPES.readMark, { conversation, seq: at, time: "2026-11-09T09:00:00.000+08:00" });
const reminder = (seq: number, id: string) => ev(seq, EVENT_TYPES.reminder, { reminder: { id } });
const job = (seq: number, id: string, runId?: string) => ev(seq, EVENT_TYPES.scheduledJob, { job: { id }, change: "run_finished", ...(runId ? { run: { runId } } : {}) });
const plan = (seq: number, taskId: string) => ev(seq, EVENT_TYPES.taskPlan, { taskId, version: seq });
const scope = (seq: number, id: string) => ev(seq, EVENT_TYPES.scopeRecord, { record: { id } });

describe("规则表", () => {
  it("协议里每个落盘事件类型都写了规则（按什么合并，或者明说不合并）；临时事件、不在协议里的不写", () => {
    const persisted = Object.values(EVENT_TYPES).filter((type) => !isEphemeralEventType(type));
    const missing = persisted.filter((type) => !(type in REPLAY_COMPACTION_RULES));
    // 新加了一个落盘事件类型？在 replay-compaction.ts 的 REPLAY_COMPACTION_RULES 里写一条：能不能合并、按什么键（拿不准就 none）
    expect(missing).toEqual([]);
    expect(Object.keys(REPLAY_COMPACTION_RULES).filter((type) => !persisted.includes(type as never))).toEqual([]);
    for (const type of EPHEMERAL_EVENT_TYPES) expect(REPLAY_COMPACTION_RULES[type]).toBeUndefined();
  });

  it("合并的只有页面一打开就订阅的那几个频道上前端整份替换的类型；会话频道上的、守护进程内部的、拿不准的不合并", () => {
    const merged = Object.entries(REPLAY_COMPACTION_RULES)
      .filter(([, rule]) => rule.merge === "claims")
      .map(([type]) => type)
      .toSorted();
    expect(merged).toEqual(
      [
        EVENT_TYPES.card,
        EVENT_TYPES.inboxItem,
        EVENT_TYPES.task,
        EVENT_TYPES.reminder,
        EVENT_TYPES.scheduledJob,
        EVENT_TYPES.tokenTotals,
        EVENT_TYPES.taskPlan,
        EVENT_TYPES.scopeRecord,
        EVENT_TYPES.activity,
        EVENT_TYPES.device,
        EVENT_TYPES.holidayData,
        EVENT_TYPES.workdaySettings,
        EVENT_TYPES.watchCategorySettings,
        EVENT_TYPES.assistantName,
        EVENT_TYPES.language,
        EVENT_TYPES.readMark,
        EVENT_TYPES.project,
        EVENT_TYPES.workOrder,
      ].toSorted(),
    );
    for (const type of [EVENT_TYPES.message, EVENT_TYPES.voice, EVENT_TYPES.pluginDataPurged, EVENT_TYPES.cardDismissed, EVENT_TYPES.questionsAnswered, EVENT_TYPES.approvalDecided]) {
      expect(REPLAY_COMPACTION_RULES[type]).toEqual({ merge: "none" });
    }
  });

  it("不认识的类型（以后新加的、插件自己的）、不合并的类型、临时事件：每条都留", () => {
    const events = [ev(1, "plugin_thing", { id: "x" }), ev(2, "plugin_thing", { id: "x" }), ev(3, EVENT_TYPES.message, { message: { id: "m" } }), ev(4, EVENT_TYPES.message, { message: { id: "m" } })];
    expect(seqs(events)).toEqual([1, 2, 3, 4]);
    expect(seqs([ev(1, EVENT_TYPES.pluginDataPurged, {}), ev(2, EVENT_TYPES.pluginDataPurged, {}), ev(3, EVENT_TYPES.cardStale, {})])).toEqual([1, 2, 3]);
  });

  it("负载的样子不认识（取不出键）的照留", () => {
    expect(seqs([ev(1, EVENT_TYPES.task, {}), ev(2, EVENT_TYPES.task, { task: { id: 7 } }), ev(3, EVENT_TYPES.card, { card: { id: "c" } }), ev(4, EVENT_TYPES.activity, null)])).toEqual([1, 2, 3, 4]);
  });
});

describe("每个类型怎么合并", () => {
  it("后来的整份替换前面的：按实体留最后一条，留下的照原来的先后", () => {
    const events = [totals(1, "t-1"), totals(2, "t-2"), totals(3, "t-1"), totals(4, "t-1"), totals(5, "t-2"), totals(6, "t-3")];
    expect(seqs(events)).toEqual([4, 5, 6]);
    expect(seqs([activity(1, "a"), activity(2, "b"), activity(3, "a")])).toEqual([2, 3]);
    expect(seqs([wo(1, "w1"), wo(2, "w1"), wo(3, "w2")])).toEqual([2, 3]);
  });

  it("全局只有一份的（名字、语言、工作日历、关注类别）：留最后一条，几种各留各的", () => {
    const events = [
      ev(1, EVENT_TYPES.holidayData, { years: [] }),
      ev(2, EVENT_TYPES.workdaySettings, { settings: {} }),
      ev(3, EVENT_TYPES.workdaySettings, { settings: {} }),
      ev(4, EVENT_TYPES.holidayData, { years: [] }),
      ev(5, EVENT_TYPES.workdaySettings, { settings: {} }),
    ];
    expect(seqs(events)).toEqual([4, 5]);
    expect(seqs([1, 2, 3].map((s) => ev(s, EVENT_TYPES.assistantName, { name: `n${s}` })))).toEqual([3]);
    expect(seqs([1, 2].map((s) => ev(s, EVENT_TYPES.language, { language: "en" })))).toEqual([2]);
    expect(seqs([1, 2].map((s) => ev(s, EVENT_TYPES.watchCategorySettings, { categories: [] })))).toEqual([2]);
  });

  it("任务：每个留最后一条；返工每条都留（前端攒返工记录）；删除的照留（连带拿掉计划、返工、负责人会话）", () => {
    const events = [task(1, "t-1", "created"), task(2, "t-1"), task(3, "t-1", "rework"), task(4, "t-2", "created"), task(5, "t-1"), task(6, "t-1", "rework"), task(7, "t-1")];
    expect(seqs(events)).toEqual([3, 4, 6, 7]);
    // 删掉的任务：最后一条（删除）留下，之前的不发
    expect(seqs([task(1, "t-1", "created"), task(2, "t-1"), task(3, "t-1", "deleted", { deleted: true }), task(4, "t-2")])).toEqual([3, 4]);
    // 删了又来了（拿不准会不会有）：删除那条照留，先后不变
    expect(seqs([task(1, "t-1", "created"), task(2, "t-1", "deleted", { deleted: true }), task(3, "t-1"), task(4, "t-2")])).toEqual([2, 3, 4]);
  });

  it("项目：每个留最后一条；删除的照留（连带拿掉项目内部的任务、工单、范围记录）", () => {
    expect(seqs([project(1, "p", "created"), project(2, "p", "charter_confirmed"), project(3, "q", "created"), project(4, "p", "deleted"), project(5, "q", "paused")])).toEqual([4, 5]);
    expect(seqs([project(1, "p", "deleted"), project(2, "p", "created")])).toEqual([1, 2]);
  });

  it("卡片：每张留版本最大的；一样大的留先到的（前端后到的不认）；快速动作卡每版都留；\"已删除\"标记不发", () => {
    expect(seqs([card(1, "c", 1), card(2, "d", 1), card(3, "c", 2), card(4, "c", 3), card(5, "d", 2)])).toEqual([4, 5]);
    expect(seqs([card(1, "c", 2), card(2, "c", 2), card(3, "d", 1)])).toEqual([1, 3]);
    // 版本往回走的（不该有）：留版本大的；最后一条总在
    expect(seqs([card(1, "c", 3), card(2, "c", 2), card(3, "d", 1), card(4, "c", 1)])).toEqual([1, 3, 4]);
    expect(seqs([card(1, "q", 1, "quick_action"), card(2, "q", 2, "quick_action"), card(3, "c", 1)])).toEqual([1, 2, 3]);
    expect(seqs([ev(1, EVENT_TYPES.card, deleted), card(2, "c", 3), ev(3, EVENT_TYPES.card, deleted), card(4, "d", 1)])).toEqual([2, 4]);
  });

  it("待办、设备：每条留最后一条；最后一条是删除的整条不发（只有这个频道管它们）", () => {
    expect(seqs([item(1, "i"), item(2, "j"), item(3, "i", true), item(4, "k"), item(5, "j")])).toEqual([4, 5]);
    // 删了又来了：后来的那条留
    expect(seqs([item(1, "i"), item(2, "i", true), item(3, "i"), item(4, "k")])).toEqual([3, 4]);
    expect(seqs([device(1, "a"), device(2, "b"), device(3, "a"), device(4, "b", true), device(5, "c")])).toEqual([3, 5]);
  });

  it("最后一条总在（页面的游标是它）：哪怕它被盖掉了、是删除、是前端忽略的标记", () => {
    expect(seqs([item(1, "i"), item(2, "j"), item(3, "i", true)])).toEqual([2, 3]);
    expect(seqs([card(1, "c", 2), card(2, "c", 1)])).toEqual([1, 2]);
    expect(seqs([card(1, "c", 1), ev(2, EVENT_TYPES.card, deleted)])).toEqual([1, 2]);
    expect(seqs([])).toEqual([]);
  });

  it("提醒、定时作业：各留最后一条；看板上最后一条提醒或作业事件总留着（日历按它的序号认旧）——\"已删除\"标记也是", () => {
    expect(seqs([reminder(1, "r"), reminder(2, "r"), reminder(3, "s"), totals(4, "t")])).toEqual([2, 3, 4]);
    expect(seqs([reminder(1, "r"), ev(2, EVENT_TYPES.reminder, deleted), ev(3, EVENT_TYPES.reminder, deleted), totals(4, "t")])).toEqual([1, 3, 4]);
    // 作业：每个作业最后一条，每次运行最后说到它的那条
    expect(seqs([job(1, "j"), job(2, "j", "run-1"), job(3, "j", "run-1"), job(4, "j", "run-2"), job(5, "j"), totals(6, "t")])).toEqual([3, 4, 5, 6]);
    // 日历：作业的赢家早，最后一条提醒或作业事件是另一个的
    expect(seqs([job(1, "j"), reminder(2, "r"), reminder(3, "r"), job(4, "k"), totals(5, "t")])).toEqual([1, 3, 4, 5]);
  });

  it("计划、范围记录：每个留最后一条；\"已删除\"标记不发", () => {
    expect(seqs([plan(1, "t"), ev(2, EVENT_TYPES.taskPlan, deleted), plan(3, "t"), plan(4, "u"), totals(5, "x")])).toEqual([3, 4, 5]);
    expect(seqs([scope(1, "s"), scope(2, "s"), ev(3, EVENT_TYPES.scopeRecord, deleted), scope(4, "t")])).toEqual([2, 4]);
  });

  it("已读位置：每个会话留位置最靠后的那条（前端只往后挪），不看到的先后", () => {
    expect(seqs([mark(1, "secretary", 10), mark(2, "secretary", 30), mark(3, "maintainer:m", 5), mark(4, "secretary", 20), mark(5, "maintainer:m", 6)])).toEqual([2, 5]);
  });
});

/** 编一个频道：几类事件混着、实体反复更新、有删除、有返工、卡片版本 */
function mixedLog(n: number, seed = 7): CompactableEvent[] {
  let x = seed;
  const rand = (k: number) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % k;
  };
  const versions = new Map<string, number>();
  const events: CompactableEvent[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const kind = rand(8);
    const id = `e${rand(12)}`;
    if (kind === 0) events.push(task(seq, id, rand(5) === 0 ? "rework" : "updated", rand(20) === 0 ? { deleted: true } : {}));
    else if (kind === 1) {
      const v = (versions.get(id) ?? 0) + rand(2);
      versions.set(id, v);
      events.push(card(seq, id, v, rand(6) === 0 ? "quick_action" : "suggest_task"));
    } else if (kind === 2) events.push(totals(seq, id));
    else if (kind === 3) events.push(ev(seq, EVENT_TYPES.scheduledJob, { job: { id }, change: "run_started", ...(rand(2) ? { run: { runId: `r${rand(5)}` } } : {}) }));
    else if (kind === 4) events.push(ev(seq, EVENT_TYPES.inboxItem, { item: { id, deleted: rand(4) === 0 } }));
    else if (kind === 5) events.push(ev(seq, EVENT_TYPES.readMark, { conversation: "secretary", seq: rand(100) }));
    else if (kind === 6) events.push(ev(seq, EVENT_TYPES.reminder, rand(5) === 0 ? deleted : { reminder: { id } }));
    else events.push(ev(seq, rand(2) ? "plugin_thing" : EVENT_TYPES.pluginDataPurged, {}));
  }
  return events;
}

describe("接着往后加 = 一次合并整段", () => {
  it("一条条加进去留下的，和一次合并整段的一样；合并过的再合并一遍不变", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const events = mixedLog(400, seed);
      const state = emptyCompaction();
      for (const e of events) addToCompaction(state, e);
      const kept = survivingSeqs(state);
      expect([...kept].toSorted((a, b) => a - b)).toEqual(seqs(events));
      expect(seqs(compactChannel(events))).toEqual(seqs(events));
      expect(compactChannel(events).length).toBeLessThan(events.length);
    }
  });

  it("存着前一段合并后的，后一段一条不少地接着加：和整段合并的一样（页面本机存的就是这样长的）", () => {
    for (const seed of [11, 12, 13]) {
      const events = mixedLog(500, seed);
      for (const cut of [0, 1, 50, 250, 499, 500]) {
        const head = compactChannel(events.slice(0, cut));
        expect(seqs([...head, ...events.slice(cut)]), `在 ${cut} 处`).toEqual(seqs(events));
        // 一样的，用接着加的那一套：先加前一段合并后留下的，复制一份再加后一段
        const state = emptyCompaction();
        for (const e of events.slice(0, cut)) addToCompaction(state, e);
        const next = copyCompaction(state);
        for (const e of events.slice(cut)) addToCompaction(next, e);
        expect([...survivingSeqs(next)].toSorted((a, b) => a - b)).toEqual(seqs(events));
        // 复制的那份不动原来的
        expect([...survivingSeqs(state)].toSorted((a, b) => a - b)).toEqual(seqs(events.slice(0, cut)));
      }
    }
  });

  it("重复、更旧的序号不管", () => {
    const state = emptyCompaction();
    addToCompaction(state, totals(5, "a"));
    addToCompaction(state, totals(3, "a"));
    addToCompaction(state, totals(5, "b"));
    expect(state.last).toBe(5);
    expect([...survivingSeqs(state)]).toEqual([5]);
  });

  it("合并到哪儿能存成 JSON、读回来认得出；坏的认不出", () => {
    const state = emptyCompaction();
    for (const e of mixedLog(100)) addToCompaction(state, e);
    const back: unknown = JSON.parse(JSON.stringify(state));
    expect(isChannelCompaction(back)).toBe(true);
    expect(survivingSeqs(back as typeof state)).toEqual(survivingSeqs(state));
    expect(isChannelCompaction(undefined)).toBe(false);
    expect(isChannelCompaction({ last: -1, keep: [], winners: {} })).toBe(false);
    expect(isChannelCompaction({ last: 1, keep: ["x"], winners: {} })).toBe(false);
    expect(isChannelCompaction({ last: 1, keep: [], winners: { a: [1] } })).toBe(false);
    expect(isChannelCompaction({ last: 1, keep: [], winners: { a: [1, 1, 2] } })).toBe(false);
    expect(isChannelCompaction({ last: 1, keep: [], winners: [] })).toBe(false);
  });
});
