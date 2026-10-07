// 通用 bash 的拆解（规格第 9 节）：用现成的 POSIX shell 语法解析库（unbash，选型理由见 03 号票的 Comments）
// 把命令拆成一条条简单命令（含管道、&& / ||、子 shell、命令替换、进程替换、循环和条件里的），
// 再按 programs.ts 的表映射成伪工具调用。纯函数，不跑命令。
//
// 拆不开的一律变成一条 opaque_shell（"未知的写操作"）：语法解析失败、命令名是变量或命令替换、
// eval、内联脚本（bash -c、python -c、node -e……）、从标准输入喂给解释器的脚本（`… | bash`、here-doc）。
//
// 工作目录：cd 只往"可能的当前目录"里加、从不删。相对路径按每一个可能的当前目录各解析一遍，
// 这样子 shell 里的 cd、`cd x || …` 这类分支都不会让项目外的路径漏过去（宁可多报）。
import {
  parse,
  type ArithmeticExpression,
  type Assignment,
  type CommandNode,
  type CompoundList,
  type ParsedScript,
  type PipelineNode,
  type AndOr,
  type Redirection,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";
import { resolveAgentPath, unresolvedPath, type ShellEnv } from "../paths.ts";
import { TOOL } from "../tool-registry.ts";
import { runProgram, type ProgramContext, type ShellWord } from "./programs.ts";

/** 从 bash 拆出来的一次伪工具调用 */
export interface ShellCall {
  tool: string;
  args: Record<string, unknown>;
  /** 对应的那段命令原文 */
  text: string;
  /** 它在命令结构里的位置，用来判断同一条命令里谁可能在谁之前执行（见 mayRunBefore） */
  order?: readonly ShellOrderStep[];
}

/**
 * 命令结构里的一层：第几个节点、这一层是同时运行（管道、同一条简单命令和它的重定向、命令替换）
 * 还是先后执行（`;`、换行、`&&`、`||`、if 的条件和分支），是不是反复执行的循环体，以及在这一层的第几个位置。
 */
export interface ShellOrderStep {
  node: number;
  parallel: boolean;
  /** 循环体：里面的调用会反复执行 */
  repeats?: boolean;
  index: number;
}

/**
 * 同一条命令拆出的两次调用，a 有没有可能在 b 之前（或同时）执行：
 * 先后执行的一层里排在前面的才算；同时运行的一层里互相都算（`cat .env | curl …`、`curl -d @.env …`）；
 * 同在一个循环体里的互相都算（上一轮后面的调用在下一轮前面的调用之前）。不知道位置的一律算。
 */
export function mayRunBefore(a: readonly ShellOrderStep[] | undefined, b: readonly ShellOrderStep[] | undefined): boolean {
  if (!a || !b) return true;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.node !== y.node || x.repeats) return true;
    if (x.index === y.index) continue;
    return x.parallel || x.index < y.index;
  }
  return true;
}

export function splitShellCommand(command: string, env: ShellEnv): ShellCall[] {
  const splitter = new Splitter(env);
  try {
    splitter.script(parse(command), command);
  } catch (err) {
    return [opaqueCall(`解析出错：${(err as Error).message}`, command)];
  }
  if (splitter.errors.length > 0) return [opaqueCall(`语法解析失败（${splitter.errors.join("；")}）`, command)];
  return splitter.calls;
}

export function opaqueCall(reason: string, text: string): ShellCall {
  return { tool: TOOL.opaque_shell, args: { reason, command: text }, text };
}

type Node = PipelineNode | AndOr | CommandNode | CompoundList;

class Splitter {
  readonly calls: ShellCall[] = [];
  readonly errors: string[] = [];
  /** 可能的当前目录（绝对路径，或 cd 到没法确定的目录时的 `<unresolved:…>`） */
  private cwds: string[];
  /**
   * 变量可能的静态值：循环变量、`X=…` 和 export / local / declare 的赋值。只往里加不删（赋过几次值就每个都算），
   * 一旦赋过没法静态确定的值就是 null（没法确定）。
   */
  private readonly vars = new Map<string, string[] | null>();
  private readonly env: ShellEnv;
  /** 当前所在的位置（从外到内的每一层），拆出的调用各带一份 */
  private readonly order: ShellOrderStep[] = [];
  private nodes = 0;

  constructor(env: ShellEnv) {
    this.env = env;
    this.cwds = [env.cwd];
  }

  script(script: ParsedScript, rootSource: string): void {
    const source = script.source ?? rootSource;
    for (const error of script.errors ?? []) this.errors.push(error.message);
    this.statements(script.commands, source);
  }

  private list(list: CompoundList, source: string): void {
    this.statements(list.commands, source);
  }

