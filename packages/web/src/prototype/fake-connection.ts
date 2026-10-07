// 原型用的假连接：没有守护进程，在浏览器里模拟服务端。
// - 启动时把假事件按频道编上序号，当作服务端已有的事件；连上时按前端带来的序号补发；
// - 发消息：过一会儿推回带同一个幂等键的权威消息，再推一条 agent 的回复；
// - 卡片动作：按版本条件更新（先到先得），推卡片更新事件；版本对不上就回"已被处理"；
// - 待我处理：假事项也走 inbox_item 事件；标已读、归档、删除、处理通知照守护进程的规矩（卡着任务的处理之前不能归档或删除）；
// - 已配对设备：假设备走 device 事件；吊销推一条吊销事件；批准假的配对请求卡多一台设备；
// - 发起任务（按钮，或者点"建议发起任务"卡上的"发起任务"）：在看板频道推一条 task 事件（规划中）；
// - 工作日历：假的节假日数据和个人设置走工作日历频道；改个人设置（假 HTTP 交过来）推一条 workday_settings 事件。
// - 关注类别设置（26 号票）：假设置走 watch_category_settings 事件；改设置照守护进程的规矩（内置类别只能往严里调），推一条新的。
// 由守护进程提供页面时，接了真数据的频道（秘书会话、卡片、待我处理……）走 WebSocket，这里的假数据只给其余页面用。
import type { CardActionRequest, Connection, InboxActionRequest, RevokeDeviceRequest, SendMessageRequest, StartTaskRequest, UpdateWatchCategoriesRequest } from "../app/connection.ts";
import {
  applyWorkdayChange,
  BLOCKING_URGENCIES,
  type Card,
  type CardAction,
  type CardEventPayload,
  CHANNELS,
  type DeviceEventPayload,
  EVENT_TYPES,
  type EventFrame,
  type InboxItem,
  type InboxItemEventPayload,
  isInboxItemProcessed,
  type MessageEnvelope,
  type MessageEventPayload,
  type PairedDevice,
  type PairingCardPayload,
  type SuggestTaskCardPayload,
  type Task,
  type TaskEventPayload,
  type TaskOrigin,
  type UiInput,
  type Urgency,
  type WorkdayChange,
  type WorkdayChangeResult,
  type WorkdaySettings,
  type WorkdaySettingsEventPayload,
  dispositionsNotLooserThan,
  type WatchCategoriesState,
  type WatchCategorySettingsEventPayload,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { FAKE_CARDS, FAKE_HISTORY } from "./fake-conversations.ts";
import { FAKE_DEVICES, FAKE_HOLIDAYS, FAKE_INBOX, FAKE_WATCH_CATEGORIES, FAKE_WORKDAY_SETTINGS } from "./fake-data.ts";

/** 这些动作算"关掉不处理"（回避信号），卡片状态记为已关闭 */
const DISMISS_ACTIONS = new Set<CardAction>(["dismiss", "cancel"]);

export class FakeConnection implements Connection {
  private readonly log: EventFrame[] = [];
  private readonly seqs: Record<string, number> = {};
  private readonly cards = new Map<string, Card>();
  private readonly inbox = new Map<string, InboxItem>();
  private readonly devices = new Map<string, PairedDevice>();
  private workday: WorkdaySettings = FAKE_WORKDAY_SETTINGS;
  private deliver: ((input: UiInput) => void) | undefined;
  private taskNo = 0;
  private watch: WatchCategoriesState = FAKE_WATCH_CATEGORIES;
  private customNo = FAKE_WATCH_CATEGORIES.custom.length;

  constructor() {
    for (const c of FAKE_CARDS) this.cards.set(c.id, c);
    for (const e of FAKE_HISTORY) this.append(e.channel, e.type, e.payload);
    for (const item of FAKE_INBOX) {
      this.inbox.set(item.id, item);
      this.append(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
    }
    for (const device of FAKE_DEVICES) {
      this.devices.set(device.id, device);
      this.append(CHANNELS.devices, EVENT_TYPES.device, { device, change: device.revoked ? "revoked" : "paired" } satisfies DeviceEventPayload);
    }
    this.append(CHANNELS.workdayCalendar, EVENT_TYPES.holidayData, { years: FAKE_HOLIDAYS });
    this.append(CHANNELS.workdayCalendar, EVENT_TYPES.workdaySettings, { settings: this.workday, source: "settings" } satisfies WorkdaySettingsEventPayload);
    this.append(CHANNELS.watchCategories, EVENT_TYPES.watchCategorySettings, { state: this.watch, change: { op: "file" }, by: "system", time: nowIso() } satisfies WatchCategorySettingsEventPayload);
  }

  /** 改个人工作日历（假 HTTP 交过来）：和守护进程一样，有变化就推一条 workday_settings 事件；日期不存在时抛错 */
  changeWorkday(change: WorkdayChange): WorkdayChangeResult {
    const result = applyWorkdayChange(this.workday, change);
    if (result.changed) {
      this.workday = result.settings;
      later(150, () => this.emit(CHANNELS.workdayCalendar, EVENT_TYPES.workdaySettings, { settings: result.settings, source: "settings", change } satisfies WorkdaySettingsEventPayload));
    }
    return result;
  }

  /** 改关注类别设置：内置类别只能往严里调（两条底线不在内置类别里，改不到）；自定义类别随便改 */
  updateWatchCategories(req: UpdateWatchCategoriesRequest): void {
    later(250, () => {
      const p = req.params;
      const fail = (error: string) => this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error });
      let next = this.watch;
      let categoryId: string | undefined;
      if (p.op === "set_builtin") {
        const c = next.builtin.find((x) => x.id === p.categoryId);
        if (!c) return fail(`没有这个内置类别：${p.categoryId}`);
        const base = c.defaults[p.scene];
        if (base === null) return fail(`「${c.title}」在对话里不适用`);
        if (!dispositionsNotLooserThan(base).includes(p.disposition)) return fail(`「${c.title}」只能往严里调`);
        next = { ...next, builtin: next.builtin.map((x) => (x.id === c.id ? { ...x, [p.scene]: p.disposition } : x)) };
        categoryId = c.id;
      } else if (p.op === "create_custom") {
        categoryId = `c-${++this.customNo}`;
        next = { ...next, custom: [...next.custom, { id: categoryId, ...p.category }] };
      } else if (p.op === "update_custom" || p.op === "delete_custom") {
        if (!next.custom.some((c) => c.id === p.categoryId)) return fail(`没有这个自定义类别：${p.categoryId}`);
        categoryId = p.categoryId;
        next = { ...next, custom: p.op === "delete_custom" ? next.custom.filter((c) => c.id !== p.categoryId) : next.custom.map((c) => (c.id === p.categoryId ? { id: c.id, ...p.category } : c)) };
      } else {
        // 原型里设置文件不会坏：修复、重新读取什么都不做
        return;
      }
      this.watch = next;
      this.emit(CHANNELS.watchCategories, EVENT_TYPES.watchCategorySettings, { state: next, change: { op: p.op, categoryId }, by: "user", time: nowIso() } satisfies WatchCategorySettingsEventPayload);
    });
  }

  /** 是不是原型里的假卡片（过渡期的分流连接据此把卡片动作交给假连接） */
  hasCard(cardId: string): boolean {
    return this.cards.has(cardId);
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    this.deliver = deliver;
    for (const frame of this.log) if (frame.seq > (cursors[frame.channel] ?? 0)) deliver({ kind: "frame", frame });
    return () => {
      if (this.deliver === deliver) this.deliver = undefined;
    };
  }

  sendMessage(req: SendMessageRequest): void {
    const time = nowIso();
    later(350, () => {
      const message: MessageEnvelope = { id: `u-${req.idempotencyKey}`, conversation: req.conversation, speaker: "user", time, parts: req.parts };
      this.emit(req.conversation, EVENT_TYPES.message, { message, idempotencyKey: req.idempotencyKey } satisfies MessageEventPayload);
    });
    later(1200, () => {
      const reply = req.conversation === CHANNELS.secretary ? "（原型）收到。这里是假数据，接上守护进程后是秘书的真实回复。" : "（原型）收到，作为插话在下一步之前插入。这里是假数据。";
      const message: MessageEnvelope = { id: `a-${req.idempotencyKey}`, conversation: req.conversation, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: reply }] };
      this.emit(req.conversation, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  cardAction(req: CardActionRequest): void {
    later(450, () => {
      const card = this.cards.get(req.cardId);
      if (!card || card.version !== req.expectedVersion || card.status !== "pending") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "已被处理" });
        return;
      }
      const started = card.type === "suggest_task" && req.action === "start_task" ? this.createTask(card.payload as SuggestTaskCardPayload, "suggestion") : undefined;
      const next: Card = {
        ...card,
        ...(started ? { payload: { ...(card.payload as SuggestTaskCardPayload), taskId: started.id } } : {}),
        version: card.version + 1,
        status: DISMISS_ACTIONS.has(req.action) ? "dismissed" : "handled",
        handledAt: nowIso(),
        outcome: { action: req.action, note: req.note },
      };
      this.cards.set(next.id, next);
      this.emit(CHANNELS.cards, EVENT_TYPES.card, { card: next } satisfies CardEventPayload);
      if (card.type === "pairing" && req.action === "approve") {
        const p = card.payload as PairingCardPayload;
        const now = nowIso();
        const device: PairedDevice = { id: `d-${card.id}`, name: p.deviceName, from: p.from, pairedAt: now, activated: true, lastUsedAt: now, expiresAt: "2027-10-07T09:30:00+08:00", revoked: false };
        this.devices.set(device.id, device);
        this.emit(CHANNELS.devices, EVENT_TYPES.device, { device, change: "paired" } satisfies DeviceEventPayload);
      }
    });
  }

  startTask(req: StartTaskRequest): void {
    later(300, () => {
      const title = req.request.trim().split("\n")[0]!.slice(0, 40);
      const task = this.createTask({ title, why: req.request.trim() }, "button", req.projects);
      const message: MessageEnvelope = {
        id: `a-${req.idempotencyKey}`,
        conversation: CHANNELS.secretary,
        speaker: "agent",
        time: nowIso(),
        parts: [{ type: "text", text: `（原型）任务 ${task.id}「${task.title}」已建好（规划中）。接上守护进程后，秘书先说出它的理解，再用提问卡和你对齐。` }],
      };
      this.emit(CHANNELS.secretary, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  /** 建一个假任务（规划中），推到看板频道 */
  private createTask(what: { title: string; why: string }, origin: TaskOrigin, projects: string[] = []): Task {
    this.taskNo += 1;
    const time = nowIso();
    const id = `t-proto-${this.taskNo}`;
    const task: Task = { id, title: what.title, summary: what.why, state: "planning", origin, maintainerId: `tm-proto-${this.taskNo}`, projects, createdAt: time, updatedAt: time };
    this.emit(CHANNELS.board, EVENT_TYPES.task, { task, change: "created", from: null, by: "user" } satisfies TaskEventPayload);
    return task;
  }

  revokeDevice(req: RevokeDeviceRequest): void {
    later(300, () => {
      const device = this.devices.get(req.deviceId);
      if (!device || device.revoked) {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "这台设备已经吊销了" });
        return;
      }
      const next: PairedDevice = { ...device, revoked: true, revokedAt: nowIso() };
      this.devices.set(next.id, next);
      this.emit(CHANNELS.devices, EVENT_TYPES.device, { device: next, change: "revoked" } satisfies DeviceEventPayload);
    });
  }

  inboxAction(req: InboxActionRequest): void {
    later(200, () => {
      const items = req.itemIds.map((id) => this.inbox.get(id)).filter((x): x is InboxItem => x !== undefined && !x.deleted);
      const changes: InboxItem[] = [];
      for (const item of items) {
        const processed = isInboxItemProcessed(item, item.kind === "card" ? this.cards.get(item.cardId)?.status : undefined);
        if ((req.action === "archive" || req.action === "delete") && (BLOCKING_URGENCIES as readonly Urgency[]).includes(item.urgency) && !processed) {
          const verb = req.action === "archive" ? "归档" : "删除";
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: `「${item.title}」卡着任务，处理之前不能${verb}：先在卡片上处理它（或者取消那个任务）` });
          return;
        }
        const next: InboxItem | undefined =
          req.action === "read"
            ? { ...item, read: true }
            : req.action === "unread"
              ? { ...item, read: false }
              : req.action === "archive"
                ? { ...item, archived: true, read: true }
                : req.action === "unarchive"
                  ? { ...item, archived: false }
                  : req.action === "delete"
                    ? { ...item, deleted: true }
                    : item.kind === "notice" && req.choice !== undefined
                      ? { ...item, handled: req.choice, handledAt: nowIso(), read: true }
                      : undefined;
        if (next) changes.push({ ...next, version: item.version + 1 });
      }
      for (const item of changes) {
        this.inbox.set(item.id, item);
        this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
      }
    });
  }

  private append(channel: string, type: string, payload: unknown): EventFrame {
    const seq = (this.seqs[channel] ?? 0) + 1;
    this.seqs[channel] = seq;
    const frame = { channel, seq, type, payload };
    this.log.push(frame);
    return frame;
  }

  private emit(channel: string, type: string, payload: unknown): void {
    const frame = this.append(channel, type, payload);
    this.deliver?.({ kind: "frame", frame });
  }
}

function later(ms: number, f: () => void): void {
  setTimeout(f, ms);
}
