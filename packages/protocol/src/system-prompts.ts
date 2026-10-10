// 各 agent 的系统提示（71 号票，照 drama_maker 的 prompts/*.md）：提示的文字放在 md 文件里，用户能在设置里直接改。
// 这里是守护进程和设置页共用的部分（不引用 TypeBox；接口的 schema 在 system-prompt-schema.ts）：
// 提示文件里占位符的写法、检查（parsePromptTemplate）和填值（renderPromptTemplate）。哪些提示、各能用哪些占位符由守护进程定
// （packages/daemon/src/prompts/registry.ts），经接口交给设置页，设置页边改边用同一个函数查。
//
// 写法（只有四种，都用两层花括号）：
// - {{名字}}：填一个值（名字、工具名、阈值里的数字……）；
// - {{#条件}}……{{/条件}}：条件成立时才有中间这段；{{^条件}}……{{/条件}}：条件不成立时才有；
// - {{> 片段}}：插入一段共用片段（另一份提示文件），片段里的占位符照样填。
// 一行里只有一个条件的开头或结尾（前后只有空白）时，这一整行连同换行一起去掉，所以条件可以各占一行包住整段。
// 占位符写错（不认得、条件当值用、值当条件用、片段不认得、没配对）一律报错，不默默填空串；有的值只在某个条件成立时才有
// （比如项目类型只在立项书确认之后才有），写在那个条件外面也报错，说清在什么情况下会缺。
// 占位符的名字是中文的（拉回次数、立项书已确认……）：这些文件是给用户看、给用户改的（"标识符用英文"的例外，见 docs/dev.md）。

/** 一份提示能用的占位符（检查用）：填值的、条件、能插的片段 */
export interface PromptTemplateSpec {
  /** 填值的占位符的名字（这份提示自己的） */
  readonly values: readonly string[];
  /** 每份提示都能用的填值占位符（工具名、标记）：一样能填，报错时不一个个列出来 */
  readonly common?: readonly string[];
  /** 条件的名字 */
  readonly flags: readonly string[];
  /** 能插的片段（提示的编号） */
  readonly partials: readonly string[];
  /** 只在某个条件成立时才有值的占位符：占位符 → 条件。要写在 {{#条件}}……{{/条件}} 里面 */
  readonly onlyWhen?: Readonly<Record<string, string>>;
}

/** 检查出的一处问题：第几行（1 起）、说明 */
export interface PromptTemplateIssue {
  readonly line: number;
  readonly message: string;
}

/** 解析好的提示 */
export type PromptNode =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "var"; readonly name: string; readonly line: number }
  | { readonly type: "section"; readonly name: string; readonly inverted: boolean; readonly line: number; readonly children: readonly PromptNode[] }
  | { readonly type: "partial"; readonly id: string; readonly line: number };

export type PromptTemplateCheck = { ok: true; nodes: readonly PromptNode[] } | { ok: false; issues: readonly PromptTemplateIssue[] };

/** 填值时的值：填值的占位符是文字（undefined 表示这次没有值，真用到时报错），条件是真假（用到了却没给也报错） */
export type PromptValues = Readonly<Record<string, string | boolean | undefined>>;

/**
 * 读进来的提示文件统一成一个样子：去掉开头的 BOM、换行统一成 \n（Windows 上检出、编辑器存的可能是 \r\n），去掉末尾的空行。
 * 守护进程读文件、设置页比较"改没改"都先过它
 */
