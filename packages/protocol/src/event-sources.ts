// 事件来源登记表（77 号票，ADR 0025）：事件触发的任务、简单提醒靠事件推送触发，事件从哪来叫"事件来源"。
// 每个来源登记：名字、能产生哪些事件、事件带哪些字段（流程步骤的参数可以写成 {{事件.字段名}} 的占位）、可以按什么过滤。
// 以后接邮件、webhook 这些，只在 EVENT_SOURCES 里加一项（连同它自己"在等什么事件"的说法 describe），守护进程 event-sources/ 里再加它的实现；
// 对话框、守护进程的检查、看板卡上的说法、交给 agent 的结构化输入都从这张表推出。第一批两个来源：
// - 二狗内部事件（ergo）：任务或流程完成、失败、转"等我"；项目状态变化；定时、事件触发的任务的一次运行失败。可以按任务、项目过滤；
// - 本机文件夹变化（folder）：指定文件夹（可含子文件夹）里新增、修改、删除文件，可以按文件名模式过滤（比如 *.pdf）。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 event-source-schema.ts。
// 172 号票：来源、事件、过滤条件的名字和说明跟着当前语言（取值时现查）；字段的中文名是占位里写的名字（{{事件.文件路径}}），
// 也是交给 agent 的结构化输入里的键，不跟着语言变。
import { t, tTable } from "./i18n/runtime.ts";
import { isNameOrOld } from "./old-names.ts";

/** 二狗内部事件 */
export const ERGO_EVENT_SOURCE = "ergo";
/** 本机文件夹变化 */
export const FOLDER_EVENT_SOURCE = "folder";

/** 事件带的一个字段：键（事件值里的名字）、中文名（占位里写的、交给 agent 的结构化输入里的键，不跟着语言变）、说明 */
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
export const ERGO_EVENTS = ["task_done", "task_failed", "task_waiting", "project_state", "run_failed"] as const;
export type ErgoEvent = (typeof ERGO_EVENTS)[number];

/** 本机文件夹变化的种类 */
export const FOLDER_EVENTS = ["added", "changed", "removed"] as const;
export type FolderEvent = (typeof FOLDER_EVENTS)[number];

/** 登记表里的一项加上说法：texts（tTable）里的名字、说明取值时按当前语言现查（172 号票） */
function withTexts<T extends object, K extends string>(fixed: T, texts: Readonly<Record<K, string>>): T & Readonly<Record<K, string>> {
  return Object.defineProperties({ ...fixed }, Object.getOwnPropertyDescriptors(texts)) as T & Readonly<Record<K, string>>;
}

/** 几样东西连成一串的分隔（"、" / ", "） */
const listSep = () => t("protocol.common.listSep");

