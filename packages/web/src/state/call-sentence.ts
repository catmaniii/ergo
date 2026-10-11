// 工具调用说成人话的一句（67 号票，规格第 19 节"会话区照搬 AgentSense"）：照 AgentSense 每个场景的 describe
// （web/src/agent/scenarios/*.ts，"删除照片：…""在蓝鲸购物下单：柔丝家庭装 ×1"）和 semantic.ts 的 describeCall、keyLine。
// 不写"工具名 + 参数摘要"，写一句"读 src/app.ts""把改动提交：修复登录超时"；没有模板的退回"中文名 · 参数值"。
// 用在：工具调用组的要点那一行和组的详情里每一步（57 号票）、单次调用的详情（56 号票）、缩小后每一块的要点层（54、57 号票）。
//
// 用户 2026-10-10 定的：
// - 说法照 AgentSense：动词加对象，不带"了"（"读 src/app.ts"，不是"读了 src/app.ts"）——被拦下、你拒绝了的前面加了 ⛔ ✕，
//   带"了"就把没做的事说成做了；
// - 要点层那一行的前缀照 AgentSense keyLine 的四种：⛔ 被拦下、↩ 拉回（二狗的"按规则退回"）、⏸ 等你批准、✕ 你拒绝了；
//   问过你、出错、按计划引回不加（AgentSense 的当场确认、出错、引回计划都不加）；读了密钥文件的（守护进程不记内容的那种，
//   工具调用 part 的 readsSecretFile）再加 🔒（AgentSense 读了敏感数据的加 🔒）；
// - 和 AgentSense 不一样的两处：句子里超过 40 字的路径只留末尾几级、前面写"…/"（AgentSense 的说法用名字不用路径，不截）；
//   没有模板的，对话层、要点层、详情页三处统一写"中文名 · 参数值"、截到 60 字（AgentSense 三处各不同：工具行是中文名加参数值
//   拼接截 60，要点层是中文名 · 一个主要参数，详情只写中文名），参数摘要里的"参数名="去掉。
//
// 前端拿到的只有工具调用 part 的参数摘要（一行，守护进程截到 160 字，guard-runtime/describe.ts 的 summarizeArgs）：
// bash 是命令原文，文件工具是路径（搜索带上模式："模式 · 路径"），联网搜索是查询词、读网页是网址，别的工具是"参数名=值 参数名=值"
// （不是字符串的值写成 JSON）。模板按工具名查，按这个写法拆出参数（用户 2026-10-10 同意，不改协议）；拆不出要的参数（参数缺失、
// 摘要被截断、彻底删除过）就退回。工具的中文名照守护进程登记的 title 抄一份在这里（AgentSense 也是每个场景自带 toolLabels）；
// MCP 工具（mcp__<MCP 名>__<工具名>）前端不知道中文名，写原名。纯函数。
import { describeWorkdayChange, MEMORY_COMMAND_LABEL, type MessagePart, PURGED_TEXT, type RepeatRule, describeSchedule, repeatSchedule, type WorkdayChange } from "./protocol.ts";
import { bashSentence } from "./shell-sentence.ts";
import { cutTo, FALLBACK_MAX, pathsText, shortPath, shortUrl } from "./sentence-parts.ts";
import { awaitingApproval } from "./timeline.ts";

