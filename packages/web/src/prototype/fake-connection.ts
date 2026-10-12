// 原型用的假连接：没有守护进程，在浏览器里模拟服务端。
// - 启动时把假事件按频道编上序号，当作服务端已有的事件；连上时按前端带来的序号补发；
// - 发消息：过一会儿推回带同一个幂等键的权威消息，再推一条 agent 的回复；
// - 卡片动作：按版本条件更新（先到先得），推卡片更新事件；版本对不上就回"已被处理"；
// - 待我处理：假事项也走 inbox_item 事件；标已读、归档、删除、处理通知照守护进程的规矩（卡着任务的处理之前不能归档或删除）；
// - 已配对设备：假设备走 device 事件；吊销推一条吊销事件；批准假的配对请求卡多一台设备；
// - 发起任务（按钮，或者点"建议发起任务"卡上的"发起任务"）：在看板频道推一条 task 事件（规划中）；
//   普通任务（75 号票）：排队中 → 执行中（agent 在它的会话里调几次工具）→ 自动完成，助理在对话里转告；做完了在它的会话里接着说，演一遍接着做；
// - 定时触发（76 号票）：发起对话框里选"定时"建的普通任务建出就是运营中，登记它的触发（看板频道上的 scheduled_job）；
//   暂停、恢复、取消（看板卡、任务详情）落到它的触发上，取消时任务一起取消；选"只提醒我"建一条简单提醒；
// - 任务的暂停、继续、取消、归档（90 号票：看板卡的菜单、多选、任务详情的"⋯"）：照"谁能改"表演一遍状态变化（没有执行），
//   一次处理多个任务时逐条回报；重试、返工、验收这些假任务做不了；
// - 工作日历：假的节假日数据和个人设置走工作日历频道；改个人设置（假 HTTP 交过来）推一条 workday_settings 事件。
// - 日历（35 号票）：按月看的每一天（假 HTTP 交过来），工作日判定照上面的假工作日历算，提醒和作业是假的（fake-calendar.ts）。
// - 关注类别设置（26 号票）：假设置走 watch_category_settings 事件；改设置照守护进程的规矩（内置类别只能往严里调），推一条新的。
// - 项目（15 号票）：假项目走项目列表频道上的 project 事件；点"立项"、立项书卡的确认、项目页上的动作、删除的二次确认、
//   任务转为项目都照守护进程的规矩（状态迁移按协议包的 PROJECT_ACTION_RULES）；点"新建项目"推一张假的建议立项卡。
// - 语音消息（31 号票）：发出去的语音带上假的语音对象 id（v-fake-），过一会儿推"识别中""识别完成"（文字是原型的占位）；
//   重新识别同样走一遍。
// 由守护进程提供页面时，接了真数据的频道（秘书会话、卡片、待我处理……）走 WebSocket，这里的假数据只给其余页面用。
import type {
  CardActionRequest,
  Connection,
  ConvertTaskRequest,
  InboxActionRequest,
  NewProjectRequest,
  ProjectActionRequest,
  RescheduleJobRequest,
  ResetMaintainerRequest,
  RetryVoiceRequest,
  RevokeDeviceRequest,
  RunJobNowRequest,
  SetToolkitRequest,
  SetVoiceAnnounceRequest,
  ScheduledJobActionRequest,
  SendMessageRequest,
  StartTaskRequest,
  CreateReminderRequest,
  TaskActionRequest,
  TaskBatchActionRequest,
  UpdateWatchCategoriesRequest,
} from "../app/connection.ts";
import {
  type ActivityEventPayload,
  applyWorkdayChange,
  availableTaskActions,
  canRescheduleJob,
  canRunJobNow,
  canSetVoiceAnnounce,
  describeTime,
  type JobRun,
  MANUAL_TRIGGER_SOURCE,
  manualTriggerSummary,
  type RescheduleJobResult,
  type RunJobNowResult,
  type SetVoiceAnnounceResult,
  taskActRefusal,
  type TaskBatchAction,
  type TaskBatchActionResult,
  type TaskBatchItemResult,
  type AssistantNameEventPayload,
  type AssistantNameResult,
  checkAssistantName,
  DEFAULT_ASSISTANT_NAME,
  type CalendarMonthView,
  BLOCKING_URGENCIES,
  type Card,
  type CardAction,
  type CardEventPayload,
  CARD_TYPE_VERSIONS,
  CHANNELS,
  type CharterCardPayload,
  type DeviceEventPayload,
  EVENT_TYPES,
  type EventFrame,
  type InboxItem,
  type InboxItemEventPayload,
  type NoticeInboxItem,
  isInboxItemProcessed,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type PairedDevice,
  type PairingCardPayload,
  inboxItemProjectId,
  isPlainTask,
  isTriggered,
  onceAt,
  maintainerChannel,
  ownMaintainerId,
  PROJECT_DELETE_CANCEL,
  PROJECT_DELETE_CONFIRM,
  type Project,
  type ProjectChange,
  type ProjectEventPayload,
  projectActionRefusal,
  projectActions,
  canResetMaintainer,
  projectActionTarget,
  type SuggestProjectCardPayload,
  type SuggestTaskCardPayload,
  type Task,
  type TaskEventPayload,
  type TaskKind,
  type TaskOrigin,
  type UiInput,
  type Urgency,
  type VoiceEventPayload,
  type VoiceRecord,
  type WorkdayChange,
  type WorkdayChangeResult,
  type WorkdaySettings,
  type WorkdaySettingsEventPayload,
  dispositionsNotLooserThan,
  type WatchCategoriesState,
  type WatchCategorySettingsEventPayload,
  nextOccurrence,
  type Reminder,
  type ReminderEventPayload,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type TaskTrigger,
  workdayCalendar,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { fakeCalendarMonth } from "./fake-calendar.ts";
import { FAKE_AT_TASK, FAKE_CARDS, FAKE_EVENT_TASK, FAKE_HISTORY, FAKE_PLAIN_TASK, FAKE_TIMED_TASK, FAKE_TIMED_WORKFLOW, FAKE_WORKFLOW_TASK } from "./fake-conversations.ts";
import { FAKE_DEVICES, FAKE_HOLIDAYS, FAKE_INBOX, FAKE_PROJECT_EVENTS, FAKE_PROJECTS, FAKE_WATCH_CATEGORIES, FAKE_WORKDAY_SETTINGS } from "./fake-data.ts";

/** 原型里假的语音对象 id 的前缀（分流连接据此把"重新识别"交给假连接） */
export const FAKE_VOICE_PREFIX = "v-fake-";

/** 这些动作算"关掉不处理"（回避信号），卡片状态记为已关闭 */
const DISMISS_ACTIONS = new Set<CardAction>(["dismiss", "cancel"]);

export class FakeConnection implements Connection {
  private readonly log: EventFrame[] = [];
  private readonly seqs: Record<string, number> = {};
  private readonly cards = new Map<string, Card>();
  private readonly inbox = new Map<string, InboxItem>();
  private readonly devices = new Map<string, PairedDevice>();
  private workday: WorkdaySettings = FAKE_WORKDAY_SETTINGS;
  /** 个人助理的名字（43 号票）：原型里从默认的开始，只记在内存里 */
  private assistantName = DEFAULT_ASSISTANT_NAME;
  private readonly projects = new Map<string, Project>();
  private readonly tasks = new Map<string, Task>();
  /** 定时触发的任务的触发登记（76 号票）：按任务 id */
  private readonly triggers = new Map<string, ScheduledJob>();
  private reminderNo = 0;
  private deliver: ((input: UiInput) => void) | undefined;
  private taskNo = 0;
  private watch: WatchCategoriesState = FAKE_WATCH_CATEGORIES;
  private customNo = FAKE_WATCH_CATEGORIES.custom.length;
  private projectNo = 0;
  private itemNo = 0;
  private voiceNo = 0;
  private readonly voices = new Map<string, VoiceRecord>();

  constructor() {
    for (const c of FAKE_CARDS) this.cards.set(c.id, c);
    this.tasks.set(FAKE_PLAIN_TASK.id, FAKE_PLAIN_TASK);
    for (const t of [FAKE_TIMED_TASK, FAKE_TIMED_WORKFLOW, FAKE_AT_TASK, FAKE_WORKFLOW_TASK, FAKE_EVENT_TASK]) this.tasks.set(t.id, t);
    for (const e of FAKE_HISTORY) {
      this.append(e.channel, e.type, e.payload);
      if (e.type === EVENT_TYPES.scheduledJob) {
        const { job } = e.payload as ScheduledJobEventPayload;
        if (job.ownerTaskId) this.triggers.set(job.ownerTaskId, job);
      }
    }
    for (const item of FAKE_INBOX) {
      this.inbox.set(item.id, item);
      this.append(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
    }
    for (const project of FAKE_PROJECTS) {
      this.projects.set(project.id, project);
      this.append(CHANNELS.projects, EVENT_TYPES.project, { project, change: "created", from: null, by: "user" } satisfies ProjectEventPayload);
    }
    for (const e of FAKE_PROJECT_EVENTS) this.append(e.channel, e.type, e.payload);
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

  /** 改个人助理的名字（假 HTTP 交过来）：和守护进程一样按起名的规则查（不合规抛错），有变化就推一条 assistant_name 事件 */
  setAssistantName(raw: string): AssistantNameResult {
    const checked = checkAssistantName(raw);
    if (!checked.ok) throw new Error(checked.error);
    if (checked.name === this.assistantName) return { name: checked.name, changed: false };
    this.assistantName = checked.name;
    later(150, () => this.emit(CHANNELS.assistantName, EVENT_TYPES.assistantName, { name: checked.name, source: "settings" } satisfies AssistantNameEventPayload));
    return { name: checked.name, changed: true };
  }

  /** 某个月的日历（假 HTTP 交过来）：asOf 是这边两个频道的序号 */
  calendarMonth(month: string): CalendarMonthView {
    return fakeCalendarMonth(month, FAKE_HOLIDAYS, this.workday, { board: this.seqs[CHANNELS.board] ?? 0, workdayCalendar: this.seqs[CHANNELS.workdayCalendar] ?? 0 });
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
    const messageId = `u-${req.idempotencyKey}`;
    // 语音（31 号票）：带上假的语音对象 id，之后推识别的过程
    const parts = req.parts.map((p): MessagePart => (p.type === "voice" ? { ...p, voiceId: `${FAKE_VOICE_PREFIX}${++this.voiceNo}` } : p));
    later(350, () => {
      const message: MessageEnvelope = { id: messageId, conversation: req.conversation, speaker: "user", time, parts };
      this.emit(req.conversation, EVENT_TYPES.message, { message, idempotencyKey: req.idempotencyKey } satisfies MessageEventPayload);
      for (const p of parts) {
        if (p.type !== "voice" || p.voiceId === undefined) continue;
        const voice: VoiceRecord = { id: p.voiceId, messageId, conversation: req.conversation, mediaId: p.mediaId, mime: p.mime, durationMs: p.durationMs, waveform: p.waveform, status: "queued", attempt: 1, createdAt: time, updatedAt: time, version: 1 };
        this.recognizeVoice(voice);
      }
    });
    // 做完了的普通任务里接着说（75 号票）：演一遍接着做
    const plain = [...this.tasks.values()].find((t) => isPlainTask(t) && t.state === "done" && maintainerChannel(t.maintainerId) === req.conversation);
    if (plain) {
      later(500, () => this.runPlain(plain, "continued", "（原型）好，接着做。"));
      return;
    }
    later(1200, () => {
      const reply = req.conversation === CHANNELS.secretary ? "（原型）收到。这里是假数据，接上守护进程后是真实的回复。" : "（原型）收到，作为插话在下一步之前插入。这里是假数据。";
      const message: MessageEnvelope = { id: `a-${req.idempotencyKey}`, conversation: req.conversation, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: reply }] };
      this.emit(req.conversation, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  /** 原型的识别：排队 → 识别中 → 完成（文字是占位） */
  private recognizeVoice(voice: VoiceRecord): void {
    const put = (next: VoiceRecord) => {
      this.voices.set(next.id, next);
      this.emit(next.conversation, EVENT_TYPES.voice, { voice: next } satisfies VoiceEventPayload);
    };
    put(voice);
    later(400, () => put({ ...voice, status: "recognizing", version: voice.version + 1, updatedAt: nowIso() }));
    later(1600, () => {
      const time = nowIso();
      const text = "（原型）这里显示识别出的文字，接上守护进程后是语音的真实转写。";
      put({
        ...voice,
        status: "done",
        version: voice.version + 2,
        updatedAt: time,
        recognition: { text, language: "zh", segments: [], model: "large-v3", device: "cuda", computeType: "int8_float16", elapsedMs: 1200, time },
      });
    });
  }

  /** 重新识别：只有识别失败的能重新识别（原型里的都识别成功，所以总是被拒） */
  retryVoice(req: RetryVoiceRequest): void {
    later(200, () => {
      const voice = this.voices.get(req.voiceId);
      if (voice?.status !== "failed") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "只有识别失败的语音能重新识别" });
        return;
      }
      this.recognizeVoice({ ...voice, status: "queued", attempt: voice.attempt + 1, version: voice.version + 1, updatedAt: nowIso() });
    });
  }

  cardAction(req: CardActionRequest): void {
    later(450, () => {
      const card = this.cards.get(req.cardId);
      if (!card || card.version !== req.expectedVersion || card.status !== "pending") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "已被处理" });
        return;
      }
      // "建议发起任务"卡的两个按钮（58 号票）：作为流程、作为长程任务
      const kind: TaskKind | undefined = card.type !== "suggest_task" ? undefined : req.action === "start_workflow" ? "workflow" : req.action === "start_task" ? "long_running" : undefined;
      const started = kind ? this.createTask(card.payload as SuggestTaskCardPayload, "suggestion", (card.payload as SuggestTaskCardPayload).projects ?? [], kind) : undefined;
      const payload = started && kind ? { ...(card.payload as SuggestTaskCardPayload), taskId: started.id, kind } : this.projectCardEffect(card, req.action);
      const next: Card = {
        ...card,
        ...(payload ? { payload } : {}),
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
      const task = this.createTask({ title, why: req.request.trim() }, "button", req.projects, req.kind, req.trigger, req.voiceAnnounce === true && req.projects.length !== 1);
      // 定时的普通任务（76 号票）：建出就是运营中，登记触发，到点才运行
      if (task.state === "operating") {
        this.registerTrigger(task);
        return;
      }
      // 普通任务（75 号票）：不经助理，排到了就开始做
      if (isPlainTask(task)) {
        later(600, () => this.runPlain(task, "started", `（原型）收到，开始做「${task.title}」。`));
        return;
      }
      const message: MessageEnvelope = {
        id: `a-${req.idempotencyKey}`,
        conversation: CHANNELS.secretary,
        speaker: "agent",
        time: nowIso(),
        parts: [{ type: "text", text: `（原型）任务 ${task.id}「${task.title}」已建好（规划中）。接上守护进程后，这里先说出对任务的理解，再用提问卡和你对齐。` }],
      };
      this.emit(CHANNELS.secretary, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  /** 普通任务的一轮（75 号票）：执行中 → agent 调几次工具、说结果 → 自动完成，助理转告 */
  private runPlain(task: Task, change: "started" | "continued", opening: string): void {
    const channel = maintainerChannel(task.maintainerId);
    const say = (speaker: "agent" | "system", parts: MessagePart[]) => {
      const message: MessageEnvelope = { id: `pm-${++this.itemNo}`, conversation: channel, speaker, time: nowIso(), parts };
      this.emit(channel, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    };
    const running: Task = { ...task, state: "running", updatedAt: nowIso() };
    this.tasks.set(task.id, running);
    this.emit(CHANNELS.board, EVENT_TYPES.task, { task: running, change, from: task.state, by: change === "continued" ? "user" : "system" } satisfies TaskEventPayload);
    say("agent", [{ type: "text", text: opening }]);
    const activity = (state: "working" | "sleeping") =>
      this.emit(CHANNELS.activity, EVENT_TYPES.activity, { agentId: task.maintainerId, state, since: nowIso() } satisfies ActivityEventPayload);
    activity("working");
    later(1500, () =>
      say("agent", [
        { type: "tool_call", callId: `pc-${this.itemNo}-1`, tool: "web_search", argsSummary: task.title, categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", resultSummary: "（原型）5 条结果", nature: "look" },
        { type: "tool_call", callId: `pc-${this.itemNo}-2`, tool: "bash", argsSummary: "（原型）python do_it.py", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: true, outcome: "done", resultSummary: "（原型）完成", nature: "act" },
      ]),
    );
    later(4500, () => {
      say("agent", [{ type: "text", text: `（原型）「${task.title}」做好了。接上守护进程后，这里是 agent 真实的结果。` }]);
      say("system", [{ type: "text", text: "这一轮做完了，任务自动完成。要它接着做，在这里接着说。" }]);
      activity("sleeping");
      const done: Task = { ...running, state: "done", updatedAt: nowIso() };
      this.tasks.set(task.id, done);
      this.emit(CHANNELS.board, EVENT_TYPES.task, { task: done, change: "completed", from: "running", by: "system" } satisfies TaskEventPayload);
      const relay: MessageEnvelope = { id: `pr-${++this.itemNo}`, conversation: CHANNELS.secretary, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: `（原型）后台的「${task.title}」做完了。` }] };
      this.emit(CHANNELS.secretary, EVENT_TYPES.message, { message: relay } satisfies MessageEventPayload);
    });
  }

  /** 建一个假任务（规划中；普通任务是排队中，定时的普通任务是运营中，某个时间做一次的普通任务是等时间），推到看板频道 */
  private createTask(what: { title: string; why: string }, origin: TaskOrigin, projects: string[] = [], kind: TaskKind = "long_running", trigger?: TaskTrigger, voiceAnnounce = false): Task {
    this.taskNo += 1;
    const time = nowIso();
    const id = `t-proto-${this.taskNo}`;
    const projectIds = projects.flatMap((name) => [...this.projects.values()].filter((p) => p.name === name).map((p) => p.id));
    const triggerShape = trigger ? { trigger } : {};
    const state = isPlainTask({ kind }) ? (isTriggered(triggerShape) ? "operating" : onceAt(triggerShape) !== undefined ? "scheduled" : "queued") : "planning";
    const task: Task = {
      id,
      title: what.title,
      summary: what.why,
      state,
      origin,
      kind,
      ...(trigger ? { trigger } : {}),
      maintainerId: ownMaintainerId(id),
      projects,
      projectIds,
      ...(voiceAnnounce ? { voiceAnnounce: true } : {}),
      createdAt: time,
      updatedAt: time,
    };
    this.tasks.set(id, task);
    this.emit(CHANNELS.board, EVENT_TYPES.task, { task, change: "created", from: null, by: "user" } satisfies TaskEventPayload);
    return task;
  }

  newProject(req: NewProjectRequest): void {
    later(600, () => {
      const request = req.request.trim();
      this.itemNo += 1;
      const payload: SuggestProjectCardPayload = { name: request.split("\n")[0]!.slice(0, 20), goal: request.slice(0, 300) };
      const card: Card = {
        id: `c-proto-sp-${this.itemNo}`,
        type: "suggest_project",
        typeVersion: CARD_TYPE_VERSIONS.suggest_project,
        version: 1,
        status: "pending",
        payload,
        text: `建议立项：${payload.name}（${payload.goal}）`,
        createdAt: nowIso(),
      };
      this.cards.set(card.id, card);
      this.emit(CHANNELS.cards, EVENT_TYPES.card, { card } satisfies CardEventPayload);
      const message: MessageEnvelope = {
        id: `a-${req.idempotencyKey}`,
        conversation: CHANNELS.secretary,
        speaker: "agent",
        time: nowIso(),
        parts: [{ type: "text", text: "（原型）你点了“新建项目”：不判断是不是项目，直接给你一张建议立项卡。" }, { type: "card_ref", cardId: card.id }],
      };
      this.emit(CHANNELS.secretary, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    });
  }

  convertTaskToProject(req: ConvertTaskRequest): void {
    later(300, () => {
      const task = this.tasks.get(req.taskId);
      if (!task || task.state !== "planning") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "（原型）只有原型里新发起、还在规划中的任务能转为项目" });
        return;
      }
      const name = req.name.trim();
      if ([...this.projects.values()].some((p) => p.name === name)) {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: `已经有叫「${name}」的项目了：换个名字` });
        return;
      }
      const ended: Task = { ...task, state: "done", endKind: "converted_to_project", updatedAt: nowIso() };
      this.tasks.set(ended.id, ended);
      this.emit(CHANNELS.board, EVENT_TYPES.task, { task: ended, change: "converted_to_project", from: task.state, by: "user" } satisfies TaskEventPayload);
      this.createProject(name, task.summary, { origin: "task", maintainerId: task.maintainerId, fromTaskId: task.id });
    });
  }

  projectAction(req: ProjectActionRequest): void {
    later(300, () => {
      const project = this.projects.get(req.projectId);
      const buildState = project?.buildTaskId === undefined ? undefined : this.tasks.get(project.buildTaskId)?.state;
      if (!project || !projectActions(project, buildState).includes(req.action)) {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: project ? projectActionRefusal(project, req.action) : "没有这个项目" });
        return;
      }
      // 迁移和守护进程用同一张表（共享协议包的 projectActionTarget）；删除不马上删
      const target = projectActionTarget(project, req.action);
      if (!target) return this.askDelete(project);
      const buildTaskId = req.action === "start_build" ? this.createTask({ title: `建设「${project.name}」首版`, why: project.goal }, "project_build", [project.name]).id : project.buildTaskId;
      this.updateProject(project, { state: target.state, archivedFrom: target.archivedFrom, ...(buildTaskId === undefined ? {} : { buildTaskId }) }, target.change);
    });
  }

  resetMaintainer(req: ResetMaintainerRequest): void {
    // 重置维护者不改项目状态（原型里没有维护者的会话分段，只核对能不能重置）
    later(300, () => {
      const project = this.projects.get(req.projectId);
      if (!project || !canResetMaintainer(project)) this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: project ? "项目已归档：维护者会话只读，不能重置" : "没有这个项目" });
    });
  }

  watchChannels(): void {
    // 假连接推的是所有频道，不用再订阅
  }

  /** 改工具包：原型里只改项目的（项目跟着推来）；假任务的工具包在原型的任务详情里自己改 */
  setToolkit(req: SetToolkitRequest): void {
    later(300, () => {
      const project = req.target.kind === "project" ? this.projects.get(req.target.projectId) : undefined;
      if (!project) {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "原型里只能改原型项目的工具包：连上守护进程看真任务" });
        return;
      }
      if (project.state === "archived") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: `项目「${project.name}」已归档：工具包不能改` });
        return;
      }
      this.updateProject(project, { toolkit: req.toolkit }, "toolkit_changed");
    });
  }

  /** 删除项目不马上删：在待我处理里放一条二次确认 */
  private askDelete(project: Project): void {
    this.itemNo += 1;
    const item: InboxItem = {
      id: `i-proto-del-${this.itemNo}`,
      kind: "notice",
      notice: "project_delete",
      version: 1,
      title: `删除项目「${project.name}」？`,
      body: "项目档案和维护者会话都会删掉，不可恢复；你在维护者会话里说过的话作为素材保留。",
      source: `项目「${project.name}」`,
      urgency: "non_blocking",
      actions: [PROJECT_DELETE_CONFIRM, PROJECT_DELETE_CANCEL],
      data: { projectId: project.id },
      pinned: false,
      createdAt: nowIso(),
      read: false,
      archived: false,
      deleted: false,
    };
    this.inbox.set(item.id, item);
    this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
  }

  /** 立项（点"立项"、任务转为项目）：项目以筹备中出现在项目列表频道 */
  private createProject(name: string, goal: string, from: Pick<Project, "origin"> & Partial<Pick<Project, "maintainerId" | "fromTaskId">>): Project {
    this.projectNo += 1;
    const time = nowIso();
    const project: Project = {
      id: `p-proto-${this.projectNo}`,
      name,
      goal,
      state: "preparing",
      maintainerId: `pm-proto-${this.projectNo}`,
      workdir: { external: false },
      charterConfirmed: false,
      createdAt: time,
      updatedAt: time,
      ...from,
    };
    this.projects.set(project.id, project);
    this.emit(CHANNELS.projects, EVENT_TYPES.project, { project, change: "created", from: null, by: "user" } satisfies ProjectEventPayload);
    return project;
  }

  private updateProject(project: Project, patch: Partial<Project>, change: ProjectChange): Project {
    const next: Project = { ...project, ...patch, updatedAt: nowIso() };
    if (next.archivedFrom === undefined) delete next.archivedFrom;
    this.projects.set(next.id, next);
    this.emit(CHANNELS.projects, EVENT_TYPES.project, { project: next, change, from: project.state, by: "user" } satisfies ProjectEventPayload);
    return next;
  }

  /** 建议立项卡点了"立项"、立项书卡上的确认：项目跟着变，返回卡片的新负载（不相干的卡返回 undefined） */
  private projectCardEffect(card: Card, action: CardAction): unknown {
    if (card.type === "suggest_project" && action === "kickoff") {
      const payload = card.payload as SuggestProjectCardPayload;
      const project = this.createProject(payload.name, payload.goal, { origin: "suggestion" });
      return { ...payload, projectId: project.id };
    }
    if (card.type !== "charter" || (action !== "confirm_start" && action !== "confirm_later")) return undefined;
    const payload = card.payload as CharterCardPayload;
    const project = this.projects.get(payload.projectId);
    if (!project) return undefined;
    const { charter, toolkit } = payload;
    // 不管点哪个，项目类型、工作目录和工具包在确认时就生效
    const confirmed: Partial<Project> = {
      kind: charter.kind,
      workdir: charter.bindExternal ? { external: true, path: charter.externalPath } : { external: false },
      toolkit,
      charterConfirmed: true,
    };
    if (action === "confirm_later") {
      this.updateProject(project, confirmed, "charter_confirmed");
      return { ...payload, confirmed: { start: false } };
    }
    const task = this.createTask({ title: `建设「${project.name}」首版`, why: charter.firstVersion }, "project_build", [project.name]);
    this.updateProject(project, { ...confirmed, state: "building", buildTaskId: task.id }, "building_started");
    return { ...payload, confirmed: { start: true, buildTaskId: task.id } };
  }

  /** 下一次（按假的工作日历算）；事件触发的（没有时间表）没有 */
  private nextAt(schedule: ScheduledJob["schedule"]): string | undefined {
    const next = schedule && nextOccurrence(schedule, new Date(), { calendar: workdayCalendar(FAKE_HOLIDAYS, this.workday) });
    return next ? nowIso(next) : undefined;
  }

  /** 定时、事件触发的任务登记它的触发（76、77 号票） */
  private registerTrigger(task: Task): void {
    if (task.trigger?.kind !== "schedule" && task.trigger?.kind !== "event") return;
    const time = nowIso();
    const schedule = task.trigger.kind === "schedule" ? task.trigger.schedule : undefined;
    const nextAt = this.nextAt(schedule);
    const job: ScheduledJob = {
      id: `j-${task.id}`,
      title: task.title,
      ...(schedule ? { schedule } : {}),
      ...(task.trigger.kind === "event" ? { event: task.trigger } : {}),
      each: task.summary,
      maintainerId: task.maintainerId,
      taskId: task.id,
      taskTitle: task.title,
      ownerTaskId: task.id,
      grants: [],
      temporalRules: [],
      grantInfo: {},
      state: "active",
      ...(nextAt ? { nextAt } : {}),
      lastFailed: false,
      consecutiveFailures: 0,
      runCount: 0,
      createdAt: time,
      updatedAt: time,
    };
    this.triggers.set(task.id, job);
    this.emit(CHANNELS.board, EVENT_TYPES.scheduledJob, { job, change: "registered", by: "user" } satisfies ScheduledJobEventPayload);
  }

  /** 暂停、恢复、取消定时触发的任务（76 号票）：落到它的触发上，取消时任务一起取消；原型旧的假定时作业控制不了。做不了时返回原因 */
  private actOnTrigger(job: ScheduledJob, action: "pause" | "resume" | "cancel"): string | undefined {
    if ((action === "pause" && job.state !== "active") || (action === "resume" && job.state !== "paused") || job.state === "cancelled") return "现在不能这样做";
    const time = nowIso();
    const { nextAt: _n, pausedBy: _p, ...rest } = job;
    const nextAt = action === "resume" ? this.nextAt(job.schedule) : undefined;
    const next: ScheduledJob = {
      ...rest,
      state: action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled",
      ...(action === "pause" ? { pausedBy: "user" as const } : {}),
      ...(nextAt ? { nextAt } : {}),
      ...(action === "resume" ? { consecutiveFailures: 0 } : {}),
      updatedAt: time,
    };
    this.triggers.set(job.ownerTaskId!, next);
    this.emit(CHANNELS.board, EVENT_TYPES.scheduledJob, { job: next, change: action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled", by: "user" } satisfies ScheduledJobEventPayload);
    const task = this.tasks.get(job.ownerTaskId!);
    if (action === "cancel" && task) {
      const cancelled: Task = { ...task, state: "cancelled", updatedAt: time };
      this.tasks.set(task.id, cancelled);
      this.emit(CHANNELS.board, EVENT_TYPES.task, { task: cancelled, change: "cancelled", from: task.state, by: "user" } satisfies TaskEventPayload);
    }
    return undefined;
  }

  scheduledJobAction(req: ScheduledJobActionRequest): void {
    later(300, () => {
      const job = [...this.triggers.values()].find((j) => j.id === req.jobId);
      if (job) {
        const refusal = this.actOnTrigger(job, req.action);
        if (refusal) this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: refusal });
        return;
      }
      this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "原型的假定时作业不能控制：连上守护进程看真作业" });
    });
  }

  /**
   * 改时间（98 号票）：只换时间表、重算下一次（暂停着的照旧暂停），记一条用户改的 rescheduled；事件触发的、已取消的、
   * 某个时间做一次的时间已过的说做不了
   */
  rescheduleJob(req: RescheduleJobRequest): Promise<RescheduleJobResult> {
    return new Promise((resolve, reject) =>
      later(300, () => {
        const job = [...this.triggers.values()].find((j) => j.id === req.jobId);
        const { schedule } = req;
        const refusal = !job
          ? "原型的假定时作业不能改时间：连上守护进程看真作业"
          : !canRescheduleJob(job)
            ? job.schedule
              ? "已取消的不能改时间"
              : "事件触发的没有时间表，改不了时间"
            : schedule.kind === "once" && !(Date.parse(schedule.at) > Date.now())
              ? `定的时间 ${describeTime(new Date(schedule.at))} 已经过了：定一个将来的时间`
              : undefined;
        if (!job || refusal) {
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: refusal ?? "做不了" });
          reject(new Error(refusal));
          return;
        }
        const { nextAt: _n, ...rest } = job;
        const nextAt = job.state === "active" ? this.nextAt(schedule) : undefined;
        const next: ScheduledJob = { ...rest, schedule, ...(nextAt ? { nextAt } : {}), updatedAt: nowIso() };
        this.triggers.set(job.ownerTaskId!, next);
        this.emit(CHANNELS.board, EVENT_TYPES.scheduledJob, { job: next, change: "rescheduled", by: "user" } satisfies ScheduledJobEventPayload);
        resolve({ jobId: next.id, state: next.state, schedule, ...(nextAt ? { nextAt } : {}) });
      }),
    );
  }

  /**
   * 立即运行一次（100 号票）：演一遍运行（排队 → 运行中 → 成功），触发记成手动、时间表不动；暂停着的跑一次照旧暂停。
   * 上一次还在跑的、已取消的、原型旧的假定时作业说做不了
   */
  runJobNow(req: RunJobNowRequest): Promise<RunJobNowResult> {
    return new Promise((resolve, reject) =>
      later(300, () => {
        const job = [...this.triggers.values()].find((j) => j.id === req.jobId);
        const busy = job?.lastRun && (job.lastRun.state === "queued" || job.lastRun.state === "running");
        const refusal = !job ? "原型的假定时作业不能立即运行：连上守护进程看真作业" : !canRunJobNow(job) ? "已取消的不能立即运行" : busy ? `「${job.title}」上一次还在跑，跑完再说` : undefined;
        if (!job || refusal) {
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: refusal ?? "做不了" });
          reject(new Error(refusal));
          return;
        }
        const at = new Date();
        const runId = `${job.id}-r${job.runCount + 1}`;
        const run: JobRun = { runId, jobId: job.id, trigger: "manual", dueAt: nowIso(at), events: [{ source: MANUAL_TRIGGER_SOURCE, at: nowIso(at), summary: manualTriggerSummary(at) }], state: "running", queuedAt: nowIso(at), startedAt: nowIso(at) };
        const step = (change: "triggered" | "run_finished", r: JobRun) => {
          const latest = this.triggers.get(job.ownerTaskId!) ?? job;
          const next: ScheduledJob = { ...latest, lastRun: r, runCount: job.runCount + 1, ...(change === "run_finished" ? { lastFailed: false, consecutiveFailures: 0 } : {}), updatedAt: nowIso() };
          this.triggers.set(job.ownerTaskId!, next);
          this.emit(CHANNELS.board, EVENT_TYPES.scheduledJob, { job: next, change, by: change === "triggered" ? "user" : "system", run: r } satisfies ScheduledJobEventPayload);
        };
        step("triggered", run);
        later(4000, () => step("run_finished", { ...run, state: "done", endedAt: nowIso(), summary: "（原型）手动跑了一次，做好了" }));
        resolve({ jobId: job.id, runId, state: "running" });
      }),
    );
  }

  /** 跑完自动播报（100 号票）：照协议包的 canSetVoiceAnnounce 改假任务的开关，推一条 voice_announce_set */
  setVoiceAnnounce(req: SetVoiceAnnounceRequest): Promise<SetVoiceAnnounceResult> {
    return new Promise((resolve, reject) =>
      later(300, () => {
        const task = this.tasks.get(req.taskId);
        const refusal = !task ? `没有任务 ${req.taskId}` : !canSetVoiceAnnounce(task) ? "这个任务不会再做完了，没有跑完自动播报可开关" : undefined;
        if (!task || refusal) {
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: refusal ?? "做不了" });
          reject(new Error(refusal));
          return;
        }
        if ((task.voiceAnnounce === true) !== req.on) {
          const next: Task = { ...task, voiceAnnounce: req.on, updatedAt: nowIso() };
          this.tasks.set(task.id, next);
          this.emit(CHANNELS.board, EVENT_TYPES.task, { task: next, change: "voice_announce_set", from: task.state, by: "user" } satisfies TaskEventPayload);
        }
        resolve({ taskId: task.id, on: req.on });
      }),
    );
  }

  /**
   * 原型的假任务没有执行：暂停、继续、取消、归档照"谁能改"表演一遍状态变化（定时触发的任务运营中时落到它的触发上）；
   * 重试、返工、验收这些说一声做不了
   */
  taskAction(req: TaskActionRequest): void {
    later(300, () => {
      const { action } = req;
      if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "archive") {
        this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "原型的假任务不能控制：连上守护进程看真任务" });
        return;
      }
      const result = this.actOnTask(req.taskId, action);
      if (!result.ok) this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: result.message });
    });
  }

  /** 一次处理多个任务（90 号票）：一个一个演，逐条回报 */
  taskBatchAction(req: TaskBatchActionRequest): Promise<TaskBatchActionResult> {
    return new Promise((resolve) => later(300, () => resolve({ results: req.taskIds.map((id) => this.actOnTask(id, req.action)) })));
  }

  /** 对一个假任务做暂停、继续、取消、归档：定时触发的运营中时落到它的触发上；别的照"谁能改"表改状态 */
  private actOnTask(taskId: string, action: TaskBatchAction): TaskBatchItemResult {
    const task = this.tasks.get(taskId);
    if (!task) return { taskId, ok: false, code: "not_found", message: `没有任务 ${taskId}` };
    const job = this.triggers.get(taskId);
    if (task.state === "operating" && job && action !== "archive") {
      const refusal = this.actOnTrigger(job, action);
      return refusal ? { taskId, ok: false, code: "not_allowed", message: refusal } : { taskId, ok: true, state: this.tasks.get(taskId)?.state ?? task.state };
    }
    if (!availableTaskActions(task, "user").includes(action)) return { taskId, ok: false, code: "not_allowed", message: taskActRefusal(task, action) };
    const state = action === "pause" ? "paused" : action === "resume" ? "running" : action === "cancel" ? "cancelled" : "archived";
    const next: Task = { ...task, state, updatedAt: nowIso() };
    this.tasks.set(taskId, next);
    const change = action === "pause" ? "paused" : action === "resume" ? "resumed" : action === "cancel" ? "cancelled" : "archived";
    this.emit(CHANNELS.board, EVENT_TYPES.task, { task: next, change, from: task.state, by: "user" } satisfies TaskEventPayload);
    return { taskId, ok: true, state };
  }

  /** 发起对话框里的"只提醒我"（76 号票）：建一条假的简单提醒，推到看板频道；事件发生时提醒的（77 号票）没有下一次 */
  createReminder(req: CreateReminderRequest): void {
    later(300, () => {
      const nextAt = this.nextAt(req.schedule);
      if (req.schedule && !nextAt) return this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "这个时间已经过去了" });
      this.reminderNo += 1;
      const time = nowIso();
      const reminder: Reminder = {
        id: `r-proto-${this.reminderNo}`,
        text: req.text.trim(),
        ...(req.schedule ? { schedule: req.schedule } : {}),
        ...(req.event ? { event: req.event } : {}),
        status: "pending",
        ...(nextAt ? { nextAt } : {}),
        cardId: `c-r-proto-${this.reminderNo}`,
        createdAt: time,
        updatedAt: time,
      };
      this.emit(CHANNELS.board, EVENT_TYPES.reminder, { reminder, change: "created", by: "user" } satisfies ReminderEventPayload);
    });
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
        if (item.kind === "notice" && item.notice === "project_delete" && req.choice === PROJECT_DELETE_CONFIRM) this.deleteProject(item);
      }
    });
  }

  /** 删除项目的二次确认点了"确认删除"：还在已归档的才删 */
  private deleteProject(item: NoticeInboxItem): void {
    const projectId = inboxItemProjectId(item);
    const project = projectId === undefined ? undefined : this.projects.get(projectId);
    if (project?.state !== "archived") return;
    this.projects.delete(project.id);
    this.emit(CHANNELS.projects, EVENT_TYPES.project, { project, change: "deleted", from: "archived", by: "user" } satisfies ProjectEventPayload);
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
