// 原型的假流程（60 号票）：照守护进程真实会发的事件编的，界面上看流程会话的进度条、计划台账、"接下来的计划"虚线框、计划详情（含检测项全览）。
// - 「整理九月的发票」（一次性的流程）：第 1 版计划被审查退回（移动发票之前没备份），第 2 版补上备份、审查按计划里写的条件调整了顺序，
//   你授权后在执行：做完 3 步，第 4 步（移到归档目录）先被引回补写清单、现在在做；第 5 步写汇总时想写到桌面（超出计划，你没同意）；
//   中间看了一眼归档目录（计划外、只看）。
// - 「每周整理下载目录」（定时触发的流程，76 号票原型里已有，这里补上计划卡和会话）：第 1 次运行做完了，第 2 次运行在跑——
//   进度条、虚线框都按这一次运行算。
// 规则原文（审查结果的 docs）里框架的六条 v1 模板照守护进程真实给出的抄（录像 workflow.json 里的那一份）。全部是虚构的。
// 153 号票：维护者每报一步开始（report_step in_progress），守护进程在会话频道上记一条步骤开始的记号（stage_start 带 stepId），
// 缩小后那里有"撤回到步骤「…」开始前"；定时触发的那个只有这一次运行里的有（一次运行就是一段会话）。
import {
  CARD_TYPE_VERSIONS,
  type Card,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  type JobRun,
  maintainerChannel,
  type MessageEnvelope,
  type MessagePart,
  type MessageScope,
  ownMaintainerId,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Speaker,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type ToolCallOutcome,
  type ToolNature,
  type WorkflowPlan,
  type WorkflowPlanCardPayload,
  type WorkflowReview,
  type WorkflowStepView,
} from "../state/index.ts";

/** 时间：月-日 + 时:分（2026 年，东八区；和 fake-conversations.ts 的 at 一样） */
const at = (md: string, hm: string) => `2026-${md}T${hm}:00+08:00`;

const text = (t: string): MessagePart => ({ type: "text", text: t });
const think = (t: string): MessagePart => ({ type: "reasoning", text: t });
const cardRef = (cardId: string): MessagePart => ({ type: "card_ref", cardId });

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
let callNo = 0;
/** 一次工具调用，照守护进程会记的写：plan 是和授权的计划比对的结果（60 号票） */
function tool(
  name: string,
  argsSummary: string,
  o: {
    nature?: ToolNature;
    outcome?: ToolCallOutcome;
    result?: string;
    generic?: boolean;
    categories?: string[];
    disposition?: ToolCallPart["disposition"];
    withinGrant?: boolean;
    blockedBy?: ToolCallPart["blockedBy"];
    plan?: ToolCallPart["plan"];
  } = {},
): MessagePart {
  callNo += 1;
  return {
    type: "tool_call",
    callId: `wf-call-${callNo}`,
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
    ...(o.plan ? { plan: o.plan } : {}),
  };
}
/** report_step（守护进程代为执行，不和计划比对） */
const report = (stepId: string, status: string, gist?: string) => tool("report_step", `stepId=${stepId} status=${status}${gist ? ` gist=${gist}` : ""}`, { nature: "look", result: "已记下" });

let msgNo = 0;
const SCOPES = new Map<string, MessageScope>();
function msg(conversation: ConversationId, speaker: Speaker, time: string, scope: MessageScope, ...parts: MessagePart[]): MessageEnvelope {
  msgNo += 1;
  const m: MessageEnvelope = { id: `wf-msg-${msgNo}`, conversation, speaker, time, parts };
  SCOPES.set(m.id, scope);
  return m;
}

function card(id: string, payload: WorkflowPlanCardPayload, o: Partial<Card>): Card {
  return {
    id,
    type: "workflow_plan",
    typeVersion: CARD_TYPE_VERSIONS.workflow_plan,
    version: 1,
    status: "pending",
    payload,
    text: `流程计划卡：${payload.taskTitle}（计划 v${payload.revision}）`,
    createdAt: at("10-07", "09:00"),
    ...o,
  };
}

// ───────────────────────── 规则原文 ─────────────────────────

