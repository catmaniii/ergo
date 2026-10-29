// 通用 bash 的拆解（规格第 9 节）：用现成的 POSIX shell 语法解析库（unbash，选型理由见 03 号票的 Comments）
// 把命令拆成一条条简单命令（含管道、&& / ||、子 shell、命令替换、进程替换、循环和条件里的），
// 再按 programs.ts 的表映射成伪工具调用。纯函数，不跑命令。
//
// 拆不开的一律变成一条 opaque_shell（"未知的写操作"）：语法解析失败、命令名是变量或命令替换、
// eval、内联脚本（bash -c、python -c、node -e……）、从标准输入喂给解释器的脚本（`… | bash`、here-doc）。
//
// 变量和当前目录按执行的先后推（177 号票："只认前面定义、后面使用"）：每走到一处，记着此刻每个变量可能的值（没法确定是 null）
// 和可能的当前目录（FlowState）。
// - 前面确定赋过值的变量代进去（`A=x && … $A`、`A=x; …`、`export A=x`，值由已知的变量拼成的也算）；
// - 可能没赋上的（条件里、`||` 后面、&& 链停下的地方之后、循环体里），和之前的值合起来算：之前没赋过的（也不是环境里已知的）就是没法确定；
// - 子 shell、管道的每一段、命令替换、后台跑的里面赋的值、cd 不往外传；
// - 循环回头再跑：循环体里后面的赋值、cd 和 continue 时的样子在下一轮前面也算（反复推到不再变，推不完的放弃成没法确定）；
//   continue、break、return、exit 之后的语句走不到；
// - case 的某一支只写了几个字面的模式（`S16|S17)`），走这一支时变量就是其中之一；
// - 算术展开 $((…)) 的结果是一个整数，不会有路径分隔符：按一个不跨目录的通配符 `*` 算；
// - 值来自命令替换、read / mapfile / printf -v / getopts / let / 算术里的赋值、unset 掉的、${A:=…}、带选项声明的（declare -n 这类），
//   和 source 过脚本、eval 过的，都是没法确定；
// - 函数在调用的地方按那时的样子走一遍函数体（定义时不走；递归的再按什么都没法确定走一遍）；
// - 不加引号的变量值里有空白（会被拆成几个词）、命令里改过 IFS 的，按没法确定。
// cd 可能失败：一句里的 cd 之后，后面的语句在原目录和新目录都可能；相对路径按每一个可能的当前目录各解析一遍（宁可多报）。
import { t } from "@ergo/protocol";
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
  type Statement,
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
  /**
   * 这条命令拿到了守卫看不见的输入（管道、here-doc 或重定向喂来的标准输入，xargs 补上的参数，没法静态确定的词，
   * curl -K 这类配置文件）：它往外发了什么守卫看不全，见 programs.ts 的 Invocation.unseenInput。判定输出的调用、效果日志都原样带着它
   */
  unseenInput?: true;
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
    return [opaqueCall(t("guard.shell.parseError", { error: (err as Error).message }), command)];
  }
  if (splitter.errors.length > 0) return [opaqueCall(t("guard.shell.syntaxError", { errors: splitter.errors.join(t("guard.sep")) }), command)];
  return splitter.calls;
}

export function opaqueCall(reason: string, text: string): ShellCall {
  return { tool: TOOL.opaque_shell, args: { reason, command: text }, text };
}

type Node = PipelineNode | AndOr | CommandNode | CompoundList;

/** 走到某一处时：变量可能的值、可能的当前目录 */
interface FlowState {
  /**
   * 命令里赋过值的变量此刻可能的值（赋过几种就每个都算），没法确定的是 null。不在这里的变量是命令里没赋过的：
   * 用户主目录类（HOME、USERPROFILE）和 agent 的 bash 带着的已知环境变量（ShellEnv.vars）按已知的值，别的没法确定
   */
  vars: Map<string, string[] | null>;
  /** source 过脚本、eval、命令名没法确定之后：命令里没赋过的变量也没法确定了（环境里已知的、HOME 也一样） */
  havoc: boolean;
  /** 可能的当前目录（绝对路径，或 cd 到没法确定的目录时的 `<unresolved:…>`） */
  cwds: string[];
  /** 走不到了（continue、break、return、exit 之后）：和别的样子合起来时不算它 */
  dead: boolean;
}

/** 一层循环：continue、break 时的样子（continue 回到循环开头，break 跳到循环后面） */
interface LoopFrame {
  continues: FlowState[];
  breaks: FlowState[];
}

