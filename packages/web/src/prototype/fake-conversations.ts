// 原型的假事件：卡片和各个会话的历史。由假连接按频道编上序号，当作"服务端已有的事件"推给前端。
// 14 种卡片各至少出现一次（聊天、待我处理或任务详情里）。
import {
  type ApprovalPayload,
  CARD_TYPE_LABEL,
  type CharterPayload,
  type PairingPayload,
  type ParallelPayload,
  type PlanPayload,
  type ProgressPayload,
  type QuestionsPayload,
  type SuggestProjectPayload,
  type SuggestTaskPayload,
  type WorkOrderPayload,
} from "../model/cards.ts";
import {
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  CARD_TYPE_VERSIONS,
  type Card,
  type CardType,
  CHANNELS,
  type ConversationId,
  type Disposition,
  EVENT_TYPES,
  type MemoryDeleteCardPayload,
  type MessageEnvelope,
  type MessagePart,
  type MessageScope,
  maintainerChannel,
  ownMaintainerId,
  type Plan,
  type PlanChangeCardPayload,
  type QuickActionCardPayload,
  type ReminderCardPayload,
  type JobRun,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Speaker,
  type Task,
  type TaskEventPayload,
  type ToolCallOutcome,
  type ToolNature,
  toolNatureOf,
  type VoiceRecord,
} from "../state/index.ts";
import { WORKFLOW_CARDS, WORKFLOW_HISTORY } from "./fake-workflow.ts";

