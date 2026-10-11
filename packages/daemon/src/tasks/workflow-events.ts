// 事件触发的流程（77 号票，ADR 0025）：步骤的参数可以写成事件里的值的占位（{{事件.文件路径}}）——
// - 交计划时（draftEventProblems）：只有事件触发的流程能写占位，名字要是它等的事件带的字段（中文名或键）；
// - 规划时（reviewWorkflowDraft 用 maskEventPlaceholders / unmaskEventPlaceholders）：不知道值。非 bash 的参数里带占位的整个当作
//   "未知"交给审查（审查不会改写它、规划时不发授权、不标敏感）；通用 bash 的命令照原文（占位只是命令里的一段字）。审查完换回原来写的占位，
//   计划卡上照这样显示，标出这一步"代入事件的值"（WorkflowStepView.eventValues）；
// - 每次运行（runWorkflowSteps）：一批里每个事件各走一遍步骤（只有一个事件的照原来的编号；几个的编号后面加 .e<第几个>，前置步骤
//   跟着换成同一遍里的），文件工具的参数、标题里的占位直接代入这个事件的值（只换一遍，值里写着 {{事件.…}} 也不会再被代入）。
//   通用 bash 的命令里不拼值：占位换成引用环境变量（shellCommandWithVars，ERGOU_EVENT_<第几个事件>_<字段>，按占位所在的引号换成
//   "${X}"、${X} 或 '"${X}"'），值放进这次运行 bash 的环境变量（eventShellEnv，经 JobRunAssembly.shellEnv 交给拉起的 agent）——
//   文件名里有引号、$、反引号、换行、{{ 都改变不了命令的意思，路径也不会多出字符。守卫拆命令时按同一份值展开这些变量（guard/paths.ts 的
//   agentShellEnv），看到的路径和真正跑的一样。交给维护者的步骤、守卫逐步比对的步骤都是代入之后的，59 号票的核对按代入后的值比；
// - 执行时按执行它的维护者现取代入后的路径的真实路径、推出授权项：workflow-plan.ts 的 boundRunWorkflow（和规划时同一套办法）。
import {
  EVENT_PLACEHOLDER_PATTERN,
  eventFieldNamed,
  eventPassStepId,
  eventPlaceholdersIn,
  eventSourceOf,
  eventValueOf,
  eventValueText,
  type EventFieldDescriptor,
  substituteEventValues,
  type TriggerEvent,
  type WorkflowPlanDraft,
  type WorkflowStepView,
} from "@ergou/protocol";
import { isUnknownArg, TOOL } from "../guard/index.ts";

/** 一步里写了哪些占位（参数和标题里的，去掉重复） */
export function stepEventValues(step: { title: string; args?: Readonly<Record<string, unknown>> | undefined }): string[] {
  return [...new Set([...eventPlaceholdersIn(step.title), ...eventPlaceholdersIn(step.args ?? {})])];
}

/**
 * 交来的流程计划里的占位对不对（不对的原因，交回维护者）：fields 是这个流程等的事件带的字段（不是事件触发的流程是 undefined：一个占位都不能写）
 */
export function draftEventProblems(draft: WorkflowPlanDraft, fields: readonly EventFieldDescriptor[] | undefined): string[] {
  const problems: string[] = [];
  for (const step of draft.steps) {
    const names = stepEventValues(step);
    if (names.length === 0) continue;
    if (!fields) {
      problems.push(`步骤 ${step.id} 写了事件的值（${names.map((n) => `{{事件.${n}}}`).join("、")}），但这个流程不是事件触发的：没有事件可以代入`);
      continue;
    }
    const unknown = names.filter((n) => !eventFieldNamed(fields, n));
    if (unknown.length > 0) problems.push(`步骤 ${step.id} 的 ${unknown.map((n) => `{{事件.${n}}}`).join("、")} 不是这个流程等的事件带的字段（能用：${fields.map((f) => f.label).join("、")}）`);
  }
  return problems;
}

