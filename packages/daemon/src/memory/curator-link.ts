// @i18n-ignore-file model：工具的说明、参数说明和交回的文字给秘书（模型）看（174 号票）；工具的名字走 t()。
//
// 秘书 → 记忆管理员的转达（242 号票，和 103 号票的"秘书转达"同一个现成机制）：用户在和秘书说话时要深聊记忆的来龙去脉、
// 要改/要忘某条结论时，秘书用问记忆管理员（ask_curator）把用户的话转给管理员，等它答完，把回答带回来。
// - 怎么转：往记忆管理员的会话里追加一条转达的消息（conversation/messages.ts 的 buildRelayedMessage：发言方是用户、
//   relayedBy 是秘书、relayOf 是用户在秘书那里说的那句）。管理员那一侧照用户直接跟它说的话处理（agent-input.ts 会写明是秘书转达的）；
// - 怎么等：这一条输入在它会话里的 turn_end（和 AgentSession 记输入队列同一个事件）；等不到（它在整理、没起来）就交回一句"话转到了、
//   还没答上来"，让秘书如实说，不要自己编记忆里的事；
// - 为什么不是指一条新消息总线：管理员本来就是会话，这条消息走的就是用户在它那里说话的同一条路（243 号票起它按需拉起：这条转达
//   就跟用户发的一句话一样，先把管理员拉起来、再交过去），网页上同样看得到。
// 秘书的 ask_memory 不动：那是快通道（232 号票），回答"你是不是……"这类轻问题；这里转的是要深聊、要动手的。
import { randomUUID } from "node:crypto";
import { type ConversationId, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { buildRelayedMessage } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import { ASK_CURATOR } from "./tool-names.ts";

export { ASK_CURATOR } from "./tool-names.ts";

/** 最多等管理员回答多久（毫秒）：等不到就先把"话转到了、还没答上来"交回秘书 */
export const ASK_CURATOR_WAIT_MS = 90_000;

/** 转达的幂等键前缀 */
export const ASK_CURATOR_KEY_PREFIX = "curator-ask:";

/** 交回来的回答最多多少字（秘书再转述，不用全文） */
export const ASK_CURATOR_MAX_CHARS = 4000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一条 turn_end 的负载里是不是这一条输入 */
function settledFor(payload: unknown, messageId: string): boolean {
  const turn = payload as { inputMessageId?: string; moreInputMessageIds?: readonly string[] };
  return turn.inputMessageId === messageId || (turn.moreInputMessageIds?.includes(messageId) ?? false);
}

/** 这一轮里它说的话（管理员对这条转达的回话），按先后拼起来 */
function answerOf(store: Pick<EventStore, "read">, conversation: ConversationId, afterSeq: number): string {
  const texts = store
    .read(conversation, afterSeq, "message")
    .map((event) => (event.payload as { message?: { speaker?: string; parts?: readonly { type: string; text?: string }[] } }).message)
    .filter((message): message is { speaker: string; parts: readonly { type: string; text?: string }[] } => message?.speaker === "agent")
    .flatMap((message) => (message.parts ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined && part.text.trim() !== "" ? [part.text.trim()] : [])));
  const text = texts.join("\n\n").trim();
  return text.length > ASK_CURATOR_MAX_CHARS ? `${text.slice(0, ASK_CURATOR_MAX_CHARS)}…` : text;
}

export interface AskCuratorOptions {
  store: Pick<EventStore, "append" | "read" | "onAppend">;
  /** 记忆管理员的会话 */
  conversation: ConversationId;
  /** 等多久（毫秒）；默认 ASK_CURATOR_WAIT_MS */
  waitMs?: number;
  log?: (line: string) => void;
}

/** 秘书的"问记忆管理员"工具（只给秘书；转达走现成的会话机制） */
export function askCuratorTool(options: AskCuratorOptions): HostTool {
  const log = options.log ?? (() => {});
  const waitMs = options.waitMs ?? ASK_CURATOR_WAIT_MS;
  return defineHostTool({
    name: ASK_CURATOR,
    title: t("memory.tool.curator"),
    description:
      "问记忆管理员：用户要深聊记忆的来龙去脉（「这条结论是哪来的」「为什么把我标成这样」）、要改一条结论的状态、要把某条素材忘掉或者别拿来推断时，" +
      "把用户这句话转给它，等它答完把回答带回来。它是负责整理和修改记忆的那个 agent（用户在记忆页顶上点「和记忆管理员聊」进的就是和它的对话）；" +
      "轻问题（「我是不是……」）用 ask_memory 就够，不用转。转过去的话以用户的口吻说，别替用户加要求；回答是它的判断，转述时说清是从哪来的。",
    parameters: Type.Object(
      {
        question: Type.String({ minLength: 1, maxLength: 1000, description: "要转给记忆管理员的话：用户要问的、要它做的，尽量照用户的意思说清楚" }),
      },
      { additionalProperties: false },
    ),
    // 它会唤起另一个 agent（还可能改记忆），不重试
    readOnlyOrIdempotent: false,
    async run(args, call) {
      if (call.signal?.aborted) return { text: "这一轮结束了，没转出去。", isError: true };
      const key = `${ASK_CURATOR_KEY_PREFIX}${randomUUID()}`;
      const relayed = buildRelayedMessage(options.conversation, args.question, key, {}, call.inputMessageId);
      let inputSeq: number;
      try {
        const appended = options.store.append(relayed.event);
        inputSeq = appended.event.globalSeq;
      } catch (err) {
        return { text: `没转出去：${messageOf(err)}`, isError: true };
      }
      const ended = await new Promise<{ seq: number; payload: unknown } | undefined>((resolve) => {
        const messageId = relayed.message.id;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let off: () => void = () => {};
        const onAbort = () => finish(undefined);
        const finish = (found: { seq: number; payload: unknown } | undefined) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          off();
          call.signal?.removeEventListener("abort", onAbort);
          resolve(found);
        };
        // 先看是不是已经处理完了（管理员闲着时几乎马上就回）
        for (const event of options.store.read(options.conversation, inputSeq, "turn_end")) {
          if (settledFor(event.payload, messageId)) return finish({ seq: event.globalSeq, payload: event.payload });
        }
        off = options.store.onAppend((event) => {
          if (event.channel !== options.conversation || event.type !== "turn_end") return;
          if (settledFor(event.payload, messageId)) finish({ seq: event.globalSeq, payload: event.payload });
        });
        call.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => finish(undefined), waitMs);
        timer.unref?.();
      });
      if (ended === undefined) {
        log("问记忆管理员：等不到它这一轮结束，先把话带回去");
        return {
          text: "话已经转给记忆管理员了，它这一会儿还没答上来（可能在整理，或者没起来）。如实告诉用户：话转到了，等它在记忆页 · 记忆管理员的对话里回复；不要自己编记忆里的事。",
        };
      }
      const outcome = (ended.payload as { outcome?: string; error?: string }).outcome;
      const answer = answerOf(options.store, options.conversation, inputSeq);
      if (answer === "") {
        return {
          text: `记忆管理员这一轮没答上来（${outcome === "error" ? (ended.payload as { error?: string }).error ?? "出错了" : outcome ?? "没说话"}）。告诉用户话转到了、这次没答上来。`,
        };
      }
      return { text: `记忆管理员说：\n${answer}` };
    },
  });
}
