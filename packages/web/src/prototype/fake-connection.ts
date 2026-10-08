// 原型用的假连接：没有守护进程，在浏览器里模拟服务端。
// - 启动时把假事件按频道编上序号，当作服务端已有的事件；连上时按前端带来的序号补发；
// - 发消息：过一会儿推回带同一个幂等键的权威消息，再推一条 agent 的回复；
// - 卡片动作：按版本条件更新（先到先得），推卡片更新事件；版本对不上就回"已被处理"；
// - 待我处理：假事项也走 inbox_item 事件；标已读、归档、删除、处理通知照守护进程的规矩（卡着任务的处理之前不能归档或删除）；
// - 已配对设备：假设备走 device 事件；吊销推一条吊销事件；批准假的配对请求卡多一台设备；
// - 发起任务（按钮，或者点"建议发起任务"卡上的"发起任务"）：在看板频道推一条 task 事件（规划中）；
// - 工作日历：假的节假日数据和个人设置走工作日历频道；改个人设置（假 HTTP 交过来）推一条 workday_settings 事件。
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
  ResetMaintainerRequest,
  RetryVoiceRequest,
  RevokeDeviceRequest,
  SetToolkitRequest,
  SendMessageRequest,
  StartTaskRequest,
  TaskActionRequest,
  UpdateWatchCategoriesRequest,
} from "../app/connection.ts";
import {
  applyWorkdayChange,
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
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { FAKE_CARDS, FAKE_HISTORY } from "./fake-conversations.ts";
import { FAKE_DEVICES, FAKE_HOLIDAYS, FAKE_INBOX, FAKE_PROJECTS, FAKE_WATCH_CATEGORIES, FAKE_WORKDAY_SETTINGS } from "./fake-data.ts";

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
  private readonly projects = new Map<string, Project>();
  private readonly tasks = new Map<string, Task>();
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
    for (const e of FAKE_HISTORY) this.append(e.channel, e.type, e.payload);
    for (const item of FAKE_INBOX) {
      this.inbox.set(item.id, item);
      this.append(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
    }
    for (const project of FAKE_PROJECTS) {
      this.projects.set(project.id, project);
      this.append(CHANNELS.projects, EVENT_TYPES.project, { project, change: "created", from: null, by: "user" } satisfies ProjectEventPayload);
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
    later(1200, () => {
      const reply = req.conversation === CHANNELS.secretary ? "（原型）收到。这里是假数据，接上守护进程后是秘书的真实回复。" : "（原型）收到，作为插话在下一步之前插入。这里是假数据。";
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
      const started = card.type === "suggest_task" && req.action === "start_task" ? this.createTask(card.payload as SuggestTaskCardPayload, "suggestion", (card.payload as SuggestTaskCardPayload).projects ?? []) : undefined;
      const payload = started ? { ...(card.payload as SuggestTaskCardPayload), taskId: started.id } : this.projectCardEffect(card, req.action);
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
    const projectIds = projects.flatMap((name) => [...this.projects.values()].filter((p) => p.name === name).map((p) => p.id));
    const task: Task = { id, title: what.title, summary: what.why, state: "planning", origin, maintainerId: ownMaintainerId(id), projects, projectIds, createdAt: time, updatedAt: time };
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

  /** 原型的假任务没有执行（任务详情里的控制是假数据自己演的）：说一声做不了 */
  taskAction(req: TaskActionRequest): void {
    later(300, () => this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: "原型的假任务不能控制：连上守护进程看真任务" }));
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