/** 字符串里有没有占位 */
const hasPlaceholder = (v: unknown): v is string => typeof v === "string" && eventPlaceholdersIn(v).length > 0;

/** 一个参数值里带占位的字符串换成"未知"（数组逐个换） */
function maskValue(value: unknown): unknown {
  if (hasPlaceholder(value)) return { $unknown: value };
  if (Array.isArray(value)) return value.map(maskValue);
  return value;
}

/** 规划时：非 bash 的步骤里带占位的参数值当作"未知"交给审查（通用 bash 的命令照原文） */
export function maskEventPlaceholders<S extends { tool: string; args?: Record<string, unknown> | undefined }>(steps: readonly S[]): S[] {
  return steps.map((s) => (s.tool === TOOL.bash || !s.args ? s : { ...s, args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, maskValue(v)])) }));
}

/** "未知"里包着的原话（{"$unknown": 原话}，或者规则引擎的 Unknown 的 desc） */
function unknownText(value: unknown): unknown {
  if (!isUnknownArg(value)) return undefined;
  const v = value as { $unknown?: unknown; desc?: unknown };
  return "$unknown" in v ? v.$unknown : (unknownText(v.desc) ?? v.desc);
}

/** 审查完：当作"未知"交出去的占位换回原来写的（数组、对象一层层换） */
export function unmaskEventPlaceholders<T>(value: T): T {
  if (isUnknownArg(value)) {
    const text = unknownText(value);
    return (hasPlaceholder(text) ? text : value) as T;
  }
  if (Array.isArray(value)) return value.map(unmaskEventPlaceholders) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unmaskEventPlaceholders(v)])) as T;
  return value;
}

/** 这一遍步骤的编号：一个事件的照原来的，几个的加 .e<第几个> */
const passId = (id: string, pass: number | undefined) => (pass === undefined ? id : eventPassStepId(id, pass));

/** 一个事件的一个字段放进哪个环境变量：ERGOU_EVENT_<一批里第几个事件，从 1 起>_<字段的键，驼峰换成下划线大写>（relativePath → RELATIVE_PATH） */
export const eventShellVar = (n: number, key: string): string => `ERGOU_EVENT_${n}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

/**
 * 这次运行 bash 的环境变量：一批里每个事件（从 1 起编号）、它的来源登记的每个字段一个变量，值是这个事件里的值（没有的是空字符串）。
 * 命令里引用它们（shellCommandWithVars），值从不拼进命令
 */
export function eventShellEnv(events: readonly TriggerEvent[]): Record<string, string> {
  const env: Record<string, string> = {};
  events.forEach((event, i) => {
    for (const field of eventSourceOf(event.source)?.fields ?? []) {
      const v = event.data?.[field.key];
      env[eventShellVar(i + 1, field.key)] = v === undefined || v === null ? "" : eventValueText(v);
    }
  });
  return env;
}

/** 扫命令时的一层：不在引号里、双引号里、单引号里、$'…' 里、$(…) 或反引号的命令替换里（里面又是不在引号里） */
type QuoteState = "plain" | "double" | "single" | "ansi" | "subst" | "backtick";

/** 引用变量的写法：在哪一层就怎么写，保证展开成一个完整的值（不分词、不再展开） */
function varRef(state: QuoteState, name: string): string {
  if (state === "double") return `\${${name}}`;
  // 单引号里变量不展开：先收掉单引号，接一个双引号里的变量，再接着单引号
  if (state === "single") return `'"\${${name}}"'`;
  if (state === "ansi") return `'"\${${name}}"$'`;
  return `"\${${name}}"`;
}

/**
 * 通用 bash 的命令里的占位换成引用这次事件的环境变量（n 是一批里第几个事件，fields 是这个来源登记的字段）：按占位所在的那一层引号换成
 * "${X}"（不在引号里、命令替换里）、${X}（双引号里）、'"${X}"'（单引号里）。认不出的字段名原样留着
 */
export function shellCommandWithVars(command: string, n: number, fields: readonly EventFieldDescriptor[]): string {
  const stack: QuoteState[] = ["plain"];
  const top = () => stack.at(-1)!;
  const placeholder = new RegExp(EVENT_PLACEHOLDER_PATTERN.source, "y");
  let out = "";
  let i = 0;
  while (i < command.length) {
    placeholder.lastIndex = i;
    const m = placeholder.exec(command);
    if (m) {
      const field = eventFieldNamed(fields, m[1]!);
      out += field ? varRef(top(), eventShellVar(n, field.key)) : m[0];
      i += m[0].length;
      continue;
    }
    const move = quoteMove(top(), command[i]!, command[i + 1]);
    if (move.pop) stack.pop();
    if (move.push) stack.push(move.push);
    out += command.slice(i, i + move.take);
    i += move.take;
  }
  return out;
}

/** 扫到一个字符（next 是下一个）：这一层引号收掉、进新的一层，这一步吃掉几个字符（反斜杠连同后面那个一起） */
function quoteMove(state: QuoteState, c: string, next: string | undefined): { pop?: true; push?: QuoteState; take: number } {
  if (state === "single") return c === "'" ? { pop: true, take: 1 } : { take: 1 };
  if (state === "ansi") return c === "\\" ? { take: 2 } : c === "'" ? { pop: true, take: 1 } : { take: 1 };
  if (c === "\\") return { take: 2 };
  if (c === "$" && next === "(") return { push: "subst", take: 2 };
  if (state === "double") return c === '"' ? { pop: true, take: 1 } : c === "`" ? { push: "backtick", take: 1 } : { take: 1 };
  if (c === "'") return { push: "single", take: 1 };
  if (c === '"') return { push: "double", take: 1 };
  if (c === "$" && next === "'") return { push: "ansi", take: 2 };
  if (c === "`") return state === "backtick" ? { pop: true, take: 1 } : { push: "backtick", take: 1 };
  if (c === ")" && state === "subst") return { pop: true, take: 1 };
  return { take: 1 };
}

