// 前端协议里状态层要用到的名字和形状，全部取自共享协议包（TypeBox 定义，守护进程和 Web 共用）。
// 状态层和界面从这里（经 state/index.ts）取，不直接散着引用协议包。
export {
  ACCEPTANCE_METHOD_LABEL,
  // 个人助理的名字（43 号票）：起名的规则、守护进程生成的话里的名字占位
  ASSISTANT_NAME_MARK,
  ASSISTANT_NAME_MAX,
  checkAssistantName,
  // 我的名字（249 号票）：用户自己的名字，规矩照助理的名字
  checkUserName,
  USER_NAME_MAX,
  currentWording,
  DEFAULT_ASSISTANT_NAME,
  LEGACY_WORDING,
  fillAssistantName,
  splitAssistantName,
  ACTIVITY_STATE_LABEL,
  // 活动状态的说明、时间线上的记录、消息归属、操作记录凭什么执行的、被拦下的原因（25 号票）
  activityDetailText,
  // agent 这一轮出错时留的那条系统说明（60 号票：阶段详情算"要你看一眼"）
  isTurnFailedNote,
  isTimelineRecordKind,
  pickMessageScope,
  QUICK_ACTION_BASIS_LABEL,
  TIMELINE_RECORD_KIND_INFO,
  TOOL_CALL_BLOCK_LABEL,
  // 工具调用做了什么性质的事：只看、动手、删改（54 号票）
  TOOL_NATURES,
  TOOL_NATURE_LABEL,
  attachmentPartFrom,
  BOARD_GROUP_LABEL,
  BOARD_GROUP_OF_TASK_STATE,
  BOARD_GROUPS,
  boardGroupOfReminder,
  DISPOSITION_LABEL,
  ENDED_TASK_STATES,
  // 关注类别设置（26 号票）
  categoryMatchText,
  dispositionsNotLooserThan,
  DISPOSITIONS,
  grantNarrowingText,
  heldByTasksText,
  unregisteredTools,
  unregisteredToolsText,
  WATCH_CATEGORIES_BROKEN_COPY,
  WATCH_CATEGORIES_REPAIR_ACTION,
  WATCH_CATEGORY_OPS,
  WATCH_CATEGORY_REPAIR_LABEL,
  WATCH_CATEGORY_TITLE_MAX,
  WATCH_SCENE_LABEL,
  WATCH_SCENES,
  CHARTER_DECISION_LABEL,
  // "首版做完了"卡（112 号票）：三个选择、标题
  BUILD_DONE_CHOICE_LABEL,
  buildDoneTitle,
  hasOwnMaintainer,
  // 任务涉及几个项目（建卡时定下，17 号票）
  taskProjectScope,
  // 任务的种类：流程、长程任务（58 号票）；普通任务（75 号票）
  taskKind,
  isPlainTask,
  TASK_KIND_LABEL,
  TASK_KIND_HINT,
  TASK_KINDS,
  // 任务的触发方式（76 号票，ADR 0025）：现在做一次、定时、事件（77 号票）；长程任务只能现在做一次
  isTriggered,
  onceAt,
  LONG_RUNNING_TRIGGER_REFUSAL,
  TASK_TRIGGER_KINDS,
  TASK_TRIGGER_LABEL,
  taskTriggerKind,
  triggerKindsOf,
  // 项目内部（64 号票）：项目内部的任务、定时作业不上全局看板，在项目页上
  internalScopeLabel,
  isInternalTo,
  isProjectInternal,
  // 141 号票：运营方案建的内部任务也上任务看板；项目在用时运营方案里的一条只能暂停、恢复
  internalTaskOnBoard,
  operationsItemLock,
  taskOnBoard,
  // 流程的计划卡、步骤（58 号票）
  REPORTED_STEP_STATES,
  WORKFLOW_CONDITION_SOURCE_LABEL,
  WORKFLOW_CONDITION_STATUS_LABEL,
  WORKFLOW_REPAIR_LABEL,
  WORKFLOW_REVIEW_STATUS_LABEL,
  WORKFLOW_STAGE_ID,
  WORKFLOW_STEP_ICON,
  WORKFLOW_STEP_STATE_LABEL,
  TIMED_WORKFLOW_GRANT_TEXT,
  workflowConfirmationItems,
  inboxItemProjectId,
  ownMaintainerId,
  projectActionTarget,
  // 项目还有没结束的工单时不能归档、重置维护者（16 号票）
  ARCHIVING_ACTIONS,
  archiveBlockedText,
  canResetMaintainer,
  RESET_MAINTAINER_LABEL,
  isActiveWorkOrder,
  toolkitBashWording,
  PROJECT_ACTION_LABEL,
  PROJECT_ACTION_RULES,
  PROJECT_ACTIONS,
  PROJECT_DELETE_CANCEL,
  PROJECT_NAME_MAX,
  PROJECT_DELETE_CONFIRM,
  PROJECT_KIND_LABEL,
  PROJECT_STATE_LABEL,
  PROJECT_STATES,
  projectActionRefusal,
  projectActions,
  UNFINISHED_TASK_STATES,
  grantAuthorizes,
  grantNotAuthorizedLabel,
  grantText,
  planGrants,
  planPolicies,
  planStops,
  stagePolicies,
  stageStops,
  initialStages,
  // 从某个阶段重做的范围、开始过没有（84 号票，和守护进程同一份）；规则违反了怎么办的说法（84 号票合成一份）
  stageStarted,
  downstreamOf,
  reopenScope,
  ON_VIOLATION_TEXT,
  onViolationOf,
  availableTaskActions,
  taskActRefusal,
  // 186 号票：没结束的先取消再归档、能不能删
  archiveCancelsFirst,
  taskDeleteRefusal,
  TASK_BATCH_ACTIONS,
  policyOwnerLabel,
  // 第几阶段、编号（91 号票：依赖图、计划卡、阶段详情都按它；93 号票起编号存在计划里，读的时候照存的）
  stageNumbers,
  stageCodes,
  planStageCodes,
  listStageCodes,
  stageCodeAt,
  stageLayerCount,
  TOOL_CALL_MARKS,
  type StageDeps,
  TASK_END_KIND_LABEL,
  ACCEPTANCE_VERDICT_LABEL,
  FAILURE_CHOICE_ACTIONS,
  STAGE_ACCEPTANCE_ACTIONS,
  STAGE_STATE_LABEL,
  STUCK_HELP_ACTIONS,
  TASK_WAIT_REASON_LABEL,
  userDecidesWait,
  // 偏离、阈值与计划变更（14 号票）
  GRANT_RENEWAL_ACTIONS,
  OVER_BUDGET_ACTIONS,
  planChangeItemText,
  TASK_PAUSE_REASON_LABEL,
  toolkitText,
  temporalRuleText,
  TASK_STATE_LABEL,
  TASK_STATES,
  BLOCKING_URGENCIES,
  CARD_ACTIONS,
  CARD_TYPE_VERSIONS,
  CARD_TYPES,
  CHANNELS,
  defaultDeviceName,
  // 像网络上的自动访问的配对请求，卡上那句提示（137 号票）
  automatedAccessHint,
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_FIRST_USE_WINDOW_MS,
  DEVICE_NAME_MAX_LENGTH,
  // 已配对设备的多选管理（123 号票）：能做的动作、延期能选的天数、哪台要跳过、跳过的原因怎么说、延期后的到期日
  DEFAULT_DEVICE_EXTEND_DAYS,
  DEVICE_BATCH_ACTIONS,
  DEVICE_BATCH_MAX,
  DEVICE_EXTEND_DAYS,
  deviceBatchSkip,
  deviceSkipPhrase,
  extendedExpiry,
  durationText,
  EVENT_TYPES,
  FRONTEND_PROTOCOL_VERSION,
  HTTP_PATHS,
  HTTP_QUERY,
  INBOX_ACTIONS,
  isCardType,
  isDeletedEventPayload,
  isEphemeralEventType,
  // 待我处理事项的先后（秘书列出待我处理也用它，22 号票）
  compareInboxItems,
  // 事项的动作、处理结果显示成当前语言（172 号票：存的、按字认的是中文原字）
  inboxActionText,
  isInboxItemProcessed,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  // 记忆管理员（242 号票）：它的 agent 编号和会话频道（#/more/memory/curator 那一层订阅、发消息）
  MEMORY_CURATOR_AGENT_ID,
  MEMORY_CURATOR_CONVERSATION,
  MAX_MEMORY_DELETE_MATERIALS,
  // 设置里看素材（158 号票）；记忆 · 素材的种类筛选（167 号票）
  MATERIAL_FACET_HINT,
  MATERIAL_FACET_LABEL,
  MATERIAL_FACETS,
  MATERIAL_LIST_MAX,
  MATERIAL_QUERY_MAX,
  MEMORY_COMMAND_LABEL,
  MEMORY_DELETE_MODE_INFO,
  MEMORY_DELETE_MODES,
  METHODS,
  normalizeDeviceName,
  NOTICE_TYPES,
  PAIRING_FINGERPRINT_HEX_DIGITS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_SHORT_CODE_DIGITS,
  pairingRequestTitle,
  PURGE_LIMITS,
  PURGED_TEXT,
  MEMORY_RECALL_SOURCES,
  REMINDER_STATUS_LABEL,
  URGENCIES,
  URGENCY_LABEL,
  WS_CLOSE_UNPAIRED,
  // 简单提醒的时间规则（按规则种类分支的逻辑只在共享协议包的 reminder-schedule.ts 里）
  describeSchedule,
  describeTime,
  isRepeating,
  // 282 号票：每年某月某日的编辑框（几月、最多几日）
  maxDayOfMonth,
  monthName,
  nextClockTime,
  nextOccurrence,
  REPEAT_KIND_LABEL,
  REPEAT_KINDS,
  repeatRuleOf,
  repeatSchedule,
  scheduleClockTime,
  withClockTime,
  // 97 号票：发起对话框按写的话定时间（state/text-time.ts）要拼出带时区偏移的时刻、补零的钟点（98 号票改时间的对话框起草"某个时间做一次"也用）
  nowIso,
  pad2,
  // 个人工作日历（29 号票）：某天上班或休息及原因，守护进程和这里用同一个纯函数
  applyWorkdayChange,
  DAY_MARKS,
  DAY_SHORT_LABEL_LEGEND,
  dayReasonLabel,
  dayShortLabel,
  describeExtraRule,
  describeLocalDate,
  describeWorkdayChange,
  EMPTY_WORKDAY_SETTINGS,
  HOLIDAY_REGION_LABEL,
  HOLIDAY_UPDATE_ACTION,
  isManualDay,
  localDate,
  localDateKey,
  weekdayName,
  parseLocalDate,
  missingHolidayDataText,
  workdayCalendar,
  // token 账本与消耗（24 号票）
  addTokens,
  cacheHitRate,
  COST_ESTIMATE_LABEL,
  costOf,
  currencySymbol,
  LEDGER_OWNER_KIND_LABEL,
  LEDGER_PURPOSE_LABEL,
  LEDGER_ROLE_LABEL,
  ledgerOwnerKey,
  SYSTEM_OVERHEAD_LABEL,
  tokenTotal,
  UNATTRIBUTED_LABEL,
  ZERO_TOKENS,
  // 框架自带的单价表和高峰时段（94 号票）
  BUILTIN_PRICE_SOURCE,
  builtinPriceOf,
  describePeakHours,
  PRICE_PERIOD_LABEL,
  pricePeriodJudge,
  // 工单与维护者会话分段（16 号票）
  WORK_ORDER_KIND_LABEL,
  WORK_ORDER_LANE_LABEL,
  WORK_ORDER_LANES,
  WORK_ORDER_SOURCE_LABEL,
  workOrderLane,
  workOrderStatusText,
  workOrderTaskId,
  // 定时作业的一次运行的工单（19 号票）
  isJobRunWorkOrder,
} from "@ergo/protocol";
export type {
  AssistantNameCheck,
  AssistantNameEventPayload,
  AssistantNameResult,
  AssistantNameSegment,
  UserNameView,
  UserNameResult,
  LedgerOwner,
  LedgerOwnerKind,
  LedgerPurpose,
  LedgerRole,
  ModelPrice,
  BuiltinPricingNote,
  PricePeriod,
  TokenPrice,
  TokenAgentRow,
  TokenCounts,
  TokenStageRow,
  TokenTotalsEventPayload,
  UsageAgentRow,
  UsageCategory,
  UsageDay,
  UsagePricing,
  UsageSummary,
  UsageTally,
  BottomLineView,
  BuiltinWatchCategoryView,
  CustomWatchCategoryView,
  PlanCategoryAddition,
  PlanUserLimit,
  UpdateWatchCategoriesParams,
  WatchCategoriesState,
  WatchCategoryDraft,
  WatchCategoryMatch,
  WatchCategoryRepair,
  WatchCategorySettingsEventPayload,
  WatchScene,
  WatchToolChoice,
  BuildDoneCardPayload,
  Charter,
  CharterCardPayload,
  ConvertTaskParams,
  NewProjectParams,
  ProjectActionParams,
  ResetMaintainerParams,
  Project,
  ProjectAction,
  ProjectChange,
  ProjectEventPayload,
  ProjectKind,
  ProjectState,
  SuggestProjectCardPayload,
  SegmentEventPayload,
  WorkOrder,
  WorkOrderCardPayload,
  WorkOrderEventPayload,
  WorkOrderLane,
  UserTaskWorkOrder,
  JobRunWorkOrder,
  AcceptanceMethod,
  AccessInfo,
  ActivityDetail,
  ActivityEventPayload,
  ActivityProgressEventPayload,
  ActivityState,
  HistoryRecord,
  MessageScope,
  QuickActionBasis,
  TimelineRecord,
  TimelineRecordEventPayload,
  TimelineRecordKind,
  TimelineRecordSeverity,
  BoardGroup,
  GrantInfo,
  GrantNarrowing,
  Plan,
  PlanCardPayload,
  PlanChangeCardPayload,
  PlanChangeItem,
  PlanChangeOwner,
  TaskPlanEventPayload,
  PlanConfirmInput,
  PlanGrant,
  PlanTemporalRule,
  OnViolation,
  PlanGrantChoice,
  PlanStage,
  PlanStop,
  PolicyOwner,
  PlanWatchCategory,
  Question,
  QuestionAnswer,
  QuestionsAnswerInput,
  QuestionsCardPayload,
  StartTaskParams,
  SuggestTaskCardPayload,
  Task,
  TaskAction,
  TaskAct,
  TaskActionParams,
  TaskActionResult,
  // 看板多选（90 号票）：一次对多个任务做暂停、继续、取消、归档
  DeviceBatchAction,
  DeviceBatchActionParams,
  DeviceBatchActionResult,
  DeviceBatchItemResult,
  DeviceBatchSkip,
  TaskBatchAction,
  TaskBatchActionParams,
  TaskBatchActionResult,
  TaskBatchItemResult,
  // 对简单提醒的取消、归档、删除（185 号票）
  ReminderAction,
  ReminderActionParams,
  ReminderActionResult,
  ReminderActionItemResult,
  TaskEndKind,
  TaskPauseReason,
  TaskStage,
  TaskWaitReason,
  ProgressCardPayload,
  // 并行确认卡（20 号票）
  ParallelAgent,
  ParallelCardPayload,
  StageState,
  TaskEventPayload,
  TaskKind,
  TaskStep,
  WorkflowCondition,
  WorkflowConfirmationItem,
  WorkflowConfirmInput,
  WorkflowPlan,
  WorkflowPlanCardPayload,
  WorkflowReview,
  WorkflowStepMark,
  WorkflowStepState,
  WorkflowStepView,
  TaskOrigin,
  TaskState,
  DayMarkKind,
  DayReason,
  DayVerdict,
  ExtraWorkdayRule,
  HolidayDataEventPayload,
  HolidayRegion,
  HolidayYear,
  WorkdayCalendar,
  WorkdayChange,
  WorkdayChangeResult,
  WorkdaySettings,
  WorkdaySettingsEventPayload,
  ApprovalCardPayload,
  Card,
  CardAction,
  CardActionParams,
  CardEventPayload,
  CardStatus,
  CardType,
  ConversationId,
  CredentialRejection,
  DeletedEventPayload,
  DeleteMaterialsBody,
  DeleteMaterialsResult,
  DeviceEventPayload,
  Disposition,
  EventFrame,
  HistoryMessage,
  HistoryPage,
  HttpErrorBody,
  InboxAction,
  InboxActionParams,
  CardInboxItem,
  InboxItem,
  InboxItemEventPayload,
  InboxOrigin,
  MaterialDetailView,
  // 回话时调用记忆（187 号票）
  MemoryRecall,
  MemoryRecallHit,
  MemoryRecallSource,
  MaterialListFilter,
  MaterialListItem,
  MaterialListPage,
  MaterialMarks,
  MaterialScope,
  MaterialScopeSummary,
  MaterialSegmentView,
  MaterialFacet,
  MaterialSegmentForm,
  MaterialSourceLevel,
  MemoryDeleteCardPayload,
  MemoryDeleteInput,
  MemoryDeleteMatch,
  MemoryDeleteMode,
  MessagesPurgedEventPayload,
  QuickActionCardPayload,
  QuickActionExecutedEventPayload,
  NoticeInboxItem,
  MessageEnvelope,
  MessageEventPayload,
  MessagePart,
  Method,
  NoticeType,
  NotifyEventPayload,
  PairedDevice,
  PairingCardPayload,
  PairingRequestStatus,
  PairingRequestView,
  Reminder,
  ReminderCardPayload,
  ReminderEditInput,
  ReminderEventPayload,
  // 已读位置（109 号票）
  MarkReadParams,
  MarkReadResult,
  ReadMarkEventPayload,
  ReminderSchedule,
  RepeatKind,
  RepeatRule,
  RequestFrame,
  ResponseFrame,
  RevokeDeviceParams,
  SendMessageParams,
  Speaker,
  StreamDelta,
  StreamEventPayload,
  SubscribeParams,
  SubscribeResult,
  ToolCallOutcome,
  ToolNature,
  TurnEndEventPayload,
  TurnStartEventPayload,
  // 停止和排队（144 号票）
  MessageQueueEventPayload,
  QueueChange,
  QueuedMessage,
  QueuedMessageActionParams,
  QueuedMessageActionResult,
  StopReplyParams,
  StopReplyResult,
  UploadedMedia,
  UploadStatus,
  Urgency,
} from "@ergo/protocol";