/** 框架的六条 v1 模板（守护进程审查时真正用的那一份，抄自录像 workflow.json；最后一条的提示里去掉了括号里说助理的那半句：构建产物里不出现那个旧称呼） */
const TEMPLATE_DOCS: NonNullable<WorkflowReview["docs"]> = [
  {
    id: "v1.backup-before-overwrite",
    title: "删除或覆盖项目档案和工作目录里的文件之前，必须已备份或已 git 提交",
    trigger: { tool: ["write", "delete", "move", "copy", "git_discard"] },
    for_each: { var: "p", key: "$p.path", in: { select: { from: "$current.paths", where: { ne: ["$row.access", "read"] } } } },
    when: { and: [{ eq: ["$p.replaced", true] }, { eq: ["$p.area", "project"] }] },
    unless: { or: [{ eq: ["$p.committed", true] }, { eq: ["$p.backedUp", true] }] },
    require: { before: { tool: "copy", where: { path_within: ["$p.path", "$prior.args.from"] } } },
    message: "「{p.path}」还没有 git 提交、也没有备份。先提交（git_commit），或者先复制一份备份（cp），再删除或覆盖；只改已有文件的一部分请用 edit 局部修改",
    on_violation: "pull_back",
    repairs: [{ replan: { text: "「{p.path}」还没有 git 提交、也没有备份。先提交（git_commit），或者先复制一份备份（cp），再删除或覆盖；只改已有文件的一部分请用 edit 局部修改" } }],
  },
  {
    id: "v1.test-before-push",
    title: "push 之前必须跑过测试",
    trigger: { tool: "git_push" },
    require: { before: { tool: "run_tests", where: { path_within: ["$current.args.repoPath", "$prior.args.repoPath"] } } },
    message: "推送之前要在这个仓库里成功跑过测试。先单独跑一次测试（run_tests，或 bash 里的 npm test），通过后再推送",
    on_violation: "pull_back",
    repairs: [{ insert: { tool: "run_tests", title: "推送之前先在这个仓库里跑一遍测试", args: { repoPath: "$current.args.repoPath" }, share: "$current.args.repoPath" } }],
  },
  {
    id: "v1.no-send-after-secret-read",
    title: "读过 .env 或密钥文件之后不许往外送",
    trigger: { tool: ["git_push", "create_remote_repo", "install_deps", "web_search", "web_fetch", "git_fetch", "http_request", "network_read", "run_package", "network_command", "github_write", "publish_package", "install_global", "run_script"] },
    when: { eq: ["$current.outward", true] },
    require: {
      not_before: {
        tool: ["read", "ls", "grep", "find", "git_status_diff", "copy", "run_script", "shell_command"],
        where: { any: { from: "$prior.paths", where: { and: [{ eq: ["$row.secretFile", true] }, { in: ["$row.access", ["read", "unknown"]] }] } } },
      },
    },
    message:
      "之前读过 .env 或密钥文件，之后一律不许往外送（非 GET 的请求、带数据或上传的请求、发消息、推送、发布、建远端仓库、用到联网库的脚本，以及从管道拿输入、参数里有 $(…) 或变量的联网命令）。这一步不能做；只往下拉的（只读的 GET、下载、装依赖、git pull / clone）照常可以做，确实需要往外送的话，请用户亲自处理",
    on_violation: "block",
  },
  {
    id: "v1.no-duplicate-send",
    title: "同一收件人、同一内容不重复发",
    trigger: { tool: ["git_push", "create_remote_repo", "http_request", "network_command", "github_write", "publish_package"] },
    when: { and: [{ present: "$current.recipients" }, { not: { in: ["$current.args.method", ["GET", "HEAD", "OPTIONS"]] } }] },
    require: {
      not_before: {
        tool: ["git_push", "create_remote_repo", "http_request", "network_command", "github_write", "publish_package"],
        where: {
          and: [
            { not: { in: ["$prior.args.method", ["GET", "HEAD", "OPTIONS"]] } },
            { eq: ["$prior.content", "$current.content"] },
            { any: { from: "$current.recipients", as: "r", where: { in: ["$r", "$prior.recipients"] } } },
          ],
        },
      },
    },
    message: "之前已经给同一个收件人（{current.recipients}）发过一模一样的内容了，再发一次要用户确认",
    on_violation: "confirm",
    repairs: [{ confirm: { text: "之前已经给同一个收件人（{current.recipients}）发过一模一样的内容了，再发一次要用户确认" } }],
  },
  {
    id: "v1.no-secret-in-outbound",
    title: "对外内容不许含密钥",
    trigger: { tool: ["git_push", "create_remote_repo", "install_deps", "web_search", "web_fetch", "git_fetch", "http_request", "network_read", "run_package", "network_command", "github_write", "publish_package", "install_global"] },
    require: { check: { eq: [{ len: "$current.secrets" }, 0] } },
    message: "要发出去的内容里有密钥（{current.secrets}）。把密钥从内容里去掉再发；需要凭据的地方请用户自己配置",
    on_violation: "block",
  },
  {
    id: "v1.no-force-push-or-rm-rf-outside",
    title: "force push 和项目外的 rm -rf 一律禁止",
    trigger: { tool: ["git_push", "delete"] },
    when: { or: [{ eq: ["$current.args.force", true] }, { and: [{ eq: ["$current.args.recursive", true] }, { any: { from: "$current.paths", where: { eq: ["$row.area", "outside"] } } }] }] },
    message: "force push 和项目档案、工作目录之外的递归删除一律禁止。推送不要带 force；项目外的东西请用户自己删",
    on_violation: "block",
  },
];

