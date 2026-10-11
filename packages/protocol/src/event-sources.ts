// 事件来源登记表（77 号票，ADR 0025）：事件触发的任务、简单提醒靠事件推送触发，事件从哪来叫"事件来源"。
// 每个来源登记：名字、能产生哪些事件、事件带哪些字段（流程步骤的参数可以写成 {{事件.字段名}} 的占位）、可以按什么过滤。
// 以后接邮件、webhook 这些，只在 EVENT_SOURCES 里加一项（连同它自己"在等什么事件"的说法 describe），守护进程 event-sources/ 里再加它的实现；
// 对话框、守护进程的检查、看板卡上的说法、交给 agent 的结构化输入都从这张表推出。第一批两个来源：
// - 二狗内部事件（ergou）：任务或流程完成、失败、转"等我"；项目状态变化；定时、事件触发的任务的一次运行失败。可以按任务、项目过滤；
// - 本机文件夹变化（folder）：指定文件夹（可含子文件夹）里新增、修改、删除文件，可以按文件名模式过滤（比如 *.pdf）。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 event-source-schema.ts。

/** 二狗内部事件 */
export const ERGOU_EVENT_SOURCE = "ergou";
/** 本机文件夹变化 */
export const FOLDER_EVENT_SOURCE = "folder";

/** 事件带的一个字段：键（事件值里的名字）、中文名（占位里写的、交给 agent 的结构化输入里的键） */
export interface EventFieldDescriptor {
  key: string;
  label: string;
  hint: string;
}

/** 来源能产生的一种事件：编号、中文名、带哪些字段（字段的键） */
export interface EventKindDescriptor {
  id: string;
  label: string;
  hint: string;
  fields: readonly string[];
}

/**
 * 一个过滤条件：键、中文名、怎么填——选一个任务、选一个项目、填一个文件夹、填文件名模式、开关。
 * 必填的不写建不了
 */
export type EventFilterKind = "task" | "project" | "folder" | "pattern" | "boolean";

export interface EventFilterDescriptor {
  key: string;
  label: string;
  kind: EventFilterKind;
  required?: true;
  hint: string;
  placeholder?: string;
}

/** 事件触发方式里要看的那几样（不引用 schema；schema 是 event-source-schema.ts 的 EventTrigger） */
export interface EventTriggerShape {
  kind: "event";
  source: string;
  events: readonly string[];
  filter?: Readonly<Record<string, string | boolean>> | undefined;
}

/** 说法里要用的名字：任务、项目编号换成名字（认不出的照写编号） */
export interface EventNames {
  task?: (taskId: string) => string | undefined;
  project?: (projectId: string) => string | undefined;
}

/** 登记表里的一个事件来源 */
export interface EventSourceDescriptor {
  id: string;
  label: string;
  hint: string;
  events: readonly EventKindDescriptor[];
  fields: readonly EventFieldDescriptor[];
  filters: readonly EventFilterDescriptor[];
  /**
   * 在等这个来源的什么事件（describeEventTrigger 交给它）：kinds 是选的事件的中文名（按选的先后），names 把编号换成名字。
   * 每个来源自己说，加来源不用改别处
   */
  describe(trigger: EventTriggerShape, kinds: readonly string[], names: EventNames): string;
}

/** 二狗内部事件的种类 */
export const ERGOU_EVENTS = ["task_done", "task_failed", "task_waiting", "project_state", "run_failed"] as const;
export type ErgouEvent = (typeof ERGOU_EVENTS)[number];

/** 本机文件夹变化的种类 */
export const FOLDER_EVENTS = ["added", "changed", "removed"] as const;
export type FolderEvent = (typeof FOLDER_EVENTS)[number];

