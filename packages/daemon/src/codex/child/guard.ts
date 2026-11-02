// Codex 的工具调用都过二狗守卫（用户第 4 条决定，ADR-0046）。接在三个口子上，每次调用只判一次（decide 按调用 id 记着），谁先到谁发 guard_request：
// 1. PreToolUse 钩子（guard-hook.ts 转到 hook）：能拦、能写明原因、能改参数，是主闸口。实测 0.166（真的 codex + 假模型，test/codex/real-codex.test.ts）：
//    命令（只读的 dir、git status 也过）、补丁、MCP、看图、sleep、goal、子代理工具、代码模式 exec 里嵌套的调用都先到这里，tool_use_id 和条目 id 一致；deny 之后没有条目，这里当场报结束，模型收到原因；
//    不过钩子的：write_stdin（启动时关了 TTY，送不了字符）、tool_search、代码模式外层的 exec 和 wait（碰不到文件和网络）；
// 2. 审批请求（approveCommand、approveFile、approvePermissions、elicitation）：审批策略固定最严的 untrusted、送到二狗（approvalsReviewer: user）。钩子放行过的直接 accept（二狗就是审批的那一侧）；
//    钩子跑失败时在这里判（实测接得住）。不放行回 decline（说不了原因，模型只收到 rejected by user）。不回 acceptForSession：那会让之后的同类调用不再问；
// 3. 事后核对（audit）：前两个口子都没判过的（Codex 不管设置硬报的联网搜索、钩子跑失败又被 execpolicy 放行的命令、万一送进终端的字符）。
//    已经在跑了，拦不住：照样发 guard_request（守护进程按它记这次调用，不发就没有记录），不放行就打断这一轮。这是要上报用户的缺口，见 ADR-0046。
// 换目录跑的命令（模型写了 workdir）：钩子的 tool_input 只有 command，看不到目录，守卫按负责人的工作目录判的。实测顺序是钩子、条目、审批，条目和审批请求的 cwd 才是真的目录：
//    和负责人的工作目录不同时补判一次（cwdCheckOf，自己的调用 id <id>#cwd，单独一条记录）。审批等这次补判才回，不放行回 decline（approveCwd）；
//    没有审批可接的（execpolicy 放行的只读命令）已经在跑了，判了不放行只能打断这一轮（checkCwd）。
// 工具名和参数映射到守卫的工具登记表（toGuardCall），原样的放在 native。回合中止：等着的判定、提问按"不放行 / 没答"收尾。
// @i18n-ignore-file model：交回 Codex、给模型看的说明（守卫的说明本来就是中文）；日志
import type { RuntimeChoiceQuestion, RuntimeQuestion, RuntimeQuestionReply } from "@ergo/protocol";
import type { AgentReport, GuardVerdict } from "../../runtime/host-protocol.ts";
import { type CodexToolCall, commandForGuard, pathsOfPatch } from "./translator.ts";

type Input = Record<string, unknown>;

const isRecord = (value: unknown): value is Input => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** 钩子给 Codex 的不放行 */
export const denyOutput = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** 实测 0.166：钩子报的工具名把命名空间直接拼在前面（clocksleep、collaborationspawn_agent，没有分隔符） */
const HOOK_NAMESPACE = /^(?:clock|collaboration|multi_agent_v\d+)(?=[a-z_])/;
/** 钩子报的子代理工具名 → 协议（CollabAgentTool）和守卫登记表里的名字 */
const COLLAB_TOOLS: Readonly<Record<string, string>> = {
  spawn_agent: "spawnAgent",
  send_input: "sendInput",
  resume_agent: "resumeAgent",
  wait_agent: "wait",
  close_agent: "closeAgent",
  send_message: "sendMessage",
  followup_task: "followupTask",
  interrupt_agent: "interruptAgent",
  list_agents: "listAgents",
};

/**
 * 命令实际在 cwd 跑、不是负责人的工作目录时补判的那次调用：按 cd 到那里再跑判。守卫的 shell 分析核对目录本身（cd 算一次"不只是读"的读：越出项目目录要问，密钥区硬拒绝），
 * 认得的程序（rm、cat……）和像路径的词（.\x）的相对路径按它解析。PowerShell 的 cmdlet 守卫不认得，裸文件名（Remove-Item keep.txt）不算路径，靠的就是目录本身那一条。
 * 目录里的分隔符换成正斜杠（`"D:\"` 的反斜杠会把引号转义掉），双引号里还有特殊意思的字符转义
 */
