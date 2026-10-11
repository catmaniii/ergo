// 原型的假长程任务（91 号票：计划栏照 AgentSense 画成依赖图）：照守护进程真实会发的事件编的（看板上的 task 事件、计划卡、计划变更卡、
// 验收结论的进度卡、维护者会话），走真任务的界面（RealTaskDetail），看并行的阶段、等你确认的计划、计划调整中的样子。全部是虚构的。
// - 「换新电脑：把旧电脑的资料搬过去」（执行中）：第 1 阶段两个并行（盘点资料、列出要重装的软件），第 3 阶段三个并行（拷文档和照片、
//   导出书签和密码库、装常用软件），汇成第 4 阶段你在新电脑上过目。前两段做完了（列软件时一次被拉回），第 2 阶段由你验收通过，
//   第 3 阶段正在拷文档（问过你一次能不能动外接硬盘）；并行的照旧一次做一个；
// - 「给家里的打印机配扫描到网盘」（计划等你确认）：第 1 阶段两个并行（查打印机型号、在网盘建目录），之后配置、你试扫一页；
// - 「整理家里 NAS 的备份」（执行中，计划变更等你确认）：第 3 阶段原来是并行的"每晚备份到移动硬盘"和"异地备份到网盘"，维护者提议
//   去掉异地备份、加一个"给备份加完整性校验"，并给移动硬盘那一支加一项格式化授权。
import {
  CARD_TYPE_VERSIONS,
  type Card,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEnvelope,
  type MessagePart,
  type MessageScope,
  ownMaintainerId,
  type Plan,
  type PlanCardPayload,
  type PlanChangeCardPayload,
  type PlanStage,
  type ProgressCardPayload,
  type Speaker,
  type Task,
  type TaskEventPayload,
  type ToolCallOutcome,
  type ToolNature,
} from "../state/index.ts";

/** 时间：月-日 + 时:分（2026 年，东八区；和 fake-conversations.ts 的 at 一样） */
const at = (md: string, hm: string) => `2026-${md}T${hm}:00+08:00`;

const text = (t: string): MessagePart => ({ type: "text", text: t });
const think = (t: string): MessagePart => ({ type: "reasoning", text: t });
const cardRef = (cardId: string): MessagePart => ({ type: "card_ref", cardId });

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
let callNo = 0;
/**
 * 一次工具调用，照守护进程会记的写；93 号票的 mark（外 / 权）也照守护进程的口径：命中了关注类别的才有，往外送的（这里按"以我的名义
 * 对外发送或发布"这一类认）是外，别的是权
 */
function tool(
  name: string,
  argsSummary: string,
  o: { nature?: ToolNature; outcome?: ToolCallOutcome; result?: string; generic?: boolean; categories?: string[]; disposition?: ToolCallPart["disposition"]; withinGrant?: boolean; blockedBy?: ToolCallPart["blockedBy"] } = {},
): MessagePart {
  callNo += 1;
  return {
    type: "tool_call",
    callId: `lt-call-${callNo}`,
    tool: name,
    argsSummary,
    categoryTitles: o.categories ?? [],
    disposition: o.disposition ?? "do",
    withinGrant: o.withinGrant ?? false,
    genericBash: o.generic ?? false,
    outcome: o.outcome ?? "done",
    ...(o.result === undefined ? {} : { resultSummary: o.result }),
    nature: o.nature ?? "act",
    ...(o.blockedBy ? { blockedBy: o.blockedBy } : {}),
    ...markOf(o.categories),
  };
}

/** 假调用上的 mark（93 号票）：照守护进程 guard/nature.ts 的 toolCallMark 的口径估 */
export function markOf(categories: readonly string[] | undefined): { mark?: "out" | "perm" } {
  if (!categories?.length) return {};
  return { mark: categories.some((c) => c.startsWith("以我的名义对外发送")) ? "out" : "perm" };
}

let msgNo = 0;
const SCOPES = new Map<string, MessageScope>();
function msg(conversation: ConversationId, speaker: Speaker, time: string, scope: MessageScope, ...parts: MessagePart[]): MessageEnvelope {
  msgNo += 1;
  const m: MessageEnvelope = { id: `lt-msg-${msgNo}`, conversation, speaker, time, parts };
  SCOPES.set(m.id, scope);
  return m;
}

