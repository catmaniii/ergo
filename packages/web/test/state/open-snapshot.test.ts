// 打开页面时先用的本机快照（388）：存哪些、会话留多少、先用快照再补增量和从头补出来的一样；补发攒着一次交（batch）和逐帧交一样。
// 本机存的事件（452）：网页换了一版时用本机存的事件重新折一遍、再补增量，和守护进程冷补发折出来的一样。
// 冷补发只发最新的（456）：全量冷补发、合并后冷补发、本机合并后存的重折 + 增量折出来的都一样（录下的、合成的、专门编的删除连带、返工、
// 卡片版本、重新同步）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHANNELS,
  compactChannel,
  conversationView,
  type EventFrame,
  HISTORY_PAGE_SIZE,
  initialUiState,
  isEphemeralEventType,
  isOpenSnapshot,
  keepsOpenEvents,
  olderHistory,
  reduce,
  refoldInput,
  replay,
  snapshotChanged,
  snapshotOf,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { syntheticLog, USER_SCALE } from "../open-snapshot/synthetic.ts";

const RECORDINGS = path.join(import.meta.dirname, "recordings");

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(RECORDINGS, name), "utf8")) as UiInput[];
}

/** 先用快照（存了再读回来：IndexedDB 存的是结构化克隆，这里用 JSON 走一遍，存不下的东西会露出来） */
function restored(snapshotFrom: UiState): UiState {
  const snapshot = JSON.parse(JSON.stringify(snapshotOf(snapshotFrom))) as ReturnType<typeof snapshotOf>;
  return reduce(initialUiState, { kind: "restore", snapshot });
}

const voice = (id: string, messageId: string, seq: number): EventFrame => ({
  channel: "secretary",
  seq,
  type: "voice",
  payload: { voice: { id, messageId, conversation: "secretary", mediaId: "x", mime: "audio/webm", durationMs: 1000, waveform: [], status: "done", attempt: 1, version: 1 } },
});

const message = (seq: number, speaker: "user" | "agent" = "agent"): EventFrame => ({
  channel: "secretary",
  seq,
  type: "message",
  payload: { message: { id: `m-${seq}`, conversation: "secretary", speaker, time: "2026-11-03T09:00:00.000+08:00", parts: [{ type: "text", text: `第 ${seq} 条` }] } },
});

/**
 * 比较用：语音对象只看留下的消息、排着的消息带的，和还没落到消息上的。快照里截掉了的消息，它的语音对象后来又推来新版本时
 * 先用快照的手里多一条用不上的（消息不在手里，界面不会画它），不算不一样
 */
function comparable(state: UiState) {
  const snap = snapshotOf(state);
  const ids = new Set(Object.values(snap.conversations).flatMap((c) => [...c.messages.flatMap((m) => ("message" in m ? [m.message.id] : [])), ...c.queue.map((q) => q.message.id)]));
  const used = <V extends { messageId?: string }>(voices: Readonly<Record<string, V>>) => Object.fromEntries(Object.entries(voices).filter(([, v]) => v.messageId === undefined || ids.has(v.messageId)));
  return { ...snap, voices: used(snap.voices), agentVoices: used(snap.agentVoices) };
}

describe("先用快照再补增量，和从头补出来的一样（录下的真实事件流）", () => {
  // 打开的时候守护进程补的是游标之后的事件；之前本机做过、还没等到结果的不留（下次打开不再有）
  const names = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
  for (const name of names) {
    test(`录下的 ${name}`, () => {
      const inputs = load(name);
      const full = replay(inputs);
      for (const cut of [Math.floor(inputs.length / 3), Math.floor(inputs.length / 2), Math.floor((inputs.length * 4) / 5)]) {
        const before = replay(inputs.slice(0, cut));
        const after = replay(inputs.slice(cut), restored(before));
        expect(comparable(after), `在第 ${cut} 个输入处存的快照`).toEqual(comparable(full));
        expect(after.cursors).toEqual(full.cursors);
      }
    });
  }

  test("合成的大份数据（会话比一页长、看板上几百个任务）：在中间存一份，先用它再补后面的，和从头补的一样", () => {
    const log = syntheticLog({ ...USER_SCALE, tasks: 30, cards: 40, inboxItems: 40, activityEvents: 200, readMarks: 100, deviceEvents: 20, projectEvents: 30 });
    const frames = [...log.channels.values()].flat();
    const half = (list: EventFrame[]) => list.filter((f) => f.seq <= Math.floor(log.lastSeq(f.channel) / 2));
    const before = replay(half(frames));
    const rest = frames.filter((f) => f.seq > (before.cursors[f.channel] ?? 0));
    expect(comparable(replay(rest, restored(before)))).toEqual(comparable(replay(frames)));
    expect(snapshotOf(before).conversations.secretary!.messages).toHaveLength(HISTORY_PAGE_SIZE);
  });

  test("agent 语音落到的消息还没到（合成完先改了语音，消息随后才追加）：语音对象照留", () => {
    const agentVoice = { id: "av-1", conversation: "secretary", scope: {}, inputMessageId: "m-1", replyMessageIds: [], status: "done", version: 2, createdAt: "2026-11-03T09:00:00.000+08:00", messageId: "m-later" };
    const state = replay([message(1, "user"), { channel: "secretary", seq: 2, type: "agent_voice", payload: { voice: agentVoice } }]);
    expect(Object.keys(snapshotOf(state).agentVoices)).toEqual(["av-1"]);
  });
});