export function cwdCheckOf(call: CodexToolCall, cwd: string): CodexToolCall {
  const dir = commandForGuard(cwd).replace(/["$`]/g, "\\$&");
  const written = isRecord(call.native.args) ? call.native.args.command : undefined;
  return { id: `${call.id}#cwd`, toolName: "bash", args: { command: `cd "${dir}" && ${str(call.args.command) ?? ""}` }, native: { toolName: "Bash", args: { command: written, workdir: cwd } } };
}

/** 一次钩子来的 Codex 调用在守卫眼里是什么：命令 → bash；补丁 → apply_patch（看不出改哪些文件的不写路径，名字换掉，照未登记的写操作判）；看图 → read；sleep、子代理工具去掉命名空间换成登记表里的名字；别的照原名原样 */
export function toGuardCall(id: string, toolName: string, input: Input): CodexToolCall {
  const native = { toolName, args: input };
  if (toolName === "Bash") return { id, toolName: "bash", args: { command: commandForGuard(str(input.command) ?? "") }, native };
  if (toolName === "view_image") return { id, toolName: "read", args: { path: str(input.path) ?? "" }, native };
  if (toolName === "apply_patch" || toolName === "Write" || toolName === "Edit") {
    const patch = str(input.command) ?? "";
    const paths = pathsOfPatch(patch);
    return paths ? { id, toolName: "apply_patch", args: { ...paths, patch }, native } : { id, toolName: "apply_patch_unparsed", args: { patch }, native };
  }
  const plain = toolName.startsWith("mcp__") ? toolName : toolName.replace(HOOK_NAMESPACE, "");
  if (plain === "sleep") return { id, toolName: "sleep", args: { durationMs: input.duration_ms ?? null }, native };
  const collab = COLLAB_TOOLS[plain];
  if (collab !== undefined) {
    const { message, prompt, ...rest } = input;
    return { id, toolName: collab, args: { ...(message !== undefined || prompt !== undefined ? { prompt: message ?? prompt } : {}), ...rest }, native };
  }
  return { id, toolName: plain, args: input, native };
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
  /** 这个 thread 是哪次调用派的子代理（钩子的 agent_id 是子代理的 thread） */
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
    // 实测：session_id 永远是主线的；子代理的 thread 在 agent_id 里（主线的调用没有这个字段）
    const parent = this.deps.parentOf(str(payload.agent_id));
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
    if (!verdict.allow) {
      this.deps.log(`审批请求按守卫的判定拒了 ${call.toolName}（${call.id}）：${verdict.reason}`);
      // decline 带不了话，模型只收到 rejected by user；记录上写明原因
      this.deps.addPrefix(call.id, verdict.reason);
    } else if (verdict.args && !this.rewritten.has(call.id)) {
      // 审批回不了改过的参数（钩子没拦到才走到这）：拒掉，模型照计划重来
      this.deps.log(`审批请求改不了参数，拒了 ${call.toolName}（${call.id}）`);
      return false;
    }
    return verdict.allow;
  }

  /** 口子 3：条目开始了、前两个口子都没判过的（见文件开头） */
  audit(call: CodexToolCall): void {
    if (!this.deps.enabled || this.decisions.has(call.id)) return;
    this.deps.log(`调用开始时还没过守卫（钩子没拦到）：${call.native.toolName}（${call.id}），事后核对`);
    void this.decide(call, false).then((verdict) => {
      if (!verdict.allow) this.interruptUnlessBlocking(call, verdict.reason);
    });
  }

  /** 判了不放行、已经拦不住：等一小会儿再打断这一轮，审批请求可能紧跟着到（那时能正经拦下）。这一轮已经结束了（判定都清了）就不用打断 */
  private interruptUnlessBlocking(call: CodexToolCall, reason: string): void {
    setTimeout(() => {
      const decision = this.decisions.get(call.id);
      if (!decision || decision.blocking) return;
      this.deps.log(`事后核对判了不放行、已经拦不住：${call.native.toolName}（${call.id}）：${reason}。打断这一轮`);
      this.deps.interrupt();
    }, AUDIT_INTERRUPT_DELAY_MS).unref();
  }

  /**
   * 补判换目录（见文件开头）：条目和审批谁先到都走这里，按自己的 id 只判一次，判定回来就结束那条记录。
   * 判的命令用钩子看到的那句（模型写的原样，条目里的可能是外壳包好的）；钩子按计划改过参数的用条目里的（实际跑的是改过的）
   */
  private recheckCwd(call: CodexToolCall, cwd: string, parent: string | undefined, blocking: boolean): { check: CodexToolCall; verdict: Promise<GuardVerdict>; first: boolean } {
    const hooked = this.rewritten.has(call.id) ? undefined : this.decisions.get(call.id)?.call;
    const check = cwdCheckOf(hooked ?? call, cwd);
    const first = !this.decisions.has(check.id);
    const verdict = this.decide(check, blocking, parent);
    if (first) void verdict.then((v) => this.deps.end(check.id, !v.allow, v.allow ? "" : v.reason, parent));
    return { check, verdict, first };
  }

  /** 条目开始时发现命令在别的目录跑：后面有审批的由 approveCwd 接住；没有的（execpolicy 放行）已经在跑了，判了不放行只能打断这一轮 */
  checkCwd(call: CodexToolCall, cwd: string, parent: string | undefined): void {
    if (!this.deps.enabled) return;
    const { check, verdict, first } = this.recheckCwd(call, cwd, parent, false);
    if (!first) return;
    this.deps.log(`${call.id} 这条命令在别的目录跑（${cwd}），补判一次`);
    void verdict.then((v) => {
      if (!v.allow) this.interruptUnlessBlocking(check, v.reason);
    });
  }

  /** 审批请求里发现命令在别的目录跑：等补判的结果才回。不放行的、要改参数的（审批改不了）都回 decline，原因写在这条命令的记录上 */
  async approveCwd(call: CodexToolCall, cwd: string, parent: string | undefined): Promise<boolean> {
    if (this.deps.sealed() || !this.deps.enabled) return false;
    const verdict = await this.recheckCwd(call, cwd, parent, true).verdict;
    if (verdict.allow && !verdict.args) return true;
    const reason = verdict.allow ? `二狗按计划要改这条在 ${cwd} 跑的命令，审批改不了，不放行；请按计划的写法重新调用。` : verdict.reason;
    this.deps.log(`审批请求按补判的结果拒了 ${call.id}（在 ${cwd} 跑）：${reason}`);
    this.deps.addPrefix(call.id, reason);
    return false;
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