const ERGOU_SOURCE: EventSourceDescriptor = {
  id: ERGOU_EVENT_SOURCE,
  label: "二狗内部事件",
  hint: "二狗自己的事：任务或流程完成、失败、转等我，项目状态变化，定时或事件触发的任务的一次运行失败",
  events: [
    { id: "task_done", label: "任务完成", hint: "一个任务或流程做完了（反复运行的任务一次运行做完不算）", fields: ["taskId", "taskTitle", "taskKind", "projectId", "projectName"] },
    { id: "task_failed", label: "任务失败", hint: "一个任务或流程失败了", fields: ["taskId", "taskTitle", "taskKind", "reason", "projectId", "projectName"] },
    { id: "task_waiting", label: "任务转等我", hint: "一个任务或流程停下来等你处理（卡住求助、等你验收……）", fields: ["taskId", "taskTitle", "taskKind", "reason", "projectId", "projectName"] },
    { id: "project_state", label: "项目状态变化", hint: "项目从筹备中、建设中、使用中、已停用之间变了", fields: ["projectId", "projectName", "from", "to"] },
    { id: "run_failed", label: "一次运行失败", hint: "定时或事件触发的任务有一次运行失败了", fields: ["taskId", "taskTitle", "runId", "reason", "projectId", "projectName"] },
  ],
  fields: [
    { key: "taskId", label: "任务编号", hint: "比如 t-3" },
    { key: "taskTitle", label: "任务标题", hint: "任务的标题" },
    { key: "taskKind", label: "做法", hint: "普通任务、流程或长程任务" },
    { key: "reason", label: "原因", hint: "失败、等你的原因" },
    { key: "runId", label: "运行号", hint: "比如 j-2-r5" },
    { key: "projectId", label: "项目编号", hint: "比如 p-1（不属于项目的没有）" },
    { key: "projectName", label: "项目名", hint: "项目的名字（不属于项目的没有）" },
    { key: "from", label: "原来的状态", hint: "项目原来的状态" },
    { key: "to", label: "现在的状态", hint: "项目现在的状态" },
  ],
  filters: [
    { key: "taskId", label: "哪个任务", kind: "task", hint: "只要这个任务的（不选是任何任务）" },
    { key: "projectId", label: "哪个项目", kind: "project", hint: "只要这个项目的（不选是任何项目）" },
  ],
  // "二狗内部：任务 t-3「整理发票」的任务完成、任务失败"
  describe(trigger, kinds, names) {
    const taskId = filterValue(trigger, "taskId");
    const projectId = filterValue(trigger, "projectId");
    const scope = [
      typeof taskId === "string" ? `任务 ${taskId}${names.task?.(taskId) ? `「${names.task(taskId)}」` : ""}` : undefined,
      typeof projectId === "string" ? `项目${names.project?.(projectId) ? `「${names.project(projectId)}」` : ` ${projectId}`}` : undefined,
    ].filter((x) => x !== undefined);
    return `二狗内部：${scope.length > 0 ? `${scope.join("、")}的` : ""}${kinds.join("、")}`;
  },
};

const FOLDER_SOURCE: EventSourceDescriptor = {
  id: FOLDER_EVENT_SOURCE,
  label: "本机文件夹变化",
  hint: "本机一个文件夹里新增、修改、删除文件。同一个文件短时间内连续变化的合成一次；守护进程停着时的变化，开机后比对一次补上",
  events: [
    { id: "added", label: "新增文件", hint: "文件夹里多了一个文件（放进来、建出来、移进来）", fields: ["path", "name", "relativePath", "folder", "change", "size", "modifiedAt"] },
    { id: "changed", label: "修改文件", hint: "文件夹里一个文件的内容变了", fields: ["path", "name", "relativePath", "folder", "change", "size", "modifiedAt"] },
    { id: "removed", label: "删除文件", hint: "文件夹里一个文件没了（删掉、移走）", fields: ["path", "name", "relativePath", "folder", "change"] },
  ],
  fields: [
    { key: "path", label: "文件路径", hint: "文件的完整路径" },
    { key: "name", label: "文件名", hint: "文件名（带扩展名）" },
    { key: "relativePath", label: "相对路径", hint: "相对于监视的文件夹的路径" },
    { key: "folder", label: "文件夹", hint: "监视的文件夹" },
    { key: "change", label: "变化", hint: "新增、修改或删除" },
    { key: "size", label: "大小", hint: "文件大小（字节）" },
    { key: "modifiedAt", label: "修改时间", hint: "文件最后修改的时间" },
  ],
  filters: [
    { key: "path", label: "文件夹", kind: "folder", required: true, hint: "要监视的文件夹（完整路径）；二狗的数据目录、密钥区、受保护区域不能监视", placeholder: "比如 D:\\收件箱" },
    { key: "recursive", label: "含子文件夹", kind: "boolean", hint: "子文件夹里的变化也算" },
    { key: "pattern", label: "文件名模式", kind: "pattern", hint: "只要名字对得上的文件（* 是任意几个字，? 是一个字；几个模式用分号隔开）；不写是所有文件", placeholder: "比如 *.pdf" },
  ],
  // "本机文件夹 D:\收件箱（含子文件夹）里新增、修改 *.pdf 文件"
  describe(trigger, kinds) {
    const folder = filterValue(trigger, "path");
    const deep = filterValue(trigger, "recursive") === true ? "（含子文件夹）" : "";
    const pattern = filterValue(trigger, "pattern");
    const what = kinds.map((k) => k.replace(/文件$/, "")).join("、");
    return `本机文件夹 ${typeof folder === "string" ? folder : "（没写）"}${deep}里${what}${typeof pattern === "string" ? ` ${pattern} ` : ""}文件`;
  },
};

