// 原型的假数据：看板、项目、待我处理、设置、消耗。全部是虚构的，不含任何个人数据。
import type {
  ArchiveListData,
  BoardEntry,
  ScheduledJobSummary,
  ScopeRecord,
  SkillEntry,
  Stage,
  Toolkit,
  WorkOrder,
} from "../model/types.ts";
import {
  ASSISTANT_NAME_MARK,
  addTokens,
  type StageEffect,
  type ConversationId,
  type HolidayYear,
  type InboxItem,
  type LedgerRole,
  type LibrarySkill,
  localDate,
  type ModelPrice,
  type NoticeType,
  type PairedDevice,
  type Project,
  type TokenCounts,
  type SlashCommandEntry,
  type ToolkitCatalog,
  type UsageAgentRow,
  type UsageSummary,
  type UsageTally,
  type WatchCategoriesState,
  type WorkdaySettings,
  ZERO_TOKENS,
} from "../state/index.ts";
import { at, MAINTAINERS } from "./fake-conversations.ts";

// ---------- 任务看板 ----------

export const FAKE_BOARD: BoardEntry[] = (
  [
    // 等我
    {
      kind: "task",
      id: "t-photos",
      title: "家庭照片整理与去重",
      status: "waiting_for_user",
      waitReason: "approval",
      stage: { current: 2, total: 4 },
      activity: "waiting_for_user",
      tokens: 182_000,
      projects: ["相册库", "家庭网盘"],
      updatedAt: at("10-07", "09:20"),
    },
    {
      kind: "task",
      id: "t-bills",
      title: "每周汇总银行账单",
      status: "awaiting_confirm",
      activity: "waiting_for_user",
      tokens: 31_000,
      projects: ["记账本"],
      updatedAt: at("10-07", "08:40"),
    },
    { kind: "task", id: "t-health", title: "季度体检报告整理", status: "waiting_for_user", waitReason: "acceptance", stage: { current: 3, total: 3 }, activity: "waiting_for_user", tokens: 96_000, projects: [], updatedAt: at("10-06", "18:00") },
    { kind: "task", id: "t-ssl", title: "VPS 证书续期检查", status: "waiting_for_user", waitReason: "interrupted", stage: { current: 2, total: 2 }, activity: "waiting_for_user", tokens: 12_000, projects: [], updatedAt: at("10-07", "07:02") },
    {
      kind: "task",
      id: "t-tax",
      title: "个税年度汇算材料",
      status: "waiting_for_user",
      waitReason: "over_budget",
      // 90 号票：真的超预算任务看板卡、状态签浮层上写的原因（守护进程的说法，见 tasks/thresholds.ts）
      waitNote: "用了 452000 token、41 次工具调用（预算 200000 token、30 次），超过预算的 2 倍",
      stage: { current: 2, total: 3 },
      activity: "waiting_for_user",
      tokens: 640_000,
      projects: [],
      updatedAt: at("10-06", "16:45"),
    },
    { kind: "task", id: "t-nas", title: "NAS 硬盘健康巡检", status: "waiting_for_user", waitReason: "stuck", stage: { current: 1, total: 2 }, activity: "waiting_for_user", tokens: 45_000, projects: [], updatedAt: at("10-07", "06:30") },
    { kind: "task", id: "t-notes", title: "读书笔记整理成卡片", status: "waiting_for_user", waitReason: "clarification", stage: { current: 1, total: 3 }, activity: "waiting_for_user", tokens: 22_000, projects: [], updatedAt: at("10-06", "21:10") },
    // 进行中
    { kind: "task", id: "t-tokyo", title: "十一月东京行程", status: "planning", activity: "working", activityNote: "和你对齐意图", tokens: 8_000, projects: [], updatedAt: at("10-07", "08:31") },
    { kind: "task", id: "t-blog", title: "博客迁移到 Astro", status: "running", stage: { current: 3, total: 5 }, activity: "working", activityNote: "跑端到端测试", tokens: 356_000, projects: ["个人博客"], updatedAt: at("10-07", "09:10") },
    { kind: "task", id: "t-netdisk", title: "家庭网盘去重", status: "queued", activity: "queued", activityNote: "等项目「家庭网盘」", tokens: 0, projects: ["家庭网盘"], updatedAt: at("10-07", "07:40") },
    { kind: "task", id: "t-car", title: "车险比价", status: "paused", stage: { current: 1, total: 2 }, activity: "sleeping", tokens: 27_000, projects: [], updatedAt: at("10-06", "20:13") },
    // 运营中
    { kind: "reminder", id: "r-rent", title: "交房租", status: "pending", nextAt: at("10-08", "09:00"), schedule: { kind: "monthly", time: "09:00", days: [8] } },
    // "按我的工作日"在 29 号票加；原型先写成周一到周五
    { kind: "reminder", id: "r-weekly", title: "准备周会材料", status: "pending", nextAt: at("10-08", "17:30"), schedule: { kind: "weekly", time: "17:30", weekdays: [1, 2, 3, 4, 5] } },
    { kind: "reminder", id: "r-dentist", title: "看牙（洗牙）", status: "pending", nextAt: at("10-17", "10:00"), schedule: { kind: "once", at: at("10-17", "10:00") } },
    { kind: "reminder", id: "r-run", title: "跑步", status: "pending", nextAt: at("10-07", "19:00"), schedule: { kind: "weekly", time: "19:00", weekdays: [1, 3, 5] } },
    // 定时触发的任务（76 号票）是假连接里的真任务（fake-conversations.ts 的 FAKE_TIMED_TASK、FAKE_TIMED_WORKFLOW），不在这里
    // 最近结束
    { kind: "task", id: "t-resume", title: "简历更新", status: "done", stage: { current: 2, total: 2 }, activity: "sleeping", tokens: 88_000, projects: [], updatedAt: at("10-05", "11:00") },
    { kind: "task", id: "t-ledger-build", title: "搭一个记账本", status: "done", stage: { current: 4, total: 4 }, activity: "sleeping", tokens: 512_000, projects: ["记账本"], updatedAt: at("09-28", "20:00"), endNote: "已转为项目" },
    { kind: "task", id: "t-flight", title: "盯特价机票", status: "failed", stage: { current: 1, total: 2 }, activity: "sleeping", tokens: 41_000, projects: [], updatedAt: at("10-04", "12:00") },
    { kind: "task", id: "t-moving", title: "搬家清单", status: "cancelled", activity: "sleeping", tokens: 5_000, projects: [], updatedAt: at("10-02", "09:00") },
    { kind: "reminder", id: "r-visa", title: "续签证材料", status: "fired", nextAt: at("10-03", "10:00"), schedule: { kind: "once", at: at("10-03", "10:00") } },
    // 已归档
    { kind: "task", id: "t-oldphone", title: "旧手机数据迁移", status: "archived", stage: { current: 2, total: 2 }, activity: "sleeping", tokens: 64_000, projects: [], updatedAt: at("09-10", "10:00") },
    { kind: "task", id: "t-review", title: "上半年总结", status: "archived", stage: { current: 1, total: 1 }, activity: "sleeping", tokens: 33_000, projects: [], updatedAt: at("07-02", "10:00") },
  ] satisfies BoardEntry[]
).map(withProgress);

