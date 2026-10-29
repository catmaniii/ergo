// 自定义的压缩指令（22 号票：秘书专用的那一份，规格第 7 节；128 号票起是通用贡献清单里的 compaction_instructions 钩子订阅，
// 由桥接扩展 bridge.ts 在 pi 的 session_before_compact 里叫这里）。pi 的自动压缩（到了阈值、上下文溢出）不带自定义指令，
// 手动压缩也只在调用时带：所以自己按这份指令写摘要（pi 导出的 compact，和 pi 默认的写法同一个函数、同一个模型调用函数和凭据，
// 只是多了这份指令），把结果交回 pi，由 pi 照常记进会话文件、之后照常注入上下文块。
// 指令接在 pi 的摘要提示后面（"Additional focus: …"）。被当成"切在一轮中间"、其实没切开的，整段按这份指令写（wholeTurns）。
// 从 session.ts 搬来（128 号票），写法没变。
import { compact, type AgentSession, type ExtensionContext, type ModelRuntime, type SessionBeforeCompactEvent, type SessionBeforeCompactResult, type SessionEntry, type SettingsManager } from "@earendil-works/pi-coding-agent";

/** 按自定义指令写摘要要的：模型目录和凭据、pi 的设置（重试）、建好的会话（它的思考档位和模型调用函数；会话建好之后才会压缩） */
export interface CompactionDeps {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  session: () => AgentSession | undefined;
}

/** 按 instructions 写这次压缩的摘要；还没有会话、没有模型时交给 pi 默认的写法（返回 undefined） */
export async function compactWithInstructions(event: SessionBeforeCompactEvent, ctx: ExtensionContext, instructions: string, deps: CompactionDeps): Promise<SessionBeforeCompactResult | undefined> {
  const session = deps.session();
  const model = ctx.model;
  if (!session || !model) return undefined;
  const auth = await deps.modelRuntime.getAuth(model, { signal: event.signal });
  const requestModel = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
  const compaction = await compact(
    wholeTurns(event.preparation, event.branchEntries),
    requestModel,
    auth?.auth.apiKey,
    withoutDeletedHeaders(auth?.auth.headers),
    instructions,
    event.signal,
    session.thinkingLevel,
    session.agent.streamFunction,
    auth?.env,
    deps.settingsManager.getRetrySettings(),
  );
  return { compaction };
}

/** pi 压缩前准备好的东西（要压缩的消息、留下的第一条……；pi 没导出这个类型的名字） */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * pi 留下的第一条之前紧挨着的非消息条目（二狗在每条输入前记的输入标记）也一起留下，切点就落在标记上，被当成切在一轮中间：
 * 那一轮另用 pi 自己的"半轮"提示写一段摘要（不带自定义指令）。切点之后的第一条消息就是一轮的开头（用户消息、上下文消息）时
 * 其实没切开哪一轮：把那"半轮"并回要压缩的历史，整段按自定义指令写。真切在一轮中间的（留下的从助手消息、工具结果开始）照旧
 */
function wholeTurns(preparation: CompactionPreparation, entries: readonly SessionEntry[]): CompactionPreparation {
  if (!preparation.isSplitTurn || preparation.turnPrefixMessages.length === 0) return preparation;
  const at = entries.findIndex((e) => e.id === preparation.firstKeptEntryId);
  if (at < 0) return preparation;
  const first = entries.slice(at).find((e) => e.type === "message" || e.type === "custom_message");
  const startsTurn = first?.type === "custom_message" || (first?.type === "message" && first.message.role === "user");
  if (!startsTurn) return preparation;
  return { ...preparation, messagesToSummarize: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], turnPrefixMessages: [], isSplitTurn: false };
}

/** provider 的请求头里值为 null 的表示删掉这个头（pi 自己的摘要请求也这样去掉） */
function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
}
