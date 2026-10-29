// 工具调用说成人话的一句（67 号票，规格第 19 节"会话区"）：每种工具一个说法模板（"删除照片：…""在蓝鲸购物下单：柔丝家庭装 ×1"
// 这种），加上要点层那一行的前缀。
// 不写"工具名 + 参数摘要"，写一句"读 src/app.ts""把改动提交：修复登录超时"；没有模板的退回"中文名 · 参数值"。
// 用在：工具调用组的要点那一行和组的详情里每一步（57 号票）、单次调用的详情（56 号票）、缩小后每一块的要点层（54、57 号票）。
//
// 用户 2026-10-10 定的：
// - 说法：动词加对象，不带"了"（"读 src/app.ts"，不是"读了 src/app.ts"）——被拦下、你拒绝了的前面加了 ⛔ ✕，
//   带"了"就把没做的事说成做了；
// - 要点层那一行的前缀四种：⛔ 被拦下、↩ 拉回（二狗的"按规则退回"）、⏸ 等你批准、✕ 你拒绝了；
//   问过你、出错、按计划引回不加；读了密钥文件的（守护进程不记内容的那种，
//   工具调用 part 的 readsSecretFile）再加 🔒；
// - 句子里超过 40 字的路径只留末尾几级、前面写"…/"；
//   没有模板的，对话层、要点层、详情页三处统一写"中文名 · 参数值"、截到 60 字（不三处各写一种：工具行是中文名加参数值
//   拼接截 60，要点层是中文名 · 一个主要参数，详情只写中文名），参数摘要里的"参数名="去掉。
//
// 前端拿到的只有工具调用 part 的参数摘要（一行，守护进程截到 160 字，guard-runtime/describe.ts 的 summarizeArgs）：
// bash 是命令原文，文件工具是路径（搜索带上模式："模式 · 路径"），联网搜索是查询词、读网页是网址，别的工具是"参数名=值 参数名=值"
// （不是字符串的值写成 JSON）。模板按工具名查，按这个写法拆出参数（用户 2026-10-10 同意，不改协议）；拆不出要的参数（参数缺失、
// 摘要被截断、彻底删除过）就退回。工具的中文名照守护进程登记的 title 抄一份在这里；
// MCP 工具（mcp__<MCP 名>__<工具名>）前端不知道中文名，写原名。纯函数。
// 170 号票起句子和工具名按当前语言（state.callSentence.*；英文的说法同样是动词加对象）。
import { describeWorkdayChange, MEMORY_COMMAND_LABEL, type MessagePart, PURGED_TEXT, type RepeatRule, describeSchedule, repeatSchedule, t, TELL_SECRETARY_CAPABILITY, tTable, type WorkdayChange } from "./protocol.ts";
import { bashSentence } from "./shell-sentence.ts";
import { cutTo, FALLBACK_MAX, joinList, pathsText, shortPath, shortUrl } from "./sentence-parts.ts";
import { awaitingApproval } from "./timeline.ts";