export function normalizePromptSource(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** 占位符的名字里不能有的：空白、花括号、写法用的几个符号 */
const BAD_NAME = /[\s{}#^/>]/u;

/** 占位符的名字合不合规（不能是空的，不能有空白、花括号、写法用的几个符号）：检查提示文件和守护进程查自己的清单共用 */
export function isPromptPlaceholderName(name: string): boolean {
  return name !== "" && !BAD_NAME.test(name);
}

/** 一行里只有一个条件的开头或结尾 */
const STANDALONE_SECTION_TAG = /^[ \t]*\{\{([#^/])([^{}]*)\}\}[ \t]*$/u;

type Token = { kind: "text"; text: string } | { kind: "var" | "open" | "inverted" | "close" | "partial"; name: string; line: number };

/** 拆成文字和占位符；写法上的问题（没配对的花括号、名字不合规）记进 issues */
function tokenize(source: string, issues: PromptTemplateIssue[]): Token[] {
  const tokens: Token[] = [];
  const lines = source.split("\n");
  lines.forEach((lineText, i) => {
    const line = i + 1;
    const newline = i < lines.length - 1 ? "\n" : "";
    const standalone = STANDALONE_SECTION_TAG.exec(lineText);
    if (standalone) {
      tokens.push(tag(standalone[1]! + standalone[2]!, line, issues));
      return;
    }
    let rest = lineText;
    while (rest.length > 0) {
      const open = rest.indexOf("{{");
      const strayClose = rest.indexOf("}}");
      if (open < 0) {
        tokens.push({ kind: "text", text: rest });
        break;
      }
      if (strayClose >= 0 && strayClose < open) {
        // "}}" 出现在 "{{" 前面：只当普通文字（JSON 例子里常见），不报错
        tokens.push({ kind: "text", text: rest.slice(0, strayClose + 2) });
        rest = rest.slice(strayClose + 2);
        continue;
      }
      if (open > 0) tokens.push({ kind: "text", text: rest.slice(0, open) });
      const close = rest.indexOf("}}", open + 2);
      if (close < 0) {
        issues.push({ line, message: `“{{”没有配对的“}}”：占位符要在同一行里写完，比如 {{名字}}` });
        tokens.push({ kind: "text", text: rest.slice(open) });
        break;
      }
      tokens.push(tag(rest.slice(open + 2, close), line, issues));
      rest = rest.slice(close + 2);
    }
    if (newline) tokens.push({ kind: "text", text: newline });
  });
  return tokens;
}

/** 两层花括号里面的东西 → 占位符 */
function tag(inner: string, line: number, issues: PromptTemplateIssue[]): Token {
  const raw = inner.trim();
  const sigil = raw[0];
  const kind = sigil === "#" ? "open" : sigil === "^" ? "inverted" : sigil === "/" ? "close" : sigil === ">" ? "partial" : "var";
  const name = (kind === "var" ? raw : raw.slice(1)).trim();
  if (!isPromptPlaceholderName(name)) issues.push({ line, message: `{{${inner}}} 写得不对：两层花括号里要写占位符的名字（不能有空白），比如 {{名字}}、{{#条件}}、{{/条件}}、{{> 片段}}` });
  return { kind, name, line };
}

/** 报错时列出这里能用的名字："名字、web_search"，一个都没有写"没有" */
const listNames = (names: readonly string[]) => (names.length > 0 ? names.join("、") : "没有");

const isValue = (spec: PromptTemplateSpec, name: string) => spec.values.includes(name) || (spec.common?.includes(name) ?? false);

/** 报错时列出能填的值：自己的一个个列，公用的（工具名、标记）只提一句 */
function listValues(spec: PromptTemplateSpec): string {
  if (!spec.common?.length) return listNames(spec.values);
  return spec.values.length > 0 ? `${spec.values.join("、")}，另有每份都能用的工具名和标记` : "每份都能用的工具名和标记";
}

/** 按 spec 检查一份提示，没问题时给出解析好的样子 */
export function parsePromptTemplate(source: string, spec: PromptTemplateSpec): PromptTemplateCheck {
  const issues: PromptTemplateIssue[] = [];
  const tokens = tokenize(source, issues);
  type Frame = { name: string; inverted: boolean; line: number; children: PromptNode[] };
  const root: PromptNode[] = [];
  const stack: Frame[] = [];
  const out = () => stack.at(-1)?.children ?? root;
  for (const t of tokens) {
    if (t.kind === "text") {
      const into = out();
      const last = into.at(-1);
      if (last?.type === "text") into[into.length - 1] = { type: "text", text: last.text + t.text };
      else into.push({ type: "text", text: t.text });
      continue;
    }
    if (!isPromptPlaceholderName(t.name)) continue;
    switch (t.kind) {
      case "var": {
        const flag = spec.onlyWhen?.[t.name];
        if (spec.flags.includes(t.name)) issues.push({ line: t.line, message: `“${t.name}”是条件，要写成 {{#${t.name}}}……{{/${t.name}}} 或 {{^${t.name}}}……{{/${t.name}}}` });
        else if (!isValue(spec, t.name)) issues.push({ line: t.line, message: `不认得的占位符 {{${t.name}}}（这里能填的值：${listValues(spec)}）` });
        // 只在某个条件成立时才有值：离它最近的那个条件要是"成立时才有"（{{^条件}} 里面、或者不在条件里，都会缺）
        else if (flag !== undefined && stack.findLast((f) => f.name === flag)?.inverted !== false) {
          issues.push({ line: t.line, message: `{{${t.name}}} 在条件“${flag}”不成立时没有值，要写在 {{#${flag}}}……{{/${flag}}} 里面` });
        }
        out().push({ type: "var", name: t.name, line: t.line });
        break;
      }
      case "open":
      case "inverted":
        if (!spec.flags.includes(t.name)) {
          issues.push({
            line: t.line,
            message: isValue(spec, t.name) ? `“${t.name}”不是条件，只能写成 {{${t.name}}}` : `不认得的条件“${t.name}”（这里能用的条件：${listNames(spec.flags)}）`,
          });
        }
        stack.push({ name: t.name, inverted: t.kind === "inverted", line: t.line, children: [] });
        break;
      case "close": {
        const top = stack.at(-1);
        if (!top) {
          issues.push({ line: t.line, message: `{{/${t.name}}} 前面没有对应的 {{#${t.name}}} 或 {{^${t.name}}}` });
          break;
        }
        if (top.name !== t.name) {
          issues.push({ line: t.line, message: `{{/${t.name}}} 对不上：第 ${top.line} 行的 {{${top.inverted ? "^" : "#"}${top.name}}} 还没结束` });
          break;
        }
        stack.pop();
        out().push({ type: "section", name: top.name, inverted: top.inverted, line: top.line, children: top.children });
        break;
      }
      case "partial":
        if (!spec.partials.includes(t.name)) issues.push({ line: t.line, message: `不认得的片段 {{> ${t.name}}}（这里能插的片段：${listNames(spec.partials)}）` });
        out().push({ type: "partial", id: t.name, line: t.line });
        break;
    }
  }
  for (const open of stack.toReversed()) issues.push({ line: open.line, message: `第 ${open.line} 行的 {{${open.inverted ? "^" : "#"}${open.name}}} 没有结束：后面要有 {{/${open.name}}}` });
  if (issues.length > 0) return { ok: false, issues: issues.toSorted((a, b) => a.line - b.line) };
  return { ok: true, nodes: root };
}

/** 把检查出的问题写成一段给人看的话（每处一行，"第 3 行：……"） */
export function promptIssuesText(issues: readonly PromptTemplateIssue[]): string {
  return issues.map((i) => `第 ${i.line} 行：${i.message}`).join("\n");
}

/**
 * 填值时出的错：用到的占位符这次没有值、条件没给成立不成立（不默默填空串）。source 是出错的那一份提示（角色或片段）的编号，
 * 守护进程据此把那一份退回默认的
 */
export class PromptValueMissing extends Error {
  readonly source: string;
  readonly line: number;
  /** 没有值的占位符（或条件）的名字 */
  readonly placeholder: string;
  /** 是条件（没给成立不成立），不是填值的占位符 */
  readonly flag: boolean;
  constructor(source: string, line: number, placeholder: string, flag: boolean) {
    super(flag ? `“${source}”第 ${line} 行的条件“${placeholder}”没有给出成立不成立` : `“${source}”第 ${line} 行的 {{${placeholder}}} 没有值`);
    this.source = source;
    this.line = line;
    this.placeholder = placeholder;
    this.flag = flag;
  }
}

/**
 * 填值：source 是这一份提示的编号（出错时写明是哪一份），partial(id) 给出片段解析好的样子（片段里的占位符用同一份值）。
 * 末尾的空行去掉（条件包住的最后一段不成立时会留下换行）
 */
export function renderPromptTemplate(nodes: readonly PromptNode[], values: PromptValues, partial: (id: string) => readonly PromptNode[], source = "提示"): string {
  const parts: string[] = [];
  const walk = (list: readonly PromptNode[]) => {
    for (const n of list) {
      switch (n.type) {
        case "text":
          parts.push(n.text);
          break;
        case "var": {
          const v = values[n.name];
          if (typeof v !== "string") throw new PromptValueMissing(source, n.line, n.name, false);
          parts.push(v);
          break;
        }
        case "section": {
          const v = values[n.name];
          if (typeof v !== "boolean") throw new PromptValueMissing(source, n.line, n.name, true);
          if (v !== n.inverted) walk(n.children);
          break;
        }
        case "partial":
          parts.push(renderPromptTemplate(partial(n.id), values, partial, n.id));
          break;
      }
    }
  };
  walk(nodes);
  return parts.join("").replace(/\n+$/, "");
}