/** 六条模板逐条复测的结果（规则 id → 查了多久、违反几处、判不了几处） */
function probes(over: Record<string, { violated?: number; unknown?: number }> = {}, plan: { id: string; title: string; violated?: number }[] = []): WorkflowReview["rules"] {
  const ms = [0.21, 0.04, 0.03, 0.03, 0.02, 0.02];
  return [
    ...TEMPLATE_DOCS.map((d, i) => ({ id: d.id, title: String(d.title), source: "template" as const, ms: ms[i]!, violated: over[d.id]?.violated ?? 0, unknown: over[d.id]?.unknown ?? 0 })),
    ...plan.map((r) => ({ id: r.id, title: r.title, source: "plan" as const, ms: 0.05, violated: r.violated ?? 0, unknown: 0 })),
  ];
}

const BACKUP_CONDITION = (status: "pass" | "violated" | "unknown") => ({
  ruleId: "v1.backup-before-overwrite",
  title: "删除或覆盖项目档案和工作目录里的文件之前，必须已备份或已 git 提交",
  text: "move 之前必须已经成功做过 copy（只在满足条件时检查，有例外）；违反时退回，先补上再做",
  source: "template" as const,
  status,
  ...(status === "violated" ? { note: "「下载/发票」还没有 git 提交、也没有备份" } : status === "unknown" ? { note: "规划时事实不足（文件在不在、git 状态这些要执行时才知道），执行时再查" } : {}),
});

const MOVE_MARK = { category: "delete_or_overwrite", title: "删除或覆盖（项目档案和工作目录内）", disposition: "planned_only" as const, authorized: true };

// ───────────────────────── 一次性的流程：整理九月的发票 ─────────────────────────

const INVOICE_TASK_ID = "t-invoices";
const INVOICES = maintainerChannel(ownMaintainerId(INVOICE_TASK_ID));

function step(id: string, title: string, toolName: string, args: Record<string, unknown>, o: Partial<WorkflowStepView> = {}): WorkflowStepView {
  return { id, title, tool: toolName, args, after: [], marks: [], conditions: [], ...o };
}

const LIST_BEFORE_MOVE = {
  id: "list-before-move",
  title: "移动之前先写清单",
  trigger: { tool: "move" },
  require: { before: { tool: "write", where: { path_within: ["$prior.args.path", "归档/2026-09"] } } },
  message: "移动发票之前先把清单写进归档目录，方便事后核对",
  on_violation: "pull_back",
  repairs: [{ move_after: { tool: "write" }, cost: { ops: 0 } }, { replan: { text: "移动发票之前先把清单写进归档目录，方便事后核对" }, cost: { interaction: 1 } }],
};

/** 第 1 版：移动之前没备份，审查退回维护者补上（审查退回，没有交给你授权） */
const INVOICE_PLAN_V1: WorkflowPlan = {
  version: 1,
  goal: "把下载目录里九月的发票归档到 归档/2026-09，并写一份清单和本月汇总",
  steps: [
    step("s1", "列出下载目录里的发票", "ls", { path: "下载/发票" }),
    step("s2", "把发票移到归档目录", "bash", { command: "mv 下载/发票/*.pdf 归档/2026-09/" }, { marks: [{ ...MOVE_MARK, authorized: false }], conditions: [BACKUP_CONDITION("violated")] }),
    step("s3", "写一份发票清单", "write", { path: "归档/2026-09/清单.md" }),
    step("s4", "写本月汇总", "write", { path: "归档/2026-09/汇总.md" }),
  ],
  rules: [],
  review: {
    verdict: "fail",
    status: "needs_replan",
    violations: [{ stepId: "s2", property: "v1.backup-before-overwrite", message: "「下载/发票」还没有 git 提交、也没有备份。先提交（git_commit），或者先复制一份备份（cp），再删除或覆盖", key: "v1.backup-before-overwrite@s2" }],
    actions: [],
    confirmations: [],
    deferred: [],
    replans: ["「下载/发票」还没有 git 提交、也没有备份。先复制一份备份（cp），再移动"],
    scanned: { rules: 6, steps: 4 },
    phases: { facts: 0, compile: 1.8, solve: 3.1, probe: 0.4 },
    rules: probes({ "v1.backup-before-overwrite": { violated: 1 } }),
    docs: TEMPLATE_DOCS,
    ms: 5.6,
  },
  toolkit: { skills: [], mcp: [], bash: true, network: false },
};