function card(id: string, type: "plan" | "plan_change" | "progress", payload: unknown, plain: string, o: Partial<Card>): Card {
  return { id, type, typeVersion: CARD_TYPE_VERSIONS[type], version: 1, status: "pending", payload, text: plain, createdAt: at("10-06", "09:00"), ...o };
}

/** 全局的九类关注类别（和 fake-conversations.ts 的一样） */
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

/** 一个阶段：没写的都取最简单的（开放、没有授权和规则） */
function stage(stageId: string, title: string, dependsOn: string[], o: Partial<PlanStage> = {}): PlanStage {
  return {
    stageId,
    title,
    deliverables: o.deliverables ?? [`${title}的结果`],
    acceptance: o.acceptance ?? [{ criterion: `${title}：交上来的东西齐了`, method: "review" }],
    mode: o.mode ?? "open",
    dependsOn,
    policy: o.policy ?? { grants: [], temporalRules: [] },
    budget: o.budget ?? { tokens: 80_000, toolCalls: 60 },
    ...(o.steps ? { steps: o.steps } : {}),
    ...(o.modeReason ? { modeReason: o.modeReason } : {}),
    ...(o.roughIdea ? { roughIdea: o.roughIdea } : {}),
  };
}

function plan(stages: PlanStage[], o: Partial<Plan> = {}): Plan {
  return {
    stages,
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: true, network: false },
    projects: [],
    watchCategories: GLOBAL_CATEGORIES,
    assumptions: [],
    stops: { count: 0, where: [] },
    tokenEstimate: 600_000,
    ...o,
  };
}

/** 一条验收标准在执行时的样子 */
const acc = (criterion: string, method: "script" | "review" | "user", passed?: boolean, when?: string) => ({
  criterion,
  method,
  ...(passed === undefined ? {} : { result: { passed, at: when ?? at("10-06", "12:00") } }),
});

// ───────────────────────── 换新电脑：把旧电脑的资料搬过去（执行中，并行的阶段） ─────────────────────────

