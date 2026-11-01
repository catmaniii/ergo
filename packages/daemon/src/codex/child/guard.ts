// Codex 的工具调用都过二狗守卫（用户第 4 条决定，ADR-0046）。接在三个口子上，每次调用只判一次（decide 按调用 id 记着），谁先到谁发 guard_request：
// 1. PreToolUse 钩子（guard-hook.ts 转到 hook）：Codex 执行命令、改文件、调 MCP 工具之前。能拦、能写明原因、能改参数，是主闸口。deny 之后 Codex 不一定再报条目，这里当场报结束；
// 2. 审批请求（approveCommand、approveFile、approvePermissions、elicitation）：审批策略固定最严的 untrusted、送到二狗（approvalsReviewer: user）。钩子放行过的直接 accept（二狗就是审批的那一侧）；
//    钩子没拦到的（没生效、没覆盖到）在这里判。不放行回 decline（说不了原因，模型只知道被拒了）。不回 acceptForSession：那会让之后的同类调用不再问；
// 3. item/started 上的事后核对（audit）：前两个口子都没判过的条目（联网搜索这种 Codex 在服务端做的、看图、被 Codex 判成安全的只读命令而钩子又没拦到的）。
//    已经在跑了，拦不住：照样发 guard_request（守护进程按它记这次调用，不发就没有记录），不放行就立刻打断这一轮。这是要上报用户的缺口，见 ADR-0046。
// 工具名和参数映射到守卫的工具登记表（toGuardCall），原样的放在 native。回合中止：等着的判定、提问按"不放行 / 没答"收尾。
// @i18n-ignore-file model：交回 Codex、给模型看的说明（守卫的说明本来就是中文）；日志
import type { RuntimeChoiceQuestion, RuntimeQuestion, RuntimeQuestionReply } from "@ergo/protocol";
import type { AgentReport, GuardVerdict } from "../../runtime/host-protocol.ts";
import { type CodexToolCall, pathsOfPatch } from "./translator.ts";

type Input = Record<string, unknown>;

const isRecord = (value: unknown): value is Input => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** 钩子给 Codex 的不放行 */
export const denyOutput = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** 一次钩子来的 Codex 调用在守卫眼里是什么：命令 → bash；补丁 → apply_patch（看不出改哪些文件的不写路径，名字换掉，照未登记的写操作判）；别的照原名原样 */
export function toGuardCall(id: string, toolName: string, input: Input): CodexToolCall {
  const native = { toolName, args: input };
  if (toolName === "Bash") return { id, toolName: "bash", args: { command: str(input.command) ?? "" }, native };
  if (toolName === "apply_patch" || toolName === "Write" || toolName === "Edit") {
    const patch = str(input.command) ?? "";
    const paths = pathsOfPatch(patch);
    return paths ? { id, toolName: "apply_patch", args: { ...paths, patch }, native } : { id, toolName: "apply_patch_unparsed", args: { patch }, native };
  }
  return { id, toolName, args: input, native };
}

/** 守卫按计划改过的参数换回这个工具的参数；换不回去是 undefined */
export function fromGuardArgs(call: CodexToolCall, args: Input): Input | undefined {
  if (call.toolName === "bash") return typeof args.command === "string" ? { ...(call.native.args as Input), command: args.command } : undefined;
  if (call.toolName === "apply_patch") return typeof args.patch === "string" ? { command: args.patch } : undefined;
  return args;
}

export interface CodexGuardDeps {
  emit: (report: AgentReport) => void;
  /** 这次调用报开始（还没报过的话）；parent：子代理里的调用，派它的那次 */
  ensureStarted: (call: CodexToolCall, parent?: string) => void;
  /** 这次调用报结束 */
  end: (id: string, isError: boolean, text: string, parent?: string) => void;
  /** 这个 thread 是哪次调用派的子代理（钩子的 session_id 是子代理的 thread） */
  parentOf: (threadId: string | undefined) => string | undefined;
  /** 结果前面要加的话 */
  addPrefix: (id: string, prefix: string) => void;
  /** 判定回来了（先记着的结束可以报了） */
  settled: (id: string) => void;
  /** 事后核对判了不放行：打断这一轮 */
  interrupt: () => void;
  /** 是二狗交给 Codex 的工具（mcp__ergo__*）：在中转那边过守卫，这里不判 */
  ownTool: (toolName: string) => boolean;
  /** 现在在写交接摘要（临时分叉里）：什么工具都不让用 */
  sealed: () => boolean;
  /** 开着守卫（正式的会话都开；只有测试里直接拉起的不开：要问的一律拒绝） */
  enabled: boolean;
  log: (line: string) => void;
}