/** 第 2 版：补上备份；计划里写的条件"移动之前先写清单"让审查把移动挪到写清单之后（调整顺序）；你授权了 */
const INVOICE_PLAN_V2: WorkflowPlan = {
  version: 2,
  goal: "把下载目录里九月的发票归档到 归档/2026-09，并写一份清单和本月汇总",
  steps: [
    step("s1", "列出下载目录里的发票", "ls", { path: "下载/发票" }),
    step("s2", "备份发票目录", "bash", { command: "cp -r 下载/发票 回收区/发票-备份" }),
    step("s4", "写一份发票清单", "write", { path: "归档/2026-09/清单.md" }, { after: ["s2"] }),
    step("s3", "把发票移到归档目录", "bash", { command: "mv 下载/发票/*.pdf 归档/2026-09/" }, {
      after: ["s2", "s4"],
      patches: ["move_after:s3:s4"],
      marks: [MOVE_MARK],
      conditions: [
        BACKUP_CONDITION("pass"),
        { ruleId: "list-before-move", title: "移动之前先写清单", text: "move 之前必须已经成功做过 write；违反时退回，先补上再做", source: "plan", status: "pass" },
      ],
    }),
    step("s5", "写本月汇总", "write", { path: "归档/2026-09/汇总.md" }, { after: ["s3"] }),
  ],
  rules: [LIST_BEFORE_MOVE],
  review: {
    verdict: "fail",
    status: "patched",
    violations: [{ stepId: "s3", property: "list-before-move", message: "移动发票之前先把清单写进归档目录，方便事后核对", key: "list-before-move@s3" }],
    actions: [{ kind: "move_after", title: "把「把发票移到归档目录」挪到「写一份发票清单」之后", covers: ["list-before-move@s3"], stepId: "s3", costs: { ops: 0 } }],
    confirmations: [],
    deferred: [{ stepId: "s5", property: "v1.backup-before-overwrite", message: "「归档/2026-09/汇总.md」在不在要执行时才知道：已存在的话，覆盖之前要已备份或已提交", key: "v1.backup-before-overwrite@s5" }],
    replans: [],
    scanned: { rules: 7, steps: 5 },
    phases: { facts: 0, compile: 2.2, solve: 4.7, probe: 0.6 },
    rules: probes({ "v1.backup-before-overwrite": { unknown: 1 } }, [{ id: "list-before-move", title: "移动之前先写清单", violated: 1 }]),
    docs: [...TEMPLATE_DOCS, LIST_BEFORE_MOVE],
    ms: 7.5,
  },
  toolkit: { skills: [], mcp: [], bash: true, network: false },
};

const invoicePayload = (plan: WorkflowPlan, extra: Partial<WorkflowPlanCardPayload> = {}): WorkflowPlanCardPayload => ({
  taskId: INVOICE_TASK_ID,
  taskTitle: "整理九月的发票",
  revision: plan.version,
  planId: `${INVOICE_TASK_ID}-p${plan.version}`,
  goal: "把九月的发票归档，写清单和汇总",
  plan,
  ...extra,
});

const INVOICE_CARDS: Card[] = [
  card("c-wf-invoice-v1", invoicePayload(INVOICE_PLAN_V1, { refused: "needs_replan" }), { status: "handled", outcome: { action: "ack" }, createdAt: at("10-07", "09:32"), handledAt: at("10-07", "09:40") }),
  card("c-wf-invoice-v2", invoicePayload(INVOICE_PLAN_V2, { confirmed: [] }), { status: "handled", outcome: { action: "confirm" }, createdAt: at("10-07", "09:45"), handledAt: at("10-07", "09:50") }),
];