const ERGO_SOURCE: EventSourceDescriptor = withTexts(
  {
    id: ERGO_EVENT_SOURCE,
    events: [
      withTexts(
        { id: "task_done", fields: ["taskId", "taskTitle", "taskKind", "projectId", "projectName"] },
        tTable({ label: "protocol.eventSources.ergo.taskDone", hint: "protocol.eventSources.ergo.taskDoneHint" }),
      ),
      withTexts(
        { id: "task_failed", fields: ["taskId", "taskTitle", "taskKind", "reason", "projectId", "projectName"] },
        tTable({ label: "protocol.eventSources.ergo.taskFailed", hint: "protocol.eventSources.ergo.taskFailedHint" }),
      ),
      withTexts(
        { id: "task_waiting", fields: ["taskId", "taskTitle", "taskKind", "reason", "projectId", "projectName"] },
        tTable({ label: "protocol.eventSources.ergo.taskWaiting", hint: "protocol.eventSources.ergo.taskWaitingHint" }),
      ),
      withTexts(
        { id: "project_state", fields: ["projectId", "projectName", "from", "to"] },
        tTable({ label: "protocol.eventSources.ergo.projectState", hint: "protocol.eventSources.ergo.projectStateHint" }),
      ),
      withTexts(
        { id: "run_failed", fields: ["taskId", "taskTitle", "runId", "reason", "projectId", "projectName"] },
        tTable({ label: "protocol.eventSources.ergo.runFailed", hint: "protocol.eventSources.ergo.runFailedHint" }),
      ),
    ],
    // 字段的中文名是占位里写的名字，不跟着语言变
    // @i18n-ignore-start data：占位里写的字段名
    fields: [
      withTexts({ key: "taskId", label: "任务编号" }, tTable({ hint: "protocol.eventSources.ergo.field.taskId" })),
      withTexts({ key: "taskTitle", label: "任务标题" }, tTable({ hint: "protocol.eventSources.ergo.field.taskTitle" })),
      withTexts({ key: "taskKind", label: "做法" }, tTable({ hint: "protocol.eventSources.ergo.field.taskKind" })),
      withTexts({ key: "reason", label: "原因" }, tTable({ hint: "protocol.eventSources.ergo.field.reason" })),
      withTexts({ key: "runId", label: "运行号" }, tTable({ hint: "protocol.eventSources.ergo.field.runId" })),
      withTexts({ key: "projectId", label: "项目编号" }, tTable({ hint: "protocol.eventSources.ergo.field.projectId" })),
      withTexts({ key: "projectName", label: "项目名" }, tTable({ hint: "protocol.eventSources.ergo.field.projectName" })),
      withTexts({ key: "from", label: "原来的状态" }, tTable({ hint: "protocol.eventSources.ergo.field.from" })),
      withTexts({ key: "to", label: "现在的状态" }, tTable({ hint: "protocol.eventSources.ergo.field.to" })),
    ],
    // @i18n-ignore-end
    filters: [
      withTexts({ key: "taskId", kind: "task" as const }, tTable({ label: "protocol.eventSources.ergo.filter.task", hint: "protocol.eventSources.ergo.filter.taskHint" })),
      withTexts({ key: "projectId", kind: "project" as const }, tTable({ label: "protocol.eventSources.ergo.filter.project", hint: "protocol.eventSources.ergo.filter.projectHint" })),
    ],
    // "二狗内部：任务 t-3「整理发票」的任务完成、任务失败"
    describe(trigger: EventTriggerShape, kinds: readonly string[], names: EventNames) {
      const taskId = filterValue(trigger, "taskId");
      const projectId = filterValue(trigger, "projectId");
      const scope = [
        typeof taskId === "string"
          ? names.task?.(taskId)
            ? t("protocol.eventSources.ergo.scope.taskNamed", { id: taskId, name: names.task(taskId) })
            : t("protocol.eventSources.ergo.scope.task", { id: taskId })
          : undefined,
        typeof projectId === "string"
          ? names.project?.(projectId)
            ? t("protocol.eventSources.ergo.scope.projectNamed", { name: names.project(projectId) })
            : t("protocol.eventSources.ergo.scope.project", { id: projectId })
          : undefined,
      ].filter((x) => x !== undefined);
      const what = kinds.join(listSep());
      return scope.length > 0
        ? t("protocol.eventSources.ergo.describeScoped", { scope: scope.join(listSep()), what })
        : t("protocol.eventSources.ergo.describe", { what });
    },
  },
  tTable({ label: "protocol.eventSources.ergo.label", hint: "protocol.eventSources.ergo.hint" }),
);

/** 文件夹的几种变化在"在等什么事件"那句里的短说法（"新增、修改"） */
const FOLDER_EVENT_SHORT: Readonly<Record<FolderEvent, string>> = tTable({
  added: "protocol.eventSources.folder.short.added",
  changed: "protocol.eventSources.folder.short.changed",
  removed: "protocol.eventSources.folder.short.removed",
});

const FOLDER_SOURCE: EventSourceDescriptor = withTexts(
  {
    id: FOLDER_EVENT_SOURCE,
    events: [
      withTexts(
        { id: "added", fields: ["path", "name", "relativePath", "folder", "change", "size", "modifiedAt"] },
        tTable({ label: "protocol.eventSources.folder.added", hint: "protocol.eventSources.folder.addedHint" }),
      ),
      withTexts(
        { id: "changed", fields: ["path", "name", "relativePath", "folder", "change", "size", "modifiedAt"] },
        tTable({ label: "protocol.eventSources.folder.changed", hint: "protocol.eventSources.folder.changedHint" }),
      ),
      withTexts(
        { id: "removed", fields: ["path", "name", "relativePath", "folder", "change"] },
        tTable({ label: "protocol.eventSources.folder.removed", hint: "protocol.eventSources.folder.removedHint" }),
      ),
    ],
    // @i18n-ignore-start data：占位里写的字段名
    fields: [
      withTexts({ key: "path", label: "文件路径" }, tTable({ hint: "protocol.eventSources.folder.field.path" })),
      withTexts({ key: "name", label: "文件名" }, tTable({ hint: "protocol.eventSources.folder.field.name" })),
      withTexts({ key: "relativePath", label: "相对路径" }, tTable({ hint: "protocol.eventSources.folder.field.relativePath" })),
      withTexts({ key: "folder", label: "文件夹" }, tTable({ hint: "protocol.eventSources.folder.field.folder" })),
      withTexts({ key: "change", label: "变化" }, tTable({ hint: "protocol.eventSources.folder.field.change" })),
      withTexts({ key: "size", label: "大小" }, tTable({ hint: "protocol.eventSources.folder.field.size" })),
      withTexts({ key: "modifiedAt", label: "修改时间" }, tTable({ hint: "protocol.eventSources.folder.field.modifiedAt" })),
    ],
    // @i18n-ignore-end
    filters: [
      withTexts(
        { key: "path", kind: "folder" as const, required: true as const },
        tTable({ label: "protocol.eventSources.folder.filter.path", hint: "protocol.eventSources.folder.filter.pathHint", placeholder: "protocol.eventSources.folder.filter.pathPlaceholder" }),
      ),
      withTexts({ key: "recursive", kind: "boolean" as const }, tTable({ label: "protocol.eventSources.folder.filter.recursive", hint: "protocol.eventSources.folder.filter.recursiveHint" })),
      withTexts(
        { key: "pattern", kind: "pattern" as const },
        tTable({ label: "protocol.eventSources.folder.filter.pattern", hint: "protocol.eventSources.folder.filter.patternHint", placeholder: "protocol.eventSources.folder.filter.patternPlaceholder" }),
      ),
    ],
    // "本机文件夹 D:\收件箱（含子文件夹）里新增、修改 *.pdf 文件"
    describe(trigger: EventTriggerShape, kinds: readonly string[]) {
      const folder = filterValue(trigger, "path");
      const deep = filterValue(trigger, "recursive") === true ? t("protocol.eventSources.folder.deep") : "";
      const pattern = filterValue(trigger, "pattern");
      const what = trigger.events.map((id, i) => (Object.hasOwn(FOLDER_EVENT_SHORT, id) ? FOLDER_EVENT_SHORT[id as FolderEvent] : (kinds[i] ?? id))).join(listSep());
      return t("protocol.eventSources.folder.describe", {
        folder: typeof folder === "string" ? folder : t("protocol.eventSources.folder.noFolder"),
        deep,
        what,
        pattern: typeof pattern === "string" ? t("protocol.eventSources.folder.pattern", { pattern }) : "",
      });
    },
  },
  tTable({ label: "protocol.eventSources.folder.label", hint: "protocol.eventSources.folder.hint" }),
);