export { FALLBACK_MAX, PATH_MAX, shortPath, shortUrl } from "./sentence-parts.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/**
 * 工具的中文名：照守护进程登记的 title（guard/tool-registry.ts 的内置、带类型的 bash、联网工具，各模块 defineHostTool 的 title）。
 * 项目维护者的发起任务（tasks/internal-tools.ts）和秘书的同名，中文名按秘书的写
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  // pi 自带的文件工具和通用 bash
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  ls: "列目录",
  grep: "搜索文件内容",
  find: "查找文件",
  bash: "通用 bash",
  // 带类型的特殊 bash 工具（28 号票）
  git_status_diff: "git 状态和差异",
  git_commit: "git 提交",
  git_merge: "git 合并",
  git_push: "git 推送",
  create_remote_repo: "建远端仓库",
  run_tests: "跑测试",
  install_deps: "在工作目录里装依赖",
  start_build: "启动构建",
  // 联网工具（70 号票）
  web_search: "联网搜索",
  web_fetch: "读网页",
  // 秘书的工具
  view_board: "查看板",
  // 守护进程登记的是"列出待我处理"，界面上一律叫"待办"（43 号票）
  list_inbox: "列出待办",
  show_card: "把卡片放进聊天",
  search_materials: "检索素材",
  read_attachment: "读取附件",
  send_attachment: "把文件作为附件发出",
  read_project_records: "读项目档案",
  suggest_project: "建议立项",
  create_reminder: "建简单提醒",
  update_reminder: "改简单提醒",
  cancel_reminder: "取消简单提醒",
  propose_quick_action: "提议快速动作",
  start_workflow: "发起流程",
  create_task: "发起长程任务",
  delegate_task: "交给后台（普通任务）",
  suggest_task: "建议发起任务",
  ask_questions: "提问卡",
  write_task_brief: "写任务书",
  spoken_summary: "口语总结",
  send_voice: "发语音",
  // 维护者的工具
  submit_plan: "提交计划",
  submit_charter: "提交立项书",
  start_stage: "开始阶段",
  complete_stage: "宣布阶段完成",
  report_progress: "报告进展",
  wait_for_user: "转为等我",
  fail_task: "任务失败",
  propose_plan_change: "提交计划变更",
  revise_plan: "自行调整计划",
  mark_infeasible: "标做不了",
  propose_parallel: "提议并行",
  submit_review: "提交评审结论",
  propose_plan: "提交计划",
  report_step: "汇报步骤",
  write_segment_summary: "写这一段的摘要",
  write_progress: "写回进展",
  ask_clarification: "向派单方提问",
  submit_receipt: "交回执",
  dispatch_work_order: "派工单",
  summarize_receipts: "汇总回执",
  answer_work_order: "回答项目维护者",
  forward_to_user: "转问用户",
  fail_job_run: "报告这次运行失败",
  adjust_skills: "增减 skill",
  request_toolkit_change: "申请工具包变更",
};

/** 工具的中文名；没登记的（MCP 工具、以后加的）写原名 */
export function toolLabel(tool: string): string {
  return Object.hasOwn(TOOL_LABELS, tool) ? TOOL_LABELS[tool]! : tool;
}

/** 一次调用说成的那一句；said 是有模板说成了人话的（AgentSense 的 describeCall 有值），否则是退回的"中文名 · 参数值" */
export interface CallSentence {
  readonly text: string;
  readonly said: boolean;
}

/** 一次调用说成人话；没有模板、拆不出要的参数时退回"中文名 · 参数值"（截到 60 字） */
export function callSentence(part: Pick<ToolCallPart, "tool" | "argsSummary">): CallSentence {
  const said = describeCall(part.tool, part.argsSummary);
  return said === undefined ? { text: fallbackLine(part.tool, part.argsSummary), said: false } : { text: said, said: true };
}

/**
 * 要点层那一行（照 AgentSense keyLine）：前缀（⛔ 被拦下、↩ 拉回、⏸ 等你批准、✕ 你拒绝了）、读了密钥文件的 🔒，再是那一句
 */
export function callKeyLine(part: ToolCallPart): string {
  return `${callMark(part)}${part.readsSecretFile ? "🔒 " : ""}${callSentence(part).text}`;
}