class Splitter {
  readonly calls: ShellCall[] = [];
  readonly errors: string[] = [];
  private state: FlowState;
  /** 带选项声明过的变量（declare -n 引用别的变量、-i 每次赋值都按算术算……）：之后怎么赋值都没法确定 */
  private readonly opaqueVars = new Set<string>();
  /** 定义过的函数：名字 → 函数体（定义了几次就有几个，调用时每个都走一遍） */
  private readonly functions = new Map<string, Node[]>();
  /** 正在走的函数调用（从外到内），每一层收着 return 时的样子 */
  private readonly calling: { name: string; returns: FlowState[]; locals: Set<string> }[] = [];
  private readonly loops: LoopFrame[] = [];
  private readonly env: ShellEnv;
  /** 当前所在的位置（从外到内的每一层），拆出的调用各带一份 */
  private readonly order: ShellOrderStep[] = [];
  private nodes = 0;
  /** 大于 0 时是在推循环回头之后的样子：只推变量和当前目录，不记调用、不记解析错误（真走的那一遍会记） */
  private dry = 0;

  constructor(env: ShellEnv) {
    this.env = env;
    this.state = { vars: new Map(), havoc: false, cwds: [env.cwd], dead: false };
  }

  script(script: ParsedScript, rootSource: string): void {
    const source = script.source ?? rootSource;
    if (this.dry === 0) for (const error of script.errors ?? []) this.errors.push(error.message);
    this.statements(script.commands, source);
  }

  private list(list: CompoundList, source: string): void {
    this.statements(list.commands, source);
  }

  /** 一串语句（`;` 或换行分隔）：前一句里的 cd 可能失败，所以后面的语句在原目录和新目录都可能；后台跑的（`&`）在子 shell 里 */
  private statements(statements: readonly Statement[], source: string): void {
    this.layer(false, statements, (statement) => {
      const before = this.snapshot();
      this.node(statement.command, source, false);
      if (statement.background) this.restore(before);
      else this.state.cwds = unique([...before.cwds, ...this.state.cwds]);
    });
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

  /** 拆出一次调用，记下它的位置（推循环回头的那几遍不记） */
  private push(call: Omit<ShellCall, "order">): void {
    if (this.dry === 0) this.calls.push({ ...call, order: [...this.order] });
  }

  private node(node: Node, source: string, stdin: boolean): void {
    switch (node.type) {
      case "AndOr":
        this.andOr(node, source, stdin);
        return;
      case "Pipeline": {
        // 管道的每一段都在子 shell 里：从同一个样子开始，赋值、cd 不往外传。各段同时运行。
        // shopt -s lastpipe 时最后一段在当前 shell 里跑：保守起见并上它
        const entry = this.snapshot();
        this.layer(true, node.commands, (c, i) => {
          this.restore(entry);
          this.node(c, source, stdin || i > 0);
        });
        this.state = this.join(entry, this.state);
        return;
      }
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
        // 条件在前，分支在后；之后是 then 或 else 走完的样子（没有 else 就是条件判完的样子）
        let afterClause = this.snapshot();
        let afterThen = afterClause;
        const parts = [
          () => {
            this.list(node.clause, source);
            afterClause = this.snapshot();
          },
          () => {
            this.list(node.then, source);
            afterThen = this.snapshot();
            this.restore(afterClause);
          },
        ];
        const otherwise = node.else;
        if (otherwise) parts.push(() => this.node(otherwise, source, stdin));
        this.layer(false, parts, (f) => f());
        this.state = this.join(afterThen, this.state);
        return;
      }
      case "For":
      case "Select": {
        for (const w of node.wordlist ?? []) this.word(w, source);
        // 循环变量依次取 wordlist 里的每个词（不写 in 时是脚本参数，没法确定）
        const values = node.wordlist ? node.wordlist.map((w) => this.staticValues(w, true)) : [null];
        const loopValues = values.some((v) => v === null) ? null : values.flatMap((v) => v!);
        const name = node.name.value;
        this.repeat(() => {
          this.assign(name, loopValues);
          this.list(node.body, source);
        });
        return;
      }
      case "ArithmeticFor":
        this.repeat(() => {
          for (const e of [node.initialize, node.test, node.update]) if (e) this.arithmetic(e, source);
          this.list(node.body, source);
        });
        return;
      case "While":
        this.repeat(() => {
          this.list(node.clause, source);
          this.list(node.body, source);
        });
        return;
      case "Subshell":
        this.subshell(() => this.list(node.body, source));
        return;
      case "BraceGroup":
        this.list(node.body, source);
        return;
      case "Case":
        this.caseNode(node, source);
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
      case "Function": {
        // 定义时不跑：记下函数体，调用的地方再走（见 callFunction）
        const bodies = this.functions.get(node.name.value) ?? [];
        if (!bodies.includes(node.body)) this.functions.set(node.name.value, [...bodies, node.body]);
        return;
      }
      case "Coproc":
        // 协进程在子 shell 里异步跑
        this.subshell(() => this.node(node.body, source, stdin));
        return;
      case "CompoundList":
        this.list(node, source);
        return;
      default:
        if (this.dry === 0) this.errors.push(t("guard.shell.unknownNode", { type: (node as { type: string }).type }));
    }
  }