/** 页面一打开就订阅的频道，照 App.tsx 的先后（守护进程冷补发按订阅的先后一个频道一个频道补） */
const OPENING_ORDER: readonly string[] = [
  CHANNELS.secretary,
  CHANNELS.cards,
  CHANNELS.inbox,
  CHANNELS.board,
  CHANNELS.activity,
  CHANNELS.devices,
  CHANNELS.workdayCalendar,
  CHANNELS.watchCategories,
  CHANNELS.projects,
  CHANNELS.assistantName,
  CHANNELS.readMarks,
  CHANNELS.language,
  CHANNELS.plugins,
  CHANNELS.backgroundAgents,
];

/** 录下的输入里守护进程最后的事件日志：按频道、序号（重新同步过的频道只留之后的；临时事件不算，两边订阅时都补推同样的） */
function serverLog(inputs: readonly UiInput[]): Map<string, EventFrame[]> {
  const log = new Map<string, Map<number, EventFrame>>();
  const visit = (input: UiInput): void => {
    if (input.kind === "batch") return input.inputs.forEach(visit);
    if (input.kind === "resync") return void log.delete(input.channel);
    if (input.kind !== "frame" || isEphemeralEventType(input.frame.type)) return;
    const channel = log.get(input.frame.channel) ?? new Map<number, EventFrame>();
    log.set(input.frame.channel, channel);
    channel.set(input.frame.seq, input.frame);
  };
  inputs.forEach(visit);
  return new Map([...log].map(([c, m]) => [c, [...m.values()].toSorted((a, b) => a.seq - b.seq)]));
}

/** 订阅的先后：一打开就订阅的，后面是后来多订阅的（负责人的会话） */
const orderOf = (log: Map<string, EventFrame[]>): string[] => [...OPENING_ORDER.filter((c) => log.has(c)), ...[...log.keys()].filter((c) => !OPENING_ORDER.includes(c)).toSorted()];

/** 守护进程从头补发（游标全 0）：一个频道一个频道补完，攒着一次交，最后 synced（会话频道两边补的一样，这里补全部） */
function coldOpen(log: Map<string, EventFrame[]>): UiState {
  const inputs: UiInput[] = orderOf(log).flatMap((c) => log.get(c)!.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })));
  return reduce(initialUiState, { kind: "batch", inputs: [...inputs, { kind: "synced" }] });
}

/**
 * 换了一版：本机存着各频道到 cut 为止的事件（会话频道不存），读出来（IndexedDB 是结构化克隆，这里用 JSON 走一遍）按订阅的先后重新折一遍；
 * 再带着游标订阅——存了的频道守护进程只补 cut 之后的，会话频道游标 0 照冷打开补
 */
function refoldThenIncrement(log: Map<string, EventFrame[]>, cut: (channel: string, frames: EventFrame[]) => number): UiState {
  const order = orderOf(log);
  const cuts = new Map(order.map((c) => [c, keepsOpenEvents(c) ? cut(c, log.get(c)!) : 0]));
  const stored = JSON.parse(JSON.stringify(order.flatMap((c) => log.get(c)!.filter((f) => f.seq <= cuts.get(c)!)))) as EventFrame[];
  const refolded = reduce(initialUiState, refoldInput(stored));
  const increment: UiInput[] = order.flatMap((c) => log.get(c)!.filter((f) => f.seq > cuts.get(c)!).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })));
  return reduce(refolded, { kind: "batch", inputs: [...increment, { kind: "synced" }] });
}

