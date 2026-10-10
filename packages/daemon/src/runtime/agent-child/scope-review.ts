// 子进程里的范围审视（规格第 10 节，18 号票）。守护进程不跑模型，审视的模型调用在维护者自己的子进程里另开一次：
// 用审视的模型（便宜模型）、在会话之外调用（modelRuntime.completeSimple），不写进维护者的会话；结果报给守护进程保存，
// 同时 appendEntry 进会话（只是副本，不进模型的上下文）。审视的说明、对照物、近期范围记录都是守护进程写好的文字（装配参数
// scopeReview），这里只管什么时候审、审哪段对话、怎么解析回复。两个时点：
// - 压缩会话时（session_before_compact）：审视要压缩掉的消息；
// - 守护进程要时（scope_review 命令，工单结束、子进程退出之前）：审视会话里还没审视过的部分——上次压缩留下的和之后的消息
//   （压缩掉的那些压缩时已经审视过了）。
// 另外 before_agent_start 把守护进程给的近期范围记录拼到系统提示末尾（每段新会话里都有，不靠旧会话里的 appendEntry）。
// 审视的输入：对照物（立项书、任务计划、授权和用户在会话里直接说的话）加上这段对话的文本（pi 自己压缩时的写法）。
// 输出：约定的 JSON {"records":[{"kind","summary","detail?","basis?"}]}，解析不了就报原因、不记。
// 结果里带上这个会话里交给它的输入（输入标记里的 id）：工作记录里可能引着它们的原话，彻底删除时守护进程据此改写范围记录。
// 审视用的模型（73 号票）：拉起时装配里的，之后守护进程在 scope_review、scope_context 里带上它此刻按设置取的（每次审视时现取），
// 和手里的不一样才换（faux 剧本一样时不重新注册，剧本接着往下走）；换上的模型目录里没有时，那次审视报原因。
import { convertToLlm, type AgentSession, type ExtensionFactory, type ModelRuntime, serializeConversation, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentReport,
  CONTEXT_BLOCK_TYPE,
  INPUT_CONTEXT_TYPE,
  SCOPE_REVIEW_ENTRY,
  type ScopeFinding,
  type ScopeReviewReport,
  type ModelSpec,
  type ScopeReviewSetup,
  SESSION_INPUT_TAG,
} from "../host-protocol.ts";
import { usageReport } from "./event-translator.ts";

/** pi 会话里的一条消息（pi 没从包入口导出这个类型的名字） */
type SessionMessage = AgentSession["messages"][number];

/** 审视的输入：范围依据在前，工作记录在后 */
function reviewPrompt(reference: string, conversation: string): string {
  return `<scope-reference>\n${reference}\n</scope-reference>\n\n<work-log>\n${conversation}\n</work-log>`;
}

/** 这些消息不算"这段工作"：上次压缩的摘要（压缩时审视过了）、分支摘要、运行时注入的重注入块和看板变化 */
const SKIPPED_CUSTOM_TYPES: readonly string[] = [CONTEXT_BLOCK_TYPE, INPUT_CONTEXT_TYPE];
function isWork(message: SessionMessage): boolean {
  if (message.role === "compactionSummary" || message.role === "branchSummary") return false;
  if (message.role === "custom" && SKIPPED_CUSTOM_TYPES.includes(message.customType)) return false;
  return true;
}

/** 一段对话的文本（pi 压缩时的写法：先换成模型看的消息，再按行写成文本） */
function conversationText(messages: readonly SessionMessage[]): string {
  return serializeConversation(convertToLlm(messages.filter(isWork)));
}