  /**
   * `a && b && c`：后面的只在前面的成功之后才跑，变量、目录一路往后传；链子可能停在任何一段（那一段的 cd 没成功），
   * 之后是这几种样子合起来。只赋值（不带命令替换）的一段不会失败，链子不会停在那里。
   * 有 `||` 的：后面每一段可能跑、也可能没跑，保守地一路合起来
   */
  private andOr(node: AndOr, source: string, stdin: boolean): void {
    const allAnd = node.operators.every((op) => op === "&&");
    const stops: FlowState[] = [];
    this.layer(false, node.commands, (c, i) => {
      const entry = this.snapshot();
      this.node(c, source, stdin);
      const cdMayFail = unique([...entry.cwds, ...this.state.cwds]);
      if (allAnd) {
        if (mayFail(c)) stops.push({ ...this.snapshot(), cwds: cdMayFail, dead: entry.dead });
      } else if (i === 0) this.state.cwds = cdMayFail;
      else this.state = this.join(entry, this.state);
    });
    for (const stop of stops) this.state = this.join(stop, this.state);
  }

  /**
   * case：走某一支（`;&`、`;;&` 会接着走后面的），一支都没对上就是原样（有 `*)` 时总有一支）。
   * 判的是一个变量、这一支只写了字面的模式（`S16|S17)`，不带通配符）：走这一支时变量就是其中之一
   */
  private caseNode(node: Extract<CommandNode, { type: "Case" }>, source: string): void {
    this.word(node.word, source);
    const subject = caseSubject(node.word);
    const entry = this.snapshot();
    const exits: FlowState[] = [];
    let carry: FlowState | undefined;
    let catchAll = false;
    for (const item of node.items) {
      this.restore(entry);
      for (const w of item.pattern) this.word(w, source);
      if (item.pattern.some((w) => w.text === "*")) catchAll = true;
      if (subject !== undefined && item.pattern.length > 0 && item.pattern.every(isLiteralPattern)) this.assign(subject, item.pattern.map((w) => w.value));
      // 上一支 `;&` 落下来的不看这一支的模式：不收窄
      if (carry) this.state = this.join(this.state, carry);
      this.list(item.body, source);
      const after = this.snapshot();
      exits.push(after);
      if (item.terminator === ";&" || item.terminator === ";;&") carry = carry ? this.join(carry, after) : after;
    }
    if (!catchAll || node.items.some((item) => item.terminator === ";;&")) exits.push(entry);
    this.state = exits.reduce((a, b) => this.join(a, b));
  }

  /**
   * 循环：先推出回到循环开头时可能的样子（入口、每一轮走完的、continue 时的合起来，推到不再变；推了几遍还在变的变量、目录放弃成没法确定），
   * 从那个样子真走一遍记下调用；之后是循环开头的样子、走完一轮的、continue、break 时的合起来（一轮都没跑的也在里面）
   */
  private repeat(body: () => void): void {
    const entry = this.snapshot();
    let head = entry;
    let settled = false;
    for (let pass = 0; pass < MAX_LOOP_PASSES && !settled; pass++) {
      this.restore(head);
      const frame: LoopFrame = { continues: [], breaks: [] };
      this.loops.push(frame);
      this.dry++;
      try {
        body();
      } finally {
        this.dry--;
        this.loops.pop();
      }
      const next = [this.state, ...frame.continues].reduce((a, b) => this.join(a, b), head);
      settled = sameState(next, head);
      head = next;
    }
    if (!settled) head = this.widen(entry, head);
    this.restore(head);
    const frame: LoopFrame = { continues: [], breaks: [] };
    this.loops.push(frame);
    try {
      this.loop(body);
    } finally {
      this.loops.pop();
    }
    this.state = [this.state, ...frame.continues, ...frame.breaks].reduce((a, b) => this.join(a, b), head);
  }