export { FALLBACK_MAX, PATH_MAX, shortPath, shortUrl } from "./sentence-parts.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/**
 * 工具的中文名：照守护进程登记的 title（guard/tool-registry.ts 的内置、带类型的 bash、联网工具，各模块 defineHostTool 的 title）。
 * 项目维护者的发起任务（tasks/internal-tools.ts）和秘书的同名，中文名按秘书的写
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = labelTable(
  {
    // pi 自带的文件工具和通用 bash
    read: "state.callSentence.tool.read",
    write: "state.callSentence.tool.write",
    edit: "state.callSentence.tool.edit",
    ls: "state.callSentence.tool.ls",
    grep: "state.callSentence.tool.grep",
    find: "state.callSentence.tool.find",
    bash: "state.callSentence.tool.bash",
    // 带类型的特殊 bash 工具（28 号票）
    git_status_diff: "state.callSentence.tool.git_status_diff",
    git_commit: "state.callSentence.tool.git_commit",
    git_merge: "state.callSentence.tool.git_merge",
    git_push: "state.callSentence.tool.git_push",
    create_remote_repo: "state.callSentence.tool.create_remote_repo",
    run_tests: "state.callSentence.tool.run_tests",
    install_deps: "state.callSentence.tool.install_deps",
    start_build: "state.callSentence.tool.start_build",
    // 联网工具（70 号票）
    web_search: "state.callSentence.tool.web_search",
    web_fetch: "state.callSentence.tool.web_fetch",
    // 秘书的工具
    view_board: "state.callSentence.tool.view_board",
    // 守护进程登记的是"列出待我处理"，界面上一律叫"待办"（43 号票）
    list_inbox: "state.callSentence.tool.list_inbox",
    show_card: "state.callSentence.tool.show_card",
    search_materials: "state.callSentence.tool.search_materials",
    // 271 号票：记下这一轮顺口问了哪个"了解你问题"
    mark_woven_question: "state.callSentence.tool.mark_woven_question",
    // 166 号票：读一条素材的全文（用户存的网页给存下的正文）
    read_material: "state.callSentence.tool.read_material",
    read_attachment: "state.callSentence.tool.read_attachment",
    send_attachment: "state.callSentence.tool.send_attachment",
    read_project_records: "state.callSentence.tool.read_project_records",
    suggest_project: "state.callSentence.tool.suggest_project",
    create_reminder: "state.callSentence.tool.create_reminder",
    update_reminder: "state.callSentence.tool.update_reminder",
    cancel_reminder: "state.callSentence.tool.cancel_reminder",
    archive_reminder: "state.callSentence.tool.archive_reminder",
    propose_quick_action: "state.callSentence.tool.propose_quick_action",
    start_workflow: "state.callSentence.tool.start_workflow",
    create_task: "state.callSentence.tool.create_task",
    delegate_task: "state.callSentence.tool.delegate_task",
    suggest_task: "state.callSentence.tool.suggest_task",
    ask_questions: "state.callSentence.tool.ask_questions",
    write_task_brief: "state.callSentence.tool.write_task_brief",
    spoken_summary: "state.callSentence.tool.spoken_summary",
    send_voice: "state.callSentence.tool.send_voice",
    // 维护者的工具
    submit_plan: "state.callSentence.tool.submit_plan",
    submit_charter: "state.callSentence.tool.submit_charter",
    propose_charter_change: "state.callSentence.tool.propose_charter_change",
    propose_standard_change: "state.callSentence.tool.propose_standard_change",
    // 259 号票：维护者、秘书提转入使用（只出确认卡）
    propose_go_live: "state.callSentence.tool.propose_go_live",
    start_stage: "state.callSentence.tool.start_stage",
    complete_stage: "state.callSentence.tool.complete_stage",
    report_progress: "state.callSentence.tool.report_progress",
    wait_for_user: "state.callSentence.tool.wait_for_user",
    fail_task: "state.callSentence.tool.fail_task",
    propose_plan_change: "state.callSentence.tool.propose_plan_change",
    revise_plan: "state.callSentence.tool.revise_plan",
    mark_infeasible: "state.callSentence.tool.mark_infeasible",
    propose_parallel: "state.callSentence.tool.propose_parallel",
    submit_review: "state.callSentence.tool.submit_review",
    propose_plan: "state.callSentence.tool.propose_plan",
    report_step: "state.callSentence.tool.report_step",
    write_segment_summary: "state.callSentence.tool.write_segment_summary",
    write_progress: "state.callSentence.tool.write_progress",
    ask_clarification: "state.callSentence.tool.ask_clarification",
    submit_receipt: "state.callSentence.tool.submit_receipt",
    dispatch_work_order: "state.callSentence.tool.dispatch_work_order",
    summarize_receipts: "state.callSentence.tool.summarize_receipts",
    answer_work_order: "state.callSentence.tool.answer_work_order",
    forward_to_user: "state.callSentence.tool.forward_to_user",
    fail_job_run: "state.callSentence.tool.fail_job_run",
    adjust_skills: "state.callSentence.tool.adjust_skills",
    request_toolkit_change: "state.callSentence.tool.request_toolkit_change",
    // 239 号票：登记 MCP
    request_mcp_change: "state.callSentence.tool.request_mcp_change",
  },
  // 102 号票：给秘书发消息（写名字占位，界面上显示用户起的名字，43 号票）；协议包的常量，现取
  { tell_secretary: () => TELL_SECRETARY_CAPABILITY },
);

/** tTable 再加几项现取的（协议包的常量）：取值时按当前语言查，换了语言不用重建 */
function labelTable(keys: Readonly<Record<string, string>>, more: Readonly<Record<string, () => string>>): Readonly<Record<string, string>> {
  const table: Record<string, string> = {};
  for (const [name, key] of Object.entries(keys)) Object.defineProperty(table, name, { enumerable: true, get: () => t(key) });
  for (const [name, get] of Object.entries(more)) Object.defineProperty(table, name, { enumerable: true, get });
  return Object.freeze(table);
}

