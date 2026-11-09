// 把前端状态层接到 React：连接推来的输入交给 reduce，界面从这里读状态、发请求。
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { noteRecognizerInput } from "./voice-format.ts";
import {
  type AgentRoleBody,
  type AgentRolesView,
  type AgentRoleUpdateBody,
  type CardAction,
  type CardState,
  type ConversationId,
  type DeviceBatchAction,
  type DeviceBatchActionResult,
  type DaemonInfo,
  type InboxAction,
  INBOX_ACTION_MAX,
  inChunks,
  initialUiState,
  type MessagePart,
  olderHistory,
  type PageAlert,
  type PlanToolkit,
  type ProjectAction,
  type ProjectServicesAction,
  reduce,
  refoldInput,
  type RescheduleJobResult,
  type RollbackSessionResult,
  type RollbackTarget,
  branchGaps,
  type RequestEffectUndoResult,
  type SwitchBranchResult,
  type RunJobNowResult,
  type SetProjectVoiceAnnounceResult,
  type SetVoiceAnnounceResult,
  type ScheduledJobAction,
  resumeCursors,
  selectCard,
  snapshotChanged,
  snapshotOf,
  type TaskAction,
  type TaskActOptions,
  type TaskBatchAction,
  type TaskBatchActionResult,
  type ReminderAction,
  type ReminderActionResult,
  type TaskKind,
  type TaskTrigger,
  type EventTrigger,
  type ReminderSchedule,
  type ToolkitTarget,
  type UiInput,
  type UiState,
  type UpdateWatchCategoriesParams,
  type UserNameResult,
  type BrowsingContext,
  browsingMarkOf,
  type MapContext,
  mapMarkOf,
  type WorkFolderChoice,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import type { ChatCache, ChatCacheStats } from "./chat-cache.ts";
import type { Connection, ConnectionStats } from "./connection.ts";
import type { DaemonHttp } from "./daemon-http.ts";
import { useLocale } from "./locale.ts";
import type { PageSnapshots } from "./open-snapshot.ts";

/** 打开时先用了什么（Debug 工具集）：本机快照、换了一版后本机存的事件（重新折了几条）、什么都没有（从头补） */
export type OpenedFrom = { readonly kind: "snapshot" } | { readonly kind: "events"; readonly events: number } | { readonly kind: "scratch" };

interface Store {
  ui: UiState;
  /**
   * 发消息；taskId 是在哪个任务的详情里说的（项目内部的普通任务做完了接着说），browsing 是浏览侧边栏里发的那条带的网页上下文
   * （悬浮按钮上发的也是它），map 是地图页右边的聊天窗里、右下角的二狗悬浮按钮上发的那条带的地图上下文（444）。
   * 回这次发送请求的幂等键（悬浮按钮据此认出秘书回了什么）
   */
  sendMessage(conversation: ConversationId, parts: MessagePart[], taskId?: string, browsing?: BrowsingContext, map?: MapContext): string;
  /** 点卡片上的按钮；note 是动作附带的说明，input 是结构化输入（比如改提醒的新时间） */
  cardAction(cardId: string, action: CardAction, note?: string, input?: unknown): void;
  /** 对待我处理事项做动作；被拒时原因出现在 ui.failures 里 */
  inboxAction(itemIds: string[], action: InboxAction, choice?: string): void;
  /**
   * 设置 · 已配对设备的延期（days 天）、吊销、删除（多选和单台的"⋯"菜单都走它），等到逐台的结果；
   * 整个被拒时原因出现在 ui.failures 里，这里也拒绝
   */
  deviceBatchAction(deviceIds: string[], action: DeviceBatchAction, days?: number): Promise<DeviceBatchActionResult>;
  /**
   * 点"发起任务"按钮：先选种类（流程、长程任务），写要做什么、选涉及的项目、什么时候做（定时的带时间表）；
   * 任务建出后出现在看板上，被拒时原因出现在 ui.failures 里
   */
  startTask(request: string, projects: string[], kind: TaskKind, trigger?: TaskTrigger, voiceAnnounce?: boolean, runtime?: string, folder?: WorkFolderChoice): void;
  /** 发起对话框里的"只提醒我"：建一条简单提醒；被拒时原因出现在 ui.failures 里 */
  /** 只提醒我：到点提醒给时间表；事件发生时提醒给 { event } */
  createReminder(text: string, when: ReminderSchedule | { event: EventTrigger }): void;
  /** 设置页改关注类别；设置随后在关注类别频道推来，被拒时原因出现在 ui.failures 里 */
  updateWatchCategories(params: UpdateWatchCategoriesParams): void;
  /** 点"新建项目"：写想立个什么项目，秘书直接出一张建议立项卡 */
  newProject(request: string, runtime?: string, folder?: WorkFolderChoice): void;
  /** 把一个任务转为项目（项目名由用户定）：项目出现在项目列表，原任务以"已完成 · 已转为项目"结束；重名时原因出现在 ui.failures 里 */
  convertTaskToProject(taskId: string, name: string): void;
  /** 项目页上的动作（删除在待我处理里二次确认）；被拒时原因出现在 ui.failures 里 */
  projectAction(projectId: string, action: ProjectAction): void;
  /** 项目卡片、项目页上的"启动""关闭"：做到哪了随后经 project_services 推来；被拒时原因出现在 ui.failures 里 */
  projectServicesAction(projectId: string, action: ProjectServicesAction): void;
  /** 项目页上的"重置负责人" */
  resetMaintainer(projectId: string): void;
  /** 多订阅几个频道（打开一个项目的负责人会话时） */
  watchChannels(channels: readonly string[]): void;
  /** 控制任务：暂停、继续、取消、重试、返工、由我验收的验收通过或退回；被拒时原因出现在 ui.failures 里 */
  /** stageEdit：从这里重做时直接改的这一阶段 */
  taskAction(taskId: string, action: TaskAction, options?: TaskActOptions): void;
  /** 看板多选：一次对多个任务做暂停、继续、取消、归档，等到逐条的结果；整个被拒时原因出现在 ui.failures 里，这里也拒绝 */
  taskBatchAction(taskIds: string[], action: TaskBatchAction): Promise<TaskBatchActionResult>;
  /** 对简单提醒取消、归档、删除：看板菜单、提醒卡上的按钮、看板多选；等到逐条的结果，整个被拒时原因出现在 ui.failures 里，这里也拒绝 */
  reminderAction(reminderIds: string[], action: ReminderAction): Promise<ReminderActionResult>;
  /** 气泡菜单里的"重新识别"：识别失败的语音重新识别；被拒时原因出现在 ui.failures 里 */
  retryVoice(voiceId: string): void;
  /** 输入框旁的"停止"：停下这个会话的 agent 正在回复的这一轮 */
  stopReply(conversation: ConversationId): void;
  /** 会话回退：回到某条之前，等守护进程做完；被拒时原因出现在 ui.failures 里，这里也拒绝 */
  rollbackSession(conversation: ConversationId, before: RollbackTarget): Promise<RollbackSessionResult>;
  /** 切换到一条废弃分支：等守护进程做完；被拒时原因出现在 ui.failures 里，这里也拒绝 */
  switchBranch(conversation: ConversationId, branchId: string): Promise<SwitchBranchResult>;
  /** 废弃分支详情里的「申请撤回」：等守护进程记下；被拒时原因出现在 ui.failures 里，这里也拒绝 */
  requestEffectUndo(conversation: ConversationId, branchId: string, callId: string): Promise<RequestEffectUndoResult>;
  /** 取一条废弃分支的样子（⑂ 预览、分支详情），并进状态层；取失败时抛错 */
  loadBranch(conversation: ConversationId, branchId: string): Promise<void>;
  /** 叉掉一条排队的消息：先照着显示，守护进程的队列随后推来 */
  removeQueued(conversation: ConversationId, messageId: string): void;
  /** 拖完给出排队的消息的新顺序：先照着显示，守护进程的队列随后推来 */
  reorderQueued(conversation: ConversationId, messageIds: string[]): void;
  /** 工具包区里改工具包 */
  setToolkit(target: ToolkitTarget, toolkit: PlanToolkit): void;
  /** 看板、项目页上暂停、恢复、取消定时作业；被拒时原因出现在 ui.failures 里 */
  scheduledJobAction(jobId: string, action: ScheduledJobAction): void;
  /** 任务操作菜单里的"改时间"：等到守护进程回的结果（提示改成了什么、下次什么时候）；被拒时原因出现在 ui.failures 里，这里也拒绝 */
  rescheduleJob(jobId: string, schedule: ReminderSchedule): Promise<RescheduleJobResult>;
  /** 任务操作菜单里的"立即运行一次"：等到起了哪一次运行；上一次还在跑之类被拒时原因出现在 ui.failures 里，这里也拒绝 */
  runJobNow(jobId: string): Promise<RunJobNowResult>;
  /** 任务操作菜单里的"跑完自动播报：开 / 关"；被拒时原因出现在 ui.failures 里，这里也拒绝 */
  setVoiceAnnounce(taskId: string, on: boolean): Promise<SetVoiceAnnounceResult>;
  setProjectVoiceAnnounce(projectId: string, on: boolean): Promise<SetProjectVoiceAnnounceResult>;
  /** 这台设备上看到了会话的哪一条：先记上（"秘书"页签的红点马上消失），不报给守护进程 */
  seeRead(conversation: ConversationId, seq: number): void;
  /** 把看到哪一条报给守护进程：已读位置随后在已读位置频道推来，几台设备一起 */
  markRead(conversation: ConversationId, seq: number): void;
  /** 界面自己出一条顶上的通知（秘书新消息）；同一个 id 的不重复出 */
  showAlert(alert: PageAlert): void;
  /** 对秘书说完的这一轮（这一轮开始的序号）决定过了要不要提醒 */
  seeSecretaryTurn(since: number): void;
  /**
   * 网页的版本（app/page-update.ts）：问到的服务端版本、"等会儿"、切到后台、切回前台、切回前台后问完了
   */
  notePageUpdate(input: PageUpdateInput): void;
  /** 界面已经提示过这条通知 */
  seeAlert(id: string): void;
  /** 界面已经提示过这个被拒的请求 */
  seeFailure(idempotencyKey: string): void;
  /** 对这条新到的 agent 语音决定过了（自动播了，或者不播） */
  seeAgentVoiceArrival(voiceId: string): void;
  /** 往上翻：取这个会话更早的一页历史（没有更早的了就什么也不做） */
  /** 往上翻取回更早的一页（limit 不填是一页 50 条；任务详情取齐历史时一次 200 条） */
  loadOlder(conversation: ConversationId, limit?: number): Promise<void>;
  /** 日历：取某个月（YYYY-MM）每一天的日历条目，并进状态层；取失败时抛错 */
  loadCalendarMonth(month: string): Promise<void>;
  /** 设置 · 语音：取两个语音模型现在的状态，并进状态层（之后的变化经活动状态频道推来）；取失败时抛错 */
  loadVoiceModels(): Promise<void>;
  /**
   * 角色：取一次整份并进状态层（默认角色、角色表、每个 agent 用哪个角色；界面各处现取）；
   * 取失败时抛错（界面上按"跟默认"显示）
   */
  loadAgentRoles(): Promise<void>;
  /** 新建一个角色（设置 · 角色与声音）：接口回的整份并进状态层 */
  createAgentRole(body: AgentRoleBody): Promise<AgentRolesView>;
  /** 改名 / 换音色（默认角色会同时改全局名字 / 全局选中的音色） */
  updateAgentRole(roleId: string, body: AgentRoleUpdateBody): Promise<AgentRolesView>;
  /** 删一个角色：默认角色、还有 agent 在用的会被拒（400 带原因） */
  deleteAgentRole(roleId: string): Promise<AgentRolesView>;
  /** 把某个角色设成默认 */
  setDefaultAgentRole(roleId: string): Promise<AgentRolesView>;
  /** 给一个 agent 选角色（null = 跟默认；⚙ 面板和角色页都走它）：改完下一轮 / 下一次合成就生效 */
  assignAgentRole(agentId: string, roleId: string | null): Promise<AgentRolesView>;
  /** 我的名字：取一次并进状态层（秘书页、待办页的副标题和设置那一项用）；取失败时抛错（界面上照旧、不多字） */
  loadUserName(): Promise<void>;
  /** 改我的名字（设置 · 身份那一项）：null 或者空串 = 清除；改完的那个并进状态层，不合规时抛错（message 是原因） */
  saveUserName(name: string | null): Promise<UserNameResult>;
  /** 把聊天里的一张卡片引用到输入框（发消息时带上）；去掉一张引用 */
  quoteCard(conversation: ConversationId, cardId: string): void;
  unquoteCard(conversation: ConversationId, cardId: string): void;
  /** HTTP 那一半：上传附件、媒体的地址 */
  http: DaemonHttp;
  /** 守护进程是哪一版、什么时候起来的、它此刻的时间（关于页、Debug 工具集）；没连上、太旧的守护进程拒绝 */
  daemonInfo(): Promise<DaemonInfo>;
  /**
   * 这次打开以来断线、重连各几次，最近一次断线，最近一次补发收了多少（Debug 工具集）；openedFrom：打开时先用了什么
   * （本机快照、换了一版后本机存的事件、什么都没有；没有本机快照这回事的——原型、开发服务器——不带）
   */
  connectionStats(): ConnectionStats & { readonly openedFrom?: OpenedFrom };
  /** 手机本机存的聊天记录存了多少（Debug 工具集）；没有这回事的（原型、开发服务器）是 undefined */
  chatCacheStats(): ChatCacheStats | undefined;
  /** Debug 工具集的"断开重连" */
  reconnect(): void;
}

/** 网页的版本那几样输入 */
export type PageUpdateInput = Extract<UiInput, { kind: "web_version" | "update_later" | "page_hidden" | "page_foreground" | "page_settled" }>;

const StoreContext = createContext<Store | null>(null);

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把状态里要存的那部分存进本机快照：补发推完了、连着时，要存的那几样变了就交给 snapshots 攒着（闲下来再写，写的时候取最新的）；
 * 切到后台、关页面时马上写
 */
function useSnapshotSaving(snapshots: PageSnapshots | undefined, state: UiState, uiRef: { readonly current: UiState }): void {
  const scheduled = useRef<UiState | undefined>(undefined);
  useEffect(() => {
    if (!snapshots || !state.caughtUp || state.connection !== "online") return;
    if (!snapshotChanged(scheduled.current, state)) return;
    scheduled.current = state;
    snapshots.save(() => snapshotOf(uiRef.current));
  }, [snapshots, state, uiRef]);
  useEffect(() => {
    if (!snapshots || typeof document === "undefined") return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") snapshots.flush();
    };
    const onLeave = () => snapshots.flush();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [snapshots]);
}

/** 切到后台、关页面时马上写本机存的聊天记录（攒着的不丢） */
function useChatCacheFlush(chatCache: ChatCache | undefined): void {
  useEffect(() => {
    if (!chatCache || typeof document === "undefined") return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") chatCache.flush();
    };
    const onLeave = () => chatCache.flush();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [chatCache]);
}

/**
 * snapshots：本机快照（安装版由守护进程提供的页面才有，app/open-snapshot.ts）；没有时照旧从头补（原型、开发服务器、测试）。
 * chatCache：手机本机存的聊天记录（457，app/chat-cache.ts）：往上翻时本机有的直接用，没有才向电脑要；同样只有安装版有
 */
export function StoreProvider({ connection, http, snapshots, chatCache, children }: { connection: Connection; http: DaemonHttp; snapshots?: PageSnapshots; chatCache?: ChatCache; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialUiState);
  // 装上了新的词典（换了语言、守护进程的词典到了）时给一份新的 ui（浅拷贝，内容不变）：各处 useMemo(() => …(ui), [ui])
  // 里拼出来的字（会话的条目、阶段框、日期分隔……）跟着重算，不停在旧语言（由守护进程提供的页面先按中文打开、词典随后才到）
  const localeRev = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies
  const ui = useMemo(() => ({ ...state }), [state, localeRev]);
  // 事件处理函数里要读最新的状态（比如卡片的当前版本）
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  }, [ui]);

  // 连上就收事件；断开重连时带上每个频道最后收到的序号，重复补发的事件由状态层丢掉。
  // 有本机快照（snapshots，app/open-snapshot.ts）时先读它：读到同一版的快照就先用它把界面画出来，订阅时带它的游标，守护进程只补增量；
  // 网页换了一版、快照不能用了，读到存着的事件就用新版本的状态层重新折一遍（452），订阅时带事件的游标（会话频道没存，从 0 要最近一页）。
  // 连接交来的每一样都先给 snapshots 记一下（要存的事件），再交给状态层。
  // 本机存的聊天记录（chatCache）同样每一样都看一眼（会话频道上的消息照收到的存，作废的照着改）；连上之前先告诉它这次订阅带的游标
  // （热打开时它从快照的游标接着存，见 app/chat-cache.ts）
  const openedFrom = useRef<OpenedFrom | undefined>(undefined);
  useEffect(() => {
    const deliver = (input: UiInput) => {
      snapshots?.note(input);
      chatCache?.note(input);
      dispatch(input);
    };
    if (!snapshots) {
      const cursors = resumeCursors(uiRef.current);
      chatCache?.begin(cursors);
      return connection.connect(cursors, chatCache ? deliver : dispatch);
    }
    let gone = false;
    let stop: (() => void) | undefined;
    void snapshots.load().then((start) => {
      if (gone) return;
      openedFrom.current = start === undefined ? { kind: "scratch" } : start.kind === "snapshot" ? { kind: "snapshot" } : { kind: "events", events: start.events.length };
      const cursors = start === undefined ? resumeCursors(uiRef.current) : start.kind === "snapshot" ? { ...start.snapshot.cursors } : { ...start.cursors };
      chatCache?.begin(cursors, start?.kind === "snapshot" ? (conversation) => start.snapshot.conversations[conversation]?.branches : undefined);
      if (start?.kind === "snapshot") dispatch({ kind: "restore", snapshot: start.snapshot });
      if (start?.kind === "events") {
        const refold = refoldInput(start.events);
        chatCache?.note(refold);
        dispatch(refold);
      }
      stop = connection.connect(cursors, deliver);
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [connection, snapshots, chatCache]);
  useSnapshotSaving(snapshots, state, uiRef);
  useChatCacheFlush(chatCache);

  const sendMessage = useCallback(
    (conversation: ConversationId, parts: MessagePart[], taskId?: string, browsing?: BrowsingContext, map?: MapContext) => {
      const idempotencyKey = newKey();
      dispatch({ kind: "send_message", conversation, idempotencyKey, parts, time: nowIso(), ...(browsing ? { browsing: browsingMarkOf(browsing) } : {}), ...(map ? { map: mapMarkOf(map) } : {}) });
      connection.sendMessage({ conversation, idempotencyKey, parts, ...(taskId === undefined ? {} : { taskId }), ...(browsing ? { browsing } : {}), ...(map ? { map } : {}) });
      return idempotencyKey;
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
      // 一次最多 INBOX_ACTION_MAX 条：多选全选、全部标已读多于这些时分批交，每批各自生效
      for (const batch of inChunks(itemIds, INBOX_ACTION_MAX)) {
        connection.inboxAction({ itemIds: batch, action, idempotencyKey: newKey(), ...(choice === undefined ? {} : { choice }) });
      }
    },
    [connection],
  );

  const deviceBatchAction = useCallback(
    (deviceIds: string[], action: DeviceBatchAction, days?: number) => connection.deviceBatchAction({ deviceIds, action, ...(days === undefined ? {} : { days }), idempotencyKey: newKey() }),
    [connection],
  );
  const startTask = useCallback(
    (request: string, projects: string[], kind: TaskKind, trigger?: TaskTrigger, voiceAnnounce?: boolean, runtime?: string, folder?: WorkFolderChoice) =>
      connection.startTask({
        request,
        projects,
        kind,
        ...(trigger ? { trigger } : {}),
        ...(voiceAnnounce ? { voiceAnnounce: true } : {}),
        ...(runtime === undefined ? {} : { runtime }),
        ...(folder === undefined ? {} : { folder }),
        idempotencyKey: newKey(),
      }),
    [connection],
  );
  const createReminder = useCallback(
    (text: string, when: ReminderSchedule | { event: EventTrigger }) =>
      connection.createReminder({ text, ...("event" in when ? { event: when.event } : { schedule: when }), idempotencyKey: newKey() }),
    [connection],
  );
  const updateWatchCategories = useCallback((params: UpdateWatchCategoriesParams) => connection.updateWatchCategories({ params, idempotencyKey: newKey() }), [connection]);
  const newProject = useCallback(
    (request: string, runtime?: string, folder?: WorkFolderChoice) =>
      connection.newProject({ request, ...(runtime === undefined ? {} : { runtime }), ...(folder === undefined ? {} : { folder }), idempotencyKey: newKey() }),
    [connection],
  );
  const convertTaskToProject = useCallback((taskId: string, name: string) => connection.convertTaskToProject({ taskId, name, idempotencyKey: newKey() }), [connection]);
  const projectAction = useCallback((projectId: string, action: ProjectAction) => connection.projectAction({ projectId, action, idempotencyKey: newKey() }), [connection]);
  const projectServicesAction = useCallback((projectId: string, action: ProjectServicesAction) => connection.projectServicesAction({ projectId, action, idempotencyKey: newKey() }), [connection]);
  const resetMaintainer = useCallback((projectId: string) => connection.resetMaintainer({ projectId, idempotencyKey: newKey() }), [connection]);
  const watchChannels = useCallback((channels: readonly string[]) => connection.watchChannels(channels), [connection]);
  const taskAction = useCallback(
    (taskId: string, action: TaskAction, options: TaskActOptions = {}) =>
      connection.taskAction({
        taskId,
        action,
        idempotencyKey: newKey(),
        ...(options.stageId === undefined ? {} : { stageId: options.stageId }),
        ...(options.note?.trim() ? { note: options.note.trim() } : {}),
        ...(options.stageEdit === undefined ? {} : { stageEdit: options.stageEdit }),
      }),
    [connection],
  );

  const taskBatchAction = useCallback((taskIds: string[], action: TaskBatchAction) => connection.taskBatchAction({ taskIds, action, idempotencyKey: newKey() }), [connection]);
  const reminderAction = useCallback((reminderIds: string[], action: ReminderAction) => connection.reminderAction({ reminderIds, action, idempotencyKey: newKey() }), [connection]);
  const retryVoice = useCallback((voiceId: string) => connection.retryVoice({ voiceId, idempotencyKey: newKey() }), [connection]);
  const stopReply = useCallback((conversation: ConversationId) => connection.stopReply({ conversation, idempotencyKey: newKey() }), [connection]);
  const rollbackSession = useCallback(
    (conversation: ConversationId, before: RollbackTarget) => connection.rollbackSession({ conversation, before, idempotencyKey: newKey() }),
    [connection],
  );
  const switchBranch = useCallback(
    (conversation: ConversationId, branchId: string) => connection.switchBranch({ conversation, branchId, idempotencyKey: newKey() }),
    [connection],
  );
  const requestEffectUndo = useCallback(
    (conversation: ConversationId, branchId: string, callId: string) => connection.requestEffectUndo({ conversation, branchId, callId, idempotencyKey: newKey() }),
    [connection],
  );
  const loadBranch = useCallback(
    async (conversation: ConversationId, branchId: string) => {
      const view = await http.branchView(conversation, branchId);
      dispatch({ kind: "branch_view", conversation, view });
    },
    [http],
  );
  // 切换分支之后手里缺的那一段（别的设备切的、断线时切的）：取切过去的那条和原来那条比的样子补进来。
  // 同一个缺口只取一次（取失败了不反复取，下次打开页面时补发、往上翻照样沿当前分支）
  const gapFetches = useRef(new Set<string>());
  useEffect(() => {
    for (const gap of branchGaps(ui)) {
      const key = `${gap.conversation}\u0000${gap.branch}\u0000${gap.against}`;
      if (gapFetches.current.has(key)) continue;
      gapFetches.current.add(key);
      http.branchView(gap.conversation, gap.branch, gap.against).then(
        (view) => {
          gapFetches.current.delete(key);
          dispatch({ kind: "branch_view", conversation: gap.conversation, view });
        },
        () => undefined,
      );
    }
  }, [ui, http]);
  const removeQueued = useCallback(
    (conversation: ConversationId, messageId: string) => {
      const idempotencyKey = newKey();
      dispatch({ kind: "queue_edit", conversation, edit: { key: idempotencyKey, kind: "remove", messageId } });
      connection.queuedMessageAction({ conversation, action: "remove", messageId, idempotencyKey });
    },
    [connection],
  );
  const reorderQueued = useCallback(
    (conversation: ConversationId, messageIds: string[]) => {
      const idempotencyKey = newKey();
      dispatch({ kind: "queue_edit", conversation, edit: { key: idempotencyKey, kind: "reorder", messageIds } });
      connection.queuedMessageAction({ conversation, action: "reorder", messageIds, idempotencyKey });
    },
    [connection],
  );
  const setToolkit = useCallback((target: ToolkitTarget, toolkit: PlanToolkit) => connection.setToolkit({ target, toolkit, idempotencyKey: newKey() }), [connection]);
  const scheduledJobAction = useCallback((jobId: string, action: ScheduledJobAction) => connection.scheduledJobAction({ jobId, action, idempotencyKey: newKey() }), [connection]);
  const rescheduleJob = useCallback((jobId: string, schedule: ReminderSchedule) => connection.rescheduleJob({ jobId, schedule, idempotencyKey: newKey() }), [connection]);
  const runJobNow = useCallback((jobId: string) => connection.runJobNow({ jobId, idempotencyKey: newKey() }), [connection]);
  const setVoiceAnnounce = useCallback((taskId: string, on: boolean) => connection.setVoiceAnnounce({ taskId, on, idempotencyKey: newKey() }), [connection]);
  const setProjectVoiceAnnounce = useCallback((projectId: string, on: boolean) => connection.setProjectVoiceAnnounce({ projectId, on, idempotencyKey: newKey() }), [connection]);
  const seeAlert = useCallback((id: string) => dispatch({ kind: "alert_seen", id }), []);
  const seeRead = useCallback((conversation: ConversationId, seq: number) => dispatch({ kind: "read_seen", conversation, seq }), []);
  const markRead = useCallback((conversation: ConversationId, seq: number) => connection.markRead({ conversation, seq, idempotencyKey: newKey() }), [connection]);
  const showAlert = useCallback((alert: PageAlert) => dispatch({ kind: "alert", alert }), []);
  const seeSecretaryTurn = useCallback((since: number) => dispatch({ kind: "secretary_turn_seen", since }), []);
  const quoteCard = useCallback((conversation: ConversationId, cardId: string) => dispatch({ kind: "quote_card", conversation, cardId }), []);
  const unquoteCard = useCallback((conversation: ConversationId, cardId: string) => dispatch({ kind: "unquote_card", conversation, cardId }), []);
  const seeFailure = useCallback((idempotencyKey: string) => dispatch({ kind: "failure_seen", idempotencyKey }), []);
  const seeAgentVoiceArrival = useCallback((voiceId: string) => dispatch({ kind: "agent_voice_arrival_seen", voiceId }), []);
  const notePageUpdate = useCallback((input: PageUpdateInput) => dispatch(input), []);

  // 往上翻：手机本机存着这一段的直接用（马上出来，没网也能看）；没有、拼不出、信不过才向电脑要，要来的存下（457）
  const loadOlder = useCallback(
    async (conversation: ConversationId, limit?: number) => {
      const { canLoadOlder, before } = olderHistory(uiRef.current, conversation);
      if (!canLoadOlder || before === undefined) return;
      if (chatCache) {
        const cached = await chatCache.page(conversation, before, limit, uiRef.current.conversations[conversation]?.branches);
        const input: UiInput | undefined = cached && { kind: "history_page", conversation, page: cached };
        // 拼出来的这一页得真的往前翻了（防着本机存的和手里的对不上时原地打转）；没往前就当没有，向电脑要
        if (input && olderHistory(reduce(uiRef.current, input), conversation).before !== before) {
          dispatch(input);
          return;
        }
      }
      const ticket = chatCache?.ticket(conversation);
      const page = await http.history(conversation, before, limit);
      dispatch({ kind: "history_page", conversation, page });
      if (ticket !== undefined) chatCache?.keep(conversation, before, page, ticket);
    },
    [http, chatCache],
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

  // 语音识别走 audio.cpp 时服务只收 WAV：录音要先知道。开页面时取一次，之后变了经 voice_models 推来
  useEffect(() => noteRecognizerInput(ui.voiceModels), [ui.voiceModels]);
  useEffect(() => {
    loadVoiceModels().catch(() => undefined);
  }, [loadVoiceModels]);

  // 角色：取回的整份进状态层（改了角色、给 agent 换了角色、删了 agent 之后重新取同一份）
  const loadAgentRoles = useCallback(async () => {
    const view = await http.agentRoles();
    dispatch({ kind: "agent_roles", view });
  }, [http]);

  /** 每次改完接口回的是整份：并进状态层，再交给调用方 */
  const withRoles = useCallback((run: () => Promise<AgentRolesView>) => {
    return run().then((view) => {
      dispatch({ kind: "agent_roles", view });
      return view;
    });
  }, []);

  const createAgentRole = useCallback((body: AgentRoleBody) => withRoles(() => http.createAgentRole(body)), [http, withRoles]);
  const updateAgentRole = useCallback((roleId: string, body: AgentRoleUpdateBody) => withRoles(() => http.updateAgentRole(roleId, body)), [http, withRoles]);
  const deleteAgentRole = useCallback((roleId: string) => withRoles(() => http.deleteAgentRole(roleId)), [http, withRoles]);
  const setDefaultAgentRole = useCallback((roleId: string) => withRoles(() => http.setDefaultAgentRole(roleId)), [http, withRoles]);
  const assignAgentRole = useCallback((agentId: string, roleId: string | null) => withRoles(() => http.assignAgentRole(agentId, roleId)), [http, withRoles]);

  // 我的名字：打开页面时取一次（秘书页、待办页的副标题用得上），改了之后用接口回的那个
  const loadUserName = useCallback(async () => {
    const view = await http.userName();
    dispatch({ kind: "user_name", name: view.name });
  }, [http]);

  const saveUserName = useCallback(
    async (name: string | null) => {
      const result = await http.setUserName(name);
      dispatch({ kind: "user_name", name: result.name });
      return result;
    },
    [http],
  );

  const daemonInfo = useCallback(() => connection.daemonInfo(), [connection]);
  const connectionStats = useCallback(() => ({ ...connection.stats(), ...(openedFrom.current === undefined ? {} : { openedFrom: openedFrom.current }) }), [connection]);
  const chatCacheStats = useCallback(() => chatCache?.stats(), [chatCache]);
  const reconnect = useCallback(() => connection.reconnect(), [connection]);

  const store = useMemo(
    () => ({
      ui,
      sendMessage,
      cardAction,
      inboxAction,
      deviceBatchAction,
      startTask,
      createReminder,
      taskAction,
      taskBatchAction,
      reminderAction,
      updateWatchCategories,
      newProject,
      convertTaskToProject,
      projectAction,
      projectServicesAction,
      resetMaintainer,
      watchChannels,
      retryVoice,
      stopReply,
      rollbackSession,
      switchBranch,
      requestEffectUndo,
      loadBranch,
      removeQueued,
      reorderQueued,
      setToolkit,
      scheduledJobAction,
      rescheduleJob,
      runJobNow,
      setVoiceAnnounce,
      setProjectVoiceAnnounce,
      seeRead,
      markRead,
      showAlert,
      seeSecretaryTurn,
      seeAlert,
      seeFailure,
      seeAgentVoiceArrival,
      notePageUpdate,
      loadOlder,
      loadCalendarMonth,
      loadVoiceModels,
      loadAgentRoles,
      createAgentRole,
      updateAgentRole,
      deleteAgentRole,
      setDefaultAgentRole,
      assignAgentRole,
      loadUserName,
      saveUserName,
      quoteCard,
      unquoteCard,
      http,
      daemonInfo,
      connectionStats,
      chatCacheStats,
      reconnect,
    }),
    [ui, sendMessage, cardAction, inboxAction, deviceBatchAction, startTask, createReminder, taskAction, taskBatchAction, reminderAction, updateWatchCategories, newProject, convertTaskToProject, projectAction, projectServicesAction, resetMaintainer, watchChannels, retryVoice, stopReply, rollbackSession, switchBranch, requestEffectUndo, loadBranch, removeQueued, reorderQueued, setToolkit, scheduledJobAction, rescheduleJob, runJobNow, setVoiceAnnounce, setProjectVoiceAnnounce, seeRead, markRead, showAlert, seeSecretaryTurn, seeAlert, seeFailure, seeAgentVoiceArrival, notePageUpdate, loadOlder, loadCalendarMonth, loadVoiceModels, loadAgentRoles, createAgentRole, updateAgentRole, deleteAgentRole, setDefaultAgentRole, assignAgentRole, loadUserName, saveUserName, quoteCard, unquoteCard, http, daemonInfo, connectionStats, chatCacheStats, reconnect],
  );
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** 不在 StoreProvider 里时是 null（只画样子的组件测试里）：用得上就用、用不上照旧的地方用它 */
export function useOptionalStore(): Store | null {
  return useContext(StoreContext);
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore 必须在 StoreProvider 里用"); // @i18n-ignore log：用错了地方的编程错误
  return s;
}

export function useCard(cardId: string): CardState | undefined {
  return selectCard(useStore().ui, cardId);
}