describe("换了一版：本机存的事件重新折一遍再补增量，和守护进程冷补发折出来的一样（452）", () => {
  const names = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
  for (const name of names) {
    test(`录下的 ${name}`, () => {
      const log = serverLog(load(name));
      const cold = coldOpen(log);
      for (const fraction of [0, 1 / 3, 1 / 2, 4 / 5, 1]) {
        const after = refoldThenIncrement(log, (_c, frames) => frames[Math.floor(frames.length * fraction) - 1]?.seq ?? 0);
        expect(snapshotOf(after), `各频道存到 ${fraction} 处`).toEqual(snapshotOf(cold));
        expect(after.cursors).toEqual(cold.cursors);
      }
    });
  }

  test("合成的用户量级数据（一万多条、十来 MB）：存到一半、存全了，都和冷补发的一样", () => {
    const synthetic = syntheticLog();
    const log = new Map([...synthetic.channels].map(([c, frames]) => [c, frames]));
    const cold = coldOpen(log);
    for (const fraction of [1 / 2, 1]) {
      const after = refoldThenIncrement(log, (_c, frames) => frames[Math.floor(frames.length * fraction) - 1]?.seq ?? 0);
      expect(snapshotOf(after)).toEqual(snapshotOf(cold));
      expect(after.cursors).toEqual(cold.cursors);
    }
  });

  test("会话频道（秘书会话、负责人的会话）不存，别的都存", () => {
    expect(keepsOpenEvents(CHANNELS.secretary)).toBe(false);
    expect(keepsOpenEvents("maintainer:tm-1")).toBe(false);
    for (const channel of OPENING_ORDER.filter((c) => c !== CHANNELS.secretary)) expect(keepsOpenEvents(channel)).toBe(true);
  });
});

/** 守护进程冷补发（456）：会话频道以外的每个频道合并过（协议包的 compactChannel，gateway.ts 的订阅照它） */
function compacted(log: Map<string, EventFrame[]>): Map<string, EventFrame[]> {
  return new Map([...log].map(([c, frames]) => [c, keepsOpenEvents(c) ? compactChannel(frames) : frames]));
}

/**
 * 换了一版（456 之后）：本机存的是各频道到 cut 为止的事件合并后留下的（会话频道不存），重新折一遍；再带着游标订阅，守护进程只补 cut 之后的、
 * 一条不少（会话频道游标 0 照冷打开补）
 */
function compactedRefoldThenIncrement(log: Map<string, EventFrame[]>, cut: (channel: string, frames: EventFrame[]) => number): UiState {
  const order = orderOf(log);
  const cuts = new Map(order.map((c) => [c, keepsOpenEvents(c) ? cut(c, log.get(c)!) : 0]));
  const stored = JSON.parse(JSON.stringify(order.flatMap((c) => compactChannel(log.get(c)!.filter((f) => f.seq <= cuts.get(c)!))))) as EventFrame[];
  const refolded = reduce(initialUiState, refoldInput(stored));
  const increment: UiInput[] = order.flatMap((c) => log.get(c)!.filter((f) => f.seq > cuts.get(c)!).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })));
  return reduce(refolded, { kind: "batch", inputs: [...increment, { kind: "synced" }] });
}

/** 三样都比：全量冷补发 = 合并后冷补发（整份状态逐项相等）= 本机存到各处的合并后重折 + 增量（快照、游标） */
function expectSameAsFull(log: Map<string, EventFrame[]>, label: string): void {
  const full = coldOpen(log);
  const merged = coldOpen(compacted(log));
  expect(merged, `${label}：合并后冷补发`).toEqual(full);
  for (const fraction of [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 4 / 5, 1]) {
    const after = compactedRefoldThenIncrement(log, (_c, frames) => frames[Math.floor(frames.length * fraction) - 1]?.seq ?? 0);
    expect(snapshotOf(after), `${label}：本机合并后存到 ${fraction} 处，重折 + 增量`).toEqual(snapshotOf(full));
    expect(after.cursors).toEqual(full.cursors);
  }
}

/** 编一份日志用：按频道往后排序号 */
class LogBuilder {
  readonly log = new Map<string, EventFrame[]>();
  private clock = Date.parse("2026-11-01T09:00:00.000+08:00");
  push(channel: string, type: string, payload: unknown): EventFrame {
    const list = this.log.get(channel) ?? [];
    this.log.set(channel, list);
    const frame: EventFrame = { channel, seq: list.length + 1, type, payload };
    list.push(frame);
    return frame;
  }
  time(): string {
    this.clock += 60_000;
    const d = new Date(this.clock + 8 * 3_600_000);
    return `${d.toISOString().slice(0, 23)}+08:00`;
  }
}