/** 工具的中文名；没登记的（MCP 工具、以后加的）写原名 */
export function toolLabel(tool: string): string {
  return Object.hasOwn(TOOL_LABELS, tool) ? TOOL_LABELS[tool]! : tool;
}

/** 一次调用说成的那一句；said 是有模板说成了人话的，否则是退回的"中文名 · 参数值" */
export interface CallSentence {
  readonly text: string;
  readonly said: boolean;
}

/**
 * 参数里的编号换成给用户看的写法（159 号票：任务写"t-3「整理发票」"（163 号票），状态层的 readableId 现取）；认不出的（写的是标题）原样。
 * 不给时照原样写编号（纯函数、测试里）
 */
export type IdNamer = (ref: string) => string;

const asIs: IdNamer = (ref) => ref;

/** 一次调用说成人话；没有模板、拆不出要的参数时退回"中文名 · 参数值"（截到 60 字）。named：参数里的编号怎么写（159 号票） */
export function callSentence(part: Pick<ToolCallPart, "tool" | "argsSummary">, named?: IdNamer): CallSentence {
  const said = describeCall(part.tool, part.argsSummary, named);
  return said === undefined ? { text: fallbackLine(part.tool, part.argsSummary), said: false } : { text: said, said: true };
}

/**
 * 要点层那一行：前缀（⛔ 被拦下、↩ 拉回、⏸ 等你批准、✕ 你拒绝了）、读了密钥文件的 🔒，再是那一句
 * （sentence：会话条目层已经按状态层的名字说好的那一句，159 号票；不给时现说，编号照原样）
 */
export function callKeyLine(part: ToolCallPart, sentence: string = callSentence(part).text): string {
  return `${callMark(part)}${part.readsSecretFile ? "🔒 " : ""}${sentence}`;
}

/**
 * 要点层的前缀（拦下 ⛔、拉回 ↩、停下说明进展 ⏸、你拒绝了 ✕）。二狗：被拦下（硬拒绝、判定出错、计划检查拦下、
 * 按处置没执行）⛔；按规则退回（时序规则，即拉回）↩；等你批准 ⏸（57 号票定的）；你拒绝了 ✕。
 * 按计划引回、问过你（当场确认）、出错都不加（用户 2026-10-10 定）
 */
export function callMark(part: ToolCallPart): string {
  if (part.outcome === "denied") return "✕ ";
  if (part.outcome !== "blocked") return "";
  if (part.blockedBy === "pull_back") return "↩ ";
  if (part.blockedBy === "plan_redirect") return "";
  return awaitingApproval(part) ? "⏸ " : "⛔ ";
}

/** 这个工具有没有模板 */
export function hasCallTemplate(tool: string): boolean {
  return Object.hasOwn(TEMPLATES, tool);
}

/** 有模板就说成人话；没有模板、彻底删除过、拆不出要的参数是 undefined。named 见 callSentence */
export function describeCall(tool: string, argsSummary: string, named: IdNamer = asIs): string | undefined {
  if (argsSummary === PURGED_TEXT || !Object.hasOwn(TEMPLATES, tool)) return undefined;
  try {
    return TEMPLATES[tool]!(argsSummary, named) || undefined;
  } catch {
    // 参数不全、写法不对时退回
    return undefined;
  }
}

/** 没有模板的：中文名 · 参数值（参数摘要里的"参数名="去掉，几个值用 · 隔开），截到 60 字 */
export function fallbackLine(tool: string, argsSummary: string): string {
  // 命令原文、查询词、网址、路径本来就是值，不按"参数名="拆（FOO=1 npm ci 不能拆成"1 npm ci"）；路径工具没给路径时才是"参数名=值"
  const pairs = Object.hasOwn(RAW_SUMMARY, tool) ? summaryArgs(argsSummary, RAW_SUMMARY[tool]!) : summaryArgs(argsSummary);
  const values = Object.keys(pairs).length > 0 ? Object.values(pairs).filter((v) => v !== "") : argsSummary.trim() ? [argsSummary.trim()] : [];
  return cutTo([toolLabel(tool), ...values].join(" · "), FALLBACK_MAX);
}