interface Decision {
  call: CodexToolCall;
  verdict: Promise<GuardVerdict>;
  /** 判定回来了 */
  done: boolean;
  /** 有能拦的口子（钩子、审批）在等这个判定 */
  blocking: boolean;
}

/** 事后核对判了不放行之后，等一小会儿再打断：审批请求可能紧跟着条目到，那时能正经拦下 */
const AUDIT_INTERRUPT_DELAY_MS = 200;

export class CodexGuard {
  private seq = 0;
  private readonly decisions = new Map<string, Decision>();
  /** 钩子已经按判定改过参数的调用：审批时不用再管 */
  private readonly rewritten = new Set<string>();
  private readonly guardWaits = new Map<string, (verdict: GuardVerdict) => void>();
  private readonly askWaits = new Map<string, (reply: RuntimeQuestionReply) => void>();
  private readonly deps: CodexGuardDeps;

  constructor(deps: CodexGuardDeps) {
    this.deps = deps;
  }

  /** 这次调用的判定：判过的直接用；没判过的报开始、发 guard_request */
  decide(call: CodexToolCall, blocking: boolean, parent?: string): Promise<GuardVerdict> {
    const known = this.decisions.get(call.id);
    if (known) {
      known.blocking ||= blocking;
      return known.verdict;
    }
    this.deps.ensureStarted(call, parent);
    const requestId = `guard-${++this.seq}`;
    const decision: Decision = {
      call,
      blocking,
      done: false,
      verdict: new Promise<GuardVerdict>((resolve) => {
        this.guardWaits.set(requestId, (verdict) => {
          decision.done = true;
          resolve(verdict);
          this.deps.settled(call.id);
        });
      }),
    };
    this.decisions.set(call.id, decision);
    this.deps.emit({ type: "guard_request", requestId, toolCallId: call.id, toolName: call.toolName, args: call.args, native: call.native });
    return decision.verdict;
  }

  /** 这次调用的判定还没回（结束先不报） */
  pending(id: string): boolean {
    const decision = this.decisions.get(id);
    return decision !== undefined && !decision.done;
  }

  /** 判定过（或正在判）的调用 */
  known(id: string): boolean {
    return this.decisions.has(id);
  }

  /** 守护进程的判定到了；没有在等的是 false */
  replyGuard(requestId: string, verdict: GuardVerdict): boolean {
    const resolve = this.guardWaits.get(requestId);
    if (!resolve) return false;
    this.guardWaits.delete(requestId);
    resolve(verdict);
    return true;
  }

  replyAsk(requestId: string, reply: RuntimeQuestionReply): boolean {
    const resolve = this.askWaits.get(requestId);
    if (!resolve) return false;
    this.askWaits.delete(requestId);
    resolve(reply);
    return true;
  }

  /** 这一轮中止、结束了：等着的判定按不放行、提问按没答收尾 */
  abortAll(reason: string): void {
    for (const [requestId, resolve] of this.guardWaits) {
      this.guardWaits.delete(requestId);
      resolve({ allow: false, reason });
    }
    for (const [requestId, resolve] of this.askWaits) {
      this.askWaits.delete(requestId);
      resolve({ kind: "declined", note: reason });
    }
  }

  /** 这一轮结束了：判过的不用再记着 */
  endTurn(): void {
    this.decisions.clear();
    this.rewritten.clear();
  }

