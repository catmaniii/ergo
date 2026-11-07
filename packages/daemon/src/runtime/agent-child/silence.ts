// 太久没回应就提前重试（421）：包在 pi 发每次模型调用的函数（agent.streamFunction）外面。
// 一次调用发出去之后计时（runtime/silence-watch.ts），silenceMs 内一个字（正文、思考、工具调用的参数，pi 的增量事件都算）
// 都没回来，就中止这一次请求，交给 pi 一条出错的回复（silentCallError：带 "timed out"，pi 当成能重试的），pi 照它的重试设置
// 再调一次、算进重试次数。中途每收到一段内容就重新计时：正在慢慢输出的调用不砍；输出到一半停住超过 silenceMs 的照样中止。
// 守护进程那边单次模型调用的上限（agent-manager 的 modelCallMs）照旧另管。
import { type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { silentCallError } from "../host-protocol.ts";
import { type SilenceTimers, watchForSilence } from "../silence-watch.ts";

/** pi 发一次模型调用的函数（pi-agent-core 的 StreamFn 的样子） */
type StreamFunction = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 包一层：每次调用 silenceMs 内一个字都没回来就中止这次请求、以出错结束（pi 据此重试）。
 * onSilent：中止的时候叫一声（写日志用）
 */
export function watchSilence(streamFn: StreamFunction, silenceMs: number, options: { timers?: SilenceTimers; onSilent?: () => void } = {}): StreamFunction {
  return (model, context, streamOptions) => {
    const outer = createAssistantMessageEventStream();
    // 这次请求自己的中止信号：外面中止（用户点停止、守护进程中止这一轮）跟着中止；没回应时只中止这一次
    const controller = new AbortController();
    const upstream = streamOptions?.signal;
    const onUpstreamAbort = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) controller.abort(upstream.reason);
    else upstream?.addEventListener("abort", onUpstreamAbort, { once: true });

    let partial: AssistantMessage | undefined;
    let settled = false;
    const finish = (event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) => {
      settled = true;
      watch.stop();
      upstream?.removeEventListener("abort", onUpstreamAbort);
      outer.push(event);
      outer.end(event.type === "done" ? event.message : event.error);
    };
    const watch = watchForSilence(
      silenceMs,
      () => {
        if (settled) return;
        options.onSilent?.();
        finish({ type: "error", reason: "error", error: { ...emptyMessage(model, partial), errorMessage: silentCallError(silenceMs) } });
        controller.abort();
      },
      options.timers,
    );

    void (async () => {
      try {
        const inner = await streamFn(model, context, { ...streamOptions, signal: controller.signal });
        for await (const event of inner) {
          if (settled) return;
          if (event.type === "done" || event.type === "error") return finish(event);
          partial = event.partial;
          watch.heard(event.type);
          outer.push(event);
        }
        if (!settled) {
          const message = await inner.result();
          finish(message.stopReason === "error" || message.stopReason === "aborted" ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: doneReason(message), message });
        }
      } catch (err) {
        if (settled) return;
        finish({ type: "error", reason: "error", error: { ...emptyMessage(model, partial), errorMessage: err instanceof Error ? err.message : String(err) } });
      }
    })();
    return outer;
  };
}

/** 出错时交给 pi 的回复：已经回来的内容留着（pi 重试时不放进上下文），用量照已经报的 */
function emptyMessage(model: Model<Api>, partial: AssistantMessage | undefined): AssistantMessage {
  return {
    role: "assistant",
    content: partial?.content ?? [],
    api: partial?.api ?? model.api,
    provider: partial?.provider ?? model.provider,
    model: partial?.model ?? model.id,
    usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  };
}

function doneReason(message: AssistantMessage): Extract<AssistantMessageEvent, { type: "done" }>["reason"] {
  const reason = message.stopReason;
  return reason === "length" || reason === "toolUse" || reason === "deferred" ? reason : "stop";
}