/**
 * 参数摘要"参数名=值 参数名=值"按参数名拆开。keys 给了就只在这几个名字处断开（值里碰巧有空格加"别的名字="也不会拆错），
 * 第一个必须从开头起；不是这种写法的（路径、命令原文）是空的
 */
export function summaryArgs(summary: string, keys?: readonly string[]): Record<string, string> {
  const hits = [...summary.matchAll(/(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g)].filter((m) => !keys || keys.includes(m[1]!));
  if (hits.length === 0 || hits[0]!.index !== 0) return {};
  const out: Record<string, string> = {};
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index : summary.length;
    out[m[1]!] = summary.slice(m.index + m[0].length, end).trim();
  });
  return out;
}

// ───────────────────────── 模板 ─────────────────────────

/** 一个工具的模板：参数摘要 → 一句话；拆不出要的参数时返回 undefined（退回）。named：参数里的编号怎么写（159 号票，说到任务的模板用） */
type Template = (summary: string, named: IdNamer) => string | undefined;

/** 路径工具（read、write、edit、ls）的摘要：有路径时就是路径本身；没给路径时是"参数名=值"（这几个名字是它的其他参数） */
function pathOf(summary: string, otherKeys: readonly string[]): string | undefined {
  const s = summary.trim();
  if (s === "" || Object.keys(summaryArgs(s, otherKeys)).length > 0) return undefined;
  return s;
}

/** JSON 数组的值（守护进程用 JSON.stringify 写的）：各项写成字符串；被截断、解析不了的去掉括号和引号凑合着用 */
function listOf(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    return [typeof parsed === "string" ? parsed : value];
  } catch {
    return value
      .replace(/^\[|\]$|…$/g, "")
      .split(",")
      .map((x) => x.replace(/^"|"$/g, "").trim())
      .filter((x) => x !== "");
  }
}