const stage = (stageId: string, state: string) => ({ stageId, title: `阶段 ${stageId}`, state, dependsOn: [], acceptance: [], attempts: 1, code: stageId });
function taskOf(id: string, maintainerId: string, time: string, over: Record<string, unknown> = {}) {
  return { id, title: `任务 ${id}`, summary: "编的", state: "running", origin: "request", kind: "long_running", maintainerId, projects: [], projectIds: [], projectScope: "none", createdAt: "2026-11-01T09:00:00.000+08:00", updatedAt: time, ...over };
}
const projectOf = (id: string, maintainerId: string, time: string, state = "active") => ({ id, name: `项目 ${id}`, goal: "编的", state, origin: "suggestion", maintainerId, workdir: { external: false }, charterConfirmed: true, createdAt: "2026-11-01T09:00:00.000+08:00", updatedAt: time });
const workOrderOf = (id: string, projectId: string, time: string, status: string) => ({ id, projectId, maintainerId: `pm-${projectId}`, title: `工单 ${id}`, createdAt: "2026-11-01T09:00:00.000+08:00", updatedAt: time, source: "user_task", kind: "execute", status });
const scopeOf = (id: string, time: string, projectId?: string) => ({ id, kind: "scope_change", time, summary: `范围记录 ${id}`, ...(projectId === undefined ? {} : { projectId }) });
const chat = (b: LogBuilder, channel: string, n: number) => {
  for (let i = 0; i < n; i++) b.push(channel, "message", { message: { id: `${channel}-m${i}`, conversation: channel, speaker: i % 2 === 0 ? "user" : "agent", time: b.time(), parts: [{ type: "text", text: `第 ${i} 句` }] } });
};

/** 删除连带：项目删了带走内部任务、工单、范围记录、负责人会话；任务删了带走计划、返工记录、它自己的负责人会话 */
function cascadeLog(): LogBuilder {
  const b = new LogBuilder();
  chat(b, "secretary", 6);
  b.push("projects", "project", { project: projectOf("p-1", "pm-1", b.time(), "preparing"), change: "created", from: null, by: "user" });
  b.push("projects", "project", { project: projectOf("p-2", "pm-2", b.time()), change: "created", from: null, by: "user" });
  for (let i = 0; i < 4; i++) {
    b.push("board", "task", { task: taskOf("t-a", "pm-1", b.time(), { internal: { projectId: "p-1", projectName: "项目 p-1" }, projectIds: ["p-1"], projectScope: "single", stages: { total: 1, current: 1, list: [stage("s1", "working")] } }), change: i === 0 ? "created" : "updated", from: null, by: "system" });
    b.push("board", "token_totals", { owner: { kind: "task", id: "t-a" }, tokens: { cacheHit: i, cacheMiss: i, output: i }, calls: i + 1, byAgent: [], byStage: [], time: b.time() });
    b.push("board", "task", { task: taskOf("t-b", "tm-b", b.time()), change: i === 0 ? "created" : "updated", from: null, by: "system" });
    b.push("board", "task_plan", { taskId: "t-b", version: i + 1, plan: { stages: [] }, time: b.time() });
    b.push("projects", "work_order", { workOrder: workOrderOf("wo-1", "p-1", b.time(), i < 3 ? "running" : "done") });
    b.push("projects", "work_order", { workOrder: workOrderOf("wo-2", "p-2", b.time(), "running") });
    b.push("projects", "scope_record", { record: scopeOf("sr-1", b.time(), "p-1") });
    b.push("board", "scope_record", { record: scopeOf("sr-2", b.time()) });
    b.push("projects", "project", { project: projectOf("p-1", "pm-1", b.time()), change: "charter_confirmed", from: "preparing", by: "user" });
  }
  b.push("board", "task", { task: taskOf("t-b", "tm-b", b.time(), { stages: { total: 1, current: 1, list: [stage("s1", "working")] } }), change: "rework", from: "done", by: "user", reopened: ["s1"] });
  b.push("board", "task", { task: { ...taskOf("t-b", "tm-b", b.time()), deleted: true }, change: "deleted", from: "running", by: "user" });
  b.push("board", "task_plan", { deleted: true, deletedAt: b.time() });
  b.push("board", "task", { task: taskOf("t-c", "tm-c", b.time()), change: "created", from: null, by: "user" });
  b.push("projects", "project", { project: projectOf("p-1", "pm-1", b.time()), change: "deleted", from: "active", by: "user" });
  b.push("projects", "project", { project: projectOf("p-2", "pm-2", b.time()), change: "paused", from: "active", by: "user" });
  b.push("board", "task", { task: taskOf("t-c", "tm-c", b.time()), change: "updated", from: null, by: "system" });
  chat(b, "maintainer:pm-1", 4);
  chat(b, "maintainer:tm-b", 4);
  return b;
}

const stages = (states: string[]) => ({ total: states.length, current: 1, list: states.map((s, i) => stage(`s${i + 1}`, s)) });