/** 事件来源登记表：以后接别的来源只在这里加一项 */
export const EVENT_SOURCES: readonly EventSourceDescriptor[] = [ERGOU_SOURCE, FOLDER_SOURCE];

export function eventSourceOf(id: string): EventSourceDescriptor | undefined {
  return EVENT_SOURCES.find((s) => s.id === id);
}

export function eventKindOf(source: EventSourceDescriptor | undefined, id: string): EventKindDescriptor | undefined {
  return source?.events.find((e) => e.id === id);
}

/** 一个过滤条件的值（字符串的去掉首尾空白；空的当没写） */
export function filterValue(trigger: Pick<EventTriggerShape, "filter">, key: string): string | boolean | undefined {
  const v = trigger.filter?.[key];
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim();
  return v;
}

/** 选的事件里一共有哪些字段（按登记表的先后） */
export function triggerFields(trigger: Pick<EventTriggerShape, "source" | "events">): EventFieldDescriptor[] {
  const source = eventSourceOf(trigger.source);
  if (!source) return [];
  const keys = new Set(trigger.events.flatMap((id) => eventKindOf(source, id)?.fields ?? []));
  return source.fields.filter((f) => keys.has(f.key));
}

/**
 * 事件触发方式写得对不对（不对的原因；文件夹在不在、能不能监视要守护进程现查）：来源在登记表里、至少选一种事件、
 * 事件是这个来源的、过滤条件的键是这个来源的、类型对、必填的写了
 */
export function eventTriggerProblems(trigger: EventTriggerShape): string[] {
  const source = eventSourceOf(trigger.source);
  if (!source) return [`没有这个事件来源：${trigger.source}（有的：${EVENT_SOURCES.map((s) => `${s.id}「${s.label}」`).join("、")}）`];
  const problems: string[] = [];
  if (trigger.events.length === 0) problems.push(`至少选一种事件（${source.label}能产生：${source.events.map((e) => e.label).join("、")}）`);
  for (const id of trigger.events) if (!eventKindOf(source, id)) problems.push(`${source.label}没有这种事件：${id}`);
  for (const [key, value] of Object.entries(trigger.filter ?? {})) {
    const filter = source.filters.find((f) => f.key === key);
    if (!filter) {
      problems.push(`${source.label}不能按 ${key} 过滤（能按：${source.filters.map((f) => f.label).join("、")}）`);
      continue;
    }
    if ((filter.kind === "boolean") !== (typeof value === "boolean")) problems.push(`过滤条件「${filter.label}」${filter.kind === "boolean" ? "是开关（true 或 false）" : "要写文字"}`);
  }
  for (const f of source.filters) if (f.required && filterValue(trigger, f.key) === undefined) problems.push(`要写过滤条件「${f.label}」`);
  return problems;
}

// ───────────────────────── 文件名模式 ─────────────────────────