/**
 * 假长程任务看板卡上的进度（60 号票：已验收的阶段数）：在第几阶段就是前面几个验收了，做完、归档的全部验收了；
 * 还在规划、等确认计划的尚无计划
 */
function withProgress(e: BoardEntry): BoardEntry {
  if (e.kind !== "task") return e;
  if (e.stage) return { ...e, progress: { done: e.status === "done" || e.status === "archived" ? e.stage.total : e.stage.current - 1, total: e.stage.total, unit: "stage" } };
  return e.status === "planning" || e.status === "awaiting_confirm" ? { ...e, progress: { done: 0, total: 0, unit: "stage" } } : e;
}

/** 全局最多几个任务同时处于执行中（规格第 8 节默认 3，可调）。原型里用它判断"继续"回执行中还是排队中 */
export const FAKE_RUN_SLOTS = 3;

// ---------- 任务详情 ----------

export interface TaskDetail {
  /** 维护者会话的频道 */
  maintainer?: ConversationId;
  /** 只涉及一个项目的任务由该项目的维护者执行 */
  executedBy?: string;
  planCardId?: string;
  stages: Stage[];
  workOrders: WorkOrder[];
  toolkit: Toolkit;
  /** 按 agent（含子 agent）细分的 token */
  tokensByAgent: { agent: string; tokens: number }[];
  scopeRecords: ScopeRecord[];
}

// 84 号票：阶段详情的执行方式理由和初步思路、要你留意的（权、外、问）、规则原文（点进详情）
const NO_MARKS = { perm: [], out: [], ask: [] };
const PHOTO_STAGES: Stage[] = [
  {
    id: "s1",
    title: "盘点两边的照片",
    status: "accepted",
    deliverable: "照片清单和重复估计",
    acceptance: [
      { text: "清单覆盖两个目录", method: "script", result: "pass" },
      { text: "你看过清单，确认要整理的目录都在里面", method: "user", result: "pass" },
    ],
    mode: "open",
    modeReason: "两边的目录怎么组织还不清楚，先各自扫一遍再说",
    roughIdea: "给两个项目各派一张扫描工单，拿到清单后按文件内容的哈希估重复",
    after: [],
    grants: ["给「相册库」「家庭网盘」各派一张扫描工单"],
    marks: {
      perm: [{ text: "给「相册库」「家庭网盘」各派一张扫描工单：派工单 · 动别的项目：项目是 相册库、家庭网盘；最多 2 次", grantId: "dispatch-scan", limit: 2 }],
      out: [],
      ask: [{ text: "有 1 条标准要你亲自验收：你看过清单，确认要整理的目录都在里面" }],
    },
    rules: [],
    ruleDocs: [],
    budget: { tokens: 60_000, usedTokens: 41_000, toolCalls: 40, usedToolCalls: 12 },
  },
  {
    id: "s2",
    title: "找出重复并移进回收区",
    status: "waiting",
    deliverable: "重复清单；重复照片移进回收区",
    acceptance: [{ text: "回收区里的每张都能在保留区找到同一张", method: "script" }],
    mode: "steps",
    modeReason: "移动照片的先后不能乱：先演练、再移、再核对",
    steps: ["演练一遍，出重复清单", "把重复照片移进回收区", "核对回收区和保留区一一对得上"],
    after: ["s1"],
    grants: ["把重复照片移进回收区（不超过 2000 张）"],
    marks: {
      perm: [{ text: "把重复照片移进回收区（不超过 2000 张）：通用 bash · 删除或覆盖：最多 2000 次", grantId: "move-duplicates", limit: 2000 }],
      out: [],
      ask: [{ text: "同步到备份机（rsync --delete）：每次都当场问你" }],
    },
    rules: ["照片一律先移进回收区，不许直接删除", "删除或覆盖之前必须已备份或已 git 提交"],
    ruleDocs: [
      { id: "recycle-not-delete", title: "照片一律先移进回收区，不许直接删除", trigger: { tool: "delete" }, on_violation: "block" },
      { id: "backup-before-overwrite", title: "删除或覆盖之前必须已备份或已 git 提交", trigger: { tool: "write" }, require: { before: { tool: "git_commit" } }, on_violation: "pull_back" },
    ],
    budget: { tokens: 150_000, usedTokens: 141_000, toolCalls: 120, usedToolCalls: 77 },
    incident: true,
  },
  {
    id: "s3",
    title: "按事件归档",
    status: "pending",
    deliverable: "按事件分好的目录",
    acceptance: [{ text: "抽查 20 个事件目录", method: "review" }],
    mode: "open",
    modeReason: "事件怎么分要看照片的时间和地点，没法事先写死",
    roughIdea: "先按拍摄日期聚成簇，再用拍摄地点把同一天的分开",
    after: ["s2"],
    grants: ["在相册库里新建、改名事件目录"],
    marks: { perm: [{ text: "在相册库里新建、改名事件目录：派工单 · 动别的项目：项目是 相册库", grantId: "event-dirs" }], out: [], ask: [] },
    rules: [],
    ruleDocs: [],
    budget: { tokens: 200_000, usedTokens: 0, toolCalls: 300, usedToolCalls: 0 },
  },
  {
    id: "s4",
    title: "你过目",
    status: "pending",
    deliverable: "归档结果的说明",
    acceptance: [{ text: "你确认归档结果", method: "user" }],
    mode: "steps",
    modeReason: "最后由你过目，维护者只写说明",
    after: ["s3"],
    grants: [],
    marks: { perm: [], out: [], ask: [{ text: "有 1 条标准要你亲自验收：你确认归档结果" }] },
    rules: [],
    ruleDocs: [],
    budget: { tokens: 20_000, usedTokens: 0, toolCalls: 10, usedToolCalls: 0 },
  },
];