/** 返工：一个任务做完又返工了几次（前端攒返工记录），中间夹着一般的更新和用量 */
function reworkLog(): LogBuilder {
  const b = new LogBuilder();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 3; i++) b.push("board", "task", { task: taskOf("t-r", "tm-r", b.time(), { stages: stages(["accepted", i === 2 ? "accepted" : "working"]) }), change: "updated", from: null, by: "system" });
    b.push("board", "token_totals", { owner: { kind: "task", id: "t-r" }, tokens: { cacheHit: round, cacheMiss: round, output: round }, calls: round, byAgent: [], byStage: [], time: b.time() });
    // 以前的返工记录没有 reopened（这一刻没验收的就是重开的）
    b.push("board", "task", { task: taskOf("t-r", "tm-r", b.time(), { state: "running", stages: stages(["accepted", "working"]) }), change: "rework", from: "done", by: "user", ...(round === 1 ? {} : { reopened: ["s2"] }) });
  }
  b.push("board", "task", { task: taskOf("t-r", "tm-r", b.time(), { state: "done", stages: stages(["accepted", "accepted"]) }), change: "updated", from: null, by: "system" });
  return b;
}

/**
 * 卡片的版本：一般的卡留版本最大的；快速动作卡每版都改会话里的操作记录。照守护进程现在的样子编：q-1 等确认、执行了（这一版带结果，
 * 操作记录同一事务）；q-2 执行过又被彻底删除（旧版本改写成"已删除"标记，另来一版去掉原话的，操作记录也原地改写了）。
 * dropResult：q-1 没做成，再来一版没有结果说明（守护进程不会这样：结果有了就一直有）——前端是"这一版没有就留着上一版的"，只留最后一版就不一样，
 * 所以快速动作卡不合并
 */
function cardsLog(dropResult = false): LogBuilder {
  const b = new LogBuilder();
  const created = b.time();
  const cardOf = (id: string, version: number, type: string, payload: Record<string, unknown>) => ({ id, type, typeVersion: 1, version, status: version > 1 ? "handled" : "pending", createdAt: created, ...(version > 1 ? { handledAt: b.time() } : {}), payload });
  const quick = (id: string, version: number, title: string, result?: string) =>
    cardOf(id, version, "quick_action", { actionId: `qa-${id}`, conversation: "secretary", action: { type: "remember", params: null }, name: "记住", title, explicit: true, categories: [], disposition: "ask", ...(result === undefined ? {} : { result }) });
  const record = (id: string, title: string, summary: string) =>
    b.push("secretary", "quick_action_executed", { actionId: `qa-${id}`, action: { type: "remember", params: null }, name: "记住", title, explicit: true, basis: "explicit", cardId: id, result: { ok: true, summary } });
  chat(b, "secretary", 3);
  for (let v = 1; v <= 4; v++) b.push("cards", "card", { card: cardOf("c-1", v, "suggest_task", { title: `建议 第 ${v} 版`, request: "编的", reason: "编的" }) });
  b.push("cards", "card", { card: cardOf("c-2", 1, "suggest_task", { title: "建议", request: "编的", reason: "编的" }) });
  // 同一版本又来一条（后到的前端不认）
  b.push("cards", "card", { card: cardOf("c-2", 1, "suggest_task", { title: "建议（后到的）", request: "编的", reason: "编的" }) });
  b.push("cards", "card", { card: quick("q-1", 1, "记住：周三体检") });
  // dropResult 那份照没做成的写：卡上的结果说明和操作记录自己的不一样（"没做成：…"）
  record("q-1", "记住：周三体检", dropResult ? "日历没连上" : "记下了");
  b.push("cards", "card", { card: quick("q-1", 2, "记住：周三体检", dropResult ? "没做成：日历没连上" : "记下了") });
  if (dropResult) b.push("cards", "card", { card: quick("q-1", 3, "记住：周三体检") });
  b.push("cards", "card_dismissed", { cardId: "c-2", time: b.time() });
  // q-2 执行过、又被彻底删除了：两个旧版本改写成"已删除"标记，操作记录原地改写，另来一版去掉原话的
  b.push("cards", "card", { deleted: true, deletedAt: b.time() });
  record("q-2", "记住（已删除）", "（已删除）");
  b.push("cards", "card", { deleted: true, deletedAt: b.time() });
  b.push("cards", "card", { card: quick("q-2", 3, "记住（已删除）", "（已删除）") });
  b.push("cards", "card", { card: cardOf("c-3", 1, "reminder_due", { title: "到点了" }) });
  b.push("cards", "card", { card: cardOf("c-3", 2, "reminder_due", { title: "到点了" }) });
  b.push("cards", "card", { card: cardOf("c-2", 2, "suggest_task", { title: "建议", request: "编的", reason: "编的" }) });
  b.push("plugins", "plugin_data_purged", { plugin: "reminders", at: b.time(), cardTypes: ["reminder_due"], eventTypes: ["reminder"], deleted: 3 });
  b.push("board", "reminder", { reminder: { id: "r-1", text: "编的", createdAt: created, schedule: { kind: "once", at: b.time() } } });
  b.push("board", "reminder", { reminder: { id: "r-1", text: "编的", createdAt: created, schedule: { kind: "once", at: b.time() }, done: true } });
  b.push("board", "reminder", { deleted: true, deletedAt: b.time() });
  b.push("board", "token_totals", { owner: { kind: "task", id: "t-x" }, tokens: { cacheHit: 1, cacheMiss: 1, output: 1 }, calls: 1, byAgent: [], byStage: [], time: b.time() });
  return b;
}

