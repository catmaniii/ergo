// 交给我做（规格第 9 节）：守卫判定为"交给我做"的调用不执行（比如花钱），在待我处理里放一个"交给我做"事项，
// 带这次调用的规范化摘要（实际要判定的每一条，通用 bash 拆出来的伪工具调用，参数是规范化之后的），由用户亲手完成。
// 用户点"已完成"后，往调用所在的会话里给 agent 递一条通知，免得它以为还没做。
// 这里不碰子进程：判定、回 guard_reply 在守卫接入（guard-runtime/guard-runtime.ts）。
import { CHANNELS, EVENT_TYPES, HAND_OVER_DONE, type InboxItem, type InboxItemEventPayload } from "@ergou/protocol";
import { appendAgentNotice } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import type { CallOrigin } from "../guard-runtime/events.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { oneLine } from "../util/text.ts";

/** "交给我做"事项里带的东西（待我处理事项的 data） */
export interface HandOverData {
  /** 调用从哪儿来 */
  origin: CallOrigin;
  /** 子进程里的这次工具调用 */
  toolCallId: string;
  /** 模型调用的工具、它的中文名、参数摘要 */
  tool: string;
  toolTitle: string;
  argsSummary: string;
  /** 这次调用的规范化摘要：实际要判定的每一条（工具、它的中文名、规范化之后的参数） */
  calls: { tool: string; title: string; args: Record<string, unknown> }[];
}

export interface HandOverService {
  /** 放一个"交给我做"事项进待我处理并提示用户。explanation 是守卫的说明 */
  create(data: HandOverData, explanation: string): InboxItem;
  /** 不再听"已完成" */
  stop(): void;
}

const TITLE_MAX = 60;

export function createHandOverService(options: { store: EventStore; inbox: InboxService }): HandOverService {
  const { store, inbox } = options;

  const onHandled = (item: InboxItem) => {
    if (item.kind !== "notice" || item.notice !== "hand_over" || item.handled !== HAND_OVER_DONE) return;
    const data = item.data as Partial<HandOverData> | undefined;
    const conversation = data?.origin?.conversation;
    if (!conversation) return;
    appendAgentNotice(
      store,
      conversation,
      `交给用户做的「${data.toolTitle ?? data.tool}：${data.argsSummary ?? ""}」用户已经亲手完成了，不用你再做。`,
      `hand-over-done:${item.id}`,
      data.origin?.taskId ? { taskId: data.origin.taskId } : {},
    );
  };
  const unsubscribe = store.onAppend((event) => {
    if (event.channel === CHANNELS.inbox && event.type === EVENT_TYPES.inboxItem) onHandled((event.payload as InboxItemEventPayload).item);
  });

  return {
    create(data, explanation) {
      const steps = data.calls.map((c) => `${c.title}（${c.tool}）：${JSON.stringify(c.args)}`).join("\n");
      const item = inbox.add({
        kind: "notice",
        notice: "hand_over",
        title: oneLine(`交给我做：${data.toolTitle} ${data.argsSummary}`, TITLE_MAX),
        body: `${data.origin.source}里要做的这件事守卫判定为"交给我做"，请你亲手完成，做完点"${HAND_OVER_DONE}"。\n要做的事：\n${steps}\n守卫的说明：${explanation}`,
        source: data.origin.source,
        // 对话里的不卡任务；任务里的按卡住任务算（13 号票接任务一侧）
        urgency: data.origin.taskId === null ? "non_blocking" : "blocking",
        actions: [HAND_OVER_DONE],
        data,
      });
      inbox.alert(item);
      return item;
    },
    stop: unsubscribe,
  };
}