const BILL_STAGES: Stage[] = [
  { id: "s1", title: "摸清账单来源", status: "pending", deliverable: "三张卡的账单来源说明和样例文件", acceptance: [{ text: "三张卡各拿到一份上周的样例", method: "script" }], mode: "open", after: [], grants: ["读邮箱里带「月结单」的邮件附件"], rules: [], budget: { tokens: 80_000, usedTokens: 0, toolCalls: 60, usedToolCalls: 0 } },
  { id: "s2", title: "写导出和去重脚本", status: "pending", deliverable: "导出脚本、去重脚本和测试", acceptance: [{ text: "测试全部通过", method: "script" }, { text: "脚本不往外发任何东西", method: "review" }], mode: "steps", after: ["s1"], grants: ["在记账本的工作目录里写、改脚本"], rules: ["删除或覆盖历史数据之前必须已 git 提交"], budget: { tokens: 200_000, usedTokens: 0, toolCalls: 150, usedToolCalls: 0 } },
  { id: "s3", title: "接进记账本、出第一份周报", status: "pending", deliverable: "周汇总和第一份周报", acceptance: [{ text: "你看过第一份周报", method: "user" }], mode: "steps", after: ["s2"], grants: ["追加周汇总", "登记定时作业"], rules: [], budget: { tokens: 120_000, usedTokens: 0, toolCalls: 80, usedToolCalls: 0 } },
];