/** 别的几类：定时作业的运行、待办删了的、设备删了的、已读位置往回的、活动状态、工作日历、名字、语言、关注类别 */
function othersLog(): LogBuilder {
  const b = new LogBuilder();
  const job = (id: string, runId: string | undefined, change: string) => ({
    job: { id, title: `作业 ${id}`, state: "active", maintainerId: `jm-${id}`, createdAt: "2026-11-01T09:00:00.000+08:00", updatedAt: b.time() },
    change,
    by: "system",
    ...(runId ? { run: { runId, jobId: id, state: change === "run_finished" ? "done" : "running", startedAt: b.time() } } : {}),
  });
  for (let i = 0; i < 6; i++) {
    b.push("board", "scheduled_job", job("j-1", i % 3 === 0 ? undefined : `run-${Math.floor(i / 2)}`, i % 2 === 0 ? "run_started" : "run_finished"));
    b.push("board", "scheduled_job", job("j-2", `run-b${i}`, "run_finished"));
    b.push("inbox", "inbox_item", { item: { id: `i-${i % 3}`, version: i + 1, title: "编的", source: "编的", urgency: "non_blocking", pinned: false, createdAt: b.time(), read: i > 2, archived: false, deleted: i === 4, kind: "notice", notice: "out_of_scope", body: "编的", actions: [] } });
    b.push("devices", "device", {
      device: { id: `d-${i % 2}`, name: "编的", from: "本机", pairedAt: "2026-11-01T09:00:00.000+08:00", activated: true, lastUsedAt: b.time(), expiresAt: "2027-11-01T09:00:00.000+08:00", revoked: i === 3, ...(i === 5 ? { deletedAt: b.time() } : {}) },
      change: i === 5 ? "deleted" : "used",
    });
    b.push("read_marks", "read_mark", { conversation: "secretary", seq: [3, 9, 5, 12, 12, 7][i]!, time: b.time() });
    b.push("activity", "activity", { agentId: `a-${i % 2}`, state: i % 2 === 0 ? "working" : "sleeping", since: b.time() });
    b.push("workday_calendar", i === 0 ? "holiday_data" : "workday_settings", i === 0 ? { years: [] } : { settings: { weekdays: [1, 2, 3, 4, 5], marks: [] } });
    b.push("assistant_name", "assistant_name", { name: `名字 ${i}`, source: "user" });
    b.push("language", "language", { language: i % 2 === 0 ? "zh-CN" : "en", source: "user" });
    b.push("watch_categories", "watch_category_settings", { categories: [], change: "updated", by: "user" });
  }
  chat(b, "secretary", 14);
  return b;
}