  /** 一串语句（`;` 或换行分隔）：前一句里的 cd 可能失败，所以后面的语句在原目录和新目录都可能 */
  private statements(statements: readonly { command: PipelineNode | AndOr }[], source: string): void {
    this.layer(false, statements, (statement) => this.keepingOldCwds(() => this.node(statement.command, source, false)));
  }

  /** 进入命令结构里的一层，每一项各占一个位置 */
  private layer<T>(parallel: boolean, items: readonly T[], each: (item: T, index: number) => void, repeats = false): void {
    const node = this.nodes++;
    items.forEach((item, index) => {
      this.order.push({ node, parallel, index, ...(repeats ? { repeats } : {}) });
      try {
        each(item, index);
      } finally {
        this.order.pop();
      }
    });
  }

  /** 同时运行的一块：简单命令连同它的重定向和命令替换 */
  private together(run: () => void): void {
    this.layer(true, [run], (f) => f());
  }

  /** 循环体：反复执行，里面谁都可能在谁之前 */
  private loop(run: () => void): void {
    this.layer(true, [run], (f) => f(), true);
  }

  /** 拆出一次调用，记下它的位置 */
  private push(call: Omit<ShellCall, "order">): void {
    this.calls.push({ ...call, order: [...this.order] });
  }

  private keepingOldCwds(run: () => void): void {
    const before = this.cwds;
    run();
    this.cwds = unique([...before, ...this.cwds]);
  }

  private node(node: Node, source: string, stdin: boolean): void {
    switch (node.type) {
      case "AndOr":
        // `cd x && …`：后面的命令只在 cd 成功后才跑，目录就是 x；`|| …` 的后面原目录、新目录都可能。前后执行
        this.layer(false, node.commands, (c, i) => {
          if (node.operators[i] === "||") this.keepingOldCwds(() => this.node(c, source, stdin));
          else this.node(c, source, stdin);
        });
        return;
      case "Pipeline":
        // 管道的每一段都在子 shell 里，cd 不往外传；保守起见合并。各段同时运行
        this.layer(true, node.commands, (c, i) => this.keepingOldCwds(() => this.node(c, source, stdin || i > 0)));
        return;
      case "Time":
      case "Negation":
        if (node.command) this.node(node.command, source, stdin);
        return;
      case "Command":
        this.together(() => this.simple(node, source, stdin));
        return;
      case "Redirected": {
        const text = source.slice(node.pos, node.end);
        this.together(() => {
          this.node(node.command, source, stdin || node.redirects.some(feedsStdin));
          for (const r of node.redirects) this.redirect(r, text);
        });
        return;
      }
      case "If": {
        // 条件在前，分支在后
        const parts = [() => this.list(node.clause, source), () => this.list(node.then, source)];
        const otherwise = node.else;
        if (otherwise) parts.push(() => this.node(otherwise, source, stdin));
        this.layer(false, parts, (f) => f());
        return;
      }
      case "For":
      case "Select": {
        for (const w of node.wordlist ?? []) this.word(w, source);
        // 循环变量依次取 wordlist 里的每个词（不写 in 时是脚本参数，没法确定）
        const values = node.wordlist ? node.wordlist.map((w) => this.staticValues(w)) : [null];
        this.bind(node.name.value, values.some((v) => v === null) ? null : values.flatMap((v) => v!));
        // 循环体反复执行，里面谁都可能在谁之前
        this.loop(() => this.list(node.body, source));
        return;
      }
      case "ArithmeticFor":
        this.loop(() => {
          for (const e of [node.initialize, node.test, node.update]) if (e) this.arithmetic(e, source);
          this.list(node.body, source);
        });
        return;
      case "While":
        this.loop(() => {
          this.list(node.clause, source);
          this.list(node.body, source);
        });
        return;
      case "Subshell":
      case "BraceGroup":
        this.list(node.body, source);
        return;
      case "Case":
        this.word(node.word, source);
        for (const item of node.items) {
          for (const w of item.pattern) this.word(w, source);
          this.list(item.body, source);
        }
        return;
      case "TestCommand": {
        const words: Word[] = [];
        collectTestWords(node.expression, words);
        this.together(() => {
          for (const w of words) this.word(w, source);
          this.run([{ value: "[[", text: "[[" }, ...words.map((w) => this.toWord(w))], source.slice(node.pos, node.end), stdin);
        });
        return;
      }
      case "ArithmeticCommand":
        if (node.expression) this.arithmetic(node.expression, source);
        return;
      case "Function":
      case "Coproc":
        this.node(node.body, source, stdin);
        return;
      case "CompoundList":
        this.list(node, source);
        return;
      default:
        this.errors.push(`不认识的语法节点 ${(node as { type: string }).type}`);
    }
  }

