// 原型的假事件：卡片和各个会话的历史。由假连接按频道编上序号，当作"服务端已有的事件"推给前端。
// 14 种卡片各至少出现一次（聊天、待我处理或任务详情里）。
import type {
  ApprovalPayload,
  CharterPayload,
  PairingPayload,
  ParallelPayload,
  PlanChangePayload,
  PlanPayload,
  ProgressPayload,
  QuestionsPayload,
  SuggestProjectPayload,
  SuggestTaskPayload,
  WorkOrderPayload,
} from "../model/cards.ts";
import {
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
  maintainerChannel,
  type QuickActionCardPayload,
  type ReminderCardPayload,
  type Speaker,
  type ToolCallOutcome,
} from "../state/index.ts";

/** 时间：月-日 + 时:分（2026 年，东八区） */
export function at(md: string, hm: string): string {
  return `2026-${md}T${hm}:00+08:00`;
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
const think = (t: string): MessagePart => ({ type: "reasoning", text: t });
const cardRef = (cardId: string): MessagePart => ({ type: "card_ref", cardId });
const divider = (workOrderId: string, title: string, from: string): MessagePart => ({ type: "work_order_divider", workOrderId, title, from });

let callNo = 0;
function tool(
  name: string,
  argsSummary: string,
  o: { categories?: string[]; disposition?: Disposition; withinGrant?: boolean; generic?: boolean; outcome?: ToolCallOutcome; result?: string } = {},
): MessagePart {
  callNo += 1;
  return {
    type: "tool_call",
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
}

let msgNo = 0;
function msg(conversation: ConversationId, speaker: Speaker, time: string, ...parts: MessagePart[]): MessageEnvelope {
  msgNo += 1;
  return { id: `msg-${msgNo}`, conversation, speaker, time, parts };
}

// ---------- 卡片 ----------

function card(id: string, type: CardType, payload: unknown, o: Partial<Card> = {}): Card {
  return { id, type, typeVersion: CARD_TYPE_VERSIONS[type], version: 1, status: "pending", payload, text: "（原型的假卡片）", createdAt: at("10-07", "09:00"), ...o };
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
    scheduledJobs: [{ title: "每周一出账单周报", schedule: { kind: "weekly", time: "08:00", weekdays: [1] }, each: "导出上周账单、去重、分类，追加周汇总，出一页周报", project: "记账本" }],
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
    scheduledJobs: [],
    assumptions: ["NAS 上的照片目录是 /示例/相册", "家庭网盘的「手机备份」目录和相册库有大量重复"],
    stops: { count: 1, where: ["归档结果由你过目"] },
    tokenEstimate: 430_000,
  },
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
  card(
    "c-pc-1",
    "plan_change",
    {
      kind: "capability",
      scope: "任务「家庭照片整理与去重」",
      summary: "第 3 阶段加一个 MCP「demo-exif-reader」",
      before: "工具包：skill 无；MCP 无；bash 开；联网关",
      after: "工具包：skill 无；MCP demo-exif-reader；bash 开；联网关",
      affectedStages: ["第 3 阶段 · 按事件归档"],
      reason: "按事件归档要读照片的拍摄时间和地点，用 bash 一张张读太慢。",
    } satisfies PlanChangePayload,
    { urgency: "blocking", createdAt: at("10-07", "09:05") },
  ),
  card(
    "c-tk-1",
    "plan_change",
    {
      kind: "toolkit",
      scope: "项目「记账本」",
      summary: "加一个 MCP「demo-mail-readonly」",
      before: "工具包：skill demo-pdf-reader；MCP 无；bash 开；联网关",
      after: "工具包：skill demo-pdf-reader；MCP demo-mail-readonly；bash 开；联网关",
      affectedStages: [],
      reason: "你让我以后直接从邮箱拿月结单，现在的工具包里没有读邮箱的工具。",
    } satisfies PlanChangePayload,
    { urgency: "non_blocking", createdAt: at("10-06", "21:36") },
  ),
  card(
    "c-pc-2",
    "plan_change",
    {
      kind: "grant",
      scope: "任务「博客迁移到 Astro」",
      summary: "扩大授权：第 4 阶段允许改 DNS 记录",
      before: "第 4 阶段：只部署到预览地址",
      after: "第 4 阶段：部署后把 blog 子域名指向新站点",
      affectedStages: ["第 4 阶段 · 上线"],
      reason: "你昨天在会话里说「测完直接切过去吧」，原计划没写切 DNS。",
    } satisfies PlanChangePayload,
    { urgency: "non_blocking", createdAt: at("10-06", "23:10") },
  ),
  card(
    "c-par-1",
    "parallel",
    {
      task: "家庭照片整理与去重",
      stage: "第 3 阶段 · 按事件归档",
      subagents: [
        { name: "子 agent 1", work: "归档 2015–2019 年的照片" },
        { name: "子 agent 2", work: "归档 2020 年以后的照片" },
      ],
      worktrees: false,
    } satisfies ParallelPayload,
    { urgency: "blocking", createdAt: at("10-07", "09:12") },
  ),
  card(
    "c-wo-1",
    "work_order",
    {
      id: "W-24",
      project: "家庭网盘",
      from: "任务「家庭照片整理与去重」的维护者",
      title: "把「手机备份/微信」目录也扫一遍",
      acceptance: ["出一份重复清单，格式同 W-22"],
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
];

// ---------- 秘书主线 ----------

const S = CHANNELS.secretary;

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
];

// ---------- 任务「家庭照片整理与去重」的维护者 ----------

const P = MAINTAINERS.photos;

const PHOTOS: MessageEnvelope[] = [
  msg(P, "system", at("10-05", "20:40"), text("任务书：把相册库和家庭网盘里 2015 年以来的照片去重、按事件归档。约束：重复的先放回收区，不直接删。涉及项目：相册库、家庭网盘。")),
  msg(P, "agent", at("10-05", "20:52"), think("两个项目都要扫描，跨项目任务只能派工单，不能直接动它们的目录。"), text("计划交上来了，请过目。"), cardRef("c-plan-photos")),
  msg(P, "system", at("10-05", "21:02"), text("计划已确认（勾掉 1 项授权：直接删除回收区）。进入第 1 阶段。")),
  msg(
    P,
    "agent",
    at("10-05", "21:05"),
    tool("read_project_records", "相册库 · 规格摘要、进展"),
    tool("dispatch_work_order", "→ 相册库 W-21：扫描重复照片，出清单", { disposition: "planned_only", withinGrant: true }),
    tool("dispatch_work_order", "→ 家庭网盘 W-22：扫描「手机备份」目录，出清单", { disposition: "planned_only", withinGrant: true }),
  ),
  msg(P, "system", at("10-06", "10:20"), text("回执：W-21、W-22 都已完成。第 1 阶段验收通过（脚本：清单覆盖两个目录）。")),
  msg(
    P,
    "agent",
    at("10-06", "10:31"),
    tool("bash", "python dedupe.py --dry-run /示例/相册 /示例/网盘/手机备份", { generic: true, result: "412 组重复，共 1,137 张" }),
    tool("move_files", "1,137 张重复照片 → 回收区/2026-10-06", { categories: ["删除或覆盖"], disposition: "do_then_tell", withinGrant: true, result: "已移动 1,137 张" }),
    tool("http_request", "POST photos.example.com/api/albums（同步相册）", {
      categories: ["以我的名义对外发送或发布"],
      disposition: "planned_only",
      withinGrant: false,
      outcome: "blocked",
      result: "计划里没列，已拦下并提醒维护者回到计划",
    }),
    tool("delete_files", "/示例/相册/2019/草稿", { categories: ["删除或覆盖"], disposition: "ask_first", outcome: "denied", result: "你拒绝了：「草稿目录别动」" }),
  ),
  msg(P, "agent", at("10-07", "09:00"), cardRef("c-prog-1")),
  msg(P, "agent", at("10-07", "09:05"), text("第 3 阶段要读照片的拍摄时间和地点，想加一个工具，提交了一张计划变更："), cardRef("c-pc-1")),
  msg(P, "agent", at("10-07", "09:12"), text("第 3 阶段可以按年份分两批并行："), cardRef("c-par-1")),
  msg(P, "agent", at("10-07", "09:15"), text("家庭网盘里还有一个微信备份目录，计划里没写，想加一张工单："), cardRef("c-wo-1")),
  msg(
    P,
    "agent",
    at("10-07", "09:20"),
    tool("bash", "rsync -av --delete /示例/相册/ 示例备份机:/相册/", {
      categories: ["删除或覆盖", "越出项目目录"],
      disposition: "ask_first",
      generic: true,
      outcome: "running",
      result: "等你批准",
    }),
    cardRef("c-appr-1"),
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
    tool("read", "inbox/2026-10-05/*.csv（3 个文件）"),
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
    tool("write", "rules/categories.yaml（新增「外卖」）", { categories: ["删除或覆盖"], disposition: "ask_first", outcome: "done", result: "你在卡片上批准了" }),
    tool("git_commit", "rules: 外卖单独成类", { disposition: "do_then_tell", result: "提交 3f9a1c2；做完告诉你" }),
    text("改好了，下次汇总生效。进展文档也写回了。"),
  ),
  msg(L, "user", at("10-06", "21:35"), text("以后月结单直接从邮箱里拿吧，别让我手动下载了")),
  msg(L, "agent", at("10-06", "21:36"), text("我现在的工具包里没有读邮箱的工具。这不在任何任务里，所以提交了一张工具包变更："), cardRef("c-tk-1")),
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
    tool("run_tests", "npm test", { result: "42 passed" }),
    tool("bash", "node scripts/migrate-posts.mjs --from hexo --to astro", { generic: true, result: "迁移 186 篇文章、1,024 张图片" }),
    tool("run_tests", "npm test", { result: "45 passed" }),
    tool("git_commit", "迁移文章和图片到 Astro", { disposition: "do_then_tell", result: "提交 a81c0de" }),
    tool("git_push", "origin astro-migration", { categories: ["以我的名义对外发送或发布"], disposition: "planned_only", withinGrant: true, result: "已推送" }),
    text("第 3 阶段的交付件做完了，交回执。"),
  ),
  msg(G, "user", at("10-06", "22:58"), text("测完直接切过去吧")),
  msg(G, "agent", at("10-06", "23:10"), text("切 DNS 不在原计划里，提交了一张计划变更："), cardRef("c-pc-2")),
  msg(G, "agent", at("10-07", "09:10"), tool("run_tests", "npm run test:e2e", { outcome: "running" })),
];

// ---------- 项目「家电档案」的维护者（立项问答） ----------

const A = MAINTAINERS.appliance;

const APPLIANCE: MessageEnvelope[] = [
  msg(A, "system", at("10-06", "22:06"), { type: "work_order_divider", workOrderId: "", title: "立项问答", from: "你" }),
  msg(A, "agent", at("10-06", "22:06"), text("先问几个问题把范围定下来：\n1. 现在大概有多少件电器？\n2. 保修单是纸质的多还是电子的多？\n3. 到期前多久提醒你？")),
  msg(A, "user", at("10-06", "22:15"), text("二十多件吧。纸质的多，我拍照给你。提前一个月提醒。")),
  msg(A, "agent", at("10-06", "22:28"), text("好，规格、术语表都写进项目档案了。立项书如下，确认就可以开工："), cardRef("c-charter-1")),
];

/** 原型启动时服务端"已有"的事件，按频道分组前的顺序 */
export const FAKE_HISTORY: { channel: string; type: string; payload: unknown }[] = [
  ...FAKE_CARDS.map((c) => ({ channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card: c } })),
  ...[...SECRETARY, ...PHOTOS, ...BILLS, ...LEDGER, ...BLOG, ...APPLIANCE].map((m) => ({ channel: m.conversation, type: EVENT_TYPES.message, payload: { message: m } })),
];