describe("冷补发只发最新的（456）：全量冷补发 = 合并后冷补发 = 本机合并后重折 + 增量", () => {
  const names = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
  for (const name of names) {
    test(`录下的 ${name}`, () => {
      expect.hasAssertions();
      expectSameAsFull(serverLog(load(name)), name);
    });
  }

  test("合成的用户量级数据（一万多条、十来 MB）", () => {
    const synthetic = syntheticLog();
    const log = new Map([...synthetic.channels].map(([c, frames]) => [c, frames]));
    expectSameAsFull(log, "合成");
    // 合并掉的确实多：看板上每个任务一轮轮更新只留最后一条
    expect(compactChannel(log.get(CHANNELS.board)!).length).toBeLessThan(log.get(CHANNELS.board)!.length / 5);
  });

  test("删除连带：项目删了带走内部任务、工单、范围记录；任务删了带走计划、返工记录", () => {
    const { log } = cascadeLog();
    expectSameAsFull(log, "删除连带");
    const full = coldOpen(log);
    expect(Object.keys(full.tasks)).toEqual(["t-c"]);
    expect(Object.keys(full.workOrders)).toEqual(["wo-2"]);
    expect(Object.keys(full.scopeRecords)).toEqual(["sr-2"]);
    expect(full.taskPlans).toEqual({});
    expect(full.taskReopens).toEqual({});
    expect(Object.keys(full.projects)).toEqual(["p-2"]);
    // 删除的那两条照发
    const board = compactChannel(log.get(CHANNELS.board)!);
    expect(board.some((f) => f.type === "task" && (f.payload as { change: string }).change === "deleted")).toBe(true);
    expect(compactChannel(log.get(CHANNELS.projects)!).some((f) => f.type === "project" && (f.payload as { change: string }).change === "deleted")).toBe(true);
  });

  test("返工：每次返工都发，返工记录和全量的一样", () => {
    const { log } = reworkLog();
    expectSameAsFull(log, "返工");
    expect(coldOpen(log).taskReopens["t-r"]).toHaveLength(3);
    expect(compactChannel(log.get(CHANNELS.board)!).filter((f) => (f.payload as { change?: string }).change === "rework")).toHaveLength(3);
  });

  test("卡片的版本：留版本最大的；快速动作卡每版都发（会话里的操作记录一版版改）；插件连数据删的照发", () => {
    const { log } = cardsLog();
    expectSameAsFull(log, "卡片版本");
    const full = coldOpen(log);
    expect(full.cards["c-1"]!.card.version).toBe(4);
    expect(full.cards["c-2"]!.card.version).toBe(2);
    expect(full.cards["c-3"]).toBeUndefined();
    expect(compactChannel(log.get(CHANNELS.cards)!).filter((f) => (f.payload as { card?: { id: string } }).card?.id === "q-1")).toHaveLength(2);
    // 日历记着的是看板上最后一条提醒事件（"已删除"标记）
    expect(full.calendar.changedAt.board).toBe(log.get(CHANNELS.board)!.at(-2)!.seq);

    // 快速动作卡来了一版没有结果说明的：一版版改下来操作记录留着上一版的结果；只留最后一版就成了操作记录自己的——所以它不合并
    const dropped = cardsLog(true).log;
    const coldDropped = coldOpen(dropped);
    expect(coldOpen(compacted(dropped))).toEqual(coldDropped);
    const op = coldDropped.conversations.secretary!.records.find((r) => r.record.type === "operation" && r.record.operation.cardId === "q-1")!.record;
    expect(op.type === "operation" && op.operation.result.summary).toBe("没做成：日历没连上");
    const onlyLast = new Map(dropped);
    onlyLast.set(CHANNELS.cards, dropped.get(CHANNELS.cards)!.filter((f) => (f.payload as { card?: { id: string; version: number } }).card?.id !== "q-1" || (f.payload as { card: { version: number } }).card.version === 3));
    expect(coldOpen(onlyLast).conversations.secretary).not.toEqual(coldDropped.conversations.secretary);
  });

  test("定时作业的运行、删掉的待办和设备、往回的已读位置、只有一份的设置", () => {
    const { log } = othersLog();
    expectSameAsFull(log, "别的几类");
    const full = coldOpen(log);
    expect(Object.keys(full.jobRuns).toSorted()).toEqual(["run-0", "run-1", "run-2", "run-b0", "run-b1", "run-b2", "run-b3", "run-b4", "run-b5"]);
    expect(full.readMarks.secretary).toBe(12);
    expect(Object.keys(full.devices)).toEqual(["d-0"]);
  });

  test("重新同步：手里已经有别的（负责人会话开着），一个频道从头补合并过的，和从头补全部的一样", () => {
    for (const { log } of [cascadeLog(), cardsLog(), othersLog(), reworkLog()]) {
      // 先照增量收全（负责人会话也订阅着），再让每个会话以外的频道各重新同步一次
      const live = replay(orderOf(log).flatMap((c) => log.get(c)!));
      for (const channel of orderOf(log).filter(keepsOpenEvents)) {
        const resyncWith = (frames: EventFrame[]) =>
          reduce(live, { kind: "batch", inputs: [{ kind: "resync", channel }, ...frames.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })), { kind: "synced" }] });
        expect(resyncWith(compactChannel(log.get(channel)!)), `重新同步 ${channel}`).toEqual(resyncWith(log.get(channel)!));
      }
    }
  });
});