/** 一步代入一个事件的值（pass 是一批里的第几个事件，只有一个事件时不给） */
function boundStep(step: WorkflowStepView, event: TriggerEvent | undefined, pass: number | undefined): WorkflowStepView {
  const fields = event ? (eventSourceOf(event.source)?.fields ?? []) : [];
  const valueOf = eventValueOf(event?.data, fields);
  const sub = <T>(v: T): T => (event ? (substituteEventValues(v, valueOf) as T) : v);
  // 通用 bash 的命令：值不拼进命令，换成引用这个事件的环境变量
  const shell = (k: string, v: unknown) => step.tool === TOOL.bash && k === "command" && typeof v === "string";
  const args = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, event && shell(k, v) ? shellCommandWithVars(v as string, pass ?? 1, fields) : sub(v)]));
  const substituted = stepEventValues(step).length > 0;
  // 代入之后的路径另取真实路径（boundRunWorkflow）；没有占位的步骤沿用规划时取的
  const { realPaths, ...rest } = step;
  return {
    ...rest,
    id: passId(step.id, pass),
    title: `${sub(step.title)}${pass === undefined ? "" : `（第 ${pass} 个事件）`}`,
    args,
    after: step.after.map((a) => passId(a, pass)),
    ...(step.excluded ? { excluded: sub(step.excluded) } : {}),
    ...(realPaths && !substituted ? { realPaths } : {}),
  };
}

/**
 * 事件触发的流程这次运行要照的步骤：一批里每个事件各走一遍（只有一个事件的照原来的编号），参数和标题里的占位代入这个事件的值
 * （通用 bash 的命令引用这个事件的环境变量，见 eventShellEnv）。不是事件来的（时间到了的）不算一个事件
 */
export function runWorkflowSteps(steps: readonly WorkflowStepView[], events: readonly TriggerEvent[]): WorkflowStepView[] {
  if (events.length <= 1) return steps.map((s) => boundStep(s, events[0], undefined));
  return events.flatMap((e, i) => steps.map((s) => boundStep(s, e, i + 1)));
}