  /** 循环推不完：和入口比变过的变量放弃成没法确定，当前目录再加一个没法确定的 */
  private widen(entry: FlowState, head: FlowState): FlowState {
    const vars = new Map(head.vars);
    for (const [name, values] of head.vars) {
      const before = entry.vars.has(name) ? entry.vars.get(name)! : this.prior(name, entry.havoc);
      if (!sameValues(values, before)) vars.set(name, null);
    }
    const cwds = sameSet(head.cwds, entry.cwds) ? head.cwds : unique([...head.cwds, unresolvedPath(t("guard.shell.loopCwd"))]);
    return { vars, havoc: head.havoc, cwds, dead: head.dead };
  }

  /**
   * 调用定义过的函数：按此刻的样子走一遍函数体（定义了几次就每个都走，合起来），return 时的样子也算。
   * 递归调用（函数体里又调到正在走的函数）：再按什么都没法确定（变量、当前目录）走一遍，之后变量都没法确定
   */
  private callFunction(name: string, source: string, stdin: boolean): void {
    const bodies = this.functions.get(name) ?? [];
    if (this.calling.some((c) => c.name === name)) {
      if (this.calling.filter((c) => c.name === name).length >= 2) return;
      const before = this.snapshot();
      this.state = { vars: new Map(), havoc: true, cwds: [...before.cwds, unresolvedPath(t("guard.shell.recursiveCwd", { name }))], dead: false };
      this.walkBodies(name, bodies, source, stdin);
      this.restore(before);
      this.havocAll();
      this.state.cwds = unique([...this.state.cwds, unresolvedPath(t("guard.shell.recursiveCwd", { name }))]);
      return;
    }
    this.walkBodies(name, bodies, source, stdin);
  }