describe("存哪些", () => {
  test("不存发送中的、提醒弹窗、被拒的提示、正在生成的回复、连接状态这些临时的；游标、会话、卡片照存", () => {
    const state = replay([
      message(1, "user"),
      { kind: "send_message", conversation: "secretary", idempotencyKey: "k-1", parts: [{ type: "text", text: "还没发到" }], time: "2026-11-03T09:01:00.000+08:00" },
      { kind: "alert", alert: { id: "a-1", title: "到点了" } },
      { kind: "request_failed", idempotencyKey: "k-x", error: "不行" },
      { channel: "secretary", seq: 1, type: "stream", payload: { messageId: "m-2", deltas: [{ part: 0, type: "text", offset: 0, text: "正在" }] } },
      { channel: "cards", seq: 1, type: "card", payload: { card: { id: "c-1", type: "suggest_task", typeVersion: 1, version: 1, status: "pending", createdAt: "2026-11-03T09:00:00.000+08:00", payload: {} } } },
      { kind: "card_action", cardId: "c-1", action: "approve", idempotencyKey: "k-c" },
      { kind: "connection", status: "online" },
      { kind: "synced" },
    ]);
    expect(conversationView(state, "secretary").map((i) => i.kind)).toEqual(["message", "streaming", "pending"]);
    const back = restored(state);
    expect(back.cursors).toEqual({ secretary: 1, cards: 1 });
    expect(conversationView(back, "secretary").map((i) => i.kind)).toEqual(["message"]);
    expect(back.cards["c-1"]).toEqual({ card: state.cards["c-1"]!.card });
    expect(back.alerts).toEqual([]);
    expect(back.failures).toEqual([]);
    expect(back.streams).toEqual({});
    expect(back.connection).toBe("connecting");
    expect(back.caughtUp).toBe(false);
  });

  test("会话只留当前分支上最近一页：更早的、它们的语音对象不留，留下的还能往上翻；没满一页的原样留", () => {
    const frames: EventFrame[] = [];
    for (let seq = 1; seq <= HISTORY_PAGE_SIZE + 10; seq++) frames.push(message(seq));
    const n = HISTORY_PAGE_SIZE + 10;
    frames.push(voice("v-old", "m-3", n + 1), voice("v-new", `m-${n}`, n + 2));
    const state = replay(frames);
    const snap = snapshotOf(state);
    const kept = snap.conversations.secretary!.messages;
    expect(kept).toHaveLength(HISTORY_PAGE_SIZE);
    expect(kept[0]!.seq).toBe(11);
    expect(Object.keys(snap.voices)).toEqual(["v-new"]);
    const back = restored(state);
    expect(olderHistory(back, "secretary")).toEqual({ canLoadOlder: true, before: 11 });
    expect(back.cursors.secretary).toBe(n + 2);

    const short = replay([message(1), message(2)]);
    expect(snapshotOf(short).conversations.secretary!.messages).toHaveLength(2);
  });

  test("已经收到事件了就不再用快照盖", () => {
    const snapshot = snapshotOf(replay([message(1), message(2)]));
    const live = replay([message(1)]);
    expect(reduce(live, { kind: "restore", snapshot })).toBe(live);
  });

  test("要存的那几样变了才算变了：正在生成的回复、弹窗、连接状态变了不算", () => {
    const a = replay([message(1)]);
    expect(snapshotChanged(undefined, a)).toBe(true);
    expect(snapshotChanged(a, reduce(a, { kind: "alert", alert: { id: "a", title: "x" } }))).toBe(false);
    expect(snapshotChanged(a, reduce(a, { kind: "connection", status: "online" }))).toBe(false);
    expect(snapshotChanged(a, reduce(a, { kind: "frame", frame: message(2) }))).toBe(true);
  });

  test("读回来的不像快照就不用", () => {
    expect(isOpenSnapshot(JSON.parse(JSON.stringify(snapshotOf(replay([message(1)])))))).toBe(true);
    expect(isOpenSnapshot(undefined)).toBe(false);
    expect(isOpenSnapshot({ cursors: { secretary: -1 } })).toBe(false);
    expect(isOpenSnapshot({ ...snapshotOf(initialUiState), conversations: [] })).toBe(false);
  });
});

describe("补发攒着一次交", () => {
  test("一次交的和一帧帧交的归并出来一样", () => {
    for (const name of ["multi-project.json", "secretary-reconnect.json", "secretary-resync.json", "task-execution.json"]) {
      const inputs = load(name);
      expect(reduce(initialUiState, { kind: "batch", inputs })).toEqual(replay(inputs));
    }
  });

  test("补发的帧和 synced 一起到：一次就是补完的样子", () => {
    const state = reduce(initialUiState, { kind: "batch", inputs: [{ kind: "frame", frame: message(1), catchUp: true }, { kind: "frame", frame: message(2), catchUp: true }, { kind: "synced" }] });
    expect(state.caughtUp).toBe(true);
    expect(conversationView(state, "secretary")).toHaveLength(2);
  });
});