/** 文件名模式拆成几个（分号、逗号隔开） */
export function namePatterns(pattern: string | undefined): string[] {
  return (pattern ?? "")
    .split(/[;,；，]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 文件名对不对得上模式（* 任意几个字、? 一个字，不分大小写）；没写模式的都对得上 */
export function fileNameMatches(name: string, pattern: string | undefined): boolean {
  const list = namePatterns(pattern);
  if (list.length === 0) return true;
  return list.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(name));
}

// ───────────────────────── 说法 ─────────────────────────

const labelsOf = (source: EventSourceDescriptor | undefined, events: readonly string[]) => events.map((id) => eventKindOf(source, id)?.label ?? id);

/**
 * 在等什么事件（对话框、看板卡、任务详情、秘书的看板、交给 agent 的通知都用这一句）：交给登记表里这个来源自己的 describe——
 * "本机文件夹 D:\收件箱（含子文件夹）里新增、修改 *.pdf 文件"、"二狗内部：任务 t-3「…」任务完成、任务失败"
 */
export function describeEventTrigger(trigger: EventTriggerShape, names: EventNames = {}): string {
  const source = eventSourceOf(trigger.source);
  const kinds = labelsOf(source, trigger.events);
  return source ? source.describe(trigger, kinds, names) : `${trigger.source}：${kinds.join("、")}`;
}

// ───────────────────────── 流程步骤里的占位 ─────────────────────────

/** 占位的写法：{{事件.文件路径}}（字段的中文名，也认键：{{事件.path}}） */
export const eventPlaceholder = (name: string) => `{{事件.${name}}}`;

/** 认占位：{{事件.X}}（X 前后可以有空白） */
const PLACEHOLDER = /\{\{\s*事件\.([^{}\s]+?)\s*\}\}/g;

/** 一个值（字符串、数组、对象，一层层找）里写了哪些占位（名字，按出现的先后、不重复） */
export function eventPlaceholdersIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER)) if (!out.includes(m[1]!)) out.push(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

export const hasEventPlaceholder = (value: unknown): boolean => eventPlaceholdersIn(value).length > 0;

/** 占位里的名字对上字段（中文名或键） */
export function eventFieldNamed(fields: readonly EventFieldDescriptor[], name: string): EventFieldDescriptor | undefined {
  return fields.find((f) => f.label === name || f.key === name);
}

/** 一个占位（{{事件.X}}，X 前后可以有空白）：一处一处找，名字在第一个分组 */
export const EVENT_PLACEHOLDER_PATTERN = PLACEHOLDER;

/** 一个事件值写成文字（数字、开关照写；别的写成 JSON） */
export const eventValueText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

/**
 * 代入事件的值（流程每次运行执行前，59 号票的核对按代入后的值比）：字符串里的每个占位换成这次事件里那个字段的值；整个字符串就是一个占位的，
 * 换成值本身（数字照样是数字）。只换一遍：代入的值里就算写着 {{事件.…}} 也原样留着，不会再被代入。
 * 这次事件里没有的字段，占位原样留着（执行时照样核对，对不上会被拦下）。
 * 通用 bash 的命令不用它：值不拼进命令，命令里换成引用环境变量（守护进程 tasks/workflow-events.ts 的 shellCommandWithVars）
 */
export function substituteEventValues(value: unknown, valueOf: (name: string) => unknown): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*事件\.([^{}\s]+?)\s*\}\}$/.exec(value);
    if (whole) {
      const v = valueOf(whole[1]!);
      return v === undefined ? value : v;
    }
    return value.replace(PLACEHOLDER, (m: string, name: string) => {
      const v = valueOf(name);
      return v === undefined ? m : eventValueText(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEventValues(v, valueOf));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEventValues(v, valueOf)]));
  return value;
}

/**
 * 一次事件的值按字段名取（交给 substituteEventValues）：占位里写中文名或键都认。fields 是这个来源登记的字段
 */
export function eventValueOf(data: Readonly<Record<string, unknown>> | undefined, fields: readonly EventFieldDescriptor[]): (name: string) => unknown {
  return (name) => {
    const field = eventFieldNamed(fields, name);
    return field ? data?.[field.key] : undefined;
  };
}

/** 一批里多个事件时，第 pass 个事件那一遍的步骤编号：s1 → s1.e2（守护进程代入时、Web 显示这次运行的步骤时同一个写法） */
export const eventPassStepId = (stepId: string, pass: number): string => `${stepId}.e${pass}`;

/** 步骤编号是哪一步的第几遍（s1.e2 → s1、2）；不是分遍的编号是 undefined */
export function eventPassOf(stepId: string): { stepId: string; pass: number } | undefined {
  const m = /^(.+)\.e(\d+)$/.exec(stepId);
  return m ? { stepId: m[1]!, pass: Number(m[2]) } : undefined;
}

/** 一次事件交给 agent 的结构化样子：来源、事件、时间，加上每个字段（键是字段的中文名，和占位里写的一样） */
export function eventRecord(event: { source: string; event?: string | undefined; at: string; data?: Readonly<Record<string, unknown>> | undefined }): Record<string, unknown> {
  const source = eventSourceOf(event.source);
  const kind = event.event === undefined ? undefined : eventKindOf(source, event.event);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (value === undefined) continue;
    values[source?.fields.find((f) => f.key === key)?.label ?? key] = value;
  }
  return { 来源: source?.label ?? event.source, ...(kind ? { 事件: kind.label } : {}), 时间: event.at, ...values };
}
