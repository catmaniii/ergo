// 打开页面量补发用的合成数据（388）：照用户那台二狗的量级编一份事件日志（2026-11-03 数过：看板 4548 条 / 7.9 MB、活动状态 2487、
// 已读位置 2176、待办 798、卡片 746 / 1.4 MB、已配对设备 296、项目 192……合起来一万多条、十来 MB 的 JSON）。
// 全是编的：名字、内容一看就是合成的。形状照守护进程推来的事件（协议包的事件载荷），只带界面画得出来的那几样。
import type { EventFrame } from "../../src/state/index.ts";

/** 各频道编多少 */
export interface SyntheticSize {
  /** 秘书会话的消息条数（每两条一轮，带回合开始、结束） */
  secretaryMessages: number;
  /** 看板上的任务个数、每个任务的事件条数（另有一成是用量合计） */
  tasks: number;
  updatesPerTask: number;
  cards: number;
  inboxItems: number;
  agents: number;
  activityEvents: number;
  readMarks: number;
  devices: number;
  deviceEvents: number;
  projects: number;
  projectEvents: number;
}

/** 用户那台二狗的量级 */
export const USER_SCALE: SyntheticSize = {
  secretaryMessages: 600,
  tasks: 300,
  updatesPerTask: 14,
  cards: 400,
  inboxItems: 400,
  agents: 40,
  activityEvents: 2500,
  readMarks: 2200,
  devices: 8,
  deviceEvents: 296,
  projects: 20,
  projectEvents: 192,
};

/** 编的事件日志：按频道，序号从 1 起 */
export class SyntheticLog {
  readonly channels = new Map<string, EventFrame[]>();
  private clock = Date.parse("2026-09-01T09:00:00.000+08:00");

  push(channel: string, type: string, payload: unknown): EventFrame {
    const list = this.channels.get(channel) ?? [];
    this.channels.set(channel, list);
    const frame: EventFrame = { channel, seq: list.length + 1, type, payload };
    list.push(frame);
    return frame;
  }

  lastSeq(channel: string): number {
    return this.channels.get(channel)?.length ?? 0;
  }

  /** 一个往后走的时间（每次一分钟） */
  time(): string {
    this.clock += 60_000;
    return iso(this.clock);
  }

  count(): number {
    return [...this.channels.values()].reduce((n, l) => n + l.length, 0);
  }

  bytes(channel?: string): number {
    const lists = channel === undefined ? [...this.channels.values()] : [this.channels.get(channel) ?? []];
    return lists.reduce((n, l) => n + l.reduce((m, f) => m + Buffer.byteLength(JSON.stringify(f), "utf8"), 0), 0);
  }
}