/** 正在执行的流程：做完 s1、s2、s4，s3 在做，s5 没做 */
export const FAKE_WORKFLOW_TASK: Task = {
  id: INVOICE_TASK_ID,
  title: "整理九月的发票",
  summary: "整理九月的发票\n下载目录里九月的发票归档到 归档/2026-09，写一份清单和本月汇总",
  state: "running",
  origin: "button",
  kind: "workflow",
  maintainerId: ownMaintainerId(INVOICE_TASK_ID),
  projects: [],
  projectIds: [],
  projectScope: "none",
  planCardId: "c-wf-invoice-v2",
  steps: {
    total: 5,
    done: 3,
    list: [
      { stepId: "s1", title: "列出下载目录里的发票", state: "done", gist: "12 张发票" },
      { stepId: "s2", title: "备份发票目录", state: "done", gist: "备份到 回收区/发票-备份" },
      { stepId: "s4", title: "写一份发票清单", state: "done", gist: "清单 12 行" },
      { stepId: "s3", title: "把发票移到归档目录", state: "in_progress" },
      { stepId: "s5", title: "写本月汇总", state: "pending" },
    ],
  },
  createdAt: at("10-07", "09:30"),
  updatedAt: at("10-07", "10:12"),
};

const FLOW: MessageScope = { taskId: INVOICE_TASK_ID, stageId: "flow" };
const PLANNING: MessageScope = { taskId: INVOICE_TASK_ID };

const INVOICE_MESSAGES: MessageEnvelope[] = [
  msg(
    INVOICES,
    "system",
    at("10-07", "09:30"),
    PLANNING,
    text("任务书：流程 t-invoices「整理九月的发票」\n目标：把下载目录里九月的发票归档到 归档/2026-09，并写一份清单和本月汇总\n验收标准：\n- 发票都在归档目录里，清单和汇总写好\n请据此把要做的事排成步骤（每步一次工具调用，连同要满足的条件）。"),
  ),
  msg(INVOICES, "agent", at("10-07", "09:32"), PLANNING, think("先列出来，再移过去，最后写清单和汇总。"), cardRef("c-wf-invoice-v1")),
  msg(INVOICES, "system", at("10-07", "09:32"), PLANNING, text("审查把计划 v1 退回维护者补充：「下载/发票」还没有 git 提交、也没有备份。先复制一份备份（cp），再移动。")),
  msg(INVOICES, "agent", at("10-07", "09:45"), PLANNING, text("补上了：移动之前先把发票目录复制一份到回收区；另外加了一条条件，移动之前先把清单写好。"), cardRef("c-wf-invoice-v2")),
  msg(INVOICES, "system", at("10-07", "09:50"), FLOW, text("用户已授权计划 v2，开始执行流程 t-invoices「整理九月的发票」，请按计划执行。")),
  msg(INVOICES, "agent", at("10-07", "09:51"), FLOW, report("s1", "in_progress"), tool("ls", "path=下载/发票", { nature: "look", result: "12 个 PDF", plan: { stepId: "s1" } }), report("s1", "done", "12 张发票")),
  msg(
    INVOICES,
    "agent",
    at("10-07", "09:55"),
    FLOW,
    report("s2", "in_progress"),
    tool("bash", "cp -r 下载/发票 回收区/发票-备份", { generic: true, result: "已复制 12 个文件", plan: { stepId: "s2" } }),
    report("s2", "done", "备份到 回收区/发票-备份"),
  ),
  msg(
    INVOICES,
    "agent",
    at("10-07", "09:58"),
    FLOW,
    think("备份好了，直接移过去。"),
    tool("bash", "mv 下载/发票/*.pdf 归档/2026-09/", {
      generic: true,
      categories: ["删除或覆盖（项目档案和工作目录内）"],
      disposition: "planned_only",
      withinGrant: true,
      nature: "modify",
      outcome: "blocked",
      blockedBy: "plan_redirect",
      result: "这一步先不执行：步骤 s3 依赖的 s4 还没有执行。按计划应先执行步骤 s4「写一份发票清单」，做完再回来",
      plan: { stepId: "s3", findings: ["rule:list-before-move"], correction: "redirect" },
    }),
  ),
  msg(
    INVOICES,
    "agent",
    at("10-07", "10:02"),
    FLOW,
    report("s4", "in_progress"),
    tool("write", "path=归档/2026-09/清单.md", { result: "写了 12 行", plan: { stepId: "s4" } }),
    report("s4", "done", "清单 12 行"),
    tool("ls", "path=归档", { nature: "look", result: "2026-07  2026-08  2026-09", plan: { offPlan: true } }),
  ),
  msg(
    INVOICES,
    "agent",
    at("10-07", "10:06"),
    FLOW,
    think("顺手先把汇总写了，放桌面方便看。"),
    tool("write", "path=桌面/汇总.md", { outcome: "denied", result: "你拒绝了：「汇总放归档目录里，别放桌面」", plan: { stepId: "s5", findings: ["out_of_scope"] } }),
  ),
  msg(INVOICES, "agent", at("10-07", "10:12"), FLOW, report("s3", "in_progress"), text("清单写好了，现在把发票移到归档目录；汇总照计划写在归档目录里。")),
];