/** 事件来源登记表：以后接别的来源只在这里加一项 */
export const EVENT_SOURCES: readonly EventSourceDescriptor[] = [ERGO_SOURCE, FOLDER_SOURCE];

/** 登记表里的来源（312 号票：二狗内部事件的来源编号以前是 ergou，存着的事件触发方式里写的旧编号照样认） */
export function eventSourceOf(id: string): EventSourceDescriptor | undefined {
  return EVENT_SOURCES.find((s) => isNameOrOld(id, s.id));
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
  if (!source) {
    const known = EVENT_SOURCES.map((s) => t("protocol.eventSources.problem.knownSource", { id: s.id, label: s.label })).join(listSep());
    return [t("protocol.eventSources.problem.noSource", { source: trigger.source, known })];
  }
  const problems: string[] = [];
  if (trigger.events.length === 0) {
    problems.push(t("protocol.eventSources.problem.noEvents", { source: source.label, events: source.events.map((e) => e.label).join(listSep()) }));
  }
  for (const id of trigger.events) if (!eventKindOf(source, id)) problems.push(t("protocol.eventSources.problem.unknownEvent", { source: source.label, id }));
  for (const [key, value] of Object.entries(trigger.filter ?? {})) {
    const filter = source.filters.find((f) => f.key === key);
    if (!filter) {
      problems.push(t("protocol.eventSources.problem.unknownFilter", { source: source.label, key, filters: source.filters.map((f) => f.label).join(listSep()) }));
      continue;
    }
    if ((filter.kind === "boolean") !== (typeof value === "boolean")) {
      problems.push(t(filter.kind === "boolean" ? "protocol.eventSources.problem.filterBoolean" : "protocol.eventSources.problem.filterText", { label: filter.label }));
    }
  }
  for (const f of source.filters) if (f.required && filterValue(trigger, f.key) === undefined) problems.push(t("protocol.eventSources.problem.filterRequired", { label: f.label }));
  return problems;
}

// ───────────────────────── 文件名模式 ─────────────────────────

/** 文件名模式拆成几个（分号、逗号隔开） */
export function namePatterns(pattern: string | undefined): string[] {
  return (pattern ?? "")
    .split(/[;,；，]/) // @i18n-ignore data
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
  return source ? source.describe(trigger, kinds, names) : t("protocol.eventSources.describeUnknown", { source: trigger.source, what: kinds.join(listSep()) });
}

// ───────────────────────── 流程步骤里的占位 ─────────────────────────

/** 占位的写法：{{事件.文件路径}}（字段的中文名，也认键：{{事件.path}}） */
export const eventPlaceholder = (name: string) => `{{事件.${name}}}`; // @i18n-ignore data：占位的写法

/** 认占位：{{事件.X}}（X 前后可以有空白） */
const PLACEHOLDER = /\{\{\s*事件\.([^{}\s]+?)\s*\}\}/g; // @i18n-ignore data

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
    const whole = /^\{\{\s*事件\.([^{}\s]+?)\s*\}\}$/.exec(value); // @i18n-ignore data
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