  private walkBodies(name: string, bodies: readonly Node[], source: string, stdin: boolean): void {
    const entry = this.snapshot();
    const exits: FlowState[] = [];
    for (const body of bodies) {
      this.restore(entry);
      const frame = { name, returns: [] as FlowState[], locals: new Set<string>() };
      this.calling.push(frame);
      try {
        this.node(body, source, stdin);
      } finally {
        this.calling.pop();
      }
      const exit = [this.state, ...frame.returns.map((r) => ({ ...r, dead: false }))].reduce((a, b) => this.join(a, b));
      // 函数里的局部变量（local、不带 -g 的 declare / typeset）调用完恢复成原来的：保守地和调用完的样子合起来
      for (const local of frame.locals) {
        const was = entry.vars.has(local) ? entry.vars.get(local)! : this.prior(local, entry.havoc);
        const now = exit.vars.has(local) ? exit.vars.get(local)! : this.prior(local, exit.havoc);
        exit.vars.set(local, was === null || now === null ? null : unique([...was, ...now]));
      }
      exits.push(exit);
    }
    if (exits.length > 0) this.state = exits.reduce((a, b) => this.join(a, b));
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
      const argv = [command.name, ...words].map((w) => this.toWord(w));
      const name = argv[0]!.value;
      if (name !== null && this.functions.has(name)) {
        // 函数调用：重定向先算（读写的文件照样过围栏），再走函数体。命令前面的赋值（`A=x f`）在函数里看得到，调用完恢复成原来的
        // （保守地和调用完的样子合起来）
        for (const r of redirects) this.redirect(r, text);
        const prefix = command.prefix.filter((item): item is Assignment => item.type === "Assignment");
        const before = this.snapshot();
        for (const a of prefix) this.assignVar(a);
        this.callFunction(name, source, stdin || redirects.some(feedsStdin));
        for (const a of prefix) {
          const was = before.vars.has(a.name) ? before.vars.get(a.name)! : this.prior(a.name, before.havoc);
          const now = this.variable(a.name);
          this.state.vars.set(a.name, was === null || now === null ? null : unique([...was, ...now]));
        }
        return;
      }
      // 命令前面的赋值（`X=… cmd`）进这条命令的环境，没法确定的也是看不见的输入
      const dynamicEnv = command.prefix.some((item) => item.type === "Assignment" && (item.value.type === "ArrayValue" || this.staticValues(item.value, false) === null));
      this.run(argv, text, stdin || redirects.some(feedsStdin), dynamicEnv);
      this.commandEffects(argv, command.suffix);
    } else {
      // 只有赋值的命令：`X=…`（命令前面的 `X=… cmd` 只进那条命令的环境，不改 shell 变量）
      for (const item of command.prefix) if (item.type === "Assignment") this.assignVar(item);
    }
    for (const r of redirects) this.redirect(r, text);
  }

  /**
   * 命令对 shell 变量和之后走不走得到的影响：export / local / declare 后面的赋值（带选项的没法确定，之后也一直没法确定）；
   * read、mapfile、printf -v、getopts、let 赋的值、unset 掉的没法确定；source、eval、命令名没法确定的之后什么变量都没法确定；
   * continue、break、return、exit 之后走不到
   */
  private commandEffects(argv: readonly ShellWord[], suffix: Extract<CommandNode, { type: "Command" }>["suffix"]): void {
    let start = 0;
    while (start < argv.length - 1 && (argv[start]!.value === "command" || argv[start]!.value === "builtin")) start++;
    const name = argv[start]?.value ?? null;
    const args = argv.slice(start + 1);
    const identifiers = () => args.flatMap((w) => (w.value !== null && IDENTIFIER.test(w.value) ? [w.value] : []));
    if (name === null || name === "source" || name === "." || name === "eval") {
      this.havocAll();
      return;
    }
    if (DECLARES.has(name)) {
      // 参数都先展开、再由命令一起赋值：`export A=x B=$A/y` 里的 $A 是原来的值
      const withOptions = args.some((w) => w.value === null || w.value.startsWith("-") || w.value.startsWith("+"));
      const assignments = suffix.filter((item): item is Assignment => item.type === "Assignment");
      const values = assignments.map((a) => (a.value.type === "ArrayValue" || a.index || a.append ? null : this.staticValues(a.value, false)));
      assignments.forEach((a, i) => (withOptions ? this.forget(a.name, true) : this.assign(a.name, values[i]!)));
      if (withOptions) for (const id of identifiers()) this.forget(id, true);
      // 函数里的 local、declare、typeset：是局部变量（调用完恢复）；只写了名字的（`local A`）此刻是空的，按没法确定
      const frame = this.calling.at(-1);
      if (frame && (name === "local" || name === "declare" || name === "typeset")) {
        for (const a of assignments) frame.locals.add(a.name);
        for (const id of identifiers()) {
          frame.locals.add(id);
          this.forget(id);
        }
      }
      return;
    }
    switch (name) {
      case "read":
        for (const id of [...identifiers(), "REPLY"]) this.forget(id);
        return;
      case "mapfile":
      case "readarray":
        for (const id of [...identifiers(), "MAPFILE"]) this.forget(id);
        return;
      case "getopts":
        for (const id of [...identifiers(), "OPTARG", "OPTIND"]) this.forget(id);
        return;
      case "unset":
        for (const id of identifiers()) this.forget(id);
        return;
      case "let":
        for (const w of args) for (const id of (w.value ?? w.text).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) this.forget(id);
        return;
      case "printf":
        args.forEach((w, i) => {
          if (w.value === "-v" && args[i + 1]?.value) this.forget(args[i + 1]!.value!);
          else if (w.value?.startsWith("-v") && w.value.length > 2) this.forget(w.value.slice(2));
        });
        return;
      case "continue":
      case "break": {
        // continue N、break N：跳出 N 层（不认得的按 1 层）；收进那几层循环
        const levels = Math.max(1, Number.parseInt(args[0]?.value ?? "1", 10) || 1);
        for (const frame of this.loops.slice(-levels)) (name === "continue" ? frame.continues : frame.breaks).push(this.snapshot());
        this.state.dead = true;
        return;
      }
      case "return":
        this.calling.at(-1)?.returns.push(this.snapshot());
        this.state.dead = true;
        return;
      case "exit":
        this.state.dead = true;
        return;
    }
  }

  private assignVar(a: Assignment): void {
    if (a.value.type === "ArrayValue" || a.index || a.append) this.forget(a.name);
    else this.assign(a.name, this.staticValues(a.value, false));
  }

  /** 确定的一次赋值：此后就是这些值（没法确定是 null） */
  private assign(name: string, values: string[] | null): void {
    this.state.vars.set(name, this.opaqueVars.has(name) ? null : values);
  }

  /** 此后没法确定；forever：之后怎么赋值都没法确定 */
  private forget(name: string, forever = false): void {
    if (forever) this.opaqueVars.add(name);
    this.state.vars.set(name, null);
  }

  /** 之后什么变量都没法确定（命令里没赋过的、环境里已知的也一样） */
  private havocAll(): void {
    for (const name of this.state.vars.keys()) this.state.vars.set(name, null);
    this.state.havoc = true;
  }

  // ───── 走到某一处的样子：存、取、合起来 ─────

  private snapshot(): FlowState {
    return { vars: new Map(this.state.vars), havoc: this.state.havoc, cwds: [...this.state.cwds], dead: this.state.dead };
  }

  private restore(s: FlowState): void {
    this.state = { vars: new Map(s.vars), havoc: s.havoc, cwds: [...s.cwds], dead: s.dead };
  }

  /** 两种可能合起来：每个变量的值都算，有一边没法确定就没法确定；命令里没赋过的那一边按原来的值。走不到的那一边不算 */
  private join(a: FlowState, b: FlowState): FlowState {
    if (a.dead !== b.dead) return copyState(a.dead ? b : a);
    const vars = new Map<string, string[] | null>();
    for (const name of new Set([...a.vars.keys(), ...b.vars.keys()])) {
      const x = a.vars.has(name) ? a.vars.get(name)! : this.prior(name, a.havoc);
      const y = b.vars.has(name) ? b.vars.get(name)! : this.prior(name, b.havoc);
      const both = x === null || y === null ? null : unique([...x, ...y]);
      vars.set(name, both !== null && both.length > MAX_ALTERNATIVES ? null : both);
    }
    return { vars, havoc: a.havoc || b.havoc, cwds: unique([...a.cwds, ...b.cwds]), dead: a.dead };
  }

  /** 命令里没赋过的变量原来的值：用户主目录类、agent 的 bash 带着的已知环境变量；别的（和 source 过之后的）没法确定 */
  private prior(name: string, havoc: boolean): string[] | null {
    if (havoc) return null;
    if (HOME_VARS.has(name)) return [this.env.homeDir];
    // 这个 agent 的 bash 带着的、值已知的环境变量（77 号票：事件的值；177 号票：TMPDIR 这些）
    const known = this.env.vars?.[name];
    return known === undefined ? null : [known];
  }

  private variable(name: string): string[] | null {
    if (this.opaqueVars.has(name)) return null;
    return this.state.vars.has(name) ? this.state.vars.get(name)! : this.prior(name, this.state.havoc);
  }

  /** 按程序表把一条简单命令映射成伪工具调用 */
  private run(argv: ShellWord[], text: string, stdin: boolean, dynamicEnv = false): void {
    const unseenInput = stdin || dynamicEnv || argv.some((w) => w.value === null);
    runProgram(this.programContext(text, stdin, unseenInput), argv);
  }

  private programContext(text: string, stdin: boolean, unseenInput: boolean): ProgramContext {
    return {
      text,
      stdin,
      unseenInput,
      emit: (tool, args, unseen) => this.push(unseen ? { tool, args, text, unseenInput: true } : { tool, args, text }),
      opaque: (reason) => this.push(opaqueCall(reason, text)),
      path: (word) => this.resolve(word),
      cwd: () => single(this.state.cwds),
      cd: (word) => {
        // cd 成功之后的目录；失败的可能由语句、&& 链和 || 的合并兜住
        const home = this.variable("HOME");
        const targets = word === undefined ? (home ?? [unresolvedPath("$HOME")]) : this.resolveAll(word);
        if (targets.length > 0) this.state.cwds = targets;
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
    // `~` 是此刻的 HOME（命令里改过就按改的）
    const home = this.variable("HOME");
    const homes = home ?? [unresolvedPath("$HOME")];
    const out: string[] = [];
    for (const value of values) {
      for (const cwd of this.state.cwds) {
        for (const homeDir of value.startsWith("~") ? homes : [this.env.homeDir]) {
          const r = resolveAgentPath(value, { cwd, homeDir, ...(this.env.tmpMount === undefined ? {} : { tmpMount: this.env.tmpMount }) });
          if (r.kind === "absolute") out.push(r.path);
          else if (r.kind === "unknown") out.push(unresolvedPath(r.raw));
        }
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
    // 只往末尾追加的（>>、&>>）带上 append：不碰原有的内容（54 号票，guard/nature.ts 据此算动手而不是删改）
    const append = r.operator === ">>" || r.operator === "&>>";
    this.push({ tool, args: append ? { path, append: true } : { path }, text });
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
        // ${A=…}、${A:=…} 顺手给 A 赋了值
        if (op.type === "Default" && (op.operator === "=" || op.operator === ":=")) this.forget(p.parameter);
        return;
      }
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (p.script) this.subshell(() => this.script(p.script!, source));
        else if (this.dry === 0) this.errors.push(t("guard.shell.badSubstitution", { text: p.text }));
        return;
      case "ArithmeticExpansion":
        if (p.expression) this.arithmetic(p.expression, source);
        return;
      case "BraceExpansion":
      case "ExtendedGlob":
        for (const child of p.parts ?? []) this.part(child, source);
        return;
      default:
        if (this.dry === 0) this.errors.push(t("guard.shell.unknownPart", { type: (p as { type: string }).type }));
    }
  }

  /** 子 shell（`( … )`、命令替换、进程替换、协进程）：里面的赋值、cd、exit 不往外传 */
  private subshell(run: () => void): void {
    const before = this.snapshot();
    // 子 shell 里的 continue、break、return 出不去：照样收进外面的循环、函数只是多算
    run();
    this.restore(before);
  }

  private arithmetic(e: ArithmeticExpression, source: string): void {
    switch (e.type) {
      case "ArithmeticBinary":
        // 算术里的赋值（A = 1、A += 2……）：值是算出来的，按没法确定
        if (ARITHMETIC_ASSIGN.has(e.operator) && e.left.type === "ArithmeticWord" && IDENTIFIER.test(e.left.value)) this.forget(e.left.value);
        this.arithmetic(e.left, source);
        this.arithmetic(e.right, source);
        return;
      case "ArithmeticUnary":
        if ((e.operator === "++" || e.operator === "--") && e.operand.type === "ArithmeticWord" && IDENTIFIER.test(e.operand.value)) this.forget(e.operand.value);
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
        if (e.script) this.subshell(() => this.script(e.script!, source));
        else if (this.dry === 0) this.errors.push(t("guard.shell.badSubstitution", { text: e.text }));
        return;
    }
  }

  /** 命令里的一个词（命令名、参数、重定向的目标）：静态值去掉引号；已知的变量换成它可能的值；别的展开没法静态确定 */
  private toWord(word: Word): ShellWord {
    const values = this.staticValues(word, true);
    const shape = pathTextOf(word);
    const base = shape === word.text ? {} : { pathText: shape };
    if (values === null) return { value: null, text: word.text, ...base };
    if (values.length === 1) return { value: values[0]!, text: word.text, ...base };
    return { value: null, text: word.text, alternatives: values, ...base };
  }

  /**
   * 词可能的静态值；没法确定时为 null。split：这个词会被拆分（命令的参数、for 的词表；赋值的右边不拆）——
   * 不加引号的变量值里有空白、命令里改过 IFS 的，会被拆成几个词，按没法确定
   */
  private staticValues(word: Word, split: boolean): string[] | null {
    if (!word.parts) return [word.value];
    return this.partsValues(word.parts, split);
  }

  private partsValues(parts: readonly WordPart[], split: boolean): string[] | null {
    let out = [""];
    for (const p of parts) {
      const values = this.partValues(p, split);
      if (values === null) return null;
      out = out.flatMap((prefix) => values.map((v) => prefix + v));
      if (out.length > MAX_ALTERNATIVES) return null;
    }
    return out;
  }

  private partValues(p: WordPart, split: boolean): string[] | null {
    switch (p.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        return [p.value];
      case "DoubleQuoted":
      case "LocaleString":
        // 引号里的不拆
        return this.partsValues(p.parts, false);
      case "SimpleExpansion":
        return this.unquoted(this.variable(p.text.slice(1)), split);
      case "ParameterExpansion":
        return !p.prefix && !p.index && !p.operation ? this.unquoted(this.variable(p.parameter), split) : null;
      case "ArithmeticExpansion":
        // 算出来是一个整数：不会有路径分隔符、不会是 ..，按一个不跨目录的通配符算（改过 IFS 时不加引号的会被拆开）
        return split && this.splitsDifferently() ? null : [ARITHMETIC_RESULT];
      default:
        return null;
    }
  }

  /** 不加引号的变量展开：会被拆开的（值里有空白、命令里改过 IFS）没法确定 */
  private unquoted(values: string[] | null, split: boolean): string[] | null {
    if (!split || values === null) return values;
    if (this.splitsDifferently()) return null;
    return values.some((v) => /[ \t\n]/.test(v)) ? null : values;
  }

  /** IFS 可能被改过（命令里赋过、source 过）：不加引号的展开怎么拆说不准 */
  private splitsDifferently(): boolean {
    return this.state.vars.has("IFS") || this.state.havoc;
  }
}

function copyState(s: FlowState): FlowState {
  return { vars: new Map(s.vars), havoc: s.havoc, cwds: [...s.cwds], dead: s.dead };
}

/** case 判的是不是一个变量（`$x`、`"$x"`、`${x}`）：是的话返回变量名 */
function caseSubject(word: Word): string | undefined {
  let parts = word.parts ?? [];
  if (parts.length === 1 && parts[0]!.type === "DoubleQuoted") parts = parts[0]!.parts;
  if (parts.length !== 1) return undefined;
  const p = parts[0]!;
  const name = p.type === "SimpleExpansion" ? p.text.slice(1) : p.type === "ParameterExpansion" && !p.prefix && !p.index && !p.operation ? p.parameter : undefined;
  return name !== undefined && IDENTIFIER.test(name) ? name : undefined;
}

/** case 的模式是不是一个字面的词（不带引号、通配符、转义） */
function isLiteralPattern(w: Word): boolean {
  return w.parts === undefined && w.value !== "" && !/[*?[\]\\]/.test(w.value);
}

const HOME_VARS = new Set(["HOME", "USERPROFILE"]);
/** 一个词最多展开成几个可能的值，再多就当没法确定 */
const MAX_ALTERNATIVES = 64;
/** 推循环回头最多推几遍，还在变的放弃成没法确定 */
const MAX_LOOP_PASSES = 4;
/** 算术展开的结果：一个整数，按不跨目录的通配符算 */
const ARITHMETIC_RESULT = "*";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 声明变量的内建命令：不带选项的赋值和普通赋值一样 */
const DECLARES = new Set(["export", "local", "declare", "typeset", "readonly"]);
const ARITHMETIC_ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);