const INVOICE_RECORD: TimelineRecordEventPayload = {
  record: {
    id: "wf-rec-1",
    kind: "deviation",
    summary: "自动纠偏：缺了前置步骤：先让维护者做「写一份发票清单」，再回来执行这一步",
    detail: "违反规则 list-before-move：移动发票之前先把清单写进归档目录，方便事后核对",
    time: at("10-07", "09:58"),
  },
  ...FLOW,
};

// ───────────────────────── 定时触发的流程：每周整理下载目录 ─────────────────────────

const DOWNLOADS_TASK_ID = "t-downloads";
const DOWNLOADS = maintainerChannel(ownMaintainerId(DOWNLOADS_TASK_ID));

const DOWNLOADS_PLAN: WorkflowPlan = {
  version: 1,
  goal: "把下载目录里的安装包、截图、文档分到三个文件夹",
  steps: [
    step("s1", "看下载目录里有什么", "ls", { path: "下载" }),
    step("s2", "安装包移到 installers/", "bash", { command: "mv 下载/*.exe 下载/*.msi 下载/installers/" }, { marks: [MOVE_MARK], conditions: [BACKUP_CONDITION("unknown")] }),
    step("s3", "截图移到 screenshots/", "bash", { command: "mv 下载/截图*.png 下载/screenshots/" }, { marks: [MOVE_MARK], conditions: [BACKUP_CONDITION("unknown")] }),
    step("s4", "文档移到 docs/", "bash", { command: "mv 下载/*.pdf 下载/*.docx 下载/docs/" }, { marks: [MOVE_MARK], conditions: [BACKUP_CONDITION("unknown")] }),
  ],
  rules: [],
  review: {
    verdict: "pass",
    status: "pass",
    violations: [],
    actions: [],
    confirmations: [],
    deferred: ["s2", "s3", "s4"].map((s) => ({ stepId: s, property: "v1.backup-before-overwrite", message: "移动的文件在不在、有没有备份要执行时才知道，执行时再查", key: `v1.backup-before-overwrite@${s}` })),
    replans: [],
    scanned: { rules: 6, steps: 4 },
    phases: { facts: 0, compile: 1.6, solve: 2.4, probe: 0.3 },
    rules: probes({ "v1.backup-before-overwrite": { unknown: 3 } }),
    docs: TEMPLATE_DOCS,
    ms: 4.3,
  },
  toolkit: { skills: [], mcp: [], bash: true, network: false },
};

const DOWNLOADS_CARD = card(
  "c-wf-downloads",
  {
    taskId: DOWNLOADS_TASK_ID,
    taskTitle: "每周整理下载目录",
    revision: 1,
    planId: `${DOWNLOADS_TASK_ID}-p1`,
    goal: "每周一把下载目录分门别类",
    plan: DOWNLOADS_PLAN,
    confirmed: [],
    schedule: { kind: "weekly", time: "09:00", weekdays: [1] },
  },
  { status: "handled", outcome: { action: "confirm" }, createdAt: at("10-01", "20:03"), handledAt: at("10-01", "20:05") },
);

/** 每周一 09:00 整理下载目录（定时触发的流程）：授权过一次；第 1 次运行做完了，第 2 次在跑 */
export const FAKE_TIMED_WORKFLOW: Task = {
  id: DOWNLOADS_TASK_ID,
  title: "每周整理下载目录",
  summary: "每周整理下载目录\n把下载目录里的安装包、截图、文档分到三个文件夹",
  state: "operating",
  origin: "button",
  kind: "workflow",
  trigger: { kind: "schedule", schedule: { kind: "weekly", time: "09:00", weekdays: [1] } },
  maintainerId: ownMaintainerId(DOWNLOADS_TASK_ID),
  projects: [],
  projectIds: [],
  projectScope: "none",
  planCardId: "c-wf-downloads",
  createdAt: at("10-01", "20:00"),
  updatedAt: at("10-12", "09:03"),
};