/** 协议时间（+08:00） */
function iso(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 23)}+08:00`;
}

const FILLER = "这是编的内容，用来把体积撑到和真的差不多。".repeat(6);

const TASK_STATES = ["planning", "awaiting_confirmation", "running", "running", "running", "done"] as const;

function task(no: number, step: number, time: string) {
  const state = TASK_STATES[Math.min(TASK_STATES.length - 1, Math.floor((step * TASK_STATES.length) / USER_SCALE.updatesPerTask))]!;
  const stages = [1, 2, 3].map((n) => ({
    stageId: `s${n}`,
    title: `合成阶段 ${n}`,
    state: state === "done" || step > n * 4 ? "accepted" : step > n * 3 ? "working" : "pending",
    dependsOn: n === 1 ? [] : [`s${n - 1}`],
    acceptance: [{ criterion: `合成的验收标准 ${n}`, method: "review" }],
    attempts: 1,
    code: String(n),
  }));
  return {
    id: `t-syn-${no}`,
    title: `合成任务 ${no}`,
    summary: `合成任务 ${no} 的一句话说明`,
    request: `${FILLER}${FILLER}（第 ${no} 个任务，第 ${step} 次更新）`,
    state,
    origin: "request",
    kind: "long_running",
    maintainerId: `tm-syn-${no}`,
    projects: [],
    projectIds: [],
    projectScope: "none",
    createdAt: "2026-09-01T09:00:00.000+08:00",
    updatedAt: time,
    stages: { total: 3, current: Math.min(3, 1 + Math.floor(step / 4)), list: stages },
  };
}

function card(no: number, version: number, time: string) {
  return {
    id: `c-syn-${no}`,
    type: "suggest_task",
    typeVersion: 1,
    version,
    status: version > 1 ? "handled" : "pending",
    createdAt: "2026-09-01T09:00:00.000+08:00",
    ...(version > 1 ? { handledAt: time } : {}),
    payload: { title: `合成建议 ${no}`, request: `${FILLER}${FILLER}${FILLER}${FILLER}`, reason: `合成的理由 ${no}` },
  };
}

function inboxItem(no: number, version: number, time: string, change: "new" | "read" | "archived" | "deleted") {
  return {
    id: `i-syn-${no}`,
    version,
    title: `合成通知 ${no}`,
    source: "合成来源",
    urgency: "non_blocking",
    pinned: false,
    createdAt: time,
    read: change !== "new",
    archived: change === "archived",
    deleted: change === "deleted",
    kind: "notice",
    notice: "out_of_scope",
    body: `合成通知的正文 ${no}。${FILLER}`,
    actions: ["知道了"],
  };
}

function device(no: number, time: string) {
  return {
    id: `d-syn-${no}`,
    name: `合成设备 ${no}`,
    from: "经隧道 · 203.0.113.9",
    pairedAt: "2026-09-01T09:00:00.000+08:00",
    activated: true,
    lastUsedAt: time,
    expiresAt: "2027-09-01T09:00:00.000+08:00",
    revoked: false,
  };
}

function project(no: number, time: string) {
  return {
    id: `p-syn-${no}`,
    name: `合成项目 ${no}`,
    goal: `合成项目 ${no} 的目标`,
    state: "active",
    origin: "suggestion",
    maintainerId: `pm-syn-${no}`,
    workdir: { external: false, path: `projects/p-syn-${no}` },
    charterConfirmed: true,
    createdAt: "2026-09-01T09:00:00.000+08:00",
    updatedAt: time,
    kind: "dev",
    toolkit: { skills: [], mcp: [], bash: true, network: false },
  };
}

/** 秘书会话的一轮：用户一句、秘书一句，带回合开始、结束 */
export function secretaryTurn(log: SyntheticLog, no: number): void {
  const userId = `m-syn-u-${no}`;
  log.push("secretary", "message", { message: { id: userId, conversation: "secretary", speaker: "user", time: log.time(), parts: [{ type: "text", text: `合成的第 ${no} 句话` }] } });
  log.push("secretary", "turn_start", { inputMessageId: userId });
  log.push("secretary", "message", {
    message: { id: `m-syn-a-${no}`, conversation: "secretary", speaker: "agent", time: log.time(), parts: [{ type: "text", text: `合成的第 ${no} 句回答。${FILLER}` }] },
  });
  log.push("secretary", "turn_end", { inputMessageId: userId, outcome: "done" });
}

/** 编一份事件日志 */
export function syntheticLog(size: SyntheticSize = USER_SCALE): SyntheticLog {
  const log = new SyntheticLog();
  log.push("assistant_name", "assistant_name", { name: "合成助理", source: "user" });
  log.push("language", "language", { language: "zh-CN", source: "user" });
  for (let i = 1; i <= size.projects; i++) log.push("projects", "project", { project: project(i, log.time()), change: "created", by: "user" });
  for (let i = size.projects; i < size.projectEvents; i++) log.push("projects", "project", { project: project((i % size.projects) + 1, log.time()), change: "charter_confirmed", by: "user" });
  for (let i = 1; i <= size.devices; i++) log.push("devices", "device", { device: device(i, log.time()), change: "paired" });
  for (let i = size.devices; i < size.deviceEvents; i++) log.push("devices", "device", { device: device((i % size.devices) + 1, log.time()), change: "used" });
  // 看板：任务一轮轮往前走，中间夹着用量合计
  for (let step = 0; step < size.updatesPerTask; step++) {
    for (let t = 1; t <= size.tasks; t++) {
      log.push("board", "task", { task: task(t, step, log.time()), change: step === 0 ? "created" : "updated", by: "system" });
      if (t % 10 === 0) {
        log.push("board", "token_totals", {
          owner: { kind: "task", id: `t-syn-${t}` },
          tokens: { cacheHit: 1000 * step, cacheMiss: 500 * step, output: 40 * step },
          calls: step,
          byAgent: [],
          byStage: [],
          time: log.time(),
        });
      }
    }
  }
  // 卡片：大约一半处理过（第二个版本）
  for (let i = 1; i <= size.cards; i++) {
    log.push("cards", "card", { card: card(i, 1, log.time()) });
    if (i % 8 !== 0) log.push("cards", "card", { card: card(i, 2, log.time()) });
  }
  // 待办：来了、看过、归档，一些删了
  for (let i = 1; i <= size.inboxItems; i++) {
    log.push("inbox", "inbox_item", { item: inboxItem(i, 1, log.time(), "new") });
    log.push("inbox", "inbox_item", { item: inboxItem(i, 2, log.time(), i % 4 === 0 ? "deleted" : i % 3 === 0 ? "archived" : "read") });
  }
  const states = ["working", "waiting_for_user", "sleeping"] as const;
  for (let i = 0; i < size.activityEvents; i++) {
    const state = states[i % states.length]!;
    log.push("activity", "activity", {
      agentId: `tm-syn-${(i % size.agents) + 1}`,
      state,
      since: log.time(),
      ...(state === "waiting_for_user" ? { detail: { kind: "approval", tool: "读文件" } } : {}),
    });
  }
  for (let i = 1; i <= size.secretaryMessages / 2; i++) secretaryTurn(log, i);
  const last = log.lastSeq("secretary");
  for (let i = 1; i <= size.readMarks; i++) log.push("read_marks", "read_mark", { conversation: "secretary", seq: Math.round((last * i) / size.readMarks), time: log.time() });
  return log;
}

/** 关掉页面之后又发生的一点事（热打开时守护进程只该补这些） */
export function syntheticIncrement(log: SyntheticLog, turns = 3): number {
  const before = log.count();
  const base = log.lastSeq("secretary");
  for (let i = 1; i <= turns; i++) secretaryTurn(log, 100_000 + base + i);
  log.push("board", "task", { task: task(1, USER_SCALE.updatesPerTask, log.time()), change: "updated", by: "system" });
  log.push("activity", "activity", { agentId: "tm-syn-1", state: "sleeping", since: log.time() });
  log.push("inbox", "inbox_item", { item: inboxItem(9999, 1, log.time(), "new") });
  log.push("cards", "card", { card: card(9999, 1, log.time()) });
  log.push("read_marks", "read_mark", { conversation: "secretary", seq: log.lastSeq("secretary"), time: log.time() });
  return log.count() - before;
}