/**
 * && 链里这一段会不会失败（链子停在这里）：只赋值的（`A=x`、不带选项的 `export A=x`）、true、`:` 不会——
 * 带重定向、命令替换、算术展开、${A:?…} 这类展开的照样可能失败
 */
function mayFail(node: PipelineNode): boolean {
  if (node.type !== "Command") return true;
  const items = [...node.prefix, ...node.suffix];
  if (items.some((item) => item.type !== "Word" && item.type !== "Assignment")) return true;
  const words = items.flatMap((item): readonly Word[] => (item.type === "Assignment" ? (item.value.type === "ArrayValue" ? item.value.elements : [item.value]) : item.type === "Word" ? [item] : []));
  if (words.some(hasExpansionThatMayFail)) return true;
  if (!node.name) return false;
  const name = node.name.value;
  return !(name === "true" || name === ":" || (DECLARES.has(name) && node.suffix.every((item) => item.type === "Assignment")));
}

function hasExpansionThatMayFail(word: Word): boolean {
  return partsMayFail(word.parts);
}

function partsMayFail(parts: readonly WordPart[] | undefined): boolean {
  return (parts ?? []).some(
    (p) =>
      p.type === "CommandExpansion" ||
      p.type === "ProcessSubstitution" ||
      p.type === "ArithmeticExpansion" ||
      ((p.type === "DoubleQuoted" || p.type === "LocaleString") && partsMayFail(p.parts)) ||
      (p.type === "ParameterExpansion" && p.operation !== undefined),
  );
}