const RUN_1: JobRun = {
  runId: "j-downloads-r1",
  jobId: "j-downloads",
  trigger: "scheduled",
  dueAt: at("10-05", "09:00"),
  events: [{ source: "time", at: at("10-05", "09:00"), summary: "10 月 5 日（周一）09:00 到点" }],
  state: "done",
  queuedAt: at("10-05", "09:00"),
  startedAt: at("10-05", "09:00"),
  endedAt: at("10-05", "09:04"),
  summary: "整理好了：3 个安装包、12 张截图归了位；这周没有新文档。",
  steps: [
    { stepId: "s1", title: "看下载目录里有什么", state: "done" },
    { stepId: "s2", title: "安装包移到 installers/", state: "done", gist: "3 个" },
    { stepId: "s3", title: "截图移到 screenshots/", state: "done", gist: "12 张" },
    { stepId: "s4", title: "文档移到 docs/", state: "skipped", gist: "这周没有新文档" },
  ],
};
const RUN_2: JobRun = {
  runId: "j-downloads-r2",
  jobId: "j-downloads",
  trigger: "scheduled",
  dueAt: at("10-12", "09:00"),
  events: [{ source: "time", at: at("10-12", "09:00"), summary: "10 月 12 日（周一）09:00 到点" }],
  state: "running",
  queuedAt: at("10-12", "09:00"),
  startedAt: at("10-12", "09:00"),
  steps: [
    { stepId: "s1", title: "看下载目录里有什么", state: "done", gist: "5 个安装包、20 张截图、2 份文档" },
    { stepId: "s2", title: "安装包移到 installers/", state: "in_progress" },
    { stepId: "s3", title: "截图移到 screenshots/", state: "pending" },
    { stepId: "s4", title: "文档移到 docs/", state: "pending" },
  ],
};
const downloadsJob = (runCount: number, lastRun: JobRun): ScheduledJob => ({
  id: "j-downloads",
  title: FAKE_TIMED_WORKFLOW.title,
  schedule: { kind: "weekly", time: "09:00", weekdays: [1] },
  each: FAKE_TIMED_WORKFLOW.summary,
  maintainerId: FAKE_TIMED_WORKFLOW.maintainerId,
  taskId: FAKE_TIMED_WORKFLOW.id,
  taskTitle: FAKE_TIMED_WORKFLOW.title,
  ownerTaskId: FAKE_TIMED_WORKFLOW.id,
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state: "active",
  nextAt: at("10-19", "09:00"),
  lastFailed: false,
  consecutiveFailures: 0,
  runCount,
  lastRun,
  createdAt: at("10-01", "20:05"),
  updatedAt: lastRun.endedAt ?? lastRun.startedAt ?? lastRun.queuedAt,
});

const runDivider = (run: JobRun, no: number): MessagePart => ({ type: "run_divider", jobId: run.jobId, runId: run.runId, title: `第 ${no} 次运行 · ${run.events![0]!.summary}` });
const RUN_SCOPE: MessageScope = { taskId: DOWNLOADS_TASK_ID, scheduledJobId: "j-downloads" };

const DOWNLOADS_MESSAGES: MessageEnvelope[] = [
  msg(DOWNLOADS, "system", at("10-01", "20:00"), { taskId: DOWNLOADS_TASK_ID }, text("任务书：流程 t-downloads「每周整理下载目录」\n目标：把下载目录里的安装包、截图、文档分到三个文件夹\n定时：每周一 09:00")),
  msg(DOWNLOADS, "agent", at("10-01", "20:03"), { taskId: DOWNLOADS_TASK_ID }, cardRef("c-wf-downloads")),
  msg(DOWNLOADS, "system", at("10-05", "09:00"), RUN_SCOPE, runDivider(RUN_1, 1)),
  msg(DOWNLOADS, "system", at("10-05", "09:00"), RUN_SCOPE, text("定时触发的流程 t-downloads「每周整理下载目录」的第 1 次运行（j-downloads-r1）。触发：10 月 5 日（周一）09:00 到点\n照授权的计划从第一步做起。")),
  msg(
    DOWNLOADS,
    "agent",
    at("10-05", "09:01"),
    RUN_SCOPE,
    report("s1", "in_progress"),
    tool("ls", "path=下载", { nature: "look", result: "3 个安装包、12 张截图", plan: { stepId: "s1" } }),
    report("s1", "done"),
    tool("bash", "mv 下载/*.exe 下载/*.msi 下载/installers/", { generic: true, nature: "modify", categories: ["删除或覆盖（项目档案和工作目录内）"], disposition: "planned_only", withinGrant: true, result: "移了 3 个", plan: { stepId: "s2" } }),
    tool("bash", "mv 下载/截图*.png 下载/screenshots/", { generic: true, nature: "modify", categories: ["删除或覆盖（项目档案和工作目录内）"], disposition: "planned_only", withinGrant: true, result: "移了 12 张", plan: { stepId: "s3" } }),
    report("s4", "skipped", "这周没有新文档"),
  ),
  msg(DOWNLOADS, "agent", at("10-05", "09:04"), RUN_SCOPE, text("整理好了：3 个安装包、12 张截图归了位；这周没有新文档。")),
  msg(DOWNLOADS, "system", at("10-12", "09:00"), RUN_SCOPE, runDivider(RUN_2, 2)),
  msg(
    DOWNLOADS,
    "system",
    at("10-12", "09:00"),
    RUN_SCOPE,
    text("定时触发的流程 t-downloads「每周整理下载目录」的第 2 次运行（j-downloads-r2）。触发：10 月 12 日（周一）09:00 到点\n前几次运行的结果（做了什么在这一段会话的前面）：\n- 第 1 次运行（10 月 5 日（周一）09:00）：成功——最后说的：整理好了：3 个安装包、12 张截图归了位；这周没有新文档。"),
  ),
  msg(
    DOWNLOADS,
    "agent",
    at("10-12", "09:02"),
    RUN_SCOPE,
    report("s1", "in_progress"),
    tool("ls", "path=下载", { nature: "look", result: "5 个安装包、20 张截图、2 份文档", plan: { stepId: "s1" } }),
    report("s1", "done", "5 个安装包、20 张截图、2 份文档"),
    report("s2", "in_progress"),
    // 命令和计划写的不一样（少了 *.msi）：守卫按计划把参数改回再执行
    tool("bash", "mv 下载/*.exe 下载/installers/", {
      generic: true,
      nature: "modify",
      categories: ["删除或覆盖（项目档案和工作目录内）"],
      disposition: "planned_only",
      withinGrant: true,
      result: "参数按计划改回（补上 *.msi）后执行：移了 5 个",
      plan: { stepId: "s2", findings: ["out_of_scope"], correction: "rewrite" },
    }),
  ),
];