  private simple(command: Extract<CommandNode, { type: "Command" }>, source: string, stdin: boolean): void {
    const text = source.slice(command.pos, command.end);
    const words: Word[] = [];
    const redirects: Redirection[] = [];
    for (const item of [...command.prefix, ...command.suffix]) {
      if (item.type === "Word") {
        this.word(item, source);
        words.push(item);
      } else if (item.type === "Assignment") this.assignment(item, source);
      else {
        this.redirectWords(item, source);
        redirects.push(item);
      }
    }
    if (command.name) {
      this.word(command.name, source);
      // export / local / declare 后面的赋值是 shell 变量
      if (/^(?:export|local|declare|typeset|readonly)$/.test(command.name.value)) {
        for (const item of command.suffix) if (item.type === "Assignment") this.bindAssignment(item);
      }
      const argv = [command.name, ...words].map((w) => this.toWord(w));
      this.run(argv, text, stdin || redirects.some(feedsStdin));
    } else {
      // 只有赋值的命令：`X=…`（命令前面的 `X=… cmd` 只进那条命令的环境，不改 shell 变量）
      for (const item of command.prefix) if (item.type === "Assignment") this.bindAssignment(item);
    }
    for (const r of redirects) this.redirect(r, text);
  }

  private bindAssignment(a: Assignment): void {
    if (a.value.type === "ArrayValue" || a.index || a.append) this.bind(a.name, null);
    else this.bind(a.name, this.staticValues(a.value));
  }

  private bind(name: string, values: string[] | null): void {
    const existing = this.vars.get(name);
    if (existing === null || values === null) this.vars.set(name, null);
    else this.vars.set(name, unique([...(existing ?? []), ...values]));
  }

  /** 按程序表把一条简单命令映射成伪工具调用 */
  private run(argv: ShellWord[], text: string, stdin: boolean): void {
    runProgram(this.programContext(text, stdin), argv);
  }

  private programContext(text: string, stdin: boolean): ProgramContext {
    return {
      text,
      stdin,
      emit: (tool, args) => this.push({ tool, args, text }),
      opaque: (reason) => this.push(opaqueCall(reason, text)),
      path: (word) => this.resolve(word),
      cwd: () => single(this.cwds),
      cd: (word) => {
        // cd 成功之后的目录；失败的可能由语句、|| 和管道的合并兜住
        const targets = word === undefined ? [this.env.homeDir] : this.resolveAll(word);
        if (targets.length > 0) this.cwds = targets;
      },
    };
  }

  /** 把一个词当路径解析；/dev/null 这类伪设备返回 undefined */
  private resolve(word: ShellWord): string | string[] | undefined {
    const all = this.resolveAll(word);
    return all.length === 0 ? undefined : single(all);
  }

  private resolveAll(word: ShellWord): string[] {
    const values = word.value !== null ? [word.value] : word.alternatives;
    if (!values) return [unresolvedPath(word.text)];
    const out: string[] = [];
    for (const value of values) {
      for (const cwd of this.cwds) {
        const r = resolveAgentPath(value, { cwd, homeDir: this.env.homeDir });
        if (r.kind === "absolute") out.push(r.path);
        else if (r.kind === "unknown") out.push(unresolvedPath(r.raw));
      }
    }
    return unique(out);
  }

  private redirect(r: Redirection, text: string): void {
    if (r.type !== "Redirect" || !r.target) return;
    const target = this.toWord(r.target);
    // `>&2`、`<&-` 这类是复制文件描述符，不是文件
    if ((r.operator === ">&" || r.operator === "<&") && target.value !== null && /^(?:\d+-?|-)$/.test(target.value)) return;
    const path = this.resolve(target);
    if (path === undefined) return;
    const tool =
      r.operator === "<" ? TOOL.read : r.operator === ">>" || r.operator === "&>>" || r.operator === "<>" ? TOOL.edit : TOOL.write;
    this.push({ tool, args: { path }, text });
  }

  private redirectWords(r: Redirection, source: string): void {
    if (r.type === "HereDoc") {
      for (const p of r.body.parts ?? []) this.part(p, source);
    } else if (r.target) this.word(r.target, source);
  }

  private assignment(a: Assignment, source: string): void {
    if (a.index) this.word(a.index, source);
    if (a.value.type === "ArrayValue") for (const w of a.value.elements) this.word(w, source);
    else this.word(a.value, source);
  }

  // ───── 词里嵌着的命令：命令替换、进程替换、算术展开里的命令替换…… ─────