/**
 * 词的原文去掉命令替换（$(...)、反引号）、进程替换、算术展开之后的样子：没法确定的词像不像路径按它看——
 * "$(cat a/b)" 里的斜杠是里面那条命令的，不说明它的值是路径（和 "$X" 一样）；"$(pwd)/out" 照旧像路径
 */
function pathTextOf(word: Word): string {
  return word.parts ? partsPathText(word.parts) : word.text;
}

function partsPathText(parts: readonly WordPart[]): string {
  return parts
    .map((p) => {
      switch (p.type) {
        case "CommandExpansion":
        case "ProcessSubstitution":
        case "ArithmeticExpansion":
          return "";
        case "DoubleQuoted":
        case "LocaleString":
          return `"${partsPathText(p.parts)}"`;
        default:
          return p.text;
      }
    })
    .join("");
}

function sameValues(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return a === null || b === null ? a === b : sameSet(a, b);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function sameState(a: FlowState, b: FlowState): boolean {
  if (a.dead !== b.dead || a.havoc !== b.havoc || a.vars.size !== b.vars.size || !sameSet(a.cwds, b.cwds)) return false;
  for (const [name, values] of a.vars) {
    if (!b.vars.has(name) || !sameValues(values, b.vars.get(name)!)) return false;
  }
  return true;
}

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