/** 原型启动时这两个流程"已有"的事件（卡片、会话、看板），按先后 */
export const WORKFLOW_CARDS: Card[] = [...INVOICE_CARDS, DOWNLOADS_CARD];

const messageEvent = (m: MessageEnvelope) => ({ channel: m.conversation, type: EVENT_TYPES.message, payload: { message: m, ...SCOPES.get(m.id) } });

/**
 * 这条消息里每次报某一步开始（report_step status=in_progress）的那条步骤开始的记号（153 号票），排在消息前面（守护进程在汇报这次调用里记，
 * 调用记录在它后面）；原型把一轮里的几次调用并成一条消息，回退点挂在这条消息上
 */
function stepMarks(m: MessageEnvelope, taskId: string, plan: WorkflowPlan): { channel: string; type: string; payload: StageStartEventPayload }[] {
  return m.parts.flatMap((p) => {
    if (p.type !== "tool_call" || p.tool !== "report_step") return [];
    const found = /stepId=(\S+) status=in_progress/.exec(p.argsSummary);
    if (!found) return [];
    const stepId = found[1]!;
    const title = plan.steps.find((s) => s.id === stepId)?.title ?? stepId;
    const payload: StageStartEventPayload = { id: `ss-${p.callId}`, conversation: m.conversation, taskId, stageId: "flow", stepId, title, via: { call: p.callId, tool: "report_step", after: false }, time: m.time };
    return [{ channel: m.conversation, type: EVENT_TYPES.stageStart, payload }];
  });
}

export const WORKFLOW_HISTORY: { channel: string; type: string; payload: unknown }[] = [
  // 自动纠偏的那一条时间线记录紧跟在被引回的那次调用后面（守护进程同一时刻发）
  ...INVOICE_MESSAGES.flatMap((m) => [
    ...stepMarks(m, INVOICE_TASK_ID, INVOICE_PLAN_V2),
    messageEvent(m),
    ...(m.time === INVOICE_RECORD.record.time ? [{ channel: INVOICES, type: EVENT_TYPES.timelineRecord, payload: INVOICE_RECORD }] : []),
  ]),
  ...DOWNLOADS_MESSAGES.flatMap((m) => [...stepMarks(m, DOWNLOADS_TASK_ID, DOWNLOADS_PLAN), messageEvent(m)]),
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_WORKFLOW_TASK, change: "step_reported", from: "running", by: "maintainer" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task: FAKE_TIMED_WORKFLOW, change: "plan_confirmed", from: "awaiting_confirm", by: "user" } satisfies TaskEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: downloadsJob(1, RUN_1), change: "run_finished", by: "system", run: RUN_1 } satisfies ScheduledJobEventPayload },
  { channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload: { job: downloadsJob(2, RUN_2), change: "run_started", by: "system", run: RUN_2 } satisfies ScheduledJobEventPayload },
];
