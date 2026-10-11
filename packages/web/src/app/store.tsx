// 把前端状态层接到 React：连接推来的输入交给 reduce，界面从这里读状态、发请求。
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import {
  type CardAction,
  type CardState,
  type ConversationId,
  type InboxAction,
  INBOX_ACTION_MAX,
  inChunks,
  initialUiState,
  type MessagePart,
  olderHistory,
  type PlanToolkit,
  type ProjectAction,
  reduce,
  type ScheduledJobAction,
  resumeCursors,
  selectCard,
  type TaskAction,
  type TaskBatchAction,
  type TaskBatchActionResult,
  type TaskKind,
  type TaskTrigger,
  type EventTrigger,
  type ReminderSchedule,
  type ToolkitTarget,
  type UiState,
  type UpdateWatchCategoriesParams,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import type { Connection } from "./connection.ts";
import type { DaemonHttp } from "./daemon-http.ts";

interface Store {
  ui: UiState;
  /** 发消息；taskId 是在哪个任务的详情里说的（75 号票：项目内部的普通任务做完了接着说） */
  sendMessage(conversation: ConversationId, parts: MessagePart[], taskId?: string): void;
  /** 点卡片上的按钮；note 是动作附带的说明，input 是结构化输入（比如改提醒的新时间） */
  cardAction(cardId: string, action: CardAction, note?: string, input?: unknown): void;
  /** 对待我处理事项做动作；被拒时原因出现在 ui.failures 里 */
  inboxAction(itemIds: string[], action: InboxAction, choice?: string): void;
  /** 吊销一台已配对设备；被拒时原因出现在 ui.failures 里 */
  revokeDevice(deviceId: string): void;
  /**
   * 点"发起任务"按钮：先选种类（流程、长程任务，58 号票），写要做什么、选涉及的项目、什么时候做（76 号票：定时的带时间表）；
   * 任务建出后出现在看板上，被拒时原因出现在 ui.failures 里
   */
  startTask(request: string, projects: string[], kind: TaskKind, trigger?: TaskTrigger): void;
  /** 发起对话框里的"只提醒我"（76 号票）：建一条简单提醒；被拒时原因出现在 ui.failures 里 */
  /** 只提醒我（76 号票）：到点提醒给时间表；事件发生时提醒（77 号票）给 { event } */
  createReminder(text: string, when: ReminderSchedule | { event: EventTrigger }): void;
  /** 设置页改关注类别（26 号票）；设置随后在关注类别频道推来，被拒时原因出现在 ui.failures 里 */
  updateWatchCategories(params: UpdateWatchCategoriesParams): void;
  /** 点"新建项目"：写想立个什么项目，秘书直接出一张建议立项卡（15 号票） */
  newProject(request: string): void;
  /** 把一个任务转为项目（项目名由用户定）：项目出现在项目列表，原任务以"已完成 · 已转为项目"结束；重名时原因出现在 ui.failures 里 */
  convertTaskToProject(taskId: string, name: string): void;
  /** 项目页上的动作（删除在待我处理里二次确认）；被拒时原因出现在 ui.failures 里 */
  projectAction(projectId: string, action: ProjectAction): void;
  /** 项目页上的"重置维护者"（16 号票） */
  resetMaintainer(projectId: string): void;
  /** 多订阅几个频道（打开一个项目的维护者会话时） */
  watchChannels(channels: readonly string[]): void;
  /** 控制任务（13 号票）：暂停、继续、取消、重试、返工、由我验收的验收通过或退回；被拒时原因出现在 ui.failures 里 */
  taskAction(taskId: string, action: TaskAction, options?: { stageId?: string; note?: string }): void;
  /** 看板多选（90 号票）：一次对多个任务做暂停、继续、取消、归档，等到逐条的结果；整个被拒时原因出现在 ui.failures 里，这里也拒绝 */
  taskBatchAction(taskIds: string[], action: TaskBatchAction): Promise<TaskBatchActionResult>;
  /** 气泡菜单里的"重新识别"（31 号票）：识别失败的语音重新识别；被拒时原因出现在 ui.failures 里 */
  retryVoice(voiceId: string): void;
  /** 工具包区里改工具包（27 号票） */
  setToolkit(target: ToolkitTarget, toolkit: PlanToolkit): void;
  /** 看板、项目页上暂停、恢复、取消定时作业（19 号票）；被拒时原因出现在 ui.failures 里 */
  scheduledJobAction(jobId: string, action: ScheduledJobAction): void;
  /** 界面已经提示过这条通知 */
  seeAlert(id: string): void;
  /** 界面已经提示过这个被拒的请求 */
  seeFailure(idempotencyKey: string): void;
  /** 对这条新到的 agent 语音决定过了（自动播了，或者不播；36 号票） */
  seeAgentVoiceArrival(voiceId: string): void;
  /** 往上翻：取这个会话更早的一页历史（没有更早的了就什么也不做） */
  /** 往上翻取回更早的一页（limit 不填是一页 50 条；任务详情取齐历史时一次 200 条） */
  loadOlder(conversation: ConversationId, limit?: number): Promise<void>;
  /** 日历（35 号票）：取某个月（YYYY-MM）每一天的日历条目，并进状态层；取失败时抛错 */
  loadCalendarMonth(month: string): Promise<void>;
  /** 设置 · 语音（45 号票）：取两个语音模型现在的状态，并进状态层（之后的变化经活动状态频道推来）；取失败时抛错 */
  loadVoiceModels(): Promise<void>;
  /** 把聊天里的一张卡片引用到输入框（发消息时带上）；去掉一张引用 */
  quoteCard(conversation: ConversationId, cardId: string): void;
  unquoteCard(conversation: ConversationId, cardId: string): void;
  /** HTTP 那一半：上传附件、媒体的地址 */
  http: DaemonHttp;
}

const StoreContext = createContext<Store | null>(null);

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function StoreProvider({ connection, http, children }: { connection: Connection; http: DaemonHttp; children: ReactNode }) {
  const [ui, dispatch] = useReducer(reduce, initialUiState);
  // 事件处理函数里要读最新的状态（比如卡片的当前版本）
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  }, [ui]);

  // 连上就收事件；断开重连时带上每个频道最后收到的序号，重复补发的事件由状态层丢掉
  useEffect(() => connection.connect(resumeCursors(uiRef.current), dispatch), [connection]);

  const sendMessage = useCallback(
    (conversation: ConversationId, parts: MessagePart[], taskId?: string) => {
      const idempotencyKey = newKey();
      dispatch({ kind: "send_message", conversation, idempotencyKey, parts, time: nowIso() });
      connection.sendMessage({ conversation, idempotencyKey, parts, ...(taskId === undefined ? {} : { taskId }) });
    },
    [connection],
  );

  const cardAction = useCallback(
    (cardId: string, action: CardAction, note?: string, input?: unknown) => {
      const view = selectCard(uiRef.current, cardId);
      if (!view) return;
      const idempotencyKey = newKey();
      dispatch({ kind: "card_action", cardId, action, idempotencyKey });
      connection.cardAction({ cardId, action, expectedVersion: view.card.version, idempotencyKey, note, ...(input === undefined ? {} : { input }) });
    },
    [connection],
  );

  const inboxAction = useCallback(
    (itemIds: string[], action: InboxAction, choice?: string) => {
      // 一次最多 INBOX_ACTION_MAX 条：多选全选、全部标已读多于这些时分批交（90 号票评审），每批各自生效
      for (const batch of inChunks(itemIds, INBOX_ACTION_MAX)) {
        connection.inboxAction({ itemIds: batch, action, idempotencyKey: newKey(), ...(choice === undefined ? {} : { choice }) });
      }
    },
    [connection],
  );

  const revokeDevice = useCallback((deviceId: string) => connection.revokeDevice({ deviceId, idempotencyKey: newKey() }), [connection]);
  const startTask = useCallback(
    (request: string, projects: string[], kind: TaskKind, trigger?: TaskTrigger) => connection.startTask({ request, projects, kind, ...(trigger ? { trigger } : {}), idempotencyKey: newKey() }),
    [connection],
  );
  const createReminder = useCallback(
    (text: string, when: ReminderSchedule | { event: EventTrigger }) =>
      connection.createReminder({ text, ...("event" in when ? { event: when.event } : { schedule: when }), idempotencyKey: newKey() }),
    [connection],
  );
  const updateWatchCategories = useCallback((params: UpdateWatchCategoriesParams) => connection.updateWatchCategories({ params, idempotencyKey: newKey() }), [connection]);
  const newProject = useCallback((request: string) => connection.newProject({ request, idempotencyKey: newKey() }), [connection]);
  const convertTaskToProject = useCallback((taskId: string, name: string) => connection.convertTaskToProject({ taskId, name, idempotencyKey: newKey() }), [connection]);
  const projectAction = useCallback((projectId: string, action: ProjectAction) => connection.projectAction({ projectId, action, idempotencyKey: newKey() }), [connection]);
  const resetMaintainer = useCallback((projectId: string) => connection.resetMaintainer({ projectId, idempotencyKey: newKey() }), [connection]);
  const watchChannels = useCallback((channels: readonly string[]) => connection.watchChannels(channels), [connection]);
  const taskAction = useCallback(
    (taskId: string, action: TaskAction, options: { stageId?: string; note?: string } = {}) =>
      connection.taskAction({
        taskId,
        action,
        idempotencyKey: newKey(),
        ...(options.stageId === undefined ? {} : { stageId: options.stageId }),
        ...(options.note?.trim() ? { note: options.note.trim() } : {}),
      }),
    [connection],
  );

  const taskBatchAction = useCallback((taskIds: string[], action: TaskBatchAction) => connection.taskBatchAction({ taskIds, action, idempotencyKey: newKey() }), [connection]);
  const retryVoice = useCallback((voiceId: string) => connection.retryVoice({ voiceId, idempotencyKey: newKey() }), [connection]);
  const setToolkit = useCallback((target: ToolkitTarget, toolkit: PlanToolkit) => connection.setToolkit({ target, toolkit, idempotencyKey: newKey() }), [connection]);
  const scheduledJobAction = useCallback((jobId: string, action: ScheduledJobAction) => connection.scheduledJobAction({ jobId, action, idempotencyKey: newKey() }), [connection]);
  const seeAlert = useCallback((id: string) => dispatch({ kind: "alert_seen", id }), []);
  const quoteCard = useCallback((conversation: ConversationId, cardId: string) => dispatch({ kind: "quote_card", conversation, cardId }), []);
  const unquoteCard = useCallback((conversation: ConversationId, cardId: string) => dispatch({ kind: "unquote_card", conversation, cardId }), []);
  const seeFailure = useCallback((idempotencyKey: string) => dispatch({ kind: "failure_seen", idempotencyKey }), []);
  const seeAgentVoiceArrival = useCallback((voiceId: string) => dispatch({ kind: "agent_voice_arrival_seen", voiceId }), []);

  const loadOlder = useCallback(
    async (conversation: ConversationId, limit?: number) => {
      const { canLoadOlder, before } = olderHistory(uiRef.current, conversation);
      if (!canLoadOlder) return;
      const page = await http.history(conversation, before, limit);
      dispatch({ kind: "history_page", conversation, page });
    },
    [http],
  );

  const loadCalendarMonth = useCallback(
    async (month: string) => {
      const view = await http.calendarMonth(month);
      dispatch({ kind: "calendar_month", view });
    },
    [http],
  );

  const loadVoiceModels = useCallback(async () => {
    const view = await http.voiceModels();
    dispatch({ kind: "voice_models", view });
  }, [http]);

  const store = useMemo(
    () => ({
      ui,
      sendMessage,
      cardAction,
      inboxAction,
      revokeDevice,
      startTask,
      createReminder,
      taskAction,
      taskBatchAction,
      updateWatchCategories,
      newProject,
      convertTaskToProject,
      projectAction,
      resetMaintainer,
      watchChannels,
      retryVoice,
      setToolkit,
      scheduledJobAction,
      seeAlert,
      seeFailure,
      seeAgentVoiceArrival,
      loadOlder,
      loadCalendarMonth,
      loadVoiceModels,
      quoteCard,
      unquoteCard,
      http,
    }),
    [ui, sendMessage, cardAction, inboxAction, revokeDevice, startTask, createReminder, taskAction, taskBatchAction, updateWatchCategories, newProject, convertTaskToProject, projectAction, resetMaintainer, watchChannels, retryVoice, setToolkit, scheduledJobAction, seeAlert, seeFailure, seeAgentVoiceArrival, loadOlder, loadCalendarMonth, loadVoiceModels, quoteCard, unquoteCard, http],
  );
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore 必须在 StoreProvider 里用");
  return s;
}

export function useCard(cardId: string): CardState | undefined {
  return selectCard(useStore().ui, cardId);
}
