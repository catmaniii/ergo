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
// - 关于页、Debug 工具集（124 号票）：守护进程的版本是这个页面的版本（3 小时 12 分钟前起来的）；断开重连演一遍断开、连上；
//   一次性的提醒（只提醒我、测试提醒）一小时内到点的照守护进程那样到点：待办里置顶一条、推一条 notify。
// - 流程撤回之后等你（155 号票）：一次性的流程撤回之后停在那里，一分钟内没在它的会话里说话，待办里一条"流程在等你"（卡着它）、
//   推一条 notify；说了话这条记成处理过。
// 由守护进程提供页面时，接了真数据的频道（秘书会话、卡片、待我处理……）走 WebSocket，这里的假数据只给其余页面用。
import { APP_VERSION } from "../app/build-info.ts";
import { prototypeLanguage } from "../app/locale.ts";
import { BUNDLED_LOCALES } from "../app/locale-bundle.ts";
import type {
  CardActionRequest,
  Connection,
  ConnectionStats,
  ConvertTaskRequest,
  InboxActionRequest,
  NewProjectRequest,
  ProjectActionRequest,
  ProjectServicesActionRequest,
  RescheduleJobRequest,
  ResetMaintainerRequest,
  RetryVoiceRequest,
  DeviceBatchActionRequest,
  RollbackSessionRequest,
  RequestEffectUndoRequest,
  SwitchBranchRequest,
  RunJobNowRequest,
  SetToolkitRequest,
  SetVoiceAnnounceRequest,
  ScheduledJobActionRequest,
  SendMessageRequest,
  StartTaskRequest,
  CreateReminderRequest,
  MarkReadRequest,
  QueuedMessageActionRequest,
  StopReplyRequest,
  TaskActionRequest,
  TaskBatchActionRequest,
  ReminderActionRequest,
  UpdateWatchCategoriesRequest,
} from "../app/connection.ts";
import {
  type ActivityEventPayload,
  applyWorkdayChange,
  type PluginAction,
  type PluginActionResult,
  type PluginsView,
  archiveCancelsFirst,
  availableTaskActions,
  ENDED_TASK_STATES,
  canRescheduleJob,
  canRunJobNow,
  canSetVoiceAnnounce,
  type DaemonInfo,
  describeTime,
  type JobRun,
  MANUAL_TRIGGER_SOURCE,
  manualTriggerSummary,
  type RescheduleJobResult,
  type ConversationId,
  type RollbackPreview,
  type RollbackSessionResult,
  type RollbackTarget,
  ROLLBACK_WAIT_ACK,
  ROLLBACK_WAIT_REMIND_MS,
  ROLLBACK_WAIT_SETTLED,
  rollbackWaitNotice,
  type RollbackWaitNoticeData,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  taskKind,
  type BranchView,
  type RequestEffectUndoResult,
  type SwitchBranchResult,
  type RunJobNowResult,
  type SetVoiceAnnounceResult,
  taskActRefusal,
  type TaskBatchAction,
  type TaskBatchActionResult,
  type TaskBatchItemResult,
  type AssistantNameEventPayload,
  type AssistantNameResult,
  type UserNameResult,
  type UserNameView,
  checkUserName,
  DEFAULT_LANGUAGE,
  type LanguageEventPayload,
  type LanguageResult,
  type LocaleDictionaryView,
  type LocaleEventPayload,
  type LocaleListView,
  checkAssistantName,
  DEFAULT_ASSISTANT_NAME,
  ASSISTANT_NAME_MARK,
  type CalendarMonthView,
  BLOCKING_URGENCIES,
  type Card,
  type CardAction,
  type CardEventPayload,
  CARD_TYPE_VERSIONS,
  CHANNELS,
  type BuildDoneCardPayload,
  type GoLiveCardPayload,
  type StandardBackfillCardPayload,
  goLiveTitle,
  type OperationsChangeCardPayload,
  type CharterCardPayload,
  DEFAULT_DEVICE_EXTEND_DAYS,
  type DeviceBatchActionResult,
  type DeviceBatchItemResult,
  type DeviceEventPayload,
  deviceBatchSkip,
  deviceSkipPhrase,
  extendedExpiry,
  EVENT_TYPES,
  type EventFrame,
  type InboxItem,
  type InboxItemEventPayload,
  type NoticeInboxItem,
  type NotifyEventPayload,
  isInboxItemProcessed,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessageQueueEventPayload,
  type QueueChange,
  type QueuedMessage,
  type TimelineRecordEventPayload,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  type ReadMarkEventPayload,
  type MessagePart,
  type PairedDevice,
  type PairingCardPayload,
  inboxItemProjectId,
  isPlainTask,
  isTriggered,
  onceAt,
  maintainerChannel,
  ownMaintainerId,
  PI_RUNTIME_ID,
  PROJECT_DELETE_CANCEL,
  PROJECT_DELETE_CONFIRM,
  type Project,
  type ProjectChange,
  type ProjectEventPayload,
  type ProjectServiceView,
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
  type ReminderActionItemResult,
  type ReminderCardPayload,
  type ReminderActionResult,
  type ReminderEventPayload,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type TaskTrigger,
  type WebVersionEventPayload,
  workdayCalendar,
  joinFolder,
  type WorkFolderChoice,
  workFolderName,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { fakeRuntimes } from "./fake-runtimes.ts";
import { fakeCalendarMonth } from "./fake-calendar.ts";
import { FakePlugins } from "./fake-plugins.ts";
import { appendRollbackDemo, type FakeBranchLog, fakeBranchView, fakeEffectUndo, fakeRollback, fakeRollbackPreview, fakeSwitchBranch } from "./fake-branches.ts";
import { FAKE_AT_TASK, FAKE_CARDS, FAKE_EVENT_TASK, FAKE_HISTORY, FAKE_PLAIN_TASK, FAKE_REMOTE_TASK, FAKE_TAKEOVER_TASK, FAKE_TIMED_TASK, FAKE_TIMED_WORKFLOW, FAKE_WORKFLOW_TASK } from "./fake-conversations.ts";
import { FAKE_DEVICES, FAKE_HOLIDAYS, FAKE_SELF_DEVICE_ID, FAKE_INBOX, FAKE_PROJECT_EVENTS, FAKE_PROJECTS, FAKE_WATCH_CATEGORIES, FAKE_WORKDAY_SETTINGS } from "./fake-data.ts";
import { FAKE_PROJECT_SERVICES } from "./fake-operations.ts";
import { fakeGoLiveChecklist } from "./fake-standard.ts";

/** 原型里假的语音对象 id 的前缀（分流连接据此把"重新识别"交给假连接） */
export const FAKE_VOICE_PREFIX = "v-fake-";

/** 这些动作算"关掉不处理"（回避信号），卡片状态记为已关闭 */
const DISMISS_ACTIONS = new Set<CardAction>(["dismiss", "cancel"]);

/** 原型里定的工作文件夹（305 号票）：能选工作文件夹的运行时才定；已有的照填的，新开的是默认文件夹下按名字起（原型不真建） */
function fakeWorkdir(runtime: string | undefined, folder: WorkFolderChoice | undefined, title: string): string | undefined {
  const found = fakeRuntimes().find((r) => r.id === runtime);
  if (!found?.workFolder) return undefined;
  if (folder?.kind === "existing") return folder.path;
  const parent = found.workFolder.defaultFolder;
  return parent === undefined ? undefined : joinFolder(parent, workFolderName(folder?.name ?? title) || "新的工作");
}

export class FakeConnection implements Connection {
  private readonly log: EventFrame[] = [];
  private readonly seqs: Record<string, number> = {};
  private readonly cards = new Map<string, Card>();
  private readonly inbox = new Map<string, InboxItem>();
  private readonly devices = new Map<string, PairedDevice>();
  private workday: WorkdaySettings = FAKE_WORKDAY_SETTINGS;
  /** 个人助理的名字（43 号票）：原型里从默认的开始，只记在内存里 */
  private assistantName = DEFAULT_ASSISTANT_NAME;
  /** 我的名字（249 号票，用户自己的名字）：原型里一开始没设，只记在内存里 */
  private userName: string | undefined;
  /** 语言（168 号票）：原型里从地址的 ?lang= 开始（没写是中文），只记在内存里；只有打包进去的几种 */
  private language = prototypeLanguage();
  /** 词典换过几次（临时事件 locale 的版本） */
  private localeNo = 0;
  private readonly projects = new Map<string, Project>();
  /** 项目的服务（133 号票的临时事件 project_services）：257 号票起点"启动""关闭"会变，整份推一次 */
  private services: ProjectServiceView[] = FAKE_PROJECT_SERVICES.map((v) => ({ ...v }));
  private readonly tasks = new Map<string, Task>();
  /** 定时触发的任务的触发登记（76 号票）：按任务 id */
  private readonly triggers = new Map<string, ScheduledJob>();
  private reminderNo = 0;
  /** 假连接建的提醒（只提醒我、Debug 工具集的测试提醒）现在的样子：取消、归档、删除（185 号票）照它演 */
  private readonly reminders = new Map<string, Reminder>();
  /** 原型里正在回复的一轮（144 号票：一段一段流出来，这时输入框上有"停止"、发的话排队）：会话 → 这一轮 */
  private readonly turns = new Map<string, FakeTurn>();
  /** 原型里排队的消息（144 号票）：会话 → 整队 */
  private readonly queues = new Map<string, QueuedMessage[]>();
  private deliver: ((input: UiInput) => void) | undefined;
  /** 设置 · 插件（211 号票）：原型里两个插件的状况，停用、启用、移除只在内存里 */
  private readonly plugins = new FakePlugins(demoList("demo-plugins-off"), demoList("demo-plugins-removed"));
  private taskNo = 0;
  private watch: WatchCategoriesState = FAKE_WATCH_CATEGORIES;
  private customNo = FAKE_WATCH_CATEGORIES.custom.length;
  private projectNo = 0;
  private itemNo = 0;
  private voiceNo = 0;
  private readonly voices = new Map<string, VoiceRecord>();
  /** 已读位置（109 号票，键是会话 id）：只往后挪 */
  private readonly readMarks = new Map<string, number>();
  /** 流程撤回之后在等你的（155 号票）：会话 → 第几次撤回、哪个流程、放过的提醒 */
  private readonly rollbackWaits = new Map<string, { no: number; taskId: string; reminder?: string }>();
  private rollbackWaitNo = 0;
  /** Debug 工具集里点了几次断开重连、最近一次（124 号票） */
  private manualDrops = 0;
  private lastManualDrop: { at: string; reason: string } | undefined;

  constructor() {
    for (const c of FAKE_CARDS) this.cards.set(c.id, c);
    this.tasks.set(FAKE_PLAIN_TASK.id, FAKE_PLAIN_TASK);
    for (const t of [FAKE_TIMED_TASK, FAKE_TIMED_WORKFLOW, FAKE_AT_TASK, FAKE_WORKFLOW_TASK, FAKE_EVENT_TASK, FAKE_TAKEOVER_TASK, FAKE_REMOTE_TASK]) this.tasks.set(t.id, t);
    for (const e of FAKE_HISTORY) {
      this.append(e.channel, e.type, e.payload);
      if (e.type === EVENT_TYPES.scheduledJob) {
        const { job } = e.payload as ScheduledJobEventPayload;
        if (job.ownerTaskId) this.triggers.set(job.ownerTaskId, job);
      }
    }
    // 秘书主线最后演过一次会话回退（150 号票）：缩小后看得到 ↶、⑂、🧭 分支摘要
    appendRollbackDemo(this.branchLog);
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
    // 已读位置（109 号票）：原型里的历史都算看过（照守护进程启动时记的那条）。地址里带 ?demo-unread 时，看过之后秘书又在"你不在时"
    // 念了一段语音（看"秘书"页签的红点、顶上的"秘书有 N 条新消息"、秘书会话里不在时念的语音小栏）
    this.readMarks.set(CHANNELS.secretary, this.seqs[CHANNELS.secretary] ?? 0);
    this.append(CHANNELS.readMarks, EVENT_TYPES.readMark, { conversation: CHANNELS.secretary, seq: this.readMarks.get(CHANNELS.secretary)!, time: nowIso() } satisfies ReadMarkEventPayload);
    if (demoParam("demo-unread") !== null) {
      for (const e of awayDemo()) this.append(e.channel, e.type, e.payload);
      // 秘书会话里还有一张没处理的快速动作卡进了待办：输入框上面"等你处理"栏（107 号票）和不在时念的语音小栏一起出现
      const item: InboxItem = { id: "i-demo-relay", kind: "card", cardId: "c-qa-4", title: "转达给项目「记账本」的维护者", source: ASSISTANT_NAME_MARK, urgency: "non_blocking", createdAt: nowIso(), read: false, version: 1, pinned: false, archived: false, deleted: false, origin: { conversation: CHANNELS.secretary } };
      this.inbox.set(item.id, item);
      this.append(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
    }
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

  /** 我的名字（249 号票，假 HTTP 交过来）：和守护进程一样按同一条规则查（不合规抛错），null / 空串是清除；只记在内存里 */
  userNameView(): UserNameView {
    return this.userName === undefined ? {} : { name: this.userName };
  }

  setUserName(raw: string | null): UserNameResult {
    if (raw === null || raw.trim() === "") {
      const changed = this.userName !== undefined;
      this.userName = undefined;
      return { changed };
    }
    const checked = checkUserName(raw);
    if (!checked.ok) throw new Error(checked.error);
    if (checked.name === this.userName) return { name: checked.name, changed: false };
    this.userName = checked.name;
    return { name: checked.name, changed: true };
  }

  /** 设置 · 语言（假 HTTP 交过来）：打包进去的几种，都是自带的、不缺句 */
  localeList(): LocaleListView {
    return {
      language: this.language,
      effective: this.language,
      userDir: "~/.ergo/locales",
      // 和守护进程一样中文排第一
      languages: [...BUNDLED_LOCALES.values()]
        .toSorted((a, b) => (a.meta.id === DEFAULT_LANGUAGE ? -1 : b.meta.id === DEFAULT_LANGUAGE ? 1 : a.meta.id < b.meta.id ? -1 : 1))
        .map((entry) => ({ id: entry.meta.id, nativeName: entry.meta.nativeName, source: "builtin", overridden: 0, missing: 0 })),
      problems: [],
      revision: this.localeRevision(),
    };
  }

  /** 网页的词典（假 HTTP 交过来）：打包进去的那种（网页再垫一层打包进去的，一样） */
  localeView(): LocaleDictionaryView {
    const entry = BUNDLED_LOCALES.get(this.language)!;
    const zh = BUNDLED_LOCALES.get(DEFAULT_LANGUAGE)!;
    return { language: this.language, meta: entry.meta, messages: entry.messages, ...(this.language === DEFAULT_LANGUAGE ? {} : { fallback: zh.messages }), revision: this.localeRevision() };
  }

  /** 换语言（假 HTTP 交过来）：和守护进程一样只认列表里有的，有变化推一条 language 和临时事件 locale */
  setLanguage(raw: string): LanguageResult {
    const language = raw.trim();
    if (!BUNDLED_LOCALES.has(language)) throw new Error(`没有这种语言：${language}`);
    if (language === this.language) return { language, changed: false };
    this.language = language;
    this.localeNo += 1;
    later(150, () => {
      this.emit(CHANNELS.language, EVENT_TYPES.language, { language, source: "settings" } satisfies LanguageEventPayload);
      this.deliver?.({ kind: "frame", frame: this.localeFrame() });
    });
    return { language, changed: true };
  }

  /** 设置 · 插件（假 HTTP 交过来，211 号票）：清单 */
  pluginList(): PluginsView {
    return this.plugins.view();
  }

  /** 停用、启用、移除（假 HTTP 交过来）：变了的话插件频道上推新的状况，网页插件跟着装、停 */
  pluginAction(name: string, action: PluginAction, purgeData: boolean): PluginActionResult {
    const result = this.plugins.act(name, action, purgeData);
    if (result.changed.length > 0) later(150, () => this.deliver?.({ kind: "frame", frame: this.pluginStatusFrame() }));
    return result;
  }

  /** 插件频道上的临时事件 plugin_status */
  private pluginStatusFrame(): EventFrame {
    return { channel: CHANNELS.plugins, seq: 0, type: EVENT_TYPES.pluginStatus, payload: this.plugins.status() };
  }

  private localeRevision(): string {
    return `proto-${this.localeNo}`;
  }

  /** 语言频道上的临时事件 locale：实际在用的语言和词典的版本 */
  private localeFrame(): EventFrame {
    return { channel: CHANNELS.language, seq: this.seqs[CHANNELS.language] ?? 0, type: EVENT_TYPES.locale, payload: { language: this.language, revision: this.localeRevision() } satisfies LocaleEventPayload };
  }

  /** 某个月的日历（假 HTTP 交过来）：asOf 是这边两个频道的序号（原型里外部日程不变，版本是 0） */
  calendarMonth(month: string): CalendarMonthView {
    return fakeCalendarMonth(month, FAKE_HOLIDAYS, this.workday, { board: this.seqs[CHANNELS.board] ?? 0, workdayCalendar: this.seqs[CHANNELS.workdayCalendar] ?? 0, external: 0 });
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

  /** 秘书页上看到哪一条了（109 号票）：和守护进程一样只往后挪、比最后一条还靠后的按最后一条记，推一条 read_mark */
  markRead(req: MarkReadRequest): void {
    const seq = Math.min(req.seq, this.seqs[req.conversation] ?? 0);
    if (seq <= (this.readMarks.get(req.conversation) ?? -1)) return;
    this.readMarks.set(req.conversation, seq);
    later(100, () => this.emit(CHANNELS.readMarks, EVENT_TYPES.readMark, { conversation: req.conversation, seq, time: nowIso() } satisfies ReadMarkEventPayload));
  }

  /** 守护进程的版本（124 号票：关于页、Debug 工具集）：原型里就是这个页面的版本，3 小时 12 分钟前起来的；回得慢一点，"测一次延迟"有个数 */
  daemonInfo(): Promise<DaemonInfo> {
    const now = Date.now();
    return new Promise((resolve) => later(18, () => resolve({ version: APP_VERSION, startedAt: nowIso(new Date(now - FAKE_DAEMON_UPTIME_MS)), now: nowIso(new Date(now + 18)) })));
  }

  /** 这次打开以来的连接情况（124 号票）：原型的假连接不会断；?demo-debug 时给几个假数，看 Debug 页的样子 */
  stats(): ConnectionStats {
    const demo = demoParam("demo-debug") !== null;
    const drops = this.manualDrops + (demo ? 2 : 0);
    if (drops === 0) return { drops: 0, reconnects: 0 };
    const lastDrop = this.lastManualDrop ?? { at: nowIso(new Date(Date.now() - 25 * 60_000)), reason: "1006 异常断开（没收到关闭帧：网断了、守护进程停了、隧道断了）" };
    return { drops, reconnects: drops, lastDrop };
  }

  /** 断开重连（124 号票）：原型里报一下断开、0.6 秒后又连上 */
  reconnect(): void {
    this.manualDrops += 1;
    this.lastManualDrop = { at: nowIso(), reason: "在 Debug 工具集里点了断开重连" };
    this.deliver?.({ kind: "connection", status: "offline" });
    later(600, () => this.deliver?.({ kind: "connection", status: "online" }));
  }

  /**
   * 一次性的提醒（只提醒我、Debug 工具集的测试提醒）一小时内到点的：和守护进程一样到点在待办里置顶一条、推一条 notify，
   * 提醒变成已触发
   */
  private fireLater(reminder: Reminder): void {
    if (reminder.schedule?.kind !== "once" || reminder.nextAt === undefined) return;
    const delay = Date.parse(reminder.nextAt) - Date.now();
    if (!(delay >= 0 && delay <= 3_600_000)) return;
    later(delay, () => {
      this.itemNo += 1;
      const item: InboxItem = {
        id: `i-proto-r-${this.itemNo}`,
        kind: "notice",
        notice: "reminder_due",
        title: `提醒：${reminder.text}`,
        body: `${describeTime(new Date(reminder.nextAt!))} 的提醒。`,
        source: "简单提醒",
        urgency: "non_blocking",
        createdAt: nowIso(),
        read: false,
        version: 1,
        pinned: true,
        archived: false,
        deleted: false,
        actions: ["知道了"],
        cardId: reminder.cardId,
      };
      this.inbox.set(item.id, item);
      this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
      const { nextAt: dueAt, ...rest } = reminder;
      // 到点前取消了、删了的不响
      if (this.reminders.get(reminder.id)?.status !== "pending") return;
      const fired: Reminder = { ...rest, status: "fired", lastFiredAt: dueAt!, updatedAt: nowIso() };
      this.reminders.set(fired.id, fired);
      this.emit(CHANNELS.board, EVENT_TYPES.reminder, { reminder: fired, change: "fired", by: "system" } satisfies ReminderEventPayload);
      const notify: NotifyEventPayload = { id: `n-proto-${item.id}`, title: item.title, body: item.body ?? "", itemId: item.id };
      this.deliver?.({ kind: "frame", frame: { channel: CHANNELS.inbox, seq: this.seqs[CHANNELS.inbox] ?? 0, type: EVENT_TYPES.notify, payload: notify } });
    });
  }

  /** 是不是原型里的假卡片（过渡期的分流连接据此把卡片动作交给假连接） */
  hasCard(cardId: string): boolean {
    return this.cards.has(cardId);
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    this.deliver = deliver;
    // 打开时补发的历史（标成补发的：不自动播语音、不算秘书刚说完的一轮），之后报补发推完了（109 号票）
    for (const frame of this.log) if (frame.seq > (cursors[frame.channel] ?? 0)) deliver({ kind: "frame", frame, catchUp: true });
    deliver({ kind: "synced" });
    // 133 号票：项目的服务（守护进程订阅时补推一次全量的那个临时事件）
    this.pushServices();
    // 168 号票：实际在用的语言和词典的版本（守护进程订阅语言频道时补推的那个临时事件）
    deliver({ kind: "frame", frame: this.localeFrame() });
    // 193 号票：插件的状况（守护进程订阅插件频道时补推的那个临时事件）：原型里提醒、记忆都在运行；?demo-plugins-off=memory,reminders 看停用的样子
    deliver({ kind: "frame", frame: this.pluginStatusFrame() });
    this.demoAlerts(deliver);
    this.demoSecretaryTurn();
    this.demoUpdate(deliver);
    return () => {
      if (this.deliver === deliver) this.deliver = undefined;
    };
  }

  /**
   * 流程撤回之后停在那里（155 号票，照守护进程的 tasks/rollback-wait.ts）：一次性的流程跟着撤回还在执行中、排队中的，一分钟
   * （ROLLBACK_WAIT_REMIND_MS）内没在这个会话里说话，待办里放一条"流程在等你"（卡着它，来源是这个任务），推一条 notify；只放一次
   */
  private armRollbackWait(conversation: string, frames: readonly EventFrame[]): void {
    this.settleRollbackWait(conversation, "voided");
    const rolled = frames.findLast((f) => f.channel === CHANNELS.board && f.type === EVENT_TYPES.task && (f.payload as TaskEventPayload).change === "rolled_back")?.payload as TaskEventPayload | undefined;
    const task = rolled?.task;
    if (!task || taskKind(task) !== "workflow" || isTriggered(task) || (task.state !== "running" && task.state !== "queued")) return;
    const branch = frames.find((f) => f.type === EVENT_TYPES.sessionBranch)?.payload as SessionBranchEventPayload | undefined;
    const before = branch?.before;
    const mark =
      before && "stageStart" in before
        ? (this.log.find((f) => f.channel === conversation && f.type === EVENT_TYPES.stageStart && (f.payload as StageStartEventPayload).id === before.stageStart)?.payload as StageStartEventPayload | undefined)
        : undefined;
    const next = task.steps?.list?.find((s) => s.state !== "done" && s.state !== "skipped")?.title;
    const no = ++this.rollbackWaitNo;
    this.rollbackWaits.set(conversation, { no, taskId: task.id });
    later(ROLLBACK_WAIT_REMIND_MS, () => {
      const wait = this.rollbackWaits.get(conversation);
      if (wait?.no !== no || wait.reminder !== undefined) return;
      this.itemNo += 1;
      const { title, body } = rollbackWaitNotice(task.title, { ...(mark?.stepId === undefined ? {} : { step: mark.title }), next });
      const item: InboxItem = {
        id: `i-proto-rw-${this.itemNo}`,
        kind: "notice",
        notice: "rollback_wait",
        title,
        body,
        source: `任务「${task.title}」`,
        urgency: "blocking",
        createdAt: nowIso(),
        read: false,
        version: 1,
        pinned: false,
        archived: false,
        deleted: false,
        actions: [ROLLBACK_WAIT_ACK],
        origin: { taskId: task.id },
        data: { taskId: task.id, rollbackSeq: no } satisfies RollbackWaitNoticeData,
      };
      wait.reminder = item.id;
      this.inbox.set(item.id, item);
      this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item } satisfies InboxItemEventPayload);
      const notify: NotifyEventPayload = { id: `n-proto-${item.id}`, title: item.title, body, itemId: item.id };
      this.deliver?.({ kind: "frame", frame: { channel: CHANNELS.inbox, seq: this.seqs[CHANNELS.inbox] ?? 0, type: EVENT_TYPES.notify, payload: notify } });
    });
  }

  /** 不等了（155 号票）：在这个会话里说了话（resumed）、又撤回了一次（voided）；放过的提醒还没处理的记成处理过 */
  private settleRollbackWait(conversation: string, how: keyof typeof ROLLBACK_WAIT_SETTLED): void {
    const wait = this.rollbackWaits.get(conversation);
    if (!wait) return;
    this.rollbackWaits.delete(conversation);
    const item = wait.reminder === undefined ? undefined : this.inbox.get(wait.reminder);
    if (item?.kind !== "notice" || item.handled !== undefined) return;
    const { handled, note } = ROLLBACK_WAIT_SETTLED[how];
    const next: InboxItem = { ...item, handled, handledAt: nowIso(), handledNote: note, urgency: "non_blocking", read: true, version: item.version + 1 };
    this.inbox.set(next.id, next);
    this.emit(CHANNELS.inbox, EVENT_TYPES.inboxItem, { item: next } satisfies InboxItemEventPayload);
  }

  sendMessage(req: SendMessageRequest): void {
    this.settleRollbackWait(req.conversation, "resumed");
    const time = nowIso();
    const messageId = `u-${req.idempotencyKey}`;
    // 语音（31 号票）：带上假的语音对象 id，之后推识别的过程
    const parts = req.parts.map((p): MessagePart => (p.type === "voice" ? { ...p, voiceId: `${FAKE_VOICE_PREFIX}${++this.voiceNo}` } : p));
    // 正在回复（144 号票）：排进队，这一轮说完（或者点了停止）一起交出去
    if (this.turns.has(req.conversation)) {
      const item: QueuedMessage = { message: { id: messageId, conversation: req.conversation, speaker: "user", time, parts }, idempotencyKey: req.idempotencyKey };
      later(250, () => {
        this.putQueue(req.conversation, "queued", [messageId], [...(this.queues.get(req.conversation) ?? []), item], req.idempotencyKey);
        for (const p of parts) {
          if (p.type !== "voice" || p.voiceId === undefined) continue;
          this.recognizeVoice({ id: p.voiceId, messageId, conversation: req.conversation, mediaId: p.mediaId, mime: p.mime, durationMs: p.durationMs, waveform: p.waveform, status: "queued", attempt: 1, createdAt: time, updatedAt: time, version: 1 });
        }
      });
      return;
    }
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
    // 一轮回复（144 号票起一段一段流出来：说着的时候能停止、发的话排队）
    later(600, () => this.startTurn(req.conversation, [messageId], FAKE_REPLY));
  }

  /** 原型的一轮回复：turn_start，一段一段推流式增量，说完了定稿、turn_end，再把排着的一起交出去 */
  private startTurn(conversation: string, inputs: readonly string[], text: string): void {
    const [input, ...more] = inputs;
    if (input === undefined) return;
    this.emit(conversation, EVENT_TYPES.turnStart, { inputMessageId: input, ...(more.length > 0 ? { moreInputMessageIds: more } : {}) });
    const turn: FakeTurn = { inputs, replyId: `a-${input}`, text, said: 0, timer: undefined };
    turn.timer = setInterval(() => {
      const step = text.slice(turn.said, turn.said + 4);
      if (!step) return this.endTurn(conversation, "completed");
      const delta = { part: 0, type: "text" as const, offset: turn.said, text: step };
      turn.said += step.length;
      this.deliver?.({ kind: "frame", frame: { channel: conversation, seq: this.seqs[conversation] ?? 0, type: EVENT_TYPES.stream, payload: { messageId: turn.replyId, deltas: [delta] } } });
    }, 120);
    this.turns.set(conversation, turn);
  }

  /** 这一轮结束：说出来的定稿（点了停止的标"已停止"、时间线记一笔），排着的一起交出去作为下一轮 */
  private endTurn(conversation: string, outcome: "completed" | "aborted"): void {
    const turn = this.turns.get(conversation);
    if (!turn) return;
    clearInterval(turn.timer);
    this.turns.delete(conversation);
    const said = turn.text.slice(0, turn.said);
    if (said) {
      const message: MessageEnvelope = { id: turn.replyId, conversation: conversation as MessageEnvelope["conversation"], speaker: "agent", time: nowIso(), parts: [{ type: "text", text: said }], ...(outcome === "aborted" ? { stopped: true as const } : {}) };
      this.emit(conversation, EVENT_TYPES.message, { message } satisfies MessageEventPayload);
    }
    if (outcome === "aborted") {
      this.emit(conversation, EVENT_TYPES.timelineRecord, { record: { id: `r-stop-${turn.replyId}`, kind: "stopped", summary: "你停止了这一轮", time: nowIso() } } satisfies TimelineRecordEventPayload);
    }
    const [input, ...more] = turn.inputs;
    this.emit(conversation, EVENT_TYPES.turnEnd, { inputMessageId: input, ...(more.length > 0 ? { moreInputMessageIds: more } : {}), outcome });
    const queue = this.queues.get(conversation) ?? [];
    if (queue.length === 0) return;
    const delivery = `qd-${queue[0]!.message.id}`;
    for (const q of queue) this.emit(conversation, EVENT_TYPES.message, { message: q.message, idempotencyKey: q.idempotencyKey, queueDelivery: delivery } satisfies MessageEventPayload);
    const ids = queue.map((q) => q.message.id);
    this.putQueue(conversation, "delivered", ids, []);
    later(500, () => this.startTurn(conversation, ids, ids.length > 1 ? `（原型）这 ${ids.length} 条一起收到了，按顺序处理。${FAKE_REPLY}` : FAKE_REPLY));
  }

  /** 原型的队列换一份：推一条 message_queue */
  private putQueue(conversation: string, change: QueueChange, messageIds: readonly string[], queue: QueuedMessage[], requestKey?: string): void {
    this.queues.set(conversation, queue);
    this.emit(conversation, EVENT_TYPES.messageQueue, { change, messageIds: [...messageIds], queue, ...(requestKey === undefined ? {} : { requestKey }) } satisfies MessageQueueEventPayload);
  }

  /** 原型的事件日志给会话回退用（150 号票，fake-branches.ts） */
  private readonly branchLog: FakeBranchLog = {
    append: (channel, type, payload) => this.append(channel, type, payload),
    frames: (channel) => this.log.filter((f) => f.channel === channel),
  };

  /** 回退前的确认（150 号票，假 HTTP 交过来）：这一段做了的事按假会话里的工具调用编 */
  rollbackPreview(conversation: ConversationId, before: RollbackTarget): RollbackPreview {
    return fakeRollbackPreview(this.branchLog, conversation, before);
  }

  /** 会话回退（150 号票）：过一会儿长出新分支（推 session_branch、分支摘要）；回不到那里的说原因 */
  rollbackSession(req: RollbackSessionRequest): Promise<RollbackSessionResult> {
    return new Promise((resolve, reject) =>
      later(600, () => {
        try {
          const { result, frames } = fakeRollback(this.branchLog, req.conversation, req.before);
          for (const frame of frames) this.deliver?.({ kind: "frame", frame });
          this.armRollbackWait(req.conversation, frames);
          resolve(result);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error });
          reject(new Error(error));
        }
      }),
    );
  }

  /** 一条分支的样子（151 号票，假 HTTP 交过来）：它自己那一段的消息、遗留效果、分支摘要 */
  branchView(conversation: ConversationId, branchId: string, against?: string): BranchView {
    return fakeBranchView(this.branchLog, conversation, branchId, against);
  }

  /** 切换分支（151 号票）：正在回复的先停下，过一会儿切过去（推 session_branch）；切不过去的说原因 */
  switchBranch(req: SwitchBranchRequest): Promise<SwitchBranchResult> {
    if (this.turns.has(req.conversation)) this.endTurn(req.conversation, "aborted");
    return this.settleBranchRequest(req.idempotencyKey, 600, () => fakeSwitchBranch(this.branchLog, req.conversation, req.branchId));
  }

  /** 申请撤回（151 号票）：记一条 effect_undo_requested；不能申请的说原因 */
  requestEffectUndo(req: RequestEffectUndoRequest): Promise<RequestEffectUndoResult> {
    return this.settleBranchRequest(req.idempotencyKey, 200, () => fakeEffectUndo(this.branchLog, req.conversation, req.branchId, req.callId));
  }

  /** 原型的切换、申请撤回：过一会儿做，推出帧、兑现结果；做不成的进 request_failed 并拒绝 */
  private settleBranchRequest<T>(idempotencyKey: string, ms: number, run: () => { result: T; frames: EventFrame[] }): Promise<T> {
    return new Promise((resolve, reject) =>
      later(ms, () => {
        try {
          const { result, frames } = run();
          for (const frame of frames) this.deliver?.({ kind: "frame", frame });
          resolve(result);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.deliver?.({ kind: "request_failed", idempotencyKey, error });
          reject(new Error(error));
        }
      }),
    );
  }

  stopReply(req: StopReplyRequest): void {
    later(150, () => this.endTurn(req.conversation, "aborted"));
  }

  queuedMessageAction(req: QueuedMessageActionRequest): void {
    later(150, () => {
      const queue = this.queues.get(req.conversation) ?? [];
      if (req.action === "remove") {
        if (!queue.some((q) => q.message.id === req.messageId)) return;
        return this.putQueue(req.conversation, "removed", [req.messageId], queue.filter((q) => q.message.id !== req.messageId), req.idempotencyKey);
      }
      const named = req.messageIds.flatMap((id) => queue.find((q) => q.message.id === id) ?? []);
      const next = [...named, ...queue.filter((q) => !named.includes(q))];
      this.putQueue(req.conversation, "reordered", next.map((q) => q.message.id), next, req.idempotencyKey);
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
      const payload = started && kind ? { ...(card.payload as SuggestTaskCardPayload), taskId: started.id, kind } : this.projectCardEffect(card, req.action, req.note);
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
      const runtime = req.projects.length === 1 ? undefined : req.runtime;
      const task = this.createTask({ title, why: req.request.trim() }, "button", req.projects, req.kind, req.trigger, req.voiceAnnounce === true && req.projects.length !== 1, runtime, fakeWorkdir(runtime, req.folder, title));
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
  private createTask(
    what: { title: string; why: string },
    origin: TaskOrigin,
    projects: string[] = [],
    kind: TaskKind = "long_running",
    trigger?: TaskTrigger,
    voiceAnnounce = false,
    runtime?: string,
    workdir?: string,
  ): Task {
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
      // 289 号票：发起对话框里选的运行时（pi 不写）
      ...(runtime === undefined || runtime === PI_RUNTIME_ID ? {} : { runtime }),
      // 305 号票：在哪个文件夹做（原型不真建文件夹）
      ...(workdir === undefined ? {} : { workdir }),
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
      // 289 号票：选了运行时的照写在卡上（pi 不写）
      const runtime = req.runtime === undefined || req.runtime === PI_RUNTIME_ID ? {} : { runtime: req.runtime };
      // 305 号票：选的文件夹照写在卡上（新开的、没起名的不写：按项目名）
      const folder = req.folder === undefined || runtime.runtime === undefined || (req.folder.kind === "new" && req.folder.name === undefined) ? {} : { folder: req.folder };
      const payload: SuggestProjectCardPayload = { name: request.split("\n")[0]!.slice(0, 20), goal: request.slice(0, 300), ...runtime, ...folder };
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
      // 转入使用不马上转（259 号票）：出一张"转入使用"确认卡（还在等的就用那一张）
      if (req.action === "go_live") return this.askGoLive(project);
      // 迁移和守护进程用同一张表（共享协议包的 projectActionTarget）；删除不马上删
      const target = projectActionTarget(project, req.action);
      if (!target) return this.askDelete(project);
      const buildTaskId = req.action === "start_build" ? this.createTask({ title: `建设「${project.name}」首版`, why: project.goal }, "project_build", [project.name]).id : project.buildTaskId;
      this.updateProject(project, { state: target.state, archivedFrom: target.archivedFrom, ...(buildTaskId === undefined ? {} : { buildTaskId }) }, target.change);
    });
  }

  /**
   * 项目卡片、项目页上的"启动""关闭"（257 号票）：照守护进程的规矩——使用中、有在 LSM 上的服务才收下；先标"启动中…""关闭中…"，
   * 一会儿之后全部起来（在线、开机自启）或全部关掉（已关闭）
   */
  projectServicesAction(req: ProjectServicesActionRequest): void {
    later(200, () => {
      const project = this.projects.get(req.projectId);
      const mine = this.services.filter((v) => v.projectId === req.projectId && v.rollout !== "withdrawn" && v.rollout !== "withdrawing");
      const refusal = !project ? "没有这个项目" : project.state !== "in_use" ? `项目「${project.name}」不是使用中的，没有可以启动、关闭的服务` : mine.length === 0 ? `项目「${project.name}」没有上线的服务，没有可以启动、关闭的` : undefined;
      if (refusal) return this.deliver?.({ kind: "request_failed", idempotencyKey: req.idempotencyKey, error: refusal });
      const on = req.action === "start";
      const update = (change: (v: ProjectServiceView) => ProjectServiceView) => {
        this.services = this.services.map((v) => (v.projectId === req.projectId && mine.some((m) => m.app === v.app) ? change(v) : v));
        this.pushServices();
      };
      update((v) => {
        const { paused: _paused, powerReason: _reason, ...rest } = v;
        return { ...rest, ...(on ? {} : { paused: true }), power: on ? "starting" : "stopping" };
      });
      later(on ? 1500 : 900, () =>
        update((v) => {
          const { power: _power, detail: _detail, reason: _why, ...rest } = v;
          return on ? { ...rest, rollout: "live", status: "online" } : { ...rest, status: "offline" };
        }),
      );
    });
  }

  /** 推一次项目的服务（整份） */
  private pushServices(): void {
    this.deliver?.({ kind: "frame", frame: { channel: CHANNELS.projects, seq: this.seqs[CHANNELS.projects] ?? 0, type: EVENT_TYPES.projectServices, payload: { services: this.services } } });
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

  /**
   * 转入使用（259 号票）：已经有"首版做完了"卡、"转入使用"卡在等的就用那一张；没有就出一张"转入使用"卡（你在项目页点的），
   * 清单照假的项目规范编（fakeGoLiveChecklist）
   */
  private askGoLive(project: Project): void {
    const waiting = [...this.cards.values()].some((c) => (c.type === "build_done" || c.type === "go_live") && c.status === "pending" && (c.payload as { projectId?: string }).projectId === project.id);
    if (waiting) return;
    this.itemNo += 1;
    const payload: GoLiveCardPayload = { projectId: project.id, projectName: project.name, by: "user", checklist: fakeGoLiveChecklist(project), checkedAt: nowIso() };
    const card: Card = { id: `c-proto-golive-${this.itemNo}`, type: "go_live", typeVersion: CARD_TYPE_VERSIONS.go_live, version: 1, status: "pending", payload, text: goLiveTitle(payload), createdAt: nowIso() };
    this.cards.set(card.id, card);
    this.emit(CHANNELS.cards, EVENT_TYPES.card, { card } satisfies CardEventPayload);
  }

  /** "转入使用"卡上的确认、先不转（259 号票）：确认了项目进入使用中（带着运营方案的照"首版做完了"卡记结局），先不转的不动 */
  private goLiveEffect(payload: GoLiveCardPayload, action: CardAction): unknown {
    const project = this.projects.get(payload.projectId);
    if (!project) return undefined;
    if (action === "dismiss") return { ...payload, decided: { choice: "dismiss" } };
    if (action !== "put_in_use") return undefined;
    const ops = payload.operations;
    const results = ops?.items.map((i) => ({ key: i.key, name: i.name, outcome: i.automatic ? ("created" as const) : ("manual" as const) }));
    const operations = ops && { revision: ops.revision, confirmedAt: nowIso(), items: ops.items.map(({ workflow: _w, ...i }) => ({ ...i, ...(i.automatic ? { taskId: `t-ops-${i.key}` } : {}) })) };
    this.updateProject(project, { state: "in_use", ...(operations ? { operations } : {}) }, "in_use");
    const missing = payload.checklist.filter((i) => !i.done);
    return { ...payload, decided: { choice: "put_in_use", ...(results ? { operations: results } : {}), ...(missing.length > 0 ? { missing } : {}) } };
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
  private createProject(name: string, goal: string, from: Pick<Project, "origin"> & Partial<Pick<Project, "maintainerId" | "fromTaskId" | "runtime" | "workdir">>): Project {
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

  /**
   * 建议立项卡点了"立项"、立项书卡上的确认、"首版做完了"卡上的选择（112 号票）：项目跟着变，返回卡片的新负载
   * （不相干的卡返回 undefined）
   */
  private projectCardEffect(card: Card, action: CardAction, note?: string): unknown {
    if (card.type === "build_done") return this.buildDoneEffect(card.payload as BuildDoneCardPayload, action, note);
    if (card.type === "go_live") return this.goLiveEffect(card.payload as GoLiveCardPayload, action);
    if (card.type === "standard_backfill") return this.standardBackfillEffect(card.payload as StandardBackfillCardPayload, action);
    if (card.type === "operations_change") return this.operationsChangeEffect(card.payload as OperationsChangeCardPayload, action);
    if (card.type === "suggest_project" && action === "kickoff") {
      const payload = card.payload as SuggestProjectCardPayload;
      const workdir = fakeWorkdir(payload.runtime, payload.folder, payload.name);
      const project = this.createProject(payload.name, payload.goal, {
        origin: "suggestion",
        ...(payload.runtime === undefined ? {} : { runtime: payload.runtime }),
        ...(workdir === undefined ? {} : { workdir: { external: true, path: workdir } }),
      });
      return { ...payload, projectId: project.id };
    }
    if (card.type !== "charter" || (action !== "confirm_start" && action !== "confirm_later")) return undefined;
    const payload = card.payload as CharterCardPayload;
    const project = this.projects.get(payload.projectId);
    if (!project) return undefined;
    const { charter, toolkit } = payload;
    // 不管点哪个，项目类型、工作目录和工具包在确认时就生效（305 号票：新建时选了文件夹的不改）
    const confirmed: Partial<Project> = {
      kind: charter.kind,
      workdir: project.workdir.external ? project.workdir : charter.bindExternal ? { external: true, path: charter.externalPath } : { external: false },
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

  /** "首版做完了"卡上的选择（112 号票）：转入使用、继续建设（建出下一轮建设任务）、放弃并归档 */
  private buildDoneEffect(payload: BuildDoneCardPayload, action: CardAction, note: string | undefined): unknown {
    const project = this.projects.get(payload.projectId);
    if (!project) return undefined;
    if (action === "put_in_use") {
      // 130 号票：带着运营方案的，每一条一起生效（原型不真建任务：开得起来的记"已开起来"，要你手动的记"要你手动"）
      const ops = payload.operations;
      const results = ops?.items.map((i) => ({ key: i.key, name: i.name, outcome: i.automatic ? ("created" as const) : ("manual" as const) }));
      const operations = ops && { revision: ops.revision, confirmedAt: nowIso(), items: ops.items.map(({ workflow: _w, ...i }) => ({ ...i, ...(i.automatic ? { taskId: `t-ops-${i.key}` } : {}) })) };
      this.updateProject(project, { state: "in_use", ...(operations ? { operations } : {}) }, "in_use");
      return { ...payload, decided: { choice: "put_in_use", ...(results ? { operations: results } : {}) } };
    }
    if (action === "abandon") {
      this.updateProject(project, { state: "archived", archivedFrom: project.state }, "abandoned");
      return { ...payload, decided: { choice: "abandon" } };
    }
    if (action !== "keep_building") return undefined;
    const request = note?.trim() || "（原型）接着建设";
    const task = this.createTask({ title: `建设「${project.name}」第 ${payload.round + 1} 轮`, why: request }, "project_build", [project.name]);
    this.updateProject(project, { buildTaskId: task.id }, "build_continued");
    return { ...payload, decided: { choice: "keep_building", request, nextTaskId: task.id } };
  }

  /** "补齐规范文档"卡（262 号票）：补齐记一个假的任务编号（原型不真建任务、不真补档案），不补什么都不动 */
  private standardBackfillEffect(payload: StandardBackfillCardPayload, action: CardAction): unknown {
    const at = nowIso();
    if (action === "dismiss") return { ...payload, decided: { choice: "skip", at } };
    if (action !== "confirm") return undefined;
    return { ...payload, decided: { choice: "backfill", at, taskId: `t-proto-backfill-${payload.projectId}` } };
  }

  /** "运营方案变更"卡（130 号票）：确认的照差异记下结局、项目上的运营方案换成新的一份（原型不真建、不真取消任务）；拒绝的什么都不动 */
  private operationsChangeEffect(payload: OperationsChangeCardPayload, action: CardAction): unknown {
    const project = this.projects.get(payload.projectId);
    if (!project) return undefined;
    const at = nowIso();
    if (action === "reject") return { ...payload, decided: { confirmed: false, at } };
    if (action !== "confirm") return undefined;
    const results = [
      ...payload.added.map((i) => ({ key: i.key, name: i.name, outcome: i.automatic ? ("created" as const) : ("manual" as const) })),
      ...payload.changed.map((c) => ({ key: c.after.key, name: c.after.name, outcome: c.inPlace ? ("rescheduled" as const) : ("recreated" as const) })),
      ...payload.restored.map((i) => ({ key: i.key, name: i.name, outcome: "created" as const })),
      ...payload.removed.map((i) => ({ key: i.key, name: i.name, outcome: "cancelled" as const })),
    ];
    const before = project.operations?.items ?? [];
    const next = [...payload.changed.map((c) => c.after), ...payload.added, ...payload.restored].map(({ workflow: _w, ...i }) => ({
      ...i,
      ...(i.automatic ? { taskId: before.find((b) => b.key === i.key)?.taskId ?? `t-ops-${i.key}` } : {}),
    }));
    const kept = before.filter((b) => payload.kept.some((k) => k.key === b.key));
    this.updateProject(project, { operations: { revision: payload.revision, confirmedAt: at, items: [...kept, ...next] } }, "operations_changed");
    return { ...payload, decided: { confirmed: true, at, results } };
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
      if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "archive" && action !== "delete") {
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

  /**
   * 对一个假任务做暂停、继续、取消、归档、删除：定时触发的运营中时落到它的触发上；别的照"谁能改"表改状态。
   * 186 号票：没结束的归档先取消再归档（运营中的连同触发一起取消）；删除先照取消停下，再推一条带 deleted 的任务事件（看板上拿掉）
   */
  private actOnTask(taskId: string, action: TaskBatchAction): TaskBatchItemResult {
    const task = this.tasks.get(taskId);
    if (!task) return { taskId, ok: false, code: "not_found", message: `没有任务 ${taskId}` };
    const job = this.triggers.get(taskId);
    if (action === "delete" || (action === "archive" && archiveCancelsFirst(task))) {
      if (!ENDED_TASK_STATES.includes(task.state)) {
        const cancelled = this.actOnTask(taskId, "cancel");
        if (!cancelled.ok) return cancelled;
      }
      const now = this.tasks.get(taskId)!;
      if (action === "archive") return this.actOnTask(taskId, "archive");
      const gone: Task = { ...now, deleted: true, updatedAt: nowIso() };
      this.tasks.delete(taskId);
      this.emit(CHANNELS.board, EVENT_TYPES.task, { task: gone, change: "deleted", from: now.state, by: "user" } satisfies TaskEventPayload);
      return { taskId, ok: true, state: now.state };
    }
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

  /**
   * 对假提醒取消、归档、删除（185 号票）：照守护进程的规则一条条演——取消只对待触发的，归档只对已经结束、没归档的，删除对没删过的；
   * 逐条回报，提醒的新样子推到看板频道
   */
  reminderAction(req: ReminderActionRequest): Promise<ReminderActionResult> {
    const act = (reminderId: string): ReminderActionItemResult => {
      const r = this.reminders.get(reminderId) ?? this.reminderOfFakeCard(reminderId);
      const refuse = (message: string): ReminderActionItemResult => ({ reminderId, ok: false, code: "not_allowed", message });
      if (!r) return { reminderId, ok: false, code: "not_found", message: `没有编号为 ${reminderId} 的提醒` };
      if (r.status === "deleted") return refuse(`提醒 ${r.id}「${r.text}」已经删了`);
      const { nextAt: _next, ...rest } = r;
      let next: Reminder;
      if (req.action === "cancel") {
        if (r.status !== "pending") return refuse(`提醒 ${r.id}「${r.text}」${r.status === "fired" ? "已经响过了" : "已经取消了"}`);
        next = { ...rest, status: "cancelled", updatedAt: nowIso() };
      } else if (req.action === "archive") {
        if (r.status === "pending") return refuse(`提醒 ${r.id}「${r.text}」还没结束（待触发）：先取消再归档`);
        if (r.archived) return refuse(`提醒 ${r.id}「${r.text}」已经归档了`);
        next = { ...r, archived: true, updatedAt: nowIso() };
      } else {
        next = { ...rest, status: "deleted", updatedAt: nowIso() };
      }
      this.reminders.set(reminderId, next);
      const change = req.action === "cancel" ? "cancelled" : req.action === "archive" ? "archived" : "deleted";
      this.emit(CHANNELS.board, EVENT_TYPES.reminder, { reminder: next, change, by: "user" } satisfies ReminderEventPayload);
      this.updateFakeReminderCard(next, req.action);
      return { reminderId, ok: true, status: next.status, ...(next.archived ? { archived: true } : {}) };
    };
    return new Promise((resolve) => later(300, () => resolve({ results: req.reminderIds.map(act) })));
  }

  /** 聊天里假的提醒卡（fake-conversations.ts 的 c-rem-1）背后的提醒：按卡上的样子拼一条，归档、删除在卡上演 */
  private reminderOfFakeCard(reminderId: string): Reminder | undefined {
    const card = [...this.cards.values()].find((c) => c.type === "reminder" && (c.payload as ReminderCardPayload).reminderId === reminderId);
    if (!card) return undefined;
    const p = card.payload as ReminderCardPayload;
    return { id: reminderId, text: p.text, ...(p.schedule ? { schedule: p.schedule } : {}), status: p.status, ...(p.nextAt ? { nextAt: p.nextAt } : {}), ...(p.archived ? { archived: true } : {}), cardId: card.id, createdAt: card.createdAt, updatedAt: nowIso() };
  }

  /** 提醒变了，聊天里假的提醒卡跟着变（185 号票：取消了已处理，删了作废、写已删除） */
  private updateFakeReminderCard(r: Reminder, action: "cancel" | "archive" | "delete"): void {
    const card = this.cards.get(r.cardId);
    if (!card || card.type !== "reminder") return;
    const payload: ReminderCardPayload = { ...(card.payload as ReminderCardPayload), status: r.status, ...(r.archived ? { archived: true } : {}) };
    const status = action === "delete" ? "expired" : action === "cancel" ? "handled" : card.status;
    const next: Card = {
      ...card,
      payload,
      version: card.version + 1,
      status,
      ...(status !== card.status ? { handledAt: nowIso() } : {}),
      ...(action === "cancel" ? { outcome: { action: "cancel_reminder" } } : {}),
      ...(action === "delete" ? { expiredNote: "提醒已经删了" } : {}),
    };
    this.cards.set(next.id, next);
    this.emit(CHANNELS.cards, EVENT_TYPES.card, { card: next } satisfies CardEventPayload);
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
      this.reminders.set(reminder.id, reminder);
      this.emit(CHANNELS.board, EVENT_TYPES.reminder, { reminder, change: "created", by: "user" } satisfies ReminderEventPayload);
      this.fireLater(reminder);
    });
  }

  /**
   * 设备多选（123 号票）：照守护进程的做法——能做的都做（协议包的 deviceBatchSkip），延期从原到期日和现在里晚的那个起算，
   * 删除时还没吊销的先吊销。原型里"就是这台"被吊销、删除时，过一会儿报连接 unpaired（被吊销），走"本设备已被吊销"那一页
   */
  deviceBatchAction(req: DeviceBatchActionRequest): Promise<DeviceBatchActionResult> {
    return new Promise((resolve) =>
      later(300, () => {
        const now = Date.now();
        const at = nowIso();
        const results: DeviceBatchItemResult[] = [];
        const put = (device: PairedDevice, change: DeviceEventPayload["change"]) => {
          this.devices.set(device.id, device);
          this.emit(CHANNELS.devices, EVENT_TYPES.device, { device, change } satisfies DeviceEventPayload);
        };
        let selfGone = false;
        for (const deviceId of req.deviceIds) {
          const device = this.devices.get(deviceId);
          const skip = deviceBatchSkip(device, req.action);
          if (skip !== undefined || !device) {
            const why = skip ?? "not_found";
            results.push({ deviceId, ok: false, skip: why, message: `这台设备${deviceSkipPhrase(req.action, why)}` });
            continue;
          }
          let next: PairedDevice;
          if (req.action === "extend") {
            next = { ...device, expiresAt: nowIso(new Date(extendedExpiry(device.expiresAt, now, req.days ?? DEFAULT_DEVICE_EXTEND_DAYS))), extendedAt: at };
            put(next, "extended");
          } else {
            next = device.revoked ? device : { ...device, revoked: true, revokedAt: at };
            if (!device.revoked) put(next, "revoked");
            if (req.action === "delete") {
              next = { ...next, deletedAt: at };
              put(next, "deleted");
            }
            if (deviceId === FAKE_SELF_DEVICE_ID) selfGone = true;
          }
          results.push({ deviceId, ok: true, device: next });
        }
        resolve({ results });
        if (selfGone) later(800, () => this.deliver?.({ kind: "connection", status: "unpaired", reason: "revoked" }));
      }),
    );
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

  /**
   * 演示页面顶上的通知（105、106 号票）：地址里带 ?demo-alerts=N 时，连上后陆续来 N 条到点的通知（临时的 notify 事件，
   * 对应前几条没读的事项），看框里轮播、"2/3"、自动收起；?demo-alerts=long 来一条标题、正文都很长的，看框的大小固定、
   * 放不下省略。平常不来
   */
  private demoAlerts(deliver: (input: UiInput) => void): void {
    const param = demoParam("demo-alerts");
    const notify = (payload: NotifyEventPayload) => deliver({ kind: "frame", frame: { channel: CHANNELS.inbox, seq: this.seqs[CHANNELS.inbox] ?? 0, type: EVENT_TYPES.notify, payload } });
    if (param === "long") {
      later(800, () => notify(DEMO_LONG_ALERT));
      return;
    }
    const n = Number(param ?? 0);
    if (!(n > 0)) return;
    FAKE_INBOX.filter((item) => !item.read && !item.archived)
      .slice(0, n)
      .forEach((item, i) =>
        later(800 + i * 300, () => notify({ id: `n-demo-${item.id}`, title: item.title, ...(item.kind === "notice" && item.body ? { body: item.body } : {}), itemId: item.id })),
      );
  }

  /**
   * 演示秘书说完一轮（109 号票）：地址里带 ?demo-unread 时，连上后一会儿秘书收到一件做完的事、在主线里说一声（实时推来的回合），
   * 不在看秘书会话时顶上提醒一条
   */
  private demoSecretaryTurn(): void {
    if (demoParam("demo-unread") === null) return;
    later(2500, () => {
      const S = CHANNELS.secretary;
      const notice: MessageEnvelope = { id: `m-demo-notice-${Date.now()}`, conversation: S, speaker: "system", time: nowIso(), parts: [{ type: "text", text: "【任务做完】后台有一件事做完了（运行时发来的，不是用户说的）：普通任务「写这周的周报草稿」在后台做完了。" }] };
      this.emit(S, EVENT_TYPES.message, { message: notice, agentInput: true } satisfies MessageEventPayload);
      this.emit(S, EVENT_TYPES.turnStart, { inputMessageId: notice.id });
      const reply: MessageEnvelope = { id: `m-demo-reply-${Date.now()}`, conversation: S, speaker: "agent", time: nowIso(), parts: [{ type: "text", text: "周报草稿写好了：这周做完三件事，下周要跟进报销。要我念给你听吗？" }] };
      this.emit(S, EVENT_TYPES.message, { message: reply } satisfies MessageEventPayload);
      this.emit(S, EVENT_TYPES.turnEnd, { inputMessageId: notice.id, outcome: "completed" });
    });
  }

  /**
   * 演示服务端的页面更新了（116 号票）：地址里带 ?demo-update 时，连上后一会儿活动状态频道上推来一条 web_version（假的新一版），
   * 和页面自己的对不上，出"二狗有新版本 · 刷新"；切到后台再回来、什么都没打开时直接刷新（原型刷新后又从头演一遍）。平常不推
   */
  private demoUpdate(deliver: (input: UiInput) => void): void {
    const version = fakeServerWebVersion();
    if (version === undefined) return;
    const payload: WebVersionEventPayload = { version };
    later(1200, () => deliver({ kind: "frame", frame: { channel: CHANNELS.activity, seq: this.seqs[CHANNELS.activity] ?? 0, type: EVENT_TYPES.webVersion, payload } }));
  }

  private emit(channel: string, type: string, payload: unknown): void {
    const frame = this.append(channel, type, payload);
    this.deliver?.({ kind: "frame", frame });
  }
}

/** 原型里假的守护进程起来多久了（124 号票：关于页的"已运行"） */
const FAKE_DAEMON_UPTIME_MS = 3 * 3_600_000 + 12 * 60_000;

/** ?demo-alerts=long 的那一条（对应待办里"卡住求助：smartctl 读不到 sdb"） */
const DEMO_LONG_ALERT: NotifyEventPayload = {
  id: "n-demo-long",
  title: "卡住求助：任务「NAS 硬盘健康巡检」第 2 阶段拉回 3 次仍没进展，smartctl 对 /dev/sdb 一直返回权限错误",
  body: "维护者试过换用 sudo、重新挂载、换一根数据线后再读，都是同样的权限错误；任务已转为等我，需要你决定是跳过 sdb、自己去看看，还是取消这个任务。",
  itemId: "i-nas",
};

/**
 * 地址里逗号分开的插件名（193 号票的 ?demo-plugins-off=memory,reminders：那几个算在配置里停用了；211 号票的 ?demo-plugins-removed=：
 * 算移除了）——看停用、移除插件后的样子（截图、page-opens 测试）
 */
function demoList(name: string): Set<string> {
  return new Set((demoParam(name) ?? "").split(",").map((x) => x.trim()));
}

/** ?demo-update（116 号票）时假的服务端现在是哪一版；平常不知道 */
export function fakeServerWebVersion(): string | undefined {
  return demoParam("demo-update") === null ? undefined : "demo-update";
}

/** 地址里的演示参数（?demo-alerts、?demo-unread、?demo-update、?demo-debug）；没有是 null */
export function demoParam(name: string): string | null {
  return typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name);
}

/** ?demo-unread 的"你不在时"：定时任务跑完，秘书收到【任务做完】【跑完自动播报】，念了一段 1 分 06 秒的语音、附一行字（收进气泡） */
function awayDemo(): { channel: string; type: string; payload: unknown }[] {
  const S = CHANNELS.secretary;
  const time = nowIso();
  const notice: MessageEnvelope = {
    id: "m-demo-away-notice",
    conversation: S,
    speaker: "system",
    time,
    parts: [{ type: "text", text: "【任务做完】【跑完自动播报】后台有一件事做完了（运行时发来的，不是用户说的）：定时触发的普通任务「每天早上出 AI 新闻日报」的第 3 次运行做完了。" }],
  };
  const waveform = [14, 38, 62, 50, 28, 20, 46, 70, 86, 66, 40, 22, 50, 74, 58, 36, 24, 48, 70, 82, 60, 34, 18, 42, 64, 76, 52, 30, 20, 38, 56, 26];
  const bubble: MessageEnvelope = { id: "m-demo-away-voice", conversation: S, speaker: "agent", time, parts: [{ type: "tts_audio", voiceId: "av-demo-away", mediaId: "sha256:demo-away", mime: "audio/wav", durationMs: 66_000, waveform }] };
  const covered: MessageEnvelope = { id: "m-demo-away-text", conversation: S, speaker: "agent", time, parts: [{ type: "text", text: "今天的 AI 日报出好了，要点念给你听了，细节在任务里。" }] };
  const voice: AgentVoiceRecord = {
    id: "av-demo-away",
    conversation: S,
    scope: {},
    inputMessageId: notice.id,
    replyMessageIds: [covered.id],
    mode: "tool",
    coversReply: true,
    text: "今天的 AI 日报有三条要点：第一，一个开源的大模型发布了新版本；第二，几家厂商在比拼端侧推理；第三，芯片价格又涨了。细节在任务里。",
    referenceVoice: { id: "v-sample", name: "示例音色" },
    status: "done",
    mediaId: "sha256:demo-away",
    mime: "audio/wav",
    durationMs: 66_000,
    waveform,
    messageId: bubble.id,
    createdAt: time,
    updatedAt: time,
    version: 4,
  };
  return [
    { channel: S, type: EVENT_TYPES.message, payload: { message: notice, agentInput: true } satisfies MessageEventPayload },
    { channel: S, type: EVENT_TYPES.turnStart, payload: { inputMessageId: notice.id } },
    { channel: S, type: EVENT_TYPES.agentVoice, payload: { voice } satisfies AgentVoiceEventPayload },
    { channel: S, type: EVENT_TYPES.message, payload: { message: bubble } satisfies MessageEventPayload },
    { channel: S, type: EVENT_TYPES.message, payload: { message: covered } satisfies MessageEventPayload },
    { channel: S, type: EVENT_TYPES.turnEnd, payload: { inputMessageId: notice.id, outcome: "completed" } },
  ];
}

function later(ms: number, f: () => void): void {
  setTimeout(f, ms);
}

/** 原型里正在回复的一轮（144 号票）：交给它的几条输入、回复的消息 id、整段话、说到哪了 */
interface FakeTurn {
  readonly inputs: readonly string[];
  readonly replyId: string;
  readonly text: string;
  said: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** 原型的回复（144 号票起一段一段流出来，说得够久，能在它说着的时候停止、排队） */
const FAKE_REPLY =
  "（原型）收到。我先把你说的拆成几步：第一步看看现在的情况，第二步列出要改的地方，第三步一项一项改完再告诉你。" +
  "这里是假数据，接上守护进程后是真实的回复；说着的时候可以点输入框旁的“停止”，也可以接着发话——发的话先排队，这一轮说完再交给我。";