const PC_ID = "t-newpc";
const PC = maintainerChannel(ownMaintainerId(PC_ID));
const PC_PLAN = plan(
  [
    stage("s1", "盘点旧电脑上的资料", [], {
      deliverables: ["资料清单（目录、大小、要不要搬）"],
      acceptance: [{ criterion: "清单覆盖用户目录和 D 盘", method: "script", script: "node check-inventory.mjs" }],
      roughIdea: "先按目录统计大小，再挑出照片、文档、下载里还有用的",
    }),
    stage("s2", "列出要重装的软件", [], {
      deliverables: ["软件清单（名字、版本、许可证在哪）"],
      acceptance: [{ criterion: "清单里的每个软件都写了安装来源", method: "review" }],
      policy: { grants: [{ id: "read-registry", tool: "read", title: "读注册表里已装软件的列表", scope: { path: "HKLM\\SOFTWARE" } }], temporalRules: [] },
    }),
    stage("s3", "定搬迁清单", ["s1", "s2"], {
      deliverables: ["搬迁清单"],
      acceptance: [{ criterion: "你看过搬迁清单", method: "user" }],
      mode: "steps",
      steps: ["合并两份清单", "标出不搬的"],
      modeReason: "两份清单合起来就是一张表，照做就行",
    }),
    stage("s4", "拷文档和照片", ["s3"], {
      deliverables: ["新电脑上的文档、照片目录"],
      acceptance: [{ criterion: "两边文件数和大小对得上", method: "script", script: "node verify-copy.mjs" }],
      mode: "steps",
      steps: ["拷文档", "拷照片", "核对"],
      policy: { grants: [{ id: "copy-files", tool: "copy", title: "把搬迁清单里的目录拷到新电脑", scope: { to: "\\\\NEWPC\\Users\\me" }, maxUses: 40 }], temporalRules: [] },
      budget: { tokens: 120_000, toolCalls: 120 },
    }),
    stage("s5", "导出浏览器书签和密码库", ["s3"], {
      deliverables: ["书签文件、加密的密码库导出文件"],
      acceptance: [{ criterion: "密码库导出文件是加密的", method: "script", script: "node check-vault.mjs" }],
      policy: { grants: [{ id: "export-vault", tool: "bash", title: "用密码管理器的命令行导出加密的密码库", scope: {}, maxUses: 1 }], temporalRules: [] },
    }),
    stage("s6", "装好常用软件", ["s3"], {
      deliverables: ["新电脑上装好的软件"],
      acceptance: [{ criterion: "清单里的软件都能打开", method: "review" }],
      policy: { grants: [{ id: "install", tool: "install_global", title: "在新电脑上装清单里的软件", scope: {}, maxUses: 30 }], temporalRules: [] },
    }),
    stage("s7", "你在新电脑上过目", ["s4", "s5", "s6"], {
      deliverables: ["搬迁说明"],
      acceptance: [{ criterion: "你在新电脑上看过，常用的都在", method: "user" }],
      mode: "steps",
      steps: ["写搬迁说明"],
    }),
  ],
  { stops: { count: 2, where: ["搬迁清单由你验收", "最后由你在新电脑上过目"] } },
);
const PC_PLAN_CARD = card(
  "c-plan-newpc",
  "plan",
  {
    taskId: PC_ID,
    taskTitle: "换新电脑：把旧电脑的资料搬过去",
    revision: 1,
    planId: `${PC_ID}-p1`,
    goal: "把旧电脑上还要用的资料、书签和常用软件搬到新电脑上，旧电脑先不动",
    plan: PC_PLAN,
    globalCategories: GLOBAL_CATEGORIES.map((c) => c.id),
    grantInfo: {
      "read-registry": { toolTitle: "读文件", categoryTitles: [], disposition: "do", outward: false },
      "copy-files": { toolTitle: "复制", categoryTitles: ["越出项目目录"], disposition: "planned_only", outward: false },
      "export-vault": { toolTitle: "通用 bash", categoryTitles: ["账户与安全"], disposition: "planned_only", outward: false },
      install: { toolTitle: "全局装软件", categoryTitles: ["账户与安全"], disposition: "planned_only", outward: true },
    },
  } satisfies PlanCardPayload,
  "计划：换新电脑：把旧电脑的资料搬过去（第 1 版，7 个阶段）",
  { status: "handled", outcome: { action: "confirm" }, createdAt: at("10-06", "09:10"), handledAt: at("10-06", "09:15") },
);

function progress(id: string, taskId: string, taskTitle: string, stageId: string, stageTitle: string, index: number, total: number, results: ProgressCardPayload["acceptance"], time: string): Card {
  return card(
    id,
    "progress",
    { taskId, taskTitle, stageId, stageTitle, stageIndex: index, stageTotal: total, kind: "acceptance", text: results?.passed ? "验收通过。" : "没通过，交回维护者修改。", ...(results ? { acceptance: results } : {}) } satisfies ProgressCardPayload,
    `${results?.passed ? "验收通过" : "验收没通过"}：任务「${taskTitle}」阶段「${stageTitle}」`,
    { status: "handled", createdAt: time },
  );
}

const PC_TITLE = "换新电脑：把旧电脑的资料搬过去";
const PC_CARDS: Card[] = [
  PC_PLAN_CARD,
  progress("c-acc-newpc-s1", PC_ID, PC_TITLE, "s1", "盘点旧电脑上的资料", 1, 7, { passed: true, judgedBy: "script", summary: "用户目录 182 GB、D 盘 640 GB，要搬的 96 GB", results: [{ criterion: "清单覆盖用户目录和 D 盘", method: "script", passed: true }] }, at("10-06", "10:05")),
  progress("c-acc-newpc-s2", PC_ID, PC_TITLE, "s2", "列出要重装的软件", 2, 7, { passed: true, judgedBy: "review", summary: "常用软件 23 个，许可证 4 个在邮箱里", results: [{ criterion: "清单里的每个软件都写了安装来源", method: "review", passed: true }] }, at("10-06", "10:50")),
  progress("c-acc-newpc-s3", PC_ID, PC_TITLE, "s3", "定搬迁清单", 3, 7, { passed: true, judgedBy: "user", summary: "搬 96 GB；旧游戏存档不搬", results: [{ criterion: "你看过搬迁清单", method: "user", passed: true }] }, at("10-06", "14:20")),
];