/**
 * 要点层的前缀（AgentSense keyLine：拦下 ⛔、拉回 ↩、停下说明进展 ⏸、你拒绝了 ✕）。二狗：被拦下（硬拒绝、判定出错、计划检查拦下、
 * 按处置没执行）⛔；按规则退回（时序规则，对应 AgentSense 的拉回）↩；等你批准 ⏸（57 号票定的）；你拒绝了 ✕。
 * 按计划引回（AgentSense 的引回计划）、问过你（当场确认）、出错都不加（用户 2026-10-10 定，照 AgentSense）
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

/** 有模板就说成人话（AgentSense 的 describeCall）；没有模板、彻底删除过、拆不出要的参数是 undefined */
export function describeCall(tool: string, argsSummary: string): string | undefined {
  if (argsSummary === PURGED_TEXT || !Object.hasOwn(TEMPLATES, tool)) return undefined;
  try {
    return TEMPLATES[tool]!(argsSummary) || undefined;
  } catch {
    // 参数不全、写法不对时退回（AgentSense 同样）
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

/** 一个工具的模板：参数摘要 → 一句话；拆不出要的参数时返回 undefined（退回） */
type Template = (summary: string) => string | undefined;

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

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** 提醒的时间参数（reminders/tools.ts 的 timeParams）写成一句：明天 09:00、周五 18:00、30 分钟后、每天 09:00 */
function reminderWhen(a: Record<string, string>): string | undefined {
  const time = a.time;
  if (a.at) return a.at;
  if (a.inMinutes) return `${a.inMinutes} 分钟后`;
  if (a.repeat) {
    const rule = objectOf(a.repeat) as RepeatRule | undefined;
    const made = rule && time ? repeatSchedule(rule, time) : undefined;
    return made && "schedule" in made ? describeSchedule(made.schedule) : `重复${time ? ` ${time}` : ""}`;
  }
  const day = a.inDays !== undefined ? (["今天", "明天", "后天"][Number(a.inDays)] ?? `${a.inDays} 天后`) : a.weekday !== undefined ? `周${WEEKDAY[Number(a.weekday)] ?? a.weekday}` : a.date;
  if (day && time) return `${day} ${time}`;
  return day ?? time;
}

const REMINDER_TIME_KEYS = ["at", "time", "date", "weekday", "inDays", "inMinutes", "repeat"];

/** 发语音那一句写口语稿的前多少个字（超出的写"…"） */
const SEND_VOICE_HEAD = 20;

/** 项目档案的几份（projects/records-tool.ts 的 DOCS） */
const PROJECT_DOC_LABEL: Readonly<Record<string, string>> = {
  charter: "立项书",
  spec: "规格",
  glossary: "术语表",
  adr: "决策记录",
  progress: "进展",
  manifest: "项目清单",
  scope_records: "范围记录",
};

/** 快速动作（quick-actions/tool.ts）：按动作类型说做什么 */
function quickActionLine(type: string | undefined, params: Record<string, unknown> | undefined): string | undefined {
  if (!type) return undefined;
  const p = params ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  switch (type) {
    case "remember":
      return str("content") ? `记住：${str("content")}` : undefined;
    case "forget":
    case "purge":
    case "no_infer": {
      const n = Array.isArray(p.materialIds) ? p.materialIds.length : undefined;
      return `${MEMORY_COMMAND_LABEL[type]}${n ? ` ${n} 条素材` : "素材"}`;
    }
    case "pause_task":
      return str("task") ? `暂停任务 ${str("task")}` : undefined;
    case "resume_task":
      return str("task") ? `继续任务 ${str("task")}` : undefined;
    case "cancel_task":
      return str("task") ? `取消任务 ${str("task")}` : undefined;
    case "workday_calendar": {
      // 照快速动作自己的规范化（workday/quick-action.ts）拼成改动，再用工作日历的写法说
      const change = str("change");
      const rule = p.rule as Extract<WorkdayChange, { kind: "add_rule" }>["rule"] | undefined;
      const date = str("date");
      let normalized: WorkdayChange | undefined;
      if ((change === "add_rule" || change === "remove_rule") && rule) normalized = { kind: change, rule };
      else if (change === "clear_mark" && date) normalized = { kind: "clear_mark", date };
      else if ((change === "mark_rest" || change === "mark_work") && date) normalized = { kind: "mark", date, mark: change === "mark_work" ? "work" : "rest" };
      return normalized ? `改工作日历：${describeWorkdayChange(normalized)}` : "改工作日历";
    }
    default:
      return `提议快速动作：${type}`;
  }
}

/**
 * 各工具的模板（照 AgentSense describe 的写法：动词加对象，对象是名字、标题的用「」括起来，后面要补充的用"："接）。
 * 用户点名要有的：读、写、改、删、列目录、搜索、通用 bash（按拆出来的命令）、git 提交 / 推送 / 建仓库、联网读取、提醒、日历（快速动作
 * "改工作日历"）、看板、项目档案、附件和素材；70 号票的联网搜索、读网页；82 号票的斜杠命令调出来的发起流程、发起长程任务，
 * 和 agent 读 skill 的 SKILL.md；75 号票的交给后台（普通任务）。二狗没有发消息、发邮件、日历的工具（只有 MCP 来的，退回原样）
 */
const TEMPLATES: Readonly<Record<string, Template>> = {
  read: (s) => {
    const path = pathOf(s, READ_KEYS);
    if (!path) return undefined;
    const skill = skillOf(path);
    return skill ? `读 skill「${skill}」的说明` : `读 ${shortPath(path)}`;
  },
  write: (s) => {
    const path = pathOf(s, WRITE_KEYS);
    return path && `写 ${shortPath(path)}`;
  },
  edit: (s) => {
    const path = pathOf(s, EDIT_KEYS);
    return path && `改 ${shortPath(path)}`;
  },
  ls: (s) => {
    const path = pathOf(s, LS_KEYS);
    return path ? `列出 ${shortPath(path)}` : "列出当前目录";
  },
  grep: (s) => {
    const p = patternOf(s);
    return p && (p.path ? `在 ${shortPath(p.path)} 里搜「${p.pattern}」` : `搜「${p.pattern}」`);
  },
  find: (s) => {
    const p = patternOf(s);
    return p && (p.path ? `在 ${shortPath(p.path)} 里找 ${p.pattern}` : `在当前目录里找 ${p.pattern}`);
  },
  bash: (s) => bashSentence(s),

  git_status_diff: (s) => {
    const a = summaryArgs(s, ["repoPath", "paths"]);
    const paths = listOf(a.paths);
    return paths.length > 0 ? `看 ${pathsText(paths)} 的 git 状态和改动` : "看 git 状态和改动";
  },
  git_commit: (s) => {
    const a = summaryArgs(s, ["repoPath", "message", "paths", "amend"]);
    if (!a.message) return undefined;
    if (a.amend === "true") return `改上一次提交：${a.message}`;
    const paths = listOf(a.paths);
    return paths.length > 0 ? `把 ${pathsText(paths)} 提交：${a.message}` : `把改动提交：${a.message}`;
  },
  git_merge: (s) => {
    const a = summaryArgs(s, ["repoPath", "branch"]);
    return a.branch && `合并分支 ${a.branch}`;
  },
  git_push: (s) => {
    const a = summaryArgs(s, ["repoPath", "remote", "branch", "force", "delete", "headCommit"]);
    if (!a.remote) return undefined;
    if (a.delete === "true") return a.branch && `删除 ${a.remote} 上的分支 ${a.branch}`;
    return `${a.force === "true" ? "强推" : "推送"}${a.branch ? ` ${a.branch} ` : "当前分支"}到 ${a.remote}`;
  },
  create_remote_repo: (s) => {
    const a = summaryArgs(s, ["repoPath", "name", "visibility", "description"]);
    if (!a.name) return undefined;
    const visibility = a.visibility === "public" ? "（公开）" : a.visibility === "internal" ? "（内部）" : "";
    return `建远端仓库 ${a.name}${visibility}${a.description ? `：${a.description}` : ""}`;
  },
  run_tests: (s) => {
    const args = listOf(summaryArgs(s, ["repoPath", "args"]).args);
    return args.length > 0 ? `跑测试（${args.join(" ")}）` : "跑测试";
  },
  install_deps: (s) => {
    const a = summaryArgs(s, ["repoPath", "packages", "dev"]);
    const packages = listOf(a.packages);
    return `装依赖${packages.length > 0 ? ` ${packages.join("、")}` : ""}${a.dev === "true" ? "（开发依赖）" : ""}`;
  },
  start_build: (s) => {
    const args = listOf(summaryArgs(s, ["repoPath", "args"]).args);
    return args.length > 0 ? `构建（${args.join(" ")}）` : "构建";
  },

  web_search: (s) => {
    // 没给查询词时摘要是其他参数的"参数名=值"
    const query = pathOf(s, ["query", "n", "time", "engine", "region", "tavily", "json"]);
    return query && `联网搜「${query}」`;
  },
  web_fetch: (s) => (/^https?:\/\//i.test(s.trim()) ? `读网页 ${shortUrl(s.trim())}` : undefined),

  create_reminder: (s) => {
    const a = summaryArgs(s, ["text", ...REMINDER_TIME_KEYS]);
    if (!a.text) return undefined;
    const when = reminderWhen(a);
    return `建提醒「${a.text}」${when ? `：${when}` : ""}`;
  },
  update_reminder: (s) => {
    const a = summaryArgs(s, ["reminderId", "text", ...REMINDER_TIME_KEYS]);
    if (!a.reminderId) return undefined;
    const when = reminderWhen(a);
    const changes = [a.text ? `内容改成「${a.text}」` : undefined, when ? `时间改到 ${when}` : undefined].filter(Boolean);
    return `改提醒 ${a.reminderId}${changes.length > 0 ? `：${changes.join("，")}` : ""}`;
  },
  cancel_reminder: (s) => {
    const a = summaryArgs(s, ["reminderId"]);
    return a.reminderId && `取消提醒 ${a.reminderId}`;
  },

  view_board: () => "查看板",
  list_inbox: () => "看待办",
  show_card: (s) => {
    const ids = listOf(summaryArgs(s, ["cardIds"]).cardIds);
    return ids.length > 0 ? `把卡片 ${ids.join("、")} 放进聊天` : undefined;
  },

  read_project_records: (s) => {
    const a = summaryArgs(s, ["project", "docs"]);
    if (!a.project) return undefined;
    const docs = listOf(a.docs).map((d) => PROJECT_DOC_LABEL[d] ?? d);
    return `读项目档案「${a.project}」${docs.length > 0 ? `：${docs.join("、")}` : ""}`;
  },
  suggest_project: (s) => {
    const a = summaryArgs(s, ["name", "goal"]);
    return a.name && `建议立项「${a.name}」${a.goal ? `：${a.goal}` : ""}`;
  },

  read_attachment: (s) => {
    const a = summaryArgs(s, ["ref", "offset", "limit"]);
    // 引用是媒体的 sha256：留前 8 位认得出就行
    return a.ref && `读附件 ${a.ref.length > 12 ? a.ref.slice(0, 8) : a.ref}`;
  },
  send_attachment: (s) => {
    const a = summaryArgs(s, ["path", "name"]);
    const what = a.name || (a.path && shortPath(a.path));
    return what && `把 ${what} 作为附件发出`;
  },
  search_materials: (s) => {
    const a = summaryArgs(s, ["query", "limit"]);
    return a.query && `检索素材「${a.query}」`;
  },
  // 86 号票：用户打字时发语音，写口语稿的前几个字（整段在气泡的"转文字"里）
  send_voice: (s) => {
    const a = summaryArgs(s, ["text"]);
    return a.text && `发语音：${cutTo(a.text, SEND_VOICE_HEAD)}`;
  },

  propose_quick_action: (s) => {
    const a = summaryArgs(s, ["type", "params", "explicit"]);
    return quickActionLine(a.type, objectOf(a.params));
  },

  // 82 号票：/流程、/任务 调出来的（项目维护者发起项目内部任务的同名工具同样）
  start_workflow: (s) => {
    const a = summaryArgs(s, ["title", "summary", "projects"]);
    return a.title && `发起流程「${a.title}」`;
  },
  create_task: (s) => {
    const a = summaryArgs(s, ["title", "summary", "projects"]);
    return a.title && `发起长程任务「${a.title}」`;
  },
  // 75 号票的普通任务：秘书交给后台直接做
  delegate_task: (s) => {
    const a = summaryArgs(s, ["title", "instructions", "projects"]);
    return a.title && `交给后台做「${a.title}」`;
  },
  suggest_task: (s) => {
    const a = summaryArgs(s, ["title", "why", "projects"]);
    return a.title && `建议发起任务「${a.title}」`;
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
    return `向你提问：${questions[0]}${questions.length > 1 ? ` 等 ${questions.length} 个问题` : ""}`;
  },
  write_task_brief: (s) => {
    const a = summaryArgs(s, ["taskId", "goal", "acceptanceCriteria", "constraints", "projects", "memoryScope"]);
    return a.taskId && `写任务书 ${a.taskId}${a.goal ? `：${a.goal}` : ""}`;
  },
};
