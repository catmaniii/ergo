// Claude Code 的工具调用都过二狗守卫（288 号票，issue 24 用户答复第 4 条"所有工具调用都经二狗守卫"、方案 2.4）。
// 全量闸口是二狗交给 SDK 的 PreToolUse 钩子——canUseTool 只在 Claude Code 自己的权限系统本来就要问人时才叫（用户设置里放行过的、内置的安全命令
// 直接过），不是全量闸口（调研 32 第 4.2 节）；钩子每次工具调用都过，子代理里的也过（钩子输入带 agent_id）。每次调用：
// - 先让翻译那一层赶上（钩子可能比前面那条回复先到手），确保这次调用报过 tool_call_start，再发 guard_request（和 pi 一样：开始在前、判定在后）；
//   工具名和参数映射到守卫的工具登记表（toGuardCall），原样的放在 native 里（工具调用的完整内容存它）；
// - 守卫拦下 → permissionDecision: deny，模型收到守卫的说明；
// - 放行 → 不给决定，接着走 Claude Code 自己的权限（用户设置里的规则、权限模式照常；要问人时到 canUseTool，守卫放行过的在那里直接放行）。
//   钩子在规则之前，用户设置里的放行规则绕不过守卫；
// - 按计划改了参数（宿主协议 12 的 args）→ permissionDecision: allow + updatedInput（参数从守卫的说法映射回这个工具的，fromGuardArgs）；
//   映射不回去的（PowerShell、Notebook、一次改几处的 Edit）拦下、写明计划要的是什么；
// - 结果前面加话（resultPrefix）→ PostToolUse（出错的 PostToolUseFailure）钩子的 additionalContext，模型和结果一起看到；
//   二狗这边的工具调用结束（tool_call_end 的 resultText）前面也加上，和 pi 的记录一样（translator.ts 取 takePrefix）；
// - Claude 自己要问用户的（AskUserQuestion、ExitPlanMode）守卫放行后 permissionDecision: ask，到 canUseTool 变成二狗的提问卡：报 ask_user、
//   等 ask_user_reply——选择题的回答按 SDK 的写法交回（updatedInput.answers：题目 → 回答，多选的用逗号连起来），计划批准就放行、打回就拒绝并转达你的话；
// - 回合中止（SDK 给钩子、canUseTool 的中止信号）：等着的判定、提问按"不放行 / 没答"收尾。
// 钩子的超时给到一天：钩子超时 Claude Code 当作钩子出错、接着走它自己的权限，等于没过守卫；守护进程这边等审批有自己的时限，总会回判定。
// 291 号票：二狗交给 Claude 的工具（进程内 MCP 服务，host-tools.ts）——mcp__ergo__<工具名> 映射成二狗的工具名、参数原样，守卫按那个工具的登记判；
// 工具包里的 MCP 两边同名，原样判。这些工具守卫放行了就 permissionDecision: allow（二狗的工具二狗自己管，不再走 Claude Code 自己的权限提示；
// 用户的 deny 规则照样赢）。PostToolUse 要交给模型的话由会话合在一起（守卫的这一份是 postToolContext，会话另有工具包变更的通知）。
// @i18n-ignore-file model：交回 Claude、给模型看的说明（守卫的说明本来就是中文）；日志
import type { CanUseTool, HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeChoiceQuestion, RuntimeQuestion, RuntimeQuestionReply } from "@ergo/protocol";
import type { AgentReport, GuardVerdict } from "../../runtime/host-protocol.ts";
import { hostToolNameOf } from "./host-tools.ts";

/** 钩子最多等多久（秒）：见文件开头 */
export const GUARD_HOOK_TIMEOUT_S = 24 * 60 * 60;

/** Claude 自己要问用户的工具：守卫放行之后到 canUseTool，变成二狗的提问卡 */
export const ASKS_USER: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

type Input = Record<string, unknown>;