const PC_TASK: Task = {
  id: PC_ID,
  title: PC_TITLE,
  summary: `${PC_TITLE}\n旧电脑先不动，新电脑上常用的都要能用`,
  state: "running",
  origin: "button",
  kind: "long_running",
  maintainerId: ownMaintainerId(PC_ID),
  projects: [],
  projectIds: [],
  projectScope: "none",
  planCardId: PC_PLAN_CARD.id,
  stages: {
    total: 7,
    current: 4,
    focus: "s4",
    list: [
      { stageId: "s1", title: "盘点旧电脑上的资料", state: "accepted", dependsOn: [], acceptance: [acc("清单覆盖用户目录和 D 盘", "script", true, at("10-06", "10:05"))], attempts: 1, startedAt: at("10-06", "09:16") },
      { stageId: "s2", title: "列出要重装的软件", state: "accepted", dependsOn: [], acceptance: [acc("清单里的每个软件都写了安装来源", "review", true, at("10-06", "10:50"))], attempts: 1, startedAt: at("10-06", "10:06") },
      { stageId: "s3", title: "定搬迁清单", state: "accepted", dependsOn: ["s1", "s2"], acceptance: [acc("你看过搬迁清单", "user", true, at("10-06", "14:20"))], attempts: 1, startedAt: at("10-06", "10:52") },
      { stageId: "s4", title: "拷文档和照片", state: "running", dependsOn: ["s3"], acceptance: [acc("两边文件数和大小对得上", "script")], attempts: 0, startedAt: at("10-06", "14:22") },
      { stageId: "s5", title: "导出浏览器书签和密码库", state: "pending", dependsOn: ["s3"], acceptance: [acc("密码库导出文件是加密的", "script")], attempts: 0 },
      { stageId: "s6", title: "装好常用软件", state: "pending", dependsOn: ["s3"], acceptance: [acc("清单里的软件都能打开", "review")], attempts: 0 },
      { stageId: "s7", title: "你在新电脑上过目", state: "pending", dependsOn: ["s4", "s5", "s6"], acceptance: [acc("你在新电脑上看过，常用的都在", "user")], attempts: 0 },
    ],
  },
  createdAt: at("10-06", "09:00"),
  updatedAt: at("10-06", "15:10"),
};