// 语音消息（31 号票）：时长和波形的限制、识别状态、语音对象
export {
  isVoiceSettled,
  settledVoiceText,
  VOICE_CAPTURE_TEXT_MAX,
  VOICE_COUNTDOWN_MS,
  VOICE_MAX_MS,
  VOICE_MIC_LOG_MAX,
  VOICE_MIN_MS,
  VOICE_STATUS_LABEL,
  VOICE_WAVEFORM_MAX,
  VOICE_WAVEFORM_MAX_BARS,
  voiceDurationLabel,
} from "@ergo/protocol";
export type { RetryVoiceParams, RetryVoiceResult, VoiceCapture, VoiceEventPayload, VoiceMicLogEntry, VoiceRecord, VoiceStatus } from "@ergo/protocol";

// agent 发的语音（语音回复）和参考音色（32 号票）
export {
  AGENT_VOICE_SEGMENT_FADE_MS,
  agentVoiceCoversReply,
  agentVoiceHoldsTurn,
  agentVoiceIdsOf,
  REFERENCE_VOICE_MAX_BYTES,
  REFERENCE_VOICE_MAX_MS,
  REFERENCE_VOICE_MIN_MS,
  REFERENCE_VOICE_NAME_MAX,
  REFERENCE_VOICE_TEXT_MAX,
  VOICE_REFERENCE_IMPORT_ACTION,
  // 323 号票："向量模型还没下载"的"去装组件"（去设置 · 组件）
  COMPONENTS_INSTALL_ACTION,
} from "@ergo/protocol";
export type { AgentVoiceEventPayload, AgentVoiceMode, AgentVoiceRecord, AgentVoiceStatus, ImportReferenceVoiceBody, ReferenceVoice, ReferenceVoiceList } from "@ergo/protocol";
// 两个语音模型的状态（45 号票：模型预热）
export { VOICE_MODEL_STATUS_LABEL, VOICE_MODEL_STATUSES } from "@ergo/protocol";
export type { VoiceModelState, VoiceModelStatus, VoiceModelsView } from "@ergo/protocol";
// 范围记录：范围变更、越界（18 号票）
// 只是确认收到的"知道了"（越界、秘书会话里的中断不确定、写回求助；待办多选里只有这类能一起处理，90 号票）
export { INTERRUPTED_ACK, WRITE_BACK_HELP_ACK } from "@ergo/protocol";
// 一次批量请求最多几项（看板 task_batch_action、待办 inbox_action；多了分批交，90 号票）
export { INBOX_ACTION_MAX, REMINDER_ACTION_MAX, TASK_BATCH_MAX } from "@ergo/protocol";
export { OUT_OF_SCOPE_ACK, SCOPE_RECORD_KIND_LABEL, SCOPE_RECORD_KINDS, scopeRecordChannel, SCOPE_REVIEW_TRIGGER_LABEL } from "@ergo/protocol";
export type { OutOfScopeNoticeData, ScopeOwnership, ScopeRecord, ScopeRecordEventPayload, ScopeRecordKind, ScopeReviewTrigger, ScopeSources } from "@ergo/protocol";
// skill 库、MCP 登记与工具包（27 号票）：工具包区、skill 库页、工具包变更卡；集合、导入并改名、秘书用的 skill（72 号票）
export { capabilityText, DEFAULT_SECRETARY_SKILLS, IMPORT_NAME_PATTERN, SECRETARY_SKILL_PROMPT_WARN_BYTES, toolkitChangeText } from "@ergo/protocol";
// 工具包里"给秘书发消息"的开关（102 号票；名字写名字占位）
export { canTellSecretary, TELL_SECRETARY_CAPABILITY, tellSecretaryField } from "@ergo/protocol";
// 工具包里"发附件"那个开关（117 号票）
export { canSendAttachment, SEND_ATTACHMENT_CAPABILITY, sendAttachmentField } from "@ergo/protocol";
export type {
  ImportCollectionSpec,
  ImportReportLine,
  ImportSkillBody,
  ImportSkillResult,
  SecretarySkillsBody,
  SecretarySkillsView,
  SkillCollectionEntry,
  McpServerEntry,
  McpToolEntry,
  PlanToolkit,
  SetToolkitParams,
  SetToolkitResult,
  SkillEntry as LibrarySkill,
  // 输入框里打 / 弹出的候选（82 号票）
  SlashCommandEntry,
  SlashCommandList,
  ToolkitCatalog,
  ToolkitChangeCardPayload,
  ToolkitTarget,
  // "MCP 登记变更"卡（239 号票）
  McpChangeCardPayload,
  McpChangeToolView,
} from "@ergo/protocol";
// 定时触发的任务（19 号票的定时作业，76 号票起是触发登记）和归档清单（19 号票）
export {
  ARCHIVE_CHOICE_LABEL,
  ARCHIVE_CHOICES,
  boardGroupOfScheduledJob,
  // 改时间（98 号票）：定时的、没取消的触发登记能改时间表
  canRescheduleJob,
  // 立即运行一次（100 号票）：没取消的触发登记都能；手动的那次触发不是事件
  canRunJobNow,
  isSourceEvent,
  MANUAL_TRIGGER_SOURCE,
  manualTriggerSummary,
  // 跑完自动播报（100 号票）：还会再做完一次的、不是项目内部的任务能开关
  canSetVoiceAnnounce,
  JOB_AUTO_PAUSED_ACTIONS,
  TIME_TRIGGER_SOURCE,
  JOB_PAUSE_REASON_LABEL,
  JOB_RUN_STATE_LABEL,
  JOB_RUN_TRIGGER_LABEL,
  LAST_RUN_FAILED_LABEL,
  // 最近一次部分完成（176 号票）：卡上标的最近一次的结局
  LAST_RUN_PARTIAL_LABEL,
  lastRunMark,
  runEvents,
  SCHEDULED_JOB_ACTION_LABEL,
  SCHEDULED_JOB_STATE_LABEL,
  scheduledJobActions,
  scheduledJobStatusText,
} from "@ergo/protocol";
export type {
  ArchiveChoice,
  ArchiveListCardPayload,
  ArchiveListDecideInput,
  ArchiveListItem,
  CreateReminderParams,
  RunDividerPart,
  TaskTrigger,
  TaskTriggerKind,
  TriggerEvent,
  JobPauseReason,
  JobRun,
  JobRunState,
  ScheduledJob,
  ScheduledJobAction,
  ScheduledJobActionParams,
  RescheduleJobParams,
  RescheduleJobResult,
  RunJobNowParams,
  RunJobNowResult,
  SetVoiceAnnounceParams,
  SetVoiceAnnounceResult,
  ScheduledJobEventPayload,
  ScheduledJobState,
} from "@ergo/protocol";
// 日历（35 号票）：按月看的每一天（工作日判定、当天的提醒和定时作业），守护进程按月给出
export {
  CALENDAR_JOB_STATUS_LABEL,
  CALENDAR_JOB_STATUSES,
  CALENDAR_REMINDER_STATUS_LABEL,
  CALENDAR_REMINDER_STATUSES,
  CALENDAR_YEAR_SPAN,
  calendarDayCounts,
  calendarYearOptions,
  clockLabel,
  describeDuration,
  monthKey,
  occurrencesBetween,
  parseMonthKey,
  shiftMonthKey,
} from "@ergo/protocol";
export type { CalendarDay, CalendarDayCounts, CalendarExternalEntry, CalendarJobEntry, CalendarJobStatus, CalendarMonthView, CalendarReminderEntry, CalendarReminderStatus, ExternalCalendarEventPayload } from "@ergo/protocol";
// 工具调用的完整参数和返回（53 号票；56 号票的详情页按调用 id 现取）
export { TOOL_CALL_VALUE_MAX_BYTES } from "@ergo/protocol";
export type { ToolCallDetail, ToolCallEffect, ToolCallEffectObject, ToolResultMedia, TruncatedValue } from "@ergo/protocol";
// 文本类附件的预览（113 号票）：能不能预览（守护进程的内容接口和附件卡片共用一个判断）、报告页取到的内容和上限
export { MEDIA_TEXT_MAX_BYTES, textPreviewOf } from "@ergo/protocol";
export type { FilePartValue, HttpErrorCode, MediaTextView, TextPreviewMime } from "@ergo/protocol";
// HTML、SVG 附件在隔离的沙箱里预览（117 号票）：哪些能（按扩展名）、多大以内、报告页 <iframe sandbox> 的值
export { framePreviewOf, HTML_PREVIEW_SANDBOX, MEDIA_FRAME_MAX_BYTES } from "@ergo/protocol";
export type { FramePreview } from "@ergo/protocol";
// agent 之间的来信（115 号票）：哪些消息在会话里折成一行、一句话总结从哪来（守护进程写通知时用同一份标记）
export { firstSentence, LETTER_SUMMARY_MAX, LETTER_TAGS, letterKindOf, letterSummaryOf } from "@ergo/protocol";
export type { AgentLetterKind } from "@ergo/protocol";
// 长程任务的阶段详情从守护进程现取的（84 号票）；274 号票起有系统查到的结果（StageObserved）、看板卡上那一行用的个数（StageObservedCounts）
export type { StageClaimResult, StageEffect, StageEffectReach, StageFileChange, StageObserved, StageObservedCounts, StageSendKind, TaskStageView } from "@ergo/protocol";
// 重做之后复验没过（274 号票）：待办里那一条的两个动作和数据
export { REVERIFY_ACTIONS, reverifyNoticeData } from "@ergo/protocol";
export type { ReverifyNoticeData } from "@ergo/protocol";
// 完整内容的保留期和总量上限（65 号票）：清掉的原因、设置里占了多大和"现在就清理"
export type { ToolCallCleanupResult, ToolCallClearReason, ToolCallStorageView } from "@ergo/protocol";
// 设置里的"备份"（335 号票）
export type { BackupRunRecord, BackupStatusView } from "@ergo/protocol";
// 设置里的系统提示（71 号票）：占位符的写法和检查（守护进程和设置页共用一个函数），接口的形状
export { normalizePromptSource, parsePromptTemplate, promptIssuesText, renderPromptTemplate } from "@ergo/protocol";
export type {
  PromptNode,
  PromptTemplateIssue,
  PromptTemplateSpec,
  SystemPromptBody,
  SystemPromptDetail,
  SystemPromptGroup,
  SystemPromptList,
  SystemPromptPlaceholder,
  SystemPromptState,
  SystemPromptSummary,
} from "@ergo/protocol";
// 每个 agent 的会话里的 ⚙（114 号票）：单独的提示词两种写法、怎么查（和守护进程同一个函数）、面板的样子
export { AGENT_PROMPT_MODES, AGENT_PROMPT_STATE_LABEL, agentPromptProblem, PI_COMPACTION_DEFAULTS } from "@ergo/protocol";
export type {
  AgentClearKind,
  AgentCompactResult,
  AgentModelBody,
  AgentModelView,
  AgentCompactionState,
  AgentContextView,
  AgentPromptBody,
  AgentPromptMode,
  AgentPromptState,
  AgentPromptView,
  AgentSettingsKind,
  AgentSettingsView,
} from "@ergo/protocol";
// 角色（248 号票）：名字 + 音色绑成一个角色，每个 agent 只选一个；名字照 43 号票同一套规则查
export { AGENT_PROFILE_NAME_SOURCE_LABEL, AGENT_PROFILE_VOICE_SOURCE_LABEL, agentMaintainerName, DEFAULT_AGENT_ROLE_ID, defaultAgentName, followDefaultRoleLabel } from "@ergo/protocol";
export type {
  AgentIdentityView,
  AgentProfileNameSource,
  AgentProfileVoiceSource,
  AgentRoleAssignmentBody,
  AgentRoleAssignmentView,
  AgentRoleBody,
  AgentRoleOption,
  AgentRolesView,
  AgentRoleUpdateBody,
  AgentRoleView,
} from "@ergo/protocol";
// 设置里的"模型"（73 号票）：agent、思考档位、设置和设置页的样子、连通测试的结果；
// 319 号票起还有在网页上填 key 的请求体（{ key }）、写完之后什么时候生效（now / restart）；
// 自定义（OpenAI 兼容）服务商：provider id 固定是 custom、两种接口风格、跨字段合规的那条判法、列它有哪些模型的结果
export {
  checkModelCustom,
  CUSTOM_MODELS_MAX,
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_CUSTOM_PROVIDER_API,
  effectiveModelChoice,
  MAINTAINER_MODEL_AGENTS,
  MODEL_AGENT_LABEL,
  MODEL_AGENT_NOTE,
  MODEL_AGENTS,
  MODEL_KEY_MAX_LENGTH,
  MODEL_KEY_MIN_LENGTH,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelKeyOf,
  normalizeModelKey,
} from "@ergo/protocol";
export type {
  CustomProviderApi,
  CustomProviderCheck,
  MaintainerModelAgent,
  MaintainerModelView,
  ModelSwitchAt,
  ModelApiKeyStatus,
  ModelChoice,
  ModelCustomModel,
  ModelCustomModelsBody,
  ModelCustomModelsResult,
  ModelCustomProvider,
  ModelKeyBody,
  ModelKeyEffective,
  ModelKeyView,
  ModelKeyWriteResult,
  ModelOptionView,
  ModelProviderView,
  ModelAgent,
  ModelAgentOverride,
  ModelSettings,
  ModelSettingsBody,
  ModelSettingsView,
  ModelTestBody,
  ModelTestResult,
  ModelThinkingLevel,
  ModelVisionChoice,
  ModelVisionSource,
  SessionModelView,
} from "@ergo/protocol";
// 设置里 agent 的联网搜索、读网页（154 号票；162 号票起是 DeepSeek、浏览器、agent-browser 三种方式的队列）：名字、初始顺序、
// 实际用哪几种、至少留一个；消耗页的按次计费的联网调用
export {
  BUILTIN_WEB_CALL_PRICE_SOURCE,
  BUILTIN_WEB_CALL_PRICES,
  copyWebSettings,
  DEFAULT_WEB_SETTINGS,
  effectiveWebQueue,
  WEB_CALL_KIND_LABEL,
  WEB_CALL_KINDS,
  WEB_METHOD_LABEL,
  WEB_METHODS,
  webMethodUsable,
  webQueueFallback,
  webSettingsProblem,
} from "@ergo/protocol";
export type { UsageWeb, UsageWebAgentRow, UsageWebTally, WebCallKind, WebCallPrice, WebMethod, WebMethodEntry, WebSettings, WebSettingsBody, WebSettingsView } from "@ergo/protocol";
// 事件触发（77 号票）：事件来源登记表（来源、事件、字段、过滤条件）、事件触发方式的检查、在等什么事件的说法、
// 触发登记和提醒在等什么、一次运行最后一个事件、交给 agent 的结构化事件、流程步骤里的占位、事件触发的流程计划卡上的话
export {
  describeEventTrigger,
  EVENT_PLACEHOLDER_NOTE,
  EVENT_SOURCES,
  EVENT_WORKFLOW_GRANT_TEXT,
  eventKindOf,
  eventPassOf,
  eventPlaceholder,
  eventRecord,
  eventSourceOf,
  eventTriggerOf,
  eventTriggerProblems,
  filterValue,
  jobTriggerText,
  lastTriggerEvent,
  triggerFields,
} from "@ergo/protocol";
export type { EventFieldDescriptor, EventFilterDescriptor, EventKindDescriptor, EventNames, EventSourceDescriptor, EventTrigger } from "@ergo/protocol";
// 网页是哪一版（116 号票：服务端更新了网页，开着的页面提示刷新）
export { WEB_VERSION_META } from "@ergo/protocol";
export type { WebVersionEventPayload, WebVersionView } from "@ergo/protocol";
// 设置里的关于二狗、Debug 工具集（124 号票）：守护进程的版本和起来的时间、调试用的识别和合成
export { DEBUG_SPEAK_TEXT_MAX } from "@ergo/protocol";
export type { DaemonInfo, DaemonInfoParams, DebugRecognizeBody, DebugRecognizeResult, DebugSpeakBody, DebugSpeakResult } from "@ergo/protocol";
// 运行时核实过的用户原话、立项要求变更、从这里重做时直接改这一阶段（125 号票）
export { CHARTER_FIELD_LABEL, CHARTER_FIXED_NOTE, charterChangeItemText, USER_WORDS_BADGE, USER_WORDS_TITLE, userWordsSource } from "@ergo/protocol";
export type { CharterChangeCardPayload, CharterChangeItem, StageAcceptanceEdit, StageEdit, VerifiedUserWords } from "@ergo/protocol";
export type { StandardChangeCardPayload, StandardChangeItem, StandardOverride, StandardOverrideEntry, StandardOverrideView } from "@ergo/protocol";
// 现有项目补齐规范文档（262 号票）：缺的一份怎么说、两个选择
export { STANDARD_BACKFILL_CHOICE_LABEL, STANDARD_CUSTOM_DOC, standardBackfillDocText } from "@ergo/protocol";
export type { StandardBackfillCardPayload, StandardBackfillChoice, StandardBackfillDoc } from "@ergo/protocol";
// 守护进程转发本机服务的页面、内置浏览器（132 号票）：/apps/<应用名>/ 的写法
export { appUrl, isAppName, parseAppPath } from "@ergo/protocol";
// 运营方案（130 号票）："首版做完了"卡上的那一节、"运营方案变更"卡、项目上现在生效的运营方案
export {
  capabilitiesText,
  OPERATION_APPROACH_LABEL,
  OPERATION_CHANGE_LABEL,
  OPERATION_OUTCOME_LABEL,
  operationLine,
  OPERATIONS_GRANT_TEXT,
  OPERATIONS_MANUAL_PREFIX,
  OPERATIONS_PUT_IN_USE_LABEL,
  OPERATIONS_SECTION_TITLE,
  operationsConfirmationItems,
} from "@ergo/protocol";
export type { OperationItem, OperationResult, OperationService, OperationsChangeCardPayload, OperationsPlanView, ProjectOperationItem, ProjectOperations } from "@ergo/protocol";
// 网页上下指令（134 号票）：页面桥报的框（149 号票起选中的框带着框里的内容）、悬浮按钮上说的一段送识别（149 号票）、要交的文件、
// 授权的文件夹（138 号票起叫这个名字）和列子文件夹
export type {
  FolderBrowseView,
  FolderEntry,
  LocalFolder,
  LocalFoldersBody,
  LocalFoldersChangeBody,
  LocalFoldersView,
  PageChooser,
  PageCommandFile,
  PageCommandMark,
  PageField,
  PageFieldKind,
  PageFieldValue,
  PageVoiceBody,
  PageVoiceResult,
} from "@ergo/protocol";
export {
  AUTHORIZE_FOLDERS_ACTION,
  FOLDER_BROWSE_MAX,
  LOCAL_FOLDERS_MAX,
  PAGE_CANDIDATES_MAX,
  PAGE_CHOOSER_TARGET,
  PAGE_COMMAND_TEXT_MAX,
  PAGE_FIELD_VALUE_MAX,
  PAGE_FILE_MAX_BYTES,
  PAGE_FILES_ASK_OVER,
  PAGE_FILES_TOTAL_MAX_BYTES,
  pageFieldValueOf,
  pageUrlForModel,
} from "@ergo/protocol";
// 浏览侧边栏（147 号票）：侧边栏、悬浮按钮（149 号票）发的消息带的网页上下文、设备报的浏览器样子、秘书的网页工具转给设备的请求和结果、网页候选卡
// 164 号票：网页上能点的东西（PageElement）
export type {
  BrowsePickCardPayload,
  BrowsePickConfirmInput,
  BrowserOutcome,
  BrowserReplyParams,
  BrowserRequest,
  BrowserStatusParams,
  BrowsingContext,
  BrowsingMark,
  BrowsingPage,
  PageElement,
  PageElementRole,
} from "@ergo/protocol";
export { BROWSER_PAGE_TEXT_MAX, browsingLabel, browsingMarkOf, CHOOSER_TEXT, PAGE_ELEMENT_OPTION_MAX, PAGE_ELEMENT_OPTIONS_MAX, PAGE_ELEMENT_ROLES, PAGE_ELEMENT_VALUE_MAX, PAGE_ELEMENTS_DEFAULT, PAGE_ELEMENTS_MAX, selectedFieldText } from "@ergo/protocol";
// "浏览"的搜索引擎的结果页地址（182 号票挪到协议包：守护进程也要拼）
export { BROWSE_SEARCH_ENGINE_IDS, BROWSE_SEARCH_ENGINES, browseSearchEngineOf, browseSearchUrl, DEFAULT_BROWSE_SEARCH_ENGINE } from "@ergo/protocol";
export type { BrowseSearchEngineId } from "@ergo/protocol";
// 存进二狗的素材（165 号票）："浏览"的 ⋮ 菜单里存一页网页的请求和结果、存下的网页的素材的情境标签
export type { SaveWebPageBody, SaveWebPageResult } from "@ergo/protocol";
export { SAVED_WEB_PAGE_CONTEXT } from "@ergo/protocol";
// 运营手段"服务"、项目的服务（133 号票）：上线到哪了、在不在线、入口
export { OPERATION_SERVICE_MEANS, projectPower, serviceCanOpen, serviceEnvText, serviceOpenLabel, serviceShown, serviceStateText } from "@ergo/protocol";
// 服务首页的缩略图（140 号票）：多久算旧、地址里的 seen
export { SERVICE_THUMBNAIL_REFRESH_MS, serviceThumbnailSeen } from "@ergo/protocol";
export type { ProjectPowerState, ProjectPowerView, ProjectServicesAction, ProjectServicesActionParams, ProjectServicesEventPayload, ProjectServiceView, ServiceEntryCardPayload, ServiceStateKind } from "@ergo/protocol";
// 项目规范（258 号票）：规范里的文档、写了 / 只有模板 / 缺、只读接口的返回
export {
  PROJECT_STANDARD_LATEST,
  STANDARD_CHECKLIST_ITEM_LABEL,
  STANDARD_CHECKLIST_TO,
  STANDARD_DOC_LABEL,
  STANDARD_DOC_STATE_LABEL,
  standardDocState,
  standardHasNewer,
  standardOverrideTarget,
  standardOverrideText,
} from "@ergo/protocol";
export type { ProjectStandardView, StandardDocKey, StandardDocState, StandardDocView, StandardOverrideKind } from "@ergo/protocol";
// 转入使用的确认（259 号票）：谁发起的、两个选择、标题、检查清单里没做到的
export { checklistMissing, GO_LIVE_BY_LABEL, GO_LIVE_CHOICE_LABEL, GO_LIVE_CHOICES, goLiveTitle } from "@ergo/protocol";
export type { GoLiveBy, GoLiveCardPayload, GoLiveChecklistItem, GoLiveChoice, StandardChecklistItem } from "@ergo/protocol";
// 会话树和会话回退（150 号票）：当前分支、废弃分支、分叉点、回退点、回退前的确认
export type {
  BranchFilesRewind,
  BranchFork,
  BranchSummaryPart,
  ConversationBranch,
  ConversationBranches,
  RollbackEffect,
  RollbackPreview,
  RollbackSessionParams,
  RollbackSessionResult,
  RollbackTarget,
  SeqRange,
  SessionBranchEventPayload,
} from "@ergo/protocol";
export { agentSessionStart, branchAt, branchChain, branchForks, findBranch, onBranchPath, pathRanges, ROLLBACK_LABEL, rollbackEnabled, ROOT_BRANCH } from "@ergo/protocol";
// 废弃分支的预览、详情、切换、申请撤回（151 号票）
export type {
  BranchEffect,
  BranchView,
  EffectUndoRequestedEventPayload,
  RequestEffectUndoParams,
  RequestEffectUndoResult,
  SwitchBranchParams,
  SwitchBranchResult,
} from "@ergo/protocol";
export { branchOwnRanges, subtractRanges, switchedTree } from "@ergo/protocol";
// 原型演会话回退（150 号票，prototype/fake-branches.ts）：照守护进程的算法长出新分支、算被放弃的那一段
export { grownTree, inRanges, nextBranchId, rangesFrom, rollbackFork, SINGLE_BRANCH } from "@ergo/protocol";
// 给用户看的编号写成"编号「简短描述」"（159、163 号票）：写法在协议包，名字由 readable-ids.ts 从状态层现取
export { deletedIdLabel, idLabel, maintainerIdLabel, type MaintainerOwner, namedIdLabel, shortDescription } from "@ergo/protocol";
// 长程任务阶段开始的回退点（152 号票）：维护者会话频道上 stage_start 的记号、回退点的说法、阶段框底部那一个、确认框里多的那一句
export type { StageStartEventPayload, StageStartVia } from "@ergo/protocol";
export { STAGE_BOX_UNDO, STAGE_ROLLBACK_CONTINUES, stageRollbackLabel } from "@ergo/protocol";
// 流程步骤开始的回退点（153 号票）：同一条 stage_start 记号带 stepId，说法"撤回到步骤「…」开始前"；一次运行的分段线也是这段会话的开头
export { rollbackSegmentStart, startRollbackLabel, stepRollbackLabel } from "@ergo/protocol";
// 流程撤回之后等你（155 号票）：确认框里多的那一句、"流程在等你"事项（一分钟没说话提醒一次）的说法和数据
export type { RollbackWaitNoticeData } from "@ergo/protocol";
export { JOB_RUN_ROLLED_BACK_REASON, ROLLBACK_WAIT_ACK, ROLLBACK_WAIT_REMIND_MS, ROLLBACK_WAIT_SETTLED, rollbackWaitNotice, WORKFLOW_ROLLBACK_WAITS } from "@ergo/protocol";
// 多语言（168 号票）：t()、单复数、回退中文、按语言格式化；语言文件的形状；全局语言设置的事件、接口
export {
  activeLanguage,
  activeLocale,
  activeLocaleFrom,
  catalogsFromFiles,
  DEFAULT_LANGUAGE,
  formatDate,
  formatList,
  formatNumber,
  formatRelativeTime,
  intlLocale,
  localeRevision,
  mergeMessages,
  missingCount,
  onLocaleChange,
  pluralCategory,
  setActiveLocale,
  setMissingMessageHandler,
  t,
  tParts,
  tTable,
  WEB_NAMESPACES,
  // 插件的状况（193 号票）：网页按它装、停自己的网页插件
  PLUGIN_STATES,
} from "@ergo/protocol";
export type { PluginState, PluginStatusEventPayload, PluginStatusView } from "@ergo/protocol";
// 设置 · 插件（211 号票）：清单、停用 / 启用 / 移除的结果、连数据删的记录
export type { PluginAction, PluginActionResult, PluginBrings, PluginDataPurgedEventPayload, PluginInfo, PluginPurgeCounts, PluginsView } from "@ergo/protocol";
// agent 运行时（286 号票）：维护者用的运行时（pi 或者插件登记的）连同能力清单，GET /api/runtimes 取；289 号票起新建时选、⚙ 里换、卡上标出
export { PI_RUNTIME_ID, RUNTIME_OPERATIONS, RUNTIME_SWITCH_STATES, runtimeIdOf, runtimeShown, runtimeTitleOf, selectableRuntimes, TAKEOVER_ACTIONS, TAKEOVER_KINDS, TAKEOVER_PLACES, takeoverPlaceOf, WORK_FOLDER_NAME_MAX, workFolderName } from "@ergo/protocol";
export type {
  AgentRuntimeBody,
  AgentRuntimeStateView,
  AgentRuntimeView,
  ResumableSessionView,
  RuntimeCapabilities,
  RuntimeChoice,
  RuntimeModelView,
  RuntimeOperation,
  RuntimeOptions,
  RuntimeSettingView,
  RuntimeSwitchState,
  RuntimesView,
  // 290 号票：从运行时已有的会话接管
  RuntimeSessionsView,
  RuntimeTakeover,
  TakeoverAction,
  TakeOverBody,
  TakeoverKind,
  TakeoverPlace,
  TakeOverResult,
  // 305 号票：新建时选工作文件夹
  RuntimeFolderBody,
  WorkFolderCheckResult,
  WorkFolderChoice,
} from "@ergo/protocol";
// 设置 · 数据源（295 号票）：插件登记的数据源（连接状态、上次同步和条数、两种用法、敏感类别）和共用的导入文件夹
export { DATA_SOURCE_USAGES, IMPORTED_SHOWN } from "@ergo/protocol";
export type {
  DataSourceAction,
  DataSourceActionBody,
  DataSourceActionResult,
  DataSourceConnection,
  DataSourcePurgeCounts,
  DataSourceSensitiveView,
  DataSourcesView,
  DataSourceSyncTrigger,
  DataSourceItemView,
  DataSourceSyncView,
  DataSourceUsage,
  DataSourceUsageView,
  DataSourceView,
  ImportedFileView,
  ImportFileHint,
  ImportFileProblem,
  ImportFolderAction,
  ImportFolderActionBody,
  ImportFolderActionResult,
  ImportFolderView,
  DataSourcePushBody,
  DataSourcePushResult,
  DataSourceRawDay,
  DataSourceRawView,
} from "@ergo/protocol";
// 设置 · 组件（323 号票）：模型、语音这些大件按需下载——每个组件装了没有、大小、版本、默认装不装、下载进度；功能灰不灰
export { COMPONENT_ACTIONS, COMPONENT_FEATURES, COMPONENT_STATES, componentBusy, missingComponentFor } from "@ergo/protocol";
export type {
  ComponentAction,
  ComponentDefault,
  ComponentFeatureGate,
  ComponentFeatureView,
  ComponentImportResult,
  ComponentPhase,
  ComponentProgress,
  ComponentsView,
  ComponentState,
  ComponentView,
} from "@ergo/protocol";
// 手机上的二狗 App 读本机（299 号票）："手机"插件的数据源、App 交来的样子；300 号票加了照片的时间地点、位置；
// 308 号票加了系统地名、"常去的地方"那一块
export {
  isPhonePlacesView,
  phoneAddressLabel,
  PHONE_ADDRESS_PART_MAX,
  PHONE_PLACE_NAME_MAX,
  PHONE_PLACE_RADII_M,
  PHONE_PLACE_RADIUS_DEFAULT_M,
  PHONE_CALENDAR_EVENTS_MAX,
  PHONE_CALENDAR_SOURCE,
  PHONE_CALENDAR_SYNC_EVERY_MS,
  PHONE_CONTACTS_MAX,
  PHONE_CONTACTS_SOURCE,
  PHONE_LOCATION_POINTS_MAX,
  PHONE_LOCATION_SOURCE,
  PHONE_PHOTOS_MAX,
  PHONE_PHOTOS_SOURCE,
  phoneCalendarWindow,
  phonePhotosWindow,
} from "@ergo/protocol";
export type {
  PhoneAddress,
  PhonePlaceSuggestionView,
  PhonePlacesView,
  PhonePlaceView,
  PhoneCalendarEvent,
  PhoneCalendarPush,
  PhoneCalendarState,
  PhoneContact,
  PhoneContactsPush,
  PhoneContactsReply,
  PhoneLocationPoint,
  PhoneLocationPush,
  PhonePhoto,
  PhonePhotosPush,
} from "@ergo/protocol";
// Looki 的"存一份到本地"（307 号票）：设置 · 数据源里 Looki 那一块的数据、填设置时交的值
export { isLookiArchiveView, LOOKI_ARCHIVE_DEFAULT_KINDS, LOOKI_ARCHIVE_KINDS, LOOKI_BACKFILL_DEFAULT_DAYS } from "@ergo/protocol";
export type { LookiArchiveKind, LookiArchiveOp, LookiArchiveSaved, LookiArchiveView, LookiArchiveWorking, LookiBackfillView } from "@ergo/protocol";
export type {
  ActiveLocale,
  LanguageEventPayload,
  LanguageResult,
  LocaleDictionaryView,
  LocaleEntry,
  LocaleEventPayload,
  LocaleListView,
  LocaleMeta,
  LocaleProblemCode,
  LocaleProblemView,
  LocaleSource,
  LocaleSummary,
  MessageParams,
  Messages,
} from "@ergo/protocol";
// 记忆的推理库只读看的形状（233 号票）：网页"记忆"页的结论、证据与推理、问题箱
export { MEMORY_CLAIMS_DEFAULT, MEMORY_CLAIMS_MAX, MEMORY_CLAIM_STATUSES, MEMORY_CLAIM_TIERS, MEMORY_CONFIDENCES, MEMORY_EPISTEMICS, MEMORY_QUESTION_STATUSES } from "@ergo/protocol";
// 264 号票：问题的经过（问过、跳过、答了……）、回答读成什么；记忆的设置（顺口问开不开）
export { DEFAULT_MEMORY_SETTINGS, MEMORY_ANSWER_VERDICTS, MEMORY_QUESTION_EVENTS } from "@ergo/protocol";
export type { MemoryAnswerVerdict, MemoryQuestionEvent, MemoryQuestionLogEntry, MemorySettingsBody, MemorySettingsView } from "@ergo/protocol";
// 安全和预算的两个开关（315 号票）：设置 · 关注类别那一页上
export type { SafetySettingsBody, SafetySettingsView } from "@ergo/protocol";
// 首次设置向导（319 号票）：五步是哪五步、顺序，GET /api/setup 的形状、POST 标一步的请求体
export { SETUP_STEPS } from "@ergo/protocol";
export type { SetupMarkBody, SetupStepId, SetupStepView, SetupView } from "@ergo/protocol";
// 体检（319 号票的 319b）：八项检查是哪八项、GET /api/doctor 的形状（每项的事实按 id 各不同）；
// doctorCheck / doctorDataOf 是取某一项、按 id 收窄事实类型的两个小函数
export { DOCTOR_CHECKS, DOCTOR_FIX_UNKNOWN, doctorCheck, doctorDataOf } from "@ergo/protocol";
export type { DoctorCheckData, DoctorCheckDataById, DoctorCheckId, DoctorCheckView, DoctorView } from "@ergo/protocol";
// 330 号票：做法（交互策略）列表、猜测为什么还是猜测
export { MEMORY_STRATEGY_STATUSES } from "@ergo/protocol";
export type { MemoryGuessReason, MemoryStrategiesView, MemoryStrategyStatus, MemoryStrategyView } from "@ergo/protocol";
// 284 号票：了解你访谈——主题的名字、约访卡的负载、GET / POST /api/memory/interview 的形状
export { INTERVIEW_TOPIC_LABEL, INTERVIEW_TOPICS } from "@ergo/protocol";
export type { InterviewCardPayload, InterviewFileItem, InterviewFilesCardPayload, InterviewStartResult, InterviewStatusView, InterviewTopic } from "@ergo/protocol";
export type {
  MemoryClaimBrief,
  MemoryClaimDetailClaim,
  MemoryClaimDetailView,
  MemoryClaimLinkView,
  MemoryClaimListPage,
  MemoryClaimQuery,
  MemoryClaimStatus,
  MemoryClaimTier,
  MemoryConfidence,
  MemoryEpistemic,
  MemoryEvidenceQuote,
  MemoryEvidenceSource,
  MemoryGraphStatus,
  MemoryInferenceView,
  MemoryLastNight,
  MemoryLinkWeight,
  MemoryNightlyState,
  MemoryPremiseNode,
  MemoryQuestionItem,
  MemoryQuestionKind,
  MemoryQuestionStatus,
  MemoryQuestionsView,
  MemoryRevisionChange,
  MemoryRevisionOp,
  MemoryRevisionView,
  MemoryWriteActor,
  MemoryWriteOp,
  MemoryStatusCounts,
  MemorySummaryView,
  MemoryTierCounts,
} from "@ergo/protocol";
// 个人档案（281 号票）：字段叫什么、哪些算号码、号码怎么逐位分组、值合不合规；档案页的接口和核对卡的形状。
// 283 号票：生日、纪念日的每年提醒（哪些字段、认公历日子、默认提前几天）、二狗了解到的、候选核对卡
// 302 号票：内置字段"纪念日"（能有几个、各带名字；档案上的先后）
export {
  ANNIVERSARY_FIELD,
  anniversaryFieldOf,
  anniversaryNameOf,
  isAnniversaryField,
  personalFieldOrder,
  ANNUAL_REMINDER_DEFAULT_DAYS,
  ANNUAL_REMINDER_MAX_DAYS,
  isAnnualField,
  monthDayOf,
  builtinFields,
  checkPersonalNote,
  checkPersonalValue,
  checkPersonName,
  customFieldOf,
  CUSTOM_FIELD_LABEL_MAX,
  customLabelOf,
  isNumberField,
  numberGroups,
  PERSON_FIELDS,
  personalFieldLabel,
  personalFieldOf,
  SELF_FIELDS,
  SELF_PERSON_ID,
  spelledNumber,
  // 285 号票：档案里的人分组（家人、重要的人、其他人），没选的按关系猜
  guessPersonGroup,
  isPersonGroup,
  PERSON_GROUPS,
} from "@ergo/protocol";
export type {
  AddPersonBody,
  PersonGroup,
  PersonalFieldValue,
  PersonalFieldView,
  PersonalFileCardField,
  PersonalFileCardPayload,
  PersonalFileChangeBody,
  PersonalFileDeleteBody,
  PersonalFileDeleteMode,
  PersonalFileDeleteResult,
  PersonalFileDeleteTarget,
  PersonalFileKind,
  PersonalFileSource,
  PersonalFilesView,
  PersonalFileSummary,
  PersonalFileView,
  PersonalAnnualView,
  PersonalFileCardRemind,
  PersonalFileExecuteInput,
  PersonalFileLearnedView,
  PersonalFileSuggestCardPayload,
  PersonalFileSuggestInput,
  PersonalFileSuggestItem,
  PersonalLearnedClaim,
  PersonalLearnedFact,
  PersonalLearnedQuote,
} from "@ergo/protocol";
// 运行时的提问卡（288 号票）：Claude Code 自己要问你的选择题、退出计划模式的批准；"提交回答"能不能点照协议包的同一条规矩
export { runtimeAnswerProblem } from "@ergo/protocol";
export type { RuntimeChoiceAnswer, RuntimeChoiceQuestion, RuntimeQuestion, RuntimeQuestionCardPayload, RuntimeQuestionReply } from "@ergo/protocol";