/** 会话（当前分支）里交给 agent 的输入：输入标记（SESSION_INPUT_TAG）里的 id，按先后 */
function inputIdsOf(sessionManager: Pick<SessionManager, "getBranch">): string[] {
  return sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== SESSION_INPUT_TAG) return [];
    const id = (entry.data as { inputId?: unknown } | undefined)?.inputId;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * 从审视模型的回复里取出约定的 JSON：去掉代码块的围栏，从第一个 { 起按括号配对取一个对象。
 * 取不出、或者形状不对时抛错（原因里带回复的开头）
 */
export function parseFindings(reply: string): ScopeFinding[] {
  const start = reply.indexOf("{");
  const end = start < 0 ? -1 : matchingBrace(reply, start);
  const fail = (why: string): never => {
    throw new Error(`${why}：${reply.trim().slice(0, 200) || "（空的）"}`);
  };
  if (end < 0) return fail("审视模型的回复里没有约定的 JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return fail("审视模型的回复不是合法的 JSON");
  }
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return fail("审视模型的回复里没有 records 数组");
  const findings: ScopeFinding[] = [];
  for (const r of records as Array<Record<string, unknown>>) {
    if (typeof r !== "object" || r === null) continue;
    const kind = r.kind;
    const summary = typeof r.summary === "string" ? r.summary.trim() : "";
    if ((kind !== "scope_change" && kind !== "out_of_scope") || !summary) continue;
    const detail = nonEmpty(r.detail);
    const basis = nonEmpty(r.basis);
    findings.push({ kind, summary, ...(detail === undefined ? {} : { detail }), ...(basis === undefined ? {} : { basis }) });
  }
  return findings;
}

/** 去掉首尾空白后不是空的字符串；别的是 undefined */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** 从 start（一个 {）起配对到的 } 的位置；字符串里的括号不算；配不上是 -1 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 一次审视：守护进程要的带 requestId；messages 是要审视的对话，inputIds 是会话里交给它的输入 */
interface ReviewInput {
  requestId?: string;
  messages: readonly SessionMessage[];
  reference: string;
  inputIds: string[];
  signal?: AbortSignal;
}

/** 子进程里的范围审视：装配了 scopeReview 的会话才有 */
export class ScopeReviewer {
  private reference: string;
  private recentRecords: string | undefined;
  private readonly setup: ScopeReviewSetup;
  /** 审视用的模型（守护进程最近交来的）和解析好的 pi 模型（换了模型之后第一次审视时才解析） */
  private spec: ModelSpec;
  private model: Model<string> | undefined;
  private readonly resolve: (spec: ModelSpec) => Model<string>;
  private readonly modelRuntime: ModelRuntime;
  private readonly emit: (report: AgentReport) => void;
  /** 记一条副本进会话（扩展拿到的 pi.appendEntry）；会话建好之前没有 */
  private appendEntry: ((data: unknown) => void) | undefined;
  private reviews = 0;

  constructor(
    setup: ScopeReviewSetup,
    model: Model<string>,
    deps: { modelRuntime: ModelRuntime; resolve: (spec: ModelSpec) => Model<string>; emit: (report: AgentReport) => void },
  ) {
    this.setup = setup;
    this.spec = setup.model;
    this.model = model;
    this.resolve = deps.resolve;
    this.reference = setup.reference;
    this.recentRecords = setup.recentRecords;
    this.modelRuntime = deps.modelRuntime;
    this.emit = deps.emit;
  }

  /** 换成守护进程给的最新对照物和近期范围记录（给了模型也换上） */
  setContext(reference: string, recentRecords: string | undefined, model?: ModelSpec): void {
    this.reference = reference;
    this.recentRecords = recentRecords;
    if (model) this.useModel(model);
  }

  /** 换成守护进程此刻按设置取的审视模型：和手里的一样就不动 */
  useModel(spec: ModelSpec): void {
    if (JSON.stringify(spec) === JSON.stringify(this.spec)) return;
    this.spec = spec;
    this.model = undefined;
  }

  readonly extension: ExtensionFactory = (pi) => {
    this.appendEntry = (data) => pi.appendEntry(SCOPE_REVIEW_ENTRY, data);
    // 每条输入之前：近期范围记录拼到系统提示末尾（每次在原来的系统提示上拼，不叠加）
    pi.on("before_agent_start", (event) => (this.recentRecords ? { systemPrompt: `${event.systemPrompt}\n\n${this.recentRecords}` } : undefined));
    // 压缩之前：要压缩掉的消息送审；不改压缩本身（返回 undefined），审视出错也不拦压缩
    pi.on("session_before_compact", async (event, ctx) => {
      const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
      await this.review({ messages, reference: this.reference, inputIds: inputIdsOf(ctx.sessionManager), signal: event.signal });
      return undefined;
    });
  };

  /** 守护进程要的审视：会话里还没审视过的部分（上次压缩留下的和之后的消息） */
  async reviewSession(session: AgentSession, requestId: string, reference: string, model?: ModelSpec): Promise<void> {
    this.reference = reference;
    if (model) this.useModel(model);
    await this.review({ requestId, messages: session.messages, reference, inputIds: inputIdsOf(session.sessionManager) });
  }

  /** 审视一段对话，报回结果、记进会话 */
  private async review(input: ReviewInput): Promise<void> {
    const { requestId } = input;
    const report: ScopeReviewReport = { type: "scope_review_result", ...(requestId === undefined ? {} : { requestId }), findings: [], inputIds: input.inputIds };
    try {
      const text = conversationText(input.messages);
      // 没有要审视的（刚开就结束、只有运行时注入的消息）：不调用模型
      if (text.trim()) report.findings = await this.call(input.reference, text, input.signal);
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
    }
    this.appendEntry?.({ ...(requestId === undefined ? {} : { requestId }), findings: report.findings, ...(report.error === undefined ? {} : { error: report.error }) });
    this.emit(report);
  }

  /** 在会话之外另开一次模型调用：报一条用量（scope_review），解析回复 */
  private async call(reference: string, conversation: string, signal?: AbortSignal): Promise<ScopeFinding[]> {
    const thinking = this.spec.thinkingLevel;
    // 换了模型之后第一次审视时解析（模型目录里没有时抛错，这次审视报原因）
    this.model ??= this.resolve(this.spec);
    const model = this.model;
    const response = await this.modelRuntime.completeSimple(
      model,
      { systemPrompt: this.setup.instructions, messages: [{ role: "user", content: [{ type: "text", text: reviewPrompt(reference, conversation) }], timestamp: Date.now() }] },
      { cacheRetention: "none", ...(model.reasoning && thinking !== "off" ? { reasoning: thinking } : {}), ...(signal ? { signal } : {}) },
    );
    this.reviews += 1;
    this.emit(usageReport(`scope-review-${this.reviews}`, response.usage, { provider: response.provider, modelId: response.model }, "scope_review"));
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`审视的模型调用没成：${response.errorMessage ?? response.stopReason}`);
    return parseFindings(response.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
  }
}