const PC_PLANNING: MessageScope = { taskId: PC_ID };
const pcStage = (stageId: string): MessageScope => ({ taskId: PC_ID, stageId });
const PC_MESSAGES: MessageEnvelope[] = [
  msg(PC, "system", at("10-06", "09:00"), PC_PLANNING, text("任务书：任务 t-newpc「换新电脑：把旧电脑的资料搬过去」\n目标：把旧电脑上还要用的资料、书签和常用软件搬到新电脑上，旧电脑先不动")),
  msg(PC, "agent", at("10-06", "09:10"), PC_PLANNING, think("资料和软件两头可以同时摸底；定了清单之后，拷文件、导书签、装软件三件事互不相干。"), text("计划交上来了：七个阶段，有两处可以并行。"), cardRef(PC_PLAN_CARD.id)),
  msg(PC, "system", at("10-06", "09:16"), pcStage("s1"), text("计划已确认，开始执行任务 t-newpc「换新电脑：把旧电脑的资料搬过去」。")),
  msg(PC, "agent", at("10-06", "09:40"), pcStage("s1"), tool("ls", "path=C:\\Users\\me", { nature: "look", result: "12 个目录" }), tool("bash", "du -sh C:/Users/me/* D:/*", { generic: true, nature: "look", result: "用户目录 182 GB、D 盘 640 GB" }), tool("write", "path=inventory.md", { result: "写了 48 行" })),
  msg(PC, "agent", at("10-06", "10:00"), pcStage("s1"), text("资料清单写好了：要搬的大约 96 GB，主要是照片和文档。"), cardRef("c-acc-newpc-s1")),
  msg(PC, "agent", at("10-06", "10:20"), pcStage("s2"), tool("read", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", { nature: "look", withinGrant: true, result: "61 项" })),
  msg(
    PC,
    "agent",
    at("10-06", "10:30"),
    pcStage("s2"),
    think("顺手把旧版本卸了，省得清单里重复。"),
    tool("bash", "winget uninstall 7zip.7zip --version 19.00", {
      generic: true,
      nature: "modify",
      outcome: "blocked",
      blockedBy: "pull_back",
      result: "这一阶段只列清单，不动旧电脑上的软件：按计划退回",
    }),
  ),
  msg(PC, "agent", at("10-06", "10:45"), pcStage("s2"), tool("write", "path=software.md", { result: "23 个软件" }), text("软件清单写好了，没动旧电脑上的东西。"), cardRef("c-acc-newpc-s2")),
  msg(PC, "agent", at("10-06", "11:30"), pcStage("s3"), tool("write", "path=migration.md", { result: "搬迁清单 31 项" }), text("搬迁清单在 migration.md，请你过目。")),
  msg(PC, "system", at("10-06", "14:20"), pcStage("s3"), cardRef("c-acc-newpc-s3")),
  msg(PC, "agent", at("10-06", "14:30"), pcStage("s4"), tool("copy", "from=C:\\Users\\me\\Documents to=\\\\NEWPC\\Users\\me\\Documents", { withinGrant: true, categories: ["越出项目目录"], disposition: "planned_only", result: "拷了 12,408 个文件" })),
  msg(
    PC,
    "agent",
    at("10-06", "15:00"),
    pcStage("s4"),
    tool("copy", "from=E:\\照片备份 to=\\\\NEWPC\\Users\\me\\Pictures", { disposition: "ask_first", categories: ["越出项目目录"], result: "你允许了；拷了 21,630 张" }),
  ),
  msg(PC, "agent", at("10-06", "15:10"), pcStage("s4"), text("文档和照片拷完了，正在核对两边的文件数和大小。书签、软件等这一段核对完再做。")),
];

// ───────────────────────── 给家里的打印机配扫描到网盘（计划等你确认） ─────────────────────────

const SCAN_ID = "t-scan";
const SCAN = maintainerChannel(ownMaintainerId(SCAN_ID));
const SCAN_TITLE = "给家里的打印机配扫描到网盘";
const SCAN_PLAN = plan(
  [
    stage("s1", "查打印机型号和固件", [], { deliverables: ["型号、固件版本、支不支持扫描到 SMB"], acceptance: [{ criterion: "写清楚支持哪几种扫描目的地", method: "review" }] }),
    stage("s2", "在网盘建扫描目录", [], {
      deliverables: ["网盘上的「扫描件」目录和一个只能写这个目录的账号"],
      acceptance: [{ criterion: "用新账号能往目录里写一个文件", method: "script", script: "node check-share.mjs" }],
      policy: { grants: [{ id: "mkdir-share", tool: "make_dir", title: "在网盘上建「扫描件」目录", scope: { path: "\\\\NAS\\家庭\\扫描件" }, maxUses: 1 }], temporalRules: [] },
    }),
    stage("s3", "配置扫描到网盘", ["s1", "s2"], {
      deliverables: ["打印机上配好的扫描目的地"],
      acceptance: [{ criterion: "打印机的管理页面里能看到这个目的地", method: "review" }],
      mode: "steps",
      steps: ["登录打印机管理页面", "加扫描目的地", "测试连接"],
      policy: { grants: [{ id: "printer-admin", tool: "http_request", title: "在打印机的管理页面上加扫描目的地", scope: { url: "http://192.168.1.20/admin" }, maxUses: 5 }], temporalRules: [] },
    }),
    stage("s4", "你试扫一页", ["s3"], { deliverables: ["一份试扫的文件"], acceptance: [{ criterion: "你试扫的那一页出现在网盘的目录里", method: "user" }] }),
  ],
  { toolkit: { skills: [], mcp: [], bash: true, network: true }, stops: { count: 1, where: ["最后由你试扫一页"] }, tokenEstimate: 150_000 },
);
const SCAN_PLAN_CARD = card(
  "c-plan-scan",
  "plan",
  {
    taskId: SCAN_ID,
    taskTitle: SCAN_TITLE,
    revision: 1,
    planId: `${SCAN_ID}-p1`,
    goal: "在打印机上按一下就把扫描件存进家里网盘的「扫描件」目录",
    plan: SCAN_PLAN,
    globalCategories: GLOBAL_CATEGORIES.map((c) => c.id),
    grantInfo: {
      "mkdir-share": { toolTitle: "建目录", categoryTitles: ["越出项目目录"], disposition: "planned_only", outward: false },
      "printer-admin": { toolTitle: "发 HTTP 请求", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only", outward: true },
    },
  } satisfies PlanCardPayload,
  `计划：${SCAN_TITLE}（第 1 版，4 个阶段）`,
  { urgency: "blocking", createdAt: at("10-07", "08:50") },
);
const SCAN_TASK: Task = {
  id: SCAN_ID,
  title: SCAN_TITLE,
  summary: `${SCAN_TITLE}\n扫描件按日期命名`,
  state: "awaiting_confirm",
  origin: "button",
  kind: "long_running",
  maintainerId: ownMaintainerId(SCAN_ID),
  projects: [],
  projectIds: [],
  projectScope: "none",
  planCardId: SCAN_PLAN_CARD.id,
  stages: { total: 4 },
  createdAt: at("10-07", "08:40"),
  updatedAt: at("10-07", "08:50"),
};
const SCAN_MESSAGES: MessageEnvelope[] = [
  msg(SCAN, "system", at("10-07", "08:40"), { taskId: SCAN_ID }, text(`任务书：任务 t-scan「${SCAN_TITLE}」\n目标：在打印机上按一下就把扫描件存进家里网盘的「扫描件」目录`)),
  msg(SCAN, "agent", at("10-07", "08:50"), { taskId: SCAN_ID }, think("型号和网盘目录两头互不相干，可以先后各做一段；配置要两头都好了才能做。"), text("计划交上来了，请过目。"), cardRef(SCAN_PLAN_CARD.id)),
];

// ───────────────────────── 整理家里 NAS 的备份（执行中，计划变更等你确认） ─────────────────────────

const NAS_ID = "t-backup";
const NAS = maintainerChannel(ownMaintainerId(NAS_ID));
const NAS_TITLE = "整理家里 NAS 的备份";
const NAS_STAGES = {
  s1: stage("s1", "盘点 NAS 上的共享目录", [], { deliverables: ["共享目录清单和大小"] }),
  s2: stage("s2", "定备份策略", ["s1"], { deliverables: ["备份策略：哪些目录、多久一次、留几份"], acceptance: [{ criterion: "你看过备份策略", method: "user" }] }),
  s3: stage("s3", "配置每晚备份到移动硬盘", ["s2"], {
    deliverables: ["NAS 上每晚 2 点的备份任务"],
    acceptance: [{ criterion: "手动跑一次备份任务成功", method: "script", script: "node run-backup-once.mjs" }],
    mode: "steps",
    steps: ["建备份任务", "手动跑一次"],
  }),
  s4: stage("s4", "配置异地备份到网盘", ["s2"], {
    deliverables: ["每周一次的异地备份任务"],
    acceptance: [{ criterion: "网盘上能看到第一次备份", method: "script", script: "node check-offsite.mjs" }],
    policy: { grants: [{ id: "upload", tool: "http_request", title: "把加密后的备份传到网盘", scope: { url: "https://pan.example.com/upload" } }], temporalRules: [] },
  }),
  s5: stage("s5", "恢复演练", ["s3", "s4"], { deliverables: ["恢复演练记录"], acceptance: [{ criterion: "从备份里恢复一个目录，内容对得上", method: "script", script: "node restore-drill.mjs" }] }),
};
const NAS_BASE = plan([NAS_STAGES.s1, NAS_STAGES.s2, NAS_STAGES.s3, NAS_STAGES.s4, NAS_STAGES.s5], { toolkit: { skills: [], mcp: [], bash: true, network: true }, tokenEstimate: 400_000 });
const formatGrant = { id: "format-usb", tool: "bash", title: "把新移动硬盘格式化成 ext4", scope: {}, maxUses: 1 };
const NAS_CHANGED = plan(
  [
    NAS_STAGES.s1,
    NAS_STAGES.s2,
    { ...NAS_STAGES.s3, policy: { grants: [formatGrant], temporalRules: [] } },
    stage("s6", "给备份加完整性校验", ["s2"], { deliverables: ["每次备份后的校验和清单"], acceptance: [{ criterion: "校验和清单和备份对得上", method: "script", script: "node verify-checksums.mjs" }] }),
    { ...NAS_STAGES.s5, dependsOn: ["s3", "s6"] },
  ],
  { toolkit: { skills: [], mcp: [], bash: true, network: true }, tokenEstimate: 380_000 },
);
const NAS_GRANT_INFO = {
  upload: { toolTitle: "发 HTTP 请求", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only" as const, outward: true },
  "format-usb": { toolTitle: "通用 bash", categoryTitles: ["删除或覆盖（项目档案和工作目录内）"], disposition: "planned_only" as const, outward: false },
};
const NAS_PLAN_CARD = card(
  "c-plan-backup",
  "plan",
  {
    taskId: NAS_ID,
    taskTitle: NAS_TITLE,
    revision: 1,
    planId: `${NAS_ID}-p1`,
    goal: "NAS 上的家庭照片和文档每晚有一份本地备份、每周有一份异地备份，并且演练过能恢复",
    plan: NAS_BASE,
    globalCategories: GLOBAL_CATEGORIES.map((c) => c.id),
    grantInfo: { upload: NAS_GRANT_INFO.upload },
  } satisfies PlanCardPayload,
  `计划：${NAS_TITLE}（第 1 版，5 个阶段）`,
  { status: "handled", outcome: { action: "confirm" }, createdAt: at("10-05", "20:00"), handledAt: at("10-05", "20:05") },
);
const NAS_CHANGE_CARD = card(
  "c-pc-backup",
  "plan_change",
  {
    taskId: NAS_ID,
    taskTitle: NAS_TITLE,
    planId: `${NAS_ID}-p2`,
    revision: 2,
    basePlanId: `${NAS_ID}-p1`,
    why: "网盘的上传限速，异地备份一周传不完；先不做异地，改成每次备份后核对校验和。新买的移动硬盘是 NTFS，要格式化成 ext4 才能当备份盘。",
    changes: [
      { kind: "stage_removed", expands: false, stageId: "s4", title: "配置异地备份到网盘" },
      { kind: "stage_added", expands: false, stageId: "s6", title: "给备份加完整性校验" },
      { kind: "grant_added", expands: true, owner: { kind: "stage", id: "s3", title: "配置每晚备份到移动硬盘" }, grant: formatGrant },
    ],
    affectedStages: [{ stageId: "s3", title: "配置每晚备份到移动硬盘" }],
    plan: NAS_CHANGED,
    grantInfo: { "format-usb": NAS_GRANT_INFO["format-usb"] },
  } satisfies PlanChangeCardPayload,
  `计划变更：${NAS_TITLE}（先不做异地备份）`,
  { urgency: "blocking", createdAt: at("10-07", "09:30") },
);
const NAS_TASK: Task = {
  id: NAS_ID,
  title: NAS_TITLE,
  summary: `${NAS_TITLE}\n照片和文档最要紧`,
  state: "running",
  origin: "button",
  kind: "long_running",
  maintainerId: ownMaintainerId(NAS_ID),
  projects: [],
  projectIds: [],
  projectScope: "none",
  planCardId: NAS_PLAN_CARD.id,
  stages: {
    total: 5,
    current: 3,
    focus: "s3",
    list: [
      { stageId: "s1", title: "盘点 NAS 上的共享目录", state: "accepted", dependsOn: [], acceptance: [acc("盘点 NAS 上的共享目录：交上来的东西齐了", "review", true)], attempts: 1 },
      { stageId: "s2", title: "定备份策略", state: "accepted", dependsOn: ["s1"], acceptance: [acc("你看过备份策略", "user", true)], attempts: 1 },
      { stageId: "s3", title: "配置每晚备份到移动硬盘", state: "waiting", waitReason: "plan_change", dependsOn: ["s2"], acceptance: [acc("手动跑一次备份任务成功", "script")], attempts: 0, startedAt: at("10-07", "09:00") },
      { stageId: "s4", title: "配置异地备份到网盘", state: "pending", dependsOn: ["s2"], acceptance: [acc("网盘上能看到第一次备份", "script")], attempts: 0 },
      { stageId: "s5", title: "恢复演练", state: "pending", dependsOn: ["s3", "s4"], acceptance: [acc("从备份里恢复一个目录，内容对得上", "script")], attempts: 0 },
    ],
  },
  createdAt: at("10-05", "19:50"),
  updatedAt: at("10-07", "09:30"),
};
const nasStage = (stageId: string): MessageScope => ({ taskId: NAS_ID, stageId });
const NAS_MESSAGES: MessageEnvelope[] = [
  msg(NAS, "system", at("10-05", "19:50"), { taskId: NAS_ID }, text(`任务书：任务 t-backup「${NAS_TITLE}」\n目标：照片和文档每晚有一份本地备份、每周有一份异地备份，并且演练过能恢复`)),
  msg(NAS, "agent", at("10-05", "20:00"), { taskId: NAS_ID }, text("计划交上来了。"), cardRef(NAS_PLAN_CARD.id)),
  msg(NAS, "system", at("10-05", "20:05"), nasStage("s1"), text(`计划已确认，开始执行任务 t-backup「${NAS_TITLE}」。`)),
  msg(NAS, "agent", at("10-05", "20:30"), nasStage("s1"), tool("ls", "path=\\\\NAS", { nature: "look", result: "6 个共享目录" }), text("NAS 上有 6 个共享目录，要备份的是「照片」「文档」两个，一共 1.2 TB。")),
  msg(NAS, "agent", at("10-06", "21:00"), nasStage("s2"), text("备份策略写好了：每晚备份到移动硬盘留 7 份，每周异地备份留 4 份。")),
  msg(NAS, "agent", at("10-07", "09:20"), nasStage("s3"), tool("bash", "lsblk -f /dev/sdb", { generic: true, nature: "look", result: "sdb1 ntfs 4T" }), think("移动硬盘是 NTFS，要格式化；网盘限速也查过了，一周传不完 1.2 TB。")),
  msg(NAS, "agent", at("10-07", "09:30"), nasStage("s3"), text("要改计划：先不做异地备份，加一个校验和核对；移动硬盘要格式化，这一项要你确认。"), cardRef(NAS_CHANGE_CARD.id)),
];

// ───────────────────────── 交给假连接的 ─────────────────────────

export const LONG_TASK_CARDS: Card[] = [...PC_CARDS, SCAN_PLAN_CARD, NAS_PLAN_CARD, NAS_CHANGE_CARD];

const messageEvent = (m: MessageEnvelope) => ({ channel: m.conversation, type: EVENT_TYPES.message, payload: { message: m, ...SCOPES.get(m.id) } });

/** 原型启动时这三个长程任务"已有"的事件（会话、看板），按先后 */
export const LONG_TASK_HISTORY: { channel: string; type: string; payload: unknown }[] = [
  ...[...PC_MESSAGES, ...SCAN_MESSAGES, ...NAS_MESSAGES].map(messageEvent),
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: PC_TASK, change: "stage_started", from: "running", by: "maintainer" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: SCAN_TASK, change: "plan_submitted", from: "planning", by: "maintainer" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: NAS_TASK, change: "plan_change_proposed", from: "running", by: "maintainer" } satisfies TaskEventPayload },
];