/** 一个能对上二狗工具的 Claude 工具：守卫里叫什么、参数怎么换过去、守卫按计划改过的参数怎么换回来（换不回来是 undefined） */
interface Mapping {
  guardName: string;
  toGuard(input: Input): Input;
  fromGuard(input: Input, args: Input): Input | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** 去掉值是 undefined 的键（模型没给的参数不写进守卫看的参数） */
const defined = (input: Input): Input => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

type GuardEdit = { oldText: string; newText: string };
function editsOf(args: Input): GuardEdit[] | undefined {
  const edits = args.edits;
  if (!Array.isArray(edits)) return undefined;
  const out = edits.filter((e): e is GuardEdit => typeof e === "object" && e !== null && typeof (e as GuardEdit).oldText === "string" && typeof (e as GuardEdit).newText === "string");
  return out.length === edits.length ? out : undefined;
}

/** 守卫拆不开 PowerShell 的命令：写成 powershell -Command '…'，守卫照内联命令按未知的写操作判（随 bash 开关） */
function powershellCommand(command: string): string {
  return `powershell -Command '${command.replaceAll("'", `'\\''`)}'`;
}

/** 只换路径参数名的（路径和别的参数一一对得上） */
const pathTool = (guardName: string, from: string, to = "path"): Mapping => ({
  guardName,
  toGuard: (i) => defined({ [to]: i[from] }),
  fromGuard: (i, a) => (typeof a[to] === "string" ? { ...i, [from]: a[to] } : undefined),
});

/** 搜索类（Glob → find、Grep → grep）：pattern、path 照搬 */
const searchTool = (guardName: string): Mapping => ({
  guardName,
  toGuard: (i) => defined({ pattern: i.pattern, path: i.path }),
  fromGuard: (i, a) => ({ ...i, ...(typeof a.pattern === "string" ? { pattern: a.pattern } : {}), ...(typeof a.path === "string" ? { path: a.path } : {}) }),
});

/** Claude 的工具 → 守卫工具登记表里的（照 SDK 0.3.296 的 sdk-tools.d.ts；MultiEdit、LS 是以前版本的，照样认） */
const MAPPINGS: Readonly<Record<string, Mapping>> = {
  Bash: { guardName: "bash", toGuard: (i) => ({ command: str(i.command) ?? "" }), fromGuard: (i, a) => (typeof a.command === "string" ? { ...i, command: a.command } : undefined) },
  PowerShell: { guardName: "bash", toGuard: (i) => ({ command: powershellCommand(str(i.command) ?? "") }), fromGuard: () => undefined },
  Read: pathTool("read", "file_path"),
  Write: {
    guardName: "write",
    toGuard: (i) => defined({ path: i.file_path, content: i.content }),
    fromGuard: (i, a) => (typeof a.path === "string" && typeof a.content === "string" ? { ...i, file_path: a.path, content: a.content } : undefined),
  },
  Edit: {
    guardName: "edit",
    toGuard: (i) => defined({ path: i.file_path, edits: [{ oldText: str(i.old_string) ?? "", newText: str(i.new_string) ?? "" }] }),
    fromGuard: (i, a) => {
      const edits = editsOf(a);
      if (typeof a.path !== "string" || edits?.length !== 1) return undefined;
      return { ...i, file_path: a.path, old_string: edits[0]!.oldText, new_string: edits[0]!.newText };
    },
  },
  MultiEdit: {
    guardName: "edit",
    toGuard: (i) =>
      defined({
        path: i.file_path,
        edits: (Array.isArray(i.edits) ? (i.edits as Input[]) : []).map((e) => ({ oldText: str(e.old_string) ?? "", newText: str(e.new_string) ?? "" })),
      }),
    fromGuard: (i, a) => {
      const edits = editsOf(a);
      if (typeof a.path !== "string" || !edits) return undefined;
      return { ...i, file_path: a.path, edits: edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })) };
    },
  },
  NotebookEdit: { guardName: "edit", toGuard: (i) => defined({ path: i.notebook_path, edits: [{ oldText: "", newText: str(i.new_source) ?? "" }] }), fromGuard: () => undefined },
  Glob: searchTool("find"),
  Grep: searchTool("grep"),
  LS: pathTool("ls", "path"),
  WebFetch: pathTool("web_fetch", "url", "url"),
  WebSearch: pathTool("web_search", "query", "query"),
};

/** 一次 Claude 工具调用在守卫眼里是什么：能对上二狗工具的换成它，别的照原名原样（由运行时登记的、没登记的守卫各按各的判） */
export function toGuardCall(toolName: string, input: Input): { toolName: string; args: Input } {
  const mapping = MAPPINGS[toolName];
  return mapping ? { toolName: mapping.guardName, args: mapping.toGuard(input) } : { toolName: hostToolNameOf(toolName), args: input };
}

/** 守卫按计划改过的参数（守卫的说法）换回这个 Claude 工具的参数；换不回去是 undefined。没映射的工具守卫看的就是原样，改过的直接用 */
export function fromGuardArgs(toolName: string, input: Input, args: Input): Input | undefined {
  const mapping = MAPPINGS[toolName];
  return mapping ? mapping.fromGuard(input, args) : args;
}

export interface ClaudeGuardDeps {
  emit: (report: AgentReport) => void;
  /**
   * 发判定请求之前：让翻译那一层赶上、确保这次调用报过 tool_call_start（钩子比那条回复先到手时由这里先报）
   */
  ensureStarted: (toolCallId: string, toolName: string, args: unknown) => void;
  /** 这是二狗交给 Claude 的工具（Claude 的工具名；291 号票）：守卫放行了就直接 allow */
  ownTool?: (claudeName: string) => boolean;
  log: (line: string) => void;
}

const isRecord = (value: unknown): value is Input => typeof value === "object" && value !== null && !Array.isArray(value);

/** 让一轮宏任务过去：SDK 先到手的消息在微任务里交给消费循环，这之后翻译那一层就赶上了 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

export class ClaudeGuard {
  private seq = 0;
  private readonly guardWaits = new Map<string, (verdict: GuardVerdict) => void>();
  private readonly askWaits = new Map<string, (reply: RuntimeQuestionReply) => void>();
  /** 守卫放行了的调用（工具调用 id）：Claude 自己的权限再要问人时（canUseTool）直接放行 */
  private readonly approved = new Set<string>();
  /** 守卫要在结果前面加的话（工具调用 id → 话）：PostToolUse 交给模型，工具调用结束时记录里也加上（takePrefix） */
  private readonly prefixes = new Map<string, string>();
  /** 只交给模型、不进结果的话（批准计划时你附的话） */
  private readonly notes = new Map<string, string>();
  private readonly deps: ClaudeGuardDeps;

  constructor(deps: ClaudeGuardDeps) {
    this.deps = deps;
  }

  /** 交给 SDK 的钩子：PreToolUse 是全量闸口（PostToolUse、PostToolUseFailure 由会话合着交，守卫的那份见 postToolContext） */
  hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
      PreToolUse: [{ hooks: [(input, _id, { signal }) => this.preToolUse(input, signal)], timeout: GUARD_HOOK_TIMEOUT_S }],
    };
  }

  /** 交给 SDK 的 canUseTool：Claude 自己要问人时才叫 */
  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const { toolUseID, signal, agentID } = options;
    if (!this.approved.has(toolUseID)) return { behavior: "deny", message: "二狗的守卫没有判过这次调用，不放行。" };
    if (toolName === "AskUserQuestion") return this.askChoices(toolUseID, input, agentID, signal);
    if (toolName === "ExitPlanMode") return this.askPlan(toolUseID, input, agentID, signal);
    // 守卫放行过的，Claude Code 自己要问的不再问（二狗就是审批的那一侧）
    return { behavior: "allow", updatedInput: input };
  };

  /** 守护进程的判定到了；没有在等的是 false */
  replyGuard(requestId: string, verdict: GuardVerdict): boolean {
    const resolve = this.guardWaits.get(requestId);
    if (!resolve) return false;
    this.guardWaits.delete(requestId);
    resolve(verdict);
    return true;
  }

  /** 提问卡上的回答到了；没有在等的是 false */
  replyAsk(requestId: string, reply: RuntimeQuestionReply): boolean {
    const resolve = this.askWaits.get(requestId);
    if (!resolve) return false;
    this.askWaits.delete(requestId);
    resolve(reply);
    return true;
  }

  /** 工具调用结束时记录里结果前面要加的话（取了就不再记着） */
  takePrefix(toolCallId: string): string | undefined {
    const prefix = this.prefixes.get(toolCallId);
    this.prefixes.delete(toolCallId);
    this.approved.delete(toolCallId);
    return prefix;
  }

  private async preToolUse(input: HookInput, signal: AbortSignal): Promise<HookJSONOutput> {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: toolName, tool_use_id: toolCallId } = input;
    const native = isRecord(input.tool_input) ? input.tool_input : {};
    await tick();
    this.deps.ensureStarted(toolCallId, toolName, native);
    const call = toGuardCall(toolName, native);
    const verdict = await this.wait<GuardVerdict>(this.guardWaits, "guard", signal, { allow: false, reason: "回合已中止" }, (requestId) => ({
      type: "guard_request",
      requestId,
      toolCallId,
      toolName: call.toolName,
      args: call.args,
      native: { toolName, args: native },
    }));
    if (!verdict.allow) return deny(verdict.reason);
    if (verdict.args) {
      const updated = fromGuardArgs(toolName, native, verdict.args);
      if (!updated) return deny(`二狗按计划要把这次调用改成 ${call.toolName} ${JSON.stringify(verdict.args)}，${toolName} 工具照这样执行不了；请按计划的写法换个工具再调用。`);
      this.allow(toolCallId, verdict.resultPrefix);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: updated } };
    }
    this.allow(toolCallId, verdict.resultPrefix);
    if (ASKS_USER.has(toolName)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    if (this.deps.ownTool?.(toolName)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    return {};
  }

  private allow(toolCallId: string, prefix: string | undefined): void {
    this.approved.add(toolCallId);
    if (prefix) this.prefixes.set(toolCallId, prefix);
  }

  /** 工具调用结束（PostToolUse、PostToolUseFailure）时守卫要交给模型的话：结果前面加的话、批准计划时你附的话；没有是 undefined */
  postToolContext(input: HookInput): string | undefined {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return undefined;
    const context = [this.prefixes.get(input.tool_use_id), this.notes.get(input.tool_use_id)].filter((s): s is string => Boolean(s)).join("\n");
    this.notes.delete(input.tool_use_id);
    return context || undefined;
  }

  /** AskUserQuestion：变成二狗的提问卡；回答按 SDK 的写法交回（题目 → 回答，多选的用逗号连起来） */
  private async askChoices(toolCallId: string, input: Input, agentID: string | undefined, signal: AbortSignal): Promise<PermissionResult> {
    const questions = choiceQuestionsOf(input.questions);
    if (!questions) return { behavior: "deny", message: "问题的格式不对，二狗没法交给用户。" };
    const reply = await this.ask(toolCallId, { kind: "choices", questions }, agentID, signal);
    if (reply.kind !== "choices") return { behavior: "deny", message: declinedText(reply, "用户没有回答这些问题") };
    const answers = Object.fromEntries(reply.answers.map((a) => [a.question, [...a.selected, ...(a.other ? [a.other] : [])].join(", ")]));
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /** ExitPlanMode：计划交给你批准；批准就放行（你附的话和结果一起交给模型），打回就拒绝、转达你的话 */
  private async askPlan(toolCallId: string, input: Input, agentID: string | undefined, signal: AbortSignal): Promise<PermissionResult> {
    const plan = str(input.plan) ?? "";
    const reply = await this.ask(toolCallId, { kind: "plan", plan }, agentID, signal);
    if (reply.kind === "plan" && reply.approved) {
      if (reply.note) this.notes.set(toolCallId, `用户批准了计划，还说：${reply.note}`);
      return { behavior: "allow", updatedInput: input };
    }
    if (reply.kind === "plan") return { behavior: "deny", message: `用户没有批准这份计划，接着计划、先别动手${reply.note ? `。用户说：${reply.note}` : "。"}` };
    return { behavior: "deny", message: declinedText(reply, "用户没有批准这份计划") };
  }

  private ask(toolCallId: string, question: RuntimeQuestion, agentID: string | undefined, signal: AbortSignal): Promise<RuntimeQuestionReply> {
    return this.wait<RuntimeQuestionReply>(this.askWaits, "ask", signal, { kind: "declined", note: "回合已中止" }, (requestId) => ({
      type: "ask_user",
      requestId,
      toolCallId,
      question,
      ...(agentID ? { subAgent: true as const } : {}),
    }));
  }

  /** 发一条请求、等同一 requestId 的回复；中止信号到了按 aborted 收尾 */
  private wait<T>(waits: Map<string, (value: T) => void>, prefix: string, signal: AbortSignal, aborted: T, report: (requestId: string) => AgentReport): Promise<T> {
    const requestId = `${prefix}-${++this.seq}`;
    return new Promise<T>((resolve) => {
      if (signal.aborted) return resolve(aborted);
      waits.set(requestId, resolve);
      signal.addEventListener(
        "abort",
        () => {
          if (waits.delete(requestId)) resolve(aborted);
        },
        { once: true },
      );
      this.deps.emit(report(requestId));
    });
  }
}

/** 没答（点了不答、这一轮结束了、中止了）交回模型的话 */
function declinedText(reply: RuntimeQuestionReply, what: string): string {
  const note = reply.kind === "declined" ? reply.note : undefined;
  return `${what}${note ? `（${note}）` : ""}。不要替用户做决定；需要的话以后再问。`;
}

/** AskUserQuestion 的 questions → 提问卡的选择题；格式不对是 undefined */
function choiceQuestionsOf(value: unknown): RuntimeChoiceQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: RuntimeChoiceQuestion[] = [];
  for (const q of value) {
    if (!isRecord(q) || typeof q.question !== "string" || !Array.isArray(q.options)) return undefined;
    const options = q.options.filter(isRecord).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) ?? "", ...(typeof o.preview === "string" ? { preview: o.preview } : {}) }));
    if (options.length === 0 || options.some((o) => o.label === "")) return undefined;
    out.push({ question: q.question, header: str(q.header) ?? "", options, multiSelect: q.multiSelect === true });
  }
  return out;
}