const BLOG_STAGES: Stage[] = [
  { id: "s1", title: "搭 Astro 骨架", status: "accepted", deliverable: "能跑起来的 Astro 站点", acceptance: [{ text: "构建通过", method: "script", result: "pass" }], mode: "steps", after: [], grants: [], marks: NO_MARKS, rules: [], ruleDocs: [], budget: { tokens: 60_000, usedTokens: 52_000, toolCalls: 50, usedToolCalls: 31 } },
  {
    id: "s2",
    title: "迁移主题样式",
    status: "accepted",
    deliverable: "和旧站一致的样式",
    acceptance: [{ text: "评审对比 10 个页面", method: "review", result: "pass" }],
    mode: "open",
    modeReason: "旧主题的样式写得很散，逐页对照着改比事先列步骤靠谱",
    roughIdea: "先搬全局样式和字体，再逐页对照旧站截图修差异",
    after: ["s1"],
    grants: [],
    marks: NO_MARKS,
    rules: [],
    ruleDocs: [],
    budget: { tokens: 100_000, usedTokens: 118_000, toolCalls: 80, usedToolCalls: 64 },
  },
  {
    id: "s3",
    title: "迁移文章和图片",
    status: "running",
    deliverable: "186 篇文章和图片",
    acceptance: [{ text: "所有文章链接不 404", method: "script" }],
    mode: "steps",
    modeReason: "迁移脚本和先后都定好了，照做就行",
    steps: ["跑迁移脚本搬文章", "搬图片并改引用", "跑链接检查", "推送到 astro-migration 分支"],
    after: ["s2"],
    grants: ["推送到 astro-migration 分支"],
    marks: { perm: [], out: [{ text: "推送到 astro-migration 分支：git 推送（git_push）· 以我的名义对外发送或发布：remote 是 origin，branch 是 astro-migration；最多 3 次", grantId: "push-branch", limit: 3 }], ask: [] },
    rules: ["push 之前必须跑过测试"],
    ruleDocs: [{ id: "test-before-push", title: "push 之前必须跑过测试", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" }],
    budget: { tokens: 120_000, usedTokens: 96_000, toolCalls: 100, usedToolCalls: 58 },
  },
  {
    id: "s4",
    title: "上线",
    status: "pending",
    deliverable: "部署到预览地址",
    acceptance: [{ text: "你在预览地址看过", method: "user" }],
    mode: "steps",
    after: ["s3"],
    grants: ["部署到预览地址"],
    marks: { perm: [], out: [{ text: "部署到预览地址：部署 · 以我的名义对外发送或发布：最多 1 次", grantId: "deploy-preview", limit: 1 }], ask: [{ text: "有 1 条标准要你亲自验收：你在预览地址看过" }] },
    rules: [],
    ruleDocs: [],
    budget: { tokens: 40_000, usedTokens: 0, toolCalls: 30, usedToolCalls: 0 },
  },
  { id: "s5", title: "收尾", status: "pending", deliverable: "旧站下线说明", acceptance: [{ text: "评审", method: "review" }], mode: "open", after: ["s4"], grants: [], marks: NO_MARKS, rules: [], ruleDocs: [], budget: { tokens: 20_000, usedTokens: 0, toolCalls: 20, usedToolCalls: 0 } },
];

/**
 * 阶段详情从守护进程现取的（84 号票，原型的 fake-http 给）：授权已用几次（任务 → 阶段 → 授权项），
 * 各阶段这一轮已经做了的事（本机的、对外的）
 */
export const FAKE_GRANT_USES: Readonly<Record<string, Readonly<Record<string, { grantId: string; used: number }[]>>>> = {
  "t-photos": { s1: [{ grantId: "dispatch-scan", used: 2 }], s2: [{ grantId: "move-duplicates", used: 1 }] },
  "t-blog": { s3: [{ grantId: "push-branch", used: 1 }] },
};
export const FAKE_STAGE_EFFECTS: Readonly<Record<string, readonly StageEffect[]>> = {
  "t-photos": [{ stageId: "s2", tool: "bash", toolTitle: "通用 bash", argsSummary: "python dedupe.py --verify 回收区/2026-10-06", reach: "local", at: at("10-06", "18:20") }],
  "t-blog": [
    { stageId: "s2", tool: "write", toolTitle: "写文件", argsSummary: "src/styles/global.css", reach: "local", at: at("10-05", "15:10") },
    { stageId: "s2", tool: "bash", toolTitle: "通用 bash", argsSummary: "npm install @fontsource/noto-serif-sc", reach: "local", at: at("10-05", "15:30") },
    { stageId: "s3", tool: "bash", toolTitle: "通用 bash", argsSummary: "node scripts/migrate-posts.mjs ../old-blog/_posts src/content/posts", reach: "local", at: at("10-06", "21:00") },
    { stageId: "s3", tool: "git_push", toolTitle: "git 推送", argsSummary: "remote=origin branch=astro-migration", reach: "external", at: at("10-07", "08:40") },
  ],
};

// 90 号票：等我 · 超预算的长程任务（第 2 阶段用量超过预算的 2 倍停下）
const TAX_STAGES: Stage[] = [
  {
    id: "s1",
    title: "收齐收入和扣缴凭证",
    status: "accepted",
    deliverable: "收入汇总.md",
    acceptance: [{ text: "工资、劳务报酬逐月对得上扣缴记录", method: "script", result: "pass" }],
    mode: "open",
    after: [],
    grants: ["读材料目录"],
    rules: [],
    budget: { tokens: 120_000, usedTokens: 96_000, toolCalls: 40, usedToolCalls: 22 },
  },
  {
    id: "s2",
    title: "核对专项附加扣除",
    status: "waiting",
    waitReason: "over_budget",
    waitNote: "用了 452000 token、41 次工具调用（预算 200000 token、30 次），超过预算的 2 倍",
    deliverable: "扣除项核对表",
    acceptance: [{ text: "每一项扣除都有凭证对应", method: "review" }],
    mode: "open",
    after: ["s1"],
    grants: ["读材料目录"],
    rules: [],
    budget: { tokens: 200_000, usedTokens: 452_000, toolCalls: 30, usedToolCalls: 41 },
    incident: true,
  },
  {
    id: "s3",
    title: "填汇算草表",
    status: "pending",
    deliverable: "汇算草表",
    acceptance: [{ text: "你看过草表", method: "user" }],
    mode: "steps",
    steps: ["按核对表填草表", "写一页说明"],
    after: ["s2"],
    grants: [],
    rules: [],
    budget: { tokens: 80_000, toolCalls: 20 },
  },
];

const DEFAULT_DETAIL: TaskDetail = {
  stages: [],
  workOrders: [],
  toolkit: { skills: [], mcps: [], bash: false, network: false },
  tokensByAgent: [],
  scopeRecords: [],
};

export const FAKE_TASK_DETAILS: Record<string, TaskDetail> = {
  "t-photos": {
    maintainer: MAINTAINERS.photos,
    planCardId: "c-plan-photos",
    stages: PHOTO_STAGES,
    workOrders: [
      { id: "W-21", title: "扫描重复照片，出清单", project: "相册库", from: "本任务", status: "done", updatedAt: at("10-06", "09:40") },
      { id: "W-22", title: "扫描「手机备份」目录，出清单", project: "家庭网盘", from: "本任务", status: "done", updatedAt: at("10-06", "10:15") },
      { id: "W-24", title: "把「手机备份/微信」目录也扫一遍", project: "家庭网盘", from: "本任务（计划外）", status: "waiting_for_user", updatedAt: at("10-07", "09:15") },
      { id: "W-25", title: "按事件新建目录", project: "相册库", from: "本任务", status: "queued", updatedAt: at("10-07", "09:00") },
    ],
    toolkit: { skills: [], mcps: [], bash: true, network: false },
    tokensByAgent: [
      { agent: "任务维护者", tokens: 121_000 },
      { agent: "相册库的维护者（W-21）", tokens: 38_000 },
      { agent: "家庭网盘的维护者（W-22）", tokens: 23_000 },
    ],
    scopeRecords: [{ id: "sr1", kind: "change", text: "你在会话里同意先扫「手机备份」以外的目录（范围变更）", at: at("10-06", "10:40") }],
  },
  "t-tax": {
    maintainer: MAINTAINERS.tax,
    stages: TAX_STAGES,
    workOrders: [],
    toolkit: { skills: ["demo-pdf-reader"], mcps: [], bash: false, network: false },
    tokensByAgent: [
      { agent: "任务维护者", tokens: 588_000 },
      { agent: "评审子 agent", tokens: 52_000 },
    ],
    scopeRecords: [],
  },
  "t-bills": {
    maintainer: MAINTAINERS.bills,
    planCardId: "c-plan-bills",
    stages: BILL_STAGES,
    workOrders: [],
    toolkit: { skills: ["demo-pdf-reader"], mcps: ["demo-mail-readonly"], bash: true, network: false },
    tokensByAgent: [{ agent: "任务维护者（起草计划）", tokens: 31_000 }],
    scopeRecords: [],
  },
  "t-blog": {
    maintainer: MAINTAINERS.blog,
    executedBy: "个人博客的维护者",
    stages: BLOG_STAGES,
    workOrders: [
      { id: "W-28", title: "第 1 阶段：搭 Astro 骨架", project: "个人博客", from: "本任务", status: "done", updatedAt: at("10-03", "20:00") },
      { id: "W-29", title: "第 2 阶段：迁移主题样式", project: "个人博客", from: "本任务", status: "done", updatedAt: at("10-05", "17:00") },
      { id: "W-30", title: "第 3 阶段：迁移文章和图片", project: "个人博客", from: "本任务", status: "in_progress", updatedAt: at("10-07", "09:10") },
    ],
    toolkit: { skills: [], mcps: [], bash: true, network: true },
    tokensByAgent: [
      { agent: "个人博客的维护者", tokens: 301_000 },
      { agent: "评审子 agent", tokens: 55_000 },
    ],
    scopeRecords: [],
  },
};

export function taskDetailOf(id: string): TaskDetail {
  return FAKE_TASK_DETAILS[id] ?? DEFAULT_DETAIL;
}

// ---------- 项目 ----------

/**
 * 假项目（15 号票起是协议包里的 Project，由假连接作为项目列表频道上的 project 事件推来）。
 * 维护者 id 和 fake-conversations.ts 里 MAINTAINERS 的会话对得上（记账本、个人博客、家电档案有假会话）
 */
function fakeProject(x: Pick<Project, "id" | "name" | "goal" | "state"> & Partial<Project>): Project {
  return {
    origin: "suggestion",
    maintainerId: `project-${x.id.slice(2)}`,
    workdir: { external: false },
    charterConfirmed: x.state !== "preparing",
    createdAt: at("09-01", "10:00"),
    updatedAt: at("10-06", "22:30"),
    ...x,
  };
}

export const FAKE_PROJECTS: Project[] = [
  fakeProject({ id: "p-ledger", name: "记账本", goal: "所有银行和支付账单进一个本子，按月出报表", state: "in_use", kind: "dev", toolkit: { skills: ["demo-pdf-reader"], mcp: [], bash: true, network: false } }),
  fakeProject({
    id: "p-blog",
    name: "个人博客",
    goal: "写东西的地方，从 Hexo 迁到 Astro",
    state: "in_use",
    kind: "dev",
    workdir: { external: true, path: "/示例/外部/blog" },
    toolkit: { skills: [], mcp: [], bash: true, network: true },
  }),
  fakeProject({ id: "p-photos", name: "相册库", goal: "全家的照片按事件归档，一处可查", state: "building", kind: "other", buildTaskId: "t-photos", toolkit: { skills: [], mcp: [], bash: false, network: false } }),
  fakeProject({ id: "p-netdisk", name: "家庭网盘", goal: "家里的文件统一放一处，自动去重和备份", state: "in_use", kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: false } }),
  fakeProject({ id: "p-appliance", name: "家电档案", goal: "家里电器的保修单、说明书和维修记录收在一处", state: "preparing", charterCardId: "c-charter-1" }),
  fakeProject({ id: "p-oldsite", name: "旧作品集网站", goal: "以前的作品集，不再更新", state: "retired", kind: "dev" }),
  fakeProject({ id: "p-jp", name: "日语学习", goal: "每天十个单词，周末复习", state: "archived", archivedFrom: "in_use", kind: "other" }),
];

/** 项目页上还没接真数据的部分（定时作业 19、工单流水线 16、工具包的查看和修改 27、范围记录 18）：只有原型的假项目有 */
export interface ProjectDetail {
  scheduledJobs: ScheduledJobSummary[];
  workOrders: WorkOrder[];
  toolkit: Toolkit;
  scopeRecords: ScopeRecord[];
}

export const FAKE_PROJECT_DETAILS: Record<string, ProjectDetail> = {
  "p-ledger": {
    scheduledJobs: [
      { kind: "scheduled_job", id: "sj-daily-bills", title: "每天 21:00 汇总当天账单", status: "active", schedule: "每天 21:00", lastRun: { at: at("10-06", "21:00"), ok: false } },
      { kind: "scheduled_job", id: "sj-monthly", title: "每月 1 号出月报", status: "paused", schedule: "每月 1 号 09:00", lastRun: { at: at("10-01", "09:00"), ok: true } },
    ],
    workOrders: [
      { id: "W-17", title: "每日汇总（10-07 21:00 的运行）", project: "记账本", from: "定时作业", status: "queued", updatedAt: at("10-07", "09:00") },
      { id: "W-16", title: "每日汇总（10-06 21:00 的运行）", project: "记账本", from: "定时作业", status: "unable", updatedAt: at("10-06", "21:01") },
      { id: "W-15", title: "每日汇总（10-05 21:00 的运行）", project: "记账本", from: "定时作业", status: "done", updatedAt: at("10-05", "21:01") },
      { id: "W-12", title: "分类规则加上「订阅」", project: "记账本", from: "任务「搭一个记账本」", status: "done", updatedAt: at("09-28", "19:00") },
    ],
    toolkit: { skills: ["demo-pdf-reader"], mcps: [], bash: true, network: false },
    scopeRecords: [
      { id: "sr-l1", kind: "overreach", text: "读了「家庭网盘」项目里的 budget-2025.xlsx（没有授权）", at: at("10-06", "21:40") },
      { id: "sr-l2", kind: "change", text: "你让它把「外卖」从餐饮里拆出来（范围变更，已写进项目档案）", at: at("10-06", "21:31") },
    ],
  },
  "p-blog": {
    scheduledJobs: [],
    workOrders: [
      { id: "W-30", title: "第 3 阶段：迁移文章和图片", project: "个人博客", from: "任务「博客迁移到 Astro」", status: "in_progress", updatedAt: at("10-07", "09:10") },
      { id: "W-29", title: "第 2 阶段：迁移主题样式", project: "个人博客", from: "任务「博客迁移到 Astro」", status: "done", updatedAt: at("10-05", "17:00") },
      { id: "W-28", title: "第 1 阶段：搭 Astro 骨架", project: "个人博客", from: "任务「博客迁移到 Astro」", status: "done", updatedAt: at("10-03", "20:00") },
    ],
    toolkit: { skills: [], mcps: [], bash: true, network: true },
    scopeRecords: [],
  },
  "p-appliance": {
    scheduledJobs: [],
    workOrders: [],
    toolkit: { skills: ["demo-pdf-reader"], mcps: [], bash: false, network: false },
    scopeRecords: [],
  },
  "p-photos": {
    scheduledJobs: [{ kind: "scheduled_job", id: "sj-photo-backup", title: "每周日备份照片", status: "paused", schedule: "每周日 03:00", lastRun: { at: at("10-04", "03:00"), ok: false }, autoPaused: true }],
    workOrders: [
      { id: "W-25", title: "按事件新建目录", project: "相册库", from: "任务「家庭照片整理与去重」", status: "queued", updatedAt: at("10-07", "09:00") },
      { id: "W-21", title: "扫描重复照片，出清单", project: "相册库", from: "任务「家庭照片整理与去重」", status: "done", updatedAt: at("10-06", "09:40") },
    ],
    toolkit: { skills: [], mcps: [], bash: true, network: false },
    scopeRecords: [],
  },
};

/** 原型假项目的这些部分；真项目（守护进程推来的）没有，项目页上不显示这几节 */
export function projectDetailOf(id: string): ProjectDetail | undefined {
  return FAKE_PROJECT_DETAILS[id];
}

// ---------- 待我处理 ----------

type Fresh = Pick<InboxItem, "id" | "title" | "source" | "urgency" | "createdAt" | "read"> & { archived?: boolean };

function cardItem(x: Fresh & { cardId: string }): InboxItem {
  return { kind: "card", version: 1, pinned: false, archived: false, deleted: false, ...x };
}

function notice(x: Fresh & { notice: NoticeType; body: string; actions: string[]; pinned?: boolean; archiveList?: ArchiveListData["archiveList"] }): InboxItem {
  const { archiveList, ...rest } = x;
  return { kind: "notice", version: 1, pinned: false, archived: false, deleted: false, ...rest, ...(archiveList ? { data: { archiveList } satisfies ArchiveListData } : {}) };
}

export const FAKE_INBOX: InboxItem[] = [
  notice({ id: "i-rent", notice: "reminder_due", title: "该交房租了", body: "每月 8 号 09:00 的提醒。", source: "简单提醒", urgency: "non_blocking", createdAt: at("10-07", "09:00"), read: false, pinned: true, actions: ["知道了"] }),
  cardItem({ id: "i-appr", cardId: "c-appr-1", title: "批准一条会删除备份端文件的 rsync？", source: "任务「家庭照片整理与去重」", urgency: "blocking_deadline", createdAt: at("10-07", "09:20"), read: false }),
  cardItem({ id: "i-plan", cardId: "c-plan-bills", title: "计划等你确认：每周汇总银行账单", source: "任务「每周汇总银行账单」", urgency: "blocking", createdAt: at("10-07", "08:40"), read: false }),
  cardItem({ id: "i-par", cardId: "c-par-1", title: "并行确认：家庭照片整理与去重", source: "任务「家庭照片整理与去重」", urgency: "non_blocking", createdAt: at("10-07", "09:12"), read: false }),
  cardItem({ id: "i-wo", cardId: "c-wo-1", title: "计划外工单：把「手机备份/微信」也扫一遍", source: "任务「家庭照片整理与去重」", urgency: "blocking", createdAt: at("10-07", "09:15"), read: true }),
  cardItem({ id: "i-pc", cardId: "c-pc-1", title: "计划变更：第 3 阶段加 MCP「demo-exif-reader」", source: "任务「家庭照片整理与去重」", urgency: "blocking", createdAt: at("10-07", "09:05"), read: true }),
  cardItem({ id: "i-pc2", cardId: "c-pc-2", title: "扩大授权：上线时改 DNS 记录", source: "任务「博客迁移到 Astro」", urgency: "non_blocking", createdAt: at("10-06", "23:10"), read: true }),
  notice({
    id: "i-ssl",
    notice: "interrupted",
    title: "中断：不确定「重启 nginx」是否已执行",
    body: "守护进程 07:01 被重启时，任务「VPS 证书续期检查」正在执行 ssh 上 VPS 重启 nginx，说不清做没做完。任务已转为等我。",
    source: "任务「VPS 证书续期检查」",
    urgency: "blocking",
    createdAt: at("10-07", "07:02"),
    read: true,
    actions: ["已经执行了，继续", "没执行，重做这一步", "我自己去看看"],
  }),
  notice({
    id: "i-nas",
    notice: "stuck_help",
    title: "卡住求助：smartctl 读不到 sdb",
    body: "任务「NAS 硬盘健康巡检」拉回 3 次仍没进展：smartctl 对 /dev/sdb 返回权限错误。需要你决定怎么办。",
    source: "任务「NAS 硬盘健康巡检」",
    urgency: "blocking",
    createdAt: at("10-07", "06:30"),
    read: false,
    actions: ["我来看看", "跳过 sdb", "取消任务"],
  }),
  cardItem({ id: "i-pair", cardId: "c-pair-1", title: "新设备请求配对：iPad · Safari", source: "设备配对", urgency: "non_blocking", createdAt: at("10-07", "09:30"), read: false }),
  cardItem({ id: "i-charter", cardId: "c-charter-1", title: "立项书等你确认：家电档案", source: "项目「家电档案」", urgency: "non_blocking", createdAt: at("10-06", "22:30"), read: true }),
  notice({
    id: "i-scope",
    notice: "out_of_scope",
    title: "越界：记账本的维护者读了「家庭网盘」的文件",
    body: "范围审视（10-06 21:40）：维护者读了家庭网盘里的 budget-2025.xlsx，没有授权。只记录，没有暂停它。",
    source: "项目「记账本」",
    urgency: "non_blocking",
    createdAt: at("10-06", "21:40"),
    read: true,
    actions: ["算范围变更（是我让它读的）", "知道了"],
  }),
  notice({ id: "i-backup", notice: "backup_failed", title: "昨晚的备份没写进同步目录", body: "03:30 的备份：快照已在本机做好，但配置里的同步目录（华为家庭存储）不存在。", source: "系统", urgency: "non_blocking", createdAt: at("10-07", "03:31"), read: false, actions: ["重试", "知道了"] }),
  notice({ id: "i-sjob", notice: "scheduled_job_auto_paused", title: "定时作业「每周日备份照片」已自动暂停", body: "连续失败 3 次（10-04、09-27、09-20），最近一次：NAS 没挂载。", source: "项目「相册库」", urgency: "non_blocking", createdAt: at("10-04", "03:05"), read: true, actions: ["恢复", "保持暂停"] }),
  notice({
    id: "i-archive",
    notice: "archive_list",
    title: "归档清单：3 个任务结束超过 7 天",
    body: "每项可选：归档、继续改（返工）、先留着。",
    source: "系统",
    urgency: "non_blocking",
    createdAt: at("10-05", "09:00"),
    read: true,
    actions: ["完成"],
    archiveList: [
      { task: "搭一个记账本（已转为项目）", endedAt: at("09-28", "20:00") },
      { task: "搬家清单（已取消）", endedAt: at("09-25", "09:00") },
      { task: "盯特价机票（失败）", endedAt: at("09-26", "12:00") },
    ],
  }),
  notice({ id: "i-grant", notice: "grant_renewal", title: "授权明天到期：移动重复照片", body: "任务「家庭照片整理与去重」第 2 阶段的授权「把重复照片移进回收区」明天 21:02 到期。", source: "任务「家庭照片整理与去重」", urgency: "non_blocking", createdAt: at("10-07", "08:00"), read: false, actions: ["续期 7 天", "让它到期"] }),
  notice({ id: "i-missed", notice: "missed_reminder", title: "错过的提醒：周日 10:00 买菜", body: "电脑关机期间错过，晚了 26 小时，按规则改放到这里。", source: "简单提醒", urgency: "non_blocking", createdAt: at("10-05", "12:00"), read: true, actions: ["知道了"] }),
  notice({ id: "i-snap", notice: "snapshot_check_failed", title: "周校验没通过：10-04 的快照", body: "打开 10-04 快照里的 ergou.db 做完整性检查失败（page 1882 校验和不对）。", source: "系统", urgency: "non_blocking", createdAt: at("10-05", "04:00"), read: true, actions: ["重新校验", "知道了"] }),
  notice({ id: "i-fail", notice: "failure_choice", title: "「盯特价机票」失败了", body: "航司页面改版，脚本连续 3 天抓不到价格。", source: "任务「盯特价机票」", urgency: "non_blocking", createdAt: at("10-04", "12:00"), read: true, actions: ["重试", "重新起草计划再试", "放弃"] }),
  notice({ id: "i-old", notice: "missed_reminder", title: "错过的提醒：周五 18:00 取快递", body: "晚了 3 小时。", source: "简单提醒", urgency: "non_blocking", createdAt: at("10-03", "21:00"), read: true, actions: ["知道了"], archived: true }),
];

// ---------- 设置 ----------

/** 关注类别设置：假连接作为关注类别频道上的设置事件推给前端状态层（守护进程那边由数据目录配置区的文件画出来） */
export const FAKE_WATCH_CATEGORIES: WatchCategoriesState = {
  builtin: [
    { id: "spend_money", title: "花钱", defaults: { chat: "hand_to_me", task: "hand_to_me" }, chat: "hand_to_me", task: "hand_to_me" },
    { id: "external_send", title: "以我的名义对外发送或发布", defaults: { chat: "ask_first", task: "planned_only" }, chat: "ask_first", task: "planned_only" },
    { id: "delete_or_overwrite", title: "删除或覆盖（项目档案和工作目录内）", defaults: { chat: "ask_first", task: "do_then_tell" }, chat: "ask_first", task: "ask_first" },
    { id: "irreversible_commit", title: "不可逆的提交", defaults: { chat: "ask_first", task: "planned_only" }, chat: "ask_first", task: "planned_only" },
    { id: "account_security", title: "账户与安全（凭据、权限、全局装软件）", defaults: { chat: "ask_first", task: "ask_first" }, chat: "ask_first", task: "ask_first" },
    { id: "outside_project", title: "越出项目目录", defaults: { chat: "ask_first", task: "planned_only" }, chat: "ask_first", task: "planned_only" },
    { id: "memory_out_of_scope", title: "使用授权范围外的记忆", defaults: { chat: "ask_first", task: "ask_first" }, chat: "ask_first", task: "ask_first" },
    { id: "unplanned_work_order", title: "计划外工单", defaults: { chat: null, task: "ask_first" }, chat: null, task: "ask_first" },
    { id: "unknown_write", title: "未知的写操作", defaults: { chat: "ask_first", task: "ask_first" }, chat: "ask_first", task: "ask_first" },
  ],
  bottomLines: [
    { id: "payment_account_auth", title: "付款转账、创建账户、改密码或两步验证", disposition: "hand_to_me" },
    { id: "secret_in_outbound", title: "把凭据写进对外内容", disposition: "never" },
  ],
  custom: [
    { id: "c-1", title: "给房东发邮件", match: { recipients: ["landlord@example.com"] }, chat: "ask_first", task: "ask_first" },
    { id: "c-2", title: "动财务文件夹", match: { paths: ["D:\\示例\\财务"] }, chat: "ask_first", task: "do_then_tell" },
  ],
  tools: [
    { name: "write", title: "写文件" },
    { name: "edit", title: "改文件" },
    { name: "delete", title: "删除" },
    { name: "git_push", title: "git 推送" },
    { name: "http_request", title: "HTTP 请求" },
    { name: "quick_action:remember", title: "快速动作：记住" },
  ],
  problems: [],
};

/** 已配对设备：假连接作为已配对设备频道上的 device 事件推给前端状态层 */
export const FAKE_DEVICES: PairedDevice[] = [
  { id: "d1", name: "iPhone · Safari（iOS 19）", from: "经隧道 · 203.0.113.24", pairedAt: at("09-12", "21:00"), activated: true, lastUsedAt: at("10-07", "08:31"), expiresAt: "2027-10-07T08:31:00+08:00", revoked: false },
  { id: "d2", name: "华为 MatePad · 浏览器（HarmonyOS 6）", from: "经隧道 · 198.51.100.7", pairedAt: at("08-30", "10:00"), activated: true, lastUsedAt: at("10-05", "22:10"), expiresAt: "2027-10-05T22:10:00+08:00", revoked: false },
  {
    id: "d3",
    name: "公司电脑 · Edge（Windows 11）",
    from: "经隧道 · 192.0.2.80",
    pairedAt: at("08-01", "09:00"),
    activated: true,
    lastUsedAt: at("09-02", "18:00"),
    expiresAt: "2027-09-02T18:00:00+08:00",
    revoked: true,
    revokedAt: at("09-03", "09:00"),
  },
];

export const FAKE_SKILLS: SkillEntry[] = [
  { id: "sk-sample", name: "demo-weekly-report", description: "框架自带的示例 skill，演示 skill 的写法（假数据）。", origin: "framework", usedBy: [] },
  { id: "sk-pdf", name: "demo-pdf-reader", description: "读 PDF、抽取文字和表格（假数据）。", origin: "imported", usedBy: ["项目「记账本」", "项目「家电档案」", "任务「每周汇总银行账单」"] },
  { id: "sk-receipt", name: "demo-receipt-ocr", description: "识别小票和发票上的金额（假数据）。", origin: "imported", usedBy: [] },
  { id: "sk-photo", name: "demo-photo-sorter", description: "按拍摄时间和地点给照片分组（假数据）。", origin: "imported", usedBy: ["项目「相册库」"] },
];

/** 原型的 skill 集合（72 号票）：整套导入的两套假集合，skill 库页上各显示成一项 */
const FAKE_COLLECTIONS: { name: string; source: string; version: string; description: string; skills: { name: string; description: string }[] }[] = [
  {
    name: "demo-methods",
    source: "假的插件仓库 demo-plugins 的 demo-methods/",
    version: "0.3.1",
    description: "一套假的工程方法论：入口加几条原则（假数据）",
    skills: [
      { name: "demo-mode", description: "方法论的入口（假数据）" },
      { name: "demo-principle-prove-it", description: "原则：拿出真的输出证明它能用（假数据）" },
      { name: "demo-principle-subtract", description: "原则：先删再加（假数据）" },
      { name: "demo-tdd", description: "先写测试（假数据）" },
      { name: "demo-unslop", description: "把啰嗦的话改干净（假数据）" },
    ],
  },
  {
    name: "demo-engineering",
    source: "假的 skill 包 demo-skills 的 engineering/",
    version: "1.0.0",
    description: "一套假的开发流程 skill：规格、拆票、实现、评审（假数据）",
    skills: [
      { name: "demo-to-spec", description: "把对话整理成规格（假数据）" },
      { name: "demo-to-tickets", description: "把规格拆成票（假数据）" },
      { name: "demo-implement", description: "照票实现（假数据）" },
      { name: "demo-review", description: "评审改动（假数据）" },
    ],
  },
];

/** 原型的 skill 库和已登记的 MCP（工具包区、skill 库页取它；27 号票）；集合（72 号票） */
export const FAKE_TOOLKIT_CATALOG: ToolkitCatalog = {
  skills: [
    ...FAKE_SKILLS.map((s): LibrarySkill => ({ name: s.name, description: s.description, origin: s.origin })),
    { name: "agent-browser", description: "浏览器自动化：打开网页、点按钮、截图（假数据）", origin: "imported" as const },
    { name: "yt-dlp", description: "下载视频和图片（假数据）", origin: "imported" as const },
    ...FAKE_COLLECTIONS.flatMap((c) => c.skills.map((s) => ({ ...s, origin: "imported" as const, collection: c.name }))),
  ].toSorted((a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === "framework" ? -1 : 1)),
  collections: FAKE_COLLECTIONS.map((c) => ({ ...c, skills: c.skills.map((s) => s.name).toSorted() })),
  mcp: [
    {
      name: "demo-mail-readonly",
      title: "邮箱（只读，假数据）",
      tools: [{ name: "search", title: "搜邮件", network: true, readOnlyOrIdempotent: true }],
    },
    {
      name: "demo-exif-reader",
      title: "照片信息（假数据）",
      tools: [{ name: "read_exif", title: "读拍摄信息", network: false, readOnlyOrIdempotent: true, quickAction: "看一下这张照片的拍摄时间" }],
    },
  ],
};

/** 原型里输入框打 / 弹出的二狗自己的命令（82 号票，说法照守护进程的） */
export const FAKE_SLASH_COMMANDS: SlashCommandEntry[] = [
  { kind: "command", text: "/流程", name: "流程", description: "发起一个流程：维护者把要做的事排成步骤，你授权一次，照步骤做" },
  { kind: "command", text: "/任务", name: "任务", description: "发起一个长程任务：维护者分阶段做，逐阶段验收" },
];

/**
 * 原型里输入框打 / 弹出的 skill（82 号票）：写法是目录名；显示的名字带空格的（Demo Mode）跟在写法后面；
 * 两个集合里目录名相同的（review）写成"集合名:目录名"；和命令同名的写 /skill:目录名
 */
export const FAKE_SLASH_SKILLS: SlashCommandEntry[] = [
  { kind: "skill", text: "/agent-browser", name: "agent-browser", description: "浏览器自动化：打开网页、点按钮、截图（假数据）" },
  { kind: "skill", text: "/demo-engineering:review", name: "review", description: "评审改动（假数据）", collection: "demo-engineering" },
  { kind: "skill", text: "/demo-implement", name: "demo-implement", description: "照票实现（假数据）", collection: "demo-engineering" },
  { kind: "skill", text: "/demo-methods:review", name: "review", description: "按原则逐条复查（假数据）", collection: "demo-methods" },
  { kind: "skill", text: "/demo-mode", name: "Demo Mode", description: "方法论的入口：先问清楚再动手，做完拿出证据（假数据）", collection: "demo-methods" },
  { kind: "skill", text: "/demo-tdd", name: "demo-tdd", description: "先写测试（假数据）", collection: "demo-methods" },
  { kind: "skill", text: "/yt-dlp", name: "yt-dlp", description: "下载视频和图片（假数据）" },
  { kind: "skill", text: "/skill:流程", name: "流程", description: "和 /流程 同名的 skill：画流程图（假数据）" },
];

/** 按会话删除素材时可选的会话 */
/** 设置里删除素材时能选的会话（原型）：会话 id 和名字 */
export const FAKE_SESSIONS = [
  { id: "secretary", name: `${ASSISTANT_NAME_MARK}主线` },
  { id: "maintainer:m-photos", name: "任务「家庭照片整理与去重」的维护者" },
  { id: "maintainer:m-ledger", name: "项目「记账本」的维护者" },
  { id: "maintainer:m-blog", name: "项目「个人博客」的维护者" },
  { id: "maintainer:m-appliances", name: "项目「家电档案」的维护者" },
];

// ---------- 消耗 ----------

/** 确定的伪随机数，让每次打开看到的假数据一样 */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

/** 假账本里的 agent：秘书是系统开销，其余记在任务、项目、定时作业名下 */
const AGENTS: { agentId: string; role: LedgerRole; system?: boolean; scale: number }[] = [
  { agentId: "secretary", role: "secretary", system: true, scale: 1 },
  { agentId: "tm-photos", role: "maintainer", scale: 1.6 },
  { agentId: "tm-blog", role: "maintainer", scale: 2.2 },
  { agentId: "m-ledger", role: "maintainer", scale: 0.7 },
  { agentId: "job-brief", role: "maintainer", scale: 0.4 },
  { agentId: "review-t-blog-s3-1", role: "reviewer", scale: 0.5 },
];

/** 配置里的单价（元 / 百万 token）。示例值，实际按配置 */
const FAKE_PRICE: ModelPrice = { model: "deepseek/deepseek-flash", cacheHit: 0.2, cacheMiss: 2, output: 3 };

/** 假账本：最近 30 天每天每个 agent 一笔（相对打开页面的这一天） */
const FAKE_LEDGER: { day: string; agentId: string; role: LedgerRole; system: boolean; tokens: TokenCounts }[] = (() => {
  const rand = seeded(7);
  const today = new Date();
  const out: { day: string; agentId: string; role: LedgerRole; system: boolean; tokens: TokenCounts }[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    for (const a of AGENTS) {
      if (rand() < 0.2 && !a.system) continue;
      const base = 20_000 + rand() * 60_000;
      out.push({
        day,
        agentId: a.agentId,
        role: a.role,
        system: a.system === true,
        tokens: { cacheHit: Math.round(base * a.scale * 2.4), cacheMiss: Math.round(base * a.scale * 0.6), output: Math.round(base * a.scale * 0.25) },
      });
    }
  }
  return out;
})();

const fakeCost = (t: TokenCounts) => (t.cacheHit * FAKE_PRICE.cacheHit + t.cacheMiss * FAKE_PRICE.cacheMiss + t.output * FAKE_PRICE.output) / 1_000_000;

/** 假的消耗页数据：和守护进程的 GET /api/usage 同一个形状 */
export function fakeUsageSummary(range: { from: string; to: string }): UsageSummary {
  const rows = FAKE_LEDGER.filter((r) => r.day >= range.from && r.day <= range.to);
  const tally = (rs: typeof rows): UsageTally => {
    const tokens = rs.reduce<TokenCounts>((a, r) => addTokens(a, r.tokens), { ...ZERO_TOKENS });
    return { tokens, calls: rs.length * 12, cost: fakeCost(tokens) };
  };
  const agents = (rs: typeof rows): UsageAgentRow[] =>
    AGENTS.flatMap((a) => {
      const mine = rs.filter((r) => r.agentId === a.agentId);
      return mine.length === 0 ? [] : [{ agentId: a.agentId, role: a.role, category: a.system === true ? ("system" as const) : ("owned" as const), ...tally(mine) }];
    });
  const days = [...new Set(rows.map((r) => r.day))].map((date) => {
    const rs = rows.filter((r) => r.day === date);
    return { date, total: tally(rs), system: tally(rs.filter((r) => r.system)), unattributed: tally([]), agents: agents(rs) };
  });
  return {
    ...range,
    days,
    agents: agents(rows),
    total: tally(rows),
    system: tally(rows.filter((r) => r.system)),
    unattributed: tally([]),
    pricing: { estimate: true, currency: "CNY", prices: rows.length > 0 ? [FAKE_PRICE] : [], unpriced: [] },
  };
}

/**
 * 工作日历的假数据（29 号票）：节假日只带 2026 年 9–12 月（摘自 docs/research/13-holidays-sg-cn.md，是公开数据），
 * 个人设置是虚构的。由守护进程提供页面时用的是框架自带的完整数据和真的个人设置。
 */
const PROTO_SOURCE = [{ title: "原型：摘自调研文件 docs/research/13-holidays-sg-cn.md", url: "https://www.mom.gov.sg/employment-practices/public-holidays" }];
export const FAKE_HOLIDAYS: HolidayYear[] = [
  {
    format: 1,
    region: "cn",
    year: 2026,
    sources: [{ ...PROTO_SOURCE[0]!, url: "https://www.gov.cn/zhengce/content/202511/content_7047090.htm" }],
    days: [
      { date: "2026-09-20", name: "国庆节调休上班", kind: "makeup_workday" },
      ...["09-25", "09-26", "09-27"].map((d) => ({ date: `2026-${d}`, name: "中秋节", kind: "holiday" as const })),
      ...["10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07"].map((d) => ({ date: `2026-${d}`, name: "国庆节", kind: "holiday" as const })),
      { date: "2026-10-10", name: "国庆节调休上班", kind: "makeup_workday" },
    ],
  },
  {
    format: 1,
    region: "sg",
    year: 2026,
    sources: PROTO_SOURCE,
    days: [
      { date: "2026-11-08", name: "Deepavali 屠妖节", kind: "holiday" },
      { date: "2026-11-09", name: "Deepavali (Observed) 屠妖节补假", kind: "observed" },
      { date: "2026-12-25", name: "Christmas Day 圣诞节", kind: "holiday" },
    ],
  },
];

export const FAKE_WORKDAY_SETTINGS: WorkdaySettings = {
  rules: [{ kind: "last_weekday", weekday: 6 }],
  marks: [
    { date: "2026-10-12", mark: "rest" },
    { date: "2026-10-17", mark: "work" },
  ],
};