  /** 口子 1：PreToolUse 钩子。交回写给 Codex 的 JSON（空对象是不管，接着走它自己的流程） */
  async hook(payload: Input): Promise<unknown> {
    const toolName = str(payload.tool_name) ?? "";
    const id = str(payload.tool_use_id) ?? "";
    const input = isRecord(payload.tool_input) ? payload.tool_input : {};
    if (this.deps.ownTool(toolName)) return {};
    if (this.deps.sealed()) return denyOutput("这一轮只写交接摘要，不调用工具。");
    if (id === "") return denyOutput("这次调用没有调用 id，二狗的守卫没法记录，不放行。");
    const call = toGuardCall(id, toolName, input);
    const parent = this.deps.parentOf(str(payload.session_id));
    const verdict = await this.decide(call, true, parent);
    if (!verdict.allow) {
      this.deps.end(id, true, verdict.reason, parent);
      return denyOutput(verdict.reason);
    }
    if (verdict.resultPrefix) this.deps.addPrefix(id, verdict.resultPrefix);
    if (verdict.args) {
      const updated = fromGuardArgs(call, verdict.args);
      if (!updated) {
        const reason = `二狗按计划要把这次调用改成 ${call.toolName} ${JSON.stringify(verdict.args)}，${toolName} 照这样执行不了；请按计划的写法换个工具再调用。`;
        this.deps.end(id, true, reason, parent);
        return denyOutput(reason);
      }
      this.rewritten.add(id);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: updated, ...(verdict.resultPrefix ? { additionalContext: verdict.resultPrefix } : {}) } };
    }
    return verdict.resultPrefix ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.resultPrefix } } : {};
  }

  /** 口子 2：一次审批。call：这次调用；放行是 true */
  async approve(call: CodexToolCall): Promise<boolean> {
    if (this.deps.sealed() || !this.deps.enabled) return false;
    const verdict = await this.decide(call, true);
    if (!verdict.allow) this.deps.log(`审批请求按守卫的判定拒了 ${call.toolName}（${call.id}）：${verdict.reason}`);
    else if (verdict.args && !this.rewritten.has(call.id)) {
      // 审批回不了改过的参数（钩子没拦到才走到这）：拒掉，模型照计划重来
      this.deps.log(`审批请求改不了参数，拒了 ${call.toolName}（${call.id}）`);
      return false;
    }
    return verdict.allow;
  }

  /** 口子 3：条目开始了、前两个口子都没判过的（见文件开头） */
  audit(call: CodexToolCall): void {
    if (!this.deps.enabled || this.decisions.has(call.id)) return;
    this.deps.log(`条目开始时还没过守卫（钩子没拦到）：${call.native.toolName}（${call.id}），事后核对`);
    void this.decide(call, false).then((verdict) => {
      if (verdict.allow) return;
      setTimeout(() => {
        if (this.decisions.get(call.id)?.blocking === true) return;
        this.deps.log(`事后核对判了不放行、已经拦不住：${call.native.toolName}（${call.id}）：${verdict.reason}。打断这一轮`);
        this.deps.interrupt();
      }, AUDIT_INTERRUPT_DELAY_MS).unref();
    });
  }

  /** Codex 自己要问用户的（item/tool/requestUserInput）：变成二狗的提问卡；答案按它的写法交回 */
  async askUser(params: Input): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const raw = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
    const questions: RuntimeChoiceQuestion[] = raw.map((q) => ({
      question: str(q.question) ?? "",
      header: str(q.header) ?? "",
      options: (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) ?? "" })),
      multiSelect: false,
    }));
    if (questions.length === 0 || this.deps.sealed() || !this.deps.enabled) return { answers: {} };
    const reply = await this.ask(str(params.itemId) ?? "", { kind: "choices", questions });
    if (reply.kind !== "choices") return { answers: {} };
    const answers: Record<string, { answers: string[] }> = {};
    raw.forEach((q, index) => {
      const given = reply.answers.find((a) => a.question === questions[index]!.question);
      if (given && typeof q.id === "string") answers[q.id] = { answers: [...given.selected, ...(given.other ? [given.other] : [])] };
    });
    return { answers };
  }

  private ask(toolCallId: string, question: RuntimeQuestion): Promise<RuntimeQuestionReply> {
    const requestId = `ask-${++this.seq}`;
    return new Promise((resolve) => {
      this.askWaits.set(requestId, resolve);
      this.deps.emit({ type: "ask_user", requestId, toolCallId, question });
    });
  }
}
