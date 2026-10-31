// 按二狗自己的事件记录另起一次生成（293 号票），一次性子进程这一侧（recorded-generation-main.ts 拉起这里）：运行时自己做不了、要二狗的模型做的
// 那几样。会话内容是守护进程按自己的事件日志整理好交来的（RecordedTurn），这里把它摆成 pi 的会话条目，再用 pi 导出的同一个函数做：
// - branch_summary：Claude Code 撤回时给被放弃的那段写分支摘要——pi 撤回时用的 generateBranchSummary（同一份 pi 的提示，摘要要求
//   接在后面，session-navigation.ts 的 writeSummary 同一套），交回给人看的那段（去掉 pi 加的开头和文件清单，summaryText）和进新分支上下文的
//   那段（pi 放进新分支上下文的样子：convertToLlm 把分支摘要换成的那条用户消息，开头说明这是撤回回来的那段的摘要）。
// - scope_review（309 号票）：Claude Code 的范围审视（压缩之前、工单结束时）——摆好的条目里的消息按 pi 子进程里审视的同一套（scope-review.ts 的
//   conversationText：pi 压缩时的写法；reviewPrompt：对照物在前、工作记录在后）在会话之外另开一次审视的模型调用，回复按同一个 parseFindings 解析；
//   调用出错、回复不合约定时不抛，结果里写原因（用量照样交回，同 pi 子进程里那次）；这段没有要审视的不调用模型。
// 模型是守护进程交来的（分支摘要用这个 agent 在二狗这边的模型，范围审视用审视的模型；catalog 的按 provider 取凭据，faux 的按剧本回），凭据只放内存；
// 用量交回守护进程记账（purpose 按 task）。
// 出错的原因里去掉凭据的内容（runtime/redact.ts）。
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { convertToLlm, generateBranchSummary, ModelRuntime, type SessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { modelKeyOf, t } from "@ergo/protocol";
import type { ModelSpec, RecordedGenerationRequest, RecordedGenerationResult, RecordedGenerationTask, RecordedTurn, ScopeFinding, UsageReport } from "../host-protocol.ts";
import { redactApiKeys } from "../redact.ts";
import { registerCustomProvider } from "./custom-provider.ts";
import { usageReport } from "./event-translator.ts";
import { registerFauxModel } from "./faux.ts";
import { conversationText, parseFindings, reviewPrompt } from "./scope-review.ts";
import { summaryText } from "./session-navigation.ts";

/** 摆出来的 assistant 条目的来历（不是哪家模型回的：会话内容是二狗记下的） */
const RECORDED = "ergo-recorded";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 二狗记下的会话 → pi 的会话条目（一条链，按先后）：用户说的是 user 消息，回复是 assistant 消息（思考、文字、工具调用），工具结果是 toolResult，
 * 之前的分支摘要是 branch_summary 条目（pi 写摘要时把它当上下文、合并它记下的文件）
 */
export function recordedEntries(turns: readonly RecordedTurn[], now: () => number = Date.now): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  const push = (fields: Record<string, unknown>) => {
    const id = `rec-${entries.length + 1}`;
    entries.push({ id, parentId, timestamp: new Date(now()).toISOString(), ...fields } as unknown as SessionEntry);
    parentId = id;
  };
  for (const turn of turns) {
    const timestamp = now();
    switch (turn.role) {
      case "user":
        if (turn.text.trim()) push({ type: "message", message: { role: "user", content: [{ type: "text", text: turn.text }], timestamp } });
        break;
      case "assistant": {
        const content = [
          ...(turn.thinking ? [{ type: "thinking", thinking: turn.thinking }] : []),
          ...(turn.text ? [{ type: "text", text: turn.text }] : []),
          ...turn.calls.map((call) => ({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args })),
        ];
        if (content.length === 0) break;
        push({
          type: "message",
          message: { role: "assistant", content, api: RECORDED, provider: RECORDED, model: RECORDED, usage: ZERO_USAGE, stopReason: turn.calls.length > 0 ? "toolUse" : "stop", timestamp },
        });
        break;
      }
      case "tool_result":
        push({ type: "message", message: { role: "toolResult", toolCallId: turn.callId, toolName: turn.tool, content: [{ type: "text", text: turn.text }], isError: turn.isError, timestamp } });
        break;
      case "branch_summary":
        push({ type: "branch_summary", fromId: parentId ?? "root", summary: turn.text, fromHook: true });
        break;
    }
  }
  return entries;
}

/** 解析模型：faux 的按剧本注册，catalog 的从模型目录取（契约测试给了 baseUrl 的换掉请求地址） */
function resolveModel(spec: ModelSpec, modelRuntime: ModelRuntime) {
  if (spec.kind === "faux") return registerFauxModel(spec, modelRuntime);
  const model = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) throw new Error(t("runtime.probe.noModel", { model: modelKeyOf(spec.provider, spec.modelId) }));
  return spec.baseUrl === undefined ? model : { ...model, baseUrl: spec.baseUrl };
}

