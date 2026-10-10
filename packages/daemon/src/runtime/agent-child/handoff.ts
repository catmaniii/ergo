// 换模型就新开会话（83 号票，规格第 1 节"模型"）在子进程这一侧。一个会话固定一个模型（73 号票），所以接着的会话开始时的模型
// （或思考档位）和装配参数里的不一样、装配参数又给了 handoff 时：先用原来的模型写一份交接摘要，再新开一个会话（用装配参数里的模型），
// 第一条就是这份摘要，之后照常。
// - 摘要的写法照 pi 的压缩摘要：pi 导出的 generateSummaryWithUsage（同一份结构化的摘要提示、同一个把对话转成文字的写法；
//   会话压缩过的，上次压缩的摘要作为 previous summary，用 pi 的"更新摘要"提示），守护进程给的写法（prompts/handoff-summary.md
//   填好值）接在后面（"Additional focus: …"），和秘书的压缩指令同一种接法（22 号票）。模型、思考档位都是原来的会话的，
//   凭据由模型运行时按 provider 取（和会话里的调用一样）；
// - 新会话先建一个空文件再交给 pi 打开：pi 对空文件写好会话头，之后每一条都马上落盘，所以换过去的那一刻新会话就在盘上
//   （接着最近的会话的秘书、按名字接分段的项目维护者，这时被杀、重启都接得上新的，不会回到原来的会话或开出一个空会话）；
// - 交接摘要作为新会话的第一条：HANDOFF_SUMMARY_TYPE 的自定义消息（模型看到的是一条用户角色的消息），开头一句说明换了模型、
//   接着之前的对话（和二狗的段摘要一样，作为"上一段的摘要"交给新的一段）；数据里记着从哪个会话换过来的，彻底删除时据此判断
//   要不要整段换掉（session-rewrite.ts）；
// - 写摘要那次调用的用量（purpose: handoff）等 ready 之后再报（agent 管家在 ready 时才知道会话 id）；
// - 没写成（模型出错、超时）：不换，照旧接着原来的会话；原因去掉凭据的内容后报回，守护进程下一轮再试。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS, generateSummaryWithUsage, type ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { HANDOFF_SUMMARY_TYPE, type HandoffSetup, type ModelRef, type SessionAssembly, type ThinkingLevel } from "../host-protocol.ts";
import { redactApiKeys } from "../redact.ts";

/** pi 会话里的一条消息（pi 没从包入口导出这个类型的名字） */
type SessionMessage = ReturnType<SessionManager["buildSessionContext"]>["messages"][number];

/** 写好的交接摘要：文字和那次调用的用量 */
export interface WrittenHandoff {
  text: string;
  usage: Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"];
}

/**
 * 用原来的会话的模型写交接摘要（pi 的压缩摘要的写法，守护进程给的写法接在后面）。没写成抛错：模型出错、超时（timeoutMs）、
 * 回复里没有文字；原因里凭据的内容去掉
 */
export async function writeHandoffSummary(
  sessionManager: SessionManager,
  model: Model<string>,
  thinkingLevel: ThinkingLevel,
  setup: HandoffSetup,
  deps: { modelRuntime: ModelRuntime; credentials: Readonly<Record<string, string>> },
): Promise<WrittenHandoff> {
  const { messages, previousSummary } = summarizable(sessionManager.buildSessionContext().messages);
  const signal = AbortSignal.timeout(setup.timeoutMs);
  try {
    const { text, usage } = await generateSummaryWithUsage(
      messages,
      model,
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      // 凭据由模型运行时按 provider 取（和会话里的调用、范围审视一样）
      undefined,
      undefined,
      signal,
      setup.instructions,
      previousSummary,
      thinkingLevel,
      (m, context, options) => deps.modelRuntime.streamSimple(m, context, options),
    );
    if (!text.trim()) throw new Error("模型回的交接摘要是空的");
    return { text: text.trim(), usage };
  } catch (err) {
    const reason = signal.aborted ? `写交接摘要超过 ${Math.round(setup.timeoutMs / 1000)} 秒没有结束` : err instanceof Error ? err.message : String(err);
    throw new Error(redactApiKeys(reason, Object.values(deps.credentials)), { cause: err });
  }
}

/** 要总结的对话：会话压缩过的，开头那条压缩摘要作为 previous summary（pi 压缩时也这样），其余照原样 */
function summarizable(messages: readonly SessionMessage[]): { messages: SessionMessage[]; previousSummary?: string } {
  const first = messages[0];
  if (first?.role === "compactionSummary") return { messages: messages.slice(1), previousSummary: first.summary };
  return { messages: [...messages] };
}

/** 会话文件的扩展名（和 session.ts 的一致：会话的名字加上它就是文件名） */
const SESSION_EXT = ".jsonl";

/**
 * 换过去的新会话：先建一个空文件再交给 pi 打开（pi 对空文件写好会话头、之后每条马上落盘），名字照 pi 新开会话的样子（时间_随机 id）
 */
export function handoffSessionManager(assembly: Pick<SessionAssembly, "sessionDir" | "cwd">): SessionManager {
  fs.mkdirSync(assembly.sessionDir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
  const file = path.join(assembly.sessionDir, `${name}${SESSION_EXT}`);
  fs.writeFileSync(file, "", { flag: "wx" });
  return SessionManager.open(file, assembly.sessionDir, assembly.cwd);
}

/** 交接摘要在新会话里的样子：开头一句说明（换了什么模型、接着之前的对话），然后是原来的模型写的摘要 */
export function handoffMessage(summary: string, from: { session: string; model: ModelRef }, to: ModelRef) {
  return {
    customType: HANDOFF_SUMMARY_TYPE,
    content: handoffText(summary, from.model, to),
    display: false,
    details: { fromSession: from.session, fromModel: `${from.model.provider}/${from.model.modelId}` },
  };
}

/** 交接摘要前面的那句说明（给新模型看） */
export function handoffText(summary: string, from: ModelRef, to: ModelRef): string {
  return [
    `【交接摘要】这个对话换了模型：之前是 ${from.name}，现在由你（${to.name}）接着。下面是之前的模型写的交接摘要，`,
    "用户看到的还是同一个对话，不会重新交代一遍；照它接着之前的对话往下做，不用复述它，也不用向用户确认换了模型。",
    "",
    summary,
  ].join("\n");
}