/** 时间：月-日 + 时:分（2026 年，东八区） */
export function at(md: string, hm: string): string {
  return `2026-${md}T${hm}:00+08:00`;
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
const think = (t: string): MessagePart => ({ type: "reasoning", text: t });
const cardRef = (cardId: string): MessagePart => ({ type: "card_ref", cardId });
const divider = (workOrderId: string, title: string, from: string): MessagePart => ({ type: "work_order_divider", workOrderId, title, from });

let callNo = 0;
/** 一次工具调用。nature 照守护进程会记的写（54 号票）；不写的按工具名估（和旧记录一样） */
function tool(
  name: string,
  argsSummary: string,
  o: { categories?: string[]; disposition?: Disposition; withinGrant?: boolean; generic?: boolean; outcome?: ToolCallOutcome; result?: string; nature?: ToolNature } = {},
): MessagePart {
  callNo += 1;
  const part = {
    type: "tool_call" as const,
    callId: `call-${callNo}`,
    tool: name,
    argsSummary,
    categoryTitles: o.categories ?? [],
    disposition: o.disposition ?? "do",
    withinGrant: o.withinGrant ?? false,
    genericBash: o.generic ?? false,
    outcome: o.outcome ?? "done",
    resultSummary: o.result,
  };
  return { ...part, nature: o.nature ?? toolNatureOf(part) };
}

let msgNo = 0;
function msg(conversation: ConversationId, speaker: Speaker, time: string, ...parts: MessagePart[]): MessageEnvelope {
  msgNo += 1;
  return { id: `msg-${msgNo}`, conversation, speaker, time, parts };
}

/** 消息的归属（任务、阶段）：守护进程在维护者会话里的消息上带着，缩小后的底色带、书脊、任务卡按它分（55 号票） */
const SCOPES = new Map<string, MessageScope>();
function scoped(scope: MessageScope, m: MessageEnvelope): MessageEnvelope {
  SCOPES.set(m.id, scope);
  return m;
}

// ---------- 卡片 ----------

function card(id: string, type: CardType, payload: unknown, o: Partial<Card> = {}): Card {
  return { id, type, typeVersion: CARD_TYPE_VERSIONS[type], version: 1, status: "pending", payload, text: fakeCardText(type, payload), createdAt: at("10-07", "09:00"), ...o };
}

/**
 * 假卡片的纯文本（不认识这种卡的前端显示它；54 号票起缩放的要点层也取它的第一行）：种类加负载里的标题、名字或目标，
 * 都没有就写"（原型的假卡片）"
 */
function fakeCardText(type: CardType, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const what = [p.title, p.name, p.taskTitle, p.goal, p.stageTitle, p.toolTitle].find((x): x is string => typeof x === "string" && x !== "");
  return what ? `${CARD_TYPE_LABEL[type]}：${what}` : "（原型的假卡片）";
}

export const MAINTAINERS = {
  photos: maintainerChannel("task-photos"),
  bills: maintainerChannel("task-bills"),
  ledger: maintainerChannel("project-ledger"),
  blog: maintainerChannel("project-blog"),
  appliance: maintainerChannel("project-appliance"),
} as const;

/** 全局的九类关注类别（假数据：和守护进程内置的一样） */
const GLOBAL_CATEGORIES = [
  { id: "spend_money", title: "花钱" },
  { id: "external_send", title: "以我的名义对外发送或发布" },
  { id: "delete_or_overwrite", title: "删除或覆盖（项目档案和工作目录内）" },
  { id: "irreversible_commit", title: "不可逆的提交" },
  { id: "account_security", title: "账户与安全" },
  { id: "outside_project", title: "越出项目目录" },
  { id: "memory_out_of_scope", title: "越出记忆范围" },
  { id: "unplanned_work_order", title: "计划外的工单" },
  { id: "unknown_write", title: "未知的写操作" },
];

const planBills: PlanPayload = {
  taskId: "t-bills",
  taskTitle: "每周汇总银行账单",
  revision: 1,
  planId: "t-bills-p1",
  goal: "每周一早上把上周三张卡的账单导出、去重、分类，汇总进「记账本」，给我一页周报。",
  globalCategories: GLOBAL_CATEGORIES.map((c) => c.id),
  grantInfo: {
    "read-statements": { toolTitle: "读邮件", categoryTitles: [], disposition: "do" },
    "write-scripts": { toolTitle: "写文件", categoryTitles: [], disposition: "do" },
    "append-summary": { toolTitle: "写文件", categoryTitles: ["删除或覆盖（项目档案和工作目录内）"], disposition: "planned_only" },
  },
  plan: {
    stages: [
      {
        stageId: "s1",
        title: "摸清账单来源",
        deliverables: ["三张卡的账单来源说明和样例文件"],
        acceptance: [{ criterion: "三张卡各拿到一份上周的样例", method: "script", script: "ls samples | wc -l" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [{ id: "read-statements", tool: "mail_read", title: "读邮箱里带「月结单」的邮件附件", scope: { folder: ["甲银行", "乙银行"] }, maxUses: 20 }], temporalRules: [] },
        budget: { tokens: 80_000, toolCalls: 40 },
      },
      {
        stageId: "s2",
        title: "写导出和去重脚本",
        deliverables: ["导出脚本、去重脚本和它们的测试"],
        acceptance: [
          { criterion: "测试全部通过", method: "script", script: "npm test" },
          { criterion: "脚本不往外发任何东西", method: "review" },
        ],
        mode: "steps",
        steps: ["导出", "去重", "分类", "写测试"],
        dependsOn: ["s1"],
        policy: { grants: [{ id: "write-scripts", tool: "write", title: "在记账本的工作目录里写、改脚本", scope: { path: "记账本/weekly" } }], temporalRules: [{ id: "commit-before-overwrite", title: "删除或覆盖记账本里的历史数据之前，必须已经 git 提交", trigger: { tool: "delete" }, require: { before: { tool: "git_commit" } }, on_violation: "pull_back" }] },
        budget: { tokens: 200_000, toolCalls: 120 },
        groupId: "g-build",
      },
      {
        stageId: "s3",
        title: "接进记账本、出第一份周报",
        deliverables: ["记账本里新增的周汇总和第一份周报"],
        acceptance: [{ criterion: "你看过第一份周报，觉得能用", method: "user" }],
        mode: "steps",
        steps: ["追加周汇总", "出周报"],
        dependsOn: ["s2"],
        policy: { grants: [{ id: "append-summary", tool: "write", title: "往记账本的数据表里追加周汇总（不改历史数据）", scope: { path: "记账本/data/weekly" }, maxUses: 4 }], temporalRules: [] },
        budget: { tokens: 120_000, toolCalls: 60 },
        groupId: "g-build",
      },
    ],
    stageGroups: [{ groupId: "g-build", title: "建设", policy: { grants: [], temporalRules: [] } }],
    toolkit: { skills: ["demo-pdf-reader"], mcp: ["demo-mail-readonly"], bash: true, network: false },
    projects: [{ project: "记账本", changes: ["新增 weekly/ 目录：导出、去重、汇总脚本", "数据表加一张周汇总表"] }],
    memoryScope: "记账本相关的偏好",
    watchCategories: GLOBAL_CATEGORIES,
    assumptions: ["甲银行和乙银行的账单可以从邮箱里的月结单附件拿到", "丙银行的账单你会每月手动放进下载目录", "分类沿用记账本现有的规则"],
    stops: { count: 2, where: ["第一份周报由你验收", "丙银行的账单要你手动放进下载目录"] },
    tokenEstimate: 400_000,
  },
};

const planPhotos: PlanPayload = {
  taskId: "t-photos",
  taskTitle: "家庭照片整理与去重",
  revision: 1,
  planId: "t-photos-p1",
  goal: "把相册库和家庭网盘里 2015 年以来的照片去重、按事件归档，重复的先放回收区，不直接删。",
  globalCategories: GLOBAL_CATEGORIES.map((c) => c.id),
  grantInfo: {
    "move-duplicates": { toolTitle: "通用 bash", categoryTitles: [], disposition: "do" },
    "rename-dirs": { toolTitle: "改名", categoryTitles: ["删除或覆盖（项目档案和工作目录内）"], disposition: "planned_only" },
  },
  removedGrants: [{ id: "rename-dirs", tool: "move", title: "在相册库里新建、改名事件目录", scope: { path: "相册库" } }],
  plan: {
    stages: [
      {
        stageId: "s1",
        title: "盘点两边的照片",
        deliverables: ["照片清单和重复估计"],
        acceptance: [{ criterion: "清单覆盖两个目录", method: "script", script: "node check-list.mjs" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 60_000, toolCalls: 40 },
      },
      {
        stageId: "s2",
        title: "找出重复并移进回收区",
        deliverables: ["重复清单", "重复照片移进回收区"],
        acceptance: [{ criterion: "回收区里的每张都能在保留区找到同一张", method: "script", script: "node check-recycle.mjs" }],
        mode: "steps",
        steps: ["比对哈希", "移进回收区"],
        dependsOn: ["s1"],
        policy: { grants: [{ id: "move-duplicates", tool: "bash", title: "把重复照片移进回收区（不超过 2000 张）", scope: {}, maxUses: 2000 }], temporalRules: [{ id: "recycle-not-delete", title: "照片一律先移进回收区，不许直接删除", trigger: { tool: "delete" }, on_violation: "block" }] },
        budget: { tokens: 150_000, toolCalls: 200 },
      },
      {
        stageId: "s3",
        title: "按事件归档",
        deliverables: ["按事件分好的目录"],
        acceptance: [{ criterion: "抽查 20 个事件目录", method: "review" }],
        mode: "open",
        dependsOn: ["s2"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 200_000, toolCalls: 150 },
      },
      {
        stageId: "s4",
        title: "你过目",
        deliverables: ["归档结果的说明"],
        acceptance: [{ criterion: "你确认归档结果", method: "user" }],
        mode: "steps",
        steps: ["写说明"],
        dependsOn: ["s3"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 20_000, toolCalls: 10 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: true, network: false },
    projects: [
      { project: "相册库", changes: ["扫描重复照片，出清单", "按事件新建目录"] },
      { project: "家庭网盘", changes: ["扫描「手机备份」目录，出清单"] },
    ],
    watchCategories: GLOBAL_CATEGORIES,
    assumptions: ["NAS 上的照片目录是 /示例/相册", "家庭网盘的「手机备份」目录和相册库有大量重复"],
    stops: { count: 1, where: ["归档结果由你过目"] },
    tokenEstimate: 430_000,
  },
};

/** 照片任务的计划变更（14 号票的真负载）：第 3 阶段要加一个读照片元数据的 MCP */
const photosWithExif: Plan = { ...planPhotos.plan, toolkit: { ...planPhotos.plan.toolkit, mcp: ["demo-exif-reader"] } };
const planChangePhotos: PlanChangeCardPayload = {
  taskId: "t-photos",
  taskTitle: "家庭照片整理与去重",
  planId: "t-photos-p2",
  revision: 2,
  basePlanId: "t-photos-p1",
  why: "按事件归档要读照片的拍摄时间和地点，用 bash 一张张读太慢。",
  changes: [{ kind: "toolkit", expands: true, before: planPhotos.plan.toolkit, after: photosWithExif.toolkit }],
  affectedStages: [{ stageId: "s3", title: "按事件归档" }],
  plan: photosWithExif,
  grantInfo: planPhotos.grantInfo,
};

/** 博客迁移的计划变更：第 2 阶段加一项改 DNS 记录的授权 */
const blogPlan: Plan = {
  stages: [
    {
      stageId: "s1",
      title: "迁移文章",
      deliverables: ["Astro 站点"],
      acceptance: [{ criterion: "构建通过", method: "script", script: "npm run build" }],
      mode: "open",
      dependsOn: [],
      policy: { grants: [], temporalRules: [] },
      budget: { tokens: 120_000, toolCalls: 80 },
    },
    {
      stageId: "s2",
      title: "上线",
      deliverables: ["预览地址"],
      acceptance: [{ criterion: "你看过预览", method: "user" }],
      mode: "open",
      dependsOn: ["s1"],
      policy: { grants: [], temporalRules: [] },
      budget: { tokens: 30_000, toolCalls: 30 },
    },
  ],
  stageGroups: [],
  toolkit: { skills: [], mcp: [], bash: true, network: true },
  projects: [],
  memoryScope: "（第一阶段不授予）",
  watchCategories: GLOBAL_CATEGORIES,
  assumptions: [],
  stops: { count: 1, where: ["上线前你看预览"] },
  tokenEstimate: 150_000,
};
const dnsGrant = { id: "dns", tool: "http_request", title: "把 blog 子域名指向新站点", scope: { url: "https://dns.example.com/api/records/blog" }, maxUses: 2 };
const planChangeBlog: PlanChangeCardPayload = {
  taskId: "t-blog",
  taskTitle: "博客迁移到 Astro",
  planId: "t-blog-p2",
  revision: 2,
  basePlanId: "t-blog-p1",
  why: "你昨天在会话里说「测完直接切过去吧」，原计划没写切 DNS。",
  changes: [{ kind: "grant_added", expands: true, owner: { kind: "stage", id: "s2", title: "上线" }, grant: dnsGrant }],
  affectedStages: [{ stageId: "s2", title: "上线" }],
  plan: { ...blogPlan, stages: [blogPlan.stages[0]!, { ...blogPlan.stages[1]!, policy: { grants: [dnsGrant], temporalRules: [] } }] },
  grantInfo: { dns: { toolTitle: "发 HTTP 请求", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only" } },
};

export const FAKE_CARDS: Card[] = [
  card("c-rem-1", "reminder", {
    reminderId: "r-rent",
    text: "交房租",
    schedule: { kind: "monthly", time: "09:00", days: [8] },
    status: "pending",
    nextAt: at("10-08", "09:00"),
  } satisfies ReminderCardPayload),
  card(
    "c-qa-1",
    "quick_action",
    {
      actionId: "qa-fake-1",
      conversation: "secretary",
      action: { type: "pause_task", params: { taskId: "t-car" } },
      name: "暂停任务",
      title: "暂停任务：车险比价",
      target: "车险比价",
      explicit: true,
      categories: [],
      disposition: "do",
      result: "任务已暂停",
    } satisfies QuickActionCardPayload,
    { version: 1, status: "handled", outcome: { action: "execute" }, handledAt: at("10-06", "20:13") },
  ),
  card("c-qa-2", "quick_action", {
    actionId: "qa-fake-2",
    conversation: "secretary",
    action: { type: "pause_scheduled_job", params: { jobId: "sj-daily-bills", days: 7 } },
    name: "暂停定时作业",
    title: "暂停定时作业一周：每天 21:00 汇总当天账单（记账本）",
    target: "每天 21:00 汇总当天账单（记账本）",
    content: "暂停一周，下周一 21:00 自动恢复",
    explicit: false,
    categories: [],
    disposition: "ask_first",
  } satisfies QuickActionCardPayload),
  card("c-st-1", "suggest_task", { title: "每周自动导出并汇总银行账单", why: "这周你手动导出了三次账单，每次都在晚上 10 点以后。", taskId: "t-bills" } satisfies SuggestTaskPayload, {
    version: 2,
    status: "handled",
    outcome: { action: "start_task" },
  }),
  card("c-st-2", "suggest_task", { title: "整理 NAS 上的旧电影", why: "NAS 剩余空间不到 8%，电影目录占了 61%。" } satisfies SuggestTaskPayload),
  card("c-sp-1", "suggest_project", { name: "家电档案", goal: "把家里电器的保修单、说明书和维修记录收在一处，保修到期前提醒我。" } satisfies SuggestProjectPayload, {
    version: 2,
    status: "handled",
    outcome: { action: "kickoff" },
  }),
  card("c-sp-2", "suggest_project", { name: "健身记录", goal: "记下每次训练和体重，每月给我一张趋势图。" } satisfies SuggestProjectPayload),
  card("c-q-1", "questions", {
    intro: "先对齐几件事，每题我都给了推荐：",
    questions: [
      { id: "q1", question: "去几天？", options: ["5 天（11-14 到 11-18）", "7 天（11-13 到 11-19）", "我再想想"], recommended: "5 天（11-14 到 11-18）" },
      { id: "q2", question: "住哪一带？", options: ["新宿", "上野", "银座"], recommended: "上野", why: "你上次说想离博物馆近一点" },
      { id: "q3", question: "订票这一步要不要我做？", options: ["只给我行程计划，票我自己订", "你订，下单前问我"], recommended: "只给我行程计划，票我自己订" },
    ],
  } satisfies QuestionsPayload),
  card("c-md-1", "memory_delete", {
    actionId: "qa-fake-3",
    conversation: "secretary",
    mode: "forget",
    matches: [
      { materialId: "mat-fake-1", kind: "用户发言", excerpt: "其实我在考虑要不要换工作", time: at("09-03", "22:41"), conversation: "secretary" },
      { materialId: "mat-fake-2", kind: "用户发言", excerpt: "猎头又来找了，薪资涨 30%", time: at("09-11", "21:05"), conversation: "secretary" },
      { materialId: "mat-fake-3", kind: "用户发言", excerpt: "先别跟任何人说换工作的事", time: at("09-12", "08:15"), conversation: "secretary" },
    ],
  } satisfies MemoryDeleteCardPayload),
  card("c-plan-bills", "plan", planBills, { urgency: "blocking", createdAt: at("10-07", "08:40") }),
  card("c-plan-photos", "plan", planPhotos, { version: 2, status: "handled", outcome: { action: "confirm", note: "勾掉 1 项授权" }, handledAt: at("10-05", "21:02") }),
  card(
    "c-appr-1",
    "approval",
    {
      approvalId: "a-proto-1",
      source: "任务「家庭照片整理与去重」· 第 2 阶段 · 找出重复并移进回收区",
      taskId: "t-photos",
      stageId: "s2",
      tool: "bash",
      toolTitle: "通用 bash",
      argsSummary: "rsync -av --delete /示例/相册/ 示例备份机:/相册/",
      categoryTitles: ["删除或覆盖", "越出项目目录"],
      reason: "计划里授权的是「移进回收区」；这条命令会删掉备份端多出来的文件，超出了授权的对象范围。",
    } satisfies ApprovalPayload,
    { urgency: "blocking_deadline", createdAt: at("10-07", "09:20") },
  ),
  // 55 号票：第 1 阶段验收通过、第 2 阶段第一次交上来被退回（缩小后的书脊一段绿、一段橙，接着做的那一轮在做）
  card(
    "c-acc-photos-s1",
    "progress",
    {
      taskId: "t-photos",
      taskTitle: "家庭照片整理与去重",
      stageId: "s1",
      stageTitle: "两边扫描出清单",
      stageIndex: 1,
      stageTotal: 4,
      kind: "acceptance",
      text: "验收通过。",
      acceptance: { passed: true, judgedBy: "script", results: [{ criterion: "清单覆盖两个目录", method: "script", passed: true }] },
    } satisfies ProgressPayload,
    { status: "handled", createdAt: at("10-06", "10:20") },
  ),
  card(
    "c-acc-photos-s2",
    "progress",
    {
      taskId: "t-photos",
      taskTitle: "家庭照片整理与去重",
      stageId: "s2",
      stageTitle: "找出重复并移进回收区",
      stageIndex: 2,
      stageTotal: 4,
      kind: "acceptance",
      text: "没通过 1 条，交回维护者修改。",
      acceptance: {
        passed: false,
        judgedBy: "script",
        results: [{ criterion: "回收区里的每张都能在保留区找到同一张", method: "script", passed: false, note: "3 张在保留区找不到" }],
      },
    } satisfies ProgressPayload,
    { status: "handled", createdAt: at("10-06", "18:00") },
  ),
  card("c-prog-1", "progress", {
    taskId: "task-photos",
    taskTitle: "家庭照片整理与去重",
    stageId: "s2",
    stageTitle: "去重",
    stageIndex: 2,
    stageTotal: 4,
    kind: "progress",
    text: "两边一共 38,214 张照片；找出 412 组重复，已移进回收区。下一步把备份端同步一遍（等你批准）",
  } satisfies ProgressPayload),
  card("c-pc-1", "plan_change", planChangePhotos, { urgency: "blocking", createdAt: at("10-07", "09:05") }),
  card("c-pc-2", "plan_change", planChangeBlog, { urgency: "non_blocking", createdAt: at("10-06", "23:10") }),
  card(
    "c-par-1",
    "parallel",
    {
      proposalId: "par-1",
      taskId: "t-photos",
      taskTitle: "家庭照片整理与去重",
      maintainerId: "tm-photos",
      reason: "按年份分开归档互不影响，两个子 agent 同时做能快一半",
      agents: [
        { agentId: "sa-1", stageId: "s3", stageTitle: "按事件归档", instructions: "归档 2015–2019 年的照片", workDir: "D:\\照片\\整理", ownWorkDir: false },
        { agentId: "sa-2", stageId: "s3", stageTitle: "按事件归档", instructions: "归档 2020 年以后的照片", workDir: "D:\\照片\\整理", ownWorkDir: false },
      ],
    } satisfies ParallelPayload,
    { urgency: "non_blocking", createdAt: at("10-07", "09:12") },
  ),
  card(
    "c-wo-1",
    "work_order",
    {
      workOrderId: "W-24",
      taskId: "t-photos",
      taskTitle: "家庭照片整理与去重",
      projectId: "p-netdisk",
      projectName: "家庭网盘",
      stageId: "s2",
      stageTitle: "扫描重复",
      title: "把「手机备份/微信」目录也扫一遍",
      instructions: "把「手机备份/微信」目录也扫一遍",
      acceptance: ["出一份重复清单，格式同 W-22"],
      categories: ["计划外工单"],
    } satisfies WorkOrderPayload,
    { urgency: "blocking", createdAt: at("10-07", "09:15") },
  ),
  card(
    "c-charter-1",
    "charter",
    {
      projectId: "p-appliance",
      projectName: "家电档案",
      revision: 1,
      charter: {
        goal: "家里电器的保修单、说明书和维修记录收在一处，保修到期前一个月提醒我。",
        scope: ["拍照或扫描件录入，自动识别品牌、型号、购买日期", "保修到期提醒", "维修记录"],
        firstVersion: "先把现有 23 件电器录进去，能按名字查到说明书。",
        kind: "other",
        bindExternal: false,
      },
      toolkit: { skills: ["demo-pdf-reader"], mcp: [], bash: false, network: false },
    } satisfies CharterPayload,
    { urgency: "non_blocking", createdAt: at("10-06", "22:30") },
  ),
  card(
    "c-pair-1",
    "pairing",
    {
      requestId: "pr-1",
      deviceName: "iPad · Safari（iPadOS 19）",
      shortCode: "482913",
      fingerprint: "9f3ac21e",
      from: "经隧道 · 203.0.113.24",
      expiresAt: at("10-07", "09:35"),
    } satisfies PairingPayload,
    { urgency: "non_blocking", createdAt: at("10-07", "09:30") },
  ),
  // 两个流程的计划卡（60 号票，fake-workflow.ts）：退回的 v1、授权的 v2，定时流程的那一份
  ...WORKFLOW_CARDS,
];

// ---------- 秘书主线 ----------

const S = CHANNELS.secretary;

/**
 * 个人助理发的一条语音（40 号票：截图看助理语音气泡的样子；原型里只有这一条）。消息 id 写死，不经 msg() 编号，后面消息的 id 不变。
 * 语音对象（agent_voice 事件）在 FAKE_HISTORY 里：合成好了、整段念的，长按"转文字"展开的是它的原文；对应的回复消息不写，文字照常显示
 */
const FAKE_AGENT_VOICE_ID = "av-fake-demo";
const FAKE_AGENT_VOICE_WAVE = [12, 30, 55, 40, 22, 48, 70, 62, 35, 18, 44, 66, 52, 28, 14, 38, 58, 46, 24, 10];
const FAKE_AGENT_VOICE_MESSAGE: MessageEnvelope = {
  id: "msg-agent-voice-demo",
  conversation: S,
  speaker: "agent",
  time: at("10-07", "07:59"),
  parts: [{ type: "tts_audio", voiceId: FAKE_AGENT_VOICE_ID, mediaId: "sha256:fake-agent-voice", mime: "audio/wav", durationMs: 12_000, waveform: FAKE_AGENT_VOICE_WAVE }],
};
const FAKE_AGENT_VOICE: AgentVoiceRecord = {
  id: FAKE_AGENT_VOICE_ID,
  conversation: S,
  scope: {},
  inputMessageId: "msg-12",
  replyMessageIds: [],
  mode: "whole",
  text: "改好了，下周一下午三点，还是那家诊所。前一天晚上我再提醒你一次。",
  status: "done",
  mediaId: "sha256:fake-agent-voice",
  mime: "audio/wav",
  durationMs: 12_000,
  waveform: FAKE_AGENT_VOICE_WAVE,
  messageId: FAKE_AGENT_VOICE_MESSAGE.id,
  createdAt: at("10-07", "07:58"),
  updatedAt: at("10-07", "07:59"),
  version: 3,
};

const SECRETARY: MessageEnvelope[] = [
  msg(S, "user", at("10-06", "20:12"), text("把车险比价那个任务先暂停一下")),
  msg(S, "agent", at("10-06", "20:13"), text("好，已暂停。"), cardRef("c-qa-1")),
  msg(S, "user", at("10-06", "20:30"), text("每个月 8 号早上九点提醒我交房租")),
  msg(S, "agent", at("10-06", "20:30"), text("建好了，重复规则可以在卡片上改。"), cardRef("c-rem-1")),
  msg(
    S,
    "agent",
    at("10-06", "21:40"),
    think("用户这周三次在晚上 10 点后手动导出账单（周一、周三、周四），每次十几分钟。这是重复劳动，适合做成定时作业，但用户没要求，只能给建议卡。"),
    text("顺便说一句：这周你手动导出了三次账单。要不要交给一个任务每周自动做？"),
    cardRef("c-st-1"),
  ),
  msg(S, "user", at("10-06", "22:05"), text("我想做一个专门管家里各种保修单和说明书的东西")),
  msg(S, "agent", at("10-06", "22:05"), think("长期使用、有自己的数据和定时提醒，像是一个项目而不是一次性任务。"), text("这听起来是个可以长期用的项目，建议立项："), cardRef("c-sp-1")),
  msg(
    S,
    "user",
    at("10-06", "22:40"),
    { type: "image", mediaId: "sha256:fake-invoice", name: "发票-0927.jpg", mime: "image/jpeg", width: 1200, height: 1600 },
    text("这张发票帮我算一下能报销多少，按 85% 报"),
  ),
  msg(
    S,
    "agent",
    at("10-06", "22:41"),
    tool("write", "草稿区/invoice-0927.json", { result: "写了 1 个文件" }),
    tool("bash", "python calc_reimburse.py invoice-0927.json --rate 0.85", { generic: true, result: "合计 ¥1,280.00 × 85% = ¥1,088.00" }),
    text("能报 ¥1,088.00（¥1,280.00 × 85%）。明细放在附件里。"),
    { type: "file", mediaId: "sha256:fake-csv", name: "报销明细-0927.csv", mime: "text/csv", size: 1_284 },
  ),
  msg(S, "user", at("10-06", "23:02"), text("忘掉我上个月说的关于换工作的那些话")),
  msg(S, "agent", at("10-06", "23:02"), text("找到 3 条相关的素材，核对一下再删："), cardRef("c-md-1")),
  // 语音消息（31 号票）：按住说话发的，识别出的文字直接显示在气泡下方
  msg(S, "user", at("10-07", "07:58"), { type: "voice", voiceId: "v-fake-demo", mediaId: "sha256:fake-voice", mime: "audio/webm", durationMs: 6200, waveform: [6, 22, 48, 71, 60, 35, 18, 52, 80, 66, 30, 12, 40, 58, 26, 9] }),
  msg(S, "agent", at("10-07", "07:58"), text("好，周五下午三点的牙医改到下周一同一时间了。")),
  FAKE_AGENT_VOICE_MESSAGE,
  msg(S, "user", at("10-07", "08:31"), text("帮我规划一下十一月去东京的行程")),
  msg(S, "agent", at("10-07", "08:31"), text("好，建了任务「十一月东京行程」（规划中）。先对齐几件事："), cardRef("c-q-1")),
  msg(
    S,
    "user",
    at("10-07", "08:50"),
    { type: "file", mediaId: "sha256:fake-notes", name: "读书笔记-置身事内.md", mime: "text/markdown", size: 18_430, asMaterial: true },
    text("最近的读书笔记，收着"),
  ),
  msg(S, "agent", at("10-07", "08:50"), text("收到，作为你主动投喂的材料入库了。")),
  msg(S, "user", at("10-07", "08:55"), text("记账本最近老失败，先停一阵")),
  msg(
    S,
    "agent",
    at("10-07", "08:55"),
    text("我理解是先停「每天 21:00 汇总当天账单」这个作业一周？这是我推断的，你确认了才执行。另外 NAS 快满了，给你一个建议："),
    cardRef("c-qa-2"),
    cardRef("c-st-2"),
  ),
  msg(S, "agent", at("10-07", "09:01"), text("还有一个想法，你上周说想坚持记录训练："), cardRef("c-sp-2")),
  // 57 号票：带思考、一串工具调用（连着三次检索素材，详情里合成一条）和多段的回复（第一段之后有后文）
  msg(S, "user", at("10-07", "09:30"), text("九月三张卡在吃上一共花了多少？")),
  msg(
    S,
    "agent",
    at("10-07", "09:31"),
    think("账单在记账本项目里，我这边看不到项目内部；但你投喂过三张卡九月的月结单，素材里有。先检索素材，再在草稿区按类别加一遍。"),
    tool("search_materials", "query=九月 月结单 甲银行", { result: "1 份月结单（PDF）" }),
    tool("search_materials", "query=九月 月结单 乙银行", { result: "1 份月结单（PDF）" }),
    tool("search_materials", "query=九月 月结单 丙银行", { result: "1 份月结单（CSV）" }),
    tool("write", "草稿区/九月餐饮.csv", { result: "写了 1 个文件" }),
    tool("bash", "python sum_by_category.py 九月餐饮.csv", { generic: true, result: "餐饮 ¥3,412.60" }),
    text(
      "九月三张卡在吃上一共花了 **¥3,412.60**，比八月多 12%。\n\n- 外卖 ¥1,286.00（38%）\n- 餐馆 ¥1,530.60\n- 超市生鲜 ¥596.00\n\n外卖大多在工作日晚上 9 点以后。要不要让记账本在周报里把「外卖」单列出来？",
    ),
  ),
  // 67 号票：提醒、联网搜索、读网页（70 号票）各一次，工具调用说成人话
  msg(S, "user", at("10-07", "10:02"), text("下周三早上提醒我交季度报告；再查查东京十一月中旬的天气")),
  msg(
    S,
    "agent",
    at("10-07", "10:03"),
    tool("create_reminder", "text=交季度报告 date=10-15 time=09:00", { result: "已建好提醒 r-7「交季度报告」：10 月 15 日（周三）09:00" }),
    tool("web_search", "东京 11月 中旬 天气 平均气温", { result: "10 条结果" }),
    tool("web_fetch", "https://www.data.jma.go.jp/obd/stats/etrn/view/monthly_s3.php?prec_no=44&block_no=47662", { result: "11 月平均气温 13.9℃" }),
    text("提醒建好了：10 月 15 日（周三）09:00。东京十一月中旬白天 15–18℃，早晚 8–10℃，带件薄外套就行。"),
  ),
];

// ---------- 任务「家庭照片整理与去重」的维护者 ----------

const P = MAINTAINERS.photos;

const PHOTOS: MessageEnvelope[] = [
  scoped(
    { taskId: "t-photos" },
    msg(P, "system", at("10-05", "20:40"), text("任务书：把相册库和家庭网盘里 2015 年以来的照片去重、按事件归档。约束：重复的先放回收区，不直接删。涉及项目：相册库、家庭网盘。")),
  ),
  scoped(
    { taskId: "t-photos" },
    msg(P, "agent", at("10-05", "20:52"), think("两个项目都要扫描，跨项目任务只能派工单，不能直接动它们的目录。"), text("计划交上来了，请过目。"), cardRef("c-plan-photos")),
  ),
  scoped({ taskId: "t-photos", stageId: "s1" }, msg(P, "system", at("10-05", "21:02"), text("计划已确认（勾掉 1 项授权：直接删除回收区）。进入第 1 阶段。"))),
  scoped(
    { taskId: "t-photos", stageId: "s1" },
    msg(
      P,
      "agent",
      at("10-05", "21:05"),
      tool("read_project_records", 'project=相册库 docs=["spec","progress"]'),
      tool("dispatch_work_order", "project=相册库 stageId=s1 instructions=扫描重复照片，出清单", { disposition: "planned_only", withinGrant: true }),
      tool("dispatch_work_order", "project=家庭网盘 stageId=s1 instructions=扫描「手机备份」目录，出清单", { disposition: "planned_only", withinGrant: true }),
    ),
  ),
  scoped({ taskId: "t-photos", stageId: "s1" }, msg(P, "system", at("10-06", "10:20"), text("回执：W-21、W-22 都已完成。第 1 阶段验收通过（脚本：清单覆盖两个目录）。"))),
  scoped({ taskId: "t-photos", stageId: "s1" }, msg(P, "system", at("10-06", "10:20"), cardRef("c-acc-photos-s1"))),
  scoped(
    { taskId: "t-photos", stageId: "s2" },
    msg(
      P,
      "agent",
      at("10-06", "10:31"),
      tool("bash", "python dedupe.py --dry-run /示例/相册 /示例/网盘/手机备份", { generic: true, result: "412 组重复，共 1,137 张" }),
      // 守护进程拆开 bash：只看的命令是只看（按名字估的旧记录是动手）
      tool("bash", "ls /示例/网盘/手机备份 | wc -l", { generic: true, result: "3,204", nature: "look" }),
      tool("bash", "python move_dupes.py dupes.json --to 回收区/2026-10-06", { generic: true, categories: ["删除或覆盖"], disposition: "do_then_tell", withinGrant: true, result: "已移动 1,137 张" }),
      tool("bash", "curl -X POST https://photos.example.com/api/albums -d @albums.json", {
        generic: true,
        categories: ["以我的名义对外发送或发布"],
        disposition: "planned_only",
        withinGrant: false,
        outcome: "blocked",
        result: "计划里没列，已拦下并提醒维护者回到计划",
      }),
      tool("bash", "rm -rf /示例/相册/2019/草稿", { generic: true, categories: ["删除或覆盖"], disposition: "ask_first", outcome: "denied", result: "你拒绝了：「草稿目录别动」" }),
    ),
  ),
  scoped({ taskId: "t-photos", stageId: "s2" }, msg(P, "system", at("10-06", "18:00"), cardRef("c-acc-photos-s2"))),
  scoped(
    { taskId: "t-photos", stageId: "s2" },
    msg(
      P,
      "agent",
      at("10-06", "18:20"),
      tool("bash", "python dedupe.py --verify 回收区/2026-10-06", { generic: true, result: "3 张在保留区找不到：已移回原处" }),
      text("漏掉的 3 张移回原处了，回收区现在和保留区一一对得上。"),
    ),
  ),
  scoped({ taskId: "t-photos", stageId: "s2" }, msg(P, "agent", at("10-07", "09:00"), cardRef("c-prog-1"))),
  scoped({ taskId: "t-photos", stageId: "s2" }, msg(P, "agent", at("10-07", "09:05"), text("第 3 阶段要读照片的拍摄时间和地点，想加一个工具，提交了一张计划变更："), cardRef("c-pc-1"))),
  scoped({ taskId: "t-photos", stageId: "s2" }, msg(P, "agent", at("10-07", "09:12"), text("第 3 阶段可以按年份分两批并行："), cardRef("c-par-1"))),
  scoped({ taskId: "t-photos", stageId: "s2" }, msg(P, "agent", at("10-07", "09:15"), text("家庭网盘里还有一个微信备份目录，计划里没写，想加一张工单："), cardRef("c-wo-1"))),
  scoped(
    { taskId: "t-photos", stageId: "s2" },
    msg(
      P,
      "agent",
      at("10-07", "09:20"),
      tool("bash", "rsync -av --delete /示例/相册/ 示例备份机:/相册/", {
        categories: ["删除或覆盖", "越出项目目录"],
        disposition: "ask_first",
        generic: true,
        // 挂起等审批的调用守护进程记成没执行（blocked、没有 blockedBy），会话里算"等你批准"（timeline.ts 的 awaitingApproval）
        outcome: "blocked",
        result: "等你批准",
      }),
      cardRef("c-appr-1"),
    ),
  ),
];

// ---------- 任务「每周汇总银行账单」的维护者 ----------

const B = MAINTAINERS.bills;

const BILLS: MessageEnvelope[] = [
  msg(B, "system", at("10-07", "08:10"), text("任务书：每周一把上周三张卡的账单导出、去重、分类，汇总进「记账本」，出一页周报。约束：历史账目不能丢；邮件正文别看。涉及项目：记账本。")),
  msg(
    B,
    "agent",
    at("10-07", "08:40"),
    think("只涉及记账本一个项目，按规格应该由记账本的维护者执行；这里演示的是计划卡本身。对话里的两条限制要编译成规则和授权收窄。"),
    text("计划草稿好了。你在对话里说的两条限制，我编成了一条时序规则和一条授权收窄，写在卡片上。"),
    cardRef("c-plan-bills"),
  ),
];

// ---------- 项目「记账本」的维护者 ----------

const L = MAINTAINERS.ledger;

const LEDGER: MessageEnvelope[] = [
  msg(L, "system", at("10-05", "21:00"), divider("W-15", "每日汇总（10-05 21:00 的运行）", "定时作业「每天 21:00 汇总当天账单」")),
  msg(
    L,
    "agent",
    at("10-05", "21:01"),
    // 连着三次读文件（57 号票：组的详情里合成一条"还有 2 次同样的操作"）
    tool("read", "inbox/2026-10-05/demo-a.csv"),
    tool("read", "inbox/2026-10-05/demo-b.csv"),
    tool("read", "inbox/2026-10-05/demo-c.csv"),
    tool("bash", "python summarize.py --day 2026-10-05", { generic: true, result: "支出 ¥286.40，收入 ¥0" }),
    tool("write", "reports/daily/2026-10-05.md"),
    text("10-05 汇总好了：支出 ¥286.40，其中外卖 ¥96。"),
  ),
  msg(L, "system", at("10-06", "21:00"), divider("W-16", "每日汇总（10-06 21:00 的运行）", "定时作业「每天 21:00 汇总当天账单」")),
  msg(
    L,
    "agent",
    at("10-06", "21:01"),
    tool("bash", "python fetch.py --bank demo-a --day 2026-10-06", { generic: true, outcome: "error", result: "HTTP 403：甲银行账单接口拒绝访问" }),
    text("甲银行的账单接口返回 403，这次运行失败了。可能是登录过期，需要你重新授权一次。"),
  ),
  msg(L, "system", at("10-06", "21:30"), { type: "work_order_divider", workOrderId: "", title: "你直接对话", from: "你" }),
  msg(L, "user", at("10-06", "21:30"), text("把分类规则里「外卖」单独拆出来，别和餐饮混在一起")),
  msg(
    L,
    "agent",
    at("10-06", "21:31"),
    tool("read", "rules/categories.yaml"),
    tool("write", "rules/categories.yaml", { categories: ["删除或覆盖"], disposition: "ask_first", outcome: "done", result: "你在卡片上批准了" }),
    tool("git_commit", "message=rules: 外卖单独成类", { disposition: "do_then_tell", result: "提交 3f9a1c2；做完告诉你" }),
    text("改好了，下次汇总生效。进展文档也写回了。"),
  ),
  msg(L, "user", at("10-06", "21:35"), text("以后月结单直接从邮箱里拿吧，别让我手动下载了")),
  msg(L, "agent", at("10-06", "21:36"), text("我现在的工具包里没有读邮箱的工具，这件事也不在任何任务里。你在项目的工具包里给我加上读邮箱的 MCP 之后，我再从邮箱里拿月结单。")),
  msg(L, "system", at("10-06", "21:40"), text("范围审视：这段读了「家庭网盘」项目里的一个文件，没有授权，记为越界。")),
];

// ---------- 项目「个人博客」的维护者 ----------

const G = MAINTAINERS.blog;

const BLOG: MessageEnvelope[] = [
  msg(G, "system", at("10-06", "14:00"), divider("W-30", "第 3 阶段：迁移文章和图片", "任务「博客迁移到 Astro」")),
  msg(
    G,
    "agent",
    at("10-06", "14:02"),
    think("先跑一遍现有测试，确认迁移前是绿的。"),
    tool("run_tests", "", { result: "42 passed" }),
    tool("bash", "node scripts/migrate-posts.mjs --from hexo --to astro", { generic: true, result: "迁移 186 篇文章、1,024 张图片" }),
    tool("run_tests", "", { result: "45 passed" }),
    tool("git_commit", "message=迁移文章和图片到 Astro", { disposition: "do_then_tell", result: "提交 a81c0de" }),
    tool("git_push", "remote=origin branch=astro-migration", { categories: ["以我的名义对外发送或发布"], disposition: "planned_only", withinGrant: true, result: "已推送" }),
    text("第 3 阶段的交付件做完了，交回执。"),
  ),
  msg(G, "user", at("10-06", "22:58"), text("测完直接切过去吧")),
  msg(G, "agent", at("10-06", "23:10"), text("切 DNS 不在原计划里，提交了一张计划变更："), cardRef("c-pc-2")),
  msg(G, "agent", at("10-07", "09:10"), tool("run_tests", 'args=["e2e"]', { outcome: "running" })),
];

// ---------- 项目「家电档案」的维护者（立项问答） ----------

const A = MAINTAINERS.appliance;

const APPLIANCE: MessageEnvelope[] = [
  msg(A, "system", at("10-06", "22:06"), { type: "work_order_divider", workOrderId: "", title: "立项问答", from: "你" }),
  msg(A, "agent", at("10-06", "22:06"), text("先问几个问题把范围定下来：\n1. 现在大概有多少件电器？\n2. 保修单是纸质的多还是电子的多？\n3. 到期前多久提醒你？")),
  msg(A, "user", at("10-06", "22:15"), text("二十多件吧。纸质的多，我拍照给你。提前一个月提醒。")),
  msg(A, "agent", at("10-06", "22:28"), text("好，规格、术语表都写进项目档案了。立项书如下，确认就可以开工："), cardRef("c-charter-1")),
];

/** 秘书主线里那条语音（识别完成） */
const FAKE_VOICES: VoiceRecord[] = [
  {
    id: "v-fake-demo",
    messageId: "m-voice-demo",
    conversation: S,
    mediaId: "sha256:fake-voice",
    mime: "audio/webm",
    durationMs: 6200,
    waveform: [6, 22, 48, 71, 60, 35, 18, 52, 80, 66, 30, 12, 40, 58, 26, 9],
    status: "done",
    attempt: 1,
    recognition: { text: "周五下午三点那个牙医，帮我改到下周一吧，同一个时间。", language: "zh", segments: [], model: "large-v3", device: "cuda", computeType: "int8_float16", elapsedMs: 1300, time: at("10-07", "07:58") },
    createdAt: at("10-07", "07:58"),
    updatedAt: at("10-07", "07:58"),
    version: 3,
  },
];

// ---------- 普通任务（75 号票）：助理交给后台的一件事，做完自动完成 ----------

/** 一个做完了的普通任务（助理自己交出去的）：任务详情只有会话和工具调用详情 */
export const FAKE_PLAIN_TASK: Task = {
  id: "t-song",
  title: "下载《晴天》的音频",
  summary: "搜一下周杰伦《晴天》，把音频下载成 mp3，放进工作目录，文件名写歌名",
  state: "done",
  origin: "delegated",
  kind: "plain",
  maintainerId: ownMaintainerId("t-song"),
  projects: [],
  projectIds: [],
  createdAt: at("10-07", "08:40"),
  updatedAt: at("10-07", "08:46"),
};
const SONG = maintainerChannel(FAKE_PLAIN_TASK.maintainerId);
const PLAIN: MessageEnvelope[] = [
  msg(
    SONG,
    "system",
    at("10-07", "08:40"),
    text("普通任务 t-song「下载《晴天》的音频」（助理交给你的）：要做的事——\n搜一下周杰伦《晴天》，把音频下载成 mp3，放进工作目录，文件名写歌名\n直接动手做，一轮轮做到交付为止；做完了用一两句话说清做成了什么、结果在哪。"),
  ),
  msg(
    SONG,
    "agent",
    at("10-07", "08:41"),
    think("先搜到能下载的来源，再用 yt-dlp 抽音频转 mp3。"),
    tool("web_search", "周杰伦 晴天 官方 MV", { nature: "look", result: "5 条结果：官方频道的 MV 排第一" }),
    tool("web_fetch", "youtube.com/watch?v=…（官方 MV 页面）", { nature: "look", result: "标题、时长 4:29，确认是官方上传" }),
    tool("bash", "yt-dlp -x --audio-format mp3 -o \"晴天.%(ext)s\" <链接>", { generic: true, result: "[ExtractAudio] Destination: 晴天.mp3" }),
    tool("bash", "ls -lh 晴天.mp3", { generic: true, nature: "look", result: "4.2M 晴天.mp3" }),
  ),
  msg(SONG, "agent", at("10-07", "08:46"), text("下好了：工作目录里的「晴天.mp3」（4.2 MB，4 分 29 秒，来自官方 MV）。")),
  msg(SONG, "system", at("10-07", "08:46"), text("这一轮做完了，任务自动完成。要它接着做，在这里接着说。")),
];
// 普通任务 agent 会话里的消息带着所属的任务（守护进程照样带）：缩小后左边一张任务卡；没有阶段，不画书脊（55 号票）
for (const m of PLAIN) SCOPES.set(m.id, { taskId: FAKE_PLAIN_TASK.id });
/** 助理那边：交出去时说一声，做完转告结果 */
const SECRETARY_PLAIN: MessageEnvelope[] = [
  msg(S, "user", at("10-07", "08:39"), text("去搜一下晴天这首歌，把音频下下来")),
  msg(S, "agent", at("10-07", "08:40"), tool("delegate_task", "title=下载《晴天》的音频 instructions=找到周杰伦《晴天》的音频，下载到草稿区", { nature: "act", result: "已交给后台：普通任务 t-song" }), text("已交给后台去做，做完告诉你。")),
  msg(S, "agent", at("10-07", "08:47"), text("《晴天》下好了，在后台任务的工作目录里：晴天.mp3（4.2 MB）。")),
];

// ---------- 用户打字、个人助理发语音（86 号票）：发语音工具发的语音气泡 ----------

/** 第一轮：只出语音气泡（另写的那句普通的话收进气泡，长按"转文字"看得到） */
const VOICE_ONLY_ASK = msg(S, "user", at("10-07", "10:20"), text("把明天的安排念给我听"));
const VOICE_ONLY_TEXT = "明天上午九点开周会，下午两点交季度报告，晚上七点约了牙医。";
const VOICE_ONLY_COVERED = msg(S, "agent", at("10-07", "10:21"), text("好的，念给你听了。"));
const VOICE_ONLY_MESSAGE = msg(S, "agent", at("10-07", "10:21"), { type: "tts_audio", voiceId: "av-fake-tool-1", mediaId: "sha256:fake-tts-1", mime: "audio/wav", durationMs: 6400, waveform: [12, 40, 66, 52, 30, 18, 44, 72, 90, 64, 38, 20, 48, 70, 56, 34, 22, 46, 68, 80, 58, 32, 16, 40, 62, 74, 50, 28, 18, 36, 54, 24] });
/** 第二轮：语音气泡下面是一张表和一个链接（念不出来，照常显示） */
const VOICE_TABLE_ASK = msg(S, "user", at("10-07", "10:25"), text("用语音说一下这周要交的三份材料，再列个表给我，附上提交入口"));
const VOICE_TABLE_TEXT ="这周要交三份材料：周三交季度报告，周四交报销单，周五交周报。表和提交入口我发在下面了。";
const VOICE_TABLE_MESSAGE = msg(S, "agent", at("10-07", "10:26"), { type: "tts_audio", voiceId: "av-fake-tool-2", mediaId: "sha256:fake-tts-2", mime: "audio/wav", durationMs: 9800, waveform: [20, 52, 74, 60, 36, 24, 50, 78, 88, 70, 42, 26, 54, 76, 62, 40, 28, 50, 72, 84, 60, 34, 20, 44, 66, 80, 58, 30, 22, 42, 60, 30] });
const VOICE_TABLE_SHOWN = msg(
  S,
  "agent",
  at("10-07", "10:26"),
  text("| 材料 | 截止 | 交给 |\n| --- | --- | --- |\n| 季度报告 | 周三 18:00 | 部门邮箱 |\n| 报销单 | 周四 12:00 | 财务系统 |\n| 周报 | 周五 17:00 | 团队周报页 |\n\n提交入口：https://example.com/submit"),
);
const SECRETARY_VOICE: MessageEnvelope[] = [
  VOICE_ONLY_ASK,
  msg(S, "agent", at("10-07", "10:21"), tool("send_voice", `text=${VOICE_ONLY_TEXT}`, { nature: "act", result: "已经把这段话合成语音发给用户了（约 6.4 秒）" })),
  VOICE_ONLY_MESSAGE,
  VOICE_ONLY_COVERED,
  VOICE_TABLE_ASK,
  msg(S, "agent", at("10-07", "10:26"), tool("send_voice", `text=${VOICE_TABLE_TEXT}`, { nature: "act", result: "已经把这段话合成语音发给用户了（约 9.8 秒）" })),
  VOICE_TABLE_MESSAGE,
  VOICE_TABLE_SHOWN,
];

/** 两条工具发的语音（合成好了、回合结束时定了另写的文字收不收） */
const FAKE_AGENT_VOICES: AgentVoiceRecord[] = [
  { id: "av-fake-tool-1", ask: VOICE_ONLY_ASK, text: VOICE_ONLY_TEXT, message: VOICE_ONLY_MESSAGE, replies: [VOICE_ONLY_COVERED], covers: true, segments: 2 },
  { id: "av-fake-tool-2", ask: VOICE_TABLE_ASK, text: VOICE_TABLE_TEXT, message: VOICE_TABLE_MESSAGE, replies: [VOICE_TABLE_SHOWN], covers: false, segments: 3 },
].map(({ id, ask, text: spoken, message, replies, covers, segments }): AgentVoiceRecord => {
  const part = message.parts[0] as Extract<MessagePart, { type: "tts_audio" }>;
  return {
    id,
    conversation: S,
    scope: {},
    inputMessageId: ask.id,
    replyMessageIds: replies.map((m) => m.id),
    mode: "tool",
    coversReply: covers,
    text: spoken,
    referenceVoice: { id: "v-sample", name: "示例音色" },
    model: "fish_audio（audio.cpp/tts）",
    status: "done",
    segmentCount: segments,
    mediaId: part.mediaId,
    mime: part.mime,
    durationMs: part.durationMs,
    waveform: part.waveform,
    messageId: message.id,
    firstSegmentMs: 2900,
    elapsedMs: Math.round(part.durationMs * 0.9),
    createdAt: message.time,
    updatedAt: message.time,
    version: 4,
  };
});

// ---------- 定时触发的任务（76 号票）：按时间表反复运行，各次运行接着同一段会话 ----------

/** 按我的工作日 08:00 出早报（定时触发的普通任务）：跑过三次，第二次失败了 */
export const FAKE_TIMED_TASK: Task = {
  id: "t-brief",
  title: "每天早上出早报",
  summary: "每天早上出早报\n汇总昨天的科技新闻和我关注的几个开源项目的新版本，写成一页 brief.md",
  state: "operating",
  origin: "button",
  kind: "plain",
  trigger: { kind: "schedule", schedule: { kind: "workdays", time: "08:00" } },
  maintainerId: ownMaintainerId("t-brief"),
  projects: [],
  projectIds: [],
  projectScope: "none",
  createdAt: at("10-02", "21:10"),
  updatedAt: at("10-07", "08:06"),
};
const BRIEF = maintainerChannel(FAKE_TIMED_TASK.maintainerId);
const briefRun = (n: number, day: string, weekday: string, state: JobRun["state"], reason?: string, summary?: string): JobRun => ({
  runId: `j-brief-r${n}`,
  jobId: "j-brief",
  trigger: "scheduled",
  dueAt: at(day, "08:00"),
  events: [{ source: "time", at: at(day, "08:00"), summary: `10 月 ${Number(day.slice(3))} 日（${weekday}）08:00 到点` }],
  state,
  queuedAt: at(day, "08:00"),
  startedAt: at(day, "08:00"),
  endedAt: at(day, "08:05"),
  ...(reason ? { reason } : {}),
  ...(summary ? { summary } : {}),
});
const BRIEF_RUNS: JobRun[] = [
  briefRun(1, "10-05", "周一", "done", undefined, "早报写好了：brief.md（11 条新闻，Vite 出了 7.2）。"),
  briefRun(2, "10-06", "周二", "failed", "新闻源 rss.example.com 连不上（超时）", "新闻源连不上，这次没出早报。"),
  briefRun(3, "10-07", "周三", "done", undefined, "早报写好了：brief.md（9 条；昨天那份补不回来了，新闻源今天恢复了）。"),
];
const briefJob = (runs: number, last: JobRun | undefined): ScheduledJob => ({
  id: "j-brief",
  title: FAKE_TIMED_TASK.title,
  schedule: { kind: "workdays", time: "08:00" },
  each: FAKE_TIMED_TASK.summary,
  maintainerId: FAKE_TIMED_TASK.maintainerId,
  taskId: FAKE_TIMED_TASK.id,
  taskTitle: FAKE_TIMED_TASK.title,
  ownerTaskId: FAKE_TIMED_TASK.id,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state: "active",
  nextAt: at("10-08", "08:00"),
  lastFailed: last?.state === "failed",
  consecutiveFailures: last?.state === "failed" ? 1 : 0,
  runCount: runs,
  ...(last ? { lastRun: last } : {}),
  createdAt: at("10-02", "21:10"),
  updatedAt: last?.endedAt ?? at("10-02", "21:10"),
});
const runDivider = (run: JobRun, no: number): MessagePart => ({ type: "run_divider", jobId: run.jobId, runId: run.runId, title: `第 ${no} 次运行 · ${run.events![0]!.summary}` });
const BRIEF_MESSAGES: MessageEnvelope[] = [
  msg(BRIEF, "system", at("10-05", "08:00"), runDivider(BRIEF_RUNS[0]!, 1)),
  msg(BRIEF, "system", at("10-05", "08:00"), text("定时触发的普通任务 t-brief「每天早上出早报」的第 1 次运行（j-brief-r1；时间表：按我的工作日 08:00）。触发：10 月 5 日（周一）08:00 到点\n要做的事——\n汇总昨天的科技新闻和我关注的几个开源项目的新版本，写成一页 brief.md\n这是第一次运行。")),
  msg(
    BRIEF,
    "agent",
    at("10-05", "08:02"),
    think("先拉 RSS，再看几个仓库的 releases。"),
    tool("web_fetch", "rss.example.com/tech", { nature: "look", result: "32 条，昨天的 11 条" }),
    tool("web_fetch", "github.com/vitejs/vite/releases", { nature: "look", result: "v7.2.0（10-04）" }),
    tool("write", "brief.md", { nature: "act", result: "写了 1.6 KB" }),
  ),
  msg(BRIEF, "agent", at("10-05", "08:05"), text("早报写好了：brief.md（11 条新闻，Vite 出了 7.2）。")),
  msg(BRIEF, "system", at("10-06", "08:00"), runDivider(BRIEF_RUNS[1]!, 2)),
  msg(BRIEF, "system", at("10-06", "08:00"), text("定时触发的普通任务 t-brief「每天早上出早报」的第 2 次运行（j-brief-r2）。触发：10 月 6 日（周二）08:00 到点\n前几次运行的结果（做了什么在这一段会话的前面）：\n- 第 1 次运行（10 月 5 日（周一）08:00）：成功——最后说的：早报写好了：brief.md（11 条新闻，Vite 出了 7.2）。")),
  msg(
    BRIEF,
    "agent",
    at("10-06", "08:04"),
    tool("web_fetch", "rss.example.com/tech", { nature: "look", outcome: "error", result: "超时（20 秒）" }),
    tool("fail_job_run", "新闻源 rss.example.com 连不上（超时）", { nature: "act", result: "这次运行记为失败" }),
  ),
  msg(BRIEF, "agent", at("10-06", "08:05"), text("新闻源连不上，这次没出早报。")),
  msg(BRIEF, "system", at("10-07", "08:00"), runDivider(BRIEF_RUNS[2]!, 3)),
  msg(BRIEF, "system", at("10-07", "08:00"), text("定时触发的普通任务 t-brief「每天早上出早报」的第 3 次运行（j-brief-r3）。触发：10 月 7 日（周三）08:00 到点\n前几次运行的结果（做了什么在这一段会话的前面）：\n- 第 1 次运行（10 月 5 日（周一）08:00）：成功——最后说的：早报写好了：brief.md（11 条新闻，Vite 出了 7.2）。\n- 第 2 次运行（10 月 6 日（周二）08:00）：失败——新闻源 rss.example.com 连不上（超时）；最后说的：新闻源连不上，这次没出早报。")),
  msg(
    BRIEF,
    "agent",
    at("10-07", "08:03"),
    think("上次新闻源超时：先试一下，不通就换备用源。"),
    tool("web_fetch", "rss.example.com/tech", { nature: "look", result: "通了，昨天的 9 条" }),
    tool("write", "brief.md", { nature: "act", result: "写了 1.4 KB" }),
  ),
  msg(BRIEF, "agent", at("10-07", "08:06"), text("早报写好了：brief.md（9 条；昨天那份补不回来了，新闻源今天恢复了）。")),
];
for (const m of BRIEF_MESSAGES) SCOPES.set(m.id, { taskId: FAKE_TIMED_TASK.id, scheduledJobId: "j-brief" });
const BRIEF_EVENTS: { channel: string; type: string; payload: unknown }[] = [
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_TIMED_TASK, change: "created", from: null, by: "user" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: briefJob(0, undefined), change: "registered", by: "user" } satisfies ScheduledJobEventPayload },
  ...BRIEF_RUNS.map((run, i) => ({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: briefJob(i + 1, run), change: "run_finished", by: "system", run } satisfies ScheduledJobEventPayload })),
];

// 每周一 09:00 整理下载目录（定时触发的流程）：60 号票起挪到 fake-workflow.ts，补上计划卡和会话，第 2 次运行在跑（原来是暂停着）
export { FAKE_TIMED_WORKFLOW, FAKE_WORKFLOW_TASK } from "./fake-workflow.ts";

/** 明天早上 9 点查一下航班（某个时间做一次的普通任务，助理交给后台的）：还在等时间（76 号票，用户 2026-10-10 定） */
export const FAKE_AT_TASK: Task = {
  id: "t-flight",
  title: "查一下明早的航班",
  summary: "查一下 10 月 8 日上午从上海飞新加坡的航班，挑三班直飞的列出时间和价格",
  state: "scheduled",
  origin: "delegated",
  kind: "plain",
  trigger: { kind: "schedule", schedule: { kind: "once", at: at("10-08", "09:00") } },
  maintainerId: ownMaintainerId("t-flight"),
  projects: [],
  projectIds: [],
  projectScope: "none",
  createdAt: at("10-07", "21:30"),
  updatedAt: at("10-07", "21:30"),
};

// ---------- 事件触发的任务（77 号票）：每来一次等的事件运行一次 ----------

/** 收件箱里来了 PDF 就提取要点（事件触发的普通任务）：跑过两次，第二次是排队合并的一批两个事件 */
const INBOX_TRIGGER = { kind: "event" as const, source: "folder", events: ["added"], filter: { path: "D:\\收件箱", pattern: "*.pdf" } };
export const FAKE_EVENT_TASK: Task = {
  id: "t-inbox",
  title: "收件箱来了 PDF 就提取要点",
  summary: "收件箱来了 PDF 就提取要点\n读一遍新来的 PDF，把要点记进 读书笔记.md",
  state: "operating",
  origin: "button",
  kind: "plain",
  trigger: INBOX_TRIGGER,
  maintainerId: ownMaintainerId("t-inbox"),
  projects: [],
  projectIds: [],
  projectScope: "none",
  createdAt: at("10-06", "20:00"),
  updatedAt: at("10-07", "15:42"),
};
const INBOX = maintainerChannel(FAKE_EVENT_TASK.maintainerId);
const pdfEvent = (name: string, time: string, size: number) => ({
  source: "folder",
  event: "added",
  at: at("10-07", time),
  summary: `新增文件 ${name}（D:\\收件箱）`,
  data: { path: `D:\\收件箱\\${name}`, name, relativePath: name, folder: "D:\\收件箱", change: "新增", size, modifiedAt: at("10-07", time) },
});
const INBOX_RUNS: JobRun[] = [
  {
    runId: "j-inbox-r1",
    jobId: "j-inbox",
    trigger: "event",
    dueAt: at("10-07", "10:12"),
    events: [pdfEvent("季度报告.pdf", "10:12", 482_133)],
    state: "done",
    queuedAt: at("10-07", "10:12"),
    startedAt: at("10-07", "10:12"),
    endedAt: at("10-07", "10:15"),
    summary: "季度报告.pdf 的要点记好了：营收同比 +12%，三个风险点。",
  },
  {
    runId: "j-inbox-r2",
    jobId: "j-inbox",
    trigger: "event",
    dueAt: at("10-07", "15:38"),
    events: [pdfEvent("合同-草稿.pdf", "15:38", 96_512), pdfEvent("发票-0923.pdf", "15:39", 41_220)],
    state: "done",
    queuedAt: at("10-07", "15:38"),
    startedAt: at("10-07", "15:39"),
    endedAt: at("10-07", "15:42"),
    summary: "两份都看过了：合同草稿的付款条款记下了；发票不是读物，只记了一行。",
  },
];
const inboxJob = (runs: number, last: JobRun | undefined): ScheduledJob => ({
  id: "j-inbox",
  title: FAKE_EVENT_TASK.title,
  event: INBOX_TRIGGER,
  each: FAKE_EVENT_TASK.summary,
  maintainerId: FAKE_EVENT_TASK.maintainerId,
  taskId: FAKE_EVENT_TASK.id,
  taskTitle: FAKE_EVENT_TASK.title,
  ownerTaskId: FAKE_EVENT_TASK.id,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state: "active",
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: runs,
  ...(last ? { lastRun: last } : {}),
  createdAt: at("10-06", "20:00"),
  updatedAt: last?.endedAt ?? at("10-06", "20:00"),
});
const INBOX_MESSAGES: MessageEnvelope[] = [
  msg(INBOX, "system", at("10-07", "10:12"), { type: "run_divider", jobId: "j-inbox", runId: "j-inbox-r1", title: "第 1 次运行 · 新增文件 季度报告.pdf（D:\\收件箱）" }),
  msg(INBOX, "system", at("10-07", "10:12"), text("事件触发的普通任务 t-inbox「收件箱来了 PDF 就提取要点」的第 1 次运行（j-inbox-r1；事件发生时：本机文件夹 D:\\收件箱里新增 *.pdf 文件）。触发：新增文件 季度报告.pdf（D:\\收件箱）\n这一批事件的内容（结构化，1 个）：……")),
  msg(INBOX, "agent", at("10-07", "10:14"), tool("read", "D:\\收件箱\\季度报告.pdf", { nature: "look", result: "12 页" }), tool("edit", "读书笔记.md", { nature: "act", result: "加了 6 行" })),
  msg(INBOX, "agent", at("10-07", "10:15"), text("季度报告.pdf 的要点记好了：营收同比 +12%，三个风险点。")),
  msg(INBOX, "system", at("10-07", "15:39"), { type: "run_divider", jobId: "j-inbox", runId: "j-inbox-r2", title: "第 2 次运行 · 合并了 2 次触发" }),
  msg(INBOX, "system", at("10-07", "15:39"), text("事件触发的普通任务 t-inbox「收件箱来了 PDF 就提取要点」的第 2 次运行（j-inbox-r2）。触发：这一批触发（上一次还没跑完时又来的，合成一批交给这一次运行）：……")),
  msg(INBOX, "agent", at("10-07", "15:41"), tool("read", "D:\\收件箱\\合同-草稿.pdf", { nature: "look", result: "4 页" }), tool("read", "D:\\收件箱\\发票-0923.pdf", { nature: "look", result: "1 页" }), tool("edit", "读书笔记.md", { nature: "act", result: "加了 4 行" })),
  msg(INBOX, "agent", at("10-07", "15:42"), text("两份都看过了：合同草稿的付款条款记下了；发票不是读物，只记了一行。")),
];
for (const m of INBOX_MESSAGES) SCOPES.set(m.id, { taskId: FAKE_EVENT_TASK.id, scheduledJobId: "j-inbox" });
const INBOX_EVENTS: { channel: string; type: string; payload: unknown }[] = [
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_EVENT_TASK, change: "created", from: null, by: "user" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: inboxJob(0, undefined), change: "registered", by: "user" } satisfies ScheduledJobEventPayload },
  ...INBOX_RUNS.map((run, i) => ({ channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: inboxJob(i + 1, run), change: "run_finished", by: "system", run } satisfies ScheduledJobEventPayload })),
];

/** 原型启动时服务端"已有"的事件，按频道分组前的顺序 */
export const FAKE_HISTORY: { channel: string; type: string; payload: unknown }[] = [
  ...FAKE_CARDS.map((c) => ({ channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card: c } })),
  ...[...SECRETARY, ...SECRETARY_PLAIN, ...SECRETARY_VOICE, ...PHOTOS, ...BILLS, ...LEDGER, ...BLOG, ...APPLIANCE, ...PLAIN, ...BRIEF_MESSAGES, ...INBOX_MESSAGES].map((m) => ({ channel: m.conversation, type: EVENT_TYPES.message, payload: { message: m, ...SCOPES.get(m.id) } })),
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_PLAIN_TASK, change: "completed", from: "running", by: "system" } satisfies TaskEventPayload },
  ...BRIEF_EVENTS,
  ...WORKFLOW_HISTORY,
  ...INBOX_EVENTS,
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_AT_TASK, change: "created", from: null, by: "secretary" } satisfies TaskEventPayload },
  ...FAKE_VOICES.map((voice) => ({ channel: voice.conversation, type: EVENT_TYPES.voice, payload: { voice } })),
  { channel: FAKE_AGENT_VOICE.conversation, type: EVENT_TYPES.agentVoice, payload: { voice: FAKE_AGENT_VOICE } satisfies AgentVoiceEventPayload },
  ...FAKE_AGENT_VOICES.map((voice) => ({ channel: voice.conversation, type: EVENT_TYPES.agentVoice, payload: { voice } satisfies AgentVoiceEventPayload })),
];