/** 做一次另起的生成；没做成抛错（原因里凭据的内容去掉） */
export async function runRecordedGeneration(request: RecordedGenerationRequest): Promise<RecordedGenerationResult> {
  const secrets = Object.values(request.credentials);
  try {
    // 凭据只放内存：不读 ~/.pi/agent/auth.json，也不读 models.json，不连网刷新模型目录（和 agent 会话一样）
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    // 自定义（OpenAI 兼容）服务商：pi 的模型目录里没有它，先登记，getModel("custom", 模型 id) 才认得
    registerCustomProvider(modelRuntime, request.custom);
    for (const [provider, apiKey] of Object.entries(request.credentials)) await modelRuntime.setRuntimeApiKey(provider, apiKey);
    const model = resolveModel(request.model, modelRuntime);
    switch (request.task.kind) {
      case "branch_summary":
        return await branchSummary(request, request.task.instructions, model, modelRuntime);
      case "scope_review":
        return await scopeReview(request, request.task, model, modelRuntime, secrets);
    }
  } catch (err) {
    throw new Error(redactApiKeys(err instanceof Error ? err.message : String(err), secrets), { cause: err });
  }
}

/** 给被放弃的那段写分支摘要：同 pi 撤回时（session-navigation.ts 的 writeSummary）——同一个函数、同一份提示，重试照 pi 的默认设置 */
async function branchSummary(request: RecordedGenerationRequest, instructions: string, model: ReturnType<typeof resolveModel>, modelRuntime: ModelRuntime): Promise<RecordedGenerationResult> {
  const entries = recordedEntries(request.turns);
  if (entries.length === 0) return { kind: "branch_summary", text: "", context: "" };
  const settings = SettingsManager.inMemory({});
  const result = await generateBranchSummary(entries, {
    model,
    signal: new AbortController().signal,
    customInstructions: instructions,
    reserveTokens: settings.getBranchSummarySettings().reserveTokens,
    // 凭据由模型运行时按 provider 取（和会话里的调用、写交接摘要一样）
    streamFn: (m, context, options) => modelRuntime.streamSimple(m, context, options),
    retry: settings.getRetrySettings(),
  });
  if (result.aborted) throw new Error(t("runtime.navigate.summaryAborted"));
  if (result.error !== undefined) throw new Error(t("runtime.navigate.summaryFailed", { error: result.error }));
  const stored = result.summary ?? "";
  // 进新分支上下文的样子：pi 把会话里的分支摘要条目换成的那条用户消息（开头那句、<summary> 包着）
  const [message] = convertToLlm([{ role: "branchSummary", summary: stored, fromId: "recorded", timestamp: Date.now() } as unknown as Parameters<typeof convertToLlm>[0][number]]);
  const context = message && "content" in message && Array.isArray(message.content) ? message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") : stored;
  const usage: UsageReport | undefined = result.usage
    ? (usageReport(request.usageId, result.usage, { provider: model.provider, modelId: model.id }, "branch_summary") as UsageReport)
    : undefined;
  return { kind: "branch_summary", text: summaryText(stored), context, ...(usage ? { usage } : {}) };
}

/**
 * 审视这段工作（309 号票）：同 pi 子进程里的 ScopeReviewer（scope-review.ts）——摆好的条目里的消息（之前的分支摘要不算这段工作）按 pi 压缩时的写法
 * 转成文字，审视的说明作系统提示、对照物和工作记录作一条用户消息，在会话之外调一次审视的模型（不缓存，思考档位照模型设置），回复按约定的 JSON 解析
 */
async function scopeReview(
  request: RecordedGenerationRequest,
  task: Extract<RecordedGenerationTask, { kind: "scope_review" }>,
  model: ReturnType<typeof resolveModel>,
  modelRuntime: ModelRuntime,
  secrets: readonly string[],
): Promise<RecordedGenerationResult> {
  const messages = recordedEntries(request.turns).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const text = conversationText(messages as Parameters<typeof conversationText>[0]);
  // 没有要审视的（只有分隔线、刚开就结束）：不调用模型
  if (!text.trim()) return { kind: "scope_review", findings: [] };
  const thinking = request.model.thinkingLevel;
  const response = await modelRuntime.completeSimple(
    model,
    { systemPrompt: task.instructions, messages: [{ role: "user", content: [{ type: "text", text: reviewPrompt(task.reference, text) }], timestamp: Date.now() }] },
    { cacheRetention: "none", ...(model.reasoning && thinking !== "off" ? { reasoning: thinking } : {}) },
  );
  const usage = usageReport(request.usageId, response.usage, { provider: response.provider, modelId: response.model }, "scope_review") as UsageReport;
  const failed = (error: string): RecordedGenerationResult => ({ kind: "scope_review", findings: [], error: redactApiKeys(error, secrets), usage });
  // @i18n-ignore-next log：没做成的原因，同 pi 子进程里审视的写法（scope-review.ts）
  if (response.stopReason === "error" || response.stopReason === "aborted") return failed(`审视的模型调用没成：${response.errorMessage ?? response.stopReason}`);
  let findings: ScopeFinding[];
  try {
    findings = parseFindings(response.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  return { kind: "scope_review", findings, usage };
}