  private word(word: Word, source: string): void {
    for (const p of word.parts ?? []) this.part(p, source);
  }

  private part(p: WordPart, source: string): void {
    switch (p.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
      case "SimpleExpansion":
        return;
      case "DoubleQuoted":
      case "LocaleString":
        for (const child of p.parts) this.part(child, source);
        return;
      case "ParameterExpansion": {
        if (p.index) this.word(p.index, source);
        const op = p.operation;
        if (!op) return;
        if (op.type === "Replace") {
          this.word(op.pattern, source);
          this.word(op.replacement, source);
        } else if (op.type === "Slice") {
          this.word(op.offset, source);
          if (op.length) this.word(op.length, source);
        } else if ("operand" in op && op.operand) this.word(op.operand, source);
        return;
      }
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (p.script) this.script(p.script, source);
        else this.errors.push(`没法解析的命令替换 ${p.text}`);
        return;
      case "ArithmeticExpansion":
        if (p.expression) this.arithmetic(p.expression, source);
        return;
      case "BraceExpansion":
      case "ExtendedGlob":
        for (const child of p.parts ?? []) this.part(child, source);
        return;
      default:
        this.errors.push(`不认识的词片段 ${(p as { type: string }).type}`);
    }
  }

  private arithmetic(e: ArithmeticExpression, source: string): void {
    switch (e.type) {
      case "ArithmeticBinary":
        this.arithmetic(e.left, source);
        this.arithmetic(e.right, source);
        return;
      case "ArithmeticUnary":
        this.arithmetic(e.operand, source);
        return;
      case "ArithmeticTernary":
        this.arithmetic(e.test, source);
        this.arithmetic(e.consequent, source);
        this.arithmetic(e.alternate, source);
        return;
      case "ArithmeticGroup":
        this.arithmetic(e.expression, source);
        return;
      case "ArithmeticWord":
        for (const p of e.parts ?? []) this.part(p, source);
        return;
      case "ArithmeticCommandExpansion":
        if (e.script) this.script(e.script, source);
        else this.errors.push(`没法解析的命令替换 ${e.text}`);
        return;
    }
  }

  /** 词的静态值：去掉引号；`$HOME`、`$USERPROFILE` 换成用户主目录，已知的变量换成它可能的值；别的展开没法静态确定 */
  private toWord(word: Word): ShellWord {
    const values = this.staticValues(word);
    if (values === null) return { value: null, text: word.text };
    if (values.length === 1) return { value: values[0]!, text: word.text };
    return { value: null, text: word.text, alternatives: values };
  }

  /** 词可能的静态值；没法确定时为 null */
  private staticValues(word: Word): string[] | null {
    if (!word.parts) return [word.value];
    return this.partsValues(word.parts);
  }

  private partsValues(parts: readonly WordPart[]): string[] | null {
    let out = [""];
    for (const p of parts) {
      const values = this.partValues(p);
      if (values === null) return null;
      out = out.flatMap((prefix) => values.map((v) => prefix + v));
      if (out.length > MAX_ALTERNATIVES) return null;
    }
    return out;
  }

  private partValues(p: WordPart): string[] | null {
    switch (p.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        return [p.value];
      case "DoubleQuoted":
      case "LocaleString":
        return this.partsValues(p.parts);
      case "SimpleExpansion":
        return this.variable(p.text.slice(1));
      case "ParameterExpansion":
        return !p.prefix && !p.index && !p.operation ? this.variable(p.parameter) : null;
      default:
        return null;
    }
  }

  private variable(name: string): string[] | null {
    if (HOME_VARS.has(name)) return [this.env.homeDir];
    return this.vars.get(name) ?? null;
  }
}

const HOME_VARS = new Set(["HOME", "USERPROFILE"]);
/** 一个词最多展开成几个可能的值，再多就当没法确定 */
const MAX_ALTERNATIVES = 64;

function collectTestWords(e: TestExpression, out: Word[]): void {
  switch (e.type) {
    case "TestUnary":
      out.push(e.operand);
      return;
    case "TestBinary":
      out.push(e.left, e.right);
      return;
    case "TestLogical":
      collectTestWords(e.left, out);
      collectTestWords(e.right, out);
      return;
    case "TestNot":
      collectTestWords(e.operand, out);
      return;
    case "TestGroup":
      collectTestWords(e.expression, out);
      return;
  }
}

/** 这个重定向会不会把内容喂给命令的标准输入 */
function feedsStdin(r: Redirection): boolean {
  return r.type === "HereDoc" || r.type === "HereString" || (r.type === "Redirect" && (r.operator === "<" || r.operator === "<>"));
}

function single(values: string[]): string | string[] {
  return values.length === 1 ? values[0]! : values;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