/** JSON 对象的值；解析不了是 undefined */
function objectOf(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const READ_KEYS = ["path", "offset", "limit"];
const WRITE_KEYS = ["path", "content"];
const EDIT_KEYS = ["path", "edits", "oldText", "newText", "append"];
const LS_KEYS = ["path", "limit"];
const SEARCH_KEYS = ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"];

/**
 * 参数摘要本来就是值的工具（guard-runtime/describe.ts 的 summarizeArgs）：bash 是命令（只认空的名单，一律不拆），联网是查询词和网址、
 * 文件工具是路径、搜索是"模式 · 路径"（没给这些时才是"参数名=值"，只认它们自己的参数名）
 */
const RAW_SUMMARY: Readonly<Record<string, readonly string[]>> = {
  bash: [],
  web_search: ["query", "n", "time", "engine", "region", "tavily", "json"],
  web_fetch: ["url", "max"],
  read: READ_KEYS,
  write: WRITE_KEYS,
  edit: EDIT_KEYS,
  ls: LS_KEYS,
  grep: SEARCH_KEYS,
  find: SEARCH_KEYS,
};

/** "模式 · 路径"（搜索、查找文件）：没给路径时只有模式；两个都没给时是"参数名=值" */
function patternOf(summary: string): { pattern: string; path?: string } | undefined {
  if (summary.trim() === "" || Object.keys(summaryArgs(summary, SEARCH_KEYS)).length > 0) return undefined;
  const cut = summary.lastIndexOf(" · ");
  return cut < 0 ? { pattern: summary } : { pattern: summary.slice(0, cut), path: summary.slice(cut + 3) };
}

/** read 读到某个 skill 的 SKILL.md：pi 用 skill 时就是这样读它的说明（82 号票的斜杠命令点名之后也一样） */
function skillOf(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts.length >= 2 && /^skill\.md$/i.test(parts[parts.length - 1]!) ? parts[parts.length - 2] : undefined;
}

/** 星期几（0 是周日）、几天后（0、1、2 是今天、明天、后天） */
const WEEKDAY: Readonly<Record<string, string>> = tTable({
  "0": "state.callSentence.weekday.0",
  "1": "state.callSentence.weekday.1",
  "2": "state.callSentence.weekday.2",
  "3": "state.callSentence.weekday.3",
  "4": "state.callSentence.weekday.4",
  "5": "state.callSentence.weekday.5",
  "6": "state.callSentence.weekday.6",
});
const IN_DAY: Readonly<Record<string, string>> = tTable({ "0": "state.callSentence.inDay.0", "1": "state.callSentence.inDay.1", "2": "state.callSentence.inDay.2" });

/** 表里有这一项就取（不认原型链上的） */
const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** 提醒的时间参数（reminders/tools.ts 的 timeParams）写成一句：明天 09:00、周五 18:00、30 分钟后、每天 09:00 */
function reminderWhen(a: Record<string, string>): string | undefined {
  const time = a.time;
  if (a.at) return a.at;
  if (a.inMinutes) return t("state.callSentence.inMinutes", { count: Number(a.inMinutes), n: a.inMinutes });
  if (a.repeat) {
    const rule = objectOf(a.repeat) as RepeatRule | undefined;
    const made = rule && time ? repeatSchedule(rule, time) : undefined;
    return made && "schedule" in made ? describeSchedule(made.schedule) : time ? t("state.callSentence.repeatAt", { time }) : t("state.callSentence.repeat");
  }
  const day =
    a.inDays !== undefined
      ? (own(IN_DAY, String(Number(a.inDays))) ?? t("state.callSentence.inDays", { count: Number(a.inDays), n: a.inDays }))
      : a.weekday !== undefined
        ? (own(WEEKDAY, String(Number(a.weekday))) ?? t("state.callSentence.weekdayRaw", { n: a.weekday }))
        : a.date;
  if (day && time) return `${day} ${time}`;
  return day ?? time;
}

const REMINDER_TIME_KEYS = ["at", "time", "date", "weekday", "inDays", "inMinutes", "repeat"];

/** 发语音那一句写口语稿的前多少个字（超出的写"…"） */
const SEND_VOICE_HEAD = 20;
/** 给秘书发消息写原话的前几个字（整段在调用详情里） */
const TELL_SECRETARY_HEAD = 30;

/** 项目档案的几份（projects/records-tool.ts 的 DOCS） */
const PROJECT_DOC_LABEL: Readonly<Record<string, string>> = tTable({
  charter: "state.callSentence.doc.charter",
  spec: "state.callSentence.doc.spec",
  glossary: "state.callSentence.doc.glossary",
  adr: "state.callSentence.doc.adr",
  progress: "state.callSentence.doc.progress",
  manifest: "state.callSentence.doc.manifest",
  scope_records: "state.callSentence.doc.scope_records",
});

/** 路径里的文件夹名（末尾的斜杠不算；盘的根写原样） */
function folderName(path: string): string {
  return path.split(/[\\/]/u).findLast((part) => part !== "" && !part.endsWith(":")) ?? path;
}

/** 快速动作（quick-actions/tool.ts）：按动作类型说做什么；任务写编号的换成"t-3「整理发票」"（159、163 号票） */
function quickActionLine(type: string | undefined, params: Record<string, unknown> | undefined, named: IdNamer): string | undefined {
  if (!type) return undefined;
  const p = params ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  switch (type) {
    case "remember":
      return str("content") ? t("state.callSentence.qa.remember", { content: str("content") }) : undefined;
    case "forget":
    case "purge":
    case "no_infer": {
      const n = Array.isArray(p.materialIds) ? p.materialIds.length : undefined;
      const label = MEMORY_COMMAND_LABEL[type];
      return n ? t("state.callSentence.qa.materialsCount", { label, count: n, n }) : t("state.callSentence.qa.materials", { label });
    }
    case "pause_task":
      return str("task") ? t("state.callSentence.qa.pauseTask", { task: named(str("task")!) }) : undefined;
    case "resume_task":
      return str("task") ? t("state.callSentence.qa.resumeTask", { task: named(str("task")!) }) : undefined;
    case "cancel_task":
      return str("task") ? t("state.callSentence.qa.cancelTask", { task: named(str("task")!) }) : undefined;
    // 103 号票：秘书转达，写转给谁和那句话
    case "tell_task":
      return str("task") ? t(str("message") ? "state.callSentence.qa.tellTaskSaying" : "state.callSentence.qa.tellTask", { task: named(str("task")!), message: str("message") }) : undefined;
    case "tell_project":
      return str("project") ? t(str("message") ? "state.callSentence.qa.tellProjectSaying" : "state.callSentence.qa.tellProject", { project: str("project"), message: str("message") }) : undefined;
    case "workday_calendar": {
      // 照快速动作自己的规范化（workday/quick-action.ts）拼成改动，再用工作日历的写法说
      const change = str("change");
      const rule = p.rule as Extract<WorkdayChange, { kind: "add_rule" }>["rule"] | undefined;
      const date = str("date");
      let normalized: WorkdayChange | undefined;
      if ((change === "add_rule" || change === "remove_rule") && rule) normalized = { kind: change, rule };
      else if (change === "clear_mark" && date) normalized = { kind: "clear_mark", date };
      else if ((change === "mark_rest" || change === "mark_work") && date) normalized = { kind: "mark", date, mark: change === "mark_work" ? "work" : "rest" };
      return normalized ? t("state.callSentence.qa.workdayChange", { change: describeWorkdayChange(normalized) }) : t("state.callSentence.qa.workday");
    }
    // 185 号票：删除简单提醒
    case "delete_reminder":
      return str("reminderId") ? t("state.callSentence.qa.deleteReminder", { id: str("reminderId") }) : undefined;
    // 138 号票：授权文件夹，写方向和文件夹名（完整路径在卡上）
    case "authorize_folders": {
      const verb = str("change") === "remove" ? t("state.callSentence.qa.unauthorize") : t("state.callSentence.qa.authorize");
      const names = Array.isArray(p.folders) ? p.folders.flatMap((f) => (typeof f === "string" ? [folderName(f)] : [])) : [];
      return names.length > 0 ? t("state.callSentence.qa.folders", { verb, names: joinList(names) }) : verb;
    }
    default:
      return t("state.callSentence.qa.other", { type });
  }
}

/**
 * 各工具的模板（动词加对象，对象是名字、标题的用「」括起来，后面要补充的用"："接）。
 * 用户点名要有的：读、写、改、删、列目录、搜索、通用 bash（按拆出来的命令）、git 提交 / 推送 / 建仓库、联网读取、提醒、日历（快速动作
 * "改工作日历"）、看板、项目档案、附件和素材；70 号票的联网搜索、读网页；82 号票的斜杠命令调出来的发起流程、发起长程任务，
 * 和 agent 读 skill 的 SKILL.md；75 号票的交给后台（普通任务）；102 号票维护者给秘书发消息。二狗没有发邮件、日历的工具（只有 MCP 来的，退回原样）
 */
const TEMPLATES: Readonly<Record<string, Template>> = {
  read: (s) => {
    const path = pathOf(s, READ_KEYS);
    if (!path) return undefined;
    const skill = skillOf(path);
    return skill ? t("state.callSentence.readSkill", { skill }) : t("state.callSentence.read", { path: shortPath(path) });
  },
  write: (s) => {
    const path = pathOf(s, WRITE_KEYS);
    return path && t("state.callSentence.write", { path: shortPath(path) });
  },
  edit: (s) => {
    const path = pathOf(s, EDIT_KEYS);
    return path && t("state.callSentence.edit", { path: shortPath(path) });
  },
  ls: (s) => {
    const path = pathOf(s, LS_KEYS);
    return path ? t("state.callSentence.ls", { path: shortPath(path) }) : t("state.callSentence.lsHere");
  },
  grep: (s) => {
    const p = patternOf(s);
    return p && (p.path ? t("state.callSentence.grepIn", { path: shortPath(p.path), pattern: p.pattern }) : t("state.callSentence.grep", { pattern: p.pattern }));
  },
  find: (s) => {
    const p = patternOf(s);
    return p && (p.path ? t("state.callSentence.findIn", { path: shortPath(p.path), pattern: p.pattern }) : t("state.callSentence.findHere", { pattern: p.pattern }));
  },
  bash: (s) => bashSentence(s),

  git_status_diff: (s) => {
    const a = summaryArgs(s, ["repoPath", "paths"]);
    const paths = listOf(a.paths);
    return paths.length > 0 ? t("state.callSentence.gitStatusOf", { paths: pathsText(paths) }) : t("state.callSentence.gitStatus");
  },
  git_commit: (s) => {
    const a = summaryArgs(s, ["repoPath", "message", "paths", "amend"]);
    if (!a.message) return undefined;
    if (a.amend === "true") return t("state.callSentence.amend", { message: a.message });
    const paths = listOf(a.paths);
    return paths.length > 0 ? t("state.callSentence.commitPaths", { paths: pathsText(paths), message: a.message }) : t("state.callSentence.commit", { message: a.message });
  },
  git_merge: (s) => {
    const a = summaryArgs(s, ["repoPath", "branch"]);
    return a.branch && t("state.callSentence.merge", { branch: a.branch });
  },
  git_push: (s) => {
    const a = summaryArgs(s, ["repoPath", "remote", "branch", "force", "delete", "headCommit"]);
    if (!a.remote) return undefined;
    if (a.delete === "true") return a.branch && t("state.callSentence.deleteBranch", { remote: a.remote, branch: a.branch });
    const force = a.force === "true";
    if (a.branch) return t(force ? "state.callSentence.forcePush" : "state.callSentence.push", { branch: a.branch, remote: a.remote });
    return t(force ? "state.callSentence.forcePushCurrent" : "state.callSentence.pushCurrent", { remote: a.remote });
  },
  create_remote_repo: (s) => {
    const a = summaryArgs(s, ["repoPath", "name", "visibility", "description"]);
    if (!a.name) return undefined;
    const visibility = a.visibility === "public" ? t("state.callSentence.visibility.public") : a.visibility === "internal" ? t("state.callSentence.visibility.internal") : "";
    return t(a.description ? "state.callSentence.createRepoAbout" : "state.callSentence.createRepo", { name: a.name, visibility, description: a.description });
  },
  run_tests: (s) => {
    const args = listOf(summaryArgs(s, ["repoPath", "args"]).args);
    return args.length > 0 ? t("state.callSentence.runTestsWith", { args: args.join(" ") }) : t("state.callSentence.runTests");
  },
  install_deps: (s) => {
    const a = summaryArgs(s, ["repoPath", "packages", "dev"]);
    const packages = listOf(a.packages);
    const what = packages.length > 0 ? t("state.callSentence.installPackages", { packages: joinList(packages) }) : t("state.callSentence.installDeps");
    return `${what}${a.dev === "true" ? t("state.callSentence.devDeps") : ""}`;
  },
  start_build: (s) => {
    const args = listOf(summaryArgs(s, ["repoPath", "args"]).args);
    return args.length > 0 ? t("state.callSentence.buildWith", { args: args.join(" ") }) : t("state.callSentence.build");
  },

  web_search: (s) => {
    // 没给查询词时摘要是其他参数的"参数名=值"
    const query = pathOf(s, ["query", "n", "time", "engine", "region", "tavily", "json"]);
    return query && t("state.callSentence.webSearch", { query });
  },
  web_fetch: (s) => (/^https?:\/\//i.test(s.trim()) ? t("state.callSentence.webFetch", { url: shortUrl(s.trim()) }) : undefined),

  create_reminder: (s) => {
    const a = summaryArgs(s, ["text", ...REMINDER_TIME_KEYS]);
    if (!a.text) return undefined;
    const when = reminderWhen(a);
    return t(when ? "state.callSentence.createReminderAt" : "state.callSentence.createReminder", { text: a.text, when });
  },
  update_reminder: (s) => {
    const a = summaryArgs(s, ["reminderId", "text", ...REMINDER_TIME_KEYS]);
    if (!a.reminderId) return undefined;
    const when = reminderWhen(a);
    const changes = [a.text ? t("state.callSentence.reminderText", { text: a.text }) : undefined, when ? t("state.callSentence.reminderTime", { when }) : undefined].filter(Boolean);
    return changes.length > 0
      ? t("state.callSentence.updateReminderHow", { id: a.reminderId, changes: changes.join(t("state.callSentence.clauseSep")) })
      : t("state.callSentence.updateReminder", { id: a.reminderId });
  },
  cancel_reminder: (s) => {
    const a = summaryArgs(s, ["reminderId"]);
    return a.reminderId && t("state.callSentence.cancelReminder", { id: a.reminderId });
  },
  // 185 号票
  archive_reminder: (s) => {
    const a = summaryArgs(s, ["reminderId"]);
    return a.reminderId && t("state.callSentence.archiveReminder", { id: a.reminderId });
  },

  view_board: () => t("state.callSentence.viewBoard"),
  list_inbox: () => t("state.callSentence.listInbox"),
  show_card: (s) => {
    const ids = listOf(summaryArgs(s, ["cardIds"]).cardIds);
    return ids.length > 0 ? t("state.callSentence.showCard", { count: ids.length, ids: joinList(ids) }) : undefined;
  },

  read_project_records: (s) => {
    const a = summaryArgs(s, ["project", "docs"]);
    if (!a.project) return undefined;
    const docs = listOf(a.docs).map((d) => own(PROJECT_DOC_LABEL, d) ?? d);
    return docs.length > 0 ? t("state.callSentence.readRecordsDocs", { project: a.project, docs: joinList(docs) }) : t("state.callSentence.readRecords", { project: a.project });
  },
  suggest_project: (s) => {
    const a = summaryArgs(s, ["name", "goal"]);
    return a.name && t(a.goal ? "state.callSentence.suggestProjectGoal" : "state.callSentence.suggestProject", { name: a.name, goal: a.goal });
  },

  read_attachment: (s) => {
    const a = summaryArgs(s, ["ref", "offset", "limit"]);
    // 引用是媒体的 sha256：留前 8 位认得出就行
    return a.ref && t("state.callSentence.readAttachment", { ref: a.ref.length > 12 ? a.ref.slice(0, 8) : a.ref });
  },
  send_attachment: (s) => {
    const a = summaryArgs(s, ["path", "name"]);
    const what = a.name || (a.path && shortPath(a.path));
    return what && t("state.callSentence.sendAttachment", { what });
  },
  search_materials: (s) => {
    // 187 号票起多一个 why（为什么查），在它那里断开
    const a = summaryArgs(s, ["query", "why", "limit"]);
    return a.query && t("state.callSentence.searchMaterials", { query: a.query });
  },
  // 166 号票：素材 id 留到前 8 位十六进制认得出就行
  read_material: (s) => {
    const a = summaryArgs(s, ["materialId"]);
    return a.materialId && t("state.callSentence.readMaterial", { id: a.materialId.slice(0, 12) });
  },
  // 86 号票：用户打字时发语音，写口语稿的前几个字（整段在气泡的"转文字"里）
  send_voice: (s) => {
    const a = summaryArgs(s, ["text"]);
    return a.text && t("state.callSentence.sendVoice", { text: cutTo(a.text, SEND_VOICE_HEAD) });
  },
  // 102 号票：维护者给秘书发消息（由秘书在主线里转告用户），写原话的前几个字；115 号票起有一句话总结的写它
  tell_secretary: (s) => {
    const a = summaryArgs(s, ["summary", "text"]);
    const said = a.summary || a.text;
    return said && t("state.callSentence.tellSecretary", { capability: TELL_SECRETARY_CAPABILITY, text: cutTo(said, TELL_SECRETARY_HEAD) });
  },

  propose_quick_action: (s, named) => {
    const a = summaryArgs(s, ["type", "params", "explicit"]);
    return quickActionLine(a.type, objectOf(a.params), named);
  },

  // 82 号票：/workflow、/task（老写法 /流程、/任务）调出来的（项目维护者发起项目内部任务的同名工具同样）
  start_workflow: (s) => {
    const a = summaryArgs(s, ["title", "summary", "projects"]);
    return a.title && t("state.callSentence.startWorkflow", { title: a.title });
  },
  create_task: (s) => {
    const a = summaryArgs(s, ["title", "summary", "projects"]);
    return a.title && t("state.callSentence.createTask", { title: a.title });
  },
  // 75 号票的普通任务：秘书交给后台直接做
  delegate_task: (s) => {
    const a = summaryArgs(s, ["title", "instructions", "projects"]);
    return a.title && t("state.callSentence.delegateTask", { title: a.title });
  },
  suggest_task: (s) => {
    const a = summaryArgs(s, ["title", "why", "projects"]);
    return a.title && t("state.callSentence.suggestTask", { title: a.title });
  },
  ask_questions: (s) => {
    const a = summaryArgs(s, ["taskId", "intro", "questions"]);
    // 问题是 JSON 数组；摘要被截断、解析不了时按"question":"…"找
    const parsed = listOf(a.questions).flatMap((q) => {
      const o = objectOf(q);
      return typeof o?.question === "string" ? [o.question] : [];
    });
    const questions = parsed.length > 0 ? parsed : [...(a.questions ?? "").matchAll(/"question":"([^"]+)"/g)].map((m) => m[1]!);
    if (questions.length === 0) return undefined;
    return questions.length > 1 ? t("state.callSentence.askQuestions", { question: questions[0], total: questions.length }) : t("state.callSentence.askQuestion", { question: questions[0] });
  },
  write_task_brief: (s, named) => {
    const a = summaryArgs(s, ["taskId", "goal", "acceptanceCriteria", "constraints", "projects", "memoryScope"]);
    return a.taskId && t(a.goal ? "state.callSentence.writeBriefGoal" : "state.callSentence.writeBrief", { task: named(a.taskId), goal: a.goal });
  },
};
